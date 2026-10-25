/**
 * AI CLI Agent HTTP Routes
 */
const { requireAuth } = require('../security/auth');
const { requireModule } = require('../modules/registry');
const agentRegistry = require('../services/agentRegistry');
const auditService = require('../services/auditService');

async function agentRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireModule('agents'));

  // List all available CLI agents with live installation status
  fastify.get('/api/agents', async () => {
    return {
      agents: agentRegistry.listAgents(),
    };
  });

  // Launch an agent inside a persistent terminal session for a project
  fastify.post('/api/agents/launch', async (request, reply) => {    const { projectId, agentId, extraArgs } = request.body || {};

    if (!projectId || !agentId) {
      return reply.status(400).send({ error: 'Both projectId and agentId are required.' });
    }

    if (agentId === 'claude' && require('../services/gatewayService').status().enabled && request.user.role !== 'admin') {
      return reply.status(403).send({ error: 'Administrator privileges are required to use AI Gateway.' });
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

  // Install a CLI agent by running its official one-line installer in a terminal
  fastify.post('/api/agents/install', async (request, reply) => {
    const { agentId, action = 'install' } = request.body || {};
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Administrator privileges are required.' });

    if (!agentId) {
      return reply.status(400).send({ error: 'agentId is required.' });
    }

    try {
      const result = agentRegistry.installAgent({ agentId, action });
      auditService.logAction({
        userId: request.user.id,
        action: 'agent_install_started',
        targetType: 'agent',
        targetId: agentId,
        details: { action, sessionId: result.session.sessionId, command: result.agent.installCommand },
        ip: request.ip,
      });

      return result;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = agentRoutes;
