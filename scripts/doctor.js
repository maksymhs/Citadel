#!/usr/bin/env node
/**
 * Citadel local diagnostics and recovery CLI.
 *
 * Commands (also available through `citadel`):
 *   doctor [--json]                 read-only host + Citadel overview
 *   network [--json]                detailed network/Wi-Fi diagnosis
 *   wifi list [--json]              list visible networks (NetworkManager)
 *   wifi connect [SSID]             connect to a saved or new network
 *   repair [--json]                 list supported fixes
 *   repair --action=<id>            apply one fix (asks for confirmation)
 *
 * Everything works locally and does not require Citadel's web server, an API,
 * DNS, GitHub or Internet access (some probes are skipped or reported as
 * "could not confirm" when the network is unavailable).
 */
const { spawnSync } = require('node:child_process');
const diagnostics = require('./diagnostics');

const EXIT_OK = 0;
const EXIT_PROBLEMS = 1;
const EXIT_USAGE = 2;

const HELP = `Citadel local diagnostics

  citadel doctor [--json]              Read-only host, network and Citadel checks
  citadel network [--json]             Detailed interface, route, DNS and Wi-Fi state
  citadel wifi list [--json]           List visible Wi-Fi networks (nmcli)
  citadel wifi connect [SSID]          Connect to a saved profile or a new network
  citadel wifi connect --ssid=<SSID>   Same, without positional parsing
  citadel repair [--json]              List supported recovery actions
  citadel repair --action=<id>         Apply one action (confirmation required)
  citadel help                         Show this help

Options:
  --json             Machine-readable output (no prompts for read-only commands)
  --yes              Skip the ordinary confirmation; remote-sensitive actions also
                     require --confirm-remote
  --confirm-remote   Explicitly allow a network change while connected over SSH
  --no-color         Disable ANSI colours

Exit codes: 0 = no confirmed problem / action verified, 1 = problem or failed
action, 2 = invalid usage. Missing optional tools are reported as skipped, not
fatal. Wi-Fi is optional: a VPS without wireless hardware works normally.

Passwords are never accepted on the command line or written to logs/JSON. New
Wi-Fi networks are connected with "nmcli --ask", which prompts on the terminal.
`;

function createIO(overrides = {}) {
  return {
    stdout: overrides.stdout || ((text) => process.stdout.write(text)),
    stderr: overrides.stderr || ((text) => process.stderr.write(text)),
    prompt: overrides.prompt || null,
    isTTY: overrides.isTTY !== undefined ? overrides.isTTY : !!process.stdout.isTTY,
    env: overrides.env || process.env,
    color: overrides.color !== undefined
      ? overrides.color
      : (!!process.stdout.isTTY && !(overrides.env || process.env).NO_COLOR),
  };
}

function defaultInteractive(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    timeout: opts.timeout === undefined ? 120000 : opts.timeout,
    env: opts.env,
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    error: res.error ? res.error.code || res.error.message : null,
  };
}

