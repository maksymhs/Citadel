const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const testRoot = path.resolve(__dirname, '../data/test-knowledge-http-data');
process.env.DATA_DIR = testRoot;
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
process.env.CITADEL_MISSIONS_DIR = path.join(testRoot, 'missions');
process.env.CITADEL_DOCS_SUBDIR = 'docs';

const agentRegistry = require('../server/services/agentRegistry');
const originalListAgents = agentRegistry.listAgents.bind(agentRegistry);
agentRegistry.listAgents = (options) => originalListAgents(options).map((agent) => (
  ['claude', 'opencode', 'codex'].includes(agent.id) ? { ...agent, installed: true, path: '/usr/bin/true', version: 'test' } : agent
));

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');
const projectService = require('../server/services/projectService');
const taskService = require('../server/services/taskService');

describe('Docs and Learning HTTP routes', () => {
  const testDb = path.resolve(__dirname, '../data/test-knowledge-http.db');
  let app;
  let cookie;
  let project;
  let docPath;

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(testRoot, 'repo'), { recursive: true });
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST', url: '/api/auth/setup',
      payload: { username: 'knowledgeadmin', password: 'SuperPassword123!' },
    });
    cookie = setup.cookies.find((c) => c.name === 'session_id').value;
    project = projectService.importProject({ name: 'Knowledge repo', targetPath: path.join(testRoot, 'repo') });
  });

  after(async () => {
    agentRegistry.listAgents = originalListAgents;
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('docs routes require a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/docs?projectId=${project.id}` });
    assert.equal(res.statusCode, 401);
  });

  test('a page can be created, listed, read and updated', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/docs', cookies: { session_id: cookie },
      payload: { projectId: project.id, path: 'guides/start.md', content: '# Start\n\nHello.\n' },
    });
    assert.equal(created.statusCode, 201, created.payload);
    docPath = JSON.parse(created.payload).doc.path;

    const list = await app.inject({ method: 'GET', url: `/api/docs?projectId=${project.id}`, cookies: { session_id: cookie } });
    assert.equal(list.statusCode, 200);
    assert.ok(JSON.parse(list.payload).docs.some((doc) => doc.path === docPath));

    const read = await app.inject({
      method: 'GET', url: `/api/docs/file?projectId=${project.id}&path=${encodeURIComponent(docPath)}`,
      cookies: { session_id: cookie },
    });
    assert.equal(read.statusCode, 200);
    const doc = JSON.parse(read.payload).doc;
    assert.match(doc.content, /Hello/);

    const updated = await app.inject({
      method: 'PUT', url: '/api/docs', cookies: { session_id: cookie },
      payload: { projectId: project.id, path: docPath, content: '# Start\n\nChanged.\n', expectedUpdatedAt: doc.modifiedAt },
    });
    assert.equal(updated.statusCode, 200);
    assert.match(JSON.parse(updated.payload).doc.content, /Changed/);
  });

  test('docs refuse overwrite and traversal', async () => {
    const duplicate = await app.inject({
      method: 'POST', url: '/api/docs', cookies: { session_id: cookie },
      payload: { projectId: project.id, path: docPath, content: '# No\n' },
    });
    assert.equal(duplicate.statusCode, 400);

    const traversal = await app.inject({
      method: 'GET', url: `/api/docs/file?projectId=${project.id}&path=../citadel.db`,
      cookies: { session_id: cookie },
    });
    assert.equal(traversal.statusCode, 400);
  });

  test('learning rows stay project-scoped until an explicit promotion', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/learning', cookies: { session_id: cookie },
      payload: { projectId: project.id, title: 'Prefer the existing scheduler', rule: 'Do not add a second scheduler.', status: 'confirmed', scope: 'global' },
    });
    assert.equal(created.statusCode, 201);
    let lesson = JSON.parse(created.payload).lesson;
    assert.equal(lesson.scope, 'project');

    const globalBefore = await app.inject({ method: 'GET', url: '/api/learning?scope=global', cookies: { session_id: cookie } });
    assert.equal(JSON.parse(globalBefore.payload).lessons.length, 0);

    const promoted = await app.inject({
      method: 'POST', url: `/api/learning/${lesson.id}/promote`, cookies: { session_id: cookie }, payload: {},
    });
    assert.equal(promoted.statusCode, 200);
    lesson = JSON.parse(promoted.payload).lesson;
    assert.equal(lesson.scope, 'global');

    const globalAfter = await app.inject({ method: 'GET', url: '/api/learning?scope=global', cookies: { session_id: cookie } });
    assert.ok(JSON.parse(globalAfter.payload).lessons.some((l) => l.id === lesson.id));
  });

  test('a correction recorded on a task becomes retrievable project memory', async () => {
    const createdMission = await app.inject({
      method: 'POST', url: '/api/missions', cookies: { session_id: cookie },
      payload: {
        goal: 'Correct the scheduler work',
        projectId: project.id,
        plan: { tasks: [{ title: 'Inspect recovery', role: 'analyst' }] },
      },
    });
    const mission = JSON.parse(createdMission.payload);
    const claim = taskService.claimTask('node-correction');
    assert.equal(claim.missionId, mission.mission.id);
    taskService.completeTask(claim.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken });

    const correction = await app.inject({
      method: 'POST',
      url: `/api/missions/${mission.mission.id}/tasks/${claim.id}/correction`,
      cookies: { session_id: cookie },
      payload: { text: 'Inspect the recovery mechanism before changing it.' },
    });
    assert.equal(correction.statusCode, 200);
    const body = JSON.parse(correction.payload);
    assert.equal(body.lesson.status, 'confirmed');
    assert.equal(body.lesson.source, 'user_correction');

    const learning = await app.inject({
      method: 'GET', url: `/api/learning?projectId=${project.id}`, cookies: { session_id: cookie },
    });
    assert.ok(JSON.parse(learning.payload).lessons.some((l) => l.id === body.lesson.id));
  });
});
