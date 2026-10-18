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
