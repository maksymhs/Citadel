const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  }
}

describe('Staged update propagation', () => {
  const testDb = path.resolve(__dirname, '../data/test-update-rollout.db');
  let app;
  let hostService;
  let rollout;
  let calls;
  let versions;
  let updateBehaviour;
  const original = {};

  const rows = [
    { id: 'h1', name: 'one', instance_id: 'i1' },
    { id: 'h2', name: 'two', instance_id: 'i2' },
    { id: 'h3', name: 'three', instance_id: 'i3' },
  ];

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    hostService = require('../server/services/hostService');
    rollout = require('../server/services/updateRolloutService');
    original.requestHost = hostService.requestHost;
    original.listHostRows = hostService.listHostRows;
    hostService.listHostRows = () => rows;
    hostService.requestHost = async (id, apiPath, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${id} ${apiPath}`);
      if (apiPath === '/api/system/version') {
        const v = versions[id];
        if (v === 'down') throw new Error('unreachable');
        return { ok: true, status: 200, data: { version: { version: v.version, canUpdate: v.canUpdate !== false, updateProblem: v.problem || null } } };
      }
      if (apiPath === '/api/system/update') {
        const behaviour = updateBehaviour[id] || 'ok';
        if (behaviour === 'ok') versions[id] = { version: '2.0.0' };
        if (behaviour === 'stuck') versions[id] = { version: '1.0.0' };
        return { ok: true, status: 200, data: { started: true } };
      }
      throw new Error(`unexpected ${apiPath}`);
    };
  });

  beforeEach(() => {
    calls = [];
    versions = { h1: { version: '1.0.0' }, h2: { version: '1.0.0' }, h3: { version: '1.0.0' } };
    updateBehaviour = {};
  });

  after(async () => {
    hostService.requestHost = original.requestHost;
    hostService.listHostRows = original.listHostRows;
    await app.close();
    require('../server/database/db').closeDatabase();
    cleanDb(testDb);
  });

  const opts = { target: '2.0.0', pollMs: 1, timeoutMs: 50 };

  test('updates behind machines one at a time and skips up-to-date ones', async () => {
    versions.h2 = { version: '2.0.0' };
    const summary = await rollout.rollout(opts);
    assert.deepEqual(summary.hosts.map((h) => h.status), ['updated', 'up-to-date', 'updated']);
    assert.equal(summary.halted, null);
    const updates = calls.filter((c) => c.includes('/api/system/update'));
    assert.deepEqual(updates, ['POST h1 /api/system/update', 'POST h3 /api/system/update']);
  });

  test('stops at the first machine that does not come back', async () => {
    updateBehaviour.h1 = 'stuck';
    const summary = await rollout.rollout(opts);
    assert.equal(summary.hosts.length, 1);
    assert.equal(summary.hosts[0].status, 'failed');
    assert.match(summary.halted, /one/);
    assert.ok(!calls.some((c) => c.includes('h2') || c.includes('h3')), 'later machines are left untouched');
  });

  test('a machine without a usable updater is skipped, the rollout goes on', async () => {
    versions.h1 = { version: '1.0.0', canUpdate: false, problem: 'not configured' };
    const summary = await rollout.rollout(opts);
    assert.deepEqual(summary.hosts.map((h) => h.status), ['skipped', 'updated', 'updated']);
    assert.match(summary.hosts[0].error, /not configured/);
  });

  test('an unreachable machine halts the rollout', async () => {
    versions.h2 = 'down';
    const summary = await rollout.rollout(opts);
    assert.deepEqual(summary.hosts.map((h) => h.status), ['updated', 'failed']);
    assert.ok(summary.halted);
  });

  test('a forced rollout updates every machine, even one on the same version', async () => {
    const statuses = { h1: { startedAt: 'a' }, h2: { startedAt: 'a' }, h3: { startedAt: 'a' } };
    const base = hostService.requestHost;
    hostService.requestHost = async (id, apiPath, o = {}) => {
      if (apiPath === '/api/system/update/status') {
        return { ok: true, status: 200, data: { update: { status: statuses[id] } } };
      }
      if (apiPath === '/api/system/update') {
        calls.push(`POST ${id} /api/system/update`);
        statuses[id] = { startedAt: 'b', state: 'success' };
        return { ok: true, status: 200, data: { started: true } };
      }
      return base(id, apiPath, o);
    };
    try {
      versions.h2 = { version: '2.0.0' };
      const summary = await rollout.rollout({ ...opts, force: true, timeoutMs: 500 });
      assert.deepEqual(summary.hosts.map((h) => h.status), ['updated', 'updated', 'updated']);
      assert.equal(calls.filter((c) => c.startsWith('POST')).length, 3);
    } finally {
      hostService.requestHost = base;
    }
  });

  test('propagation runs only after an upgrade, when enabled, and not for propagated updates', async () => {
    const { APP_VERSION } = require('../server/config');
    rollout.setPropagationEnabled(false);
    hostService.writeConfig('update.last_version', '0.0.1');
    assert.equal(await rollout.maybePropagateAfterUpdate(), null, 'disabled');

    rollout.setPropagationEnabled(true);
    hostService.writeConfig('update.last_version', APP_VERSION);
    assert.equal(await rollout.maybePropagateAfterUpdate(), null, 'no version change');

    hostService.writeConfig('update.last_version', '0.0.1');
    rollout.markPropagatedUpdate();
    assert.equal(await rollout.maybePropagateAfterUpdate(), null, 'updated by a peer, must not cascade');

    hostService.writeConfig('update.last_version', '0.0.1');
    versions = { h1: { version: APP_VERSION }, h2: { version: APP_VERSION }, h3: { version: APP_VERSION } };
    const summary = await rollout.maybePropagateAfterUpdate();
    assert.ok(summary && summary.hosts.length === 3, 'upgrade with propagation on rolls out');
  });
});
