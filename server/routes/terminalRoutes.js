/**
 * Terminal Sessions Management HTTP Routes
 */
const { requireAuth } = require('../security/auth');
const terminalManager = require('../services/terminalManager');
const auditService = require('../services/auditService');
const { validateSafePath } = require('../security/guard');
const { PROJECTS_DIR } = require('../config');
const { getSession, canAccessSession, canCreateGlobalSession, effectiveRole } = require('../security/terminalAccess');

async function terminalRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List terminal sessions
  fastify.get('/api/terminals', async (request) => {
    const projectId = request.query?.projectId || null;
    const globalOnly = request.query?.scope === 'global';
    const sessions = terminalManager.listSessions(projectId, globalOnly)
      .filter((session) => canAccessSession(request.user, session, request.headers));
    return {
      sessions,
      tmuxAvailable: terminalManager.isTmuxAvailable(),
      runAsUser: effectiveRole(request.user, request.headers) === 'admin' ? terminalManager.getAdminTerminalUser() : null,
    };
  });

  // Create new terminal session
  fastify.post('/api/terminals', async (request, reply) => {
    const { projectId, repoId, name, cwd, cols, rows } = request.body || {};
    if (!projectId && !canCreateGlobalSession(request.user, request.headers)) {
      return reply.status(403).send({ error: 'Administrator privileges are required for System terminals.' });
    }
    if (projectId && require('../services/gatewayService').status().enabled && effectiveRole(request.user, request.headers) !== 'admin') {
      return reply.status(403).send({ error: 'Administrator privileges are required for gateway-enabled project terminals.' });
    }

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
        repoId: projectId ? repoId : null,
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
        details: { projectId, repoId: projectId ? repoId : null, tmuxSession: session.tmuxSession, runAsUser: projectId ? null : terminalManager.getAdminTerminalUser() },
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
    if (!canAccessSession(request.user, getSession(sessionId), request.headers)) {
      return reply.status(403).send({ error: 'Administrator privileges are required for System terminals.' });
    }
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

  // Text of the screen plus scrollback (used by the "Select" view in the panel)
  fastify.get('/api/terminals/:id/capture', async (request, reply) => {
    const sessionId = request.params.id;
    if (!canAccessSession(request.user, getSession(sessionId), request.headers)) {
      return reply.status(403).send({ error: 'Administrator privileges are required for System terminals.' });
    }
    const result = terminalManager.captureSession(sessionId, request.query?.lines);
    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }
    auditService.logAction({
      userId: request.user.id,
      action: 'terminal_captured',
      targetType: 'terminal',
      targetId: sessionId,
      ip: request.ip,
    });
    return result;
  });

  // Kill terminal session
  fastify.delete('/api/terminals/:id', async (request, reply) => {
    const sessionId = request.params.id;
    if (!canAccessSession(request.user, getSession(sessionId), request.headers)) {
      return reply.status(403).send({ error: 'Administrator privileges are required for System terminals.' });
    }
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
