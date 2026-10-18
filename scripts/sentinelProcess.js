/**
 * Process identity helpers used by the sentinel supervisor.
 *
 * A persisted PID is never trusted on its own: PIDs are reused by the kernel.
 * Before signalling anything we check that the live process still has the same
 * start token (Linux `/proc/<pid>/stat` field 22, or `ps lstart` elsewhere) and
 * (when recorded) the same process group. Executions are spawned detached, so
 * the child becomes its own process-group leader and `-pgid` reaches its
 * descendants as well.
 *
 * Linux gets the strongest evidence (`/proc` jiffies + environment marker
 * scan). Other platforms fall back to `ps` and the group probe; limitations are
 * documented in docs/architecture.md.
 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 1;
}

function isAlive(pid) {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

function readLinuxStat(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // The comm field can contain spaces and parentheses: split after the last ')'.
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  // fields[0] = state (field 3), fields[2] = pgrp (field 5),
  // fields[19] = starttime (field 22).
  const state = fields[0];
  const pgrp = parseInt(fields[2], 10);
  const starttime = fields[19];
  if (!Number.isInteger(pgrp) || !starttime) return null;
  return { state, pgrp, starttime };
}

function readPs(pid) {
  try {
    const res = spawnSync('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 4000,
    });
    if (res.status !== 0) return null;
    const match = res.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    return { pgrp: parseInt(match[1], 10), state: match[2], lstart: match[3].trim() };
  } catch {
    return null;
  }
}

/**
 * Inspect a live process. Returns null when it is gone (or a zombie) or when
 * the kernel does not expose it. `startToken` identifies this incarnation of
 * the PID; `pgid` is the process group.
 */
function inspect(pid) {
  if (!isAlive(pid)) return null;
  if (process.platform === 'linux') {
    const stat = readLinuxStat(pid);
    if (!stat) return null;
    if (stat.state === 'Z') return null; // terminated, waiting to be reaped
    return { pid, pgid: stat.pgrp, startToken: `linux:${stat.starttime}`, state: stat.state };
  }
  const ps = readPs(pid);
  if (!ps || ps.state.startsWith('Z')) return null;
  return { pid, pgid: ps.pgrp, startToken: `ps:${ps.lstart}`, state: ps.state };
}

/**
 * Decide whether a persisted execution record still refers to the live process
 * it was created for. Missing start token on either side is tolerated (older
 * records / restricted platforms) but never treated as positive reuse.
 */
function verify(record) {
  if (!record || !isValidPid(record.pid)) return { alive: false, reason: 'no-pid' };
  const current = inspect(record.pid);
  if (!current) return { alive: false, reason: 'gone' };
  if (record.startToken && current.startToken && record.startToken !== current.startToken) {
    return { alive: false, reason: 'pid-reused', current };
  }
  if (Number.isInteger(record.pgid) && record.pgid > 1 && current.pgid !== record.pgid) {
    return { alive: false, reason: 'group-changed', current };
  }
  return { alive: true, current };
}

