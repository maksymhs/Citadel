/**
 * Fleet monitor HTTP routes: live overview of every machine, per-machine
 * history, and the alert/notification settings. Always served by this panel
 * (it is the one watching the others), so they require a local session.
 */
const { requireSessionAuth } = require('../security/auth');
const monitorService = require('../services/monitorService');
const auditService = require('../services/auditService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

async function monitorRoutes(fastify) {
  fastify.addHook('preHandler', requireSessionAuth);

  fastify.get('/api/monitor/overview', async () => monitorService.getOverview());

  // Probe everything right now instead of waiting for the next tick.
  fastify.post('/api/monitor/refresh', { preHandler: requireAdmin }, async () => {
    await monitorService.pollOnce();
    return monitorService.getOverview();
  });

  fastify.get('/api/monitor/hosts/:id/history', async (request) => (
    monitorService.getHistory(request.params.id, request.query && request.query.hours)
  ));

  fastify.get('/api/monitor/config', async () => ({ config: monitorService.getPublicConfig() }));

  fastify.put('/api/monitor/config', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const config = monitorService.updateConfig(request.body || {});
      auditService.logAction({
        userId: request.user.id,
        action: 'monitor_config_updated',
        targetType: 'monitor',
        targetId: 'config',
        ip: request.ip,
      });
      return { config };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.post('/api/monitor/test', { preHandler: requireAdmin }, async () => monitorService.sendTest());
}

module.exports = monitorRoutes;
