const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');
const secretStore = require('../server/services/secretStore');
const secretSyncService = require('../server/services/secretSyncService');
const hostService = require('../server/services/hostService');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('Credential vault sync', () => {
  const testDb = path.resolve(__dirname, '../data/test-secret-sync.db');
  let app;
  let cookie;

  before(async () => {
    cleanDb(testDb);
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'syncadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    cleanDb(testDb);
  });

  test('import merges the newest value and skips invalid or older entries', () => {
    secretStore.setSecret('EXISTING', 'old-value', { kind: 'env' });
    secretStore.setSecret('LOCAL_ONLY', 'local-value', { kind: 'env' });

    const newer = new Date(Date.now() + 120000).toISOString();
    const result = secretSyncService.importSecrets([
      { name: 'EXISTING', value: 'new-value', kind: 'env', updated_at: newer },
      { name: 'ADDED', value: 'added-value', kind: 'env', updated_at: '2000-01-01T00:00:00.000Z' },
      { name: 'ADDED', value: 'stale-value', kind: 'env', updated_at: '1999-01-01T00:00:00.000Z' },
      { name: '', value: 'x', kind: 'env' },
      { name: 'TOO_BIG', value: 'x'.repeat(300000), kind: 'env' },
      { name: 'BAD_KIND', value: 'x', kind: 'nope' },
    ]);

    assert.equal(result.imported, 2);
    assert.equal(result.invalid, 3);
    assert.equal(secretStore.getValue('EXISTING'), 'new-value');
    assert.equal(secretStore.getValue('ADDED'), 'added-value');
    assert.equal(secretStore.getValue('LOCAL_ONLY'), 'local-value');

    // An older value never overwrites a local one.
    const stale = secretSyncService.importSecrets([
      { name: 'EXISTING', value: 'older-value', kind: 'env', updated_at: '2000-01-01T00:00:00.000Z' },
      { name: 'EXISTING', value: 'new-value', kind: 'env', updated_at: newer },
    ]);
    assert.equal(stale.skipped, 2);
    assert.equal(secretStore.getValue('EXISTING'), 'new-value');

    const exported = secretStore.exportSecrets();
    assert.ok(exported.some((s) => s.name === 'EXISTING' && s.value === 'new-value'));
  });

  test('peer sync endpoint requires a peer token and merges both vaults', async () => {
    secretStore.setSecret('PEER_SHARED', 'local-value', { kind: 'env' });

    const denied = await app.inject({
      method: 'POST',
      url: '/api/host/peers/secrets/sync',
      payload: { secrets: [] },
    });
    assert.equal(denied.statusCode, 401);

    const sessionDenied = await app.inject({
      method: 'POST',
      url: '/api/host/peers/secrets/sync',
      headers: { cookie },
      payload: { secrets: [] },
    });
    assert.equal(sessionDenied.statusCode, 401);

    const invite = JSON.parse((await app.inject({
      method: 'POST', url: '/api/pair/invite', headers: { cookie }, payload: {},
    })).payload).invite;
    const accepted = JSON.parse((await app.inject({
      method: 'POST',
      url: '/api/pair/accept',
      payload: {
        inviteId: invite.inviteId,
        secret: invite.payload.secret,
        peer: {
          instanceId: 'instance-sync-b',
          name: 'sync-b',
          url: 'http://127.0.0.1:4999',
          urls: ['http://127.0.0.1:4999'],
        },
        token: 'b'.repeat(64),
      },
    })).payload);
    const tokenA = accepted.token;

    const sync = await app.inject({
      method: 'POST',
      url: '/api/host/peers/secrets/sync',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        secrets: [{
          name: 'FROM_B', value: 'b-value', kind: 'env', updated_at: new Date().toISOString(),
        }],
      },
    });
    assert.equal(sync.statusCode, 200);
    const body = JSON.parse(sync.payload);
    assert.equal(body.imported, 1);
    assert.ok(body.secrets.some((s) => s.name === 'PEER_SHARED'));
    assert.ok(body.secrets.some((s) => s.name === 'FROM_B'));
    assert.equal(secretStore.getValue('FROM_B'), 'b-value');

    const list = JSON.parse((await app.inject({
      method: 'GET', url: '/api/secrets', headers: { cookie },
    })).payload).secrets;
    const fromB = list.find((s) => s.name === 'FROM_B');
    assert.ok(fromB);
    assert.equal(fromB.value, undefined);
  });

  test('syncWithHost pushes local secrets and imports the peer response', async (t) => {
    let seenAuth = null;
    let seenBody = null;
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/host/peers/secrets/sync') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          seenAuth = req.headers.authorization;
          seenBody = JSON.parse(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            imported: 1,
            skipped: 0,
            invalid: 0,
            secrets: [{
              name: 'REMOTE_TOKEN',
              value: 'remote-secret',
              kind: 'env',
              metadata: null,
              updated_at: '2000-01-01T00:00:00.000Z',
            }],
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(upstream);
    t.after(() => new Promise((resolve) => upstream.close(resolve)));

    secretStore.setSecret('LOCAL_PUSH', 'push-value', { kind: 'env' });
    const host = hostService.upsertPairedHost({
      instanceId: 'instance-remote-sync',
      name: 'remote-sync',
      url: `http://127.0.0.1:${port}`,
      urls: [`http://127.0.0.1:${port}`],
      outboundToken: 'a'.repeat(64),
      inboundToken: 'c'.repeat(64),
    });

    const result = await secretSyncService.syncWithHost(host.id);
    assert.equal(result.ok, true);
    assert.equal(result.imported, 1);
    assert.equal(result.remoteImported, 1);
    assert.equal(seenAuth, `Bearer ${'a'.repeat(64)}`);
    assert.ok(seenBody.secrets.some((s) => s.name === 'LOCAL_PUSH'));
    assert.equal(secretStore.getValue('REMOTE_TOKEN'), 'remote-secret');
  });

  test('redeem auto-merges the vault when the invite came from Settings', async (t) => {
    let syncCalls = 0;
    let seenAccept = null;
    let upstreamUrl = null;
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/pair/accept') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          seenAccept = JSON.parse(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            token: 'a'.repeat(64),
            peer: {
              instanceId: 'instance-auto-sync',
              name: 'auto-sync-peer',
              url: upstreamUrl,
              urls: [upstreamUrl],
            },
            autoSync: true,
          }));
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/host/peers/secrets/sync') {
        syncCalls += 1;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            imported: 0,
            skipped: 0,
            invalid: 0,
            secrets: [{
              name: 'AUTO_FROM_PEER',
              value: 'peer-value',
              kind: 'env',
              metadata: null,
              updated_at: new Date().toISOString(),
            }],
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await listen(upstream);
    upstreamUrl = `http://127.0.0.1:${port}`;
    t.after(() => new Promise((resolve) => upstream.close(resolve)));

    const payload = {
      v: 1,
      instanceId: 'instance-auto-sync',
      name: 'auto-sync-peer',
      url: upstreamUrl,
      urls: [upstreamUrl],
      inviteId: 'invite-auto-sync',
      secret: 'secret-auto-sync',
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
    assert.equal(seenAccept.inviteId, 'invite-auto-sync');
    assert.equal(body.secrets.ok, true);
    assert.equal(syncCalls, 1);
    assert.equal(secretStore.getValue('AUTO_FROM_PEER'), 'peer-value');
  });

  test('redeem always attempts the vault merge, even for an installer invite', async (t) => {
    let syncCalls = 0;
    let upstreamUrl = null;
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/pair/accept') {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            token: 'a'.repeat(64),
            peer: {
              instanceId: 'instance-installer-sync',
              name: 'installer-peer',
              url: upstreamUrl,
              urls: [upstreamUrl],
            },
            autoSync: false,
          }));
        });
        return;
      }
      if (req.url === '/api/host/peers/secrets/sync') syncCalls += 1;
      res.writeHead(404);
      res.end();
    });
    const port = await listen(upstream);
    upstreamUrl = `http://127.0.0.1:${port}`;
    t.after(() => new Promise((resolve) => upstream.close(resolve)));

    const payload = {
      v: 1,
      instanceId: 'instance-installer-sync',
      name: 'installer-peer',
      url: upstreamUrl,
      urls: [upstreamUrl],
      inviteId: 'invite-installer-sync',
      secret: 'secret-installer-sync',
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
    assert.equal(syncCalls, 1);
    // The upstream stub has no sync endpoint, so the attempt is reported, not fatal.
    assert.equal(body.secrets.ok, false);
  });
});

