/** Viewport sizing follows touch keyboards without shrinking the app during desktop or pinch zoom. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('visual viewport ignores mouse zoom and restores touch keyboard sizing after pinch zoom', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const start = source.indexOf('  function setupVisualViewport() {');
  const end = source.indexOf('\n  window.addEventListener(\'resize\', refitActiveTerminals);', start);
  assert.ok(start > 0 && end > start);
  const dom = new JSDOM('', { runScripts: 'dangerously' });
  const win = dom.window;
  try {
    let touch = false;
    win.matchMedia = () => ({ matches: touch });
    win.visualViewport = new win.EventTarget();
    Object.assign(win.visualViewport, { height: 500, offsetTop: 100, scale: 1 });
    win.eval(`const refitActiveTerminals = () => {}; ${source.slice(start, end)}; setupVisualViewport();`);
    const style = win.document.documentElement.style;
    const resize = () => win.visualViewport.dispatchEvent(new win.Event('resize'));
    assert.equal(style.getPropertyValue('--app-height'), '');
    win.visualViewport.scale = 1.5;
    resize();
    assert.equal(style.getPropertyValue('--app-height'), '');
    assert.equal(style.getPropertyValue('--app-top'), '');
    touch = true;
    win.visualViewport.scale = 1;
    resize();
    assert.equal(style.getPropertyValue('--app-height'), '500px');
    assert.equal(style.getPropertyValue('--app-top'), '100px');
    win.visualViewport.scale = 2;
    resize();
    assert.equal(style.getPropertyValue('--app-height'), '');
    assert.equal(style.getPropertyValue('--app-top'), '');
    win.visualViewport.scale = 1;
    resize();
    assert.equal(style.getPropertyValue('--app-height'), '500px');
    touch = false;
    resize();
    assert.equal(style.getPropertyValue('--app-height'), '');
  } finally { win.close(); }
});
