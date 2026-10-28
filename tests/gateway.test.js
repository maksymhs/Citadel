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
const { gatewayEnvironment, opencodeEnvironment, codexLaunch } = require('../scripts/gateway-launch');
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
        let override = {}; try { override = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'usage-override.json'), 'utf8')); } catch { /* default fixture */ }
        const used = call.url.includes('anthropic.com') ? override.claude : override.codex;
        if (used === 'fail') { res.end(JSON.stringify({ status_code: 500, body: '{}', header: {} })); return; }
        const payload = typeof used === 'number' ? (call.url.includes('anthropic.com') ? { five_hour: { utilization: used, resets_at: new Date(Date.now() + 3600000).toISOString() } } : { rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000, reset_after_seconds: 1200 } } }) : call.url.includes('anthropic.com') ? { five_hour: { utilization: 0, resets_at: new Date(Date.now() + 3600000).toISOString() }, seven_day: { utilization: 25, resets_at: new Date(Date.now() + 86400000).toISOString() } } : { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 1200 }, secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 7200 } } };
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
    gateway.status = () => ({ enabled: true, opencodeEnabled: true, codexEnabled: true });
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/api/terminals', cookies, payload: { projectId: 'fixture' } })).statusCode, 403);
      for (const agentId of ['claude', 'opencode', 'codex']) assert.equal((await app.inject({ method: 'POST', url: '/api/agents/launch', cookies, payload: { projectId: 'fixture', agentId } })).statusCode, 403);
    } finally { gateway.status = originalStatus; }
  } finally { getDatabase().prepare("UPDATE users SET role = 'admin'").run(); }
  const result = await app.inject({ url: '/api/settings/gateway', cookies });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().gateway.enabled, false);
  assert.equal(result.json().gateway.running, false);
  assert.equal(result.json().gateway.contextTokens, 1000000, 'fresh status reports the 1M default');
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
  const env = gatewayEnvironment({ ANTHROPIC_API_KEY: 'old-key', CLAUDE_CODE_OAUTH_TOKEN: 'old-token', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000', KEEP: 'yes' }, settings);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'citadel-planning');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000', 'configured context budget replaces an inherited lower value');
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
    registry.getAgent = () => ({ id: 'opencode', name: 'OpenCode', installed: true, path: '/usr/bin/opencode', defaultArgs: [] });
    gateway.launchOptions = client => {
      assert.equal(client, 'opencode');
      return { command: process.execPath, args: ['/wrapper.js', '/private/runtime/launch.json', '--client', client] };
    };
    registry.launchAgent({ projectId: project.id, agentId: 'opencode' });
    assert.deepEqual(launches[2].args, ['/wrapper.js', '/private/runtime/launch.json', '--client', 'opencode', '/usr/bin/opencode']);
    gateway.launchOptions = () => null;
    registry.launchAgent({ projectId: project.id, agentId: 'opencode' });
    assert.equal(launches[3].command, undefined);
  } finally {
    registry.getAgent = original.getAgent; terminals.createSession = original.createSession; gateway.launchOptions = original.launchOptions;
  }
});

