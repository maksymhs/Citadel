/**
 * Citadel Mission Service — a small, durable "agent team" layer on top of the
 * pull queue.
 *
 * A mission is a goal plus a validated DAG of subtasks. It deliberately does not
 * own execution: every subtask is a normal row in `tasks`, so claims, leases,
 * retries, cancellation and reconciliation keep working unchanged. The mission
 * only adds the parts a queue does not have:
 *
 *   - a validated plan (roles, dependencies, one project, bounded size);
 *   - a workspace with goal, plan, notes and per-task handoffs, so agents pass
 *     context through files instead of ever-growing prompts;
 *   - dependency release: a blocked task becomes claimable only when every task
 *     it depends on is done;
 *   - planner ingestion: the planner agent writes plan.json and the server
 *     validates it before enqueuing anything. A planner can never inject a
 *     command line or a path.
 *
 * The workspace is intentionally under DATA_DIR, not the project checkout: agent
 * notes must not dirty a repository.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDatabase } = require('../database/db');
const { MISSIONS_DIR } = require('../config');
const { scrub } = require('../security/redact');
const taskService = require('./taskService');
const projectService = require('./projectService');
const logService = require('./logService');
const learningService = require('./learningService');
const docService = require('./docService');

const MAX_TASKS = 20;
const MAX_GOAL_CHARS = 8000;
const MAX_NOTE_CHARS = 20000;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_TITLE_CHARS = 160;
const MAX_ACCEPTANCE = 20;
// A quota pause is a cooldown before the next cautious availability check, not
// a claim about when the provider resets. It is deliberately configurable and
// bounded; the mission never spins on the provider while paused.
const QUOTA_COOLDOWN_MS = Math.min(
  Math.max(parseInt(process.env.CITADEL_QUOTA_COOLDOWN_MS, 10) || 15 * 60 * 1000, 60 * 1000),
  24 * 60 * 60 * 1000,
);
const MAX_QUOTA_PAUSES = 5;

// Roles are data, not code paths: the same CLI gets a different brief per role.
// `agent` is a preference, not a requirement; ingest falls back to the first
// installed headless agent so a mission is not blocked by a missing binary.
const ROLES = {
  planner: {
    label: 'Planner',
    short: 'PL',
    color: '#a371f7',
    agent: 'claude',
    brief: 'You are the technical lead. Break the mission into small, verifiable subtasks, keep independent work parallel, and put QA after implementation. Do not write application code.',
  },
  developer: {
    label: 'Developer',
    short: 'DV',
    color: '#3fb950',
    agent: 'claude',
    brief: 'You are the developer. Implement the smallest correct change, follow the project conventions, and report tests you ran and anything you could not verify.',
  },
  analyst: {
    label: 'Analyst',
    short: 'AN',
    color: '#58a6ff',
    agent: 'claude',
    brief: 'You are the analyst. Inspect the codebase and requirements, state assumptions and risks, and write a precise implementation brief with file-level pointers.',
  },
  backend: {
    label: 'Backend',
    short: 'BE',
    color: '#3fb950',
    agent: 'claude',
    brief: 'You are the backend engineer. Implement the smallest correct change, follow the project conventions, and report tests you ran and anything you could not verify.',
  },
  frontend: {
    label: 'Frontend',
    short: 'FE',
    color: '#d29922',
    agent: 'claude',
    brief: 'You are the frontend engineer. Keep the UI consistent with the existing design system, use plain JS/CSS as the project does, and report what you verified in the browser.',
  },
  qa: {
    label: 'QA',
    short: 'QA',
    color: '#f85149',
    agent: 'opencode',
    brief: 'You are QA. Try to break the change: run the relevant tests, add focused tests when useful, and report exact commands and outcomes. Never claim a test passed if you did not run it.',
  },
  reviewer: {
    label: 'Reviewer',
    short: 'RV',
    color: '#db6d28',
    agent: 'codex',
    brief: 'You are the reviewer. Look for correctness, security and regressions. Report findings ordered by severity; do not rewrite the implementation unless asked.',
  },
  docs: {
    label: 'Docs',
    short: 'DC',
    color: '#8b949e',
    agent: 'opencode',
    brief: 'You are the technical writer. Update the documentation that the change affects, in the project tone, and link the files you changed.',
  },
  devops: {
    label: 'DevOps',
    short: 'DO',
    color: '#39c5cf',
    agent: 'opencode',
    brief: 'You are the DevOps engineer. Keep changes local and unprivileged by default, prefer structured arguments and path guards, and flag anything that widens exposure.',
  },
};

const ROLE_IDS = Object.keys(ROLES);
const HEADLESS_AGENTS = Object.keys(taskService.AGENT_HEADLESS);
const FINAL_TASK_STATES = new Set(['done', 'failed', 'cancelled']);
const ACTIVE_TASK_STATES = new Set(['queued', 'blocked', 'running', 'cancelling']);

function nowIso() {
  return new Date().toISOString();
}

function slugify(value, fallback = 'task') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function titleFromGoal(goal) {
  const firstLine = String(goal || '').trim().split(/\r?\n/)[0].trim();
  return (firstLine || 'Untitled mission').slice(0, 120);
}

function normalisePlan(raw) {
  if (Array.isArray(raw)) return { tasks: raw };
  if (raw && typeof raw === 'object' && Array.isArray(raw.tasks)) return raw;
  if (raw && typeof raw === 'object' && raw.plan && Array.isArray(raw.plan.tasks)) return raw.plan;
  return null;
}

/**
 * Validate a planner/UI plan. Every rule here is a security boundary: the plan
 * is untrusted model output, and it must never be able to choose a binary, a
 * project path, a shell command or a workspace outside this mission.
 */
