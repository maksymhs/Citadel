/**
 * Citadel Security & Authentication Module
 */
const crypto = require('node:crypto');
const { getDatabase } = require('../database/db');
const { SESSION_TTL_DAYS } = require('../config');

const SCRYPT_KEYLEN = 64;

/**
 * Hash a password securely using scrypt with random salt
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return {
    hash: derivedKey.toString('hex'),
    salt,
  };
}

/**
 * Verify password against stored hash and salt
 */
function verifyPassword(password, hash, salt) {
  if (typeof password !== 'string' || typeof hash !== 'string' || typeof salt !== 'string') {
    return false;
  }
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const hashBuffer = Buffer.from(hash, 'hex');
  // A malformed/truncated stored hash must fail authentication, not throw.
  if (hashBuffer.length !== derivedKey.length) {
    return false;
  }
  return crypto.timingSafeEqual(derivedKey, hashBuffer);
}

/**
 * Check if the initial admin has been configured
 */
function isSetupComplete() {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  return row.count > 0;
}

/**
 * Register the initial admin user. Only allowed when no users exist.
 */
function createInitialAdmin(username, password) {
  if (isSetupComplete()) {
    throw new Error('Initial setup is already completed. Registration is disabled.');
  }

  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    throw new Error('Username must be at least 3 characters long.');
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  const cleanUsername = username.trim().toLowerCase();
  const { hash, salt } = hashPassword(password);
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  const db = getDatabase();
  // Conditional INSERT ... WHERE NOT EXISTS is atomic at the statement level, so
  // two concurrent setup requests (or two server processes during an update)
  // cannot both create an administrator. The check above is only a fast path.
  const res = db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, role, created_at, updated_at)
    SELECT ?, ?, ?, ?, 'admin', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM users)
  `).run(userId, cleanUsername, hash, salt, now, now);

  if (res.changes !== 1) {
    throw new Error('Initial setup is already completed. Registration is disabled.');
  }

  return { id: userId, username: cleanUsername, role: 'admin' };
}

/**
 * Replace a user's password and revoke every session. This is the offline
 * recovery path (`citadel reset-password`); there is no unauthenticated route.
 * Returns the user, or null when the username does not exist.
 */
function setUserPassword(username, password) {
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  const db = getDatabase();
  const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?')
    .get(String(username || '').trim().toLowerCase());
  if (!user) return null;

  const { hash, salt } = hashPassword(password);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE id = ?')
      .run(hash, salt, new Date().toISOString(), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  })();
  return user;
}

/**
 * Authenticate credentials and create a session
 */
function login(username, password) {
  if (!username || !password) {
    return null;
  }

  const db = getDatabase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user) {
    return null;
  }

  const valid = verifyPassword(password, user.password_hash, user.salt);
  if (!valid) {
    return null;
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at, last_active)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, user.id, expiresAt, nowIso, nowIso);

  return {
    sessionId,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
    expiresAt,
  };
}

/**
 * Validate session token and return user if valid
 */
function getSessionUser(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return null;
  }

  const db = getDatabase();
  const session = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, s.last_active, u.id AS user_id, u.username, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(sessionId);

  if (!session) {
    return null;
  }

  const now = new Date().toISOString();
  if (session.expires_at < now) {
    // Session expired, purge it
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  // Activity is informational, not an expiry extension. Polling should not
  // turn every authenticated GET into a WAL write; one update/minute suffices.
  if (!session.last_active || Date.parse(now) - Date.parse(session.last_active) >= 60000) {
    db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(now, sessionId);
  }

  return {
    id: session.user_id,
    username: session.username,
    role: session.role,
    sessionId: session.session_id,
  };
}

/**
 * Destroy a session
 */
function destroySession(sessionId) {
  if (!sessionId) return;
  const db = getDatabase();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function hashPeerToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Resolve an inbound peer bearer token to a synthetic admin identity bound to
 * the paired host. Only the SHA-256 hash is stored, so a database leak does not
 * expose usable credentials. Returns null for unknown/revoked tokens.
 */
function getPeerTokenUser(token) {
  if (!token || typeof token !== 'string') return null;
  const db = getDatabase();
  const row = db.prepare(`
    SELECT t.id AS token_id, t.host_id, t.user_id, h.name AS host_name
    FROM peer_tokens t
    JOIN fleet_hosts h ON h.id = t.host_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL
  `).get(hashPeerToken(token));

  if (!row) return null;

  db.prepare('UPDATE peer_tokens SET last_used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), row.token_id);

  return {
    id: row.user_id || `peer:${row.host_id}`,
    username: `peer:${row.host_name}`,
    role: 'admin',
    sessionId: null,
    peerHostId: row.host_id,
    isPeer: true,
  };
}

/**
 * Resolve the caller from either a browser session (cookie or bearer session
 * id) or an inbound peer token. Peer tokens are scoped to a paired host and
 * grant the same privileges as an administrator, because the remote proxy has
 * to be able to reach the whole panel API on the peer's behalf.
 */
function resolveAuthUser(request) {
  const sessionId = request.cookies?.session_id || extractBearerToken(request.headers?.authorization);
  const user = getSessionUser(sessionId);
  if (user) return user;
  return getPeerTokenUser(extractBearerToken(request.headers?.authorization));
}

/**
 * Fastify preHandler hook for routes requiring authentication
 */
async function requireAuth(request, reply) {
  const user = resolveAuthUser(request);

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication is required to access this resource.',
    });
  }

  request.user = user;
}

/**
 * Fastify preHandler hook for local-management routes (pairing, host list,
 * fleet CRUD). A paired host token is admin-equivalent for proxied panel APIs,
 * but it must not be able to create invitations or manage the peer list.
 */
async function requireSessionAuth(request, reply) {
  const sessionId = request.cookies?.session_id || extractBearerToken(request.headers?.authorization);
  const user = getSessionUser(sessionId);
  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'A local panel session is required for this resource.',
    });
  }
  request.user = user;
}

/**
 * Fastify preHandler hook for peer-only routes (announce/revoke). A browser
 * session is not sufficient: the caller must present a paired host token.
 */
async function requirePeerAuth(request, reply) {
  const user = resolveAuthUser(request);
  if (!user || !user.isPeer) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'A paired host token is required for this resource.',
    });
  }
  request.user = user;
}

function extractBearerToken(authHeader) {
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  isSetupComplete,
  createInitialAdmin,
  setUserPassword,
  login,
  getSessionUser,
  destroySession,
  requireAuth,
  requireSessionAuth,
  requirePeerAuth,
  resolveAuthUser,
  getPeerTokenUser,
  hashPeerToken,
  extractBearerToken,
};
