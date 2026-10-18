const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const doctor = require('../scripts/doctor');
const diagnostics = require('../scripts/diagnostics');
const { createFakeDeps, response, failure, host } = require('./support/fake-diagnostics');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-doctor-test-'));

function cleanup() {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
process.on('exit', cleanup);

function capture(options = {}) {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      isTTY: options.isTTY || false,
      prompt: options.prompt || null,
      env: options.env || {},
      color: options.color === undefined ? false : options.color,
    },
    out() { return stdout.join(''); },
    err() { return stderr.join(''); },
  };
}

function doctorDeps(overrides = {}) {
  return createFakeDeps({
    which: { git: '/usr/bin/git' },
    env: { PATH: '/usr/bin', DATA_DIR: tempDir },
    files: {
      '/proc/meminfo': 'MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
      '/etc/os-release': 'NAME="Debian GNU/Linux"\nVERSION_ID="12"\n',
      '/etc/resolv.conf': 'nameserver 1.1.1.1\n',
    },
    responses: { git: response('git version 2.39.0') },
    ...overrides,
  });
}

describe('doctor CLI output contract', () => {
  test('doctor --json writes only JSON to stdout and exits 0 when there is no failure', async () => {
    const c = capture();
    const code = await doctor.main(['doctor', '--json'], { io: c.io, deps: doctorDeps() });
    assert.equal(code, 0);
    assert.equal(c.err(), '');
    const report = JSON.parse(c.out());
    assert.equal(report.kind, 'doctor');
    assert.equal(report.summary.fail, 0);
    assert.equal(report.host.platform, 'linux');
    assert.ok(Array.isArray(report.findings));
  });

  test('doctor text output is readable and keeps warnings non-fatal', async () => {
    const c = capture();
    const code = await doctor.main(['doctor'], { io: c.io, deps: doctorDeps() });
    assert.equal(code, 0);
    assert.match(c.out(), /Citadel doctor/);
    assert.match(c.out(), /CITADEL/);
    assert.equal(c.err(), '');
  });

  test('invalid usage returns exit 2 without touching the system', async () => {
    const c = capture();
    const code = await doctor.main(['--bogus'], { io: c.io, deps: doctorDeps() });
    assert.equal(code, 2);
    assert.match(c.err(), /Unknown option/);
    assert.equal(c.out(), '');

    const emptyAction = capture();
    assert.equal(await doctor.main(['repair', '--action='], { io: emptyAction.io, deps: doctorDeps() }), 2);
    assert.match(emptyAction.err(), /non-empty/);

    const emptySsid = capture();
    assert.equal(await doctor.main(['wifi', 'connect', '--ssid='], { io: emptySsid.io, deps: doctorDeps() }), 2);
    assert.match(emptySsid.err(), /non-empty network name/);
  });

  test('--no-color disables ANSI even on a colour-capable terminal', async () => {
    const c = capture({ color: true });
    const code = await doctor.main(['doctor', '--no-color'], { io: c.io, deps: doctorDeps() });
    assert.equal(code, 0);
    assert.doesNotMatch(c.out(), /\x1b\[/);
  });

  test('help is local and complete', async () => {
    const c = capture();
    assert.equal(await doctor.main(['help'], { io: c.io, deps: doctorDeps() }), 0);
    assert.match(c.out(), /citadel wifi connect/);
    assert.match(c.out(), /Passwords are never accepted/);
  });

  test('repair --json lists an empty plan without prompting', async () => {
    const c = capture();
    const code = await doctor.main(['repair', '--json'], { io: c.io, deps: doctorDeps() });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(c.out()).actions, []);
    assert.equal(c.err(), '');
  });

  test('repair refuses unknown actions and JSON without explicit consent', async () => {
    const unknown = capture();
    const code = await doctor.main(['repair', '--json', '--action=restart:nope.service', '--yes'], {
      io: unknown.io,
      deps: doctorDeps(),
    });
    assert.equal(code, 2);
    assert.match(unknown.err(), /Unknown or no-longer-applicable/);

    const noConsent = capture();
    assert.equal(await doctor.main(['repair', '--json', '--action=restart:citadel.service'], {
      io: noConsent.io,
      deps: doctorDeps(),
    }), 2);
    assert.match(noConsent.err(), /requires --yes/);
  });
});

