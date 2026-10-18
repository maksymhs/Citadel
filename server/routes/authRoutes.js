/**
 * Authentication HTTP Routes
 */
const {
  isSetupComplete,
  createInitialAdmin,
  login,
  destroySession,
  requireAuth,
} = require('../security/auth');
const auditService = require('../services/auditService');
const { SESSION_TTL_DAYS } = require('../config');

// Throttle credential endpoints per client + username. request.ip is the socket
// address for untrusted clients (forwarded headers are only honoured from trusted
// proxies, see CITADEL_TRUST_PROXY), so spoofing X-Forwarded-For does not reset
// the bucket; the username component also stops source-IP rotation from
// brute-forcing a single account.
const credentialRateLimit = {
  max: 8,
  timeWindow: '5 minutes',
  keyGenerator: (request) => `${request.ip}:${(request.body && request.body.username) || ''}`,
};

// Session cookies are set with the full attribute set in one place so setup,
// login and logout cannot drift apart. The session id itself is never returned
// in a JSON body: the cookie is the only browser channel.
function sessionCookieOptions(request) {
  return {
    path: '/',
    httpOnly: true,
    secure: request.protocol === 'https',
    sameSite: 'strict',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  };
}

async function authRoutes(fastify) {
  // Check if system has been initialized
  fastify.get('/api/auth/status', async () => {
    return {
      setupComplete: isSetupComplete(),
    };
  });

  // Setup initial admin account (only allowed once)
  fastify.post('/api/auth/setup', { config: { rateLimit: credentialRateLimit } }, async (request, reply) => {
    const { username, password } = request.body || {};
    try {
      const user = createInitialAdmin(username, password);
      auditService.logAction({
        userId: user.id,
        action: 'system_setup_admin_created',
        ip: request.ip,
      });

      // Auto login newly created admin
      const session = login(username, password);
      reply.setCookie('session_id', session.sessionId, sessionCookieOptions(request));

      return {
        success: true,
        user: session.user,
      };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Login
  fastify.post('/api/auth/login', { config: { rateLimit: credentialRateLimit } }, async (request, reply) => {
    const { username, password } = request.body || {};
    const session = login(username, password);

    if (!session) {
      auditService.logAction({
        userId: null,
        action: 'login_failed',
        details: { attemptedUser: username },
        ip: request.ip,
      });
      return reply.status(401).send({ error: 'Invalid username or password.' });
    }

    auditService.logAction({
      userId: session.user.id,
      action: 'login_success',
      ip: request.ip,
    });

    reply.setCookie('session_id', session.sessionId, sessionCookieOptions(request));

    return {
      success: true,
      user: session.user,
    };
  });

  // Logout
  fastify.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const sessionId = request.cookies?.session_id || request.headers?.authorization?.replace('Bearer ', '');
    destroySession(sessionId);

    auditService.logAction({
      userId: request.user.id,
      action: 'logout',
      ip: request.ip,
    });

    reply.clearCookie('session_id', { path: '/' });
    return { success: true };
  });

  // Current authenticated user
  fastify.get('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    return {
      user: request.user,
    };
  });
}

module.exports = authRoutes;
