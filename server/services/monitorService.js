/**
 * Citadel Fleet Monitor
 *
 * Probes this machine and every paired machine on an interval, keeps a short
 * history (for uptime % and sparklines) and raises alerts when a machine goes
 * offline or runs low on disk, memory or CPU. Alerts are shown in the panel and
 * can also be pushed to a webhook, ntfy or Telegram.
 *
 * Monitoring is per panel: each Citadel watches the machines it is paired with.
 * A machine can therefore never alert about its own outage; configure channels
 * on a second machine for that.
 */
const { getDatabase } = require('../database/db');
const { encrypt, decrypt } = require('../security/secrets');
const hostService = require('./hostService');
const nodeService = require('./nodeService');
const updateService = require('./updateService');
const logService = require('./logService');

const INTERVAL_MS = parseInt(process.env.CITADEL_MONITOR_INTERVAL_MS, 10) || 60000;
const PROBE_TIMEOUT_MS = 8000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CONFIG_KEY = 'monitor.config';
const LOCAL_ID = 'local';
const OFFLINE_AFTER_FAILURES = 2;
const BREACH_BEFORE_ALERT = 2;
const HISTORY_POINTS = 96;
const NOTIFY_TIMEOUT_MS = 8000;

const DEFAULT_CONFIG = {
  enabled: true,
  securityAlerts: true,
  thresholds: { diskPercent: 90, memPercent: 95, loadPerCore: 2 },
  channels: {},
};

const KINDS = {
  offline: { severity: 'critical', label: 'Offline' },
  disk: { severity: 'warning', label: 'Disk almost full' },
  memory: { severity: 'warning', label: 'Memory almost full' },
  load: { severity: 'warning', label: 'High CPU load' },
};

// hostId -> live state (not persisted: rebuilt from the first probes after boot).
const states = new Map();
// "hostId:kind" -> active alert
const alerts = new Map();

let timer = null;
let running = false;
let lastRunAt = 0;
let lastPrune = 0;

// --- Configuration ----------------------------------------------------------

