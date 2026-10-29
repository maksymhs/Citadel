const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const root = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : require('node:os').tmpdir(), 'citadel-chat-test-'));
Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), DATA_DIR: root, DATABASE_PATH: path.join(root, 'panel.sqlite'), PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'), DOTENV_CONFIG_PATH: '/dev/null', CITADEL_SELF_UPDATE: '0' });
const { createChatService, getChildEnv } = require('../server/services/chatService');
const { initDatabase, closeDatabase, getDatabase } = require('../server/database/db');
const auth = require('../server/security/auth');
const Fastify = require('fastify');
const routes = require('../server/routes/chatRoutes');
let upstream, chat, app, cookie, sessionId, launchSeen, lastPrompt, streamResponse, user, other, port;
let enabled = true, statuses = {}, permissions = [], questions = [], wrongDirectory = false, prompts = 0;
const sessions = new Map(), requests = [];
const launchFile = path.join(root, 'launch.json');
const settings = { token: 'isolated-test-only', baseUrl: 'http://127.0.0.1:1', opencodeEnabled: true };
fs.writeFileSync(launchFile, JSON.stringify(settings), { mode: 0o600 });
let configValid = true, completedPrompt = null, failPrompt = false, overrideResponse = null, transformConfig = value => value;
const projects = { p1: path.join(root, 'projects', 'one'), p2: path.join(root, 'projects', 'two') };
const requiredPaths = { '/provider': ['get'], '/event': ['get'], '/session': ['post'], '/session/status': ['get'], '/session/{sessionID}': ['get', 'patch'], '/session/{sessionID}/message': ['get'], '/session/{sessionID}/prompt_async': ['post'], '/session/{sessionID}/abort': ['post'], '/permission': ['get'], '/question': ['get'], '/permission/{requestID}/reply': ['post'], '/question/{requestID}/reply': ['post'], '/question/{requestID}/reject': ['post'] };
function service(dataDir = root) {
  return createChatService({ dataDir, getProject: id => projects[id] ? { path: projects[id] } : null, validatePath: value => value,
    registry: { findBinary: () => '/fake/opencode' }, gateway: { status: () => ({ enabled, opencodeEnabled: enabled, running: enabled }), launchOptions: () => enabled ? { command: 'wrapper', args: ['launch', launchFile, '--client', 'opencode'] } : null },
    spawnImpl(command, args, options) {
      launchSeen = { command, args, options };
      port = Number(args.at(-1));
      const child = new EventEmitter(); child.exitCode = null;
      child.kill = () => { child.exitCode = 0; upstream.closeAllConnections(); upstream.close(() => child.emit('close')); };
      upstream.listen(port, '127.0.0.1');
      return child;
    } });
}
before(async () => {
  for (const value of Object.values(projects)) fs.mkdirSync(value, { recursive: true });
  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : undefined;
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, payload });
    res.setHeader('content-type', 'application/json');
    const override = overrideResponse?.(req, url);
    if (override) { res.statusCode = override.status || 200; return res.end(override.body || ''); }
    const send = data => res.end(JSON.stringify(data));
    if (url.pathname === '/global/health') return send({ healthy: true, version: '1.19.3' });
    if (url.pathname === '/config') return send(configValid ? transformConfig(JSON.parse(require('../scripts/gateway-launch').opencodeEnvironment(launchSeen.options.env, settings).OPENCODE_CONFIG_CONTENT)) : { enabled_providers: ['native'] });
    if (url.pathname === '/provider') return send({ all: [{ id: 'citadel', key: 'never-return-provider-key', models: { 'citadel-execution': { limit: { context: 64000 } }, 'citadel-planning': { limit: { context: 128000 } } } }], default: { citadel: 'citadel-execution' }, connected: ['citadel'] });
    if (url.pathname === '/doc') return send({ paths: Object.fromEntries(Object.entries(requiredPaths).map(([key, methods]) => [key, Object.fromEntries(methods.map(method => [method, {}]))])) });
    if (url.pathname === '/event') { res.setHeader('content-type', 'text/event-stream'); res.write('data: {"type":"server.connected"}\n\n'); streamResponse = res; return; }
    if (url.pathname === '/session/status') return send(statuses);
    if (url.pathname === '/permission') return send(permissions);
    if (url.pathname === '/question') return send(questions);
    if (url.pathname === '/session' && req.method === 'POST') { const id = `ses_test${sessions.size}`; const session = { id, directory: url.searchParams.get('directory'), title: 'chat' }; sessions.set(id, session); return send(session); }
    const id = url.pathname.split('/')[2];
    if (/\/prompt_async$/.test(url.pathname)) { lastPrompt = payload; prompts++; if (failPrompt) { res.statusCode = 503; return res.end('{}'); } statuses[id] = { type: 'busy' }; res.statusCode = 204; return res.end(); }
    if (/\/abort$/.test(url.pathname)) { statuses = {}; permissions = []; questions = []; return send(true); }
    if (/\/message$/.test(url.pathname)) return send([...(completedPrompt ? [{ info: { id: 'msg_done', sessionID: id, role: 'assistant', parentID: completedPrompt, finish: 'stop', time: { completed: Date.now() } }, parts: [] }] : []), { info: { id: 'msg_user', sessionID: id, role: 'user' }, parts: [{ id: 'prt_text', type: 'text', text: 'Hello' }, { id: 'prt_file', type: 'file', url: 'private' }] }, { info: { id: 'msg_foreign', sessionID: 'foreign', role: 'assistant' }, parts: [{ type: 'text', text: 'foreign secret' }] }]);
    if (url.pathname.startsWith('/permission/')) { permissions = permissions.filter(p => p.id !== url.pathname.split('/')[2]); return send(true); }
    if (url.pathname.startsWith('/question/')) { questions = questions.filter(q => q.id !== url.pathname.split('/')[2]); return send(true); }
    if (sessions.has(id)) return send({ ...sessions.get(id), ...(wrongDirectory ? { directory: projects.p2 } : {}) });
    res.statusCode = 404; send({ error: 'secret upstream failure' });
  });
  chat = service();
  initDatabase();
  user = auth.createInitialAdmin('chat-admin', 'chat-password-123');
  const login = auth.login('chat-admin', 'chat-password-123');
  cookie = { session_id: login.sessionId };
  other = 'other-user';
  app = Fastify({ logger: false });
  await app.register(require('@fastify/cookie'));
  await app.register(routes, { chat });
});
after(async () => { await app.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

test('project removal serializes with startup and blocks engines regardless of owner', async () => {
  let removed = false;
  await chat.withProjectRemoval('p1', () => { removed = true; });
  assert.equal(removed, true);
  const created = chat.create(other, 'p2');
  const removal = chat.withProjectRemoval('p2', () => { throw new Error('must not remove'); });
  await created;
  await assert.rejects(removal, err => err.statusCode === 409 && /running Chat/.test(err.message));
  await chat.withProjectRemoval('p1', () => {});
  await chat.stopProject(other, 'p2');
  await chat.withProjectRemoval('p2', () => {});
  launchSeen = undefined;
});

test('gateway-only eligibility fails closed without spawning', async () => {
  enabled = false;
  assert.equal(chat.status().ready, false);
  await assert.rejects(chat.create(user.id, 'p1'), /Native provider fallback/);
  assert.equal(launchSeen, undefined);
  enabled = true;
});
test('gateway runtime launch settings are checked, not just saved flags', async () => {
  fs.writeFileSync(launchFile, JSON.stringify({ ...settings, opencodeEnabled: false }));
  assert.equal(chat.status().ready, false);
  await assert.rejects(chat.create(user.id, 'p1'), /runtime settings/);
  assert.equal(launchSeen, undefined);
  fs.writeFileSync(launchFile, JSON.stringify(settings));
  assert.equal(chat.status().ready, true);
});
test('project activity and stop are read-only when no engine exists and enforce route guards', async () => {
  const url = '/api/projects/p1/chat/activity';
  const count = requests.length;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, cookies: cookie, headers: { origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ url: `${url}?owner=other`, cookies: cookie })).statusCode, 400);
  assert.deepEqual((await app.inject({ url, cookies: cookie })).json(), { running: false });
  assert.deepEqual(await chat.stopProject(user.id, 'p1'), { stopped: false });
  assert.equal(launchSeen, undefined);
  assert.equal(requests.length, count);
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/p1/chat/stop', cookies: cookie, payload: { owner: other } })).statusCode, 400);
  getDatabase().prepare("UPDATE users SET role = 'viewer' WHERE id = ?").run(user.id);
  assert.equal((await app.inject({ url, cookies: cookie })).statusCode, 403);
  getDatabase().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
});
test('creates only registered canonical project sessions using private wrapper environment', async () => {
  await assert.rejects(chat.create(user.id, 'missing'), /Project not found/);
  const result = await chat.create(user.id, 'p1'); sessionId = result.session.id;
  assert.equal(launchSeen.command, 'wrapper');
  assert.deepEqual(launchSeen.args.slice(0, 5), ['launch', launchFile, '--client', 'opencode', '/fake/opencode']);
  assert.equal(launchSeen.options.cwd, fs.realpathSync(projects.p1));
  assert.equal(launchSeen.options.env.OPENCODE_SERVER_PASSWORD.length, 64);
  assert.equal(launchSeen.options.env.DOTENV_CONFIG_PATH, '/dev/null');
  assert.equal(getChildEnv({ PATH: '/bin', SESSION_SECRET: 'private', OPENAI_API_KEY: 'private', OPENCODE_CONFIG_CONTENT: 'unsafe' }).SESSION_SECRET, undefined);
  assert.deepEqual(getChildEnv({ PATH: '/bin', OPENAI_API_KEY: 'private' }), { PATH: '/bin' });
  assert.equal(JSON.stringify(result).includes('directory'), false);
  assert.deepEqual(chat.list(other, 'p1'), { sessions: [] });
  assert.equal(chat.list(user.id, 'p1').sessions.length, 1);
  assert.ok(requests.every(r => r.headers.authorization?.startsWith('Basic ')));
  assert.ok(requests.every(r => !r.headers.cookie));
});
test('ownership and directory checked for snapshots, sends, actions and events', async () => {
  const count = requests.length;
  for (const work of [() => chat.snapshot(other, 'p1', sessionId), () => chat.message(other, 'p1', sessionId, {}), () => chat.action(other, 'p1', sessionId, 'cancel'), () => chat.subscribe(other, 'p1', sessionId, () => {}), () => chat.snapshot(user.id, 'p2', sessionId)]) await assert.rejects(work(), /Chat not found/);
  assert.equal(requests.length, count);
  wrongDirectory = true;
  await assert.rejects(chat.snapshot(user.id, 'p1', sessionId), /directory does not match/);
  wrongDirectory = false;
  const result = await chat.snapshot(user.id, 'p1', sessionId);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].parts.length, 1);
  assert.equal(JSON.stringify(result).includes('foreign secret'), false);
});
test('snapshot exposes only scoped counters and gateway model limits without metadata requests per command', async () => {
  const count = prompts;
  try {
    overrideResponse = (req, url) => url.pathname.endsWith('/message') ? { body: JSON.stringify([
      { info: { id: 'msg_usage', sessionID: sessionId, role: 'assistant', providerID: 'citadel', modelID: 'citadel-execution', tokens: { input: 120, output: 30, reasoning: 10, cache: { read: 50, write: 5 }, secret: 'never-return' } }, parts: [] },
      { info: { sessionID: 'foreign', role: 'assistant', tokens: { input: 99999 } }, parts: [] }
    ]) } : null;
    const snapshot = await chat.snapshot(user.id, 'p1', sessionId);
    assert.deepEqual(snapshot.messages[0].tokens, { input: 120, output: 30, reasoning: 10, cache: { read: 50, write: 5 } });
    assert.equal(snapshot.messages[0].model, 'citadel/citadel-execution');
    assert.deepEqual(snapshot.models, { build: { model: 'citadel/citadel-execution', limitTokens: 64000 }, plan: { model: 'citadel/citadel-planning', limitTokens: 128000 } });
    assert.doesNotMatch(JSON.stringify(snapshot), /never-return|99999/);
    const providersBefore = requests.filter(item => item.path === '/provider').length;
    for (const invalid of [-1, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
      overrideResponse = (req, url) => url.pathname.endsWith('/message') ? { body: JSON.stringify([{ info: { sessionID: sessionId, role: 'assistant', tokens: { input: invalid, output: 0, reasoning: invalid, cache: { read: invalid, write: 0 } } }, parts: [] }]) } : null;
      const result = await chat.snapshot(user.id, 'p1', sessionId);
      assert.deepEqual(result.messages[0].tokens, { input: null, output: 0, reasoning: null, cache: { read: null, write: 0 } });
    }
    assert.equal(requests.filter(item => item.path === '/provider').length, providersBefore);
    assert.equal(prompts, count);
  } finally { overrideResponse = null; }
});
test('strict authenticated API rejects browser config and persistent approvals', async () => {
  const url = `/api/projects/p1/chat/sessions/${sessionId}`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, cookies: cookie, headers: { origin: 'https://evil.example' } })).statusCode, 403);
  for (const payload of [{ text: '/help', role: 'build', requestId: 'slash' }, { text: ' /unknown argument', role: 'plan', requestId: 'slash2' }, null, [], { text: ' \n ', role: 'build', requestId: 'r' }, { text: 'nul\0text', role: 'plan', requestId: 'r' }, { text: 'x'.repeat(32001), role: 'build', requestId: 'r' }, { text: 'hi', role: 'build', requestId: 'r', directory: '/' }, { text: '', role: 'plan', requestId: 'r' }, { text: 'hi', role: 'root', requestId: 'r' }, { text: 'hi', role: 'build', requestId: '../r' }]) assert.equal((await app.inject({ method: 'POST', url: `${url}/messages`, cookies: cookie, payload })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `${url}/permissions/per_test/reply`, cookies: cookie, payload: { reply: 'always' } })).statusCode, 400);
  assert.equal((await app.inject({ url: `${url}?directory=/`, cookies: cookie })).statusCode, 400);
  getDatabase().prepare("UPDATE users SET role = 'viewer' WHERE id = ?").run(user.id);
  assert.equal((await app.inject({ url, cookies: cookie })).statusCode, 403);
  getDatabase().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
});
test('plan prompt is idempotent, applies deny rules, and never switches active work', async () => {
  const input = { text: 'Plan only', role: 'plan', requestId: 'request-one' };
  const url = `/api/projects/p1/chat/sessions/${sessionId}/messages`;
  assert.equal((await app.inject({ method: 'POST', url, cookies: cookie, payload: input })).statusCode, 202);
  assert.equal(lastPrompt.agent, 'plan');
  assert.deepEqual(lastPrompt.parts, [{ type: 'text', text: 'Plan only' }]);
  const patch = requests.findLast(r => r.method === 'PATCH');
  assert.ok(patch.payload.permission.some(p => p.permission === 'edit' && p.action === 'deny'));
  assert.ok(patch.payload.permission.some(p => p.permission === '*' && p.action === 'ask'));
  await chat.message(user.id, 'p1', sessionId, input);
  assert.equal(prompts, 1);
  await assert.rejects(chat.message(user.id, 'p1', sessionId, { ...input, text: 'different' }), /different content/);
  await assert.rejects(chat.create(other, 'p2'), /busy in another session/);
  await assert.rejects(chat.message(user.id, 'p1', sessionId, { ...input, requestId: 'request-two' }), /busy/);
});
test('approvals normalize safe display fields and bind global upstream IDs to owned session', async () => {
  permissions = [{ id: 'per_one', sessionID: sessionId, permission: 'bash', patterns: ['npm test'], metadata: { token: 'never return' } }, { id: 'per_foreign', sessionID: 'foreign', permission: 'edit', patterns: ['secret'] }];
  questions = [{ id: 'que_one', sessionID: sessionId, questions: [{ header: 'Choice', question: 'Which?', multiple: false, options: [{ label: 'A', description: 'First' }] }] }];
  const snapshot = await chat.snapshot(user.id, 'p1', sessionId);
  assert.deepEqual(snapshot.permissions, [{ id: 'per_one', permission: 'bash', patterns: ['npm test'] }]);
  assert.equal(snapshot.questions[0].questions[0].options[0].label, 'A');
  await assert.rejects(chat.action(user.id, 'p1', sessionId, 'permission', 'per_foreign', { reply: 'once' }), /not found/);
  await chat.action(user.id, 'p1', sessionId, 'permission', 'per_one', { reply: 'once' });
  await chat.action(user.id, 'p1', sessionId, 'question', 'que_one', { answers: [['A']] });
  assert.equal(questions.length, 0);
});
test('real upstream SSE delivers scoped invalidation without forwarding payloads', async () => {
  let updates = 0;
  const release = await chat.subscribe(user.id, 'p1', sessionId, () => updates++);
  for (let i = 0; !streamResponse && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 20));
  streamResponse.write('data: '+JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 'foreign', delta: 'secret' } })+'\n\n');
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(updates, 0);
  streamResponse.write('data: '+JSON.stringify({ type: 'message.part.delta', properties: { sessionID: sessionId, delta: 'hello' } })+'\n\n');
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(updates, 1);
  release();
  await chat.action(user.id, 'p1', sessionId, 'cancel');
});
test('missed busy events and delayed idle events cannot unlock an active prompt', async () => {
  await chat.message(user.id, 'p1', sessionId, { text: 'race', role: 'build', requestId: 'race-one' });
  const messageID = lastPrompt.messageID;
  statuses = {};
  streamResponse.write(`data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: sessionId } })}\n\n`);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await chat.snapshot(user.id, 'p1', sessionId)).status, 'busy');
  await assert.rejects(chat.message(user.id, 'p1', sessionId, { text: 'race', role: 'build', requestId: 'race-two' }), /busy/);
  completedPrompt = messageID;
  assert.equal((await chat.snapshot(user.id, 'p1', sessionId)).status, 'idle');
  completedPrompt = null;
});
test('event stream disconnect does not lock out reconnect or hide Stop for active work', async () => {
  await chat.message(user.id, 'p1', sessionId, { text: 'reconnect', role: 'build', requestId: 'reconnect-one' });
  streamResponse.end();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(chat.status().ready, true);
  assert.equal((await chat.snapshot(user.id, 'p1', sessionId)).status, 'busy');
  await new Promise(resolve => setTimeout(resolve, 30));
  await chat.action(user.id, 'p1', sessionId, 'cancel');
  assert.equal((await chat.snapshot(user.id, 'p1', sessionId)).status, 'idle');
});
test('uncertain submissions stay cancellable and idempotent until explicitly resolved', async () => {
  failPrompt = true;
  const input = { text: 'uncertain', role: 'build', requestId: 'uncertain-one' };
  await assert.rejects(chat.message(user.id, 'p1', sessionId, input), /request failed/);
  failPrompt = false;
  const count = prompts;
  await chat.message(user.id, 'p1', sessionId, input);
  assert.equal(prompts, count);
  assert.equal(chat.status().ready, true);
  fs.writeFileSync(launchFile, JSON.stringify({ ...settings, token: 'rotated-test-only' }));
  assert.equal((await chat.snapshot(user.id, 'p1', sessionId)).status, 'busy');
  await chat.action(user.id, 'p1', sessionId, 'cancel');
  fs.writeFileSync(launchFile, JSON.stringify(settings));
  assert.equal((await chat.snapshot(user.id, 'p1', sessionId)).status, 'idle');
});
test('empty acknowledgements work but required JSON and upstream errors are safely diagnosed', async () => {
  const base = `/api/projects/p1/chat/sessions/${sessionId}`;
  try {
    overrideResponse = (req, url) => /\/(prompt_async|abort|reply|reject)$/.test(url.pathname) ? { status: 200 } : null;
    await chat.message(user.id, 'p1', sessionId, { text: 'fake-only', role: 'build', requestId: 'empty-ack' });
    await chat.action(user.id, 'p1', sessionId, 'cancel');
    for (const [status, body, expected] of [[200, '', 'empty response'], [204, '', 'empty response'], [200, 'private prompt token http://secret:password@host', 'invalid JSON'], [502, 'private prompt token http://secret:password@host', 'HTTP 502'], [200, 'x'.repeat(2 * 1024 * 1024 + 1), 'response too large']]) {
      overrideResponse = (req, url) => url.pathname === '/permission' ? { status, body } : null;
      const response = await app.inject({ url: base, cookies: cookie });
      assert.equal(response.statusCode, 503);
      assert.match(response.json().error, /GET \/permission/);
      assert.ok(response.json().error.includes(expected));
      assert.doesNotMatch(response.body, /private prompt|password|http:/);
    }
    overrideResponse = (req, url) => url.pathname === `/session/${sessionId}` ? { status: 404, body: 'private upstream' } : null;
    const missing = await app.inject({ url: base, cookies: cookie });
    assert.equal(missing.statusCode, 409);
    assert.match(missing.json().error, /GET \/session\/:id: HTTP 404/);
    assert.match(missing.json().error, /Create a new chat/);
    assert.ok(!missing.body.includes(sessionId));
  } finally { overrideResponse = null; }
});

