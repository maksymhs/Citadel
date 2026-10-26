/**
 * Host Identity & Peer Pairing
 *
 * A "host" is another Citadel installation this panel can switch to without
 * changing the browser URL: the local server proxies API and terminal traffic
 * to it. Pairing is bidirectional and identity-based:
 *
 *   - Every installation owns a stable random `instance.id` (app_config), so an
 *     association survives address changes.
 *   - A peer is addressed by a *list* of candidate URLs. A Cloudflare Quick
 *     Tunnel URL changes on every restart, so the peers periodically announce
 *     their current addresses and the caller tries each candidate until one
 *     answers.
 *   - Each direction has its own bearer token. Only the SHA-256 hash of the
 *     inbound token is stored; the outbound token is encrypted at rest.
 */
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const { getDatabase } = require('../database/db');
const { encrypt, decrypt } = require('../security/secrets');
const connectService = require('./connectService');

const INSTANCE_ID_KEY = 'instance.id';
const INSTANCE_NAME_KEY = 'instance.name';
const INVITE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const STREAM_TIMEOUT_MS = 120000;
const INVITE_MAX = 32;

function nowIso() {
  return new Date().toISOString();
}

function readConfig(key) {
  const row = getDatabase().prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function writeConfig(key, value) {
  getDatabase().prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}

function defaultInstanceName() {
  return require('node:os').hostname() || 'citadel';
}

function getInstanceId() {
  let id = readConfig(INSTANCE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    writeConfig(INSTANCE_ID_KEY, id);
  }
  return id;
}

function getInstanceName() {
  return readConfig(INSTANCE_NAME_KEY) || defaultInstanceName();
}

function setInstanceName(name) {
  const clean = String(name || '').trim().slice(0, 64);
  if (!clean) throw new Error('An instance name is required.');
  writeConfig(INSTANCE_NAME_KEY, clean);
  identityCache = null;
  identityAt = 0;
  return clean;
}

/**
 * Public identity of this installation, including every address a peer could
 * currently use to reach it.
 */
let identityCache = null;
let identityAt = 0;
const IDENTITY_TTL_MS = 30 * 1000;

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Addresses that can carry secret material. HTTPS is required everywhere;
 * loopback is allowed for two local instances and tests.
 */
function isSecurePeerUrl(value) {
  try {
    return new URL(value).protocol === 'https:' || isLoopbackUrl(value);
  } catch {
    return false;
  }
}

function getIdentity() {
  const now = Date.now();
  if (identityCache && now - identityAt < IDENTITY_TTL_MS) return { ...identityCache, urls: identityCache.urls.slice() };
  const connect = connectService.getConnectInfo();
  const candidates = connectService.getCandidateUrls();
  // Never advertise loopback as a peer reachability candidate: on the other
  // machine 127.0.0.1 points at itself, which could hijack the row. The
  // effective URL is kept separately for same-host flows and the QR code.
  const peerUrls = candidates.filter((url) => !isLoopbackUrl(url));
  identityCache = {
    instanceId: getInstanceId(),
    name: getInstanceName(),
    url: connect.url,
    urls: peerUrls.length ? peerUrls : candidates,
    source: connect.source,
  };
  identityAt = now;
  return { ...identityCache, urls: identityCache.urls.slice() };
}

/**
 * Every API response advertises this host's identity and current addresses in
 * headers. A peer's proxy reads them and repairs its stored row when a tunnel
 * URL rotated, which keeps the association alive without user action.
 */
function identityHeaders() {
  try {
    const identity = getIdentity();
    return {
      'x-citadel-instance': identity.instanceId,
      'x-citadel-name': encodeURIComponent(identity.name),
      'x-citadel-urls': identity.urls.join(' '),
    };
  } catch {
    return {};
  }
}

/**
 * Apply identity headers received from a peer to its stored row. Only the row
 * that was actually called is updated, and only when the instance id matches,
 * so a response cannot be used to redirect a different host.
 */
function absorbIdentityHeaders(hostId, headers, { observedUrl = null } = {}) {
  try {
    const get = (name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name]);
    const instanceId = get('x-citadel-instance');
    if (!instanceId) return null;
    const row = getHostRow(hostId);
    if (!row || row.instance_id !== instanceId) return null;
    const rawUrls = get('x-citadel-urls') || '';
    const urls = String(rawUrls).split(/\s+/).filter(Boolean);
    if (urls.length === 0) return null;
    const name = get('x-citadel-name');
    // Keep the address that actually worked as the primary one: a peer may list
    // a LAN/tunnel address we cannot reach first in its preference list.
    return updateHostUrls(hostId, {
      name: name ? decodeURIComponent(name) : row.name,
      url: observedUrl || urls[0],
      urls,
      observedUrl,
    });
  } catch {
    return null;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// --- Host rows ------------------------------------------------------------

function parseUrls(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeUrl(value) {
  const normalized = connectService.normalizeUrl(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    // What the user sees: their own alias when set, else the machine's name.
    name: row.alias || row.name,
    peerName: row.name,
    alias: row.alias || null,
    baseUrl: row.base_url,
    instanceId: row.instance_id || null,
    urls: candidateUrls(row),
    paired: Boolean(row.paired_at),
    pairedAt: row.paired_at || null,
    lastSeen: row.last_seen || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Give a paired machine a private display name (empty clears it). Only affects
 * this panel: the other machine is never told.
 */
function setHostAlias(id, alias) {
  const row = getHostRow(id);
  if (!row) throw new Error('Host not found.');
  const clean = String(alias || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  getDatabase().prepare('UPDATE fleet_hosts SET alias = ?, updated_at = ? WHERE id = ?')
    .run(clean || null, new Date().toISOString(), id);
  return toPublic(getHostRow(id));
}

function getHostRow(id) {
  return getDatabase().prepare('SELECT * FROM fleet_hosts WHERE id = ?').get(id) || null;
}

function getHostRowByInstance(instanceId) {
  if (!instanceId) return null;
  return getDatabase().prepare('SELECT * FROM fleet_hosts WHERE instance_id = ?').get(instanceId) || null;
}

function listHostRows() {
  return getDatabase().prepare('SELECT * FROM fleet_hosts ORDER BY COALESCE(alias, name)').all();
}

/**
 * Ordered, de-duplicated addresses for a host. The last known-good base URL is
 * tried first, then the announced candidates.
 */
function candidateUrls(row) {
  const list = [];
  const push = (value) => {
    const url = normalizeUrl(value);
    if (url && !list.includes(url)) list.push(url);
  };
  if (!row) return list;
  push(row.base_url);
  for (const url of parseUrls(row.urls)) push(url);
  return list;
}

function getOutboundToken(row) {
  if (!row || !row.token_encrypted) return null;
  try {
    return decrypt(row.token_encrypted);
  } catch {
    return null;
  }
}

/**
 * Create or update a paired host. `inboundToken` is the token the peer will
 * present to us (stored hashed); `outboundToken` is the token we present to the
 * peer (stored encrypted). When a host already exists for the instance id it is
 * reused, so re-pairing is idempotent.
 */
function upsertPairedHost({
  instanceId, name, url, urls = [], outboundToken, inboundToken,
}) {
  if (!instanceId) throw new Error('The peer did not report an instance id.');
  const db = getDatabase();
  const cleanUrls = [];
  for (const candidate of [url, ...urls]) {
    const normalized = normalizeUrl(candidate);
    if (normalized && !cleanUrls.includes(normalized)) cleanUrls.push(normalized);
  }
  if (cleanUrls.length === 0) throw new Error('The peer did not report a reachable URL.');
  const primary = cleanUrls[0];
  const cleanName = String(name || 'citadel').trim().slice(0, 64) || 'citadel';

  let row = getHostRowByInstance(instanceId);
  const now = nowIso();
  if (row) {
    db.prepare(`
      UPDATE fleet_hosts
      SET name = ?, base_url = ?, token_encrypted = ?, urls = ?, paired_at = ?, last_seen = ?, updated_at = ?
      WHERE id = ?
    `).run(
      cleanName,
      primary,
      encrypt(outboundToken),
      JSON.stringify(cleanUrls),
      row.paired_at || now,
      now,
      now,
      row.id
    );
  } else {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO fleet_hosts
        (id, name, base_url, token_encrypted, instance_id, urls, paired_at, last_seen, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, cleanName, primary, encrypt(outboundToken), instanceId, JSON.stringify(cleanUrls), now, now, now, now);
    row = getHostRow(id);
  }

  if (inboundToken) {
    // Re-pairing replaces the previous inbound credential instead of stacking
    // tokens that can never be revoked individually.
    db.prepare('UPDATE peer_tokens SET revoked_at = ? WHERE host_id = ? AND revoked_at IS NULL')
      .run(now, row.id);
    db.prepare(`
      INSERT INTO peer_tokens (id, host_id, token_hash, user_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), row.id, hashToken(inboundToken), null, now);
  }

  return toPublic(getHostRow(row.id));
}

/**
 * Merge newly announced addresses into a host row and refresh its base URL.
 * Called when a peer says "my Cloudflare URL changed".
 */
function updateHostUrls(hostId, { name, url, urls = [], observedUrl = null }) {
  const row = getHostRow(hostId);
  if (!row) return null;
  const merged = [];
  const push = (value) => {
    const normalized = normalizeUrl(value);
    if (normalized && !merged.includes(normalized)) merged.push(normalized);
  };
  push(url);
  for (const candidate of urls) push(candidate);
  for (const candidate of candidateUrls(row)) push(candidate);
  push(observedUrl);

  const primary = normalizeUrl(url) || row.base_url;
  const now = nowIso();
  getDatabase().prepare(`
    UPDATE fleet_hosts SET name = ?, base_url = ?, urls = ?, last_seen = ?, updated_at = ? WHERE id = ?
  `).run(
    String(name || row.name).trim().slice(0, 64) || row.name,
    primary,
    JSON.stringify(merged),
    now,
    now,
    hostId
  );
  return toPublic(getHostRow(hostId));
}

function markHostSeen(hostId, baseUrl) {
  if (!hostId) return;
  const row = getHostRow(hostId);
  if (!row) return;
  const now = nowIso();
  if (baseUrl && baseUrl !== row.base_url) {
    getDatabase().prepare('UPDATE fleet_hosts SET base_url = ?, last_seen = ? WHERE id = ?')
      .run(baseUrl, now, hostId);
  } else {
    getDatabase().prepare('UPDATE fleet_hosts SET last_seen = ? WHERE id = ?').run(now, hostId);
  }
}

function revokeInboundTokens(hostId) {
  getDatabase().prepare('UPDATE peer_tokens SET revoked_at = ? WHERE host_id = ? AND revoked_at IS NULL')
    .run(nowIso(), hostId);
}

function deleteHost(hostId) {
  const row = getHostRow(hostId);
  if (!row) return { success: false };
  const db = getDatabase();
  db.prepare('UPDATE peer_tokens SET revoked_at = ? WHERE host_id = ?').run(nowIso(), hostId);
  db.prepare('DELETE FROM fleet_hosts WHERE id = ?').run(hostId);
  return { success: true, host: toPublic(row) };
}

function listHosts() {
  return listHostRows().map(toPublic);
}

// --- Invites --------------------------------------------------------------

function cleanupInvites() {
  getDatabase().prepare('DELETE FROM pairing_invites WHERE expires_at <= ?').run(Date.now());
}

/**
 * Create a single-use invitation. The secret is only returned to the caller and
 * embedded in the QR/link; the server keeps a hash so a leaked database does not
 * grant pairing.
 */
function createInvite({ userId, url } = {}) {
  cleanupInvites();
  const db = getDatabase();
  const overflow = db.prepare(`
    SELECT id FROM pairing_invites ORDER BY created_at ASC LIMIT -1 OFFSET ?
  `).all(INVITE_MAX - 1);
  if (overflow.length) {
    const remove = db.prepare('DELETE FROM pairing_invites WHERE id = ?');
    const transaction = db.transaction((rows) => rows.forEach((row) => remove.run(row.id)));
    transaction(overflow);
  }

  const identity = getIdentity();
  const inviteId = crypto.randomUUID();
  const secret = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + INVITE_TTL_MS;
  db.prepare(`
    INSERT INTO pairing_invites (id, secret_hash, user_id, instance_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(inviteId, hashToken(secret), userId || null, identity.instanceId, expiresAt, nowIso());

  const primaryUrl = url || identity.urls[0] || identity.url;
  const payload = {
    v: 1,
    instanceId: identity.instanceId,
    name: identity.name,
    url: primaryUrl,
    urls: identity.urls,
    inviteId,
    secret,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const link = `${primaryUrl.replace(/\/+$/, '')}/#pair=${encoded}`;
  const hexId = inviteId.replace(/-/g, '');
  const b64Id = Buffer.from(hexId, 'hex').toString('base64url');
  const b64Secret = Buffer.from(secret, 'hex').toString('base64url');
  const compactLink = `${primaryUrl.replace(/\/+$/, '')}/#pair=v1.${b64Id}.${b64Secret}`;

  return {
    inviteId,
    expiresAt: new Date(expiresAt).toISOString(),
    payload,
    encoded,
    link,
    compactLink,
    // The compact link encodes far fewer bytes, so the QR is lower density and
    // scans reliably from a phone camera or across a screen.
    qrSvg: connectService.qrSvg(compactLink),
    reachableWarning: /^http:\/\/(127\.0\.0\.1|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(identity.url)
      ? 'This address only works on the same network. Use Tailscale or a tunnel URL so the other machine can reach it.'
      : null,
  };
}

/**
 * Parse a pairing link (full URL with #pair=...) or a bare base64url payload.
 */
function parsePairingCode(code) {
  const raw = String(code || '').trim();
  if (!raw) throw new Error('Paste the pairing link or scan its QR code.');
  let linkUrl = null;
  let encoded = raw.replace(/^#?pair=/i, '');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const value = new URLSearchParams(url.hash.replace(/^#/, '')).get('pair');
      if (!value) throw new Error('missing pair payload');
      encoded = value;
      url.hash = '';
      linkUrl = url.toString().replace(/\/+$/, '');
    } catch {
      throw new Error('That is the plain panel address, not a pairing code. On the other Citadel open Settings → Connection (signed in as admin) and scan the QR shown there, or copy its full link including the #pair=… part.');
    }
  }

  const compact = encoded.match(/^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (compact) {
    if (!linkUrl) throw new Error('The compact pairing code must include its link address.');
    let idRaw = compact[1];
    let secret = compact[2];
    if (idRaw.length === 22) {
      try {
        idRaw = Buffer.from(idRaw, 'base64url').toString('hex');
      } catch {
        throw new Error('The pairing code is not valid.');
      }
    }
    if (secret.length === 32) {
      try {
        secret = Buffer.from(secret, 'base64url').toString('hex');
      } catch {
        throw new Error('The pairing code is not valid.');
      }
    }
    if (idRaw.length !== 32 || secret.length !== 48 || !/^[0-9a-f]{32}$/i.test(idRaw) || !/^[0-9a-f]{48}$/i.test(secret)) {
      throw new Error('The compact pairing code is not valid.');
    }
    const inviteId = `${idRaw.slice(0, 8)}-${idRaw.slice(8, 12)}-${idRaw.slice(12, 16)}-${idRaw.slice(16, 20)}-${idRaw.slice(20)}`;
    return { v: 1, inviteId, secret: secret.toLowerCase(), url: linkUrl, urls: [linkUrl] };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('The pairing code is not valid.');
  }
  if (!payload || payload.v !== 1 || !payload.inviteId || !payload.secret) {
    throw new Error('The pairing code is not valid.');
  }
  return payload;
}

/**
 * Consume an invitation. Returns the invite record (or throws when expired or
 * already used).
 */
function consumeInvite(inviteId, secret) {
  cleanupInvites();
  const db = getDatabase();
  return db.transaction(() => {
    const invite = db.prepare('SELECT * FROM pairing_invites WHERE id = ?').get(inviteId);
    if (!invite) throw new Error('This invitation has expired or was already used.');
    if (invite.expires_at <= Date.now()) {
      db.prepare('DELETE FROM pairing_invites WHERE id = ?').run(inviteId);
      throw new Error('This invitation has expired.');
    }
    const provided = Buffer.from(hashToken(secret));
    const expected = Buffer.from(invite.secret_hash);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      throw new Error('The invitation secret is not valid.');
    }
    db.prepare('DELETE FROM pairing_invites WHERE id = ?').run(inviteId);
    return { userId: invite.user_id, instanceId: invite.instance_id, expiresAt: invite.expires_at };
  })();
}

// --- Network helpers ------------------------------------------------------

function fetchJson(url, { method = 'GET', token, body, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { Accept: 'application/json', 'User-Agent': 'Citadel-Peer', ...identityHeaders() };
  if (token) headers.Authorization = `Bearer ${token}`;
  const options = { method, headers, signal: controller.signal };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  return fetch(url, options)
    .then(async (res) => {
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      return { status: res.status, ok: res.ok, data, headers: res.headers };
    })
    .catch((err) => {
      throw new Error(err.name === 'AbortError' ? 'Request timed out.' : err.message);
    })
    .finally(() => clearTimeout(timer));
}

/**
 * Call a paired host, trying every candidate URL until one answers. Updates the
 * row with the address that worked so future calls skip dead candidates.
 * `secureOnly` restricts the attempt to HTTPS/loopback, for secret transfers.
 */
async function requestHost(hostId, apiPath, {
  method = 'GET',
  body = null,
  timeout = REQUEST_TIMEOUT_MS,
  maxCandidates = Infinity,
  deadlineMs = 0,
  secureOnly = false,
} = {}) {
  const row = getHostRow(hostId);
  if (!row) throw new Error('Host not found.');
  const token = getOutboundToken(row);
  if (!token) throw new Error('Stored token could not be decrypted; re-pair this host.');

  const clean = String(apiPath || '');
  if (!clean.startsWith('/api/')) throw new Error('Only /api paths can be forwarded.');

  const candidates = candidateUrls(row)
    .filter((url) => !secureOnly || isSecurePeerUrl(url))
    .slice(0, maxCandidates);
  if (candidates.length === 0) {
    throw new Error(secureOnly
      ? 'No HTTPS address is available for this host. Credentials are never sent over plain HTTP.'
      : 'The host has no known address.');
  }

  const startedAt = Date.now();
  let lastError = null;
  for (let i = 0; i < candidates.length; i += 1) {
    if (deadlineMs > 0 && Date.now() - startedAt >= deadlineMs) break;
    const attemptTimeout = deadlineMs > 0
      ? Math.min(timeout, Math.max(1, deadlineMs - (Date.now() - startedAt)))
      : timeout;
    const base = candidates[i];
    try {
      const res = await fetchJson(`${base}${clean}`, { method, token, body, timeout: attemptTimeout });
      // A stale tunnel hostname can still resolve and answer with a Cloudflare
      // error page (502/530) instead of failing the connection. Treat gateway
      // errors as "this address is dead" and try the next candidate.
      if (res.status >= 500 && i < candidates.length - 1) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      absorbIdentityHeaders(hostId, res.headers, { observedUrl: base });
      markHostSeen(hostId, base);
      return { ...res, baseUrl: base };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Remote host unreachable: ${lastError ? lastError.message : 'no address answered'}`);
}

/**
 * Open a streaming request (downloads, large bodies) to a paired host, trying
 * every candidate URL. Resolves with the raw IncomingMessage and the base URL
 * that answered.
 */
function openHostStream(hostId, apiPath, { method = 'GET', body = null, headers: extraHeaders = {}, timeout = STREAM_TIMEOUT_MS } = {}) {
  const row = getHostRow(hostId);
  if (!row) return Promise.reject(new Error('Host not found.'));
  const token = getOutboundToken(row);
  if (!token) return Promise.reject(new Error('Stored token could not be decrypted; re-pair this host.'));

  const clean = String(apiPath || '');
  if (!clean.startsWith('/api/')) return Promise.reject(new Error('Only /api paths can be forwarded.'));

  const candidates = candidateUrls(row);
  const payload = body === undefined || body === null ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    let index = 0;
    let lastError = null;

    const attempt = () => {
      if (index >= candidates.length) {
        reject(new Error(`Remote host unreachable: ${lastError ? lastError.message : 'no address answered'}`));
        return;
      }
      const base = candidates[index++];
      const target = new URL(`${base}${clean}`);
      const transport = target.protocol === 'https:' ? https : http;
      const headers = {
        Accept: '*/*',
        'User-Agent': 'Citadel-Peer',
        Authorization: `Bearer ${token}`,
        ...identityHeaders(),
        ...extraHeaders,
      };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = transport.request(target, { method, headers, timeout }, (res) => {
        // Same stale-address handling as requestHost: a retired tunnel host can
        // answer with a Cloudflare gateway error rather than a socket error.
        if (res.statusCode >= 500 && index < candidates.length) {
          res.resume();
          attempt();
          return;
        }
        absorbIdentityHeaders(hostId, res.headers, { observedUrl: base });
        markHostSeen(hostId, base);
        resolve({ res, baseUrl: base });
      });
      req.on('timeout', () => req.destroy(new Error('Request timed out.')));
      req.on('error', (err) => {
        lastError = err;
        attempt();
      });
      if (payload !== null) req.write(payload);
      req.end();
    };

    attempt();
  });
}

/**
 * WebSocket URL candidates for a paired host.
 */
function wsCandidates(hostId, wsPath) {
  const row = getHostRow(hostId);
  if (!row) return [];
  return candidateUrls(row).map((base) => {
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = wsPath;
    url.search = '';
    return { url: url.toString(), token: getOutboundToken(row), baseUrl: base };
  }).filter((c) => c.token);
}

/**
 * Peers this host is paired with, as seen by `requesterHostId`: identity and
 * addresses only, never a credential. Lets another machine discover who else
 * exists without gaining any access to them.
 */
function listKnownPeers(requesterHostId) {
  return listHostRows()
    .filter((row) => row.instance_id && row.id !== requesterHostId)
    .map((row) => ({
      instanceId: row.instance_id,
      name: row.name,
      url: row.base_url,
      urls: candidateUrls(row),
    }));
}

/**
 * Machines my paired hosts know that I am not paired with yet. Pairing still
 * needs the other machine's own invitation (an admin scans its QR): discovery
 * grants nothing.
 */
async function discoverSuggestions() {
  const identity = getIdentity();
  const rows = listHostRows().filter((row) => row.instance_id);
  const paired = new Set(rows.map((row) => row.instance_id));
  paired.add(identity.instanceId);

  const found = new Map();
  await Promise.allSettled(rows.map(async (row) => {
    const res = await requestHost(row.id, '/api/host/peers/known', { timeout: 5000, maxCandidates: 3 });
    if (!res.ok || !res.data || !Array.isArray(res.data.peers)) return;
    for (const peer of res.data.peers) {
      if (!peer || typeof peer.instanceId !== 'string' || paired.has(peer.instanceId)) continue;
      const urls = (Array.isArray(peer.urls) ? peer.urls : [peer.url])
        .map(normalizeUrl).filter(Boolean);
      if (urls.length === 0) continue;
      const entry = found.get(peer.instanceId) || {
        instanceId: peer.instanceId,
        name: String(peer.name || 'citadel').slice(0, 64),
        urls: [],
        via: [],
      };
      for (const url of urls) if (!entry.urls.includes(url)) entry.urls.push(url);
      if (!entry.via.includes(row.name)) entry.via.push(row.name);
      found.set(peer.instanceId, entry);
    }
  }));
  return Array.from(found.values());
}

/**
 * Announce this host's current addresses to every paired peer. Best-effort:
 * an offline peer never blocks the others. Called periodically so a Cloudflare
 * URL rotation is picked up without user action.
 */
async function announceToPeers() {
  const identity = getIdentity();
  const rows = listHostRows().filter((row) => row.instance_id);
  const results = await Promise.allSettled(rows.map(async (row) => {
    const res = await requestHost(row.id, '/api/host/peers/announce', {
      method: 'POST',
      body: {
        instanceId: identity.instanceId,
        name: identity.name,
        url: identity.urls[0] || identity.url,
        urls: identity.urls,
      },
      timeout: 8000,
    });
    if (!res.ok) throw new Error((res.data && res.data.error) || `HTTP ${res.status}`);
    return { id: row.id, name: row.name };
  }));
  return results.map((r, i) => (r.status === 'fulfilled'
    ? { ...r.value, ok: true }
    : { id: rows[i].id, name: rows[i].name, ok: false, error: String(r.reason) }));
}

/**
 * Remove a peer. The local row always disappears, even when the other machine
 * is offline: waiting for every stale address (a retired Quick Tunnel URL can
 * hang until its timeout) used to make Unpair look broken. The remote revoke is
 * best-effort and gets a small, fixed time budget.
 */
async function unpairHost(hostId) {
  const row = getHostRow(hostId);
  if (!row) throw new Error('Host not found.');
  let remote = { attempted: false, ok: false, error: null };
  if (row.instance_id) {
    remote.attempted = true;
    try {
      const res = await requestHost(hostId, '/api/host/peers/revoke', {
        method: 'POST',
        body: { instanceId: getInstanceId() },
        timeout: 2000,
        maxCandidates: 3,
        deadlineMs: 3500,
      });
      remote.ok = res.ok;
      if (!res.ok) remote.error = (res.data && res.data.error) || `HTTP ${res.status}`;
    } catch (err) {
      remote.error = err.message;
    }
  }
  deleteHost(hostId);
  return { success: true, remote };
}

module.exports = {
  setHostAlias,
  INSTANCE_ID_KEY,
  INSTANCE_NAME_KEY,
  INVITE_TTL_MS,
  getInstanceId,
  getInstanceName,
  setInstanceName,
  getIdentity,
  identityHeaders,
  absorbIdentityHeaders,
  hashToken,
  generateToken,
  normalizeUrl,
  getHostRow,
  getHostRowByInstance,
  getHost: (id) => toPublic(getHostRow(id)),
  toPublic,
  candidateUrls,
  getOutboundToken,
  upsertPairedHost,
  updateHostUrls,
  markHostSeen,
  revokeInboundTokens,
  deleteHost,
  listHosts,
  createInvite,
  parsePairingCode,
  consumeInvite,
  requestHost,
  openHostStream,
  wsCandidates,
  announceToPeers,
  readConfig,
  writeConfig,
  listHostRows,
  listKnownPeers,
  discoverSuggestions,
  unpairHost,
  _resetInvites: () => getDatabase().prepare('DELETE FROM pairing_invites').run(),
};
