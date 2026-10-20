/**
 * Host Identity, Pairing and Peer Routes
 *
 * Everything the panel needs to switch between paired Citadel instances:
 * this host's identity, pairing invites, the bidirectional handshake and the
 * peer-to-peer announce/revoke endpoints.
 */
const { requireSessionAuth, requirePeerAuth } = require('../security/auth');
const hostService = require('../services/hostService');
const pairingService = require('../services/pairingService');
const secretSyncService = require('../services/secretSyncService');
const auditService = require('../services/auditService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

function audit(request, action, targetId, details) {
  auditService.logAction({
    userId: request.user ? request.user.id : null,
    action,
    targetType: 'host',
    targetId: targetId || null,
    details,
    ip: request.ip,
  });
}

async function hostRoutes(fastify) {
  // --- Local identity (session required) ----------------------------------

  fastify.get('/api/host/identity', { preHandler: requireSessionAuth }, async () => ({
    host: hostService.getIdentity(),
    hosts: hostService.listHosts(),
  }));

  fastify.put('/api/host/identity', { preHandler: [requireSessionAuth, requireAdmin] }, async (request, reply) => {
    try {
      hostService.setInstanceName(request.body ? request.body.name : null);
      const host = hostService.getIdentity();
      audit(request, 'host_identity_renamed', host.instanceId, { name: host.name });
      return { host };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // --- Paired hosts -------------------------------------------------------

  fastify.get('/api/hosts', { preHandler: requireSessionAuth }, async () => ({
    hosts: hostService.listHosts(),
  }));

  // Lightweight reachability probe for the sidebar status dots. Deliberately
  // independent of the optional fleet module so host switching always works.
  fastify.get('/api/hosts/status', { preHandler: requireSessionAuth }, async (request) => {
    const only = request.query && typeof request.query.id === 'string' ? request.query.id : null;
    const list = hostService.listHosts().filter((host) => !only || host.id === only);
    const hosts = await Promise.all(list.map(async (host) => {
      try {
        const res = await hostService.requestHost(host.id, '/api/system/version', { timeout: 6000 });
        if (!res.ok) throw new Error((res.data && res.data.error) || `HTTP ${res.status}`);
        const version = (res.data && res.data.version) || {};
        return { id: host.id, online: true, version: version.version || null };
      } catch (err) {
        return { id: host.id, online: false, error: err.message };
      }
    }));
    return { hosts };
  });

  // Machines known by my paired hosts that I am not paired with. Discovery
  // only: pairing each one still needs that machine's own invitation.
  fastify.get('/api/hosts/suggestions', { preHandler: [requireSessionAuth, requireAdmin] }, async () => ({
    suggestions: await hostService.discoverSuggestions(),
  }));

  // Manual address repair. Needed only in the worst case: both machines use
  // ephemeral Cloudflare tunnels and both URLs rotated while offline, so no
  // announcement could get through. Entering one reachable address is enough;
  // the identity headers on the resulting call heal the other direction.
  fastify.put('/api/hosts/:id/address', { preHandler: [requireSessionAuth, requireAdmin] }, async (request, reply) => {
    const row = hostService.getHostRow(request.params.id);
    if (!row) return reply.status(404).send({ error: 'Host not found.' });
    const raw = request.body ? request.body.url : null;
    const normalized = hostService.normalizeUrl(raw);
    if (!normalized) return reply.status(400).send({ error: 'Enter a valid http:// or https:// address.' });
    const host = hostService.updateHostUrls(row.id, {
      name: row.name,
      url: normalized,
      urls: [normalized],
    });
    audit(request, 'host_address_updated', row.id, { url: normalized });
    return { host };
  });

  fastify.delete('/api/hosts/:id', { preHandler: [requireSessionAuth, requireAdmin] }, async (request, reply) => {
    try {
      const result = await hostService.unpairHost(request.params.id);
      audit(request, 'host_unpaired', request.params.id, { remote: result.remote });
      return result;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Re-merge the credential vault with a paired machine. Pairing from Settings
  // does this automatically; this endpoint lets the operator re-run it after
  // adding or rotating a token.
  fastify.post('/api/hosts/:id/sync-secrets', {
    preHandler: [requireSessionAuth, requireAdmin],
  }, async (request, reply) => {
    const row = hostService.getHostRow(request.params.id);
    if (!row) return reply.status(404).send({ error: 'Host not found.' });
    try {
      const result = await secretSyncService.syncWithHost(row.id);
      audit(request, 'host_secrets_synced', row.id, {
        imported: result.imported,
        remoteImported: result.remoteImported,
      });
      return result;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // --- Pairing ------------------------------------------------------------

  // Create a single-use invitation (QR + link) to show on this machine.
  fastify.post('/api/pair/invite', { preHandler: [requireSessionAuth, requireAdmin] }, async (request) => {
    const invite = hostService.createInvite({ userId: request.user.id });
    audit(request, 'host_pair_invite_created', invite.inviteId, { expiresAt: invite.expiresAt });
    return { invite };
  });

  // Redeem a scanned/pasted code: pairs both directions and stores the host.
  fastify.post('/api/pair/redeem', { preHandler: [requireSessionAuth, requireAdmin] }, async (request, reply) => {
    try {
      const result = await pairingService.redeemPairing(request.body ? request.body.code : null);
      audit(request, 'host_paired', result.host.id, {
        instanceId: result.host.instanceId,
        name: result.host.name,
      });
      return result;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Called by the machine that redeems the code. Unauthenticated by session:
  // the single-use invitation secret is the credential.
  fastify.post('/api/pair/accept', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { inviteId, secret, peer, token } = request.body || {};
    try {
      const result = pairingService.acceptPairing({ inviteId, secret, peer, token });
      auditService.logAction({
        userId: null,
        action: 'host_pair_accepted',
        targetType: 'host',
        targetId: result.host.id,
        details: { instanceId: result.host.instanceId, name: result.host.name },
        ip: request.ip,
      });
      // The scanner may auto-merge the credential vault, but only when the
      // invite came from an authenticated Settings screen. Do not leak the
      // inviting user id; a boolean is all the peer needs.
      return {
        host: result.host,
        token: result.token,
        peer: result.peer,
        autoSync: Boolean(result.invitedBy),
      };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // --- Peer-to-peer (paired token required) -------------------------------

  // A peer tells us its current addresses. This is what keeps the association
  // alive when a Cloudflare Quick Tunnel URL rotates.
  fastify.post('/api/host/peers/announce', { preHandler: requirePeerAuth }, async (request, reply) => {
    const { instanceId, name, url, urls } = request.body || {};
    if (!instanceId || !url) {
      return reply.status(400).send({ error: 'instanceId and url are required.' });
    }
    // The token is bound to one host row: a peer may only announce for itself.
    const row = hostService.getHostRow(request.user.peerHostId);
    if (!row) return reply.status(404).send({ error: 'Host not found.' });
    if (row.instance_id && row.instance_id !== instanceId) {
      return reply.status(403).send({ error: 'This token belongs to a different host.' });
    }
    const host = hostService.updateHostUrls(row.id, {
      name,
      url,
      urls: Array.isArray(urls) ? urls : [],
      observedUrl: null,
    });
    if (!host) return reply.status(404).send({ error: 'Host not found.' });
    return { host };
  });

  // A peer asks which other machines we are paired with (identity and
  // addresses only, no credentials) so its admin can pair with them directly.
  fastify.get('/api/host/peers/known', { preHandler: requirePeerAuth }, async (request) => ({
    peers: hostService.listKnownPeers(request.user.peerHostId),
  }));

  // A peer asks us to forget it (the other half of unpair). We remove the row
  // for that instance and revoke its inbound token, which is this very token.
  fastify.post('/api/host/peers/revoke', { preHandler: requirePeerAuth }, async (request, reply) => {
    const { instanceId } = request.body || {};
    const row = hostService.getHostRow(request.user.peerHostId);
    if (!row) return reply.status(404).send({ error: 'Host not found.' });
    if (instanceId && row.instance_id && instanceId !== row.instance_id) {
      return reply.status(403).send({ error: 'This token belongs to a different host.' });
    }
    hostService.revokeInboundTokens(row.id);
    hostService.deleteHost(row.id);
    return { success: true };
  });

  // Bidirectional credential-vault merge. The caller sends its secrets; we
  // import them (newest timestamp wins) and return ours so both sides converge
  // in one round trip. Values never reach the browser: only paired peer tokens
  // can call this, and the response is marked no-store.
  fastify.post('/api/host/peers/secrets/sync', {
    preHandler: requirePeerAuth,
    bodyLimit: 8 * 1024 * 1024,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const result = secretSyncService.importSecrets(request.body ? request.body.secrets : []);
      const secrets = secretSyncService.exportLocal();
      auditService.logAction({
        userId: request.user.id,
        action: 'peer_secrets_synced',
        targetType: 'host',
        targetId: request.user.peerHostId,
        details: {
          imported: result.imported,
          skipped: result.skipped,
          invalid: result.invalid,
          exported: secrets.length,
        },
        ip: request.ip,
      });
      return { ...result, secrets };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = hostRoutes;
