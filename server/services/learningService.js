/**
 * Citadel Learning Service — a small, recoverable memory of failures,
 * resolutions and explicit user corrections.
 *
 * This is not a log and not vector memory. It stores compact, structured rows
 * that can be retrieved deterministically by project, status, tags and keywords
 * before a mission is planned. Two scopes are kept strictly apart:
 *
 *   - project: the default. It never leaks into another project.
 *   - global: only after an explicit promotion by the operator. No failure ever
 *     becomes general policy on its own.
 *
 * A repeated observation updates `occurrences` on the same dedupe key instead of
 * creating near-duplicate lessons, and an agent hypothesis is always stored as
 * unconfirmed. Safety policies are never written here, so learning can never
 * govern the system that governs it.
 */
const crypto = require('node:crypto');
const { getDatabase } = require('../database/db');
const { scrub } = require('../security/redact');
const logService = require('./logService');

const MAX_RULE = 1000;
const SCOPES = new Set(['project', 'global']);
const STATUSES = new Set(['pending', 'confirmed', 'discarded', 'superseded']);
const SOURCES = new Set(['failure', 'user_correction', 'success', 'manual']);
const QUOTA_PATTERN = /(usage limit|quota|rate.?limit|too many requests|insufficient_quota|credit balance|\b429\b)/i;
const RESET_PATTERN = /(reset|retry|try again)[^.\n]{0,40}?(\d{1,2}:\d{2}|in \d+ ?(?:s|m|h|min|hour))/i;
const AUTH_PATTERN = /(unauthori[sz]ed|authentication|invalid api key|forbidden|expired token|not logged in|\b401\b|\b403\b)/i;
const NETWORK_PATTERN = /(econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|connection (reset|refused)|network (error|unreachable)|temporary failure|bad gateway|\b502\b|\b503\b|\b504\b)/i;
const TESTS_PATTERN = /(test(s)? failed|failing test|assertionerror|assertion failed|npm test.*(fail|error)|\bFAIL\b)/i;
const INTERRUPTED_PATTERN = /(terminated by signal|sigterm|sigint|sigkill|process (was )?killed|interrupted)/i;

function nowIso() {
  return new Date().toISOString();
}

function normaliseForKey(value) {
  return scrub(value, 400).toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 :._/-]/g, '').trim();
}

function dedupeKey({ scope, projectId, source, title, problem }) {
  const seed = [scope, projectId || '-', source, normaliseForKey(problem || title)].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    projectId: row.project_id || null,
    taskId: row.task_id || null,
    missionId: row.mission_id || null,
    title: row.title,
    problem: row.problem || '',
    context: row.context || '',
    rootCause: row.root_cause || '',
    rootCauseConfirmed: Boolean(row.root_cause_confirmed),
    solution: row.solution || '',
    rule: row.rule || '',
    components: parseJson(row.components, []),
    evidence: parseJson(row.evidence, []),
    tags: parseJson(row.tags, []),
    source: row.source || null,
    occurrences: row.occurrences || 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    supersededBy: row.superseded_by || null,
  };
}

