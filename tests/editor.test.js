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
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'self'");
    if (req.url === '/assets/index-B5F0ExSs.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end('window.editorFixture = true;');
    } else if (req.url === '/assets/index-B5F0ExSs.css') {
      res.setHeader('content-type', 'text/css');
      res.end('body { color: red; }');
    } else if (['/provider', '/path', '/session', '/project', '/config', '/file', '/permission', '/question', '/pty', '/agent'].some(prefix => req.url === prefix || req.url.startsWith(`${prefix}/`) || req.url.startsWith(`${prefix}?`))) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url, method: req.method, body: text }));
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<html>Browser editor fixture</html>');
    }
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket, request) => { seen = { headers: request.headers }; socket.on('message', (data, binary) => socket.send(data, { binary })); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const original = editor.target;
  const originalOpenCodeTarget = editor.openCodeWeb.target;
  const originalCurrentOpenCodeTarget = editor.openCodeWeb.currentTarget;
  editor.target = id => { assert.equal(id, project.id); return { port: upstream.address().port, cookie: 'backend=fixture' }; };
  editor.openCodeWeb.target = id => { assert.equal(id, project.id); return { port: upstream.address().port, auth: 'Basic private' }; };
  editor.openCodeWeb.currentTarget = () => ({ port: upstream.address().port, auth: 'Basic private', projectId: project.id });
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
    const documentUrl = `${base}/opencode/${project.id}/`;
    const document = await app.inject({ url: `/opencode/${project.id}/`, cookies });
    assert.equal(document.statusCode, 502);
    assert.match(document.body, /OpenCode GUI compatibility check failed/);
    assert.equal(document.headers['cache-control'], 'no-store');
    assert.equal(document.headers['x-frame-options'], undefined);
    assert.ok(!document.body.includes('Basic private'));
    const panel = await app.inject({ url: '/', cookies });
    assert.equal(panel.headers['referrer-policy'], 'no-referrer');
    assert.equal(panel.headers['x-frame-options'], 'SAMEORIGIN');
    for (const endpoint of ['/global/health', '/api/event', '/api/provider']) {
      const result = await app.inject({ url: endpoint, cookies, headers: { referer: documentUrl } });
      assert.equal(result.statusCode, 200);
      assert.equal(seen.url, endpoint);
      assert.equal(seen.headers.authorization, 'Basic private');
    }
    for (const endpoint of ['/provider', '/provider/auth', '/path', '/session/status', '/project', '/project/current', '/config', '/file/status', '/permission', '/question', '/pty', '/agent', '/session?directory=%2Ftmp%2Fproject&limit=10']) {
      const result = await app.inject({ url: endpoint, cookies, headers: { referer: documentUrl } });
      assert.equal(result.statusCode, 200, endpoint);
      assert.equal(result.headers['content-type'], 'application/json');
      assert.deepEqual(result.json(), { url: endpoint, method: 'GET', body: '' });
      assert.equal(seen.headers.authorization, 'Basic private');
      assert.equal(seen.headers.cookie, undefined);
      for (const referer of [undefined, `${base}/`, `${base}/opencode/other-project/`]) {
        const denied = await app.inject({ url: endpoint, cookies, headers: referer ? { referer } : {} });
        assert.equal(denied.statusCode, 404, endpoint);
      }
      assert.equal((await app.inject({ url: endpoint, headers: { referer: documentUrl } })).statusCode, 401);
    }
    for (const [method, endpoint, payload] of [['POST', '/session', '{"title":"New session"}'], ['POST', '/session/test/prompt_async', '{"parts":[]}'], ['PATCH', '/config', '{"model":"test/model"}'], ['DELETE', '/session/test', undefined]]) {
      const result = await app.inject({ method, url: endpoint, cookies, headers: { referer: documentUrl, 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });
      assert.equal(result.statusCode, 200, `${method} ${endpoint}`);
      assert.deepEqual(result.json(), { url: endpoint, method, body: payload || '' });
    }
    assert.equal((await app.inject({ url: '/provider-unrelated', cookies, headers: { referer: documentUrl } })).statusCode, 404);
    const asset = await app.inject({ url: '/assets/index-B5F0ExSs.js', cookies, headers: { referer: documentUrl } });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers['content-type'], 'application/javascript');
    assert.equal(asset.body, 'window.editorFixture = true;');
    assert.equal(seen.url, '/assets/index-B5F0ExSs.js');
    assert.equal(seen.headers.authorization, 'Basic private');
    const css = await app.inject({ url: '/assets/index-B5F0ExSs.css', cookies, headers: { referer: `${base}/opencode/${project.id}/` } });
    assert.equal(css.statusCode, 200);
    assert.equal(css.headers['content-type'], 'text/css');
    assert.equal(css.body, 'body { color: red; }');
    assert.equal(seen.url, '/assets/index-B5F0ExSs.css');
    assert.equal(seen.headers.authorization, 'Basic private');
    const api = await app.inject({ url: '/global/health', cookies, headers: { referer: `${base}/opencode/${project.id}/` } });
    assert.equal(api.statusCode, 200);
    assert.equal(seen.url, '/global/health');
    const denied = await app.inject({ url: '/global/health', cookies });
    assert.equal(denied.statusCode, 404);
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
    editor.openCodeWeb.target = originalOpenCodeTarget;
    editor.openCodeWeb.currentTarget = originalCurrentOpenCodeTarget;
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('prefixed OpenCode adaptation bounds text, strips validators, preserves API/SSE and sockets', async () => {
  const zlib = require('node:zlib');
  const adapter = require('../server/services/openCodeGuiAdapter');
  const prefix = `/opencode/${project.id}`;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('set-cookie', 'private=secret');
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { location: new URL(req.url, 'http://localhost').searchParams.get('to') }); res.end();
    } else if (req.url === '/assets/chunk.js') {
      const bytes = zlib.gzipSync(Buffer.from('const asset="/assets/icon.svg";'));
      res.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': 'gzip', 'content-length': bytes.length, etag: '"old"', 'last-modified': new Date().toUTCString(), 'accept-ranges': 'bytes' }); res.end(bytes);
    } else if (req.url === '/assets/index-unknown.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('unsupported build');
    } else if (req.url === '/assets/big.css') {
      res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(Buffer.alloc(adapter.MAX_BYTES + 1)));
    } else if (req.url === '/global/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n');
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 50);
      res.on('close', () => clearInterval(timer));
    } else if (req.url === '/api/raw') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>API unchanged /assets/icon.svg</html>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script type="module" src="/assets/index-unknown.js"></script>');
    }
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (socket, req) => { seen.push({ url: req.url, headers: req.headers }); socket.on('message', data => socket.send(data)); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const original = editor.openCodeWeb.target;
  editor.openCodeWeb.target = () => ({ port: upstream.address().port, auth: 'Basic private' });
  let socket;
  try {
    const headers = { 'accept-encoding': 'br, gzip', 'if-none-match': '"old"', 'if-modified-since': new Date().toUTCString(), range: 'bytes=0-10', authorization: 'Bearer browser-secret' };
    const chunk = await app.inject({ url: prefix + '/assets/chunk.js', cookies, headers });
    assert.equal(chunk.statusCode, 200);
    assert.equal(chunk.body, `const asset="${prefix}/assets/icon.svg";`);
    assert.equal(chunk.headers['content-type'], 'text/javascript; charset=utf-8');
    for (const key of ['content-encoding', 'etag', 'last-modified', 'accept-ranges', 'set-cookie']) assert.equal(chunk.headers[key], undefined);
    assert.equal(Number(chunk.headers['content-length']), Buffer.byteLength(chunk.body));
    assert.equal(seen.at(-1).headers['accept-encoding'], 'identity');
    for (const key of ['if-none-match', 'if-modified-since', 'range', 'cookie']) assert.equal(seen.at(-1).headers[key], undefined);
    assert.equal(seen.at(-1).headers.authorization, 'Basic private');
    for (const path of ['/assets/index-unknown.js', '/directory/session/42?x=1', '/assets/big.css']) {
      const failure = await app.inject({ url: prefix + path, cookies });
      assert.equal(failure.statusCode, 502);
      assert.match(failure.body, /OpenCode GUI compatibility check failed/);
      assert.ok(!failure.body.includes('Basic private'));
    }
    const raw = await app.inject({ url: prefix + '/api/raw', cookies });
    assert.equal(raw.body, '<html>API unchanged /assets/icon.svg</html>');
    for (const [to, expected] of [['/session/42?x=1#hash', prefix + '/session/42?x=1#hash'], [prefix + '/session', prefix + '/session'], ['next?x=2', prefix + '/next?x=2']]) {
      const redirect = await app.inject({ url: prefix + '/redirect?to=' + encodeURIComponent(to), cookies });
      assert.equal(redirect.statusCode, 302);
      assert.equal(redirect.headers.location, expected);
    }
    assert.equal((await app.inject({ url: prefix + '/redirect?to=%2F%2Fevil.example', cookies })).statusCode, 502);
    const slash = await app.inject({ url: prefix + '?x=1', cookies });
    assert.equal(slash.statusCode, 308);
    assert.equal(slash.headers.location, prefix + '/?x=1');
    const controller = new AbortController();
    try {
      const response = await fetch(base + prefix + '/global/event', { headers: { cookie: `session_id=${cookies.session_id}` }, signal: controller.signal });
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.match(Buffer.from((await response.body.getReader().read()).value).toString(), /data: first/);
    } finally { controller.abort(); }
    socket = new WebSocket(`${base.replace('http:', 'ws:')}${prefix}/pty/42/connect`, { headers: { cookie: `session_id=${cookies.session_id}`, origin: base } });
    await once(socket, 'open');
    socket.send('terminal');
    assert.equal((await once(socket, 'message'))[0].toString(), 'terminal');
    assert.equal(seen.at(-1).url, '/pty/42/connect');
    assert.equal(seen.at(-1).headers.authorization, 'Basic private');
    assert.equal(seen.at(-1).headers.cookie, undefined);
  } finally {
    socket?.terminate(); for (const client of wss.clients) client.terminate();
    editor.openCodeWeb.target = original;
    await new Promise(resolve => wss.close(resolve));
    upstream.closeAllConnections();
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

test('OpenCode web starts a protected server with private credentials and closes it', async () => {
  const instance = fs.mkdtempSync(path.join(root, 'opencode-'));
  const binary = path.join(instance, 'opencode');
  fs.writeFileSync(binary, `#!/usr/bin/env node
const http = require('node:http');
if (!process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_SERVER_USERNAME !== 'opencode') process.exit(1);
const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
http.createServer((req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(401); res.end(); return; }
  if (req.url === '/global/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ healthy: true })); }
  else if (req.url === '/assets/index.js') { res.setHeader('content-type', 'application/javascript'); res.end('window.opencodeFixture = true;'); }
  else if (req.url === '/assets/index.css') { res.setHeader('content-type', 'text/css'); res.end('body { color: blue; }'); }
  else { res.writeHead(404); res.end(); }
}).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), process.argv[process.argv.indexOf('--hostname') + 1]);
`, { mode: 0o700 });
  const s = editor.createOpenCodeWebService({
    registry: { findBinary: name => { assert.equal(name, 'opencode'); return binary; } },
    getProject: id => { assert.equal(id, project.id); return projects.getProject(id); },
  });
  try {
    const opened = await s.open(project.id);
    assert.equal(opened.url, `/opencode/${project.id}/`);
    const target = s.target(project.id);
    const upstream = `http://127.0.0.1:${target.port}`;
    assert.equal((await fetch(`${upstream}/global/health`)).status, 401);
    const health = await fetch(`${upstream}/global/health`, { headers: { authorization: target.auth } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('content-type'), 'application/json');
    assert.deepEqual(await health.json(), { healthy: true });
    for (const [asset, mime, body] of [['index.js', 'application/javascript', 'window.opencodeFixture = true;'], ['index.css', 'text/css', 'body { color: blue; }']]) {
      const response = await fetch(`${upstream}/assets/${asset}`, { headers: { authorization: target.auth } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(await response.text(), body);
    }
    const password = Buffer.from(target.auth.slice('Basic '.length), 'base64').toString().slice('opencode:'.length);
    assert.ok(password);
    assert.deepEqual(s.status(), { installed: true, running: true, error: null });
    assert.ok(!JSON.stringify(s.status()).includes(target.auth));
    assert.ok(!JSON.stringify(s.status()).includes(password));
  } finally { await s.close(); }
  assert.equal(s.status().running, false);
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
