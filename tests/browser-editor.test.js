/** Browser editor startup masking, theme preservation and stale lifecycle guards without a real editor. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-browser-editor-'));
Object.assign(process.env, { DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'), PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'), CITADEL_SELF_UPDATE: '0' });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const source = fs.readFileSync(path.join(__dirname, '../public/js/browser-editor.js'), 'utf8');
const project = { id: 'project', name: 'Project <test>' };
const url = '/editor/project/?folder=%2Fprojects%2Ftest';
function setup(api) {
  const dom = new JSDOM('<main id="surface"><div id="terminal">Terminal</div><div id="inert" inert>Already inert</div></main>', { url: 'http://citadel.test/', runScripts: 'dangerously' });
  const win = dom.window;
  const intervals = new Map(), timeouts = new Map(), calls = [], opened = [];
  let next = 0;
  win.setInterval = fn => { intervals.set(++next, fn); return next; };
  win.setTimeout = (fn, delay) => { assert.equal(delay, 60000); timeouts.set(++next, fn); return next; };
  win.clearInterval = id => intervals.delete(id);
  win.clearTimeout = id => timeouts.delete(id);
  win.eval(source);
  const state = { user: { id: 'alice' }, activeHostId: 'local', hostIdentity: { instanceId: 'one' } };
  win.CitadelProjectTools = { workspacePreference: (...args) => opened.push(args) };
  win.CitadelBrowserEditor.init({ state, escapeHtml: text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]), showToast() {}, api: async (address, options = {}) => {
    calls.push([address, options.method]);
    if (api) return api(address, options);
    return address === '/api/editor' ? { editor: { installed: true } } : { url };
  } });
  return {
    win, state, calls, opened, intervals, timeouts,
    editor: win.CitadelBrowserEditor,
    content: win.document.getElementById('surface'),
    check: () => { for (const fn of [...intervals.values()]) fn(); },
    expire: () => { for (const fn of [...timeouts.values()]) fn(); },
    dispose: () => { win.CitadelBrowserEditor.close(); dom.window.close(); },
  };
}
function documentFor(frame, html) {
  const doc = frame.contentDocument;
  doc.open(); doc.write(`<html><head></head><body>${html}</body></html>`); doc.close();
  return doc;
}

test('iframe stays masked through document load and startup splash, then reveals the unmodified user theme', async () => {
  const h = setup();
  try {
    await h.editor.open(project, { content: h.content });
    const frame = h.content.querySelector('iframe');
    assert.equal(frame.getAttribute('src'), url);
    assert.equal(frame.getAttribute('allow'), 'clipboard-read; clipboard-write');
    assert.equal(frame.title, `VS Code · ${project.name}`);
    assert.equal(frame.getAttribute('aria-hidden'), 'true');
    assert.equal(frame.tabIndex, -1);
    frame.dispatchEvent(new h.win.Event('load'));
    h.check();
    assert.ok(frame.classList.contains('browser-editor-frame-loading'), 'load alone is not workbench readiness');
    const doc = documentFor(frame, '<div id="vscode-startup-fallback"></div><div class="monaco-workbench" style="background: white; color: black">Custom light theme</div><div id="monaco-parts-splash"></div><style class="initialShellColors">body { background: white; }</style>');
    h.win.localStorage.setItem('custom-theme', 'user preference');
    h.check();
    assert.ok(frame.classList.contains('browser-editor-frame-loading'));
    doc.getElementById('vscode-startup-fallback').remove();
    h.check();
    assert.ok(frame.classList.contains('browser-editor-frame-loading'));
    doc.querySelector('.initialShellColors').remove();
    h.check();
    assert.ok(frame.classList.contains('browser-editor-frame-loading'), 'visible parts splash stays masked');
    doc.getElementById('monaco-parts-splash').style.display = 'none';
    const html = doc.documentElement.outerHTML;
    h.check();
    assert.equal(frame.classList.contains('browser-editor-frame-loading'), false);
    assert.equal(frame.hasAttribute('aria-hidden'), false);
    assert.equal(frame.hasAttribute('tabindex'), false);
    assert.equal(h.content.querySelector('.browser-editor-loading'), null);
    assert.equal(doc.documentElement.outerHTML, html, 'no styles/settings injected into the editor');
    assert.equal(h.win.localStorage.getItem('custom-theme'), 'user preference');
    assert.equal(h.intervals.size + h.timeouts.size, 0);
    assert.equal(h.opened.length, 1);
  } finally { h.dispose(); }
});

test('blocked, error and changed startup documents get bounded retry and trusted open-in-new-tab recovery', async () => {
  const h = setup();
  try {
    await h.editor.open(project);
    const frame = h.win.document.querySelector('iframe');
    documentFor(frame, '<h1>Bad gateway</h1>');
    h.check();
    assert.ok(frame.classList.contains('browser-editor-frame-loading'));
    h.expire();
    assert.equal(h.win.document.querySelector('iframe'), null);
    assert.match(h.win.document.querySelector('.browser-editor-setup').textContent, /longer than expected/);
    let link = h.win.document.querySelector('.browser-editor-setup a');
    assert.equal(link.getAttribute('href'), url);
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(h.intervals.size + h.timeouts.size, 0);
    await h.win.document.getElementById('editor-retry').onclick();
    const retryFrame = h.win.document.querySelector('iframe');
    assert.ok(retryFrame.classList.contains('browser-editor-frame-loading'));
    retryFrame.onerror();
    assert.match(h.win.document.querySelector('.browser-editor-setup').textContent, /could not load/);
    link = h.win.document.querySelector('.browser-editor-setup a');
    assert.equal(link.getAttribute('href'), url);
    assert.equal(h.intervals.size + h.timeouts.size, 0);
    await h.win.document.getElementById('editor-retry').onclick();
    const inaccessible = h.win.document.querySelector('iframe');
    Object.defineProperty(inaccessible, 'contentDocument', { get() { throw new h.win.DOMException('Blocked', 'SecurityError'); } });
    assert.doesNotThrow(h.check);
    assert.ok(inaccessible.classList.contains('browser-editor-frame-loading'));
    h.expire();
    assert.equal(h.win.document.querySelector('iframe'), null);
    assert.equal(h.win.document.querySelector('.browser-editor-setup a').getAttribute('href'), url);
    assert.equal(h.intervals.size + h.timeouts.size, 0);
    assert.equal(h.calls.some(([, method]) => method === 'DELETE'), false);
  } finally { h.dispose(); }
});

test('closing, replacing and changing owner or host cancel startup without stopping the editor or stealing the new view', async () => {
  const h = setup();
  try {
    for (const change of ['close', 'replace', 'owner', 'host', 'instance']) {
      h.state.user.id = 'alice'; h.state.activeHostId = 'local'; h.state.hostIdentity.instanceId = 'one';
      await h.editor.open(project, { content: h.content });
      const frame = h.content.querySelector('iframe');
      const oldError = frame.onerror;
      const oldCheck = [...h.intervals.values()][0];
      if (change === 'close') h.editor.close();
      if (change === 'replace') await h.editor.open(project, { content: h.content });
      if (change === 'owner') h.state.user.id = 'bob';
      if (change === 'host') h.state.activeHostId = 'peer';
      if (change === 'instance') h.state.hostIdentity.instanceId = 'two';
      const replacement = h.content.querySelector('iframe');
      oldError(); oldCheck();
      assert.equal(h.content.querySelector('iframe'), replacement);
      assert.equal(h.win.document.getElementById('editor-retry'), null);
      assert.equal(h.intervals.size, change === 'replace' ? 1 : 0);
      h.editor.close();
      assert.equal(h.intervals.size + h.timeouts.size, 0);
      assert.equal(h.win.document.getElementById('terminal').hasAttribute('inert'), false);
      assert.equal(h.win.document.getElementById('inert').hasAttribute('inert'), true);
    }
    assert.equal(h.calls.some(([, method]) => method === 'DELETE'), false);
  } finally { h.dispose(); }
});

test('same-view retries ignore stale iframe errors and out-of-order startup responses', async () => {
  let pending;
  const h = setup(address => address === '/api/editor' ? { editor: { installed: true } } : pending ? new Promise(resolve => pending.push(resolve)) : { url });
  try {
    await h.editor.open(project);
    const staleError = h.win.document.querySelector('iframe').onerror;
    staleError();
    const retry = h.win.document.getElementById('editor-retry').onclick;
    pending = [];
    const older = retry(), newer = retry();
    pending[1]({ url }); await newer;
    const frame = h.win.document.querySelector('iframe');
    staleError();
    assert.equal(h.win.document.querySelector('iframe'), frame);
    pending[0]({ url: '/editor/project/?folder=stale' }); await older;
    assert.equal(h.win.document.querySelector('iframe'), frame);
    assert.equal(frame.getAttribute('src'), url);
    assert.equal(h.opened.length, 2, 'only the current startup marks the editor opened');
    assert.equal(h.intervals.size, 1);
  } finally { h.dispose(); }
});

test('untrusted URLs and late startup responses never create frames or recovery links', async () => {
  for (const invalid of ['https://evil.test/editor/project/?folder=x', '//evil.test/editor/project/?folder=x', '/editor/other/?folder=x', '/editor/project/?wrong=x']) {
    const h = setup(address => address === '/api/editor' ? { editor: { installed: true } } : { url: invalid });
    try {
      await h.editor.open(project);
      assert.equal(h.win.document.querySelector('iframe, .browser-editor-setup a'), null);
      assert.match(h.win.document.querySelector('.browser-editor-setup').textContent, /Invalid editor address/);
      assert.equal(h.intervals.size + h.timeouts.size, 0);
    } finally { h.dispose(); }
  }
  for (const change of ['close', 'owner', 'host', 'instance']) {
    let finish, started;
    const requested = new Promise(resolve => { started = resolve; });
    const h = setup(address => address === '/api/editor' ? { editor: { installed: true } } : new Promise(resolve => { finish = resolve; started(); }));
    try {
      const opening = h.editor.open(project);
      await requested;
      if (change === 'close') h.editor.close();
      if (change === 'owner') h.state.user.id = 'bob';
      if (change === 'host') h.state.activeHostId = 'peer';
      if (change === 'instance') h.state.hostIdentity.instanceId = 'two';
      finish({ url }); await opening;
      assert.equal(h.win.document.querySelector('iframe'), null);
      assert.equal(h.intervals.size + h.timeouts.size, 0);
    } finally { h.dispose(); }
  }
});
