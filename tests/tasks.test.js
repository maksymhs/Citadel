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

describe('Task service (pull queue with leases)', () => {
  const testDb = path.resolve(__dirname, '../data/test-tasks.db');

  before(() => {
    cleanDb(testDb);
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
  });

  test('enqueue requires a cmd and stores args as an array', () => {
    assert.throws(() => taskService.enqueue({}), /cmd/i);
    const task = taskService.enqueue({ cmd: 'echo', args: ['hi'], priority: 3, node: 'n-enqueue' });
    assert.equal(task.status, 'queued');
    assert.deepEqual(task.args, ['hi']);
    assert.equal(task.priority, 3);
  });

  test('claim is atomic: one task goes to exactly one node', () => {
    const task = taskService.enqueue({ cmd: 'sleep', args: ['1'], node: 'n-atomic' });
    const first = taskService.claimTask('n-atomic');
    assert.equal(first.id, task.id);
    assert.equal(first.status, 'running');
    assert.equal(first.node, 'n-atomic');

    // Nothing else claimable by a different node.
    assert.equal(taskService.claimTask('n-other'), null);
  });

  test('node pinning: a task pinned to a node is invisible to others', () => {
    taskService.enqueue({ cmd: 'echo', node: 'node-b' });
    assert.equal(taskService.claimTask('node-a'), null);
    const claimed = taskService.claimTask('node-b');
    assert.equal(claimed.node, 'node-b');
    taskService.completeTask(claimed.id, { status: 'done', exitCode: 0 });
  });

  test('completeTask marks done/failed and rejects finished tasks', () => {
    const task = taskService.enqueue({ cmd: 'true', node: 'n-complete' });
    taskService.claimTask('n-complete');
    const done = taskService.completeTask(task.id, { status: 'done', exitCode: 0, resultRef: 'agent/x' });
    assert.equal(done.status, 'done');
    assert.equal(done.resultRef, 'agent/x');
    assert.throws(() => taskService.completeTask(task.id, { status: 'done' }), /not found or already finished/i);
  });

  test('an expired lease returns the task to the queue', () => {
    const task = taskService.enqueue({ cmd: 'long-job', node: 'n-lease' });
    taskService.claimTask('n-lease');
    // Simulate a crashed worker by expiring the lease.
    const past = new Date(Date.now() - 1000).toISOString();
    getDatabase().prepare('UPDATE tasks SET lease_until = ? WHERE id = ?').run(past, task.id);

    const reclaimed = taskService.claimTask('n-lease2');
    assert.equal(reclaimed.id, task.id);
    assert.equal(reclaimed.node, 'n-lease2');
  });

  test('heartbeat upserts a node and renews its running leases', () => {
    const task = taskService.enqueue({ cmd: 'job', node: 'node-c' });
    taskService.claimTask('node-c');
    const before = getDatabase().prepare('SELECT lease_until FROM tasks WHERE id = ?').get(task.id).lease_until;

    const node = taskService.heartbeat({ node: 'node-c', capacity: 2, active: 1, load: 0.5, tags: ['gpu'] });
    assert.equal(node.capacity, 2);
    assert.deepEqual(node.tags, ['gpu']);

    const after = getDatabase().prepare('SELECT lease_until FROM tasks WHERE id = ?').get(task.id).lease_until;
    assert.ok(after >= before);
    assert.ok(taskService.listNodes().some((n) => n.id === 'node-c'));
  });
});

describe('Task mesh HTTP routes', () => {
  const testDb = path.resolve(__dirname, '../data/test-tasks-http.db');
  let app;
  let cookie;

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'taskadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    cleanDb(testDb);
  });

  test('task routes require a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    assert.equal(res.statusCode, 401);
  });

  test('enqueue, claim and complete round-trip over HTTP', async () => {
    const enqueue = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie },
      payload: { cmd: 'echo', args: ['hello'] },
    });
    assert.equal(enqueue.statusCode, 200);
    const task = JSON.parse(enqueue.payload).task;

    const claim = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: { cookie },
      payload: { node: 'worker-1' },
    });
    assert.equal(claim.statusCode, 200);
    assert.equal(JSON.parse(claim.payload).task.id, task.id);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: { cookie },
      payload: { node: 'worker-2' },
    });
    assert.equal(empty.statusCode, 204);

    const result = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/result`,
      headers: { cookie },
      payload: { status: 'done', exitCode: 0, resultRef: 'commit-abc' },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.payload).task.status, 'done');

    const list = await app.inject({
      method: 'GET',
      url: '/api/tasks?status=done',
      headers: { cookie },
    });
    assert.equal(list.statusCode, 200);
    assert.ok(JSON.parse(list.payload).tasks.some((t) => t.id === task.id));
  });

  test('node heartbeat and listing reflect reported load', async () => {
    const hb = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: { cookie },
      payload: { node: 'worker-1', capacity: 3, active: 2, load: 1.25 },
    });
    assert.equal(hb.statusCode, 200);

    const nodes = await app.inject({ method: 'GET', url: '/api/nodes', headers: { cookie } });
    assert.equal(nodes.statusCode, 200);
    const worker = JSON.parse(nodes.payload).nodes.find((n) => n.id === 'worker-1');
    assert.equal(worker.capacity, 3);
    assert.equal(worker.active, 2);
    assert.equal(worker.load, 1.25);
  });
});
