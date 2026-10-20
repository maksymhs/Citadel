/**
 * Settings HTTP Routes
 *
 * Connection settings: the public URL an administrator reaches the panel on.
 * It drives the connection QR code and is trusted as a WebSocket origin, so the
 * terminal works when the panel is opened through it. It is a preference only —
 * nothing is exposed, no port is opened and no host service is touched.
 */
const { requireAuth } = require('../security/auth');
const { getDatabase } = require('../database/db');
const connectService = require('../services/connectService');
const auditService = require('../services/auditService');
const cloudflareTunnel = require('../services/cloudflareTunnelService');
const { PUBLIC_URL } = require('../config');

const STORED_KEY = 'connect.public_url';

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

function normalizePublicUrl(raw) {
  if (raw === null || raw === undefined) return { value: '' };
  const trimmed = String(raw).trim();
  if (!trimmed) return { value: '' };
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { error: 'Enter a valid URL, e.g. https://panel.example.com' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http:// and https:// URLs are supported.' };
  }
  return { value: withScheme.replace(/\/+$/, '') };
}

async function settingsRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/settings/connect', async () => {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(STORED_KEY);
    return {
      connect: {
        publicUrl: row ? row.value : '',
        envPublicUrl: PUBLIC_URL || '',
        envLocked: Boolean(PUBLIC_URL),
        effectiveUrl: connectService.getConnectInfo().url,
      },
    };
  });

  fastify.put('/api/settings/connect', { preHandler: requireAdmin }, async (request, reply) => {
    if (PUBLIC_URL) {
      return reply.status(409).send({
        error: 'The public URL is fixed by the CITADEL_PUBLIC_URL environment variable. Unset it to edit it here.',
      });
    }

    const result = normalizePublicUrl(request.body ? request.body.publicUrl : undefined);
    if (result.error) return reply.status(400).send({ error: result.error });

    const db = getDatabase();
    const now = new Date().toISOString();
    if (result.value) {
      db.prepare(`
        INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(STORED_KEY, result.value, now);
    } else {
      db.prepare('DELETE FROM app_config WHERE key = ?').run(STORED_KEY);
    }

    connectService.writeStoredPublicUrl(result.value);
    connectService._reset();
    auditService.logAction({
      userId: request.user.id,
      action: result.value ? 'connect_url_set' : 'connect_url_cleared',
      targetType: 'settings',
      targetId: 'connect',
      details: { publicUrl: result.value || null },
      ip: request.ip,
    });

    return {
      connect: {
        publicUrl: result.value,
        effectiveUrl: connectService.getConnectInfo().url,
      },
    };
  });

  // --- Own-domain Cloudflare tunnel (Settings → Tunnel) --------------------
  fastify.get('/api/settings/tunnel', { preHandler: requireAdmin }, async () => {
    const tunnel = cloudflareTunnel.getStatus();
    if (tunnel.job.phase === 'done') connectService._reset();
    return { tunnel };
  });

  fastify.post('/api/settings/tunnel', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const tunnel = cloudflareTunnel.start(request.body && request.body.domain);
      auditService.logAction({
        userId: request.user.id,
        action: 'tunnel_setup_started',
        targetType: 'settings',
        targetId: 'tunnel',
        details: { domain: tunnel.job.domain },
        ip: request.ip,
      });
      return { tunnel };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.delete('/api/settings/tunnel/setup', { preHandler: requireAdmin }, async () => {
    cloudflareTunnel.cancel();
    return { tunnel: cloudflareTunnel.getStatus() };
  });

  fastify.delete('/api/settings/tunnel', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      cloudflareTunnel.revertToQuick();
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
    connectService._reset();
    auditService.logAction({
      userId: request.user.id,
      action: 'tunnel_reverted_to_quick',
      targetType: 'settings',
      targetId: 'tunnel',
      details: {},
      ip: request.ip,
    });
    return { tunnel: cloudflareTunnel.getStatus() };
  });
}

module.exports = settingsRoutes;
