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
    for (const name of ['CitadelMonitor', 'CitadelDisk', 'CitadelDeployments', 'CitadelFleet', 'CitadelActivity', 'CitadelRepos', 'CitadelFiles', 'CitadelPairing', 'CitadelProjectTools', 'CitadelGatewaySettings', 'CitadelBrowserEditor', 'CitadelTerminalImages']) {
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

  test('Claude Code Gateway settings expose installation, login and 1M context controls', async () => {
    w.document.querySelector('.nav-item[data-view="settings"]').click();
    await sleep(800);
    const tile = w.document.querySelector('[data-settings-section="gateway"]');
    assert.ok(tile, 'Claude Code Gateway is reachable from Settings');
    assert.match(tile.textContent, /Claude Code Gateway/);
    tile.click();
    await sleep(500);
    assert.ok(w.document.getElementById('gateway-install'));
    assert.equal(w.document.querySelector('.settings-screen-head h2').textContent, 'Claude Code Gateway');
    assert.match(w.document.getElementById('top-bar-title').textContent, /Claude Code Gateway/);
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
      let gateway = { installed: true, supported: true, running: true, connected: true, enabled: true, port: 8317, version: 'fixture', mode: 'chatgpt', contextTokens: 200000,
        planningModel: 'gpt-plan', executionModel: 'gpt-run', smallModel: 'gpt-small', claudePlanningModel: 'claude-plan', claudeExecutionModel: 'claude-run', claudeSmallModel: 'claude-small', connections: { codex: true, claude: false } };
      const discovery = { providers: { codex: { connected: true, models: { status: 'available', source: 'credential_catalog', fetchedAt: new Date().toISOString(), stale: false, items: [{ id: 'gpt-run', label: 'GPT run' }] }, usage: { status: 'available', fetchedAt: new Date().toISOString(), accounts: [{ label: 'Account 1', windows: [{ id: 'primary', label: '5-hour window', usedPercent: 0, durationSeconds: 18000, resetsAt: new Date(Date.now() + 60000).toISOString() }, { id: 'weekly', label: 'Weekly window', usedPercent: 45 }, { id: 'limit', label: 'Additional limit', usedPercent: 100 }, { id: 'unknown', label: 'Unknown window', usedPercent: null }] }, { label: 'Account 2', windows: [{ id: 'secondary', label: 'Other account', usedPercent: 12 }] }] } }, claude: { connected: false, models: { status: 'not_connected', items: [] }, usage: { status: 'not_connected', accounts: [] } } } };
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
      const opencode = win.document.getElementById('gateway-opencode');
      assert.ok(opencode);
      opencode.checked = true; opencode.dispatchEvent(new win.Event('change', { bubbles: true }));
      win.document.getElementById('gateway-mode').value = 'auto';
      win.document.getElementById('gateway-mode').dispatchEvent(new win.Event('change', { bubbles: true }));
      win.document.getElementById('gateway-save').click(); await sleep(30);
      assert.equal(calls.find(call => call.method === 'PUT').body.mode, 'auto');
      assert.equal(calls.find(call => call.method === 'PUT').body.opencodeEnabled, true);
      assert.equal(calls.find(call => call.method === 'PUT').body.contextTokens, 1000000, 'the explicit draft restoration is applied only by Save');
      const planning = win.document.getElementById('gateway-planning');
      planning.value = 'gpt-run'; planning.dispatchEvent(new win.Event('change', { bubbles: true }));
      const enabled = win.document.getElementById('gateway-enabled'); enabled.checked = false; enabled.dispatchEvent(new win.Event('change', { bubbles: true })); await sleep(30);
      const toggle = calls.filter(call => call.method === 'PUT').at(-1);
      assert.deepEqual(Object.keys(toggle.body), ['enabled'], 'the activation switch sends no other configuration fields');
      assert.equal(toggle.body.enabled, false, 'the activation switch sends its new state');
      assert.equal(win.document.getElementById('gateway-planning').value, 'gpt-run', 'pending model edit survives an activation update');
      win.document.getElementById('gateway-test').click(); await sleep(30);
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
