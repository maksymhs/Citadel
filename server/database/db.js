/**
 * Citadel SQLite Database Service
 */
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const { DATABASE_PATH } = require('../config');

let dbInstance = null;

/**
 * Ordered, idempotent schema migrations. Fresh databases get the full current
 * schema from the CREATE TABLE statements below, so migration #1 is a baseline
 * marker; every future schema change (new columns, data backfills) must be
 * added here as a new numbered entry so existing installs upgrade in place.
 */
const MIGRATIONS = [
  {
    name: '001_baseline',
    up: () => {
      // Baseline: schema as of v0.1.0 (projects, terminals, credentials, ...).
    },
  },
  {
    name: '002_task_mesh_enhancements',
    up: (db) => {
      // Additive columns for agent tasks and result capture. Guarded so fresh
      // databases (which already have them via CREATE TABLE) skip cleanly.
      if (!columnExists(db, 'tasks', 'result')) db.exec('ALTER TABLE tasks ADD COLUMN result TEXT');
      if (!columnExists(db, 'tasks', 'agent')) db.exec('ALTER TABLE tasks ADD COLUMN agent TEXT');
      if (!columnExists(db, 'tasks', 'prompt')) db.exec('ALTER TABLE tasks ADD COLUMN prompt TEXT');
    },
  },
];

function columnExists(db, table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((c) => c.name === column);
}

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      record.run(migration.name, new Date().toISOString());
    });
    apply();
  }
}

function initDatabase(customPath = null) {
  const dbFile = customPath || DATABASE_PATH;
  const dbDir = path.dirname(dbFile);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbFile);

  // Performance and integrity pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Create tables if not exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_active TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      path TEXT UNIQUE NOT NULL,
      git_remote TEXT,
      git_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS term_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      tmux_session TEXT UNIQUE NOT NULL,
      agent_id TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_active TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      domain TEXT UNIQUE NOT NULL,
      target_port INTEGER NOT NULL,
      status TEXT DEFAULT 'inactive',
      ssl_active INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      ip TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      config TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS git_credentials (
      provider TEXT PRIMARY KEY,
      username TEXT,
      token_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fleet_hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      token_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Distributed work queue: an orchestrator enqueues tasks, a per-node
    -- sentinel atomically claims one at a time and reports the result. A short
    -- lease (renewed by the node heartbeat) makes crashed workers harmless.
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      node TEXT,
      project_path TEXT,
      cmd TEXT NOT NULL,
      args TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      agent TEXT,
      prompt TEXT,
      lease_until TEXT,
      result_ref TEXT,
      result TEXT,
      exit_code INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    -- Nodes that run sentinels and report their load via heartbeat.
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      url TEXT,
      tags TEXT,
      capacity INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 0,
      load REAL,
      last_seen TEXT NOT NULL
    );

    -- Structured observability timeline (task lifecycle, node health, system).
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      category TEXT NOT NULL,
      node TEXT,
      task_id TEXT,
      action TEXT,
      message TEXT,
      details TEXT
    );

    -- Periodic resource samples for historical charts and export.
    CREATE TABLE IF NOT EXISTS metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      host TEXT NOT NULL,
      load1 REAL,
      load5 REAL,
      load15 REAL,
      cpu_cores INTEGER,
      mem_used_percent INTEGER,
      mem_free_mb INTEGER,
      mem_total_mb INTEGER,
      active_terminals INTEGER,
      tasks_running INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(lease_until);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
    CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metric_samples(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_host ON metric_samples(host);
  `);

  runMigrations(db);

  dbInstance = db;
  return db;
}

function getDatabase() {
  if (!dbInstance) {
    dbInstance = initDatabase();
  }
  return dbInstance;
}

function closeDatabase() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore if already closed
    }
    dbInstance = null;
  }
}

module.exports = {
  initDatabase,
  getDatabase,
  closeDatabase,
  runMigrations,
  columnExists,
};
