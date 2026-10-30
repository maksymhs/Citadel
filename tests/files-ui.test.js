/** File Explorer starts in the host's projects directory without overriding navigation. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('Files starts in configured projects, renders breadcrumbs and preserves a chosen path', async () => {
  const dom = new JSDOM('<div id="main-content"></div><div id="top-bar-actions"></div>', { runScripts: 'dangerously' });
  const win = dom.window;
  const calls = [];
  const state = { currentView: 'files', activeHostId: 'local', filesMode: 'grid', filesPath: null };
  try {
    win.matchMedia = () => ({ matches: false });
    win.eval(fs.readFileSync(path.join(__dirname, '../public/js/files.js'), 'utf8'));
    win.CitadelFiles.init({
      state, escapeHtml: value => String(value), formatBytes: String,
      hostApiPath: value => value, openContextMenu() {}, openModal() {}, showToast() {},
      api: async url => {
        calls.push(url);
        return url.endsWith('/capabilities') ? { defaultPath: '/srv/citadel/projects' } : { listing: { items: [] } };
      },
    });
    await win.CitadelFiles.renderFilesView();
    assert.equal(state.filesPath, '/srv/citadel/projects');
    assert.deepEqual([...win.document.querySelectorAll('.files-crumb')].map(button => button.textContent), ['/', 'srv', 'citadel', 'projects']);
    assert.ok(calls.includes('/api/files?path=%2Fsrv%2Fcitadel%2Fprojects'));
    state.filesPath = '/';
    await win.CitadelFiles.renderFilesView();
    assert.equal(state.filesPath, '/');
    assert.equal(calls.filter(url => url.endsWith('/capabilities')).length, 1);
    assert.equal(calls.at(-1), '/api/files?path=%2F');
  } finally { win.close(); }
});
