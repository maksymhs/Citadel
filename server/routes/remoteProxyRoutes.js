/**
 * Remote Host Proxy
 *
 * The browser always talks to the local server, even when the selected host is
 * a paired machine. These routes forward API calls and terminal WebSockets to
 * the active peer using its stored outbound token, so switching hosts never
 * changes the page URL and never exposes a peer token to the browser.
 *
 * Only registered hosts can be reached (no arbitrary URL is accepted), which
 * keeps this from becoming an SSRF primitive.
 */
const { WebSocket } = require('ws');
const { getSessionUser, getPeerTokenUser } = require('../security/auth');
const { isAllowedOrigin } = require('../security/guard');
const hostService = require('../services/hostService');
const { FORWARDED_ROLE_HEADER, effectiveRole } = require('../security/terminalAccess');

// Routes that must always run on the local machine: authentication, pairing and
// the host list itself. Everything else (files, terminals, projects, settings,
// system) is served by the selected host.
const LOCAL_ONLY_PREFIXES = [
  '/api/auth/',
  '/api/pair/',
  '/api/hosts',
  '/api/host/',
  '/api/fleet/',
  '/api/monitor/',
  '/api/remote/',
];

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
  'cookie',
  'set-cookie',
]);

function isLocalOnly(apiPath) {
  return LOCAL_ONLY_PREFIXES.some((prefix) => apiPath === prefix.replace(/\/$/, '') || apiPath.startsWith(prefix));
}

function buildRemotePath(request) {
  const rest = (request.params['*'] || '').replace(/^\/+/, '');
  // Accept both `/api/remote/:id/system/version` (what the client generates)
  // and `/api/remote/:id/api/system/version` (the literal API path).
  const base = rest.startsWith('api/') ? `/${rest}` : `/api/${rest}`;
  const queryIndex = request.raw.url.indexOf('?');
  const query = queryIndex === -1 ? '' : request.raw.url.slice(queryIndex);
  return `${base.replace(/\/{2,}/g, '/')}${query}`;
}

function filterHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

// The proxy is reachable from the browser (session cookie) and from a peer
// proxying a chained request (bearer token). Peer tokens are accepted here so
// machine A -> B -> C works, while local management stays session-only.
function authenticate(request, reply) {
  const sessionId = request.cookies?.session_id || null;
  const bearer = typeof request.headers.authorization === 'string'
    && request.headers.authorization.startsWith('Bearer ')
    ? request.headers.authorization.slice(7).trim()
    : null;
  const user = getSessionUser(sessionId)
    || (bearer ? getPeerTokenUser(bearer) : null);
  if (!user) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Authentication is required.' });
    return null;
  }
  // A peer that reaches us advertises its current addresses. Absorb them so a
  // rotated tunnel URL on the other side is repaired automatically.
  if (user.isPeer && user.peerHostId) {
    hostService.absorbIdentityHeaders(user.peerHostId, request.headers);
  }
  return user;
}

async function proxyApiRequest(request, reply, user, remotePathOverride = null) {
    const remotePath = remotePathOverride || buildRemotePath(request);
    if (isLocalOnly(remotePath)) {
      return reply.status(400).send({ error: `"${remotePath}" must be called on the local host.` });
    }

    const body = request.body === undefined || request.body === null || Object.keys(request.body || {}).length === 0
      ? null
      : request.body;

    try {
      const { res } = await hostService.openHostStream(request.params.hostId, remotePath, {
        method: request.method,
        body,
        headers: { [FORWARDED_ROLE_HEADER]: effectiveRole(user, request.headers) },
      });

      reply.hijack();
      const headers = filterHeaders(res.headers);
      reply.raw.writeHead(res.statusCode || 502, headers);
      res.pipe(reply.raw);
      res.on('error', () => {
        try { reply.raw.destroy(); } catch { /* ignore */ }
      });
    } catch (err) {
      return reply.status(502).send({ error: err.message });
    }
}

