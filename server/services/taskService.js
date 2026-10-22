/**
 * Citadel Task Service — a minimal, pull-based distributed work queue.
 *
 * Design rule: the orchestrator (a smart agent) decides WHAT and HOW MUCH; the
 * nodes are dumb. Each node runs a sentinel that pulls one task at a time when
 * it has a free slot, so load balancing is emergent (a busy node simply stops
 * pulling) and there is no central scheduler.
 *
 * A short lease, renewed by the node heartbeat for the attempts the node
 * reports as actually running, makes crashed workers harmless: a task whose
 * process is gone stops being renewed and falls back to `queued` at expiry
 * (bounded by max_attempts). Every claim gets a fresh `claim_token`; only the
 * holder of the current token — and only while its lease is valid — can report
 * a result, so a stale worker from an expired attempt can never overwrite a
 * newer attempt's outcome or finish after expiry.
 */
const crypto = require('node:crypto');
const { getDatabase } = require('../database/db');
const logService = require('./logService');

const LEASE_MS = parseInt(process.env.CITADEL_TASK_LEASE_MS, 10) || 90000;
const MAX_RESULT_CHARS = 20000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_MAX_ATTEMPTS = 10;
// Worker protocol 2 promises: a durable local execution journal, exec identity
// in the heartbeat and startup reconciliation. Such an attempt is never
// auto-requeued on lease expiry without a confirmed process outcome, because
// the process may still be running on a node that lost contact.
const WORKER_PROTOCOL_JOURNAL = 2;

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
    title: row.title || null,
    agent: row.agent || null,
    prompt: row.prompt || null,
    missionId: row.mission_id || null,
    role: row.role || null,
    deps: parseJson(row.deps, []),
    stage: row.stage || 0,
    handoffRef: row.handoff_ref || null,
    exclusive: Boolean(row.exclusive),
    acceptance: parseJson(row.acceptance, []),
    refs: parseJson(row.refs, []),
    autonomous: Boolean(row.autonomous),
    blockedReason: row.blocked_reason || null,
    retryAt: row.retry_at || null,
    reviewNote: row.review_note || null,
    quotaCount: row.quota_count || 0,
    attempt: row.attempt || 0,
    maxAttempts: row.max_attempts || DEFAULT_MAX_ATTEMPTS,
    workerProtocol: row.worker_protocol || 1,
    execPid: row.exec_pid || null,
    execStartedAt: row.exec_started_at || null,
    reconcileState: row.reconcile_state || null,
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

/**
 * A lease is the only execution authority a running attempt has. Missing
 * (NULL/empty) and past leases are both invalid: a result is accepted only
 * while the current attempt holds a lease that is still in the future. A
 * missing lease is never treated as an indefinite one.
 */
function hasValidLease(leaseUntil, now) {
  return typeof leaseUntil === 'string' && leaseUntil !== '' && leaseUntil >= now;
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
  // Version probing is expensive and irrelevant to execution: only the binary
  // path and installed flag are used here.
  const info = agentRegistry.getAgent(agent, { versions: false });
  if (!info) throw new Error(`Agent "${agent}" not found in the registry.`);
  if (!info.installed || !info.path) throw new Error(`Agent "${info.name}" is not installed on this host.`);
  return { cmd: info.path, args: build(String(prompt)) };
}

