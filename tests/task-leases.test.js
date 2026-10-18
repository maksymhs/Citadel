const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const taskService = require('../server/services/taskService');
const { initDatabase, getDatabase, closeDatabase } = require('../server/database/db');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function leaseOf(id) {
  const row = getDatabase().prepare('SELECT lease_until FROM tasks WHERE id = ?').get(id);
  return row ? row.lease_until : null;
}

function forceLease(id, iso) {
  getDatabase().prepare('UPDATE tasks SET lease_until = ? WHERE id = ?').run(iso, id);
}

const PAST = () => new Date(Date.now() - 1000).toISOString();
// A lease that is valid now but far enough in the future that a renewal
// (now + RELEASE_MS) is unambiguously later, whatever the wall clock does.
const FROZEN_FUTURE = () => new Date(Date.now() + 60 * 1000).toISOString();

describe('Heartbeat lease reconciliation (witness list)', () => {
  const testDb = path.resolve(__dirname, '../data/test-task-leases.db');

  before(() => {
    cleanDb(testDb);
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
  });

  test('only attempts reported in the witness list keep being renewed', () => {
    const reported = taskService.enqueue({ cmd: 'x', node: 'wl-1' });
    const orphan = taskService.enqueue({ cmd: 'x', node: 'wl-1' });
    const cReported = taskService.claimTask('wl-1');
    const cOrphan = taskService.claimTask('wl-1');
    assert.equal(cReported.id, reported.id);
    assert.equal(cOrphan.id, orphan.id);

    const frozen = FROZEN_FUTURE();
    forceLease(reported.id, frozen);
    forceLease(orphan.id, frozen);

    taskService.heartbeat({
      node: 'wl-1',
      running: [{ id: reported.id, claimToken: cReported.claimToken }],
    });

    assert.notEqual(leaseOf(reported.id), frozen, 'the reported attempt must be renewed');
    assert.ok(leaseOf(reported.id) > frozen);
    assert.equal(leaseOf(orphan.id), frozen, 'an unreported attempt must not be renewed');

    // Stopping renewal is what releases the task: once the unreported lease
    // expires, another attempt can pick it up. No eager requeue happened.
    assert.equal(taskService.getTask(orphan.id).status, 'running');
    forceLease(orphan.id, PAST());
    const reclaimed = taskService.claimTask('wl-1');
    assert.equal(reclaimed.id, orphan.id);
    assert.equal(reclaimed.attempt, 2);
  });

  test('a stale claim token cannot renew the lease of a newer attempt', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'wl-stale' });
    const first = taskService.claimTask('wl-stale');
    forceLease(task.id, PAST());
    const second = taskService.claimTask('wl-stale');
    assert.equal(second.attempt, 2);

    const frozen = FROZEN_FUTURE();
    forceLease(task.id, frozen);

    // An outdated beat from attempt 1 arrives after attempt 2 was claimed.
    taskService.heartbeat({
      node: 'wl-stale',
      running: [{ id: task.id, claimToken: first.claimToken }],
    });
    assert.equal(leaseOf(task.id), frozen, 'the stale token must not extend the new lease');
    assert.equal(taskService.getTask(task.id).status, 'running');
    assert.equal(taskService.getTask(task.id).attempt, 2);

    // The current attempt still renews normally.
    taskService.heartbeat({
      node: 'wl-stale',
      running: [{ id: task.id, claimToken: second.claimToken }],
    });
    assert.ok(leaseOf(task.id) > frozen);
  });

  test('plain id entries keep renewing for compatibility', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'wl-legacy-ids' });
    taskService.claimTask('wl-legacy-ids');
    const frozen = FROZEN_FUTURE();
    forceLease(task.id, frozen);

    taskService.heartbeat({ node: 'wl-legacy-ids', running: [task.id] });
    assert.ok(leaseOf(task.id) > frozen);
  });

  test('plain id entries renew but warn once about the weaker guarantee', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'wl-unbound' });
    taskService.claimTask('wl-unbound');
    const frozen = FROZEN_FUTURE();
    forceLease(task.id, frozen);

    const body = { node: 'wl-unbound', running: [task.id] };
    taskService.heartbeat(body);
    assert.ok(leaseOf(task.id) > frozen, 'plain id entries still renew for compatibility');
    taskService.heartbeat(body);

    const warning = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE action = 'node_heartbeat_unbound' AND node = 'wl-unbound'
    `).get();
    assert.equal(warning.count, 1, 'unbound entries are warned once per node, not per beat');
  });

  test('entries carrying a claim token do not trigger the unbound warning', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'wl-bound-warn' });
    const claim = taskService.claimTask('wl-bound-warn');
    taskService.heartbeat({
      node: 'wl-bound-warn',
      running: [{ id: task.id, claimToken: claim.claimToken }],
    });

    for (const action of ['node_heartbeat_unbound', 'node_heartbeat_legacy']) {
      const warning = getDatabase().prepare(`
        SELECT COUNT(*) AS count FROM events
        WHERE action = ? AND node = 'wl-bound-warn'
      `).get(action);
      assert.equal(warning.count, 0);
    }
  });

  test('an unbound heartbeat cannot resurrect an attempt whose lease already expired', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'wl-unbound-expired' });
    taskService.claimTask('wl-unbound-expired');
    forceLease(task.id, PAST());

    // Reclaim runs before renewal in the same transaction: a stale id-only beat
    // finds the attempt already requeued and cannot extend it.
    taskService.heartbeat({ node: 'wl-unbound-expired', running: [task.id] });

    const after = taskService.getTask(task.id);
    assert.equal(after.status, 'queued');
    assert.equal(leaseOf(task.id), null);
    assert.equal(after.attempt, 1, 'the attempt was reclaimed, not silently kept alive');

    const next = taskService.claimTask('wl-unbound-expired');
    assert.equal(next.id, task.id);
    assert.equal(next.attempt, 2);
  });

  test('a legacy heartbeat without a witness list renews node-wide and is flagged once', () => {
    const t1 = taskService.enqueue({ cmd: 'x', node: 'wl-nolist' });
    const t2 = taskService.enqueue({ cmd: 'x', node: 'wl-nolist' });
    taskService.claimTask('wl-nolist');
    taskService.claimTask('wl-nolist');
    const frozen = FROZEN_FUTURE();
    forceLease(t1.id, frozen);
    forceLease(t2.id, frozen);

    taskService.heartbeat({ node: 'wl-nolist' });
    assert.ok(leaseOf(t1.id) > frozen);
    assert.ok(leaseOf(t2.id) > frozen);

    const warning = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE action = 'node_heartbeat_legacy' AND node = 'wl-nolist'
    `).get();
    assert.equal(warning.count, 1, 'a legacy client is warned once per node, not per beat');
  });

  test('duplicate heartbeats with the witness list are harmless', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'wl-dupe' });
    const claim = taskService.claimTask('wl-dupe');
    const body = { node: 'wl-dupe', running: [{ id: task.id, claimToken: claim.claimToken }] };

    taskService.heartbeat(body);
    taskService.heartbeat(body);

    const after = taskService.getTask(task.id);
    assert.equal(after.status, 'running');
    assert.equal(after.attempt, 1);
    const done = taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken });
    assert.equal(done.status, 'done');
  });

  test('a delayed heartbeat cannot resurrect a finished task', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'wl-done' });
    const claim = taskService.claimTask('wl-done');
    taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken });
    const finishedAt = taskService.getTask(task.id).finishedAt;

    taskService.heartbeat({
      node: 'wl-done',
      running: [{ id: task.id, claimToken: claim.claimToken }],
    });

    const after = taskService.getTask(task.id);
    assert.equal(after.status, 'done');
    assert.equal(after.claimToken, undefined);
    assert.equal(after.finishedAt, finishedAt);
  });

  test('a cancelling task is never renewed by the witness list', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'wl-cancel' });
    const claim = taskService.claimTask('wl-cancel');
    taskService.cancelTask(task.id);
    const frozen = FROZEN_FUTURE();
    forceLease(task.id, frozen);

    taskService.heartbeat({
      node: 'wl-cancel',
      running: [{ id: task.id, claimToken: claim.claimToken }],
    });
    assert.equal(leaseOf(task.id), frozen, 'an unconfirmed kill must finalise via expiry');
    assert.equal(taskService.getTask(task.id).status, 'cancelling');
  });
});

