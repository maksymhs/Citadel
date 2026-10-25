/** Retiring Hub removes capabilities while preserving core execution and archived data. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-retired-hub-'));
Object.assign(process.env, { DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'), PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'), CITADEL_SELF_UPDATE: '0' });
const { buildServer } = require('../server/index');
const { getDatabase, closeDatabase, runMigrations } = require('../server/database/db');
const tasks = require('../server/services/taskService');
let app, cookies;
before(async () => {
  app = await buildServer({ logger: false });
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'cleanup', password: 'Cleanup-password-123' } });
  cookies = { session_id: setup.cookies.find((c) => c.name === 'session_id').value };
});
after(async () => { await app.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

test('Hub APIs, assets and module are no longer registered', async () => {
  for (const url of ['/api/missions', '/api/missions/meta', '/api/docs', '/api/learning', '/api/projects/x/hub', '/api/projects/x/trace', '/api/projects/x/code-graph', '/js/project-hub.js', '/js/missions.js', '/js/knowledge.js']) {
    assert.equal((await app.inject({ url, cookies })).statusCode, 404, url);
  }
  const res = await app.inject({ url: '/api/modules', cookies });
  assert.equal(res.json().modules.some((module) => module.id === 'missions'), false);
  assert.equal(require('../server/services/taskService').autonomousBudgetStatus, undefined);
});

test('upgrade retires old automatic work without disturbing plain tasks or execution identity', () => {
  const db = getDatabase();
  const plain = tasks.enqueue({ cmd: 'true', title: 'Keep plain work' });
  const oldQueued = tasks.enqueue({ cmd: 'true' });
  const oldRunning = tasks.enqueue({ cmd: 'true', node: 'old-worker' });
  const oldReview = tasks.enqueue({ cmd: 'true' });
  db.prepare("UPDATE tasks SET autonomous = 1, mission_id = 'old-mission' WHERE id IN (?, ?, ?)").run(oldQueued.id, oldRunning.id, oldReview.id);
  db.prepare("UPDATE tasks SET status = 'running', claim_token = 'legacy-token', exec_id = 'legacy-exec', worker_protocol = 2, lease_until = ? WHERE id = ?").run(new Date(Date.now() + 60000).toISOString(), oldRunning.id);
  db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(oldReview.id);
  db.prepare("INSERT INTO documents (id, project_id, path, created_at, updated_at) VALUES ('archive', 'project', 'keep.md', 'now', 'now')").run();
  db.prepare("DELETE FROM schema_migrations WHERE name = '017_retire_project_hub'").run();
  runMigrations(db); runMigrations(db);
  assert.equal(tasks.getTask(oldQueued.id).status, 'cancelled');
  assert.equal(tasks.getTask(oldReview.id).status, 'cancelled');
  assert.equal(tasks.getTask(oldRunning.id).status, 'cancelling');
  assert.equal(db.prepare('SELECT claim_token FROM tasks WHERE id = ?').get(oldRunning.id).claim_token, 'legacy-token');
  assert.equal(tasks.getTask(plain.id).status, 'queued');
  assert.equal(db.prepare("SELECT path FROM documents WHERE id = 'archive'").get().path, 'keep.md');
  assert.equal(tasks.claimTask('worker').id, plain.id);
  db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(oldQueued.id);
  assert.equal(tasks.claimTask('worker'), null, 'retired work is never reclaimed even if requeued');
  assert.equal(tasks.completeTask(oldRunning.id, { status: 'cancelled', claimToken: 'legacy-token', execId: 'legacy-exec' }).status, 'cancelled');
  const current = db.prepare('SELECT claim_token FROM tasks WHERE id = ?').get(plain.id);
  tasks.completeTask(plain.id, { status: 'done', claimToken: current.claim_token });
});

test('plain work still supports retry while obsolete automation cannot be submitted', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: { cmd: 'true', title: 'Retry sample' } });
  assert.equal(res.statusCode, 200);
  const id = res.json().task.id;
  const task = tasks.claimTask('worker');
  assert.equal(task.id, id);
  tasks.completeTask(id, { status: 'failed', claimToken: task.claimToken });
  assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${id}/retry`, cookies })).json().task.status, 'queued');
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: { cmd: 'true', autonomous: true } })).statusCode, 400);
});

test('remote execution control rejects a non-admin session', async () => {
  const db = getDatabase();
  db.prepare("UPDATE users SET role = 'viewer'").run();
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: { cmd: 'true' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/claim', cookies, payload: { node: 'viewer' } })).statusCode, 403);
  } finally { db.prepare("UPDATE users SET role = 'admin'").run(); }
});
