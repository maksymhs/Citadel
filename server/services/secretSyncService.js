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
 *   - Deletions propagate as tombstones: a secret removed on one machine is
 *     removed on its peers unless it was changed again after the deletion.
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

function exportDeleted() {
  return secretStore.exportTombstones();
}

/**
 * Merge secrets received from a peer. Invalid entries are skipped and counted
 * instead of discarding the whole batch (one bad row must not break pairing).
 */
function importSecrets(entries, deleted = []) {
  if (!Array.isArray(entries)) throw new Error('secrets must be an array.');
  if (entries.length > MAX_ENTRIES) throw new Error('Too many secrets in one sync.');

  let totalBytes = 0;
  let imported = 0;
  let skipped = 0;
  let invalid = 0;
  let removed = 0;

  // Older peers do not send deletions; tolerate a missing or malformed list.
  for (const raw of (Array.isArray(deleted) ? deleted : []).slice(0, MAX_ENTRIES)) {
    const name = raw && typeof raw.name === 'string' ? raw.name.trim() : '';
    const deletedAt = raw ? validTimestamp(raw.deleted_at) : null;
    if (!name || !deletedAt) {
      invalid += 1;
      continue;
    }
    try {
      if (secretStore.applyTombstone(name, deletedAt)) removed += 1;
    } catch {
      invalid += 1;
    }
  }

  for (const raw of entries) {
    const incoming = sanitizeEntry(raw);
    if (!incoming) {
      invalid += 1;
      continue;
    }
    totalBytes += Buffer.byteLength(incoming.value, 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Secret sync payload is too large.');

    // A newer local deletion beats an older copy still held by the peer.
    const tombstone = secretStore.getTombstone(incoming.name);
    if (tombstone && (!incoming.updated_at || incoming.updated_at <= tombstone)) {
      skipped += 1;
      continue;
    }

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
        updatedAt: incoming.updated_at,
      });
      imported += 1;
    } catch {
      invalid += 1;
    }
  }

  return { imported, skipped, invalid, removed };
}

/**
 * Push the local vault to a paired host and merge its vault back. Uses the
 * stored peer token and only secure candidate addresses (HTTPS or loopback).
 */
async function syncWithHost(hostId, { timeout = SYNC_TIMEOUT_MS } = {}) {
  const res = await hostService.requestHost(hostId, SYNC_PATH, {
    method: 'POST',
    body: { secrets: exportLocal(), deleted: exportDeleted() },
    timeout,
    secureOnly: true,
  });

  if (!res.ok) {
    throw new Error((res.data && res.data.error) || `Credential sync failed (HTTP ${res.status}).`);
  }
  if (!res.data || !Array.isArray(res.data.secrets)) {
    throw new Error('The peer did not return a credential list.');
  }

  const merged = importSecrets(res.data.secrets, res.data.deleted);
  return {
    ok: true,
    baseUrl: res.baseUrl,
    imported: merged.imported,
    skipped: merged.skipped,
    invalid: merged.invalid,
    removed: merged.removed,
    remoteImported: res.data.imported || 0,
    remoteSkipped: res.data.skipped || 0,
    remoteInvalid: res.data.invalid || 0,
  };
}

/**
 * Sync with every paired machine, one after another. Best-effort: an offline
 * or HTTP-only peer is reported and never blocks the others; the next run
 * (periodic, after a vault change, or at startup) retries it.
 */
async function syncWithAllPeers() {
  const rows = hostService.listHostRows().filter((row) => row.instance_id);
  const results = [];
  for (const row of rows) {
    try {
      results.push({ id: row.id, name: row.name, ...(await syncWithHost(row.id)) });
    } catch (err) {
      results.push({ id: row.id, name: row.name, ok: false, error: err.message });
    }
  }
  return results;
}

let scheduled = null;

/** Debounced syncWithAllPeers, for "the vault just changed here". */
function scheduleSync(delayMs = 3000) {
  clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    syncWithAllPeers().catch(() => {});
  }, delayMs);
  if (typeof scheduled.unref === 'function') scheduled.unref();
}

module.exports = {
  SYNC_PATH,
  exportLocal,
  exportDeleted,
  syncWithAllPeers,
  scheduleSync,
  importSecrets,
  syncWithHost,
};
