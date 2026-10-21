const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Channel secrets are encrypted with a key kept in DATA_DIR: keep it private to this run.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-secalerts-'));
process.env.DATA_DIR = dataDir;

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');
const monitor = require('../server/services/monitorService');
const alerts = require('../server/services/securityAlertService');
const logService = require('../server/services/logService');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(25);
  }
  return fn();
}

describe('Security alerts', () => {
  const testDb = path.resolve(__dirname, '../data/test-security-alerts.db');
  const received = [];
  let hook;
  let app;
  let cookie;
  const wipe = () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(testDb + s, { force: true }); };
  const login = (remoteAddress, password = 'SuperPassword123!') => app.inject({
    method: 'POST', url: '/api/auth/login', remoteAddress,
    headers: { 'user-agent': 'TestBrowser/1.0' },
    payload: { username: 'alice', password },
  });
  const titles = () => received.map((m) => m.title);

  before(async () => {
    wipe();
    hook = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push(JSON.parse(body)); res.end('ok'); });
    });
    await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', remoteAddress: '10.1.0.1', payload: { username: 'alice', password: 'SuperPassword123!' } });
    cookie = setup.cookies.find((c) => c.name === 'session_id').value;
    monitor.updateConfig({ channels: { webhook: `http://127.0.0.1:${hook.address().port}/hook` } });
    received.length = 0;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    await new Promise((resolve) => hook.close(resolve));
    wipe();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => { received.length = 0; });

  test('security alerts are on by default and shown in the config', () => {
    assert.equal(monitor.getPublicConfig().securityAlerts, true);
  });

  test('a sign-in from a new address alerts once; the first address is just remembered', async () => {
    assert.equal((await login('10.1.0.1')).statusCode, 200);
    await wait(150);
    assert.deepEqual(received, [], 'the first address a user signs in from is not an alert');

    assert.equal((await login('203.0.113.7')).statusCode, 200);
    assert.ok(await waitFor(() => received.length === 1), 'one alert for the new address');
    const alert = received[0];
    assert.equal(alert.title, 'Citadel security: New sign-in location');
    assert.match(alert.message, /"alice" signed in from 203\.0\.113\.7 \(TestBrowser\/1\.0\)/);
    assert.match(alert.message, new RegExp(`\\(${os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$|\\(.+\\)$`), 'names the machine');
    assert.equal(alert.kind, 'security_new_signin');

    await login('203.0.113.7');
    await wait(150);
    assert.equal(received.length, 1, 'the same address again is quiet');
  });

  test('repeated failed sign-ins alert once, not on every attempt', async () => {
    for (let i = 0; i < 7; i += 1) {
      const res = await login('198.51.100.9', `wrong-${i}`);
      assert.equal(res.statusCode, 401);
    }
    assert.ok(await waitFor(() => titles().includes('Citadel security: Repeated failed sign-ins')));
    await wait(150);
    assert.equal(titles().filter((t) => /Repeated failed/.test(t)).length, 1, 'throttled to one alert');
    assert.match(received.find((m) => /Repeated failed/.test(m.title)).message, /198\.51\.100\.9/);
  });

  test('failures spread over many addresses raise a critical alert', async () => {
    const now = 10 * 60 * 1000 * 1000; // a clean window of its own
    for (let ip = 0; ip < 4; ip += 1) {
      for (let n = 0; n < 4; n += 1) await alerts.loginFailed({ ip: `192.0.2.${ip}`, username: 'alice' }, now + n);
    }
    const spread = received.find((m) => /many addresses/.test(m.title));
    assert.ok(spread, 'spread alert sent');
    assert.equal(spread.severity, 'critical');
    // It fires as soon as the threshold (15 failures, 3+ addresses) is reached.
    assert.match(spread.message, /^15 failed sign-ins from 3 different addresses in 10 minutes/);
    assert.equal(received.filter((m) => /many addresses/.test(m.title)).length, 1, 'only once');
  });

  test('pairing, setup and password-reset events are reported with the machine name', async () => {
    await alerts.peerPaired({ name: 'old-laptop', ip: '10.9.9.9' });
    await alerts.setupCodeRotated({ ip: '10.9.9.8' });
    await alerts.passwordReset({ username: 'alice' });
    assert.deepEqual(titles(), [
      'Citadel security: A machine paired with this Citadel',
      'Citadel security: Wrong setup codes',
      'Citadel security: Password reset from the shell',
    ]);
    assert.match(received[0].message, /"old-laptop" paired from 10\.9\.9\.9 and now has administrator access/);
  });

  test('events are written to the activity log under "security"', () => {
    const events = logService.listEvents({ category: 'security', limit: 50 });
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes('security_new_signin'));
    assert.ok(actions.includes('security_peer_paired'));
  });

  test('turning security alerts off stops the push but not the log', async () => {
    const off = await app.inject({ method: 'PUT', url: '/api/monitor/config', cookies: { session_id: cookie }, payload: { securityAlerts: false } });
    assert.equal(off.statusCode, 200);
    assert.equal(JSON.parse(off.payload).config.securityAlerts, false);
    received.length = 0;
    await login('203.0.113.99');
    await alerts.peerPaired({ name: 'quiet', ip: '10.9.9.7' });
    await wait(200);
    assert.deepEqual(received, [], 'nothing pushed');
    assert.ok(logService.listEvents({ category: 'security', limit: 50 }).some((e) => /"quiet" paired/.test(e.message)), 'still logged');

    const on = await app.inject({ method: 'PUT', url: '/api/monitor/config', cookies: { session_id: cookie }, payload: { securityAlerts: true } });
    assert.equal(JSON.parse(on.payload).config.securityAlerts, true);
    assert.equal(JSON.parse(on.payload).config.channels.webhook.set, true, 'channels survive the toggle');
  });
});
