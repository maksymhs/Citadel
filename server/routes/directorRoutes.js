/** Administrator-only configuration and control for the Telegram project director. */
const { requireAuth } = require('../security/auth');
const { isAllowedOrigin } = require('../security/guard');
const audit = require('../services/auditService');
const { createDirectorRuntime } = require('../services/directorRuntime');
async function directorRoutes(fastify, options = {}) {
  const runtime = options.runtime || createDirectorRuntime(), director = runtime.service;
  fastify.addHook('onListen', async () => {
    if (options.startRuntime === false) return;
    const address = fastify.server.address();
    runtime.start(`http://127.0.0.1:${address.port}`);
  });
  fastify.addHook('onClose', async () => runtime.close());
  fastify.addHook('preHandler', async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Administrator privileges are required.' });
    if (request.headers.origin && !isAllowedOrigin(request.headers.origin)) return reply.code(403).send({ error: 'Unauthorized origin.' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Unauthorized origin.' });
    reply.header('cache-control', 'no-store');
  });
  function route(method, url, action, run) {
    fastify.route({ method, url: '/api/director' + url, bodyLimit: 65536, handler: async (request, reply) => {
      try {
        const result = await run(request);
        if (action) audit.logAction({ userId: request.user.id, action: 'director_' + action, targetType: 'project', targetId: request.params.id || null, ip: request.ip });
        return result;
      } catch (err) { return reply.code(err.statusCode || 400).send({ error: err.statusCode ? err.message : 'Director operation failed; inspect configuration and project state.' }); }
    } });
  }
  route('GET', '', null, () => ({ ...director.snapshot(), runtime: runtime.status() }));
  route('PUT', '/config', 'configured', r => ({ config: director.configure(r.body) }));
  route('PUT', '/projects/:id', 'policy_saved', r => ({ project: director.configureProject(r.params.id, r.body || {}) }));
  route('POST', '/projects/:id/diagnose', 'diagnosed', r => director.diagnose(r.params.id));
  route('POST', '/projects/:id/instructions', 'instructed', r => ({ job: director.enqueue(r.body?.kind || 'execute', r.params.id, r.body?.instruction) }));
  route('POST', '/projects/:id/control', 'controlled', r => {
    const action = r.body?.action;
    if (!['pause', 'resume', 'cancel'].includes(action)) throw Object.assign(new Error('Invalid control action.'), { statusCode: 400 });
    if (action === 'cancel') director.cancel(r.params.id); else director.pause(r.params.id, action === 'pause');
    return { accepted: true };
  });
  route('POST', '/decisions/:id/answer', 'decision_answered', r => director.answer(r.params.id, r.body?.answer, `panel:${r.user.id}`));
  route('POST', '/control', 'global_control', r => {
    if (!['pause', 'resume'].includes(r.body?.action)) throw Object.assign(new Error('Invalid global control action.'), { statusCode: 400 });
    director.pause(null, r.body.action === 'pause'); return { accepted: true };
  });
}
module.exports = directorRoutes;
