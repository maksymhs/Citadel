const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('Fleet monitor: health, history, alerts and actions', () => {
  const testDb = path.resolve(__dirname, '../data/test-monitor.db');
  let app;
  let cookie;
  let upstream;
  let upstreamUrl;
  let hookServer;
  let hookUrl;
  let monitor;
  let remoteId;
  const hooks = [];
  // Mutable fake remote machine.
  const remote = { down: false, legacy: false, disk: 40 };
  let realGetHealth;

  before(async () => {
    cleanDb(testDb);
    // Never let the restart endpoint signal the test runner itself.
    process.env.CITADEL_ALLOW_RESTART = '0';

    // The alert tests set thresholds against fake remote machines; this machine's own
    // load, memory and disk must not be able to raise alerts of their own.
    const nodeService = require('../server/services/nodeService');
    realGetHealth = nodeService.getHealth;
    nodeService.getHealth = async function getHealth(...args) {
      const h = await realGetHealth.apply(this, args);
      return {
        ...h,
        loadPerCore: 0.1,
        memory: { ...h.memory, usedPercent: 30 },
        disk: h.disk && { ...h.disk, usedPercent: 40 },
      };
    };

    upstream = http.createServer((req, res) => {
      if (remote.down) {
        req.socket.destroy();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer remote-token-abc') {
        res.writeHead(401);
        res.end('{"error":"Unauthorized"}');
        return;
      }
      if (req.url.startsWith('/api/system/health') && !remote.legacy) {
        res.writeHead(200);
        res.end(JSON.stringify({
          health: {
            hostname: 'nas', cores: 4, loadPerCore: 0.2, uptimeSeconds: 99,
            memory: { usedPercent: 30 }, disk: { usedPercent: remote.disk },
          },
          version: '9.9.9',
          commit: 'abc1234',
        }));
        return;
      }
      if (req.url.startsWith('/api/system/version')) {
        res.writeHead(200);
        res.end(JSON.stringify({ version: { version: '1.2.3' } }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

    hookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hooks.push(JSON.parse(body));
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook?token=secret-token`;

    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'monadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;

    const hostService = require('../server/services/hostService');
    remoteId = hostService.upsertPairedHost({
      instanceId: 'instance-nas',
      name: 'nas',
      url: upstreamUrl,
      urls: [upstreamUrl],
      outboundToken: 'remote-token-abc',
      inboundToken: 'inbound-token-nas',
    }).id;

    monitor = require('../server/services/monitorService');
  });

  after(async () => {
    delete require('../server/services/nodeService').getHealth; // back to the prototype method
    await app.close();
    require('../server/database/db').closeDatabase();
    cleanDb(testDb);
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => hookServer.close(resolve));
  });

  test('GET /api/system/health returns load, memory, disk and uptime', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/health', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.health.cores >= 1);
    assert.ok(body.health.memory.usedPercent >= 0);
    assert.ok(body.health.uptimeSeconds > 0);
    assert.ok(body.version);
    if (body.health.disk) assert.ok(body.health.disk.usedPercent >= 0 && body.health.disk.usedPercent <= 100);
  });

  test('monitor routes require a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/monitor/overview' });
    assert.equal(res.statusCode, 401);
  });

  test('config never returns channel secrets and validates input', async () => {
    const bad = await app.inject({
      method: 'PUT', url: '/api/monitor/config', headers: { cookie }, payload: { channels: { webhook: 'ftp://x' } },
    });
    assert.equal(bad.statusCode, 400);

    const ok = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      headers: { cookie },
      payload: {
        thresholds: { diskPercent: 80 },
        channels: { webhook: hookUrl, telegramToken: '123:SECRET', telegramChatId: '42' },
      },
    });
    assert.equal(ok.statusCode, 200);
    assert.ok(!ok.payload.includes('secret-token'));
    assert.ok(!ok.payload.includes('SECRET'));
    const cfg = JSON.parse(ok.payload).config;
    assert.equal(cfg.thresholds.diskPercent, 80);
    assert.equal(cfg.channels.webhook.set, true);
    assert.equal(cfg.channels.telegram.set, true);

    // Secrets are encrypted at rest.
    const raw = require('../server/database/db').getDatabase()
      .prepare("SELECT value FROM app_config WHERE key = 'monitor.config'").get().value;
    assert.ok(!raw.includes('secret-token'));
    assert.ok(!raw.includes('SECRET'));

    // Omitted secrets are kept; an empty string clears one.
    const keep = await app.inject({
      method: 'PUT', url: '/api/monitor/config', headers: { cookie }, payload: { thresholds: { diskPercent: 85 } },
    });
    assert.equal(JSON.parse(keep.payload).config.channels.webhook.set, true);
    const clear = await app.inject({
      method: 'PUT', url: '/api/monitor/config', headers: { cookie }, payload: { channels: { telegramToken: '' } },
    });
    assert.equal(JSON.parse(clear.payload).config.channels.telegram.set, false);
  });

  test('a poll reports every machine with health, version and uptime', async () => {
    monitor._reset();
    await monitor.pollOnce();
    const res = await app.inject({ method: 'GET', url: '/api/monitor/overview', headers: { cookie } });
    const { hosts, alerts } = JSON.parse(res.payload);
    assert.equal(hosts.length, 2);
    assert.equal(hosts[0].isLocal, true);
    const nas = hosts.find((h) => h.id === remoteId);
    assert.equal(nas.online, true);
    assert.equal(nas.version, '9.9.9');
    assert.equal(nas.health.disk.usedPercent, 40);
    assert.equal(nas.uptime24h, 100);
    assert.equal(alerts.length, 0);
  });

  test('an older machine without /health still counts as online', async () => {
    remote.legacy = true;
    monitor._reset();
    await monitor.pollOnce();
    remote.legacy = false;
    const nas = monitor.getOverview().hosts.find((h) => h.id === remoteId);
    assert.equal(nas.online, true);
    assert.equal(nas.limited, true);
    assert.equal(nas.version, '1.2.3');
  });

  test('disk alert needs consecutive breaches, notifies once and resolves', async () => {
    monitor._reset();
    hooks.length = 0;
    remote.disk = 95;
    await monitor.pollOnce();
    assert.equal(monitor.getOverview().alerts.length, 0, 'one breach is not enough');
    await monitor.pollOnce();
    await monitor.pollOnce();
    const alerts = monitor.getOverview().alerts;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'disk');
    assert.equal(hooks.length, 1, 'notified once, not on every poll');
    assert.equal(hooks[0].state, 'firing');
    assert.match(hooks[0].message, /95%/);

    remote.disk = 40;
    await monitor.pollOnce();
    assert.equal(monitor.getOverview().alerts.length, 0);
    assert.equal(hooks.length, 2);
    assert.equal(hooks[1].state, 'resolved');
  });

  test('offline machine raises a critical alert after repeated failures, then recovers', async () => {
    monitor._reset();
    hooks.length = 0;
    await monitor.pollOnce();
    remote.down = true;
    for (let i = 0; i < monitor.OFFLINE_AFTER_FAILURES; i += 1) await monitor.pollOnce();
    const overview = monitor.getOverview();
    const nas = overview.hosts.find((h) => h.id === remoteId);
    assert.equal(nas.online, false);
    assert.ok(nas.error);
    const alert = overview.alerts.find((a) => a.kind === 'offline');
    assert.equal(alert.severity, 'critical');
    assert.equal(hooks.filter((h) => h.kind === 'offline' && h.state === 'firing').length, 1);

    remote.down = false;
    await monitor.pollOnce();
    assert.equal(monitor.getOverview().alerts.length, 0);
    assert.equal(hooks.filter((h) => h.state === 'resolved').length, 1);
    assert.ok(monitor.getOverview().hosts.find((h) => h.id === remoteId).online);
  });

  test('history returns bucketed points, uptime and the incident trail', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/monitor/hosts/${remoteId}/history?hours=1`, headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.points.length > 0);
    assert.ok(body.uptime < 100, 'the outage lowers uptime');
    assert.ok(body.events.some((e) => e.action === 'alert_offline'));
  });

  test('disabling alerts keeps the live view but sends nothing', async () => {
    await app.inject({ method: 'PUT', url: '/api/monitor/config', headers: { cookie }, payload: { enabled: false } });
    monitor._reset();
    hooks.length = 0;
    remote.disk = 99;
    for (let i = 0; i < 3; i += 1) await monitor.pollOnce();
    remote.disk = 40;
    assert.equal(monitor.getOverview().alerts.length, 0);
    assert.equal(hooks.length, 0);
    assert.equal(monitor.getOverview().hosts.find((h) => h.id === remoteId).online, true);
    await app.inject({ method: 'PUT', url: '/api/monitor/config', headers: { cookie }, payload: { enabled: true } });
  });

  test('POST /api/monitor/test reaches the configured channel', async () => {
    hooks.length = 0;
    const res = await app.inject({ method: 'POST', url: '/api/monitor/test', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.results.every((r) => r.ok));
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].state, 'test');
  });

  test('a paired machine can get a private display name', async () => {
    const put = (name) => app.inject({ method: 'PUT', url: `/api/hosts/${remoteId}/name`, headers: { cookie }, payload: { name } });

    const set = await put('  Home NAS  ');
    assert.equal(set.statusCode, 200);
    const host = JSON.parse(set.payload).host;
    assert.equal(host.name, 'Home NAS');
    assert.equal(host.alias, 'Home NAS');
    assert.equal(host.peerName, 'nas', 'the machine\'s own name is kept');

    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie } })).payload).hosts;
    assert.equal(list.find((h) => h.id === remoteId).name, 'Home NAS');

    monitor._reset();
    await monitor.pollOnce();
    assert.equal(monitor.getOverview().hosts.find((h) => h.id === remoteId).name, 'Home NAS');

    // The peer announcing its own name again must not overwrite the alias.
    const hostService = require('../server/services/hostService');
    hostService.absorbIdentityHeaders(remoteId, {
      'x-citadel-instance': 'instance-nas',
      'x-citadel-name': encodeURIComponent('nas-renamed'),
      'x-citadel-urls': upstreamUrl,
    });
    const after = JSON.parse((await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie } })).payload).hosts.find((h) => h.id === remoteId);
    assert.equal(after.name, 'Home NAS');
    assert.equal(after.peerName, 'nas-renamed');

    const cleared = JSON.parse((await put('')).payload).host;
    assert.equal(cleared.alias, null);
    assert.equal(cleared.name, 'nas-renamed');

    assert.equal((await put('x'.repeat(100))).statusCode, 200);
    const long = JSON.parse((await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie } })).payload).hosts.find((h) => h.id === remoteId);
    assert.equal(long.alias.length, 40);
    await put('');

    const missing = await app.inject({ method: 'PUT', url: '/api/hosts/nope/name', headers: { cookie }, payload: { name: 'a' } });
    assert.equal(missing.statusCode, 404);
    const anon = await app.inject({ method: 'PUT', url: `/api/hosts/${remoteId}/name`, payload: { name: 'a' } });
    assert.equal(anon.statusCode, 401);
  });

  test('unpairing a machine drops it and its alerts', async () => {
    monitor._reset();
    remote.down = true;
    for (let i = 0; i < monitor.OFFLINE_AFTER_FAILURES; i += 1) await monitor.pollOnce();
    assert.equal(monitor.getOverview().alerts.length, 1);
    require('../server/database/db').getDatabase().prepare('DELETE FROM fleet_hosts WHERE id = ?').run(remoteId);
    await monitor.pollOnce();
    remote.down = false;
    assert.equal(monitor.getOverview().alerts.length, 0);
    assert.equal(monitor.getOverview().hosts.length, 1);
  });

  test('GET /api/system/tools lists installed tools with versions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/tools', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const { tools } = JSON.parse(res.payload);
    assert.ok(tools.length > 20);
    const node = tools.find((x) => x.id === 'node');
    assert.equal(node.installed, true);
    assert.match(node.version, /^\d+\.\d+/);
    assert.ok(node.path.endsWith('node'));
    const missing = tools.filter((x) => !x.installed);
    assert.ok(missing.every((x) => x.version === null && x.path === null));
    const unauth = await app.inject({ method: 'GET', url: '/api/system/tools' });
    assert.equal(unauth.statusCode, 401);
  });

  test('log tail and restart are admin actions; restart is inert under test', async () => {
    const logs = await app.inject({ method: 'GET', url: '/api/system/logs?lines=20', headers: { cookie } });
    assert.equal(logs.statusCode, 200);
    assert.ok(['journal', 'file', 'events'].includes(JSON.parse(logs.payload).source));

    const noAuth = await app.inject({ method: 'POST', url: '/api/system/restart' });
    assert.equal(noAuth.statusCode, 401);
    const restart = await app.inject({ method: 'POST', url: '/api/system/restart', headers: { cookie } });
    assert.equal(restart.statusCode, 409);
  });
});
