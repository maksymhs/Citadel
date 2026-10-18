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
 *   CITADEL_NODE_TOKEN=<shared node secret> \
 *   CITADEL_NODE=vps-2 \
 *   CITADEL_CAPACITY=2 \
 *   node scripts/sentinel.js
 *
 * Prefer CITADEL_NODE_TOKEN (scoped to claim/result/heartbeat) when the server
 * has CITADEL_NODE_TOKEN configured; CITADEL_TOKEN (a full session id) is still
 * supported as a fallback but grants panel-wide privileges.
 *
 * A task's `cmd` is executed directly (no shell); for shell one-liners use
 * cmd="bash" and args=["-lc", "..."].
 */
const os = require('node:os');
const { spawn } = require('node:child_process');

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

let active = 0;
const running = new Map(); // task id -> { child, claimToken, cancelled, killTimer }

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
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function runTask(task) {
  active += 1;
  const cwd = task.projectPath || process.cwd();
  const args = Array.isArray(task.args) ? task.args : [];

  // The child learns which task it is, so it can name worktrees/branches
  // idempotently (agent/<task id>) and survive a lease retry safely.
  const env = {
    ...process.env,
    CITADEL_TASK_ID: task.id,
    CITADEL_TASK_NODE: NODE,
    CITADEL_TASK_PROJECT: task.projectPath || '',
  };
  console.log(`[sentinel] running ${task.id}: ${task.cmd} ${args.join(' ')} (cwd=${cwd})`);

  const child = spawn(task.cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { child, claimToken: task.claimToken || null, cancelled: false, killTimer: null };
  running.set(task.id, entry);

  // Tee live output to the sentinel terminal while keeping a bounded tail to
  // report back, so the orchestrator can read what the task actually produced.
  let output = '';
  const capture = (buf) => {
    output += buf.toString();
    if (output.length > MAX_RESULT) output = output.slice(-MAX_RESULT);
  };
  child.stdout.on('data', (b) => { capture(b); process.stdout.write(b); });
  child.stderr.on('data', (b) => { capture(b); process.stderr.write(b); });

  let finished = false;
  const finish = async (code, error) => {
    if (finished) return;
    finished = true;
    active = Math.max(0, active - 1);
    running.delete(task.id);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    const outcome = entry.cancelled ? 'cancelled' : (code === 0 ? 'done' : 'failed');
    try {
      await api(`/api/tasks/${task.id}/result`, {
        method: 'POST',
        body: {
          status: outcome,
          exitCode: code,
          error: error || null,
          result: output.slice(-MAX_RESULT),
          // Proves this worker still holds the current claim: a stale worker
          // whose lease expired cannot overwrite the newer attempt's result.
          claimToken: entry.claimToken,
        },
      });
      console.log(`[sentinel] ${task.id} -> ${outcome}${outcome === 'failed' ? ` (${code})` : ''}`);
    } catch (err) {
      if (!/already finished/i.test(err.message)) {
        console.error(`[sentinel] could not report ${task.id}: ${err.message}`);
      }
    }
  };

  child.on('error', (err) => finish(-1, `spawn error: ${err.message}`));
  child.on('exit', (code, signal) => finish(code === null ? -1 : code, signal ? `signal ${signal}` : null));
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
        running: [...running.keys()],
      },
    });
  } catch (err) {
    console.error(`[sentinel] heartbeat failed: ${err.message}`);
    return;
  }

  // Kill any task the operator cancelled since the last beat. SIGTERM first,
  // then SIGKILL if the process ignores it; the result report confirms
  // termination to the server (status "cancelled").
  const cancel = (beat && beat.node && beat.node.cancel) || [];
  for (const id of cancel) {
    const entry = running.get(id);
    if (!entry || !entry.child || entry.cancelled) continue;
    entry.cancelled = true;
    console.log(`[sentinel] cancelling ${id}`);
    entry.child.kill('SIGTERM');
    entry.killTimer = setTimeout(() => {
      if (running.has(id)) {
        console.warn(`[sentinel] ${id} ignored SIGTERM; sending SIGKILL.`);
        try { entry.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 10000);
    if (typeof entry.killTimer.unref === 'function') entry.killTimer.unref();
  }

  while (active < CAPACITY) {
    let task = null;
    try {
      const res = await api('/api/tasks/claim', { method: 'POST', body: { node: NODE } });
      task = res && res.task;
    } catch (err) {
      console.error(`[sentinel] claim failed: ${err.message}`);
      break;
    }
    if (!task) break;
    runTask(task);
  }
}

if (require.main === module) {
  console.log(`[sentinel] node=${NODE} capacity=${CAPACITY} base=${BASE} tags=[${TAGS.join(',')}]`);
  setInterval(tick, POLL_MS);
  tick();
}

module.exports = { tick, tickCycle, api, runTask };
