const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const testRoot = path.resolve(__dirname, '../data/test-missions-http-data');
const workspaceRoot = path.join(testRoot, 'missions');
process.env.DATA_DIR = testRoot;
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
process.env.CITADEL_MISSIONS_DIR = workspaceRoot;
// Mission creation resolves the installed binaries on the server. Keep the test
// independent of the host by reporting the three headless agents as installed.
const agentRegistry = require('../server/services/agentRegistry');
const originalListAgents = agentRegistry.listAgents.bind(agentRegistry);
agentRegistry.listAgents = (options) => originalListAgents(options).map((agent) => (
  ['claude', 'opencode', 'codex'].includes(agent.id)
    ? { ...agent, installed: true, path: '/usr/bin/true', version: 'test' }
    : agent
));

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

const PLAN = {
  tasks: [
    { title: 'Inspect the project', role: 'analyst' },
    { title: 'Verify the result', role: 'qa', deps: [0] },
  ],
};

describe('Mission HTTP routes', () => {
  const testDb = path.resolve(__dirname, '../data/test-missions-http.db');
  let app;
  let adminCookie;
  let missionId;

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'missionadmin', password: 'SuperPassword123!' },
    });
    assert.equal(setup.statusCode, 200);
    adminCookie = setup.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    agentRegistry.listAgents = originalListAgents;
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    delete process.env.CITADEL_MISSIONS_DIR;
  });

  test('mission routes require a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/missions' });
    assert.equal(res.statusCode, 401);
  });

  test('meta exposes roles and headless agents', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/missions/meta', cookies: { session_id: adminCookie } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.roles.some((r) => r.id === 'backend'));
    assert.ok(body.agents.some((a) => a.id === 'claude' && a.installed));
  });

  test('an invalid plan is rejected without creating a mission', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/missions',
      cookies: { session_id: adminCookie },
      payload: { goal: 'Nope', plan: { tasks: [{ title: 'Do it', role: 'wizard' }] } },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(JSON.parse(bad.payload).error, /unknown role/i);

    const list = await app.inject({ method: 'GET', url: '/api/missions', cookies: { session_id: adminCookie } });
    assert.equal(JSON.parse(list.payload).missions.length, 0);
  });

  test('a mission can be created, read, prioritised and noted', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/missions',
      cookies: { session_id: adminCookie },
      payload: { goal: 'Ship the HTTP test', plan: PLAN, title: 'HTTP mission' },
    });
    assert.equal(created.statusCode, 201);
    const detail = JSON.parse(created.payload);
    missionId = detail.mission.id;
    assert.equal(detail.mission.total, 2);
    assert.equal(detail.tasks.filter((t) => t.status === 'queued').length, 1);
    assert.equal(detail.tasks.filter((t) => t.status === 'blocked').length, 1);

    const read = await app.inject({ method: 'GET', url: `/api/missions/${missionId}`, cookies: { session_id: adminCookie } });
    assert.equal(read.statusCode, 200);
    assert.equal(JSON.parse(read.payload).mission.id, missionId);

    const queued = detail.tasks.filter((t) => ['queued', 'blocked'].includes(t.status));
    const reorder = await app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/prioritize`,
      cookies: { session_id: adminCookie },
      payload: { order: [...queued].reverse().map((t) => t.id) },
    });
    assert.equal(reorder.statusCode, 200);

    const note = await app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/notes`,
      cookies: { session_id: adminCookie },
      payload: { text: 'Keep the workspace small.' },
    });
    assert.equal(note.statusCode, 200);

    const decisions = await app.inject({
      method: 'GET',
      url: `/api/missions/${missionId}/file?path=decisions.md`,
      cookies: { session_id: adminCookie },
    });
    assert.equal(decisions.statusCode, 200);
    assert.match(JSON.parse(decisions.payload).file.content, /Keep the workspace small/);
  });

  test('mission file reads reject traversal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/missions/${missionId}/file?path=../citadel.db`,
      cookies: { session_id: adminCookie },
    });
    assert.equal(res.statusCode, 400);
  });

  test('cancelling the mission cancels its tasks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/cancel`,
      cookies: { session_id: adminCookie },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.mission.status, 'cancelled');
    assert.ok(body.tasks.every((t) => t.status === 'cancelled'));
  });
});
