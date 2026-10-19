const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../scripts/diagnostics');
const { createFakeDeps, response, failure, host } = require('./support/fake-diagnostics');

describe('diagnostics parsers', () => {
  test('parses meminfo, resolv.conf and failed units', () => {
    assert.deepEqual(diagnostics.parseMeminfo('MemTotal: 1024 kB\nMemAvailable: 512 kB\n'), {
      MemTotal: 1024,
      MemAvailable: 512,
    });
    assert.deepEqual(diagnostics.parseResolvConf('nameserver 1.1.1.1\nnameserver 1.1.1.1\nnameserver 8.8.8.8\n'), ['1.1.1.1', '8.8.8.8']);
    assert.deepEqual(diagnostics.parseFailedUnits([
      'citadel.service loaded failed failed Citadel',
      'docker.service loaded failed failed Docker',
      'not-a-unit loaded active running',
    ].join('\n')), ['citadel.service', 'docker.service']);
  });

  test('parses df space and inode tables without pseudo filesystems', () => {
    const space = [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/sda1 100 90 10 90% /',
      'tmpfs 100 1 99 1% /run',
      '/dev/sdb1 100 10 90 10% /mnt/data with space',
    ].join('\n');
    const rows = diagnostics.parseDf(space);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].mount, '/');
    assert.equal(rows[0].usePct, 90);
    assert.equal(rows[1].mount, '/mnt/data with space');

    const inodes = [
      'Filesystem Inodes IUsed IFree IUse% Mounted on',
      '/dev/sda1 1000 960 40 96% /',
    ].join('\n');
    assert.equal(diagnostics.parseDf(inodes, { inodes: true })[0].usePct, 96);
  });

  test('does not mistake macOS block capacity for inode capacity', () => {
    const mac = [
      'Filesystem 512-blocks Used Available Capacity iused ifree %iused Mounted on',
      '/dev/disk1s1 100 90 10 90% 1000 9000 10% /',
      'devfs 10 10 0 100% 654 0 100% /dev',
    ].join('\n');
    const rows = diagnostics.parseDf(mac, { inodes: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mount, '/');
    assert.equal(rows[0].usePct, 10);
    assert.equal(rows[0].total, null);
  });

  test('parses routes from JSON and fallback text', () => {
    assert.deepEqual(diagnostics.parseDefaultRoutes('[{"gateway":"10.0.0.1","dev":"eth0","metric":100}]'), [
      { gateway: '10.0.0.1', dev: 'eth0', metric: 100 },
    ]);
    assert.deepEqual(diagnostics.parseDefaultRoutesText('default via 10.0.0.1 dev eth0 metric 100\n'), [
      { gateway: '10.0.0.1', dev: 'eth0', metric: 100 },
    ]);
    assert.deepEqual(diagnostics.parseDefaultRoutes('not json'), []);
  });

  test('parses interfaces, addresses and ip -o output', () => {
    const ifaces = diagnostics.parseInterfaces([{
      ifname: 'eth0',
      operstate: 'UP',
      flags: ['BROADCAST', 'UP'],
      addr_info: [{ family: 'inet', local: '10.0.0.2', prefixlen: 24, scope: 'global' }],
    }]);
    assert.equal(ifaces[0].operstate, 'up');
    assert.equal(ifaces[0].addresses[0].address, '10.0.0.2');

    const fromText = diagnostics.parseIpO([
      '2: eth0    inet 10.0.0.2/24 brd 10.0.0.255 scope global eth0',
      '2: eth0    inet6 fe80::1/64 scope link',
    ].join('\n'));
    assert.equal(fromText.length, 1);
    assert.equal(fromText[0].name, 'eth0');
    assert.equal(fromText[0].addresses.length, 2);
  });

  test('parses and deduplicates nmcli Wi-Fi output with escaped colons', () => {
    const networks = diagnostics.parseNmcliWifi([
      '*:Cafe\\:Guest:WPA2:80',
      ' :Cafe\\:Guest:WPA2:40',
      ' :Open:--:30',
    ].join('\n'));
    assert.equal(networks.length, 2);
    assert.equal(networks[0].ssid, 'Cafe:Guest');
    assert.equal(networks[0].inUse, true);
    assert.equal(networks[1].ssid, 'Open');
  });

  test('parses nmcli devices/connections and rfkill state', () => {
    assert.deepEqual(diagnostics.parseNmcliDevices('wlan0:wifi:connected\neth0:ethernet:connected\n'), [
      { device: 'wlan0', type: 'wifi', state: 'connected' },
      { device: 'eth0', type: 'ethernet', state: 'connected' },
    ]);
    assert.deepEqual(diagnostics.parseNmcliConnections('Home:802-11-wireless\nWired:802-3-ethernet\n'), [
      { name: 'Home', type: '802-11-wireless' },
      { name: 'Wired', type: '802-3-ethernet' },
    ]);
    const rfkill = diagnostics.parseRfkill([
      '0: phy0: Wireless LAN',
      '        Soft blocked: yes',
      '        Hard blocked: no',
    ].join('\n'));
    assert.deepEqual(rfkill, [{ name: 'phy0', type: 'Wireless LAN', soft: true, hard: false }]);
  });
});

