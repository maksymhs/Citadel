const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Point the sentinel at a fake base URL before loading it. The module exports
// its tick function and does not start the polling loop when required.
process.env.CITADEL_URL = 'http://sentinel.test';
const sentinel = require('../scripts/sentinel.js');

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
});