function enqueue({
  cmd,
  args,
  projectPath,
  priority,
  node,
  agent,
  prompt,
  maxAttempts,
  title,
  missionId,
  role,
  deps,
  stage,
  handoffRef,
  exclusive,
  status,
  acceptance,
  refs,
  autonomous,
  blockedReason,
  retryAt,
} = {}) {
  let cleanCmd = String(cmd || '').trim();
  let cleanArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  let agentId = null;
  let promptText = null;
  const cleanMaxAttempts = Number.isFinite(maxAttempts)
    ? Math.min(Math.max(Math.trunc(maxAttempts), 1), MAX_MAX_ATTEMPTS)
    : DEFAULT_MAX_ATTEMPTS;
  // Mission subtasks may start blocked until their dependencies are done.
  const initialStatus = ['blocked', 'quota'].includes(status) ? status : 'queued';
  const cleanDeps = Array.isArray(deps)
    ? deps.map((d) => String(d)).filter(Boolean)
    : [];
  const cleanTitle = title ? String(title).trim().slice(0, 200) : null;
  const cleanAcceptance = Array.isArray(acceptance)
    ? acceptance.map((a) => String(a).trim()).filter(Boolean).slice(0, 20)
    : [];
  const cleanRefs = Array.isArray(refs)
    ? refs.map((r) => String(r).trim()).filter(Boolean).slice(0, 50)
    : [];

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
    INSERT INTO tasks (
      id, status, node, project_path, cmd, args, priority, agent, prompt,
      max_attempts, title, mission_id, role, deps, stage, handoff_ref, exclusive,
      acceptance, refs, autonomous, blocked_reason, retry_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    initialStatus,
    node ? String(node) : null,
    projectPath ? String(projectPath) : null,
    cleanCmd,
    JSON.stringify(cleanArgs),
    Number.isFinite(priority) ? Math.trunc(priority) : 0,
    agentId,
    promptText,
    cleanMaxAttempts,
    cleanTitle,
    missionId ? String(missionId) : null,
    role ? String(role) : null,
    JSON.stringify(cleanDeps),
    Number.isFinite(stage) ? Math.trunc(stage) : 0,
    handoffRef ? String(handoffRef) : null,
    exclusive ? 1 : 0,
    JSON.stringify(cleanAcceptance),
    JSON.stringify(cleanRefs),
    autonomous ? 1 : 0,
    blockedReason ? String(blockedReason) : null,
    retryAt ? String(retryAt) : null,
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

/**
 * Let the mission layer react to a terminal task (release dependants, ingest a
 * planner plan, refresh mission status). Kept outside the task transaction on
 * purpose: plan ingestion can enqueue more work and probe agent binaries, which
 * must never hold the task write lock. A missed notification is recovered when
 * the mission is read, because refreshMission() is idempotent.
 */
function notifyMission(task) {
  if (!task || !task.missionId) return;
  try {
    require('./missionService').onTaskChanged(task.missionId);
  } catch (err) {
    logService.record({
      level: 'warn',
      category: 'task',
      taskId: task.id,
      action: 'mission_notify_failed',
      message: `Mission refresh after task change failed: ${err.message}`,
    });
  }
}

function listTasks({ status, node, missionId, autonomous, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (missionId) { where.push('mission_id = ?'); params.push(missionId); }
  if (autonomous !== undefined) { where.push('autonomous = ?'); params.push(autonomous ? 1 : 0); }
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
 * Apply lease expiry rules.
 *
 *   - `running` past its lease, WITHOUT execution evidence: requeue for another
 *     attempt while attempts remain, otherwise mark failed (legacy behaviour).
 *   - `running` past its lease WITH execution evidence: the attempt loses all
 *     authority (results are rejected) but the task is NOT requeued. The local
 *     process may still be alive (sentinel crash/restart, network partition).
 *     It moves to `reconcile_state = 'uncertain'` and waits for the owning node
 *     to prove the process terminated (`reconcileTask`) or to re-adopt it.
 *     Protocol-2 workers are treated the same even before they report a pid:
 *     they journal the execution before spawning, so "no pid yet" is not proof
 *     that nothing was spawned.
 *   - `cancelling` past its lease: same rule. A tracked/unreported execution is
 *     never marked `cancelled` from expiry alone; it becomes uncertain. Only a
 *     legacy attempt with no execution evidence is finalised as cancelled.
 *
 * A `running`/`cancelling` row with NO lease (NULL or empty) from a legacy
 * worker is treated exactly like an expired one (legacy rows never store that
 * state). Missing execution evidence + no lease keeps the historical recovery.
 *
 * Returns a summary so callers can emit trace events outside the transaction.
 */
function reclaimExpired(db, now) {
  const expired = db.prepare(`
    SELECT id, node, attempt, max_attempts, exec_pid, worker_protocol FROM tasks
    WHERE status = 'running'
      AND (lease_until IS NULL OR lease_until = '' OR lease_until < ?)
  `).all(now);

  const requeued = [];
  const exhausted = [];
  const uncertain = [];
  const requeueStmt = db.prepare(`
    UPDATE tasks SET status = 'queued', node = NULL, claim_token = NULL, lease_until = NULL,
                     exec_id = NULL, exec_pid = NULL, exec_pgid = NULL,
                     exec_started_at = NULL, exec_reported_at = NULL, reconcile_state = NULL,
                     updated_at = ?
    WHERE id = ? AND status = 'running'
  `);
  const failStmt = db.prepare(`
    UPDATE tasks SET status = 'failed', claim_token = NULL, lease_until = NULL,
                     reconcile_state = NULL, error = ?, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `);
  // Only flip to uncertain once, so repeated reclaims stay idempotent and do
  // not spam the event log.
  const uncertainStmt = db.prepare(`
    UPDATE tasks SET reconcile_state = 'uncertain', updated_at = ?
    WHERE id = ? AND status IN ('running', 'cancelling')
      AND (reconcile_state IS NULL OR reconcile_state <> 'uncertain')
  `);

  for (const row of expired) {
    const hasExecutionEvidence = Number.isInteger(row.exec_pid)
      || (row.worker_protocol || 1) >= WORKER_PROTOCOL_JOURNAL;
    if (hasExecutionEvidence) {
      if (uncertainStmt.run(now, row.id).changes === 1) {
        uncertain.push({ id: row.id, node: row.node, status: 'running' });
      }
    } else if ((row.attempt || 0) >= (row.max_attempts || DEFAULT_MAX_ATTEMPTS)) {
      if (failStmt.run(`Lease expired after ${row.attempt} attempt(s); max attempts reached.`, now, now, row.id).changes === 1) {
        exhausted.push({ id: row.id, node: row.node });
      }
    } else if (requeueStmt.run(now, row.id).changes === 1) {
      requeued.push({ id: row.id, node: row.node, attempt: row.attempt });
    }
  }

  const cancelling = db.prepare(`
    SELECT id, node, exec_pid, worker_protocol FROM tasks
    WHERE status = 'cancelling'
      AND (lease_until IS NULL OR lease_until = '' OR lease_until < ?)
  `).all(now);
  const finalizeStmt = db.prepare(`
    UPDATE tasks SET status = 'cancelled', claim_token = NULL, lease_until = NULL,
                     reconcile_state = NULL, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'cancelling'
  `);
  const cancelled = [];
  for (const row of cancelling) {
    const hasExecutionEvidence = Number.isInteger(row.exec_pid)
      || (row.worker_protocol || 1) >= WORKER_PROTOCOL_JOURNAL;
    if (hasExecutionEvidence) {
      if (uncertainStmt.run(now, row.id).changes === 1) {
        uncertain.push({ id: row.id, node: row.node, status: 'cancelling' });
      }
    } else if (finalizeStmt.run(now, now, row.id).changes === 1) {
      cancelled.push(row.id);
    }
  }

  return { requeued, exhausted, cancelled, uncertain };
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
  for (const item of summary.uncertain || []) {
    logService.record({
      level: 'warn',
      category: 'task',
      taskId: item.id,
      node: item.node,
      action: 'task_reconcile_required',
      message: item.status === 'cancelling'
        ? 'Cancellation lease expired with a tracked execution; waiting for the owning node to confirm termination.'
        : 'Lease expired with a tracked execution; the task is not requeued until the owning node confirms the process outcome.',
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
function claimTask(node, { protocol } = {}) {
  const cleanNode = String(node || '').trim();
  if (!cleanNode) throw new Error('A node id is required to claim a task.');

  // A worker that declares protocol >= 2 promises a durable execution journal
  // and reconciliation. Store it so lease expiry can distinguish "crashed and
  // definitely nothing is running" from "contact lost, process may be alive".
  const workerProtocol = Number.isFinite(protocol)
    ? Math.max(1, Math.min(Math.trunc(protocol), 99))
    : 1;

  const db = getDatabase();
  const claimToken = crypto.randomBytes(24).toString('hex');
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const reclaim = reclaimExpired(db, now);

    // An exclusive mission task is only claimable when no other exclusive task
    // is running in the same project. This keeps front/back agents from writing
    // the same checkout at once without adding a second scheduler. Tasks with
    // no project (plain queue work) are not serialised.
    const candidate = db.prepare(`
      SELECT * FROM tasks AS t
      WHERE t.status = 'queued' AND (t.node IS NULL OR t.node = ?)
        AND (
          t.exclusive = 0 OR t.project_path IS NULL OR NOT EXISTS (
            SELECT 1 FROM tasks AS running
            WHERE running.exclusive = 1
              AND running.project_path IS t.project_path
              AND running.status IN ('running', 'cancelling')
          )
        )
        -- Autonomous work is strictly one attempt at a time across the whole
        -- instance. Manual queue work is untouched: the guard only looks at
        -- rows explicitly created by the mission loop.
        AND (
          t.autonomous = 0 OR NOT EXISTS (
            SELECT 1 FROM tasks AS auto
            WHERE auto.autonomous = 1
              AND auto.status IN ('running', 'cancelling')
          )
        )
      ORDER BY t.priority DESC, t.created_at ASC
      LIMIT 1
    `).get(cleanNode);
    if (!candidate) return { row: null, reclaim };

    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    const res = db.prepare(`
      UPDATE tasks
      SET status = 'running', node = ?, started_at = COALESCE(started_at, ?),
          lease_until = ?, claim_token = ?, attempt = attempt + 1,
          worker_protocol = ?, exec_id = NULL, exec_pid = NULL, exec_pgid = NULL,
          exec_started_at = NULL, exec_reported_at = NULL, reconcile_state = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(cleanNode, now, leaseUntil, claimToken, workerProtocol, now, candidate.id);

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
 * returned by `claimTask`, and the attempt must still hold a valid lease: once
 * `lease_until` has passed the attempt has no authority, even if no other
 * worker has reclaimed the task yet, and a running row whose lease is missing
 * (NULL/empty) has no authority either — a null lease is never read as an
 * indefinite one.
 *
 * All ownership checks (claim token, node identity, status, lease) and the
 * write run in one transaction with a guarded UPDATE, so a cancellation, a
 * reclaim or a concurrent duplicate report can never interleave with it. An
 * expired or missing lease is reclaimed in the same transaction (requeue while
 * attempts remain, otherwise failed) and the caller gets an explicit rejection.
 *
 * Statuses: `done`/`failed` finish a running attempt; `cancelled` confirms that
 * a previously requested cancellation actually terminated the process.
 *
 * Errors carry `statusCode` 403 when the credential is valid but bound to a
 * different node; every other rejection keeps the 400 convention of the API.
 */
function completeTask(id, { status, exitCode, resultRef, error, result, claimToken, expectedNode, execId } = {}) {
  if (typeof claimToken !== 'string' || claimToken === '') {
    throw new Error('A claim token is required to report a result.');
  }

  const db = getDatabase();
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row || !tokensMatch(row.claim_token, claimToken)) {
      throw new Error('Task not found, already finished, or claimed by another worker.');
    }

    // Per-node credentials may only report for tasks assigned to that node. The
    // claim token is the primary guard; this is defence in depth for a leaked
    // token and for credential/identity binding.
    if (expectedNode && row.node !== expectedNode) {
      const err = new Error('Node credential is not authorized for this task.');
      err.statusCode = 403;
      throw err;
    }

    // Executions tracked by a protocol-2 sentinel must present the execution
    // id recorded with the claim, so a stale worker (or a different process
    // that somehow learned the token) cannot report for another execution.
    if (row.exec_id) {
      if (typeof execId !== 'string' || execId === '') {
        throw new Error('This attempt has a tracked execution; the result must include its execId.');
      }
      if (execId !== row.exec_id) {
        throw new Error('Execution identity mismatch; refusing a result from another execution.');
      }
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

    const leaseMissing = row.lease_until === null || row.lease_until === undefined || row.lease_until === '';
    if (leaseMissing || !hasValidLease(row.lease_until, now)) {
      return {
        leaseInvalid: leaseMissing ? 'missing' : 'expired',
        node: row.node,
        reclaim: reclaimExpired(db, now),
      };
    }

    const finalStatus = isCancelReport ? 'cancelled' : (status === 'done' ? 'done' : 'failed');
    const cleanResult = result === undefined || result === null
      ? null
      : String(result).slice(0, MAX_RESULT_CHARS);
    const res = db.prepare(`
      UPDATE tasks
      SET status = ?, exit_code = ?, result_ref = ?, error = ?, result = ?,
          lease_until = NULL, claim_token = NULL, reconcile_state = 'terminated',
          finished_at = ?, updated_at = ?
      WHERE id = ? AND claim_token = ? AND status = ?
        AND lease_until >= ?
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
      row.status,
      now
    );

    if (res.changes !== 1) {
      throw new Error('Task not found, already finished, or claimed by another worker.');
    }

    return {
      task: toPublicTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)),
      finalStatus,
    };
  });

  const outcome = tx();
  if (outcome.reclaim) recordReclaim(outcome.reclaim);
  if (outcome.leaseInvalid) {
    const missing = outcome.leaseInvalid === 'missing';
    // A tracked execution that lost its lease is not requeued: its process may
    // still be alive. Tell the caller that reconciliation (not a blind retry)
    // is required; the owning sentinel must prove the process outcome.
    const after = getDatabase().prepare('SELECT status, reconcile_state FROM tasks WHERE id = ?').get(id);
    const needsReconcile = !!after && after.status === 'running' && after.reconcile_state === 'uncertain';
    logService.record({
      level: 'warn',
      category: 'task',
      taskId: id,
      node: outcome.node,
      action: needsReconcile
        ? 'task_result_rejected_reconcile'
        : (missing ? 'task_result_rejected_no_lease' : 'task_result_rejected_expired'),
      message: needsReconcile
        ? 'Result rejected: the attempt lease was invalid and its execution state is uncertain; it was not requeued automatically.'
        : (missing
          ? 'Result rejected: the running attempt had no lease; the task was reclaimed.'
          : 'Result rejected: the attempt lease had already expired; the task was reclaimed.'),
    });
    if (needsReconcile) {
      const err = new Error('Task attempt lease is invalid and its execution state is uncertain; reconciliation is required.');
      err.statusCode = 409;
      err.reconcile = true;
      throw err;
    }
    throw new Error(missing
      ? 'Task attempt has no lease; the result was rejected and the task reclaimed.'
      : 'Task lease expired; the result was rejected and the task reclaimed.');
  }

  const task = outcome.task;
  const finalStatus = outcome.finalStatus;
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
  notifyMission(task);
  return task;
}

/**
 * Request cancellation of a queued, blocked or running task.
 *
 * Idempotent: cancelling an already `cancelling`/`cancelled` task returns its
 * current state instead of failing, so retries and concurrent HTTP requests are
 * harmless.
 *
 * A queued task is finalised immediately. For a running task the server only
 * *requests* termination: the owning node must kill the execution and confirm
 * it. A protocol-1 attempt with no execution evidence and an invalid lease keeps
 * the historical immediate finalisation. A tracked execution (or any
 * protocol-2 worker, which may have spawned before its first heartbeat) is
 * never marked `cancelled` from the server side, even if its lease expired:
 * there may still be a live process. It moves to `cancelling`; expiry turns it
 * into `reconcile_state='uncertain'`, and only a confirmed termination
 * (`reconcileTask`) or a legacy no-execution expiry finalises it.
 */
function cancelTask(id) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Error('Task not found or already finished.');

    // Idempotent cancellation: a repeated request observes the same state.
    if (row.status === 'cancelling' || row.status === 'cancelled') {
      return { row, idempotent: true };
    }
    if (!['queued', 'blocked', 'quota', 'running'].includes(row.status)) {
      throw new Error('Task not found or already finished.');
    }

    if (['queued', 'blocked', 'quota'].includes(row.status)) {
      db.prepare(`
        UPDATE tasks SET status = 'cancelled', finished_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(now, now, id, row.status);
    } else {
      const hasExecutionEvidence = Number.isInteger(row.exec_pid)
        || (row.worker_protocol || 1) >= WORKER_PROTOCOL_JOURNAL;
      if (hasExecutionEvidence || hasValidLease(row.lease_until, now)) {
        // Request in flight; the node confirms the actual termination.
        db.prepare(`
          UPDATE tasks SET status = 'cancelling', updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(now, id);
      } else {
        // Legacy attempt, no tracked process, no authority left: safe to finalise.
        db.prepare(`
          UPDATE tasks SET status = 'cancelled', claim_token = NULL, lease_until = NULL,
                           reconcile_state = NULL, finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(now, now, id);
      }
    }

    return { row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), idempotent: false };
  });
  const { row, idempotent } = tx();
  const task = toPublicTask(row);
  logService.record({
    level: 'warn',
    category: 'task',
    taskId: id,
    node: task.node,
    action: idempotent ? 'task_cancel_idempotent' : 'task_cancelled',
    message: idempotent
      ? `Cancellation already ${task.status}; no further action.`
      : (task.status === 'cancelling'
        ? 'Cancellation requested; waiting for the worker to confirm termination.'
        : 'Task cancelled.'),
  });
  notifyMission(task);
  return task;
}

/**
 * Normalise the heartbeat `running` field into `{ present, entries }`, where an
 * entry is `{ id, claimToken }`.
 *
 * `running` is a *witness list*: the attempts this node says it is executing
 * right now. A sentinel sends object entries with the claim token it holds, so
 * the server can renew exactly those attempts and an outdated beat (old attempt,
 * wrong token) can never extend a newer attempt's lease.
 *
 * Plain id strings (and objects without claimToken) are still accepted for
 * compatibility with older clients, but their guarantee is explicitly weaker:
 * renewal is bound only to id + node + running status, so a delayed beat from
 * an earlier attempt of the same node can extend a newer attempt's lease. Two
 * bounds remain even for them: `reclaimExpired` runs before renewal in the same
 * transaction, so an already-expired attempt is requeued/failed and cannot be
 * resurrected; and a task re-claimed by a different node is protected by the
 * node guard. The heartbeat logs a one-time warning when it sees unbound
 * entries so operators know to upgrade the client.
 *
 * A missing/!array value means a legacy client that only reports liveness: the
 * caller falls back to node-wide renewal so live tasks are not requeued under a
 * running process, and logs a one-time warning.
 */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

/**
 * Reconcile the stored attempt with the local execution that the owning node
 * actually observed. This is the only path that can resolve an attempt whose
 * lease expired while its process state was unknown; it never creates a new
 * attempt and never resurrects a terminal task.
 *
 * Evidence required: the current claim token AND the execution id recorded for
 * this attempt (or, if none was recorded yet, the id the worker presents, which
 * is persisted as part of the decision). Both are per-attempt, so an execution
 * from an older attempt can never resolve a newer one.
 *
 * States:
 *   - `alive`      : the exact execution is still running. The attempt keeps
 *                    its authority and receives a fresh lease (no requeue).
 *   - `terminated` : the process is gone. The task is finalised (exit code
 *                    known) or requeued while attempts remain (outcome unknown,
 *                    e.g. after a reboot). A cancellation becomes `cancelled`.
 *   - `unknown`    : the node cannot determine the process state. The task stays
 *                    uncertain and is never auto-requeued; an operator must
 *                    decide. Returns the task for observability.
 */
function reconcileTask(id, { claimToken, execId, state, exitCode, signal, expectedNode, pid, pgid, startedAt } = {}) {
  if (!['alive', 'terminated', 'unknown'].includes(state)) {
    throw new Error('Reconciliation state must be one of alive, terminated, unknown.');
  }
  if (typeof claimToken !== 'string' || claimToken === '') {
    throw new Error('A claim token is required to reconcile a task.');
  }
  if (typeof execId !== 'string' || execId === '') {
    throw new Error('An execution id is required to reconcile a task.');
  }

  const db = getDatabase();
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) {
      const err = new Error('Task not found.');
      err.statusCode = 404;
      throw err;
    }
    if (expectedNode && row.node !== expectedNode) {
      const err = new Error('Node credential is not authorized for this task.');
      err.statusCode = 403;
      throw err;
    }

    if (!tokensMatch(row.claim_token, claimToken)) {
      // A terminal or requeued task no longer holds any claim token: an old
      // execution reporting after the fact is a safe, observable no-op.
      if (TERMINAL_STATUSES.has(row.status) || row.status === 'queued') {
        return { row, discarded: true, reason: 'stale-attempt' };
      }
      const err = new Error('Attempt is not authoritative for this task.');
      err.statusCode = 409;
      err.discard = true;
      throw err;
    }

    if (row.exec_id && row.exec_id !== execId) {
      const err = new Error('Execution identity mismatch; refusing reconciliation from another execution.');
      err.statusCode = 409;
      err.discard = true;
      throw err;
    }

    if (TERMINAL_STATUSES.has(row.status)) {
      return { row, discarded: true, reason: 'terminal' };
    }

    if (state === 'alive') {
      const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      db.prepare(`
        UPDATE tasks SET lease_until = ?, reconcile_state = 'alive', exec_id = ?,
                         exec_pid = COALESCE(?, exec_pid), exec_pgid = COALESCE(?, exec_pgid),
                         exec_started_at = COALESCE(exec_started_at, ?), exec_reported_at = ?,
                         updated_at = ?
        WHERE id = ? AND claim_token = ? AND status IN ('running', 'cancelling')
      `).run(
        leaseUntil, execId, pid, pgid, startedAt, now, now,
        id, claimToken
      );
      return { row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), state };
    }

    if (state === 'unknown') {
      db.prepare(`
        UPDATE tasks SET reconcile_state = 'uncertain', exec_id = COALESCE(exec_id, ?),
                         updated_at = ?
        WHERE id = ? AND claim_token = ? AND status IN ('running', 'cancelling')
      `).run(execId, now, id, claimToken);
      return { row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), state };
    }

    // state === 'terminated'
    if (row.status === 'cancelling') {
      db.prepare(`
        UPDATE tasks SET status = 'cancelled', claim_token = NULL, lease_until = NULL,
                         reconcile_state = 'terminated', finished_at = ?, updated_at = ?
        WHERE id = ? AND claim_token = ? AND status = 'cancelling'
      `).run(now, now, id, claimToken);
      return {
        row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
        state,
        finalStatus: 'cancelled',
      };
    }

    if (Number.isFinite(exitCode)) {
      const finalStatus = exitCode === 0 ? 'done' : 'failed';
      const finalError = exitCode === 0 ? null
        : (signal ? `Execution terminated by signal ${signal}.` : `Execution exited with code ${exitCode}.`);
      db.prepare(`
        UPDATE tasks SET status = ?, exit_code = ?, error = ?, claim_token = NULL,
                         lease_until = NULL, reconcile_state = 'terminated',
                         finished_at = ?, updated_at = ?
        WHERE id = ? AND claim_token = ? AND status = 'running'
      `).run(finalStatus, Math.trunc(exitCode), finalError, now, now, id, claimToken);
      return {
        row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
        state,
        finalStatus,
      };
    }

    if ((row.attempt || 0) < (row.max_attempts || DEFAULT_MAX_ATTEMPTS)) {
      // The process is confirmed gone but its outcome was never reported (for
      // example, the whole host rebooted). Retrying is safe now: there is no
      // concurrent execution. It remains bounded by max_attempts.
      db.prepare(`
        UPDATE tasks SET status = 'queued', node = NULL, claim_token = NULL, lease_until = NULL,
                         exec_id = NULL, exec_pid = NULL, exec_pgid = NULL,
                         exec_started_at = NULL, exec_reported_at = NULL, reconcile_state = NULL,
                         error = ?, updated_at = ?
        WHERE id = ? AND claim_token = ? AND status = 'running'
      `).run('Execution ended without a reported result; task requeued.', now, id, claimToken);
      return {
        row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
        state,
        requeued: true,
      };
    }

    db.prepare(`
      UPDATE tasks SET status = 'failed', claim_token = NULL, lease_until = NULL,
                       reconcile_state = 'terminated',
                       error = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND claim_token = ? AND status = 'running'
    `).run('Execution ended without a reported result; max attempts reached.', now, now, id, claimToken);
    return {
      row: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
      state,
      finalStatus: 'failed',
    };
  });

  const outcome = tx();
  const task = toPublicTask(outcome.row);
  if (outcome.discarded) {
    logService.record({
      level: 'warn',
      category: 'task',
      taskId: id,
      node: task ? task.node : null,
      action: 'task_reconcile_discarded',
      message: `Reconciliation ignored: ${outcome.reason}.`,
    });
  } else if (outcome.state === 'alive') {
    logService.record({
      category: 'task',
      taskId: id,
      node: task.node,
      action: 'task_reconciled_alive',
      message: 'Execution confirmed alive by the owning node; attempt re-authorized.',
    });
  } else if (outcome.state === 'unknown') {
    logService.record({
      level: 'warn',
      category: 'task',
      taskId: id,
      node: task.node,
      action: 'task_reconcile_unknown',
      message: 'Node could not determine the execution state; automatic requeue stays blocked.',
    });
  } else {
    logService.record({
      level: outcome.finalStatus === 'failed' ? 'error' : 'info',
      category: 'task',
      taskId: id,
      node: task.node,
      action: 'task_reconciled_terminated',
      message: outcome.requeued
        ? 'Execution confirmed terminated; task requeued for a new attempt.'
        : `Execution confirmed terminated; task ${outcome.finalStatus || 'finalised'}.`,
    });
  }

  return {
    task,
    state: outcome.state || null,
    requeued: !!outcome.requeued,
    discarded: !!outcome.discarded,
    reason: outcome.reason || null,
  };
}


/**
 * Normalise the heartbeat `running` field into `{ present, entries }`, where an
 * entry is `{ id, claimToken, execId, pid, pgid, startedAt }`.
 *
 * `running` is a *witness list*: the attempts this node says it is executing
 * right now. A protocol-2 sentinel sends object entries with the claim token
 * and the execution identity it recorded locally, so the server can renew
 * exactly those attempts, persist the execution correlation, and tell the node
 * to abandon executions that no longer own the current attempt.
 *
 * Plain id strings (and objects without claimToken) are still accepted for
 * compatibility with older clients, but their guarantee is explicitly weaker:
 * renewal is bound only to id + node + running status, so a delayed beat from
 * an earlier attempt of the same node can extend a newer attempt's lease. Two
 * bounds remain even for them: `reclaimExpired` runs before renewal in the same
 * transaction, so an already-expired attempt is requeued/failed and cannot be
 * resurrected; and a task re-claimed by a different node is protected by the
 * node guard. The heartbeat logs a one-time warning when it sees unbound
 * entries so operators know to upgrade the client.
 *
 * A missing/!array value means a legacy client that only reports liveness: the
 * caller falls back to node-wide renewal so live tasks are not requeued under a
 * running process, and logs a one-time warning.
 */
function parseRunningEntries(running) {
  if (!Array.isArray(running)) return { present: false, entries: [] };
  const entries = [];
  for (const item of running) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) entries.push({ id, claimToken: null, execId: null, pid: null, pgid: null, startedAt: null });
    } else if (item && typeof item === 'object' && typeof item.id === 'string') {
      const id = item.id.trim();
      if (!id) continue;
      const claimToken = typeof item.claimToken === 'string' && item.claimToken ? item.claimToken : null;
      const execId = typeof item.execId === 'string' && item.execId ? item.execId : null;
      const pid = Number.isInteger(item.pid) && item.pid > 1 ? item.pid : null;
      const pgid = Number.isInteger(item.pgid) && item.pgid > 1 ? item.pgid : null;
      const startedAt = typeof item.startedAt === 'string' && item.startedAt ? item.startedAt : null;
      entries.push({ id, claimToken, execId, pid, pgid, startedAt });
    }
  }
  return { present: true, entries };
}

const legacyHeartbeatWarned = new Set();

function warnLegacyHeartbeat(node) {
  if (legacyHeartbeatWarned.has(node)) return;
  legacyHeartbeatWarned.add(node);
  logService.record({
    level: 'warn',
    category: 'task',
    node,
    action: 'node_heartbeat_legacy',
    message: 'Heartbeat did not report its running task ids; renewing leases node-wide for compatibility. Upgrade the sentinel for precise lease reconciliation.',
  });
}

const unboundHeartbeatWarned = new Set();

function warnUnboundHeartbeat(node) {
  if (unboundHeartbeatWarned.has(node)) return;
  unboundHeartbeatWarned.add(node);
  logService.record({
    level: 'warn',
    category: 'task',
    node,
    action: 'node_heartbeat_unbound',
    message: 'Heartbeat reported running task ids without a claim token; those leases are renewed by id/node/status only, so a delayed beat from a previous attempt could extend a newer one. Upgrade the client to send {id, claimToken}.',
  });
}

/**
 * Upsert a node's liveness, load and capacity and renew the leases of the
 * attempts that are actually alive on it.
 *
 * Renewal rules (see `parseRunningEntries`):
 *   - witness list present: renew ONLY the listed attempts; anything else on
 *     this node stops being renewed and expires through `reclaimExpired`. A
 *     delayed or duplicated beat therefore cannot resurrect a finished task or
 *     extend an outdated attempt (claim-token guard), and a dead process can
 *     never hold its lease forever. Entries without a claim token renew by
 *     id/node/status only (documented weaker guarantee, warned once).
 *   - witness list absent (legacy client): renew every running attempt on the
 *     node and warn once; refusing to renew would requeue tasks that are still
 *     executing and cause duplicate work.
 *   - `cancelling` attempts are renewed only when the entry carries a claim
 *     token and an execution id (the node proves the same process is alive and
 *     still needs to be stopped). Legacy/unbound cancelling entries are never
 *     renewed, so an unconfirmed kill finalises via expiry. A tracked expiry
 *     becomes `reconcile_state='uncertain'`, never a false `cancelled`.
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
  const runningInfo = parseRunningEntries(running);

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

    if (runningInfo.present) {
      // Guarded per-attempt renewal: id + node + status, plus the claim token
      // and (when present) the execution id. A tracked entry may renew both a
      // `running` attempt and a `cancelling` one: the node is proving that the
      // same execution is still alive and must be able to keep trying to stop
      // it. Anything else (finished, requeued, re-claimed, different execution)
      // is a silent no-op, and the caller is told to abandon it.
      const renewTracked = db.prepare(`
        UPDATE tasks SET lease_until = ?, updated_at = ?, exec_id = ?,
                         exec_pid = COALESCE(?, exec_pid), exec_pgid = COALESCE(?, exec_pgid),
                         exec_started_at = COALESCE(exec_started_at, ?),
                         exec_reported_at = ?, reconcile_state = 'alive'
        WHERE id = ? AND node = ? AND status IN ('running', 'cancelling')
          AND claim_token = ? AND (exec_id IS NULL OR exec_id = ?)
      `);
      const renewBound = db.prepare(`
        UPDATE tasks SET lease_until = ?, updated_at = ?
        WHERE id = ? AND node = ? AND status = 'running' AND claim_token = ?
      `);
      const renewLegacy = db.prepare(`
        UPDATE tasks SET lease_until = ?, updated_at = ?
        WHERE id = ? AND node = ? AND status = 'running'
      `);
      for (const entry of runningInfo.entries) {
        if (entry.claimToken && entry.execId) {
          renewTracked.run(
            leaseUntil, now, entry.execId, entry.pid, entry.pgid, entry.startedAt, now,
            entry.id, cleanNode, entry.claimToken, entry.execId
          );
        } else if (entry.claimToken) {
          renewBound.run(leaseUntil, now, entry.id, cleanNode, entry.claimToken);
        } else {
          renewLegacy.run(leaseUntil, now, entry.id, cleanNode);
        }
      }
    } else {
      db.prepare(`
        UPDATE tasks SET lease_until = ?, updated_at = ?
        WHERE status = 'running' AND node = ?
      `).run(leaseUntil, now, cleanNode);
    }
    return reclaim;
  });
  const reclaim = tx();
  recordReclaim(reclaim);
  if (!runningInfo.present) {
    warnLegacyHeartbeat(cleanNode);
  } else if (runningInfo.entries.some((e) => !e.claimToken)) {
    warnUnboundHeartbeat(cleanNode);
  }

  // Tell a node which of its tasks were cancelled since the last beat. Both
  // `cancelling` (kill in flight) and `cancelled` are returned so the sentinel
  // retries until the process is gone and it can confirm termination.
  const cancel = [];
  const abandon = [];
  if (runningInfo.entries.length > 0) {
    const ids = runningInfo.entries.map((e) => e.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, status, claim_token, exec_id FROM tasks
      WHERE node = ? AND id IN (${placeholders})
    `).all(cleanNode, ...ids);
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const row of rows) {
      if (row.status === 'cancelling' || row.status === 'cancelled') cancel.push(row.id);
    }
    const cancelSet = new Set(cancel);

    // The node still reports an execution that no longer belongs to the
    // current attempt (or whose task is terminal/queued). It must stop the
    // local process; it must not report a result. The execution id lets the
    // sentinel target only the exact process it owns, never a newer attempt.
    for (const entry of runningInfo.entries) {
      if (cancelSet.has(entry.id)) continue;
      const row = byId.get(entry.id);
      if (!row) continue;
      const tokenMismatch = entry.claimToken && !tokensMatch(row.claim_token, entry.claimToken);
      const execMismatch = entry.execId && row.exec_id && entry.execId !== row.exec_id;
      const notCurrent = ['queued', 'done', 'failed', 'cancelled'].includes(row.status);
      if (tokenMismatch || execMismatch || notCurrent) {
        abandon.push({ id: row.id, execId: entry.execId || row.exec_id || null });
      }
    }
  }

  // Attempts whose process state is unknown and which the server deliberately
  // did not requeue. The owning node must prove alive/terminated (see
  // reconcileTask); the claim token is scoped to this node's authenticated
  // worker credential.
  const reconcile = db.prepare(`
    SELECT id, attempt, claim_token, exec_id, status FROM tasks
    WHERE node = ? AND status IN ('running', 'cancelling')
      AND (reconcile_state = 'uncertain' OR lease_until IS NULL OR lease_until = '' OR lease_until < ?)
  `).all(cleanNode, now).map((r) => ({
    id: r.id,
    attempt: r.attempt,
    claimToken: r.claim_token,
    execId: r.exec_id,
    status: r.status,
  }));

  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(cleanNode);
  return { ...toPublicNode(row), cancel, abandon, reconcile };
}

function listNodes() {
  const rows = getDatabase().prepare('SELECT * FROM nodes ORDER BY id').all();
  return rows.map(toPublicNode);
}

module.exports = {
  LEASE_MS,
  AGENT_HEADLESS,
  enqueue,
  listTasks,
  getTask,
  claimTask,
  completeTask,
  cancelTask,
  reconcileTask,
  heartbeat,
  listNodes,
};