describe('collectHost', () => {
  test('detects Linux capabilities and wireless hardware', () => {
    const deps = createFakeDeps({
      which: { systemctl: '/usr/bin/systemctl', ip: '/usr/bin/ip' },
      files: { '/etc/os-release': 'NAME="Debian GNU/Linux"\nVERSION="12 (bookworm)"\n', '/run/systemd/system': '' },
      wireless: ['wlan0'],
    });
    const result = diagnostics.collectHost(deps);
    assert.equal(result.platform, 'linux');
    assert.equal(result.distro.name, 'Debian GNU/Linux');
    assert.deepEqual(result.wireless, ['wlan0']);
    assert.equal(result.capabilities.ip, true);
    assert.equal(result.capabilities.systemd, true);
    assert.equal(result.systemd, true);
  });

  test('works on non-Linux platforms without wireless assumptions', () => {
    const deps = createFakeDeps({ platform: 'darwin', which: {} });
    const result = diagnostics.collectHost(deps);
    assert.equal(result.platform, 'darwin');
    assert.deepEqual(result.wireless, []);
    assert.equal(result.systemd, false);
  });
});

describe('collectWifi', () => {
  const wifiHost = host({ wireless: ['wlan0'] });

  test('is optional when no wireless hardware exists', () => {
    const deps = createFakeDeps({ wireless: [] });
    const result = diagnostics.collectWifi(deps, host({ wireless: [] }));
    assert.equal(result.nmcli, false);
    assert.equal(result.findings[0].status, 'skip');
    assert.match(result.findings[0].detail, /expected on a VPS/);
  });

  test('reports unsupported management when nmcli is missing', () => {
    const deps = createFakeDeps();
    const h = host({ wireless: ['wlan0'] });
    h.capabilities.nmcli = false;
    const result = diagnostics.collectWifi(deps, h);
    assert.equal(result.nmcli, false);
    assert.match(result.findings[0].detail, /nmcli is not available/);
  });

  test('reports NetworkManager not responding instead of guessing', () => {
    const deps = createFakeDeps({
      responses: {
        nmcli: (args) => {
          if (args.join(' ') === 'radio wifi') return response('enabled');
          return failure('ETIMEDOUT');
        },
        rfkill: response(''),
      },
    });
    const result = diagnostics.collectWifi(deps, wifiHost);
    assert.equal(result.nmcli, true);
    assert.ok(result.findings.some((f) => f.id === 'wifi.manager-state' && f.status === 'warn'));
  });

  test('reports soft-blocked and hard-blocked radios with the right remedy', () => {
    const softDeps = createFakeDeps({
      responses: {
        nmcli: (args) => {
          const key = args.join(' ');
          if (key === 'radio wifi') return response('enabled');
          if (key === '-t -f DEVICE,TYPE,STATE device status') return response('wlan0:wifi:disconnected');
          return failure();
        },
        rfkill: response('0: phy0: Wireless LAN\n        Soft blocked: yes\n        Hard blocked: no\n'),
      },
    });
    const soft = diagnostics.collectWifi(softDeps, wifiHost);
    assert.equal(soft.blocked, 'soft');
    assert.ok(soft.findings.some((f) => f.id === 'wifi.blocked' && /soft-blocked/.test(f.title)));

    const hardDeps = createFakeDeps({
      responses: {
        nmcli: (args) => {
          const key = args.join(' ');
          if (key === 'radio wifi') return response('enabled');
          return response('wlan0:wifi:disconnected');
        },
        rfkill: response('0: phy0: Wireless LAN\n        Soft blocked: no\n        Hard blocked: yes\n'),
      },
    });
    const hard = diagnostics.collectWifi(hardDeps, wifiHost);
    assert.equal(hard.blocked, 'hard');
    assert.ok(hard.findings.some((f) => f.id === 'wifi.blocked' && /hard-blocked/.test(f.title)));
  });

  test('reports a connected Wi-Fi interface', () => {
    const deps = createFakeDeps({
      responses: {
        nmcli: (args) => {
          const key = args.join(' ');
          if (key === 'radio wifi') return response('enabled');
          if (key === '-t -f DEVICE,TYPE,STATE device status') return response('wlan0:wifi:connected');
          return failure();
        },
        rfkill: response('0: phy0: Wireless LAN\n        Soft blocked: no\n        Hard blocked: no\n'),
      },
    });
    const result = diagnostics.collectWifi(deps, wifiHost);
    assert.ok(result.findings.some((f) => f.id === 'wifi.state' && f.status === 'ok'));
  });
});

