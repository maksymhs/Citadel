const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Sentinel configuration must be in place before the module captures it.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-sentinel-process-'));
process.env.CITADEL_URL = 'http://sentinel.invalid';
process.env.CITADEL_NODE = 'process-test-node';
process.env.CITADEL_SENTINEL_STATE_DIR = stateDir;
process.env.CITADEL_KILL_GRACE_MS = '300';
process.env.CITADEL_KILL_CONFIRM_MS = '2000';
process.env.CITADEL_HTTP_TIMEOUT_MS = '2000';

const proc = require('../scripts/sentinelProcess');
const { Journal, acquireLock } = require('../scripts/sentinelJournal');
const sentinel = require('../scripts/sentinel');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const children = new Set();

function spawnNode(source, { env } = {}) {
  const child = spawn(process.execPath, ['-e', source], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(env || {}) },
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function waitExit(child, timeout = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, timeout);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function killHard(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

function recordFor(child, execId = `exec-${child.pid}`) {
  const info = proc.inspect(child.pid);
  assert.ok(info, 'the test child must be visible to the process inspector');
  return {
    execId,
    taskId: `task-${execId}`,
    node: 'process-test-node',
    attempt: 1,
    claimToken: 'claim-token',
    pid: child.pid,
    pgid: info.pgid,
    startToken: info.startToken,
    startedAt: new Date().toISOString(),
    state: 'running',
  };
}

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function jsonResponse(data) {
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify(data),
  };
}

after(() => {
  for (const child of children) killHard(child);
  try { sentinel._internals.running.clear(); } catch { /* best effort */ }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const child of children) killHard(child);
  try { sentinel.journal().clear(); } catch { /* best effort */ }
  sentinel._internals.running.clear();
});

describe('Process identity and termination', () => {
  test('a record without any execution identity is never reported as terminated', async () => {
    const result = await sentinel.terminateRecord({ execId: 'no-identity', pid: null, pgid: null });
    assert.equal(result.gone, false);
    assert.equal(result.reason, 'no-execution-identity');
  });

  test('a detached child is its own group leader and is verifiable', async () => {
    const child = spawnNode('setTimeout(() => {}, 30000)');
    await sleep(100);
    const info = proc.inspect(child.pid);
    assert.ok(info);
    assert.equal(info.pgid, child.pid, 'detached spawn makes the child a group leader');
    assert.equal(proc.verify({ pid: child.pid, pgid: child.pid, startToken: info.startToken }).alive, true);
    killHard(child);
    await waitExit(child);
  });

  test('a reused PID (different start token) is never signalled', async () => {
    const child = spawnNode('setTimeout(() => {}, 30000)');
    await sleep(100);
    const record = recordFor(child);
    const forged = { ...record, startToken: 'bogus:not-this-process' };

    const check = proc.verify(forged);
    assert.equal(check.alive, false);
    assert.equal(check.reason, 'pid-reused');

    const result = proc.signalTree(forged, 'SIGKILL');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'pid-reused');
    await sleep(100);
    assert.equal(proc.isAlive(child.pid), true, 'the unrelated live process must be untouched');

    killHard(child);
    await waitExit(child);
  });

  test('terminating an execution also stops its descendants in the group', async () => {
    const source = `
      const { spawn } = require('node:child_process');
      const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      process.stdout.write(String(gc.pid));
      setTimeout(() => {}, 30000);
    `;
    const child = spawnNode(source);
    const grandPid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grandchild pid not reported')), 5000);
      child.stdout.on('data', (buf) => {
        const text = String(buf).trim();
        if (/^\d+$/.test(text)) { clearTimeout(timer); resolve(Number(text)); }
      });
    });
    await sleep(100);
    assert.equal(proc.isAlive(grandPid), true);

    const result = await sentinel.terminateRecord(recordFor(child));
    assert.equal(result.gone, true);
    assert.equal(proc.isAlive(child.pid), false);
    assert.equal(proc.isAlive(grandPid), false);
    await waitExit(child);
  });

  test('a process that ignores SIGTERM is escalated to SIGKILL', async () => {
    const child = spawnNode('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
    await sleep(100);
    const started = Date.now();
    const result = await sentinel.terminateRecord(recordFor(child));
    const elapsed = Date.now() - started;

    assert.equal(result.gone, true);
    assert.equal(proc.isAlive(child.pid), false);
    assert.ok(elapsed >= 250, `escalation must wait for the grace period (waited ${elapsed}ms)`);
    await waitExit(child);
  });

  test('a dead execution is reported gone, and a starting record without a pid is unknown off Linux', async () => {
    const child = spawnNode('process.exit(0)');
    await waitExit(child);
    const dead = {
      execId: 'dead-exec',
      taskId: 'task-dead',
      claimToken: 'tok',
      pid: child.pid,
      pgid: child.pid,
      startToken: 'dead-start-token',
      state: 'running',
    };
    const recovered = proc.recoverExecution(dead);
    assert.equal(recovered.alive, false);
    assert.equal(recovered.reason, 'gone');

    const starting = { execId: 'never-persisted-pid', taskId: 't-start', state: 'starting', pid: null, pgid: null };
    const uncertain = proc.recoverExecution(starting);
    if (process.platform === 'linux') {
      // The environment marker scan is authoritative on Linux.
      assert.equal(uncertain.reason, 'gone');
    } else {
      assert.equal(uncertain.reason, 'unknown');
    }
  });
});