function readRawConfig() {
  try {
    const row = getDatabase().prepare('SELECT value FROM app_config WHERE key = ?').get(CONFIG_KEY);
    return row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

function writeRawConfig(config) {
  getDatabase().prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(CONFIG_KEY, JSON.stringify(config), new Date().toISOString());
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getConfig() {
  const raw = readRawConfig();
  const t = raw.thresholds || {};
  return {
    enabled: raw.enabled !== false,
    securityAlerts: raw.securityAlerts !== false,
    thresholds: {
      diskPercent: clampNumber(t.diskPercent, 50, 99, DEFAULT_CONFIG.thresholds.diskPercent),
      memPercent: clampNumber(t.memPercent, 50, 99, DEFAULT_CONFIG.thresholds.memPercent),
      loadPerCore: clampNumber(t.loadPerCore, 0.5, 20, DEFAULT_CONFIG.thresholds.loadPerCore),
    },
    channels: raw.channels || {},
  };
}

function normalizeHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error(`${label}: the URL is not valid.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label}: only http and https URLs are supported.`);
  }
  return parsed.toString();
}

function decryptField(value) {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

/**
 * Configuration as shown in the UI. Channel secrets (webhook URLs routinely
 * embed a token, Telegram has a bot token) are never returned, only whether
 * they are set and a harmless label.
 */
function getPublicConfig() {
  const cfg = getConfig();
  const ch = cfg.channels;
  const webhook = decryptField(ch.webhook);
  const ntfy = decryptField(ch.ntfy);
  const tgToken = decryptField(ch.telegramToken);
  const originOf = (url) => {
    try { return new URL(url).origin; } catch { return null; }
  };
  return {
    enabled: cfg.enabled,
    securityAlerts: cfg.securityAlerts,
    intervalSec: Math.round(INTERVAL_MS / 1000),
    thresholds: cfg.thresholds,
    channels: {
      webhook: { set: Boolean(webhook), label: webhook ? originOf(webhook) : null },
      ntfy: { set: Boolean(ntfy), label: ntfy ? originOf(ntfy) : null },
      telegram: { set: Boolean(tgToken && ch.telegramChatId), chatId: ch.telegramChatId || null },
    },
  };
}

/**
 * Apply a partial update. For a secret field `undefined` keeps the stored
 * value and an empty string clears it.
 */
function updateConfig(patch = {}) {
  const current = getConfig();
  const next = { enabled: current.enabled, securityAlerts: current.securityAlerts, thresholds: { ...current.thresholds }, channels: { ...current.channels } };

  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.securityAlerts !== undefined) next.securityAlerts = Boolean(patch.securityAlerts);
  if (patch.thresholds && typeof patch.thresholds === 'object') {
    const t = patch.thresholds;
    if (t.diskPercent !== undefined) next.thresholds.diskPercent = clampNumber(t.diskPercent, 50, 99, current.thresholds.diskPercent);
    if (t.memPercent !== undefined) next.thresholds.memPercent = clampNumber(t.memPercent, 50, 99, current.thresholds.memPercent);
    if (t.loadPerCore !== undefined) next.thresholds.loadPerCore = clampNumber(t.loadPerCore, 0.5, 20, current.thresholds.loadPerCore);
  }

  const c = patch.channels || {};
  const setUrl = (field, value, label) => {
    if (value === undefined) return;
    if (value === '' || value === null) delete next.channels[field];
    else next.channels[field] = encrypt(normalizeHttpUrl(value, label));
  };
  setUrl('webhook', c.webhook, 'Webhook');
  setUrl('ntfy', c.ntfy, 'ntfy');
  if (c.telegramToken !== undefined) {
    if (c.telegramToken === '' || c.telegramToken === null) delete next.channels.telegramToken;
    else next.channels.telegramToken = encrypt(String(c.telegramToken).trim());
  }
  if (c.telegramChatId !== undefined) {
    const chat = String(c.telegramChatId || '').trim();
    if (!chat) delete next.channels.telegramChatId;
    else if (!/^-?\d+$|^@[A-Za-z0-9_]{4,}$/.test(chat)) throw new Error('Telegram: the chat id must be a number or @channel.');
    else next.channels.telegramChatId = chat;
  }

  writeRawConfig(next);
  return getPublicConfig();
}

// --- Notifications ----------------------------------------------------------

async function postWithTimeout(url, options) {
  const controller = new AbortController();
  const timer2 = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer2);
  }
}

/**
 * Push one message to every configured channel. Best effort and never throws:
 * a broken channel must not stop the others (or the monitor).
 */
async function notify({ title, message, severity = 'info', hostId = null, kind = null, state = null }) {
  const ch = getConfig().channels;
  const jobs = [];

  const webhook = decryptField(ch.webhook);
  if (webhook) {
    jobs.push(['webhook', postWithTimeout(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text`/`content` make the payload work as-is with Slack and Discord.
      body: JSON.stringify({
        title, message, severity, hostId, kind, state,
        text: `${title}\n${message}`, content: `${title}\n${message}`,
        timestamp: new Date().toISOString(),
      }),
    })]);
  }

  const ntfy = decryptField(ch.ntfy);
  if (ntfy) {
    const priority = severity === 'critical' ? '5' : severity === 'warning' ? '4' : '3';
    const tag = state === 'resolved' ? 'white_check_mark' : severity === 'critical' ? 'rotating_light' : 'warning';
    jobs.push(['ntfy', postWithTimeout(ntfy, {
      method: 'POST',
      // Header values must be latin-1 safe; the title may hold a host name.
      headers: { Title: Buffer.from(title, 'utf8').toString('latin1').replace(/[^\x20-\x7e]/g, '?'), Priority: priority, Tags: tag },
      body: message,
    })]);
  }

  const tgToken = decryptField(ch.telegramToken);
  if (tgToken && ch.telegramChatId) {
    jobs.push(['telegram', postWithTimeout(`https://api.telegram.org/bot${encodeURIComponent(tgToken)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ch.telegramChatId, text: `${title}\n${message}` }),
    })]);
  }

  const settled = await Promise.allSettled(jobs.map(([, job]) => job));
  return settled.map((r, i) => ({
    channel: jobs[i][0],
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? r.reason.message : null,
  }));
}

