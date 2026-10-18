const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

// The self-updater is exercised against a throwaway git world (a local bare
// "origin" plus a checkout) with every privileged/network command replaced by a
// fake in a temporary PATH. Nothing on the host is touched, no service is
// restarted, and no real database is read. `git` is intentionally real so the
// rollback (`git reset --hard <sha>`) is verified for real.
const SCRIPT = path.join(__dirname, '..', 'scripts', 'update.sh');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Citadel Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Citadel Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe', encoding: 'utf8' });
}

function writeFake(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

const FAKES = {
  sudo: 'echo "sudo $*" >> "$CITADEL_TEST_LOG"\nexec "$@"',
  curl:
    'echo "curl $*" >> "$CITADEL_TEST_LOG"\n' +
    'n=$(cat "$CITADEL_TEST_STATE/restarts" 2>/dev/null || echo 0)\n' +
    'need=$(cat "$CITADEL_TEST_STATE/health-after" 2>/dev/null || echo 1)\n' +
    '[ "$n" -ge "$need" ] && exit 0\nexit 1',
  sqlite3:
    'echo "sqlite3 $*" >> "$CITADEL_TEST_LOG"\n' +
    'if [ -f "$CITADEL_TEST_STATE/fail-snapshot" ]; then exit 1; fi\n' +
    'target=""\n' +
    'for a in "$@"; do case "$a" in *"VACUUM INTO "*) target="${a##*VACUUM INTO }";; esac; done\n' +
    'target="${target#\\\'}"\ntarget="${target%\\\'}"\n' +
    '[ -n "$target" ] && printf "SNAPSHOT-CONTENT" > "$target"\nexit 0',
  npm:
    'echo "npm $*" >> "$CITADEL_TEST_LOG"\n' +
    'if [ -f "$CITADEL_TEST_STATE/fail-npm" ]; then exit 1; fi\nexit 0',
  systemctl:
    'echo "systemctl $*" >> "$CITADEL_TEST_LOG"\n' +
    'S="$CITADEL_TEST_STATE"\n' +
    'case "$1" in\n' +
    '  is-active) [ -f "$S/stopped" ] && exit 3; exit 0 ;;\n' +
    '  stop) [ -f "$S/fail-stop" ] && exit 1; touch "$S/stopped"; exit 0 ;;\n' +
    '  restart)\n' +
    '    rm -f "$S/stopped"\n' +
    '    n=$(cat "$S/restarts" 2>/dev/null || echo 0); echo $((n + 1)) > "$S/restarts"\n' +
    '    exit 0 ;;\n' +
    '  *) exit 0 ;;\n' +
    'esac',
};

// Build an isolated git world whose "origin" is one commit ahead of the
// checkout, mimicking "an update is available".
function makeWorld({ withDb = false, healthAfter = 1 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-update-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  const repo = path.join(base, 'app');
  const dataDir = path.join(base, 'data');
  const state = path.join(base, 'state');
  const binFull = path.join(base, 'bin-full');
  const binNoSys = path.join(base, 'bin-nosys');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(binFull, { recursive: true });
  fs.mkdirSync(binNoSys, { recursive: true });

  for (const [name, body] of Object.entries(FAKES)) {
    writeFake(binFull, name, body);
    if (name !== 'systemctl') writeFake(binNoSys, name, body);
  }

  git(['init', '-q', '--bare', '--initial-branch=main', origin], base);
  fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(work, 'server'), { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), `${JSON.stringify({ name: 'citadel', version: '0.19.0' })}\n`);
  fs.writeFileSync(path.join(work, 'server', 'index.js'), '// citadel entrypoint\n');
  fs.writeFileSync(path.join(work, 'scripts', 'doctor.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(work, 'marker.txt'), 'V1\n');
  git(['init', '-q', '--initial-branch=main', work], base);
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'v1'], work);
  git(['remote', 'add', 'origin', `file://${origin}`], work);
  git(['push', '-q', '-u', 'origin', 'main'], work);

  git(['clone', '-q', `file://${origin}`, repo], base);

  fs.writeFileSync(path.join(work, 'marker.txt'), 'V2\n');
  git(['add', '-A'], work);
  git(['commit', '-q', '-m', 'v2'], work);
  git(['push', '-q', 'origin', 'main'], work);

  const dbPath = path.join(dataDir, 'citadel.db');
  if (withDb) fs.writeFileSync(dbPath, 'ORIGINAL-DB');
  fs.writeFileSync(path.join(state, 'health-after'), String(healthAfter));

  return { base, origin, work, repo, dataDir, state, binFull, binNoSys, dbPath, counter: 0 };
}

function run(world, { args = [], bin, env = {} } = {}) {
  const log = path.join(world.base, `calls-${++world.counter}.log`);
  const res = spawnSync('bash', [SCRIPT, ...args], {
    cwd: world.repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${bin || world.binFull}${path.delimiter}${process.env.PATH}`,
      CITADEL_DIR: world.repo,
      DATA_DIR: world.dataDir,
      CITADEL_REPO_BRANCH: 'main',
      CITADEL_SERVICE: 'citadel',
      CITADEL_UPDATE_HEALTH_RETRIES: '2',
      CITADEL_UPDATE_HEALTH_INTERVAL: '0',
      CITADEL_TEST_LOG: log,
      CITADEL_TEST_STATE: world.state,
      PORT: '3999',
      ...env,
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '', calls };
}

function marker(world) {
  return fs.readFileSync(path.join(world.repo, 'marker.txt'), 'utf8').trim();
}

function backups(world) {
  const dir = path.join(world.dataDir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
}

const worlds = [];
function world(opts) {
  const w = makeWorld(opts);
  worlds.push(w);
  return w;
}

after(() => {
  for (const w of worlds) fs.rmSync(w.base, { recursive: true, force: true });
});

describe('self-updater snapshot and rollback', () => {
  test('--check verifies the update is possible without mutating anything', () => {
    const w = world();
    const { code, stdout, calls } = run(w, { args: ['--check'] });
    assert.equal(code, 0);
    assert.match(stdout, /Check OK/);
    assert.equal(marker(w), 'V1', 'the checkout must not be touched by --check');
    assert.equal(calls.trim(), '', 'no privileged/network command may run for --check');
  });

  test('a failed snapshot aborts before the checkout changes', () => {
    const w = world({ withDb: true });
    fs.writeFileSync(path.join(w.state, 'fail-snapshot'), '1');
    const { code, stderr, calls } = run(w);
    assert.notEqual(code, 0);
    assert.match(stderr, /reliable SQLite snapshot/i);
    assert.equal(marker(w), 'V1', 'the checkout must survive a failed snapshot');
    assert.ok(!calls.includes('npm'), 'dependencies must not be installed');
    assert.ok(!calls.includes('systemctl'), 'the service must not be restarted');
    assert.equal(backups(w).length, 0);
  });

  test('a database that cannot be restored safely aborts before any change', (t) => {
    if (process.platform !== 'darwin' && fs.existsSync('/usr/bin/systemctl')) {
      t.skip('real systemd present; the no-systemd branch is not reachable');
      return;
    }
    const w = world({ withDb: true });
    const { code, stderr, calls } = run(w, { bin: w.binNoSys });
    assert.notEqual(code, 0);
    assert.match(stderr, /cannot safely update/i);
    assert.equal(marker(w), 'V1', 'the checkout must be unchanged');
    assert.ok(!calls.includes('npm'), 'dependencies must not be installed');
  });

  test('a dependency failure restores the previous commit', () => {
    const w = world();
    fs.writeFileSync(path.join(w.state, 'fail-npm'), '1');
    const { code, stderr, calls } = run(w);
    assert.notEqual(code, 0);
    assert.match(stderr, /Rolling back/);
    assert.equal(marker(w), 'V1', 'the previous commit must be restored');
    assert.ok(calls.includes('systemctl restart citadel'), 'the previous service must be restarted');
  });

  test('a health-check failure restores the exact database snapshot after stopping the service', () => {
    const w = world({ withDb: true, healthAfter: 2 });
    const { code, stderr, calls } = run(w);
    assert.notEqual(code, 0);
    assert.equal(marker(w), 'V1', 'the previous commit must be restored');
    assert.equal(fs.readFileSync(w.dbPath, 'utf8'), 'SNAPSHOT-CONTENT', 'the matching snapshot must be restored');

    const kept = backups(w);
    assert.equal(kept.length, 1, 'the snapshot must be preserved, not deleted');
    assert.equal(fs.readFileSync(path.join(w.dataDir, 'backups', kept[0]), 'utf8'), 'SNAPSHOT-CONTENT');

    const stopAt = calls.indexOf('systemctl stop citadel');
    assert.notEqual(stopAt, -1, 'the service must be stopped before restoring the database');
    assert.ok(
      stopAt < calls.lastIndexOf('systemctl restart citadel'),
      'the previous version must be restarted after the restore',
    );
    assert.match(stderr, /Rolled back to/);
  });

  test('if the service cannot be stopped the database is not overwritten and the snapshot is kept', () => {
    const w = world({ withDb: true, healthAfter: 2 });
    fs.writeFileSync(path.join(w.state, 'fail-stop'), '1');
    const { code, stderr, calls } = run(w);
    assert.notEqual(code, 0);
    assert.equal(fs.readFileSync(w.dbPath, 'utf8'), 'ORIGINAL-DB', 'the live database must be left untouched');
    assert.equal(backups(w).length, 1, 'the snapshot must be preserved');
    assert.ok(calls.includes('systemctl stop citadel'), 'stopping must be attempted');
    assert.match(stderr, /INCOMPLETE|NOT restored/i);
  });

  test('a successful update advances the checkout and reports the new commit', () => {
    const w = world();
    const { code, stdout } = run(w);
    assert.equal(code, 0);
    assert.match(stdout, /Update completed/);
    assert.equal(marker(w), 'V2', 'the checkout must advance to the latest commit');
  });
});