/** True when any live process still belongs to the recorded process group. */
function groupExists(pgid) {
  if (!isValidPid(pgid) || pgid === process.pid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function safeTarget(record, current) {
  const pgid = Number.isInteger(record.pgid) && record.pgid > 1 ? record.pgid : (current && current.pgid);
  return Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid ? pgid : null;
}

/**
 * Send a signal to the execution's process group (descendants included).
 * Returns `{ ok, gone, reason }`. A mismatching PID is never signalled.
 */
function signalTree(record, signal) {
  const check = verify(record);
  const current = check.current;
  // A PID that now belongs to a different incarnation is never signalled. Even
  // if a process group with the same id still exists, it may be unrelated; the
  // execution marker scan is the only safe way to attribute survivors.
  if (check.reason === 'pid-reused') return { ok: false, reason: 'pid-reused' };
  if (!check.alive) {
    return { ok: true, gone: true, reason: check.reason };
  }

  const pgid = safeTarget(record, current);
  if (!pgid) return { ok: false, reason: 'unsafe-target' };

  try {
    process.kill(-pgid, signal);
    return { ok: true, pgid };
  } catch (err) {
    if (err.code === 'ESRCH') return { ok: true, gone: true };
    if (err.code === 'EPERM') return { ok: false, reason: 'permission-denied' };
    return { ok: false, reason: err.code || err.message };
  }
}

/** Signal a process group directly (used only when the group was attributed). */
function signalGroup(pgid, signal) {
  if (!isValidPid(pgid) || pgid === process.pid) return { ok: false, reason: 'unsafe-target' };
  try {
    process.kill(-pgid, signal);
    return { ok: true, pgid };
  } catch (err) {
    if (err.code === 'ESRCH') return { ok: true, gone: true };
    return { ok: false, reason: err.code || err.message };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the verified process is gone (leader only). */
async function waitForExit(record, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!verify(record).alive) return true;
    await sleep(stepMs);
  }
  return !verify(record).alive;
}

/** Wait until neither the leader nor any member of the recorded group remains. */
async function waitForGroupGone(record, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const pgid = record.pgid;
  while (Date.now() <= deadline) {
    const leaderGone = !verify(record).alive;
    const members = groupExists(pgid);
    if (leaderGone && !members) return true;
    await sleep(stepMs);
  }
  return !verify(record).alive && !groupExists(pgid);
}

/**
 * Scan visible /proc entries for an environment marker. Returns
 * `{ available, pids }`; `available:false` means the platform or permissions
 * cannot give a definitive answer. Only Linux exposes per-process environ.
 */
function scanEnvMarker(key, value) {
  if (process.platform !== 'linux') return { available: false, pids: [] };
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return { available: false, pids: [] };
  }
  const needle = `${key}=${value}`;
  const pids = [];
  try {
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (!isValidPid(pid)) continue;
      let environ;
      try {
        environ = fs.readFileSync(`/proc/${pid}/environ`);
      } catch {
        continue;
      }
      if (!environ.includes(needle)) continue;
      const info = inspect(pid);
      if (info) pids.push({ pid, pgid: info.pgid, startToken: info.startToken, state: info.state });
    }
    return { available: true, pids };
  } catch {
    return { available: false, pids: [] };
  }
}

/**
 * Find survivors of a specific execution. The exec marker is injected into the
 * child environment, so direct children and inherited descendants match.
 */
function findByExecMarker(execId) {
  if (!execId) return { available: process.platform === 'linux', pids: [] };
  // Indirection through the exports object so tests can inject a scanner; the
  // production path is the same function.
  const scanner = module.exports.scanEnvMarker || scanEnvMarker;
  const found = scanner('CITADEL_EXEC_ID', execId);
  if (!found.available) return found;
  return found;
}

/**
 * Recover the process group of a concrete execution after a restart. Prefers
 * the leader's start token; falls back to the exec marker on Linux.
 */
function recoverExecution(record) {
  if (!isValidPid(record.pid)) {
    // The sentinel may have crashed between spawn and persisting the pid. Only
    // the environment marker can give a definitive answer on Linux; elsewhere
    // the state stays explicitly unknown (never silently "gone").
    const marker = findByExecMarker(record.execId);
    if (!marker.available) return { alive: false, reason: 'unknown' };
    if (marker.pids.length === 0) return { alive: false, reason: 'gone' };
    const hit = pickMarkerProcess(marker.pids);
    return { alive: true, pid: hit.pid, pgid: hit.pgid, startToken: hit.startToken, source: 'env-marker' };
  }

  const direct = verify(record);
  if (direct.alive) return { alive: true, pid: record.pid, pgid: direct.current.pgid, startToken: direct.current.startToken, source: 'pid' };

  const marker = findByExecMarker(record.execId);
  if (marker.available && marker.pids.length > 0) {
    const hit = pickMarkerProcess(marker.pids);
    return { alive: true, pid: hit.pid, pgid: hit.pgid, startToken: hit.startToken, source: 'env-marker' };
  }
  if (marker.available) return { alive: false, reason: 'gone' };
  if (!groupExists(record.pgid)) return { alive: false, reason: direct.reason === 'pid-reused' ? 'gone' : direct.reason };
  return { alive: false, reason: 'unknown', groupAlive: true };
}

// Prefer the group leader, then the lowest pid in the group.
function pickMarkerProcess(pids) {
  return [...pids].sort((a, b) => {
    const leaderA = a.pgid === a.pid ? 0 : 1;
    const leaderB = b.pgid === b.pid ? 0 : 1;
    return leaderA - leaderB || a.pid - b.pid;
  })[0];
}

module.exports = {
  isAlive,
  inspect,
  verify,
  groupExists,
  signalTree,
  signalGroup,
  waitForExit,
  waitForGroupGone,
  scanEnvMarker,
  findByExecMarker,
  recoverExecution,
};
