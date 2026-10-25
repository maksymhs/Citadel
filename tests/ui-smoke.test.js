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
  let authCookie, managedProjectId;

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
        CITADEL_MISSIONS_DIR: path.join(data, 'missions'),
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
    authCookie = cookie;
    const createdProject = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Managed smoke' }),
    });
    assert.equal(createdProject.status, 200);
    managedProjectId = (await createdProject.json()).project.id;
    const repo = path.join(data, 'projects', 'managed-smoke');
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'overview.md'), '# Project overview\n\nSmoke documentation.');
    fs.writeFileSync(path.join(repo, 'first.js'), "require('./second');");
    fs.writeFileSync(path.join(repo, 'second.js'), 'module.exports = 1;');
    const mission = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        goal: 'Render the work board smoke mission',
        title: 'Work smoke',
        projectId: managedProjectId,
        plan: { tasks: [
          { title: 'Inspect the shell', role: 'analyst', acceptance: ['Brief is reviewed'] },
          { title: 'Render the room', role: 'frontend', deps: [0] },
        ] },
      }),
    });
    assert.equal(mission.status, 201, 'the smoke mission should be created');

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
    for (const name of ['CitadelMonitor', 'CitadelDisk', 'CitadelDeployments', 'CitadelFleet', 'CitadelActivity', 'CitadelRepos', 'CitadelFiles', 'CitadelPairing', 'CitadelMissions', 'CitadelKnowledge', 'CitadelProjectTools', 'CitadelProjectHub']) {
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
    for (const view of ['files', 'settings', 'projects', 'dashboard', 'project-hub']) {
      const link = w.document.querySelector(`.nav-item[data-view="${view}"]`);
      assert.ok(link, `nav item ${view} should exist`);
      link.click();
      await sleep(800);
      assert.ok(w.document.getElementById('main-content').innerHTML.length > 100, `${view} rendered nothing`);
    }
    assert.deepEqual(errors, []);
  });

  test('project discovery imports a folder and VS Code links encode paths safely', async () => {
    w.document.querySelector('.nav-item[data-view="projects"]').click();
    await sleep(800);
    const importButton = w.document.querySelector('[data-discover-index]');
    assert.ok(importButton, 'the projects directory is scanned when opening Projects');
    importButton.click();
    await sleep(800);
    assert.ok(w.document.querySelector('.proj-name').textContent.includes('ui-discovered'));
    assert.equal(w.document.querySelector('[data-discover-index]'), null, 'imported folder is not suggested twice');
    assert.equal(w.CitadelProjectTools.editorUrl('/tmp/a # b'), 'vscode://file/tmp/a%20%23%20b/');
    assert.throws(() => w.CitadelProjectTools.editorUrl('/tmp/project', 'host/path'), /SSH config/);
    w.CitadelProjectTools.showEditor({ name: 'Project', path: '/srv/a # b' });
    const host = w.document.getElementById('editor-ssh-host');
    host.value = 'my-vps';
    host.dispatchEvent(new w.Event('input'));
    const link = w.document.getElementById('editor-open-link');
    assert.equal(link.hidden, false);
    assert.equal(link.getAttribute('href'), 'vscode://vscode-remote/ssh-remote+my-vps/srv/a%20%23%20b/');
    w.document.getElementById('modal-close-btn').click();
    assert.deepEqual(errors, []);
  });

  test('one project hub connects the board, docs, graph and live trace with review', async () => {
    w.document.querySelector('.nav-item[data-view="project-hub"]').click();
    await sleep(800);
    assert.equal(w.document.querySelectorAll('.nav-item[data-view="work"], .nav-item[data-view="docs"], .nav-item[data-view="learning"]').length, 0);
    assert.ok(w.document.getElementById('ph-shell'));
    assert.equal(w.document.querySelectorAll('.ph-task').length, 2);
    assert.ok(w.document.querySelector('.ph-doc-link').textContent.includes('Project overview'));
    assert.ok(w.document.querySelectorAll('.ph-event').length >= 2, 'real enqueue events appear in the trace');
    w.document.querySelector('[data-ph="priority"]').click();
    await sleep(500);
    assert.match(w.document.getElementById('ph-trace-list').textContent, /reordered/);
    w.document.querySelector('[data-ph="graph"]').click();
    await sleep(500);
    assert.match(w.document.getElementById('ph-graph').textContent, /2 files/);
    w.document.querySelector('[data-ph="graph-node"]').click();
    assert.ok(w.document.querySelector('.ph-node-graph svg'));
    w.document.getElementById('modal-close-btn').click();
    w.document.querySelector('[data-ph="doc"]').click();
    await sleep(350);
    assert.match(w.document.querySelector('.ph-doc-modal').textContent, /Smoke documentation/);
    w.document.getElementById('modal-close-btn').click();

    const claim = await fetch(`${base}/api/tasks/claim`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: authCookie }, body: JSON.stringify({ node: 'ui-worker' }) });
    assert.equal(claim.status, 200);
    const task = (await claim.json()).task;
    const done = await fetch(`${base}/api/tasks/${task.id}/result`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: authCookie }, body: JSON.stringify({ status: 'done', claimToken: task.claimToken, result: 'Brief ready.' }) });
    assert.equal(done.status, 200);
    w.document.querySelector('[data-ph="refresh"]').click();
    await sleep(500);
    assert.equal(w.document.querySelectorAll('[data-ph-column="review"] .ph-task').length, 1);
    w.document.querySelector(`[data-ph="task"][data-id="${task.id}"]`).click();
    await sleep(350);
    w.document.getElementById('ms-review-accept').click();
    await sleep(600);
    assert.ok(w.document.getElementById('ph-shell'), 'accepting a task keeps the unified view');
    assert.equal(w.document.querySelectorAll('[data-ph-column="done"] .ph-task').length, 1);
    const pause = w.document.querySelector('[data-ph="pause"]');
    pause.click();
    assert.match(w.document.getElementById('ph-trace-state').textContent, /Paused/);
    pause.click();
    await sleep(300);
    assert.match(w.document.getElementById('ph-trace-state').textContent, /Live/);
    assert.deepEqual(errors, []);
  });

  test('leaving the project hub stops its background polling', async () => {
    let requests = 0;
    const original = w.fetch;
    w.fetch = (url, options) => {
      if (/\/(hub|trace)(\?|$)/.test(String(url))) requests++;
      return original(url, options);
    };
    try {
      w.document.querySelector('.nav-item[data-view="files"]').click();
      const count = requests;
      await sleep(4500);
      assert.equal(requests, count, 'hidden project views must not keep polling');
    } finally { w.fetch = original; }
  });

  test('screens reached from other screens render through their entry points', async () => {
    const entries = [
      ['CitadelRepos', 'renderReposView'], ['CitadelActivity', 'renderActivityView'], ['CitadelFleet', 'renderFleetView'],
      ['CitadelDeployments', 'renderDeploymentsView'], ['CitadelDeployments', 'renderDockerView'], ['CitadelFiles', 'renderFilesView'], ['CitadelMissions', 'renderMissionsView'],
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
