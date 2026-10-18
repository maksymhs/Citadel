const realFs = require('node:fs');
const diagnostics = require('../../scripts/diagnostics');

function response(stdout = '', status = 0, stderr = '') {
  return { ok: status === 0, status, stdout, stderr, error: null };
}

function failure(error = 'ENOENT') {
  return { ok: false, status: null, stdout: '', stderr: '', error };
}

function createFakeDeps(options = {}) {
  const {
    platform = 'linux',
    which = {},
    responses = {},
    files = {},
    dirs = {},
    wireless = [],
    env = { PATH: '/usr/bin' },
    uid = 1000,
    osOverrides = {},
    runInteractive = null,
  } = options;

  const fakeFs = {
    constants: realFs.constants,
    readFileSync(file, encoding) {
      if (Object.prototype.hasOwnProperty.call(files, file)) return files[file];
      return realFs.readFileSync(file, encoding);
    },
    existsSync(file) {
      if (Object.prototype.hasOwnProperty.call(files, file)) return true;
      if (wireless.some((name) => file === `/sys/class/net/${name}/wireless`
        || file === `/sys/class/net/${name}/phy80211`)) return true;
      return realFs.existsSync(file);
    },
    readdirSync(dir) {
      if (Object.prototype.hasOwnProperty.call(dirs, dir)) return dirs[dir];
      if (dir === '/sys/class/net' && wireless.length > 0) return ['lo', 'eth0', ...wireless];
      return realFs.readdirSync(dir);
    },
    accessSync(...args) { return realFs.accessSync(...args); },
    statSync(...args) { return realFs.statSync(...args); },
  };

  const run = (cmd, args = [], opts = {}) => {
    const key = `${cmd} ${args.join(' ')}`.trim();
    const handler = responses[key] || responses[cmd];
    if (!handler) return failure('ENOENT');
    return typeof handler === 'function' ? handler(args, opts) : handler;
  };

  const fakeOs = {
    hostname: () => 'test-host',
    release: () => '6.1.0-test',
    arch: () => 'x64',
    cpus: () => [{}],
    loadavg: () => [0.1, 0.2, 0.3],
    totalmem: () => 8 * 1024 ** 3,
    freemem: () => 6 * 1024 ** 3,
    ...osOverrides,
  };

  return diagnostics.createDeps({
    fs: fakeFs,
    os: fakeOs,
    env,
    platform,
    run,
    which: (name) => (Object.prototype.hasOwnProperty.call(which, name) ? which[name] : null),
    uid,
    now: () => new Date('2026-01-01T00:00:00Z'),
    isTTY: false,
    runInteractive,
  });
}

function host(overrides = {}) {
  return {
    hostname: 'test-host',
    platform: 'linux',
    kernel: '6.1.0-test',
    arch: 'x64',
    node: 'v20.0.0',
    distro: { name: 'Debian', version: '12' },
    systemd: true,
    wireless: [],
    capabilities: {
      ip: true,
      nmcli: true,
      networkctl: true,
      resolvectl: true,
      iw: true,
      rfkill: true,
      ping: true,
      getent: true,
      curl: true,
      df: true,
      systemctl: true,
      journalctl: true,
      docker: false,
      podman: false,
      sudo: true,
      root: false,
      systemd: true,
      wireless: false,
    },
    ...overrides,
  };
}

module.exports = { createFakeDeps, response, failure, host };
