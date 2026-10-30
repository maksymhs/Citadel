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
  const failing = new Set(), holds = new Map();
  const state = { activeHostId: 'peer-one', user: { id: 'owner', role }, hosts: [{ id: 'peer-one', name: 'First machine' }] };
  win.CitadelSystem.init({ state, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    openModal: value => { dialog = value; }, showToast: value => notices.push(value), forgetTerminal: (...args) => forgotten.push(args), installAgent() {},
    localApi: async (url, options = {}) => {
      calls.push({ url, ...options });
      for (const part of failing) if (!options.method && url.includes(part)) throw new Error(`${part} unavailable`);
      for (const [part, gate] of holds) if (!options.method && url.includes(part)) await gate;
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
      if (url.endsWith('/system/integrations')) return { integrations: { agents: [{ id: 'codex', name: 'Codex', available: false, detected: false }] } };
      if (url.endsWith('/system/tools')) return { tools: [{ id: 'git', name: 'git', group: 'Development', installed: true, version: '2.0' }] };
      throw new Error('Unexpected endpoint');
    },
  });
  return { win, state, calls, notices, forgotten, dialog: () => dialog, fail: () => { failure = true; }, failing, holds, close: () => dom.window.close() };
}

test('System process controls require confirmation, bind identity and distinguish signal delivery from exit', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
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
      await f.win.CitadelSystem.render();
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
    await f.win.CitadelSystem.render();
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
    await f.win.CitadelSystem.render();
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
    await f.win.CitadelSystem.render();
    assert.equal(f.win.document.querySelector('[data-process], [data-stop-terminal], #system-stop-editor'), null);
    assert.match(f.win.document.querySelector('#system-editor-body').textContent, /Administrator privileges/);
    assert.equal(f.calls.some(call => call.url.endsWith('/editor')), false);
  } finally { f.close(); }
});

test('leaving System invalidates a pending confirmation', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
    f.win.document.querySelector('[data-stop-terminal]').click();
    f.win.CitadelSystem.dispose();
    await assert.rejects(f.dialog().onConfirm, /Machine or user changed/);
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});

const SECTION_IDS = ['processes', 'terminals', 'editor', 'tools'];

test('System shows every section on one page with no tabs and opening performs no mutations', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
    const doc = f.win.document, pane = doc.querySelector('#system-management');
    assert.equal(pane.className, 'management-screen system-screen');
    assert.ok(doc.querySelector('#system-refresh'));
    assert.equal(doc.querySelector('[role="tablist"], [role="tab"], [data-system-tab], .mon-tabs'), null);
    const sections = [...doc.querySelectorAll('.system-sections > section.card.system-section')];
    assert.deepEqual(sections.map(s => s.dataset.systemSection), SECTION_IDS);
    assert.deepEqual(sections.map(s => s.classList.contains('system-section-wide')), [true, false, false, true]);
    for (const section of sections) {
      const heading = doc.getElementById(section.getAttribute('aria-labelledby'));
      assert.equal(heading.tagName, 'H2');
      assert.ok(section.contains(heading));
      assert.equal(section.hidden, false);
    }
    assert.deepEqual(sections.map(s => s.querySelector('h2').textContent), ['Processes', 'Terminals', 'VS Code', 'Tools']);
    assert.ok(doc.querySelector('[data-process]'));
    assert.ok(doc.querySelector('[data-stop-terminal]'));
    assert.ok(doc.querySelector('#system-stop-editor'));
    assert.match(doc.querySelector('#system-tools-body').textContent, /AI coding agents[\s\S]*Codex[\s\S]*Installed tools[\s\S]*git/);
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});

test('System sections fail independently and keep headings', async () => {
  for (const broken of SECTION_IDS) {
    const f = fixture();
    const part = { processes: '/system/processes', terminals: '/terminals', editor: '/editor', tools: '/system/integrations' }[broken];
    f.failing.add(part);
    try {
      await f.win.CitadelSystem.render();
      const doc = f.win.document;
      assert.equal(doc.querySelectorAll('[data-system-section] h2').length, 4);
      assert.match(doc.querySelector(`#system-${broken}-body`).textContent, /unavailable/);
      for (const id of SECTION_IDS.filter(id => id !== broken)) {
        assert.doesNotMatch(doc.querySelector(`#system-${id}-body`).textContent, /unavailable|Unexpected|Loading/, `${id} still renders when ${broken} fails`);
      }
    } finally { f.close(); }
  }
});

