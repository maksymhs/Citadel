const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('Remote host proxy', () => {
  const testDb = path.resolve(__dirname, '../data/test-remote-proxy.db');
  let app;
  let cookie;
  let upstream;
  let upstreamUrl;
  let wss;
  let hostId;
  const seen = [];

  before(async () => {
    cleanDb(testDb);

    upstream = http.createServer((req, res) => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        instance: req.headers['x-citadel-instance'],
      });
      res.setHeader('x-citadel-instance', 'instance-remote-1');
      res.setHeader('x-citadel-name', 'remote-1');
      res.setHeader('x-citadel-urls', `${upstreamUrl} https://rotated.example.com`);

      if (req.headers.authorization !== 'Bearer remote-token-abc') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (req.url.startsWith('/api/system/version')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: { version: '7.7.7' } }));
        return;
      }
      if (req.url.startsWith('/api/files/download')) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="x.bin"',
        });
        res.end(Buffer.from([0, 1, 2, 3, 4]));
        return;
      }
      if (req.url.startsWith('/api/projects')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null }));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

    wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (socket, req) => {
      if (req.headers.authorization !== 'Bearer remote-token-abc') {
        socket.close();
        return;
      }
      socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
    });
    upstream.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/ws/terminal/')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'proxyadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;

    const hostService = require('../server/services/hostService');
    const host = hostService.upsertPairedHost({
      instanceId: 'instance-remote-1',
      name: 'remote-1',
      url: upstreamUrl,
      urls: [upstreamUrl],
      outboundToken: 'remote-token-abc',
      inboundToken: 'inbound-token-xyz',
    });
    hostId = host.id;
  });

  after(async () => {
    await app.close();
    const { closeDatabase } = require('../server/database/db');
    closeDatabase();
    cleanDb(testDb);
    await new Promise((resolve) => upstream.close(resolve));
    wss.close();
  });

  test('requires a session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/remote/${hostId}/system/version`,
    });
    assert.equal(res.statusCode, 401);
  });

  test('proxies JSON API calls with the stored peer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/remote/${hostId}/system/version`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).version.version, '7.7.7');
    const call = seen.find((s) => s.url.startsWith('/api/system/version'));
    assert.equal(call.authorization, 'Bearer remote-token-abc');
  });

  test('advertises its identity and absorbs the peer identity headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/remote/${hostId}/system/version`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);

    const call = seen.find((s) => s.url.startsWith('/api/system/version'));
    assert.ok(call.instance, 'outgoing peer calls should advertise our instance id');

    const hostService = require('../server/services/hostService');
    const row = hostService.getHost(hostId);
    assert.ok(row.urls.includes('https://rotated.example.com'));
    assert.equal(row.baseUrl, upstreamUrl);
  });

  test('accepts the literal /api/... path form as well', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/remote/${hostId}/api/system/version`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).version.version, '7.7.7');
  });

  test('forwards the method and JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/remote/${hostId}/projects`,
      headers: { cookie },
      payload: { name: 'from-proxy' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.equal(body.method, 'POST');
    assert.equal(body.body.name, 'from-proxy');
  });

  test('streams binary downloads unchanged', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/remote/${hostId}/files/download?path=%2Ftmp%2Fx.bin`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(res.headers['content-disposition'], /x\.bin/);
    assert.deepEqual([...res.rawPayload], [0, 1, 2, 3, 4]);
  });

  test('refuses to proxy local-only routes', async () => {
    for (const url of ['auth/me', 'pair/invite', 'hosts', 'host/identity']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/remote/${hostId}/${url}`,
        headers: { cookie },
      });
      assert.equal(res.statusCode, 400, `${url} must not be proxied`);
    }
  });

  test('unknown hosts fail cleanly', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/remote/does-not-exist/system/version',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 502);
  });

  test('a peer bearer token can be used by a chained proxy but not for management', async () => {
    const viaPeer = await app.inject({
      method: 'GET',
      url: `/api/remote/${hostId}/system/version`,
      headers: { authorization: 'Bearer inbound-token-xyz' },
    });
    assert.equal(viaPeer.statusCode, 200);

    const manage = await app.inject({
      method: 'GET',
      url: '/api/hosts',
      headers: { authorization: 'Bearer inbound-token-xyz' },
    });
    assert.equal(manage.statusCode, 401);
  });

  test('proxies terminal WebSockets with the stored peer token', async () => {
    const port = app.server.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/remote/${hostId}/terminal/abc`, {
      headers: { cookie },
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
      ws.on('open', () => ws.send('hello'));
      ws.on('message', (data) => {
        clearTimeout(timer);
        try {
          assert.equal(data.toString(), 'echo:hello');
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.close();
  });
});
