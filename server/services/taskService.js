/**
 * Citadel Task Service — a minimal, pull-based distributed work queue.
 *
 * Design rule: the orchestrator (a smart agent) decides WHAT and HOW MUCH; the
 * nodes are dumb. Each node runs a sentinel that pulls one task at a time when
 * it has a free slot, so load balancing is emergent (a busy node simply stops
 * pulling) and there is no central scheduler.
 *
 * A short lease, renewed implicitly by the node heartbeat, makes crashed
 * workers harmless: their tasks fall back to `queued` (bounded by max_attempts)
 * automatically. Every claim gets a fresh `claim_token`; only the holder of the
 * current token can report a result, so a stale worker from an expired attempt
 * can never overwrite a newer attempt's outcome.
 */
const crypto = require('node:crypto');
const { getDatabase } = require('../database/db');
const logService = require('./logService');

const LEASE_MS = parseInt(process.env.CITADEL_TASK_LEASE_MS, 10) || 90000;
const MAX_RESULT_CHARS = 20000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_MAX_ATTEMPTS = 10;

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

function toPublicTask(row, { includeClaimToken = false } = {}) {
  if (!row) return null;
  const task = {
    id: row.id,
    status: row.status,
    node: row.node,
    projectPath: row.project_path,
    cmd: row.cmd,
    args: parseJson(row.args, []),
    priority: row.priority,
    agent: row.agent || null,
    prompt: row.prompt || null,
    attempt: row.attempt || 0,
    maxAttempts: row.max_attempts || DEFAULT_MAX_ATTEMPTS,
    resultRef: row.result_ref,
    result: row.result || null,
    exitCode: row.exit_code,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
  // The claim token is a per-claim secret: it is only ever returned to the
  // worker that just claimed the task, never in list/get responses.
  if (includeClaimToken) task.claimToken = row.claim_token || null;
  return task;
}

function tokensMatch(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
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

function enqueue({ cmd, args, projectPath, priority, node, agent, prompt, maxAttempts } = {}) {
  let cleanCmd = String(cmd || '').trim();
  let cleanArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  let agentId = null;
  let promptText = null;
  const cleanMaxAttempts = Number.isFinite(maxAttempts)
    ? Math.min(Math.max(Math.trunc(maxAttempts), 1), MAX_MAX_ATTEMPTS)
    : DEFAULT_MAX_ATTEMPTS;

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
    INSERT INTO tasks (id, status, node, project_path, cmd, args, priority, agent, prompt, max_attempts, created_at, updated_at)
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    node ? String(node) : null,
    projectPath ? String(projectPath) : null,
    cleanCmd,
    JSON.stringify(cleanArgs),
    Number.isFinite(priority) ? Math.trunc(priority) : 0,
    agentId,
    promptText,
    cleanMaxAttempts,
    now,
    now
  );

  logService.record({
    category: 'task',
    taskId: id,
    node: node ? String(node) : null,
    action: 'task_enqueued',
    message: agentId ? `Enqueued ${agentId} agent task.` : `Enqueued task: ${cleanCmd}.`,
    details: { cmd: cleanCmd, agent: agentId, projectPath: projectPath ? String(projectPath) : null },
  });

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

/**
 * Apply lease expiry rules:
 *   - `running` past its lease: requeue for another attempt while attempts
 *     remain, otherwise mark failed (explicit, bounded retry semantics).
 *   - `cancelling` past its lease: the worker never confirmed the kill, so the
 *     process is considered dead and the cancellation becomes final.
 * Returns a summary so callers can emit trace events outside the transaction.
 */
function reclaimExpired(db, now) {
  const expired = db.prepare(`
    SELECT id, node, attempt, max_attempts FROM tasks
    WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
  `).all(now);

  const requeued = [];
  const exhausted = [];
  const requeueStmt = db.prepare(`
    UPDATE tasks SET status = 'queued', node = NULL, claim_token = NULL, lease_until = NULL, updated_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const failStmt = db.prepare(`
    UPDATE tasks SET status = 'failed', claim_token = NULL, lease_until = NULL, error = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `);

  for (const row of expired) {
    if ((row.attempt || 0) >= (row.max_attempts || DEFAULT_MAX_ATTEMPTS)) {
      if (failStmt.run(`Lease expired after ${row.attempt} attempt(s); max attempts reached.`, now, now, row.id).changes === 1) {
        exhausted.push({ id: row.id, node: row.node });
      }
    } else if (requeueStmt.run(now, row.id).changes === 1) {
      requeued.push({ id: row.id, node: row.node, attempt: row.attempt });
    }
  }

  const cancelling = db.prepare(`
    SELECT id, node FROM tasks WHERE status = 'cancelling' AND lease_until IS NOT NULL AND lease_until < ?
  `).all(now);
  const finalizeStmt = db.prepare(`
    UPDATE tasks SET status = 'cancelled', claim_token = NULL, lease_until = NULL, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'cancelling'
  `);
  const cancelled = [];
  for (const row of cancelling) {
    if (finalizeStmt.run(now, now, row.id).changes === 1) cancelled.push(row.id);
  }

  return { requeued, exhausted, cancelled };
}

function recordReclaim(summary) {
  for (const item of summary.requeued) {
    logService.record({
      level: 'warn',
      category: 'task',
      taskId: item.id,
      node: item.node,
      action: 'task_lease_expired',
      message: `Lease expired on attempt ${item.attempt}; task requeued.`,
    });
  }
  for (const item of summary.exhausted) {
    logService.record({
      level: 'error',
      category: 'task',
      taskId: item.id,
      node: item.node,
      action: 'task_attempts_exhausted',
      message: 'Lease expired and no attempts remain; task failed.',
    });
  }
  for (const id of summary.cancelled) {
    logService.record({
      level: 'warn',
      category: 'task',
      taskId: id,
      action: 'task_cancel_confirmed',
      message: 'Cancellation confirmed: worker lease expired while cancelling.',
    });
  }
}

/**
 * Atomically claim one queued task for a node. Returns the task (including its
 * per-claim token) or null. Expired leases are reclaimed first, then the oldest
 * highest-priority task is taken with a guarded UPDATE so two nodes can never
 * claim the same one. Each successful claim bumps `attempt` and mints a fresh
 * random `claim_token`.
 */
function claimTask(node) {
  const cleanNode = String(node || '').trim();
  if (!cleanNode) throw new Error('A node id is required to claim a task.');

  const db = getDatabase();
  const claimToken = crypto.randomBytes(24).toString('hex');
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const reclaim = reclaimExpired(db, now);

    const candidate = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'queued' AND (node IS NULL OR node = ?)
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get(cleanNode);
    if (!candidate) return { row: null, reclaim };

    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    const res = db.prepare(`
      UPDATE tasks
      SET status = 'running', node = ?, started_at = COALESCE(started_at, ?),
          lease_until = ?, claim_token = ?, attempt = attempt + 1, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(cleanNode, now, leaseUntil, claimToken, now, candidate.id);

    if (res.changes !== 1) return { row: null, reclaim };
    return { row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(candidate.id), reclaim };
  });

  const { row, reclaim } = tx();
  recordReclaim(reclaim);
  const claimed = toPublicTask(row, { includeClaimToken: true });
  if (!claimed) return null;

  logService.record({
    category: 'task',
    taskId: claimed.id,
    node: claimed.node,
    action: 'task_claimed',
    message: `Task claimed by ${claimed.node} (attempt ${claimed.attempt}/${claimed.maxAttempts}).`,
  });
  return claimed;
}

/**
 * Report the outcome of a claimed task. The caller must present the claim token
 * returned by `claimTask`; a worker whose claim expired (and whose task was
 * retried elsewhere) is rejected instead of overwriting the newer attempt.
 *
 * Statuses: `done`/`failed` finish a running attempt; `cancelled` confirms that
 * a previously requested cancellation actually terminated the process.
 */
function completeTask(id, { status, exitCode, resultRef, error, result, claimToken } = {}) {
  if (typeof claimToken !== 'string' || claimToken === '') {
    throw new Error('A claim token is required to report a result.');
  }

  const db = getDatabase();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row || !tokensMatch(row.claim_token, claimToken)) {
    throw new Error('Task not found, already finished, or claimed by another worker.');
  }

  const isCancelReport = status === 'cancelled';
  if (isCancelReport && row.status !== 'cancelling') {
    throw new Error('Task was not cancelled; refusing a cancellation report.');
  }
  if (!isCancelReport && row.status === 'cancelling') {
    throw new Error('Task cancellation is in progress; only a cancellation report is accepted.');
  }
  if (!isCancelReport && row.status !== 'running') {
    throw new Error('Task not found or already finished.');
  }

  const finalStatus = isCancelReport ? 'cancelled' : (status === 'done' ? 'done' : 'failed');
  const now = new Date().toISOString();
  const cleanResult = result === undefined || result === null
    ? null
    : String(result).slice(0, MAX_RESULT_CHARS);
  const res = db.prepare(`
    UPDATE tasks
    SET status = ?, exit_code = ?, result_ref = ?, error = ?, result = ?,
        lease_until = NULL, claim_token = NULL, finished_at = ?, updated_at = ?
    WHERE id = ? AND claim_token = ? AND status = ?
  `).run(
    finalStatus,
    Number.isFinite(exitCode) ? Math.trunc(exitCode) : null,
    resultRef ? String(resultRef) : null,
    error ? String(error) : null,
    cleanResult,
    now,
    now,
    id,
    claimToken,
    row.status
  );

  if (res.changes !== 1) {
    throw new Error('Task not found, already finished, or claimed by another worker.');
  }

  const task = getTask(id);
  logService.record({
    level: finalStatus === 'failed' ? 'error' : 'info',
    category: 'task',
    taskId: id,
    node: task.node,
    action: finalStatus === 'cancelled'
      ? 'task_cancel_confirmed'
      : (finalStatus === 'failed' ? 'task_failed' : 'task_completed'),
    message: finalStatus === 'cancelled'
      ? 'Worker confirmed termination of the cancelled task.'
      : (finalStatus === 'failed'
        ? `Task failed (exit ${task.exitCode ?? 'n/a'}): ${error || 'unknown error'}`
        : 'Task completed.'),
    details: { exitCode: task.exitCode, resultRef: task.resultRef, attempt: task.attempt },
  });
  return task;
}

