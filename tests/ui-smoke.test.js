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
  let loadPage;

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
    loadPage = (saved = {}, width = 1024, storageBlocked = false) => JSDOM.fromURL(`${base}/`, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, cookieJar: jar, virtualConsole,
      beforeParse(win) {
        win.innerWidth = width;
        for (const [key, value] of Object.entries(saved)) win.localStorage.setItem(key, value);
        if (storageBlocked) {
          win.Storage.prototype.getItem = () => { throw new Error('Storage blocked'); };
          win.Storage.prototype.setItem = () => { throw new Error('Storage blocked'); };
        }
        win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
        win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        win.fetch = (url, opts = {}) => fetch(new URL(url, base), { ...opts, signal: undefined, headers: { ...(opts.headers || {}), cookie } });
        win.HTMLCanvasElement.prototype.getContext = () => null;
        win.addEventListener('error', (e) => errors.push(e.message));
        win.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason && e.reason.message}`));
      },
    });
    dom = await loadPage();
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
    for (const name of ['CitadelMonitor', 'CitadelDisk', 'CitadelDeployments', 'CitadelFleet', 'CitadelActivity', 'CitadelRepos', 'CitadelFiles', 'CitadelPairing', 'CitadelProjectTools', 'CitadelGatewaySettings', 'CitadelBrowserEditor', 'CitadelTerminalImages']) {
      assert.equal(typeof w[name], 'object', `window.${name} is missing`);
    }
    assert.ok(w.document.querySelector('.nav-item'), 'the sidebar should render after sign-in');
    assert.equal(w.document.querySelector('.nav-item[data-view="projects"]').classList.contains('active'), true);
    assert.ok(w.document.getElementById('projects-system-open'));
    assert.equal(w.document.querySelector('.workspace-heading'), null);
    assert.deepEqual(errors, []);
  });

  test('sidebar toggle keeps desktop preference separate from mobile overlay and restores focus', async () => {
    const sidebar = w.document.getElementById('app-sidebar');
    const toggle = w.document.getElementById('mobile-menu-btn');
    const backdrop = w.document.getElementById('sidebar-backdrop');
    const resize = width => { w.innerWidth = width; w.dispatchEvent(new w.Event('resize')); };
    const visible = expected => {
      assert.equal(toggle.getAttribute('aria-expanded'), String(expected));
      assert.equal(toggle.getAttribute('aria-label'), expected ? 'Close sidebar' : 'Open sidebar');
      assert.equal(toggle.title, toggle.getAttribute('aria-label'));
      assert.equal(sidebar.getAttribute('aria-hidden'), String(!expected));
      assert.equal(sidebar.hasAttribute('inert'), !expected);
    };
    assert.equal(toggle.getAttribute('aria-controls'), sidebar.id);
    assert.notEqual(w.getComputedStyle(toggle).display, 'none');
    visible(true);
    sidebar.querySelector('button').focus();
    toggle.click();
    visible(false);
    assert.equal(w.getComputedStyle(sidebar).display, 'none');
    assert.equal(w.document.activeElement, toggle);
    const key = Object.keys(w.localStorage).find(key => key.startsWith('citadel.sidebar.'));
    assert.ok(key);
    assert.equal(w.localStorage.getItem(key), '1');
    const saved = { [key]: '1' };
    const restored = await loadPage(saved);
    try {
      await sleep(1200);
      assert.equal(restored.window.document.getElementById('mobile-menu-btn').getAttribute('aria-expanded'), 'false');
      assert.equal(restored.window.document.getElementById('app-sidebar').hasAttribute('inert'), true);
    } finally { restored.window.close(); }
    resize(768);
    visible(false);
    assert.equal(sidebar.classList.contains('desktop-folded'), false);
    toggle.click();
    visible(true);
    assert.equal(backdrop.classList.contains('open'), true);
    sidebar.querySelector('button').focus();
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    visible(false);
    assert.equal(w.document.activeElement, toggle);
    toggle.click(); backdrop.click(); visible(false);
    toggle.click();
    resize(1024);
    visible(false);
    assert.equal(backdrop.classList.contains('open'), false);
    assert.equal(w.document.body.style.overflow, '');
    assert.equal(w.localStorage.getItem(key), '1');
    toggle.click(); visible(true);
    assert.equal(w.localStorage.getItem(key), '0');
    resize(767); visible(false);
    toggle.click();
    w.document.querySelector('.nav-item[data-view="dashboard"]').click();
    visible(false);
    resize(1024); visible(true);
    assert.equal(backdrop.classList.contains('open'), false);
    toggle.focus();
    assert.equal(toggle.tagName, 'BUTTON');
    assert.equal(toggle.type, 'button');
    assert.deepEqual(errors, []);
  });

  test('sidebar preference is owner scoped and storage failure leaves a usable default', async () => {
    const key = Object.keys(w.localStorage).find(key => key.startsWith('citadel.sidebar.'));
    const foreignKey = `citadel.sidebar.${JSON.stringify(['another-owner', base])}`;
    for (const [saved, blocked] of [[{ [foreignKey]: '1' }, false], [{ [key]: '1' }, true]]) {
      const page = await loadPage(saved, 1024, blocked);
      try {
        await sleep(1200);
        const toggle = page.window.document.getElementById('mobile-menu-btn');
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        toggle.click();
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        toggle.click();
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
      } finally { page.window.close(); }
    }
    const page = await loadPage({ [key]: '1' }, 600);
    try {
      await sleep(1200);
      const win = page.window;
      const toggle = win.document.getElementById('mobile-menu-btn');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      toggle.click();
      assert.equal(toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(win.localStorage.getItem(key), '1');
      win.innerWidth = 1024; win.dispatchEvent(new win.Event('resize'));
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(win.document.getElementById('sidebar-backdrop').classList.contains('open'), false);
    } finally { page.window.close(); }
    assert.deepEqual(errors, []);
  });

  test('Projects is the entry point with System first and no empty Workspace navigation', async () => {
    w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(350);
    assert.equal(w.document.querySelector('[data-view="workspace"]'), null);
    assert.equal(w.document.querySelector('.workspace-heading'), null);
    assert.equal(w.document.querySelector('[data-workspace-context="system"]'), null);
    assert.equal(w.document.getElementById('main-content').firstElementChild.className, 'card project-system');
    assert.ok(w.document.getElementById('projects-system-open'));
  });

  test('runtime uses read-only editor status, not saved mode or history, and isolates scope', async () => {
    const isolated = new JSDOM('', { runScripts: 'dangerously', url: base });
    const win = isolated.window;
    try {
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/project-tools.js'), 'utf8'));
      const tools = win.CitadelProjectTools;
      const state = { user: { id: 'alice', role: 'admin' }, activeHostId: 'local', hostIdentity: { instanceId: 'one' }, projects: [{ id: 'a' }, { id: 'b' }] };
      let editor = false, finish;
      const calls = [];
      tools.init({ state, escapeHtml: String, renderProjectsView() {}, showToast() {}, openWorkspace() {}, api: async url => {
        calls.push(url);
        if (finish === true) return new Promise(resolve => { finish = resolve; });
        return { editor: { running: editor } };
      } });
      tools.workspacePreference('a', { mode: 'chat', chatSessionId: 'retained', editorOpened: true });
      await tools.refreshRuntime();
      assert.equal(tools.projectRuntime('a').vscode, false);
      assert.equal(tools.projectRuntime('a').editor, false);
      editor = true;
      tools.workspacePreference('a', { editorOpened: true });
      await tools.refreshRuntime();
      assert.equal(tools.projectRuntime('a').vscode, true);
      assert.equal(tools.projectRuntime('b').vscode, false, 'shared process does not open every project');
      assert.ok(calls.length > 0 && calls.every(url => url === '/api/editor'), 'runtime never queries retired Chat activity');
      assert.equal(Object.hasOwn(tools.projectRuntime('a'), 'chat'), false);
      state.user = { id: 'bob', role: 'admin' };
      assert.equal(tools.projectRuntime('a').editor, undefined);
      state.user = { id: 'alice', role: 'admin' };
      finish = true;
      const pending = tools.refreshRuntime(); await sleep(0);
      tools.reset(); state.activeHostId = 'peer';
      finish({ editor: { running: true } }); await pending;
      assert.equal(tools.projectRuntime('a').editor, undefined);
    } finally { win.close(); }
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
    const content = w.document.getElementById('main-content');
    assert.ok(w.document.querySelector('[data-discover-index]'), 'the projects directory is scanned when opening Projects');
    assert.equal(content.firstElementChild.className, 'card project-system');
    assert.equal(content.lastElementChild.className, 'card project-discovery');
    w.document.querySelector('[data-dismiss-discovery]').click();
    assert.equal(w.document.querySelector('.project-discovery').hidden, true);
    assert.ok(fs.existsSync(path.join(data, 'projects', 'ui-discovered')), 'dismissing a suggestion never deletes its folder');
    assert.equal(w.document.activeElement.id, 'proj-refresh-btn');
    w.document.getElementById('proj-refresh-btn').click(); await sleep(400);
    w.document.querySelector('[data-discover-index]').click();
    await sleep(800);
    assert.ok(w.document.querySelector('.proj-name').textContent.includes('ui-discovered'));
    assert.equal(w.document.querySelector('[data-discover-index]'), null, 'imported folder is not suggested twice');
    fs.mkdirSync(path.join(data, 'projects', 'ui-later'));
    w.document.getElementById('proj-refresh-btn').click(); await sleep(400);
    const list = w.document.getElementById('proj-list');
    assert.equal(content.firstElementChild.className, 'card project-system');
    assert.equal(list.nextElementSibling, w.document.querySelector('.project-discovery'), 'detected folders follow registered projects');
    assert.equal(content.lastElementChild, list.nextElementSibling);
    assert.equal(list.querySelector('.proj-desc'), null);
    assert.doesNotMatch(list.textContent, /Status unavailable|Stopped|0 repos/);
    w.document.querySelector('[data-dismiss-discovery]').click();
    assert.ok(w.document.querySelector('.open-workspace-btn'), 'dismissal preserves registered projects');
    assert.ok(fs.existsSync(path.join(data, 'projects', 'ui-later')));
    await w.CitadelBrowserEditor.open({ id: 'fixture-project', name: 'Project', path: '/srv/a # b' });
    assert.ok(w.document.getElementById('editor-back'));
    assert.ok(w.document.getElementById('editor-install'));
    assert.equal(w.document.getElementById('editor-ssh-host'), null);
    assert.equal(w.document.querySelector('a[href^="vscode:"]'), null);
    w.document.getElementById('editor-back').click();
    assert.equal(w.document.querySelector('.browser-editor'), null);
    assert.deepEqual(errors, []);
  });

  test('discovery dismissal is read-only and stale import actions cannot affect another workspace scope', async () => {
    const isolated = new JSDOM('<button id="proj-refresh-btn">Refresh</button><main><section class="project-system"></section><div id="registered"></div></main>', { runScripts: 'dangerously', url: base });
    const win = isolated.window, calls = [];
    const state = { user: { id: 1 }, hostIdentity: { instanceId: 'panel-a' }, activeHostId: 'local' };
    let finishImport, renders = 0;
    const directories = [{ name: 'first', path: '/projects/first' }, { name: 'second', path: '/projects/second' }];
    try {
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/project-tools.js'), 'utf8'));
      win.CitadelProjectTools.init({ state, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), openWorkspace() {}, showToast() {}, renderProjectsView: () => { renders++; },
        api: (url, opts = {}) => {
          calls.push({ url, ...opts });
          if (url.endsWith('/import')) return new Promise(resolve => { finishImport = resolve; });
          return Promise.resolve({ directories });
        } });
      const content = win.document.querySelector('main');
      await win.CitadelProjectTools.mountDiscovery(content);
      let panel = content.querySelector('.project-discovery');
      assert.equal(panel.previousElementSibling.id, 'registered');
      assert.equal(panel.querySelector('p'), null, 'discovery has no introductory prose');
      panel.querySelector('[data-dismiss-discovery]').click();
      assert.equal(panel.querySelectorAll('.proj-row').length, 1);
      assert.equal(win.document.activeElement.dataset.discoverIndex, '1');
      assert.equal(calls.length, 1, 'dismissing a suggestion performs no API mutation or recheck');
      panel.querySelector('[data-dismiss-discovery]').click();
      assert.equal(panel.hidden, true);
      assert.equal(calls.length, 1);
      panel.remove();
      await win.CitadelProjectTools.mountDiscovery(content);
      panel = content.querySelector('.project-discovery');
      assert.equal(panel.querySelectorAll('.proj-row').length, 2, 'a new scan restores dismissed suggestions');
      const staleImport = panel.querySelector('[data-discover-index]');
      const staleDismiss = panel.querySelector('[data-dismiss-discovery]');
      state.user = { id: 2 };
      staleImport.click(); staleDismiss.click();
      assert.equal(calls.length, 2, 'owner changes invalidate both actions');
      assert.equal(panel.querySelectorAll('.proj-row').length, 2);
      state.user = { id: 1 };
      staleImport.click(); staleImport.click();
      assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'import is submitted once');
      assert.equal(staleDismiss.disabled, true, 'pending import cannot be dismissed');
      assert.equal(calls.at(-1).body.targetPath, '/projects/first');
      state.activeHostId = 'another-host';
      finishImport({ success: true }); await sleep(0);
      assert.equal(renders, 0, 'late import cannot redraw a different machine');
      state.activeHostId = 'local';
      panel.remove();
      staleImport.disabled = false; staleDismiss.disabled = false;
      staleImport.click(); staleDismiss.click();
      assert.equal(calls.length, 3, 'detached discovery actions do not send requests');
    } finally { isolated.window.close(); }
  });

  test('project removal preserves files by default and disk deletion requires the exact path', async () => {
    const originalFetch = w.fetch, calls = [];
    const projectId = w.document.querySelector('.open-workspace-btn').dataset.projectId;
    let running = false, backendBusy = false, blockedRemovals = 0;
    w.fetch = (url, opts = {}) => {
      url = String(url);
      if (opts.method === 'DELETE' && url.startsWith('/api/projects/')) {
        if (backendBusy) {
          blockedRemovals++;
          return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'Stop active project work before removal.' }) });
        }
        calls.push(url); return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      if (url === '/api/editor') return Promise.resolve({ ok: true, json: async () => ({ editor: { running: false } }) });
      if (url === '/api/terminals') return Promise.resolve({ ok: true, json: async () => ({ sessions: running ? [{ id: 'busy-project', project_id: projectId, isAlive: true }] : [] }) });
      return originalFetch(url, opts);
    };
    const action = label => {
      w.document.querySelector(`.proj-menu-btn[data-project-id="${projectId}"]`).click();
      [...w.document.querySelectorAll('.ctx-item')].find(item => item.textContent === label).click();
    };
    try {
      action('Remove from Citadel…');
      assert.equal(w.document.getElementById('del-files-check'), null);
      assert.match(w.document.querySelector('.modal-body').textContent, /kept untouched/);
      w.document.getElementById('modal-cancel-btn').click();
      assert.equal(calls.length, 0);
      running = true;
      action('Remove from Citadel…');
      w.document.getElementById('modal-confirm-btn').click(); await sleep(60);
      assert.equal(calls.length, 0, 'running project terminals block removal');
      w.document.getElementById('modal-cancel-btn').click(); running = false;
      backendBusy = true;
      action('Remove from Citadel…');
      w.document.getElementById('modal-confirm-btn').click(); await sleep(60);
      assert.equal(blockedRemovals, 1, 'backend still rejects active work not tracked by the frontend');
      assert.equal(calls.length, 0);
      assert.ok(w.document.getElementById('modal-confirm-btn'), 'server refusal keeps the confirmation open');
      assert.match(w.document.getElementById('toast-root').textContent, /Stop active project work/);
      w.document.getElementById('modal-cancel-btn').click(); backendBusy = false;
      action('Remove from Citadel…');
      w.document.getElementById('modal-confirm-btn').click(); await sleep(150);
      assert.ok(calls[0].endsWith('deleteFiles=false'));
      assert.ok(fs.existsSync(path.join(data, 'projects', 'ui-discovered')));
      action('Delete project files from disk…');
      w.document.getElementById('modal-confirm-btn').click(); await sleep(30);
      assert.equal(calls.length, 1);
      const input = w.document.getElementById('delete-project-path');
      input.value = path.join(data, 'projects', 'ui-discovered');
      w.document.getElementById('modal-confirm-btn').click(); await sleep(150);
      assert.ok(calls[1].endsWith('deleteFiles=true'));
    } finally {
      w.document.getElementById('modal-cancel-btn')?.click();
      w.fetch = originalFetch;
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
    }
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
      assert.ok(w.document.querySelector('.workspace-chooser'));
      assert.equal(w.document.getElementById('terminal-viewport'), null);
      w.document.querySelector('[data-workspace-mode="terminal"]').click();
      await sleep(500);
      const button = w.document.getElementById('ws-editor-btn');
      assert.equal(button.textContent, 'VS Code');
      assert.equal(w.document.querySelector('.workspace-modes'), null);
      assert.equal(w.document.getElementById('ws-chat-btn'), null);
      const viewport = w.document.getElementById('terminal-viewport');
      button.click();
      await sleep(300);
      assert.ok(w.document.getElementById('editor-install'));
      assert.ok(w.document.querySelector('.browser-editor').getAttribute('aria-label').includes('ui-discovered'));
      assert.equal(w.document.querySelector(`[data-workspace-context="${projectId}"]`), null, 'failed terminal launch and editor setup are not open workspaces');
      assert.ok(w.document.querySelector('.workspace-surface > .browser-editor-embedded'));
      assert.equal(w.getComputedStyle(w.document.querySelector('.sidebar')).visibility, 'visible');
      assert.equal(w.getComputedStyle(w.document.querySelector('.top-bar')).visibility, 'visible');
      assert.equal(w.document.getElementById('editor-stop'), null);
      assert.equal(w.document.getElementById('editor-back'), null);
      assert.equal(w.document.querySelector('.browser-editor-bar'), null);
      w.document.getElementById('ws-close-mode').click();
      assert.equal(w.document.getElementById('terminal-viewport'), viewport);
      assert.equal(w.document.querySelector('.browser-editor'), null);
      assert.ok(w.document.querySelector('.workspace-chooser'));
      w.document.querySelector('[data-workspace-mode="terminal"]').click();
      assert.equal(w.document.getElementById('terminal-viewport'), viewport);
    } finally {
      w.fetch = originalFetch;
      w.document.querySelector('.nav-item[data-view="projects"]').click();
      await sleep(300);
    }
    assert.deepEqual(errors, []);
  });

  test('retired native Chat entry points and OpenCode GUI controls are absent', () => {
    assert.equal(w.CitadelChat, undefined);
    assert.equal(w.CitadelProjectTools.showChat, undefined);
    assert.equal(w.document.querySelector('script[src^="/js/chat.js"]'), null);
    assert.equal(w.document.querySelector('[data-view="chat"], [data-workspace-mode="chat"], #ws-chat-btn, .chat-panel'), null);
    const projectId = w.document.querySelector('.open-workspace-btn').dataset.projectId;
    w.document.querySelector(`.proj-menu-btn[data-project-id="${projectId}"]`).click();
    assert.equal([...w.document.querySelectorAll('.ctx-item')].some(item => item.textContent.trim() === 'Chat'), false);
    w.document.body.click();
    assert.equal(w.CitadelBrowserEditor.openCode, undefined);
    assert.equal(w.CitadelProjectTools.showOpenCode, undefined);
    assert.equal(w.document.getElementById('ws-opencode-btn'), null);
    for (const file of ['app.js', 'browser-editor.js', 'project-tools.js']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'public/js', file), 'utf8'), /CitadelChat|opencode-web|openCode\(/);
  });

  test('workspace remembers VS Code, keeps mounted terminals and ignores late terminal lists outside Terminal', async () => {
    const originalFetch = w.fetch;
    const projectId = w.document.querySelector('.open-workspace-btn').dataset.projectId;
    w.CitadelProjectTools.workspacePreference(projectId, { mode: 'vscode' });
    let creates = 0, finishTerminals;
    w.fetch = (url, opts = {}) => {
      if (String(url).includes('/api/terminals?projectId=') && !opts.method) return new Promise(resolve => { finishTerminals = () => resolve({ ok: true, json: async () => ({ sessions: [], tmuxAvailable: false }) }); });
      if (String(url).includes('/api/terminals') && opts.method === 'POST') { creates++; return Promise.reject(new Error('Fixture terminal disabled')); }
      if (String(url) === '/api/editor') return Promise.resolve({ ok: true, json: async () => ({ editor: { installed: false, running: false } }) });
      return originalFetch(url, opts);
    };
    try {
      w.document.querySelector('.open-workspace-btn').click(); await sleep(500);
      assert.ok(w.document.querySelector('.browser-editor-embedded'));
      assert.ok(w.document.querySelector('.top-bar-lead #ws-close-mode'));
      assert.equal(creates, 0);
      assert.equal(w.getComputedStyle(w.document.querySelector('.sidebar')).visibility, 'visible');
      assert.equal(w.getComputedStyle(w.document.querySelector('.top-bar')).visibility, 'visible');
      w.document.getElementById('mobile-menu-btn').click();
      assert.equal(w.document.querySelector('.sidebar').classList.contains('desktop-folded'), true);
      assert.equal(w.document.getElementById('mobile-menu-btn').getAttribute('aria-expanded'), 'false');
      w.document.getElementById('mobile-menu-btn').click();
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
      w.document.querySelector('.open-workspace-btn').click(); await sleep(500);
      assert.ok(w.document.querySelector('.browser-editor-embedded'));
      assert.equal(creates, 0);
      w.document.getElementById('ws-close-mode').click();
      w.document.querySelector('[data-workspace-mode="terminal"]').click(); await sleep(400);
      const viewport = w.document.getElementById('terminal-viewport');
      w.document.getElementById('ws-close-mode').click();
      w.document.querySelector('[data-workspace-mode="vscode"]').click(); await sleep(0);
      assert.equal(typeof finishTerminals, 'function');
      finishTerminals(); await sleep(50);
      assert.equal(creates, 0, 'late empty terminal list cannot spawn a shell in VS Code');
      w.document.getElementById('ws-close-mode').click();
      w.document.querySelector('[data-workspace-mode="terminal"]').click(); await sleep(100);
      const mountedViewport = w.document.getElementById('terminal-viewport');
      finishTerminals(); await sleep(100);
      const before = creates;
      for (let i = 0; i < 3; i++) {
        w.document.getElementById('ws-close-mode').click();
        w.document.querySelector('[data-workspace-mode="vscode"]').click(); await sleep(0);
        assert.equal(w.document.getElementById('ws-close-mode').closest('[inert]'), null);
        assert.equal(w.document.getElementById('terminal-viewport'), mountedViewport);
        assert.equal(mountedViewport.isConnected, true);
        w.document.getElementById('ws-close-mode').click();
        w.document.querySelector('[data-workspace-mode="terminal"]').click();
        assert.equal(w.document.getElementById('terminal-viewport'), mountedViewport);
      }
      assert.notEqual(mountedViewport, viewport);
      assert.equal(creates, before);
      w.document.getElementById('ws-close-mode').click();
      w.document.querySelector('[data-workspace-mode="vscode"]').click(); await sleep(0);
      assert.equal(w.document.getElementById('editor-back'), null);
      w.document.getElementById('ws-close-mode').click();
      assert.ok(w.document.querySelector('.workspace-chooser'));
      assert.equal(w.document.getElementById('terminal-viewport'), mountedViewport);
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
      w.document.querySelector('.open-workspace-btn').click(); await sleep(500);
      assert.ok(w.document.querySelector('.workspace-chooser'));
      assert.equal(w.document.querySelector('.browser-editor'), null);
    } finally {
      w.fetch = originalFetch;
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
    }
  });

  test('legacy Chat preference falls back to the two-mode chooser and preserves workspace lifecycle', async () => {
    const originalFetch = w.fetch;
    const calls = [];
    let finishEditor;
    w.fetch = (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET' });
      if (String(url) === '/api/editor') return Promise.resolve({ ok: true, json: async () => ({ editor: { installed: true, running: true } }) });
      if (String(url).endsWith('/editor') && opts.method === 'POST') return new Promise(resolve => { finishEditor = () => resolve({ ok: true, json: async () => ({ url: `/editor/${projectId}/?folder=test` }) }); });
      if (String(url) === '/api/terminals' && opts.method === 'POST') return Promise.reject(new Error('Fixture terminal disabled'));
      return originalFetch(url, opts);
    };
    const projectId = w.document.querySelector('.open-workspace-btn').dataset.projectId;
    const tools = w.CitadelProjectTools;
    tools.workspacePreference(projectId, { mode: 'chat', terminalId: 'saved-terminal', chatSessionId: 'saved-chat' });
    const enter = async () => { w.document.querySelector('.open-workspace-btn').click(); await sleep(350); };
    const leave = async () => {
      const close = w.document.getElementById('ws-close-mode');
      const mode = tools.workspacePreference(projectId).mode;
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
      assert.equal(w.document.getElementById('ws-close-mode'), null);
      close?.click();
      assert.equal(tools.workspacePreference(projectId).mode, mode, 'detached header action cannot clear remembered mode');
    };
    const sidebar = label => {
      const entry = w.document.querySelector(`[data-ws-menu-context="${projectId}"]`);
      if (!entry) {
        const mode = { 'VS Code': 'vscode', 'Open terminal': 'terminal' }[label];
        w.document.querySelector(`[data-workspace-mode="${mode}"]`).click();
        return;
      }
      entry.click();
      assert.equal([...w.document.querySelectorAll('.ctx-item')].some(item => item.textContent.trim() === 'Chat'), false);
      const button = [...w.document.querySelectorAll('.ctx-item')].find(item => item.textContent === label);
      assert.ok(button); button.click();
    };
    try {
      await enter();
      assert.ok(w.document.querySelector('.workspace-chooser'), 'retired saved mode opens the chooser instead of launching a service');
      assert.deepEqual([...w.document.querySelectorAll('[data-workspace-mode]')].map(button => button.dataset.workspaceMode), ['terminal', 'vscode']);
      assert.equal(w.document.querySelectorAll('.workspace-mode-card').length, 2);
      assert.equal(w.document.getElementById('ws-close-mode'), null);
      for (const selector of ['.workspace-modes', '#ws-terminal-mode', '#ws-chat-btn', '#ws-vscode-mode', '.chat-panel']) assert.equal(w.document.querySelector(selector), null);
      assert.equal(w.document.activeElement.dataset.workspaceMode, 'terminal');
      assert.equal(calls.some(call => call.method !== 'GET' || /\/chat(?:\/|$)/.test(call.url)), false);
      assert.equal(w.document.querySelectorAll('[data-stop-mode], [data-mode-status]').length, 0);
      assert.equal(w.document.querySelector('button button'), null);
      sidebar('VS Code'); await sleep(30);
      assert.equal(tools.workspacePreference(projectId).mode, 'vscode');
      const close = w.document.querySelector('.top-bar-lead #ws-close-mode');
      assert.ok(close);
      assert.equal(close.getAttribute('aria-label'), 'Choose mode');
      assert.equal(close.title, 'Choose mode');
      assert.ok(close.querySelector('svg[aria-hidden="true"]'));
      assert.equal(close.textContent.trim(), '', 'mode action is an arrow with no visible label');
      assert.equal(w.document.getElementById('mobile-menu-btn').nextElementSibling, close, 'mode action sits directly beside the sidebar toggle');
      assert.equal(w.document.querySelector('#top-bar-actions #ws-close-mode'), null);
      assert.match(w.document.getElementById('top-bar-title').textContent, /ui-discovered/);
      assert.ok(w.document.querySelector('.workspace-surface > .browser-editor-embedded'));
      w.document.getElementById('ws-close-mode').click();
      finishEditor(); await sleep(20);
      assert.equal(w.document.querySelector('.browser-editor-frame'), null);
      assert.ok(w.document.querySelector('.workspace-chooser'));
      assert.equal(tools.workspacePreference(projectId).mode, null);
      assert.equal(w.document.getElementById('ws-close-mode'), null);
      assert.equal(w.document.activeElement.dataset.workspaceMode, 'terminal');
      assert.equal(tools.workspacePreference(projectId).terminalId, 'saved-terminal');
      assert.equal(tools.workspacePreference(projectId).chatSessionId, 'saved-chat');
      w.document.querySelector('[data-workspace-mode="vscode"]').click(); await sleep(20);
      finishEditor(); await sleep(20);
      assert.ok(w.document.querySelector('.workspace-surface iframe'));
      assert.equal(w.getComputedStyle(w.document.querySelector('.browser-editor')).position, 'absolute');
      await leave(); assert.equal(w.document.querySelector('.browser-editor'), null);
      await enter(); await sleep(20); finishEditor(); await sleep(20);
      assert.equal(tools.workspacePreference(projectId).mode, 'vscode');
      assert.ok(w.document.querySelector('.top-bar-lead #ws-close-mode'));
      assert.ok(w.document.querySelector('.workspace-surface iframe'));
      sidebar('Open terminal'); await sleep(100);
      assert.equal(w.document.querySelector('.browser-editor'), null);
      const viewport = w.document.getElementById('terminal-viewport');
      assert.ok(viewport);
      const creates = calls.filter(call => call.url === '/api/terminals' && call.method === 'POST').length;
      for (let i = 0; i < 3; i++) {
        w.document.getElementById('ws-close-mode').click();
        w.document.querySelector('[data-workspace-mode="terminal"]').click();
        assert.equal(w.document.getElementById('terminal-viewport'), viewport);
      }
      assert.equal(calls.filter(call => call.url === '/api/terminals' && call.method === 'POST').length, creates);
      await leave(); await enter();
      assert.equal(tools.workspacePreference(projectId).mode, 'terminal');
      assert.ok(w.document.querySelector('.top-bar-lead #ws-close-mode'));
      assert.equal(calls.some(call => call.method === 'DELETE' || call.url.endsWith('/cancel')), false);
      w.document.getElementById('ws-close-mode').click();
      await leave(); await enter();
      assert.ok(w.document.querySelector('.workspace-chooser'));
    } finally {
      w.fetch = originalFetch; await leave();
    }
    assert.deepEqual(errors, []);
  });

  test('minimal chooser has only mode buttons and Back preserves work without status requests', async () => {
    const originalFetch = w.fetch, calls = [];
    const projectId = w.document.querySelector('.open-workspace-btn').dataset.projectId;
    w.CitadelProjectTools.workspacePreference(projectId, { mode: null });
    w.fetch = (url, opts = {}) => {
      url = String(url);
      calls.push({ url, method: opts.method || 'GET' });
      const response = data => Promise.resolve({ ok: true, json: async () => data });
      if (url.startsWith('/api/terminals?projectId=')) return response({ sessions: [], tmuxAvailable: false });
      if (url === '/api/terminals' && opts.method === 'POST') return Promise.reject(new Error('Fixture terminal disabled'));
      if (url === '/api/editor') return response({ editor: { installed: false, running: true } });
      return originalFetch(url, opts);
    };
    const assertChooser = () => {
      const chooser = w.document.querySelector('.workspace-chooser');
      assert.ok(chooser);
      assert.equal(chooser.getAttribute('aria-label'), 'Choose workspace mode');
      assert.deepEqual([...chooser.querySelectorAll('button')].map(button => button.textContent.trim()), ['Terminal', 'VS Code']);
      assert.equal(chooser.querySelector('h2, p, [data-stop-mode], [data-mode-status], [role="status"]'), null);
      assert.equal(w.document.activeElement.dataset.workspaceMode, 'terminal');
    };
    try {
      w.document.querySelector('.open-workspace-btn').click(); await sleep(400);
      assertChooser();
      assert.equal(calls.some(call => call.method !== 'GET' || call.url.startsWith('/api/terminals?projectId=')), false);
      w.document.querySelector('[data-workspace-mode="terminal"]').click(); await sleep(100);
      const viewport = w.document.getElementById('terminal-viewport');
      assert.ok(viewport);
      const beforeBack = calls.length;
      w.document.getElementById('ws-close-mode').click(); await sleep(20);
      assertChooser();
      assert.equal(calls.length, beforeBack, 'Back does not query status or stop terminal work');
      assert.equal(viewport.isConnected, true);
      assert.ok(viewport.closest('.workspace-container').hasAttribute('inert'));
      w.document.querySelector('[data-workspace-mode="terminal"]').click(); await sleep(20);
      assert.equal(w.document.getElementById('terminal-viewport'), viewport);
      assert.equal(calls.length, beforeBack, 'reopening the mounted terminal does not create another session');
      w.document.getElementById('ws-close-mode').click();
      w.document.querySelector('[data-workspace-mode="vscode"]').click(); await sleep(30);
      assert.ok(w.document.querySelector('.browser-editor'));
      const beforeEditorBack = calls.length;
      w.document.getElementById('ws-close-mode').click(); await sleep(20);
      assertChooser();
      assert.equal(calls.length, beforeEditorBack, 'Back closes the editor view without a stop/status request');
      assert.equal(w.document.querySelector('.browser-editor'), null);
      assert.equal(w.document.getElementById('terminal-viewport'), viewport);
      assert.equal(calls.some(call => call.method === 'DELETE' || call.url.endsWith('/cancel')), false);
    } finally {
      w.fetch = originalFetch;
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
    }
  });

  test('pending terminal creation is serialized across workspace navigation and mode switches', async () => {
    const originalFetch = w.fetch;
    const projectId = w.document.querySelector('.open-workspace-btn').dataset.projectId;
    let finishCreate, creates = 0, live = false;
    w.CitadelProjectTools.workspacePreference(projectId, { mode: 'terminal' });
    w.fetch = (url, opts = {}) => {
      if (String(url).includes('/api/terminals?projectId=')) return Promise.resolve({ ok: true, json: async () => ({ sessions: live ? [{ id: 'serialized-terminal', name: 'Fixture', isAlive: true }] : [] }) });
      if (String(url) === '/api/terminals' && opts.method === 'POST') {
        creates++;
        return new Promise(resolve => { finishCreate = () => { live = true; resolve({ ok: true, json: async () => ({ session: { sessionId: 'serialized-terminal', name: 'Fixture' } }) }); }; });
      }
      return originalFetch(url, opts);
    };
    try {
      w.document.querySelector('.open-workspace-btn').click(); await sleep(350);
      assert.equal(creates, 1);
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
      w.document.querySelector('.open-workspace-btn').click(); await sleep(350);
      assert.equal(creates, 1, 're-entry must wait for the previous POST');
      w.document.getElementById('ws-close-mode').click();
      w.document.querySelector('[data-workspace-mode="terminal"]').click(); await sleep(30);
      assert.equal(creates, 1);
      finishCreate(); await sleep(350);
      assert.equal(creates, 1, 'the new view restores the newly created session instead of spawning again');
      assert.equal(w.CitadelProjectTools.workspacePreference(projectId).terminalId, 'serialized-terminal');
      assert.ok(w.document.getElementById('terminal-viewport'));
    } finally {
      w.fetch = originalFetch;
      w.document.querySelector('.nav-item[data-view="projects"]').click(); await sleep(300);
    }
  });

  test('editor stale stop and install handlers cannot affect replacement views', async () => {
    const isolated = new JSDOM('<main></main>', { runScripts: 'dangerously', url: base });
    const win = isolated.window;
    try {
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/browser-editor.js'), 'utf8'));
      const state = { user: { id: 'alice' }, activeHostId: 'local' };
      const notices = [], calls = [];
      let finishStop, failStop, installed = true;
      win.CitadelBrowserEditor.init({ state, escapeHtml: String, showToast: text => notices.push(text), api: async (url, opts = {}) => {
        calls.push([url, opts.method]);
        if (opts.method === 'DELETE') return new Promise((resolve, reject) => { finishStop = resolve; failStop = reject; });
        if (url === '/api/editor') return { editor: { installed, supported: true } };
        return { url: '/editor/project/?folder=test' };
      } });
      const project = { id: 'project', name: 'Project' };
      for (const failure of [false, true]) {
        await win.CitadelBrowserEditor.open(project);
        const stop = win.document.getElementById('editor-stop');
        const back = win.document.getElementById('editor-back');
        const stopping = stop.onclick();
        await win.CitadelBrowserEditor.open(project);
        const replacement = win.document.querySelector('.browser-editor');
        if (failure) failStop(new Error('Late stop failure'));
        else finishStop({});
        await stopping;
        assert.equal(win.document.querySelector('.browser-editor'), replacement);
        const before = calls.length;
        await stop.onclick(); back.onclick();
        assert.equal(win.document.querySelector('.browser-editor'), replacement);
        assert.equal(calls.length, before, 'detached stop handler cannot stop a new editor');
        assert.deepEqual(notices, []);
      }
      installed = false;
      await win.CitadelBrowserEditor.open(project);
      const install = win.document.getElementById('editor-install');
      win.CitadelBrowserEditor.close();
      const before = calls.length;
      await install.onclick({ currentTarget: install });
      assert.equal(calls.length, before, 'detached install handler cannot start installation');
      assert.deepEqual(notices, []);
    } finally { win.CitadelBrowserEditor.close(); isolated.window.close(); }
  });

  test('embedded editor ignores stale owner, host, project and closed-view startup responses', async () => {
    const isolated = new JSDOM('<main id="surface"><div id="terminal">Mounted terminal</div></main>', { runScripts: 'dangerously', url: base });
    const win = isolated.window;
    try {
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/browser-editor.js'), 'utf8'));
      const state = { user: { id: 'alice' }, activeHostId: 'local', hostIdentity: { instanceId: 'one' } };
      const calls = [], notices = [];
      let finish;
      win.CitadelBrowserEditor.init({ state, escapeHtml: text => String(text), showToast: text => notices.push(text), api: async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/editor') return { editor: { installed: true } };
        return new Promise(resolve => { finish = resolve; });
      } });
      const content = win.document.getElementById('surface');
      for (const change of ['close', 'host', 'owner', 'instance', 'project']) {
        state.activeHostId = 'local'; state.user = { id: 'alice' }; state.hostIdentity = { instanceId: 'one' };
        const opening = win.CitadelBrowserEditor.open({ id: 'old', name: 'Old' }, { content });
        await sleep(0);
        const resolveOld = finish;
        if (change === 'close') win.CitadelBrowserEditor.close();
        if (change === 'host') state.activeHostId = 'peer';
        if (change === 'owner') state.user = { id: 'bob' };
        if (change === 'instance') state.hostIdentity = { instanceId: 'two' };
        let next;
        if (change === 'project') { next = win.CitadelBrowserEditor.open({ id: 'next', name: 'Next' }, { content }); await sleep(0); }
        resolveOld({ url: '/editor/old/?folder=test' }); await opening;
        assert.equal(content.querySelector('iframe'), null);
        if (next) { finish({ url: '/editor/next/?folder=test' }); await next; assert.match(content.querySelector('iframe').src, /\/editor\/next\//); }
        win.CitadelBrowserEditor.close();
        assert.equal(content.querySelector('#terminal').hasAttribute('inert'), false);
      }
      state.activeHostId = 'peer';
      const before = calls.length;
      await win.CitadelBrowserEditor.open({ id: 'remote', name: 'Remote' }, { content });
      assert.equal(calls.length, before);
      assert.match(notices.at(-1), /machine’s own Citadel panel/);
      assert.equal(calls.some(call => call.options?.method === 'DELETE'), false);
    } finally { win.CitadelBrowserEditor.close(); isolated.window.close(); }
  });

  test('workspace preferences isolate project, owner and host while preserving saved selections', () => {
    const isolated = new JSDOM('', { runScripts: 'dangerously', url: base });
    const win = isolated.window;
    try {
      win.eval(fs.readFileSync(path.join(ROOT, 'public/js/project-tools.js'), 'utf8'));
      const state = { activeHostId: 'local', user: { id: 'alice' }, hostIdentity: { instanceId: 'one' } };
      const tools = win.CitadelProjectTools;
      const launches = [];
      tools.init({ state, api() {}, escapeHtml() {}, renderProjectsView() {}, showToast() {}, openWorkspace: (...args) => launches.push(args) });
      tools.showEditor({ id: 'editor' });
      assert.deepEqual(launches, [['editor', 'vscode']]);
      assert.equal(tools.showChat, undefined);
      tools.workspacePreference('a', { mode: 'terminal', terminalId: 'term-a' });
      tools.workspacePreference('b', { mode: 'terminal', terminalId: 'term-b' });
      tools.workspacePreference('editor', { mode: 'vscode', editorOpened: true });
      tools.workspacePreference('legacy', { mode: 'chat', chatSessionId: 'saved-history' });
      assert.equal(tools.workspacePreference('a').terminalId, 'term-a');
      assert.equal(tools.workspacePreference('b').terminalId, 'term-b');
      for (const field of ['user', 'activeHostId', 'hostIdentity']) {
        const original = state[field];
        state[field] = field === 'user' ? { id: 'bob' } : field === 'activeHostId' ? 'peer' : { instanceId: 'two' };
        assert.equal(tools.workspacePreference('a').mode, undefined);
        assert.equal(tools.workspacePreference('editor').mode, undefined);
        assert.equal(tools.workspacePreference('legacy').chatSessionId, undefined);
        state[field] = original;
      }
      tools.reset();
      assert.equal(tools.workspacePreference('a').mode, 'terminal', 'non-secret selections survive logout');
      assert.equal(tools.workspacePreference('editor').mode, 'vscode');
      assert.equal(tools.workspacePreference('legacy').chatSessionId, 'saved-history', 'retiring the GUI does not erase history references');
    } finally { isolated.window.close(); }
  });

  test('session teardown invalidates workspace actions and resets retained frontend state', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    assert.match(appSource, /function teardownSession\(\) \{\s*workspaceGeneration\+\+;\s*document.getElementById\('ws-close-mode'\)\?\.remove\(\);\s*window.CitadelBrowserEditor.close\(\);\s*window.CitadelProjectTools.reset\(\);\s*chooseWorkspaceMode = null;\s*workspaceMode = null;/);
    assert.doesNotMatch(appSource, /CitadelChat/);
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
