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
const securityAlerts = require('../services/securityAlertService');
const setupCode = require('../security/setupCode');
const { SESSION_TTL_DAYS } = require('../config');

// Throttle credential endpoints per client address. request.ip is the socket
// address for untrusted clients (forwarded headers are only honoured from trusted
// proxies, see CITADEL_TRUST_PROXY), so spoofing X-Forwarded-For does not reset
// the bucket. The key is built in the onRequest hook, before the body is parsed,
// so the username is not part of it: the limit is per address. Guessing spread
// over many addresses is what security alerts (failed-login bursts) are for.
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
    const setupComplete = isSetupComplete();
    return {
      setupComplete,
      // The setup screen asks for the code that `citadel setup-code` prints.
      setupCodeRequired: !setupComplete && Boolean(fastify.requireSetupCode),
    };
  });

  // Setup initial admin account (only allowed once)
  fastify.post('/api/auth/setup', { config: { rateLimit: credentialRateLimit } }, async (request, reply) => {
    const { username, password, setupCode: submittedCode } = request.body || {};
    // Only while setup is open: once an admin exists the code is never consulted.
    if (fastify.requireSetupCode && !isSetupComplete()) {
      const check = setupCode.verify(submittedCode);
      if (!check.ok) {
        auditService.logAction({ userId: null, action: 'setup_code_rejected', details: { reason: check.reason }, ip: request.ip });
        if (check.reason === 'locked') {
          return reply.status(429).send({ error: `Too many wrong setup codes. Try again in ${check.retryAfterSec} seconds.` });
        }
        const hint = 'Run "citadel setup-code" on this machine to see it.';
        const rotated = check.rotated ? ' Too many wrong attempts: a new code was generated.' : '';
        if (check.rotated) securityAlerts.setupCodeRotated({ ip: request.ip });
        return reply.status(403).send({ error: `Invalid setup code. ${hint}${rotated}` });
      }
    }
    try {
      const user = createInitialAdmin(username, password);
      setupCode.clear();
      securityAlerts.setupCompleted({ username: user.username, ip: request.ip });
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
      securityAlerts.loginFailed({ ip: request.ip, username });
      return reply.status(401).send({ error: 'Invalid username or password.' });
    }

    auditService.logAction({
      userId: session.user.id,
      action: 'login_success',
      ip: request.ip,
    });
    securityAlerts.loginSucceeded({ user: session.user, ip: request.ip, userAgent: request.headers['user-agent'] });

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