/**
 * Request cancellation of a queued or running task.
 *
 * A queued task is finalised immediately. A running task moves to `cancelling`
 * (a *request*, not a confirmed kill): its node keeps the claim and the next
 * heartbeat returns it in the `cancel` list so the sentinel terminates the
 * child and confirms with `completeTask(..., {status:'cancelled', claimToken})`.
 * If the worker never confirms, lease expiry finalises it as `cancelled`.
 */
function cancelTask(id) {
  const now = new Date().toISOString();
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row || !['queued', 'running'].includes(row.status)) {
    throw new Error('Task not found or already finished.');
  }

  if (row.status === 'queued') {
    db.prepare(`
      UPDATE tasks SET status = 'cancelled', finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now, now, id);
  } else {
    db.prepare(`
      UPDATE tasks SET status = 'cancelling', updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, id);
  }

  const task = getTask(id);
  logService.record({
    level: 'warn',
    category: 'task',
    taskId: id,
    node: task.node,
    action: 'task_cancelled',
    message: task.status === 'cancelling'
      ? 'Cancellation requested; waiting for the worker to confirm termination.'
      : 'Task cancelled.',
  });
  return task;
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

    const reclaim = reclaimExpired(db, now);
    // Only running attempts are renewed: a `cancelling` task deliberately stops
    // being renewed so an unconfirmed kill finalises via lease expiry.
    db.prepare(`
      UPDATE tasks SET lease_until = ?, updated_at = ?
      WHERE status = 'running' AND node = ?
    `).run(leaseUntil, now, cleanNode);
    return reclaim;
  });
  const reclaim = tx();
  recordReclaim(reclaim);

  // Tell a node which of its tasks were cancelled since the last beat. Both
  // `cancelling` (kill in flight) and `cancelled` are returned so the sentinel
  // retries until the process is gone and it can confirm termination.
  const cancel = [];
  if (Array.isArray(running) && running.length > 0) {
    const ids = running.map((r) => String(r));
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id FROM tasks WHERE status IN ('cancelling', 'cancelled') AND node = ? AND id IN (${placeholders})
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
