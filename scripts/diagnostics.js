const { spawnSync } = require('node:child_process');
const realFs = require('node:fs');
const realOs = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT = 4000;
const MAX_FINDING_LIST = 12;

function makeRunner(spawnSyncImpl = spawnSync) {
  return function run(cmd, args = [], opts = {}) {
    const res = spawnSyncImpl(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout === undefined ? DEFAULT_TIMEOUT : opts.timeout,
      maxBuffer: opts.maxBuffer || 512 * 1024,
      input: opts.input,
      env: opts.env,
      stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) {
      return { ok: false, status: null, stdout: '', stderr: '', error: res.error.code || res.error.message };
    }
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
      error: null,
    };
  };
}

function makeWhich(fs, env) {
  return function which(name) {
    const dirs = String((env && env.PATH) || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
    return null;
  };
}

function createDeps(overrides = {}) {
  const fs = overrides.fs || realFs;
  const os = overrides.os || realOs;
  const env = overrides.env || process.env;
  const platform = overrides.platform || process.platform;
  const run = overrides.run || makeRunner(overrides.spawnSync);
  const which = overrides.which || ((name) => makeWhich(fs, env)(name));
  const uid = overrides.uid !== undefined
    ? overrides.uid
    : (typeof process.getuid === 'function' ? process.getuid() : null);
  return {
    fs,
    os,
    env,
    platform,
    run,
    which,
    uid,
    now: overrides.now || (() => new Date()),
    runInteractive: overrides.runInteractive || null,
    isTTY: overrides.isTTY !== undefined ? overrides.isTTY : !!process.stdin.isTTY,
  };
}

function finding(status, id, category, title, detail, extra = {}) {
  return {
    id,
    status,
    category,
    title,
    detail,
    confidence: extra.confidence || 'confirmed',
    ...(extra.hint ? { hint: extra.hint } : {}),
    ...(extra.data !== undefined ? { data: extra.data } : {}),
  };
}

function summarize(findings) {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0, total: findings.length };
  for (const item of findings) {
    if (summary[item.status] !== undefined) summary[item.status] += 1;
  }
  return summary;
}

function readText(deps, file) {
  try {
    return deps.fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function userName(deps, uid) {
  try {
    const line = String(deps.fs.readFileSync('/etc/passwd', 'utf8'))
      .split('\n')
      .find((l) => l.split(':')[2] === String(uid));
    if (line) return line.split(':')[0];
  } catch {}
  return `uid ${uid}`;
}

function exists(deps, file) {
  try {
    return deps.fs.existsSync(file);
  } catch {
    return false;
  }
}

function cLocale(deps) {
  return { ...(deps.env || {}), LC_ALL: 'C', LANG: 'C' };
}

function readOsRelease(deps) {
  const text = readText(deps, '/etc/os-release') || readText(deps, '/usr/lib/os-release');
  const data = {};
  if (text) {
    for (const line of text.split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      data[match[1]] = value;
    }
  }
  const name = data.PRETTY_NAME || data.NAME || (deps.platform === 'darwin' ? 'macOS' : 'Linux (unknown distribution)');
  return {
    id: data.ID || (deps.platform === 'darwin' ? 'darwin' : 'unknown'),
    version: data.VERSION_ID || null,
    name,
    idLike: data.ID_LIKE ? data.ID_LIKE.split(/\s+/) : [],
  };
}

function parseMeminfo(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)(?:\s+kB)?/);
    if (!match) continue;
    out[match[1]] = Number(match[2]);
  }
  return out;
}

function pct(used, total) {
  if (!total || total <= 0) return null;
  return Math.round((used / total) * 100);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function parseDf(text, { inodes = false } = {}) {
  const rows = [];
  if (!text) return rows;
  const lines = text.split('\n').filter(Boolean);
  if (lines.length === 0) return rows;
  const header = lines[0].trim().split(/\s+/);
  const spaceIdx = header.findIndex((h) => /^(capacity|use%)$/i.test(h));
  const inodeIdx = header.findIndex((h) => /^(iuse%|%iused)$/i.test(h));
  const mountIdx = header.findIndex((h) => /^mounted$/i.test(h));
  const useIdx = inodes ? inodeIdx : spaceIdx;
  if (useIdx === -1) return rows;
  const mountAt = mountIdx === -1 ? Math.max(1, header.length - 2) : mountIdx;

  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length <= useIdx) continue;
    const filesystem = parts[0];
    const mount = parts.slice(mountAt).join(' ');
    if (!filesystem || !mount) continue;
    if (fsIsPseudo(filesystem, mount)) continue;
    const percent = parseInt(String(parts[useIdx]).replace('%', ''), 10);
    if (!Number.isFinite(percent)) continue;
    const totalNum = Number(parts[1]);
    const usedNum = Number(parts[2]);
    const freeNum = Number(parts[3]);
    rows.push({
      filesystem,
      mount,
      total: !inodes && Number.isFinite(totalNum) ? totalNum : null,
      used: !inodes && Number.isFinite(usedNum) ? usedNum : null,
      available: !inodes && Number.isFinite(freeNum) ? freeNum : null,
      usePct: percent,
      inodes,
    });
  }
  return rows;
}

