/**
 * NexusVPS Audit Logging Service
 */
const { getDatabase } = require('../database/db');

function logAction({ userId, action, targetType = null, targetId = null, details = null, ip = null }) {
  try {
    const db = getDatabase();
    const now = new Date().toISOString();

    let cleanDetails = null;
    if (details) {
      if (typeof details === 'object') {
        // Redact any sensitive keys
        const sanitized = { ...details };
        for (const key of Object.keys(sanitized)) {
          if (/password|token|secret|auth|cookie|key/i.test(key)) {
            sanitized[key] = '[REDACTED]';
          }
        }
        cleanDetails = JSON.stringify(sanitized);
      } else {
        cleanDetails = String(details);
      }
    }

    db.prepare(`
      INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId || 'system', action, targetType, targetId, cleanDetails, ip, now);
  } catch (err) {
    console.error('[AuditService] Error logging action:', err.message);
  }
}

function getAuditLogs({ limit = 50, offset = 0 } = {}) {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM audit_logs
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  return rows.map((r) => ({
    ...r,
    details: r.details ? safeParseJson(r.details) : null,
  }));
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

module.exports = {
  logAction,
  getAuditLogs,
};
