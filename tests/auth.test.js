const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

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
    assert.ok(body.sessionId);
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

  test('POST /api/auth/login with valid credentials sets session cookie', async () => {
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
    assert.ok(res.cookies.find((c) => c.name === 'session_id'));
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
