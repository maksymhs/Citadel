/** Project hub scoping, trace pagination/redaction and non-executing code graph. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-hub-'));
Object.assign(process.env, {
  DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'),
  PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'),
  CITADEL_MISSIONS_DIR: path.join(root, 'missions'), CITADEL_SELF_UPDATE: '0',
});
const { buildServer } = require('../server/index');
const { getDatabase, closeDatabase } = require('../server/database/db');
const projects = require('../server/services/projectService');
const logs = require('../server/services/logService');
const tasks = require('../server/services/taskService');
let app, cookies, first, other;
before(async () => {
  app = await buildServer({ logger: false });
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'hubadmin', password: 'Hub-password-12345' } });
  cookies = { session_id: res.cookies.find((c) => c.name === 'session_id').value };
  first = projects.createProject({ name: 'First' });
  other = projects.createProject({ name: 'Other' });
});
after(async () => {
  await app.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true });
});
const get = (suffix, id = first.id, options = {}) => app.inject({ url: `/api/projects/${id}/${suffix}`, cookies, ...options });

test('hub routes require an admin session and respect the optional module gate', async () => {
  assert.equal((await get('hub', first.id, { cookies: {} })).statusCode, 401);
  const db = getDatabase();
  db.prepare("UPDATE users SET role = 'viewer'").run();
  assert.equal((await get('hub')).statusCode, 403);
  assert.equal((await get('trace')).statusCode, 403);
  assert.equal((await get('code-graph')).statusCode, 403);
  db.prepare("UPDATE users SET role = 'admin'").run();
  await app.inject({ method: 'POST', url: '/api/modules/missions/state', cookies, payload: { enabled: false } });
  assert.equal((await get('trace')).statusCode, 403);
  await app.inject({ method: 'POST', url: '/api/modules/missions/state', cookies, payload: { enabled: true } });
  const modules = (await app.inject({ url: '/api/modules', cookies })).json().modules;
  const hub = modules.find((module) => module.id === 'missions');
  assert.equal(hub.core, false);
  assert.deepEqual(hub.views.map((view) => view.id), ['project-hub']);
  assert.equal((await get('hub', 'missing')).statusCode, 404);
});

test('snapshots and traces exclude other projects; task events retain scope after deletion', async () => {
  const a = tasks.enqueue({ cmd: '/usr/bin/true', projectPath: first.path, title: 'First task' });
  tasks.enqueue({ cmd: '/usr/bin/true', projectPath: other.path, title: 'Other task' });
  logs.record({ projectId: other.id, action: 'other', message: 'OTHER PROJECT' });
  logs.record({ projectId: first.id, action: 'first', message: 'Run password=demo-secret', details: { nested: { token: 'demo-secret' } } });
  const snap = (await get('hub')).json();
  assert.deepEqual(snap.tasks.map((task) => task.id), [a.id]);
  assert.equal(snap.tasks[0].prompt, undefined, 'snapshot does not expose prompts/arguments');
  let trace = (await get('trace')).json();
  assert.ok(trace.events.some((event) => event.taskId === a.id));
  assert.doesNotMatch(JSON.stringify(trace), /OTHER PROJECT|demo-secret/);
  assert.equal(trace.events.find((event) => event.action === 'first').details.nested.token, '[REDACTED]');
  getDatabase().prepare('DELETE FROM tasks WHERE id = ?').run(a.id);
  trace = (await get('trace')).json();
  assert.ok(trace.events.some((event) => event.taskId === a.id), 'journal remains scoped without its task row');
});

test('cursor pagination catches every new event and scrubs historical nested details', async () => {
  const initial = (await get('trace')).json();
  for (let i = 0; i < 5; i++) logs.record({ projectId: first.id, action: 'burst', message: `Event ${i}` });
  getDatabase().prepare('INSERT INTO events (project_id, ts, level, category, message, details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(first.id, new Date().toISOString(), 'warn', 'task', '{"token":"demo-old"}', JSON.stringify({ error: 'password="demo old secret"' }));
  const page1 = (await get(`trace?after=${initial.cursor}&limit=2`)).json();
  assert.equal(page1.events.length, 2); assert.equal(page1.hasMore, true);
  const page2 = (await get(`trace?after=${page1.cursor}&limit=2`)).json();
  const page3 = (await get(`trace?after=${page2.cursor}&limit=2`)).json();
  const ids = [...page1.events, ...page2.events, ...page3.events].map((event) => event.id);
  assert.equal(new Set(ids).size, 6);
  assert.equal(page3.hasMore, false);
  assert.doesNotMatch(JSON.stringify(page3), /demo-old|demo old secret/);
  assert.equal((await get('trace?after=-1')).statusCode, 400);
  assert.equal((await get('trace?after=NaN')).statusCode, 400);
  assert.equal((await get(`trace?after=${page3.cursor}`)).json().events.length, 0);
});

test('code graph resolves relative imports, ignores symlinks/dependencies and never executes code', async () => {
  fs.mkdirSync(path.join(first.path, 'src'));
  fs.writeFileSync(path.join(first.path, 'src', 'a.js'), "require('./b'); require('fs').writeFileSync('EXECUTED', 'bad');");
  fs.writeFileSync(path.join(first.path, 'src', 'b.ts'), "export const n = 1;");
  fs.mkdirSync(path.join(first.path, 'node_modules'));
  fs.writeFileSync(path.join(first.path, 'node_modules', 'ignored.js'), '');
  fs.writeFileSync(path.join(other.path, 'outside.js'), "require('./hidden')");
  fs.symlinkSync(other.path, path.join(first.path, 'linked'));
  fs.symlinkSync(path.join(other.path, 'outside.js'), path.join(first.path, 'escape.js'));
  fs.writeFileSync(path.join(first.path, 'big.js'), 'x'.repeat(128 * 1024 + 1));
  const result = await get('code-graph');
  assert.equal(result.statusCode, 200);
  const graph = result.json();
  assert.deepEqual(graph.nodes.map((node) => node.id).sort(), ['src/a.js', 'src/b.ts']);
  assert.deepEqual(graph.edges, [{ from: 'src/a.js', to: 'src/b.ts' }]);
  assert.equal(graph.skippedLargeFiles, 1);
  assert.equal(fs.existsSync(path.join(first.path, 'EXECUTED')), false);
  assert.equal((await get('code-graph')).json().generatedAt, graph.generatedAt, 'repeated reads use the short-lived cache');
  assert.ok((await get('trace')).json().events.some((event) => event.action === 'code_graph_built'));
});
