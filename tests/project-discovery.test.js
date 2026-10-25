/** Discovery is bounded, read-only, authenticated and never follows directory links. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-discovery-'));
Object.assign(process.env, {
  DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'),
  PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'),
  CITADEL_MISSIONS_DIR: path.join(root, 'missions'),
});
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');
const projects = require('../server/services/projectService');
let app, cookie;

before(async () => {
  app = await buildServer({ logger: false });
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'discovery', password: 'Discovery-password-123' } });
  cookie = res.cookies.find((c) => c.name === 'session_id').value;
});
after(async () => {
  await app.close();
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('discovery returns only immediate unregistered folders without mutating projects', async () => {
  for (const name of ['new folder', '.hidden', 'node_modules', 'registered', 'linked-repo']) fs.mkdirSync(path.join(root, 'projects', name), { recursive: true });
  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'projects', 'symlink'));
  fs.writeFileSync(path.join(root, 'projects', 'file'), 'not a directory');
  const project = projects.importProject({ name: 'Existing', targetPath: path.join(root, 'projects', 'registered') });
  projects.addRepo({ projectId: project.id, targetPath: path.join(root, 'projects', 'linked-repo') });
  assert.equal((await app.inject({ url: '/api/projects/discover' })).statusCode, 401);
  const res = await app.inject({ url: '/api/projects/discover', cookies: { session_id: cookie } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().directories.map((d) => d.name), ['new folder']);
  assert.equal(projects.listProjects().length, 1, 'discovery never imports implicitly');
  assert.equal(res.json().truncated, false);
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', cookies: { session_id: cookie }, payload: { name: 'new folder', targetPath: res.json().directories[0].path } });
  assert.equal(imported.statusCode, 200);
  assert.equal((await projects.discoverProjects()).directories.length, 0, 'registered folders are no longer suggested');
});

test('discovery limits response size in large directories', async () => {
  for (let i = 0; i < 105; i++) fs.mkdirSync(path.join(root, 'projects', `large-${i}`));
  const result = await projects.discoverProjects();
  assert.equal(result.directories.length, 100);
  assert.equal(result.truncated, true);
});