function listLessons({ projectId, scope, status, q, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (scope) {
    if (!SCOPES.has(String(scope))) throw new Error('Unknown lesson scope.');
    where.push('scope = ?');
    params.push(String(scope));
  }
  if (projectId) {
    // A project view includes its own lessons plus explicitly promoted global
    // knowledge. It never includes another project's rows.
    where.push('(scope = \'global\' OR (scope = \'project\' AND project_id = ?))');
    params.push(String(projectId));
  }
  if (status) {
    if (!STATUSES.has(String(status))) throw new Error('Unknown lesson status.');
    where.push('status = ?');
    params.push(String(status));
  }
  if (q && String(q).trim()) {
    const term = `%${String(q).trim().slice(0, 120)}%`;
    where.push('(title LIKE ? OR problem LIKE ? OR rule LIKE ? OR tags LIKE ? OR components LIKE ?)');
    params.push(term, term, term, term, term);
  }
  const capped = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDatabase().prepare(`
    SELECT * FROM lessons ${clause}
    ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
             updated_at DESC
    LIMIT ?
  `).all(...params, capped);
  return rows.map(toPublic);
}

function getLesson(id) {
  return toPublic(getDatabase().prepare('SELECT * FROM lessons WHERE id = ?').get(String(id)));
}

/**
 * Insert a lesson, or enrich the existing row with the same dedupe key. This is
 * the only write path, so a repeated error can never produce a second copy.
 */
function recordLesson(input = {}) {
  // Global knowledge requires an explicit promotion elsewhere; callers can not
  // create it implicitly through a failure, a manual row or a model hypothesis.
  const scope = 'project';
  const projectId = input.projectId ? String(input.projectId) : null;
  const title = scrub(input.title || input.problem || 'Untitled lesson', 200);
  if (!title) throw new Error('A lesson needs a title.');
  const problem = scrub(input.problem || title);
  const rule = scrub(input.rule, MAX_RULE);
  const source = SOURCES.has(input.source) ? input.source : 'manual';
  const status = STATUSES.has(input.status) ? input.status : 'pending';
  const key = dedupeKey({ scope, projectId, source, title, problem });
  const db = getDatabase();
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM lessons WHERE dedupe_key = ?').get(key);

  if (existing) {
    const evidence = parseJson(existing.evidence, []);
    if (input.evidence) {
      for (const item of [].concat(input.evidence).map((e) => scrub(e, 500))) {
        if (item && !evidence.includes(item)) evidence.push(item);
      }
    }
    const components = new Set(parseJson(existing.components, []));
    for (const c of [].concat(input.components || [])) {
      const clean = scrub(c, 120);
      if (clean) components.add(clean);
    }
    const tags = new Set(parseJson(existing.tags, []));
    for (const t of [].concat(input.tags || [])) {
      const clean = scrub(t, 60);
      if (clean) tags.add(clean);
    }
    // A human correction outranks an agent hypothesis, but a later observation
    // must not silently downgrade a confirmed lesson.
    const nextStatus = status === 'confirmed' ? 'confirmed' : existing.status;
    db.prepare(`
      UPDATE lessons
      SET occurrences = occurrences + 1, status = ?, updated_at = ?,
          solution = COALESCE(NULLIF(?, ''), solution),
          rule = COALESCE(NULLIF(?, ''), rule),
          root_cause = COALESCE(NULLIF(?, ''), root_cause),
          evidence = ?, components = ?, tags = ?,
          confirmed_at = CASE WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN ? ELSE confirmed_at END
      WHERE id = ?
    `).run(
      nextStatus,
      now,
      scrub(input.solution),
      rule,
      scrub(input.rootCause),
      JSON.stringify(evidence.slice(-20)),
      JSON.stringify([...components].slice(0, 20)),
      JSON.stringify([...tags].slice(0, 20)),
      nextStatus,
      now,
      existing.id,
    );
    logService.record({
      category: 'learning', action: 'lesson_repeated',
      message: `Lesson repeated (${title}); occurrence counter updated.`,
      details: { lessonId: existing.id, scope },
    });
    return getLesson(existing.id);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO lessons (
      id, scope, status, project_id, task_id, mission_id, title, problem, context,
      root_cause, root_cause_confirmed, solution, rule, components, evidence, tags,
      source, occurrences, dedupe_key, created_by, created_at, updated_at, confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(
    id,
    scope,
    status,
    projectId,
    input.taskId ? String(input.taskId) : null,
    input.missionId ? String(input.missionId) : null,
    title,
    problem,
    scrub(input.context),
    scrub(input.rootCause),
    input.rootCauseConfirmed ? 1 : 0,
    scrub(input.solution),
    rule,
    JSON.stringify([].concat(input.components || []).map((c) => scrub(c, 120)).filter(Boolean).slice(0, 20)),
    JSON.stringify([].concat(input.evidence || []).map((e) => scrub(e, 500)).filter(Boolean).slice(0, 20)),
    JSON.stringify([].concat(input.tags || []).map((t) => scrub(t, 60)).filter(Boolean).slice(0, 20)),
    source,
    key,
    input.createdBy ? String(input.createdBy) : null,
    now,
    now,
    status === 'confirmed' ? now : null,
  );
  logService.record({
    category: 'learning', action: 'lesson_recorded',
    message: `Lesson recorded (${title}).`,
    details: { lessonId: id, scope, source },
  });
  return getLesson(id);
}

function evidenceFor(task) {
  const refs = [];
  if (task.error) refs.push(`error: ${task.error}`);
  if (task.result && !task.error) refs.push(`result: ${task.result.slice(0, 500)}`);
  if (task.resultRef) refs.push(`result_ref: ${task.resultRef}`);
  if (task.handoffRef) refs.push(`handoff: ${task.handoffRef}`);
  return refs;
}

function isQuotaError(text) {
  return QUOTA_PATTERN.test(String(text || ''));
}

/**
 * Classify a failed attempt deterministically. The result is advisory: a
 * classification never changes a security policy and a hypothesis is not a
 * confirmed root cause. `retryable` only says whether waiting for the same
 * external condition could plausibly produce a different outcome; the caller
 * still owns the attempt budget.
 */
function classifyFailure(text) {
  const value = String(text || '');
  if (!value.trim()) return { kind: 'unknown', retryable: false };
  if (QUOTA_PATTERN.test(value)) return { kind: 'quota', retryable: true };
  if (AUTH_PATTERN.test(value)) return { kind: 'auth', retryable: false };
  if (NETWORK_PATTERN.test(value)) return { kind: 'network', retryable: true };
  if (TESTS_PATTERN.test(value)) return { kind: 'tests', retryable: false };
  if (INTERRUPTED_PATTERN.test(value)) return { kind: 'interrupted', retryable: false };
  return { kind: 'agent', retryable: false };
}

function detectResetHint(text) {
  const match = String(text || '').match(RESET_PATTERN);
  return match ? match[0].slice(0, 120) : null;
}

/**
 * Turn a failed task into a reusable lesson. The root cause is explicitly an
 * unconfirmed hypothesis: the exit code and error are evidence, nothing more.
 */
function recordFailure({ task, projectId, missionId }) {
  if (!task) return null;
  const text = `${task.error || ''}\n${task.result || ''}`;
  const { kind } = classifyFailure(text);
  const quota = kind === 'quota';
  const resetHint = detectResetHint(text);
  const titles = {
    quota: 'Agent provider quota was exhausted',
    network: 'Transient network failure reached the agent provider',
    auth: 'Agent authentication failed',
    tests: 'Tests or verification failed',
    interrupted: 'Agent execution was interrupted',
    agent: 'Agent execution failed',
    unknown: 'Task failed with an unknown execution state',
  };
  const rules = {
    quota: 'Pause autonomous work when the provider says quota is exhausted; resume only after a confirmed availability check.',
    network: 'Wait for connectivity or the provider, then retry once with the previous evidence instead of changing the code blindly.',
    auth: 'Stop and ask the operator to authenticate the agent; retrying does not fix missing or expired credentials.',
    tests: 'Read the failing assertion and fix the cause; do not claim completion until the relevant validation passes.',
    interrupted: 'Check whether a human or the host stopped the process before retrying the same action.',
    agent: 'Reproduce the failure and inspect evidence before retrying the same approach.',
    unknown: 'Reconcile the real process state before starting another attempt.',
  };
  const rootCauses = {
    quota: resetHint ? `Provider reset hint: ${resetHint}` : 'No confirmed reset time was provided.',
    network: 'Not confirmed: the provider or the local network was unreachable.',
    auth: 'Not confirmed by evidence: credentials may be missing, expired or scoped incorrectly.',
    tests: 'Not confirmed: the failing assertion identifies a symptom, not necessarily the root cause.',
    interrupted: 'Not confirmed: the process may have been stopped by the operator, the host or a crash.',
    agent: 'Not confirmed: the failure may come from the change, the environment or the agent.',
    unknown: 'Not confirmed: the execution outcome is unknown.',
  };
  return recordLesson({
    scope: 'project',
    projectId,
    taskId: task.id,
    missionId,
    title: titles[kind] || titles.agent,
    problem: task.error || 'The agent process exited without a successful result.',
    context: `Role ${task.role || 'unknown'} in mission ${missionId || 'none'}. Attempt ${task.attempt || 0}/${task.maxAttempts || 0}. Failure class: ${kind}.`,
    rootCause: rootCauses[kind] || rootCauses.agent,
    rootCauseConfirmed: false,
    solution: '',
    rule: rules[kind] || rules.agent,
    components: [task.role || 'task', task.agent || 'agent', kind].filter(Boolean),
    evidence: evidenceFor(task),
    tags: quota ? ['quota', 'provider'] : ['failure', kind],
    source: 'failure',
  });
}

/**
 * A user correction is confirmed project context from the moment it is saved.
 * It is never generalised to another project unless the operator promotes it.
 */
function recordCorrection({ task, projectId, missionId, text, createdBy }) {
  const clean = scrub(text);
  if (!clean) throw new Error('A correction cannot be empty.');
  return recordLesson({
    scope: 'project',
    projectId,
    taskId: task ? task.id : null,
    missionId,
    title: `User correction: ${clean.split('\n')[0].slice(0, 140)}`,
    problem: `The agent's result needed correction${task && task.title ? ` in "${task.title}"` : ''}.`,
    context: task ? `Role ${task.role || 'unknown'}, attempt ${task.attempt || 0}.` : 'Direct operator feedback.',
    solution: clean,
    rule: clean,
    rootCause: 'Operator correction (confirmed).',
    rootCauseConfirmed: true,
    components: [task && task.role ? task.role : 'task'].filter(Boolean),
    evidence: task ? evidenceFor(task) : [],
    tags: ['user-correction'],
    source: 'user_correction',
    status: 'confirmed',
    createdBy,
  });
}

function recordSuccess({ task, projectId, missionId }) {
  if (!task) return null;
  return recordLesson({
    scope: 'project',
    projectId,
    taskId: task.id,
    missionId,
    title: `Resolution worked: ${String(task.title || 'task').slice(0, 150)}`,
    problem: 'A previous failure was resolved by a change or verification step.',
    context: `Role ${task.role || 'unknown'}.`,
    solution: (task.result || 'The task completed successfully.').slice(0, 1200),
    rule: 'Prefer the verified approach from this task when the same failure appears again.',
    rootCauseConfirmed: false,
    components: [task.role || 'task'].filter(Boolean),
    evidence: evidenceFor(task),
    tags: ['resolution', 'success'],
    source: 'success',
    status: 'pending',
  });
}

/**
 * Deterministic retrieval used before planning. Project-specific confirmed
 * knowledge comes first; global knowledge is a fallback, never an override.
 * Pending rows are included only when they match the task text, and are
 * labelled as unconfirmed by the caller.
 */
function relevantLessons({ projectId, text = '', limit = 6 } = {}) {
  const db = getDatabase();
  const terms = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((w) => w.length >= 4)
    .slice(0, 8);
  const rows = db.prepare(`
    SELECT * FROM lessons
    WHERE status IN ('confirmed', 'pending')
      AND (scope = 'global' OR (scope = 'project' AND project_id = ?))
    ORDER BY CASE scope WHEN 'project' THEN 0 ELSE 1 END,
             CASE status WHEN 'confirmed' THEN 0 ELSE 1 END,
             occurrences DESC, updated_at DESC
    LIMIT 80
  `).all(projectId || null);

  const scored = rows.map((row) => {
    const haystack = [row.title, row.problem, row.rule, row.tags, row.components].join(' ').toLowerCase();
    const hits = terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0);
    const score = (row.scope === 'project' ? 4 : 0) + (row.status === 'confirmed' ? 2 : 0) + hits;
    return { row, score, hits };
  });
  scored.sort((a, b) => b.score - a.score || b.row.occurrences - a.row.occurrences);
  const selected = scored.filter((s) => s.hits > 0 || s.row.status === 'confirmed').slice(0, Math.min(Math.max(limit, 1), 12));
  return selected.map(({ row }) => toPublic(row));
}

function markUsed(missionId, lessonIds) {
  if (!missionId || !lessonIds || !lessonIds.length) return;
  try {
    getDatabase().prepare('UPDATE missions SET used_lessons = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify([...new Set(lessonIds)]), nowIso(), String(missionId));
  } catch {
    // The mission may have been deleted; retrieval is advisory, never fatal.
  }
}

function setStatus(id, status, extra = {}) {
  if (!STATUSES.has(status)) throw new Error('Unknown lesson status.');
  const lesson = getLesson(id);
  if (!lesson) throw new Error('Lesson not found.');
  if (status === 'superseded' && !extra.supersededBy) {
    throw new Error('A superseded lesson needs the replacement lesson id.');
  }
  const now = nowIso();
  getDatabase().prepare(`
    UPDATE lessons SET status = ?, updated_at = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
      superseded_by = COALESCE(?, superseded_by)
    WHERE id = ?
  `).run(status, now, status, now, extra.supersededBy ? String(extra.supersededBy) : null, String(id));
  logService.record({
    category: 'learning', action: `lesson_${status}`,
    message: `Lesson ${status}.`, details: { lessonId: String(id) },
  });
  return getLesson(id);
}

function confirmLesson(id) {
  return setStatus(id, 'confirmed');
}

function discardLesson(id) {
  return setStatus(id, 'discarded');
}

function supersedeLesson(id, replacementId) {
  if (!replacementId) throw new Error('A replacement lesson id is required.');
  if (String(id) === String(replacementId)) throw new Error('A lesson cannot supersede itself.');
  return setStatus(id, 'superseded', { supersededBy: replacementId });
}

/**
 * Explicit promotion only. The caller must name the lesson; there is no
 * automatic path from a repeated project failure to global policy.
 */
function promoteLesson(id, { createdBy } = {}) {
  const lesson = getLesson(id);
  if (!lesson) throw new Error('Lesson not found.');
  if (lesson.scope === 'global') return lesson;
  if (lesson.status === 'discarded' || lesson.status === 'superseded') {
    throw new Error('Only a current lesson can be promoted.');
  }
  const now = nowIso();
  getDatabase().prepare(`
    UPDATE lessons SET scope = 'global', project_id = NULL, status = 'confirmed',
      root_cause_confirmed = 1, confirmed_at = COALESCE(confirmed_at, ?), updated_at = ?
    WHERE id = ?
  `).run(now, now, String(id));
  logService.record({
    category: 'learning', action: 'lesson_promoted',
    message: 'Lesson promoted to global knowledge by an operator.',
    details: { lessonId: String(id), createdBy: createdBy || null },
  });
  return getLesson(id);
}

module.exports = {
  listLessons,
  getLesson,
  recordLesson,
  recordFailure,
  recordCorrection,
  recordSuccess,
  relevantLessons,
  markUsed,
  confirmLesson,
  discardLesson,
  supersedeLesson,
  promoteLesson,
  isQuotaError,
  classifyFailure,
  detectResetHint,
  scrub,
};
