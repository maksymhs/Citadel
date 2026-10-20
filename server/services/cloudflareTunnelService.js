/**
 * Named Cloudflare Tunnel setup driven from the panel (Settings → Tunnel).
 *
 * Runs the same steps as `cloudflared tunnel login/create/route dns/token` as
 * the service user, stores the resulting token + domain under DATA_DIR and asks
 * the root-owned helper (scripts/tunnel.sh, see `citadel tunnel setup`) to
 * (re)start citadel-tunnel.service. The account-wide login certificate is
 * deleted as soon as the tunnel exists; only the tunnel token is kept.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DATA_DIR } = require('../config');
const { getTunnelUrl } = require('./tunnelService');

const CLOUDFLARED = process.env.CLOUDFLARED_PATH || '/usr/local/bin/cloudflared';
const HELPER = process.env.CITADEL_TUNNEL_HELPER || '/usr/local/sbin/citadel-tunnel';
const TOKEN_FILE = path.join(DATA_DIR, 'tunnel-token');
const DOMAIN_FILE = path.join(DATA_DIR, 'tunnel-domain');
const CF_HOME = path.join(DATA_DIR, 'cloudflared');
const CERT_FILE = path.join(CF_HOME, 'cert.pem');
// `cloudflared tunnel login` ignores TUNNEL_ORIGIN_CERT and always writes the
// certificate to $HOME/.cloudflared/cert.pem; the other steps read CERT_FILE.
const LOGIN_CERT_FILE = path.join(CF_HOME, '.cloudflared', 'cert.pem');
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 60 * 1000;

const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

let job = { phase: 'idle', message: '', loginUrl: null, domain: null };
let loginProc = null;

function normalizeDomain(raw) {
  const value = String(raw || '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  return HOSTNAME_RE.test(value) ? value : null;
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function setJob(patch) {
  job = { ...job, ...patch };
}

function tunnelName() {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return `citadel-${host || 'host'}`;
}

function cfEnv() {
  return { ...process.env, HOME: CF_HOME, TUNNEL_ORIGIN_CERT: CERT_FILE, NO_COLOR: '1' };
}

function run(args, timeout = STEP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(CLOUDFLARED, args, { env: cfEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || 'unknown error';
}

function runHelper(args = ['up']) {
  const res = spawnSync('sudo', ['-n', HELPER, ...args], { encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0) {
    throw new Error(`Could not start the tunnel service: ${lastLine(res.stderr || res.stdout)}`);
  }
}

function helperInstalled() {
  try {
    const st = fs.statSync(HELPER);
    return st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function getStatus() {
  const domain = readFile(DOMAIN_FILE);
  const url = getTunnelUrl();
  return {
    supported: process.platform === 'linux',
    cloudflaredInstalled: fs.existsSync(CLOUDFLARED),
    helperInstalled: helperInstalled(),
    mode: domain && readFile(TOKEN_FILE) ? 'named' : (url ? 'quick' : 'off'),
    domain: domain || null,
    url,
    job: { ...job },
  };
}

function cleanupCert() {
  fs.rmSync(CF_HOME, { recursive: true, force: true });
}

async function finishSetup(domain) {
  const name = tunnelName();
  setJob({ phase: 'working', message: 'Creating the tunnel…', loginUrl: null });

  const created = await run(['tunnel', 'create', name]);
  if (created.code !== 0 && !/already exists/i.test(created.stderr + created.stdout)) {
    throw new Error(`Creating the tunnel failed: ${lastLine(created.stderr || created.stdout)}`);
  }

  setJob({ message: `Pointing ${domain} at the tunnel…` });
  const routed = await run(['tunnel', 'route', 'dns', name, domain]);
  if (routed.code !== 0) {
    throw new Error(`Creating the DNS record failed: ${lastLine(routed.stderr || routed.stdout)}`);
  }

  const tok = await run(['tunnel', 'token', name]);
  const token = tok.stdout.trim().split(/\s+/)[0];
  if (tok.code !== 0 || !token) {
    throw new Error(`Fetching the tunnel token failed: ${lastLine(tok.stderr || tok.stdout)}`);
  }

  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
  fs.writeFileSync(DOMAIN_FILE, `${domain}\n`, { mode: 0o600 });

  setJob({ message: 'Starting the tunnel service…' });
  runHelper(['up']);
}

/** Begin the login → create → route → start flow. Returns immediately. */
function start(rawDomain) {
  const domain = normalizeDomain(rawDomain);
  if (!domain) throw new Error('Enter a valid hostname, e.g. citadel.example.com');
  const status = getStatus();
  if (!status.supported) throw new Error('Tunnel setup is only available on Linux hosts.');
  if (!status.cloudflaredInstalled || !status.helperInstalled) {
    throw new Error('Run "sudo citadel tunnel setup" once on this machine to enable this.');
  }
  if (loginProc || job.phase === 'working') throw new Error('A tunnel setup is already in progress.');

  cleanupCert();
  fs.mkdirSync(CF_HOME, { recursive: true, mode: 0o700 });
  setJob({ phase: 'login', message: 'Waiting for you to authorize in Cloudflare…', loginUrl: null, domain });

  const child = spawn(CLOUDFLARED, ['tunnel', 'login'], { env: cfEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  loginProc = child;
  const timer = setTimeout(() => child.kill('SIGKILL'), LOGIN_TIMEOUT_MS);
  let output = '';
  const scan = (chunk) => {
    output += chunk;
    const m = String(chunk).match(/https:\/\/[^\s]+/);
    if (m && !job.loginUrl && /cloudflare/i.test(m[0])) setJob({ loginUrl: m[0] });
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  const fail = (err) => {
    cleanupCert();
    setJob({ phase: 'error', message: err.message, loginUrl: null });
  };
  child.on('error', fail);
  child.on('close', (code) => {
    clearTimeout(timer);
    const cancelled = loginProc !== child;
    loginProc = null;
    if (cancelled) return;
    try {
      if (fs.existsSync(LOGIN_CERT_FILE) && !fs.existsSync(CERT_FILE)) {
        fs.renameSync(LOGIN_CERT_FILE, CERT_FILE);
      }
    } catch { /* checked below */ }
    if (code !== 0 || !fs.existsSync(CERT_FILE)) {
      const detail = code !== 0 ? lastLine(output) : '';
      fail(new Error(`Cloudflare authorization was not completed.${detail ? ` (${detail})` : ''}`));
      return;
    }
    finishSetup(domain)
      .then(() => setJob({ phase: 'done', message: `Tunnel active at https://${domain}`, loginUrl: null }))
      .catch(fail)
      .finally(cleanupCert);
  });
  return getStatus();
}

function cancel() {
  if (loginProc) {
    const child = loginProc;
    loginProc = null;
    child.kill('SIGKILL');
  }
  cleanupCert();
  setJob({ phase: 'idle', message: '', loginUrl: null, domain: null });
}

/** Drop the named tunnel and return to a random trycloudflare.com URL. */
function revertToQuick() {
  fs.rmSync(TOKEN_FILE, { force: true });
  fs.rmSync(DOMAIN_FILE, { force: true });
  if (!helperInstalled()) throw new Error('Run "sudo citadel tunnel --quick" on this machine to finish.');
  runHelper(['up']);
  setJob({ phase: 'idle', message: '', loginUrl: null, domain: null });
}

module.exports = { getStatus, start, cancel, revertToQuick, normalizeDomain };
