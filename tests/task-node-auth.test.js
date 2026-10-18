const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Configure the scoped node token BEFORE the server modules are loaded.
process.env.CITADEL_NODE_TOKEN = 'node-shared-secret';

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

const NODE_HEADER = { 'x-citadel-node-token': 'node-shared-secret' };

describe('Scoped node credentials for task mesh workers', () => {
  const testDb = path.resolve(__dirname, '../data/test-task-node-auth.db');
  let app;
  let adminCookie;

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'nodeadmin', password: 'SuperPassword123!' },
    });
    assert.equal(setup.statusCode, 200);
    adminCookie = setup.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    delete process.env.CITADEL_NODE_TOKEN;
  });

  test('worker endpoints accept the node token; other endpoints do not', async () => {
    const enqueue = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      cookies: { session_id: adminCookie },
      payload: { cmd: 'echo', args: ['hello'], node: 'nt-1' },
    });
    assert.equal(enqueue.statusCode, 200);

    const claim = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: NODE_HEADER,
      payload: { node: 'nt-1' },
    });
    assert.equal(claim.statusCode, 200);
    const task = JSON.parse(claim.payload).task;
    assert.ok(task.claimToken);

    const beat = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: NODE_HEADER,
      payload: { node: 'nt-1', capacity: 1, active: 1, load: 0.1, running: [task.id] },
    });
    assert.equal(beat.statusCode, 200);

    const result = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/result`,
      headers: NODE_HEADER,
      payload: { status: 'done', exitCode: 0, claimToken: task.claimToken },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.payload).task.status, 'done');

    // The node credential is scoped to worker endpoints only.
    const forbiddenList = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: NODE_HEADER,
    });
    assert.equal(forbiddenList.statusCode, 401);

    const forbiddenSystem = await app.inject({
      method: 'GET',
      url: '/api/system/node',
      headers: NODE_HEADER,
    });
    assert.equal(forbiddenSystem.statusCode, 401);
  });

  test('an invalid node token is rejected on worker endpoints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: { 'x-citadel-node-token': 'wrong-secret' },
      payload: { node: 'nt-2' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('a node token cannot complete a task claimed by another credential', async () => {
    const enqueue = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      cookies: { session_id: adminCookie },
      payload: { cmd: 'echo', node: 'nt-3' },
    });
    const id = JSON.parse(enqueue.payload).task.id;

    const claim = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: NODE_HEADER,
      payload: { node: 'nt-3' },
    });
    const claimToken = JSON.parse(claim.payload).task.claimToken;

    const forged = await app.inject({
      method: 'POST',
      url: `/api/tasks/${id}/result`,
      headers: NODE_HEADER,
      payload: { status: 'done', exitCode: 0, claimToken: `${claimToken}xx` },
    });
    assert.equal(forged.statusCode, 400);
  });

  test('sessions remain accepted on worker endpoints for compatibility', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      cookies: { session_id: adminCookie },
      payload: { node: 'nt-session' },
    });
    assert.equal(res.statusCode, 204);
  });
});
