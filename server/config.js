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

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'citadel.db');
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(DATA_DIR, 'projects');
const LOGS_DIR = process.env.LOGS_DIR || path.join(DATA_DIR, 'logs');
const PLUGINS_DIR = process.env.PLUGINS_DIR || path.join(ROOT_DIR, 'plugins');

// Allowed origins for CORS and WebSocket handshake
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`;
const ALLOWED_ORIGINS = allowedOriginsEnv.split(',').map((o) => o.trim()).filter(Boolean);

// Session configuration
const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS, 10) || 7;
const SESSION_SECRET = process.env.SESSION_SECRET || null; // Will auto-generate if null

// Optional privileged user for the in-panel System Terminal. When set (e.g.
// "ubuntu"), non-project sessions are spawned as that OS user via sudo, which
// makes the panel root-capable. Empty keeps terminals as the unprivileged
// service user (secure default).
const TERMINAL_ADMIN_USER = process.env.TERMINAL_ADMIN_USER || null;

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
  DATA_DIR,
  DATABASE_PATH,
  PROJECTS_DIR,
  LOGS_DIR,
  PLUGINS_DIR,
  ALLOWED_ORIGINS,
  SESSION_TTL_DAYS,
  SESSION_SECRET,
  TERMINAL_ADMIN_USER,
  APP_VERSION,
  UPDATE_REPO,
  UPDATE_BRANCH,
  UPDATER_PATH,
  SERVICE_NAME,
  TMUX_PATH,
  CADDY_ADMIN_API,
  DOCKER_SOCKET,
};