describe('Task completion authority after lease expiry', () => {
  const testDb = path.resolve(__dirname, '../data/test-task-expiry.db');

  before(() => {
    cleanDb(testDb);
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
  });

  test('completion before expiry succeeds', () => {
    const task = taskService.enqueue({ cmd: 'x' });
    const claim = taskService.claimTask('ex-ok');
    const done = taskService.completeTask(task.id, {
      status: 'done',
      exitCode: 0,
      claimToken: claim.claimToken,
      expectedNode: 'ex-ok',
    });
    assert.equal(done.status, 'done');
  });

  test('completion after expiry but before reclaim is rejected and requeued', () => {
    const task = taskService.enqueue({ cmd: 'x' });
    const stale = taskService.claimTask('ex-1');
    forceLease(task.id, PAST());

    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: stale.claimToken }),
      /lease expired/i,
    );

    const requeued = taskService.getTask(task.id);
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.attempt, 1);
    assert.equal(requeued.claimToken, undefined);

    const rejection = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE task_id = ? AND action = 'task_result_rejected_expired'
    `).get(task.id);
    assert.equal(rejection.count, 1, 'the rejection must be observable');

    const next = taskService.claimTask('ex-2');
    assert.equal(next.id, task.id);
    assert.equal(next.attempt, 2);
    const done = taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: next.claimToken });
    assert.equal(done.status, 'done');
    assert.equal(done.attempt, 2);
  });

  test('completion after expiry with no attempts left fails the task', () => {
    const task = taskService.enqueue({ cmd: 'x', maxAttempts: 1 });
    const stale = taskService.claimTask('ex-exhaust');
    forceLease(task.id, PAST());

    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: stale.claimToken }),
      /lease expired/i,
    );
    const final = taskService.getTask(task.id);
    assert.equal(final.status, 'failed');
    assert.match(final.error, /max attempts/i);
  });

  test('an old attempt cannot report success or failure after a new attempt finished', () => {
    const task = taskService.enqueue({ cmd: 'x', maxAttempts: 3 });
    const old = taskService.claimTask('ex-old');
    forceLease(task.id, PAST());

    const current = taskService.claimTask('ex-new');
    assert.equal(current.attempt, 2);
    taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: current.claimToken });

    for (const status of ['done', 'failed']) {
      assert.throws(
        () => taskService.completeTask(task.id, { status, claimToken: old.claimToken }),
        /claimed by another worker/i,
      );
    }
    const after = taskService.getTask(task.id);
    assert.equal(after.status, 'done');
    assert.equal(after.attempt, 2);
  });

  test('a cancellation confirmed after expiry stays terminal and rejects late results', () => {
    const task = taskService.enqueue({ cmd: 'x' });
    const claim = taskService.claimTask('ex-cancel');
    taskService.cancelTask(task.id);
    assert.equal(taskService.getTask(task.id).status, 'cancelling');

    forceLease(task.id, PAST());
    assert.throws(
      () => taskService.completeTask(task.id, { status: 'cancelled', claimToken: claim.claimToken }),
      /lease expired/i,
    );
    const final = taskService.getTask(task.id);
    assert.equal(final.status, 'cancelled');
    assert.ok(final.finishedAt);

    // A late success with the same token cannot reopen the terminal state.
    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken }),
      /not found|claimed by another worker/i,
    );
    assert.equal(taskService.getTask(task.id).status, 'cancelled');
  });

  test('cancelling a running task with an expired lease is final immediately', () => {
    const task = taskService.enqueue({ cmd: 'x' });
    const claim = taskService.claimTask('ex-cancel-expired');
    forceLease(task.id, PAST());

    const cancelled = taskService.cancelTask(task.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.finishedAt);
    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken }),
      /not found|claimed by another worker/i,
    );
  });

  test('cancelling a running task with a valid lease still requests confirmation', () => {
    const task = taskService.enqueue({ cmd: 'x' });
    const claim = taskService.claimTask('ex-cancel-valid');
    const requested = taskService.cancelTask(task.id);
    assert.equal(requested.status, 'cancelling');
    const confirmed = taskService.completeTask(task.id, { status: 'cancelled', claimToken: claim.claimToken });
    assert.equal(confirmed.status, 'cancelled');
  });
});

describe('Running attempts with a missing lease have no authority', () => {
  const testDb = path.resolve(__dirname, '../data/test-task-null-lease.db');

  before(() => {
    cleanDb(testDb);
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
  });

  test('a null lease cannot complete; the result is rejected and the task recovered', () => {
    const task = taskService.enqueue({ cmd: 'x' });
    const claim = taskService.claimTask('nl-1');
    assert.equal(claim.id, task.id);
    forceLease(task.id, null);

    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken }),
      /no lease/i,
    );

    const recovered = taskService.getTask(task.id);
    assert.equal(recovered.status, 'queued', 'the attempt without authority must be requeued');
    assert.equal(recovered.attempt, 1);
    assert.equal(recovered.claimToken, undefined);

    const rejection = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE task_id = ? AND action = 'task_result_rejected_no_lease'
    `).get(task.id);
    assert.equal(rejection.count, 1, 'the rejection must be observable');

    // The stale attempt token is dead: not now, and not after a re-claim.
    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken }),
      /claimed by another worker/i,
    );
    const next = taskService.claimTask('nl-2');
    assert.equal(next.id, task.id);
    assert.equal(next.attempt, 2);
    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken }),
      /claimed by another worker/i,
    );

    const done = taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: next.claimToken });
    assert.equal(done.status, 'done');
  });

  test('an empty-string lease is treated as missing', () => {
    const task = taskService.enqueue({ cmd: 'x' });
    const claim = taskService.claimTask('nl-empty');
    assert.equal(claim.id, task.id);
    forceLease(task.id, '');

    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken }),
      /no lease/i,
    );
    assert.equal(taskService.getTask(task.id).status, 'queued');

    // Leave no queued task behind for the following tests.
    const next = taskService.claimTask('nl-empty');
    assert.equal(next.id, task.id);
    taskService.completeTask(task.id, { status: 'done', claimToken: next.claimToken });
  });

  test('a missing lease with no attempts left fails the task', () => {
    const task = taskService.enqueue({ cmd: 'x', maxAttempts: 1 });
    const claim = taskService.claimTask('nl-exhaust');
    assert.equal(claim.id, task.id);
    forceLease(task.id, null);

    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken }),
      /no lease/i,
    );
    const final = taskService.getTask(task.id);
    assert.equal(final.status, 'failed');
    assert.match(final.error, /max attempts/i);
  });

  test('a running task with a missing lease is recovered by the next heartbeat', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'nl-beat' });
    const claim = taskService.claimTask('nl-beat');
    assert.equal(claim.id, task.id);
    forceLease(task.id, null);

    taskService.heartbeat({ node: 'nl-beat', running: [] });

    const recovered = taskService.getTask(task.id);
    assert.equal(recovered.status, 'queued');
    assert.equal(recovered.node, null);

    // Leave no queued task behind for the following tests.
    const next = taskService.claimTask('nl-beat');
    assert.equal(next.id, task.id);
    taskService.completeTask(task.id, { status: 'done', claimToken: next.claimToken });
  });

  test('cancelling a running task with a missing lease is final immediately', () => {
    const task = taskService.enqueue({ cmd: 'x' });
    const claim = taskService.claimTask('nl-cancel');
    forceLease(task.id, null);

    const cancelled = taskService.cancelTask(task.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.finishedAt);
    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', claimToken: claim.claimToken }),
      /not found|claimed by another worker/i,
    );
  });
});
