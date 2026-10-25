/**
 * Project hub snapshots and cursor-based, project-scoped traces over the existing
 * queue and event journal. No scheduler, transcript collector or extra database.
 */
const { getDatabase } = require('../database/db');
const { scrub, scrubDetails } = require('../security/redact');
const projects = require('./projectService');
const missions = require('./missionService');
const tasks = require('./taskService');

function projectFor(id) {
  const project = projects.getProject(String(id));
  if (!project) {
    const err = new Error('Project not found.');
    err.statusCode = 404;
    throw err;
  }
  return project;
}

function snapshot(id) {
  const project = projectFor(id);
  const recent = missions.listMissions({ projectId: project.id, limit: 50 });
  for (const mission of recent) missions.refreshMission(mission.id);
  const work = tasks.listTasks({ projectId: project.id, limit: 500 });
  const counts = {};
  for (const task of work) counts[task.status] = (counts[task.status] || 0) + 1;
  const sessions = getDatabase().prepare("SELECT id, name, status, agent_id FROM term_sessions WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20").all(project.id);
  return {
    project: { id: project.id, name: project.name, path: project.path },
    missions: missions.listMissions({ projectId: project.id, limit: 50 }),
    tasks: work.map((task) => ({
      id: task.id, title: scrub(task.title || task.role || task.id, 200), status: task.status,
      role: task.role, agent: task.agent, node: task.node, priority: task.priority,
      missionId: task.missionId, attempt: task.attempt, maxAttempts: task.maxAttempts,
      blockedReason: task.blockedReason, retryAt: task.retryAt,
    })),
    workers: getDatabase().prepare('SELECT COUNT(*) n FROM nodes WHERE last_seen >= ?').get(new Date(Date.now() - 120000).toISOString()).n,
    counts, sessions, budget: tasks.autonomousBudgetStatus(),
    truncated: work.length === 500 || recent.length === 50,
    updatedAt: new Date().toISOString(),
  };
}

function trace(id, { after, limit = 100 } = {}) {
  const project = projectFor(id);
  const cursor = after === undefined ? null : Number(after);
  if (cursor !== null && (!/^\d+$/.test(String(after)) || !Number.isSafeInteger(cursor))) {
    throw new Error('Invalid trace cursor.');
  }
  const capped = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const db = getDatabase();
  let rows = cursor === null
    ? db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(project.id, capped + 1)
    : db.prepare('SELECT * FROM events WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(project.id, cursor, capped + 1);
  const hasMore = cursor !== null && rows.length > capped;
  rows = rows.slice(0, capped);
  if (cursor === null) rows.reverse();
  return {
    events: rows.map((row) => {
      let details;
      try { details = JSON.parse(row.details); } catch { details = row.details; }
      return {
        id: row.id, ts: row.ts, level: row.level, category: row.category,
        action: scrub(row.action, 200), taskId: row.task_id, node: scrub(row.node, 200) || null,
        message: scrub(row.message, 4000), details: scrubDetails(details),
      };
    }),
    cursor: rows.length ? rows[rows.length - 1].id : (cursor || 0),
    hasMore,
  };
}

module.exports = { projectFor, snapshot, trace };