test('typing claude in a project shell receives gateway settings, including through tmux', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  await s.save({ enabled: true, codexEnabled: true, port: await port(), planningModel: 'fixture-plan', executionModel: 'fixture-run', smallModel: 'fixture-small' });
  const gateway = require('../server/services/gatewayService');
  const terminals = require('../server/services/terminalManager');
  const projects = require('../server/services/projectService');
  const project = projects.createProject({ name: 'Typed Claude gateway' });
  const fixtureBin = path.join(dir, 'fixture-bin'); fs.mkdirSync(fixtureBin);
  const report = path.join(dir, 'claude-report.json');
  fs.writeFileSync(path.join(fixtureBin, 'claude'), `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ base: process.env.ANTHROPIC_BASE_URL, plan: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL, run: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, model: process.env.ANTHROPIC_MODEL, context: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, credentialPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN) }));
`, { mode: 0o700 });
  const codexReport = path.join(dir, 'codex-report.json');
  fs.writeFileSync(path.join(fixtureBin, 'codex'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(codexReport)}, JSON.stringify({ args: process.argv.slice(2), credentialPresent: Boolean(process.env.CITADEL_GATEWAY_TOKEN) }));\n`, { mode: 0o700 });
  const fixtureShell = path.join(fixtureBin, 'test-shell');
  fs.writeFileSync(fixtureShell, '#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n', { mode: 0o700 });
  const original = { launch: gateway.launchOptions, shell: process.env.SHELL, home: process.env.HOME, context: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, path: process.env.PATH };
  let session;
  try {
    gateway.launchOptions = () => s.launchOptions();
    process.env.PATH = fixtureBin + path.delimiter + process.env.PATH;
    process.env.SHELL = fixtureShell; process.env.HOME = dir; process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '200000';
    session = terminals.createSession({ projectId: project.id, name: 'Gateway regression shell' });
    const active = terminals.activePtySessions.get(session.sessionId);
    await until(() => active.buffer.includes('AI Gateway active for this project terminal'));
    // Only the fixture binary is invoked; never call a host's logged-in CLI.
    const quoted = `'${fixtureBin.replace(/'/g, "'\\''")}'`;
    active.ptyProcess.write(`export PATH=${quoted}:"$PATH"; claude\r`);
    await until(() => fs.existsSync(report));
    assert.deepEqual(JSON.parse(fs.readFileSync(report)), { base: `http://127.0.0.1:${s.status().port}`, plan: 'citadel-planning', run: 'citadel-execution', model: 'opusplan', context: '1000000', credentialPresent: true });
    const codexSettings = JSON.parse(fs.readFileSync(s.launchOptions().args[1]));
    active.ptyProcess.write(`export PATH='${codexSettings.codexBinDir}':"$PATH"; codex fixture-argument\r`);
    await until(() => fs.existsSync(codexReport));
    const codexResult = JSON.parse(fs.readFileSync(codexReport));
    assert.equal(codexResult.credentialPresent, true);
    assert.ok(codexResult.args.includes('model_provider="citadel"'));
    assert.equal(codexResult.args.at(-1), 'fixture-argument');
    assert.ok(!active.buffer.includes(JSON.parse(fs.readFileSync(s.launchOptions().args[1])).token));
  } finally {
    if (session) terminals.killSession(session.sessionId);
    gateway.launchOptions = original.launch;
    process.env.PATH = original.path;
    if (original.shell === undefined) delete process.env.SHELL; else process.env.SHELL = original.shell;
    if (original.home === undefined) delete process.env.HOME; else process.env.HOME = original.home;
    if (original.context === undefined) delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS; else process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = original.context;
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
  await s.save({ enabled: true, mode: 'auto-chatgpt' });
  proxy = JSON.parse(fs.readFileSync(configFile));
  assert.ok(proxy.oauth['model-alias'].claude && proxy.oauth['model-alias'].codex);
  assert.equal(JSON.parse(fs.readFileSync(path.join(authDir, 'claude-fixture.json'))).priority, 50);
  assert.equal(JSON.parse(fs.readFileSync(path.join(authDir, 'codex-fixture.json'))).priority, 100);
  await s.save({ enabled: true, mode: 'claude' });
  const after = gatewayEnvironment({}, JSON.parse(fs.readFileSync(settingsFile)));
  assert.equal(before.ANTHROPIC_DEFAULT_SONNET_MODEL, after.ANTHROPIC_DEFAULT_SONNET_MODEL);
  assert.equal(after.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.ok(!JSON.stringify(s.status()).includes(proxy.management['secret-key']));
  await s.disconnect();
});


test('OpenCode is opt-in, uses the shared private launch config and preserves native clients', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  await s.save({ enabled: true, port: await port() });
  assert.equal(s.status().opencodeEnabled, false);
  assert.equal(s.launchOptions('opencode'), null);
  assert.equal(s.launchOptions('codex'), null);
  await assert.rejects(s.save({ enabled: true, opencodeEnabled: 'yes' }), /boolean/);
  await s.save({ enabled: true, opencodeEnabled: true, codexEnabled: true });
  const launch = s.launchOptions('opencode');
  assert.deepEqual(launch.args.slice(2), ['--client', 'opencode']);
  const settings = JSON.parse(fs.readFileSync(launch.args[1]));
  assert.equal(settings.opencodeEnabled, true);
  assert.ok(!JSON.stringify(s.status()).includes(settings.token));
  await s.close();
});

