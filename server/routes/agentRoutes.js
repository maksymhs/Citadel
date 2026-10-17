/**
 * AI CLI Agent HTTP Routes
 */
const { requireAuth } = require('../security/auth');
const agentRegistry = require('../services/agentRegistry');
const auditService = require('../services/auditService');

async function agentRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List all available CLI agents with live installation status
  fastify.get('/api/agents', async () => {
    return {
      agents: agentRegistry.listAgents(),
    };
  });

  // Launch an agent inside a persistent terminal session for a project
  fastify.post('/api/agents/launch', async (request, reply) => {
    const { projectId, agentId, extraArgs } = request.body || {};

    if (!projectId || !agentId) {
      return reply.status(400).send({ error: 'Both projectId and agentId are required.' });
    }

    try {
      const result = agentRegistry.launchAgent({ projectId, agentId, extraArgs });
      auditService.logAction({
        userId: request.user.id,
        action: 'agent_launched',
        targetType: 'project',
        targetId: projectId,
        details: { agentId, sessionId: result.session.sessionId },
        ip: request.ip,
      });

      return result;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = agentRoutes;
