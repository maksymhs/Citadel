/**
 * Secret Vault HTTP Routes
 *
 * Manage the single encrypted credential store. Listing never returns a value;
 * only metadata is exposed. Mutations require an administrator and are audited
 * (the value itself is never logged). Agents read secrets out-of-band through
 * the `citadel-creds` CLI rather than these endpoints.
 */
const { requireAuth } = require('../security/auth');
const secretStore = require('../services/secretStore');
const auditService = require('../services/auditService');
const secretSyncService = require('../services/secretSyncService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

async function secretRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/secrets', async () => ({ secrets: secretStore.listSecrets() }));

  fastify.post('/api/secrets', { preHandler: requireAdmin }, async (request, reply) => {
    const { name, value, kind, metadata } = request.body || {};
    try {
      const res = secretStore.setSecret(name, value, { kind, metadata: metadata || null });
      secretSyncService.scheduleSync();
      auditService.logAction({
        userId: request.user.id,
        action: 'secret_saved',
        targetType: 'secret',
        targetId: res.name,
        details: { kind: res.kind },
        ip: request.ip,
      });
      return { secret: { name: res.name, kind: res.kind, metadata: res.metadata, updated_at: res.updated_at } };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.delete('/api/secrets/:name', { preHandler: requireAdmin }, async (request, reply) => {
    const res = secretStore.removeSecret(request.params.name);
    if (!res.success) return reply.status(404).send({ error: 'Secret not found.' });
    secretSyncService.scheduleSync();
    auditService.logAction({
      userId: request.user.id,
      action: 'secret_deleted',
      targetType: 'secret',
      targetId: res.name,
      ip: request.ip,
    });
    return { success: true, name: res.name };
  });
}

module.exports = secretRoutes;