test('OpenCode runtime config routes Plan, Build and small tasks with bounded context', () => {
  const settings = { baseUrl: 'http://127.0.0.1:8317', token: 'fixture-local-key', contextTokens: 64000,
    aliases: { planning: 'citadel-planning', execution: 'citadel-execution', small: 'citadel-small' } };
  const original = JSON.stringify({ theme: 'system', agent: { plan: { temperature: 0.2 } }, provider: { other: {} }, disabled_providers: ['citadel', 'other'], compaction: { reserved: 1 } });
  const env = opencodeEnvironment({ OPENCODE_CONFIG_CONTENT: original, KEEP: 'yes' }, settings);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.model, 'citadel/citadel-execution');
  assert.equal(config.agent.plan.model, 'citadel/citadel-planning');
  assert.equal(config.agent.build.model, 'citadel/citadel-execution');
  assert.equal(config.small_model, 'citadel/citadel-small');
  assert.equal(config.agent.plan.temperature, 0.2);
  assert.deepEqual(config.compaction, { auto: true, prune: true, reserved: 8000 });
  const minimum = JSON.parse(opencodeEnvironment({}, { ...settings, contextTokens: 32000 }).OPENCODE_CONFIG_CONTENT);
  assert.equal(minimum.provider.citadel.models['citadel-execution'].limit.output, 8000);
  assert.equal(minimum.compaction.reserved, 4000);
  assert.equal(config.provider.citadel.options.baseURL, settings.baseUrl + '/v1');
  assert.deepEqual(config.provider.citadel.models['citadel-execution'].limit, { context: 64000, output: 16000 });
  assert.deepEqual(config.enabled_providers, ['citadel']);
  assert.deepEqual(config.disabled_providers, ['other']);
  assert.equal(env.CITADEL_GATEWAY_TOKEN, settings.token);
  assert.ok(!env.OPENCODE_CONFIG_CONTENT.includes(settings.token));
  assert.equal(env.KEEP, 'yes');
  assert.throws(() => opencodeEnvironment({ OPENCODE_CONFIG_CONTENT: 'invalid' }, settings));
});

test('OpenCode direct launch and typed project shell receive the same scoped configuration', () => {
  const dir = fs.mkdtempSync(path.join(root, 'opencode-launch-'));
  const file = path.join(dir, 'launch.json');
  fs.writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:8317', token: 'fixture-local-key', opencodeEnabled: true, contextTokens: 64000 }), { mode: 0o600 });
  const wrapper = path.resolve(__dirname, '../scripts/gateway-launch.js');
  const probe = 'process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT)';
  const options = { encoding: 'utf8', env: { ...process.env, OPENCODE_CONFIG_CONTENT: '' }, stdio: ['ignore', 'pipe', 'pipe'] };
  const direct = execFileSync(process.execPath, [wrapper, file, '--client', 'opencode', process.execPath, '-e', probe], options);
  const shell = execFileSync(process.execPath, [wrapper, '--shell', file, process.execPath, '-e', probe], options);
  assert.deepEqual(JSON.parse(direct), JSON.parse(shell));
  assert.equal(JSON.parse(direct).agent.plan.model, 'citadel/citadel-planning');
  assert.ok(!direct.includes('fixture-local-key'));
});


