#!/usr/bin/env node
/**
 * `citadel permissions [open]` (macOS): one-time Full Disk Access setup.
 *
 * With Full Disk Access on the Citadel binaries, macOS stops asking for each
 * folder (Desktop, Documents, Downloads, iCloud Drive, external disks...). The
 * grant can only be made by the user in System Settings; this command opens the
 * right pane, reveals the binary to add and reports what the service itself sees.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { binariesToAllow, readStatus } = require('../server/services/macPermissions');

const PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  return s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function report(dataDir, { log = console.log, now = Date.now() } = {}) {
  const st = readStatus(dataDir);
  const bins = binariesToAllow();
  if (!st) {
    log('Full Disk Access: unknown (the Citadel service has not reported yet; is it running? try: citadel status)');
  } else if (st.fullDiskAccess === true) {
    log(`Full Disk Access: granted (checked by the service ${ago(st.checkedAt, now)}).`);
  } else if (st.fullDiskAccess === false) {
    log(`Full Disk Access: NOT granted (checked by the service ${ago(st.checkedAt, now)}).`);
  } else {
    log('Full Disk Access: could not be determined on this Mac.');
  }
  // The service's own node is the one that matters; fall back to this shell's.
  const nodePath = (st && st.node) || (bins.find((b) => b.label === 'node') || {}).path;
  const list = bins.map((b) => (b.label === 'node' && nodePath ? { ...b, path: nodePath } : b));
  if (!st || st.fullDiskAccess !== true) {
    log('');
    log('Allow it once, so macOS stops asking per folder:');
    log('  1. Run:  citadel permissions open   (opens Privacy & Security > Full Disk Access and shows the file)');
    log('  2. Drag the file into the list (or click + and press Cmd+Shift+G to type the path), then switch it on.');
    log('  Files to allow:');
    for (const b of list) log(`     ${b.label.padEnd(5)} ${b.path}`);
    log('  Then run `citadel permissions` again: the service re-checks every minute.');
    log('  After `brew upgrade node` the path changes: repeat this and remove the old entry.');
  }
}

function open(dataDir, { run = spawnSync, log = console.log } = {}) {
  const st = readStatus(dataDir);
  const nodePath = (st && st.node) || (binariesToAllow().find((b) => b.label === 'node') || {}).path;
  if (nodePath) run('open', ['-R', nodePath], { stdio: 'ignore' });
  const res = run('open', [PANE], { stdio: 'ignore' });
  if (res.error || res.status !== 0) {
    log('Could not open System Settings. Open it by hand: Privacy & Security > Full Disk Access.');
    return 1;
  }
  log('Opened Full Disk Access. Add the file shown in Finder, switch it on, then run: citadel permissions');
  return 0;
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (process.platform !== 'darwin') {
    console.error('Full Disk Access is a macOS permission; nothing to do on this system.');
    return 1;
  }
  const dataDir = env.DATA_DIR || env.CITADEL_DATA_DIR || path.join(__dirname, '..', 'data');
  const sub = argv[0] || 'status';
  if (sub === 'open') return open(dataDir);
  if (sub === 'status') { report(dataDir); return 0; }
  console.error('Usage: citadel permissions [status|open]');
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = { report, open, ago, PANE };
