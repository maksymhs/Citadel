/**
 * Terminal Sessions Management HTTP Routes
 */
const { requireAuth } = require('../security/auth');
const terminalManager = require('../services/terminalManager');
const auditService = require('../services/auditService');
const { validateSafePath } = require('../security/guard');
const { PROJECTS_DIR } = require('../config');

async function terminalRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List terminal sessions
  fastify.get('/api/terminals', async (request) => {
    const projectId = request.query?.projectId || null;
    const globalOnly = request.query?.scope === 'global';
    return {
      sessions: terminalManager.listSessions(projectId, globalOnly),
      tmuxAvailable: terminalManager.isTmuxAvailable(),
      runAsUser: terminalManager.getAdminTerminalUser(),
    };
  });

  // Create new terminal session
  fastify.post('/api/terminals', async (request, reply) => {
    const { projectId, name, cwd, cols, rows } = request.body || {};

    // Any ad-hoc cwd supplied by the client must stay inside the managed projects tree.
    // When projectId is given, the project's own (admin-approved) path is used instead.
    let safeCwd;
    if (cwd && !projectId) {
      try {
        safeCwd = validateSafePath(cwd, PROJECTS_DIR);
      } catch (err) {
        return reply.status(400).send({ error: err.message });
      }
    }

    try {
      const session = terminalManager.createSession({
        projectId,
        name: name || 'Terminal',
        cwd: safeCwd,
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

  // Toggle tmux copy-mode (scrollback browsing) for a session
  fastify.post('/api/terminals/:id/copy-mode', async (request, reply) => {
    const sessionId = request.params.id;
    const action = request.body?.action === 'exit' ? 'exit' : 'enter';

    const result = terminalManager.tmuxCopyMode(sessionId, action);
    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    auditService.logAction({
      userId: request.user.id,
      action: action === 'exit' ? 'terminal_copy_mode_exit' : 'terminal_copy_mode_enter',
      targetType: 'terminal',
      targetId: sessionId,
      details: { tmuxSession: result.tmuxSession },
      ip: request.ip,
    });

    return result;
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
