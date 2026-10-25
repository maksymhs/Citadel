/**
 * Citadel Observability Service
 *
 * Two layers, both persisted in SQLite and exportable:
 *   - events:         a structured trace (task lifecycle, node health, system).
 *   - metric_samples: periodic resource usage for historical charts.
 *
 * A background sampler records local resources on an interval, detects nodes
 * going stale, and prunes old rows. It is started explicitly by the server
 * (never during tests) via startSampler().
 */
const os = require('node:os');
const { scrub, scrubDetails } = require('../security/redact');
const { getDatabase } = require('../database/db');
const nodeService = require('./nodeService');

const SAMPLE_INTERVAL_MS = parseInt(process.env.CITADEL_METRICS_INTERVAL_MS, 10) || 30000;
const RETENTION_DAYS = parseInt(process.env.CITADEL_LOG_RETENTION_DAYS, 10) || 30;
const STALE_MS = parseInt(process.env.CITADEL_NODE_STALE_MS, 10) || 90000;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

let timer = null;
const nodeState = new Map(); // node id -> 'online' | 'stale'

function safeParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function redact(details) {
  if (details === null || details === undefined) return null;
  return JSON.stringify(scrubDetails(details));
}

function toPublicEvent(row) {
  return {
    id: row.id,
    ts: row.ts,
    level: row.level,
    category: row.category,
    node: row.node,
    taskId: row.task_id,
    projectId: row.project_id || null,
    action: row.action,
    message: row.message,
    details: safeParse(row.details),
  };
}

function toPublicSample(row) {
  return {
    id: row.id,
    ts: row.ts,
    host: row.host,
    load1: row.load1,
    load5: row.load5,
    load15: row.load15,
    cpuCores: row.cpu_cores,
    memUsedPercent: row.mem_used_percent,
    memFreeMB: row.mem_free_mb,
    memTotalMB: row.mem_total_mb,
    activeTerminals: row.active_terminals,
    tasksRunning: row.tasks_running,
  };
}

/**
 * Append one event to the trace. Never throws (observability must not break
 * the action it records).
 */
function record({ level = 'info', category = 'system', node = null, taskId = null, projectId = null, action = null, message = null, details = null } = {}) {
  try {
    const lvl = LEVELS.has(level) ? level : 'info';
    const db = getDatabase();
    let scope = projectId || (details && typeof details === 'object' ? details.projectId : null);
    if (!scope && taskId) scope = db.prepare(`SELECT p.id AS project_id FROM tasks t
      JOIN projects p ON p.path = t.project_path WHERE t.id = ?`).get(taskId)?.project_id;
    db.prepare(`
      INSERT INTO events (ts, level, category, node, task_id, project_id, action, message, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      lvl,
      String(category),
      node ? String(node) : null,
      taskId ? String(taskId) : null,
      scope ? String(scope) : null,
      action ? String(action) : null,
      message ? scrub(message, 4000) : null,
      redact(details)
    );
  } catch (err) {
    console.error('[LogService] Could not record event:', err.message);
  }
}

function listEvents({ level, category, node, taskId, since, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (level) { where.push('level = ?'); params.push(level); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (node) { where.push('node = ?'); params.push(node); }
  if (taskId) { where.push('task_id = ?'); params.push(taskId); }
  if (since) { where.push('ts >= ?'); params.push(String(since)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const capped = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 2000);

  const rows = getDatabase()
    .prepare(`SELECT * FROM events ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, capped);
  return rows.map(toPublicEvent);
}

function insertSample(sample) {
  getDatabase().prepare(`
    INSERT INTO metric_samples
      (ts, host, load1, load5, load15, cpu_cores, mem_used_percent, mem_free_mb, mem_total_mb, active_terminals, tasks_running)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sample.ts || new Date().toISOString(),
    String(sample.host || os.hostname()),
    numberOrNull(sample.load1), numberOrNull(sample.load5), numberOrNull(sample.load15),
    numberOrNull(sample.cpuCores),
    numberOrNull(sample.memUsedPercent), numberOrNull(sample.memFreeMB), numberOrNull(sample.memTotalMB),
    numberOrNull(sample.activeTerminals), numberOrNull(sample.tasksRunning)
  );
}

function numberOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

function listMetrics({ host, since, limit = 288 } = {}) {
  const where = [];
  const params = [];
  if (host) { where.push('host = ?'); params.push(host); }
  if (since) { where.push('ts >= ?'); params.push(String(since)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const capped = Math.min(Math.max(parseInt(limit, 10) || 288, 1), 5000);

  const rows = getDatabase()
    .prepare(`SELECT * FROM metric_samples ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, capped);
  return rows.map(toPublicSample).reverse();
}

/**
 * Actionable summary: what changed, what failed, where to improve.
 */
function summary({ since } = {}) {
  const db = getDatabase();
  const from = since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const byLevel = db.prepare(`
    SELECT level, COUNT(*) AS count FROM events WHERE ts >= ? GROUP BY level
  `).all(from);

  const eventsByCategory = db.prepare(`
    SELECT category, COUNT(*) AS count FROM events WHERE ts >= ? GROUP BY category ORDER BY count DESC
  `).all(from);

  const taskStats = db.prepare(`
    SELECT status, COUNT(*) AS count FROM tasks WHERE updated_at >= ? GROUP BY status
  `).all(from);

  const tasksByNode = db.prepare(`
    SELECT node, COUNT(*) AS count,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM tasks WHERE updated_at >= ? AND node IS NOT NULL GROUP BY node ORDER BY count DESC
  `).all(from);

  const slowest = db.prepare(`
    SELECT id, node, cmd, (julianday(finished_at) - julianday(started_at)) * 86400.0 AS durationSeconds
    FROM tasks
    WHERE finished_at IS NOT NULL AND started_at IS NOT NULL AND updated_at >= ?
    ORDER BY durationSeconds DESC LIMIT 5
  `).all(from);

  const peak = db.prepare(`
    SELECT MAX(load1) AS peakLoad, MAX(mem_used_percent) AS peakMemPercent FROM metric_samples WHERE ts >= ?
  `).get(from);

  const nodes = db.prepare('SELECT * FROM nodes').all();
  const now = Date.now();
  const staleNodes = nodes
    .filter((n) => now - new Date(n.last_seen).getTime() > STALE_MS)
    .map((n) => n.id);

  return {
    since: from,
    eventsByLevel: Object.fromEntries(byLevel.map((r) => [r.level, r.count])),
    eventsByCategory,
    tasksByStatus: Object.fromEntries(taskStats.map((r) => [r.status, r.count])),
    tasksByNode,
    slowestTasks: slowest,
    peakLoad: peak ? peak.peakLoad : null,
    peakMemPercent: peak ? peak.peakMemPercent : null,
    nodesOnline: nodes.filter((n) => !staleNodes.includes(n.id)).length,
    nodesTotal: nodes.length,
    staleNodes,
  };
}

function prune() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = getDatabase();
  try {
    db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM metric_samples WHERE ts < ?').run(cutoff);
  } catch (err) {
    console.error('[LogService] Prune failed:', err.message);
  }
}