describe('repair planning and execution', () => {
  const J = { flags: new Set(['--json']) };
  const failedReport = () => ({
    host: host(),
    findings: [
      diagnostics.finding('fail', 'services.failed', 'services', 'Failed services', 'two failed', {
        data: { units: ['docker.service', 'citadel.service'] },
      }),
      diagnostics.finding('fail', 'citadel.service', 'citadel', 'Citadel service', 'failed'),
      diagnostics.finding('warn', 'wifi.blocked', 'wifi', 'Wi-Fi is soft-blocked', 'soft'),
      diagnostics.finding('warn', 'wifi.state', 'wifi', 'Wi-Fi is not connected', 'disconnected'),
    ],
  });

  test('builds a deduplicated, explicitly supported plan', async () => {
    const deps = createFakeDeps({
      which: { nmcli: '/usr/bin/nmcli' },
      responses: {
        nmcli: response('Home:802-11-wireless\nWired:802-3-ethernet\n'),
      },
    });
    const plan = await doctor.buildRepairPlan(deps, failedReport());
    const ids = plan.map((action) => action.id);
    assert.deepEqual(ids, ['restart:docker.service', 'restart:citadel.service', 'wifi:unblock', 'wifi:reconnect:Home']);
    assert.equal(ids.filter((id) => id === 'restart:citadel.service').length, 1);
    assert.equal(plan.find((action) => action.kind === 'wifi-reconnect').remoteSensitive, true);
  });

  test('restarts only a validated unit and verifies the result', async () => {
    const report = failedReport();
    let restarted = null;
    const deps = createFakeDeps({
      uid: 0,
      responses: {
        systemctl: (args) => {
          if (args.join(' ') === 'restart docker.service') {
            restarted = args;
            return response('');
          }
          if (args.join(' ') === 'is-active docker.service') return response('active');
          return failure();
        },
      },
    });
    const outcome = await doctor.executeAction({
      kind: 'service-restart',
      target: 'docker.service',
      requiresRoot: true,
    }, report, deps, {}, J);
    assert.deepEqual(restarted, ['restart', 'docker.service']);
    assert.equal(outcome.executed, true);
    assert.equal(outcome.verified, true);

    const refused = await doctor.executeAction({
      kind: 'service-restart',
      target: 'attacker.service',
      requiresRoot: true,
    }, report, deps, {}, J);
    assert.equal(refused.executed, false);
    assert.match(refused.message, /unrecognized unit/);
  });

  test('reports a still-failed service and an unverifiable state honestly', async () => {
    const report = failedReport();
    const stillFailed = createFakeDeps({
      uid: 0,
      responses: {
        systemctl: (args) => (args.join(' ').startsWith('restart')
          ? response('')
          : response('failed', 3)),
      },
    });
    const failed = await doctor.executeAction({
      kind: 'service-restart', target: 'docker.service', requiresRoot: true,
    }, report, stillFailed, {}, J);
    assert.equal(failed.executed, true);
    assert.equal(failed.verified, false);
    assert.match(failed.message, /still failed/);

    const unknown = createFakeDeps({
      uid: 0,
      responses: {
        systemctl: (args) => (args.join(' ').startsWith('restart') ? response('') : response('', 1)),
      },
    });
    const unverified = await doctor.executeAction({
      kind: 'service-restart', target: 'docker.service', requiresRoot: true,
    }, report, unknown, {}, J);
    assert.equal(unverified.verified, false);
    assert.match(unverified.message, /could not be verified/);
  });

  test('a restart that exits 0 but leaves the unit inactive/failed is never a success', async () => {
    const report = failedReport();
    const inactive = createFakeDeps({
      uid: 0,
      responses: {
        systemctl: (args) => (args.join(' ').startsWith('restart') ? response('') : response('inactive', 3)),
      },
    });
    const outcome = await doctor.executeAction({
      kind: 'service-restart', target: 'citadel.service', requiresRoot: true,
    }, report, inactive, {}, J);
    assert.equal(outcome.executed, true);
    assert.equal(outcome.verified, false);
    assert.match(outcome.message, /did not report "active"/);

    // The verification helper itself: active is the only success.
    assert.equal(doctor.verifyServiceRestart(createFakeDeps({
      responses: { systemctl: response('active') },
    }), 'citadel.service').verified, true);
    assert.equal(doctor.verifyServiceRestart(createFakeDeps({
      responses: { systemctl: response('failed', 3) },
    }), 'citadel.service').verified, false);
    assert.equal(doctor.verifyServiceRestart(createFakeDeps({
      responses: { systemctl: failure('ENOENT') },
    }), 'citadel.service').verified, false);
    assert.equal(doctor.verifyServiceRestart(createFakeDeps({
      responses: { systemctl: response('', 1) },
    }), 'citadel.service').verified, false);
  });

  test('rfkill and saved Wi-Fi reconnect are verified, not assumed', async () => {
    const rfkillDeps = createFakeDeps({
      uid: 0,
      responses: {
        rfkill: (args) => (args.join(' ') === 'list wifi'
          ? response('0: phy0: Wireless LAN\n        Soft blocked: no\n        Hard blocked: no\n')
          : response('')),
      },
    });
    const unblocked = await doctor.executeAction({ kind: 'wifi-unblock', requiresRoot: true }, failedReport(), rfkillDeps, {}, J);
    assert.equal(unblocked.verified, true);

    const reconnectDeps = createFakeDeps({
      responses: {
        nmcli: (args) => (args.join(' ') === '-t -f NAME connection show --active' ? response('Home') : response('')),
        ip: response('[{"gateway":"10.0.0.1","dev":"wlan0"}]'),
      },
    });
    const reconnected = await doctor.executeAction({ kind: 'wifi-reconnect', target: 'Home' }, failedReport(), reconnectDeps, {}, J);
    assert.equal(reconnected.verified, true);
  });

  test('requires an allowed confirmation and refuses remote-sensitive automation without --confirm-remote', async () => {
    const remoteEnv = { SSH_CONNECTION: '203.0.113.9 5555 10.0.0.2 22' };
    const parsed = doctor.parseArgs(['repair', '--action=restart:docker.service', '--yes']);
    const remote = await doctor.confirmAction({ remoteSensitive: true }, {}, capture({ env: remoteEnv }).io, parsed);
    assert.equal(remote.allowed, false);
    assert.match(remote.reason, /confirm-remote/);

    const confirmed = doctor.parseArgs(['repair', '--action=restart:docker.service', '--yes', '--confirm-remote']);
    assert.deepEqual(await doctor.confirmAction({ remoteSensitive: true }, {}, capture({ env: remoteEnv }).io, confirmed), { allowed: true });

    const noTty = await doctor.confirmAction({ remoteSensitive: false }, {}, capture().io, doctor.parseArgs(['repair']));
    assert.equal(noTty.allowed, false);

    const answerNo = await doctor.confirmAction({ remoteSensitive: false }, {}, capture({ prompt: async () => 'n' }).io, doctor.parseArgs(['repair']));
    assert.equal(answerNo.allowed, false);
    const answerYes = await doctor.confirmAction({ remoteSensitive: false }, {}, capture({ prompt: async () => 'yes' }).io, doctor.parseArgs(['repair']));
    assert.equal(answerYes.allowed, true);
  });

  test('executes a repair through the JSON path and reports its verification', async () => {
    const original = diagnostics.collectDoctor;
    const report = {
      kind: 'doctor',
      host: host(),
      findings: [
        diagnostics.finding('fail', 'services.failed', 'services', 'Failed services', 'one failed', {
          data: { units: ['citadel.service'] },
        }),
        diagnostics.finding('fail', 'citadel.service', 'citadel', 'Citadel service', 'failed'),
      ],
      summary: { ok: 0, warn: 0, fail: 2, skip: 0, total: 2 },
    };
    diagnostics.collectDoctor = () => report;
    try {
      const c = capture();
      const deps = createFakeDeps({
        uid: 0,
        responses: {
          systemctl: (args) => (args.join(' ').startsWith('restart') ? response('') : response('active')),
        },
      });
      const code = await doctor.main([
        'repair', '--json', '--yes', '--action=restart:citadel.service',
      ], { io: c.io, deps });
      assert.equal(code, 0);
      const result = JSON.parse(c.out());
      assert.equal(result.applied.length, 1);
      assert.equal(result.applied[0].verified, true);
    } finally {
      diagnostics.collectDoctor = original;
    }
  });
});

