/**
 * Plugin Management Routes
 */
const { requireAuth } = require('../security/auth');
const pluginLoader = require('../services/pluginLoader');
const auditService = require('../services/auditService');

async function pluginRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List plugins
  fastify.get('/api/plugins', async () => {
    return {
      plugins: pluginLoader.listPlugins(),
    };
  });

  // Toggle plugin state
  fastify.post('/api/plugins/:id/toggle', async (request, reply) => {
    const { enabled } = request.body || {};
    try {
      const res = pluginLoader.togglePlugin(request.params.id, Boolean(enabled));
      auditService.logAction({
        userId: request.user.id,
        action: 'plugin_toggled',
        targetType: 'plugin',
        targetId: request.params.id,
        details: { enabled },
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = pluginRoutes;