test('project stop checks owner, project, directory and every busy session before stopping; histories survive', async () => {
  assert.deepEqual(await chat.activity(user.id, 'p1'), { running: true });
  const count = requests.length;
  assert.deepEqual(await chat.activity(other, 'p1'), { running: false });
  assert.deepEqual(await chat.stopProject(other, 'p1'), { stopped: false });
  assert.deepEqual(await chat.stopProject(user.id, 'p2'), { stopped: false });
  const original = projects.p1;
  projects.p1 = projects.p2;
  assert.deepEqual(await chat.stopProject(user.id, 'p1'), { stopped: false });
  projects.p1 = original;
  assert.equal(requests.length, count);
  statuses = { foreign: { type: 'busy' } };
  await assert.rejects(chat.stopProject(user.id, 'p1'), /Chat not found/);
  assert.equal(requests.slice(count).some(r => r.path.endsWith('/abort')), false);
  statuses = {};
  await chat.message(user.id, 'p1', sessionId, { text: 'stop fixture', role: 'build', requestId: 'project-stop' });
  overrideResponse = (req, url) => url.pathname.endsWith('/abort') ? { status: 503, body: 'private upstream' } : null;
  await assert.rejects(chat.stopProject(user.id, 'p1'), /POST \/session\/:id\/abort: HTTP 503/);
  assert.deepEqual(await chat.activity(user.id, 'p1'), { running: true });
  overrideResponse = null;
  const result = await app.inject({ method: 'POST', url: '/api/projects/p1/chat/stop', cookies: cookie, payload: {} });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { stopped: true });
  assert.deepEqual(await chat.activity(user.id, 'p1'), { running: false });
  assert.ok(requests.some(r => r.path === `/session/${sessionId}/abort`));
  assert.ok(chat.list(user.id, 'p1').sessions.some(s => s.id === sessionId));
  const afterStop = requests.length;
  assert.deepEqual(await chat.stopProject(user.id, 'p1'), { stopped: false });
  assert.equal(requests.length, afterStop);
});

