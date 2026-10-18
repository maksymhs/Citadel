const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the sentinel at a fake base URL and an isolated journal before loading
// it. The module exports its tick function and does not start the loop.
process.env.CITADEL_URL = 'http://sentinel.test';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-sentinel-test-'));
process.env.CITADEL_SENTINEL_STATE_DIR = stateDir;
const sentinel = require('../scripts/sentinel.js');

after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

describe('Sentinel polling loop', () => {
  test('a slow heartbeat never overlaps with the next tick (no double claims)', async () => {
    let heartbeatCalls = 0;
    let claimCalls = 0;
    let releaseHeartbeat;
    const gate = new Promise((resolve) => { releaseHeartbeat = resolve; });

    const restore = stubFetch(async (url) => {
      const target = String(url);
      if (target.endsWith('/api/nodes/heartbeat')) {
        heartbeatCalls += 1;
        await gate;
        return { status: 204, ok: true };
      }
      if (target.endsWith('/api/tasks/claim')) {
        claimCalls += 1;
        return { status: 204, ok: true };
      }
      throw new Error(`unexpected request: ${target}`);
    });

    try {
      const first = sentinel.tick();
      // The second call happens while the first is blocked on the heartbeat.
      const second = sentinel.tick();
      releaseHeartbeat();
      await Promise.all([first, second]);

      assert.equal(heartbeatCalls, 1, 'heartbeat must run once for both overlapping ticks');
      assert.equal(claimCalls, 1, 'the skipped tick must not attempt a claim');
    } finally {
      restore();
    }
  });

  test('a tick that fails inside the heartbeat cleans up and can run again', async () => {
    let heartbeatCalls = 0;
    const restore = stubFetch(async (url) => {
      const target = String(url);
      if (target.endsWith('/api/nodes/heartbeat')) {
        heartbeatCalls += 1;
        throw new Error('network down');
      }
      return { status: 204, ok: true };
    });

    try {
      await sentinel.tick();
      await sentinel.tick();
      assert.equal(heartbeatCalls, 2, 'the in-flight guard must reset after a failure');
    } finally {
      restore();
    }
  });

  test('the heartbeat reports the witness list with each attempt claim token', async () => {
    let beatBody = null;
    const restore = stubFetch(async (url, options) => {
      const target = String(url);
      if (target.endsWith('/api/nodes/heartbeat')) {
        beatBody = JSON.parse(options.body);
        return { status: 200, ok: true, text: async () => JSON.stringify({ node: { cancel: [] } }) };
      }
      if (target.endsWith('/api/tasks/claim')) {
        return { status: 204, ok: true };
      }
      if (target.includes('/result')) {
        return { status: 200, ok: true, text: async () => JSON.stringify({ task: {} }) };
      }
      throw new Error(`unexpected request: ${target}`);
    });

    const entry = sentinel.runTask({
      id: 'witness-task-1',
      cmd: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      claimToken: 'claim-token-witness',
    });

    try {
      await sentinel.tickCycle();
      assert.ok(beatBody, 'the heartbeat must have been sent');
      assert.equal(beatBody.running.length, 1);
      const witness = beatBody.running[0];
      assert.equal(witness.id, 'witness-task-1');
      assert.equal(witness.claimToken, 'claim-token-witness');
      assert.equal(typeof witness.execId, 'string');
      assert.ok(witness.execId.length > 0, 'the execution id must be reported');
      assert.equal(typeof witness.pid, 'number');
      assert.ok(witness.pid > 0, 'the real child pid must be reported');
    } finally {
      const exited = new Promise((resolve) => entry.child.once('exit', resolve));
      entry.child.kill('SIGKILL');
      await exited;
      // Let the async result report (finish handler) drain before the stub goes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      restore();
    }
  });
});
