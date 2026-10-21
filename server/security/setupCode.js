/**
 * First-run setup code.
 *
 * Until the first administrator exists, whoever reaches the panel first could
 * claim it. When this is required, creating that account also needs a short
 * one-time code that only someone with shell access to the host can read
 * (`citadel setup-code`, also printed by the installer). It is stored in
 * DATA_DIR/setup-code (mode 0600) and removed once the account exists.
 *
 * Guessing is bounded: after MAX_FAILURES wrong codes the code is replaced by a
 * new one (the old guesses become worthless) and attempts pause for a minute.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../config');

const CODE_FILE = path.join(DATA_DIR, 'setup-code');
// No 0/O/1/I/L: the code is typed by a person.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP = 4;
const GROUPS = 2;
const MAX_FAILURES = 5;
const LOCK_MS = 60 * 1000;

const state = { failures: 0, lockedUntil: 0 };

function generate() {
  const chars = [];
  for (let i = 0; i < GROUP * GROUPS; i += 1) chars.push(ALPHABET[crypto.randomInt(ALPHABET.length)]);
  const groups = [];
  for (let i = 0; i < GROUPS; i += 1) groups.push(chars.slice(i * GROUP, (i + 1) * GROUP).join(''));
  return groups.join('-');
}

// Case, spaces and dashes do not matter when typing.
function normalize(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameCode(a, b) {
  const ha = crypto.createHash('sha256').update(normalize(a)).digest();
  const hb = crypto.createHash('sha256').update(normalize(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// An explicit code from the environment (automation, containers) wins.
function fromEnv() {
  const value = process.env.CITADEL_SETUP_CODE;
  return value && normalize(value).length >= 8 ? value.trim() : null;
}

function read() {
  const env = fromEnv();
  if (env) return env;
  try {
    return fs.readFileSync(CODE_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function write(code) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CODE_FILE, `${code}\n`, { mode: 0o600 });
  fs.chmodSync(CODE_FILE, 0o600);
}

/** The current code, creating one when there is none yet. */
function ensure() {
  const existing = read();
  if (existing) return existing;
  const code = generate();
  write(code);
  return code;
}

function clear() {
  state.failures = 0;
  state.lockedUntil = 0;
  try { fs.rmSync(CODE_FILE, { force: true }); } catch { /* nothing to remove */ }
}

/**
 * Check a submitted code. Returns { ok: true } or { ok: false, reason, retryAfterSec?, rotated? }.
 */
function verify(input, now = Date.now()) {
  if (now < state.lockedUntil) {
    return { ok: false, reason: 'locked', retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) };
  }
  const expected = read();
  if (!expected) return { ok: false, reason: 'missing' };
  if (sameCode(input, expected)) {
    state.failures = 0;
    return { ok: true };
  }
  state.failures += 1;
  if (state.failures >= MAX_FAILURES) {
    state.failures = 0;
    state.lockedUntil = now + LOCK_MS;
    // An environment code cannot be rotated from here; a file code can.
    const rotated = !fromEnv();
    if (rotated) write(generate());
    return { ok: false, reason: 'invalid', rotated, retryAfterSec: Math.ceil(LOCK_MS / 1000) };
  }
  return { ok: false, reason: 'invalid', rotated: false };
}

module.exports = { CODE_FILE, generate, normalize, read, ensure, clear, verify, MAX_FAILURES };