async function ask(io, question) {
  if (io.prompt) return io.prompt(question);
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function write(io, text = '') {
  io.stdout(text.endsWith('\n') ? text : `${text}\n`);
}

function colorize(io, code, text) {
  if (!io.color) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function printable(text) {
  return String(text).replace(/[\x00-\x1f\x7f]/g, '?');
}

function statusLabel(io, status) {
  switch (status) {
    case 'ok': return colorize(io, '32', '[OK]  ');
    case 'warn': return colorize(io, '33', '[WARN]');
    case 'fail': return colorize(io, '31', '[FAIL]');
    default: return colorize(io, '90', '[SKIP]');
  }
}

function printFinding(io, item) {
  const probable = item.confidence && item.confidence !== 'confirmed' ? ' (probable)' : '';
  write(io, `${statusLabel(io, item.status)} ${item.title} — ${item.detail}${probable}`);
  if (item.hint && (item.status === 'fail' || item.status === 'warn')) {
    write(io, `       ${colorize(io, '90', item.hint)}`);
  }
}

function printReport(io, report) {
  const host = report.host;
  const distro = host.distro ? `${host.distro.name}${host.distro.version ? ` ${host.distro.version}` : ''}` : 'unknown distribution';
  write(io, colorize(io, '1', `Citadel ${report.kind} — ${host.hostname}`));
  write(io, `Host: ${host.platform} ${host.kernel} ${host.arch} · ${distro} · Node ${host.node}`);
  const caps = Object.entries(host.capabilities || {})
    .filter(([, value]) => value === true)
    .map(([key]) => key)
    .join(', ');
  if (caps) write(io, `Detected: ${caps}`);
  write(io, '');

  const order = ['system', 'disk', 'memory', 'services', 'network', 'wifi', 'containers', 'citadel'];
  const grouped = new Map();
  for (const item of report.findings) {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category).push(item);
  }
  for (const category of order) {
    const items = grouped.get(category);
    if (!items || items.length === 0) continue;
    write(io, colorize(io, '1', category.toUpperCase()));
    for (const item of items) printFinding(io, item);
    write(io, '');
  }

  if (report.kind === 'network' && Array.isArray(report.interfaces) && report.interfaces.length > 0) {
    write(io, colorize(io, '1', 'INTERFACES'));
    for (const iface of report.interfaces) {
      const addrs = iface.addresses.map((a) => `${a.address}/${a.prefixlen}`).join(', ') || 'no address';
      write(io, `  ${iface.name}  ${iface.operstate}  ${addrs}`);
    }
    if (report.routes && report.routes.length > 0) {
      write(io, `  default via ${report.routes[0].gateway || '?'} dev ${report.routes[0].dev || '?'}`);
    }
    if (report.nameservers && report.nameservers.length > 0) {
      write(io, `  DNS: ${report.nameservers.join(', ')}`);
    }
    write(io, '');
  }

  const s = report.summary;
  const summary = `Summary: ${s.ok} ok, ${s.warn} warning${s.warn === 1 ? '' : 's'}, ${s.fail} failure${s.fail === 1 ? '' : 's'}, ${s.skip} skipped.`;
  write(io, s.fail > 0 ? colorize(io, '31', summary) : colorize(io, '1', summary));
  if (s.fail > 0 || s.warn > 0) {
    write(io, 'Run "citadel repair" to see supported fixes, or read the hints above.');
  }
}

function parseArgs(argv) {
  const parsed = { command: null, subcommand: null, positional: [], flags: new Set(), action: null, ssid: null };
  for (const arg of argv) {
    if (arg === '--json' || arg === '--yes' || arg === '--confirm-remote'
      || arg === '--no-color' || arg === '--help' || arg === '-h') {
      parsed.flags.add(arg);
    } else if (arg.startsWith('--action=')) {
      parsed.action = arg.slice('--action='.length);
      parsed.flags.add('--action');
      if (!parsed.action) {
        const err = new Error('--action requires a non-empty action id.');
        err.exitCode = EXIT_USAGE;
        throw err;
      }
    } else if (arg.startsWith('--ssid=')) {
      parsed.ssid = arg.slice('--ssid='.length);
      parsed.flags.add('--ssid');
    } else if (arg.startsWith('-')) {
      const err = new Error(`Unknown option: ${arg}`);
      err.exitCode = EXIT_USAGE;
      throw err;
    } else if (!parsed.command) {
      parsed.command = arg;
    } else if (!parsed.subcommand && parsed.command === 'wifi') {
      parsed.subcommand = arg;
    } else {
      parsed.positional.push(arg);
    }
  }
  if (!parsed.command) parsed.command = 'doctor';
  const wifiConnect = parsed.command === 'wifi' && parsed.subcommand === 'connect';
  if (parsed.action && parsed.command !== 'repair') {
    const err = new Error('--action is only valid with "repair".');
    err.exitCode = EXIT_USAGE;
    throw err;
  }
  if (parsed.ssid && !wifiConnect) {
    const err = new Error('--ssid is only valid with "wifi connect".');
    err.exitCode = EXIT_USAGE;
    throw err;
  }
  if (parsed.flags.has('--ssid') && !parsed.ssid) {
    const err = new Error('--ssid requires a non-empty network name.');
    err.exitCode = EXIT_USAGE;
    throw err;
  }
  if (wifiConnect) {
    if (parsed.positional.length > 1 || (parsed.ssid && parsed.positional.length > 0)) {
      const err = new Error('Pass exactly one SSID, optionally quoted or via --ssid=<SSID>.');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
  } else if (parsed.positional.length > 0) {
    const err = new Error(`Unexpected argument: ${parsed.positional[0]}`);
    err.exitCode = EXIT_USAGE;
    throw err;
  }
  return parsed;
}

function jsonOut(io, data) {
  io.stdout(`${JSON.stringify(data, null, 2)}\n`);
}

function wifiSummary(wifi) {
  return {
    supported: !!wifi.nmcli && (wifi.hardware || []).length > 0,
    hardware: wifi.hardware || [],
    blocked: wifi.blocked || null,
    manager: wifi.nmcli ? 'NetworkManager' : null,
  };
}

async function commandDoctor(parsed, io, deps) {
  const report = diagnostics.collectDoctor(deps);
  if (parsed.flags.has('--json')) jsonOut(io, report);
  else printReport(io, report);
  return diagnostics.exitCodeFor(report);
}

async function commandNetwork(parsed, io, deps) {
  const report = diagnostics.collectNetworkReport(deps);
  if (parsed.flags.has('--json')) jsonOut(io, report);
  else printReport(io, report);
  return diagnostics.exitCodeFor(report);
}

async function listWifiNetworks(deps, host) {
  const res = deps.run('nmcli', [
    '-t', '-f', 'IN-USE,SSID,SECURITY,SIGNAL', 'device', 'wifi', 'list', '--rescan', 'yes',
  ], { timeout: 20000 });
  return {
    ok: res.ok,
    error: res.ok ? null : (res.stderr || res.error || 'nmcli failed'),
    networks: res.ok ? diagnostics.parseNmcliWifi(res.stdout) : [],
  };
}

async function commandWifiList(parsed, io, deps) {
  const host = diagnostics.collectHost(deps);
  const wifi = diagnostics.collectWifi(deps, host);
  const report = {
    kind: 'wifi-list',
    generatedAt: deps.now().toISOString(),
    host,
    ...wifiSummary(wifi),
    findings: wifi.findings,
    networks: [],
    error: null,
  };

  if (report.supported) {
    const list = await listWifiNetworks(deps, host);
    report.networks = list.networks;
    report.error = list.error;
  }

  if (parsed.flags.has('--json')) {
    jsonOut(io, report);
  } else {
    for (const item of wifi.findings) printFinding(io, item);
    if (!report.supported) {
      write(io, 'Wi-Fi listing is not supported on this system.');
    } else if (report.error) {
      write(io, colorize(io, '31', `Could not scan networks: ${report.error}`));
    } else if (report.networks.length === 0) {
      write(io, 'No networks were reported. Try again after moving closer to an access point.');
    } else {
      write(io, '');
      write(io, colorize(io, '1', 'AVAILABLE NETWORKS'));
      report.networks.forEach((net, index) => {
        const marker = net.inUse ? ' *' : '';
        write(io, `  ${String(index + 1).padStart(2)}. ${printable(net.ssid)}${marker}  ${printable(net.security)}  ${net.signal}%`);
      });
      write(io, '\nConnect with: citadel wifi connect');
    }
  }

  if (!report.supported) return EXIT_OK;
  return report.error ? EXIT_PROBLEMS : EXIT_OK;
}

function validateSsid(ssid) {
  if (typeof ssid !== 'string') return 'An SSID is required.';
  if (ssid.length === 0 || ssid.length > 128) return 'The SSID must be between 1 and 128 characters.';
  if (/[\x00-\x1f\x7f]/.test(ssid)) return 'The SSID contains control characters.';
  return null;
}

function parseSshConnection(env) {
  const raw = String((env && env.SSH_CONNECTION) || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  if (parts.length < 4) return { remote: true, clientIp: null, serverIp: null };
  return { remote: true, clientIp: parts[0], clientPort: parts[1], serverIp: parts[2], serverPort: parts[3] };
}

function isWirelessIface(host, name) {
  return (host.wireless || []).includes(name);
}

function sshOverWireless(host, ssh, interfaces) {
  if (!ssh || !ssh.serverIp) return false;
  return (interfaces || []).some((iface) => isWirelessIface(host, iface.name)
    && (iface.addresses || []).some((addr) => addr.address === ssh.serverIp));
}

function note(io, parsed, text) {
  if (parsed.flags.has('--json')) io.stderr(`${text}\n`);
  else write(io, text);
}

async function commandWifiConnect(parsed, io, deps) {
  const host = diagnostics.collectHost(deps);
  const wifi = diagnostics.collectWifi(deps, host);
  const result = {
    kind: 'wifi-connect',
    generatedAt: deps.now().toISOString(),
    supported: !!wifi.nmcli && (wifi.hardware || []).length > 0,
    connected: false,
    verified: false,
    ssid: null,
    profile: null,
    message: null,
  };

  if ((wifi.hardware || []).length === 0) {
    result.message = 'No Wi-Fi hardware detected; nothing to connect.';
    if (parsed.flags.has('--json')) jsonOut(io, result);
    else write(io, result.message);
    return EXIT_OK;
  }
  if (!wifi.nmcli) {
    result.message = 'NetworkManager/nmcli is not available; Wi-Fi connection is unsupported on this system.';
    if (parsed.flags.has('--json')) jsonOut(io, result);
    else write(io, result.message);
    return EXIT_OK;
  }
  if (wifi.blocked === 'hard') {
    result.message = 'The Wi-Fi radio is hard-blocked (switch/firmware); software cannot connect.';
    if (parsed.flags.has('--json')) jsonOut(io, result);
    else write(io, colorize(io, '31', result.message));
    return EXIT_PROBLEMS;
  }
  if (wifi.blocked === 'soft') {
    result.message = 'The Wi-Fi radio is soft-blocked. Run "citadel repair" to unblock it first.';
    if (parsed.flags.has('--json')) jsonOut(io, result);
    else write(io, colorize(io, '33', result.message));
    return EXIT_PROBLEMS;
  }

  let ssid = parsed.ssid;
  if (!ssid && parsed.positional.length > 1) {
    const err = new Error('Quote an SSID that contains spaces, or use --ssid=<SSID>.');
    err.exitCode = EXIT_USAGE;
    throw err;
  }
  if (!ssid && parsed.positional.length === 1) ssid = parsed.positional[0];

  if (parsed.flags.has('--json')) {
    if (!ssid) {
      const err = new Error('Wi-Fi connection in JSON mode requires an SSID (no interactive prompts).');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
    if (!parsed.flags.has('--yes')) {
      const err = new Error('Wi-Fi connection in JSON mode requires --yes (no interactive prompts).');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
  }

  if (!ssid) {
    if (!io.isTTY && !io.prompt) {
      const err = new Error('Interactive Wi-Fi selection requires a terminal. Pass an SSID or use --ssid=<SSID>.');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
    if (wifi.blocked === 'soft') {
      note(io, parsed, 'The Wi-Fi radio is soft-blocked. Run "citadel repair" to unblock it first.');
      return EXIT_PROBLEMS;
    }
    const list = await listWifiNetworks(deps, host);
    if (!list.ok) {
      result.message = `Could not scan networks: ${list.error}`;
      if (parsed.flags.has('--json')) jsonOut(io, result);
      else write(io, colorize(io, '31', result.message));
      return EXIT_PROBLEMS;
    }
    if (list.networks.length === 0) {
      result.message = 'No Wi-Fi networks were found.';
      if (parsed.flags.has('--json')) jsonOut(io, result);
      else write(io, result.message);
      return EXIT_PROBLEMS;
    }
    note(io, parsed, colorize(io, '1', 'Available networks:'));
    list.networks.forEach((net, index) => {
      note(io, parsed, `  ${String(index + 1).padStart(2)}. ${printable(net.ssid)}${net.inUse ? ' *' : ''}  ${printable(net.security)}  ${net.signal}%`);
    });
    const answer = (await ask(io, 'Select a network number (or q to cancel): ')).trim();
    if (answer === 'q' || answer === '') return EXIT_OK;
    const index = Number.parseInt(answer, 10);
    if (!Number.isInteger(index) || index < 1 || index > list.networks.length) {
      const err = new Error('Invalid network selection.');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
    ssid = list.networks[index - 1].ssid;
  }

  const invalid = validateSsid(ssid);
  if (invalid) {
    const err = new Error(invalid);
    err.exitCode = EXIT_USAGE;
    throw err;
  }
  result.ssid = ssid;

  const connRes = deps.run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'], { timeout: 5000 });
  const profiles = connRes.ok ? diagnostics.parseNmcliConnections(connRes.stdout) : [];
  const saved = profiles.find((profile) => profile.name === ssid && profile.type === '802-11-wireless');
  result.profile = saved ? saved.name : null;

  const yes = parsed.flags.has('--yes');
  if (parsed.flags.has('--json')) {
    if (!saved) {
      const err = new Error('JSON mode cannot prompt for a new Wi-Fi password. Connect interactively once, then use JSON with the saved profile.');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
  }

  const ssh = parseSshConnection(io.env);
  const interfaces = ssh ? await currentInterfaces(deps, host) : [];
  const overWireless = ssh ? sshOverWireless(host, ssh, interfaces) : false;

  if (ssh) {
    note(io, parsed, colorize(io, '33', 'WARNING: you are connected over SSH.'));
    note(io, parsed, overWireless
      ? 'This Wi-Fi change may affect the interface carrying your SSH session. The connection can drop and is NOT restored automatically.'
      : 'Changing Wi-Fi can alter the default route and interrupt this SSH session. The connection is NOT restored automatically.');
    note(io, parsed, `Target network: ${ssid}${saved ? ' (saved profile)' : ' (new network)'}.`);
    note(io, parsed, 'Keep console/IPMI access available before continuing.');
  }

  if (ssh && yes && !parsed.flags.has('--confirm-remote')) {
    result.message = 'Refusing a remote-sensitive Wi-Fi change: --confirm-remote is required together with --yes.';
    if (parsed.flags.has('--json')) jsonOut(io, result);
    else write(io, colorize(io, '31', result.message));
    return EXIT_PROBLEMS;
  }

  if (!yes) {
    if (!io.isTTY && !io.prompt) {
      const err = new Error('Connecting requires confirmation. Run in a terminal, or pass --yes (remote changes also require --confirm-remote).');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
    const expected = ssh || overWireless ? 'yes' : 'y';
    const promptText = ssh || overWireless
      ? `Type "yes" to continue despite the SSH risk: `
      : `Connect to "${ssid}"? [y/N]: `;
    const answer = (await ask(io, promptText)).trim().toLowerCase();
    if (answer !== expected && !(expected === 'y' && answer === 'yes')) {
      note(io, parsed, 'Cancelled.');
      return EXIT_OK;
    }
  }

  note(io, parsed, `Connecting to "${ssid}"...`);
  let runResult;
  if (saved) {
    runResult = deps.run('nmcli', ['connection', 'up', 'id', saved.name], { timeout: 60000 });
    if (!runResult.ok) {
      const hint = /not authorized|permission|polkit/i.test(`${runResult.stderr} ${runResult.error}`)
        ? ' NetworkManager may require root or a polkit authorization; retry with sudo if appropriate.'
        : '';
      result.message = `nmcli could not activate the saved profile.${hint}`;
    }
  } else {
    if (!io.isTTY && !io.prompt) {
      const err = new Error('Connecting to a new network requires an interactive terminal so nmcli can prompt for the password securely.');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
    const runner = deps.runInteractive || defaultInteractive;
    runResult = runner('nmcli', ['--ask', 'device', 'wifi', 'connect', ssid], { timeout: 120000 });
    if (!runResult.ok) result.message = 'nmcli could not connect to the network.';
  }

  if (!runResult.ok) {
    if (parsed.flags.has('--json')) jsonOut(io, result);
    else write(io, colorize(io, '31', result.message || 'Connection failed.'));
    return EXIT_PROBLEMS;
  }

  const verification = await verifyWifi(deps, host, ssid);
  result.connected = true;
  result.verified = verification.verified;
  result.message = verification.verified
    ? `Connected to "${ssid}" and a default route is present.`
    : `The connection command succeeded, but the result could not be verified${verification.reason ? `: ${verification.reason}` : '.'}`;

  if (parsed.flags.has('--json')) jsonOut(io, result);
  else {
    write(io, colorize(io, result.verified ? '32' : '33', result.message));
    if (!result.verified) write(io, 'Check "citadel network" and your router access point.');
  }
  return result.verified ? EXIT_OK : EXIT_PROBLEMS;
}

async function currentInterfaces(deps, host) {
  if (!host.capabilities.ip) return [];
  const res = deps.run('ip', ['-json', 'addr', 'show'], { timeout: 3000 });
  let parsed = null;
  try { parsed = res.ok ? JSON.parse(res.stdout) : null; } catch { parsed = null; }
  const interfaces = diagnostics.parseInterfaces(parsed);
  if (interfaces.length > 0) return interfaces.filter((iface) => iface.name !== 'lo');
  const fallback = deps.run('ip', ['-o', 'addr', 'show'], { timeout: 3000 });
  return diagnostics.parseIpO(fallback.stdout).filter((iface) => iface.name !== 'lo');
}

function defaultRoutes(deps) {
  const res = deps.run('ip', ['-json', 'route', 'show', 'default'], { timeout: 3000 });
  let routes = res.ok ? diagnostics.parseDefaultRoutes(res.stdout) : [];
  if (routes.length === 0) {
    const fallback = deps.run('ip', ['route', 'show', 'default'], { timeout: 3000 });
    routes = diagnostics.parseDefaultRoutesText(fallback.stdout);
  }
  return routes;
}

async function verifyWifi(deps, host, ssid) {
  const devRes = deps.run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device', 'status'], { timeout: 5000 });
  if (!devRes.ok) {
    return { verified: false, reason: 'NetworkManager did not report device state' };
  }
  const devices = diagnostics.parseNmcliDevices(devRes.stdout).filter((d) => d.type === 'wifi');
  if (devices.length === 0) {
    return { verified: false, reason: 'NetworkManager does not report a Wi-Fi device' };
  }
  if (!devices.some((d) => /^connected\b/i.test(d.state))) {
    return { verified: false, reason: 'no wireless interface reports connected' };
  }
  if (!host.capabilities.ip) {
    return { verified: false, reason: 'ip is unavailable, so the address/route could not be checked' };
  }
  const routes = defaultRoutes(deps);
  if (routes.length === 0) {
    return { verified: false, reason: 'no default route is present' };
  }
  const activeRes = deps.run('nmcli', ['-t', '-f', 'ACTIVE,SSID', 'device', 'wifi', 'list'], { timeout: 5000 });
  if (!activeRes.ok || !activeRes.stdout) {
    return { verified: false, reason: 'the active SSID could not be verified' };
  }
  const active = activeRes.stdout.split('\n')
    .map((line) => diagnostics.splitNmcli(line))
    .some((fields) => fields[0] === 'yes' && fields[1] === ssid);
  if (!active) return { verified: false, reason: `the active network does not report "${ssid}"` };
  return { verified: true, reason: null };
}


function publicAction(action) {
  return {
    id: action.id,
    kind: action.kind,
    title: action.title,
    detail: action.detail,
    requiresRoot: !!action.requiresRoot,
    disruptive: !!action.disruptive,
    remoteSensitive: !!action.remoteSensitive,
    target: action.target || null,
  };
}

// Units whose restart can interrupt remote access (the SSH session itself) or
// connectivity. Matching is anchored to concrete systemd unit names, not
// arbitrary substrings, and is deliberately conservative: over-warning is much
// safer than silently dropping an operator's SSH session.
const REMOTE_SENSITIVE_UNIT = new RegExp(
  `^(${[
    'ssh', 'sshd',
    'NetworkManager', 'systemd-networkd', 'systemd-resolved', 'networking',
    'wpa_supplicant', 'dhcpcd', 'dhclient', 'isc-dhcp',
    'ufw', 'nftables', 'firewalld', 'iptables', 'ip6tables', 'netfilter-persistent',
  ].join('|')})([-.@].*)?[.]service$`,
  'i',
);

function isNetworkUnit(unit) {
  return typeof unit === 'string' && REMOTE_SENSITIVE_UNIT.test(unit);
}

async function buildRepairPlan(deps, report) {
  const actions = [];
  const failed = report.findings.find((item) => item.id === 'services.failed');
  if (failed && failed.data && Array.isArray(failed.data.units)) {
    for (const unit of failed.data.units) {
      actions.push({
        id: `restart:${unit}`,
        kind: 'service-restart',
        title: `Restart ${unit}`,
        detail: 'Restart a failed systemd unit. This interrupts the service briefly and may affect dependent services.',
        requiresRoot: true,
        disruptive: true,
        remoteSensitive: isNetworkUnit(unit),
        target: unit,
      });
    }
  }
  const wifiBlocked = report.findings.find((item) => item.id === 'wifi.blocked');
  if (wifiBlocked && /soft-blocked/i.test(wifiBlocked.title)) {
    actions.push({
      id: 'wifi:unblock',
      kind: 'wifi-unblock',
      title: 'Unblock the Wi-Fi radio',
      detail: 'Run "rfkill unblock wifi". The radio turns on; no configuration files are edited.',
      requiresRoot: true,
      disruptive: true,
      remoteSensitive: true,
      target: 'wifi',
    });
  }
  const wifiState = report.findings.find((item) => item.id === 'wifi.state');
  if (wifiState && wifiState.status === 'warn' && report.host.capabilities.nmcli) {
    const connRes = deps.run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'], { timeout: 5000 });
    const profiles = connRes.ok ? diagnostics.parseNmcliConnections(connRes.stdout) : [];
    const wifiProfile = profiles.find((profile) => profile.type === '802-11-wireless');
    if (wifiProfile) {
      actions.push({
        id: `wifi:reconnect:${wifiProfile.name}`,
        kind: 'wifi-reconnect',
        title: `Reconnect saved Wi-Fi profile "${wifiProfile.name}"`,
        detail: 'Activate an existing NetworkManager profile. If it is the interface carrying SSH, the session may be interrupted.',
        requiresRoot: false,
        disruptive: true,
        remoteSensitive: true,
        target: wifiProfile.name,
      });
    }
  }
  const citadelService = report.findings.find((item) => item.id === 'citadel.service' && item.status === 'fail');
  if (citadelService && !actions.some((action) => action.kind === 'service-restart' && action.target === 'citadel.service')) {
    actions.push({
      id: 'restart:citadel.service',
      kind: 'service-restart',
      title: 'Restart citadel.service',
      detail: 'Restart the Citadel service. Open terminals are preserved only when KillMode=process.',
      requiresRoot: true,
      disruptive: true,
      remoteSensitive: false,
      target: 'citadel.service',
    });
  }
  return actions;
}

function validateUnit(unit, report) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9_.@:-]+\.service$/.test(unit)) return false;
  const failed = report.findings.find((item) => item.id === 'services.failed');
  if (failed && failed.data && Array.isArray(failed.data.units) && failed.data.units.includes(unit)) return true;
  return unit === 'citadel.service';
}

function elevation(deps) {
  if (deps.uid === 0) return { ok: true, root: true, command: null };
  if (deps.which('sudo')) return { ok: true, root: false, command: 'sudo' };
  return { ok: false, root: false, command: null };
}

/**
 * Read a systemd unit's state with `systemctl <verb> <unit>`. A non-zero exit is
 * NOT treated as a command failure: `is-active` exits non-zero for `inactive`
 * and `failed` while still printing the state on stdout. Only a real spawn
 * error or empty output is "unverifiable".
 */
function systemctlState(deps, verb, target) {
  const res = deps.run('systemctl', [verb, target], { timeout: 5000 });
  if (res.error) return { ok: false, reason: res.error };
  const state = String(res.stdout || '').trim().toLowerCase();
  if (!state) return { ok: false, reason: `systemctl ${verb} ${target} returned an empty state` };
  return { ok: true, state };
}

/**
 * Decide whether a restart actually left the unit healthy. A zero exit status
 * from `systemctl restart` is not proof on its own: the unit must report
 * `active`. `failed`, `inactive`, `activating`, empty or an unreadable answer is
 * never reported as success (a oneshot that is legitimately inactive is
 * reported as unverified instead of a fabricated green).
 */
function verifyServiceRestart(deps, target) {
  const state = systemctlState(deps, 'is-active', target);
  if (!state.ok) {
    return { verified: false, message: `The restart command ran, but the state of ${target} could not be verified (${state.reason}).` };
  }
  if (state.state === 'failed') {
    return { verified: false, message: `${target} is still failed. Check "systemctl status ${target}" and its logs.` };
  }
  if (state.state === 'active') {
    return { verified: true, message: `${target} restarted and is active.` };
  }
  return {
    verified: false,
    message: `The restart command ran, but ${target} did not report "active" (state: ${state.state}). Verify manually with "systemctl status ${target}".`,
  };
}

async function executeAction(action, report, deps, io, parsed = null) {
  const jsonMode = !!(parsed && parsed.flags.has('--json'));
  const runner = jsonMode ? deps.run : (deps.runInteractive || defaultInteractive);
  const elev = elevation(deps);
  if (action.requiresRoot && !elev.ok) {
    return { executed: false, verified: false, message: 'This action needs root, and sudo is not available. Run Citadel as root or install sudo.' };
  }
  if (action.kind === 'service-restart') {
    if (!validateUnit(action.target, report)) {
      return { executed: false, verified: false, message: `Refusing to restart an unrecognized unit: ${action.target}` };
    }
    const args = elev.root ? ['systemctl', 'restart', action.target] : ['sudo', 'systemctl', 'restart', action.target];
    const res = runner(args[0], args.slice(1), { timeout: 60000 });
    if (!res.ok) return { executed: false, verified: false, message: `systemctl restart failed (${res.error || `exit ${res.status}`}).` };
    const verification = verifyServiceRestart(deps, action.target);
    return { executed: true, verified: verification.verified, message: verification.message };
  }
  if (action.kind === 'wifi-unblock') {
    const args = elev.root ? ['rfkill', 'unblock', 'wifi'] : ['sudo', 'rfkill', 'unblock', 'wifi'];
    const res = runner(args[0], args.slice(1), { timeout: 15000 });
    if (!res.ok) return { executed: false, verified: false, message: `rfkill failed (${res.error || `exit ${res.status}`}).` };
    const check = deps.run('rfkill', ['list', 'wifi'], { timeout: 3000 });
    if (!check.ok) {
      return { executed: true, verified: false, message: 'rfkill ran, but the radio state could not be verified.' };
    }
    const stillSoft = diagnostics.parseRfkill(check.stdout).some((d) => d.soft);
    return { executed: true, verified: !stillSoft, message: stillSoft
      ? 'The radio is still soft-blocked. Check firmware/driver support and rfkill state.'
      : 'Wi-Fi radio unblocked.' };
  }
  if (action.kind === 'wifi-reconnect') {
    if (typeof action.target !== 'string' || action.target.length === 0) {
      return { executed: false, verified: false, message: 'Refusing to activate an empty Wi-Fi profile name.' };
    }
    const res = deps.run('nmcli', ['connection', 'up', 'id', action.target], { timeout: 60000 });
    if (!res.ok) return { executed: false, verified: false, message: `Could not activate "${action.target}" (${res.error || `exit ${res.status}`}).` };
    const active = deps.run('nmcli', ['-t', '-f', 'NAME', 'connection', 'show', '--active'], { timeout: 5000 });
    if (!active.ok) {
      return { executed: true, verified: false, message: `Activated "${action.target}", but the active profile could not be verified.` };
    }
    const activeNames = active.stdout.split('\n').map((line) => diagnostics.splitNmcli(line)[0]);
    if (!activeNames.includes(action.target)) {
      return { executed: true, verified: false, message: `"${action.target}" did not become the active connection.` };
    }
    const routes = defaultRoutes(deps);
    return { executed: true, verified: routes.length > 0, message: routes.length > 0
      ? `Activated "${action.target}" and a default route is present.`
      : `Activated "${action.target}", but no default route is present yet.` };
  }
  return { executed: false, verified: false, message: `Unsupported action kind: ${action.kind}` };
}

async function confirmAction(action, deps, io, parsed) {
  const remote = !!parseSshConnection(io.env);
  const sensitive = action.remoteSensitive && remote;
  if (sensitive) {
    note(io, parsed, colorize(io, '33', 'WARNING: this action can interrupt your SSH session.'));
    note(io, parsed, 'No automatic rollback is provided. Keep console/IPMI access available.');
  }
  if (parsed.flags.has('--yes')) {
    if (sensitive && !parsed.flags.has('--confirm-remote')) {
      return { allowed: false, reason: 'Remote-sensitive action refused: pass --confirm-remote together with --yes.' };
    }
    return { allowed: true };
  }
  if (!io.isTTY && !io.prompt) return { allowed: false, reason: 'Confirmation requires a terminal (or --yes).' };
  const question = sensitive
    ? 'Type "yes" to proceed despite the SSH risk: '
    : 'Proceed? [y/N]: ';
  const answer = (await ask(io, question)).trim().toLowerCase();
  if (sensitive) return { allowed: answer === 'yes' };
  return { allowed: answer === 'y' || answer === 'yes' };
}

async function commandRepair(parsed, io, deps) {
  if (parsed.flags.has('--json') && parsed.flags.has('--action') && !parsed.flags.has('--yes')) {
    const err = new Error('Repair in JSON mode requires --yes (no interactive prompts).');
    err.exitCode = EXIT_USAGE;
    throw err;
  }
  const report = diagnostics.collectDoctor(deps);
  const plan = await buildRepairPlan(deps, report);

  if (parsed.flags.has('--json') && !parsed.flags.has('--action')) {
    jsonOut(io, { kind: 'repair', actions: plan.map(publicAction), applied: [] });
    return EXIT_OK;
  }
  if (plan.length === 0) {
    if (parsed.action) {
      const err = new Error(`Unknown or no-longer-applicable action: ${parsed.action}. Run "citadel repair" to list actions.`);
      err.exitCode = EXIT_USAGE;
      throw err;
    }
    if (parsed.flags.has('--json')) jsonOut(io, { kind: 'repair', actions: [], applied: [] });
    else write(io, 'No supported automatic repairs apply. Address the hints from "citadel doctor" first.');
    return EXIT_OK;
  }

  let action = null;
  if (parsed.action) {
    action = plan.find((item) => item.id === parsed.action);
    if (!action) {
      const err = new Error(`Unknown or no-longer-applicable action: ${parsed.action}. Run "citadel repair" to list actions.`);
      err.exitCode = EXIT_USAGE;
      throw err;
    }
  } else {
    if (!io.isTTY && !io.prompt) {
      const err = new Error('Selecting a repair requires a terminal. Use repair --action=<id> --yes for automation.');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
    write(io, colorize(io, '1', 'Supported repairs:'));
    plan.forEach((item, index) => {
      const tags = [item.requiresRoot ? 'root' : 'user', item.disruptive ? 'disruptive' : 'safe'];
      write(io, `  ${String(index + 1).padStart(2)}. ${item.title} [${tags.join(', ')}]`);
      write(io, `      ${item.detail}`);
    });
    const answer = (await ask(io, 'Select an action (or q to cancel): ')).trim();
    if (answer === 'q' || answer === '') return EXIT_OK;
    const index = Number.parseInt(answer, 10);
    if (!Number.isInteger(index) || index < 1 || index > plan.length) {
      const err = new Error('Invalid action selection.');
      err.exitCode = EXIT_USAGE;
      throw err;
    }
    action = plan[index - 1];
  }

  note(io, parsed, '');
  note(io, parsed, colorize(io, '1', action.title));
  note(io, parsed, action.detail);

  const confirmation = await confirmAction(action, deps, io, parsed);
  if (!confirmation.allowed) {
    if (parsed.flags.has('--json')) {
      jsonOut(io, { kind: 'repair', actions: plan.map(publicAction), applied: [], message: confirmation.reason });
    } else {
      write(io, colorize(io, '33', confirmation.reason || 'Cancelled.'));
    }
    return confirmation.reason ? EXIT_PROBLEMS : EXIT_OK;
  }

  const outcome = await executeAction(action, report, deps, io, parsed);
  if (parsed.flags.has('--json')) {
    jsonOut(io, {
      kind: 'repair',
      actions: plan.map(publicAction),
      applied: [{ ...publicAction(action), ...outcome }],
    });
  } else {
    write(io, colorize(io, outcome.verified ? '32' : '31', outcome.message));
    if (!outcome.verified) {
      write(io, 'Run "citadel doctor" again and inspect the relevant service/logs; no further change was made.');
    }
  }
  return outcome.verified ? EXIT_OK : EXIT_PROBLEMS;
}

async function main(argv = process.argv.slice(2), overrides = {}) {
  const io = createIO(overrides.io || {});
  const deps = overrides.deps || diagnostics.createDeps({ env: io.env, isTTY: io.isTTY });
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.flags.has('--no-color') || parsed.flags.has('--json')) io.color = false;
    if (parsed.flags.has('--help') || parsed.flags.has('-h') || parsed.command === 'help') {
      io.stdout(HELP);
      return EXIT_OK;
    }
    switch (parsed.command) {
      case 'doctor':
        return await commandDoctor(parsed, io, deps);
      case 'network':
        return await commandNetwork(parsed, io, deps);
      case 'wifi':
        if (parsed.subcommand === 'list') return await commandWifiList(parsed, io, deps);
        if (parsed.subcommand === 'connect') return await commandWifiConnect(parsed, io, deps);
        if (!parsed.subcommand) {
          const err = new Error('Usage: citadel wifi <list|connect>');
          err.exitCode = EXIT_USAGE;
          throw err;
        }
        {
          const err = new Error(`Unknown wifi command: ${parsed.subcommand}`);
          err.exitCode = EXIT_USAGE;
          throw err;
        }
      case 'repair':
        return await commandRepair(parsed, io, deps);
      default: {
        const err = new Error(`Unknown command: ${parsed.command}`);
        err.exitCode = EXIT_USAGE;
        throw err;
      }
    }
  } catch (err) {
    io.stderr(`${err.message}\n`);
    if (err.exitCode === EXIT_USAGE) io.stderr('Run "citadel help" for usage.\n');
    return err.exitCode || EXIT_PROBLEMS;
  }
}

if (require.main === module) {
  const ignoreBrokenPipe = (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  };
  process.stdout.on('error', ignoreBrokenPipe);
  process.stderr.on('error', ignoreBrokenPipe);
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(EXIT_PROBLEMS);
  });
}

module.exports = {
  main,
  parseArgs,
  buildRepairPlan,
  executeAction,
  validateUnit,
  isNetworkUnit,
  verifyServiceRestart,
  systemctlState,
  validateSsid,
  parseSshConnection,
  confirmAction,
  verifyWifi,
  HELP,
};
