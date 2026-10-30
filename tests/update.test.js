const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-update-api-'));
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

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
  const migDb = path.join(testRoot, 'migrations.db');

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
    const testDb = path.join(testRoot, 'update.db');

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

    beforeEach(() => {
      require('../server/services/updateRolloutService').cancelFleetUpdate();
      require('../server/services/updateRolloutService').clearPropagatedUpdate();
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
      await assert.rejects(() => updateService.triggerUpdate({ fanout: false }), /unavailable|not installed/i);
      const res = await app.inject({ method: 'POST', url: '/api/system/update', cookies: { session_id: authCookie }, payload: { channel: 'stable' } });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /unavailable/);
      assert.equal(require('../server/services/updateRolloutService').getPendingUpdate(), null);
    });

    function fakeUpdater(t, trigger = async () => ({ started: true, mode: 'self', peers: [] })) {
      t.mock.method(updateService, 'getVersionInfo', () => ({ version: pkg.version, canUpdate: true }));
      t.mock.method(updateService, 'getUpdateStatus', () => ({ status: null }));
      t.mock.method(updateService, 'checkForUpdates', async () => ({ channel: 'stable', latest: pkg.version }));
      t.mock.method(updateService, 'triggerUpdate', trigger);
    }

    test('opening progress and checking stable are read-only, even with a saved main channel', async () => {
      updateService.setChannel('main');
      const originalFetch = global.fetch;
      const fetched = [];
      global.fetch = async (url) => {
        fetched.push(String(url));
        return { ok: true, json: async () => [{ name: 'v999.0.0-rc1' }, { name: '999.1.0' }, { name: 'v999.1' }, { name: 'v99.0.0' }] };
      };
      try {
        const progress = await app.inject({ method: 'GET', url: '/api/system/update/propagate', cookies: { session_id: authCookie } });
        assert.equal(progress.json().pendingUpdate, null);
        const res = await app.inject({ method: 'GET', url: '/api/system/updates?force=true&channel=stable', cookies: { session_id: authCookie } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().updates.channel, 'stable');
        assert.equal(res.json().updates.latest, '99.0.0');
        assert.equal(updateService.getChannel(), 'main');
        assert.ok(fetched.every((url) => url.includes('/tags?')));
        assert.equal(require('../server/services/updateRolloutService').getPendingUpdate(), null);
      } finally {
        global.fetch = originalFetch;
        updateService.setChannel('stable');
      }
    });

    test('Update starts only the local canary and persists the audited stable rollout request', async (t) => {
      const rollout = require('../server/services/updateRolloutService');
      const hostService = require('../server/services/hostService');
      updateService.setChannel('main');
      t.mock.method(hostService, 'requestHost', async () => assert.fail('no paired machine may be contacted before restart'));
      let launches = 0;
      fakeUpdater(t, async (options) => {
        launches += 1;
        assert.equal(updateService.getChannel(), 'stable');
        assert.equal(rollout.getPendingUpdate().channel, 'stable');
        assert.equal(rollout.getPendingUpdate().target, pkg.version);
        assert.deepEqual(options, { fanout: false });
        return { started: true, mode: 'self', peers: [] };
      });
      const res = await app.inject({ method: 'POST', url: '/api/system/update', cookies: { session_id: authCookie }, payload: { channel: 'stable' } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().started, true);
      assert.equal(launches, 1);
      const audit = getDatabase().prepare("SELECT details FROM audit_logs WHERE action = 'system_update_triggered' ORDER BY created_at DESC LIMIT 1").get();
      assert.deepEqual(JSON.parse(audit.details), { channel: 'stable', propagated: false, scope: 'paired-machines' });
      const duplicate = await app.inject({ method: 'POST', url: '/api/system/update', cookies: { session_id: authCookie }, payload: { channel: 'stable' } });
      assert.equal(duplicate.statusCode, 409);
      assert.equal(launches, 1);
      const bypass = await app.inject({ method: 'POST', url: '/api/system/update/rollout', cookies: { session_id: authCookie } });
      assert.equal(bypass.statusCode, 409, 'manual rollout must not bypass the local canary');
    });

    test('failed local launch clears the persisted rollout without contacting a peer', async (t) => {
      fakeUpdater(t, async () => { throw new Error('fake updater precheck failed'); });
      const res = await app.inject({ method: 'POST', url: '/api/system/update', cookies: { session_id: authCookie }, payload: { channel: 'stable' } });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /fake updater precheck failed/);
      assert.equal(require('../server/services/updateRolloutService').getPendingUpdate(), null);
    });

    test('a propagated update stays local and cannot cascade', async (t) => {
      fakeUpdater(t, async (options) => {
        assert.deepEqual(options, { fanout: false });
        assert.equal(require('../server/services/updateRolloutService').getPendingUpdate(), null);
        return { started: true };
      });
      const res = await app.inject({ method: 'POST', url: '/api/system/update', cookies: { session_id: authCookie }, payload: { propagated: true, channel: 'stable' } });
      assert.equal(res.statusCode, 200);
      assert.equal(require('../server/services/hostService').readConfig('update.skip_propagation'), '1');
      assert.equal(updateService.checkForUpdates.mock.callCount(), 0);
    });

    test('a stable lookup failure never launches an updater or queues peers', async (t) => {
      fakeUpdater(t);
      t.mock.method(updateService, 'checkForUpdates', async () => ({ error: 'offline' }));
      const res = await app.inject({ method: 'POST', url: '/api/system/update', cookies: { session_id: authCookie }, payload: { channel: 'stable' } });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /offline/);
      assert.equal(updateService.triggerUpdate.mock.callCount(), 0);
      assert.equal(require('../server/services/updateRolloutService').getPendingUpdate(), null);
    });

    test('Update and rollout remain authenticated and admin-only', async (t) => {
      fakeUpdater(t);
      const anonymous = await app.inject({ method: 'POST', url: '/api/system/update', payload: { channel: 'stable' } });
      assert.equal(anonymous.statusCode, 401);
      getDatabase().prepare("UPDATE users SET role = 'user' WHERE username = 'updater'").run();
      try {
        for (const url of ['/api/system/update', '/api/system/update/rollout']) {
          const res = await app.inject({ method: 'POST', url, cookies: { session_id: authCookie }, payload: { channel: 'stable' } });
          assert.equal(res.statusCode, 403);
        }
        assert.equal(updateService.triggerUpdate.mock.callCount(), 0);
        assert.equal(require('../server/services/updateRolloutService').getPendingUpdate(), null);
      } finally {
        getDatabase().prepare("UPDATE users SET role = 'admin' WHERE username = 'updater'").run();
      }
    });
  });
});

describe('Update channel', () => {
  const channelFile = path.join(require('../server/config').DATA_DIR, 'update-channel');
  let previous = null;

  before(() => {
    try { previous = fs.readFileSync(channelFile, 'utf8'); } catch { previous = null; }
  });

  after(() => {
    if (previous === null) fs.rmSync(channelFile, { force: true });
    else fs.writeFileSync(channelFile, previous);
  });

  test('defaults to stable, preserves explicit main and rejects unknown channels', () => {
    fs.rmSync(channelFile, { force: true });
    assert.equal(updateService.getChannel(), 'stable');
    assert.equal(updateService.setChannel('main'), 'main');
    assert.equal(updateService.getChannel(), 'main');
    fs.writeFileSync(channelFile, 'invalid\n');
    assert.equal(updateService.getChannel(), 'stable');
    assert.equal(updateService.setChannel('stable'), 'stable');
    assert.equal(updateService.getChannel(), 'stable');
    assert.equal(updateService.getVersionInfo().channel, 'stable');
    assert.throws(() => updateService.setChannel('nightly'), /Unknown update channel/);
    assert.equal(updateService.getChannel(), 'stable');
  });
});
