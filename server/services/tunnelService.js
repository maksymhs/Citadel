/**
 * Cloudflare Quick Tunnel support.
 *
 * A small wrapper service (`citadel-tunnel.service`) runs `cloudflared` and
 * writes the current public `https://*.trycloudflare.com` URL to a file. This
 * module reads that file so the panel (QR code, "Connect from your phone") can
 * follow along even though a Quick Tunnel URL changes on every restart.
 */
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR } = require('../config');

const TUNNEL_URL_FILE = path.join(DATA_DIR, 'tunnel-url');

function normalizeTunnelUrl(value) {
  if (!value) return null;
  const url = String(value).trim().split(/\s+/)[0];
  if (!/^https:\/\//i.test(url)) return null;
  if (!/\.trycloudflare\.com$/i.test(url.replace(/\/+$/, ''))) return null;
  return url.replace(/\/+$/, '');
}

function getTunnelUrl() {
  try {
    return normalizeTunnelUrl(fs.readFileSync(TUNNEL_URL_FILE, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { getTunnelUrl, normalizeTunnelUrl, TUNNEL_URL_FILE };
