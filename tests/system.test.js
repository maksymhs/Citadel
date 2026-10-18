const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');
const auditService = require('../server/services/auditService');

describe('System, Metrics & Audit Trail Tests', () => {
  let app;
  let authCookie;
  const testDb = path.resolve(__dirname, '../data/test-system.db');

  before(async () => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    app = await buildServer({ customDbPath: testDb, logger: false });

    // Setup admin
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'sysadmin', password: 'MasterPassword123!' },
    });
    authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  });

  test('GET /api/system/node returns hardware, memory and active project metrics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/node',
      cookies: { session_id: authCookie },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.node.hostname);
    assert.ok(body.node.platform);
    assert.ok(body.node.cpu.cores >= 1);
    assert.ok(body.node.memory.totalBytes > 0);
  });

  test('GET /api/system/processes returns a limited, well-formed process list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/processes?limit=5',
      cookies: { session_id: authCookie },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    const data = body.processes;
    assert.ok(data);
    assert.ok(Array.isArray(data.processes));
    assert.ok(data.processes.length <= 5);
    assert.ok(data.total >= data.processes.length);
    assert.ok(data.totalMemBytes > 0);

    for (const proc of data.processes) {
      assert.equal(typeof proc.pid, 'number');
      assert.equal(typeof proc.name, 'string');
      assert.equal(typeof proc.cpuPercent, 'number');
      assert.equal(typeof proc.memPercent, 'number');
      assert.equal(typeof proc.rssBytes, 'number');
    }

    // Results must be ordered by descending CPU usage.
    const cpus = data.processes.map((p) => p.cpuPercent);
    const sorted = [...cpus].sort((a, b) => b - a);
    assert.deepEqual(cpus, sorted);
  });

  test('GET /api/system/integrations reports availability of platform dependencies', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/integrations',
      cookies: { session_id: authCookie },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(typeof body.integrations.tmux.available, 'boolean');
    assert.equal(body.integrations.git.available, true);
    assert.equal(body.integrations.caddy.provider, 'caddy');
  });

  test('AuditService redacts sensitive keys and logs actions safely', async () => {
    auditService.logAction({
      userId: 'test-user',
      action: 'sensitive_test_event',
      details: {
        password: 'DO_NOT_STORE_THIS',
        token: 'SECRET_API_TOKEN',
        publicNote: 'Hello VPS',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/audit',
      cookies: { session_id: authCookie },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    const testLog = body.logs.find((l) => l.action === 'sensitive_test_event');
    assert.ok(testLog);
    assert.equal(testLog.details.password, '[REDACTED]');
    assert.equal(testLog.details.token, '[REDACTED]');
    assert.equal(testLog.details.publicNote, 'Hello VPS');
  });

  test('GET / serves index.html with a versioned, no-store asset token', async () => {
    const pkg = require('../package.json');
    const res = await app.inject({ method: 'GET', url: '/' });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    assert.ok(res.payload.includes(`/js/app.js?v=${pkg.version}`));
    assert.ok(res.payload.includes(`/css/app.css?v=${pkg.version}`));
    assert.ok(!res.payload.includes('?v=mobile18'));
  });
});
