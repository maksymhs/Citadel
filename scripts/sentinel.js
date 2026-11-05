#!/usr/bin/env node
/**
 * Citadel Sentinel — the dumb half of the task mesh.
 *
 * Runs on every node and does one thing in a loop: report load, pull a task,
 * run it, report the result. It never schedules anything; because it only
 * pulls while it has a free slot, load balancing across nodes is emergent.
 *
 * Run it inside a Citadel terminal (survives restarts via tmux) or as a
 * systemd unit:
 *
 *   CITADEL_URL=https://panel.example.com \
 *   CITADEL_NODE_TOKEN=<this node's secret> \
 *   CITADEL_NODE=vps-2 \
 *   CITADEL_CAPACITY=2 \
 *   node scripts/sentinel.js
 *
 * CITADEL_NODE_TOKEN is the scoped worker credential (claim/result/heartbeat).
 * When the server configures per-node CITADEL_NODE_TOKENS, this value is bound
 * to CITADEL_NODE and cannot act as another node; the legacy shared-token mode
 * (one secret for every sentinel) still works. CITADEL_TOKEN (a full session
 * id) is supported as a fallback but grants panel-wide privileges.
 *
 * A task's `cmd` is executed directly (no shell); for shell one-liners use
 * cmd="bash" and args=["-lc", "..."].
 *
 * Execution lifecycle (protocol 2):
 *   - Every spawned execution gets a random exec id, is launched detached (its
 *     own process group, so descendants can be terminated together) and is
 *     recorded in a durable journal BEFORE and immediately after spawn.
 *   - The heartbeat reports the journaled executions (pid/pgid/exec id). The
 *     server therefore knows an attempt has a real local process.
 *   - On startup the sentinel reconciles the journal before polling: a live
 *     process is re-adopted (and its lease re-authorized), a provably dead one
 *     is reported or requeued, and an unverifiable one is declared unknown and
 *     is never relaunched automatically.
 *   - A lease expiry alone never requeues a protocol-2 attempt; the owning node
 *     must confirm the process outcome via POST /api/tasks/:id/reconcile.
 *
 * The journal lives in CITADEL_SENTINEL_STATE_DIR (default
 * ~/.citadel/sentinel) as 0600 JSON. It contains per-claim tokens: never log it.
 * One sentinel per node/state directory is enforced with a lock file.
 */
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Journal, acquireLock } = require('./sentinelJournal');
const proc = require('./sentinelProcess');
const { buildTaskEnv } = require('./sentinelEnv');

