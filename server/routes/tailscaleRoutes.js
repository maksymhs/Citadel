/**
 * Tailscale routes (Settings → Network & access → Tailscale).
 *
 * Read the state of Tailscale on this host and switch the panel's private
 * tailnet HTTPS address on or off. Administrators only; the panel is never
 * published to the Internet (no `funnel`).
 */
const { requireAuth } = require('../security/auth');
const tailscale = require('../services/tailscaleService');
const connectService = require('../services/connectService');
const auditService = require('../services/auditService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

async function tailscaleRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/network/tailscale', { preHandler: requireAdmin }, async () => ({
    tailscale: await tailscale.getStatus(),
  }));

  fastify.post('/api/network/tailscale/serve', { preHandler: requireAdmin }, async (request, reply) => {
    const result = await tailscale.enableServe();
    connectService._reset();
    auditService.logAction({
      userId: request.user.id,
      action: result.ok ? 'tailscale_serve_enabled' : 'tailscale_serve_failed',
      targetType: 'network',
      targetId: 'tailscale',
      ip: request.ip,
    });
    if (!result.ok) return reply.status(409).send({ error: result.message, ...result });
    return { tailscale: await tailscale.getStatus() };
  });

  fastify.delete('/api/network/tailscale/serve', { preHandler: requireAdmin }, async (request, reply) => {
    const result = await tailscale.disableServe();
    connectService._reset();
    auditService.logAction({
      userId: request.user.id,
      action: result.ok ? 'tailscale_serve_disabled' : 'tailscale_serve_failed',
      targetType: 'network',
      targetId: 'tailscale',
      ip: request.ip,
    });
    if (!result.ok) return reply.status(409).send({ error: result.message, ...result });
    return { tailscale: await tailscale.getStatus() };
  });
}

module.exports = tailscaleRoutes;
