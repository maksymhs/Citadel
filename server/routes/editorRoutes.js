/** Authenticated HTTP/WebSocket bridge to the optional, password-protected local code-server. */
const http = require('node:http');
const { WebSocket } = require('ws');
const { requireAuth } = require('../security/auth');
const { isAllowedOrigin } = require('../security/guard');
const editor = require('../services/editorService');
const audit = require('../services/auditService');
const DROP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'authorization', 'cookie', 'set-cookie']);
function filtered(headers) { return Object.fromEntries(Object.entries(headers).filter(([key]) => !DROP.has(key.toLowerCase()))); }
async function editorRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Administrator privileges are required.' });
    if (request.headers.origin && !isAllowedOrigin(request.headers.origin)) return reply.status(403).send({ error: 'Unauthorized origin.' });
  });
  fastify.addHook('onClose', async () => { await editor.close(); });
  fastify.get('/api/editor', () => ({ editor: editor.status() }));
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
      const target = editor.target(request.params.projectId);
      const rest = request.params['*'] || '';
      const query = request.raw.url.includes('?') ? request.raw.url.slice(request.raw.url.indexOf('?')) : '';
      return { ...target, path: `/${rest}${query}` };
    }
    async function forward(request, reply) {
      let target;
      try { target = routeTarget(request); } catch (err) {
        return reply.status(503).send({ error: err.message });
      }
      const headers = { ...filtered(request.headers), cookie: target.cookie };
      const upstream = http.request({ hostname: '127.0.0.1', port: target.port, path: target.path, method: request.method, headers, timeout: 30000 }, response => {
        try {
          const outgoing = filtered(response.headers);
          if (outgoing.location && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(outgoing.location)) throw new Error('Unexpected editor redirect.');
          if (outgoing.location?.startsWith('/')) outgoing.location = `/editor/${encodeURIComponent(request.params.projectId)}${outgoing.location}`;
          reply.code(response.statusCode || 502);
          for (const [key, value] of Object.entries(outgoing)) if (value !== undefined) reply.header(key, value);
          reply.header('cache-control', 'no-store');
          reply.send(response);
        } catch {
          response.destroy();
          if (!reply.sent) reply.code(502).header('cache-control', 'no-store').send({ error: 'Browser editor response failed.' });
        }
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (reply.sent) return;
        reply.status(502).header('cache-control', 'no-store').send({ error: 'Browser editor connection failed.' });
      });
      request.raw.on('aborted', () => { upstream.destroy(); });
      reply.raw.on('close', () => { if (!reply.raw.writableEnded) upstream.destroy(); });
      if (Buffer.isBuffer(request.body)) upstream.write(request.body);
      upstream.end();
      // Response arrives on the stream callback, rather than through Fastify's
      // async return path. Keep its lifecycle open until reply.send is called.
      return reply;
    }
    function forwardSocket(socket, request) {
      let target;
      try { target = routeTarget(request); } catch { socket.close(1008, 'Editor unavailable.'); return; }
      const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(v => v.trim()).filter(Boolean);
      const upstream = new WebSocket(`ws://127.0.0.1:${target.port}${target.path}`, protocols, { headers: { cookie: target.cookie, host: request.headers.host, ...(request.headers.origin ? { origin: request.headers.origin } : {}) }, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
      const release = editor.socketOpened();
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
    const options = { helmet: false, config: { rateLimit: false } };
    proxy.route({ method: 'GET', url: '/editor/:projectId/*', ...options, handler: forward, wsHandler: forwardSocket });
    proxy.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/editor/:projectId/*', ...options, handler: forward });
  });
}
module.exports = editorRoutes;
