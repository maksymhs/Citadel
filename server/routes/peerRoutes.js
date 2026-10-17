/**
 * Peer update route.
 *
 * Lets another Citadel host ask this one to run its self-updater, so a single
 * "Update" action can roll out to the whole fleet. Authenticated with a shared
 * secret (CITADEL_PEER_TOKEN) sent in the X-Citadel-Peer-Token header — this
 * endpoint triggers the privileged updater, so it is deliberately separate from
 * the session-protected system routes and disabled unless a token is set.
 */
const crypto = require('node:crypto');
const { PEER_TOKEN } = require('../config');
const updateService = require('../services/updateService');
const auditService = require('../services/auditService');

function tokenMatches(provided) {
  if (!PEER_TOKEN || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(PEER_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function peerRoutes(fastify) {
  fastify.post('/api/system/peer-update', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!PEER_TOKEN) {
      return reply.status(404).send({ error: 'Peer updates are not enabled.' });
    }
    if (!tokenMatches(request.headers['x-citadel-peer-token'])) {
      return reply.status(401).send({ error: 'Invalid peer token.' });
    }

    try {
      // fanout:false prevents host A -> B -> A update loops.
      const res = await updateService.triggerUpdate({ fanout: false });
      auditService.logAction({
        userId: null,
        action: 'system_update_triggered',
        targetType: 'system',
        targetId: 'peer',
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = peerRoutes;