describe('Execution journal and lock', () => {
  test('journal records survive a reload and update/remove atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-journal-'));
    try {
      const journal = new Journal({ node: 'reload-node', dir });
      journal.put({ execId: 'e-1', taskId: 't-1', state: 'starting', pid: null, claimToken: 'secret-token' });

      const reloaded = new Journal({ node: 'reload-node', dir });
      reloaded.load();
      const records = reloaded.all();
      assert.equal(records.length, 1);
      assert.equal(records[0].taskId, 't-1');
      assert.equal(records[0].claimToken, 'secret-token');

      reloaded.update('e-1', { state: 'running', pid: 1234 });
      const again = new Journal({ node: 'reload-node', dir });
      again.load();
      assert.equal(again.get('e-1').state, 'running');
      assert.equal(again.get('e-1').pid, 1234);

      again.remove('e-1');
      const empty = new Journal({ node: 'reload-node', dir });
      empty.load();
      assert.deepEqual(empty.all(), []);

      if (process.platform !== 'win32') {
        const mode = fs.statSync(path.join(dir, 'reload-node.json')).mode & 0o777;
        assert.equal(mode, 0o600, 'the journal must not be world-readable');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a second sentinel cannot acquire the same node lock; a released lock is reusable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-lock-'));
    try {
      const lock = acquireLock('lock-node', { dir });
      assert.throws(() => acquireLock('lock-node', { dir }), /already holds/i);
      lock.release();
      const again = acquireLock('lock-node', { dir });
      again.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a fresh Journal instance loads before mutating, so records are never overwritten', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-journal-autoload-'));
    try {
      new Journal({ node: 'autoload-node', dir }).put({ execId: 'a', taskId: 't-a', state: 'running' });
      // No explicit load(): put() must merge with the on-disk state.
      new Journal({ node: 'autoload-node', dir }).put({ execId: 'b', taskId: 't-b', state: 'running' });

      const reloaded = new Journal({ node: 'autoload-node', dir });
      reloaded.load();
      assert.deepEqual(reloaded.all().map((r) => r.execId).sort(), ['a', 'b']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt journal starts empty and preserves the damaged file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-journal-corrupt-'));
    try {
      const journal = new Journal({ node: 'corrupt-node', dir });
      fs.writeFileSync(journal.file, '{not json');
      assert.deepEqual(journal.load(), []);
      const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
      assert.equal(backups.length, 1, 'the damaged journal must be kept for inspection');
      assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{not json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a lock that is not readable yet is not stolen while fresh', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-lock-races-'));
    try {
      const lockPath = path.join(dir, 'midwrite-node.lock');
      fs.writeFileSync(lockPath, '{');
      assert.throws(() => acquireLock('midwrite-node', { dir }), /not readable yet/i);

      const old = (Date.now() - 10000) / 1000;
      fs.utimesSync(lockPath, old, old);
      const lock = acquireLock('midwrite-node', { dir });
      lock.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stale lock left by a dead process is reclaimed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-stale-lock-'));
    try {
      const lockPath = path.join(dir, 'stale-node.lock');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
      const lock = acquireLock('stale-node', { dir });
      assert.ok(fs.existsSync(lockPath));
      lock.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Sentinel startup reconciliation (real processes)', () => {
  test('a live journaled execution is re-adopted and re-authorized, then cancelled for real', async () => {
    const child = spawnNode('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
    await sleep(100);
    const record = recordFor(child, 'restart-live');
    sentinel.journal().put(record);

    const calls = [];
    const restore = stubFetch(async (url, options) => {
      const target = String(url);
      const body = JSON.parse(options.body);
      calls.push({ target, body });
      if (target.endsWith('/reconcile')) return jsonResponse({ reconciliation: { discarded: false } });
      throw new Error(`unexpected request: ${target}`);
    });

    try {
      await sentinel.reconcileOnStartup();
      const entry = sentinel._internals.running.get(record.taskId);
      assert.ok(entry, 'the live execution must be adopted before polling');
      assert.equal(entry.recovered, true);
      assert.equal(sentinel._internals.active, 1);
      const aliveCall = calls.find((c) => c.body.state === 'alive');
      assert.ok(aliveCall, 'the server must be told the execution is alive');
      assert.equal(aliveCall.body.execId, record.execId);
      assert.equal(aliveCall.body.claimToken, record.claimToken);

      await sentinel.requestCancel(entry);
      assert.equal(proc.isAlive(child.pid), false, 'cancellation must terminate the real process');
      const terminated = calls.find((c) => c.body.state === 'terminated');
      assert.ok(terminated, 'the server must receive the confirmed termination');
      assert.equal(sentinel.journal().get(record.execId), null, 'the journal is cleaned after confirmation');
      await waitExit(child);
    } finally {
      restore();
    }
  });

  test('a journaled execution that is already gone is reported terminated', async () => {
    const child = spawnNode('process.exit(0)');
    await waitExit(child);
    const record = {
      execId: 'restart-dead',
      taskId: 'task-restart-dead',
      node: 'process-test-node',
      attempt: 1,
      claimToken: 'claim-token',
      pid: child.pid,
      pgid: child.pid,
      startToken: 'dead-start-token',
      startedAt: new Date().toISOString(),
      state: 'running',
    };
    sentinel.journal().put(record);

    const calls = [];
    const restore = stubFetch(async (url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ reconciliation: { discarded: false } });
    });
    try {
      await sentinel.reconcileOnStartup();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].state, 'terminated');
      assert.equal(sentinel.journal().get(record.execId), null);
    } finally {
      restore();
    }
  });

  test('an unverifiable execution is reported unknown and never relaunched', async () => {
    sentinel.journal().put({
      execId: 'restart-unknown', taskId: 'task-unknown', claimToken: 'tok', state: 'starting', pid: null,
    });
    const calls = [];
    const restore = stubFetch(async (url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ reconciliation: { discarded: false } });
    });
    try {
      await sentinel.reconcileOnStartup();
      if (process.platform === 'linux') {
        // Linux scans the environment marker and can prove absence.
        assert.equal(calls[0].state, 'terminated');
      } else {
        assert.equal(calls[0].state, 'unknown');
        assert.ok(sentinel.journal().get('restart-unknown'), 'the evidence is kept for a later retry');
      }
    } finally {
      restore();
    }
  });

  test('reconcileAssigned adopts a live process found by marker and requeues when none exists', async () => {
    const child = spawnNode('setTimeout(() => {}, 30000)');
    await sleep(100);
    const info = proc.inspect(child.pid);
    const originalScan = proc.scanEnvMarker;
    const calls = [];
    const restore = stubFetch(async (url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ reconciliation: { discarded: false } });
    });

    try {
      proc.scanEnvMarker = () => ({
        available: true,
        pids: [{ pid: child.pid, pgid: info.pgid, startToken: info.startToken, state: info.state }],
      });
      await sentinel.reconcileAssigned([{
        id: 'assigned-live', claimToken: 'tok-live', execId: 'exec-assigned', attempt: 1,
      }]);
      assert.ok(sentinel._internals.running.has('assigned-live'));
      assert.equal(calls[0].state, 'alive');

      calls.length = 0;
      proc.scanEnvMarker = () => ({ available: true, pids: [] });
      await sentinel.reconcileAssigned([{
        id: 'assigned-gone', claimToken: 'tok-gone', execId: 'exec-gone', attempt: 1,
      }]);
      assert.equal(calls[0].state, 'terminated');

      calls.length = 0;
      proc.scanEnvMarker = () => ({ available: false, pids: [] });
      await sentinel.reconcileAssigned([{
        id: 'assigned-unknown', claimToken: 'tok-unknown', execId: 'exec-unknown', attempt: 1,
      }]);
      assert.equal(calls[0].state, 'unknown');

      // An unresolved attempt is not re-reported on every poll.
      calls.length = 0;
      await sentinel.reconcileAssigned([{
        id: 'assigned-unknown', claimToken: 'tok-unknown', execId: 'exec-unknown', attempt: 1,
      }]);
      assert.equal(calls.length, 0);
    } finally {
      proc.scanEnvMarker = originalScan;
      restore();
      killHard(child);
      await waitExit(child);
    }
  });
});
