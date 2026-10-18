/**
 * Citadel Fleet Service
 *
 * Lets one Citadel panel manage other Citadel instances ("hosts"). Each host is
 * a base URL plus a bearer token (a session id of the remote admin) stored
 * encrypted at rest (AES-256-GCM) and never returned to the browser. Requests
 * are forwarded over HTTPS with the Authorization: Bearer header that the remote
 * requireAuth / websocket layer already accepts.
 */
const crypto = require('node:crypto');
const { getDatabase } = require('../database/db');
const { encrypt, decrypt } = require('../security/secrets');

const REQUEST_TIMEOUT_MS = 12000;
const ALLOWED_PATH_PREFIXES = [
  '/api/system/',
  '/api/agents',
  '/api/projects',
  '/api/terminals',
];

function normalizeBaseUrl(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('A base URL is required (e.g. https://host.example.com).');
  }
  let url = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The base URL is not valid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listHosts() {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM fleet_hosts ORDER BY name').all();
  return rows.map(toPublic);
}

function getHostRow(id) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM fleet_hosts WHERE id = ?').get(id) || null;
}

function getHost(id) {
  const row = getHostRow(id);
  return row ? toPublic(row) : null;
}

function createHost({ name, baseUrl, token }) {
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2) {
    throw new Error('A host name is required.');
  }
  if (!token || typeof token !== 'string' || token.trim().length < 8) {
    throw new Error('A valid access token (remote session id) is required.');
  }
  const normalized = normalizeBaseUrl(baseUrl);

  const db = getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO fleet_hosts (id, name, base_url, token_encrypted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, cleanName, normalized, encrypt(token.trim()), now, now);

  return getHost(id);
}

function updateHost(id, { name, baseUrl, token } = {}) {
  const existing = getHostRow(id);
  if (!existing) throw new Error('Host not found.');

  const cleanName = name !== undefined ? String(name).trim() : existing.name;
  if (cleanName.length < 2) throw new Error('A host name is required.');
  const normalized = baseUrl !== undefined ? normalizeBaseUrl(baseUrl) : existing.base_url;
  const encrypted = token !== undefined && String(token).trim() !== ''
    ? encrypt(String(token).trim())
    : existing.token_encrypted;

  const now = new Date().toISOString();
  getDatabase().prepare(
    'UPDATE fleet_hosts SET name = ?, base_url = ?, token_encrypted = ?, updated_at = ? WHERE id = ?'
  ).run(cleanName, normalized, encrypted, now, id);

  return getHost(id);
}

function deleteHost(id) {
  const res = getDatabase().prepare('DELETE FROM fleet_hosts WHERE id = ?').run(id);
  return { success: res.changes > 0, id };
}

function getDecryptedToken(id) {
  const row = getHostRow(id);
  if (!row) return null;
  try {
    return decrypt(row.token_encrypted);
  } catch {
    return null;
  }
}

function assertAllowedPath(apiPath) {
  const clean = String(apiPath || '');
  if (!clean.startsWith('/api/')) {
    throw new Error('Only /api paths can be forwarded.');
  }
  if (!ALLOWED_PATH_PREFIXES.some((prefix) => clean.startsWith(prefix))) {
    throw new Error(`Path "${clean}" is not allowed for remote base requests.`);
  }
  return clean;
}

/**
 * Forward a request to a remote Citadel host using its stored bearer token.
 * Returns { status, ok, data } instead of throwing on non-2xx, so the panel can
 * surface the remote error verbatim.
 */
async function remoteRequest(id, apiPath, { method = 'GET', body = null } = {}) {
  const row = getHostRow(id);
  if (!row) throw new Error('Host not found.');
  const token = getDecryptedToken(id);
  if (!token) throw new Error('Stored token could not be decrypted; edit the host and re-enter it.');

  const clean = assertAllowedPath(apiPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Citadel-Fleet',
    };
    const options = { method, headers, signal: controller.signal };
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${row.base_url}${clean}`, options);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'Request timed out.' : err.message;
    throw new Error(`Remote host unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan out a lightweight status probe to every host and aggregate the result,
 * so the dashboard can show one row per device from a single request.
 */
async function overview() {
  const hosts = listHosts();
  return Promise.all(hosts.map(async (h) => {
    const base = { id: h.id, name: h.name, baseUrl: h.baseUrl };
    try {
      const version = await remoteRequest(h.id, '/api/system/version');
      if (!version.ok) {
        throw new Error((version.data && version.data.error) || `HTTP ${version.status}`);
      }
      const v = (version.data && version.data.version) || {};

      const [updates, agents] = await Promise.all([
        remoteRequest(h.id, '/api/system/updates').catch(() => null),
        remoteRequest(h.id, '/api/agents').catch(() => null),
      ]);

      const agentList = (agents && agents.data && agents.data.agents) || [];
      const upd = updates && updates.data && updates.data.updates;

      return {
        ...base,
        online: true,
        version: v.version || null,
        commit: v.commit || null,
        updateAvailable: Boolean(upd && upd.updateAvailable),
        latest: upd ? upd.latest : null,
        agentsInstalled: agentList.filter((a) => a.installed).length,
        agentsTotal: agentList.length,
        error: null,
      };
    } catch (err) {
      return { ...base, online: false, error: err.message };
    }
  }));
}

/**
 * Trigger the self-updater on every registered host. Best-effort: a host that is
 * unreachable does not block the others.
 */
async function updateAll() {
  const hosts = listHosts();
  const settled = await Promise.allSettled(hosts.map(async (h) => {
    const res = await remoteRequest(h.id, '/api/system/update', { method: 'POST', body: {} });
    return {
      id: h.id,
      name: h.name,
      ok: res.ok,
      status: res.status,
      error: res.ok ? null : (res.data && res.data.error) || `HTTP ${res.status}`,
    };
  }));
  return settled.map((r, i) => (r.status === 'fulfilled'
    ? r.value
    : { id: hosts[i].id, name: hosts[i].name, ok: false, error: String(r.reason) }));
}

module.exports = {
  normalizeBaseUrl,
  listHosts,
  getHost,
  createHost,
  updateHost,
  deleteHost,
  remoteRequest,
  overview,
  updateAll,
};
