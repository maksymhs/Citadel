/** GUI Codex setup uses fixed commands, native subscriptions and no credential logs. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createDirectorSetup } = require('../server/services/directorSetup');
function fakeChild() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 99999999; child.kill = () => {}; return child; }
test('missing native executable is reported without asking the user for SSH', async () => {
  const setup = createDirectorSetup({ findBinary: () => null });
  const status = await setup.status(); assert.equal(status.installed, false); assert.equal(status.ready, false);
  assert.throws(() => setup.start('login'), /Install Codex first/);
});
test('GUI install reuses the fixed agent lifecycle rather than client commands', () => {
  let captured; const child = fakeChild();
  const setup = createDirectorSetup({ spawnImpl: (cmd, args) => { captured = { cmd, args }; return child; } });
  try {
    setup.start('install'); assert.equal(captured.cmd, process.execPath);
    assert.deepEqual(captured.args.slice(1), ['install', 'codex']); assert.match(captured.args[0], /manage-agent.js$/);
    assert.throws(() => setup.start('login'), /already running/);
    child.emit('close', 0);
  } finally { setup.close(); }
});
test('device authorization exposes only the official URL and one-time code', async () => {
  const child = fakeChild(); let args;
  const setup = createDirectorSetup({ findBinary: () => '/managed/codex', execImpl: async () => ({ stdout: '', stderr: '' }), spawnImpl: (cmd, argv) => { args = argv; return child; } });
  try {
    setup.start('login');
    child.stdout.emit('data', Buffer.from('Authorize at https://auth.openai.com/codex/device\nABCD-EFGHI\nsecret raw diagnostic'));
    const state = await setup.status();
    assert.deepEqual(args, ['login', '--device-auth']); assert.equal(state.operation.code, 'ABCD-EFGHI');
    assert.equal(state.operation.url, 'https://auth.openai.com/codex/device'); assert.ok(!JSON.stringify(state).includes('secret raw diagnostic'));
    child.emit('close', 0); assert.equal((await setup.status()).operation.code, undefined);
  } finally { setup.close(); }
});
test('stored API-key authorization is not mistaken for the selected ChatGPT subscription', async () => {
  const setup = createDirectorSetup({ findBinary: () => '/managed/codex', execImpl: async (cmd, args) => ({ stdout: args[0] === 'login' ? 'Logged in using an API key' : 'codex 1', stderr: '' }) });
  assert.equal((await setup.status()).connected, false);
});
test('GUI coordinator test makes a bounded real execution request and verifies its output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'director-setup-test-')); let invoked = false;
  const setup = createDirectorSetup({ dataDir: dir, findBinary: () => '/managed/codex', execImpl: async (cmd, args, options) => {
    if (args[0] === 'exec') { invoked = true; assert.equal(options.timeout, 45000); assert.ok(args.includes('read-only')); fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'CITADEL_COORDINATOR_READY'); }
    return { stdout: args[0] === 'login' ? 'Logged in using ChatGPT' : 'codex', stderr: '' };
  } });
  try { assert.equal((await setup.test()).phase, 'done'); assert.equal(invoked, true); }
  finally { setup.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
