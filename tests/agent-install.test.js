const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('AI coding agent install integrations', () => {
  const testDb = path.resolve(__dirname, '../data/test-agent-install.db');
  let app;
  let cookie;

  before(async () => {
    cleanDb(testDb);
    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'intadmin', password: 'SuperPassword123!' },
    });
    cookie = `session_id=${setup.cookies[0].value}`;
  });

  after(async () => {
    await app.close();
    const { closeDatabase } = require('../server/database/db');
    closeDatabase();
    cleanDb(testDb);
  });

  test('integrations report the supported agents', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/integrations', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const { agents } = JSON.parse(res.payload).integrations;
    assert.ok(Array.isArray(agents));
    const ids = agents.map((a) => a.id);
    assert.deepEqual(ids, ['opencode', 'claude', 'codex', 'antigravity']);
    for (const a of agents) {
      assert.equal(typeof a.available, 'boolean');
      assert.ok('version' in a);
    }
  });

  test('dashboard and agents API share one catalogue', () => {
    const svc = require('../server/services/agentInstallService');
    const agentRegistry = require('../server/services/agentRegistry');
    for (const id of ['opencode', 'claude', 'codex', 'antigravity']) {
      assert.equal(svc.getAgent(id), agentRegistry.builtinAgents.find((a) => a.id === id));
    }
    assert.equal(svc.getAgent('antigravity').binaryName, 'agy');
    assert.match(svc.getAgent('antigravity').installCommand, /antigravity\.google\/cli\/install\.sh/);
  });

  test('rejects an unknown tool', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/integrations/install',
      headers: { cookie },
      payload: { tool: 'rm-rf' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('installing runs the shared installer as the service user, never through sudo', () => {
    const terminalManager = require('../server/services/terminalManager');
    const agentRegistry = require('../server/services/agentRegistry');
    const svc = require('../server/services/agentInstallService');
    const calls = [];
    const original = terminalManager.createSession;
    const originalGet = agentRegistry.getAgent;
    terminalManager.createSession = (opts) => {
      calls.push(opts);
      return { sessionId: 'fake-session' };
    };
    agentRegistry.getAgent = (id) => ({ ...agentRegistry.builtinAgents.find((a) => a.id === id), installed: false });
    try {
      const res = svc.installAgent('codex');
      assert.equal(res.session.sessionId, 'fake-session');
    } finally {
      terminalManager.createSession = original;
      agentRegistry.getAgent = originalGet;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/bin/bash');
    assert.equal(calls[0].args[0], '-lc');
    const script = calls[0].args[1];
    assert.match(script, /npm install -g --prefix "\$HOME\/\.local" @openai\/codex/);
    assert.match(script, /exec \/bin\/bash -l$/);
    assert.doesNotMatch(script, /\bsudo\b/);
  });

  test('rejects installing a tool outside the built-in catalogue', () => {
    const svc = require('../server/services/agentInstallService');
    assert.throws(() => svc.installAgent('rm-rf'), /Unknown tool/);
  });
});