test('System loads sections concurrently and a slow section does not block the others', async () => {
  const f = fixture();
  let release;
  f.holds.set('/system/processes', new Promise(resolve => { release = resolve; }));
  try {
    const rendering = f.win.CitadelSystem.render();
    await new Promise(resolve => setTimeout(resolve, 20));
    const doc = f.win.document;
    assert.match(doc.querySelector('#system-processes-body').textContent, /Loading/);
    assert.ok(doc.querySelector('[data-stop-terminal]'));
    assert.ok(doc.querySelector('#system-stop-editor'));
    release();
    await rendering;
    assert.ok(doc.querySelector('[data-process]'));
  } finally { f.close(); }
});

test('successful stop refreshes contents in place and keeps the section wrappers', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
    const doc = f.win.document, wrapper = doc.querySelector('.system-sections'), terminals = doc.querySelector('[data-system-section="terminals"]');
    doc.querySelector('[data-stop-terminal]').click();
    const before = f.calls.length;
    await f.dialog().onConfirm();
    assert.deepEqual(f.forgotten, [['peer-one', 'terminal-one']]);
    assert.deepEqual(f.notices, ['Terminal stopped.']);
    assert.equal(doc.querySelector('.system-sections'), wrapper);
    assert.equal(doc.querySelector('[data-system-section="terminals"]'), terminals);
    const after = f.calls.slice(before).filter(call => !call.method).map(call => call.url);
    assert.ok(after.some(url => url.endsWith('/terminals')));
    assert.equal(after.some(url => url.includes('/system/processes')), false, 'only the affected section reloads');
  } finally { f.close(); }
});

test('leaving System invalidates a pending VS Code stop', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
    f.win.document.querySelector('#system-stop-editor').click();
    f.win.CitadelSystem.dispose();
    await assert.rejects(f.dialog().onConfirm, /Machine or user changed/);
  } finally { f.close(); }
});

test('only process polling runs on a timer, skips hidden pages and stops on disposal', async () => {
  const f = fixture();
  const intervals = [], cleared = [];
  const win = f.win;
  const realSet = win.setInterval, realClear = win.clearInterval;
  win.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  win.clearInterval = id => { cleared.push(id); };
  try {
    await win.CitadelSystem.render();
    assert.deepEqual(intervals.map(i => i.ms), [5000]);
    const count = () => f.calls.filter(call => call.url.includes('/system/processes')).length;
    const others = () => f.calls.filter(call => !call.url.includes('/system/processes')).length;
    const start = count(), otherStart = others();
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => true });
    intervals[0].fn();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(count(), start, 'hidden page does not poll');
    Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => false });
    intervals[0].fn();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(count(), start + 1);
    assert.equal(others(), otherStart, 'other sections are not polled');
    win.CitadelSystem.dispose();
    assert.ok(cleared.includes(1));
    intervals[0].fn();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(count(), start + 1, 'stale timer is inert after disposal');
  } finally { win.setInterval = realSet; win.clearInterval = realClear; f.close(); }
});

test('overlapping process polls do not stack requests', async () => {
  const f = fixture();
  const intervals = [];
  f.win.setInterval = fn => { intervals.push(fn); return intervals.length; };
  Object.defineProperty(f.win.document, 'hidden', { configurable: true, get: () => false });
  try {
    await f.win.CitadelSystem.render();
    const count = () => f.calls.filter(call => call.url.includes('/system/processes')).length, start = count();
    let release;
    f.holds.set('/system/processes', new Promise(resolve => { release = resolve; }));
    intervals[0](); intervals[0](); intervals[0]();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(count(), start + 1);
    release();
  } finally { f.close(); }
});

test('results arriving after the machine changes or System is re-rendered are discarded', async () => {
  const f = fixture();
  let release;
  f.holds.set('/terminals', new Promise(resolve => { release = resolve; }));
  try {
    const first = f.win.CitadelSystem.render();
    await new Promise(resolve => setTimeout(resolve, 5));
    f.state.activeHostId = 'peer-two';
    f.holds.clear();
    release();
    await first;
    assert.equal(f.win.document.querySelector('[data-stop-terminal]'), null, 'stale response did not paint');
    assert.equal(f.calls.filter(call => call.method).length, 0);
  } finally { f.close(); }
});

test('Refresh reloads all sections without mutating anything', async () => {
  const f = fixture();
  try {
    await f.win.CitadelSystem.render();
    const before = f.calls.length;
    f.win.document.querySelector('#system-refresh').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const added = f.calls.slice(before);
    assert.ok(added.length >= 4);
    assert.equal(added.filter(call => call.method).length, 0);
    assert.equal(f.win.document.querySelectorAll('[data-system-section]').length, 4);
  } finally { f.close(); }
});