describe('Credential vault deletions', () => {
  const testDb = path.resolve(__dirname, '../data/test-secret-tombstones.db');
  let app;

  before(async () => {
    cleanDb(testDb);
    app = await buildServer({ customDbPath: testDb, logger: false });
  });

  after(async () => {
    await app.close();
    closeDatabase();
    cleanDb(testDb);
  });

  test('a deletion propagates, and an older copy from a peer does not resurrect it', () => {
    secretStore.setSecret('GONE_TOKEN', 'v1', { kind: 'env' });
    const old = secretStore.getSecret('GONE_TOKEN').updated_at;

    const future = new Date(Date.now() + 60000).toISOString();
    const result = secretSyncService.importSecrets([], [{ name: 'GONE_TOKEN', deleted_at: future }]);
    assert.equal(result.removed, 1);
    assert.equal(secretStore.getSecret('GONE_TOKEN'), null);

    const again = secretSyncService.importSecrets([
      { name: 'GONE_TOKEN', value: 'v1', kind: 'env', updated_at: old },
    ]);
    assert.equal(again.imported, 0);
    assert.equal(secretStore.getSecret('GONE_TOKEN'), null);
  });

  test('a value saved after the deletion survives it and is shared back', () => {
    secretStore.setSecret('KEPT_TOKEN', 'v1', { kind: 'env' });
    secretStore.removeSecret('KEPT_TOKEN');
    assert.ok(secretStore.getTombstone('KEPT_TOKEN'));
    secretStore.setSecret('KEPT_TOKEN', 'v2', { kind: 'env' });
    assert.equal(secretStore.getTombstone('KEPT_TOKEN'), null);

    const stale = new Date(Date.now() - 60000).toISOString();
    const result = secretSyncService.importSecrets([], [{ name: 'KEPT_TOKEN', deleted_at: stale }]);
    assert.equal(result.removed, 0);
    assert.equal(secretStore.getSecret('KEPT_TOKEN').value, 'v2');
  });

  test('removeSecret records a tombstone that is exported to peers', () => {
    secretStore.setSecret('EXPORT_ME', 'x', { kind: 'env' });
    secretStore.removeSecret('EXPORT_ME');
    assert.ok(secretSyncService.exportDeleted().some((d) => d.name === 'EXPORT_ME'));
  });
});
