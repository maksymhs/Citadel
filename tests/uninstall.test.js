const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The uninstaller is executed as a copy in a temporary directory so its
// "script source" is never the real checkout, and every effect goes through
// fake commands that only log: nothing on the host is touched.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-uninstall-'));
const fakeBin = path.join(base, 'fakebin');
const scriptDir = path.join(base, 'scripts');

function makeFake(name) {
  const file = path.join(fakeBin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> "$UNINSTALL_TEST_LOG"\nexit 0\n`);
  fs.chmodSync(file, 0o755);
}

before(() => {
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  for (const name of ['sudo', 'systemctl', 'rm', 'userdel']) makeFake(name);
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'uninstall.sh'), path.join(scriptDir, 'uninstall.sh'));
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const UNINSTALL = path.join(scriptDir, 'uninstall.sh');
let counter = 0;

function run(args = [], envOverrides = {}) {
  const log = path.join(base, `calls-${++counter}.log`);
  const res = spawnSync('bash', [UNINSTALL, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      UNINSTALL_TEST_LOG: log,
      ...envOverrides,
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '', calls };
}

function makeInstall(name = 'install') {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'app', 'server'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'package.json'), `${JSON.stringify({ name: 'citadel', version: '0.19.0' })}\n`);
  fs.writeFileSync(path.join(dir, 'app', 'server', 'index.js'), '// citadel entrypoint\n');
  return dir;
}

function makeGitRepo(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# independent checkout\n');
  return dir;
}

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = { mode: fs.statSync(full).mode & 0o777, data: fs.readFileSync(full, 'utf8') };
    }
  };
  walk(dir);
  return out;
}

describe('uninstaller path validation (before any effect)', () => {
  test('protected targets and the filesystem root are rejected with no side effects', () => {
    for (const target of ['/', '/etc', '/usr', '/var', '/opt', '/srv', '/root', '/home']) {
      const { code, stderr, calls } = run([], { CITADEL_TARGET_DIR: target });
      assert.notEqual(code, 0, `${target} must be rejected`);
      assert.equal(calls.trim(), '', `${target}: no tool may run`);
      assert.match(stderr, /ERROR|empty/i);
    }
  });

  test('a protected agents directory is rejected before any effect', () => {
    const install = makeInstall('agents-target');
    for (const agents of ['/etc', '/usr/local', '/']) {
      const { code, calls } = run(['--dry-run'], { CITADEL_TARGET_DIR: install, CITADEL_AGENTS_DIR: agents });
      assert.notEqual(code, 0, `CITADEL_AGENTS_DIR=${agents} must be rejected`);
      assert.equal(calls.trim(), '');
    }
  });

  test('a symlink resolving to a protected directory is rejected', () => {
    const link = path.join(base, 'link-to-etc');
    try { fs.symlinkSync('/etc', link); } catch { return; }
    const { code, calls } = run(['--dry-run'], { CITADEL_TARGET_DIR: link });
    assert.notEqual(code, 0);
    assert.equal(calls.trim(), '');
  });

  test('a target without Citadel evidence is rejected before any effect', () => {
    const empty = fs.mkdtempSync(path.join(base, 'not-citadel-'));
    const { code, calls, stderr } = run([], { CITADEL_TARGET_DIR: empty });
    assert.notEqual(code, 0);
    assert.equal(calls.trim(), '');
    assert.match(stderr, /no Citadel installation/i);
  });

  test('unknown arguments are rejected without effects', () => {
    const install = makeInstall('unknown-args');
    const bogus = run(['--bogus'], { CITADEL_TARGET_DIR: install });
    assert.equal(bogus.code, 2);
    assert.match(bogus.stderr, /unknown option/i);
    assert.equal(bogus.calls.trim(), '');

    const positional = run(['surprise'], { CITADEL_TARGET_DIR: install });
    assert.equal(positional.code, 2);
    assert.match(positional.stderr, /unexpected argument/i);
    assert.equal(positional.calls.trim(), '');
  });
});

describe('uninstaller dry-run', () => {
  test('accepts a Citadel-shaped install and leaves it byte-for-byte unchanged', () => {
    const install = makeInstall('dryrun-install');
    const before = snapshot(install);
    const { code, stdout, calls } = run(['--dry-run'], {
      CITADEL_TARGET_DIR: install,
      CITADEL_AGENTS_DIR: path.join(base, 'dryrun-agents'),
    });
    assert.equal(code, 0);
    assert.match(stdout, /DRY RUN/);
    assert.ok(stdout.includes(fs.realpathSync(install)), 'the canonical target path is shown');
    assert.equal(calls.trim(), '', 'dry-run must invoke no rm/systemctl/userdel/sudo');
    assert.deepEqual(snapshot(install), before, 'dry-run must not touch the installation');
  });

  test('--check-only is an alias for --dry-run', () => {
    const install = makeInstall('checkonly-install');
    const { code, stdout, calls } = run(['--check-only'], { CITADEL_TARGET_DIR: install });
    assert.equal(code, 0);
    assert.match(stdout, /DRY RUN/);
    assert.equal(calls.trim(), '');
  });

  test('dry-run reports requested source removal without deleting anything', () => {
    const install = makeInstall('dryrun-source');
    const source = makeGitRepo('dryrun-src-repo');
    fs.writeFileSync(path.join(install, 'data', 'source-dir'), `${source}\n`);
    const { code, stdout, calls } = run(['--dry-run', '--remove-source'], { CITADEL_TARGET_DIR: install });
    assert.equal(code, 0);
    assert.match(stdout, /interactive confirmation/i);
    assert.equal(calls.trim(), '');
    assert.ok(fs.existsSync(source), 'the source checkout must survive a dry run');
  });
});

describe('uninstaller source-checkout handling', () => {
  test('an independent source checkout is preserved without --remove-source', () => {
    const install = makeInstall('keep-source-install');
    const source = makeGitRepo('keep-source-repo');
    fs.writeFileSync(path.join(install, 'data', 'source-dir'), `${source}\n`);
    const { code, stdout, calls } = run([], { CITADEL_TARGET_DIR: install });
    assert.equal(code, 0);
    assert.match(stdout, /source checkout kept/i);
    assert.ok(fs.existsSync(source), 'the source checkout must be kept by default');
    assert.ok(!calls.includes(fs.realpathSync(source)), 'no command may target the kept source');
  });

  test('an untrusted data/source-dir is preserved even with --remove-source in a non-interactive shell', () => {
    const install = makeInstall('evil-source-install');
    const evil = makeGitRepo('evil-repo');
    // Point it at the repo via a path that canonicalises to `evil` but is not
    // the literal string, to prove canonicalisation is used.
    fs.writeFileSync(path.join(install, 'data', 'source-dir'), `${path.join(evil, '.')}\n`);
    const { code, stderr, calls } = run(['--remove-source'], { CITADEL_TARGET_DIR: install });
    assert.equal(code, 0);
    assert.match(stderr, /interactive confirmation requires a terminal/i);
    assert.ok(fs.existsSync(evil), 'the source checkout must not be deleted without a TTY');
    assert.ok(!calls.includes(`rm -rf ${fs.realpathSync(evil)}`), 'no rm may target the untrusted source');
  });

  test('--keep-source remains an accepted compatibility no-op', () => {
    const install = makeInstall('compat-install');
    const source = makeGitRepo('compat-repo');
    fs.writeFileSync(path.join(install, 'data', 'source-dir'), `${source}\n`);
    const { code, calls } = run(['--keep-source'], { CITADEL_TARGET_DIR: install });
    assert.equal(code, 0);
    assert.ok(fs.existsSync(source));
    assert.ok(!calls.includes(fs.realpathSync(source)));
  });
});
