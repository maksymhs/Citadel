const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Point the updater at a path that never exists and disable the built-in
// updater so the suite can NEVER trigger a real self-update. This must be set
// before the config/updateService modules are required below.
process.env.CITADEL_UPDATER_PATH = '/nonexistent/citadel-update-test';
process.env.CITADEL_SELF_UPDATE = '0';

const { buildServer } = require('../server/index');
const { closeDatabase, getDatabase, initDatabase } = require('../server/database/db');
const updateService = require('../server/services/updateService');
const pkg = require('../package.json');

describe('Version, updater and migrations', () => {
  const migDb = path.resolve(__dirname, '../data/test-migrations.db');

  test('compareVersions orders semver tags correctly', () => {
    assert.equal(updateService.compareVersions('v0.2.0', '0.1.0'), 1);
    assert.equal(updateService.compareVersions('0.1.0', 'v0.2.0'), -1);
    assert.equal(updateService.compareVersions('v0.2.0', '0.2.0'), 0);
    assert.equal(updateService.compareVersions('1.0.10', '1.0.9'), 1);
  });

  test('getVersionInfo reports the package version and updater status', () => {
    const info = updateService.getVersionInfo();
    assert.equal(info.version, pkg.version);
    assert.equal(typeof info.updaterAvailable, 'boolean');
    assert.ok(info.repo.includes('/'));
  });

  test('schema migrations are recorded once and are idempotent', () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = migDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    initDatabase(migDb);
    let db = getDatabase();
    let rows = db.prepare('SELECT name FROM schema_migrations ORDER BY id').all();
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].name, '001_baseline');
    const appliedNames = rows.map((r) => r.name);
    closeDatabase();

    // Re-initialising must not re-apply or duplicate any migration.
    initDatabase(migDb);
    db = getDatabase();
    rows = db.prepare('SELECT name FROM schema_migrations ORDER BY id').all();
    assert.deepEqual(rows.map((r) => r.name), appliedNames);
    closeDatabase();

    for (const suffix of ['', '-wal', '-shm']) {
      const f = migDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  describe('HTTP endpoints', () => {
    let app;
    let authCookie;
    const testDb = path.resolve(__dirname, '../data/test-update.db');

    before(async () => {
      for (const suffix of ['', '-wal', '-shm']) {
        const f = testDb + suffix;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }

      app = await buildServer({ customDbPath: testDb, logger: false });

      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'updater', password: 'SuperPassword123!' },
      });
      authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
    });

    after(async () => {
      await app.close();
      closeDatabase();
      for (const suffix of ['', '-wal', '-shm']) {
        const f = testDb + suffix;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    });

    test('GET /api/system/version returns the running version', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/system/version', cookies: { session_id: authCookie } });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.version.version, pkg.version);
      assert.equal(typeof body.version.updaterAvailable, 'boolean');
    });

    test('GET /api/system/updates detects a newer release', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (String(url).includes('/releases/latest')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ tag_name: 'v99.0.0', name: 'v99.0.0', html_url: 'https://example.com/rel', published_at: null }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };
      try {
        const res = await app.inject({ method: 'GET', url: '/api/system/updates?force=true', cookies: { session_id: authCookie } });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.payload);
        assert.equal(body.updates.latest, '99.0.0');
        assert.equal(body.updates.updateAvailable, true);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('POST /api/system/update tolerates an empty JSON body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/system/update',
        cookies: { session_id: authCookie },
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /unavailable|not installed/i);
    });

    test('POST /api/system/update fails cleanly when no updater is available', async () => {
      const original = process.env.CITADEL_UPDATER_PATH;
      process.env.CITADEL_UPDATER_PATH = '/nonexistent/citadel-update';
      delete require.cache[require.resolve('../server/services/updateService')];
      delete require.cache[require.resolve('../server/config')];
      const svc = require('../server/services/updateService');
      await assert.rejects(() => svc.triggerUpdate(), /unavailable|not installed/i);
      if (original === undefined) delete process.env.CITADEL_UPDATER_PATH;
      else process.env.CITADEL_UPDATER_PATH = original;
    });
  });
});