function validatePlan(raw) {
  const plan = normalisePlan(raw);
  if (!plan) throw new Error('The plan must be an object with a "tasks" array.');
  if (plan.tasks.length < 1 || plan.tasks.length > MAX_TASKS) {
    throw new Error(`The plan must contain between 1 and ${MAX_TASKS} tasks.`);
  }

  const seenTitle = new Set();
  const tasks = plan.tasks.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Task ${index + 1} is not an object.`);
    const rawTitle = String(item.title || '').trim();
    if (rawTitle.length < 2 || rawTitle.length > MAX_TITLE_CHARS) {
      throw new Error(`Task ${index + 1} needs a title (2-${MAX_TITLE_CHARS} characters).`);
    }
    const title = scrub(rawTitle, MAX_TITLE_CHARS);
    const role = String(item.role || '').trim().toLowerCase();
    if (!ROLE_IDS.includes(role)) {
      throw new Error(`Task ${index + 1} has unknown role "${scrub(String(item.role || ''), 40)}". Use one of: ${ROLE_IDS.join(', ')}.`);
    }
    const rawDescription = item.description === undefined ? '' : String(item.description).trim();
    if (rawDescription.length > 4000) throw new Error(`Task ${index + 1} description is too long.`);
    const description = scrub(rawDescription, 4000);

    // Acceptance criteria are data on the task, not an instruction to the model
    // that can be silently dropped. They are shown in review and included in the
    // agent brief.
    const rawAcceptance = item.acceptance !== undefined ? item.acceptance : item.criteria;
    const acceptance = Array.isArray(rawAcceptance)
      ? rawAcceptance
      : (rawAcceptance ? String(rawAcceptance).split(/\r?\n/) : []);
    const cleanAcceptance = acceptance
      .map((value) => String(value).trim())
      .filter(Boolean)
      .slice(0, MAX_ACCEPTANCE)
      .map((value) => scrub(value.slice(0, 500), 500))
      .filter(Boolean);
    const refs = Array.isArray(item.refs)
      ? item.refs.map((value) => scrub(String(value).trim(), 500)).filter(Boolean).slice(0, 20)
      : [];

    let agent = null;
    if (item.agent !== undefined && item.agent !== null && item.agent !== '') {
      agent = String(item.agent).trim().toLowerCase();
      if (!HEADLESS_AGENTS.includes(agent)) {
        throw new Error(`Task ${index + 1} requests unsupported agent "${item.agent}". Use one of: ${HEADLESS_AGENTS.join(', ')}.`);
      }
    }

    const deps = Array.isArray(item.deps) ? item.deps : [];
    const cleanDeps = [];
    for (const dep of deps) {
      const n = Number(dep);
      if (!Number.isInteger(n) || n < 0 || n >= index) {
        throw new Error(`Task ${index + 1} has an invalid dependency. Dependencies must be earlier task indices.`);
      }
      if (!cleanDeps.includes(n)) cleanDeps.push(n);
    }

    const key = title.toLowerCase();
    if (seenTitle.has(key)) throw new Error(`Duplicate task title: "${title}".`);
    seenTitle.add(key);

    return {
      index,
      title,
      role,
      description,
      agent,
      deps: cleanDeps,
      exclusive: Boolean(item.exclusive),
      acceptance: cleanAcceptance,
      refs,
      stage: 0,
    };
  });

  for (const task of tasks) {
    task.stage = task.deps.reduce((max, dep) => Math.max(max, tasks[dep].stage + 1), 0);
  }
  return { tasks };
}

function installedAgents() {
  // Lazy: loading the terminal/agent stack is only needed when a mission is
  // actually created, and never for reading a mission. One pass, no version
  // probes: planning must stay fast with many subtasks.
  const agentRegistry = require('./agentRegistry');
  const out = {};
  for (const info of agentRegistry.listAgents({ versions: false })) {
    if (info.installed && HEADLESS_AGENTS.includes(info.id)) out[info.id] = info;
  }
  return out;
}

function preflightAgents(plan) {
  const installed = installedAgents();
  if (Object.keys(installed).length === 0) {
    throw new Error(`No headless agent is installed. Install one of: ${HEADLESS_AGENTS.join(', ')}.`);
  }
  for (const task of plan.tasks) {
    if (task.agent && !installed[task.agent]) {
      throw new Error(`Agent "${task.agent}" is not installed on this host.`);
    }
  }
}

function pickAgent(requested, preferred, installed) {
  if (requested) {
    if (!installed[requested]) throw new Error(`Agent "${requested}" is not installed on this host.`);
    return requested;
  }
  const candidates = [preferred, ...HEADLESS_AGENTS];
  const found = candidates.find((id) => id && installed[id]);
  if (!found) {
    throw new Error(`No headless agent is installed. Install one of: ${HEADLESS_AGENTS.join(', ')}.`);
  }
  return found;
}

function ensureWorkspace(workspace) {
  for (const dir of [workspace, path.join(workspace, 'handoff'), path.join(workspace, 'artifacts')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
}

function missionRow(id) {
  return getDatabase().prepare('SELECT * FROM missions WHERE id = ?').get(id);
}

function tasksOf(missionId) {
  return taskService.listTasks({ missionId, limit: 500 });
}

function parseList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toPublicMission(row, tasks = null) {
  if (!row) return null;
  const list = tasks || tasksOf(row.id);
  const counts = {};
  for (const task of list) counts[task.status] = (counts[task.status] || 0) + 1;
  // The planner is setup work: show progress over the actual subtasks.
  const counted = list.filter((t) => t.role !== 'planner');
  const done = counted.filter((t) => t.status === 'done').length;
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id || null,
    goal: row.goal,
    status: row.status,
    plannerAgent: row.planner_agent || null,
    plannerTaskId: row.planner_task_id || null,
    hasPlan: Boolean(row.plan),
    planVersion: row.plan_version || 1,
    usedLessons: parseList(row.used_lessons),
    workspace: row.workspace,
    error: row.error || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    counts,
    total: counted.length,
    done,
    progress: counted.length ? Math.round((done / counted.length) * 100) : 0,
  };
}

function roleList() {
  return ROLE_IDS.map((id) => ({
    id,
    label: ROLES[id].label,
    short: ROLES[id].short,
    color: ROLES[id].color,
    agent: ROLES[id].agent,
    brief: ROLES[id].brief,
  }));
}

function buildTaskPrompt({ mission, task, handoffs, projectPath, lessons }) {
  const role = ROLES[task.role];
  const lines = [
    `You are the ${role.label} in a Citadel agent team.`,
    '',
    role.brief,
    '',
    `MISSION: ${mission.title}`,
    `GOAL:\n${mission.goal}`,
    `WORKSPACE: ${mission.workspace}`,
    `PROJECT: ${projectPath || 'not set'}`,
    '',
    `YOUR TASK (${task.index + 1}/${task.total}): ${task.title}`,
  ];
  if (task.description) lines.push('', task.description);
  if (task.acceptance && task.acceptance.length) {
    lines.push('', 'ACCEPTANCE CRITERIA (a result that misses one is not done):');
    for (const item of task.acceptance) lines.push(`- ${item}`);
  }
  if (task.refs && task.refs.length) {
    lines.push('', 'FILES AND REFERENCES:');
    for (const item of task.refs) lines.push(`- ${item}`);
  }
  if (lessons && lessons.length) {
    lines.push('', 'LESSONS FROM EARLIER WORK (project-scoped unless marked global; user corrections are authoritative):');
    for (const lesson of lessons) {
      lines.push(`- [${lesson.scope}/${lesson.status}] ${lesson.rule || lesson.solution || lesson.title}`);
    }
  }
  if (task.deps.length) {
    lines.push('', 'HANDOFFS FROM DEPENDENCIES (read these first):');
    for (const dep of task.deps) lines.push(`- ${handoffs[dep]}`);
  }
  lines.push(
    '',
    `Write your handoff to: ${handoffs[task.index]}`,
    'The handoff is Markdown and must be concise but complete: what you did, files touched, commands run and their outcome, decisions, and what remains. Do not paste secrets.',
    `Do not write outside ${projectPath || 'the project'} except your handoff and ${path.join(mission.workspace, 'artifacts')}.`,
    'When the handoff is written, exit with status 0. If you could not complete the task, write why and exit non-zero.',
    'If the change alters architecture, public behaviour, configuration, security or operations, update the relevant Markdown under the project documentation directory and name those files in the handoff.',
  );
  return lines.join('\n');
}

const PLANNER_PROMPT = (mission, projectPath, context = {}) => [
  'You are the planner (technical lead) of a Citadel agent team.',
  '',
  ROLES.planner.brief,
  '',
  `MISSION: ${mission.title}`,
  `GOAL:\n${mission.goal}`,
  `WORKSPACE: ${mission.workspace}`,
  `PROJECT: ${projectPath || 'not set'}`,
  '',
  'RELATED DOCUMENTATION (read what you need; add a docs task only when the change affects it):',
  ...(context.docs && context.docs.length ? context.docs.map((d) => `- ${d.path} — ${d.title}`) : ['- none found']),
  '',
  'APPLICABLE LESSONS (do not treat a hypothesis as proven):',
  ...(context.lessons && context.lessons.length
    ? context.lessons.map((l) => `- [${l.scope}/${l.status}] ${l.rule || l.solution || l.title}`)
    : ['- none']),
  '',
  `Write the plan as JSON to: ${path.join(mission.workspace, 'plan.json')}`,
  'If you cannot write files, print the JSON in a ```json fenced block as your final answer.',
  '',
  'Schema:',
  '{"tasks":[{"title":"...","role":"analyst|developer|backend|frontend|qa|reviewer|docs|devops",',
  '"description":"...","acceptance":["..."],"refs":["path"],"deps":[0],"agent":"claude|opencode|codex","exclusive":false}]}',
  '',
  `Rules: 2-${MAX_TASKS} tasks; deps are 0-based indices of EARLIER tasks; keep independent work parallel;`,
  'put a QA task after implementation; add a docs task only when architecture, public behaviour, configuration,',
  'installation, security or operations change; keep each task small and verifiable; include acceptance criteria;',
  'never include secrets, absolute paths, shell commands or a command to execute.',
  '',
  `Also write a short planning note to: ${path.join(mission.workspace, 'handoff', 'planner.md')}`,
].join('\n');

