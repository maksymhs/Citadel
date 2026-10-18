const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// An explicitly configured per-node map whose entries are ALL invalid (short
// token, no separator, invalid node id). The shared token below must NOT be
// accepted as a silent fallback: the admin selected the per-node model.
const SHARED_SECRET = 'shared-secret-must-not-be-accepted';
process.env.CITADEL_NODE_TOKENS = 'alpha:short,broken,bad id:long-enough-secret-123';
process.env.CITADEL_NODE_TOKEN = SHARED_SECRET;

const startupErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => startupErrors.push(args.join(' '));
let buildServer;
let closeDatabase;
try {
  ({ buildServer } = require('../server/index'));
  ({ closeDatabase } = require('../server/database/db'));
} finally {
  console.error = originalConsoleError;
}

const SHARED = { 'x-citadel-node-token': SHARED_SECRET };

describe('A fully invalid CITADEL_NODE_TOKENS fails closed', () => {
  const testDb = path.resolve(__dirname, '../data/test-task-node-tokens-invalid.db');
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
      payload: { username: 'invalidtokensadmin', password: 'SuperPassword123!' },
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

  test('the startup error names the variable and never the secrets', () => {
    const report = startupErrors.join('\n');
    assert.match(report, /CITADEL_NODE_TOKENS/);
    assert.match(report, /no valid/i);
    assert.ok(!report.includes(SHARED_SECRET), 'the shared secret must never be logged');
    assert.ok(!report.includes('long-enough-secret-123'), 'entry values must never be logged');
  });

  test('the shared token is rejected on worker endpoints (no silent fallback)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      headers: SHARED,
      payload: { node: 'alpha' },
    });
    assert.equal(res.statusCode, 401);
    assert.ok(!res.payload.includes(SHARED_SECRET));
  });

  test('tokens that were discarded by the parser are rejected', async () => {
    for (const token of ['short', 'long-enough-secret-123']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks/claim',
        headers: { 'x-citadel-node-token': token },
        payload: { node: 'alpha' },
      });
      assert.equal(res.statusCode, 401, `discarded token ${token} must not authenticate`);
    }
  });

  test('sessions keep worker access (orchestrator compatibility)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/claim',
      cookies: cookie,
      payload: { node: 'alpha' },
    });
    assert.equal(res.statusCode, 204);
  });
});
