// Update-card interaction tests run only the card binder with fake HTTP and
// timers. No browser navigation, updater process, or host data is involved.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-update-panel-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.DATABASE_PATH = path.join(root, 'citadel.db');
process.env.PROJECTS_DIR = path.join(root, 'projects');
process.env.LOGS_DIR = path.join(root, 'logs');
process.env.CITADEL_SELF_UPDATE = '0';
after(() => fs.rmSync(root, { recursive: true, force: true }));

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const binder = source.slice(source.indexOf('  function bindUpdatesCard('), source.indexOf('  // Reload only once'));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function card({ admin = true, canUpdate = true, respond, confirm = () => true } = {}) {
  const elements = Object.fromEntries(['update-status', 'check-updates-btn', 'apply-update-btn', 'update-rollout-status']
    .map((id) => [id, { isConnected: true, disabled: id === 'apply-update-btn' && !canUpdate, style: {}, textContent: '' }]));
  if (!admin) {
    delete elements['apply-update-btn'];
    delete elements['update-rollout-status'];
  }
  const calls = [];
  const timers = new Map();
  const state = { activeHostId: 'local', user: { id: 'admin-one', role: admin ? 'admin' : 'user' } };
  let timerId = 0;
  const context = {
    document: { getElementById: (id) => elements[id] || null },
    state,
    confirm,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    apiForHost: async (host, url, options = {}) => {
      const call = { host, url, ...options };
      calls.push(call);
      if (respond) {
        const response = await respond(call);
        if (response !== undefined) return response;
      }
      if (url.includes('/propagate')) return { pendingUpdate: null, lastRollout: null };
      if (url.includes('/status')) return { update: { status: null } };
      if (url.includes('/updates?')) return { updates: { latest: '9.0.0', updateAvailable: true } };
      return { started: true };
    },
  };
  vm.runInNewContext(`${binder}\nbindUpdatesCard({ canUpdate: ${canUpdate} }, 'Primary');`, context);
  return { elements, calls, timers, state };
}

test('Updates template has only Check and Update, no channel/version or separate rollout selectors', () => {
  assert.ok(!source.includes('id="update-channel"'));
  assert.ok(!source.includes('id="update-rollout-now"'));
  assert.match(source, /id="check-updates-btn">Check<\/button>/);
  assert.match(source, /id="apply-update-btn"[^\n]*>Update<\/button>/);
});

test('opening Updates and pressing Check never mutates a host or changes its channel', async () => {
  const c = card();
  await flush();
  await c.elements['check-updates-btn'].onclick();
  assert.ok(c.calls.every((call) => !call.method || call.method === 'GET'));
  assert.ok(c.calls.some((call) => call.url === '/api/system/updates?force=true&channel=stable'));
  assert.match(c.elements['update-status'].textContent, /Latest stable release: v9\.0\.0/);
});

test('Update needs confirmation and sends a single explicit stable fleet request', async () => {
  const cancelled = card({ confirm: () => false });
  await flush();
  await cancelled.elements['apply-update-btn'].onclick();
  assert.ok(!cancelled.calls.some((call) => call.method === 'POST'));

  let pending = null;
  let confirmation;
  const c = card({
    confirm: (text) => { confirmation = text; return true; },
    respond: async (call) => {
      if (call.method === 'POST') pending = { channel: 'stable', requestedAt: new Date().toISOString() };
      if (call.url.includes('/propagate')) return { pendingUpdate: pending, lastRollout: null };
    },
  });
  await flush();
  await c.elements['apply-update-btn'].onclick();
  await flush();
  const mutations = c.calls.filter((call) => call.method === 'POST');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, '/api/system/update');
  assert.equal(mutations[0].host, 'local');
  assert.equal(mutations[0].body.channel, 'stable');
  assert.match(confirmation, /Primary and all machines paired with it.*latest stable/);
  assert.equal(c.elements['apply-update-btn'].disabled, true);
  assert.match(c.elements['update-rollout-status'].textContent, /healthy restart/);
});

