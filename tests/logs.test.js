const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const logService = require('../server/services/logService');
const taskService = require('../server/services/taskService');
const { initDatabase, closeDatabase } = require('../server/database/db');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('Log service (events + metric samples)', () => {
  const testDb = path.resolve(__dirname, '../data/test-logs.db');

  before(() => {
    cleanDb(testDb);
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
  });

  test('records an event and reads it back', () => {
    logService.record({ level: 'info', category: 'system', action: 'boot', message: 'Hello' });
    const events = logService.listEvents({ category: 'system' });
    assert.ok(events.length >= 1);
    assert.equal(events[0].message, 'Hello');
    assert.equal(events[0].action, 'boot');
  });

  test('redacts sensitive keys in details', () => {
    logService.record({
      category: 'system',
      action: 'secret',
      details: { token: 'abc123', password: 'p', keep: 'visible' },
    });
    const [event] = logService.listEvents({ action: 'secret' });
    assert.equal(event.details.token, '[REDACTED]');
    assert.equal(event.details.password, '[REDACTED]');
    assert.equal(event.details.keep, 'visible');
  });

  test('normalises unknown levels to info and filters by level', () => {
    logService.record({ level: 'nonsense', category: 'system', action: 'lvl' });
    const [event] = logService.listEvents({ level: 'info', limit: 1 });
    assert.equal(event.action, 'lvl');
    assert.equal(event.level, 'info');
  });

  test('inserts and lists metric samples, and summarises peaks', () => {
    logService.insertSample({ host: 'h1', load1: 0.5, load5: 0.4, load15: 0.3, cpuCores: 4, memUsedPercent: 20, memFreeMB: 800, memTotalMB: 1000, activeTerminals: 1, tasksRunning: 0 });
    logService.insertSample({ host: 'h1', load1: 2.5, memUsedPercent: 75, cpuCores: 4 });
    const metrics = logService.listMetrics({ host: 'h1' });
    assert.equal(metrics.length, 2);
    // Oldest first.
    assert.equal(metrics[0].load1, 0.5);
    assert.equal(metrics[1].memUsedPercent, 75);

    const summary = logService.summary();
    assert.equal(summary.peakLoad, 2.5);
    assert.equal(summary.peakMemPercent, 75);
  });

  test('sampleOnce records a local resource sample', async () => {
    await logService.sampleOnce();
    const metrics = logService.listMetrics({ limit: 1 });
    assert.ok(metrics.length >= 1);
    assert.ok(metrics[metrics.length - 1].cpuCores > 0);
  });

  test('toCsv escapes commas, quotes and newlines', () => {
    const csv = logService.toCsv([{ a: 'x,y', b: 'he"llo', c: null }]);
    const [, row] = csv.split('\n');
    assert.equal(row, '"x,y","he""llo",');
  });

  test('task lifecycle emits trace events', () => {
    const task = taskService.enqueue({ cmd: 'echo', node: 'n-logs' });
    const claim = taskService.claimTask('n-logs');
    taskService.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken });

    const lifecycle = logService.listEvents({ category: 'task', taskId: task.id });
    const actions = lifecycle.map((e) => e.action);
    assert.ok(actions.includes('task_enqueued'));
    assert.ok(actions.includes('task_claimed'));
    assert.ok(actions.includes('task_completed'));
  });
});

describe('Log HTTP routes', () => {
  const testDb = path.resolve(__dirname, '../data/test-logs-http.db');
  let app;
  let cookie;

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'logadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;
    // Advanced metrics are an optional module, disabled by default on new installs.
    const enable = await app.inject({
      method: 'POST',
      url: '/api/modules/metrics/state',
      headers: { cookie },
      payload: { enabled: true },
    });
    assert.equal(enable.statusCode, 200);
  });

  after(async () => {
    await app.close();
    closeDatabase();
    cleanDb(testDb);
  });

  test('log routes require a session', async () => {
    for (const url of ['/api/logs/events', '/api/logs/metrics', '/api/logs/summary', '/api/logs/export']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, `${url} should be protected`);
    }
  });

  test('events, metrics and summary are retrievable', async () => {
    const events = await app.inject({ method: 'GET', url: '/api/logs/events?category=system', headers: { cookie } });
    assert.equal(events.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(events.payload).events));

    const metrics = await app.inject({ method: 'GET', url: '/api/logs/metrics', headers: { cookie } });
    assert.equal(metrics.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(metrics.payload).metrics));

    const summary = await app.inject({ method: 'GET', url: '/api/logs/summary', headers: { cookie } });
    assert.equal(summary.statusCode, 200);
    assert.ok(JSON.parse(summary.payload).summary);
  });

  test('export returns a downloadable JSON and CSV payload', async () => {
    const json = await app.inject({ method: 'GET', url: '/api/logs/export?type=events&format=json', headers: { cookie } });
    assert.equal(json.statusCode, 200);
    assert.match(json.headers['content-disposition'], /attachment; filename="citadel-events-.*\.json"/);
    assert.ok(JSON.parse(json.payload).exportedAt);

    const csv = await app.inject({ method: 'GET', url: '/api/logs/export?type=metrics&format=csv', headers: { cookie } });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /attachment; filename="citadel-metrics-.*\.csv"/);
  });
});
