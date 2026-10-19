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
    assert.deepEqual(ids, ['opencode', 'claude', 'codex']);
    for (const a of agents) {
      assert.equal(typeof a.available, 'boolean');
      assert.ok('version' in a);
    }
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

  test('buildInstallSpec runs the official command as the service user by default', () => {
    const svc = require('../server/services/agentInstallService');
    const agent = svc.getAgent('claude');
    const spec = svc.buildInstallSpec(agent, null);
    assert.equal(spec.command, '/bin/bash');
    assert.equal(spec.args[0], '-lc');
    assert.match(spec.args[1], /claude\.ai\/install\.sh/);
    assert.match(spec.args[1], /exec \/bin\/bash -l/);
  });

  test('buildInstallSpec wraps the command with sudo when an admin user is set', () => {
    const svc = require('../server/services/agentInstallService');
    const spec = svc.buildInstallSpec(svc.getAgent('opencode'), 'deploy');
    assert.equal(spec.command, 'sudo');
    assert.deepEqual(spec.args.slice(0, 5), ['-u', 'deploy', '-H', '/bin/bash', '-lc']);
    assert.match(spec.args[5], /opencode\.ai\/install/);
  });
});
