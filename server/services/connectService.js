const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const qrcode = require('qrcode-generator');

const { PUBLIC_URL, PORT, HOST, DATA_DIR } = require('../config');
const { getTunnelUrl } = require('./tunnelService');

const CACHE_TTL_MS = 60 * 1000;
const STORED_KEY = 'connect.public_url';
const STORED_FILE = path.join(DATA_DIR, 'public-url');
let cache = null;
let cacheAt = 0;
let configuredCache;
let configuredAt = 0;

function normalizeUrl(value) {
  if (!value) return null;
  let url = String(value).trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

/**
 * The administrator-configured public URL, if any. Read from the live database
 * when the server is running, falling back to a small mirror file so the CLI and
 * installer (which may run without the database) see the same value.
 */
function readStoredPublicUrl() {
  try {
    const { peekDatabase } = require('../database/db');
    const db = peekDatabase();
    if (db) {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(STORED_KEY);
      if (row && row.value) return row.value;
    }
  } catch {
    // Ignore and try the mirror file.
  }
  try {
    if (fs.existsSync(STORED_FILE)) {
      const value = fs.readFileSync(STORED_FILE, 'utf8').split('\n')[0].trim();
      if (value) return value;
    }
  } catch {
    // Ignore.
  }
  return null;
}

/**
 * Mirror the stored public URL to a file next to the database so the `citadel`
 * CLI and the installer banner resolve the same address. Best-effort.
 */
function writeStoredPublicUrl(value) {
  try {
    if (value) {
      fs.writeFileSync(STORED_FILE, `${value}\n`, { mode: 0o644 });
    } else if (fs.existsSync(STORED_FILE)) {
      fs.unlinkSync(STORED_FILE);
    }
  } catch {
    // Non-fatal: the database copy remains the source of truth for the server.
  }
}

/**
 * The public URL an administrator set, if any. An operator-provided environment
 * value takes precedence over the stored setting. Returns null when neither is
 * set (auto-detection then decides).
 */
function getConfiguredPublicUrl() {
  const now = Date.now();
  if (configuredCache !== undefined && now - configuredAt < CACHE_TTL_MS) return configuredCache;
  const fromEnv = normalizeUrl(PUBLIC_URL);
  configuredCache = fromEnv || normalizeUrl(readStoredPublicUrl()) || null;
  configuredAt = now;
  return configuredCache;
}

function detectTailscale() {
  try {
    const res = spawnSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const data = JSON.parse(res.stdout);
    const dnsName = data && data.Self && data.Self.DNSName;
    if (!dnsName) return null;
    return { url: `https://${dnsName.replace(/\.$/, '')}`, source: 'tailscale' };
  } catch {
    return null;
  }
}

function detectLanIp() {
  // Prefer the source address of the default route: the real network the phone
  // most likely shares (avoids docker/VPN interfaces).
  try {
    const res = spawnSync('ip', ['route', 'get', '1.1.1.1'], { encoding: 'utf8', timeout: 2000 });
    if (res.status === 0 && res.stdout) {
      const match = res.stdout.match(/\bsrc\s+(\S+)/);
      if (match) return match[1];
    }
  } catch {
    // fall through to interface scanning
  }

  const candidates = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push(net.address);
    }
  }
  const privateIp = candidates.find((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return privateIp || candidates[0] || null;
}

function isLoopbackHost(host) {
  return !host || host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function resolve() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  let result;
  const configured = getConfiguredPublicUrl();
  const tunnel = getTunnelUrl();
  if (configured) {
    result = { url: configured, source: 'configured' };
  } else if (tunnel) {
    result = { url: tunnel, source: 'tunnel' };
  } else {
    result = detectTailscale();
    if (!result && !isLoopbackHost(HOST)) {
      if (HOST !== '0.0.0.0' && HOST !== '::') {
        result = { url: `http://${HOST}:${PORT}`, source: 'lan' };
      } else {
        const ip = detectLanIp();
        result = ip ? { url: `http://${ip}:${PORT}`, source: 'lan' } : null;
      }
    }
    if (!result) {
      result = { url: `http://127.0.0.1:${PORT}`, source: 'localhost' };
    }
  }

  cache = result;
  cacheAt = now;
  return result;
}

function qrAnsi(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2;
  const size = count + quiet * 2;
  const BLACK = '\x1b[40m  \x1b[0m';
  const WHITE = '\x1b[47m  \x1b[0m';
  let out = '\n';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const insideRow = row >= quiet && row < quiet + count;
      const insideCol = col >= quiet && col < quiet + count;
      const dark = insideRow && insideCol && qr.isDark(row - quiet, col - quiet);
      out += dark ? BLACK : WHITE;
    }
    out += '\n';
  }
  return out;
}

function qrSvg(text) {
  const qr = qrcode(0, 'H');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 8, margin: 4 });
  // Hard-edged modules scan far more reliably than anti-aliased ones.
  return svg.replace('<svg ', '<svg shape-rendering="crispEdges" ');
}

function getConnectInfo() {
  const { url, source } = resolve();
  return { url, source, qrSvg: qrSvg(url) };
}

module.exports = {
  getConnectInfo,
  getConfiguredPublicUrl,
  writeStoredPublicUrl,
  qrSvg,
  qrAnsi,
  normalizeUrl,
  _reset: () => { cache = null; cacheAt = 0; configuredCache = undefined; configuredAt = 0; },
};