async function sendTest() {
  const results = await notify({
    title: 'Citadel test alert',
    message: 'If you can read this, alerts from this Citadel reach you.',
    severity: 'info',
    state: 'test',
  });
  return { results, configured: results.length };
}

// --- Probing ----------------------------------------------------------------

function localLabel() {
  return hostService.getInstanceName() || 'This machine';
}

async function probeLocal() {
  const health = await nodeService.getHealth();
  const info = updateService.getVersionInfo();
  return { id: LOCAL_ID, name: localLabel(), address: null, online: true, latencyMs: 0, health, version: info.version, commit: info.commit };
}

async function probeRemote(host) {
  const started = Date.now();
  const base = { id: host.id, name: host.name, address: host.baseUrl };
  try {
    const res = await hostService.requestHost(host.id, '/api/system/health', { timeout: PROBE_TIMEOUT_MS, maxCandidates: 3 });
    const latencyMs = Date.now() - started;
    if (res.status === 404) {
      // An older Citadel without the health endpoint: reachability still counts.
      const ver = await hostService.requestHost(host.id, '/api/system/version', { timeout: PROBE_TIMEOUT_MS, maxCandidates: 3 });
      if (!ver.ok) throw new Error((ver.data && ver.data.error) || `HTTP ${ver.status}`);
      const v = (ver.data && ver.data.version) || {};
      return { ...base, online: true, limited: true, latencyMs, health: null, version: v.version || null, commit: v.commit || null };
    }
    if (!res.ok) throw new Error((res.data && res.data.error) || `HTTP ${res.status}`);
    const data = res.data || {};
    return { ...base, online: true, latencyMs, health: data.health || null, version: data.version || null, commit: data.commit || null };
  } catch (err) {
    return { ...base, online: false, latencyMs: null, health: null, error: err.message };
  }
}

