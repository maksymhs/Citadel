/** Optional local CLIProxyAPI lifecycle, encrypted credentials and scoped Claude/OpenCode/Codex launch settings. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DATA_DIR } = require('../config');
const { getDatabase } = require('../database/db');
const { encrypt, decrypt } = require('../security/secrets');
const { ALIASES, DEFAULTS, MODES, ROLES, ROLE_PROVIDERS, BALANCE, priorityFor, providerOf, aliasesFor, errorRules, requireConnections, headroomFrom, chooseBalancedPrimary } = require('./gatewayRouting');
const { normalizeModels, normalizeClaudeUsage, normalizeCodexUsage, safeProviderSnapshot } = require('./gatewayDiscoveryService');

const VERSION = '8.0.43';
const RELEASE = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${VERSION}`;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/+()-]{0,159}$/;
const KEY = 'ai.gateway';
const AUTH_KEY = 'ai.gateway.credentials';

function createGatewayService({ dataDir = DATA_DIR, database = getDatabase, fetchImpl = fetch, spawnImpl = spawn, execFileImpl = promisify(execFile), platform = process.platform, arch = process.arch, now = Date.now, balanceIntervalMs = 5 * 60 * 1000 } = {}) {
  const root = path.join(dataDir, 'gateway');
  const binary = path.join(root, 'cli-proxy-api');
  let balanceTimer = null;
  const balance = { evaluatedAt: null, reason: null, headroom: null };
  let runtime = null, processHandle = null, loginHandle = null, login = null, lastError = null, busy = false, credentialTimer = null, loginTimer = null, managementKey = null, pollingLogin = false;
  const discoveryCache = new Map();
  const discoveryGeneration = { value: 0 };
  const DISCOVERY_TTL = { models: 10 * 60 * 1000, usage: 60 * 1000 };
  const lastDiscoveryRefresh = new Map();
  const read = (key) => database().prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value;
  const write = (key, value) => database().prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString());
  const config = () => ({ ...DEFAULTS, claudeEnabled: true, enabled: false, port: 8317, planningModel: 'gpt-6.1-sol', executionModel: 'gpt-6-luna', smallModel: 'gpt-6-luna', ...JSON.parse(read(KEY) || '{}') });
  function credentialEntries() {
    const saved = read(AUTH_KEY);
    return saved ? JSON.parse(decrypt(saved)) : {};
  }
  function connections() {
    const result = { codex: false, claude: false };
    for (const [name, text] of Object.entries(credentialEntries())) {
      try { const provider = providerOf(name, JSON.parse(text)); if (provider) result[provider] = true; } catch { /* not a valid credential */ }
    }
    return result;
  }
  const connected = () => connections().codex;
  const installed = () => { try { return fs.lstatSync(binary).isFile() && !fs.lstatSync(root).isSymbolicLink(); } catch { return false; } };
  const supported = () => ['linux', 'darwin'].includes(platform) && ['x64', 'arm64'].includes(arch);

  async function exclusive(fn) {
    if (busy) throw new Error('Another gateway operation is in progress.');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }
  function prepareRoot() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(root) !== path.join(fs.realpathSync(dataDir), 'gateway')) throw new Error('Gateway directory must not be a symlink.');
    fs.chmodSync(root, 0o700);
  }
  function token() {
    const c = config();
    if (!c.clientKey) { c.clientKey = encrypt(crypto.randomBytes(32).toString('hex')); write(KEY, JSON.stringify(c)); }
    return decrypt(c.clientKey);
  }
  function persistCredentials() {
    if (!runtime) return;
    const dir = path.join(runtime, 'auth');
    const entries = {};
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-zA-Z0-9_.@+-]+\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 256 * 1024) continue;
      const text = fs.readFileSync(file, 'utf8');
      try { JSON.parse(text); } catch { continue; }
      total += Buffer.byteLength(text);
      if (total > 1024 * 1024 || Object.keys(entries).length >= 32) throw new Error('Gateway credential store exceeds its limit.');
      fs.chmodSync(file, 0o600);
      entries[name] = text;
    }
    if (Object.keys(entries).length) {
      const value = JSON.stringify(entries);
      // Avoid an encrypted DB write on every status poll.
      const previous = read(AUTH_KEY);
      if (!previous || decrypt(previous) !== value) write(AUTH_KEY, encrypt(value));
    }
  }
  function releaseIdleRuntime() {
    if (runtime && !processHandle && !loginHandle) {
      fs.rmSync(runtime, { recursive: true, force: true }); runtime = null;
    }
  }
  function ensureRuntime() {
    if (runtime) return;
    prepareRoot();
    // Linux keeps live token material in memory where available. Other systems
    // use a private temporary directory; the durable copy is always encrypted.
    const tempBase = platform === 'linux' && fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
    runtime = fs.mkdtempSync(path.join(tempBase, 'citadel-gateway-'));
    fs.chmodSync(runtime, 0o700);
    fs.mkdirSync(path.join(runtime, 'auth'), { mode: 0o700 });
    const saved = read(AUTH_KEY);
    if (saved) {
      for (const [name, text] of Object.entries(JSON.parse(decrypt(saved)))) {
        if (!/^[a-zA-Z0-9_.@+-]+\.json$/.test(name) || typeof text !== 'string') continue;
        fs.writeFileSync(path.join(runtime, 'auth', name), text, { mode: 0o600 });
      }
    }
    managementKey = crypto.randomBytes(32).toString('hex');
    writeRuntime();
  }
  function writeRuntime() {
    const c = config();
    const key = token();
    const proxy = {
      'config-version': 8,
      server: { host: '127.0.0.1', port: c.port, 'commercial-mode': true, discovery: { enabled: false } },
      // Upstream otherwise captures error request bodies even with request-log=false.
      observability: { logs: { debug: false, 'logging-to-file': false, 'request-log': false }, usage: { 'usage-statistics-enabled': false }, pprof: { enable: false } },
      management: { 'allow-remote': false, 'secret-key': managementKey, 'disable-control-panel': true, 'disable-auto-update-panel': true },
      access: { 'api-keys': [key] },
      oauth: { 'auth-dir': path.join(runtime, 'auth'), 'model-alias': aliasesFor(c), 'request-scoped-errors': { claude: errorRules(), codex: errorRules() } },
      routing: { strategy: 'fill-first', 'session-affinity': true, 'session-affinity-rebind-on': 'quota', retry: { 'request-retry': 0, 'max-retry-interval': 0 } },
    };
    for (const name of fs.readdirSync(path.join(runtime, 'auth'))) {
      if (!/^[a-zA-Z0-9_.@+-]+\.json$/.test(name)) continue;
      const file = path.join(runtime, 'auth', name);
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).size > 256 * 1024) continue;
      try {
        const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
        const provider = providerOf(name, metadata);
        const priority = priorityFor(c.mode, provider, c.balancedPrimary === 'codex' ? 'codex' : BALANCE.defaultPrimary);
        if (provider && metadata.priority !== priority) { metadata.priority = priority; fs.writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 }); }
      } catch { /* temporary or unrelated files do not become credentials */ }
    }
    // Pinned CLIProxyAPI watches this inode; rename replacement loses its watch.
    fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify(proxy), { mode: 0o600 });
    const codexBinDir = path.join(root, 'launch-bin');
    if (c.codexEnabled) {
      fs.mkdirSync(codexBinDir, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(codexBinDir).isDirectory() || fs.lstatSync(codexBinDir).isSymbolicLink()) throw new Error('Gateway launch directory must not be a symlink.');
      fs.chmodSync(codexBinDir, 0o700);
      const shim = path.join(codexBinDir, 'codex');
      try { if (!fs.lstatSync(shim).isFile()) throw new Error('Invalid gateway Codex launcher.'); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      const launcher = path.resolve(__dirname, '../../scripts/gateway-launch.js');
      fs.writeFileSync(shim, `#!${process.execPath}\nrequire(${JSON.stringify(launcher)}).codexShell();\n`, { mode: 0o700 });
    }
    fs.writeFileSync(path.join(runtime, 'launch.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${c.port}`, token: key, planningModel: c.planningModel, executionModel: c.executionModel, smallModel: c.smallModel, mode: c.mode, aliases: ALIASES, contextTokens: c.contextTokens, claudeEnabled: c.claudeEnabled !== false, opencodeEnabled: Boolean(c.opencodeEnabled), codexEnabled: Boolean(c.codexEnabled), codexBinDir }), { mode: 0o600 });
  }
  function spawnGateway(args) {
    const child = spawnImpl(binary, ['--config', path.join(runtime, 'config.json'), '--local-model', ...args], {
      cwd: runtime, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: runtime, TMPDIR: runtime }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Provider output may contain credential material. Never forward it to logs.
    child.stdout?.resume(); child.stderr?.resume();
    return child;
  }
  function request(url, options = {}) {
    return fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
  }
  async function api(route, body, { management = false, method } = {}) {
    const c = config();
    if (!processHandle) throw new Error('Gateway is not running.');
    const res = await request(`http://127.0.0.1:${c.port}${route}`, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${management ? managementKey : token()}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Gateway request failed (HTTP ${res.status}). Check account access and model availability.`); }
    // Neither provider error bodies nor generated content are reflected to clients.
    const text = await boundedBody(res, 1024 * 1024);
    try { return JSON.parse(text.toString('utf8')); } catch { throw new Error('Gateway returned an invalid response.'); }
  }
  async function boundedBody(res, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Gateway response exceeded its size limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function download(name, limit) {
    let url = `${RELEASE}/${name}`;
    for (let i = 0; i < 5; i++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error('Untrusted gateway download destination.');
      const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) throw new Error('Invalid release redirect.');
        url = new URL(location, url).href;
        continue;
      }
      if (!res.ok) throw new Error('Gateway download failed.');
      return boundedBody(res, limit);
    }
    throw new Error('Too many release redirects.');
  }
  async function install() {
    return exclusive(async () => {
      if (!supported()) throw new Error('Gateway installation supports Linux/macOS on x64/arm64.');
      if (installed()) return status();
      prepareRoot();
      const suffix = platform === 'linux' ? '_no-plugin' : '';
      const asset = `CLIProxyAPI_${VERSION}_${platform}_${arch === 'arm64' ? 'aarch64' : 'amd64'}${suffix}.tar.gz`;
      const temp = fs.mkdtempSync(path.join(root, 'install-'));
      try {
        const [archive, checksums] = await Promise.all([download(asset, 100 * 1024 * 1024), download('checksums.txt', 128 * 1024)]);
        const line = checksums.toString('utf8').split('\n').find(line => line.trim().split(/\s+/).at(-1)?.replace(/^\*/, '') === asset);
        const hash = line?.trim().split(/\s+/)[0];
        if (!hash || hash !== crypto.createHash('sha256').update(archive).digest('hex')) throw new Error('Gateway checksum verification failed.');
        const archivePath = path.join(temp, 'gateway.tar.gz');
        fs.writeFileSync(archivePath, archive, { mode: 0o600 });
        await execFileImpl('tar', ['-xzf', archivePath, '-C', temp, 'cli-proxy-api'], { timeout: 15000, maxBuffer: 1024 * 1024 });
        const extracted = path.join(temp, 'cli-proxy-api');
        if (!fs.lstatSync(extracted).isFile() || fs.lstatSync(extracted).isSymbolicLink()) throw new Error('Invalid gateway archive.');
        fs.chmodSync(extracted, 0o700);
        fs.renameSync(extracted, binary);
      } catch (err) {
        // Low-level network/tar messages can contain paths or provider data.
        if (/checksum|supports|Invalid gateway/.test(err.message)) throw err;
        throw new Error('Could not install gateway. Check network access and that tar is installed.');
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
      return status();
    });
  }
  function status() {
    const c = config();
    return { version: VERSION, supported: supported(), installed: installed(), enabled: c.enabled, running: Boolean(processHandle), connected: connected(), port: c.port,
      planningModel: c.planningModel, executionModel: c.executionModel, smallModel: c.smallModel,
      mode: c.mode, claudeEnabled: c.claudeEnabled !== false, opencodeEnabled: Boolean(c.opencodeEnabled), codexEnabled: Boolean(c.codexEnabled), contextTokens: c.contextTokens, claudePlanningModel: c.claudePlanningModel, claudeExecutionModel: c.claudeExecutionModel, claudeSmallModel: c.claudeSmallModel, connections: connections(), aliases: ALIASES,
      planningProvider: c.planningProvider, executionProvider: c.executionProvider, smallProvider: c.smallProvider, balance: balanceStatus(),
      busy, error: lastError, login: login ? { state: login.state, provider: login.provider, url: login.url, code: login.code, expiresAt: login.expiresAt } : null };
  }
  async function loginStart(provider = 'codex') {
    return exclusive(async () => {
      invalidateDiscovery();
      if (!installed()) throw new Error('Install the gateway first.');
      if (!['codex', 'claude'].includes(provider)) throw new Error('Unknown gateway provider.');
      if (loginHandle || ['waiting_callback', 'exchanging'].includes(login?.state)) throw new Error('Finish or disconnect the pending login first.');
      ensureRuntime();
      if (provider === 'claude') {
        await start({ setup: true });
        try {
          // is_webui=false avoids the upstream wildcard callback listener. The
          // operator submits the redirect URL through Citadel's authenticated UI.
          const result = await api('/v8/management/oauth/auth-url?provider=claude&is_webui=false', null, { management: true });
          const url = new URL(result.url);
          const redirect = new URL(url.searchParams.get('redirect_uri'));
          if (url.origin !== 'https://claude.ai' || url.pathname !== '/oauth/authorize' || !result.state || url.searchParams.get('state') !== result.state || redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname) || redirect.pathname !== '/callback' || redirect.port !== '54545') throw new Error();
          login = { provider, state: 'waiting_callback', url: url.href, oauthState: result.state, redirect: redirect.href, expiresAt: new Date(Date.now() + 5 * 60000).toISOString() };
          clearInterval(loginTimer);
          loginTimer = setInterval(() => { refreshLogin().catch(() => {}); }, 2000); loginTimer.unref();
          return status();
        } catch {
          login = { provider, state: 'failed' };
          if (!config().enabled) await stopSetupGateway();
          throw new Error('Could not start Claude authorization. Try connecting again.');
        }
      }
      login = { provider, state: 'starting' };
      const child = spawnGateway(['--codex-device-login', '--no-browser']);
      loginHandle = child;
      let output = '';
      const capture = chunk => {
        output = (output + chunk.toString()).slice(-8192);
        const code = output.match(/Codex device code:\s*([A-Z0-9-]{4,32})/i)?.[1];
        if (code && login.state !== 'waiting') login = { provider, state: 'waiting', url: 'https://auth.openai.com/codex/device', code, expiresAt: new Date(Date.now() + 15 * 60000).toISOString() };
      };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      const timer = setTimeout(() => child.kill('SIGTERM'), 16 * 60000); timer.unref();
      child.on('error', () => { lastError = 'Could not start ChatGPT login.'; });
      child.on('close', code => {
        clearTimeout(timer);
        if (loginHandle !== child) return;
        loginHandle = null;
        try { persistCredentials(); } catch { lastError = 'Could not save gateway credentials.'; }
        invalidateDiscovery();
        login = { provider, state: code === 0 && connected() ? 'connected' : 'failed' };
        if (processHandle) writeRuntime();
        releaseIdleRuntime();
      });
      return status();
    });
  }
  async function freePort(port) {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', () => reject(new Error('Gateway port is already in use. Choose another port.'))); server.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  }
  async function callback(input) {
    return exclusive(async () => {
      if (!login || login.provider !== 'claude' || login.state !== 'waiting_callback' || Date.now() >= Date.parse(login.expiresAt)) throw new Error('Claude login is not pending or expired. Connect again.');
      if (typeof input !== 'string' || input.length > 8192) throw new Error('Paste the complete callback URL from the authorization browser tab.');
      let url;
      try { url = new URL(input); } catch { throw new Error('Paste the complete callback URL from the authorization browser tab.'); }
      const expected = new URL(login.redirect);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.searchParams.get('state') !== login.oauthState || !url.searchParams.get('code') || input.length > 8192) throw new Error('Callback does not match this pending Claude login.');
      await api('/v8/management/oauth/callback', { provider: 'claude', redirect_url: url.href }, { management: true });
      login = { ...login, state: 'exchanging' };
      return status();
    });
  }
  async function stopSetupGateway() {
    clearInterval(credentialTimer);
    const child = processHandle; processHandle = null;
    await stopChild(child);
    if (runtime) persistCredentials();
    releaseIdleRuntime();
  }
  async function refreshLogin() {
    if (pollingLogin || busy || !processHandle || login?.provider !== 'claude' || !['waiting_callback', 'exchanging'].includes(login.state)) return;
    pollingLogin = true;
    const pending = login;
    try {
      let result;
      if (Date.now() >= Date.parse(pending.expiresAt)) result = { status: 'error' };
      else result = await api(`/v8/management/oauth/status?state=${encodeURIComponent(pending.oauthState)}`, null, { management: true });
      if (login !== pending || busy || result.status === 'wait') return;
      if (!['ok', 'error'].includes(result.status)) return;
      clearInterval(loginTimer);
      persistCredentials();
      invalidateDiscovery();
      login = { provider: 'claude', state: result.status === 'ok' && connections().claude ? 'connected' : 'failed' };
      if (config().enabled) writeRuntime(); else await stopSetupGateway();
    } catch {
      if (Date.now() >= Date.parse(pending.expiresAt) && login === pending) {
        clearInterval(loginTimer); login = { provider: 'claude', state: 'failed' };
        if (!config().enabled) await stopSetupGateway();
      }
    } finally { pollingLogin = false; }
  }
  async function start({ setup = false } = {}) {
    if (processHandle) return;
    if (!installed()) throw new Error('Install the gateway first.');
    if (!setup) requireConnections(config(), connections());
    ensureRuntime(); writeRuntime();
    await freePort(config().port);
    lastError = null;
    const child = spawnGateway([]);
    processHandle = child;
    child.on('error', () => { lastError = 'Could not start the gateway.'; });
    child.on('close', () => {
      if (processHandle !== child) return;
      processHandle = null;
      clearInterval(credentialTimer); clearBalanceTimer();
      lastError = lastError || 'Gateway stopped. Disable and enable it to restart.';
      try { persistCredentials(); } catch { /* report safe status only */ }
      releaseIdleRuntime();
    });
    for (let i = 0; i < 40; i++) {
      if (!processHandle) break;
      try { await api('/v1/models');
        credentialTimer = setInterval(() => { try { persistCredentials(); } catch { lastError = 'Could not save refreshed gateway credentials.'; } }, 10000);
        credentialTimer.unref(); return;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    await stopChild(child); processHandle = null;
    throw new Error('Gateway did not become ready. Check the port and installation.');
  }
  async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  async function save(input) {
    return exclusive(async () => {
      const c = config();
      if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
      for (const key of ['planningModel', 'executionModel', 'smallModel', 'claudePlanningModel', 'claudeExecutionModel', 'claudeSmallModel']) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'string' || !MODEL.test(input[key])) throw new Error('Invalid model identifier.');
          c[key] = input[key];
        }
      }
      if (input.mode !== undefined) {
        if (!MODES.includes(input.mode)) throw new Error('Mode must be Claude, ChatGPT, Auto, By role or Balanced.');
        c.mode = input.mode;
      }
      for (const key of ['claudeEnabled', 'opencodeEnabled', 'codexEnabled']) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
          c[key] = input[key];
        }
      }
      for (const role of ROLES) {
        if (input[role.provider] !== undefined) {
          if (!ROLE_PROVIDERS.includes(input[role.provider])) throw new Error('Role provider must be Claude or ChatGPT.');
          c[role.provider] = input[role.provider];
        }
      }
      if (input.contextTokens !== undefined) {
        if (!Number.isInteger(input.contextTokens) || input.contextTokens < 32000 || input.contextTokens > 1000000) throw new Error('Context budget must be an integer between 32000 and 1000000 tokens.');
        c.contextTokens = input.contextTokens;
      }
      if (input.enabled) requireConnections(c, connections());
      if (input.port !== undefined) {
        if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('Port must be between 1024 and 65535.');
        if (processHandle && c.port !== input.port) throw new Error('Disable the gateway before changing its port.');
        c.port = input.port;
      }
      // Persist enabled only after the process is actually healthy.
      const enabled = input.enabled;
      c.enabled = false;
      write(KEY, JSON.stringify(c));
      try {
        if (enabled) { await start(); c.clientKey = config().clientKey; c.enabled = true; write(KEY, JSON.stringify(c)); if (runtime) writeRuntime(); syncBalanceTimer(); }
        else {
          clearBalanceTimer();
          if (login?.provider === 'claude' && ['waiting_callback', 'exchanging'].includes(login.state)) { clearInterval(loginTimer); login = { provider: 'claude', state: 'failed' }; }
          clearInterval(credentialTimer); const child = processHandle; processHandle = null; await stopChild(child); if (runtime) persistCredentials(); releaseIdleRuntime(); }
      } catch (err) { lastError = err.message; throw err; }
      return status();
    });
  }
  async function models() {
    const data = await api('/v1/models');
    return (data.data || []).map(m => m.id).filter(id => typeof id === 'string' && MODEL.test(id)).slice(0, 256);
  }
  function invalidateDiscovery() { discoveryGeneration.value++; discoveryCache.clear(); lastDiscoveryRefresh.clear(); }
  function discoverySnapshot() {
    const connectedProviders = connections();
    return { providers: Object.fromEntries(['codex', 'claude'].map(provider => {
      const cached = discoveryCache.get(provider);
      return [provider, safeProviderSnapshot(connectedProviders[provider], cached)];
    })) };
  }
  function parseManagementBody(result) {
    if (!Number.isInteger(result?.status_code) || result.status_code < 200 || result.status_code >= 300 || typeof result.body !== 'string' || result.body.length > 1024 * 1024) throw new Error('Provider information is unavailable.');
    try { return JSON.parse(result.body); } catch { throw new Error('Provider information is unavailable.'); }
  }
  async function upstreamUsage(authIndex, provider) {
    const claude = provider === 'claude';
    const result = await api('/v8/management/requests/api-call', {
      auth_index: authIndex,
      method: 'GET',
      url: claude ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage',
      header: claude ? {
        Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
        'User-Agent': 'claude-cli/2.1.280 (external, cli)', 'anthropic-beta': 'oauth-2025-04-20',
      } : {
        Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
        'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
      },
    }, { management: true });
    return parseManagementBody(result);
  }
  async function usageStateFor(provider, files) {
    const credentials = files.filter(file => String(file.provider || file.type || '').toLowerCase() === provider && (typeof file.auth_index === 'string' || Number.isSafeInteger(file.auth_index)) && String(file.auth_index).length <= 128 && !file.disabled).slice(0, 8);
    const accounts = await Promise.all(credentials.map(async (_, index) => {
      try {
        const payload = await upstreamUsage(credentials[index].auth_index, provider);
        const windows = provider === 'claude' ? normalizeClaudeUsage(payload) : normalizeCodexUsage(payload);
        return { label: `Account ${index + 1}`, status: windows.length ? 'available' : 'unavailable', windows };
      } catch { return { label: `Account ${index + 1}`, status: 'unavailable', windows: [] }; }
    }));
    return { status: accounts.some(account => account.status === 'available') ? (accounts.every(account => account.status === 'available') ? 'available' : 'partial') : 'unavailable', fetchedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + DISCOVERY_TTL.usage).toISOString(), stale: false, accounts };
  }
  function balanceState() {
    const c = config();
    return { primary: c.balancedPrimary === 'codex' ? 'codex' : BALANCE.defaultPrimary, switchedAt: Number(c.balancedSwitchedAt) || 0 };
  }
  function clearBalanceTimer() { clearTimeout(balanceTimer); balanceTimer = null; }
  function syncBalanceTimer() {
    clearBalanceTimer();
    const c = config();
    if (!processHandle || !c.enabled || c.mode !== 'balanced') { balance.reason = null; balance.evaluatedAt = null; return; }
    const tick = (delay) => {
      balanceTimer = setTimeout(() => { balanceNow().catch(() => {}).finally(() => { if (balanceTimer) tick(balanceIntervalMs); }); }, delay);
      balanceTimer.unref();
    };
    tick(Math.min(10000, balanceIntervalMs));
  }
  // Reads each connected provider's usage windows and moves the Auto priority to
  // the provider with more headroom. It only rewrites priorities; running
  // conversations keep their provider through session affinity.
  async function balanceNow() {
    if (busy) return balanceStatus();
    busy = true;
    try {
      const c = config();
      if (c.mode !== 'balanced' || !c.enabled || !processHandle) return balanceStatus();
      const connectedProviders = connections();
      const headroom = {};
      try {
        const authFiles = await api('/v8/management/credentials', null, { management: true });
        const files = Array.isArray(authFiles.files) ? authFiles.files.slice(0, 64) : [];
        for (const provider of ['claude', 'codex']) {
          headroom[provider] = connectedProviders[provider] ? headroomFrom(await usageStateFor(provider, files), now()) : null;
        }
      } catch { headroom.claude = null; headroom.codex = null; }
      const current = balanceState();
      const decision = chooseBalancedPrimary({ headroom, current: current.primary, switchedAt: current.switchedAt, now: now() });
      balance.evaluatedAt = new Date(now()).toISOString();
      balance.reason = decision.reason;
      balance.headroom = { claude: headroom.claude ?? null, codex: headroom.codex ?? null };
      if (decision.switched) {
        const next = config();
        next.balancedPrimary = decision.primary; next.balancedSwitchedAt = now();
        write(KEY, JSON.stringify(next));
        if (runtime) writeRuntime();
      }
      return balanceStatus();
    } finally { busy = false; }
  }
  function balanceStatus() {
    const c = config();
    if (c.mode !== 'balanced') return null;
    const current = balanceState();
    return { primary: current.primary, switchedAt: current.switchedAt ? new Date(current.switchedAt).toISOString() : null, evaluatedAt: balance.evaluatedAt, reason: balance.reason, headroom: balance.headroom || null };
  }
  async function refreshDiscovery({ provider: onlyProvider } = {}) {
    return exclusive(async () => {
      const now = Date.now();
      const refreshKey = onlyProvider || 'all';
      if (now - (lastDiscoveryRefresh.get(refreshKey) || 0) < 30000) return discoverySnapshot();
      lastDiscoveryRefresh.set(refreshKey, now);
      const connectedProviders = connections();
      const targets = onlyProvider ? [onlyProvider] : ['codex', 'claude'];
      if (targets.some(provider => connectedProviders[provider]) && !processHandle) {
        if (!installed()) return discoverySnapshot();
        if (loginHandle || ['waiting', 'waiting_callback', 'exchanging', 'starting'].includes(login?.state)) throw new Error('Finish the pending provider login before refreshing discovery.');
      }
      const startedHere = !processHandle && targets.some(provider => connectedProviders[provider]);
      const generation = discoveryGeneration.value;
      try {
        if (startedHere) await start({ setup: true });
        if (!processHandle) return discoverySnapshot();
        const authFiles = await api('/v8/management/credentials', null, { management: true });
        const files = Array.isArray(authFiles.files) ? authFiles.files.slice(0, 64) : [];
        for (const provider of targets) {
          if (!connectedProviders[provider]) { discoveryCache.delete(provider); continue; }
          const previous = discoveryCache.get(provider) || {};
          let modelState = previous.models;
          let usageState = previous.usage;
          let modelError = false, usageError = false;
          try {
            const credentials = files.filter(file => String(file.provider || file.type || '').toLowerCase() === provider && typeof file.name === 'string' && (typeof file.auth_index === 'string' || Number.isSafeInteger(file.auth_index)) && String(file.auth_index).length <= 128 && !file.disabled);
            const catalogs = await Promise.all(credentials.map(async file => {
              try {
                const result = await api(`/v8/management/credentials/models?name=${encodeURIComponent(file.name)}`, null, { management: true });
                return normalizeModels(result.models);
              } catch { return []; }
            }));
            let items = normalizeModels(catalogs.flat());
            let source = 'credential_catalog';
            if (!items.length) {
              const definitions = await api(`/v8/management/routing/model-definitions/${provider}`, null, { management: true });
              items = normalizeModels(definitions.models);
              source = 'proxy_catalog';
            }
            modelState = { status: items.length ? 'available' : 'unavailable', source: items.length ? source : null, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + DISCOVERY_TTL.models).toISOString(), stale: false, items };
          } catch { modelError = true; }
          try {
            usageState = await usageStateFor(provider, files);
            usageError = usageState.status === 'unavailable';
          } catch { usageError = true; }
          if (generation === discoveryGeneration.value) {
            const markStale = state => state ? { ...state, stale: true } : state;
            discoveryCache.set(provider, {
              models: modelError ? markStale(modelState) : modelState,
              usage: usageError ? markStale(usageState) : usageState,
              error: modelError || usageError,
            });
          }
        }
      } finally {
        if (startedHere && processHandle) await stopSetupGateway();
      }
      return discoverySnapshot();
    });
  }
  async function testConnection() {
    const c = config();
    const result = await api('/v1/messages', { model: ALIASES.execution, max_tokens: 64, messages: [{ role: 'user', content: 'Reply OK.' }] });
    if (result.type !== 'message' || !Array.isArray(result.content) || result.error) throw new Error('Gateway did not return a valid model response.');
    return { ok: true, model: MODEL.test(result.model || '') ? result.model : ALIASES.execution, mode: c.mode };
  }
  function launchOptions(client = 'claude') {
    if (!['shell', 'claude', 'opencode', 'codex'].includes(client)) return null;
    if (client !== 'shell' && !config()[`${client}Enabled`]) return null;
    if (!config().enabled) return null;
    if (!processHandle || !runtime) throw new Error('AI Gateway is enabled but stopped. Restart it in Settings → AI Gateway.');
    return { command: process.execPath, args: [path.resolve(__dirname, '../../scripts/gateway-launch.js'), path.join(runtime, 'launch.json'), ...(!['shell', 'claude'].includes(client) ? ['--client', client] : [])] };
  }
  async function close() {
    clearInterval(credentialTimer); clearInterval(loginTimer); clearBalanceTimer();
    login = login && ['connected', 'failed'].includes(login.state) ? login : null;
    const children = [loginHandle, processHandle]; loginHandle = null; processHandle = null;
    await Promise.all(children.map(stopChild));
    if (runtime) {
      try { persistCredentials(); }
      finally { fs.rmSync(runtime, { recursive: true, force: true }); runtime = null; }
    }
  }
  async function disconnect() {
    return exclusive(async () => {
      await close();
      const c = config(); c.enabled = false; write(KEY, JSON.stringify(c));
      invalidateDiscovery();
      database().prepare('DELETE FROM app_config WHERE key = ?').run(AUTH_KEY);
      login = null; lastError = null;
      return status();
    });
  }
  async function resume() { if (config().enabled) { try { await start(); syncBalanceTimer(); } catch { lastError = 'AI Gateway could not resume. Open Settings → AI Gateway.'; } } }
  return { status, install, loginStart, save, models, discovery: discoverySnapshot, refreshDiscovery, testConnection, launchOptions, close, disconnect, resume, callback, refreshLogin, balanceNow };
}
module.exports = { ...createGatewayService(), createGatewayService, VERSION };
