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

describe('Module default seeding', () => {
  const testDb = path.resolve(__dirname, '../data/test-mod-seed.db');

  before(() => cleanDb(testDb));
  after(() => cleanDb(testDb));

  test('a brand-new installation only enables the core modules', () => {
    const { initDatabase, getDatabase, closeDatabase } = require('../server/database/db');
    initDatabase(testDb);
    const db = getDatabase();
    const registry = require('../server/modules/registry');

    const enabled = (id) => db.prepare('SELECT value FROM app_config WHERE key = ?').get(`module.${id}.enabled`).value === '1';
    for (const id of ['dashboard', 'projects', 'workspace', 'activity', 'audit']) {
      assert.equal(enabled(id), true, `${id} should be enabled`);
    }
    for (const id of ['files', 'docker', 'proxy', 'fleet', 'metrics']) {
      assert.equal(enabled(id), false, `${id} should be disabled by default`);
    }
    assert.ok(db.prepare('SELECT value FROM app_config WHERE key = ?').get(registry.SEED_MARKER));
    closeDatabase();
    cleanDb(testDb);
  });

  test('an existing installation keeps every module enabled after re-seeding', () => {
    const { initDatabase, getDatabase, closeDatabase } = require('../server/database/db');
    const registry = require('../server/modules/registry');
    initDatabase(testDb);
    const db = getDatabase();

    // Simulate a pre-registry installation: users exist, no module flags yet.
    db.prepare("DELETE FROM app_config WHERE key LIKE 'module.%' OR key = ?").run(registry.SEED_MARKER);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, salt, role, created_at, updated_at)
      VALUES ('u1', 'legacy', 'x', 'y', 'admin', 'now', 'now')
    `).run();

    const res = registry.seedDefaults(db);
    assert.equal(res.existingInstall, true);

    const rows = db.prepare("SELECT value FROM app_config WHERE key LIKE 'module.%'").all();
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.value === '1'), 'every module stays enabled for existing installs');
    closeDatabase();
    cleanDb(testDb);
  });
});

describe('Module registry HTTP + endpoint gating', () => {
  const testDb = path.resolve(__dirname, '../data/test-modules.db');
  let app;
  let cookie;

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'modadmin', password: 'SuperPassword123!' },
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
    const res = await app.inject({ method: 'GET', url: '/api/modules' });
    assert.equal(res.statusCode, 401);
  });

  test('lists core modules enabled and optional modules disabled by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const { modules } = JSON.parse(res.payload);
    const byId = Object.fromEntries(modules.map((m) => [m.id, m]));
    assert.equal(byId.dashboard.core, true);
    assert.equal(byId.dashboard.enabled, true);
    assert.equal(byId.files.enabled, false);
    assert.ok(Array.isArray(byId.files.views));
    assert.ok('serviceAvailable' in byId.files && 'ready' in byId.files);
    assert.equal(byId.agents, undefined, 'the AI Agents module was removed (installs live in the dashboard)');
  });

  test('a disabled module endpoint is protected with 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/files/capabilities', headers: { cookie } });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.payload).module, 'files');
  });

  test('enabling a module unlocks its endpoint and records an audit entry', async () => {
    const enable = await app.inject({
      method: 'POST',
      url: '/api/modules/files/state',
      headers: { cookie },
      payload: { enabled: true },
    });
    assert.equal(enable.statusCode, 200);

    const res = await app.inject({ method: 'GET', url: '/api/files/capabilities', headers: { cookie } });
    assert.equal(res.statusCode, 200);

    const audit = await app.inject({ method: 'GET', url: '/api/audit?limit=20', headers: { cookie } });
    const actions = JSON.parse(audit.payload).logs.map((l) => l.action);
    assert.ok(actions.includes('module_enabled'));
  });

  test('core modules cannot be disabled', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/modules/dashboard/state',
      headers: { cookie },
      payload: { enabled: false },
    });
    assert.equal(res.statusCode, 400);
  });

  test('enabling a module whose service requirement is absent fails cleanly', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/modules', headers: { cookie } });
    const dockerMod = JSON.parse(list.payload).modules.find((m) => m.id === 'docker');
    const res = await app.inject({
      method: 'POST',
      url: '/api/modules/docker/state',
      headers: { cookie },
      payload: { enabled: true },
    });
    if (dockerMod.serviceAvailable) {
      assert.equal(res.statusCode, 200);
    } else {
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /Docker|not available|unavailable/i);
    }
  });

  test('unknown modules are rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/modules/nope/state',
      headers: { cookie },
      payload: { enabled: true },
    });
    assert.equal(res.statusCode, 404);
  });
});
