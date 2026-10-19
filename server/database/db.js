/**
 * Citadel SQLite Database Service
 */
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
  {
    name: '003_task_attempt_claims',
    up: (db) => {
      // Per-claim identity and retry accounting: a claim gets a fresh random
      // `claim_token` and bumps `attempt`; only the holder of the current token
      // may report a result, so a stale worker can never overwrite a newer
      // attempt. `max_attempts` bounds automatic lease-expiry retries.
      if (!columnExists(db, 'tasks', 'attempt')) db.exec('ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0');
      if (!columnExists(db, 'tasks', 'max_attempts')) db.exec('ALTER TABLE tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3');
      if (!columnExists(db, 'tasks', 'claim_token')) db.exec('ALTER TABLE tasks ADD COLUMN claim_token TEXT');
    },
  },
  {
    name: '004_task_execution_identity',
    up: (db) => {
      // Correlate an authorized attempt with the concrete local execution its
      // sentinel spawned. Additive and nullable: pre-existing rows keep their
      // current semantics (worker_protocol 1 = legacy, no tracked execution).
      // `reconcile_state` marks attempts whose process state is not known
      // (alive/uncertain/terminated) so an expired lease never silently
      // authorises a duplicate run.
      if (!columnExists(db, 'tasks', 'worker_protocol')) db.exec('ALTER TABLE tasks ADD COLUMN worker_protocol INTEGER NOT NULL DEFAULT 1');
      if (!columnExists(db, 'tasks', 'exec_id')) db.exec('ALTER TABLE tasks ADD COLUMN exec_id TEXT');
      if (!columnExists(db, 'tasks', 'exec_pid')) db.exec('ALTER TABLE tasks ADD COLUMN exec_pid INTEGER');
      if (!columnExists(db, 'tasks', 'exec_pgid')) db.exec('ALTER TABLE tasks ADD COLUMN exec_pgid INTEGER');
      if (!columnExists(db, 'tasks', 'exec_started_at')) db.exec('ALTER TABLE tasks ADD COLUMN exec_started_at TEXT');
      if (!columnExists(db, 'tasks', 'exec_reported_at')) db.exec('ALTER TABLE tasks ADD COLUMN exec_reported_at TEXT');
      if (!columnExists(db, 'tasks', 'reconcile_state')) db.exec('ALTER TABLE tasks ADD COLUMN reconcile_state TEXT');
    },
  },
  {
    name: '005_project_repositories',
    up: (db) => {
      // A project may own several repositories. The table is additive: the
      // legacy 1:1 fields on `projects` remain the authoritative metadata for
      // back-compat, and each existing project is backfilled once as its
      // primary repository so nothing is duplicated or invented.
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_repos (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          git_remote TEXT,
          git_branch TEXT,
          is_primary INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repos_project_path ON project_repos(project_id, path);
        CREATE INDEX IF NOT EXISTS idx_project_repos_project ON project_repos(project_id);
      `);

      const projects = db.prepare(`
        SELECT id, name, path, git_remote, git_branch, created_at, updated_at FROM projects
      `).all();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO project_repos
          (id, project_id, name, path, git_remote, git_branch, is_primary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const p of projects) {
        insert.run(crypto.randomUUID(), p.id, p.name, p.path, p.git_remote || null, p.git_branch || null, p.created_at, p.updated_at);
      }
    },
  },
  {
    name: '006_git_oauth_credentials',
    up: (db) => {
      // Provider tokens may now be obtained through an OAuth device flow.
      // OAuth tokens (GitLab in particular) can expire and carry a refresh
      // token, so record the expiry, the optional refresh token (encrypted like
      // the access token) and which acquisition method produced the row.
      if (!columnExists(db, 'git_credentials', 'refresh_token_encrypted')) {
        db.exec('ALTER TABLE git_credentials ADD COLUMN refresh_token_encrypted TEXT');
      }
      if (!columnExists(db, 'git_credentials', 'expires_at')) {
        db.exec('ALTER TABLE git_credentials ADD COLUMN expires_at TEXT');
      }
      if (!columnExists(db, 'git_credentials', 'scope')) {
        db.exec('ALTER TABLE git_credentials ADD COLUMN scope TEXT');
      }
      if (!columnExists(db, 'git_credentials', 'auth_method')) {
        db.exec('ALTER TABLE git_credentials ADD COLUMN auth_method TEXT');
      }
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

    -- A project may contain one or several Git repositories. Row 0 is treated
    -- as the primary repository, mirroring the legacy projects git fields.
    CREATE TABLE IF NOT EXISTS project_repos (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      git_remote TEXT,
      git_branch TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
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
      refresh_token_encrypted TEXT,
      expires_at TEXT,
      scope TEXT,
      auth_method TEXT,
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
      claim_token TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      worker_protocol INTEGER NOT NULL DEFAULT 1,
      exec_id TEXT,
      exec_pid INTEGER,
      exec_pgid INTEGER,
      exec_started_at TEXT,
      exec_reported_at TEXT,
      reconcile_state TEXT,
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
  `);

  // Migrations must run BEFORE the indexes below. Some indexes reference columns
  // that only exist after an ALTER TABLE migration (e.g. tasks.reconcile_state).
  // On an existing install the `tasks` table already exists, so CREATE TABLE IF
  // NOT EXISTS is a no-op and the column is missing until the migration runs —
  // building the index first previously aborted startup on upgraded databases.
  runMigrations(db);

  // Indexes are created last, once every column they reference is guaranteed to
  // exist (fresh schema or migrated in-place).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repos_project_path ON project_repos(project_id, path);
    CREATE INDEX IF NOT EXISTS idx_project_repos_project ON project_repos(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(lease_until);
    CREATE INDEX IF NOT EXISTS idx_tasks_reconcile ON tasks(status, reconcile_state);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
    CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metric_samples(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_host ON metric_samples(host);
  `);

  // Seed module enablement exactly once. Existing installs (any user already
  // present) keep every capability enabled; brand-new installs receive the
  // minimal defaults. Lazy-required to avoid a load-time cycle with the
  // registry, which itself reads the database.
  try {
    const registry = require('../modules/registry');
    registry.seedDefaults(db);
  } catch (err) {
    console.warn(`[Database] Could not seed module defaults: ${err.message}`);
  }

  dbInstance = db;
  return db;
}

function getDatabase() {
  if (!dbInstance) {
    dbInstance = initDatabase();
  }
  return dbInstance;
}

/**
 * The open connection, or null when the database has not been initialised yet.
 * Lets read-only callers (e.g. the connection URL service, which is also used
 * by the CLI) read the live database without creating or migrating one.
 */
function peekDatabase() {
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
  peekDatabase,
  closeDatabase,
  runMigrations,
  columnExists,
};
