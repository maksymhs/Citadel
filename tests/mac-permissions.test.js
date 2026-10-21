const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perms = require('../server/services/macPermissions');
const cli = require('../scripts/permissions');

const eperm = () => Object.assign(new Error('denied'), { code: 'EPERM' });
const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

describe('macOS Full Disk Access probe', () => {
  test('is unsupported and silent off macOS', () => {
    assert.deepEqual(perms.probeFullDiskAccess({ platform: 'linux' }), { supported: false, granted: null });
  });

  test('reports granted when a protected folder can be listed', () => {
    const fsImpl = { readdirSync: () => [] };
    assert.deepEqual(perms.probeFullDiskAccess({ platform: 'darwin', home: '/h', fsImpl }), { supported: true, granted: true });
  });

  test('reports not granted on EPERM or EACCES', () => {
    for (const code of ['EPERM', 'EACCES']) {
      const fsImpl = { readdirSync: () => { throw Object.assign(new Error(code), { code }); } };
      assert.equal(perms.probeFullDiskAccess({ platform: 'darwin', home: '/h', fsImpl }).granted, false);
    }
  });

  test('tries the next probe when one folder is missing, and is unknown when none exist', () => {
    let calls = 0;
    const second = { readdirSync: () => { calls += 1; if (calls === 1) throw enoent(); throw eperm(); } };
    assert.equal(perms.probeFullDiskAccess({ platform: 'darwin', home: '/h', fsImpl: second }).granted, false);
    const none = { readdirSync: () => { throw enoent(); } };
    assert.equal(perms.probeFullDiskAccess({ platform: 'darwin', home: '/h', fsImpl: none }).granted, null);
  });
});

describe('permissions status file and CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-perms-'));

  test('writes nothing off macOS and round-trips the status on macOS', () => {
    assert.equal(perms.writeStatus(dir, { supported: false, granted: null }), null);
    assert.equal(perms.readStatus(dir), null);
    const doc = perms.writeStatus(dir, { supported: true, granted: false });
    assert.equal(doc.fullDiskAccess, false);
    assert.equal(perms.readStatus(dir).fullDiskAccess, false);
    assert.ok(path.isAbsolute(perms.readStatus(dir).node));
  });

  test('report explains what to do when access is missing', () => {
    const lines = [];
    cli.report(dir, { log: (m) => lines.push(m) });
    const text = lines.join('\n');
    assert.match(text, /NOT granted/);
    assert.match(text, /citadel permissions open/);
    assert.match(text, /brew upgrade node/);
  });

  test('report is a single line once access is granted', () => {
    const granted = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-perms-'));
    perms.writeStatus(granted, { supported: true, granted: true });
    const lines = [];
    cli.report(granted, { log: (m) => lines.push(m) });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /granted/);
  });

  test('open reveals the binary and opens the Full Disk Access pane', () => {
    const calls = [];
    const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; };
    assert.equal(cli.open(dir, { run, log: () => {} }), 0);
    assert.equal(calls[0][0], 'open');
    assert.equal(calls[0][1], '-R');
    assert.deepEqual(calls[1], ['open', cli.PANE]);
    assert.match(cli.PANE, /Privacy_AllFiles$/);
  });

  test('open reports a failure to launch System Settings', () => {
    const lines = [];
    assert.equal(cli.open(dir, { run: () => ({ status: 1 }), log: (m) => lines.push(m) }), 1);
    assert.match(lines.join(' '), /by hand/);
  });
});
