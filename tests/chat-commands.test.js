const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../public/js/chat.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(t, status = 'idle') {
  const dom = new JSDOM('<main id="main-content"></main>', { url: 'http://localhost', runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [];
  const history = [{ id: 'ses_old', title: 'Prior messages' }];
  let busy = status === 'busy', deferred;
  window.EventSource = class { addEventListener() {} close() {} };
  window.eval(source);
  window.CitadelChat.init({ state: { user: { id: 'owner' }, activeHostId: 'local' }, openSettingsAt() {}, showToast() {}, api: async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/chat/status') return { ready: true };
    if (url.endsWith('/sessions') && !options) return { sessions: history };
    if (url.endsWith('/sessions') && options?.method === 'POST') {
      if (busy) throw new Error('Chat engine is busy. Finish or cancel the active session first.');
      if (deferred) await deferred;
      const session = { id: `ses_new${history.length}`, title: 'New session' }; history.push(session); return { session };
    }
    return { status: busy ? 'busy' : 'idle', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Prior message' }] }, { role: 'assistant', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } }, model: 'citadel/build-alias', parts: [{ type: 'tool', text: '<img src=x>', state: { status: 'completed' } }] }], models: { build: { model: 'citadel/build-alias', limitTokens: 64000 }, plan: { model: 'citadel/plan-alias', limitTokens: null } } };
  } });
  await window.CitadelChat.open({ id: 'p1', name: 'Project' }); await tick();
  t.after(() => { window.CitadelChat.reset(); window.close(); });
  const input = window.document.querySelector('.chat-input');
  const type = text => { input.value = text; input.dispatchEvent(new window.Event('input')); };
  const key = (name, options = {}) => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }));
  const submit = async text => { type(text); input.closest('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(); };
  return { window, input, calls, history, type, key, submit, document: window.document, setBusy: value => { busy = value; }, defer: promise => { deferred = promise; } };
}

test('slash menu is keyboard accessible and ignores IME; Ctrl+Enter retains send behavior', async t => {
  const h = await setup(t);
  h.type('/');
  const list = h.document.querySelector('[role="listbox"]');
  assert.equal(list.children.length, 5);
  assert.equal(h.input.getAttribute('aria-expanded'), 'true');
  h.key('ArrowUp');
  assert.equal(list.lastChild.getAttribute('aria-selected'), 'true');
  h.key('Enter', { isComposing: true });
  assert.equal(h.input.value, '/');
  h.key('Enter'); await tick();
  assert.match(h.document.querySelector('.chat-command-info').textContent, /Chat commands/);
  assert.equal(h.input.value, '');
  assert.equal(h.input.getAttribute('aria-expanded'), 'false');
  h.type('/'); h.key('ArrowDown');
  assert.equal(list.children[1].getAttribute('aria-selected'), 'true');
  h.key('Escape');
  assert.equal(list.hidden, true);
  assert.equal(h.input.hasAttribute('aria-activedescendant'), false);
  h.type('text /help'); assert.equal(list.hidden, true);
  h.key('Enter', { ctrlKey: true }); await tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/messages')).length, 1);
});

test('informational commands are local, safe, dismissible and report precise snapshot metrics', async t => {
  const h = await setup(t);
  const count = h.calls.length;
  await h.submit('/context');
  let panel = h.document.querySelector('.chat-command-info');
  assert.match(panel.textContent, /Latest request input context: 160 tokens/);
  assert.match(panel.textContent, /Output and reasoning.*may overlap/);
  assert.match(panel.textContent, /64,000/);
  assert.doesNotMatch(panel.textContent, /\d+%/);
  await h.submit('/model');
  assert.match(panel.textContent, /citadel\/plan-alias/);
  assert.match(panel.textContent, /native provider selection is disabled/);
  [...panel.querySelectorAll('button')].find(button => button.textContent === 'Switch to Plan').click();
  assert.equal(h.document.querySelector('.chat-role').value, 'plan');
  await h.submit('/context'); assert.match(panel.textContent, /context window: unknown/);
  await h.submit('/help');
  assert.match(panel.textContent, /not raw inputs/);
  assert.equal(h.calls.length, count);
  assert.equal(h.document.querySelector('.chat-tools img'), null);
  h.type('draft to preserve');
  [...h.document.querySelectorAll('button')].find(button => button.textContent === 'Command help').click();
  assert.equal(h.input.value, 'draft to preserve');
  [...panel.querySelectorAll('button')].find(button => button.textContent === 'Dismiss').click();
  assert.equal(panel.hidden, true);
  assert.equal(h.document.activeElement, h.input);
});

test('unknown and argument commands never reach model; reset requires explicit non-destructive confirmation', async t => {
  const h = await setup(t);
  await h.submit('/unknown'); assert.equal(h.input.value, '/unknown');
  assert.match(h.document.querySelector('.chat-command-info').textContent, /Use \/help/);
  await h.submit('/new extra'); assert.equal(h.history.length, 1);
  await h.submit('/reset'); assert.equal(h.history.length, 1);
  const panel = h.document.querySelector('.chat-command-info');
  assert.match(panel.textContent, /does not delete history or cancel/);
  [...panel.querySelectorAll('button')].find(button => button.textContent === 'Keep current session').click();
  assert.equal(h.history.length, 1);
  await h.submit('/reset');
  [...panel.querySelectorAll('button')].find(button => button.textContent === 'Confirm new session').click(); await tick();
  assert.equal(h.history.length, 2);
  assert.equal(h.document.querySelector('.chat-sessions').options[0].value, 'ses_old');
  assert.equal(h.calls.some(call => /messages|cancel/.test(call.url) || call.options?.method === 'DELETE'), false);
});

test('busy new session keeps draft and history, reports server conflict, never cancels work', async t => {
  const h = await setup(t, 'busy');
  await h.submit('/new');
  assert.match(h.document.querySelector('.chat-notices').textContent, /busy/);
  assert.equal(h.input.value, '/new');
  assert.equal(h.history.length, 1);
  assert.equal(h.calls.some(call => call.url.endsWith('/cancel') || call.url.endsWith('/messages')), false);
  await h.submit('/model');
  assert.equal([...h.document.querySelectorAll('.chat-command-info button')].find(button => button.textContent.startsWith('Switch to')).disabled, true);
});

test('asynchronous new session preserves edits and ignores closed view responses', async t => {
  const h = await setup(t);
  let resolve;
  h.defer(new Promise(done => { resolve = done; }));
  h.type('/new'); h.key('Enter');
  h.type('edited while creating'); resolve(); await tick();
  assert.equal(h.input.value, 'edited while creating');
  let finish;
  h.defer(new Promise(done => { finish = done; }));
  h.type('/new'); h.key('Enter');
  h.window.CitadelChat.close(); finish(); await tick();
  assert.equal(h.document.querySelector('.chat-panel'), null);
});
