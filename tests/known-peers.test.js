const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  }
}

describe('Peer discovery', () => {
  const testDb = path.resolve(__dirname, '../data/test-known-peers.db');
  let app;
  let hostService;
  let tokenB;
  let hostB;

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    hostService = require('../server/services/hostService');
    tokenB = 'b'.repeat(64);
    hostB = hostService.upsertPairedHost({
      instanceId: 'peer-b', name: 'B', url: 'https://b.example.com',
      outboundToken: 'o'.repeat(40), inboundToken: tokenB,
    });
    hostService.upsertPairedHost({
      instanceId: 'peer-c', name: 'C', url: 'https://c.example.com', urls: ['https://c2.example.com'],
      outboundToken: 'p'.repeat(40), inboundToken: 'c'.repeat(64),
    });
  });

  after(async () => {
    await app.close();
    require('../server/database/db').closeDatabase();
    cleanDb(testDb);
  });

  test('a peer sees the other peers (identity and addresses only), never itself or credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/host/peers/known',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.statusCode, 200);
    const { peers } = JSON.parse(res.payload);
    assert.deepEqual(peers.map((p) => p.instanceId), ['peer-c']);
    assert.deepEqual(peers[0].urls, ['https://c.example.com', 'https://c2.example.com']);
    assert.ok(!JSON.stringify(peers).match(/token|secret/i));
    assert.ok(hostB.id);
  });

  test('discovery requires a peer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/host/peers/known' });
    assert.equal(res.statusCode, 401);
  });
});
