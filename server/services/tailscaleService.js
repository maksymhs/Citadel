/**
 * Tailscale integration: a private HTTPS address for this panel on the user's
 * tailnet (reachable from their own devices, never from the public Internet).
 *
 * The panel never runs `tailscale funnel`, which would publish it. It only reads
 * `tailscale status` and manages `tailscale serve` for its own port. Signing in
 * and giving this service permission to manage serve are one-time steps that
 * need root, so they are surfaced as commands to run, not run for the user.
 *
 * Tailscale's CLI changed between releases (`serve https / <target>` before 1.52,
 * `serve --bg --https=443 <target>` after), so both spellings are tried.
 */
const fs = require('node:fs');
const os = require('node:os');
const { execFile, spawnSync } = require('node:child_process');
const { PORT } = require('../config');

const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const STATUS_TIMEOUT_MS = 4000;
const SERVE_TIMEOUT_MS = 15000;

function target() {
  return `http://127.0.0.1:${PORT}`;
}

function isWsl() {
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// Where to get Tailscale on this host. Commands are shown, never executed.
function installHints() {
  const platform = process.platform;
  if (platform === 'darwin') {
    return { platform, commands: ['brew install --cask tailscale'], note: 'Or install it from the Mac App Store, then open it and sign in.' };
  }
  if (platform === 'linux') {
    return {
      platform: isWsl() ? 'wsl' : 'linux',
      commands: ['curl -fsSL https://tailscale.com/install.sh | sh', 'sudo tailscale up'],
      note: isWsl() ? 'Inside WSL this needs systemd enabled in /etc/wsl.conf (the Citadel installer explains how).' : null,
    };
  }
  return { platform, commands: [], note: 'Install Tailscale from https://tailscale.com/download and sign in.' };
}

function operatorCommand() {
  return `sudo tailscale set --operator=${os.userInfo().username}`;
}

function cleanOutput(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
}

function firstUrl(text) {
  const m = /https:\/\/[^\s"')]+/.exec(String(text || ''));
  return m ? m[0] : null;
}

function classifyError(output) {
  const text = cleanOutput(output);
  if (/access denied|permission denied|must be root|operator|not permitted/i.test(text)) {
    return { needsOperator: true, command: operatorCommand(), message: 'Citadel is not allowed to manage Tailscale yet.' };
  }
  return { message: text.split('\n').filter(Boolean).slice(0, 3).join(' ') || 'Tailscale returned an error.', actionUrl: firstUrl(text) };
}

// --- Running the CLI ---------------------------------------------------------

function candidates() {
  return ['tailscale', ...(process.platform === 'darwin' ? [MAC_APP_CLI] : [])];
}

function runOnce(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        missing: Boolean(err && err.code === 'ENOENT'),
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: `${stdout || ''}${stderr ? `\n${stderr}` : ''}`,
      });
    });
  });
}

async function run(args, timeout = STATUS_TIMEOUT_MS) {
  for (const bin of candidates()) {
    const res = await runOnce(bin, args, timeout);
    if (!res.missing) return { ...res, installed: true };
  }
  return { installed: false, missing: true, code: 127, out: '' };
}

function runSync(args, timeout = 3000) {
  for (const bin of candidates()) {
    const res = spawnSync(bin, args, { encoding: 'utf8', timeout });
    if (!(res.error && res.error.code === 'ENOENT')) return { code: res.status, out: `${res.stdout || ''}${res.stderr ? `\n${res.stderr}` : ''}` };
  }
  return null;
}

// --- Parsing -----------------------------------------------------------------

function parseStatus(json) {
  const data = JSON.parse(json);
  const self = data.Self || {};
  const dnsName = self.DNSName ? String(self.DNSName).replace(/\.$/, '') : null;
  return {
    backendState: data.BackendState || 'Unknown',
    loginUrl: data.AuthURL || null,
    hostName: self.HostName || null,
    dnsName,
    ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [],
    tailnet: (data.CurrentTailnet && data.CurrentTailnet.Name) || data.MagicDNSSuffix || null,
    peers: data.Peer ? Object.keys(data.Peer).length : 0,
    health: Array.isArray(data.Health) ? data.Health.map(String) : [],
  };
}