function fsIsPseudo(filesystem, mount) {
  if (!filesystem) return true;
  if (/^(tmpfs|devtmpfs|devfs|udev|shm|squashfs|proc|sysfs|cgroup2?|securityfs|pstore|debugfs|tracefs|configfs|fusectl|mqueue|hugetlbfs|bpf|nsfs|autofs|binfmt_misc|efivarfs|map)$/i.test(filesystem)) return true;
  if (/^map\s/i.test(filesystem)) return true;
  if (/^\/(proc|sys|dev)(\/|$)/.test(mount)) return true;
  if (/\/snap\//.test(mount)) return true;
  return false;
}

function parseDefaultRoutes(text) {
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((route) => ({
    gateway: route.gateway || null,
    dev: route.dev || null,
    metric: Number.isFinite(route.metric) ? route.metric : null,
  }));
}

function parseDefaultRoutesText(text) {
  const routes = [];
  if (!text) return routes;
  for (const line of text.split('\n')) {
    if (!/^default\b/.test(line.trim())) continue;
    const gateway = line.match(/\bvia\s+(\S+)/);
    const dev = line.match(/\bdev\s+(\S+)/);
    const metric = line.match(/\bmetric\s+(\d+)/);
    routes.push({
      gateway: gateway ? gateway[1] : null,
      dev: dev ? dev[1] : null,
      metric: metric ? Number(metric[1]) : null,
    });
  }
  return routes;
}

function parseIpJson(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseInterfaces(json) {
  if (!Array.isArray(json)) return [];
  return json.map((iface) => {
    const addrs = Array.isArray(iface.addr_info) ? iface.addr_info : [];
    return {
      name: iface.ifname || '?',
      operstate: String(iface.operstate || 'unknown').toLowerCase(),
      flags: Array.isArray(iface.flags) ? iface.flags : [],
      addresses: addrs.map((a) => ({
        family: a.family,
        address: a.local,
        prefixlen: a.prefixlen,
        scope: a.scope,
      })),
    };
  });
}

function interfaceHasAddress(iface) {
  return iface.addresses.some((a) => a.family === 'inet' || a.family === 'inet6');
}

function parseResolvConf(text) {
  const servers = [];
  if (!text) return servers;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*nameserver\s+(\S+)/i);
    if (match) servers.push(match[1]);
  }
  return [...new Set(servers)];
}

function parseFailedUnits(text) {
  if (!text) return [];
  const units = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const unit = trimmed.split(/\s+/)[0];
    if (!unit || unit === 'UNIT') continue;
    if (!/\.(service|socket|timer|mount|automount|path|target|slice|scope|swap|device)$/.test(unit)) continue;
    if (!units.includes(unit)) units.push(unit);
  }
  return units;
}

function parseRfkill(text) {
  const devices = [];
  let current = null;
  for (const line of text.split('\n')) {
    const head = line.match(/^\d+:\s+(.+):\s+(.+)$/);
    if (head) {
      current = { name: head[1], type: head[2], soft: false, hard: false };
      devices.push(current);
      continue;
    }
    if (!current) continue;
    if (/Soft blocked:\s*yes/i.test(line)) current.soft = true;
    if (/Hard blocked:\s*yes/i.test(line)) current.hard = true;
  }
  return devices;
}

function splitNmcli(line) {
  const fields = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += line[i + 1];
      i += 1;
    } else if (ch === ':') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseNmcliWifi(text) {
  const networks = [];
  if (!text) return networks;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const fields = splitNmcli(line);
    if (fields.length < 4) continue;
    const [inUse, ssid, security, signal] = fields;
    if (!ssid) continue;
    networks.push({
      ssid,
      security: security || '--',
      signal: Number.parseInt(signal, 10) || 0,
      inUse: inUse === '*' || /^(yes|true)$/i.test(inUse),
    });
  }
  const bySsid = new Map();
  for (const net of networks) {
    const prev = bySsid.get(net.ssid);
    if (!prev || net.inUse || (!prev.inUse && net.signal > prev.signal)) bySsid.set(net.ssid, net);
  }
  return [...bySsid.values()].sort((a, b) => (b.inUse - a.inUse) || b.signal - a.signal);
}

function parseNmcliDevices(text) {
  const devices = [];
  if (!text) return devices;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const fields = splitNmcli(line);
    if (fields.length < 3) continue;
    devices.push({ device: fields[0], type: fields[1], state: fields[2] });
  }
  return devices;
}

function parseNmcliConnections(text) {
  const rows = [];
  if (!text) return rows;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const fields = splitNmcli(line);
    if (fields.length < 2) continue;
    rows.push({ name: fields[0], type: fields[1] });
  }
  return rows;
}

function collectHost(deps) {
  const distro = readOsRelease(deps);
  const hasSystemd = deps.platform === 'linux'
    && exists(deps, '/run/systemd/system')
    && !!deps.which('systemctl');
  const wireless = collectWirelessInterfaces(deps);
  return {
    hostname: deps.os.hostname(),
    platform: deps.platform,
    kernel: deps.os.release(),
    arch: deps.os.arch(),
    node: process.version,
    distro,
    systemd: hasSystemd,
    wireless,
    capabilities: {
      ip: !!deps.which('ip'),
      nmcli: !!deps.which('nmcli'),
      networkctl: !!deps.which('networkctl'),
      resolvectl: !!deps.which('resolvectl'),
      iw: !!deps.which('iw'),
      rfkill: !!deps.which('rfkill'),
      ping: !!deps.which('ping'),
      getent: !!deps.which('getent'),
      curl: !!deps.which('curl'),
      df: !!deps.which('df'),
      systemctl: !!deps.which('systemctl'),
      journalctl: !!deps.which('journalctl'),
      docker: !!deps.which('docker'),
      podman: !!deps.which('podman'),
      sudo: !!deps.which('sudo'),
      root: deps.uid === 0,
      systemd: hasSystemd,
      wireless: wireless.length > 0,
    },
  };
}