async function sampleOnce() {
  const metrics = await nodeService.getMetrics();
  const db = getDatabase();

  let activeTerminals = 0;
  let tasksRunning = 0;
  try {
    activeTerminals = db.prepare("SELECT COUNT(*) AS c FROM term_sessions WHERE status = 'active'").get().c;
    tasksRunning = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'running'").get().c;
  } catch {
    // Counts are best-effort.
  }

  insertSample({
    ts: new Date().toISOString(),
    host: os.hostname(),
    load1: metrics.loadAvg,
    load5: os.loadavg()[1],
    load15: os.loadavg()[2],
    cpuCores: os.cpus().length,
    memUsedPercent: metrics.memoryUsedPercent,
    memFreeMB: metrics.freeMemMB,
    memTotalMB: metrics.totalMemMB,
    activeTerminals,
    tasksRunning,
  });

  // Node health transitions (record once per change, not on every beat).
  const now = Date.now();
  for (const node of db.prepare('SELECT id, last_seen FROM nodes').all()) {
    const stale = now - new Date(node.last_seen).getTime() > STALE_MS;
    const state = stale ? 'stale' : 'online';
    if (nodeState.get(node.id) !== state) {
      nodeState.set(node.id, state);
      record({
        level: stale ? 'warn' : 'info',
        category: 'node',
        node: node.id,
        action: stale ? 'node_stale' : 'node_recovered',
        message: stale ? `Node ${node.id} stopped reporting.` : `Node ${node.id} is reporting again.`,
      });
    }
  }
}

function startSampler() {
  if (timer) return;
  const run = async () => {
    try {
      await sampleOnce();
    } catch (err) {
      record({ level: 'error', category: 'system', action: 'sample_failed', message: err.message });
    }
    prune();
  };
  run();
  timer = setInterval(run, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopSampler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Serialise rows to CSV. Only the fields the dashboard shows are exported.
 */
function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
}

module.exports = {
  SAMPLE_INTERVAL_MS,
  RETENTION_DAYS,
  STALE_MS,
  record,
  listEvents,
  insertSample,
  listMetrics,
  summary,
  prune,
  sampleOnce,
  startSampler,
  stopSampler,
  toCsv,
};
