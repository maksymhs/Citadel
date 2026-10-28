const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const root = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : require('node:os').tmpdir(), 'citadel-chat-test-'));
Object.assign(process.env, { DATA_DIR: root, DATABASE_PATH: path.join(root, 'panel.sqlite'), PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'), DOTENV_CONFIG_PATH: '/dev/null', CITADEL_SELF_UPDATE: '0' });
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
let configValid = true, completedPrompt = null, failPrompt = false;
const projects = { p1: path.join(root, 'projects', 'one'), p2: path.join(root, 'projects', 'two') };
const requiredPaths = { '/event': ['get'], '/session': ['post'], '/session/status': ['get'], '/session/{sessionID}': ['get', 'patch'], '/session/{sessionID}/message': ['get'], '/session/{sessionID}/prompt_async': ['post'], '/session/{sessionID}/abort': ['post'], '/permission': ['get'], '/question': ['get'], '/permission/{requestID}/reply': ['post'], '/question/{requestID}/reply': ['post'], '/question/{requestID}/reject': ['post'] };
function service() {
  return createChatService({ dataDir: root, getProject: id => projects[id] ? { path: projects[id] } : null, validatePath: value => value,
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
    const send = data => res.end(JSON.stringify(data));
    if (url.pathname === '/global/health') return send({ healthy: true, version: '1.19.3' });
    if (url.pathname === '/config') return send(configValid ? JSON.parse(require('../scripts/gateway-launch').opencodeEnvironment({}, settings).OPENCODE_CONFIG_CONTENT) : { enabled_providers: ['native'] });
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
test('strict authenticated API rejects browser config and persistent approvals', async () => {
  const url = `/api/projects/p1/chat/sessions/${sessionId}`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, cookies: cookie, headers: { origin: 'https://evil.example' } })).statusCode, 403);
  for (const payload of [{ text: 'hi', role: 'build', requestId: 'r', directory: '/' }, { text: '', role: 'plan', requestId: 'r' }, { text: 'hi', role: 'root', requestId: 'r' }, { text: 'hi', role: 'build', requestId: '../r' }]) assert.equal((await app.inject({ method: 'POST', url: `${url}/messages`, cookies: cookie, payload })).statusCode, 400);
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
test('effective engine config must be gateway-only', async () => {
  await chat.close();
  chat = service();
  configValid = false;
  await assert.rejects(chat.create(user.id, 'p1'), /not configured exclusively/);
  configValid = true;
  assert.equal(chat.status().ready, true);
  await chat.snapshot(user.id, 'p1', sessionId);
});
test('installed OpenCode capability, creation and snapshot contract without prompts', { skip: !fs.existsSync('/srv/citadel/.opencode/bin/opencode') }, async () => {
  const realRoot = path.join(root, 'real'); fs.mkdirSync(realRoot);
  const launchFile = path.join(realRoot, 'launch.json');
  fs.writeFileSync(launchFile, JSON.stringify({ token: 'isolated-test-only', baseUrl: 'http://127.0.0.1:1', opencodeEnabled: true }), { mode: 0o600 });
  const real = createChatService({ dataDir: realRoot, getProject: () => ({ path: projects.p1 }), validatePath: value => value,
    registry: { findBinary: () => '/srv/citadel/.opencode/bin/opencode' }, gateway: { status: () => ({ enabled: true, opencodeEnabled: true, running: true }), launchOptions: () => ({ command: process.execPath, args: [path.resolve(__dirname, '../scripts/gateway-launch.js'), launchFile, '--client', 'opencode'] }) } });
  try {
    const created = await real.create(user.id, 'p1');
    const snapshot = await real.snapshot(user.id, 'p1', created.session.id);
    assert.deepEqual(snapshot.messages, []);
    assert.equal(snapshot.status, 'idle');
    assert.deepEqual(snapshot.permissions, []);
    assert.deepEqual(snapshot.questions, []);
  } finally { await real.close(); }
});

test('metadata ownership survives service recreation', async () => {
  await chat.close();
  const next = service();
  assert.equal(next.list(user.id, 'p1').sessions[0].id, sessionId);
  assert.equal(next.list(other, 'p1').sessions.length, 0);
  await next.close();
});