function recordCheck(result) {
  const h = result.health || {};
  try {
    getDatabase().prepare(`
      INSERT INTO host_checks (host_id, ts, online, latency_ms, load_per_core, mem_percent, disk_percent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id, Date.now(), result.online ? 1 : 0, result.latencyMs,
      Number.isFinite(h.loadPerCore) ? h.loadPerCore : null,
      h.memory && Number.isFinite(h.memory.usedPercent) ? h.memory.usedPercent : null,
      h.disk && Number.isFinite(h.disk.usedPercent) ? h.disk.usedPercent : null
    );
  } catch (err) {
    console.error('[Monitor] Could not store check:', err.message);
  }
}

function pruneChecks() {
  try {
    getDatabase().prepare('DELETE FROM host_checks WHERE ts < ?').run(Date.now() - RETENTION_MS);
  } catch {
    // Pruning is best effort.
  }
}

// --- Alert engine -----------------------------------------------------------

function breaches(result, thresholds) {
  const h = result.health;
  const out = {};
  if (!h) return out;
  const disk = h.disk && h.disk.usedPercent;
  const mem = h.memory && h.memory.usedPercent;
  out.disk = Number.isFinite(disk) ? { value: disk, over: disk >= thresholds.diskPercent, clear: disk < thresholds.diskPercent - 3 } : null;
  out.memory = Number.isFinite(mem) ? { value: mem, over: mem >= thresholds.memPercent, clear: mem < thresholds.memPercent - 3 } : null;
  out.load = Number.isFinite(h.loadPerCore)
    ? { value: h.loadPerCore, over: h.loadPerCore >= thresholds.loadPerCore, clear: h.loadPerCore < thresholds.loadPerCore * 0.8 }
    : null;
  return out;
}

function describe(kind, st, extra) {
  const name = st.name;
  switch (kind) {
    case 'offline': return `${name} is not responding${extra ? ` (${extra})` : ''}.`;
    case 'disk': return `${name}: disk is ${extra}% full.`;
    case 'memory': return `${name}: memory is ${extra}% used.`;
    case 'load': return `${name}: CPU load is ${extra} per core.`;
    default: return name;
  }
}

async function raise(st, kind, extra) {
  const key = `${st.id}:${kind}`;
  if (alerts.has(key)) {
    alerts.get(key).message = describe(kind, st, extra);
    return;
  }
  const def = KINDS[kind];
  const alert = {
    id: key, hostId: st.id, hostName: st.name, kind,
    severity: def.severity, label: def.label,
    message: describe(kind, st, extra), since: Date.now(),
  };
  alerts.set(key, alert);
  logService.record({
    level: def.severity === 'critical' ? 'error' : 'warn', category: 'monitor', node: st.id,
    action: `alert_${kind}`, message: alert.message,
  });
  await notify({ title: `Citadel: ${def.label} — ${st.name}`, message: alert.message, severity: def.severity, hostId: st.id, kind, state: 'firing' });
}

async function resolve(st, kind) {
  const key = `${st.id}:${kind}`;
  const alert = alerts.get(key);
  if (!alert) return;
  alerts.delete(key);
  const message = `${st.name}: ${KINDS[kind].label.toLowerCase()} — back to normal.`;
  logService.record({ level: 'info', category: 'monitor', node: st.id, action: `resolved_${kind}`, message });
  await notify({ title: `Citadel: recovered — ${st.name}`, message, severity: 'info', hostId: st.id, kind, state: 'resolved' });
}

async function evaluate(result, config) {
  let st = states.get(result.id);
  const now = Date.now();
  if (!st) {
    st = { id: result.id, failures: 0, online: null, since: now, breach: {} };
    states.set(result.id, st);
  }
  st.name = result.name;
  st.address = result.address;

  if (result.online) {
    st.failures = 0;
    if (st.online !== true) st.since = now;
    st.online = true;
    st.lastSeen = now;
    st.latencyMs = result.latencyMs;
    st.health = result.health;
    st.limited = Boolean(result.limited);
    st.version = result.version;
    st.commit = result.commit;
    st.error = null;
    if (config.enabled) await resolve(st, 'offline');
  } else {
    st.failures += 1;
    st.error = result.error || 'Unreachable';
    if (st.failures >= OFFLINE_AFTER_FAILURES) {
      if (st.online !== false) st.since = now;
      st.online = false;
      st.latencyMs = null;
      if (config.enabled) await raise(st, 'offline', st.error);
    }
    return st;
  }
  if (!config.enabled) return st;

  const b = breaches(result, config.thresholds);
  for (const kind of ['disk', 'memory', 'load']) {
    const m = b[kind];
    if (!m) continue;
    if (m.over) {
      st.breach[kind] = (st.breach[kind] || 0) + 1;
      if (st.breach[kind] >= BREACH_BEFORE_ALERT) await raise(st, kind, kind === 'load' ? m.value : Math.round(m.value));
    } else if (m.clear) {
      st.breach[kind] = 0;
      await resolve(st, kind);
    }
  }
  return st;
}

/**
 * Probe every machine once. Overlapping runs are skipped so a slow peer can
 * never pile up requests.
 */
async function pollOnce() {
  if (running) return false;
  running = true;
  try {
    const config = getConfig();
    const remotes = hostService.listHosts();
    const results = await Promise.all([
      probeLocal().catch((err) => ({ id: LOCAL_ID, name: localLabel(), online: false, error: err.message })),
      ...remotes.map(probeRemote),
    ]);

    // Machines that were unpaired no longer count or alert.
    const known = new Set(results.map((r) => r.id));
    for (const id of Array.from(states.keys())) {
      if (known.has(id)) continue;
      states.delete(id);
      for (const key of Array.from(alerts.keys())) if (key.startsWith(`${id}:`)) alerts.delete(key);
    }

    for (const result of results) {
      recordCheck(result);
      try {
        await evaluate(result, config);
      } catch (err) {
        console.error('[Monitor] Evaluation failed:', err.message);
      }
    }
    lastRunAt = Date.now();
    if (lastRunAt - lastPrune > 60 * 60 * 1000) {
      lastPrune = lastRunAt;
      pruneChecks();
    }
    return true;
  } finally {
    running = false;
  }
}

// --- Reading ----------------------------------------------------------------

function uptimePercent(hostId, windowMs) {
  const row = getDatabase().prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(online), 0) AS up FROM host_checks WHERE host_id = ? AND ts >= ?'
  ).get(hostId, Date.now() - windowMs);
  if (!row || !row.total) return null;
  return Math.round((row.up / row.total) * 1000) / 10;
}

function publicHost(st) {
  const h = st.health || null;
  return {
    id: st.id,
    name: st.name,
    address: st.address || null,
    isLocal: st.id === LOCAL_ID,
    online: st.online,
    since: st.since,
    lastSeen: st.lastSeen || null,
    latencyMs: st.latencyMs ?? null,
    version: st.version || null,
    limited: Boolean(st.limited),
    error: st.online === false ? st.error : null,
    health: h,
    uptime24h: uptimePercent(st.id, 24 * 60 * 60 * 1000),
    uptime7d: uptimePercent(st.id, 7 * 24 * 60 * 60 * 1000),
    alerts: Array.from(alerts.values()).filter((a) => a.hostId === st.id).map((a) => a.kind),
  };
}

function getOverview() {
  // A rename shows up immediately instead of at the next probe.
  const names = new Map(hostService.listHosts().map((h) => [h.id, h.name]));
  names.set(LOCAL_ID, localLabel());
  const hosts = Array.from(states.values())
    .sort((a, b) => (a.id === LOCAL_ID ? -1 : b.id === LOCAL_ID ? 1 : String(a.name).localeCompare(String(b.name))))
    .map((st) => ({ ...publicHost(st), name: names.get(st.id) || st.name }));
  return {
    checkedAt: lastRunAt || null,
    intervalSec: Math.round(INTERVAL_MS / 1000),
    enabled: getConfig().enabled,
    hosts,
    alerts: Array.from(alerts.values()).sort((a, b) => b.since - a.since),
  };
}

/**
 * Bucketed history for one machine plus its uptime and recent incidents.
 */
function getHistory(hostId, hours = 24) {
  const span = clampNumber(hours, 1, 24 * 30, 24) * 60 * 60 * 1000;
  const from = Date.now() - span;
  const rows = getDatabase().prepare(
    'SELECT ts, online, latency_ms, load_per_core, mem_percent, disk_percent FROM host_checks WHERE host_id = ? AND ts >= ? ORDER BY ts'
  ).all(hostId, from);

  const bucketMs = Math.max(span / HISTORY_POINTS, INTERVAL_MS);
  const buckets = new Map();
  for (const r of rows) {
    const key = Math.floor((r.ts - from) / bucketMs);
    let b = buckets.get(key);
    if (!b) {
      b = { ts: from + key * bucketMs, n: 0, up: 0, lat: [], load: [], mem: [], disk: [] };
      buckets.set(key, b);
    }
    b.n += 1;
    b.up += r.online;
    if (r.latency_ms !== null) b.lat.push(r.latency_ms);
    if (r.load_per_core !== null) b.load.push(r.load_per_core);
    if (r.mem_percent !== null) b.mem.push(r.mem_percent);
    if (r.disk_percent !== null) b.disk.push(r.disk_percent);
  }
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100 : null);
  const points = Array.from(buckets.values()).map((b) => ({
    ts: b.ts,
    online: b.up === b.n ? 1 : b.up === 0 ? 0 : b.up / b.n,
    latencyMs: avg(b.lat),
    loadPerCore: avg(b.load),
    memPercent: avg(b.mem),
    diskPercent: avg(b.disk),
  }));

  const events = logService.listEvents({ category: 'monitor', node: hostId, limit: 30 });
  return {
    hostId,
    hours: span / 3600000,
    points,
    uptime: uptimePercent(hostId, span),
    events,
  };
}

function start() {
  if (timer) return;
  const tick = () => pollOnce().catch((err) => console.error('[Monitor] Poll failed:', err.message));
  const first = setTimeout(tick, 4000);
  if (typeof first.unref === 'function') first.unref();
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function _reset() {
  states.clear();
  alerts.clear();
  lastRunAt = 0;
  running = false;
}

module.exports = {
  LOCAL_ID,
  OFFLINE_AFTER_FAILURES,
  BREACH_BEFORE_ALERT,
  getConfig,
  getPublicConfig,
  updateConfig,
  notify,
  sendTest,
  pollOnce,
  getOverview,
  getHistory,
  start,
  stop,
  _reset,
};
