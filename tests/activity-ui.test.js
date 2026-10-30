/** Activity requests must not overwrite another view, tab, machine or account. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('an older service-log request cannot replace a newer refresh of the same tab', async () => {
  const dom = new JSDOM('<div id="main-content"></div><div id="top-bar-actions"></div>', { runScripts: 'dangerously' });
  const win = dom.window, pending = [];
  try {
    const state = { currentView: 'activity', activityTab: 'service', activeHostId: 'local', user: { id: 'one', role: 'admin' } };
    win.eval(fs.readFileSync(path.join(__dirname, '../public/js/activity.js'), 'utf8'));
    win.CitadelActivity.init({ state, api: () => new Promise(resolve => pending.push(resolve)), escapeHtml: String, hostApiPath: String, moduleEnabled: () => false, navigateTo() {}, saveUiState() {} });
    const older = win.CitadelActivity.renderActivityView();
    const newer = win.CitadelActivity.renderActivityView();
    pending[1]({ source: 'file', text: 'New log' });
    await newer;
    pending[0]({ source: 'file', text: 'Old log' });
    await older;
    assert.equal(state.serviceLogLines.join('\n'), 'New log');
    assert.equal(win.document.getElementById('service-log-text').textContent, 'New log');
  } finally { win.close(); }
});

test('late activity, audit and service responses cannot replace a newer destination', async () => {
  for (const tab of ['activity', 'audit', 'service']) {
    for (const change of ['view', 'tab', 'host', 'user']) {
      for (const fails of [false, true]) {
        const dom = new JSDOM('<div id="main-content"></div><div id="top-bar-actions"></div>', { runScripts: 'dangerously' });
        const win = dom.window;
        try {
          let resolve, reject;
          const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
          const state = { currentView: 'activity', activityTab: tab, activeHostId: 'local', user: { id: 'one', role: 'admin' }, logsFilter: { range: '24h' } };
          win.eval(fs.readFileSync(path.join(__dirname, '../public/js/activity.js'), 'utf8'));
          win.CitadelActivity.init({ state, api: () => pending, escapeHtml: String, hostApiPath: String, moduleEnabled: () => false, navigateTo() {}, saveUiState() {} });
          const rendering = win.CitadelActivity.renderActivityView();
          if (change === 'view') state.currentView = 'system';
          if (change === 'tab') state.activityTab = tab === 'audit' ? 'service' : 'audit';
          if (change === 'host') state.activeHostId = 'peer';
          if (change === 'user') state.user.id = 'two';
          win.document.getElementById('main-content').textContent = 'New destination';
          if (fails) reject(new Error('Old failure'));
          else resolve({ events: [], logs: [], summary: {}, text: 'Old service log' });
          await rendering;
          assert.equal(win.document.getElementById('main-content').textContent, 'New destination', `${tab}/${change}/${fails}`);
          assert.equal(state.logsEvents, undefined);
          assert.equal(state.auditLogs, undefined);
          assert.equal(state.serviceLogLines, undefined);
        } finally { win.close(); }
      }
    }
  }
});