const LOCAL_TARGET = /(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/g;

// True when some serve handler proxies to this panel's port. Accepts the JSON
// printed by new CLIs and the plain text printed by old ones.
function servesPort(text, port = PORT) {
  const body = String(text || '');
  let m;
  LOCAL_TARGET.lastIndex = 0;
  while ((m = LOCAL_TARGET.exec(body))) {
    if (Number(m[1]) === Number(port)) return true;
  }
  return false;
}

function hasServeConfig(text) {
  const body = cleanOutput(text);
  if (!body || /no serve config/i.test(body)) return false;
  if (body.startsWith('{')) {
    try { return Object.keys(JSON.parse(body)).length > 0; } catch { return true; }
  }
  return true;
}

// --- Status ------------------------------------------------------------------

async function getStatus() {
  const res = await run(['status', '--json']);
  if (!res.installed) return { installed: false, install: installHints(), target: target() };

  let info;
  try {
    info = parseStatus(res.out.slice(res.out.indexOf('{')));
  } catch {
    // Installed but the daemon is not answering (stopped, or no permission).
    const stopped = /not running|failed to connect|is tailscaled running/i.test(res.out);
    return {
      installed: true, backendState: stopped ? 'Stopped' : 'Unknown', loginUrl: null, serving: false, url: null,
      error: cleanOutput(res.out).split('\n')[0] || null, install: installHints(), target: target(),
    };
  }

  let serving = false;
  let serveKnown = false;
  if (info.backendState === 'Running') {
    let serve = await run(['serve', 'status', '--json']);
    if (serve.code !== 0) serve = await run(['serve', 'status']);
    if (serve.code === 0) {
      serveKnown = true;
      serving = hasServeConfig(serve.out) && servesPort(serve.out);
    }
  }
  return {
    installed: true, ...info, serving, serveKnown,
    url: serving && info.dnsName ? `https://${info.dnsName}` : null,
    install: installHints(), target: target(), operatorCommand: operatorCommand(),
  };
}

// Synchronous variant for connectService (cached there). `serving` is null when
// it cannot be determined, so the caller keeps its old behaviour in that case.
function detectSync() {
  const res = runSync(['status', '--json']);
  if (!res || res.code !== 0 || !res.out) return null;
  let info;
  try { info = parseStatus(res.out); } catch { return null; }
  if (!info.dnsName) return null;
  let serving = null;
  let serve = runSync(['serve', 'status', '--json']);
  if (!serve || serve.code !== 0) serve = runSync(['serve', 'status']);
  if (serve && serve.code === 0) serving = hasServeConfig(serve.out) && servesPort(serve.out);
  return { dnsName: info.dnsName, serving };
}

// --- Managing serve ----------------------------------------------------------

async function enableServe() {
  const attempts = [
    ['serve', '--bg', '--https=443', target()],
    ['serve', 'https', '/', target()], // Tailscale before 1.52
  ];
  let last = null;
  for (const args of attempts) {
    const res = await run(args, SERVE_TIMEOUT_MS);
    if (!res.installed) return { ok: false, message: 'Tailscale is not installed.' };
    if (res.code === 0) return { ok: true };
    last = res;
    // Only fall through to the old spelling when the new one was not understood.
    if (!/unknown (flag|shorthand)|flag provided but not defined|usage|invalid|unexpected/i.test(res.out)) break;
  }
  return { ok: false, ...classifyError(last && last.out) };
}

async function disableServe() {
  const attempts = [
    ['serve', '--https=443', 'off'],
    ['serve', 'https', '/', 'off'],
  ];
  let last = null;
  for (const args of attempts) {
    const res = await run(args, SERVE_TIMEOUT_MS);
    if (!res.installed) return { ok: false, message: 'Tailscale is not installed.' };
    if (res.code === 0) return { ok: true };
    last = res;
    if (!/unknown (flag|shorthand)|flag provided but not defined|usage|invalid|unexpected/i.test(res.out)) break;
  }
  return { ok: false, ...classifyError(last && last.out) };
}

module.exports = {
  getStatus, detectSync, enableServe, disableServe,
  // exported for tests
  parseStatus, servesPort, hasServeConfig, classifyError, installHints,
};
