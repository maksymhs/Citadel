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
    name: '006_secret_vault',
    up: (db) => {
      // Unified credential vault. Legacy installs kept git provider tokens in
      // `git_credentials`; move them in as GITHUB_TOKEN / GITLAB_TOKEN entries
      // (kind='git') reusing the exact ciphertext, then leave the old table in
      // place (harmless, never read again) so no credential is ever lost.
      db.exec(`
        CREATE TABLE IF NOT EXISTS secrets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'env',
          value_encrypted TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      const hasGitCreds = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'git_credentials'")
        .get();
      if (!hasGitCreds) return;

      const rows = db.prepare('SELECT * FROM git_credentials').all();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO secrets (name, kind, value_encrypted, metadata, created_at, updated_at)
        VALUES (?, 'git', ?, ?, ?, ?)
      `);
      for (const r of rows) {
        const name = `${String(r.provider).toUpperCase()}_TOKEN`;
        const metadata = JSON.stringify({ provider: r.provider, username: r.username || null });
        insert.run(name, r.token_encrypted, metadata, r.created_at, r.updated_at);
      }
    },
  },
  {
    name: '007_peer_pairing',
    up: (db) => {
      // Peer pairing makes the association depend on a stable instance id and a
      // rotating set of candidate URLs, not on a single address. A Cloudflare
      // Quick Tunnel URL changes on every restart; the identity survives it and
      // peers re-learn the new address via /api/host/peers/announce.
      if (!columnExists(db, 'fleet_hosts', 'instance_id')) db.exec('ALTER TABLE fleet_hosts ADD COLUMN instance_id TEXT');
      if (!columnExists(db, 'fleet_hosts', 'urls')) db.exec('ALTER TABLE fleet_hosts ADD COLUMN urls TEXT');
      if (!columnExists(db, 'fleet_hosts', 'paired_at')) db.exec('ALTER TABLE fleet_hosts ADD COLUMN paired_at TEXT');
      if (!columnExists(db, 'fleet_hosts', 'last_seen')) db.exec('ALTER TABLE fleet_hosts ADD COLUMN last_seen TEXT');

      // Inbound credentials: a peer presents one of these as a bearer token.
      // Only the SHA-256 hash is stored; the plaintext exists only on the peer.
      // The outbound credential stays in fleet_hosts.token_encrypted so the
      // proxy can call that peer back.
      db.exec(`
        CREATE TABLE IF NOT EXISTS peer_tokens (
          id TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          user_id TEXT,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT,
          FOREIGN KEY (host_id) REFERENCES fleet_hosts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_peer_tokens_host ON peer_tokens(host_id);
      `);

      // One row per known instance. Legacy manual fleet hosts keep a NULL
      // instance id, so the unique index does not conflict with them.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_hosts_instance
        ON fleet_hosts(instance_id) WHERE instance_id IS NOT NULL;
      `);
    },
  },
  {
    name: '008_pairing_invites',
    up: (db) => {
      // Invitations must survive the CLI process that creates them: `citadel
      // qr` runs independently from the server that later accepts the pairing.
      db.exec(`
        CREATE TABLE IF NOT EXISTS pairing_invites (
          id TEXT PRIMARY KEY,
          secret_hash TEXT NOT NULL,
          user_id TEXT,
          instance_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pairing_invites_expires_at
        ON pairing_invites(expires_at);
      `);
    },
  },
  {
    name: '009_host_alias',
    up: (db) => {
      // A private display name for a paired machine. The peer's own name keeps
      // updating in `name`; the alias only changes how it is shown here.
      if (!columnExists(db, 'fleet_hosts', 'alias')) db.exec('ALTER TABLE fleet_hosts ADD COLUMN alias TEXT');
    },
  },
  {
    name: '010_login_ips',
    up: (db) => {
      // Addresses each user has signed in from, so a sign-in from a new one can
      // raise a security alert.
      db.exec(`
        CREATE TABLE IF NOT EXISTS login_ips (
          user_id TEXT NOT NULL,
          ip TEXT NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (user_id, ip)
        );
      `);
    },
  },
  {
    name: '011_agent_missions',
    up: (db) => {
      // A mission is the durable "mini-Jira" project around a team of agent
      // tasks. Tasks keep their own lifecycle (claims, leases, retries); the
      // mission only groups them and records the dependency DAG, the role and
      // the handoff file. Additive and idempotent for fresh databases.
      db.exec(`
        CREATE TABLE IF NOT EXISTS missions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          project_id TEXT,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'planning',
          planner_agent TEXT,
          planner_task_id TEXT,
          workspace TEXT NOT NULL,
          plan TEXT,
          error TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id);
      `);
      if (!columnExists(db, 'tasks', 'mission_id')) db.exec('ALTER TABLE tasks ADD COLUMN mission_id TEXT');
      if (!columnExists(db, 'tasks', 'role')) db.exec('ALTER TABLE tasks ADD COLUMN role TEXT');
      if (!columnExists(db, 'tasks', 'deps')) db.exec('ALTER TABLE tasks ADD COLUMN deps TEXT');
      if (!columnExists(db, 'tasks', 'stage')) db.exec('ALTER TABLE tasks ADD COLUMN stage INTEGER NOT NULL DEFAULT 0');
      if (!columnExists(db, 'tasks', 'handoff_ref')) db.exec('ALTER TABLE tasks ADD COLUMN handoff_ref TEXT');
      if (!columnExists(db, 'tasks', 'exclusive')) db.exec('ALTER TABLE tasks ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0');
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id, created_at)');
    },
  },
  {
    name: '012_task_title',
    up: (db) => {
      // The board and office show a human title; the prompt alone made every
      // mission card look like "Untitled task".
      if (!columnExists(db, 'tasks', 'title')) db.exec('ALTER TABLE tasks ADD COLUMN title TEXT');
    },
  },
  {
    name: '013_autonomous_learning_docs',
    up: (db) => {
      // Work: acceptance criteria, references and the autonomous-loop controls.
      // `autonomous` marks only mission work, so the single-autonomous-agent
      // guard never serialises manually enqueued tasks. `blocked_reason` and
      // `retry_at` represent quota/network pauses without inventing a reset time.
      for (const [column, definition] of [
        ['acceptance', 'TEXT'],
        ['refs', 'TEXT'],
        ['autonomous', 'INTEGER NOT NULL DEFAULT 0'],
        ['blocked_reason', 'TEXT'],
        ['retry_at', 'TEXT'],
        ['review_note', 'TEXT'],
        ['quota_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['learning_recorded', 'INTEGER NOT NULL DEFAULT 0'],
      ]) {
        if (!columnExists(db, 'tasks', column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_autonomous
        ON tasks(status, autonomous) WHERE autonomous = 1;
      `);

      // Compact plan history: a revision never destroys the plan it replaced.
      db.exec(`
        CREATE TABLE IF NOT EXISTS mission_plan_versions (
          id TEXT PRIMARY KEY,
          mission_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          plan TEXT NOT NULL,
          reason TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mission_plan_versions
        ON mission_plan_versions(mission_id, version);
      `);

      if (!columnExists(db, 'missions', 'plan_version')) db.exec('ALTER TABLE missions ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0');
      if (!columnExists(db, 'missions', 'used_lessons')) db.exec('ALTER TABLE missions ADD COLUMN used_lessons TEXT');

      // Structured, recoverable memory. Text only: no logs, no conversations and
      // no embeddings. dedupe_key makes repeated observations update a row
      // instead of multiplying near-identical lessons.
      db.exec(`
        CREATE TABLE IF NOT EXISTS lessons (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL DEFAULT 'project',
          status TEXT NOT NULL DEFAULT 'pending',
          project_id TEXT,
          task_id TEXT,
          mission_id TEXT,
          title TEXT NOT NULL,
          problem TEXT,
          context TEXT,
          root_cause TEXT,
          root_cause_confirmed INTEGER NOT NULL DEFAULT 0,
          solution TEXT,
          rule TEXT,
          components TEXT,
          evidence TEXT,
          tags TEXT,
          source TEXT,
          occurrences INTEGER NOT NULL DEFAULT 1,
          dedupe_key TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          confirmed_at TEXT,
          superseded_by TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_dedupe ON lessons(dedupe_key) WHERE dedupe_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(scope, status, project_id);
        CREATE INDEX IF NOT EXISTS idx_lessons_project ON lessons(project_id, status);
      `);

      // Document metadata only: the Markdown body stays in the project checkout,
      // versioned by the project's own Git history.
      db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          task_id TEXT,
          mission_id TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, path);
      `);
    },
  },
  {
    name: '014_review_budget_docs',
    up: (db) => {
      // Acceptance review is a real state, not an optional note on a task that
      // already counts as done. `failure_kind` records the deterministic class
      // of a failed attempt; `docs_linked` makes handoff -> docs linking a
      // one-time, idempotent operation.
      for (const [column, definition] of [
        ['reviewed_at', 'TEXT'],
        ['reviewed_by', 'TEXT'],
        ['failure_kind', 'TEXT'],
        ['docs_linked', 'INTEGER NOT NULL DEFAULT 0'],
      ]) {
        if (!columnExists(db, 'tasks', column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
      }

      // A document can reference many tasks/missions and many other documents.
      // The legacy columns on `documents` stay as the most recent single link
      // for compatibility; these tables are the authoritative relations.
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_links (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          from_path TEXT NOT NULL,
          to_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(project_id, from_path, to_path)
        );
        CREATE INDEX IF NOT EXISTS idx_document_links_from
        ON document_links(project_id, from_path);
        CREATE INDEX IF NOT EXISTS idx_document_links_to
        ON document_links(project_id, to_path);

        CREATE TABLE IF NOT EXISTS document_refs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          ref_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(project_id, path, kind, ref_id)
        );
        CREATE INDEX IF NOT EXISTS idx_document_refs_ref
        ON document_refs(kind, ref_id);
        CREATE INDEX IF NOT EXISTS idx_document_refs_path
        ON document_refs(project_id, path);
      `);
    },
  },
  {
    name: '015_attempt_usage_and_legacy_refs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS autonomous_daily_usage (
          day TEXT PRIMARY KEY,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0)
        );
        -- Older installs lack per-attempt dates. Conservatively count all
        -- attempts of tasks first started today; exact history is unavailable.
        INSERT OR IGNORE INTO autonomous_daily_usage (day, attempts)
        SELECT date(started_at, 'localtime'), SUM(attempt)
        FROM tasks WHERE autonomous = 1 AND started_at IS NOT NULL
          AND date(started_at, 'localtime') = date('now', 'localtime')
        GROUP BY date(started_at, 'localtime');
        INSERT OR IGNORE INTO document_refs (id, project_id, path, kind, ref_id, created_at)
        SELECT lower(hex(randomblob(16))), project_id, path, 'task', task_id, created_at
        FROM documents WHERE task_id IS NOT NULL AND task_id != '';
        INSERT OR IGNORE INTO document_refs (id, project_id, path, kind, ref_id, created_at)
        SELECT lower(hex(randomblob(16))), project_id, path, 'mission', mission_id, created_at
        FROM documents WHERE mission_id IS NOT NULL AND mission_id != '';
      `);
    },
  },
  {
    name: '016_project_event_trace',
    up: (db) => {
      if (!columnExists(db, 'events', 'project_id')) db.exec('ALTER TABLE events ADD COLUMN project_id TEXT');
      db.exec(`
        UPDATE events SET project_id = COALESCE(
          json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END, '$.projectId'),
          (SELECT project_id FROM missions WHERE id = json_extract(CASE WHEN json_valid(events.details) THEN events.details ELSE '{}' END, '$.missionId')),
          (SELECT COALESCE(m.project_id, p.id) FROM tasks t
            LEFT JOIN missions m ON m.id = t.mission_id
            LEFT JOIN projects p ON p.path = t.project_path WHERE t.id = events.task_id)
        ) WHERE project_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id);
      `);
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

    -- Single encrypted credential store ("vault"): git provider tokens, env
    -- vars and files agents need. Values are AES-256-GCM encrypted at rest via
    -- security/secrets.js and reachable by agents through the citadel-creds CLI
    -- and by terminals at spawn, so there is one place to add/rotate/revoke.
    CREATE TABLE IF NOT EXISTS secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'env',
      value_encrypted TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Deleted vault entries, kept so that peer sync propagates deletions
    -- instead of resurrecting the secret from a machine that still has it.
    CREATE TABLE IF NOT EXISTS secret_tombstones (
      name TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fleet_hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      token_encrypted TEXT NOT NULL,
      instance_id TEXT,
      urls TEXT,
      paired_at TEXT,
      last_seen TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Inbound peer credentials (one per paired host). Only the SHA-256 hash of
    -- the bearer token is stored; the peer keeps the plaintext.
    CREATE TABLE IF NOT EXISTS peer_tokens (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (host_id) REFERENCES fleet_hosts(id) ON DELETE CASCADE
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
      title TEXT,
      mission_id TEXT,
      role TEXT,
      deps TEXT,
      stage INTEGER NOT NULL DEFAULT 0,
      handoff_ref TEXT,
      exclusive INTEGER NOT NULL DEFAULT 0,
      acceptance TEXT,
      refs TEXT,
      autonomous INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT,
      retry_at TEXT,
      review_note TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      failure_kind TEXT,
      quota_count INTEGER NOT NULL DEFAULT 0,
      learning_recorded INTEGER NOT NULL DEFAULT 0,
      docs_linked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    -- A mission groups agent tasks into a validated DAG. The tasks table keeps
    -- its own lifecycle; this row is the durable project/goal and the workspace
    -- where handoffs and notes live.
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      planner_agent TEXT,
      planner_task_id TEXT,
      workspace TEXT NOT NULL,
      plan TEXT,
      plan_version INTEGER NOT NULL DEFAULT 0,
      used_lessons TEXT,
      error TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id);
    -- tasks.autonomous is added by migration 013 on existing installs, so its
    -- index is created there (never before the column exists).
    -- tasks.mission_id is added by migration 011 for existing installs, so its
    -- index is created there too (never before the column exists).

    CREATE TABLE IF NOT EXISTS mission_plan_versions (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      plan TEXT NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mission_plan_versions
    ON mission_plan_versions(mission_id, version);

    -- Structured learning memory. Project lessons stay scoped to their project;
    -- global lessons exist only after an explicit promotion.
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'project',
      status TEXT NOT NULL DEFAULT 'pending',
      project_id TEXT,
      task_id TEXT,
      mission_id TEXT,
      title TEXT NOT NULL,
      problem TEXT,
      context TEXT,
      root_cause TEXT,
      root_cause_confirmed INTEGER NOT NULL DEFAULT 0,
      solution TEXT,
      rule TEXT,
      components TEXT,
      evidence TEXT,
      tags TEXT,
      source TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1,
      dedupe_key TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      confirmed_at TEXT,
      superseded_by TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_dedupe ON lessons(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(scope, status, project_id);
    CREATE INDEX IF NOT EXISTS idx_lessons_project ON lessons(project_id, status);

    -- Metadata and links only: document bodies live as Markdown in the project.
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT,
      task_id TEXT,
      mission_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, path);

    CREATE TABLE IF NOT EXISTS autonomous_daily_usage (
      day TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0)
    );

    -- Relations between pages and many task/mission references. The body stays
    -- in Markdown; this only records navigable metadata.
    CREATE TABLE IF NOT EXISTS document_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      from_path TEXT NOT NULL,
      to_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, from_path, to_path)
    );
    CREATE INDEX IF NOT EXISTS idx_document_links_from
    ON document_links(project_id, from_path);
    CREATE INDEX IF NOT EXISTS idx_document_links_to
    ON document_links(project_id, to_path);

    CREATE TABLE IF NOT EXISTS document_refs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, path, kind, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_document_refs_ref
    ON document_refs(kind, ref_id);
    CREATE INDEX IF NOT EXISTS idx_document_refs_path
    ON document_refs(project_id, path);

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
      project_id TEXT,
      action TEXT,
      message TEXT,
      details TEXT
    );

    -- One reachability/health probe per machine, for uptime % and history.
    CREATE TABLE IF NOT EXISTS host_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      online INTEGER NOT NULL,
      latency_ms INTEGER,
      load_per_core REAL,
      mem_percent INTEGER,
      disk_percent INTEGER
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
    CREATE INDEX IF NOT EXISTS idx_host_checks_host_ts ON host_checks(host_id, ts);
    CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
    CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metric_samples(ts);
    CREATE INDEX IF NOT EXISTS idx_metrics_host ON metric_samples(host);
    CREATE INDEX IF NOT EXISTS idx_peer_tokens_host ON peer_tokens(host_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_hosts_instance
      ON fleet_hosts(instance_id) WHERE instance_id IS NOT NULL;
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