describe('Wi-Fi commands', () => {
  function wifiDeps(options = {}) {
    const calls = [];
    const profiles = options.profiles === undefined
      ? 'Home:802-11-wireless\nWired:802-3-ethernet\n'
      : options.profiles;
    const deps = createFakeDeps({
      wireless: ['wlan0'],
      which: { nmcli: '/usr/bin/nmcli', ip: '/usr/bin/ip', rfkill: '/usr/bin/rfkill' },
      files: {
        '/etc/os-release': 'NAME="Debian GNU/Linux"\nVERSION_ID="12"\n',
        '/etc/resolv.conf': 'nameserver 1.1.1.1\n',
      },
      env: { PATH: '/usr/bin', DATA_DIR: tempDir },
      responses: {
        nmcli: (args) => {
          const key = args.join(' ');
          calls.push(['nmcli', ...args]);
          if (key === 'radio wifi') return response(options.radio || 'enabled');
          if (key === '-t -f DEVICE,TYPE,STATE device status') {
            return response(options.deviceState || 'wlan0:wifi:connected');
          }
          if (key === '-t -f NAME,TYPE connection show') return response(profiles);
          if (key.startsWith('connection up id ')) return response('');
          if (key === '-t -f IN-USE,SSID,SECURITY,SIGNAL device wifi list --rescan yes') {
            return response(options.networks || '*:Home:WPA2:80\n :Cafe:WPA2:40\n');
          }
          if (key === '-t -f ACTIVE,SSID device wifi list') return response(`yes:${options.activeSsid || 'Home'}\n`);
          return failure();
        },
        rfkill: () => response(options.rfkill || '0: phy0: Wireless LAN\n        Soft blocked: no\n        Hard blocked: no\n'),
        ip: (args) => {
          calls.push(['ip', ...args]);
          const key = args.join(' ');
          if (key === '-json addr show') {
            return response(JSON.stringify([{
              ifname: 'wlan0',
              operstate: 'UP',
              flags: ['UP'],
              addr_info: [{ family: 'inet', local: '10.0.0.2', prefixlen: 24 }],
            }]));
          }
          if (key === '-json route show default') {
            return response('[{"gateway":"10.0.0.1","dev":"wlan0","metric":600}]');
          }
          return failure();
        },
      },
      runInteractive: options.runInteractive || null,
    });
    return { deps, calls };
  }

  test('lists networks as JSON without mixing notes into stdout', async () => {
    const { deps } = wifiDeps();
    const c = capture();
    const code = await doctor.main(['wifi', 'list', '--json'], { io: c.io, deps });
    assert.equal(code, 0);
    const result = JSON.parse(c.out());
    assert.equal(result.kind, 'wifi-list');
    assert.equal(result.supported, true);
    assert.equal(result.networks[0].ssid, 'Home');
    assert.equal(result.networks[0].inUse, true);
  });

  test('refuses a remote-sensitive Wi-Fi change without --confirm-remote', async () => {
    const { deps, calls } = wifiDeps();
    const c = capture({ env: { SSH_CONNECTION: '203.0.113.9 5555 10.0.0.2 22' } });
    const code = await doctor.main(['wifi', 'connect', '--ssid=Home', '--yes', '--json'], { io: c.io, deps });
    assert.equal(code, 1);
    assert.match(JSON.parse(c.out()).message, /confirm-remote/);
    assert.ok(!calls.some((call) => call.join(' ') === 'nmcli connection up id Home'));
  });

  test('connects a saved profile and verifies the active SSID and route', async () => {
    const { deps, calls } = wifiDeps();
    const c = capture({ env: { SSH_CONNECTION: '203.0.113.9 5555 10.0.0.2 22' } });
    const code = await doctor.main([
      'wifi', 'connect', '--ssid=Home', '--yes', '--confirm-remote', '--json',
    ], { io: c.io, deps });
    assert.equal(code, 0);
    const result = JSON.parse(c.out());
    assert.equal(result.connected, true);
    assert.equal(result.verified, true);
    assert.ok(calls.some((call) => call.join(' ') === 'nmcli connection up id Home'));
    assert.ok(!calls.some((call) => call.includes('password')));
  });


  test('verifyWifi never claims success when the active SSID cannot be confirmed', async () => {
    const base = {
      responses: {
        nmcli: (args) => {
          const key = args.join(' ');
          if (key === '-t -f DEVICE,TYPE,STATE device status') return response('wlan0:wifi:connected');
          if (key === '-t -f ACTIVE,SSID device wifi list') return response('yes:Other\n');
          return failure();
        },
        ip: response('[{"gateway":"10.0.0.1","dev":"wlan0"}]'),
      },
    };
    const mismatch = await doctor.verifyWifi(createFakeDeps(base), host(), 'Home');
    assert.equal(mismatch.verified, false);
    assert.match(mismatch.reason, /does not report/);

    const unavailable = createFakeDeps({
      responses: {
        nmcli: (args) => {
          const key = args.join(' ');
          if (key === '-t -f DEVICE,TYPE,STATE device status') return response('wlan0:wifi:connected');
          return failure('ETIMEDOUT');
        },
        ip: response('[{"gateway":"10.0.0.1","dev":"wlan0"}]'),
      },
    });
    const unverified = await doctor.verifyWifi(unavailable, host(), 'Home');
    assert.equal(unverified.verified, false);
    assert.match(unverified.reason, /active SSID/);
  });

  test('new networks use nmcli --ask and never put a password in argv', async () => {
    let interactiveArgs = null;
    const { deps } = wifiDeps({
      profiles: '',
      activeSsid: 'NewNet',
      runInteractive: (cmd, args) => {
        interactiveArgs = [cmd, ...args];
        return response('');
      },
    });
    const c = capture({ isTTY: true });
    const code = await doctor.main(['wifi', 'connect', 'NewNet', '--yes'], { io: c.io, deps });
    assert.equal(code, 0);
    assert.deepEqual(interactiveArgs, ['nmcli', '--ask', 'device', 'wifi', 'connect', 'NewNet']);
    assert.ok(!interactiveArgs.includes('password'));
  });

  test('new networks cannot prompt in JSON mode', async () => {
    const { deps, calls } = wifiDeps({ profiles: '' });
    const c = capture();
    const code = await doctor.main(['wifi', 'connect', '--ssid=NewNet', '--yes', '--json'], { io: c.io, deps });
    assert.equal(code, 2);
    assert.match(c.err(), /cannot prompt for a new Wi-Fi password/);
    assert.ok(!calls.some((call) => call.join(' ').startsWith('nmcli --ask')));
  });

  test('a hard-blocked radio fails honestly and does not attempt a connection', async () => {
    const { deps, calls } = wifiDeps({
      rfkill: '0: phy0: Wireless LAN\n        Soft blocked: no\n        Hard blocked: yes\n',
    });
    const c = capture();
    const code = await doctor.main(['wifi', 'connect', '--ssid=Home', '--yes', '--json'], { io: c.io, deps });
    assert.equal(code, 1);
    assert.match(JSON.parse(c.out()).message, /hard-blocked/);
    assert.ok(!calls.some((call) => call.join(' ') === 'nmcli connection up id Home'));
  });
});

