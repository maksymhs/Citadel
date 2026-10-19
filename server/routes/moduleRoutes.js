/**
 * Module Registry HTTP Routes
 *
 * Lists the core and optional modules with their availability and enablement,
 * and lets an administrator enable or disable an optional module. Toggling is a
 * preference change only: it never removes data, uninstalls packages or stops
 * host services.
 */
const { requireAuth } = require('../security/auth');
const registry = require('../modules/registry');
const auditService = require('../services/auditService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

async function moduleRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/modules', async () => ({
    modules: await registry.listModules(),
  }));

  fastify.post('/api/modules/:id/state', { preHandler: requireAdmin }, async (request, reply) => {
    const { enabled } = request.body || {};
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'A boolean "enabled" value is required.' });
    }
    try {
      const res = await registry.setEnabled(request.params.id, enabled);
      auditService.logAction({
        userId: request.user.id,
        action: enabled ? 'module_enabled' : 'module_disabled',
        targetType: 'module',
        targetId: request.params.id,
        details: { enabled },
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });
}

module.exports = moduleRoutes;