/**
 * Enqueue the subtasks of a validated plan. IDs are assigned by taskService, so
 * dependencies are inserted in plan order and refer to the ids collected so far.
 */
function enqueuePlan(mission, plan, projectPath) {
  const installed = installedAgents();
  const lessons = learningService.relevantLessons({
    projectId: mission.project_id || null,
    text: [mission.goal, ...plan.tasks.map((t) => `${t.title} ${t.description || ''}`)].join(' '),
    limit: 6,
  });
  const plannerAgent = mission.planner_agent && installed[mission.planner_agent]
    ? mission.planner_agent
    : pickAgent(null, ROLES.planner.agent, installed);

  const handoffs = plan.tasks.map((task, index) => path.join(
    mission.workspace,
    'handoff',
    `${String(index + 1).padStart(2, '0')}-${slugify(task.role + '-' + task.title)}.md`,
  ));

  // SQLite is authoritative: version, plan and all tasks commit together.
  // The Markdown workspace is a recoverable copy, written before publication.
  const db = getDatabase();
  const planCopy = path.join(mission.workspace, `.plan-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(planCopy, JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(planCopy, path.join(mission.workspace, 'plan.json'));
  } finally {
    fs.rmSync(planCopy, { force: true });
  }
  db.transaction(() => {
    const version = (mission.plan_version || 0) + 1;
    db.prepare(`
      INSERT INTO mission_plan_versions (id, mission_id, version, plan, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), mission.id, version, JSON.stringify(plan),
      mission.plan_revision_reason || null, mission.created_by || null, nowIso(),
    );
    db.prepare(`UPDATE missions SET plan = ?, plan_version = ?, status = ?, error = NULL, finished_at = NULL, updated_at = ?
      WHERE id = ?`).run(JSON.stringify(plan), version, 'running', nowIso(), mission.id);

    const createdIds = [];
    plan.tasks.forEach((task, index) => {
      const deps = task.deps.map((dep) => createdIds[dep]);
      const agent = pickAgent(task.agent, ROLES[task.role].agent || plannerAgent, installed);
      const prompt = buildTaskPrompt({
        mission,
        task: { ...task, total: plan.tasks.length },
        handoffs,
        projectPath,
        lessons,
      });
      const created = taskService.enqueue({
        agent,
        prompt,
        projectPath,
        title: task.title,
        missionId: mission.id,
        role: task.role,
        deps,
        stage: task.stage,
        handoffRef: path.relative(mission.workspace, handoffs[index]),
        exclusive: task.exclusive,
        acceptance: task.acceptance,
        refs: task.refs,
        autonomous: true,
        status: deps.length ? 'blocked' : 'queued',
      });
      createdIds.push(created.id);
    });
  })();

  learningService.markUsed(mission.id, lessons.map((lesson) => lesson.id));
  logService.record({
    category: 'mission',
    action: 'mission_planned',
    message: `Mission "${mission.title}" planned with ${plan.tasks.length} task(s).`,
    details: { missionId: mission.id, tasks: plan.tasks.length },
  });
}

