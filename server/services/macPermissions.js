/**
 * macOS Full Disk Access (TCC) status for the Citadel service.
 *
 * macOS grants privacy permissions per binary, so only the running service can
 * tell whether *it* has Full Disk Access (a shell in Terminal is checked against
 * Terminal's grant instead). The service probes two folders that can only be
 * listed with that permission and records the answer in DATA_DIR/permissions.json,
 * where `citadel permissions` and the panel read it. Does nothing off macOS.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FILE_NAME = 'permissions.json';
const CHECK_INTERVAL_MS = 60 * 1000;

// Listing either folder fails with EPERM/EACCES unless the process has Full Disk Access.
function probePaths(home) {
  return [
    path.join(home, 'Library', 'Application Support', 'com.apple.TCC'),
    path.join(home, 'Library', 'Safari'),
  ];
}

/**
 * @returns {{ supported: boolean, granted: boolean|null }} granted is null when
 * no probe folder exists, so the answer is unknown rather than a guess.
 */
function probeFullDiskAccess({ platform = process.platform, home = os.homedir(), fsImpl = fs } = {}) {
  if (platform !== 'darwin') return { supported: false, granted: null };
  for (const dir of probePaths(home)) {
    try {
      fsImpl.readdirSync(dir);
      return { supported: true, granted: true };
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return { supported: true, granted: false };
      // ENOENT and anything else: try the next probe.
    }
  }
  return { supported: true, granted: null };
}

/** Real paths of the binaries the user has to allow (symlinks resolved, as macOS records them). */
function binariesToAllow({ execPath = process.execPath, which = defaultWhich } = {}) {
  const out = [];
  const add = (label, p) => {
    if (!p) return;
    let real = p;
    try { real = fs.realpathSync(p); } catch { /* keep the given path */ }
    out.push({ label, path: real });
  };
  add('node', execPath);
  add('tmux', which('tmux'));
  return out;
}

function defaultWhich(name) {
  const res = spawnSync('which', [name], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function statusFile(dataDir) {
  return path.join(dataDir, FILE_NAME);
}

function writeStatus(dataDir, state = probeFullDiskAccess(), extra = {}) {
  if (!state.supported) return null;
  const doc = {
    fullDiskAccess: state.granted,
    node: binariesToAllow().find((b) => b.label === 'node')?.path || process.execPath,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(statusFile(dataDir), `${JSON.stringify(doc)}\n`, { mode: 0o644 });
  } catch {
    return null;
  }
  return doc;
}

function readStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(statusFile(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

let timer = null;

/** Probe now and then every minute, so a grant made in System Settings shows up without a restart. */
function start(dataDir, { platform = process.platform } = {}) {
  if (platform !== 'darwin' || timer) return;
  writeStatus(dataDir);
  timer = setInterval(() => writeStatus(dataDir), CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { probeFullDiskAccess, binariesToAllow, writeStatus, readStatus, statusFile, start, stop, CHECK_INTERVAL_MS };
