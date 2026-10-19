/**
 * Peer pairing handshake.
 *
 * The machine that scans/pastes the code ("B") drives the exchange:
 *
 *   1. B parses the invitation payload from A's QR/link.
 *   2. B generates `tokenB` — the credential A will present to B — and calls
 *      A's /api/pair/accept with its own identity and that token.
 *   3. A consumes the single-use invite, generates `tokenA` — the credential B
 *      will present to A — stores B (outbound=tokenB, inbound=tokenA) and
 *      returns tokenA together with A's identity.
 *   4. B stores A (outbound=tokenA, inbound=tokenB).
 *
 * Both sides end up paired without any further user action, and each direction
 * has an independent token that can be revoked separately.
 */
const hostService = require('./hostService');
const secretSyncService = require('./secretSyncService');

const ACCEPT_TIMEOUT_MS = 12000;

function assertPeerIdentity(peer) {
  if (!peer || typeof peer !== 'object') throw new Error('The peer identity is missing.');
  if (!peer.instanceId || typeof peer.instanceId !== 'string') {
    throw new Error('The peer did not report an instance id.');
  }
  if (!peer.url || typeof peer.url !== 'string') {
    throw new Error('The peer did not report a URL.');
  }
  return {
    instanceId: peer.instanceId,
    name: String(peer.name || 'citadel').slice(0, 64),
    url: peer.url,
    urls: Array.isArray(peer.urls) ? peer.urls.filter((u) => typeof u === 'string') : [],
  };
}

/**
 * Called on the invited machine (A). Validates the invitation, stores the
 * initiator as a paired host and returns the credential it must use for us.
 */
function acceptPairing({ inviteId, secret, peer, token }) {
  const invite = hostService.consumeInvite(inviteId, secret);
  const identity = assertPeerIdentity(peer);
  if (!token || typeof token !== 'string' || token.length < 32) {
    throw new Error('The peer did not provide a valid access token.');
  }
  if (identity.instanceId === hostService.getInstanceId()) {
    throw new Error('A host cannot be paired with itself.');
  }

  const inboundToken = hostService.generateToken();
  const host = hostService.upsertPairedHost({
    instanceId: identity.instanceId,
    name: identity.name,
    url: identity.url,
    urls: identity.urls,
    outboundToken: token,
    inboundToken,
  });

  return {
    host,
    token: inboundToken,
    peer: hostService.getIdentity(),
    invitedBy: invite.userId || null,
  };
}

/**
 * Called on the machine that scanned/pasted the code (B). Tries every address
 * from the invitation (a stale Cloudflare URL may be listed alongside a fresh
 * one) and stores A on success.
 */
async function redeemPairing(code) {
  const payload = hostService.parsePairingCode(code);
  const identity = hostService.getIdentity();
  if (payload.instanceId === identity.instanceId) {
    throw new Error('That pairing code belongs to this same host.');
  }

  const inboundToken = hostService.generateToken();
  const candidates = [];
  const push = (value) => {
    const url = hostService.normalizeUrl ? hostService.normalizeUrl(value) : value;
    if (url && !candidates.includes(url)) candidates.push(url);
  };
  push(payload.url);
  for (const url of payload.urls || []) push(url);

  if (candidates.length === 0) throw new Error('The pairing code has no usable address.');

  let lastError = null;
  for (const base of candidates) {
    try {
      const res = await fetchJson(`${base.replace(/\/+$/, '')}/api/pair/accept`, {
        inviteId: payload.inviteId,
        secret: payload.secret,
        peer: identity,
        token: inboundToken,
      });
      if (!res.ok) {
        const message = (res.data && res.data.error) || `HTTP ${res.status}`;
        // A consumed/expired invite is final: retrying another address will not
        // help, so surface it instead of masking it as a network failure.
        if (res.status === 400 || res.status === 401) throw new Error(message);
        lastError = new Error(message);
        continue;
      }

      const peer = assertPeerIdentity(res.data && res.data.peer);
      const outboundToken = res.data && res.data.token;
      if (!outboundToken || typeof outboundToken !== 'string') {
        throw new Error('The peer did not return an access token.');
      }

      const host = hostService.upsertPairedHost({
        instanceId: peer.instanceId,
        name: peer.name,
        url: peer.url,
        urls: peer.urls,
        outboundToken,
        inboundToken,
      });

      // Best-effort: exchange fresh addresses right away so both sides can
      // follow an address rotation without waiting for the periodic announce.
      hostService.announceToPeers().catch(() => {});

      // Invitations created from an authenticated Settings screen mean both
      // machines belong to the same operator, so merge the credential vault in
      // both directions. The startup/installer QR has no user attached and
      // deliberately does not auto-share secrets; use "Sync credentials" there.
      let secrets = null;
      if (res.data && res.data.autoSync) {
        try {
          secrets = await secretSyncService.syncWithHost(host.id);
        } catch (err) {
          secrets = { ok: false, error: err.message };
        }
      }

      return { host, peer, secrets };
    } catch (err) {
      if (/expired|already used|not valid|itself|same host/i.test(err.message)) throw err;
      lastError = err;
    }
  }

  throw new Error(`Could not reach the inviting host: ${lastError ? lastError.message : 'no address answered'}`);
}

function fetchJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACCEPT_TIMEOUT_MS);
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Citadel-Peer',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).then(async (res) => {
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, ok: res.ok, data };
  }).catch((err) => {
    throw new Error(err.name === 'AbortError' ? 'Request timed out.' : err.message);
  }).finally(() => clearTimeout(timer));
}

module.exports = { acceptPairing, redeemPairing, assertPeerIdentity };
