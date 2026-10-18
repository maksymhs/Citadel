const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const testDb = path.resolve(__dirname, '../data/test-hardening.db');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function withConfigEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  const configPath = require.resolve('../server/config');
  delete require.cache[configPath];
  try {
    return fn(require(configPath));
  } finally {
    delete require.cache[configPath];
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('Config validation (fail closed)', () => {
  test('invalid TERMINAL_ADMIN_USER is ignored instead of reaching sudo', () => {
    const cfg = withConfigEnv({ TERMINAL_ADMIN_USER: '-oops evil' }, (c) => c);
    assert.equal(cfg.TERMINAL_ADMIN_USER, null);
  });

  test('valid TERMINAL_ADMIN_USER is accepted', () => {
    const cfg = withConfigEnv({ TERMINAL_ADMIN_USER: 'deploy_user' }, (c) => c);
    assert.equal(cfg.TERMINAL_ADMIN_USER, 'deploy_user');
  });

  test('TRUST_PROXY defaults to loopback and parses explicit values', () => {
    assert.equal(withConfigEnv({ CITADEL_TRUST_PROXY: '' }, (c) => c.TRUST_PROXY), 'loopback');
    assert.equal(withConfigEnv({ CITADEL_TRUST_PROXY: 'false' }, (c) => c.TRUST_PROXY), false);
    assert.equal(withConfigEnv({ CITADEL_TRUST_PROXY: 'true' }, (c) => c.TRUST_PROXY), true);
    assert.equal(withConfigEnv({ CITADEL_TRUST_PROXY: '10.0.0.0/8' }, (c) => c.TRUST_PROXY), '10.0.0.0/8');
  });

  test('CITADEL_NODE_TOKEN is exposed when configured', () => {
    const cfg = withConfigEnv({ CITADEL_NODE_TOKEN: 'node-secret-123' }, (c) => c);
    assert.equal(cfg.NODE_TOKEN, 'node-secret-123');
  });

  test('CITADEL_NODE_TOKENS binds credentials to valid node ids only', () => {
    const cfg = withConfigEnv({
      CITADEL_NODE_TOKENS: 'alpha:alpha-secret-0123456789,beta:short,broken,gamma:gamma-secret-0123456789,bad id:long-enough-secret-123',
    }, (c) => c);
    assert.equal(cfg.NODE_TOKENS.get('alpha'), 'alpha-secret-0123456789');
    assert.equal(cfg.NODE_TOKENS.get('gamma'), 'gamma-secret-0123456789');
    assert.equal(cfg.NODE_TOKENS.has('beta'), false, 'short tokens must be ignored');
    assert.equal(cfg.NODE_TOKENS.has('bad id'), false, 'invalid node ids must be ignored');
    assert.equal(cfg.NODE_TOKENS.size, 2);
  });
});

describe('Updater helper safety', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-updater-'));
  const helper = path.join(tmpDir, 'citadel-update');

  function loadUpdateServiceWithHelper(helperPath) {
    process.env.CITADEL_UPDATER_PATH = helperPath;
    delete require.cache[require.resolve('../server/services/updateService')];
    delete require.cache[require.resolve('../server/config')];
    return require('../server/services/updateService');
  }

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CITADEL_UPDATER_PATH;
    delete require.cache[require.resolve('../server/services/updateService')];
    delete require.cache[require.resolve('../server/config')];
  });

  test('missing helper is reported as not installed', () => {
    const svc = loadUpdateServiceWithHelper(path.join(tmpDir, 'missing'));
    const res = svc.checkUpdaterHelper();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not installed');
  });

  test('group/other-writable helper is rejected', () => {
    fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helper, 0o777);
    const svc = loadUpdateServiceWithHelper(helper);
    const res = svc.checkUpdaterHelper();
    assert.equal(res.ok, false);
    // Unprivileged test runs hit the ownership check first; root hits the mode check.
    assert.match(res.reason, /root|writable/);
  });

  test('a root-owned, non-writable helper passes the safety check', () => {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      // Cannot fabricate a root-owned file unprivileged; the ownership branch is
      // covered above. Skip the positive case honestly.
      return;
    }
    fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helper, 0o755);
    fs.chownSync(helper, 0, 0);
    const svc = loadUpdateServiceWithHelper(helper);
    assert.deepEqual(svc.checkUpdaterHelper(), { ok: true, reason: null });
  });

  test('triggerUpdate refuses an insecure helper before shelling out', async () => {
    fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helper, 0o777);
    const svc = loadUpdateServiceWithHelper(helper);
    await assert.rejects(() => svc.triggerUpdate(), /Refusing to run the updater|not installed/i);
  });
});

describe('Trusted proxy handling', () => {
  let app;
  let adminCookie;

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'hardenadmin', password: 'SuperPassword123!' },
    });
    assert.equal(setup.statusCode, 200);
    adminCookie = setup.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    const { closeDatabase } = require('../server/database/db');
    closeDatabase();
    cleanDb(testDb);
  });

  test('an untrusted client cannot bypass the credential rate limit by spoofing X-Forwarded-For', async () => {
    let last;
    for (let i = 0; i < 9; i += 1) {
      last = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '203.0.113.7',
        headers: { 'x-forwarded-for': `10.0.0.${i + 1}` },
        payload: { username: 'victim', password: `wrong-${i}` },
      });
    }
    assert.equal(last.statusCode, 429);
  });

  test('a trusted loopback proxy still has its forwarded client IP honoured', async () => {
    const failed = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.5' },
      payload: { username: 'behind-proxy', password: 'wrong' },
    });
    assert.equal(failed.statusCode, 401);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=50',
      cookies: { session_id: adminCookie },
    });
    assert.equal(audit.statusCode, 200);
    const logs = JSON.parse(audit.payload).logs;
    const entry = logs.find((l) => l.action === 'login_failed' && l.details && l.details.attemptedUser === 'behind-proxy');
    assert.ok(entry, 'expected a login_failed audit entry');
    assert.equal(entry.ip, '198.51.100.5');
  });
});
