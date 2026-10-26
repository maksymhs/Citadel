/** Shared authorization rules for persistent terminal sessions. */
const { getDatabase } = require('../database/db');

const FORWARDED_ROLE_HEADER = 'x-citadel-origin-role';

function getSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return getDatabase().prepare('SELECT id, project_id, status FROM term_sessions WHERE id = ?').get(sessionId) || null;
}

function effectiveRole(user, headers = {}) {
  if (!user) return null;
  if (!user.isPeer) return user.role;
  const forwardedRole = String(headers[FORWARDED_ROLE_HEADER] || '').toLowerCase();
  return forwardedRole || 'viewer';
}

function canAccessSession(user, session, headers = {}) {
  if (!user || !session) return false;
  return session.project_id !== null || effectiveRole(user, headers) === 'admin';
}

function canCreateGlobalSession(user, headers = {}) {
  return effectiveRole(user, headers) === 'admin';
}

module.exports = { FORWARDED_ROLE_HEADER, getSession, effectiveRole, canAccessSession, canCreateGlobalSession };
