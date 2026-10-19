/**
 * Credential-vault sync between paired hosts.
 *
 * Pairing establishes mutual peer tokens, but credentials used to be local to
 * each installation: a new machine asked for the GitHub token again. This
 * service merges the encrypted vault in both directions over the authenticated
 * peer connection so env vars and provider tokens follow the pairing.
 *
 * Safety rules:
 *   - Only HTTPS peers (or loopback) are allowed; a LAN HTTP peer would expose
 *     the whole vault to the network in clear text.
 *   - The newest `updated_at` wins. Equal values are left alone, so repeated
 *     syncs are cheap and idempotent.
 *   - Deletions stay local: syncing never removes an existing secret.
 *   - Values are never written to logs or returned to the browser.
 */
const secretStore = require('./secretStore');
const hostService = require('./hostService');

const SYNC_PATH = '/api/host/peers/secrets/sync';
const SYNC_TIMEOUT_MS = 20000;
const MAX_ENTRIES = 500;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function metadataKey(metadata) {
  if (!metadata) return '';
  try {
    return JSON.stringify(metadata);
  } catch {
    return '';
  }
}

function sameEntry(local, incoming) {
  return local.value === incoming.value
    && local.kind === incoming.kind
    && metadataKey(local.metadata) === metadataKey(incoming.metadata);
}

function validTimestamp(value) {
  if (!value || typeof value !== 'string') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  const value = typeof raw.value === 'string' ? raw.value : null;
  if (value === null || value.length === 0) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return null;
  const kind = String(raw.kind || 'env').toLowerCase();
  const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
    ? raw.metadata
    : null;
  return {
    name,
    kind,
    value,
    metadata,
    updated_at: validTimestamp(raw.updated_at),
  };
}

function exportLocal() {
  return secretStore.exportSecrets();
}

/**
 * Merge secrets received from a peer. Invalid entries are skipped and counted
 * instead of discarding the whole batch (one bad row must not break pairing).
 */
function importSecrets(entries) {
  if (!Array.isArray(entries)) throw new Error('secrets must be an array.');
  if (entries.length > MAX_ENTRIES) throw new Error('Too many secrets in one sync.');

  let totalBytes = 0;
  let imported = 0;
  let skipped = 0;
  let invalid = 0;

  for (const raw of entries) {
    const incoming = sanitizeEntry(raw);
    if (!incoming) {
      invalid += 1;
      continue;
    }
    totalBytes += Buffer.byteLength(incoming.value, 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Secret sync payload is too large.');

    const local = secretStore.getSecret(incoming.name);
    if (local) {
      if (sameEntry(local, incoming)) {
        skipped += 1;
        continue;
      }
      // Clock skew is possible, but using the stored timestamp is still safer
      // than an unconditional overwrite in the wrong direction.
      if (!incoming.updated_at) {
        skipped += 1;
        continue;
      }
      if (local.updated_at && String(local.updated_at) > incoming.updated_at) {
        skipped += 1;
        continue;
      }
    }

    try {
      secretStore.setSecret(incoming.name, incoming.value, {
        kind: incoming.kind,
        metadata: incoming.metadata,
      });
      imported += 1;
    } catch {
      invalid += 1;
    }
  }

  return { imported, skipped, invalid };
}

/**
 * Push the local vault to a paired host and merge its vault back. Uses the
 * stored peer token and only secure candidate addresses (HTTPS or loopback).
 */
async function syncWithHost(hostId, { timeout = SYNC_TIMEOUT_MS } = {}) {
  const res = await hostService.requestHost(hostId, SYNC_PATH, {
    method: 'POST',
    body: { secrets: exportLocal() },
    timeout,
    secureOnly: true,
  });

  if (!res.ok) {
    throw new Error((res.data && res.data.error) || `Credential sync failed (HTTP ${res.status}).`);
  }
  if (!res.data || !Array.isArray(res.data.secrets)) {
    throw new Error('The peer did not return a credential list.');
  }

  const merged = importSecrets(res.data.secrets);
  return {
    ok: true,
    baseUrl: res.baseUrl,
    imported: merged.imported,
    skipped: merged.skipped,
    invalid: merged.invalid,
    remoteImported: res.data.imported || 0,
    remoteSkipped: res.data.skipped || 0,
    remoteInvalid: res.data.invalid || 0,
  };
}

module.exports = {
  SYNC_PATH,
  exportLocal,
  importSecrets,
  syncWithHost,
};
