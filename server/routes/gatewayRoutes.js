/** Administrator-only local AI gateway setup and connection checks. */
const { requireAuth } = require('../security/auth');
const { isAllowedOrigin } = require('../security/guard');
const gateway = require('../services/gatewayService');
const audit = require('../services/auditService');

async function gatewayRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Administrator privileges are required.' });
    if (request.headers.origin && !isAllowedOrigin(request.headers.origin)) return reply.status(403).send({ error: 'Unauthorized origin.' });
  });
  fastify.addHook('onReady', () => gateway.resume());
  fastify.addHook('onClose', () => gateway.close());
  fastify.get('/api/settings/gateway', async () => { await gateway.refreshLogin(); return { gateway: gateway.status() }; });
  for (const [method, url, action, run] of [
    ['POST', '/install', 'gateway_installed', () => gateway.install()],
    ['POST', '/login', 'gateway_login_started', request => gateway.loginStart(request.body?.provider || 'codex')],
    ['POST', '/callback', 'gateway_callback_submitted', request => gateway.callback(request.body?.redirectUrl)],
    ['PUT', '', 'gateway_settings_saved', request => gateway.save(request.body || {})],
    ['DELETE', '/login', 'gateway_disconnected', () => gateway.disconnect()],
    ['POST', '/test', 'gateway_connection_tested', () => gateway.testConnection()],
  ]) {
    fastify.route({ method, url: `/api/settings/gateway${url}`, handler: async (request, reply) => {
      try {
        const result = await run(request);
        audit.logAction({ userId: request.user.id, action, targetType: 'gateway', ip: request.ip });
        return url === '/test' ? result : { gateway: result };
      } catch (err) { return reply.status(400).send({ error: err.message }); }
    } });
  }
  fastify.get('/api/settings/gateway/models', async (request, reply) => {
    try { return { models: await gateway.models() }; } catch (err) { return reply.status(400).send({ error: err.message }); }
  });
  fastify.get('/api/settings/gateway/discovery', async () => gateway.discovery());
  fastify.post('/api/settings/gateway/discovery/refresh', async (request, reply) => {
    const provider = request.body?.provider;
    if (provider !== undefined && !['codex', 'claude'].includes(provider)) return reply.status(400).send({ error: 'Provider must be codex or claude.' });
    try {
      const result = await gateway.refreshDiscovery({ provider });
      audit.logAction({ userId: request.user.id, action: 'gateway_discovery_refreshed', targetType: 'gateway', ip: request.ip });
      return result;
    } catch (err) { return reply.status(400).send({ error: err.message }); }
  });
}
module.exports = gatewayRoutes;
