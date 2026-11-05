/** Director contracts: routing, parallelism, durable decisions and kernel boundaries. */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-director-'));
for (const [key, value] of Object.entries({ DATA_DIR: temp, DATABASE_PATH: path.join(temp, 'db.sqlite'), PROJECTS_DIR: path.join(temp, 'projects'), LOGS_DIR: path.join(temp, 'logs'), CITADEL_SELF_UPDATE: '0' })) process.env[key] = value;
const { initDatabase, getDatabase, closeDatabase, runMigrations } = require('../server/database/db');
const { createDirectorService } = require('../server/services/directorService');
const { diagnose } = require('../server/services/directorAdapters');
const { repositoryIdentity } = require('../server/services/repositoryIdentity');
const { work, runCodex } = require('../scripts/director/worker');
const { publish } = require('../server/services/directorGitHub');
const tasks = require('../server/services/taskService');
const token = '123456:' + 'x'.repeat(30);
let service, fixtures;
function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
function update(id, text, extra = {}) { return { update_id: id, message: { message_id: id, chat: { id: 42, type: 'private' }, from: { id: 42 }, text, ...extra } }; }
function complete(job, result) {
  const task = tasks.claimTask('citadel-director', { protocol: 2 });
  assert.equal(task.id, job.task_id);
  fs.writeFileSync(path.join(temp, 'director', job.id + '.result.json'), JSON.stringify(result));
  tasks.completeTask(task.id, { status: 'done', exitCode: 0, claimToken: task.claimToken });
}
before(() => {
  initDatabase();
  fixtures = ['oceans', 'portfolio', 'third'].map((name, i) => {
    const dir = path.join(temp, name); fs.mkdirSync(dir);
    git(['init', '-b', 'main'], dir); git(['-c', 'user.name=Owner', '-c', 'user.email=owner@example.test', 'commit', '--allow-empty', '-m', 'initial'], dir);
    return { id: 'p' + i, name, slug: name, path: dir };
  });
});
beforeEach(() => {
  const db = getDatabase();
  for (const t of ['director_jobs', 'director_projects', 'director_config', 'director_inbox', 'director_outbox', 'tasks']) db.prepare('DELETE FROM ' + t).run();
  db.prepare('UPDATE director_chat SET project_id=NULL,offset=0,paused=0').run();
  service = createDirectorService({ projects: { listProjects: () => fixtures }, dataDir: temp, diagnose: async p => ({ ready: true, repoKey: repositoryIdentity(p.path) }) });
  service.configure({ enabled: true, ownerId: '42', chatId: '42', token });
});
after(() => { closeDatabase(); fs.rmSync(temp, { recursive: true, force: true }); });