test('non-admins have no mutation controls and unavailable updaters remain disabled', async () => {
  const user = card({ admin: false });
  await flush();
  assert.equal(user.elements['apply-update-btn'], undefined);
  assert.equal(user.calls.length, 0, 'non-admins must not read admin-only update progress');
  await user.elements['check-updates-btn'].onclick();
  assert.equal(user.calls.length, 1);

  const unavailable = card({ canUpdate: false });
  await flush();
  await unavailable.elements['apply-update-btn'].onclick();
  assert.ok(!unavailable.calls.some((call) => call.method === 'POST'));
  assert.equal(unavailable.elements['apply-update-btn'].disabled, true);
});

test('partial rollout outcomes include skipped, failed and untouched machines rather than success', async () => {
  const c = card({ respond: async (call) => call.url.includes('/propagate') ? {
    lastRollout: {
      target: '9.0.0', finishedAt: 'now', halted: 'offline peer; remaining machines were left untouched',
      hosts: [{ name: 'one', status: 'updated' }, { name: 'two', status: 'skipped', error: 'updater unavailable' }, { name: 'three', status: 'failed', error: 'offline' }],
    },
  } : undefined });
  await flush();
  const text = c.elements['update-rollout-status'].textContent;
  assert.match(text, /Partial update/);
  assert.match(text, /one: updated/);
  assert.match(text, /two: skipped \(updater unavailable\)/);
  assert.match(text, /three: failed \(offline\)/);
  assert.match(text, /remaining machines were left untouched/);
});

test('local failures leave peers untouched and permit an explicit retry', async () => {
  const c = card({ respond: async (call) => {
    if (call.url.includes('/propagate')) return { pendingUpdate: { requestedAt: '2026-01-01' } };
    if (call.url.includes('/status')) return { update: { status: { state: 'failed', finishedAt: '2026-01-02', error: 'npm failed' } } };
  } });
  await flush();
  assert.match(c.elements['update-rollout-status'].textContent, /Local update failed: npm failed.*left untouched/);
  assert.equal(c.elements['apply-update-btn'].disabled, false);
  assert.equal(c.timers.size, 0);
});

test('progress remains bound to its original host across a selection change', async () => {
  let finish;
  const c = card({ respond: async (call) => {
    if (call.method === 'POST') return new Promise((resolve) => { finish = resolve; });
  } });
  await flush();
  const updating = c.elements['apply-update-btn'].onclick();
  await flush();
  c.state.activeHostId = 'different-host';
  finish({ started: true });
  await updating;
  assert.ok(c.calls.every((call) => call.host === 'local'));
  assert.equal(c.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(c.timers.size, 0);
});

test('logout, account changes and role changes invalidate a captured Update action', async () => {
  for (const replacement of [null, { id: 'admin-two', role: 'admin' }, { id: 'admin-one', role: 'user' }]) {
    const c = card();
    await flush();
    c.state.user = replacement;
    await c.elements['apply-update-btn'].onclick();
    assert.ok(!c.calls.some((call) => call.method === 'POST'));
  }
  let c;
  c = card({ confirm: () => { c.state.user = null; return true; } });
  await flush();
  await c.elements['apply-update-btn'].onclick();
  assert.ok(!c.calls.some((call) => call.method === 'POST'), 'revalidate identity after confirmation');
});

test('restart/offline errors report unknown completion and retry only read-only progress', async () => {
  let updating = false;
  const c = card({ respond: async (call) => {
    if (call.method === 'POST') updating = true;
    if (updating && call.url.includes('/propagate')) throw new Error('offline');
  } });
  await flush();
  await c.elements['apply-update-btn'].onclick();
  await flush();
  assert.match(c.elements['update-rollout-status'].textContent, /offline.*completion is not confirmed/);
  assert.equal(c.timers.size, 1);
  const [timer] = c.timers.values();
  timer();
  await flush();
  assert.equal(c.calls.filter((call) => call.method === 'POST').length, 1);
  c.elements['update-status'].isConnected = false;
  const count = c.calls.length;
  for (const callback of c.timers.values()) callback();
  await flush();
  assert.equal(c.calls.length, count, 'detached cards stop polling');
});
