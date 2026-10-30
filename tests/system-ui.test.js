/** System screen regression coverage with faked host APIs; no real processes are signalled. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(role = 'admin') {
  const dom = new JSDOM('<div id="main-content"></div>', { runScripts: 'dangerously' });
  const win = dom.window;
  win.eval(fs.readFileSync(path.join(__dirname, '../public/js/system.js'), 'utf8'));
  const calls = [], notices = [], forgotten = [];
  let dialog, failure = false;
  const state = { activeHostId: 'peer-one', user: { id: 'owner', role }, hosts: [{ id: 'peer-one', name: 'First machine' }] };
  win.CitadelSystem.init({ state, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    openModal: value => { dialog = value; }, showToast: value => notices.push(value), forgetTerminal: (...args) => forgotten.push(args), installAgent() {},
    localApi: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (options.method) {
        if (failure) throw new Error('Permission denied');
        if (url.endsWith('/editor')) return { editor: { running: false } };
        return { success: true, signalSent: true };
      }
      if (url.includes('/system/processes')) return { processes: { total: 2, processes: [
        { pid: 200, name: 'Worker <safe>', cpuPercent: 1, rssBytes: 1000, identity: 'start-200', canTerminate: true },
        { pid: 1, name: 'init', cpuPercent: 0, rssBytes: 1000, canTerminate: false },
      ] } };
      if (url.endsWith('/terminals')) return { sessions: [{ id: 'terminal-one', name: 'Shell', isAlive: true, project_id: null }] };
      if (url.endsWith('/editor')) return { editor: { running: true } };
      if (url.endsWith('/projects')) return { projects: [] };
      throw new Error('Unexpected endpoint');
    },
  });
  return { win, state, calls, notices, forgotten, dialog: () => dialog, fail: () => { failure = true; }, close: () => dom.window.close() };
}

test('System process controls require confirmation, bind identity and distinguish signal delivery from exit', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('processes');
    assert.deepEqual([...f.win.document.querySelectorAll('[data-system-tab]')].map(button => button.textContent), ['Processes', 'Terminals', 'VS Code', 'Tools']);
    assert.equal(f.win.document.querySelectorAll('[data-process]').length, 2, 'protected processes have no controls');
    assert.equal(f.win.document.querySelector('safe'), null, 'process names are escaped');
    assert.equal(f.calls.filter(call => call.method).length, 0);
    f.win.document.querySelector('[data-signal="KILL"]').click();
    assert.match(f.dialog().warning || f.dialog().bodyHtml, /Force kill prevents cleanup/);
    assert.equal(f.calls.filter(call => call.method).length, 0);
    await f.dialog().onConfirm();
    const call = f.calls.find(call => call.method);
    assert.equal(call.url, '/api/remote/peer-one/system/processes/200/terminate');
    assert.deepEqual(JSON.parse(JSON.stringify(call.body)), { identity: 'start-200', signal: 'KILL' });
    assert.match(f.notices[0], /exit is not guaranteed/);
  } finally { f.close(); }
});

test('System rejects stale confirmation after changing machine, account or role', async () => {
  for (const change of [f => { f.state.activeHostId = 'peer-two'; }, f => { f.state.user.id = 'another-owner'; }, f => { f.state.user.role = 'user'; }]) {
    const f = fixture();
    try {
      await f.win.CitadelSystem.render('terminals');
      f.win.document.querySelector('[data-stop-terminal]').click();
      change(f);
      await assert.rejects(f.dialog().onConfirm, /Machine or user changed/);
      assert.equal(f.calls.filter(call => call.method).length, 0);
    } finally { f.close(); }
  }
});

test('failed terminal stop retains client sessions and does not report success', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('terminals');
    f.win.document.querySelector('[data-stop-terminal]').click();
    f.fail();
    await assert.rejects(f.dialog().onConfirm, /Permission denied/);
    assert.deepEqual(f.forgotten, []);
    assert.deepEqual(f.notices, []);
  } finally { f.close(); }
});

test('VS Code stop warns that the instance is shared and uses the captured remote host', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('editor');
    assert.equal(f.calls.filter(call => call.method).length, 0);
    f.win.document.querySelector('#system-stop-editor').click();
    assert.match(f.dialog().bodyHtml, /every project and browser/);
    await f.dialog().onConfirm();
    assert.equal(f.calls.find(call => call.method).url, '/api/remote/peer-one/editor');
  } finally { f.close(); }
});

test('non-admin System has no stop actions and does not request editor status', async () => {
  const f = fixture('user');
  try {
    for (const tab of ['processes', 'terminals', 'editor']) {
      await f.win.CitadelSystem.render(tab);
      assert.equal(f.win.document.querySelector('[data-process], [data-stop-terminal], #system-stop-editor'), null);
    }
    assert.equal(f.calls.some(call => call.url.endsWith('/editor')), false);
  } finally { f.close(); }
});

test('leaving System invalidates a pending confirmation', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('terminals');
    f.win.document.querySelector('[data-stop-terminal]').click();
    f.win.CitadelSystem.dispose();
    await assert.rejects(f.dialog().onConfirm, /Machine or user changed/);
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});