test('upgrade creates persistent director tables and repository keys idempotently', () => {
  runMigrations(getDatabase()); runMigrations(getDatabase());
  assert.ok(getDatabase().prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'repo_key'));
  assert.equal(getDatabase().prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'director_%' AND type='table'").get().n, 6);
});
test('bot credentials are encrypted and never returned in snapshots', () => {
  assert.ok(!JSON.stringify(service.snapshot()).includes(token));
  assert.ok(!getDatabase().prepare('SELECT data FROM director_config').get().data.includes(token));
  assert.equal(service.settings(true).token, token);
});
test('rejects groups, unauthorized senders and disabled reception', () => {
  assert.equal(service.receive(update(1, 'hello', { from: { id: 7 } })), false);
  assert.equal(service.receive(update(2, 'hello', { chat: { id: 42, type: 'group' } })), false);
  service.configure({ enabled: false });
  assert.equal(service.receive(update(3, 'hello')), false);
  assert.equal(service.pendingUpdates().length, 0);
});
test('duplicate Telegram updates create a single instruction and survive service recreation', () => {
  service.receive(update(5, 'Añade login a portfolio')); service.receive(update(5, 'Añade login a portfolio'));
  service.processInbox(); service.processInbox();
  assert.equal(service.jobs().length, 1);
  const restarted = createDirectorService({ projects: { listProjects: () => fixtures }, dataDir: temp });
  assert.equal(restarted.jobs().length, 1);
});
test('status query does not call a model or claim an empty queue proves no work', () => {
  service.receive(update(6, '¿Cómo vamos con oceans?')); service.processInbox();
  assert.equal(service.jobs().length, 0);
  const reply = JSON.parse(service.outbox()[0].payload).text;
  assert.match(reply, /en reposo/); assert.match(reply, /No hay observación reciente/);
});
test('two repositories run concurrently; duplicate work for a repo stays queued', async () => {
  const a = service.enqueue('execute', 'p0', 'change A');
  const b = service.enqueue('execute', 'p1', 'change B');
  const c = service.enqueue('execute', 'p0', 'change C');
  await service.tick();
  const jobs = service.jobs();
  assert.equal(jobs.find(j => j.id === a.id).state, 'running');
  assert.equal(jobs.find(j => j.id === b.id).state, 'running');
  assert.equal(jobs.find(j => j.id === c.id).state, 'queued');
});
test('atomic task claiming excludes the same repository across worker nodes', () => {
  tasks.enqueue({ cmd: 'true', projectPath: fixtures[0].path });
  tasks.enqueue({ cmd: 'true', projectPath: fixtures[0].path });
  tasks.enqueue({ cmd: 'true', projectPath: fixtures[1].path });
  const a = tasks.claimTask('n1'), b = tasks.claimTask('n2');
  assert.notEqual(a.repoKey, b.repoKey);
  assert.equal(tasks.claimTask('n3'), null);
});
test('different worktrees share one repository identity', () => {
  const target = path.join(temp, 'other-worktree');
  git(['worktree', 'add', '-b', 'test-identity', target], fixtures[0].path);
  assert.equal(repositoryIdentity(target), repositoryIdentity(fixtures[0].path));
});
test('consult result and sigue create the proposed work without switching another project', async () => {
  const job = service.enqueue('consult', 'p0', 'where next?'); await service.tick();
  complete(service.jobs().find(j => j.id === job.id), { outcome: 'done', summary: 'One ready task', nextInstruction: 'Implement the ready ticket', sessionId: 's1' });
  await service.tick();
  service.receive(update(10, 'sigue', { reply_to_message: { message_id: 100 } }));
  const resultMessage = service.outbox().find(o => o.job_id === job.id); service.delivered(resultMessage.id, 100);
  service.processInbox();
  assert.ok(service.jobs().some(j => j.kind === 'execute' && j.project_id === 'p0' && j.instruction === 'Implement the ready ticket'));
});
test('decision replies retain their original project and are accepted once', async () => {
  const job = service.enqueue('execute', 'p0', 'add auth'); await service.tick();
  complete(service.jobs().find(j => j.id === job.id), { outcome: 'needs_input', summary: 'Choose auth', question: 'Which provider?', options: ['A', 'B'], sessionId: 's1' }); await service.tick();
  const question = service.outbox().find(o => o.job_id === job.id); service.delivered(question.id, 101);
  service.receive(update(11, 'p:p1')); // text does not become callback; change selection explicitly below
  getDatabase().prepare("UPDATE director_chat SET project_id='p1'").run();
  service.receive(update(12, 'A', { reply_to_message: { message_id: 101 } })); service.processInbox();
  const resumed = service.jobs().find(j => j.id === job.id);
  assert.equal(resumed.project_id, 'p0'); assert.match(resumed.instruction, /Human answer.*A/);
  assert.throws(() => service.answer(job.id, 'B', 'panel:owner'), /no longer pending/);
});
test('Oceans fails closed while Codex permissions and decision bridge are absent', async () => {
  const p = { ...fixtures[0], adapter: 'oceans' };
  const result = await diagnose(p, {}, { runCommand: async (cmd, args) => {
    if (args.includes('check')) throw new Error('unsupported'); return 'ok';
  } });
  assert.equal(result.ready, false);
  assert.match(result.reason, /kernel-codex-permissions/); assert.match(result.reason, /kernel-telegram-bridge/);
});
test('failed compatibility never enqueues an execution', async () => {
  const blocked = createDirectorService({ projects: { listProjects: () => fixtures }, dataDir: temp, diagnose: async () => ({ ready: false, reason: 'missing permission renderer' }) });
  blocked.enqueue('execute', 'p0', 'work'); await blocked.tick();
  assert.equal(blocked.jobs()[0].state, 'blocked');
  assert.equal(getDatabase().prepare('SELECT count(*) n FROM tasks').get().n, 0);
});
test('Oceans decisions cannot masquerade as human Jira comments', () => {
  service.configureProject('p0', { adapter: 'oceans' });
  const j = service.enqueue('execute', 'p0', 'work');
  getDatabase().prepare("UPDATE director_jobs SET state='waiting_input' WHERE id=?").run(j.id);
  assert.throws(() => service.answer(j.id, 'OK', 'telegram:42:12'), /verified human-decision bridge/);
});
test('pause requests termination and does not claim cancellation before worker confirmation', async () => {
  service.enqueue('execute', 'p0', 'work'); await service.tick();
  const job = service.jobs()[0]; tasks.claimTask('citadel-director', { protocol: 2 });
  service.pause('p0');
  assert.equal(service.jobs()[0].state, 'pausing');
  assert.equal(tasks.getTask(job.task_id).status, 'cancelling');
});
test('uncertain process retains repository exclusion', async () => {
  const job = service.enqueue('execute', 'p0', 'work'); await service.tick();
  getDatabase().prepare("UPDATE director_jobs SET state='uncertain' WHERE id=?").run(job.id);
  const next = service.enqueue('execute', 'p0', 'more'); await service.tick();
  assert.equal(service.jobs().find(j => j.id === next.id).state, 'queued');
});
test('failed independent tests cannot become a publishable result', async () => {
  const out = path.join(temp, 'worker-result');
  const input = { kind: 'execute', directory: fixtures[1].path, project: { adapter: 'general' }, sessionId: 'existing', job: { id: 'w1', kind: 'execute', instruction: 'work' }, policy: { tests: [{ cmd: 'npm', args: ['test'] }] }, resultFile: out };
  const result = await work(input, { runCodex: async () => ({ outcome: 'done', summary: 'done' }), command: async (cmd, args) => {
    if (cmd === 'npm') throw new Error('tests fail'); return '';
  } });
  assert.equal(result.outcome, 'blocked'); assert.equal(result.verification, 'FAIL');
});
test('workflow or policy edits stop publication even when model says done', async () => {
  const result = await work({ kind: 'execute', directory: fixtures[1].path, project: { adapter: 'general' }, sessionId: 'existing', job: { id: 'w2', kind: 'execute', instruction: 'work' }, policy: { tests: [{ cmd: 'npm', args: ['test'] }] }, resultFile: path.join(temp, 'w2') },
    { runCodex: async () => ({ outcome: 'done' }), command: async (cmd, args) => args.includes('--name-only') ? '.github/workflows/deploy.yml' : '' });
  assert.equal(result.outcome, 'needs_input');
});
test('missing publication authorization cannot run git or GitHub effects', async () => {
  const result = await publish({ id: 'job' }, {}, { verification: 'PASS' }, { publish: true }, { run: () => { throw new Error('unexpected effect'); } });
  assert.equal(result.publication, 'not_authorized');
});
test('resumed Codex invocation binds explicit session and output schema', async () => {
  const { EventEmitter } = require('node:events');
  let argv;
  const resultFile = path.join(temp, 'fake-codex');
  const result = await runCodex({ kind: 'execute', directory: temp, sessionId: 'session-A', resultFile, prompt: 'continue' }, { spawnImpl: (cmd, args) => {
    argv = args; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    child.stdin = { end: () => {
      fs.writeFileSync(resultFile + '.message', JSON.stringify({ outcome: 'done', summary: 'complete' }));
      queueMicrotask(() => child.emit('close', 0));
    } }; return child;
  } });
  assert.ok(argv.includes('session-A')); assert.ok(!argv.includes('--last')); assert.ok(argv.includes('--output-schema'));
  assert.equal(result.sessionId, 'session-A');
});
test('administrator APIs reject anonymous and cross-site callers and conceal the bot token', async () => {
  const { buildServer } = require('../server/index');
  const app = await buildServer({ customDbPath: process.env.DATABASE_PATH, logger: false, directorRuntime: false });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'director-owner', password: 'DirectorTestPassword123!' } });
    const cookie = setup.cookies.find(c => c.name === 'session_id').value;
    assert.equal((await app.inject({ method: 'GET', url: '/api/director' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/director/config', cookies: { session_id: cookie }, headers: { origin: 'https://foreign.example' }, payload: { enabled: false } })).statusCode, 403);
    const status = await app.inject({ method: 'GET', url: '/api/director', cookies: { session_id: cookie } });
    assert.equal(status.statusCode, 200); assert.ok(!status.payload.includes(token));
    assert.equal(status.headers['cache-control'], 'no-store');
  } finally { await app.close(); }
});
