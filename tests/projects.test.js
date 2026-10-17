const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

describe('Project Management API Tests', () => {
  let app;
  let authCookie;
  const testDb = path.resolve(__dirname, '../data/test-projects.db');
  const tempImportDir = path.resolve(__dirname, '../data/temp-import-test');

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