function collectWirelessInterfaces(deps) {
  if (deps.platform !== 'linux') return [];
  const names = [];
  try {
    for (const name of deps.fs.readdirSync('/sys/class/net')) {
      if (exists(deps, `/sys/class/net/${name}/wireless`) || exists(deps, `/sys/class/net/${name}/phy80211`)) {
        names.push(name);
      }
    }
  } catch {
    return [];
  }
  return names;
}

function collectLoad(deps) {
  const cores = Math.max(1, (deps.os.cpus() || []).length);
  const load1 = (deps.os.loadavg() || [0])[0] || 0;
  const perCore = load1 / cores;
  let status = 'ok';
  if (perCore >= 8) status = 'fail';
  else if (perCore >= 1.5) status = 'warn';
  const detail = `1-minute load ${load1.toFixed(2)} on ${cores} CPU${cores === 1 ? '' : 's'} (${perCore.toFixed(2)} per core).`;
  return finding(status, 'load', 'system', 'System load', detail, {
    hint: status === 'ok' ? undefined : 'Inspect the busiest processes: ps -eo pid,comm,%cpu --sort=-%cpu | head',
    data: { load1, cores, perCore },
  });
}

function collectMemory(deps) {
  const meminfo = parseMeminfo(readText(deps, '/proc/meminfo'));
  let total;
  let available;
  let swapTotal;
  let swapFree;
  if (meminfo.MemTotal) {
    total = meminfo.MemTotal * 1024;
    available = (meminfo.MemAvailable || meminfo.MemFree || 0) * 1024;
    swapTotal = (meminfo.SwapTotal || 0) * 1024;
    swapFree = (meminfo.SwapFree || 0) * 1024;
  } else {
    total = deps.os.totalmem();
    available = deps.os.freemem();
    swapTotal = null;
    swapFree = null;
  }
  const used = total - available;
  const usedPct = pct(used, total);
  const swapUsed = swapTotal !== null ? swapTotal - swapFree : null;
  const swapPct = swapTotal ? pct(swapUsed, swapTotal) : null;

  let status = 'ok';
  let detail = `${formatBytes(used)} of ${formatBytes(total)} used (${usedPct === null ? '?' : usedPct}% used).`;
  const hints = [];
  if (usedPct !== null && usedPct >= 95) {
    status = 'fail';
    hints.push('Memory is nearly exhausted; check the top consumers: ps -eo pid,comm,%mem --sort=-%mem | head');
  } else if (usedPct !== null && usedPct >= 85) {
    status = 'warn';
    hints.push('Memory pressure is high; consider stopping non-essential services or adding swap/RAM.');
  }
  if (swapPct !== null && swapPct >= 90 && swapUsed > 0) {
    if (status === 'ok') status = 'warn';
    hints.push('Swap is heavily used; the machine may be thrashing.');
  }
  if (swapTotal !== null && swapTotal > 0) {
    detail += ` Swap: ${formatBytes(swapUsed)} of ${formatBytes(swapTotal)} used (${swapPct === null ? '?' : swapPct}%).`;
  }
  return finding(status, 'memory', 'system', 'Memory and swap', detail, {
    hint: hints.join(' '),
    data: { total, available, usedPct, swapTotal, swapUsed, swapPct },
  });
}