async function remoteProxyRoutes(fastify) {
  const imageProxyOptions = {
    bodyLimit: 7 * 1024 * 1024,
    onRequest: async (request, reply) => {
      const user = authenticate(request, reply);
      if (user) request.proxyUser = user;
    },
  };
  const imageProxyHandler = (request, reply) => {
    if (!request.proxyUser) return;
    const remotePath = `/api/terminals/${encodeURIComponent(request.params.id)}/clipboard-image`;
    return proxyApiRequest(request, reply, request.proxyUser, remotePath);
  };
  fastify.post('/api/remote/:hostId/terminals/:id/clipboard-image', imageProxyOptions, imageProxyHandler);
  fastify.post('/api/remote/:hostId/api/terminals/:id/clipboard-image', imageProxyOptions, imageProxyHandler);

  fastify.all('/api/remote/:hostId/*', async (request, reply) => {
    const user = authenticate(request, reply);
    if (!user) return;
    return proxyApiRequest(request, reply, user);
  });

  fastify.get('/ws/remote/:hostId/terminal/:sessionId', { websocket: true }, (socket, req) => {
    // Same origin policy as the local terminal socket: the browser still
    // connects to this host, so an unexpected origin is rejected here too.
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized origin.' }));
      socket.close();
      return;
    }

    const bearer = typeof req.headers.authorization === 'string'
      && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : null;
    const user = getSessionUser(req.cookies?.session_id)
      || (bearer ? getPeerTokenUser(bearer) : null);
    if (!user) {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized: valid session required.' }));
      socket.close();
      return;
    }
    if (user.isPeer && user.peerHostId) {
      hostService.absorbIdentityHeaders(user.peerHostId, req.headers);
    }

    const candidates = hostService.wsCandidates(req.params.hostId, `/ws/terminal/${req.params.sessionId}`);
    if (candidates.length === 0) {
      socket.send(JSON.stringify({ type: 'error', message: 'Host not found or not paired.' }));
      socket.close();
      return;
    }

    let index = 0;
    let upstream = null;
    let closed = false;
    // The browser can send input immediately after its socket opens, before the
    // upstream handshake completes. Queue those frames instead of dropping them.
    const pending = [];

    const cleanup = () => {
      closed = true;
      try { if (upstream) upstream.close(); } catch { /* ignore */ }
      try { socket.close(); } catch { /* ignore */ }
    };

    const attempt = () => {
      if (closed) return;
      if (index >= candidates.length) {
        socket.send(JSON.stringify({ type: 'error', message: 'Remote host unreachable.' }));
        cleanup();
        return;
      }
      const candidate = candidates[index++];
      const ws = new WebSocket(candidate.url, {
        headers: {
          Authorization: `Bearer ${candidate.token}`,
          'User-Agent': 'Citadel-Peer',
          [FORWARDED_ROLE_HEADER]: effectiveRole(user, req.headers),
          ...hostService.identityHeaders(),
        },
        handshakeTimeout: 12000,
      });
      upstream = ws;

      ws.on('open', () => {
        hostService.markHostSeen(req.params.hostId, candidate.baseUrl);
        while (pending.length) {
          const frame = pending.shift();
          try {
            ws.send(frame.data, { binary: frame.binary });
          } catch {
            break;
          }
        }
      });

      ws.on('message', (data, isBinary) => {
        try {
          socket.send(isBinary ? data : data.toString());
        } catch {
          cleanup();
        }
      });

      ws.on('close', () => {
        if (!closed) cleanup();
      });

      ws.on('error', () => {
        if (closed) return;
        // Try the next candidate address; only fail once they are exhausted.
        try { ws.close(); } catch { /* ignore */ }
        upstream = null;
        if (index < candidates.length) attempt();
        else {
          socket.send(JSON.stringify({ type: 'error', message: 'Remote terminal connection failed.' }));
          cleanup();
        }
      });
    };

    socket.on('message', (data, isBinary) => {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        try {
          upstream.send(isBinary ? data : data.toString());
        } catch {
          // Ignore: the close handler cleans up.
        }
        return;
      }
      // Keep only the most recent frames while connecting; terminal input is
      // latency-sensitive and a long queue is worse than dropping old keys.
      if (pending.length < 64) pending.push({ data: isBinary ? data : data.toString(), binary: isBinary });
    });

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    attempt();
  });
}

module.exports = remoteProxyRoutes;
