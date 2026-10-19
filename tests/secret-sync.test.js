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
});
