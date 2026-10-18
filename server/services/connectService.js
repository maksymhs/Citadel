const os = require('node:os');
const { spawnSync } = require('node:child_process');
const qrcode = require('qrcode-generator');

const { PUBLIC_URL, PORT, HOST } = require('../config');

const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cacheAt = 0;

function normalizeUrl(value) {
  if (!value) return null;
  let url = String(value).trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
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
  const configured = normalizeUrl(PUBLIC_URL);
  if (configured) {
    result = { url: configured, source: 'configured' };
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

module.exports = { getConnectInfo, normalizeUrl, _reset: () => { cache = null; cacheAt = 0; } };
