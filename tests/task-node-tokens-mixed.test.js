const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Mixed configuration: one valid entry plus malformed/short ones. The valid
// entry keeps per-node identity binding active; the discarded entries and the
// shared token must not authenticate.
process.env.CITADEL_NODE_TOKENS = 'alpha:alpha-secret-0123456789,beta:short,broken,wrong id:long-enough-secret-123';
process.env.CITADEL_NODE_TOKEN = 'shared-secret-must-not-be-accepted';

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

const ALPHA = { 'x-citadel-node-token': 'alpha-secret-0123456789' };
const SHARED = { 'x-citadel-node-token': 'shared-secret-must-not-be-accepted' };

describe('A mixed CITADEL_NODE_TOKENS keeps the per-node model active', () => {
  const testDb = path.resolve(__dirname, '../data/test-task-node-tokens-mixed.db');
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
      payload: { username: 'mixedtokensadmin', password: 'SuperPassword123!' },
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

  test('the valid entry works and is bound to its node', async () => {
    const enqueue = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      cookies: cookie,
      payload: { cmd: 'echo', node: 'alpha' },
    });
    assert.equal(enqueue.statusCode, 200);
    const task = JSON.parse(enqueue.payload).task;

    const claim = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: ALPHA,
      payload: { node: 'alpha' },
    });
    assert.equal(claim.statusCode, 200);
    const claimed = JSON.parse(claim.payload).task;
    assert.equal(claimed.id, task.id);
    assert.ok(claimed.claimToken);
  });

  test('discarded entries and the shared token cannot authenticate', async () => {
    for (const token of ['short', 'long-enough-secret-123', 'shared-secret-must-not-be-accepted']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks/claim',
        headers: { 'x-citadel-node-token': token },
        payload: { node: 'alpha' },
      });
      assert.equal(res.statusCode, 401, `token ${token.slice(0, 8)}... must be rejected`);
    }
    assert.equal(SHARED['x-citadel-node-token'], 'shared-secret-must-not-be-accepted');
  });
});
