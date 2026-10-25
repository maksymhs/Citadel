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
    for (const name of ['CitadelMonitor', 'CitadelDisk', 'CitadelDeployments', 'CitadelFleet', 'CitadelActivity', 'CitadelRepos', 'CitadelFiles', 'CitadelPairing', 'CitadelProjectTools', 'CitadelGatewaySettings', 'CitadelBrowserEditor']) {
      assert.equal(typeof w[name], 'object', `window.${name} is missing`);
    }
    assert.ok(w.document.querySelector('.nav-item'), 'the sidebar should render after sign-in');
    assert.deepEqual(errors, []);
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

  test('AI Gateway settings expose installation, login and model activation controls', async () => {
    w.document.querySelector('.nav-item[data-view="settings"]').click();
    await sleep(800);
    const tile = w.document.querySelector('[data-settings-section="gateway"]');
    assert.ok(tile, 'Gateway is reachable from Settings');
    tile.click();
    await sleep(500);
    assert.ok(w.document.getElementById('gateway-install'));
    assert.equal(w.document.getElementById('gateway-login').disabled, true);
    assert.equal(w.document.getElementById('gateway-enabled').checked, false);
    assert.equal(w.document.getElementById('gateway-enabled').disabled, true);
    assert.equal(w.document.getElementById('gateway-planning').value, 'gpt-6.1-sol');
    assert.equal(w.document.getElementById('gateway-execution').value, 'gpt-6-luna');
    assert.match(w.document.getElementById('gateway-body').textContent, /Automatic quota fallback is not enabled/);
    w.document.querySelector('.nav-item[data-view="projects"]').click();
    await sleep(300);
    assert.equal(w.document.getElementById('gateway-body'), null);
    assert.deepEqual(errors, []);
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
