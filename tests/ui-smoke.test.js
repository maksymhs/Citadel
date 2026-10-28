const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Loads the real SPA in jsdom against a real server (own temp data directory)
// and checks that every script initialises and the main screens render. It is
// the safety net for moving code between public/js files: a missing dependency
// or a variable left behind shows up here as a script error.
let JSDOM;
let CookieJar;
let VirtualConsole;
try {
  ({ JSDOM, CookieJar, VirtualConsole } = require('jsdom'));
} catch {
  // jsdom is a devDependency; skip when it is not installed.
}

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('UI smoke (jsdom)', { skip: !JSDOM && 'jsdom is not installed', timeout: 120000 }, () => {
  const port = 3300 + Math.floor(Math.random() * 600);
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ui-'));
  const errors = [];
  let server;
  let dom;
  let w;

  before(async () => {
    fs.mkdirSync(path.join(data, 'projects', 'ui-discovered'), { recursive: true });
    // Every path points into the temp directory: the test must never touch a real install.
    server = spawn('node', ['server/index.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', HOME: data,
        DATA_DIR: data, DATABASE_PATH: path.join(data, 'citadel.db'),
        PROJECTS_DIR: path.join(data, 'projects'), LOGS_DIR: path.join(data, 'logs'),
        CITADEL_SELF_UPDATE: '0', CITADEL_REQUIRE_SETUP_CODE: '0',
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 60; i += 1) {
      try { const r = await fetch(`${base}/api/auth/status`); if (r.status < 500) break; } catch { /* not up yet */ }
      await sleep(200);
    }
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery-1A' }),
    });
    assert.equal(setup.status, 200, 'first-run setup should succeed on an empty data directory');
    const cookie = setup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const jar = new CookieJar();
    for (const c of cookie.split('; ')) jar.setCookieSync(c, base);
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (e) => errors.push(e.message.split('\n')[0]));
    dom = await JSDOM.fromURL(`${base}/`, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, cookieJar: jar, virtualConsole,
      beforeParse(win) {
        win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
        win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        win.fetch = (url, opts = {}) => fetch(new URL(url, base), { ...opts, signal: undefined, headers: { ...(opts.headers || {}), cookie } });
        win.HTMLCanvasElement.prototype.getContext = () => null;
        win.addEventListener('error', (e) => errors.push(e.message));
        win.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason && e.reason.message}`));
      },
    });
    w = dom.window;
    await sleep(2500);
  });

  after(async () => {
    if (dom) dom.window.close();
    if (server) {
      await new Promise((resolve) => {
        server.on('exit', resolve);
        server.kill('SIGTERM');
        setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000);
      });
    }
    fs.rmSync(data, { recursive: true, force: true });
  });

  test('every feature script registers and the app shell renders', () => {
    for (const name of ['CitadelMonitor', 'CitadelDisk', 'CitadelDeployments', 'CitadelFleet', 'CitadelActivity', 'CitadelRepos', 'CitadelFiles', 'CitadelPairing', 'CitadelProjectTools', 'CitadelGatewaySettings', 'CitadelBrowserEditor', 'CitadelChat', 'CitadelTerminalImages']) {
      assert.equal(typeof w[name], 'object', `window.${name} is missing`);
    }
    assert.ok(w.document.querySelector('.nav-item'), 'the sidebar should render after sign-in');
    assert.deepEqual(errors, []);
  });

  test('terminal image helper detects, uploads and pastes only a path for the current terminal', async () => {
    const helper = w.CitadelTerminalImages;
    const file = new w.File(['fixture'], 'clipboard.png', { type: 'image/png' });
    const found = helper.imageFromClipboard({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] });
    assert.equal(found, file);
    assert.equal(helper.imageFromClipboard({ items: [{ kind: 'file', type: 'image/svg+xml', getAsFile: () => file }] }), null);

    const pasted = [];
    const calls = [];
    const toasts = [];
    helper.init({
      apiForHost: async (host, url, options) => {
        calls.push({ host, url, options });
        return { path: '/tmp/citadel-terminal-images-7/image-a.png' };
      },
      showToast: (message) => toasts.push(message),
    });
    const item = { sessionId: 'session-1', disposed: false, term: { paste: (value) => pasted.push(value), focus() {} } };
    const uploadFile = {
      type: 'image/png', size: 8,
      arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
    };
    assert.equal(await helper.upload(item, uploadFile, { hostId: 'peer-1', isCurrent: () => true }), true);
    assert.deepEqual(pasted, ['/tmp/citadel-terminal-images-7/image-a.png']);
    assert.equal(calls[0].host, 'peer-1');
    assert.ok(calls[0].url.endsWith('/session-1/clipboard-image'));
    assert.equal(calls[0].options.body.content, 'iVBORw0KGgo=');
    assert.equal(calls.length, 1, 'image bytes go only to the upload API, not to xterm');

    assert.equal(await helper.upload(item, uploadFile, { hostId: 'peer-1', isCurrent: () => false }), false);
    assert.equal(calls.length, 1, 'a stale terminal must not finish an upload');
    assert.deepEqual(pasted, ['/tmp/citadel-terminal-images-7/image-a.png']);
    assert.ok(toasts.some((message) => message.includes('Press Enter')));
  });

  test('Tools dispatches lifecycle actions and restricts removal to managed agents', async () => {
    const toolsDom = new JSDOM('<div id="dash-machine-pane"></div>', { runScripts: 'dangerously' });
    try {
      const win = toolsDom.window;
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/monitor.js'), 'utf8'));
      const calls = [];
      const agents = [
        { id: 'codex', name: 'Codex', available: true, managed: true, version: '1.0', warning: 'Daemon package missing' },
        { id: 'claude', name: 'Claude', available: true, managed: false },
        { id: 'qwen', name: 'Qwen', available: false },
      ];
      const ctx = {
        isAdmin: true,
        activeHostId: () => 'local',
        escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
        installAgent: (...args) => calls.push(args),
        localApi: async (url) => {
          if (url === '/api/monitor/overview') return { hosts: [{ id: 'local', name: 'Local', isLocal: true, online: true, alerts: [] }] };
          if (url === '/api/system/integrations') return { integrations: { agents } };
          return { tools: [] };
        },
      };
      await win.CitadelMonitor.renderMachine(ctx, 'local', 'tools');
      const buttons = [...win.document.querySelectorAll('[data-mon-install]')];
      assert.equal(buttons.length, 4);
      for (const button of buttons) button.click();
      assert.deepEqual(calls.map((args) => args[3]), ['reinstall', 'remove', 'reinstall', 'install']);
      assert.match(win.document.body.textContent, /Daemon package missing/);
      await win.CitadelMonitor.renderMachine({ ...ctx, isAdmin: false }, 'local', 'tools');
      assert.ok([...win.document.querySelectorAll('[data-mon-install]')].every((button) => button.disabled));
    } finally { toolsDom.window.close(); }
  });

  test('main screens open without script errors', async () => {
    for (const view of ['files', 'settings', 'projects', 'dashboard']) {
      const link = w.document.querySelector(`.nav-item[data-view="${view}"]`);
      assert.ok(link, `nav item ${view} should exist`);
      link.click();
      await sleep(800);
      assert.ok(w.document.getElementById('main-content').innerHTML.length > 100, `${view} rendered nothing`);
    }
    assert.deepEqual(errors, []);
  });

  test('Settings hub and Updates selector use responsive section markup', async () => {
    w.document.querySelector('.nav-item[data-view="settings"]').click();
    await sleep(700);
    assert.equal(w.document.querySelectorAll('.settings-tile[data-settings-section]').length, 7);
    const updateIcon = w.document.querySelector('[data-settings-section="updates"] .settings-tile-icon svg path');
    assert.ok(updateIcon && updateIcon.getAttribute('d').includes('M20 11'), 'Updates uses a connected refresh icon path');
    w.document.querySelector('[data-settings-section="updates"]').click();
    await sleep(500);
    assert.equal(w.document.getElementById('update-channel')?.className, 'form-input');
    w.document.querySelector('.top-bar-back')?.click();
    await sleep(300);
    assert.deepEqual(errors, []);
  });

  test('AI Gateway settings expose installation, login and 1M context controls', async () => {
    w.document.querySelector('.nav-item[data-view="settings"]').click();
    await sleep(800);
    const tile = w.document.querySelector('[data-settings-section="gateway"]');
    assert.ok(tile, 'AI Gateway is reachable from Settings');
    assert.match(tile.textContent, /AI Gateway/);
    tile.click();
    await sleep(500);
    assert.ok(w.document.getElementById('gateway-install'));
    assert.equal(w.document.querySelector('.settings-screen-head h2').textContent, 'AI Gateway');
    assert.match(w.document.getElementById('top-bar-title').textContent, /AI Gateway/);
    assert.match(w.document.getElementById('gateway-body').textContent, /1,000,000 tokens \(1M\)/);
    assert.equal(w.document.getElementById('gateway-login').disabled, true);
    assert.equal(w.document.getElementById('gateway-enabled').checked, false);
    assert.equal(w.document.getElementById('gateway-enabled').disabled, true);
    assert.equal(w.document.getElementById('gateway-planning').value, 'gpt-6.1-sol');
    assert.equal(w.document.getElementById('gateway-execution').value, 'gpt-6-luna');
    assert.equal(w.document.getElementById('gateway-mode').value, 'chatgpt');
    assert.equal(w.document.getElementById('gateway-context').value, '1000000');
    assert.ok(w.document.getElementById('gateway-login-claude'));
    assert.match(w.document.getElementById('gateway-body').textContent, /Both accounts must be connected/);
    w.document.querySelector('.nav-item[data-view="projects"]').click();
    await sleep(300);
    assert.equal(w.document.getElementById('gateway-body'), null);
    assert.deepEqual(errors, []);
  });

  test('Gateway authorizes Claude through a private callback and saves Auto mode', async () => {
    const isolated = new JSDOM('<div id="gateway-body"></div>', { runScripts: 'dangerously' });
    const win = isolated.window;
    try {
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/settings-gateway.js'), 'utf8'));
      const calls = [], notices = [];
      let unsafeAuthUrl = false;
      let gateway = { installed: true, supported: true, running: true, connected: true, enabled: true, port: 8317, version: 'fixture', mode: 'chatgpt', contextTokens: 200000, planningProvider: 'claude', executionProvider: 'codex', smallProvider: 'codex',
        planningModel: 'gpt-plan', executionModel: 'gpt-run', smallModel: 'gpt-small', claudePlanningModel: 'claude-plan', claudeExecutionModel: 'claude-run', claudeSmallModel: 'claude-small', connections: { codex: true, claude: false } };
      const discovery = { providers: { codex: { connected: true, models: { status: 'available', source: 'credential_catalog', fetchedAt: new Date().toISOString(), stale: false, items: [{ id: 'gpt-run', label: 'GPT run' }, { id: 'gpt-image-2', label: 'Image' }, { id: 'whisper-1', label: 'Audio' }] }, usage: { status: 'available', fetchedAt: new Date().toISOString(), accounts: [{ label: 'Account 1', windows: [{ id: 'primary', label: '5-hour window', usedPercent: 0, durationSeconds: 18000, resetsAt: new Date(Date.now() + 60000).toISOString() }, { id: 'weekly', label: 'Weekly window', usedPercent: 45 }, { id: 'limit', label: 'Additional limit', usedPercent: 100 }, { id: 'unknown', label: 'Unknown window', usedPercent: null }] }, { label: 'Account 2', windows: [{ id: 'secondary', label: 'Other account', usedPercent: 12 }] }] } }, claude: { connected: false, models: { status: 'not_connected', items: [] }, usage: { status: 'not_connected', accounts: [] } } } };
      await win.CitadelGatewaySettings.init({ escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), showToast: msg => notices.push(msg),
        api: async (url, opts = {}) => {
          calls.push({ url, ...opts });
          if (url.endsWith('/discovery/refresh')) return discovery;
          if (url.endsWith('/discovery')) return discovery;
          if (url.endsWith('/models')) return { models: ['gpt-run', 'claude-run'] };
          if (url.endsWith('/login') && opts.method === 'POST') gateway = { ...gateway, login: { provider: 'claude', state: 'waiting_callback', url: unsafeAuthUrl ? 'javascript:alert(1)' : 'https://claude.ai/oauth/authorize?state=fixture' } };
          if (url.endsWith('/callback')) gateway = { ...gateway, login: { provider: 'claude', state: 'connected' }, connections: { codex: true, claude: true } };
          if (opts.method === 'PUT') gateway = { ...gateway, ...opts.body };
          if (url.endsWith('/test')) return { ok: true, model: 'actual-fixture-model' };
          return { gateway };
        } });
      assert.match(win.document.getElementById('gateway-body').textContent, /Saved shared context budget: 200,000 tokens/);
      win.document.getElementById('gateway-context-restore').click();
      assert.equal(win.document.getElementById('gateway-context').value, '1000000');
      assert.equal(calls.filter(call => call.method === 'PUT').length, 0, 'restoring 1M changes only the draft until Save');
      win.document.getElementById('gateway-login-claude').click(); await sleep(30);
      assert.equal(calls.find(call => call.method === 'POST').body.provider, 'claude');
      const authLink = win.document.querySelector('.gateway-auth-prompt a[href="https://claude.ai/oauth/authorize?state=fixture"]');
      assert.ok(authLink, 'safe Claude authorization URL is linked');
      assert.equal(authLink.rel, 'noopener noreferrer');
      assert.equal(win.document.querySelector('[data-manual-field]'), null);
      assert.equal(win.document.querySelector('#gateway-planning-manual'), null);
      const callback = 'http://localhost:54545/callback?state=fixture&code=private-fixture-code';
      win.document.getElementById('gateway-callback').value = callback;
      win.document.querySelector('[data-refresh-provider="codex"]').click(); await sleep(30);
      assert.equal(win.document.getElementById('gateway-callback').value, callback, 'status polling must preserve callback input');
      win.document.getElementById('gateway-submit-callback').click(); await sleep(30);
      assert.equal(calls.find(call => call.url.endsWith('/callback')).body.redirectUrl, callback);
      assert.equal(win.document.getElementById('gateway-callback'), null);
      assert.ok(!win.document.body.textContent.includes('private-fixture-code'));
      assert.ok(win.document.getElementById('gateway-body').textContent.includes('3. Choose your tools'));
      assert.equal(win.document.getElementById('gateway-models-codex').open, false);
      assert.ok(!Array.from(win.document.getElementById('gateway-execution').options).some(option => /image|whisper/.test(option.value)));
      assert.equal(win.document.getElementById('gateway-limits-codex-0').open, false);
      assert.equal(win.document.getElementById('gateway-planning').value, 'gpt-plan', 'model choices preserve saved IDs even outside the live catalog');
      const gatewayBody = win.document.getElementById('gateway-body');
      assert.match(gatewayBody.textContent, /0% used/);
      assert.match(gatewayBody.textContent, /45% used/);
      assert.match(gatewayBody.textContent, /100% used/);
      assert.match(gatewayBody.textContent, /Unavailable/);
      assert.match(gatewayBody.textContent, /resets in/);
      assert.equal(gatewayBody.querySelectorAll('[role="meter"][aria-valuenow]').length, 4, 'each reported numeric usage window has a separate accessible meter');
      assert.equal(gatewayBody.querySelector('[role="meter"][aria-valuenow="0"]').getAttribute('aria-valuemin'), '0');
      assert.equal(gatewayBody.querySelector('[role="meter"][aria-valuenow="100"]').getAttribute('aria-valuemax'), '100');
      assert.equal(gatewayBody.querySelectorAll('.gateway-account').length, 2, 'provider accounts remain separate');
      const claudeTool = win.document.getElementById('gateway-claude');
      assert.equal(claudeTool.checked, true);
      claudeTool.checked = false; claudeTool.dispatchEvent(new win.Event('change', { bubbles: true }));
      const codex = win.document.getElementById('gateway-codex');
      assert.ok(codex);
      codex.checked = true; codex.dispatchEvent(new win.Event('change', { bubbles: true }));
      const opencode = win.document.getElementById('gateway-opencode');
      assert.ok(opencode);
      opencode.checked = true; opencode.dispatchEvent(new win.Event('change', { bubbles: true }));
      win.document.getElementById('gateway-mode').value = 'auto';
      win.document.getElementById('gateway-mode').dispatchEvent(new win.Event('change', { bubbles: true }));
      win.document.getElementById('gateway-save').click(); await sleep(30);
      assert.equal(calls.find(call => call.method === 'PUT').body.mode, 'auto');
      assert.equal(calls.find(call => call.method === 'PUT').body.opencodeEnabled, true);
      assert.equal(calls.find(call => call.method === 'PUT').body.codexEnabled, true);
      assert.equal(calls.find(call => call.method === 'PUT').body.claudeEnabled, false);
      assert.equal(calls.find(call => call.method === 'PUT').body.contextTokens, 1000000, 'the explicit draft restoration is applied only by Save');
      win.document.getElementById('gateway-models-codex').open = true;
      win.document.getElementById('gateway-advanced').open = true;
      const planning = win.document.getElementById('gateway-planning');
      planning.value = 'gpt-run'; planning.dispatchEvent(new win.Event('change', { bubbles: true }));
      const enabled = win.document.getElementById('gateway-enabled'); enabled.checked = false; enabled.dispatchEvent(new win.Event('change', { bubbles: true })); await sleep(30);
      assert.equal(win.document.getElementById('gateway-models-codex').open, true, 'expanded model controls survive status redraws');
      assert.equal(win.document.getElementById('gateway-advanced').open, true, 'advanced controls survive status redraws');
      const toggle = calls.filter(call => call.method === 'PUT').at(-1);
      assert.deepEqual(Object.keys(toggle.body), ['enabled'], 'the activation switch sends no other configuration fields');
      assert.equal(toggle.body.enabled, false, 'the activation switch sends its new state');
      assert.equal(win.document.getElementById('gateway-planning').value, 'gpt-run', 'pending model edit survives an activation update');
      const modeSelect = () => win.document.getElementById('gateway-mode');
      assert.equal(win.document.getElementById('gateway-role-planning'), null, 'role selectors are hidden outside By role');
      modeSelect().value = 'roles'; modeSelect().dispatchEvent(new win.Event('change', { bubbles: true }));
      assert.equal(win.document.getElementById('gateway-role-planning').value, 'claude');
      assert.equal(win.document.getElementById('gateway-role-execution').value, 'codex');
      const roleSelect = win.document.getElementById('gateway-role-execution'); roleSelect.value = 'claude'; roleSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
      win.document.getElementById('gateway-save').click(); await sleep(30);
      const roleSave = calls.filter(call => call.method === 'PUT').at(-1).body;
      assert.equal(roleSave.mode, 'roles'); assert.equal(roleSave.executionProvider, 'claude'); assert.equal(roleSave.planningProvider, 'claude');
      modeSelect().value = 'balanced'; modeSelect().dispatchEvent(new win.Event('change', { bubbles: true }));
      assert.equal(win.document.getElementById('gateway-role-planning'), null);
      assert.match(win.document.getElementById('gateway-body').textContent, /most headroom|Balanced is opt-in/);
      win.document.getElementById('gateway-save').click(); await sleep(30);
      assert.equal(calls.filter(call => call.method === 'PUT').at(-1).body.mode, 'balanced');
      gateway = { ...gateway, balance: { primary: 'codex', switchedAt: null, evaluatedAt: new Date().toISOString(), reason: 'ChatGPT has more headroom (90% free vs 5%).', headroom: { claude: 5, codex: 90 } } };
      win.document.getElementById('gateway-test').click(); await sleep(30);
      assert.match(win.document.getElementById('gateway-body').textContent, /Balanced primary: ChatGPT.*Claude 5% free, ChatGPT 90% free/);
      assert.ok(notices.some(message => message.includes('actual-fixture-model')));
      assert.ok(calls.every(call => !call.url.includes('private-fixture-code')));
      unsafeAuthUrl = true;
      win.document.getElementById('gateway-login-claude').click(); await sleep(30);
      assert.equal(win.document.querySelector('.gateway-auth-prompt a[href^="javascript:"]'), null, 'untrusted authorization URLs are never linked');
    } finally { win.CitadelGatewaySettings.dispose(); isolated.window.close(); }
  });

  test('project discovery imports a folder and browser editor offers a Citadel return action', async () => {
    w.document.querySelector('.nav-item[data-view="projects"]').click();
    await sleep(800);
    const importButton = w.document.querySelector('[data-discover-index]');
    assert.ok(importButton, 'the projects directory is scanned when opening Projects');
    importButton.click();
    await sleep(800);
    assert.ok(w.document.querySelector('.proj-name').textContent.includes('ui-discovered'));
    assert.equal(w.document.querySelector('[data-discover-index]'), null, 'imported folder is not suggested twice');
    await w.CitadelProjectTools.showEditor({ id: 'fixture-project', name: 'Project', path: '/srv/a # b' });
    assert.ok(w.document.getElementById('editor-back'));
    assert.ok(w.document.getElementById('editor-install'));
    assert.equal(w.document.getElementById('editor-ssh-host'), null);
    assert.equal(w.document.querySelector('a[href^="vscode:"]'), null);
    w.document.getElementById('editor-back').click();
    assert.equal(w.document.querySelector('.browser-editor'), null);
    assert.deepEqual(errors, []);
  });

  test('project terminal opens its own editor and returns to the same workspace', async () => {
    w.document.querySelector('.nav-item[data-view="projects"]').click();
    await sleep(500);
    const projectButton = w.document.querySelector('.open-workspace-btn');
    const projectId = projectButton.getAttribute('data-project-id');
    const originalFetch = w.fetch;
    w.fetch = (url, opts = {}) => {
      if (String(url).includes('/api/terminals') && opts.method === 'POST') return Promise.reject(new Error('Terminal creation disabled in UI fixture'));
      return originalFetch(url, opts);
    };
    try {
      projectButton.click();
      await sleep(800);
      const button = w.document.getElementById('ws-editor-btn');
      assert.equal(button.textContent, 'VS Code');
      assert.equal(w.document.getElementById('ws-chat-btn').textContent, 'Chat');
      const viewport = w.document.getElementById('terminal-viewport');
      button.click();
      await sleep(300);
      assert.ok(w.document.getElementById('editor-install'));
      assert.ok(w.document.querySelector('.browser-editor').getAttribute('aria-label').includes('ui-discovered'));
      assert.ok(w.document.querySelector(`[data-workspace-context="${projectId}"]`));
      w.document.getElementById('editor-back').click();
      assert.equal(w.document.getElementById('terminal-viewport'), viewport);
      assert.equal(w.document.querySelector('.browser-editor'), null);
    } finally {
      w.fetch = originalFetch;
      w.document.querySelector('.nav-item[data-view="projects"]').click();
      await sleep(300);
    }
    assert.deepEqual(errors, []);
  });

  test('native Chat entry preserves the terminal and shell without OpenCode GUI controls', async () => {
    const originalFetch = w.fetch;
    w.fetch = (url, opts = {}) => {
      if (String(url).includes('/api/terminals') && opts.method === 'POST') return Promise.reject(new Error('Terminal creation disabled in UI fixture'));
      if (String(url) === '/api/chat/status') return Promise.resolve({ ok: true, json: async () => ({ installed: false, ready: false, error: '<img src=x onerror=alert(1)> Install OpenCode' }) });
      return originalFetch(url, opts);
    };
    try {
      w.document.querySelector('.open-workspace-btn').click(); await sleep(700);
      const viewport = w.document.getElementById('terminal-viewport');
      const workspace = w.document.querySelector('.workspace-container');
      w.document.getElementById('ws-chat-btn').click(); await sleep(30);
      assert.ok(w.document.querySelector('.chat-panel'));
      assert.equal(w.document.querySelector('.chat-panel iframe'), null);
      assert.equal(w.document.querySelector('.chat-panel img'), null);
      assert.match(w.document.querySelector('.chat-notices').textContent, /Install OpenCode/);
      assert.equal(workspace.hasAttribute('inert'), true);
      assert.equal(w.getComputedStyle(workspace).visibility, 'hidden');
      assert.equal(w.getComputedStyle(w.document.querySelector('.sidebar')).visibility, 'visible');
      assert.equal(w.getComputedStyle(w.document.querySelector('.top-bar')).visibility, 'visible');
      w.document.getElementById('mobile-menu-btn').click();
      assert.equal(w.document.querySelector('.sidebar').classList.contains('open'), true);
      w.document.getElementById('mobile-menu-btn').click();
      w.CitadelChat.close();
      assert.equal(w.document.getElementById('terminal-viewport'), viewport);
      assert.equal(viewport.isConnected, true);
      assert.equal(workspace.hasAttribute('inert'), false);
      assert.equal(w.CitadelBrowserEditor.openCode, undefined);
      assert.equal(w.CitadelProjectTools.showOpenCode, undefined);
      assert.equal(w.document.getElementById('ws-opencode-btn'), null);
      for (const file of ['app.js', 'browser-editor.js', 'project-tools.js']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public/js', file), 'utf8'), /opencode-web|openCode\(/);
    } finally {
      w.CitadelChat.close(); w.fetch = originalFetch;
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
    }
    assert.deepEqual(errors, []);
  });

  test('Chat sessions, bounded named streaming, send, Stop and explicit approvals', async () => {
    const isolated = new JSDOM('<main id="main-content"><div id="terminal">Mounted terminal</div></main>', { runScripts: 'dangerously', url: base });
    const win = isolated.window;
    try {
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/chat.js'), 'utf8'));
      const calls = [], sources = [], notices = [], settings = [];
      const state = { activeHostId: 'local' };
      let snapshot = { session: { id: 'ses_1', title: '<img src=x>' }, messages: [], status: 'idle', permissions: [], questions: [] };
      let deferred, block = false, inflight = 0, maxInflight = 0;
      win.EventSource = class {
        constructor(url) { this.url = url; this.listeners = {}; sources.push(this); }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        close() { this.closed = true; }
        update() { this.listeners.update(); }
      };
      win.CitadelChat.init({ state, showToast: message => notices.push(message), openSettingsAt: section => settings.push(section), api: async (url, opts = {}) => {
        calls.push({ url, ...opts });
        if (url === '/api/chat/status') return { installed: true, ready: true };
        if (url.endsWith('/sessions')) return opts.method === 'POST' ? { session: { id: 'ses_2', title: 'New chat' } } : { sessions: [{ id: 'ses_1', title: '<script>bad()</script>' }] };
        if (opts.method === 'POST') return { accepted: true };
        inflight++; maxInflight = Math.max(maxInflight, inflight);
        const result = block ? await new Promise(resolve => { deferred = resolve; }) : snapshot;
        inflight--; return result;
      } });
      const query = selector => win.document.querySelector(selector);
      const click = text => {
        const target = [...win.document.querySelectorAll('button')].find(element => element.textContent === text);
        assert.ok(target, `missing ${text}`); assert.equal(target.disabled, false, `${text} disabled`); target.click();
      };
      const update = async () => { sources.at(-1).update(); await sleep(300); };
      await win.CitadelChat.open({ id: 'project', name: '<svg onload=bad()>' }); await sleep(10);
      assert.equal(sources[0].url, '/api/projects/project/chat/sessions/ses_1/events');
      assert.equal(query('svg, script, img, iframe'), null);
      assert.equal(query('#terminal').isConnected, true);
      assert.equal(query('#terminal').hasAttribute('inert'), true);
      assert.equal(calls.filter(call => call.method === 'POST').length, 0);
      assert.match(query('.chat-welcome h2').textContent, /help you build/);
      assert.equal(query('.chat-suggestions').children.length, 4);
      assert.ok(query('.chat-box textarea'));
      const postsBeforeSuggestion = calls.filter(call => call.method === 'POST').length;
      query('.chat-suggestion').click();
      assert.match(query('textarea').value, /project is structured/);
      assert.equal(win.document.activeElement, query('textarea'));
      assert.equal(calls.filter(call => call.method === 'POST').length, postsBeforeSuggestion);
      click('New chat'); await sleep(10);
      assert.equal(sources[0].closed, true);
      assert.equal(query('.chat-sessions').value, 'ses_2');
      const input = query('textarea'); input.value = 'hello\nworld'; input.dispatchEvent(new win.Event('input'));
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 0);
      query('[aria-label="Agent mode"]').value = 'plan';
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); await sleep(10);
      const sent = calls.find(call => call.url.endsWith('/messages'));
      assert.equal(sent.body.text, 'hello\nworld'); assert.equal(sent.body.role, 'plan');
      assert.match(sent.body.requestId, /^[a-f0-9-]{36}$/);
      assert.equal(input.value, '');
      snapshot = { ...snapshot, status: 'busy', messages: [{ role: 'assistant', parts: [{ type: 'text', text: '<img src=x onerror=bad()>\n```html\n<script>bad()</script>\n```' }, { type: 'tool', text: 'bash', state: { status: 'running', input: 'SECRET', output: 'SECRET' } }] }], permissions: [{ id: 'perm_1', permission: '<svg>', patterns: ['<img>'] }], questions: [{ id: 'q_1', questions: [{ header: 'Choices', question: '<script>unsafe</script>', multiple: true, custom: true, options: [{ label: 'A', description: '<img>' }, { label: 'B' }] }, { header: 'Single', question: 'Pick', multiple: false, custom: false, options: [{ label: 'C' }, { label: 'D' }] }] }] };
      await update();
      assert.equal(query('img, script, svg, iframe'), null);
      assert.match(query('pre code').textContent, /<script>bad/);
      assert.doesNotMatch(query('.chat-log').textContent, /SECRET/);
      assert.equal(calls.filter(call => /permissions|questions/.test(call.url)).length, 0);
      click('Allow once'); await sleep(10);
      assert.equal(calls.at(-1).body.reply, 'once');
      await sleep(280); click('Reject'); await sleep(10);
      assert.equal(calls.at(-1).body.reply, 'reject');
      const fields = win.document.querySelectorAll('fieldset');
      fields[0].querySelectorAll('input[type="checkbox"]')[0].checked = true;
      fields[0].querySelectorAll('input[type="checkbox"]')[1].checked = true;
      const custom = fields[0].querySelector('input[type="text"]'); custom.value = 'Custom'; custom.dispatchEvent(new win.Event('input'));
      fields[1].querySelector('input').checked = true;
      await sleep(280); click('Answer'); await sleep(10);
      assert.equal(JSON.stringify(calls.at(-1).body), JSON.stringify({ answers: [['A', 'B', 'Custom'], ['C']] }));
      await sleep(280); click('Reject question'); await sleep(10);
      assert.ok(calls.at(-1).url.endsWith('/questions/q_1/reject'));
      await sleep(280); click('Stop'); await sleep(10);
      assert.ok(calls.at(-1).url.endsWith('/cancel'));
      await sleep(280);
      block = true;
      const before = calls.length;
      for (let i = 0; i < 100; i++) sources.at(-1).update();
      await sleep(280);
      for (let i = 0; i < 100; i++) sources.at(-1).update();
      assert.equal(calls.length, before + 1);
      assert.equal(maxInflight, 1);
      block = false; deferred(snapshot); await sleep(300);
      assert.equal(calls.length, before + 2);
      const after = calls.length; await sleep(350); assert.equal(calls.length, after, 'no polling without events');
      const source = sources.at(-1); source.onerror();
       assert.notEqual(source.closed, true); assert.match(query('.chat-notices').textContent, /agent may still be running/);
      const cancellations = calls.filter(call => call.url.endsWith('/cancel')).length;
      win.CitadelChat.close(); source.update(); await sleep(300);
      assert.equal(calls.filter(call => call.url.endsWith('/cancel')).length, cancellations);
      assert.equal(query('#terminal').hasAttribute('inert'), false);
      assert.equal(query('#terminal').textContent, 'Mounted terminal');
      assert.equal(query('.chat-panel'), null);
      state.activeHostId = 'peer'; await win.CitadelChat.open({ id: 'remote', name: 'Remote' });
      assert.match(notices.at(-1), /machine’s own Citadel panel/);
      state.activeHostId = 'local'; await win.CitadelChat.open({ id: 'project', name: 'Project' }); await sleep(10);
      click('Settings'); assert.deepEqual(settings, ['gateway']);
    } finally { win.CitadelChat.close(); isolated.window.close(); }
  });

  test('Chat locks stale send and approvals until recovery snapshots, preserves drafts and keeps explicit Stop', async () => {
    const isolated = new JSDOM('<main id="main-content"></main>', { runScripts: 'dangerously', url: base });
    const win = isolated.window, sources = [], calls = [], timers = new Map();
    let timerId = 0, deferred, actionDeferred, block = false, fail = false, blockAction = false;
    let snapshot = { status: 'idle', messages: [], permissions: [{ id: 'permission', permission: 'bash' }], questions: [{ id: 'question', questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] }] };
    try {
      win.setTimeout = run => { timers.set(++timerId, run); return timerId; };
      win.clearTimeout = id => timers.delete(id);
      win.EventSource = class {
        constructor() { this.listeners = {}; sources.push(this); }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        close() { this.closed = true; }
      };
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/chat.js'), 'utf8'));
      win.CitadelChat.init({ state: { activeHostId: 'local' }, showToast() {}, openSettingsAt() {}, api: async (url, opts = {}) => {
        calls.push({ url, ...opts });
        if (url.endsWith('/status')) return { ready: true };
        if (url.endsWith('/sessions')) return { sessions: [{ id: 'one' }] };
        if (opts.method === 'POST') return blockAction ? new Promise(resolve => { actionDeferred = resolve; }) : { accepted: true };
        if (block) return new Promise((resolve, reject) => { deferred = { resolve, reject }; });
        if (fail) throw new Error('Snapshot unavailable');
        return snapshot;
      } });
      const query = selector => win.document.querySelector(selector);
      const button = text => [...win.document.querySelectorAll('button')].find(element => element.textContent === text);
      const flush = async () => {
        const pending = [...timers.values()]; timers.clear();
        for (const run of pending) run();
        await sleep(0);
      };
      const locked = () => {
        assert.equal(button('Send').disabled, true);
        assert.ok([...win.document.querySelectorAll('.chat-prompts button')].every(element => element.disabled));
        assert.equal(button('Stop').disabled, false, 'explicit cancel remains safe when the last known idle state is stale');
      };
      await win.CitadelChat.open({ id: 'project', name: 'Project' }); await sleep(0);
      const source = sources[0], input = query('textarea');
      input.value = 'unsent draft'; input.dispatchEvent(new win.Event('input'));
      assert.equal(button('Send').disabled, false);
      assert.equal(button('Stop').disabled, true);
      block = true; source.listeners.update(); await flush();
      source.onerror(); locked();
      assert.notEqual(source.closed, true, 'EventSource retains its native reconnect');
      const before = calls.length;
      query('.chat-composer').dispatchEvent(new win.Event('submit', { cancelable: true }));
      button('Allow once').onclick();
      query('.chat-prompts input').checked = true;
      query('.chat-prompts form').dispatchEvent(new win.Event('submit', { cancelable: true }));
      assert.equal(calls.length, before, 'handlers guard stale actions, not just disabled buttons');
      source.onopen(); locked();
      deferred.resolve(snapshot); await sleep(0); locked();
      assert.equal(timers.size, 1, 'recovery queues a fresh snapshot after the pre-disconnect fetch');
      block = false; await flush();
      assert.equal(button('Send').disabled, false);
      assert.equal(button('Allow once').disabled, false);
      assert.equal(input.value, 'unsent draft');
      fail = true; source.listeners.update(); await flush(); locked();
      assert.match(query('.chat-notices').textContent, /Snapshot unavailable/);
      button('Stop').click(); await sleep(0);
      assert.ok(calls.at(-1).url.endsWith('/cancel'));
      await flush(); locked();
      fail = false; source.listeners.update(); await flush();
      snapshot = { ...snapshot, status: 'error' };
      source.listeners.update(); await flush(); locked();
      snapshot = { ...snapshot, status: 'busy' };
      source.listeners.update(); await flush();
      blockAction = true; button('Allow once').click(); await sleep(0);
      source.onerror(); actionDeferred({ accepted: true }); await sleep(0); locked();
      assert.equal(button('Allow once').disabled, true, 'action finally cannot unlock disconnected approvals');
      win.dispatchEvent(new win.Event('offline')); locked();
      await flush(); locked();
      blockAction = false; snapshot = { ...snapshot, status: 'idle' };
      win.dispatchEvent(new win.Event('online')); locked(); await flush();
      assert.equal(button('Send').disabled, false);
      block = true;
      Object.defineProperty(win.document, 'visibilityState', { configurable: true, value: 'visible' });
      win.document.dispatchEvent(new win.Event('visibilitychange')); locked(); await flush();
      block = false; deferred.resolve(snapshot); await sleep(0);
      assert.equal(button('Send').disabled, false, 'mobile resume requires a fresh authoritative snapshot');
      assert.equal(input.value, 'unsent draft');
      source.listeners.update(); assert.equal(timers.size, 1);
      win.CitadelChat.close();
      assert.equal(source.closed, true);
      assert.equal(timers.size, 0, 'close clears queued refresh timers');
      const closedCalls = calls.length;
      source.onopen(); source.onerror(); source.listeners.update();
      win.document.dispatchEvent(new win.Event('visibilitychange'));
      win.dispatchEvent(new win.Event('online')); win.dispatchEvent(new win.Event('offline'));
      await flush();
      assert.equal(calls.length, closedCalls);
      assert.equal(timers.size, 0);
    } finally { win.CitadelChat.close(); isolated.window.close(); }
  });

  test('Chat ignores stale snapshots, actions and failures across selection, navigation, host and logout cleanup', async () => {
    const isolated = new JSDOM('<main id="main-content"><div id="terminal"></div></main>', { runScripts: 'dangerously', url: base });
    const win = isolated.window;
    try {
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/chat.js'), 'utf8'));
      const state = { activeHostId: 'local' }, sources = [], pending = [], calls = [];
      let block = false;
      win.EventSource = class {
        constructor() { sources.push(this); }
        addEventListener(name, handler) { this[name] = handler; }
        close() { this.closed = true; }
      };
      const snapshot = title => ({ session: { title }, status: 'idle', messages: [{ role: 'assistant', parts: [{ type: 'text', text: title }] }], permissions: [], questions: [] });
      win.CitadelChat.init({ state, showToast() {}, openSettingsAt() {}, api: async (url, opts = {}) => {
        calls.push({ url, ...opts });
        if (url.endsWith('/status')) return { installed: true, ready: true };
        if (url.endsWith('/sessions')) return { sessions: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] };
        if (block) return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        return snapshot('Current');
      } });
      const project = { id: 'project', name: 'Project' };
      block = true; await win.CitadelChat.open(project); await sleep(10);
      const stale = pending.shift(), source = sources.at(-1);
      block = false;
      const selector = win.document.querySelector('.chat-sessions'); selector.value = 'two'; selector.dispatchEvent(new win.Event('change')); await sleep(10);
      stale.resolve(snapshot('STALE')); source.update(); await sleep(300);
      assert.equal(source.closed, true);
      assert.doesNotMatch(win.document.querySelector('.chat-log').textContent, /STALE/);
      for (const mode of ['navigation', 'host', 'logout', 'failure']) {
        win.CitadelChat.close(); block = true; await win.CitadelChat.open(project); await sleep(10);
        const late = pending.shift(), currentSource = sources.at(-1);
        if (mode === 'navigation') { win.document.getElementById('main-content').replaceChildren(win.document.createElement('div')); await sleep(10); }
        else if (mode === 'host') { win.CitadelChat.close(); state.activeHostId = 'peer'; }
        else win.CitadelChat.close();
        if (mode === 'failure') late.reject(new Error('Late failure'));
        else late.resolve(snapshot('STALE'));
        currentSource.update(); await sleep(300);
        assert.equal(currentSource.closed, true);
        assert.equal(win.document.querySelector('.chat-panel'), null);
        assert.equal(win.document.getElementById('main-content').classList.contains('chat-host'), false);
        state.activeHostId = 'local';
      }
      block = false; await win.CitadelChat.open(project); await sleep(10);
      const input = win.document.querySelector('textarea'); input.value = 'request'; input.dispatchEvent(new win.Event('input'));
      block = true; [...win.document.querySelectorAll('button')].find(button => button.textContent === 'Send').click(); await sleep(10);
      const lateAction = pending.shift(); win.CitadelChat.close();
      block = false; await win.CitadelChat.open(project); await sleep(10);
      const replacement = win.document.querySelector('.chat-panel'); lateAction.resolve({ accepted: true }); await sleep(300);
      assert.equal(win.document.querySelector('.chat-panel'), replacement);
      assert.equal(calls.filter(call => call.url.endsWith('/cancel')).length, 0);
      const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
      assert.match(appSource, /function navigateTo\(view\) \{\s*window.CitadelChat.close\(\)/);
      assert.match(appSource, /function teardownSession\(\) \{\s*window.CitadelChat.close\(\)/);
    } finally { win.CitadelChat.close(); isolated.window.close(); }
  });

  test('retired project management scripts and navigation are absent', () => {
    for (const name of ['CitadelProjectHub', 'CitadelMissions', 'CitadelKnowledge']) assert.equal(w[name], undefined);
    assert.equal(w.document.querySelectorAll('.nav-item[data-view="project-hub"], .nav-item[data-view="work"], .nav-item[data-view="docs"], .nav-item[data-view="learning"]').length, 0);
    for (const name of ['project-hub', 'missions', 'knowledge']) assert.equal(w.document.querySelector(`script[src^="/js/${name}.js"]`), null);
  });

  test('screens reached from other screens render through their entry points', async () => {
    const entries = [
      ['CitadelRepos', 'renderReposView'], ['CitadelActivity', 'renderActivityView'], ['CitadelFleet', 'renderFleetView'],
      ['CitadelDeployments', 'renderDeploymentsView'], ['CitadelDeployments', 'renderDockerView'], ['CitadelFiles', 'renderFilesView'],
    ];
    for (const [global, fn] of entries) {
      await w[global][fn]();
      await sleep(400);
    }
    await w.CitadelPairing.showPairModal();
    await sleep(400);
    assert.ok(w.document.querySelector('.modal-overlay, .modal, [role="dialog"]'), 'the pairing modal should open');
    assert.deepEqual(errors, []);
  });
});
