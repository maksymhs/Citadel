/** Authenticated HTTP/WebSocket bridge to the optional, password-protected local code-server. */
const http = require('node:http');
const { WebSocket } = require('ws');
const { requireAuth } = require('../security/auth');
const { isAllowedOrigin } = require('../security/guard');
const editor = require('../services/editorService');
const openCodeWeb = editor.openCodeWeb;
const audit = require('../services/auditService');
const DROP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'authorization', 'cookie', 'set-cookie']);
const OPENCODE_ABSOLUTE_PATHS = new Set(['/assets', '/api', '/global', '/event']);
function filtered(headers) { return Object.fromEntries(Object.entries(headers).filter(([key]) => !DROP.has(key.toLowerCase()))); }
async function editorRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Administrator privileges are required.' });
    if (request.headers.origin && !isAllowedOrigin(request.headers.origin)) return reply.status(403).send({ error: 'Unauthorized origin.' });
  });
  fastify.addHook('onClose', async () => { await editor.close(); await openCodeWeb.close(); });
  fastify.get('/api/editor', () => ({ editor: editor.status() }));
  fastify.get('/api/opencode-web', () => ({ opencode: openCodeWeb.status() }));
  fastify.post('/api/projects/:id/opencode-web', async (request, reply) => {
    try {
      const result = await openCodeWeb.open(request.params.id);
      audit.logAction({ userId: request.user.id, action: 'opencode_web_opened', targetType: 'project', targetId: request.params.id, ip: request.ip });
      return result;
    } catch (err) { return reply.status(400).send({ error: err.message }); }
  });
  fastify.delete('/api/opencode-web', async (request, reply) => {
    await openCodeWeb.close();
    audit.logAction({ userId: request.user.id, action: 'opencode_web_stopped', targetType: 'opencode-web', targetId: null, ip: request.ip });
    return { opencode: openCodeWeb.status() };
  });
  for (const [method, url, action, run] of [
    ['POST', '/api/editor/install', 'browser_editor_installed', () => editor.install()],
    ['POST', '/api/projects/:id/editor', 'browser_editor_opened', req => editor.open(req.params.id)],
    ['DELETE', '/api/editor', 'browser_editor_stopped', async () => { await editor.close(); return editor.status(); }],
  ]) {
    fastify.route({ method, url, handler: async (request, reply) => {
      try {
        const result = await run(request);
        audit.logAction({ userId: request.user.id, action, targetType: 'editor', targetId: request.params.id || null, ip: request.ip });
        return url.includes(':id') ? result : { editor: result };
      } catch (err) { return reply.status(400).send({ error: err.message }); }
    } });
  }
  await fastify.register(async function editorProxy(proxy) {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 }, (request, body, done) => done(null, body));
    function routeTarget(request) {
      const isOpenCode = request.raw.url.startsWith('/opencode/');
      const target = isOpenCode ? openCodeWeb.target(request.params.projectId) : editor.target(request.params.projectId);
      const rest = request.params['*'] || '';
      const query = request.raw.url.includes('?') ? request.raw.url.slice(request.raw.url.indexOf('?')) : '';
      return { ...target, isOpenCode, path: `/${rest}${query}` };
    }
    function routeAbsoluteOpenCode(request) {
      const target = openCodeWeb.currentTarget();
      const requestUrl = request.raw.url;
      const rawPath = requestUrl.split('?')[0];
      const route = [...OPENCODE_ABSOLUTE_PATHS].find(prefix => rawPath === prefix || rawPath.startsWith(`${prefix}/`));
      if (!route) throw new Error('OpenCode route is not allowed.');
      if (route !== '/assets') {
        const referer = request.headers.referer || '';
        if (!referer.includes(`/opencode/${encodeURIComponent(target.projectId)}/`)) throw new Error('OpenCode route is not associated with the active project.');
      }
      return { ...target, isOpenCode: true, projectId: target.projectId, path: requestUrl };
    }
    function isAbsoluteOpenCodePath(request) {
      const pathname = request.raw.url.split('?')[0];
      return [...OPENCODE_ABSOLUTE_PATHS].some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
    }
    async function forward(request, reply) {
      let target;
      try { target = isAbsoluteOpenCodePath(request) ? routeAbsoluteOpenCode(request) : routeTarget(request); } catch (err) { return reply.status(503).send({ error: err.message }); }
      const headers = { ...filtered(request.headers), ...(target.cookie ? { cookie: target.cookie } : {}), ...(target.auth ? { authorization: target.auth } : {}) };
      const upstream = http.request({ hostname: '127.0.0.1', port: target.port, path: target.path, method: request.method, headers, timeout: 30000 }, response => {
        const outgoing = filtered(response.headers);
        if (outgoing.location?.startsWith('/') && request.raw.url.startsWith('/opencode/')) outgoing.location = `/opencode/${encodeURIComponent(request.params.projectId)}${outgoing.location}`;
        if (outgoing.location?.startsWith('/') && request.raw.url.startsWith('/editor/')) outgoing.location = `/editor/${encodeURIComponent(request.params.projectId)}${outgoing.location}`;
        if (outgoing.location && /^https?:/i.test(outgoing.location)) {
          response.destroy(); reply.status(502).send({ error: 'Unexpected editor redirect.' }); return;
        }
        reply.code(response.statusCode || 502);
        for (const [key, value] of Object.entries(outgoing)) if (value !== undefined) reply.header(key, value);
        reply.header('cache-control', 'no-store');
        reply.send(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!reply.sent) reply.status(502).send({ error: 'Browser editor connection failed.' }); });
      request.raw.on('aborted', () => upstream.destroy());
      reply.raw.on('close', () => { if (!reply.raw.writableEnded) upstream.destroy(); });
      if (Buffer.isBuffer(request.body)) upstream.write(request.body);
      upstream.end();
      // Response arrives on the stream callback, rather than through Fastify's
      // async return path. Keep its lifecycle open until reply.send is called.
      return reply;
    }
    function forwardSocket(socket, request) {
      let target;
      try { target = isAbsoluteOpenCodePath(request) ? routeAbsoluteOpenCode(request) : routeTarget(request); } catch { socket.close(1008, 'Editor unavailable.'); return; }
      const isOpenCode = target.isOpenCode;
      const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(v => v.trim()).filter(Boolean);
      const upstream = new WebSocket(`ws://127.0.0.1:${target.port}${target.path}`, protocols, { headers: { ...(target.cookie ? { cookie: target.cookie } : {}), ...(target.auth ? { authorization: target.auth } : {}), host: request.headers.host, ...(request.headers.origin ? { origin: request.headers.origin } : {}) }, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
      const release = isOpenCode ? () => {} : editor.socketOpened();
      let closed = false, queuedBytes = 0;
      const pending = [];
      const close = () => {
        if (closed) return;
        closed = true; release();
        try { upstream.close(); socket.close(); } catch { /* closed already */ }
      };
      upstream.on('open', () => { for (const [data, binary] of pending) upstream.send(data, { binary }); pending.length = 0; });
      upstream.on('message', (data, binary) => {
        if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 16 * 1024 * 1024) socket.send(data, { binary }); else close();
      });
      socket.on('message', (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount < 16 * 1024 * 1024) upstream.send(data, { binary }); else close();
        } else if (!closed && queuedBytes + data.length < 1024 * 1024) { queuedBytes += data.length; pending.push([data, binary]); }
        else close();
      });
      upstream.on('error', close); upstream.on('close', close); socket.on('error', close); socket.on('close', close);
    }
    const options = { config: { helmet: false, rateLimit: false } };
    proxy.route({ method: 'GET', url: '/editor/:projectId/*', ...options, handler: forward, wsHandler: forwardSocket });
    proxy.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/editor/:projectId/*', ...options, handler: forward });
    proxy.route({ method: 'GET', url: '/opencode/:projectId/*', ...options, handler: forward, wsHandler: forwardSocket });
    proxy.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/opencode/:projectId/*', ...options, handler: forward });
    proxy.route({ method: 'GET', url: '/opencode/:projectId', ...options, handler: forward });
    proxy.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/opencode/:projectId', ...options, handler: forward });
    for (const route of ['/assets/*', '/api/*', '/global/*', '/event', '/event/*', '/assets', '/api', '/global']) {
      proxy.route({ method: 'GET', url: route, ...options, handler: forward, wsHandler: forwardSocket });
      proxy.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: route, ...options, handler: forward });
    }
  });
}
module.exports = editorRoutes;
