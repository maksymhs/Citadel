/**
 * Citadel Secret Vault
 *
 * One encrypted store for every credential the panel or an agent needs: git
 * provider tokens, plain environment variables and (materializable) files.
 * Values are AES-256-GCM encrypted at rest through security/secrets.js, so the
 * database and its backups never contain a plaintext secret.
 *
 * Agents reach the vault through the `citadel-creds` CLI (on demand) and, for
 * env/git entries, through the environment injected into every terminal at
 * spawn (see terminalManager). There is a single place to add, rotate and
 * revoke credentials.
 */
const { getDatabase } = require('../database/db');
const { encrypt, decrypt } = require('../security/secrets');

// `env` and `git` entries are exposed as environment variables; `file` and
// `ssh` entries are written to a 0600 file on demand via `citadel-creds`.
const KINDS = ['env', 'git', 'file', 'ssh'];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeKind(kind) {
  const k = String(kind || 'env').toLowerCase();
  if (!KINDS.includes(k)) throw new Error(`Unsupported secret kind: ${kind}`);
  return k;
}

function parseMetadata(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Metadata for every secret (never the value). */
function listSecrets() {
  const db = getDatabase();
  return db
    .prepare('SELECT name, kind, metadata, created_at, updated_at FROM secrets ORDER BY kind, name')
    .all()
    .map((r) => ({
      name: r.name,
      kind: r.kind,
      metadata: parseMetadata(r.metadata),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
}

/** A single decrypted secret, or null when it does not exist / cannot decrypt. */
function getSecret(name) {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM secrets WHERE name = ?').get(String(name));
  if (!row) return null;

  let value = null;
  try {
    value = decrypt(row.value_encrypted);
  } catch {
    value = null;
  }
  if (value === null) return null;

  return {
    name: row.name,
    kind: row.kind,
    metadata: parseMetadata(row.metadata),
    value,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getValue(name) {
  const secret = getSecret(name);
  return secret ? secret.value : null;
}

/** Create or update a secret (upsert by name). Returns metadata, never value. */
function setSecret(name, value, { kind = 'env', metadata = null } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('A secret name is required.');

  const k = normalizeKind(kind);
  if ((k === 'env' || k === 'git') && !ENV_NAME_RE.test(cleanName)) {
    throw new Error('Env secrets must use a valid environment variable name (letters, digits, underscore).');
  }
  if (value === null || value === undefined || String(value).length === 0) {
    throw new Error('A secret value is required.');
  }

  const encrypted = encrypt(String(value));
  const metaJson = metadata ? JSON.stringify(metadata) : null;
  const db = getDatabase();
  const ts = new Date().toISOString();

  const existing = db.prepare('SELECT name FROM secrets WHERE name = ?').get(cleanName);
  if (existing) {
    db.prepare(
      'UPDATE secrets SET kind = ?, value_encrypted = ?, metadata = ?, updated_at = ? WHERE name = ?'
    ).run(k, encrypted, metaJson, ts, cleanName);
  } else {
    db.prepare(
      `INSERT INTO secrets (name, kind, value_encrypted, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(cleanName, k, encrypted, metaJson, ts, ts);
  }

  return { name: cleanName, kind: k, metadata, updated_at: ts };
}

function removeSecret(name) {
  const db = getDatabase();
  const res = db.prepare('DELETE FROM secrets WHERE name = ?').run(String(name));
  return { success: res.changes > 0, name: String(name) };
}

/**
 * Decrypted copy of the vault for pairing/sync. Callers must treat the result
 * as secret material: never log it, render it, or send it over plain HTTP.
 * Undecryptable entries are skipped instead of breaking the whole export.
 */
function exportSecrets() {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT name, kind, metadata, value_encrypted, updated_at FROM secrets ORDER BY kind, name'
  ).all();
  const out = [];
  for (const row of rows) {
    try {
      out.push({
        name: row.name,
        kind: row.kind,
        metadata: parseMetadata(row.metadata),
        value: decrypt(row.value_encrypted),
        updated_at: row.updated_at,
      });
    } catch {
      // Rotated key or corrupt row: skip it rather than failing the export.
    }
  }
  return out;
}

/**
 * Environment variables an agent/terminal should receive: every `env` and `git`
 * entry, keyed by its (valid) variable name. Undecryptable entries are skipped
 * rather than failing the whole spawn.
 */
function envVars() {
  const db = getDatabase();
  const rows = db.prepare("SELECT name, value_encrypted FROM secrets WHERE kind IN ('env', 'git')").all();
  const out = {};
  for (const r of rows) {
    try {
      out[r.name] = decrypt(r.value_encrypted);
    } catch {
      // Rotated key or corrupt row: leave this variable unset.
    }
  }
  return out;
}

module.exports = {
  KINDS,
  listSecrets,
  getSecret,
  getValue,
  setSecret,
  removeSecret,
  exportSecrets,
  envVars,
};
