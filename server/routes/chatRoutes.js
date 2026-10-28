const { requireSessionAuth, getSessionUser } = require('../security/auth');
const { isAllowedOrigin } = require('../security/guard');
const defaultChat = require('../services/chatService');
const audit = require('../services/auditService');

function object(value, keys, required = keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
async function chatRoutes(fastify, options = {}) {
  const chat = options.chat || defaultChat, streams = new Set();
  fastify.addHook('onRequest', async (request, reply) => {
    await requireSessionAuth(request, reply);
    if (reply.sent) return;
    reply.header('cache-control', 'no-store');
    if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Administrator privileges are required.' });
    if (request.headers.origin && !isAllowedOrigin(request.headers.origin)) return reply.code(403).send({ error: 'Unauthorized origin.' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Unauthorized origin.' });
    if (Object.keys(request.query || {}).length) return reply.code(400).send({ error: 'Query parameters are not allowed.' });
  });
  fastify.addHook('preClose', async () => { for (const stop of streams) stop(); });
  fastify.addHook('onClose', async () => { await chat.close(); });
  const base = '/api/projects/:id/chat/sessions';
  function route(method, url, run, validate, action) {
    fastify.route({ method, url, bodyLimit: 65536, handler: async (request, reply) => {
      if (validate && !validate(request.body === undefined ? {} : request.body)) return reply.code(400).send({ error: 'Invalid chat request.' });
      try {
        const result = await run(request);
        if (action) audit.logAction({ userId: request.user.id, action: `chat_${action}`, targetType: 'project', targetId: request.params.id, ip: request.ip });
        return reply.code(action === 'message' ? 202 : 200).send(result);
      } catch (err) { return reply.code(err.statusCode || 503).send({ error: err.statusCode ? err.message : 'Chat is unavailable. Check OpenCode and AI Gateway.' }); }
    } });
  }
  const empty = value => object(value, []);
  const args = request => [request.user.id, request.params.id, request.params.chatId];
  route('GET', '/api/chat/status', () => chat.status());
  route('GET', base, request => chat.list(request.user.id, request.params.id));
  route('POST', base, request => chat.create(request.user.id, request.params.id), empty, 'created');
  route('GET', `${base}/:chatId`, request => chat.snapshot(...args(request)));
  route('POST', `${base}/:chatId/messages`, request => chat.message(...args(request), request.body), value => object(value, ['text', 'role', 'requestId']) && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 32000 && !value.text.includes('\0') && ['build', 'plan'].includes(value.role) && typeof value.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId), 'message');
  route('POST', `${base}/:chatId/cancel`, request => chat.action(...args(request), 'cancel'), empty, 'cancelled');
  route('POST', `${base}/:chatId/permissions/:requestId/reply`, request => chat.action(...args(request), 'permission', request.params.requestId, request.body), value => object(value, ['reply']) && ['once', 'reject'].includes(value.reply), 'permission_replied');
  route('POST', `${base}/:chatId/questions/:requestId/reply`, request => chat.action(...args(request), 'question', request.params.requestId, request.body), value => object(value, ['answers']) && Array.isArray(value.answers) && value.answers.length <= 20 && value.answers.every(answer => Array.isArray(answer) && answer.length <= 30 && answer.every(text => typeof text === 'string' && text.length <= 2000)), 'question_replied');
  route('POST', `${base}/:chatId/questions/:requestId/reject`, request => chat.action(...args(request), 'reject', request.params.requestId, {}), empty, 'question_rejected');
  fastify.get(`${base}/:chatId/events`, async (request, reply) => {
    let release, timer, batch, stopped = false, checking = false;
    const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); clearTimeout(batch); release?.(); streams.delete(stop); if (!reply.raw.writableEnded) reply.raw.end(); };
    const write = text => { if (!stopped && !reply.raw.write(text)) stop(); };
    const update = end => { if (end) return stop(); if (!batch && !stopped) batch = setTimeout(() => { batch = null; write('event: update\ndata: {}\n\n'); }, 150); };
    reply.raw.once('close', stop);
    try { release = await chat.subscribe(...args(request), update); }
    catch (err) { if (stopped) return; return reply.code(err.statusCode || 503).send({ error: err.statusCode ? err.message : 'Chat events are unavailable.' }); }
    if (stopped || reply.raw.destroyed) { release(); return; }
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    streams.add(stop); reply.raw.once('close', stop);
    write('event: update\ndata: {}\n\n');
    timer = setInterval(async () => {
      if (checking || stopped) return;
      checking = true;
      try {
        const user = getSessionUser(request.user.sessionId);
        if (!user || user.id !== request.user.id || user.role !== 'admin') return stop();
        await chat.check(...args(request));
        write(': heartbeat\n\n');
        update();
      } catch { stop(); }
      finally { checking = false; }
    }, 10000);
    timer.unref();
  });
}
module.exports = chatRoutes;