function collectDisk(deps) {
  if (!deps.which('df')) {
    return [finding('skip', 'disk', 'disk', 'Disk usage', 'df is not available; disk usage could not be inspected.')];
  }
  const space = deps.run('df', ['-P', '-k'], { timeout: 5000, env: cLocale(deps) });
  if (!space.ok) {
    return [finding('warn', 'disk', 'disk', 'Disk usage', 'df failed; disk usage could not be inspected.', {
      confidence: 'probable',
      data: { error: space.stderr || space.error },
    })];
  }
  const rows = parseDf(space.stdout);
  const inodesOut = deps.run('df', ['-P', '-i'], { timeout: 5000, env: cLocale(deps) });
  const inodeRows = inodesOut.ok ? parseDf(inodesOut.stdout, { inodes: true }) : [];
  const inodesByMount = new Map(inodeRows.map((row) => [row.mount, row]));
  const findings = [];
  const worstSpace = rows.reduce((a, b) => (!a || b.usePct > a.usePct ? b : a), null);
  const full = rows.filter((row) => row.usePct >= 95);
  const tight = rows.filter((row) => row.usePct >= 85 && row.usePct < 95);
  if (full.length) {
    findings.push(finding('fail', 'disk.full', 'disk', 'Disk space exhausted', full
      .slice(0, MAX_FINDING_LIST)
      .map((row) => `${row.mount} (${row.filesystem}) is ${row.usePct}% full, ${formatBytes(row.available * 1024)} free.`)
      .join(' '), {
      hint: 'Free space before other repairs; find large files with: du -xhd1 / | sort -h | tail',
      data: { filesystems: full },
    }));
  } else if (tight.length) {
    findings.push(finding('warn', 'disk.tight', 'disk', 'Disk space is running low', tight
      .slice(0, MAX_FINDING_LIST)
      .map((row) => `${row.mount} (${row.filesystem}) is ${row.usePct}% full, ${formatBytes(row.available * 1024)} free.`)
      .join(' '), {
      hint: 'Free space soon; start with: du -xhd1 /var | sort -h | tail',
      data: { filesystems: tight },
    }));
  } else {
    findings.push(finding('ok', 'disk', 'disk', 'Disk space',
      `Enough free space (worst: ${worstSpace ? `${worstSpace.mount} at ${worstSpace.usePct}%` : 'no local filesystems detected'}).`));
  }

  const inodes = [...inodesByMount.values()];
  const fullInodes = inodes.filter((row) => row.usePct >= 95);
  const tightInodes = inodes.filter((row) => row.usePct >= 85 && row.usePct < 95);
  if (fullInodes.length) {
    findings.push(finding('fail', 'disk.inodes', 'disk', 'Inode exhaustion', fullInodes
      .slice(0, MAX_FINDING_LIST)
      .map((row) => `${row.mount} is ${row.usePct}% of inodes used.`)
      .join(' '), {
      hint: 'Find directories with many files: find /var -xdev -printf "%h\\n" | sort | uniq -c | sort -n | tail',
      data: { filesystems: fullInodes },
    }));
  } else if (tightInodes.length) {
    findings.push(finding('warn', 'disk.inodes', 'disk', 'Inode usage is high', tightInodes
      .slice(0, MAX_FINDING_LIST)
      .map((row) => `${row.mount} is ${row.usePct}% of inodes used.`)
      .join(' '), {
      data: { filesystems: tightInodes },
    }));
  }
  return findings;
}

function collectServices(deps, host) {
  if (!host.systemd) {
    return [finding('skip', 'services', 'services', 'System services',
      'systemd is not available or not running; service checks were skipped.')];
  }
  const res = deps.run('systemctl', ['--failed', '--no-legend', '--plain'], { timeout: 5000 });
  if (!res.ok) {
    return [finding('warn', 'services', 'services', 'System services',
      'Failed services could not be queried with systemctl.', {
        confidence: 'probable',
        data: { error: res.stderr || res.error },
      })];
  }
  const units = parseFailedUnits(res.stdout);
  if (units.length === 0) {
    return [finding('ok', 'services', 'services', 'System services', 'No failed systemd units reported.')];
  }
  return [finding('fail', 'services.failed', 'services', 'Failed system services', units
    .slice(0, MAX_FINDING_LIST)
    .map((unit) => `${unit} is failed.`)
    .join(' '), {
    hint: 'Inspect with: systemctl status <unit> and journalctl -u <unit> -n 50 --no-pager',
    data: { units },
  })];
}

