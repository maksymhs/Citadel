const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Configure BOTH credential models before the server modules load: per-node
// tokens must win, and the shared token below must be ignored (fail closed).
process.env.CITADEL_NODE_TOKENS = 'alpha:alpha-secret-0123456789,beta:beta-secret-0123456789';
process.env.CITADEL_NODE_TOKEN = 'shared-secret-must-be-ignored';

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

const ALPHA = { 'x-citadel-node-token': 'alpha-secret-0123456789' };
const BETA = { 'x-citadel-node-token': 'beta-secret-0123456789' };
const SHARED = { 'x-citadel-node-token': 'shared-secret-must-be-ignored' };

describe('Per-node worker credentials (identity binding)', () => {
  const testDb = path.resolve(__dirname, '../data/test-task-node-identity.db');
  let app;
  let cookie;

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'identityadmin', password: 'SuperPassword123!' },
    });
    assert.equal(setup.statusCode, 200);
    cookie = { session_id: setup.cookies.find((c) => c.name === 'session_id').value };
  });

  after(async () => {
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    delete process.env.CITADEL_NODE_TOKENS;
    delete process.env.CITADEL_NODE_TOKEN;
  });

  async function enqueue(payload) {
    const res = await app.inject({ method: 'POST', url: '/api/tasks', cookies: cookie, payload });
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.payload).task;
  }

  test('a per-node credential can act as its own node and renew its own task', async () => {
    const task = await enqueue({ cmd: 'echo', node: 'alpha' });
    const claim = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: ALPHA,
      payload: { node: 'alpha' },
    });
    assert.equal(claim.statusCode, 200);
    const claimed = JSON.parse(claim.payload).task;
    assert.equal(claimed.id, task.id);

    const beat = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: ALPHA,
      payload: { node: 'alpha', running: [{ id: task.id, claimToken: claimed.claimToken }] },
    });
    assert.equal(beat.statusCode, 200);

    const result = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/result`,
      headers: ALPHA,
      payload: { status: 'done', exitCode: 0, claimToken: claimed.claimToken },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.payload).task.status, 'done');
  });

  test('a node credential cannot claim or heartbeat as another node', async () => {
    await enqueue({ cmd: 'echo', node: 'beta' });

    const claim = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: ALPHA,
      payload: { node: 'beta' },
    });
    assert.equal(claim.statusCode, 403);
    assert.match(JSON.parse(claim.payload).error, /not authorized/i);
    assert.ok(!claim.payload.includes('alpha-secret-0123456789'));

    const beat = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: ALPHA,
      payload: { node: 'beta' },
    });
    assert.equal(beat.statusCode, 403);
  });

  test('a node credential cannot report another node task even with its claim token', async () => {
    await enqueue({ cmd: 'echo', node: 'beta' });
    const claim = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: BETA,
      payload: { node: 'beta' },
    });
    assert.equal(claim.statusCode, 200);
    const claimed = JSON.parse(claim.payload).task;
    assert.equal(claimed.node, 'beta');
    assert.ok(claimed.claimToken);

    const forged = await app.inject({
      method: 'POST',
      url: `/api/tasks/${claimed.id}/result`,
      headers: ALPHA,
      payload: { status: 'done', exitCode: 0, claimToken: claimed.claimToken },
    });
    assert.equal(forged.statusCode, 403);
    assert.match(JSON.parse(forged.payload).error, /not authorized/i);

    const legit = await app.inject({
      method: 'POST',
      url: `/api/tasks/${claimed.id}/result`,
      headers: BETA,
      payload: { status: 'done', exitCode: 0, claimToken: claimed.claimToken },
    });
    assert.equal(legit.statusCode, 200);
  });

  test('unknown or removed credentials are rejected', async () => {
    const revoked = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: { 'x-citadel-node-token': 'revoked-token-0123456789' },
      payload: { node: 'alpha' },
    });
    assert.equal(revoked.statusCode, 401);
    assert.ok(!revoked.payload.includes('revoked-token-0123456789'));
  });

  test('the shared token is ignored while per-node credentials are configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: SHARED,
      payload: { node: 'alpha' },
    });
    assert.equal(res.statusCode, 401);
    assert.ok(!res.payload.includes('shared-secret-must-be-ignored'));
  });

  test('sessions keep unrestricted worker access (orchestrator compatibility)', async () => {
    const task = await enqueue({ cmd: 'echo', node: 'any-node' });
    const claim = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      cookies: cookie,
      payload: { node: 'any-node' },
    });
    assert.equal(claim.statusCode, 200);
    const claimed = JSON.parse(claim.payload).task;
    assert.equal(claimed.id, task.id);

    const beat = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      cookies: cookie,
      payload: { node: 'any-node', running: [{ id: task.id, claimToken: claimed.claimToken }] },
    });
    assert.equal(beat.statusCode, 200);

    const result = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/result`,
      cookies: cookie,
      payload: { status: 'done', claimToken: claimed.claimToken },
    });
    assert.equal(result.statusCode, 200);
  });

  test('claim tokens are never exposed in list responses', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/tasks', cookies: cookie });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.payload.includes('claimToken'));
  });
});
