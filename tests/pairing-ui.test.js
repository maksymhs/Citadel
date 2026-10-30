/** On-demand pairing QR coverage with fake invitations; no real peers or codes are created. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(role = 'admin') {
  const dom = new JSDOM('<div id="modal-root"></div>', { runScripts: 'dangerously' });
  const win = dom.window;
  win.eval(fs.readFileSync(path.join(__dirname, '../public/js/pairing.js'), 'utf8'));
  const calls = [], notices = [], copied = [];
  const state = { activeHostId: 'local', user: { id: 'owner', role } };
  let respond = async () => ({ invite: { qrSvg: '<svg aria-label="Fixture QR"></svg>', link: `https://panel.example/#pair=fixture-${calls.length}`, expiresAt: Date.now() + 600000, reachableWarning: 'Example warning' } });
  const openModal = dialog => {
    const root = win.document.getElementById('modal-root');
    root.innerHTML = `<div role="dialog"><h3></h3>${dialog.bodyHtml}<button id="close">Close</button></div>`;
    root.querySelector('h3').textContent = dialog.title;
    root.querySelector('#close').onclick = () => { root.innerHTML = ''; dialog.onClose?.(); };
  };
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async value => { copied.push(value); } } });
  win.CitadelPairing.init({ state, openModal, escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    api: async (url, options) => { calls.push({ url, ...options }); return respond(); },
    loadHosts() {}, refreshHostStatus() {}, renderSidebarNav() {}, showToast: value => notices.push(value), switchHost() {},
  });
  return { win, state, calls, notices, copied, open: () => win.CitadelPairing.showInviteModal(), replace: () => openModal({ title: 'Replacement', bodyHtml: '<p>Keep this dialog</p>' }),
    respond: handler => { respond = handler; }, close: () => dom.window.close() };
}

test('pairing QR is admin-only and generated only after explicit opening', async () => {
  const f = fixture();
  try {
    assert.equal(f.calls.length, 0);
    f.open(); await settle();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { url: '/api/pair/invite', method: 'POST' });
    assert.ok(f.win.document.querySelector('.connect-qr svg'));
    assert.match(f.win.document.body.textContent, /Works once · expires/);
    assert.match(f.win.document.body.textContent, /Example warning/);
    assert.match(f.win.document.body.textContent, /merges both credential vaults over HTTPS/);
    const link = f.win.document.getElementById('pair-invite-link');
    assert.equal(link.readOnly, true);
    f.win.document.getElementById('pair-invite-copy').click(); await settle();
    assert.deepEqual(f.copied, [link.value]);
    f.win.document.getElementById('pair-invite-new').click(); await settle();
    assert.equal(f.calls.length, 2);
    assert.match(f.win.document.getElementById('pair-invite-link').value, /fixture-2$/);
    f.state.user.role = 'user';
    f.win.document.getElementById('pair-invite-new').click(); await settle();
    assert.equal(f.calls.length, 2, 'revoked UI role cannot mint another code');
  } finally { f.close(); }
  const reader = fixture('user');
  try { reader.open(); await settle(); assert.equal(reader.calls.length, 0); assert.equal(reader.win.document.querySelector('[role="dialog"]'), null); }
  finally { reader.close(); }
});

test('failed pairing QR never falls back to a non-pairing address and supports explicit retry', async () => {
  const f = fixture();
  try {
    f.respond(async () => { throw new Error('Unavailable <safe>'); });
    f.open(); await settle();
    assert.match(f.win.document.body.textContent, /Could not create a pairing code: Unavailable <safe>/);
    assert.equal(f.win.document.querySelector('safe, .connect-qr'), null);
    f.respond(async () => ({ invite: { qrSvg: '<svg></svg>', link: 'https://panel.example/#pair=retry', expiresAt: Date.now() + 600000 } }));
    f.win.document.getElementById('pair-invite-retry').click(); await settle();
    assert.equal(f.calls.length, 2);
    assert.ok(f.win.document.querySelector('.connect-qr svg'));
  } finally { f.close(); }
});

test('incomplete invitation data is not shown as a usable pairing code', async () => {
  const f = fixture();
  try {
    f.respond(async () => ({ invite: { qrSvg: '<svg></svg>' } }));
    f.open(); await settle();
    assert.equal(f.win.document.querySelector('.connect-qr'), null);
    assert.ok(f.win.document.getElementById('pair-invite-retry'));
  } finally { f.close(); }
});

test('late invitation cannot overwrite a replacement or closed dialog', async () => {
  for (const close of [false, true]) {
    const f = fixture();
    try {
      let finish;
      f.respond(() => new Promise(resolve => { finish = resolve; }));
      f.open();
      if (close) f.win.document.getElementById('close').click();
      else f.replace();
      finish({ invite: { qrSvg: '<svg></svg>', link: 'https://panel.example/#pair=late', expiresAt: Date.now() + 600000 } });
      await settle();
      assert.equal(f.win.document.querySelector('.connect-qr'), null);
      if (close) assert.equal(f.win.document.querySelector('[role="dialog"]'), null);
      else assert.match(f.win.document.body.textContent, /Replacement.*Keep this dialog/);
    } finally { f.close(); }
  }
});

test('invitation responses are discarded after a machine, account or role change', async () => {
  for (const change of [f => { f.state.activeHostId = 'peer'; }, f => { f.state.user.id = 'another-owner'; }, f => { f.state.user.role = 'user'; }]) {
    const f = fixture();
    try {
      let finish;
      f.respond(() => new Promise(resolve => { finish = resolve; }));
      f.open(); change(f);
      finish({ invite: { qrSvg: '<svg></svg>', link: 'https://panel.example/#pair=stale', expiresAt: Date.now() + 600000 } });
      await settle();
      assert.equal(f.win.document.querySelector('.connect-qr, #pair-invite-link'), null);
      assert.equal(f.notices.length, 0);
    } finally { f.close(); }
  }
});