function collectNetwork(deps, host) {
  const findings = [];
  if (!host.capabilities.ip) {
    findings.push(finding('skip', 'network', 'network', 'Network interfaces',
      'iproute2 (ip) is not available; network diagnostics are unsupported on this system.'));
    return { findings, interfaces: [], routes: [], nameservers: [], probe: null };
  }

  const addrRes = deps.run('ip', ['-json', 'addr', 'show'], { timeout: 4000 });
  let interfaces = parseInterfaces(parseIpJson(addrRes.stdout));
  if (!addrRes.ok || interfaces.length === 0) {
    const fallback = deps.run('ip', ['-o', 'addr', 'show'], { timeout: 4000 });
    interfaces = parseIpO(fallback.stdout);
  }
  const physical = interfaces.filter((iface) => iface.name !== 'lo' && !iface.flags.includes('LOOPBACK'));
  if (physical.length === 0) {
    findings.push(finding('fail', 'network.no-interface', 'network', 'No network interface detected',
      'Only the loopback interface is present. The machine has no usable network interface.'));
  } else {
    const down = physical.filter((iface) => iface.operstate === 'down' || iface.operstate === 'lowerlayerdown');
    const noAddress = physical.filter((iface) => iface.operstate !== 'down' && !interfaceHasAddress(iface));
    if (down.length === 0 && noAddress.length === 0) {
      findings.push(finding('ok', 'network.interfaces', 'network', 'Network interfaces',
        physical.map((iface) => `${iface.name} ${iface.operstate}${iface.addresses.length ? ` (${iface.addresses.length} address${iface.addresses.length === 1 ? '' : 'es'})` : ''}`).join(', '), {
        data: { interfaces: physical },
      }));
    } else {
      const parts = [];
      if (down.length) parts.push(`Down: ${down.map((iface) => iface.name).join(', ')}.`);
      if (noAddress.length) parts.push(`No address: ${noAddress.map((iface) => iface.name).join(', ')}.`);
      findings.push(finding('warn', 'network.interfaces', 'network', 'A network interface needs attention',
        parts.join(' '), {
        hint: 'Check the cable/Wi-Fi link and the backend state: ip link, nmcli device status or networkctl status.',
        data: { interfaces: physical },
      }));
    }
  }

  const routeRes = deps.run('ip', ['-json', 'route', 'show', 'default'], { timeout: 3000 });
  let routes = routeRes.ok ? parseDefaultRoutes(routeRes.stdout) : [];
  if (routes.length === 0) {
    const fallback = deps.run('ip', ['route', 'show', 'default'], { timeout: 3000 });
    routes = parseDefaultRoutesText(fallback.stdout);
  }
  if (routes.length === 0) {
    findings.push(finding('fail', 'network.no-route', 'network', 'No default route configured',
      'The machine has no default route, so traffic to other networks cannot leave the host.', {
        hint: 'Check the interface configuration and the network backend (nmcli, networkctl or the VPS console).',
      }));
  } else {
    const route = routes[0];
    const byName = new Map(physical.map((iface) => [iface.name, iface]));
    const routeIface = route.dev ? byName.get(route.dev) : null;
    const routeDown = routeIface && routeIface.operstate === 'down';
    findings.push(finding(routeDown ? 'fail' : 'ok', 'network.route', 'network', 'Default route',
      routeDown
        ? `The default route uses ${route.dev}, which is down.`
        : `Default route via ${route.dev || '?'}${route.gateway ? ` (gateway ${route.gateway})` : ''}.`, {
        hint: routeDown ? 'Bring the interface up or reconnect the network backend.' : undefined,
        data: { routes },
      }));
  }

  const nameservers = parseResolvConf(readText(deps, '/etc/resolv.conf'));
  if (nameservers.length === 0) {
    findings.push(finding('warn', 'network.dns-config', 'network', 'No DNS nameservers configured',
      '/etc/resolv.conf contains no nameserver entries.', {
        confidence: 'probable',
        hint: 'Configure DNS via NetworkManager, systemd-resolved or /etc/resolv.conf; do not overwrite a managed file blindly.',
      }));
  } else {
    findings.push(finding('ok', 'network.dns-config', 'network', 'DNS configuration',
      `Configured nameservers: ${nameservers.join(', ')}.`));
  }

  let probe = null;
  if (routes.length > 0 && host.capabilities.getent) {
    const probeName = (deps.env && deps.env.CITADEL_DNS_PROBE) || 'example.com';
    const dns = deps.run('getent', ['hosts', probeName], { timeout: 5000 });
    probe = { name: probeName, dnsOk: dns.ok, dnsOutput: dns.stdout };
    if (!dns.ok) {
      findings.push(finding('fail', 'network.dns', 'network', 'DNS resolution failing',
        `The system resolver could not resolve ${probeName}. This is an observation from this host; the cause may be the local resolver, the upstream DNS server or Internet reachability.`, {
        hint: 'Check the resolver service (/etc/resolv.conf, resolvectl status) and try a different resolver only if you control it.',
        data: { nameservers, probe: probeName },
      }));
    } else {
      findings.push(finding('ok', 'network.dns', 'network', 'DNS resolution',
        `Resolved ${probeName} via the configured resolver.`));
    }
  } else if (routes.length === 0) {
    findings.push(finding('skip', 'network.dns', 'network', 'DNS resolution',
      'Skipped because there is no default route.'));
  } else {
    findings.push(finding('skip', 'network.dns', 'network', 'DNS resolution',
      'getent is not available; DNS resolution could not be tested.'));
  }

  const gateway = routes[0] && routes[0].gateway;
  if (gateway && host.capabilities.ping) {
    const pingArgs = deps.platform === 'darwin'
      ? ['-c', '1', '-W', '2000', gateway]
      : ['-c', '1', '-W', '2', gateway];
    const ping = deps.run('ping', pingArgs, { timeout: 4000 });
    findings.push(finding(ping.ok ? 'ok' : 'warn', 'network.gateway-ping', 'network', 'Default gateway reachability',
      ping.ok
        ? `The default gateway ${gateway} answered ICMP.`
        : `The default gateway ${gateway} did not answer ICMP. This alone does not prove the Internet is unavailable; ICMP is often filtered or the gateway may be down.`, {
        confidence: 'probable',
        data: { gateway },
      }));
  } else if (gateway) {
    findings.push(finding('skip', 'network.gateway-ping', 'network', 'Default gateway reachability',
      'ping is not available; gateway reachability was not tested.'));
  }

  if (routes.length > 0 && host.capabilities.curl) {
    const target = (deps.env && deps.env.CITADEL_HTTP_PROBE) || 'https://example.com';
    const http = deps.run('curl', ['-fsS', '-o', '/dev/null', '--max-time', '3', target], { timeout: 5000 });
    probe = { ...(probe || {}), httpOk: http.ok, httpTarget: target };
    findings.push(finding(http.ok ? 'ok' : 'warn', 'network.http', 'network', 'External connectivity',
      http.ok
        ? `An HTTPS request to ${target} succeeded.`
        : `An HTTPS request to ${target} did not succeed. Local findings (route/DNS/gateway) should be interpreted together; Internet connectivity could not be confirmed.`, {
        confidence: 'probable',
        data: { target },
      }));
  } else if (routes.length > 0) {
    findings.push(finding('skip', 'network.http', 'network', 'External connectivity',
      'curl is not available; outbound HTTPS was not tested.'));
  }

  return { findings, interfaces: physical, routes, nameservers, probe };
}

