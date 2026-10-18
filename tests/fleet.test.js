const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const fleetService = require('../server/services/fleetService');
const { initDatabase, closeDatabase } = require('../server/database/db');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('Fleet service (CRUD + safety)', () => {
  const testDb = path.resolve(__dirname, '../data/test-fleet.db');

  before(() => {
    cleanDb(testDb);
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
  });

  test('normalizeBaseUrl enforces http(s) and strips trailing slashes', () => {
    assert.equal(fleetService.normalizeBaseUrl('vps2.example.com/'), 'https://vps2.example.com');
    assert.equal(fleetService.normalizeBaseUrl('http://1.2.3.4:3000'), 'http://1.2.3.4:3000');
    assert.throws(() => fleetService.normalizeBaseUrl(''), /required/i);
  });

  test('create/list/update/delete never leaks the stored token', () => {
    const host = fleetService.createHost({
      name: 'vps-2',
      baseUrl: 'https://vps2.example.com',
      token: 'secret-token-123',
    });
    assert.ok(host.id);
    assert.equal(host.name, 'vps-2');
    assert.equal(host.baseUrl, 'https://vps2.example.com');
    assert.equal(host.token, undefined);
    assert.equal(host.token_encrypted, undefined);

    assert.ok(fleetService.listHosts().some((h) => h.id === host.id));

    const updated = fleetService.updateHost(host.id, { name: 'vps-2b' });
    assert.equal(updated.name, 'vps-2b');
    assert.equal(updated.baseUrl, 'https://vps2.example.com');

    assert.equal(fleetService.deleteHost(host.id).success, true);
    assert.equal(fleetService.getHost(host.id), null);
  });

  test('remoteRequest rejects paths outside /api', async () => {
    const host = fleetService.createHost({
      name: 'bad-path',
      baseUrl: 'http://127.0.0.1:1',
      token: 'secret-token-123',
    });
    await assert.rejects(
      () => fleetService.remoteRequest(host.id, '/etc/passwd'),
      /not allowed|only \/api/i
    );
    fleetService.deleteHost(host.id);
  });
});

describe('Fleet HTTP routes (auth + forwarding)', () => {
  const testDb = path.resolve(__dirname, '../data/test-fleet-http.db');
  let app;
  let upstream;
  let upstreamUrl;
  let cookie = '';

  before(async () => {
    cleanDb(testDb);

    upstream = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer remote-token-123') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (req.url === '/api/system/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: { version: '0.12.0', commit: 'abc1234' } }));
        return;
      }
      if (req.url === '/api/agents') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: [{ id: 'opencode', installed: false, installCommand: 'x' }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'fleetadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    await new Promise((resolve) => upstream.close(resolve));
    cleanDb(testDb);
  });

  test('fleet routes require a panel session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fleet/hosts' });
    assert.equal(res.statusCode, 401);
  });

  test('rejects an invalid base URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/fleet/hosts',
      headers: { cookie },
      payload: { name: 'bad', baseUrl: 'not a url', token: 'remote-token-123' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('adds a host and forwards status/agents with the stored bearer token', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/api/fleet/hosts',
      headers: { cookie },
      payload: { name: 'remote', baseUrl: upstreamUrl, token: 'remote-token-123' },
    });
    assert.equal(add.statusCode, 200);
    const host = JSON.parse(add.payload).host;
    assert.ok(host.id);

    const status = await app.inject({
      method: 'GET',
      url: `/api/fleet/hosts/${host.id}/status`,
      headers: { cookie },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(JSON.parse(status.payload).version.version, '0.12.0');

    const agents = await app.inject({
      method: 'GET',
      url: `/api/fleet/hosts/${host.id}/agents`,
      headers: { cookie },
    });
    assert.equal(agents.statusCode, 200);
    assert.equal(JSON.parse(agents.payload).agents[0].id, 'opencode');
  });

  test('surfaces the upstream auth failure for a wrong token', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/api/fleet/hosts',
      headers: { cookie },
      payload: { name: 'bad-token', baseUrl: upstreamUrl, token: 'wrong-token-999' },
    });
    const host = JSON.parse(add.payload).host;

    const status = await app.inject({
      method: 'GET',
      url: `/api/fleet/hosts/${host.id}/status`,
      headers: { cookie },
    });
    assert.equal(status.statusCode, 401);
  });
});
