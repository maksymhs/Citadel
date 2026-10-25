/** Local gateway lifecycle, credential isolation, downloads and administrator boundaries. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const { Response } = globalThis;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-gateway-suite-'));
Object.assign(process.env, { DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'), PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'), CITADEL_SELF_UPDATE: '0' });
const { getDatabase, closeDatabase } = require('../server/database/db');
const { createGatewayService, VERSION } = require('../server/services/gatewayService');
const { gatewayEnvironment } = require('../scripts/gateway-launch');
const { buildServer } = require('../server/index');
const { decrypt } = require('../server/security/secrets');
let app, cookies;
const services = [];
before(async () => {
  app = await buildServer({ logger: false });
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'gateway', password: 'Gateway-test-password-123' } });
  cookies = { session_id: setup.cookies.find(c => c.name === 'session_id').value };
});
after(async () => { for (const s of services) await s.close(); await app.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await pause(30); } throw new Error('Timed out waiting for gateway fixture.'); }
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p;
}
function fresh() {
  getDatabase().prepare("DELETE FROM app_config WHERE key LIKE 'ai.gateway%'").run();
  const dir = fs.mkdtempSync(path.join(root, 'instance-'));
  const service = createGatewayService({ dataDir: dir }); services.push(service);
  return { dir, service };
}
function fakeBinary(dir) {
  fs.mkdirSync(path.join(dir, 'gateway'), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'gateway', 'cli-proxy-api'), `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const c = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config') + 1]));
let authStatus = 'wait';
if (process.argv.includes('--codex-device-login')) {
  console.log('Codex device URL: https://auth.openai.com/codex/device');
  console.log('Codex device code: FIXTURE-CODE');
  setTimeout(() => { fs.writeFileSync(path.join(c.oauth['auth-dir'], 'codex-fixture.json'), JSON.stringify({ type: 'codex', access_token: 'fixture-provider-secret' })); }, 200);
} else {
  http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    if (req.url.startsWith('/v8/management/')) {
      if (req.headers.authorization !== 'Bearer ' + c.management['secret-key']) { res.writeHead(401); res.end(); return; }
      res.setHeader('content-type','application/json');
      if (req.url.startsWith('/v8/management/oauth/auth-url')) res.end(JSON.stringify({ url: 'https://claude.ai/oauth/authorize?state=fixture-state&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback', state: 'fixture-state' }));
      else if (req.url === '/v8/management/oauth/callback') {
        fs.writeFileSync(path.join(c.oauth['auth-dir'], 'claude-fixture.json'), JSON.stringify({ type: 'claude', access_token: 'fixture-claude-secret' }));
        authStatus = 'ok'; res.end(JSON.stringify({ status: 'ok' }));
      } else if (req.url === '/v8/management/credentials') res.end(JSON.stringify({ files: [{ name: 'codex-fixture.json', provider: 'codex', auth_index: 'fixture-codex' }, { name: 'claude-fixture.json', provider: 'claude', auth_index: 'fixture-claude' }] }));
      else if (req.url.startsWith('/v8/management/credentials/models')) res.end(JSON.stringify({ models: [{ id: req.url.includes('codex-fixture') ? 'gpt-fixture' : 'claude-fixture', display_name: 'Fixture model' }, { id: 'citadel-execution' }] }));
      else if (req.url === '/v8/management/routing/model-definitions/codex' || req.url === '/v8/management/routing/model-definitions/claude') res.end(JSON.stringify({ models: [{ id: 'catalog-fixture' }] }));
      else if (req.url === '/v8/management/requests/api-call') {
        const call = JSON.parse(raw);
        const payload = call.url.includes('anthropic.com') ? { five_hour: { utilization: 0, resets_at: new Date(Date.now() + 3600000).toISOString() }, seven_day: { utilization: 25, resets_at: new Date(Date.now() + 86400000).toISOString() } } : { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 1200 }, secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 7200 } } };
        res.end(JSON.stringify({ status_code: 200, body: JSON.stringify(payload), header: {} }));
      } else res.end(JSON.stringify({ status: authStatus }));
      return;
    }
    if (req.headers.authorization !== 'Bearer ' + c.access['api-keys'][0]) { res.writeHead(401); res.end(); return; }
    res.setHeader('content-type','application/json');
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    else res.end(JSON.stringify({ type: 'message', model: 'fixture-model', content: [{ type: 'text', text: 'OK' }] }));
  }).listen(c.server.port, c.server.host);
}
`, { mode: 0o700 });
}

test('gateway routes require administrator access and never reveal stored values', async () => {
  assert.equal((await app.inject({ url: '/api/settings/gateway' })).statusCode, 401);
  getDatabase().prepare("UPDATE users SET role = 'viewer'").run();
  try {
    for (const [method, url] of [['GET', ''], ['PUT', ''], ['POST', '/install'], ['POST', '/login'], ['DELETE', '/login'], ['GET', '/models'], ['GET', '/discovery'], ['POST', '/discovery/refresh'], ['POST', '/test'], ['POST', '/callback']]) {
      assert.equal((await app.inject({ method, url: `/api/settings/gateway${url}`, cookies, ...(method === 'PUT' ? { payload: { enabled: true } } : {}) })).statusCode, 403);
    }
    const gateway = require('../server/services/gatewayService');
    const originalStatus = gateway.status;
    gateway.status = () => ({ enabled: true });
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/api/terminals', cookies, payload: { projectId: 'fixture' } })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: '/api/agents/launch', cookies, payload: { projectId: 'fixture', agentId: 'claude' } })).statusCode, 403);
    } finally { gateway.status = originalStatus; }
  } finally { getDatabase().prepare("UPDATE users SET role = 'admin'").run(); }
  const result = await app.inject({ url: '/api/settings/gateway', cookies });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().gateway.enabled, false);
  assert.equal(result.json().gateway.running, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/settings/gateway/login', cookies, headers: { origin: 'https://untrusted.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/settings/gateway/discovery/refresh', cookies, payload: { provider: 'other' } })).statusCode, 400);
  const discovery = await app.inject({ url: '/api/settings/gateway/discovery', cookies });
  assert.equal(discovery.statusCode, 200);
  assert.equal(discovery.headers['cache-control'], 'no-store');
  assert.equal(discovery.json().providers.codex.connected, false);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/gateway', cookies, payload: { enabled: true } })).statusCode, 400);
});

test('managed lifecycle keeps credentials encrypted, scopes launcher settings and stops cleanly', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  assert.equal(s.launchOptions(), null);
  await s.loginStart();
  await until(() => s.status().login?.code === 'FIXTURE-CODE');
  assert.equal(s.status().login.url, 'https://auth.openai.com/codex/device');
  await until(() => s.status().connected);
  assert.equal(s.status().login.state, 'connected');
  const value = getDatabase().prepare("SELECT value FROM app_config WHERE key = 'ai.gateway.credentials'").get().value;
  assert.ok(!value.includes('fixture-provider-secret'));
  assert.ok(decrypt(value).includes('fixture-provider-secret'));
  assert.ok(!JSON.stringify(s.status()).includes('fixture-provider-secret'));
  await s.save({ enabled: true, port: await port(), planningModel: 'fixture-plan', executionModel: 'fixture-model', smallModel: 'fixture-model' });
  assert.equal(s.status().running, true);
  const launch = s.launchOptions();
  assert.equal(launch.command, process.execPath);
  assert.ok(!launch.args.join(' ').includes('fixture-provider-secret'));
  const launchConfig = launch.args[1];
  const settings = JSON.parse(fs.readFileSync(launchConfig));
  assert.equal(fs.statSync(launchConfig).mode & 0o777, 0o600);
  const runtimeConfig = JSON.parse(fs.readFileSync(path.join(path.dirname(launchConfig), 'config.json')));
  assert.equal(runtimeConfig.server.host, '127.0.0.1');
  assert.equal(runtimeConfig.server['commercial-mode'], true);
  assert.ok(runtimeConfig.management['secret-key']);
  assert.equal(runtimeConfig.management['allow-remote'], false);
  assert.equal(runtimeConfig.oauth['model-alias'].codex[1].alias, 'citadel-execution');
  assert.equal(runtimeConfig.routing['session-affinity'], true);
  assert.equal(runtimeConfig.routing['session-affinity-rebind-on'], 'quota');
  assert.equal(runtimeConfig.management['disable-control-panel'], true);
  assert.deepEqual(await s.models(), ['fixture-model']);
  assert.deepEqual(await s.testConnection(), { ok: true, model: 'fixture-model', mode: 'chatgpt' });
  const env = gatewayEnvironment({ ANTHROPIC_API_KEY: 'old-key', CLAUDE_CODE_OAUTH_TOKEN: 'old-token', CLAUDE_CODE_USE_BEDROCK: '1', KEEP: 'yes' }, settings);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'citadel-planning');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'citadel-execution');
  assert.equal(env.KEEP, 'yes');
  assert.ok(!getDatabase().prepare("SELECT value FROM app_config WHERE key = 'ai.gateway'").get().value.includes(settings.token));
  await assert.rejects(s.save({ enabled: true, planningModel: 'bad\nmodel' }), /Invalid model/);
  await assert.rejects(s.save({ enabled: true, port: 22 }), /Port must/);
  await s.close();
  assert.equal(fs.existsSync(path.dirname(launchConfig)), false);
  await s.resume();
  assert.equal(s.status().running, true, 'enabled gateway resumes with encrypted credentials');
  const resumedRuntime = path.dirname(s.launchOptions().args[1]);
  await s.save({ enabled: false });
  assert.equal(fs.existsSync(resumedRuntime), false, 'disabled gateway retains only encrypted credentials');
  assert.equal(s.launchOptions(), null);
  assert.equal(s.status().running, false);
  await s.disconnect();
  assert.equal(s.status().connected, false);
});

test('checksum mismatch and redirects to untrusted hosts never install executable code', async () => {
  const { dir } = fresh();
  const bad = createGatewayService({ dataDir: dir, fetchImpl: async url => new Response(url.endsWith('checksums.txt') ? 'bad checksum' : 'not an archive') }); services.push(bad);
  await assert.rejects(bad.install(), /checksum/);
  assert.equal(bad.status().installed, false);
  const redirects = [];
  const redirected = createGatewayService({ dataDir: dir, fetchImpl: async url => { redirects.push(url); return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); } }); services.push(redirected);
  await assert.rejects(redirected.install(), /Could not install/);
  assert.ok(redirects.every(url => url.startsWith('https://github.com/')));
});

test('installer verifies pinned archive and extracts only the expected binary', async () => {
  const { dir } = fresh();
  const archiveDir = fs.mkdtempSync(path.join(root, 'archive-'));
  fs.writeFileSync(path.join(archiveDir, 'cli-proxy-api'), '#!/bin/sh\nexit 0\n');
  execFileSync('tar', ['-czf', path.join(archiveDir, 'fixture.tar.gz'), '-C', archiveDir, 'cli-proxy-api']);
  const bytes = fs.readFileSync(path.join(archiveDir, 'fixture.tar.gz'));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const name = `CLIProxyAPI_${VERSION}_linux_amd64_no-plugin.tar.gz`;
  const installer = createGatewayService({ dataDir: dir, platform: 'linux', arch: 'x64', fetchImpl: async url => new Response(url.endsWith('checksums.txt') ? `${hash}  ${name}\n` : bytes) }); services.push(installer);
  await installer.install();
  assert.equal(installer.status().installed, true);
  assert.equal(fs.statSync(path.join(dir, 'gateway', 'cli-proxy-api')).mode & 0o777, 0o700);
});

test('port conflict leaves activation disabled and model errors do not reflect provider secrets', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(s.save({ enabled: true, port: occupied.address().port }), /port is already/); }
  finally { await new Promise(resolve => occupied.close(resolve)); }
  assert.equal(s.status().enabled, false);
  await s.disconnect();
});

test('provider errors and malformed responses never echo response bodies', async () => {
  const { dir } = fresh(); fakeBinary(dir);
  let responseKind = 'error';
  const s = createGatewayService({ dataDir: dir, fetchImpl: async url => {
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [] }));
    if (responseKind === 'error') return new Response('fixture-provider-secret', { status: 429 });
    return new Response('fixture-provider-secret');
  } }); services.push(s);
  await s.loginStart(); await until(() => s.status().connected);
  await s.save({ enabled: true, port: await port() });
  await assert.rejects(s.testConnection(), err => /HTTP 429/.test(err.message) && !err.message.includes('fixture-provider-secret'));
  responseKind = 'invalid';
  await assert.rejects(s.testConnection(), err => err.message === 'Gateway returned an invalid response.');
  await s.disconnect();
});

test('provider discovery uses credential catalogs, isolates usage windows and stops temporary proxy', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.save({ enabled: false, port: await port() });
  await s.loginStart(); await until(() => s.status().connected);
  await s.loginStart('claude');
  assert.equal(s.status().running, true, 'Claude login uses a setup-only proxy');
  await s.callback('http://localhost:54545/callback?state=fixture-state&code=fixture-code');
  await s.refreshLogin();
  assert.equal(s.status().running, false, 'setup proxy stops after authorization');
  const before = s.status();
  const result = await s.refreshDiscovery();
  assert.equal(s.status().running, false, 'discovery stops only the temporary proxy');
  assert.equal(s.status().enabled, before.enabled, 'discovery never activates the gateway');
  assert.deepEqual(result.providers.codex.models.items.map(model => model.id), ['gpt-fixture']);
  assert.deepEqual(result.providers.claude.models.items.map(model => model.id), ['claude-fixture']);
  assert.equal(result.providers.claude.usage.accounts[0].windows[0].usedPercent, 0);
  assert.equal(result.providers.claude.usage.accounts[0].windows[0].durationSeconds, 18000);
  assert.equal(result.providers.codex.usage.accounts[0].windows[1].durationSeconds, 604800);
  assert.ok(!JSON.stringify(result).includes('fixture-claude-secret'));
  assert.ok(!JSON.stringify(result).includes('fixture-codex'));
  assert.ok(!JSON.stringify(result).includes('codex-fixture.json'));
  await s.disconnect();
});

test('agent launch routes Claude through scoped wrapper and keeps native mode available', () => {
  const registry = require('../server/services/agentRegistry');
  const terminals = require('../server/services/terminalManager');
  const projects = require('../server/services/projectService');
  const gateway = require('../server/services/gatewayService');
  const project = projects.createProject({ name: 'Gateway launch' });
  const original = { getAgent: registry.getAgent, createSession: terminals.createSession, launchOptions: gateway.launchOptions };
  const launches = [];
  try {
    registry.getAgent = () => ({ id: 'claude', name: 'Claude', installed: true, path: '/usr/bin/claude', defaultArgs: [] });
    terminals.createSession = options => { launches.push(options); return { sessionId: 'gateway-fixture' }; };
    gateway.launchOptions = () => ({ command: process.execPath, args: ['/wrapper.js', '/private/runtime/launch.json'] });
    registry.launchAgent({ projectId: project.id, agentId: 'claude', extraArgs: ['argument with spaces'] });
    assert.equal(launches[0].command, process.execPath);
    assert.deepEqual(launches[0].args, ['/wrapper.js', '/private/runtime/launch.json', '/usr/bin/claude', 'argument with spaces']);
    gateway.launchOptions = () => null;
    registry.launchAgent({ projectId: project.id, agentId: 'claude' });
    assert.equal(launches[1].command, undefined);
  } finally {
    registry.getAgent = original.getAgent; terminals.createSession = original.createSession; gateway.launchOptions = original.launchOptions;
  }
});

test('typing claude in a project shell receives gateway settings, including through tmux', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  await s.save({ enabled: true, port: await port(), planningModel: 'fixture-plan', executionModel: 'fixture-run', smallModel: 'fixture-small' });
  const gateway = require('../server/services/gatewayService');
  const terminals = require('../server/services/terminalManager');
  const projects = require('../server/services/projectService');
  const project = projects.createProject({ name: 'Typed Claude gateway' });
  const fixtureBin = path.join(dir, 'fixture-bin'); fs.mkdirSync(fixtureBin);
  const report = path.join(dir, 'claude-report.json');
  fs.writeFileSync(path.join(fixtureBin, 'claude'), `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ base: process.env.ANTHROPIC_BASE_URL, plan: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, run: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, model: process.env.ANTHROPIC_MODEL, credentialPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN) }));
`, { mode: 0o700 });
  const fixtureShell = path.join(fixtureBin, 'test-shell');
  fs.writeFileSync(fixtureShell, '#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n', { mode: 0o700 });
  const original = { launch: gateway.launchOptions, shell: process.env.SHELL, home: process.env.HOME };
  let session;
  try {
    gateway.launchOptions = () => s.launchOptions();
    process.env.SHELL = fixtureShell; process.env.HOME = dir;
    session = terminals.createSession({ projectId: project.id, name: 'Gateway regression shell' });
    const active = terminals.activePtySessions.get(session.sessionId);
    await until(() => active.buffer.includes('AI Gateway active for this project terminal'));
    // Only the fixture binary is invoked; never call a host's logged-in CLI.
    const quoted = `'${fixtureBin.replace(/'/g, "'\\''")}'`;
    active.ptyProcess.write(`export PATH=${quoted}:"$PATH"; claude\r`);
    await until(() => fs.existsSync(report));
    assert.deepEqual(JSON.parse(fs.readFileSync(report)), { base: `http://127.0.0.1:${s.status().port}`, plan: 'citadel-planning', run: 'citadel-execution', model: 'opusplan', credentialPresent: true });
    assert.ok(!active.buffer.includes(JSON.parse(fs.readFileSync(s.launchOptions().args[1])).token));
  } finally {
    if (session) terminals.killSession(session.sessionId);
    gateway.launchOptions = original.launch;
    if (original.shell === undefined) delete process.env.SHELL; else process.env.SHELL = original.shell;
    if (original.home === undefined) delete process.env.HOME; else process.env.HOME = original.home;
    await s.disconnect();
  }
});

test('separate Claude authorization validates callbacks and hot policy changes preserve launch aliases', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  await assert.rejects(s.save({ enabled: true, mode: 'auto' }), /Connect Claude/);
  assert.equal(s.status().mode, 'chatgpt', 'invalid mode activation must not be persisted');
  await s.save({ enabled: false, port: await port() });
  await s.loginStart('claude');
  assert.equal(s.status().login.state, 'waiting_callback');
  assert.equal(s.status().login.provider, 'claude');
  assert.ok(!JSON.stringify(s.status()).includes('fixture-claude-secret'));
  await assert.rejects(s.callback('https://attacker.example/callback?state=fixture-state&code=fake'), /Callback does not match/);
  await assert.rejects(s.callback('http://localhost:54545/callback?state=wrong&code=fake'), /Callback does not match/);
  await assert.rejects(s.callback(null), /Paste the complete/);
  await s.callback('http://localhost:54545/callback?state=fixture-state&code=fixture-code');
  await s.refreshLogin();
  assert.deepEqual(s.status().connections, { codex: true, claude: true });
  assert.equal(s.status().running, false, 'a setup-only proxy stops after authorization');
  assert.equal(s.status().login.state, 'connected');
  await s.save({ enabled: true, mode: 'auto', port: await port() });
  const settingsFile = s.launchOptions().args[1];
  const configFile = path.join(path.dirname(settingsFile), 'config.json');
  let proxy = JSON.parse(fs.readFileSync(configFile));
  assert.equal(proxy.oauth['model-alias'].claude[1].alias, 'citadel-execution');
  assert.equal(proxy.oauth['model-alias'].codex[1].alias, 'citadel-execution');
  assert.equal(proxy.oauth['request-scoped-errors'].claude.find(r => r.status === 403).action, 'stop');
  const authDir = proxy.oauth['auth-dir'];
  assert.equal(JSON.parse(fs.readFileSync(path.join(authDir, 'claude-fixture.json'))).priority, 100);
  assert.equal(JSON.parse(fs.readFileSync(path.join(authDir, 'codex-fixture.json'))).priority, 50);
  const encrypted = getDatabase().prepare("SELECT value FROM app_config WHERE key = 'ai.gateway.credentials'").get().value;
  assert.ok(!encrypted.includes('fixture-claude-secret'));
  const before = gatewayEnvironment({}, JSON.parse(fs.readFileSync(settingsFile)));
  await s.save({ enabled: true, mode: 'claude', claudeExecutionModel: 'claude-fixture-updated' });
  assert.equal(s.launchOptions().args[1], settingsFile, 'no restart or new launch file for hot mode switch');
  proxy = JSON.parse(fs.readFileSync(configFile));
  assert.equal(proxy.oauth['model-alias'].codex, undefined);
  assert.equal(proxy.oauth['model-alias'].claude[1].name, 'claude-fixture-updated');
  const after = gatewayEnvironment({}, JSON.parse(fs.readFileSync(settingsFile)));
  assert.equal(before.ANTHROPIC_DEFAULT_SONNET_MODEL, after.ANTHROPIC_DEFAULT_SONNET_MODEL);
  assert.equal(after.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.ok(!JSON.stringify(s.status()).includes(proxy.management['secret-key']));
  await s.disconnect();
});
