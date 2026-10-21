const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Windows is supported through WSL2, where install.sh runs as on any Linux. The
// host is faked with CITADEL_WSL_PROC_VERSION / CITADEL_SYSTEMD_RUN_DIR, and
// anything that could change the machine (sudo, git, curl, npm) is a stub that
// only logs, so these tests can never install anything.
const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'install.sh');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-wsl-'));
const fakeBin = path.join(base, 'bin');
const calls = path.join(base, 'calls.log');
const wslVersion = path.join(base, 'proc-wsl');
const linuxVersion = path.join(base, 'proc-linux');

before(() => {
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const name of ['sudo', 'git', 'curl', 'npm', 'systemctl']) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\nexit 1\n`, { mode: 0o755 });
  }
  fs.writeFileSync(wslVersion, 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@build)\n');
  fs.writeFileSync(linuxVersion, 'Linux version 6.8.0-generic (buildd@lcy02)\n');
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

function run(args, { procVersion, systemd }) {
  fs.writeFileSync(calls, '');
  const res = spawnSync('bash', [INSTALL, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      HOME: base,
      CITADEL_VERBOSE: '1',
      CITADEL_WSL_PROC_VERSION: procVersion,
      CITADEL_SYSTEMD_RUN_DIR: systemd,
    },
  });
  const out = `${res.stdout}${res.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  return { code: res.status, out, calls: fs.readFileSync(calls, 'utf8') };
}

describe('install.sh inside WSL', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
  test('stops before changing anything when systemd is off, and says how to enable it', () => {
    const res = run([], { procVersion: wslVersion, systemd: path.join(base, 'no-systemd') });
    assert.equal(res.code, 1);
    assert.match(res.out, /needs systemd, which WSL does not start by default/);
    assert.match(res.out, /printf '\[boot\]\\nsystemd=true\\n' \| sudo tee \/etc\/wsl\.conf/);
    assert.match(res.out, /wsl --shutdown/);
    assert.equal(res.calls, '', 'no sudo/git/curl/npm was attempted');
  });

  test('check mode only warns about missing systemd', () => {
    const res = run(['--check-only'], { procVersion: wslVersion, systemd: path.join(base, 'no-systemd') });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /systemd is not running in this WSL distro/);
  });

  test('is local-only and skips laptop 24/7 tweaks by default', () => {
    const res = run(['--check-only'], { procVersion: wslVersion, systemd: base });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /Running inside WSL/);
    const options = /Options:(.*?)\s+\(details/.exec(res.out)[1];
    assert.doesNotMatch(options, /tunnel/);
    assert.doesNotMatch(options, /24\/7/);
  });

  test('--tunnel still opts in to the public tunnel', () => {
    const res = run(['--check-only', '--tunnel'], { procVersion: wslVersion, systemd: base });
    assert.match(/Options:(.*?)\s+\(details/.exec(res.out)[1], /tunnel/);
  });

  test('a regular Linux host keeps its defaults', () => {
    const res = run(['--check-only'], { procVersion: linuxVersion, systemd: base });
    assert.equal(res.code, 0, res.out);
    assert.doesNotMatch(res.out, /Running inside WSL/);
    const options = /Options:(.*?)\s+\(details/.exec(res.out)[1];
    assert.match(options, /tunnel/);
    assert.match(options, /24\/7/);
  });
});
