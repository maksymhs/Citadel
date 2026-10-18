const { test, describe, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-sentinel-report-'));
process.env.CITADEL_URL = 'http://sentinel.invalid';
process.env.CITADEL_NODE = 'report-test-node';
process.env.CITADEL_SENTINEL_STATE_DIR = stateDir;
process.env.CITADEL_HTTP_TIMEOUT_MS = '2000';

const sentinel = require('../scripts/sentinel');

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function jsonResponse(data, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(data) };
}

function httpErrorResponse(status, error) {
  return { status, ok: false, text: async () => JSON.stringify({ error }) };
}

function waitFor(predicate, timeout = 5000, step = 25) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = () => {
      let value;
      try { value = predicate(); } catch (err) { reject(err); return; }
      if (value) { resolve(value); return; }
      if (Date.now() > deadline) { reject(new Error('condition not met before timeout')); return; }
      setTimeout(poll, step);
    };
    poll();
  });
}

function pendingRecord(execId, overrides = {}) {
  return {
    execId,
    taskId: `task-${execId}`,
    node: 'report-test-node',
    claimToken: `claim-${execId}`,
    state: 'terminated',
    exitCode: 0,
    report: { status: 'done', exitCode: 0, error: null, result: `${execId}-output` },
    reportPending: true,
    reportAttempts: 0,
    reportNextAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  try { sentinel.journal().clear(); } catch { /* best effort */ }
  sentinel._internals.running.clear();
});

after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('Durable result reporting', () => {
  test('a transient result+reconcile failure keeps the report and a later poll delivers it', async () => {
    let mode = 'fail';
    let calls = 0;
    const restore = stubFetch(async () => {
      calls += 1;
      if (mode === 'fail') throw new Error('network down');
      return jsonResponse({ task: {} });
    });

    try {
      const entry = sentinel.runTask({
        id: 'report-transient',
        cmd: process.execPath,
        args: ['-e', 'process.exit(2)'],
        claimToken: 'claim-transient',
      });

      const record = await waitFor(() => {
        const rec = sentinel.journal().get(entry.execId);
        return rec && rec.reportPending ? rec : null;
      });

      assert.equal(record.report.status, 'failed');
      assert.equal(record.report.exitCode, 2);
      assert.ok(record.reportPending, 'the report must be persisted before delivery');
      assert.equal(sentinel._internals.running.has('report-transient'), false);
      assert.match(record.reportNextAt, /^\d{4}-/, 'a retry must be scheduled');

      // A later poll: force the backoff deadline into the past instead of waiting.
      sentinel.journal().update(entry.execId, { reportNextAt: new Date(Date.now() - 1000).toISOString() });
      mode = 'ok';
      calls = 0;
      await sentinel.retryPendingReports();

      assert.equal(sentinel.journal().get(entry.execId), null, 'the journal is cleaned after acceptance');
      assert.equal(calls, 1, 'exactly one result submission once the server recovered');
    } finally {
      restore();
    }
  });

  test('a lost HTTP response is replayed and treated as a definitive already-completed result', async () => {
    sentinel.journal().put(pendingRecord('lost'));

    const seen = [];
    const restore = stubFetch(async (url, options) => {
      seen.push({ target: String(url), body: JSON.parse(options.body) });
      return httpErrorResponse(400, 'Task not found, already finished, or claimed by another worker.');
    });

    try {
      await sentinel.retryPendingReports();
      assert.equal(sentinel.journal().get('lost'), null, 'a definitive rejection cleans the journal');
      assert.equal(seen.length, 1, 'no reconcile is attempted after a definitive rejection');
      assert.ok(seen[0].target.endsWith('/result'));
    } finally {
      restore();
    }
  });

  test('a supervisor restart resumes delivery of a persisted report', async () => {
    sentinel.journal().put(pendingRecord('restart', {
      report: { status: 'done', exitCode: 0, error: null, result: 'persisted-output' },
      reportAttempts: 1,
    }));

    // Simulate a fresh process: drop the in-memory map and reload from disk.
    const journal = sentinel.journal();
    journal.records.clear();
    journal.loaded = false;

    const bodies = [];
    const restore = stubFetch(async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return jsonResponse({ task: {} });
    });

    try {
      await sentinel.reconcileOnStartup();
      assert.equal(sentinel.journal().get('restart'), null);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].result, 'persisted-output');
      assert.equal(bodies[0].claimToken, 'claim-restart');
    } finally {
      restore();
    }
  });

  test('an unreachable server keeps the report and never floods requests', async () => {
    sentinel.journal().put(pendingRecord('offline'));

    let calls = 0;
    const restore = stubFetch(async () => {
      calls += 1;
      throw new Error('ECONNREFUSED');
    });

    try {
      await sentinel.retryPendingReports();
      const afterFirst = calls;
      assert.ok(afterFirst >= 1);

      const record = sentinel.journal().get('offline');
      assert.ok(record, 'the journal must be preserved while the server is down');
      assert.equal(record.reportPending, true);
      assert.ok(Date.parse(record.reportNextAt) > Date.now(), 'backoff must defer the next attempt');

      await sentinel.retryPendingReports();
      assert.equal(calls, afterFirst, 'an immediate poll must not resend while backing off');
    } finally {
      restore();
    }
  });

  test('a stale attempt is discarded through reconcile without a new execution identity', async () => {
    sentinel.journal().put(pendingRecord('stale', { claimToken: 'old-claim' }));

    const seen = [];
    const restore = stubFetch(async (url, options) => {
      const target = String(url);
      const body = JSON.parse(options.body);
      seen.push({ target, body });
      if (target.endsWith('/result')) {
        return httpErrorResponse(409, 'Task attempt lease is invalid and its execution state is uncertain; reconciliation is required.');
      }
      return jsonResponse({ task: {}, reconciliation: { state: 'terminated', discarded: true } });
    });

    try {
      await sentinel.retryPendingReports();
      assert.equal(sentinel.journal().get('stale'), null);

      const reconcile = seen.find((s) => s.target.endsWith('/reconcile'));
      assert.ok(reconcile, 'the reconcile protocol must be used when the lease expired');
      assert.equal(reconcile.body.claimToken, 'old-claim', 'the stored identity is reused, never invented');
      assert.equal(reconcile.body.execId, 'stale');
      assert.equal(reconcile.body.state, 'terminated');
    } finally {
      restore();
    }
  });

  test('a legacy terminated entry without a saved report is reconciled safely', async () => {
    sentinel.journal().put({
      execId: 'legacy-exec',
      taskId: 'legacy-task',
      claimToken: 'legacy-claim',
      state: 'terminated',
      exitCode: null,
    });

    const seen = [];
    const restore = stubFetch(async (url, options) => {
      seen.push({ target: String(url), body: JSON.parse(options.body) });
      return jsonResponse({ task: {}, reconciliation: { state: 'terminated', discarded: false } });
    });

    try {
      await sentinel.reconcileOnStartup();
      assert.equal(sentinel.journal().get('legacy-exec'), null);
      assert.equal(seen.length, 1);
      assert.ok(seen[0].target.endsWith('/reconcile'));
      assert.equal(seen[0].body.state, 'terminated');
    } finally {
      restore();
    }
  });
});