function parseIpO(text) {
  const interfaces = [];
  if (!text) return interfaces;
  for (const line of text.split('\n')) {
    const head = line.match(/^\d+:\s+([^:@\s]+)(?:@\S+)?:?\s*(.*)$/);
    if (!head) continue;
    const name = head[1];
    const rest = head[2] || '';
    const flagMatch = rest.match(/<([^>]*)>/);
    const flags = flagMatch ? flagMatch[1].split(',').filter(Boolean) : [];
    const stateMatch = rest.match(/\bstate\s+(\S+)/);
    const existing = interfaces.find((iface) => iface.name === name);
    const iface = existing || {
      name,
      operstate: stateMatch ? stateMatch[1].toLowerCase() : 'unknown',
      flags,
      addresses: [],
    };
    if (existing && flags.length > 0) iface.flags = flags;
    const inet = line.match(/inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    if (inet) iface.addresses.push({ family: 'inet', address: inet[1], prefixlen: Number(inet[2]), scope: 'global' });
    const inet6 = line.match(/inet6\s+([0-9a-f:]+)\/(\d+)/i);
    if (inet6) iface.addresses.push({ family: 'inet6', address: inet6[1], prefixlen: Number(inet6[2]), scope: 'global' });
    if (!existing) interfaces.push(iface);
  }
  return interfaces;
}

function collectWifi(deps, host) {
  const findings = [];
  const wireless = host.wireless || [];
  if (deps.platform !== 'linux') {
    return {
      findings: [finding('skip', 'wifi', 'wifi', 'Wi-Fi', 'Wi-Fi diagnostics are implemented for Linux only.')],
      hardware: [],
      blocked: null,
      networks: [],
      nmcli: false,
    };
  }
  if (wireless.length === 0) {
    return {
      findings: [finding('skip', 'wifi.hardware', 'wifi', 'Wi-Fi hardware',
        'No wireless interface detected. This is expected on a VPS and does not affect wired networking.')],
      hardware: [],
      blocked: null,
      networks: [],
      nmcli: false,
    };
  }
  if (!host.capabilities.nmcli) {
    return {
      findings: [finding('skip', 'wifi.manager', 'wifi', 'Wi-Fi management',
        `Wireless hardware (${wireless.join(', ')}) is present, but NetworkManager/nmcli is not available. Diagnosis and connection changes are unsupported on this system.`, {
          hint: 'Install NetworkManager only if this machine is meant to use it; do not reconfigure the network blindly.',
        })],
      hardware: wireless,
      blocked: null,
      networks: [],
      nmcli: false,
    };
  }

  const radio = deps.run('nmcli', ['radio', 'wifi'], { timeout: 3000 });
  if (radio.ok && /disabled/i.test(radio.stdout)) {
    findings.push(finding('warn', 'wifi.radio', 'wifi', 'Wi-Fi radio is disabled',
      'NetworkManager reports that the Wi-Fi radio is disabled.', {
        hint: 'Enable it with: nmcli radio wifi on',
      }));
  }

  let blocked = null;
  if (host.capabilities.rfkill) {
    const rf = deps.run('rfkill', ['list', 'wifi'], { timeout: 3000, env: cLocale(deps) });
    if (rf.ok) {
      const devices = parseRfkill(rf.stdout);
      const soft = devices.some((d) => d.soft);
      const hard = devices.some((d) => d.hard);
      if (hard) {
        blocked = 'hard';
        findings.push(finding('warn', 'wifi.blocked', 'wifi', 'Wi-Fi is hard-blocked',
          'The wireless radio is blocked by a hardware switch or firmware setting; software cannot unblock it.', {
            hint: 'Check the physical switch/BIOS/firmware setting. A VPS or server without Wi-Fi is unaffected.',
          }));
      } else if (soft) {
        blocked = 'soft';
        findings.push(finding('warn', 'wifi.blocked', 'wifi', 'Wi-Fi is soft-blocked',
          'The wireless radio is soft-blocked (rfkill). Software can unblock it, but that changes radio state.', {
            hint: 'Run: citadel repair (requires confirmation and usually sudo).',
          }));
      }
    } else {
      findings.push(finding('warn', 'wifi.blocked-state', 'wifi', 'Wi-Fi block state is unverified',
        'rfkill is installed but did not report the radio state.', {
          confidence: 'probable',
          hint: 'Check: rfkill list (and firmware/driver state).',
        }));
    }
  }

  const devRes = deps.run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device', 'status'], { timeout: 3000 });
  const devices = parseNmcliDevices(devRes.stdout).filter((d) => d.type === 'wifi');
  if (!devRes.ok) {
    findings.push(finding('warn', 'wifi.manager-state', 'wifi', 'NetworkManager is not responding',
      'nmcli is installed, but the NetworkManager daemon did not answer.', {
        confidence: 'probable',
        hint: 'Check: systemctl status NetworkManager. Do not edit its configuration blindly.',
      }));
  } else if (devices.length === 0) {
    findings.push(finding('warn', 'wifi.manager-state', 'wifi', 'NetworkManager does not manage a Wi-Fi device',
      `Wireless hardware was detected (${wireless.join(', ')}), but nmcli reports no Wi-Fi device.`, {
        confidence: 'probable',
        hint: 'Check: nmcli device status and whether the driver/firmware is loaded.',
      }));
  } else {
    const connected = devices.filter((d) => /^connected\b/i.test(d.state));
    const disconnected = devices.filter((d) => /^disconnected\b/i.test(d.state));
    if (connected.length > 0) {
      findings.push(finding('ok', 'wifi.state', 'wifi', 'Wi-Fi connection',
        `Connected on ${connected.map((d) => d.device).join(', ')}.`));
    } else if (disconnected.length > 0) {
      findings.push(finding('warn', 'wifi.state', 'wifi', 'Wi-Fi is not connected',
        `Wireless interface${disconnected.length === 1 ? '' : 's'} ${disconnected.map((d) => d.device).join(', ')} ${disconnected.length === 1 ? 'is' : 'are'} disconnected.`, {
          hint: 'List networks with: citadel wifi list; connect with: citadel wifi connect',
        }));
    } else {
      findings.push(finding('warn', 'wifi.state', 'wifi', 'Wi-Fi is unavailable',
        `Wireless interface state: ${devices.map((d) => `${d.device}=${d.state}`).join(', ')}.`));
    }
  }

  return { findings, hardware: wireless, blocked, networks: [], nmcli: true };
}

function collectContainers(deps) {
  const findings = [];
  if (deps.which('docker')) {
    const res = deps.run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000 });
    if (res.ok) {
      findings.push(finding('ok', 'containers.docker', 'containers', 'Docker',
        `Docker daemon reachable (server ${res.stdout || 'unknown'}).`));
    } else {
      findings.push(finding('warn', 'containers.docker', 'containers', 'Docker is not reachable',
        'The docker CLI is installed but the daemon did not respond.', {
          confidence: 'probable',
          hint: 'Check: systemctl status docker (or the rootless service) and the user socket permissions.',
        }));
    }
  }
  if (deps.which('podman')) {
    const res = deps.run('podman', ['info', '--format', '{{.Version.Version}}'], { timeout: 4000 });
    if (res.ok) {
      findings.push(finding('ok', 'containers.podman', 'containers', 'Podman',
        `Podman reachable (version ${res.stdout || 'unknown'}).`));
    } else {
      findings.push(finding('warn', 'containers.podman', 'containers', 'Podman is not reachable',
        'The podman CLI is installed but its service/rootless setup did not respond.', {
          confidence: 'probable',
          hint: 'Check: podman info and the rootless user namespace configuration.',
        }));
    }
  }
  if (findings.length === 0) {
    findings.push(finding('skip', 'containers', 'containers', 'Containers',
      'Docker/Podman are not installed (optional).'));
  }
  return findings;
}

