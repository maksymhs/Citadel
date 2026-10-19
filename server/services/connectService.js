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

function isPrivateIp(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip);
}

function detectPublicIp() {
  try {
    const publicIpFile = path.join(DATA_DIR, 'public-ip');
    if (fs.existsSync(publicIpFile)) {
      const ip = fs.readFileSync(publicIpFile, 'utf8').trim().split(/\s+/)[0];
      if (ip && !isPrivateIp(ip)) return ip;
    }
  } catch {
    // ignore
  }
  return null;
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
  // Prefer a public IP if any interface has one, then private LAN IP
  const publicIp = candidates.find((ip) => !isPrivateIp(ip));
  if (publicIp) return publicIp;
  const privateIp = candidates.find((ip) => isPrivateIp(ip));
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
    if (!result) {
      const publicIp = detectPublicIp();
      if (publicIp) {
        result = { url: `http://${publicIp}:${PORT}`, source: 'public' };
      }
    }
    if (!result && !isLoopbackHost(HOST)) {
      if (HOST !== '0.0.0.0' && HOST !== '::') {
        result = { url: `http://${HOST}:${PORT}`, source: 'lan' };
      } else {
        const ip = detectLanIp();
        result = ip ? { url: `http://${ip}:${PORT}`, source: isPrivateIp(ip) ? 'lan' : 'public' } : null;
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

const QR_QUIET = 2;

function makeQr(text, ecc = 'L') {
  const qr = qrcode(0, ecc);
  qr.addData(text);
  qr.make();
  return qr;
}

/**
 * How many terminal columns a QR code needs. Half-block cells draw one module
 * per column, so the module count plus the quiet zone is the printed width.
 */
function qrColumns(text, { ecc = 'L', quiet = QR_QUIET } = {}) {
  return makeQr(text, ecc).getModuleCount() + quiet * 2;
}

/**
 * True when the code fits the terminal without wrapping. A wrapped QR is not
 * merely ugly: every line after the first is shifted, so it cannot be scanned.
 */
function qrFits(text, maxWidth = 80, options = {}) {
  return qrColumns(text, options) <= maxWidth;
}

function qrAnsi(text) {
  // Half-block cells keep the printed code roughly square while using half the
  // columns of a two-space-per-module renderer. Pairing links are long, so this
  // is what keeps the terminal QR inside a standard 80-column console.
  const qr = makeQr(text);
  const count = qr.getModuleCount();
  const quiet = QR_QUIET;
  const size = count + quiet * 2;
  const isDark = (row, col) => row >= quiet && row < quiet + count
    && col >= quiet && col < quiet + count
    && qr.isDark(row - quiet, col - quiet);
  // Force black-on-white so the code keeps its polarity on dark terminals.
  let out = '\n\x1b[30;47m';
  for (let row = 0; row < size; row += 2) {
    for (let col = 0; col < size; col++) {
      const top = isDark(row, col);
      const bottom = isDark(row + 1, col);
      if (top && bottom) out += '█';
      else if (top) out += '▀';
      else if (bottom) out += '▄';
      else out += ' ';
    }
    out += '\x1b[0m\n\x1b[30;47m';
  }
  return `${out}\x1b[0m`;
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

/**
 * Every address this panel may currently be reachable at, most-likely first.
 * Peer pairing stores the whole list so an address rotation (a Cloudflare Quick
 * Tunnel URL changes on every restart) never loses the association: callers try
 * each candidate until one answers.
 */
let candidatesCache = null;
let candidatesAt = 0;

function getCandidateUrls() {
  const now = Date.now();
  if (candidatesCache && now - candidatesAt < CACHE_TTL_MS) return candidatesCache.slice();

  const urls = [];
  const push = (value) => {
    const normalized = normalizeUrl(value);
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  };

  push(getConfiguredPublicUrl());
  push(getTunnelUrl());

  const tailscale = detectTailscale();
  if (tailscale) push(tailscale.url);

  const publicIp = detectPublicIp();
  if (publicIp) push(`http://${publicIp}:${PORT}`);

  if (!isLoopbackHost(HOST) && HOST !== '0.0.0.0' && HOST !== '::') {
    push(`http://${HOST}:${PORT}`);
  } else {
    const ip = detectLanIp();
    if (ip) push(`http://${ip}:${PORT}`);
  }

  // The effective address first, then localhost as a last-resort same-host hop.
  push(resolve().url);
  push(`http://127.0.0.1:${PORT}`);

  candidatesCache = urls;
  candidatesAt = now;
  return urls.slice();
}

module.exports = {
  getConnectInfo,
  getCandidateUrls,
  getConfiguredPublicUrl,
  writeStoredPublicUrl,
  qrSvg,
  qrAnsi,
  qrColumns,
  qrFits,
  normalizeUrl,
  _reset: () => {
    cache = null;
    cacheAt = 0;
    configuredCache = undefined;
    configuredAt = 0;
    candidatesCache = null;
    candidatesAt = 0;
  },
};
