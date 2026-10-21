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

const PAST = () => new Date(Date.now() - 1000).toISOString();

function leaseOf(id) {
  const row = getDatabase().prepare('SELECT lease_until FROM tasks WHERE id = ?').get(id);
  return row ? row.lease_until : null;
}

function forceLease(id, iso) {
  getDatabase().prepare('UPDATE tasks SET lease_until = ? WHERE id = ?').run(iso, id);
}

function rowOf(id) {
  return getDatabase().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function execWitness(task, claim, execId = 'exec-1', pid = 40001) {
  return {
    id: task.id,
    claimToken: claim.claimToken,
    execId,
    pid,
    pgid: pid,
    startedAt: claim.startedAt || new Date().toISOString(),
  };
}

function trackedClaim(node, execId = 'exec-1', pid = 40001) {
  const task = taskService.enqueue({ cmd: 'x', node });
  const claim = taskService.claimTask(node, { protocol: 2 });
  assert.equal(claim.id, task.id);
  taskService.heartbeat({
    node,
    running: [execWitness(task, claim, execId, pid)],
  });
  return { task, claim, execId, pid };
}

describe('Tracked execution lifecycle (protocol 2)', () => {
  const testDb = path.resolve(__dirname, '../data/test-task-execution.db');

  before(() => {
    cleanDb(testDb);
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
  });

  test('claim stores the worker protocol and heartbeat persists exec identity', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'ex-id' });
    const claim = taskService.claimTask('ex-id', { protocol: 2 });
    assert.equal(claim.workerProtocol, 2);
    assert.equal(claim.execPid, null);

    const startedAt = new Date().toISOString();
    const node = taskService.heartbeat({
      node: 'ex-id',
      running: [{ ...execWitness(task, claim, 'exec-id', 40100), startedAt }],
    });

    const row = rowOf(task.id);
    assert.equal(row.exec_id, 'exec-id');
    assert.equal(row.exec_pid, 40100);
    assert.equal(row.exec_pgid, 40100);
    assert.equal(row.exec_started_at, startedAt);
    assert.equal(row.reconcile_state, 'alive');
    assert.ok(row.lease_until > startedAt);
    assert.deepEqual(node.abandon, []);
    assert.deepEqual(node.reconcile, []);

    taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken, execId: 'exec-id' });
  });

  test('a result that omits or forges execId for a tracked attempt is rejected', () => {
    const { task, claim } = trackedClaim('ex-exec-check', 'exec-check', 40101);

    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken }),
      /must include its execId/i,
    );
    assert.throws(
      () => taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken, execId: 'other-exec' }),
      /execution identity mismatch/i,
    );
    assert.equal(rowOf(task.id).status, 'running');

    const done = taskService.completeTask(task.id, {
      status: 'done', exitCode: 0, claimToken: claim.claimToken, execId: 'exec-check',
    });
    assert.equal(done.status, 'done');
  });

  test('expiry with a tracked execution becomes uncertain and is never requeued', () => {
    const { task, claim } = trackedClaim('ex-tracked', 'exec-tracked', 40102);
    const past = PAST();
    forceLease(task.id, past);

    // Any claim for another node triggers reclaim; it must not return the
    // tracked task.
    assert.equal(taskService.claimTask('ex-other-node'), null);

    const row = rowOf(task.id);
    assert.equal(row.status, 'running');
    assert.equal(row.reconcile_state, 'uncertain');
    assert.equal(row.attempt, 1);
    assert.equal(row.claim_token, claim.claimToken, 'authority is not silently transferred');
    assert.equal(leaseOf(task.id), past, 'the expired lease is not extended');
  });

  test('a protocol-2 attempt is uncertain even before it reports a pid', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'ex-journal-only' });
    const claim = taskService.claimTask('ex-journal-only', { protocol: 2 });
    forceLease(task.id, PAST());

    assert.equal(taskService.claimTask('ex-journal-other'), null);
    const row = rowOf(task.id);
    assert.equal(row.status, 'running');
    assert.equal(row.reconcile_state, 'uncertain');
    assert.equal(row.attempt, 1);
    assert.ok(row.claim_token);

    const reconciled = taskService.reconcileTask(task.id, {
      claimToken: claim.claimToken,
      execId: 'never-reported',
      state: 'terminated',
    });
    assert.equal(reconciled.requeued, true);
    assert.equal(rowOf(task.id).status, 'queued');

    // Drain the requeued task so it cannot be picked up by another test.
    const next = taskService.claimTask('ex-journal-only', { protocol: 2 });
    assert.equal(next.id, task.id);
    taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: next.claimToken });
  });

  test('legacy protocol-1 expiry keeps requeueing (no regression)', () => {
    const task = taskService.enqueue({ cmd: 'x', node: 'ex-legacy' });
    const first = taskService.claimTask('ex-legacy');
    forceLease(task.id, PAST());

    const second = taskService.claimTask('ex-legacy');
    assert.equal(second.id, task.id);
    assert.equal(second.attempt, 2);
    taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: second.claimToken });
    assert.ok(first.claimToken !== second.claimToken);
  });

  test('reconcile alive re-authorizes the same execution without a new attempt', () => {
    const { task, claim, execId } = trackedClaim('ex-alive', 'exec-alive', 40103);
    forceLease(task.id, PAST());
    taskService.heartbeat({ node: 'ex-alive', running: [] });
    assert.equal(rowOf(task.id).reconcile_state, 'uncertain');

    const result = taskService.reconcileTask(task.id, {
      claimToken: claim.claimToken,
      execId,
      state: 'alive',
      pid: 40103,
      pgid: 40103,
    });
    assert.equal(result.state, 'alive');
    assert.equal(result.task.status, 'running');
    assert.equal(result.task.attempt, 1);
    assert.equal(rowOf(task.id).reconcile_state, 'alive');
    assert.ok(leaseOf(task.id) > PAST());

    const done = taskService.completeTask(task.id, {
      status: 'done', exitCode: 0, claimToken: claim.claimToken, execId,
    });
    assert.equal(done.status, 'done');
  });

  test('reconcile terminated with an exit code finalises the task', () => {
    const ok = trackedClaim('ex-term-ok', 'exec-term-ok', 40104);
    forceLease(ok.task.id, PAST());
    const done = taskService.reconcileTask(ok.task.id, {
      claimToken: ok.claim.claimToken,
      execId: ok.execId,
      state: 'terminated',
      exitCode: 0,
    });
    assert.equal(done.task.status, 'done');

    const bad = trackedClaim('ex-term-bad', 'exec-term-bad', 40105);
    forceLease(bad.task.id, PAST());
    const failed = taskService.reconcileTask(bad.task.id, {
      claimToken: bad.claim.claimToken,
      execId: bad.execId,
      state: 'terminated',
      exitCode: 2,
      signal: 'SIGKILL',
    });
    assert.equal(failed.task.status, 'failed');
    assert.match(failed.task.error, /SIGKILL/);
  });

  test('reconcile terminated without an exit code requeues safely, then fails at the limit', () => {
    const retry = taskService.enqueue({ cmd: 'x', node: 'ex-term-nocode', maxAttempts: 2 });
    const claim = taskService.claimTask('ex-term-nocode', { protocol: 2 });
    forceLease(retry.id, PAST());
    const first = taskService.reconcileTask(retry.id, {
      claimToken: claim.claimToken,
      execId: 'exec-nocode',
      state: 'terminated',
    });
    assert.equal(first.requeued, true);
    assert.equal(first.task.status, 'queued');

    const second = taskService.claimTask('ex-term-nocode', { protocol: 2 });
    assert.equal(second.attempt, 2);
    forceLease(retry.id, PAST());
    const final = taskService.reconcileTask(retry.id, {
      claimToken: second.claimToken,
      execId: 'exec-nocode-2',
      state: 'terminated',
    });
    assert.equal(final.task.status, 'failed');
    assert.match(final.task.error, /max attempts/i);
  });

  test('stale tokens and foreign execution ids are rejected without changing the attempt', () => {
    const { task, claim, execId } = trackedClaim('ex-stale', 'exec-stale', 40106);
    forceLease(task.id, PAST());

    assert.throws(
      () => taskService.reconcileTask(task.id, { claimToken: 'forged', execId, state: 'terminated' }),
      /not authoritative/i,
    );
    assert.throws(
      () => taskService.reconcileTask(task.id, { claimToken: claim.claimToken, execId: 'foreign', state: 'terminated' }),
      /identity mismatch/i,
    );

    const row = rowOf(task.id);
    assert.equal(row.status, 'running');
    assert.equal(row.attempt, 1);
    assert.equal(row.claim_token, claim.claimToken);
  });

  test('reconciliation from another node credential is rejected', () => {
    const { task, claim, execId } = trackedClaim('ex-node-a', 'exec-node-a', 40107);
    assert.throws(
      () => taskService.reconcileTask(task.id, {
        claimToken: claim.claimToken,
        execId,
        state: 'alive',
        expectedNode: 'ex-node-b',
      }),
      /not authorized/i,
    );
    assert.equal(rowOf(task.id).status, 'running');
  });

  test('a terminal task cannot be reopened by a late reconcile or result', () => {
    const { task, claim, execId } = trackedClaim('ex-terminal', 'exec-terminal', 40108);
    taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken, execId });
    const finishedAt = rowOf(task.id).finished_at;

    const late = taskService.reconcileTask(task.id, {
      claimToken: claim.claimToken,
      execId,
      state: 'terminated',
      exitCode: 1,
    });
    assert.equal(late.discarded, true);
    assert.equal(late.task.status, 'done');
    assert.equal(rowOf(task.id).finished_at, finishedAt);

    assert.throws(
      () => taskService.completeTask(task.id, { status: 'failed', claimToken: claim.claimToken, execId }),
      /already finished|claimed by another worker/i,
    );
    assert.equal(rowOf(task.id).status, 'done');
  });

  test('repeated reconcile calls are idempotent and never add attempts', () => {
    const { task, claim, execId } = trackedClaim('ex-idem', 'exec-idem', 40109);
    forceLease(task.id, PAST());

    const first = taskService.reconcileTask(task.id, {
      claimToken: claim.claimToken, execId, state: 'terminated', exitCode: 0,
    });
    assert.equal(first.task.status, 'done');
    const attempt = first.task.attempt;

    for (let i = 0; i < 3; i += 1) {
      const again = taskService.reconcileTask(task.id, {
        claimToken: claim.claimToken, execId, state: 'terminated', exitCode: 0,
      });
      assert.equal(again.discarded, true);
      assert.equal(again.task.status, 'done');
      assert.equal(again.task.attempt, attempt);
    }
  });

  test('unknown reconciliation blocks requeue instead of inventing certainty', () => {
    const { task, claim, execId } = trackedClaim('ex-unknown', 'exec-unknown', 40110);
    forceLease(task.id, PAST());

    const result = taskService.reconcileTask(task.id, {
      claimToken: claim.claimToken, execId, state: 'unknown',
    });
    assert.equal(result.state, 'unknown');
    assert.equal(rowOf(task.id).status, 'running');
    assert.equal(rowOf(task.id).reconcile_state, 'uncertain');
    assert.equal(taskService.claimTask('ex-unknown-other'), null);
  });

  test('cancelling a tracked execution is a request, and expiry never fakes cancellation', () => {
    const { task, claim, execId } = trackedClaim('ex-cancel-tracked', 'exec-cancel', 40111);
    const requested = taskService.cancelTask(task.id);
    assert.equal(requested.status, 'cancelling');

    forceLease(task.id, PAST());
    taskService.heartbeat({ node: 'ex-cancel-tracked', running: [] });

    const row = rowOf(task.id);
    assert.equal(row.status, 'cancelling');
    assert.equal(row.reconcile_state, 'uncertain');
    assert.equal(row.finished_at, null);

    const confirmed = taskService.reconcileTask(task.id, {
      claimToken: claim.claimToken, execId, state: 'terminated', signal: 'SIGKILL',
    });
    assert.equal(confirmed.task.status, 'cancelled');
    assert.ok(confirmed.task.finishedAt);
  });

  test('cancelling a tracked execution with an expired lease is still only a request', () => {
    const { task, claim, execId } = trackedClaim('ex-cancel-expired-tracked', 'exec-cancel-exp', 40112);
    forceLease(task.id, PAST());

    const requested = taskService.cancelTask(task.id);
    assert.equal(requested.status, 'cancelling');
    assert.equal(rowOf(task.id).status, 'cancelling');

    const confirmed = taskService.reconcileTask(task.id, {
      claimToken: claim.claimToken, execId, state: 'terminated',
    });
    assert.equal(confirmed.task.status, 'cancelled');
  });

  test('cancellation is idempotent for in-flight and terminal tasks', () => {
    const { task, claim, execId } = trackedClaim('ex-cancel-idem', 'exec-cancel-idem', 40113);
    assert.equal(taskService.cancelTask(task.id).status, 'cancelling');
    assert.equal(taskService.cancelTask(task.id).status, 'cancelling');

    taskService.reconcileTask(task.id, { claimToken: claim.claimToken, execId, state: 'terminated' });
    assert.equal(taskService.cancelTask(task.id).status, 'cancelled');
    assert.equal(taskService.cancelTask(task.id).status, 'cancelled');
  });

  test('a tracked heartbeat renews a cancelling attempt so the kill can be confirmed', () => {
    const { task, claim, execId, pid } = trackedClaim('ex-cancel-renew', 'exec-cancel-renew', 40114);
    taskService.cancelTask(task.id);
    forceLease(task.id, PAST());

    // Cancellation renewal requires the execution witness; reclaim marks it
    // uncertain first, then the witness restores authority for the same process.
    taskService.heartbeat({
      node: 'ex-cancel-renew',
      running: [{ id: task.id, claimToken: claim.claimToken, execId, pid, pgid: pid }],
    });

    const row = rowOf(task.id);
    assert.equal(row.status, 'cancelling');
    assert.equal(row.reconcile_state, 'alive');
    assert.ok(row.lease_until > PAST());

    const confirmed = taskService.reconcileTask(task.id, {
      claimToken: claim.claimToken, execId, state: 'terminated',
    });
    assert.equal(confirmed.task.status, 'cancelled');
  });

  test('heartbeat tells the node to abandon executions that lost the attempt', () => {
    const { task, claim, execId, pid } = trackedClaim('ex-abandon', 'exec-abandon', 40115);
    taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken, execId });

    const beat = taskService.heartbeat({
      node: 'ex-abandon',
      running: [{ id: task.id, claimToken: claim.claimToken, execId, pid, pgid: pid }],
    });
    assert.deepEqual(beat.abandon, [{ id: task.id, execId }]);
    assert.deepEqual(beat.cancel, []);
    assert.equal(rowOf(task.id).status, 'done');
  });

  test('uncertain attempts are advertised to the owning node for reconciliation', () => {
    const { task, claim, execId } = trackedClaim('ex-advertise', 'exec-advertise', 40116);
    forceLease(task.id, PAST());
    taskService.heartbeat({ node: 'ex-advertise', running: [] });

    const beat = taskService.heartbeat({ node: 'ex-advertise', running: [] });
    assert.equal(beat.reconcile.length, 1);
    assert.equal(beat.reconcile[0].id, task.id);
    assert.equal(beat.reconcile[0].claimToken, claim.claimToken);
    assert.equal(beat.reconcile[0].execId, execId);

    taskService.reconcileTask(task.id, { claimToken: claim.claimToken, execId, state: 'terminated', exitCode: 0 });
  });

  test('public task views never expose claim tokens or execution secrets', () => {
    const { task } = trackedClaim('ex-public', 'exec-public', 40117);
    const view = taskService.getTask(task.id);
    assert.equal(view.claimToken, undefined);
    assert.equal(view.execId, undefined);
    assert.equal(view.execPid, 40117);
    assert.equal(view.reconcileState, 'alive');

    const listed = taskService.listTasks({ node: 'ex-public' });
    assert.equal(listed[0].claimToken, undefined);
    assert.equal(listed[0].execId, undefined);

    taskService.cancelTask(task.id);
  });
});
