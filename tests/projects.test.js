const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'citadel-projects-'));
Object.assign(process.env, { DATA_DIR: root, DATABASE_PATH: path.join(root, 'test-projects.db'), PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'), CITADEL_SELF_UPDATE: '0', CITADEL_REQUIRE_SETUP_CODE: '0' });
const terminalManager = require('../server/services/terminalManager');
const editorService = require('../server/services/editorService');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

describe('Project Management API Tests', () => {
  let app;
  let authCookie;
  const testDb = path.join(root, 'test-projects.db');
  const tempImportDir = path.join(root, 'temp-import-test');

  before(async () => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (!fs.existsSync(tempImportDir)) fs.mkdirSync(tempImportDir, { recursive: true });

    app = await buildServer({ customDbPath: testDb, logger: false });

    // Setup admin
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'projectadmin', password: 'SuperPassword123!' },
    });
    authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (fs.existsSync(tempImportDir)) fs.rmSync(tempImportDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('POST /api/projects creates local project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { session_id: authCookie },
      payload: {
        name: 'Alpha Service',
        description: 'Microservice Alpha',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.project.name, 'Alpha Service');
    assert.equal(body.project.slug, 'alpha-service');
    assert.ok(fs.existsSync(body.project.path));
  });

  test('POST /api/projects with duplicate slug fails', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { session_id: authCookie },
      payload: {
        name: 'Alpha Service',
      },
    });
    assert.equal(res.statusCode, 400);
  });

  test('POST /api/projects/import imports existing directory on host', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/import',
      cookies: { session_id: authCookie },
      payload: {
        name: 'Imported App',
        targetPath: tempImportDir,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.project.name, 'Imported App');
    assert.equal(body.project.path, fs.realpathSync(tempImportDir));
  });

  test('GET /api/projects lists registered projects', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { session_id: authCookie },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.projects.length, 2);
  });

  test('removal rejects live terminals and shared editor before touching records or files', async (t) => {
    const project = require('../server/services/projectService').listProjects().find(p => p.slug === 'alpha-service');
    const originalSessions = terminalManager.listSessions;
    const originalStatus = editorService.status;
    t.after(() => { terminalManager.listSessions = originalSessions; editorService.status = originalStatus; });
    editorService.status = () => ({ running: false });
    terminalManager.listSessions = id => { assert.equal(id, project.id); return [{ isAlive: true, status: 'closed' }]; };
    for (const deleteFiles of [false, true]) {
      const res = await app.inject({ method: 'DELETE', url: `/api/projects/${project.slug}?deleteFiles=${deleteFiles}`, cookies: { session_id: authCookie } });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /live terminals/);
      assert.ok(require('../server/services/projectService').getProject(project.id));
      assert.ok(fs.existsSync(project.path));
    }
    terminalManager.listSessions = () => [];
    editorService.status = () => ({ running: true });
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /shared editor/);
    assert.ok(require('../server/services/projectService').getProject(project.id));
    assert.ok(fs.existsSync(project.path));
  });

  test('removal uses canonical project id inside the Chat exclusion boundary', async (t) => {
    const chat = require('../server/services/chatService');
    const original = chat.withProjectRemoval;
    t.after(() => { chat.withProjectRemoval = original; });
    const project = require('../server/services/projectService').listProjects().find(p => p.slug === 'alpha-service');
    chat.withProjectRemoval = async id => {
      assert.equal(id, project.id);
      throw Object.assign(new Error('Project has a running Chat engine. Stop it before removal.'), { statusCode: 409 });
    };
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${project.slug}?deleteFiles=true`, cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /running Chat/);
    assert.ok(require('../server/services/projectService').getProject(project.id));
    assert.ok(fs.existsSync(project.path));
  });

  test('DELETE /api/projects/:id preserves files on disk by default', async () => {
    // Get list
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { session_id: authCookie },
    });
    const project = JSON.parse(listRes.payload).projects.find((p) => p.slug === 'alpha-service');

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      cookies: { session_id: authCookie },
    });
    assert.equal(delRes.statusCode, 200);

    // Verify removed from DB
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}`,
      cookies: { session_id: authCookie },
    });
    assert.equal(getRes.statusCode, 404);

    // Verify files still exist on disk (crucial safety requirement!)
    assert.ok(fs.existsSync(project.path));

    // Cleanup test project folder
    fs.rmSync(project.path, { recursive: true, force: true });
  });
});