test('effective engine config must be gateway-only', async () => {
  await chat.close();
  chat = service();
  configValid = false;
  await assert.rejects(chat.create(user.id, 'p1'), /not configured exclusively/);
  configValid = true;
  assert.equal(chat.status().ready, true);
  await chat.snapshot(user.id, 'p1', sessionId);
});
test('installed OpenCode capability, creation and snapshot contract without prompts', { skip: !fs.existsSync('/srv/citadel/.opencode/bin/opencode') }, async t => {
  const realRoot = path.join(root, 'real'); fs.mkdirSync(realRoot);
  const launchFile = path.join(realRoot, 'launch.json');
  fs.writeFileSync(launchFile, JSON.stringify({ token: 'isolated-test-only', baseUrl: 'http://127.0.0.1:1', opencodeEnabled: true }), { mode: 0o600 });
  const observed = {};
  const real = createChatService({ fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (['/global/health', '/doc'].includes(url.pathname)) {
      const text = await response.clone().text();
      observed[url.pathname] = url.pathname === '/doc' ? Buffer.byteLength(text) : JSON.parse(text).version;
    }
    return response;
  }, dataDir: realRoot, getProject: () => ({ path: projects.p1 }), validatePath: value => value,
    registry: { findBinary: () => '/srv/citadel/.opencode/bin/opencode' }, gateway: { status: () => ({ enabled: true, opencodeEnabled: true, running: true }), launchOptions: () => ({ command: process.execPath, args: [path.resolve(__dirname, '../scripts/gateway-launch.js'), launchFile, '--client', 'opencode'] }) } });
  try {
    const created = await real.create(user.id, 'p1');
    const snapshot = await real.snapshot(user.id, 'p1', created.session.id);
    assert.deepEqual(snapshot.messages, []);
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.models.build.model, 'citadel/citadel-execution');
    assert.equal(snapshot.models.build.limitTokens, 1000000);
    assert.equal(snapshot.models.plan.model, 'citadel/citadel-planning');
    assert.deepEqual(snapshot.permissions, []);
    assert.deepEqual(snapshot.questions, []);
    assert.equal(observed['/global/health'], '1.19.3');
    assert.ok(observed['/doc'] < 4 * 1024 * 1024);
    t.diagnostic(`Installed engine ${observed['/global/health']}; /doc ${observed['/doc']} bytes; no prompts submitted.`);
  } finally { await real.close(); }
});

