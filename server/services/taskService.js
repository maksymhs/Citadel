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
const MAX_RESULT_CHARS = 20000;

// Headless (non-interactive) invocation per builtin agent. Kept here so an
// orchestrator can enqueue {agent, prompt} without knowing each CLI's flags,
// while still being able to send a raw {cmd, args} for anything else.
const AGENT_HEADLESS = {
  opencode: (prompt) => ['run', prompt],
  claude: (prompt) => ['-p', prompt, '--output-format', 'json'],
  codex: (prompt) => ['exec', prompt, '--json'],
};

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
    agent: row.agent || null,
    prompt: row.prompt || null,
    resultRef: row.result_ref,
    result: row.result || null,
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

/**
 * Turn {agent, prompt} into a concrete {cmd, args} using the live agent
 * registry (resolves the installed binary). Lazy-required to avoid loading the
 * terminal stack for plain cmd tasks.
 */
function resolveAgentCommand(agent, prompt) {
  const build = AGENT_HEADLESS[agent];
  if (!build) throw new Error(`Agent "${agent}" has no headless command mapping.`);
  const agentRegistry = require('./agentRegistry');
  const info = agentRegistry.getAgent(agent);
  if (!info) throw new Error(`Agent "${agent}" not found in the registry.`);
  if (!info.installed || !info.path) throw new Error(`Agent "${info.name}" is not installed on this host.`);
  return { cmd: info.path, args: build(String(prompt)) };
}

function enqueue({ cmd, args, projectPath, priority, node, agent, prompt } = {}) {
  let cleanCmd = String(cmd || '').trim();
  let cleanArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  let agentId = null;
  let promptText = null;

  if (agent) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('An agent task requires a "prompt".');
    }
    const resolved = resolveAgentCommand(String(agent), prompt);
    cleanCmd = resolved.cmd;
    cleanArgs = resolved.args;
    agentId = String(agent);
    promptText = String(prompt);
  }

  if (!cleanCmd) throw new Error('A task requires a "cmd" (executable) or an "agent" + "prompt".');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  getDatabase().prepare(`
    INSERT INTO tasks (id, status, node, project_path, cmd, args, priority, agent, prompt, created_at, updated_at)
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    node ? String(node) : null,
    projectPath ? String(projectPath) : null,
    cleanCmd,
    JSON.stringify(cleanArgs),
    Number.isFinite(priority) ? Math.trunc(priority) : 0,
    agentId,
    promptText,
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
function completeTask(id, { status, exitCode, resultRef, error, result } = {}) {
  const finalStatus = status === 'done' ? 'done' : 'failed';
  const now = new Date().toISOString();
  const cleanResult = result === undefined || result === null
    ? null
    : String(result).slice(0, MAX_RESULT_CHARS);
  const res = getDatabase().prepare(`
    UPDATE tasks
    SET status = ?, exit_code = ?, result_ref = ?, error = ?, result = ?,
        lease_until = NULL, finished_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(
    finalStatus,
    Number.isFinite(exitCode) ? Math.trunc(exitCode) : null,
    resultRef ? String(resultRef) : null,
    error ? String(error) : null,
    cleanResult,
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
 * Cancel a queued or running task. A running task keeps its node so the
 * sentinel's next heartbeat reports it in the `cancel` list, prompting it to
 * terminate the child process.
 */
function cancelTask(id) {
  const now = new Date().toISOString();
  const res = getDatabase().prepare(`
    UPDATE tasks SET status = 'cancelled', lease_until = NULL, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(now, id);

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
function heartbeat({ node, url, tags, capacity, active, load, running } = {}) {
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

  // Tell a node which of its running tasks were cancelled since the last beat.
  const cancel = [];
  if (Array.isArray(running) && running.length > 0) {
    const ids = running.map((r) => String(r));
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id FROM tasks WHERE status = 'cancelled' AND node = ? AND id IN (${placeholders})
    `).all(cleanNode, ...ids);
    cancel.push(...rows.map((r) => r.id));
  }

  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(cleanNode);
  return { ...toPublicNode(row), cancel };
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
  cancelTask,
  heartbeat,
  listNodes,
};
