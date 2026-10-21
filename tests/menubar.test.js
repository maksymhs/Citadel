const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The macOS scripts run on Linux against fake commands that only log, so the
// flow (build, LaunchAgent, start/stop) is checked without touching the host.
const ROOT = path.join(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-menubar-'));
const fakeBin = path.join(base, 'fakebin');
const home = path.join(base, 'home');
const target = path.join(base, 'Citadel');
const LOG = path.join(base, 'calls.log');

function fake(name, body) {
  const file = path.join(fakeBin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

before(() => {
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(target, 'app', 'scripts', 'macos'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'macos', 'CitadelMenu.swift'), path.join(target, 'app', 'scripts', 'macos', 'CitadelMenu.swift'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'menubar-macos.sh'), path.join(target, 'app', 'scripts', 'menubar-macos.sh'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'citadel'), path.join(target, 'app', 'scripts', 'citadel'));
  fake('uname', 'echo Darwin');
  fake('shasum', 'shift 2; sha256sum "$@"');
  fake('codesign', 'echo "codesign $*" >> "$TEST_LOG"');
  // `swiftc -O -o <bin> <src> ...` leaves an executable at <bin>.
  fake('swiftc', 'echo "swiftc $*" >> "$TEST_LOG"; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { : > "$2"; chmod +x "$2"; }; shift; done');
  // `launchctl print` fails unless a test flips LOADED=1, like an unloaded agent.
  fake('launchctl', 'echo "launchctl $*" >> "$TEST_LOG"; [ "$1" = "print" ] && [ "${LOADED:-0}" != "1" ] && exit 1; exit 0');
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

function run(script, args, env = {}, withSwift = true) {
  fs.writeFileSync(LOG, '');
  const bin = withSwift ? fakeBin : path.join(base, 'noswift');
  if (!withSwift) {
    fs.mkdirSync(bin, { recursive: true });
    for (const f of fs.readdirSync(fakeBin)) if (f !== 'swiftc') fs.copyFileSync(path.join(fakeBin, f), path.join(bin, f)), fs.chmodSync(path.join(bin, f), 0o755);
  }
  const res = spawnSync('bash', [path.join(target, 'app', 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, CITADEL_TARGET_DIR: target, CITADEL_APP_DIR: path.join(target, 'app'), TEST_LOG: LOG, ...env },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}`, calls: fs.readFileSync(LOG, 'utf8') };
}

const agentPlist = () => path.join(home, 'Library', 'LaunchAgents', 'com.citadel.menubar.plist');
const bundle = () => path.join(target, 'CitadelMenu.app');

describe('macOS menu bar icon', () => {
  test('without swiftc it asks for the Command Line Tools and changes nothing', () => {
    const res = run('menubar-macos.sh', ['install'], {}, false);
    assert.equal(res.code, 3);
    assert.match(res.out, /xcode-select --install/);
    assert.ok(!fs.existsSync(agentPlist()));
    assert.ok(!fs.existsSync(bundle()));
  });

  test('install builds the app, registers the LaunchAgent and starts it', () => {
    const res = run('menubar-macos.sh', ['install'], { PORT: '3123' });
    assert.equal(res.code, 0, res.out);
    assert.match(res.calls, /swiftc -O -o .*CitadelMenu\.app\/Contents\/MacOS\/CitadelMenu .*CitadelMenu\.swift -framework Cocoa/);
    const info = fs.readFileSync(path.join(bundle(), 'Contents', 'Info.plist'), 'utf8');
    assert.match(info, /<key>LSUIElement<\/key><true\/>/, 'no Dock icon');
    const agent = fs.readFileSync(agentPlist(), 'utf8');
    assert.match(agent, /<key>Label<\/key><string>com\.citadel\.menubar<\/string>/);
    assert.match(agent, /<key>CITADEL_PORT<\/key><string>3123<\/string>/);
    assert.match(agent, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(agent, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
    assert.match(res.calls, /launchctl bootstrap gui\/\d+ .*com\.citadel\.menubar\.plist/);
    assert.match(res.calls, /launchctl kickstart -k gui\/\d+\/com\.citadel\.menubar/);
  });

  test('a second install does not rebuild an unchanged app', () => {
    const res = run('menubar-macos.sh', ['install']);
    assert.equal(res.code, 0, res.out);
    assert.doesNotMatch(res.calls, /swiftc/);
  });

  test('remove unregisters the agent and deletes the app', () => {
    const res = run('menubar-macos.sh', ['remove']);
    assert.equal(res.code, 0, res.out);
    assert.match(res.calls, /launchctl bootout .*com\.citadel\.menubar/);
    assert.ok(!fs.existsSync(agentPlist()));
    assert.ok(!fs.existsSync(bundle()));
  });

  test('citadel stop unloads the service and start loads it again', () => {
    let res = run('citadel', ['stop'], { CITADEL_DATA_DIR: path.join(target, 'data') });
    assert.equal(res.code, 0, res.out);
    assert.match(res.calls, /launchctl bootout gui\/\d+\/com\.citadel\.server/);

    res = run('citadel', ['start'], { CITADEL_DATA_DIR: path.join(target, 'data') });
    assert.equal(res.code, 0, res.out);
    assert.match(res.calls, /launchctl bootstrap gui\/\d+ .*com\.citadel\.server\.plist/, 'reloads an unloaded agent');
    assert.match(res.calls, /launchctl kickstart gui\/\d+\/com\.citadel\.server/);
  });

  test('citadel restart reloads a stopped service first', () => {
    const res = run('citadel', ['restart'], { CITADEL_DATA_DIR: path.join(target, 'data') });
    assert.equal(res.code, 0, res.out);
    assert.match(res.calls, /launchctl bootstrap/);
    assert.match(res.calls, /launchctl kickstart -k/);
  });

  test('the Swift source has the menu the icon promises', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'macos', 'CitadelMenu.swift'), 'utf8');
    for (const label of ['Open Dashboard', 'Stop Citadel', 'Start Citadel', 'Restart Citadel', 'Quit Menu Icon']) {
      assert.ok(src.includes(label), label);
    }
    assert.match(src, /api\/auth\/status/);
  });
});

describe('macOS installer defaults', () => {
  test('the public tunnel is opt-in and --help says so', () => {
    const script = path.join(ROOT, 'scripts', 'install-macos.sh');
    const src = fs.readFileSync(script, 'utf8');
    assert.match(src, /^TUNNEL=false$/m, 'local-only unless asked');
    assert.match(src, /--tunnel\) TUNNEL=true/);
    const res = spawnSync('bash', [script, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /--tunnel .*off by default on macOS/);
    assert.doesNotMatch(res.stdout, /--no-tunnel/);
  });
});

