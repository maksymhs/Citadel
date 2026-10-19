const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('Connection settings (public URL)', () => {
  const testDb = path.resolve(__dirname, '../data/test-settings-connect.db');
  let app;
  let cookie;

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'setadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;
  });

  after(async () => {
    await app.close();
    const { closeDatabase } = require('../server/database/db');
    closeDatabase();
    cleanDb(testDb);
  });

  test('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/connect' });
    assert.equal(res.statusCode, 401);
  });

  test('starts with no stored public URL', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/connect', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const { connect } = JSON.parse(res.payload);
    assert.equal(connect.publicUrl, '');
    assert.equal(connect.envLocked, false);
  });

  test('rejects an invalid URL', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/connect',
      headers: { cookie },
      payload: { publicUrl: 'http://' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('saves a public URL that drives the connect URL and origin allow-list', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/connect',
      headers: { cookie },
      payload: { publicUrl: 'http://13.63.131.22:3000' },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(JSON.parse(put.payload).connect.publicUrl, 'http://13.63.131.22:3000');

    const connect = await app.inject({ method: 'GET', url: '/api/system/connect', headers: { cookie } });
    const info = JSON.parse(connect.payload).connect;
    assert.equal(info.url, 'http://13.63.131.22:3000');
    assert.equal(info.source, 'configured');

    // The terminal WebSocket guard must trust the configured origin.
    const { isAllowedOrigin } = require('../server/security/guard');
    assert.equal(isAllowedOrigin('http://13.63.131.22:3000'), true);
    assert.equal(isAllowedOrigin('http://evil.example.com'), false);

    const audit = await app.inject({ method: 'GET', url: '/api/audit?limit=20', headers: { cookie } });
    const actions = JSON.parse(audit.payload).logs.map((l) => l.action);
    assert.ok(actions.includes('connect_url_set'));
  });

  test('accepts a bare host and normalises it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/connect',
      headers: { cookie },
      payload: { publicUrl: 'panel.example.com' },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(JSON.parse(put.payload).connect.publicUrl, 'http://panel.example.com');
  });

  test('clearing the URL falls back to auto-detection', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/connect',
      headers: { cookie },
      payload: { publicUrl: '' },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(JSON.parse(put.payload).connect.publicUrl, '');

    const res = await app.inject({ method: 'GET', url: '/api/settings/connect', headers: { cookie } });
    assert.equal(JSON.parse(res.payload).connect.publicUrl, '');
  });
});