function collectCitadel(deps) {
  const findings = [];
  const appDir = path.resolve(__dirname, '..');
  const packageFile = path.join(appDir, 'package.json');
  let version = '?';
  try {
    version = JSON.parse(deps.fs.readFileSync(packageFile, 'utf8')).version || '?';
  } catch {}

  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  findings.push(finding(nodeMajor >= 18 ? 'ok' : 'fail', 'citadel.node', 'citadel', 'Node.js runtime',
    `${process.version}${nodeMajor >= 18 ? ' (compatible)' : ' (requires Node.js >= 18 LTS)'}`));

  if (deps.platform === 'linux') {
    const tmux = deps.which('tmux') ? deps.run('tmux', ['-V'], { timeout: 3000 }) : null;
    findings.push(finding(tmux && tmux.ok ? 'ok' : 'warn', 'citadel.tmux', 'citadel', 'Terminal persistence (tmux)',
      tmux && tmux.ok
        ? tmux.stdout
        : 'tmux is not available; terminals will use a direct PTY and will not survive Citadel restarts.', {
        hint: 'Install tmux for persistent terminals.',
      }));
  }

  const git = deps.which('git') ? deps.run('git', ['--version'], { timeout: 3000 }) : null;
  findings.push(finding(git && git.ok ? 'ok' : 'fail', 'citadel.git', 'citadel', 'Git CLI',
    git && git.ok ? git.stdout : 'git is not available in PATH; project and agent workflows may fail.'));

  const dataDir = (deps.env && deps.env.DATA_DIR) || path.join(appDir, 'data');
  if (exists(deps, dataDir)) {
    try {
      deps.fs.accessSync(dataDir, deps.fs.constants.W_OK);
      findings.push(finding('ok', 'citadel.data', 'citadel', 'Citadel data directory', `Writable: ${dataDir}`));
    } catch {
      // The data directory belongs to the service account, so running the
      // doctor as another (non-root) user cannot write it by design. Judge it
      // by its owner's permissions instead of reporting a false failure.
      let st = null;
      try {
        st = deps.fs.statSync(dataDir);
      } catch {}
      if (st && deps.uid !== null && deps.uid !== st.uid && (st.mode & 0o200)) {
        const owner = userName(deps, st.uid);
        findings.push(finding('ok', 'citadel.data', 'citadel', 'Citadel data directory',
          `Writable by its owner ${owner}: ${dataDir} (checked as ${userName(deps, deps.uid)}).`));
      } else {
        findings.push(finding('fail', 'citadel.data', 'citadel', 'Citadel data directory',
          `Not writable: ${dataDir}`, { hint: 'Check ownership and permissions of the service data directory.' }));
      }
    }
  } else {
    findings.push(finding('skip', 'citadel.data', 'citadel', 'Citadel data directory',
      `Not initialized at ${dataDir} (running from a source checkout?).`));
  }

  const vendorFiles = ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-web-links.js', 'jsQR.js'];
  const vendorDir = path.join(appDir, 'public', 'vendor');
  const missing = vendorFiles.filter((file) => !exists(deps, path.join(vendorDir, file)));
  findings.push(finding(missing.length === 0 ? 'ok' : 'fail', 'citadel.vendor', 'citadel', 'Local browser assets',
    missing.length === 0
      ? 'All vendor bundles are present in public/vendor (no CDNs).'
      : `Missing: ${missing.join(', ')}. Run: npm run postinstall`, {
      data: { missing },
    }));

  if (deps.platform === 'linux' && deps.which('systemctl')) {
    const hasUnit = unitExists(deps, 'citadel');
    if (hasUnit) {
      const active = deps.run('systemctl', ['is-active', 'citadel'], { timeout: 3000 });
      findings.push(finding(active.stdout === 'active' ? 'ok' : 'fail', 'citadel.service', 'citadel', 'Citadel service',
        `citadel.service is ${active.stdout || 'unknown'}.`));
      const show = deps.run('systemctl', ['show', 'citadel', '-p', 'KillMode'], { timeout: 3000 });
      const killMode = parseKillMode(show.stdout);
      if (killMode) {
        findings.push(finding(killMode === 'process' ? 'ok' : 'warn', 'citadel.killmode', 'citadel', 'systemd KillMode',
          killMode === 'process'
            ? 'KillMode=process (tmux sessions survive service restarts).'
            : `KillMode=${killMode}; the whole cgroup (including tmux) is killed on restart.`, {
            hint: 'Install scripts/citadel.service or add a KillMode=process drop-in.',
          }));
      }
    } else {
      findings.push(finding('skip', 'citadel.service', 'citadel', 'Citadel service',
        'citadel.service is not installed (running from a source checkout).'));
    }
  }

  const detectedAgents = ['claude', 'codex', 'opencode', 'agy', 'kilo', 'qwen'].filter((agent) => deps.which(agent));
  findings.push(detectedAgents.length > 0
    ? finding('ok', 'citadel.agents', 'citadel', 'CLI agents', detectedAgents.join(', '))
    : finding('skip', 'citadel.agents', 'citadel', 'CLI agents',
      'No optional CLI agent is installed; Citadel works without one.'));

  findings.push(finding('ok', 'citadel.version', 'citadel', 'Citadel version', `v${version}`));
  return findings;
}

