const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');
const updateService = require('../server/services/updateService');

function removeDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  }
}

// These tests only exercise detection and status reporting. They deliberately
// never call triggerUpdate()/POST /api/system/update, which would rewrite the
// checkout and restart the service.
describe('Built-in (unprivileged) updater', () => {
  let app;
  let authCookie;
  const testDb = path.resolve(__dirname, '../data/test-selfupdate.db');

  before(async () => {
    removeDb(testDb);
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'selfupadmin', password: 'SuperPassword123!' },
    });
    authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    removeDb(testDb);
  });

  test('detects that a writable git checkout can self-update', () => {
    // Pure capability detection, independent of the enable/disable flag.
    const self = updateService.checkSelfUpdate();
    assert.equal(self.ok, true, self.reason || 'expected self-update to be available');
  });

  test('getVersionInfo reports a mode and a canUpdate flag', () => {
    const info = updateService.getVersionInfo();
    assert.ok(['helper', 'self', 'manual'].includes(info.updateMode));
    assert.equal(info.canUpdate, info.updateMode !== 'manual');
    assert.equal(typeof info.selfUpdateAvailable, 'boolean');
  });

  test('GET /api/system/version exposes the updater capability', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/version', cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    const { version } = JSON.parse(res.payload);
    assert.equal(typeof version.canUpdate, 'boolean');
    assert.equal(typeof version.updateMode, 'string');
    assert.equal(typeof version.selfUpdateAvailable, 'boolean');
  });

  test('update status is admin-only and reports no run initially', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/api/system/update/status' });
    assert.equal(unauth.statusCode, 401);

    const res = await app.inject({ method: 'GET', url: '/api/system/update/status', cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Object.prototype.hasOwnProperty.call(body, 'update'));
    assert.ok(Object.prototype.hasOwnProperty.call(body.update, 'status'));
    assert.equal(typeof body.update.logPath, 'string');
  });

  test('getUpdateStatus always returns a stable shape', () => {
    const res = updateService.getUpdateStatus();
    assert.ok(path.isAbsolute(res.logPath));
    assert.ok(res.status === null || typeof res.status === 'object');
  });
});
