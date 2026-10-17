/**
 * NexusVPS Server Configuration
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Helper to resolve paths relative to root or environment
const ROOT_DIR = path.resolve(__dirname, '..');

// Environment variables with secure defaults
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // Listen on localhost by default for security
const NODE_ENV = process.env.NODE_ENV || 'development';

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'nexusvps.db');
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(DATA_DIR, 'projects');
const LOGS_DIR = process.env.LOGS_DIR || path.join(DATA_DIR, 'logs');
const PLUGINS_DIR = process.env.PLUGINS_DIR || path.join(ROOT_DIR, 'plugins');

// Allowed origins for CORS and WebSocket handshake
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`;
const ALLOWED_ORIGINS = allowedOriginsEnv.split(',').map((o) => o.trim()).filter(Boolean);

// Session configuration
const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS, 10) || 7;
const SESSION_SECRET = process.env.SESSION_SECRET || null; // Will auto-generate if null

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
  TMUX_PATH,
  CADDY_ADMIN_API,
  DOCKER_SOCKET,
};
