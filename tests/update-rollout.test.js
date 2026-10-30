const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-update-rollout-'));
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
process.env.CITADEL_UPDATER_PATH = '/nonexistent/citadel-update-test';
process.env.CITADEL_SELF_UPDATE = '0';
after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  }
}

describe('Staged update propagation', () => {
  const testDb = path.join(testRoot, 'rollout.db');
  let app;
  let hostService;
  let rollout;
  let calls;
  let versions;
  let updateBehaviour;
  let targetVersion;
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
        return { ok: true, status: 200, data: { version: { version: v.version, commit: v.commit, canUpdate: v.canUpdate !== false, updateProblem: v.problem || null } } };
      }
      if (apiPath === '/api/system/update/channel') {
        assert.equal(opts.method, 'PUT');
        assert.deepEqual(opts.body, { channel: 'stable' });
        return { ok: true, status: 200, data: { channel: 'stable' } };
      }
      if (apiPath === '/api/system/update') {
        assert.deepEqual(opts.body, { propagated: true });
        const behaviour = updateBehaviour[id] || 'ok';
        if (behaviour === 'ok') versions[id] = { version: targetVersion };
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
    targetVersion = '2.0.0';
    for (const key of ['update.fleet_pending', 'update.skip_propagation', 'update.rollout']) hostService.writeConfig(key, '0');
    fs.rmSync(path.join(process.env.DATA_DIR, 'update-status.json'), { force: true });
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

  test('an explicit stable request persists until restart, then selects stable on every peer in order', async () => {
    const { APP_VERSION } = require('../server/config');
    hostService.writeConfig('update.last_version', APP_VERSION);
    targetVersion = APP_VERSION;
    rollout.requestFleetUpdate({ channel: 'stable', target: APP_VERSION });
    assert.equal(rollout.getPendingUpdate().channel, 'stable');
    assert.equal(calls.length, 0, 'no peer touched before the local restart');
    const summary = await rollout.maybePropagateAfterUpdate({ pollMs: 1, timeoutMs: 100 });
    assert.equal(rollout.getPendingUpdate(), null);
    assert.deepEqual(summary.hosts.map((h) => h.status), ['updated', 'updated', 'updated']);
    assert.deepEqual(calls.filter((c) => c.startsWith('PUT') || c.startsWith('POST')), [
      'PUT h1 /api/system/update/channel', 'POST h1 /api/system/update',
      'PUT h2 /api/system/update/channel', 'POST h2 /api/system/update',
      'PUT h3 /api/system/update/channel', 'POST h3 /api/system/update',
    ]);
  });

  test('a failed local update records the failure and leaves all peers untouched', async () => {
    rollout.requestFleetUpdate({ channel: 'stable' });
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'update-status.json'), JSON.stringify({
      state: 'failed', finishedAt: new Date(Date.now() + 1000).toISOString(), error: 'npm failed',
    }));
    const summary = await rollout.maybePropagateAfterUpdate();
    assert.match(summary.halted, /npm failed.*paired machines were left untouched/);
    assert.equal(rollout.getPendingUpdate(), null);
    assert.equal(calls.length, 0);
  });

  test('a local restart on the wrong stable version is treated as rollback, not rollout success', async () => {
    rollout.requestFleetUpdate({ channel: 'stable', target: '99.0.0' });
    const summary = await rollout.maybePropagateAfterUpdate();
    assert.match(summary.halted, /expected v99\.0\.0.*possibly rolled back/);
    assert.equal(calls.length, 0);
  });

  test('a stale built-in failure does not prevent a later successful helper update', async () => {
    const { APP_VERSION } = require('../server/config');
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'update-status.json'), JSON.stringify({
      state: 'failed', finishedAt: '2000-01-01T00:00:00.000Z', error: 'old failure',
    }));
    targetVersion = APP_VERSION;
    rollout.requestFleetUpdate({ channel: 'stable', target: APP_VERSION });
    const summary = await rollout.maybePropagateAfterUpdate({ pollMs: 1, timeoutMs: 100 });
    assert.equal(summary.halted, null);
    assert.equal(summary.hosts.length, 3);
  });

  test('a peer helper that restarts on the wrong stable release halts the rollout', async () => {
    const base = hostService.requestHost;
    hostService.requestHost = async (id, apiPath, o) => {
      if (apiPath === '/api/system/update') {
        calls.push(`POST ${id} ${apiPath}`);
        versions[id] = { version: '1.0.0', commit: 'rolled-back' };
        return { ok: true, status: 200, data: { started: true } };
      }
      return base(id, apiPath, o);
    };
    try {
      const summary = await rollout.rollout({ ...opts, force: true, channel: 'stable' });
      assert.equal(summary.hosts[0].status, 'failed');
      assert.match(summary.halted, /expected stable v2\.0\.0.*possibly rolled back/);
      assert.ok(!calls.some((c) => c.includes('h2') || c.includes('h3')));
    } finally {
      hostService.requestHost = base;
    }
  });

  test('a channel-selection failure halts before updating the peer or later machines', async () => {
    const base = hostService.requestHost;
    hostService.requestHost = async (id, apiPath, o) => apiPath === '/api/system/update/channel'
      ? { ok: false, status: 403, data: { error: 'Administrator privileges are required.' } }
      : base(id, apiPath, o);
    try {
      const summary = await rollout.rollout({ ...opts, force: true, channel: 'stable' });
      assert.match(summary.halted, /Administrator/);
      assert.ok(!calls.some((c) => c.startsWith('POST') || c.includes('h2') || c.includes('h3')));
    } finally {
      hostService.requestHost = base;
    }
  });

  test('propagation runs only after an upgrade, always on, and not for propagated updates', async () => {
    const { APP_VERSION } = require('../server/config');
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
