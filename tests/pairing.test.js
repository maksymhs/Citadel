const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const hostService = require('../server/services/hostService');
const connectService = require('../server/services/connectService');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('Peer pairing (invite + accept)', () => {
  const testDb = path.resolve(__dirname, '../data/test-pairing.db');
  let app;
  let cookie;

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'pairadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;
  });

  after(async () => {
    await app.close();
    const { closeDatabase } = require('../server/database/db');
    closeDatabase();
    cleanDb(testDb);
  });

  test('identity is stable and includes candidate URLs', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/host/identity', headers: { cookie } });
    assert.equal(first.statusCode, 200);
    const host = JSON.parse(first.payload).host;
    assert.ok(host.instanceId);
    assert.ok(Array.isArray(host.urls) && host.urls.length > 0);

    const second = await app.inject({ method: 'GET', url: '/api/host/identity', headers: { cookie } });
    assert.equal(JSON.parse(second.payload).host.instanceId, host.instanceId);
  });

  test('an invite is single-use and the handshake pairs both directions', async () => {
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/api/pair/invite',
      headers: { cookie },
      payload: {},
    });
    assert.equal(inviteRes.statusCode, 200);
    const invite = JSON.parse(inviteRes.payload).invite;
    assert.ok(invite.link.includes('#pair='));
    assert.match(invite.qrSvg, /<svg/);
    // The terminal/installer QR uses the compact payload so it fits 80 columns;
    // it still carries everything redeem needs.
    assert.ok(invite.compactLink.includes('#pair='));
    assert.ok(invite.compactLink.length < invite.link.length);
    assert.ok(connectService.qrFits(invite.compactLink));
    const compactPayload = hostService.parsePairingCode(invite.compactLink);
    assert.equal(compactPayload.inviteId, invite.inviteId);
    assert.equal(compactPayload.url, invite.payload.url);
    assert.deepEqual(compactPayload.urls, [invite.payload.url]);

    // Backward-compatibility: legacy hex-formatted v1 links also parse correctly
    const hexLink = `${invite.payload.url}/#pair=v1.${invite.inviteId.replace(/-/g, '')}.${'c'.repeat(48)}`;
    const hexPayload = hostService.parsePairingCode(hexLink);
    assert.equal(hexPayload.inviteId, invite.inviteId);
    assert.equal(hexPayload.secret, 'c'.repeat(48));

    // The link is dual-purpose: a normal camera follows the panel URL, while
    // the fragment carries everything another Citadel needs to pair.
    const identity = JSON.parse((await app.inject({
      method: 'GET', url: '/api/host/identity', headers: { cookie },
    })).payload).host;
    assert.ok(invite.link.startsWith(invite.payload.url));
    assert.equal(invite.payload.instanceId, identity.instanceId);
    assert.equal(invite.payload.url, identity.urls[0] || identity.url);

    // Machine B's identity and the token B will require from A.
    const tokenB = 'b'.repeat(64);
    const peerB = {
      instanceId: 'instance-b-0001',
      name: 'machine-b',
      url: 'http://127.0.0.1:4999',
      urls: ['http://127.0.0.1:4999'],
    };

    const accept = await app.inject({
      method: 'POST',
      url: '/api/pair/accept',
      payload: {
        inviteId: invite.inviteId,
        secret: invite.payload.secret,
        peer: peerB,
        token: tokenB,
      },
    });
    assert.equal(accept.statusCode, 200);
    const accepted = JSON.parse(accept.payload);
    assert.ok(accepted.token && accepted.token.length >= 32);
    assert.equal(accepted.peer.instanceId, (await app.inject({
      method: 'GET', url: '/api/host/identity', headers: { cookie },
    }).then((r) => JSON.parse(r.payload).host.instanceId)));

    // A stores B, including B's inbound token (hashed) for future calls.
    const hostsRes = await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie } });
    const hosts = JSON.parse(hostsRes.payload).hosts;
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].name, 'machine-b');
    assert.equal(hosts[0].instanceId, peerB.instanceId);
    assert.equal(hosts[0].paired, true);

    // The token A returned is accepted as a peer bearer credential for panel
    // APIs, but local management (host identity/pairing) stays session-only.
    const panelWithPeerToken = await app.inject({
      method: 'GET',
      url: '/api/system/version',
      headers: { authorization: `Bearer ${accepted.token}` },
    });
    assert.equal(panelWithPeerToken.statusCode, 200);

    const identityWithPeerToken = await app.inject({
      method: 'GET',
      url: '/api/host/identity',
      headers: { authorization: `Bearer ${accepted.token}` },
    });
    assert.equal(identityWithPeerToken.statusCode, 401);

    // Reusing the same invitation fails.
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/pair/accept',
      payload: {
        inviteId: invite.inviteId,
        secret: invite.payload.secret,
        peer: peerB,
        token: tokenB,
      },
    });
    assert.equal(reuse.statusCode, 400);
  });

  test('announce with a peer token updates the stored addresses', async () => {
    const inviteRes = await app.inject({
      method: 'POST', url: '/api/pair/invite', headers: { cookie }, payload: {},
    });
    const invite = JSON.parse(inviteRes.payload).invite;
    const tokenB = 'c'.repeat(64);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/pair/accept',
      payload: {
        inviteId: invite.inviteId,
        secret: invite.payload.secret,
        peer: {
          instanceId: 'instance-c-0001',
          name: 'machine-c',
          url: 'https://old.trycloudflare.com',
          urls: ['https://old.trycloudflare.com'],
        },
        token: tokenB,
      },
    });
    assert.equal(accept.statusCode, 200);
    const tokenA = JSON.parse(accept.payload).token;

    const announce = await app.inject({
      method: 'POST',
      url: '/api/host/peers/announce',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        instanceId: 'instance-c-0001',
        name: 'machine-c',
        url: 'https://new.trycloudflare.com',
        urls: ['https://new.trycloudflare.com', 'http://127.0.0.1:5000'],
      },
    });
    assert.equal(announce.statusCode, 200);

    const hosts = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts;
    const host = hosts.find((h) => h.instanceId === 'instance-c-0001');
    assert.equal(host.baseUrl, 'https://new.trycloudflare.com');
    assert.ok(host.urls.includes('https://old.trycloudflare.com'));
    assert.ok(host.urls.includes('https://new.trycloudflare.com'));

    // A token may only announce for its own host row.
    const spoof = await app.inject({
      method: 'POST',
      url: '/api/host/peers/announce',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        instanceId: 'instance-b-0001',
        url: 'https://attacker.example.com',
        urls: [],
      },
    });
    assert.equal(spoof.statusCode, 403);
  });

  test('API responses advertise identity headers so peers can heal URLs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/host/identity', headers: { cookie } });
    assert.ok(res.headers['x-citadel-instance']);
    assert.ok(String(res.headers['x-citadel-urls']).length > 0);

    const hostService = require('../server/services/hostService');
    const hosts = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts;
    const peer = hosts.find((h) => h.instanceId === 'instance-c-0001');
    assert.ok(peer);

    hostService.absorbIdentityHeaders(peer.id, {
      'x-citadel-instance': 'instance-c-0001',
      'x-citadel-name': 'machine-c',
      'x-citadel-urls': 'https://rotated.trycloudflare.com http://192.168.1.9:3000',
    });

    const healed = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts.find((h) => h.id === peer.id);
    assert.equal(healed.baseUrl, 'https://rotated.trycloudflare.com');
    assert.ok(healed.urls.includes('http://192.168.1.9:3000'));

    // A mismatched instance id must not be able to rewrite the row.
    hostService.absorbIdentityHeaders(peer.id, {
      'x-citadel-instance': 'someone-else',
      'x-citadel-urls': 'https://evil.example.com',
    });
    const unchanged = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts.find((h) => h.id === peer.id);
    assert.equal(unchanged.baseUrl, 'https://rotated.trycloudflare.com');
  });

  test('a manual address update repairs the row and rejects invalid URLs', async () => {
    const hosts = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts;
    const peer = hosts.find((h) => h.instanceId === 'instance-c-0001');

    const bad = await app.inject({
      method: 'PUT',
      url: `/api/hosts/${peer.id}/address`,
      headers: { cookie },
      payload: { url: 'javascript:alert(1)' },
    });
    assert.equal(bad.statusCode, 400);

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/hosts/${peer.id}/address`,
      headers: { cookie },
      payload: { url: 'https://manual.trycloudflare.com/' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.payload).host.baseUrl, 'https://manual.trycloudflare.com');

    const missing = await app.inject({
      method: 'PUT',
      url: '/api/hosts/does-not-exist/address',
      headers: { cookie },
      payload: { url: 'https://x.example.com' },
    });
    assert.equal(missing.statusCode, 404);
  });

  test('a machine with no peer token cannot call peer endpoints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/host/peers/announce',
      headers: { cookie },
      payload: { instanceId: 'x', url: 'https://x.example.com', urls: [] },
    });
    assert.equal(res.statusCode, 401);
  });

  test('unpair removes the host and revokes its inbound token', async () => {
    const hosts = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts;
    const target = hosts.find((h) => h.instanceId === 'instance-c-0001');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/hosts/${target.id}`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);

    const after = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts;
    assert.equal(after.some((h) => h.id === target.id), false);
  });

  test('unpair still removes a host whose address hangs', async (t) => {
    const hostService = require('../server/services/hostService');
    // Accept the connection but never answer, like a retired tunnel that no
    // longer times out promptly. The local row must still go away quickly.
    const silent = http.createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => {
      if (typeof silent.closeAllConnections === 'function') silent.closeAllConnections();
      silent.close(resolve);
    }));

    const url = `http://127.0.0.1:${silent.address().port}`;
    const host = hostService.upsertPairedHost({
      instanceId: 'instance-offline-0001',
      name: 'offline-machine',
      url,
      urls: [url],
      outboundToken: 'f'.repeat(64),
      inboundToken: 'e'.repeat(64),
    });

    const started = Date.now();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/hosts/${host.id}`,
      headers: { cookie },
    });
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 200);
    assert.ok(elapsed < 6000, `unpair took ${elapsed}ms`);

    const after = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts;
    assert.equal(after.some((h) => h.id === host.id), false);
  });
});

describe('Pairing redeem (scanner side)', () => {
  const testDb = path.resolve(__dirname, '../data/test-pairing-redeem.db');
  let app;
  let cookie;
  let upstream;
  let upstreamUrl;
  let seenAccept = null;
  let seenBearer = null;

  before(async () => {
    cleanDb(testDb);

    upstream = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/pair/accept') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          seenAccept = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            token: 'a'.repeat(64),
            peer: {
              instanceId: 'instance-a-0001',
              name: 'machine-a',
              url: upstreamUrl,
              urls: [upstreamUrl],
            },
          }));
        });
        return;
      }
      seenBearer = req.headers.authorization;
      if (req.url === '/api/system/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: { version: '9.9.9' } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;

    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'scanadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;
  });

  after(async () => {
    await app.close();
    const { closeDatabase } = require('../server/database/db');
    closeDatabase();
    cleanDb(testDb);
    await new Promise((resolve) => upstream.close(resolve));
  });

  test('redeem pairs with the inviting host and returns it', async () => {
    const payload = {
      v: 1,
      instanceId: 'instance-a-0001',
      name: 'machine-a',
      url: upstreamUrl,
      urls: [upstreamUrl],
      inviteId: 'invite-123',
      secret: 'secret-xyz',
    };
    const code = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    const res = await app.inject({
      method: 'POST',
      url: '/api/pair/redeem',
      headers: { cookie },
      payload: { code },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.host.instanceId, 'instance-a-0001');
    assert.equal(body.host.name, 'machine-a');

    // The initiator sent its own identity and a fresh inbound token.
    assert.equal(seenAccept.inviteId, 'invite-123');
    assert.equal(seenAccept.secret, 'secret-xyz');
    assert.equal(seenAccept.peer.name !== undefined, true);
    assert.ok(seenAccept.token && seenAccept.token.length >= 32);

    // The stored outbound token is the one the inviting host returned.
    const hosts = JSON.parse((await app.inject({
      method: 'GET', url: '/api/hosts', headers: { cookie },
    })).payload).hosts;
    assert.equal(hosts.length, 1);

    const version = await app.inject({
      method: 'GET',
      url: `/api/remote/${hosts[0].id}/api/system/version`,
      headers: { cookie },
    });
    assert.equal(version.statusCode, 200);
    assert.equal(JSON.parse(version.payload).version.version, '9.9.9');
    assert.equal(seenBearer, `Bearer ${'a'.repeat(64)}`);
  });

  test('redeem rejects a malformed code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pair/redeem',
      headers: { cookie },
      payload: { code: 'not-a-code' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a host cannot pair with itself', async () => {
    const identity = JSON.parse((await app.inject({
      method: 'GET', url: '/api/host/identity', headers: { cookie },
    })).payload).host;
    const payload = {
      v: 1,
      instanceId: identity.instanceId,
      name: identity.name,
      url: identity.url,
      urls: identity.urls,
      inviteId: 'self',
      secret: 'self',
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/pair/redeem',
      headers: { cookie },
      payload: { code: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') },
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /same host/i);
  });
});

describe('parsePairingCode forms', () => {
  const hostService = require('../server/services/hostService');
  const compact = 'https://abc.trycloudflare.com/#pair=v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  test('accepts full links and the bare pair= fragment', () => {
    assert.equal(hostService.parsePairingCode(compact).url, 'https://abc.trycloudflare.com');
    assert.throws(() => hostService.parsePairingCode('pair=v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), /must include its link address/);
  });

  test('a plain panel address explains how to get a pairing code', () => {
    assert.throws(() => hostService.parsePairingCode('https://abc.trycloudflare.com/'), /Settings → Machines → Show pairing QR/);
  });
});