test('Codex is opt-in and its Responses overrides do not expose the key in arguments', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  await s.save({ enabled: true, port: await port() });
  assert.equal(s.status().codexEnabled, false);
  assert.equal(s.launchOptions('codex'), null);
  await assert.rejects(s.save({ enabled: true, codexEnabled: 1 }), /boolean/);
  await s.save({ enabled: true, codexEnabled: true });
  const launch = s.launchOptions('codex');
  assert.deepEqual(launch.args.slice(2), ['--client', 'codex']);
  const settings = JSON.parse(fs.readFileSync(launch.args[1]));
  assert.equal(settings.codexEnabled, true);
  const overrides = codexLaunch({ KEEP: 'yes', OPENAI_API_KEY: 'native-key' }, settings, ['exec', 'argument with spaces']);
  assert.ok(overrides.args.includes('model_providers.citadel.wire_api="responses"'));
  assert.ok(overrides.args.includes('model_providers.citadel.requires_openai_auth=false'));
  assert.ok(overrides.args.includes('model="citadel-execution"'));
  assert.deepEqual(overrides.args.slice(-2), ['exec', 'argument with spaces']);
  assert.ok(!overrides.args.join(' ').includes(settings.token));
  assert.equal(overrides.env.CITADEL_GATEWAY_TOKEN, settings.token);
  assert.equal(overrides.env.KEEP, 'yes');
  assert.equal(overrides.env.OPENAI_API_KEY, 'native-key');
  assert.equal(fs.statSync(path.join(settings.codexBinDir, 'codex')).mode & 0o777, 0o700);
  assert.ok(!fs.readFileSync(path.join(settings.codexBinDir, 'codex'), 'utf8').includes(settings.token));
  await s.close();
});

test('Codex direct launch and typed codex use the same private settings without changing native config', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  await s.save({ enabled: true, codexEnabled: true, port: await port() });
  const nativeDir = path.join(dir, 'native-bin'); fs.mkdirSync(nativeDir);
  const native = path.join(nativeDir, 'codex');
  fs.writeFileSync(native, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), credentialPresent: Boolean(process.env.CITADEL_GATEWAY_TOKEN) }));\n', { mode: 0o700 });
  const launch = s.launchOptions('codex');
  const options = { encoding: 'utf8', env: { ...process.env, PATH: nativeDir + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] };
  const direct = JSON.parse(execFileSync(launch.command, [...launch.args, native, 'argument with spaces'], options));
  const probe = "process.stdout.write(require('node:child_process').execFileSync('codex', ['argument with spaces'], {encoding:'utf8'}))";
  const shell = JSON.parse(execFileSync(launch.command, [launch.args[0], '--shell', launch.args[1], process.execPath, '-e', probe], options));
  assert.deepEqual(shell, direct);
  assert.equal(shell.credentialPresent, true);
  assert.equal(shell.args.at(-1), 'argument with spaces');
  assert.ok(shell.args.includes('model_provider="citadel"'));
  // Removing native Codex from the resolver PATH must fail closed, not recurse into the shim.
  assert.throws(() => execFileSync(launch.command, [launch.args[0], '--shell', launch.args[1], process.execPath, '-e', probe], { ...options, env: { ...options.env, PATH: JSON.parse(fs.readFileSync(launch.args[1])).codexBinDir } }));
  await s.close();
});


