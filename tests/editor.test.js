/** Browser editor installation, authenticated proxy, WebSocket transport and process cleanup. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-editor-suite-'));
Object.assign(process.env, { DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'), PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'), CITADEL_SELF_UPDATE: '0' });
const { buildServer } = require('../server/index');
const { getDatabase, closeDatabase } = require('../server/database/db');
const editor = require('../server/services/editorService');
const projects = require('../server/services/projectService');
const { downloadRelease } = require('../server/services/releaseDownload');
const { Response } = globalThis;
let app, cookies, project, base;
before(async () => {
  app = await buildServer({ logger: false });
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'editor', password: 'Editor-test-password-123' } });
  cookies = { session_id: setup.cookies.find(c => c.name === 'session_id').value };
  project = projects.createProject({ name: 'Browser editor test' });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

test('editor setup and proxy reject unauthenticated, viewer and untrusted-origin access', async () => {
  for (const url of ['/api/editor', `/editor/${project.id}/`]) assert.equal((await app.inject({ url })).statusCode, 401);
  getDatabase().prepare("UPDATE users SET role = 'viewer'").run();
  try {
    for (const [method, url] of [['GET', '/api/editor'], ['GET', '/api/opencode-web'], ['POST', '/api/editor/install'], ['POST', `/api/projects/${project.id}/editor`], ['POST', `/api/projects/${project.id}/opencode-web`], ['GET', `/editor/${project.id}/`], ['GET', `/opencode/${project.id}/`]]) {
      assert.equal((await app.inject({ method, url, cookies })).statusCode, 403);
    }
  } finally { getDatabase().prepare("UPDATE users SET role = 'admin'").run(); }
  assert.equal((await app.inject({ method: 'POST', url: '/api/editor/install', cookies, headers: { origin: 'https://untrusted.example' } })).statusCode, 403);
});

test('HTTP and WebSocket proxy preserve data without exposing browser or backend credentials', async () => {
  let seen;
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    seen = { headers: req.headers, url: req.url, text };
    res.setHeader('set-cookie', 'backend=never-expose');
    res.setHeader('content-type', 'text/html');
    res.end('<html>Browser editor fixture</html>');
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket, request) => { seen = { headers: request.headers }; socket.on('message', (data, binary) => socket.send(data, { binary })); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const original = editor.target;
  editor.target = id => { assert.equal(id, project.id); return { port: upstream.address().port, cookie: 'backend=fixture' }; };
  let socket;
  try {
    const response = await app.inject({ method: 'POST', url: `/editor/${project.id}/some/path?x=1`, cookies, headers: { 'content-type': 'application/json' }, payload: '{"x":"unchanged"}' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Browser editor fixture/);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(seen.headers.cookie, 'backend=fixture');
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.url, '/some/path?x=1');
    assert.equal(seen.text, '{"x":"unchanged"}');
    socket = new WebSocket(`${base.replace('http:', 'ws:')}/editor/${project.id}/socket`, { headers: { cookie: `session_id=${cookies.session_id}`, origin: base } });
    await once(socket, 'open');
    socket.send(Buffer.from([0, 1, 2, 255]));
    const [data, binary] = await once(socket, 'message');
    assert.equal(binary, true);
    assert.deepEqual(data, Buffer.from([0, 1, 2, 255]));
    assert.equal(seen.headers.cookie, 'backend=fixture');
    assert.ok(!JSON.stringify(seen.headers).includes(cookies.session_id));
  } finally {
    socket?.terminate(); for (const s of wss.clients) s.terminate();
    editor.target = original;
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('editor validates registered project paths, starts one protected process and closes it', async () => {
  const instance = fs.mkdtempSync(path.join(root, 'instance-'));
  const binary = path.join(instance, 'editor/runtime/bin/code-server');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!/usr/bin/env node
const http = require('node:http');
const bind = process.argv[process.argv.indexOf('--bind-addr') + 1].split(':');
http.createServer(async (req, res) => {
 let body=''; for await (const p of req) body += p;
 if (req.url === '/login' && new URLSearchParams(body).get('password') === process.env.PASSWORD) { res.writeHead(302, {'set-cookie':'editor-fixture=private; HttpOnly'}); res.end(); }
 else { res.writeHead(req.headers.cookie === 'editor-fixture=private' ? 200 : 401); res.end(); }
}).listen(Number(bind[1]), bind[0]);
`, { mode: 0o700 });
  const s = editor.createEditorService({ dataDir: instance });
  try {
    await assert.rejects(s.open('nonexistent'), /Project not found/);
    const opened = await s.open(project.id);
    assert.ok(opened.url.startsWith(`/editor/${project.id}/?folder=`));
    const settingsFile = path.join(instance, 'editor', 'user-data', 'User', 'settings.json');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile))['workbench.colorTheme'], 'Default Dark Modern');
    const target = s.target(project.id);
    assert.equal((await fetch(`http://127.0.0.1:${target.port}`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${target.port}`, { headers: { cookie: target.cookie } })).status, 200);
    await s.open(project.id);
    assert.equal(s.target(project.id).port, target.port, 'one shared editor process');
    assert.ok(!JSON.stringify(s.status()).includes(target.cookie));
    await s.close();
    fs.writeFileSync(settingsFile, JSON.stringify({ 'workbench.colorTheme': 'Default Light Modern', 'editor.fontSize': 16 }));
    await s.open(project.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)), { 'workbench.colorTheme': 'Default Light Modern', 'editor.fontSize': 16 });
  } finally { await s.close(); }
  assert.equal(s.status().running, false);
  const escaping = editor.createEditorService({ dataDir: instance, getProject: () => ({ id: 'bad', path: os.tmpdir() }) });
  await assert.rejects(escaping.open('bad'), /Path traversal/);
});

test('release downloads stream with checksum verification and reject unsafe redirects', async () => {
  const destination = path.join(root, 'download.bin');
  const crypto = require('node:crypto');
  const bytes = Buffer.from('release fixture');
  await downloadRelease('https://github.com/example/release', destination, crypto.createHash('sha256').update(bytes).digest('hex'), { fetchImpl: async () => new Response(bytes) });
  assert.deepEqual(fs.readFileSync(destination), bytes);
  fs.rmSync(destination);
  await assert.rejects(downloadRelease('https://github.com/example/release', destination, 'wrong', { fetchImpl: async () => new Response(bytes) }), /checksum/);
  assert.equal(fs.existsSync(destination), false);
  await assert.rejects(downloadRelease('https://github.com/example/release', destination, 'unused', { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }), /Untrusted/);
  await assert.rejects(downloadRelease('https://github.com/example/release', destination, 'unused', { maxBytes: 1, fetchImpl: async () => new Response(bytes) }), /size limit/);
});
