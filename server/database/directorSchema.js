/** Historical director schema retained for migration compatibility; no runtime uses it. */
module.exports = `
CREATE TABLE IF NOT EXISTS director_config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS director_projects (
 project_id TEXT PRIMARY KEY, repo_key TEXT NOT NULL, adapter TEXT NOT NULL DEFAULT 'general',
 policy TEXT NOT NULL DEFAULT '{}', session_id TEXT, paused INTEGER NOT NULL DEFAULT 0,
 priority INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', observed_at TEXT
);
CREATE TABLE IF NOT EXISTS director_jobs (
 id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, instruction TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued', task_id TEXT UNIQUE, parent_id TEXT,
 result TEXT, question TEXT, session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_director_jobs_state ON director_jobs(state, created_at);
CREATE TABLE IF NOT EXISTS director_inbox (
 update_id INTEGER PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS director_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT UNIQUE NOT NULL, project_id TEXT,
 job_id TEXT, payload TEXT NOT NULL, message_id INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 next_at INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS director_chat (
 id INTEGER PRIMARY KEY CHECK(id=1), project_id TEXT, offset INTEGER NOT NULL DEFAULT 0,
 paused INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO director_chat(id) VALUES(1);
`;
