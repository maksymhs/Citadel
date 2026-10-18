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
 *   CITADEL_TOKEN=<session id> \
 *   CITADEL_NODE=vps-2 \
 *   CITADEL_CAPACITY=2 \
 *   node scripts/sentinel.js
 *
 * A task's `cmd` is executed directly (no shell); for shell one-liners use
 * cmd="bash" and args=["-lc", "..."].
 */
const os = require('node:os');
const { spawn } = require('node:child_process');

const BASE = (process.env.CITADEL_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = process.env.CITADEL_TOKEN || '';
const NODE = process.env.CITADEL_NODE || os.hostname();
const CAPACITY = Math.max(1, parseInt(process.env.CITADEL_CAPACITY, 10) || 1);
const POLL_MS = Math.max(1000, parseInt(process.env.CITADEL_POLL_MS, 10) || 4000);
const TAGS = (process.env.CITADEL_TAGS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

let active = 0;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Citadel-Sentinel',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  console.log(`[sentinel] running ${task.id}: ${task.cmd} ${args.join(' ')} (cwd=${cwd})`);

  const child = spawn(task.cmd, args, { cwd, env: process.env, stdio: 'inherit' });

  const finish = async (code, error) => {
    active = Math.max(0, active - 1);
    try {
      await api(`/api/tasks/${task.id}/result`, {
        method: 'POST',
        body: {
          status: code === 0 ? 'done' : 'failed',
          exitCode: code,
          error: error || null,
        },
      });
      console.log(`[sentinel] ${task.id} -> ${code === 0 ? 'done' : `failed (${code})`}`);
    } catch (err) {
      console.error(`[sentinel] could not report ${task.id}: ${err.message}`);
    }
  };

  child.on('error', (err) => finish(-1, `spawn error: ${err.message}`));
  child.on('exit', (code, signal) => finish(code === null ? -1 : code, signal ? `signal ${signal}` : null));
}

async function tick() {
  try {
    await api('/api/nodes/heartbeat', {
      method: 'POST',
      body: {
        node: NODE,
        url: BASE,
        tags: TAGS,
        capacity: CAPACITY,
        active,
        load: os.loadavg()[0],
      },
    });
  } catch (err) {
    console.error(`[sentinel] heartbeat failed: ${err.message}`);
    return;
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

console.log(`[sentinel] node=${NODE} capacity=${CAPACITY} base=${BASE} tags=[${TAGS.join(',')}]`);
setInterval(tick, POLL_MS);
tick();
