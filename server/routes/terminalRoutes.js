/**
 * Terminal Sessions Management HTTP Routes
 */
const { requireAuth, resolveAuthUser } = require('../security/auth');
const terminalManager = require('../services/terminalManager');
const auditService = require('../services/auditService');
const { validateSafePath } = require('../security/guard');
const { PROJECTS_DIR, TERMINAL_ADMIN_USER } = require('../config');
const { getSession, canAccessSession, canCreateGlobalSession, effectiveRole } = require('../security/terminalAccess');
const terminalImageService = require('../services/terminalImageService');

const TERMINAL_IMAGE_BODY_LIMIT = 7 * 1024 * 1024;

async function terminalRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.post('/api/terminals/:id/clipboard-image', {
    bodyLimit: TERMINAL_IMAGE_BODY_LIMIT,
    onRequest: async (request, reply) => {
      const user = resolveAuthUser(request);
      if (!user) return reply.status(401).send({ error: 'Authentication is required.' });
      request.user = user;
      const session = getSession(request.params.id);
      if (!session || session.status === 'closed') return reply.status(404).send({ error: 'Terminal session not found or closed.' });
      if (!canAccessSession(user, session, request.headers)) {
        return reply.status(403).send({ error: 'Administrator privileges are required for System terminals.' });
      }
      if (session.project_id && require('../services/gatewayService').status().enabled
        && effectiveRole(user, request.headers) !== 'admin') {
        return reply.status(403).send({ error: 'Administrator privileges are required for gateway-enabled project terminals.' });
      }
      request.terminalImageSession = session;
    },
  }, async (request, reply) => {
    const { mimeType, content } = request.body || {};
    try {
      const saved = await terminalImageService.save({
        mimeType,
        content,
        asAdmin: request.terminalImageSession.project_id === null && Boolean(TERMINAL_ADMIN_USER),
      });
      auditService.logAction({
        userId: request.user.id,
        action: 'terminal_clipboard_image_saved',
        targetType: 'terminal',
        targetId: request.params.id,
        details: { mimeType: saved.mimeType, size: saved.size },
        ip: request.ip,
      });
      return { path: saved.path };
    } catch (err) {
      const known = ['Unsupported or invalid image data.', 'Temporary image storage is full. Wait for older images to expire.', 'Image storage is busy. Try again.', 'Private image storage is unavailable on this host.'];
      const message = known.includes(err.message) ? err.message : 'Could not save the image on the terminal host.';
      return reply.status(err.statusCode || (known.includes(err.message) ? 503 : 500)).send({ error: message });
    }
  });

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
