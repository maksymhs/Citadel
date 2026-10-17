/**
 * Citadel Secret Encryption (AES-256-GCM)
 * Protects credentials at rest inside the SQLite database.
 *
 * Key resolution order:
 *   1. CITADEL_SECRET_KEY environment variable (64 hex characters = 32 bytes)
 *   2. A persisted key file in DATA_DIR (created with 0600 permissions)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../config');

const KEY_FILE = path.join(DATA_DIR, 'secret.key');
let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;

  const envKey = process.env.CITADEL_SECRET_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey.trim(), 'hex');
    if (buf.length !== 32) {
      throw new Error('CITADEL_SECRET_KEY must be 64 hex characters (32 bytes).');
    }
    cachedKey = buf;
    return cachedKey;
  }

  if (fs.existsSync(KEY_FILE)) {
    const buf = fs.readFileSync(KEY_FILE);
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
  }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  cachedKey = key;
  return cachedKey;
}

function encrypt(plaintext) {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload) {
  if (!payload || typeof payload !== 'string') return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;

  const [, ivB64, tagB64, dataB64] = parts;
  const key = loadKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = { encrypt, decrypt };