describe('collectNetwork', () => {
  const baseFiles = { '/etc/resolv.conf': 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' };
  const healthy = () => createFakeDeps({
    files: baseFiles,
    responses: {
      ip: (args) => {
        const key = args.join(' ');
        if (key === '-json addr show') {
          return response(JSON.stringify([
            { ifname: 'lo', operstate: 'UNKNOWN', flags: ['LOOPBACK'], addr_info: [] },
            { ifname: 'eth0', operstate: 'UP', flags: ['BROADCAST', 'UP'], addr_info: [{ family: 'inet', local: '192.168.1.10', prefixlen: 24 }] },
          ]));
        }
        if (key === '-json route show default') {
          return response('[{"gateway":"192.168.1.1","dev":"eth0","metric":100}]');
        }
        return failure();
      },
      getent: response('192.0.2.1 example.com'),
      ping: response(''),
      curl: response(''),
    },
  });

  test('reports a healthy network without requiring Internet access', () => {
    const result = diagnostics.collectNetwork(healthy(), host());
    assert.equal(result.interfaces.length, 1);
    assert.equal(result.routes[0].dev, 'eth0');
    assert.deepEqual(result.nameservers, ['1.1.1.1', '8.8.8.8']);
    assert.ok(result.findings.every((f) => f.status === 'ok'));
    assert.equal(diagnostics.exitCodeFor({ summary: diagnostics.summarize(result.findings) }), 0);
  });

  test('falls back to text routes and reports DNS/gateway/HTTP failures honestly', () => {
    const deps = createFakeDeps({
      files: baseFiles,
      responses: {
        ip: (args) => {
          const key = args.join(' ');
          if (key === '-json addr show') return failure();
          if (key === '-o addr show') return response('2: eth0    inet 192.168.1.10/24 scope global eth0');
          if (key === '-json route show default') return failure();
          if (key === 'route show default') return response('default via 192.168.1.1 dev eth0 metric 100');
          return failure();
        },
        getent: response('', 2),
        ping: response('', 1),
        curl: response('', 28),
      },
    });
    const result = diagnostics.collectNetwork(deps, host());
    assert.equal(result.routes[0].gateway, '192.168.1.1');
    assert.ok(result.findings.some((f) => f.id === 'network.dns' && f.status === 'fail'));
    assert.ok(result.findings.some((f) => f.id === 'network.gateway-ping' && f.status === 'warn'));
    assert.ok(result.findings.some((f) => f.id === 'network.http' && f.status === 'warn'));
    assert.equal(diagnostics.exitCodeFor({ summary: diagnostics.summarize(result.findings) }), 1);
  });

  test('treats a missing external Internet probe as unconfirmed, not a host failure', () => {
    const deps = healthy();
    const h = host();
    h.capabilities.getent = false;
    h.capabilities.ping = false;
    h.capabilities.curl = false;
    const result = diagnostics.collectNetwork(deps, h);
    assert.ok(result.findings.some((f) => f.id === 'network.dns' && f.status === 'skip'));
    assert.ok(result.findings.some((f) => f.id === 'network.gateway-ping' && f.status === 'skip'));
    assert.ok(result.findings.some((f) => f.id === 'network.http' && f.status === 'skip'));
  });

  test('reports no route and skips DNS probes', () => {
    const deps = createFakeDeps({
      files: baseFiles,
      responses: {
        ip: (args) => {
          const key = args.join(' ');
          if (key === '-json addr show') return response('[{"ifname":"eth0","operstate":"UP","flags":["UP"],"addr_info":[{"family":"inet","local":"192.168.1.10","prefixlen":24}]}]');
          if (key === '-json route show default') return response('[]');
          if (key === 'route show default') return response('');
          return failure();
        },
      },
    });
    const result = diagnostics.collectNetwork(deps, host());
    assert.ok(result.findings.some((f) => f.id === 'network.no-route' && f.status === 'fail'));
    assert.ok(result.findings.some((f) => f.id === 'network.dns' && f.status === 'skip'));
  });

  test('warns about down interfaces and skips unsupported diagnostics without ip', () => {
    const down = createFakeDeps({
      files: baseFiles,
      responses: {
        ip: (args) => {
          const key = args.join(' ');
          if (key === '-json addr show') return response('[{"ifname":"eth0","operstate":"DOWN","flags":["BROADCAST"],"addr_info":[]}]');
          return response('[]');
        },
      },
    });
    const result = diagnostics.collectNetwork(down, host());
    assert.ok(result.findings.some((f) => f.id === 'network.interfaces' && f.status === 'warn'));

    const noIp = createFakeDeps();
    const h = host();
    h.capabilities.ip = false;
    const skipped = diagnostics.collectNetwork(noIp, h);
    assert.equal(skipped.findings[0].status, 'skip');
    assert.deepEqual(skipped.interfaces, []);
  });

  test('reports missing DNS configuration', () => {
    const deps = healthy();
    const h = host();
    deps.fs.readFileSync = ((original) => (file, encoding) => (file === '/etc/resolv.conf' ? '' : original(file, encoding)))(deps.fs.readFileSync);
    const result = diagnostics.collectNetwork(deps, h);
    assert.ok(result.findings.some((f) => f.id === 'network.dns-config' && f.status === 'warn'));
  });
});

describe('citadel data directory check', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  function dataFinding(uid, files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-data-'));
    fs.chmodSync(dir, 0o755);
    const owner = fs.statSync(dir).uid;
    const deps = createFakeDeps({
      env: { PATH: '/usr/bin', DATA_DIR: dir },
      uid: uid === 'owner' ? owner : uid,
      files: { '/etc/passwd': `citadel:x:${owner}:${owner}::/srv/citadel:/bin/bash\nubuntu:x:4242:4242::/home/ubuntu:/bin/bash\n`, ...files },
    });
    deps.fs.accessSync = () => {
      const err = new Error('EACCES');
      err.code = 'EACCES';
      throw err;
    };
    try {
      return diagnostics.collectCitadel(deps).find((f) => f.id === 'citadel.data');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a directory owned (and writable) by the service user is ok for other users', () => {
    const item = dataFinding(4242);
    assert.equal(item.status, 'ok');
    assert.match(item.detail, /owner citadel/);
    assert.match(item.detail, /checked as ubuntu/);
  });

  test('a directory its own owner cannot write still fails', () => {
    assert.equal(dataFinding('owner').status, 'fail');
  });
});