function extractPlanFromResult(text) {
  const value = String(text || '');
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* try the whole text */ }
  }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(value.slice(start, end + 1)); } catch { /* invalid */ }
  }
  return null;
}

/**
 * If the planner task finished, ingest its plan exactly once. The planner can
 * write plan.json (preferred) or print it; either source is validated before a
 * single task is enqueued.
 */
function ingestPlannerPlan(mission) {
  if (!mission.planner_task_id) return false;
  const planner = taskService.getTask(mission.planner_task_id);
  if (!planner || planner.status !== 'done') return false;
  if (mission.plan) return false;

  const db = getDatabase();
  const project = mission.project_id ? projectService.getProject(mission.project_id) : null;
  const planFile = path.join(mission.workspace, 'plan.json');
  let raw = null;
  let source = null;

  try {
    const stat = fs.statSync(planFile);
    if (stat.size > 0 && stat.size <= MAX_PLAN_BYTES) {
      raw = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      source = 'file';
    }
  } catch {
    // No readable plan file: fall back to the captured result below.
  }
  if (!raw) {
    raw = extractPlanFromResult(planner.result);
    source = raw ? 'result' : null;
  }

  if (!raw) {
    db.prepare('UPDATE missions SET status = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run('review', 'The planner did not produce a valid plan.json or JSON result.', nowIso(), nowIso(), mission.id);
    logService.record({
      level: 'warn', category: 'mission', action: 'mission_plan_missing',
      message: `Mission "${mission.title}" has no readable plan.`, details: { missionId: mission.id },
    });
    return true;
  }

  try {
    const plan = validatePlan(raw);
    enqueuePlan(mission, plan, project ? project.path : null);
    logService.record({
      category: 'mission', action: 'mission_plan_ingested',
      message: `Planner plan ingested from ${source} for "${mission.title}".`,
      details: { missionId: mission.id, source },
    });
    return true;
  } catch (err) {
    db.prepare('UPDATE missions SET status = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run('review', `Invalid planner plan: ${err.message}`, nowIso(), nowIso(), mission.id);
    logService.record({
      level: 'warn', category: 'mission', action: 'mission_plan_invalid',
      message: `Mission "${mission.title}" plan rejected: ${err.message}`, details: { missionId: mission.id },
    });
    return true;
  }
}

/**
 * Link the documents an attempt actually mentioned. It is bounded to docs that
 * exist, uses the explicit refs plus Markdown paths in the result/handoff, and
 * runs once per attempt (`docs_linked`) so a refresh loop cannot duplicate work.
 */
function linkTaskDocs(mission, task) {
  if (!mission.project_id || task.docsLinked) return false;
  let handoff = '';
  if (task.handoffRef) {
    try {
      const abs = checkWorkspacePath(mission, task.handoffRef);
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= MAX_PLAN_BYTES) handoff = fs.readFileSync(abs, 'utf8');
    } catch { /* optional, missing or unsafe handoff */ }
  }
  const text = [task.result || '', task.error || '', handoff, ...(task.refs || [])].join('\n');
  const candidates = new Set();
  for (const match of text.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) candidates.add(match[1]);
  for (const match of text.matchAll(/[\w./-]+\.md\b/g)) candidates.add(match[0]);
  const linked = [];
  let failed = false;
  for (const raw of candidates) {
    const rel = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^docs\//, '');
    let clean = docService.existingDoc({ projectId: mission.project_id, relPath: rel });
    if (!clean) clean = docService.existingDoc({ projectId: mission.project_id, relPath: linkTargetFallback(rel) });
    if (!clean) continue;
    try {
      docService.linkDoc({ projectId: mission.project_id, relPath: clean, taskId: task.id, missionId: mission.id });
      linked.push(clean);
    } catch {
      failed = true;
    }
  }
  if (!failed) getDatabase().prepare('UPDATE tasks SET docs_linked = 1, updated_at = ? WHERE id = ?').run(nowIso(), task.id);
  if (linked.length) {
    logService.record({
      category: 'docs', action: 'document_task_linked',
      message: `Linked ${linked.length} document(s) to task "${task.title}".`,
      details: { missionId: mission.id, taskId: task.id, docs: linked },
    });
  }
  return linked.length > 0;
}

/** Tolerate `[[Page]]` links that omit the extension. */
function linkTargetFallback(rel) {
  return path.extname(rel) ? rel : `${rel}.md`;
}

function computeStatus(mission, tasks) {
  if (mission.status === 'cancelling' || mission.status === 'cancelled') {
    return tasks.some((t) => ACTIVE_TASK_STATES.has(t.status)) ? 'cancelling' : 'cancelled';
  }
  // A planning error (unreadable or invalid plan) stays visible until the
  // operator imports a valid plan; never silently turn it into "done".
  if (mission.error) {
    return tasks.some((t) => ACTIVE_TASK_STATES.has(t.status)) ? 'running' : 'review';
  }
  if (mission.status === 'planning') {
    if (mission.planner_task_id) {
      const planner = tasks.find((t) => t.id === mission.planner_task_id);
      if (planner && !FINAL_TASK_STATES.has(planner.status)) return 'planning';
      if (!planner && !mission.plan) return 'planning';
    } else if (!mission.plan) {
      return 'planning';
    }
  }
  // A finished task with acceptance criteria waits for a human decision. It is
  // neither done nor running: dependencies stay blocked and the mission is
  // visibly in review until accepted or rejected.
  if (tasks.some((t) => t.status === 'review')) return 'review';
  // Quota is its own visible state: work is paused, not failed and not running.
  const meaningfulForWait = tasks.filter((t) => t.role !== 'planner');
  if (meaningfulForWait.some((t) => t.status === 'quota')) {
    return meaningfulForWait.some((t) => ['running', 'cancelling'].includes(t.status)) ? 'running' : 'quota';
  }
  // A failed/missing planner is recoverable through a manual plan import: once
  // subtasks exist, the planner task no longer decides mission completion.
  const meaningful = tasks.filter((t) => t.role !== 'planner');
  const scope = meaningful.length ? meaningful : tasks;
  if (scope.length === 0) return mission.plan ? 'review' : 'planning';
  const active = scope.some((t) => ACTIVE_TASK_STATES.has(t.status));
  if (active) return 'running';
  if (scope.every((t) => t.status === 'done')) return 'done';
  return 'review';
}

/**
 * Refresh a mission: release dependency-ready tasks, ingest a finished planner,
 * recompute status and persist it. Idempotent and safe to call on every read,
 * which also recovers a notification lost between a task result and this call.
 */
function refreshMission(id) {
  const mission = missionRow(id);
  if (!mission) return null;
  const db = getDatabase();
  const now = nowIso();

  if (mission.status === 'planning') ingestPlannerPlan(mission);
  const current = missionRow(id);
  if (!current) return null;
  let tasks = tasksOf(id);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Quota pauses resume only after their cautious cooldown, and only while the
  // attempt budget lasts. No reset time is invented: the task simply becomes
  // eligible for the next check.
  const nowMs = Date.now();
  for (const task of tasks.filter((t) => t.status === 'quota')) {
    const due = !task.retryAt || new Date(task.retryAt).getTime() <= nowMs;
    if (!due) continue;
    if ((task.quotaCount || 0) >= MAX_QUOTA_PAUSES || task.attempt >= task.maxAttempts) {
      db.prepare("UPDATE tasks SET status = 'failed', blocked_reason = 'quota', retry_at = NULL, finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ? AND status = 'quota'")
        .run(now, now, task.id);
    } else {
      db.prepare("UPDATE tasks SET status = 'queued', blocked_reason = NULL, retry_at = NULL, updated_at = ? WHERE id = ? AND status = 'quota'")
        .run(now, task.id);
    }
  }
  if (tasks.some((t) => t.status === 'quota')) tasks = tasksOf(id);

  // A failed attempt whose text reports provider quota is paused, not retried
  // immediately and not counted as a final failure.
  tasks = tasksOf(id);
  for (const task of tasks.filter((t) => t.status === 'failed')) {
    const text = `${task.error || ''}\n${task.result || ''}`;
    if (task.blockedReason === 'rejected' || task.attempt >= task.maxAttempts || task.quotaCount >= MAX_QUOTA_PAUSES || !learningService.isQuotaError(text)) continue;
    const next = new Date(Date.now() + QUOTA_COOLDOWN_MS).toISOString();
    db.prepare(`
      UPDATE tasks SET status = 'quota', blocked_reason = 'quota', retry_at = ?,
        quota_count = quota_count + 1, finished_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed'
    `).run(next, now, task.id);
    logService.record({
      level: 'warn', category: 'mission', action: 'mission_quota_paused',
      message: `Task paused until the next quota check (${QUOTA_COOLDOWN_MS}ms).`,
      details: { missionId: id, taskId: task.id, retryAt: next },
    });
  }
  // Attach the deterministic failure class so the UI and docs can explain why
  // an attempt stopped without parsing the agent transcript again.
  tasks = tasksOf(id);
  for (const task of tasks.filter((t) => t.status === 'failed')) {
    const classified = learningService.classifyFailure(`${task.error || ''}\n${task.result || ''}`);
    const blockedReason = task.blockedReason === 'rejected' ? 'rejected' : classified.kind;
    if (task.failureKind === classified.kind && task.blockedReason === blockedReason) continue;
    db.prepare(`
      UPDATE tasks SET failure_kind = ?, blocked_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'failed'
    `).run(classified.kind, blockedReason, now, task.id);
  }
  tasks = tasksOf(id);

  for (const task of tasks.filter((t) => ['done', 'review', 'failed'].includes(t.status) && !t.docsLinked)) {
    try {
      linkTaskDocs(current, task);
    } catch (err) {
      logService.record({ level: 'warn', category: 'docs', action: 'document_task_link_failed', message: err.message, details: { taskId: task.id } });
    }
  }
  tasks = tasksOf(id);

  // One-time evidence capture per attempt. The dedupe in learningService keeps
  // a repeated failure as one lesson with an occurrence count.
  for (const task of tasks.filter((t) => t.status === 'failed' && !t.learningRecorded)) {
    try {
      learningService.recordFailure({ task, projectId: current.project_id, missionId: id });
      db.prepare('UPDATE tasks SET learning_recorded = 1 WHERE id = ?').run(task.id);
    } catch (err) {
      logService.record({ level: 'warn', category: 'learning', action: 'lesson_failure_failed', message: err.message, details: { taskId: task.id } });
    }
  }
  for (const task of tasks.filter((t) => t.status === 'done' && t.attempt > 1 && !t.learningRecorded)) {
    try {
      learningService.recordSuccess({ task, projectId: current.project_id, missionId: id });
      db.prepare('UPDATE tasks SET learning_recorded = 1 WHERE id = ?').run(task.id);
    } catch {
      // Learning is advisory; a persistence hiccup must not break the mission.
    }
  }
  byId.clear();
  for (const task of tasks) byId.set(task.id, task);

  const blocked = tasks.filter((t) => t.status === 'blocked');
  const released = [];
  for (const task of blocked) {
    const deps = task.deps || [];
    if (deps.length === 0) continue;
    if (deps.every((dep) => byId.get(dep) && byId.get(dep).status === 'done')) {
      const res = db.prepare(`
        UPDATE tasks SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'blocked'
      `).run(now, task.id);
      if (res.changes === 1) released.push(task.id);
    }
  }
  if (released.length) {
    logService.record({
      category: 'mission', action: 'mission_tasks_released',
      message: `Released ${released.length} task(s) after their dependencies completed.`,
      details: { missionId: id, tasks: released },
    });
  }

  const freshTasks = tasksOf(id);
  const latest = missionRow(id);
  const status = computeStatus(latest, freshTasks);
  const finished = ['done', 'review', 'cancelled'].includes(status) ? now : null;
  // Do not touch updated_at on every poll: the UI uses it as a change signal.
  const changed = status !== latest.status
    || (finished && !latest.finished_at)
    || released.length > 0;
  if (changed) {
    db.prepare(`
      UPDATE missions SET status = ?, updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(status, now, finished, id);
  }
  return missionRow(id);
}

/** Called by taskService after a task reaches a terminal state. */
function onTaskChanged(missionId) {
  if (!missionId) return;
  try {
    refreshMission(missionId);
  } catch (err) {
    logService.record({
      level: 'warn', category: 'mission', action: 'mission_refresh_failed',
      message: `Could not refresh mission: ${err.message}`, details: { missionId },
    });
  }
}

function createMission({ goal, projectId, plan, plannerAgent, createdBy, title } = {}) {
  const rawGoal = String(goal || '').trim();
  if (!rawGoal) throw new Error('A mission requires a "goal".');
  if (rawGoal.length > MAX_GOAL_CHARS) throw new Error(`The goal is too long (max ${MAX_GOAL_CHARS} characters).`);
  // Goals become prompts and Markdown, so a credential pasted into the form
  // must not survive in either place.
  const cleanGoal = scrub(rawGoal, MAX_GOAL_CHARS) || rawGoal;

  const project = projectId ? projectService.getProject(String(projectId)) : null;
  if (projectId && !project) throw new Error('Project not found.');

  const cleanPlanner = plannerAgent ? String(plannerAgent).trim().toLowerCase() : null;
  if (cleanPlanner && !HEADLESS_AGENTS.includes(cleanPlanner)) {
    throw new Error(`Unsupported planner agent "${plannerAgent}".`);
  }

  // Validate before creating any row or directory: a bad plan (or an agent that
  // is not installed) must leave no half-built mission behind.
  const validated = plan ? validatePlan(plan) : null;
  if (validated) preflightAgents(validated);

  const id = crypto.randomUUID();
  const workspace = path.join(MISSIONS_DIR, id);
  ensureWorkspace(workspace);
  const now = nowIso();
  const requestedTitle = scrub(String(title || '').trim(), 120);
  const cleanTitle = requestedTitle || titleFromGoal(cleanGoal);

  const db = getDatabase();
  db.prepare(`
    INSERT INTO missions
      (id, title, project_id, goal, status, planner_agent, workspace, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    cleanTitle,
    project ? project.id : null,
    cleanGoal,
    validated ? 'running' : 'planning',
    cleanPlanner,
    workspace,
    createdBy ? String(createdBy) : null,
    now,
    now,
  );

  const goalPage = [
    `# ${cleanTitle}`,
    '',
    `Created: ${now}`,
    `Project: ${project ? project.path : 'none'}`,
    '',
    '## Goal',
    '',
    cleanGoal,
    '',
    '## Notes',
    '',
    'Use the Notes tab to append decisions. Agent handoffs live in `handoff/`.',
    '',
  ].join('\n');
  writeIfMissing(path.join(workspace, 'goal.md'), goalPage);
  writeIfMissing(path.join(workspace, 'decisions.md'), `# Decisions — ${cleanTitle}\n`);

  if (validated) {
    enqueuePlan(missionRow(id), validated, project ? project.path : null);
  } else {
    const installed = installedAgents();
    const agent = pickAgent(cleanPlanner, ROLES.planner.agent, installed);
    const mission = missionRow(id);
    const context = {
      lessons: learningService.relevantLessons({ projectId: project ? project.id : null, text: cleanGoal, limit: 6 }),
      docs: project ? docService.relevantDocs({ projectId: project.id, q: cleanGoal, limit: 12 }) : [],
    };
    learningService.markUsed(id, context.lessons.map((lesson) => lesson.id));
    const created = taskService.enqueue({
      agent,
      prompt: PLANNER_PROMPT(mission, project ? project.path : null, context),
      projectPath: project ? project.path : null,
      title: `Plan: ${cleanTitle}`.slice(0, 200),
      missionId: id,
      role: 'planner',
      handoffRef: 'handoff/planner.md',
      autonomous: true,
      status: 'queued',
    });
    db.prepare('UPDATE missions SET planner_agent = ?, planner_task_id = ?, updated_at = ? WHERE id = ?')
      .run(agent, created.id, nowIso(), id);
  }

  logService.record({
    category: 'mission',
    action: 'mission_created',
    message: `Mission "${cleanTitle}" created${validated ? ` with ${validated.tasks.length} task(s)` : ' (waiting for planner)'}.`,
    details: { missionId: id, projectId: project ? project.id : null, plan: Boolean(validated) },
  });
  return getMission(id);
}

function listMissions({ status, projectId, limit = 50 } = {}) {
  const capped = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const where = [], params = [];
  if (status) { where.push('status = ?'); params.push(String(status)); }
  if (projectId) { where.push('project_id = ?'); params.push(String(projectId)); }
  const rows = getDatabase().prepare(`SELECT * FROM missions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC LIMIT ?`).all(...params, capped);
  return rows.map((row) => toPublicMission(row));
}

function getMission(id) {
  refreshMission(id);
  const row = missionRow(id);
  if (!row) return null;
  const tasks = tasksOf(id);
  return {
    mission: toPublicMission(row, tasks),
    tasks,
    roles: roleList(),
    files: listFiles(id),
    plan: (() => { try { return row.plan ? JSON.parse(row.plan) : null; } catch { return null; } })(),
    planVersions: listPlanVersions(id).length,
    lessons: learningService.listLessons({ projectId: row.project_id || undefined, limit: 20 })
      .filter((lesson) => (toPublicMission(row, tasks).usedLessons || []).includes(lesson.id)),
  };
}

function checkWorkspacePath(mission, relPath) {
  const clean = String(relPath || '').replace(/\\/g, '/');
  if (!clean || clean.includes('\0') || clean.startsWith('/') || clean.split('/').includes('..')) {
    throw new Error('Invalid mission file path.');
  }
  // Resolve symlinks too: an agent can create a link inside its handoff
  // directory, and it must never become a read outside the mission workspace.
  const root = fs.realpathSync(mission.workspace);
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Invalid mission file path.');
  }
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(root + path.sep)) throw new Error('Invalid mission file path.');
  return real;
}

function listFiles(id) {
  const mission = missionRow(id);
  if (!mission) return [];
  const out = [];
  try {
    for (const name of ['goal.md', 'plan.json', 'decisions.md', 'handoff']) {
      const abs = path.join(mission.workspace, name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(abs).sort()) {
          const child = path.join(abs, entry);
          const childStat = fs.lstatSync(child);
          // Skip links: the UI only lists files this service created.
          if (!childStat.isFile() || childStat.isSymbolicLink()) continue;
          out.push({
            name: entry,
            path: `handoff/${entry}`,
            size: childStat.size,
            updatedAt: childStat.mtime.toISOString(),
          });
        }
      } else if (stat.isFile()) {
        out.push({
          name,
          path: name,
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
  } catch {
    // A missing workspace is not fatal: the mission still renders its tasks.
  }
  return out;
}

function readMissionFile(id, relPath) {
  const mission = missionRow(id);
  if (!mission) throw new Error('Mission not found.');
  const abs = checkWorkspacePath(mission, relPath);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('Not a file.');
  if (stat.size > MAX_PLAN_BYTES) throw new Error('File is too large to display.');
  return {
    path: String(relPath).replace(/\\/g, '/'),
    name: path.basename(abs),
    content: fs.readFileSync(abs, 'utf8'),
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function importPlan(id, rawPlan) {
  const mission = missionRow(id);
  if (!mission) throw new Error('Mission not found.');
  if (mission.status === 'done' || mission.status === 'cancelled') {
    throw new Error('This mission is already finished.');
  }
  if (mission.plan) throw new Error('This mission already has a plan.');
  const tasks = tasksOf(id).filter((t) => t.role !== 'planner');
  if (tasks.length > 0) throw new Error('This mission already has subtasks.');
  const plan = validatePlan(rawPlan);
  preflightAgents(plan);
  const project = mission.project_id ? projectService.getProject(mission.project_id) : null;
  enqueuePlan(mission, plan, project ? project.path : null);
  refreshMission(id);
  return getMission(id);
}

function prioritize(id, { order, taskId, priority } = {}) {
  const mission = missionRow(id);
  if (!mission) throw new Error('Mission not found.');
  const tasks = tasksOf(id);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const db = getDatabase();
  const now = nowIso();

  if (Array.isArray(order)) {
    if (order.length === 0) throw new Error('An order array is required.');
    const clean = order.map((value) => String(value));
    for (const taskIdValue of clean) {
      const task = byId.get(taskIdValue);
      if (!task) throw new Error('A task in the order does not belong to this mission.');
      if (!['queued', 'blocked'].includes(task.status)) {
        throw new Error('Only queued or blocked tasks can be reordered.');
      }
    }
    const update = db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ? AND status IN (\'queued\', \'blocked\')');
    const tx = db.transaction(() => {
      clean.forEach((taskIdValue, index) => {
        update.run((clean.length - index) * 10, now, taskIdValue);
      });
    });
    tx();
  } else if (taskId) {
    const task = byId.get(String(taskId));
    if (!task) throw new Error('Task not found in this mission.');
    if (!['queued', 'blocked'].includes(task.status)) {
      throw new Error('Only queued or blocked tasks can be reprioritised.');
    }
    const value = Number(priority);
    if (!Number.isFinite(value)) throw new Error('A numeric priority is required.');
    db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?').run(Math.trunc(value), now, task.id);
  } else {
    throw new Error('Provide an "order" array or a "taskId" with "priority".');
  }

  logService.record({
    category: 'mission', action: 'mission_prioritized',
    message: `Mission "${mission.title}" backlog reordered.`, details: { missionId: id },
  });
  return getMission(id);
}

function cancelMission(id) {
  const mission = missionRow(id);
  if (!mission) throw new Error('Mission not found.');
  if (mission.status === 'done' || mission.status === 'cancelled') {
    throw new Error('This mission is already finished.');
  }
  const tasks = tasksOf(id);
  const db = getDatabase();
  db.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
    .run('cancelling', nowIso(), id);

  const cancelled = [];
  for (const task of tasks) {
    if (FINAL_TASK_STATES.has(task.status)) continue;
    try {
      taskService.cancelTask(task.id);
      cancelled.push(task.id);
    } catch {
      // A task may have finished between the read and the call; refresh will
      // settle the mission either way.
    }
  }
  logService.record({
    level: 'warn', category: 'mission', action: 'mission_cancelled',
    message: `Mission "${mission.title}" cancellation requested (${cancelled.length} task(s)).`,
    details: { missionId: id, tasks: cancelled },
  });
  refreshMission(id);
  return getMission(id);
}

function addNote(id, text) {
  const mission = missionRow(id);
  if (!mission) throw new Error('Mission not found.');
  const rawNote = String(text || '').trim();
  if (!rawNote) throw new Error('A note cannot be empty.');
  if (rawNote.length > MAX_NOTE_CHARS) throw new Error('The note is too long.');
  const note = scrub(rawNote, MAX_NOTE_CHARS) || rawNote;
  const file = path.join(mission.workspace, 'decisions.md');
  const block = `\n## ${nowIso()}\n\n${note}\n`;
  fs.appendFileSync(file, block, { encoding: 'utf8', mode: 0o600 });
  getDatabase().prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  logService.record({
    category: 'mission', action: 'mission_note_added',
    message: `Note added to mission "${mission.title}".`, details: { missionId: id },
  });
  return getMission(id);
}


/**
 * Record explicit operator feedback against a task result and make it confirmed
 * project memory. It is intentionally not generalised: promotion to global is a
 * separate, explicit action.
 */
function addCorrection(id, taskId, text, { createdBy } = {}) {
  const mission = missionRow(id);
  if (!mission) throw new Error('Mission not found.');
  const task = tasksOf(id).find((t) => t.id === String(taskId));
  if (!task) throw new Error('Task not found in this mission.');
  const lesson = learningService.recordCorrection({
    task,
    projectId: mission.project_id,
    missionId: id,
    text,
    createdBy,
  });
  getDatabase().prepare('UPDATE tasks SET review_note = ?, updated_at = ? WHERE id = ?')
    .run(lesson.solution.slice(0, 4000), nowIso(), task.id);
  addNote(id, `User correction on "${task.title}":\n\n${lesson.solution}`);
  logService.record({
    category: 'mission', action: 'mission_correction_recorded',
    message: `User correction recorded for "${mission.title}".`,
    details: { missionId: id, taskId: task.id, lessonId: lesson.id },
  });
  return { mission: getMission(id), lesson };
}

/**
 * Replace the executable part of a plan while keeping every earlier version.
 * Only pending work is detached and cancelled; completed work and evidence are
 * never rewritten.
 */
function revisePlan(id, rawPlan, { reason, createdBy } = {}) {
  const mission = missionRow(id);
  if (!mission) throw new Error('Mission not found.');
  if (['done', 'cancelled', 'cancelling'].includes(mission.status)) {
    throw new Error('This mission cannot be revised any more.');
  }
  const plan = validatePlan(rawPlan);
  preflightAgents(plan);
  const project = mission.project_id ? projectService.getProject(mission.project_id) : null;
  const db = getDatabase();

  db.transaction(() => {
    for (const task of tasksOf(id)) {
      if (!['queued', 'blocked', 'quota'].includes(task.status)) continue;
      try { taskService.cancelTask(task.id); } catch { /* finished meanwhile */ }
      // Detach superseded pending work so it does not distort progress; the row
      // remains in the queue history.
      db.prepare('UPDATE tasks SET mission_id = NULL WHERE id = ?').run(task.id);
    }

    const refreshed = missionRow(id);
    refreshed.plan_revision_reason = reason ? scrub(reason, 500) : 'Plan revised';
    enqueuePlan(refreshed, plan, project ? project.path : null);
    logService.record({
      category: 'mission', action: 'mission_plan_revised',
      message: `Mission "${mission.title}" plan revised.`,
      details: { missionId: id, reason: refreshed.plan_revision_reason, createdBy: createdBy || null },
    });
  })();
  return getMission(id);
}

function listPlanVersions(id) {
  if (!missionRow(id)) throw new Error('Mission not found.');
  return getDatabase().prepare('SELECT version, reason, created_at, plan FROM mission_plan_versions WHERE mission_id = ? ORDER BY version DESC')
    .all(id)
    .map((row) => ({
      version: row.version,
      reason: row.reason || null,
      createdAt: row.created_at,
      tasks: (() => { try { return (JSON.parse(row.plan || '{}').tasks || []).length; } catch { return 0; } })(),
    }));
}


/**
 * Explicit acceptance decision on a finished task. A done task only stays done
 * if a reviewer accepted it; a rejected result becomes failed evidence so the
 * next attempt and the learning memory can use it.
 */
function reviewTask(id, taskId, { accepted, note, reviewedBy } = {}) {
  const mission = missionRow(id);
  if (!mission) throw new Error('Mission not found.');
  const task = tasksOf(id).find((t) => t.id === String(taskId));
  if (!task) throw new Error('Task not found in this mission.');
  if (!['review', 'done', 'failed'].includes(task.status)) {
    throw new Error('Only a finished task can be reviewed.');
  }
  const cleanNote = note ? scrub(String(note).trim(), 4000) : null;
  const reviewer = reviewedBy ? String(reviewedBy).slice(0, 200) : null;
  const now = nowIso();
  const db = getDatabase();
  if (accepted) {
    db.prepare(`
      UPDATE tasks SET status = 'done', reviewed_at = ?, reviewed_by = ?,
        review_note = COALESCE(?, review_note), blocked_reason = NULL,
        failure_kind = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, reviewer, cleanNote, now, task.id);
  } else {
    db.prepare(`
      UPDATE tasks SET status = 'failed', error = COALESCE(?, error), review_note = COALESCE(?, review_note),
        reviewed_at = ?, reviewed_by = ?, blocked_reason = 'rejected',
        finished_at = ?, learning_recorded = 0, updated_at = ?
      WHERE id = ?
    `).run(cleanNote || 'Rejected during acceptance review.', cleanNote, now, reviewer, now, now, task.id);
  }
  logService.record({
    level: accepted === false ? 'warn' : 'info',
    category: 'mission', action: accepted === false ? 'mission_task_rejected' : 'mission_task_accepted',
    message: `Task "${task.title}" ${accepted === false ? 'rejected' : 'accepted'} during review.`,
    details: { missionId: id, taskId: task.id, reviewedBy: reviewedBy || null },
  });
  refreshMission(id);
  return getMission(id);
}

module.exports = {
  ROLES,
  ROLE_IDS,
  MAX_TASKS,
  validatePlan,
  roleList,
  createMission,
  listMissions,
  getMission,
  importPlan,
  prioritize,
  cancelMission,
  addNote,
  addCorrection,
  reviewTask,
  revisePlan,
  listPlanVersions,
  listFiles,
  readMissionFile,
  refreshMission,
  onTaskChanged,
};
