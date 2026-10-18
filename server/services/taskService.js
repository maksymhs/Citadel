/**
 * Citadel Task Service — a minimal, pull-based distributed work queue.
 *
 * Design rule: the orchestrator (a smart agent) decides WHAT and HOW MUCH; the
 * nodes are dumb. Each node runs a sentinel that pulls one task at a time when
 * it has a free slot, so load balancing is emergent (a busy node simply stops
 * pulling) and there is no central scheduler.
 *
 * A short lease, renewed implicitly by the node heartbeat, makes crashed
 * workers harmless: their tasks fall back to `queued` automatically.
 */
const crypto = require('node:crypto');
const { getDatabase } = require('../database/db');

const LEASE_MS = parseInt(process.env.CITADEL_TASK_LEASE_MS, 10) || 90000;

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toPublicTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    node: row.node,
    projectPath: row.project_path,
    cmd: row.cmd,
    args: parseJson(row.args, []),
    priority: row.priority,
    resultRef: row.result_ref,
    exitCode: row.exit_code,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toPublicNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    tags: parseJson(row.tags, []),
    capacity: row.capacity,
    active: row.active,
    load: row.load,
    lastSeen: row.last_seen,
  };
}

function enqueue({ cmd, args, projectPath, priority, node } = {}) {
  const cleanCmd = String(cmd || '').trim();
  if (!cleanCmd) throw new Error('A task requires a "cmd" (executable to run).');

  const cleanArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  getDatabase().prepare(`
    INSERT INTO tasks (id, status, node, project_path, cmd, args, priority, created_at, updated_at)
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    node ? String(node) : null,
    projectPath ? String(projectPath) : null,
    cleanCmd,
    JSON.stringify(cleanArgs),
    Number.isFinite(priority) ? Math.trunc(priority) : 0,
    now,
    now
  );

  return getTask(id);
}

function listTasks({ status, node, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (node) { where.push('node = ?'); params.push(node); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const capped = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);

  const rows = getDatabase()
    .prepare(`SELECT * FROM tasks ${clause} ORDER BY priority DESC, created_at ASC LIMIT ?`)
    .all(...params, capped);
  return rows.map(toPublicTask);
}

function getTask(id) {
  const row = getDatabase().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return toPublicTask(row);
}

function reclaimExpired(db, now) {
  db.prepare(`
    UPDATE tasks SET status = 'queued', node = NULL, lease_until = NULL, updated_at = ?
    WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
  `).run(now, now);
}

/**
 * Atomically claim one queued task for a node. Returns the task or null.
 * Expired leases are reclaimed first, then the oldest highest-priority task is
 * taken with a guarded UPDATE so two nodes can never claim the same one.
 */
function claimTask(node) {
  const cleanNode = String(node || '').trim();
  if (!cleanNode) throw new Error('A node id is required to claim a task.');

  const db = getDatabase();
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    reclaimExpired(db, now);

    const candidate = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'queued' AND (node IS NULL OR node = ?)
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get(cleanNode);
    if (!candidate) return null;

    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    const res = db.prepare(`
      UPDATE tasks
      SET status = 'running', node = ?, started_at = COALESCE(started_at, ?),
          lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(cleanNode, now, leaseUntil, now, candidate.id);

    if (res.changes !== 1) return null;
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(candidate.id);
  });

  return toPublicTask(tx());
}

/**
 * Mark a task finished. Only `done` or `failed` are accepted.
 */
function completeTask(id, { status, exitCode, resultRef, error } = {}) {
  const finalStatus = status === 'done' ? 'done' : 'failed';
  const now = new Date().toISOString();
  const res = getDatabase().prepare(`
    UPDATE tasks
    SET status = ?, exit_code = ?, result_ref = ?, error = ?,
        lease_until = NULL, finished_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(
    finalStatus,
    Number.isFinite(exitCode) ? Math.trunc(exitCode) : null,
    resultRef ? String(resultRef) : null,
    error ? String(error) : null,
    now,
    now,
    id
  );

  if (res.changes !== 1) {
    throw new Error('Task not found or already finished.');
  }
  return getTask(id);
}

/**
 * Upsert a node's liveness, load and capacity. Also renews the lease of every
 * running task on that node, so a healthy node keeps its work and a dead one
 * releases it automatically.
 */
function heartbeat({ node, url, tags, capacity, active, load } = {}) {
  const cleanNode = String(node || '').trim();
  if (!cleanNode) throw new Error('A node id is required for a heartbeat.');

  const db = getDatabase();
  const now = new Date().toISOString();
  const cleanTags = Array.isArray(tags) ? tags.map((t) => String(t)) : [];
  const cleanCapacity = Number.isFinite(capacity) ? Math.max(1, Math.trunc(capacity)) : 1;
  const cleanActive = Number.isFinite(active) ? Math.max(0, Math.trunc(active)) : 0;
  const cleanLoad = Number.isFinite(load) ? load : null;
  const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO nodes (id, url, tags, capacity, active, load, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        url = excluded.url, tags = excluded.tags, capacity = excluded.capacity,
        active = excluded.active, load = excluded.load, last_seen = excluded.last_seen
    `).run(
      cleanNode,
      url ? String(url) : null,
      JSON.stringify(cleanTags),
      cleanCapacity,
      cleanActive,
      cleanLoad,
      now
    );

    reclaimExpired(db, now);
    db.prepare(`
      UPDATE tasks SET lease_until = ?, updated_at = ?
      WHERE status = 'running' AND node = ?
    `).run(leaseUntil, now, cleanNode);
  });
  tx();

  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(cleanNode);
  return toPublicNode(row);
}

function listNodes() {
  const rows = getDatabase().prepare('SELECT * FROM nodes ORDER BY id').all();
  return rows.map(toPublicNode);
}

module.exports = {
  LEASE_MS,
  enqueue,
  listTasks,
  getTask,
  claimTask,
  completeTask,
  heartbeat,
  listNodes,
};