describe('Remote-sensitive service repairs', () => {
  const REMOTE_ENV = { SSH_CONNECTION: '203.0.113.9 5555 10.0.0.2 22' };

  function failedServiceReport(units) {
    return {
      kind: 'doctor',
      host: host(),
      findings: [
        diagnostics.finding('fail', 'services.failed', 'services', 'Failed services', 'failed', { data: { units } }),
      ],
      summary: { ok: 0, warn: 0, fail: 1, skip: 0, total: 1 },
    };
  }

  test('classifies SSH, network-manager and firewall units as remote-sensitive', () => {
    const sensitive = [
      'ssh.service', 'sshd.service', 'NetworkManager.service', 'systemd-networkd.service',
      'systemd-resolved.service', 'networking.service', 'wpa_supplicant.service', 'dhcpcd.service',
      'dhclient.service', 'isc-dhcp-server.service', 'ufw.service', 'nftables.service',
      'firewalld.service', 'iptables.service', 'ip6tables.service', 'netfilter-persistent.service',
    ];
    for (const unit of sensitive) assert.equal(doctor.isNetworkUnit(unit), true, `${unit} must be remote-sensitive`);
    for (const unit of ['docker.service', 'citadel.service', 'nginx.service', 'sshalias.service']) {
      assert.equal(doctor.isNetworkUnit(unit), false, `${unit} must not be remote-sensitive`);
    }
  });

  test('buildRepairPlan marks SSH/network/firewall restarts as remote-sensitive', async () => {
    const plan = await doctor.buildRepairPlan(
      doctorDeps(),
      failedServiceReport(['ssh.service', 'ufw.service', 'docker.service']),
    );
    const byId = Object.fromEntries(plan.map((action) => [action.id, action]));
    assert.equal(byId['restart:ssh.service'].remoteSensitive, true);
    assert.equal(byId['restart:ufw.service'].remoteSensitive, true);
    assert.equal(byId['restart:docker.service'].remoteSensitive, false);
  });

  test('over SSH, restarting a remote-sensitive unit is refused without --confirm-remote and runs nothing', async () => {
    const original = diagnostics.collectDoctor;
    const units = ['ssh.service', 'sshd.service', 'NetworkManager.service', 'ufw.service', 'nftables.service'];
    diagnostics.collectDoctor = () => failedServiceReport(units);
    try {
      for (const unit of units) {
        const calls = [];
        const deps = createFakeDeps({
          uid: 0,
          responses: { systemctl: (args) => { calls.push(args.join(' ')); return response('active'); } },
        });
        const c = capture({ env: REMOTE_ENV });
        const code = await doctor.main(['repair', '--json', '--yes', `--action=restart:${unit}`], { io: c.io, deps });
        assert.equal(code, 1, `${unit}: expected refusal`);
        assert.match(JSON.parse(c.out()).message, /confirm-remote/);
        assert.equal(calls.filter((cmd) => cmd.startsWith('restart')).length, 0, `${unit}: no command may run`);
      }
    } finally {
      diagnostics.collectDoctor = original;
    }
  });

  test('the same remote-sensitive restart proceeds only with --confirm-remote', async () => {
    const original = diagnostics.collectDoctor;
    diagnostics.collectDoctor = () => failedServiceReport(['ssh.service']);
    try {
      const calls = [];
      const deps = createFakeDeps({
        uid: 0,
        responses: {
          systemctl: (args) => { calls.push(args.join(' ')); return args[0] === 'restart' ? response('') : response('active'); },
        },
      });
      const c = capture({ env: REMOTE_ENV });
      const code = await doctor.main(
        ['repair', '--json', '--yes', '--confirm-remote', '--action=restart:ssh.service'],
        { io: c.io, deps },
      );
      assert.equal(code, 0);
      const result = JSON.parse(c.out());
      assert.equal(result.applied[0].verified, true);
      assert.ok(calls.includes('restart ssh.service'));
      assert.match(c.err(), /SSH session/);
    } finally {
      diagnostics.collectDoctor = original;
    }
  });

  test('a remote-sensitive interactive confirmation requires typing "yes"', async () => {
    const parsed = doctor.parseArgs(['repair']);
    const yes = await doctor.confirmAction({ remoteSensitive: true }, {}, capture({ env: REMOTE_ENV, prompt: async () => 'yes' }).io, parsed);
    assert.deepEqual(yes, { allowed: true });
    const y = await doctor.confirmAction({ remoteSensitive: true }, {}, capture({ env: REMOTE_ENV, prompt: async () => 'y' }).io, parsed);
    assert.equal(y.allowed, false);
  });
});
