/**
 * NexusVPS Security & Authentication Module
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
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const hashBuffer = Buffer.from(hash, 'hex');
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
  db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'admin', ?, ?)
  `).run(userId, cleanUsername, hash, salt, now, now);

  return { id: userId, username: cleanUsername, role: 'admin' };
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
    SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username, u.role
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

  // Update last_active
  db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(now, sessionId);

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

/**
 * Fastify preHandler hook for routes requiring authentication
 */
async function requireAuth(request, reply) {
  const sessionId = request.cookies?.session_id || extractBearerToken(request.headers?.authorization);
  const user = getSessionUser(sessionId);

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication is required to access this resource.',
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
  login,
  getSessionUser,
  destroySession,
  requireAuth,
};
