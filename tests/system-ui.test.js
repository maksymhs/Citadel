/** System screen regression coverage with faked host APIs; no real processes are signalled. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(role = 'admin') {
  const dom = new JSDOM('<button id="top-bar-back" hidden></button><div id="main-content"></div>', { runScripts: 'dangerously' });
  const win = dom.window;
  win.eval(fs.readFileSync(path.join(__dirname, '../public/js/system.js'), 'utf8'));
  const calls = [], notices = [], forgotten = [];
  let dialog, failure = false;
  const failing = new Set(), holds = new Map(), flags = { ignoreSort: false };
  const state = { activeHostId: 'peer-one', user: { id: 'owner', role }, hosts: [{ id: 'peer-one', name: 'First machine' }] };
  win.CitadelSystem.init({ state, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    openModal: value => { dialog = value; }, showToast: value => notices.push(value), forgetTerminal: (...args) => forgotten.push(args), installAgent() {},
    setDetailNavigation: (label, onBack) => {
      const button = win.document.getElementById('top-bar-back');
      button.hidden = !onBack;
      button.onclick = onBack;
    },
    localApi: async (url, options = {}) => {
      calls.push({ url, ...options });
      for (const part of failing) if (!options.method && url.includes(part)) throw new Error(`${part} unavailable`);
      for (const [part, gate] of holds) if (!options.method && url.includes(part)) await gate;
      if (options.method) {
        if (failure) throw new Error('Permission denied');
        if (url.endsWith('/editor')) return { editor: { running: false } };
        return { success: true, signalSent: true };
      }
      if (url.includes('/system/processes')) {
        const rows = [
          { pid: 200, name: 'Worker <safe>', cpuPercent: 1, rssBytes: 1000, identity: 'start-200', canTerminate: true },
          { pid: 1, name: 'init', cpuPercent: 0, rssBytes: 900, canTerminate: false },
          { pid: 300, name: 'Idle <big>', cpuPercent: 0, rssBytes: 5000, canTerminate: false },
        ];
        // The host ranks before limiting; the fake mimics that unless an old peer ignores ?sort=.
        if (url.includes('sort=memory') && !flags.ignoreSort) rows.sort((a, b) => b.rssBytes - a.rssBytes);
        return { processes: { total: 3, processes: rows } };
      }
      if (url.endsWith('/terminals')) return { sessions: [{ id: 'terminal-one', name: 'Shell', isAlive: true, project_id: null }] };
      if (url.endsWith('/editor')) return { editor: { running: true } };
      if (url.endsWith('/projects')) return { projects: [] };
      if (url.endsWith('/system/integrations')) return { integrations: { agents: [{ id: 'codex', name: 'Codex', available: false, detected: false }] } };
      if (url.endsWith('/system/tools')) return { tools: [{ id: 'git', name: 'git', group: 'Development', installed: true, version: '2.0' }] };
      throw new Error('Unexpected endpoint');
    },
  });
  return { win, state, calls, notices, forgotten, flags, dialog: () => dialog, fail: () => { failure = true; }, failing, holds, close: () => dom.window.close() };
}

test('System process controls require confirmation, bind identity and distinguish signal delivery from exit', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('processes');
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
      await f.win.CitadelSystem.render('workspace');
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
    await f.win.CitadelSystem.render('workspace');
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
    await f.win.CitadelSystem.render('workspace');
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
    await f.win.CitadelSystem.render('workspace');
    assert.equal(f.win.document.querySelector('[data-process], [data-stop-terminal], #system-stop-editor'), null);
    assert.match(f.win.document.querySelector('#system-editor-body').textContent, /Administrator privileges/);
    assert.equal(f.calls.some(call => call.url.endsWith('/editor')), false);
  } finally { f.close(); }
});

test('leaving System invalidates a pending confirmation', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('workspace');
    f.win.document.querySelector('[data-stop-terminal]').click();
    f.win.CitadelSystem.dispose();
    await assert.rejects(f.dialog().onConfirm, /Machine or user changed/);
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const SECTION_IDS = ['processes', 'workspace', 'tools'];
const processRows = doc => [...doc.querySelectorAll('#system-processes-body tbody tr')].map(row => row.querySelector('[data-label="Process"]')?.textContent);

test('System opens on three summary cards, with no tabs and no mutations', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
    const doc = f.win.document, pane = doc.querySelector('#system-management');
    assert.equal(pane.className, 'management-screen system-screen');
    assert.equal(doc.querySelector('[role="tablist"], [role="tab"], [data-system-tab], .mon-tabs'), null);
    const cards = [...doc.querySelectorAll('nav.system-cards[aria-label="System sections"] > button.system-card')];
    assert.deepEqual(cards.map(card => card.dataset.systemSection), SECTION_IDS);
    assert.deepEqual(cards.map(card => card.querySelector('strong').textContent), ['Processes', 'Terminals & VS Code', 'Tools']);
    assert.deepEqual(cards.map(card => card.querySelector('[data-system-summary]').textContent), ['3 running', '1 terminal · VS Code running', '0 AI agents · 1 tool']);
    assert.equal(doc.querySelector('#top-bar-back').hidden, true);
    assert.equal(doc.querySelector('[data-process], [data-stop-terminal], #system-stop-editor'), null, 'details load only when opened');
    assert.equal(f.calls.filter(call => call.method).length, 0);
    assert.equal(f.calls.some(call => call.url.includes('limit=50')), false, 'the hub asks only for counts');
  } finally { f.close(); }
});

test('opening a card shows its detail and Back returns to the cards', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
    const doc = f.win.document;
    doc.querySelector('[data-system-section="workspace"]').click();
    await tick();
    const detail = doc.querySelector('[data-system-detail="workspace"]');
    assert.equal(doc.getElementById(detail.getAttribute('aria-labelledby')).textContent, 'Terminals & VS Code');
    assert.ok(detail.querySelector('[data-stop-terminal]'));
    assert.ok(detail.querySelector('#system-stop-editor'));
    assert.equal(doc.querySelector('#top-bar-back').hidden, false);
    doc.querySelector('#top-bar-back').click();
    await tick();
    assert.equal(doc.querySelectorAll('.system-card').length, 3);
    assert.equal(doc.querySelector('[data-system-detail]'), null);
    doc.querySelector('[data-system-section="tools"]').click();
    await tick();
    assert.match(doc.querySelector('#system-tools-body').textContent, /AI coding agents[\s\S]*Codex[\s\S]*Installed tools[\s\S]*git/);
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});

test('hub summaries and detail mounts fail independently', async () => {
  const f = fixture();
  f.failing.add('/terminals');
  try {
    await f.win.CitadelSystem.render();
    const summaries = [...f.win.document.querySelectorAll('[data-system-summary]')].map(node => node.textContent);
    assert.deepEqual(summaries, ['3 running', 'Unavailable', '0 AI agents · 1 tool']);
    f.win.document.querySelector('[data-system-section="workspace"]').click();
    await tick();
    const doc = f.win.document;
    assert.match(doc.querySelector('#system-terminals-body').textContent, /unavailable/);
    assert.ok(doc.querySelector('#system-stop-editor'), 'VS Code still renders when terminals fail');
    assert.equal(doc.querySelector('h2').textContent, 'Terminals & VS Code');
  } finally { f.close(); }
});

test('Processes sorts by CPU or memory, asking the host to rank before limiting', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('processes');
    const doc = f.win.document;
    assert.ok(f.calls.some(call => call.url.endsWith('/system/processes?limit=50&sort=cpu')));
    assert.deepEqual(processRows(doc), ['Worker <safe>', 'Idle <big>', 'init']);
    assert.equal(doc.querySelector('[data-sort="cpu"]').getAttribute('aria-pressed'), 'true');
    doc.querySelector('[data-sort="memory"]').click();
    await tick();
    assert.ok(f.calls.some(call => call.url.endsWith('/system/processes?limit=50&sort=memory')));
    assert.deepEqual(processRows(doc), ['Idle <big>', 'Worker <safe>', 'init']);
    assert.equal(doc.querySelector('[data-sort="memory"]').getAttribute('aria-pressed'), 'true');
    assert.equal(doc.querySelector('[data-sort="cpu"]').getAttribute('aria-pressed'), 'false');
    assert.match(doc.querySelector('#system-processes-body').textContent, /by memory/);
    doc.querySelector('[data-sort="cpu"]').click();
    await tick();
    assert.deepEqual(processRows(doc), ['Worker <safe>', 'Idle <big>', 'init']);
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});

test('the process sort is applied locally when an older peer ignores ?sort=', async () => {
  const f = fixture();
  f.flags.ignoreSort = true;
  try {
    await f.win.CitadelSystem.render('processes');
    const doc = f.win.document;
    doc.querySelector('[data-sort="memory"]').click();
    await tick();
    assert.deepEqual(processRows(doc), ['Idle <big>', 'Worker <safe>', 'init']);
  } finally { f.close(); }
});

test('a successful stop refreshes in place and the hub summary updates after returning', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('workspace');
    const doc = f.win.document, detail = doc.querySelector('[data-system-detail]');
    doc.querySelector('[data-stop-terminal]').click();
    const before = f.calls.length;
    await f.dialog().onConfirm();
    assert.deepEqual(f.forgotten, [['peer-one', 'terminal-one']]);
    assert.deepEqual(f.notices, ['Terminal stopped.']);
    assert.equal(doc.querySelector('[data-system-detail]'), detail);
    const after = f.calls.slice(before).filter(call => !call.method).map(call => call.url);
    assert.ok(after.some(url => url.endsWith('/terminals')));
    assert.equal(after.some(url => url.includes('/system/processes')), false, 'only the affected mount reloads');
  } finally { f.close(); }
});

test('a stop confirmed after returning to the hub refreshes the summaries instead', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('workspace');
    const doc = f.win.document;
    doc.querySelector('[data-stop-terminal]').click();
    doc.querySelector('#top-bar-back').click();
    await tick();
    const before = f.calls.length;
    await f.dialog().onConfirm();
    assert.equal(f.calls.slice(before).some(call => !call.method && call.url.endsWith('/terminals')), true);
    assert.equal(doc.querySelectorAll('.system-card').length, 3);
  } finally { f.close(); }
});

test('leaving System invalidates a pending VS Code stop', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render('workspace');
    f.win.document.querySelector('#system-stop-editor').click();
    f.win.CitadelSystem.dispose();
    await assert.rejects(f.dialog().onConfirm, /Machine or user changed/);
  } finally { f.close(); }
});

test('only the Processes detail polls, skips hidden pages and stops on Back and disposal', async () => {
  const f = fixture();
  const intervals = [], cleared = [];
  const win = f.win;
  win.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  win.clearInterval = id => { cleared.push(id); };
  try {
    await win.CitadelSystem.render();
    assert.deepEqual(intervals, [], 'the hub never polls');
    win.document.querySelector('[data-system-section="workspace"]').click();
    await tick();
    assert.deepEqual(intervals, [], 'neither does the Terminals & VS Code detail');
    win.document.querySelector('#top-bar-back').click();
    win.document.querySelector('[data-system-section="processes"]').click();
    await tick();
    assert.deepEqual(intervals.map(i => i.ms), [5000]);
    const count = () => f.calls.filter(call => call.url.includes('/system/processes')).length;
    const others = () => f.calls.filter(call => !call.url.includes('/system/processes')).length;
    const start = count(), otherStart = others();
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => true });
    intervals[0].fn();
    await tick(5);
    assert.equal(count(), start, 'hidden page does not poll');
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => false });
    intervals[0].fn();
    await tick(5);
    assert.equal(count(), start + 1);
    assert.equal(others(), otherStart, 'other sections are not polled');
    win.document.querySelector('#top-bar-back').click();
    assert.ok(cleared.includes(1), 'Back stops the timer');
    await tick();
    const afterBack = count();
    intervals[0].fn();
    await tick(5);
    assert.equal(count(), afterBack, 'a stale timer is inert after leaving Processes');
    win.CitadelSystem.dispose();
  } finally { f.close(); }
});

test('overlapping process polls do not stack requests', async () => {
  const f = fixture();
  const intervals = [];
  f.win.setInterval = fn => { intervals.push(fn); return intervals.length; };
  Object.defineProperty(f.win.document, 'hidden', { configurable: true, get: () => false });
  try {
    await f.win.CitadelSystem.render('processes');
    const count = () => f.calls.filter(call => call.url.includes('/system/processes')).length, start = count();
    let release;
    f.holds.set('/system/processes', new Promise(resolve => { release = resolve; }));
    intervals[0](); intervals[0](); intervals[0]();
    await tick(5);
    assert.equal(count(), start + 1);
    release();
  } finally { f.close(); }
});

test('results arriving after the machine changes or System is re-rendered are discarded', async () => {
  const f = fixture();
  let release;
  f.holds.set('/terminals', new Promise(resolve => { release = resolve; }));
  try {
    const first = f.win.CitadelSystem.render('workspace');
    await tick(5);
    f.state.activeHostId = 'peer-two';
    f.holds.clear();
    release();
    await first;
    assert.equal(f.win.document.querySelector('[data-stop-terminal]'), null, 'stale response did not paint');
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});

test('a slow Processes request left behind by Back does not stall the next visit', async () => {
  const f = fixture();
  let release;
  f.holds.set('/system/processes?limit=50', new Promise(resolve => { release = resolve; }));
  try {
    const doc = f.win.document;
    await f.win.CitadelSystem.render();
    doc.querySelector('[data-system-section="processes"]').click();
    await tick(5);
    doc.querySelector('#top-bar-back').click();
    f.holds.clear();
    doc.querySelector('[data-system-section="processes"]').click();
    await tick();
    assert.deepEqual(processRows(doc), ['Worker <safe>', 'Idle <big>', 'init']);
    release();
    await tick();
    assert.deepEqual(processRows(doc), ['Worker <safe>', 'Idle <big>', 'init']);
  } finally { f.close(); }
});

test('Refresh reloads the hub summaries or the open detail without mutating anything', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
    const doc = f.win.document;
    let before = f.calls.length;
    doc.querySelector('#system-refresh').click();
    await tick();
    assert.ok(f.calls.slice(before).length >= 3);
    doc.querySelector('[data-system-section="workspace"]').click();
    await tick();
    before = f.calls.length;
    doc.querySelector('#system-refresh').click();
    await tick();
    const added = f.calls.slice(before);
    assert.ok(added.some(call => call.url.endsWith('/terminals')));
    assert.equal(added.some(call => call.url.includes('/system/processes')), false);
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});