test('Claude activation is independent and disabling it preserves OpenCode project-shell routing', async () => {
  const { dir, service: s } = fresh(); fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  await s.save({ enabled: true, port: await port() });
  assert.equal(s.status().claudeEnabled, true, 'existing installations keep Claude enabled');
  await assert.rejects(s.save({ enabled: true, claudeEnabled: 'yes' }), /boolean/);
  await s.save({ enabled: true, claudeEnabled: false, opencodeEnabled: true });
  assert.equal(s.launchOptions('claude'), null);
  assert.ok(s.launchOptions('opencode'));
  const shell = s.launchOptions('shell');
  assert.ok(shell, 'project shell must not depend on Claude activation');
  const probe = "process.stdout.write(JSON.stringify({claude: !!process.env.ANTHROPIC_BASE_URL, opencode: !!process.env.OPENCODE_CONFIG_CONTENT}))";
  const output = execFileSync(shell.command, [shell.args[0], '--shell', shell.args[1], process.execPath, '-e', probe], {
    encoding: 'utf8', env: { ...process.env, ANTHROPIC_BASE_URL: undefined, OPENCODE_CONFIG_CONTENT: undefined }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.deepEqual(JSON.parse(output), { claude: false, opencode: true });
  await s.close();
});

const routing = require('../server/services/gatewayRouting');

test('role mode publishes each alias on exactly one provider and needs only the assigned accounts', () => {
  const base = { ...routing.DEFAULTS, mode: 'roles', planningModel: 'gpt-p', executionModel: 'gpt-e', smallModel: 'gpt-s' };
  const aliases = routing.aliasesFor(base);
  assert.deepEqual(aliases.claude.map(a => a.alias), ['citadel-planning']);
  assert.deepEqual(aliases.codex.map(a => [a.alias, a.name]), [['citadel-execution', 'gpt-e'], ['citadel-small', 'gpt-s']]);
  const swapped = routing.aliasesFor({ ...base, planningProvider: 'codex', executionProvider: 'claude', smallProvider: 'claude' });
  assert.deepEqual(swapped.codex.map(a => a.alias), ['citadel-planning']);
  assert.deepEqual(swapped.claude.map(a => a.alias), ['citadel-execution', 'citadel-small']);
  const allCodex = routing.aliasesFor({ ...base, planningProvider: 'codex' });
  assert.equal(allCodex.claude, undefined, 'a provider with no role is not published');
  assert.doesNotThrow(() => routing.requireConnections({ ...base, planningProvider: 'codex' }, { codex: true, claude: false }));
  assert.throws(() => routing.requireConnections(base, { codex: true, claude: false }), /Connect Claude/);
  assert.throws(() => routing.requireConnections(base, { codex: false, claude: true }), /Connect ChatGPT/);
});

test('balanced decision uses hysteresis and never switches on missing or stale data', () => {
  const now = Date.now(), old = now - 3600000;
  const pick = (headroom, current = 'claude', switchedAt = 0) => routing.chooseBalancedPrimary({ headroom, current, switchedAt, now });
  assert.equal(pick({ claude: 50, codex: 60 }).primary, 'claude', 'a 10 point gap is below the threshold');
  assert.equal(pick({ claude: 20, codex: 80 }).primary, 'codex');
  assert.equal(pick({ claude: 20, codex: 80 }).switched, true);
  assert.equal(pick({ claude: 20, codex: 80 }, 'claude', now - 60000).primary, 'claude', 'recent switch blocks another change');
  assert.equal(pick({ claude: 20, codex: 80 }, 'claude', old).primary, 'codex');
  assert.equal(pick({ claude: 80, codex: 20 }, 'codex', old).primary, 'claude', 'switches back when roles reverse');
  assert.equal(pick({ claude: null, codex: 80 }).primary, 'claude');
  assert.equal(pick({ claude: 10 }).primary, 'claude');
  assert.equal(pick(null).switched, false);
  const fresh = { fetchedAt: new Date(now).toISOString(), accounts: [{ windows: [{ usedPercent: 30 }, { usedPercent: 90 }] }, { windows: [{ usedPercent: 50 }] }] };
  assert.equal(routing.headroomFrom(fresh, now), 50, 'tightest window per account, best account wins');
  assert.equal(routing.headroomFrom({ ...fresh, fetchedAt: new Date(old).toISOString() }, now), null, 'old readings are ignored');
  assert.equal(routing.headroomFrom({ ...fresh, stale: true }, now), null);
  assert.equal(routing.headroomFrom({ fetchedAt: fresh.fetchedAt, accounts: [{ windows: [{ usedPercent: null }] }] }, now), null);
  assert.equal(routing.priorityFor('roles', 'claude'), 100);
  assert.equal(routing.priorityFor('balanced', 'codex', 'codex'), 100);
  assert.equal(routing.priorityFor('balanced', 'claude', 'codex'), 50);
});

async function connectBoth(s, dir) {
  fakeBinary(dir);
  await s.loginStart(); await until(() => s.status().connected);
  await s.save({ enabled: false, port: await port() });
  await s.loginStart('claude');
  await s.callback('http://localhost:54545/callback?state=fixture-state&code=fixture-code');
  await s.refreshLogin();
  assert.deepEqual(s.status().connections, { codex: true, claude: true });
}

test('role mode validates providers and rewrites aliases in place', async () => {
  const { dir, service: s } = fresh(); await connectBoth(s, dir);
  await assert.rejects(s.save({ enabled: false, mode: 'roles', planningProvider: 'gemini' }), /Role provider/);
  await assert.rejects(s.save({ enabled: false, mode: 'nonsense' }), /Mode must be/);
  const saved = await s.save({ enabled: true, mode: 'roles', port: await port() });
  assert.deepEqual([saved.planningProvider, saved.executionProvider, saved.smallProvider], ['claude', 'codex', 'codex']);
  const settingsFile = s.launchOptions().args[1];
  const configFile = path.join(path.dirname(settingsFile), 'config.json');
  let proxy = JSON.parse(fs.readFileSync(configFile));
  assert.deepEqual(proxy.oauth['model-alias'].claude.map(a => a.alias), ['citadel-planning']);
  assert.deepEqual(proxy.oauth['model-alias'].codex.map(a => a.alias), ['citadel-execution', 'citadel-small']);
  await s.save({ enabled: true, planningProvider: 'codex', executionProvider: 'claude' });
  proxy = JSON.parse(fs.readFileSync(configFile));
  assert.deepEqual(proxy.oauth['model-alias'].codex.map(a => a.alias), ['citadel-planning', 'citadel-small']);
  assert.deepEqual(proxy.oauth['model-alias'].claude.map(a => a.alias), ['citadel-execution']);
  assert.equal(s.launchOptions().args[1], settingsFile, 'role changes need no restart or new launch file');
  await s.disconnect();
});

test('balanced mode moves the primary by remaining headroom and survives missing usage', async () => {
  const getNow = (() => { let t = Date.now(); const f = () => t; f.advance = ms => { t += ms; }; return f; })();
  getDatabase().prepare("DELETE FROM app_config WHERE key LIKE 'ai.gateway%'").run();
  const dir = fs.mkdtempSync(path.join(root, 'instance-'));
  const s = createGatewayService({ dataDir: dir, now: getNow, balanceIntervalMs: 3600000 }); services.push(s);
  await connectBoth(s, dir);
  await s.save({ enabled: true, mode: 'balanced', port: await port() });
  const runtimeDir = path.dirname(s.launchOptions().args[1]);
  const proxy = () => JSON.parse(fs.readFileSync(path.join(runtimeDir, 'config.json')));
  const priority = name => JSON.parse(fs.readFileSync(path.join(proxy().oauth['auth-dir'], name))).priority;
  const usage = value => fs.writeFileSync(path.join(runtimeDir, 'usage-override.json'), JSON.stringify(value));
  assert.ok(proxy().oauth['model-alias'].claude && proxy().oauth['model-alias'].codex, 'balanced publishes both providers');
  assert.equal(s.status().balance.primary, 'claude', 'Claude is the initial primary');
  assert.equal(priority('claude-fixture.json'), 100);
  usage({ claude: 95, codex: 10 });
  let balance = await s.balanceNow();
  assert.equal(balance.primary, 'codex');
  assert.equal(balance.headroom.claude, 5);
  assert.equal(balance.headroom.codex, 90);
  assert.equal(priority('codex-fixture.json'), 100);
  assert.equal(priority('claude-fixture.json'), 50);
  assert.match(balance.reason, /ChatGPT has more headroom/);
  usage({ claude: 5, codex: 95 });
  balance = await s.balanceNow();
  assert.equal(balance.primary, 'codex', 'a recent switch is not reversed immediately');
  getNow.advance(31 * 60000);
  balance = await s.balanceNow();
  assert.equal(balance.primary, 'claude');
  assert.equal(priority('claude-fixture.json'), 100);
  getNow.advance(31 * 60000);
  usage({ claude: 'fail', codex: 0 });
  balance = await s.balanceNow();
  assert.equal(balance.primary, 'claude', 'unavailable usage keeps the current primary');
  assert.equal(balance.headroom.claude, null);
  assert.match(balance.reason, /unavailable/);
  assert.ok(!JSON.stringify(s.status()).includes('fixture-claude-secret'));
  await s.save({ enabled: true, mode: 'chatgpt' });
  assert.equal(s.status().balance, null, 'balance state is hidden outside balanced mode');
  await s.disconnect();
});
