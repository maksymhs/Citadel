/**
 * Citadel Server Configuration
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Helper to resolve paths relative to root or environment
const ROOT_DIR = path.resolve(__dirname, '..');

// Load optional .env file (no dependency). Values already present in the
// environment (e.g. set by systemd) take precedence over the file.
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // No .env file present; rely on the process environment / systemd unit.
}

// Environment variables with secure defaults
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // Listen on localhost by default for security
const NODE_ENV = process.env.NODE_ENV || 'development';

// Which direct peers may set X-Forwarded-* headers (proxy trust). Only connections
// from these addresses have their forwarded headers honoured; anything else uses
// the real socket address. Defaults to loopback so a local reverse proxy
// (cloudflared, caddy, ssh -L) works while a direct/LAN client can never spoof
// its IP (rate limits) or protocol (cookie Secure flag). Set to `false`/`none` to
// ignore forwarded headers entirely. `true` trusts everyone and is NOT safe on a
// directly reachable panel.
function parseTrustProxy(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 'loopback';
  const v = String(value).trim();
  const normalized = v.toLowerCase();
  if (['0', 'false', 'off', 'none', 'no'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  return v; // 'loopback', a CIDR or a comma-separated list of addresses/CIDRs
}
const TRUST_PROXY = parseTrustProxy(process.env.CITADEL_TRUST_PROXY);

// Relative paths in .env (e.g. ./data/projects) resolve against the app root,
// not the process cwd, so child processes started with another cwd (git clone)
// never see a different location.
const resolveFromRoot = (value, fallback) => path.resolve(ROOT_DIR, value || fallback);

const DATA_DIR = resolveFromRoot(process.env.DATA_DIR, 'data');
const DATABASE_PATH = resolveFromRoot(process.env.DATABASE_PATH, path.join(DATA_DIR, 'citadel.db'));
const PROJECTS_DIR = resolveFromRoot(process.env.PROJECTS_DIR, path.join(DATA_DIR, 'projects'));
const LOGS_DIR = resolveFromRoot(process.env.LOGS_DIR, path.join(DATA_DIR, 'logs'));
const PLUGINS_DIR = resolveFromRoot(process.env.PLUGINS_DIR, 'plugins');
// Allowed origins for CORS and WebSocket handshake
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`;
const ALLOWED_ORIGINS = allowedOriginsEnv.split(',').map((o) => o.trim()).filter(Boolean);

// Session configuration
const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS, 10) || 7;
const SESSION_SECRET = process.env.SESSION_SECRET || null; // Will auto-generate if null

// Optional privileged user for the in-panel System Terminal. When set (e.g.
// "ubuntu"), non-project sessions are spawned as that OS user via sudo, which
// makes the panel root-capable. Empty keeps terminals as the unprivileged
// service user (secure default). Values that are not a valid local username are
// rejected (fail closed) instead of being passed to sudo.
const TERMINAL_ADMIN_USER_RAW = process.env.TERMINAL_ADMIN_USER || null;
let TERMINAL_ADMIN_USER = null;
if (TERMINAL_ADMIN_USER_RAW) {
  if (/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(TERMINAL_ADMIN_USER_RAW)) {
    TERMINAL_ADMIN_USER = TERMINAL_ADMIN_USER_RAW;
  } else {
    console.warn('[Config] Ignoring invalid TERMINAL_ADMIN_USER; privileged System Terminal stays disabled.');
  }
}

// Shared, world-readable directory used as the installation HOME for CLI agents
// (the one-line installers honour $HOME). Keeping them outside any user home
// means installing an agent once makes it usable by every OS user; the resulting
// binaries are also symlinked into /usr/local/bin (already on everyone's PATH).
const AGENTS_DIR = process.env.CITADEL_AGENTS_DIR || '/opt/citadel/agents';

// Application version and self-update configuration
let APP_VERSION = '0.0.0';
try {
  APP_VERSION = require(path.join(ROOT_DIR, 'package.json')).version || APP_VERSION;
} catch {
  // package.json unavailable; keep default.
}
const UPDATE_REPO = process.env.CITADEL_REPO || 'maksymhs/Citadel'; // "owner/name" on GitHub
const UPDATE_BRANCH = process.env.CITADEL_REPO_BRANCH || 'main';
const UPDATER_PATH = process.env.CITADEL_UPDATER_PATH || '/usr/local/sbin/citadel-update';
const SERVICE_NAME = process.env.CITADEL_SERVICE || 'citadel';
// Allow the panel to update itself as the service user (no root helper). Set
// CITADEL_SELF_UPDATE=0 (as the test suite does) to disable it entirely.
const SELF_UPDATE_ENABLED = !['0', 'false', 'off', 'no'].includes(
  String(process.env.CITADEL_SELF_UPDATE || '1').toLowerCase(),
);

// Scoped credential for task-mesh worker nodes (sentinels). When set, the
// worker endpoints (claim/result/heartbeat) accept the X-Citadel-Node-Token
// header instead of a full admin session, so a compromised node does not hold
// panel-wide privileges. Unset keeps the previous session-based behaviour.
// This is a single installation-wide secret: every node authenticates with the
// same value and the node id it declares is taken on trust (shared-perimeter
// model). Prefer CITADEL_NODE_TOKENS below when nodes are not all trusted.
const NODE_TOKEN = process.env.CITADEL_NODE_TOKEN || null;

// Optional per-node worker credentials, "nodeId:token" pairs separated by
// commas, semicolons or newlines (e.g. "vps-1:<secret>,vps-2:<secret>").
//
// Three explicit states (worker node-token auth):
//   - unset/empty        : legacy shared-token model (CITADEL_NODE_TOKEN), kept
//                          for compatibility.
//   - configured + valid : per-node identity binding; the shared token is
//                          ignored for worker endpoints.
//   - configured + all entries invalid: fail closed. Worker node-token auth is
//                          disabled (the shared token is NOT used as a silent
//                          fallback), an error is logged, and nothing is
//                          persisted. Fix the value and restart.
//
// Malformed or short entries are ignored with a warning that never contains
// the token itself. Rotation/revocation = edit this value and restart.
function parseNodeTokens(value) {
  const map = new Map();
  if (!value) return map;
  const entries = String(value).split(/[,;\n]+/).map((e) => e.trim()).filter(Boolean);
  entries.forEach((entry, index) => {
    const sep = entry.indexOf(':');
    if (sep <= 0 || sep === entry.length - 1) {
      console.warn(`[Config] Ignoring malformed CITADEL_NODE_TOKENS entry #${index + 1} (expected nodeId:token); token value never logged.`);
      return;
    }
    const nodeId = entry.slice(0, sep).trim();
    const token = entry.slice(sep + 1).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(nodeId) || token.length < 16) {
      console.warn(`[Config] Ignoring invalid CITADEL_NODE_TOKENS entry #${index + 1} (node id must be [A-Za-z0-9._-]{1,64}, token at least 16 chars).`);
      return;
    }
    map.set(nodeId, token);
  });
  return map;
}
// Whether the administrator explicitly selected the per-node credential model.
// An explicitly empty value (e.g. "CITADEL_NODE_TOKENS=") counts as unset, the
// way docker-compose/systemd pass optional variables.
const NODE_TOKENS_RAW = process.env.CITADEL_NODE_TOKENS;
const NODE_TOKENS_CONFIGURED = typeof NODE_TOKENS_RAW === 'string' && NODE_TOKENS_RAW.trim() !== '';
const NODE_TOKENS = parseNodeTokens(NODE_TOKENS_RAW);
if (NODE_TOKENS_CONFIGURED && NODE_TOKENS.size === 0) {
  // Selecting identity binding must never silently degrade to the shared
  // secret. The map is authoritative even when empty: no node token will be
  // accepted on worker endpoints until the value is fixed. The message never
  // contains an entry or token.
  console.error(
    '[Config] CITADEL_NODE_TOKENS is set but no valid "nodeId:token" entry could be parsed. ' +
    'Worker node-token authentication is disabled (fail closed); the shared CITADEL_NODE_TOKEN will NOT be used. ' +
    'Fix the value and restart the server.'
  );
}
if (NODE_TOKENS.size > 0 && NODE_TOKEN) {
  console.warn('[Config] CITADEL_NODE_TOKENS is set: the shared CITADEL_NODE_TOKEN is ignored for worker endpoints.');
}

// Synchronized updates across hosts. CITADEL_PEERS is a comma-separated list of
// peer base URLs (e.g. https://vps2.example.com). When CITADEL_PEER_TOKEN is
// set, triggering an update on this host also asks every peer to update itself;
// the peer authenticates that request with the X-Citadel-Peer-Token header.
const PEER_TOKEN = process.env.CITADEL_PEER_TOKEN || null;
const PEER_URLS = (process.env.CITADEL_PEERS || '')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// Public URL shown as a QR code so a phone can open the panel remotely. When
// empty, the server auto-detects a Tailscale (*.ts.net) address, then the LAN
// IP. Set it explicitly (e.g. https://vps2.example.com) to pin it.
const PUBLIC_URL = process.env.CITADEL_PUBLIC_URL || null;

// Tool and integration paths
const TMUX_PATH = process.env.TMUX_PATH || 'tmux';
const CADDY_ADMIN_API = process.env.CADDY_ADMIN_API || 'http://127.0.0.1:2019';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || (os.platform() === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');

// Ensure necessary persistent directories exist
for (const dir of [DATA_DIR, PROJECTS_DIR, LOGS_DIR, PLUGINS_DIR]) {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn(`[Config] Notice: Could not create directory ${dir}: ${err.message}`);
    }
  }
}

module.exports = {
  ROOT_DIR,
  PORT,
  HOST,
  NODE_ENV,
  TRUST_PROXY,
  NODE_TOKEN,
  NODE_TOKENS,
  NODE_TOKENS_CONFIGURED,
  DATA_DIR,
  DATABASE_PATH,
  PROJECTS_DIR,
  LOGS_DIR,
  PLUGINS_DIR,
  ALLOWED_ORIGINS,
  SESSION_TTL_DAYS,
  SESSION_SECRET,
  TERMINAL_ADMIN_USER,
  AGENTS_DIR,
  APP_VERSION,
  UPDATE_REPO,
  UPDATE_BRANCH,
  UPDATER_PATH,
  SELF_UPDATE_ENABLED,
  SERVICE_NAME,
  PEER_TOKEN,
  PEER_URLS,
  PUBLIC_URL,
  TMUX_PATH,
  CADDY_ADMIN_API,
  DOCKER_SOCKET,
};
