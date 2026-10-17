/**
 * Terminal Sessions Management HTTP Routes
 */
const { requireAuth } = require('../security/auth');
const terminalManager = require('../services/terminalManager');
const auditService = require('../services/auditService');

async function terminalRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List terminal sessions
  fastify.get('/api/terminals', async (request) => {
    const projectId = request.query?.projectId || null;
    return {
      sessions: terminalManager.listSessions(projectId),
      tmuxAvailable: terminalManager.isTmuxAvailable(),
    };
  });

  // Create new terminal session
  fastify.post('/api/terminals', async (request, reply) => {
    const { projectId, name, cwd, cols, rows } = request.body || {};
    try {
      const session = terminalManager.createSession({
        projectId,
        name: name || 'Terminal',
        cwd,
        cols,
        rows,
      });

      auditService.logAction({
        userId: request.user.id,
        action: 'terminal_session_created',
        targetType: 'terminal',
        targetId: session.sessionId,
        details: { projectId, tmuxSession: session.tmuxSession },
        ip: request.ip,
      });

      return { session };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Kill terminal session
  fastify.delete('/api/terminals/:id', async (request, reply) => {
    const sessionId = request.params.id;
    try {
      const res = terminalManager.killSession(sessionId);
      auditService.logAction({
        userId: request.user.id,
        action: 'terminal_session_killed',
        targetType: 'terminal',
        targetId: sessionId,
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = terminalRoutes;
