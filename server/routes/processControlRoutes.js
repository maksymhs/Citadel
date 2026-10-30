/**
 * Administrator-only explicit process signals; successful delivery is audited, not implied exit.
 */
const { requireAuth } = require('../security/auth');
const processControl = require('../services/processControlService');
const auditService = require('../services/auditService');

async function processControlRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.post('/api/system/processes/:pid/terminate', async (request, reply) => {
    if (request.user.role !== 'admin') {
      return reply.status(403).send({ error: 'Administrator privileges are required.' });
    }
    const { identity, signal } = request.body || {};
    try {
      const result = processControl.terminateProcess({ pid: request.params.pid, identity, signal });
      auditService.logAction({
        userId: request.user.id,
        action: 'process_signal_sent',
        targetType: 'process',
        targetId: String(result.pid),
        details: { pid: result.pid, signal: result.signal },
        ip: request.ip,
      });
      return result;
    } catch (err) {
      return reply.status(err.statusCode || 503).send({ error: err.statusCode ? err.message : 'The process could not be safely signaled.' });
    }
  });
}

module.exports = processControlRoutes;
