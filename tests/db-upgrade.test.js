const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// Reproduces an older install: `tasks` predates the execution-identity columns
// and a project exists with its legacy 1:1 git metadata. Upgrading must run the
// ALTER TABLE migrations *before* building the indexes that reference the new
// columns, otherwise startup aborts (the historical bug this guards against).
describe('In-place database upgrade (older install → current schema)', () => {
  const testDb = path.resolve(__dirname, '../data/test-upgrade.db');

  before(() => cleanDb(testDb));
  after(() => cleanDb(testDb));

  test('startup migrates a legacy tasks table without crashing', () => {
    // Build a legacy database by hand.
    const legacy = new Database(testDb);
    legacy.exec(`
      CREATE TABLE tasks (
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
        result_ref TEXT,
        result TEXT,
        exit_code INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE projects (
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
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO users VALUES ('u1','legacy','x','y','admin','now','now');
      INSERT INTO projects VALUES ('p1','Legacy App','legacy-app','old project','/srv/legacy-app','https://github.com/x/y.git','main','t0','t0');
    `);
    legacy.close();

    const { initDatabase, closeDatabase } = require('../server/database/db');
    const db = initDatabase(testDb); // must not throw

    const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    for (const col of ['worker_protocol', 'exec_id', 'reconcile_state', 'attempt', 'claim_token', 'result', 'agent', 'prompt']) {
      assert.ok(taskCols.includes(col), `tasks.${col} should exist after migration`);
    }
    for (const col of ['title', 'mission_id', 'role', 'deps', 'stage', 'handoff_ref', 'exclusive']) {
      assert.ok(taskCols.includes(col), `tasks.${col} should exist after migration`);
    }
    for (const col of ['reviewed_at', 'reviewed_by', 'failure_kind', 'docs_linked']) {
      assert.ok(taskCols.includes(col), `tasks.${col} should exist after migration`);
    }
    for (const table of ['document_links', 'document_refs']) {
      const found = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      assert.ok(found, `${table} table should exist after migration`);
    }
    const missionTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'missions'").get();
    assert.ok(missionTable, 'missions table should exist after migration');
    const missionCols = db.prepare('PRAGMA table_info(missions)').all().map((c) => c.name);
    for (const col of ['goal', 'status', 'planner_task_id', 'workspace', 'plan', 'error']) {
      assert.ok(missionCols.includes(col), `missions.${col} should exist after migration`);
    }

    // Indexes that depended on the new columns now exist.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    assert.ok(indexes.includes('idx_tasks_reconcile'));
    assert.ok(indexes.includes('idx_tasks_mission'));
    assert.ok(indexes.includes('idx_missions_status'));

    // The legacy project was backfilled as its primary repository (once).
    const repos = db.prepare('SELECT * FROM project_repos WHERE project_id = ?').all('p1');
    assert.equal(repos.length, 1);
    assert.equal(repos[0].is_primary, 1);
    assert.equal(repos[0].path, '/srv/legacy-app');
    assert.equal(repos[0].git_branch, 'main');

    // Existing install (a user already present) keeps every module enabled.
    const flags = db.prepare("SELECT value FROM app_config WHERE key LIKE 'module.%'").all();
    assert.ok(flags.length > 0);
    assert.ok(flags.every((f) => f.value === '1'));

    closeDatabase();
    // Intentionally keep the migrated file for the next test.
  });

  test('re-running init on an already-migrated database is a safe no-op', () => {
    const { initDatabase, closeDatabase } = require('../server/database/db');
    const db1 = initDatabase(testDb);
    const before = db1.prepare('SELECT COUNT(*) c FROM project_repos').get().c;
    closeDatabase();

    const db2 = initDatabase(testDb); // second boot
    const after = db2.prepare('SELECT COUNT(*) c FROM project_repos').get().c;
    assert.equal(after, before, 'project_repos must not be duplicated on restart');
    closeDatabase();
    cleanDb(testDb);
  });
  test('migration 015 retains legacy refs and seeds usage once', () => {
    const { initDatabase, runMigrations, closeDatabase } = require('../server/database/db');
    const db = initDatabase(testDb);
    db.prepare("INSERT INTO documents (id, project_id, path, task_id, mission_id, created_at, updated_at) VALUES ('doc', 'project', 'old.md', 'task', 'mission', 'now', 'now')").run();
    db.prepare("INSERT INTO tasks (id, cmd, autonomous, attempt, started_at, created_at, updated_at) VALUES ('task', 'true', 1, 2, ?, 'now', 'now')").run(new Date().toISOString());
    db.prepare("DELETE FROM schema_migrations WHERE name = '015_attempt_usage_and_legacy_refs'").run();
    db.prepare('DELETE FROM autonomous_daily_usage').run();
    runMigrations(db);
    assert.equal(db.prepare("SELECT attempts FROM autonomous_daily_usage").get().attempts, 2);
    assert.deepEqual(db.prepare('SELECT kind, ref_id FROM document_refs ORDER BY kind').all(), [
      { kind: 'mission', ref_id: 'mission' }, { kind: 'task', ref_id: 'task' },
    ]);
    runMigrations(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM document_refs').get().n, 2);
    assert.equal(db.prepare('SELECT attempts FROM autonomous_daily_usage').get().attempts, 2);
    closeDatabase();
    cleanDb(testDb);
  });

});
