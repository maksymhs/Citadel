const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');
const { verifyPassword } = require('../server/security/auth');

describe('Auth & Security API Tests', () => {
  let app;
  const testDb = path.resolve(__dirname, '../data/test-auth.db');

  before(async () => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    app = await buildServer({ customDbPath: testDb, logger: false });
  });

  after(async () => {
    await app.close();
    closeDatabase();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  });

  test('GET /api/auth/status should report setupComplete: false on fresh install', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.setupComplete, false);
  });

  test('POST /api/auth/setup should create initial admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        username: 'admin',
        password: 'SuperSecretPassword123!',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, true);
    assert.equal(body.user.username, 'admin');
    assert.equal(body.user.role, 'admin');
    // The session id must travel only in the HttpOnly cookie, never in JSON.
    assert.equal(body.sessionId, undefined);
    assert.ok(res.cookies.find((c) => c.name === 'session_id'));
  });

  test('POST /api/auth/setup second attempt must be blocked permanently', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        username: 'intruder',
        password: 'AnotherPassword123!',
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /already completed/i);
  });

  test('verifyPassword rejects malformed stored hashes instead of throwing', () => {
    assert.equal(verifyPassword('anything', 'not-a-hash', 'salt'), false);
    assert.equal(verifyPassword('anything', 'ab'.repeat(4), 'salt'), false);
  });

  test('session polling avoids repeated writes while expiry is still enforced', () => {
    const { getDatabase } = require('../server/database/db');
    const { login, getSessionUser } = require('../server/security/auth');
    const db = getDatabase();
    const session = login('admin', 'SuperSecretPassword123!');
    const id = session.id || session.sessionId;
    db.prepare("UPDATE sessions SET last_active = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    assert.ok(getSessionUser(id));
    const last = db.prepare('SELECT last_active, expires_at FROM sessions WHERE id = ?').get(id);
    assert.notEqual(last.last_active, '2000-01-01T00:00:00.000Z');
    const before = db.prepare('SELECT total_changes() n').get().n;
    assert.ok(getSessionUser(id));
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
    assert.equal(db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id).expires_at, last.expires_at);
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    assert.equal(getSessionUser(id), null);
  });

  test('concurrent setup attempts can only create one administrator', async () => {
    const { initDatabase } = require('../server/database/db');
    const concurrentDb = path.resolve(__dirname, '../data/test-auth-concurrent.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const f = concurrentDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    const concurrentApp = await buildServer({ customDbPath: concurrentDb, logger: false });
    try {
      const [a, b] = await Promise.all([
        concurrentApp.inject({
          method: 'POST',
          url: '/api/auth/setup',
          payload: { username: 'first', password: 'SuperSecretPassword123!' },
        }),
        concurrentApp.inject({
          method: 'POST',
          url: '/api/auth/setup',
          payload: { username: 'second', password: 'SuperSecretPassword123!' },
        }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      assert.deepEqual(codes, [200, 400]);

      const status = await concurrentApp.inject({ method: 'GET', url: '/api/auth/status' });
      assert.equal(JSON.parse(status.payload).setupComplete, true);
    } finally {
      await concurrentApp.close();
      closeDatabase();
      // Restore the singleton connection to the main test database so the
      // remaining tests in this file keep hitting the same app state.
      initDatabase(testDb);
      for (const suffix of ['', '-wal', '-shm']) {
        const f = concurrentDb + suffix;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  test('POST /api/auth/login with invalid password should fail with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'admin',
        password: 'WrongPassword!',
      },
    });
    assert.equal(res.statusCode, 401);
  });

  test('POST /api/auth/login with valid credentials sets an HttpOnly session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        username: 'admin',
        password: 'SuperSecretPassword123!',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, true);
    assert.equal(body.sessionId, undefined);
    const cookie = res.cookies.find((c) => c.name === 'session_id');
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    assert.equal(cookie.path, '/');
  });

  test('POST /api/auth/logout invalidates the session server-side', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'SuperSecretPassword123!' },
    });
    const cookie = loginRes.cookies.find((c) => c.name === 'session_id');

    const before = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { session_id: cookie.value },
    });
    assert.equal(before.statusCode, 200);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { session_id: cookie.value },
    });
    assert.equal(logout.statusCode, 200);

    // Reusing the destroyed session id must fail even though the cookie value
    // is still what the client held.
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { session_id: cookie.value },
    });
    assert.equal(after.statusCode, 401);
  });

  test('GET /api/auth/me requires authentication', async () => {
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
    });
    assert.equal(unauth.statusCode, 401);

    // Login and get cookie
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'SuperSecretPassword123!' },
    });
    const cookie = loginRes.cookies.find((c) => c.name === 'session_id');

    const authRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { session_id: cookie.value },
    });
    assert.equal(authRes.statusCode, 200);
    const authBody = JSON.parse(authRes.payload);
    assert.equal(authBody.user.username, 'admin');
  });
});