function unitExists(deps, name) {
  if (exists(deps, `/etc/systemd/system/${name}.service`)) return true;
  if (exists(deps, `/lib/systemd/system/${name}.service`)) return true;
  if (!deps.which('systemctl')) return false;
  const res = deps.run('systemctl', ['cat', `${name}.service`], { timeout: 3000 });
  return res.ok;
}

function parseKillMode(text) {
  const match = String(text || '').match(/KillMode=(\S+)/);
  return match ? match[1] : null;
}

function collectDoctor(deps) {
  const host = collectHost(deps);
  const network = collectNetwork(deps, host);
  const wifi = collectWifi(deps, host);
  const findings = [
    collectLoad(deps),
    collectMemory(deps),
    ...collectDisk(deps),
    ...collectServices(deps, host),
    ...network.findings,
    ...wifi.findings,
    ...collectContainers(deps),
    ...collectCitadel(deps),
  ];
  return {
    kind: 'doctor',
    generatedAt: deps.now().toISOString(),
    host,
    network: {
      interfaces: network.interfaces,
      routes: network.routes,
      nameservers: network.nameservers,
      probe: network.probe,
      wifi: {
        hardware: wifi.hardware,
        blocked: wifi.blocked,
        nmcli: wifi.nmcli,
      },
    },
    findings,
    summary: summarize(findings),
  };
}

function collectNetworkReport(deps) {
  const host = collectHost(deps);
  const network = collectNetwork(deps, host);
  const wifi = collectWifi(deps, host);
  const findings = [...network.findings, ...wifi.findings];
  return {
    kind: 'network',
    generatedAt: deps.now().toISOString(),
    host,
    interfaces: network.interfaces,
    routes: network.routes,
    nameservers: network.nameservers,
    probe: network.probe,
    wifi: {
      hardware: wifi.hardware,
      blocked: wifi.blocked,
      nmcli: wifi.nmcli,
    },
    findings,
    summary: summarize(findings),
  };
}

function exitCodeFor(report) {
  return report.summary.fail > 0 ? 1 : 0;
}

module.exports = {
  createDeps,
  finding,
  summarize,
  formatBytes,
  pct,
  parseMeminfo,
  parseDf,
  parseDefaultRoutes,
  parseDefaultRoutesText,
  parseInterfaces,
  parseIpO,
  parseResolvConf,
  parseFailedUnits,
  parseRfkill,
  parseNmcliWifi,
  parseNmcliDevices,
  parseNmcliConnections,
  splitNmcli,
  collectHost,
  collectLoad,
  collectMemory,
  collectDisk,
  collectServices,
  collectNetwork,
  collectWifi,
  collectContainers,
  collectCitadel,
  collectDoctor,
  collectNetworkReport,
  exitCodeFor,
};
