const { test, describe, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the sentinel at a fake base URL and an isolated journal before loading.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-sentinel-env-'));
process.env.CITADEL_URL = 'http://sentinel.invalid';
process.env.CITADEL_NODE = 'env-test-node';
process.env.CITADEL_SENTINEL_STATE_DIR = stateDir;
process.env.CITADEL_HTTP_TIMEOUT_MS = '2000';

const sentinel = require('../scripts/sentinel');
const { buildTaskEnv, CITADEL_INTERNAL_SECRETS } = require('../scripts/sentinelEnv');

// Dummy values only: these must never appear in test output or reach a child.
const DUMMY_SECRETS = {
  CITADEL_TOKEN: 'dummy-session-token',
  CITADEL_NODE_TOKEN: 'dummy-node-token',
  CITADEL_NODE_TOKENS: 'vps-1:dummy-node-token-0123',
  CITADEL_PEER_TOKEN: 'dummy-peer-token',
  CITADEL_SECRET_KEY: 'd'.repeat(64),
  SESSION_SECRET: 'dummy-session-secret',
};
const DUMMY_PROVIDER_KEY = 'dummy-anthropic-key';

const savedEnv = {};
for (const key of Object.keys(DUMMY_SECRETS)) savedEnv[key] = process.env[key];

function applySecrets() {
  Object.assign(process.env, DUMMY_SECRETS);
  process.env.ANTHROPIC_API_KEY = DUMMY_PROVIDER_KEY;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.ANTHROPIC_API_KEY;
}

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

// A child that reports only booleans / non-secret markers: the test must never
// print an actual credential value.
const PROBE_SCRIPT = `process.stdout.write(JSON.stringify({
  token: 'CITADEL_TOKEN' in process.env,
  nodeToken: 'CITADEL_NODE_TOKEN' in process.env,
  nodeTokens: 'CITADEL_NODE_TOKENS' in process.env,
  peerToken: 'CITADEL_PEER_TOKEN' in process.env,
  secretKey: 'CITADEL_SECRET_KEY' in process.env,
  sessionSecret: 'SESSION_SECRET' in process.env,
  providerKept: process.env.ANTHROPIC_API_KEY === ${JSON.stringify(DUMMY_PROVIDER_KEY)},
  taskId: process.env.CITADEL_TASK_ID || null,
  execIdOk: typeof process.env.CITADEL_EXEC_ID === 'string' && process.env.CITADEL_EXEC_ID.length > 0,
  taskNode: process.env.CITADEL_TASK_NODE || null,
  pathKept: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
}))`;

after(() => {
  restoreEnv();
  try { sentinel._internals.running.clear(); } catch { /* best effort */ }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

afterEach(() => {
  restoreEnv();
  try { sentinel.journal().clear(); } catch { /* best effort */ }
  sentinel._internals.running.clear();
});

describe('Task child environment (credential isolation)', () => {
  test('the helper strips every internal Citadel secret but keeps runtime vars', () => {
    const env = buildTaskEnv(
      { id: 'task-env-1', projectPath: '/work/proj' },
      'exec-env-1',
      { baseEnv: { ...DUMMY_SECRETS, ANTHROPIC_API_KEY: DUMMY_PROVIDER_KEY, PATH: '/usr/bin', HOME: '/home/u' }, node: 'node-1' },
    );

    for (const key of CITADEL_INTERNAL_SECRETS) {
      assert.equal(Object.prototype.hasOwnProperty.call(env, key), false, `${key} must not be inherited`);
    }
    assert.equal(env.ANTHROPIC_API_KEY, DUMMY_PROVIDER_KEY, 'provider keys are legitimate and preserved');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/u');
    assert.equal(env.CITADEL_TASK_ID, 'task-env-1');
    assert.equal(env.CITADEL_TASK_NODE, 'node-1');
    assert.equal(env.CITADEL_TASK_PROJECT, '/work/proj');
    assert.equal(env.CITADEL_EXEC_ID, 'exec-env-1');
  });

  test('the exported buildEnv also strips the internal secrets', () => {
    applySecrets();
    const env = sentinel.buildEnv({ id: 'task-x', projectPath: '' }, 'exec-x');
    for (const key of CITADEL_INTERNAL_SECRETS) {
      assert.equal(key in env, false, `${key} must not be exported to the child`);
    }
    assert.equal(env.ANTHROPIC_API_KEY, DUMMY_PROVIDER_KEY);
    assert.equal(env.CITADEL_TASK_ID, 'task-x');
    assert.equal(env.CITADEL_EXEC_ID, 'exec-x');
  });

  test('the real runTask spawn path hides the control-plane secrets from the task', async () => {
    applySecrets();
    let resultBody = null;
    let resolveResult;
    const posted = new Promise((resolve) => { resolveResult = resolve; });

    const restore = stubFetch(async (url, options) => {
      const target = String(url);
      if (target.endsWith('/result')) {
        resultBody = JSON.parse(options.body);
        resolveResult();
        return { status: 200, ok: true, text: async () => JSON.stringify({ task: {} }) };
      }
      throw new Error(`unexpected request: ${target}`);
    });

    let entry = null;
    try {
      entry = sentinel.runTask({
        id: 'task-spawn-1',
        cmd: process.execPath,
        args: ['-e', PROBE_SCRIPT],
        claimToken: 'dummy-claim-token',
      });
      await Promise.race([
        posted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('result was never posted')), 8000)),
      ]);

      assert.ok(resultBody, 'the task result must have been reported');
      const probe = JSON.parse(resultBody.result);
      assert.equal(probe.token, false, 'CITADEL_TOKEN must not reach the child');
      assert.equal(probe.nodeToken, false, 'CITADEL_NODE_TOKEN must not reach the child');
      assert.equal(probe.nodeTokens, false, 'CITADEL_NODE_TOKENS must not reach the child');
      assert.equal(probe.peerToken, false, 'CITADEL_PEER_TOKEN must not reach the child');
      assert.equal(probe.secretKey, false, 'CITADEL_SECRET_KEY must not reach the child');
      assert.equal(probe.sessionSecret, false, 'SESSION_SECRET must not reach the child');
      assert.equal(probe.providerKept, true, 'a legitimate provider key must survive');
      assert.equal(probe.pathKept, true, 'PATH must survive');
      assert.equal(probe.taskId, 'task-spawn-1', 'the recovery marker must survive');
      assert.equal(probe.execIdOk, true, 'the exec marker must survive');
      assert.equal(probe.taskNode, 'env-test-node');
    } finally {
      if (entry && entry.child && entry.child.exitCode === null) {
        const exited = new Promise((resolve) => entry.child.once('exit', resolve));
        entry.child.kill('SIGKILL');
        await exited;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      restore();
    }
  });
});
