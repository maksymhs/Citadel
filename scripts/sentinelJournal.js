/**
 * Durable sentinel execution journal.
 *
 * The task database knows which attempt is authorized; it cannot see the local
 * process tree. This journal is the sentinel's own record of what it actually
 * spawned, so a restarted sentinel can tell "the process is still alive" from
 * "it is gone" instead of blindly re-running a task whose lease expired.
 *
 * File layout: one JSON file per node in a 0700 directory, written 0600 via a
 * temp file + fsync + rename. It contains per-claim secrets (claim tokens), so
 * it is never logged and never placed under a world-readable path.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultDir() {
  return process.env.CITADEL_SENTINEL_STATE_DIR || path.join(os.homedir(), '.citadel', 'sentinel');
}

function safeNodeName(node) {
  return String(node || 'node').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'node';
}

class Journal {
  constructor({ node, dir } = {}) {
    this.node = node || os.hostname();
    this.dir = dir || defaultDir();
    this.file = path.join(this.dir, `${safeNodeName(this.node)}.json`);
    this.records = new Map();
    this.loaded = false;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* best effort */ }
  }

  load() {
    this.ensureDir();
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupt journal must not be silently discarded: the sentinel cannot
        // prove which processes it owns, so it starts with an explicit empty
        // state and leaves server-side tracked attempts in reconciliation. Keep
        // the damaged file for forensic inspection instead of overwriting it.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.file, backup); } catch { /* best effort */ }
        console.error(`[sentinel] execution journal unreadable (${err.code || err.message}); starting empty.`);
      }
      parsed = null;
    }
    this.records = new Map();
    if (parsed && Array.isArray(parsed.executions)) {
      for (const record of parsed.executions) {
        if (record && typeof record.execId === 'string' && typeof record.taskId === 'string') {
          this.records.set(record.execId, record);
        }
      }
    }
    this.loaded = true;
    return this.all();
  }

  ensureLoaded() {
    if (!this.loaded) this.load();
  }

  all() {
    if (!this.loaded) this.load();
    return [...this.records.values()];
  }

  get(execId) {
    if (!this.loaded) this.load();
    return this.records.get(execId) || null;
  }

  save() {
    this.ensureDir();
    const data = JSON.stringify({ version: 1, node: this.node, executions: [...this.records.values()] }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    try {
      const dfd = fs.openSync(this.dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch {
      // Directory fsync is best effort (not supported everywhere).
    }
  }

  put(record) {
    this.ensureLoaded();
    const now = new Date().toISOString();
    this.records.set(record.execId, { ...record, updatedAt: now });
    this.save();
    return this.records.get(record.execId);
  }

  update(execId, patch) {
    this.ensureLoaded();
    const current = this.records.get(execId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(execId, next);
    this.save();
    return next;
  }

  remove(execId) {
    this.ensureLoaded();
    if (!this.records.has(execId)) return false;
    this.records.delete(execId);
    this.save();
    return true;
  }

  clear() {
    this.loaded = true;
    this.records.clear();
    this.save();
  }
}

/**
 * One sentinel per node. A second instance sharing the same state directory
 * would recover the same executions and could double-signal them, so it fails
 * closed. A lock left by a dead pid is reclaimed.
 */
function acquireLock(node, { dir } = {}) {
  const stateDir = dir || defaultDir();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(stateDir, 0o700); } catch { /* best effort */ }
  const lockPath = path.join(stateDir, `${safeNodeName(node)}.lock`);

  const tryCreate = () => {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  };

  if (!tryCreate()) {
    let holder = null;
    let readable = false;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      readable = true;
    } catch { /* unreadable lock -> possibly mid-write */ }
    let holderAlive = false;
    if (holder && Number.isInteger(holder.pid) && holder.pid > 1) {
      try { process.kill(holder.pid, 0); holderAlive = true; } catch (err) { holderAlive = err.code === 'EPERM'; }
    }
    if (holderAlive) {
      throw new Error(`Another sentinel (pid ${holder.pid}) already holds ${lockPath}.`);
    }
    if (!readable) {
      // A lock file that exists but cannot be parsed may be mid-write by a
      // starting sentinel. Only reclaim it once it is old enough to be stale.
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { /* raced */ }
      if (age < 5000) {
        throw new Error(`Sentinel lock ${lockPath} exists but is not readable yet; refusing to steal it.`);
      }
    }
    try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    if (!tryCreate()) throw new Error(`Could not acquire sentinel lock ${lockPath}.`);
  }

  return {
    path: lockPath,
    release() {
      try {
        const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (holder && holder.pid === process.pid) fs.unlinkSync(lockPath);
      } catch { /* already gone */ }
    },
  };
}

module.exports = { Journal, acquireLock, defaultDir, safeNodeName };