const BASE = (process.env.CITADEL_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = process.env.CITADEL_TOKEN || '';
const NODE_TOKEN = process.env.CITADEL_NODE_TOKEN || '';
const NODE = process.env.CITADEL_NODE || os.hostname();
const CAPACITY = Math.max(1, parseInt(process.env.CITADEL_CAPACITY, 10) || 1);
const POLL_MS = Math.max(1000, parseInt(process.env.CITADEL_POLL_MS, 10) || 4000);
// Every HTTP call is bounded so a hung server can never wedge the loop.
const HTTP_TIMEOUT_MS = Math.max(1000, parseInt(process.env.CITADEL_HTTP_TIMEOUT_MS, 10) || 15000);
const TAGS = (process.env.CITADEL_TAGS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const MAX_RESULT = Math.max(1000, parseInt(process.env.CITADEL_MAX_RESULT, 10) || 8000);
// SIGTERM -> bounded wait -> SIGKILL -> bounded confirmation.
const KILL_GRACE_MS = Math.max(0, parseInt(process.env.CITADEL_KILL_GRACE_MS, 10) || 10000);
const KILL_CONFIRM_MS = Math.max(0, parseInt(process.env.CITADEL_KILL_CONFIRM_MS, 10) || 5000);
const PROTOCOL = 2;
// Durable result reporting: a finished execution keeps its bounded report in
// the journal until the server accepts it. Retries use bounded exponential
// backoff so an unreachable panel is not hammered on every poll.
const REPORT_BASE_MS = Math.max(1000, parseInt(process.env.CITADEL_REPORT_RETRY_MS, 10) || 3000);
const REPORT_MAX_MS = Math.max(REPORT_BASE_MS, parseInt(process.env.CITADEL_REPORT_RETRY_MAX_MS, 10) || 60000);

let active = 0;
const running = new Map(); // task id -> execution entry
// Executions whose stored report is being sent right now: prevents the periodic
// retry loop and a finishing handler from sending the same result twice.
const reportingInFlight = new Set();

let journalInstance = null;
function journal() {
  if (!journalInstance) journalInstance = new Journal({ node: NODE });
  return journalInstance;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Citadel-Sentinel',
  };
  if (NODE_TOKEN) headers['X-Citadel-Node-Token'] = NODE_TOKEN;
  else headers.Authorization = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function recordFor(entry) {
  const base = entry.record || (entry.execId ? journal().get(entry.execId) : null);
  if (!base) return base;
  // Close the tiny window between spawn() returning and the first journal
  // update: the child is already alive, so its identity is known even if the
  // durable record still says "starting".
  if (entry.child && entry.child.pid && !base.pid) {
    const info = proc.inspect(entry.child.pid);
    if (info) {
      return { ...base, pid: entry.child.pid, pgid: info.pgid, startToken: info.startToken };
    }
  }
  return base;
}

function cleanupJournal(execId) {
  try { journal().remove(execId); } catch (err) {
    console.error(`[sentinel] could not update execution journal: ${err.message}`);
  }
}

/** Clean up a terminal record that is no longer tracked in memory. */
function forgetRecord(record) {
  if (record && record.execId) cleanupJournal(record.execId);
}

function adoptRecord(record) {
  const existing = running.get(record.taskId);
  if (existing) return existing;
  active += 1;
  const entry = {
    execId: record.execId,
    taskId: record.taskId,
    claimToken: record.claimToken || null,
    attempt: record.attempt,
    child: null,
    recovered: true,
    cancelled: false,
    finished: false,
    abandoned: false,
    termination: null,
    record,
    startedAt: record.startedAt || null,
  };
  running.set(record.taskId, entry);
  return entry;
}

function isAttributable(record) {
  const marker = proc.findByExecMarker(record.execId);
  return marker.available && marker.pids.length > 0;
}

/**
 * Terminate the recorded execution tree: SIGTERM to the group, bounded wait,
 * SIGKILL, bounded confirmation. A group whose leader is gone is only signalled
 * when the exec marker proves it still belongs to us (avoids a reused pgid).
 */
async function terminateRecord(record) {
  if (!record) return { gone: true };
  const check = proc.verify(record);
  if (check.reason === 'no-pid' && !(Number.isInteger(record.pgid) && record.pgid > 1)) {
    // There is nothing concrete to signal. Reporting "gone" here would let a
    // cancellation claim a termination that was never verified.
    return { gone: false, reason: 'no-execution-identity' };
  }
  if (check.reason === 'pid-reused') {
    return { gone: false, reason: 'pid-reused' };
  }
  if (!check.alive && !proc.groupExists(record.pgid)) {
    return { gone: true };
  }
  const leaderAlive = () => proc.verify(record).alive;

  if (leaderAlive()) proc.signalTree(record, 'SIGTERM');
  if (await proc.waitForGroupGone(record, KILL_GRACE_MS)) return { gone: true };

  const attributable = leaderAlive() || isAttributable(record);
  if (attributable) proc.signalGroup(record.pgid, 'SIGKILL');
  const gone = await proc.waitForGroupGone(record, KILL_CONFIRM_MS);
  return { gone };
}

/**
 * Reconcile safely with the server. Returns `{ settled, discarded }`:
 * `settled` means the server gave a definitive answer (accepted or rejected),
 * so the local journal entry can be cleaned up. A network failure keeps the
 * record for the next restart instead of dropping evidence.
 */
async function safeReconcileRecord(record, state, exitCode, signal) {
  if (!record || !record.taskId || !record.claimToken) return { settled: true, discarded: true };
  const body = {
    node: NODE,
    state,
    claimToken: record.claimToken,
    execId: record.execId,
    pid: record.pid || undefined,
    pgid: record.pgid || undefined,
    startedAt: record.startedAt || undefined,
  };
  if (entryFinite(exitCode)) body.exitCode = Math.trunc(exitCode);
  if (signal) body.signal = String(signal);
  try {
    const res = await api(`/api/tasks/${record.taskId}/reconcile`, { method: 'POST', body });
    return {
      settled: true,
      discarded: !!(res && res.reconciliation && res.reconciliation.discarded),
    };
  } catch (err) {
    // 409/403/404 are authoritative rejections: the attempt is not ours.
    if ([403, 404, 409].includes(err.status)) return { settled: true, discarded: true };
    console.error(`[sentinel] reconcile ${state} failed for ${record.taskId}: ${err.message}`);
    return { settled: false, discarded: false };
  }
}

function entryFinite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A rejection that means "this attempt is over, never retry": the claim token
 * is invalid or the task is already finished. A 409 is different — the server
 * is telling us the lease expired and reconciliation is required — so it is not
 * treated as definitive.
 */
function isDefinitiveResultError(err) {
  if (!err) return false;
  if (err.status === 403 || err.status === 404) return true;
  if (err.status === 409) return false;
  return /already finished|claimed by another worker|not found|identity mismatch|refusing a result from another execution|not authorized/i.test(err.message || '');
}

function reportBackoffMs(attempts) {
  return Math.min(REPORT_MAX_MS, REPORT_BASE_MS * 2 ** Math.min(attempts, 10));
}

/**
 * Persist the bounded report and its retry state in the existing journal before
 * the first network attempt. Returns the updated record (or null when the
 * journal could not be written).
 */
function markReportPending(execId, report) {
  try {
    return journal().update(execId, {
      state: 'terminated',
      report,
      reportPending: true,
      reportAttempts: 0,
      reportNextAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[sentinel] could not persist pending report for ${execId}: ${err.message}`);
    return null;
  }
}

function scheduleReportRetry(execId) {
  const current = journal().get(execId);
  if (!current) return;
  const attempts = (entryFinite(current.reportAttempts) ? current.reportAttempts : 0) + 1;
  const nextAt = new Date(Date.now() + reportBackoffMs(attempts)).toISOString();
  try {
    journal().update(execId, { reportAttempts: attempts, reportNextAt: nextAt });
    console.error(`[sentinel] ${current.taskId}: report still pending (attempt ${attempts}); retrying after ${nextAt}.`);
  } catch (err) {
    console.error(`[sentinel] could not persist report retry state for ${execId}: ${err.message}`);
  }
}

/**
 * Deliver one finished execution's result, durably. The bounded report is read
 * from the journal, so this survives a crash/restart. On a transient failure the
 * journal is preserved and the next poll retries; on a definitive rejection or an
 * accepted result the journal entry is cleaned up. A rejected-but-reconcilable
 * attempt (lease expired) falls back to the reconcile protocol with the stored
 * identity, never inventing a new execution.
 *
 * Accepts an execId or a journal record; re-reads the record so concurrent
 * callers share persisted state.
 */
async function deliverReport(ref) {
  const execId = typeof ref === 'string' ? ref : (ref && ref.execId);
  if (!execId || reportingInFlight.has(execId)) return;
  const record = journal().get(execId) || (typeof ref === 'object' ? ref : null);
  if (!record || !record.claimToken) return;

  reportingInFlight.add(execId);
  try {
    if (record.report) {
      const body = {
        status: record.report.status,
        exitCode: record.report.exitCode,
        error: record.report.error,
        result: record.report.result,
        claimToken: record.claimToken,
        execId,
      };
      try {
        await api(`/api/tasks/${record.taskId}/result`, { method: 'POST', body });
        cleanupJournal(execId);
        console.log(`[sentinel] ${record.taskId} -> ${body.status}`);
        return;
      } catch (err) {
        if (isDefinitiveResultError(err)) {
          cleanupJournal(execId);
          console.log(`[sentinel] ${record.taskId}: result discarded by the server (${err.message}).`);
          return;
        }
        console.error(`[sentinel] report ${record.taskId} failed: ${err.message}; attempting reconcile.`);
      }
    }

    // No saved report (a legacy v0.19.0 entry) or the result was rejected as
    // reconcilable: use the existing reconcile protocol with the stored identity.
    const settled = await safeReconcileRecord(record, 'terminated', record.exitCode, record.signal);
    if (settled.settled) {
      cleanupJournal(execId);
      console.log(`[sentinel] ${record.taskId} reconciled.`);
      return;
    }
    scheduleReportRetry(execId);
  } finally {
    reportingInFlight.delete(execId);
  }
}

/**
 * A journaled execution whose process has terminated and whose report is still
 * pending. Legacy terminated entries (no saved report) are included so they are
 * reconciled on the next poll instead of waiting for a sentinel restart.
 */
function isReportDue(record, now) {
  if (!record || !record.claimToken) return false;
  const pending = record.reportPending || record.state === 'terminated';
  if (!pending) return false;
  if (!record.reportNextAt) return true;
  const next = Date.parse(record.reportNextAt);
  return !Number.isFinite(next) || next <= now;
}

async function retryPendingReports() {
  const now = Date.now();
  for (const record of journal().all()) {
    if (!isReportDue(record, now)) continue;
    await deliverReport(record);
  }
}

function requestCancel(entry) {
  if (!entry) return Promise.resolve({ gone: true });
  if (entry.termination) return entry.termination;
  entry.cancelled = true;
  console.log(`[sentinel] cancelling ${entry.taskId}`);
  const record = recordFor(entry);

  entry.termination = (async () => {
    const result = await terminateRecord(record);
    // Recovered executions have no child 'exit' event, so they must report the
    // outcome (or their uncertainty) themselves.
    if (entry.recovered && !entry.finished) {
      entry.finished = true;
      running.delete(entry.taskId);
      active = Math.max(0, active - 1);
      if (result.gone) {
        try { journal().update(entry.execId, { state: 'terminated', signal: 'SIGTERM' }); } catch { /* best effort */ }
        const settled = await safeReconcileRecord({ ...record, state: 'terminated' }, 'terminated', undefined, 'SIGTERM');
        if (settled.settled) cleanupJournal(entry.execId);
      } else {
        console.warn(`[sentinel] could not confirm termination of ${entry.taskId}; marking the execution unknown.`);
        await safeReconcileRecord({ ...record }, 'unknown');
      }
    }
    return result;
  })().catch((err) => {
    console.error(`[sentinel] cancellation failed for ${entry.taskId}: ${err.message}`);
    return { gone: false };
  });
  return entry.termination;
}

/**
 * Stop an execution that no longer owns the current attempt. Never reports a
 * result: the server already rejected/discarded it.
 */
async function abandonExecution(item, reason) {
  const id = typeof item === 'string' ? item : (item && item.id);
  if (!id) return;
  const wantedExec = item && typeof item === 'object' ? item.execId : null;

  const entry = running.get(id);
  let record = null;
  if (entry && (!wantedExec || entry.execId === wantedExec)) {
    entry.abandoned = true;
    record = recordFor(entry);
    if (!entry.finished) {
      entry.finished = true;
      running.delete(id);
      active = Math.max(0, active - 1);
    }
  } else {
    record = journal().all().find((r) => r.taskId === id && (!wantedExec || r.execId === wantedExec)) || null;
  }
  if (!record) return;

  console.log(`[sentinel] abandoning ${id}${reason ? ` (${reason})` : ''}`);
  const result = await terminateRecord(record);
  if (result.gone) forgetRecord(record);
  else console.warn(`[sentinel] abandoned execution ${id} could not be confirmed gone; keeping its journal record.`);
}

function buildEnv(task, execId) {
  // Never hand a task command Citadel's own control-plane secrets: keep the
  // runtime environment and the recovery markers, drop the internal creds.
  return buildTaskEnv(task, execId, { baseEnv: process.env, node: NODE });
}

function runTask(task) {
  active += 1;
  const cwd = task.projectPath || process.cwd();
  const args = Array.isArray(task.args) ? task.args : [];
  const execId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const claimToken = task.claimToken || null;

  // Journal the intent BEFORE spawning: if we crash right after fork, startup
  // reconciliation knows an execution may exist.
  try {
    journal().put({
      execId,
      taskId: task.id,
      node: NODE,
      attempt: entryFinite(task.attempt) ? task.attempt : null,
      claimToken,
      cmd: task.cmd,
      args,
      cwd,
      state: 'starting',
      pid: null,
      pgid: null,
      startToken: null,
      startedAt,
    });
  } catch (err) {
    active = Math.max(0, active - 1);
    console.error(`[sentinel] refusing to spawn ${task.id}: execution journal unavailable (${err.message}).`);
    if (claimToken) {
      void api(`/api/tasks/${task.id}/result`, {
        method: 'POST',
        body: {
          status: 'failed', exitCode: -1, error: 'sentinel journal unavailable; task not spawned.',
          claimToken, execId,
        },
      }).catch(() => {});
    }
    return { execId, taskId: task.id, claimToken, child: null, failedToStart: true };
  }

  console.log(`[sentinel] running ${task.id}: ${task.cmd} ${args.join(' ')} (cwd=${cwd})`);

  let child;
  try {
    child = spawn(task.cmd, args, {
      cwd,
      env: buildEnv(task, execId),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached gives the execution its own process group, so termination can
      // reach descendants with kill(-pgid).
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    active = Math.max(0, active - 1);
    console.error(`[sentinel] spawn failed for ${task.id}: ${err.message}`);
    try { journal().update(execId, { state: 'terminated', exitCode: -1, error: `spawn error: ${err.message}` }); } catch { /* best effort */ }
    finishUnstarted(task, execId, claimToken, `spawn error: ${err.message}`);
    return { execId, taskId: task.id, claimToken, child: null, failedToStart: true };
  }

  const entry = {
    execId,
    taskId: task.id,
    claimToken,
    attempt: task.attempt,
    child,
    recovered: false,
    cancelled: false,
    finished: false,
    abandoned: false,
    termination: null,
    record: null,
    startedAt,
  };
  running.set(task.id, entry);

  if (child.pid) {
    try {
      const info = proc.inspect(child.pid);
      entry.record = journal().update(execId, {
        state: 'running',
        pid: child.pid,
        pgid: process.platform !== 'win32' ? child.pid : (info ? info.pgid : null),
        startToken: info ? info.startToken : null,
      });
    } catch (err) {
      console.error(`[sentinel] could not persist execution metadata for ${task.id}: ${err.message}`);
    }
  }

  // Tee live output to the sentinel terminal while keeping a bounded tail to
  // report back, so the orchestrator can read what the task actually produced.
  let output = '';
  const capture = (buf) => {
    output += buf.toString();
    if (output.length > MAX_RESULT) output = output.slice(-MAX_RESULT);
  };
  child.stdout.on('data', (b) => { capture(b); process.stdout.write(b); });
  child.stderr.on('data', (b) => { capture(b); process.stderr.write(b); });

  const finish = async (code, signal, error) => {
    if (entry.finished) return;
    entry.finished = true;
    active = Math.max(0, active - 1);
    running.delete(task.id);

    const exitCode = entryFinite(code) ? Math.trunc(code) : null;
    const outcome = entry.cancelled ? 'cancelled' : (exitCode === 0 ? 'done' : 'failed');
    const signalText = signal ? String(signal) : null;
    const finalError = error || (signalText ? `signal ${signalText}` : null);

    try {
      journal().update(execId, {
        state: 'terminated',
        exitCode,
        signal: signalText,
        error: finalError,
      });
    } catch { /* journal may already be gone */ }

    if (entry.abandoned) {
      cleanupJournal(execId);
      return;
    }

    if (entry.cancelled) {
      // Only report a cancellation after the process tree is confirmed gone.
      const confirmed = entry.termination
        ? await entry.termination
        : await terminateRecord(recordFor(entry));
      if (!confirmed.gone) {
        console.warn(`[sentinel] ${task.id}: termination could not be confirmed; not claiming cancellation.`);
        await safeReconcileRecord({ ...recordFor(entry), taskId: task.id, claimToken, execId }, 'unknown');
        return;
      }
    } else if (entry.record && entry.record.pgid && proc.groupExists(entry.record.pgid)) {
      // The direct child exited but the group is not empty. This is observable
      // and explicitly not treated as "everything finished".
      console.warn(`[sentinel] ${task.id}: child exited but descendants remain in pgid ${entry.record.pgid}.`);
    }

    const report = {
      status: outcome,
      exitCode,
      error: finalError,
      result: output.slice(-MAX_RESULT),
      claimToken,
      execId,
    };

    // Persist the bounded report BEFORE the first network attempt, so an
    // unreachable server (or a crash right now) cannot lose it. The periodic
    // retry loop replays it later without restarting the sentinel.
    markReportPending(execId, report);
    await deliverReport(execId);
  };

  function finishUnstarted(taskArg, execIdArg, claimTokenArg, message) {
    void (async () => {
      if (!claimTokenArg) { cleanupJournal(execIdArg); return; }
      const report = {
        status: 'failed',
        exitCode: -1,
        error: message,
        result: '',
        claimToken: claimTokenArg,
        execId: execIdArg,
      };
      const persisted = markReportPending(execIdArg, report);
      // If the journal record is somehow gone there is nothing durable to
      // retry, but still make one best-effort attempt with the known identity.
      const ref = persisted || { execId: execIdArg, taskId: taskArg.id, claimToken: claimTokenArg, report, state: 'terminated' };
      await deliverReport(ref);
    })().catch(() => {});
  }

  child.on('error', (err) => {
    void finish(-1, null, `spawn error: ${err.message}`).catch((e) => {
      console.error(`[sentinel] finish failed for ${task.id}: ${e.message}`);
    });
  });
  child.on('exit', (code, signal) => {
    void finish(code === null ? null : code, signal, null).catch((e) => {
      console.error(`[sentinel] finish failed for ${task.id}: ${e.message}`);
    });
  });

  return entry;
}

let tickInFlight = false;

async function tick() {
  // Never overlap two poll cycles: a slow heartbeat/claim must not pile up
  // concurrent ticks that double-claim work or interleave node state.
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await tickCycle();
  } finally {
    tickInFlight = false;
  }
}

function witnessList() {
  return [...running.entries()].map(([id, entry]) => {
    const record = recordFor(entry);
    return {
      id,
      claimToken: entry.claimToken,
      execId: entry.execId,
      pid: record && record.pid ? record.pid : (entry.child && entry.child.pid) || null,
      pgid: record && record.pgid ? record.pgid : null,
      startedAt: (record && record.startedAt) || entry.startedAt || null,
    };
  });
}

const scanCache = new Map();
const unknownReported = new Set();
let scanCacheSweep = 0;

function scanKeyFor(item) {
  return `${item.id}:${item.attempt || 0}:${item.execId || ''}`;
}

/**
 * Resolve attempts the server marked uncertain but which this sentinel does not
 * remember (journal lost/rotated, or the crash happened after claim and before
 * the journal write). On Linux the inherited CITADEL_* environment markers make
 * this determinable; elsewhere the state stays `unknown`.
 */
async function reconcileAssigned(items) {
  if (!Array.isArray(items)) return;
  if (++scanCacheSweep % 100 === 0) {
    const cutoff = Date.now() - 60000;
    for (const [key, ts] of scanCache) if (ts < cutoff) scanCache.delete(key);
  }
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.claimToken) continue;
    if (running.has(item.id)) continue;
    if (journal().all().some((r) => r.taskId === item.id)) continue;

    const scanKey = scanKeyFor(item);
    const last = scanCache.get(scanKey);
    if (last && Date.now() - last < 30000) continue;
    scanCache.set(scanKey, Date.now());

    const marker = item.execId
      ? proc.findByExecMarker(item.execId)
      : proc.scanEnvMarker('CITADEL_TASK_ID', item.id);

    const execId = item.execId || `reconciled-${item.id}`;
    if (marker.available && marker.pids.length > 0) {
      const hit = [...marker.pids].sort((a, b) => a.pid - b.pid)[0];
      const record = {
        execId,
        taskId: item.id,
        node: NODE,
        attempt: item.attempt,
        claimToken: item.claimToken,
        state: 'running',
        pid: hit.pid,
        pgid: hit.pgid,
        startToken: hit.startToken,
        startedAt: new Date().toISOString(),
      };
      try { journal().put(record); } catch (err) {
        console.error(`[sentinel] could not journal recovered execution ${item.id}: ${err.message}`);
      }
      adoptRecord(record);
      await safeReconcileRecord(record, 'alive');
    } else if (marker.available) {
      // No process carries this task id on this host: termination is confirmed.
      await safeReconcileRecord({
        taskId: item.id, claimToken: item.claimToken, execId, attempt: item.attempt,
      }, 'terminated', null, null);
    } else if (!unknownReported.has(scanKey)) {
      // The same unresolved attempt must not spam the log on every scan.
      unknownReported.add(scanKey);
      await safeReconcileRecord({
        taskId: item.id, claimToken: item.claimToken, execId, attempt: item.attempt,
      }, 'unknown');
    }
  }
}

async function reconcileOnStartup() {
  const records = journal().all();
  for (const record of records) {
    try {
      if (record.state === 'terminated') {
        // A stored report is delivered as-is (the result was never accepted);
        // a legacy entry without one is reconciled with its existing identity.
        if (record.reportPending && record.report) {
          await deliverReport(record);
          continue;
        }
        const settled = await safeReconcileRecord(record, 'terminated', record.exitCode, record.signal);
        if (settled.settled) cleanupJournal(record.execId);
        continue;
      }

      const outcome = proc.recoverExecution(record);
      if (outcome.alive) {
        const recovered = {
          ...record,
          state: 'running',
          pid: outcome.pid,
          pgid: outcome.pgid,
          startToken: outcome.startToken,
        };
        try { journal().put(recovered); } catch { /* best effort */ }
        adoptRecord(recovered);
        console.log(`[sentinel] recovered live execution ${record.taskId} (pid ${outcome.pid}, source ${outcome.source}).`);
        const settled = await safeReconcileRecord(recovered, 'alive');
        if (settled.settled && settled.discarded) {
          await abandonExecution({ id: recovered.taskId, execId: recovered.execId }, 'stale-at-startup');
        }
        continue;
      }

      if (outcome.reason === 'gone') {
        const settled = await safeReconcileRecord(record, 'terminated', record.exitCode, record.signal);
        if (settled.settled) cleanupJournal(record.execId);
      } else {
        console.warn(`[sentinel] execution ${record.execId} for ${record.taskId} is in an unknown state; automatic requeue stays blocked.`);
        await safeReconcileRecord(record, 'unknown');
      }
    } catch (err) {
      console.error(`[sentinel] startup reconciliation failed for ${record.taskId}: ${err.message}`);
    }
  }
  console.log(`[sentinel] reconciliation complete: ${running.size} execution(s) adopted.`);
}

async function tickCycle() {
  let beat = null;
  try {
    beat = await api('/api/nodes/heartbeat', {
      method: 'POST',
      body: {
        node: NODE,
        url: BASE,
        tags: TAGS,
        capacity: CAPACITY,
        active,
        load: os.loadavg()[0],
        // Witness list: the attempts this node is really executing, with the
        // claim token and the concrete execution identity. The server renews
        // exactly these and tells us to abandon stale executions.
        running: witnessList(),
      },
    });
  } catch (err) {
    console.error(`[sentinel] heartbeat failed: ${err.message}`);
    return;
  }

  // Attempts the server could not safely requeue because a process may exist.
  await reconcileAssigned(beat && beat.node && beat.node.reconcile);

  // Finished executions whose result the server has not accepted yet. Retrying
  // here (instead of only at startup) means an outage no longer needs a restart.
  await retryPendingReports();

  // Kill any task the operator cancelled since the last beat. SIGTERM first,
  // then bounded escalation to SIGKILL; the result report confirms termination.
  const cancel = (beat && beat.node && beat.node.cancel) || [];
  for (const id of cancel) {
    const entry = running.get(id);
    if (entry) void requestCancel(entry);
  }

  // Executions that no longer own the current attempt (requeued, finished or
  // claimed by a newer attempt). Stop them but never report a result.
  const abandon = (beat && beat.node && beat.node.abandon) || [];
  for (const item of abandon) {
    void abandonExecution(item, 'server-abandon').catch((err) => {
      console.error(`[sentinel] abandon failed: ${err.message}`);
    });
  }

  while (active < CAPACITY) {
    let task = null;
    try {
      const res = await api('/api/tasks/claim', {
        method: 'POST',
        body: { node: NODE, protocol: PROTOCOL },
      });
      task = res && res.task;
    } catch (err) {
      console.error(`[sentinel] claim failed: ${err.message}`);
      break;
    }
    if (!task) break;
    try {
      runTask(task);
    } catch (err) {
      console.error(`[sentinel] could not start ${task.id}: ${err.message}`);
    }
  }
}

if (require.main === module) {
  let lock = null;
  try {
    lock = acquireLock(NODE);
  } catch (err) {
    console.error(`[sentinel] ${err.message}`);
    process.exit(1);
  }

  console.log(`[sentinel] node=${NODE} capacity=${CAPACITY} base=${BASE} tags=[${TAGS.join(',')}] protocol=${PROTOCOL}`);

  // Reconcile local executions before polling, so a restarted sentinel can
  // never spawn a second copy of a task whose process it already owns.
  reconcileOnStartup()
    .catch((err) => console.error(`[sentinel] startup reconciliation error: ${err.message}`))
    .finally(() => {
      setInterval(tick, POLL_MS);
      tick();
    });

  const shutdown = (signal) => {
    console.log(`[sentinel] ${signal} received; releasing lock (executions stay journaled).`);
    try { if (lock) lock.release(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('exit', () => { try { if (lock) lock.release(); } catch { /* best effort */ } });
}

module.exports = {
  tick,
  tickCycle,
  api,
  runTask,
  buildEnv,
  deliverReport,
  retryPendingReports,
  markReportPending,
  reconcileOnStartup,
  reconcileAssigned,
  requestCancel,
  terminateRecord,
  abandonExecution,
  journal,
  _internals: { get active() { return active; }, running, KILL_GRACE_MS, KILL_CONFIRM_MS, PROTOCOL },
};