test('startup rejects alias drift and unsafe permissions without submitting prompts', async () => {
  await chat.close();
  const count = prompts;
  try {
    for (const mutate of [value => { value.agent.plan.model = 'citadel/wrong'; return value; }, value => { value.permission = 'allow'; return value; }, value => { value.agent.plan.permission.bash = 'allow'; return value; }]) {
      transformConfig = mutate;
      const next = service();
      try { await assert.rejects(next.create(user.id, 'p1'), /aliases|permission configuration/); }
      finally { await next.close(); }
    }
  } finally { transformConfig = value => value; }
  assert.equal(prompts, count);
});

test('canonical data aliases work but symlinked runtime directories fail before spawn', async () => {
  const home = launchSeen.options.env.HOME;
  const alias = path.join(root, 'alias');
  fs.symlinkSync(root, alias);
  const originalData = path.join(home, 'data');
  fs.renameSync(originalData, `${originalData}-saved`);
  fs.symlinkSync(`${originalData}-saved`, originalData);
  const seen = launchSeen;
  const next = service();
  try {
    await assert.rejects(next.create(user.id, 'p1'), /Invalid chat runtime storage/);
    assert.equal(launchSeen, seen);
  } finally {
    await next.close();
    fs.unlinkSync(originalData);
    fs.renameSync(`${originalData}-saved`, originalData);
  }
  const aliased = service(alias);
  try { await aliased.snapshot(user.id, 'p1', sessionId); }
  finally { await aliased.close(); fs.unlinkSync(alias); }
});

test('metadata ownership survives service recreation', async () => {
  await chat.close();
  const next = service();
  assert.equal(next.list(user.id, 'p1').sessions[0].id, sessionId);
  assert.equal(next.list(other, 'p1').sessions.length, 0);
  await next.close();
});
