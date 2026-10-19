const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Configure peer sync before any module (and thus config) is required. The
// updater path points nowhere so the route can never trigger a real update.
process.env.CITADEL_UPDATER_PATH = '/nonexistent/citadel-update-test';
process.env.CITADEL_PEER_TOKEN = 'test-peer-secret-123';
process.env.CITADEL_PEERS = 'https://peer.example.com';

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

describe('Peer update endpoint', () => {
  let app;
  const testDb = path.resolve(__dirname, '../data/test-peer.db');

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    app = await buildServer({ customDbPath: testDb, logger: false });
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'peeradmin', password: 'SuperPassword123!' },
    });
  });

  after(async () => {
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  test('rejects a missing peer token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/system/peer-update' });
    assert.equal(res.statusCode, 401);
  });

  test('rejects a wrong peer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/peer-update',
      headers: { 'x-citadel-peer-token': 'wrong-token-value' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('accepts the shared token without a session and runs the updater', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/peer-update',
      headers: { 'x-citadel-peer-token': 'test-peer-secret-123' },
    });
    // No session cookie was sent: the token alone authorizes the request.
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /not installed|unavailable/i);
  });
});
