/**
 * Citadel Module Registry
 *
 * A single, explicit and typed source of truth for the platform's core and
 * optional capabilities. It does not replace the plugin loader (which handles
 * third-party code): it describes the modules that ship with Citadel, whether
 * their requirements are present, whether they are enabled, and which views,
 * widgets, capabilities and server routes they own.
 *
 * State lives in the existing `app_config` key/value table
 * (`module.<id>.enabled`), so no new database is introduced. Disabling a module
 * only records a preference: it never deletes data, uninstalls packages or
 * stops host services.
 *
 * Four distinct facts are kept separate on purpose:
 *   1. available        — the module code exists in this build (always true here).
 *   2. serviceAvailable — its external requirement is installed/reachable.
 *   3. enabled          — the operator turned it on.
 *   4. (widget visible) — a dashboard preference, tracked by the client and
 *                          independent of `enabled`.
 */
const { getDatabase } = require('../database/db');

const SEED_MARKER = 'modules.seeded';

// Requirement probes. Kept lazy so importing the registry does not eagerly load
// optional services, and cached briefly so a burst of GET /api/modules does not
// hammer the Docker socket or the Caddy admin API.
const PROBE_TTL_MS = 15000;
const _probeCache = new Map();

async function probeService(name) {
  const cached = _probeCache.get(name);
  const now = Date.now();
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.value;

  let value = { available: true, reason: null };
  try {
    if (name === 'docker') {
      const dockerService = require('../services/dockerService');
      const status = await dockerService.getStatus();
      value = { available: Boolean(status.available), reason: status.available ? null : (status.message || 'Docker is not reachable.') };
    } else if (name === 'caddy') {
      const proxyProvider = require('../services/proxyProvider');
      const status = await proxyProvider.getStatus();
      value = { available: Boolean(status.available), reason: status.available ? null : (status.helpMessage || 'Caddy admin API is not reachable.') };
    } else if (name === 'tmux') {
      const terminalManager = require('../services/terminalManager');
      const available = terminalManager.isTmuxAvailable();
      value = { available, reason: available ? null : 'tmux is not installed.' };
    } else if (name === 'git') {
      value = { available: true, reason: null };
    } else {
      // Unknown requirement: fail open so a typo never bricks a module, but
      // surface it so it can be fixed.
      value = { available: true, reason: `Unknown requirement probe "${name}".` };
    }
  } catch (err) {
    value = { available: false, reason: err.message };
  }

  _probeCache.set(name, { at: now, value });
  return value;
}

/**
 * The module catalogue. `core` modules can never be disabled; optional modules
 * default to off on brand-new installations and are seeded on.
 * existing installs to preserve their current behaviour.
 */
const MODULES = [
  {
    id: 'dashboard',
    name: 'Dashboard',
    description: 'Configurable overview with add, remove and reorder widgets.',
    core: true,
    defaultEnabled: true,
    requires: { modules: [], services: [] },
    views: [{ id: 'dashboard', title: 'Dashboard' }],
    widgets: [
      { id: 'memory', title: 'Memory usage', description: 'Current memory utilisation.' },
      { id: 'cpu', title: 'CPU load', description: 'One-minute load average and core count.' },
      { id: 'projects', title: 'Active projects', description: 'Project count and persistent terminals.' },
      { id: 'host', title: 'VPS host', description: 'Hostname, platform and architecture.' },
      { id: 'fleet', title: 'Fleet remote hosts', description: 'Status of other Citadel hosts.', requiresModules: ['fleet'] },
      { id: 'integrations', title: 'Platform integrations', description: 'tmux, Git, Caddy and Docker availability.' },
      { id: 'quick-access', title: 'Quick project access', description: 'Open a terminal in a recent project.' },
      { id: 'activity', title: 'Recent activity', description: 'Latest operational events.', requiresModules: ['activity'] },
      { id: 'processes', title: 'Top processes', description: 'Live CPU and memory per process.' },
    ],
    capabilities: ['overview'],
  },
  {
    id: 'projects',
    name: 'Projects',
    description: 'Projects, their Git repositories and workspace access.',
    core: true,
    defaultEnabled: true,
    requires: { modules: [], services: [] },
    views: [{ id: 'projects', title: 'Projects' }],
    widgets: [],
    capabilities: ['projects:read', 'projects:write'],
  },
  {
    id: 'workspace',
    name: 'Workspace',
    description: 'Persistent terminals per project plus the System host context.',
    core: true,
    defaultEnabled: true,
    requires: { modules: [], services: [] },
    views: [{ id: 'workspace', title: 'Workspace' }],
    widgets: [],
    capabilities: ['terminal:session'],
  },
  {
    id: 'activity',
    name: 'Activity',
    description: 'Operational logs, agent and task executions, errors and recent activity.',
    core: true,
    defaultEnabled: true,
    requires: { modules: [], services: [] },
    views: [{ id: 'activity', title: 'Activity' }],
    widgets: [],
    capabilities: ['logs:read'],
  },
  {
    id: 'audit',
    name: 'Audit',
    description: 'Access, configuration changes, module activation and administrative events.',
    core: true,
    defaultEnabled: true,
    requires: { modules: [], services: [] },
    views: [],
    widgets: [],
    capabilities: ['audit:read'],
  },
  {
    id: 'files',
    name: 'Files',
    description: 'Browse and edit files on the host.',
    core: false,
    defaultEnabled: false,
    requires: { modules: [], services: [] },
    views: [{ id: 'files', title: 'Files' }],
    widgets: [],
    capabilities: ['files:read', 'files:write'],
  },
  {
    id: 'docker',
    name: 'Docker',
    description: 'Inspect the local Docker engine and its containers.',
    core: false,
    defaultEnabled: false,
    requires: { modules: [], services: ['docker'] },
    views: [{ id: 'docker', title: 'Docker' }],
    widgets: [],
    capabilities: ['docker:read'],
  },
  {
    id: 'proxy',
    name: 'Proxy & Domains',
    description: 'Publish project ports over HTTPS through Caddy.',
    core: false,
    defaultEnabled: false,
    requires: { modules: [], services: ['caddy'] },
    views: [{ id: 'proxy', title: 'Proxy & Domains' }],
    widgets: [],
    capabilities: ['proxy:publish'],
  },
  {
    id: 'fleet',
    name: 'Fleet',
    description: 'Manage and control remote Citadel instances.',
    core: false,
    defaultEnabled: false,
    requires: { modules: [], services: [] },
    views: [{ id: 'fleet', title: 'Fleet' }],
    widgets: [],
    capabilities: ['fleet:manage'],
  },
  {
    id: 'metrics',
    name: 'Advanced Metrics',
    description: 'Historical resource samples, charts and metric export.',
    core: false,
    defaultEnabled: false,
    requires: { modules: ['activity'], services: [] },
    views: [],
    widgets: [],
    capabilities: ['logs:metrics'],
  },
];

const MODULES_BY_ID = new Map(MODULES.map((m) => [m.id, m]));

function getModuleDefinition(id) {
  return MODULES_BY_ID.get(id) || null;
}

function flagKey(id) {
  return `module.${id}.enabled`;
}

function readStoredFlag(db, id) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(flagKey(id));
  return row ? row.value === '1' : null;
}

/**
 * Synchronous enablement check used by route guards. Falls back to the module's
 * declared default when no flag has been persisted (e.g. a module added after
 * the installation was seeded). Core modules are always enabled.
 */
function isEnabled(id) {
  const def = getModuleDefinition(id);
  if (!def) return false;
  if (def.core) return true;
  const db = getDatabase();
  const stored = readStoredFlag(db, id);
  return stored === null ? def.defaultEnabled : stored;
}

/**
 * Persist the default enablement exactly once. Existing installations (any user
 * already present) keep every capability enabled, which preserves their current
 * behaviour; brand-new installations get the documented minimal defaults.
 */
function seedDefaults(db) {
  const marker = db.prepare('SELECT value FROM app_config WHERE key = ?').get(SEED_MARKER);
  if (marker) return { seeded: false };

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const existingInstall = userCount > 0;
  const insert = db.prepare('INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();

  for (const mod of MODULES) {
    const value = existingInstall ? '1' : (mod.defaultEnabled ? '1' : '0');
    insert.run(flagKey(mod.id), value, now);
  }
  insert.run(SEED_MARKER, '1', now);

  return { seeded: true, existingInstall };
}

/**
 * Validate that a module's declared requirements are satisfied. Returns
 * `{ ok, problems: [] }`.
 */
async function validateRequirements(def) {
  const problems = [];
  for (const dep of def.requires.modules || []) {
    if (!isEnabled(dep)) problems.push(`Requires the "${dep}" module to be enabled first.`);
  }
  for (const service of def.requires.services || []) {
    const probe = await probeService(service);
    if (!probe.available) problems.push(probe.reason || `Requirement "${service}" is not available.`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Enable or disable a module. Core modules cannot be disabled, and enabling
 * validates module and service requirements first. This is a preference only:
 * no data is removed and no external service is touched.
 */
async function setEnabled(id, enabled) {
  const def = getModuleDefinition(id);
  if (!def) {
    const err = new Error(`Unknown module: ${id}`);
    err.statusCode = 404;
    throw err;
  }
  if (def.core && !enabled) {
    const err = new Error(`"${def.name}" is a core module and cannot be disabled.`);
    err.statusCode = 400;
    throw err;
  }
  if (enabled) {
    const { ok, problems } = await validateRequirements(def);
    if (!ok) {
      const err = new Error(`Cannot enable "${def.name}": ${problems.join(' ')}`);
      err.statusCode = 400;
      throw err;
    }
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(flagKey(id), enabled ? '1' : '0', now);

  return { id, enabled: Boolean(enabled) };
}

/**
 * Describe every module, including live availability and requirement status.
 */
async function listModules() {
  const db = getDatabase();
  const described = [];

  for (const def of MODULES) {
    const enabled = def.core ? true : (readStoredFlag(db, def.id) ?? def.defaultEnabled);
    const serviceChecks = await Promise.all(
      (def.requires.services || []).map(async (service) => ({ service, ...(await probeService(service)) }))
    );
    const missingModules = (def.requires.modules || []).filter((dep) => !isEnabled(dep));
    const missingServices = serviceChecks.filter((s) => !s.available);
    const serviceAvailable = missingServices.length === 0;

    let reason = null;
    if (!serviceAvailable) reason = missingServices.map((s) => s.reason || `${s.service} unavailable`).join(' ');
    else if (missingModules.length > 0) reason = `Requires module(s): ${missingModules.join(', ')}.`;

    described.push({
      id: def.id,
      name: def.name,
      description: def.description,
      core: def.core,
      defaultEnabled: def.defaultEnabled,
      enabled,
      available: true,
      serviceAvailable,
      ready: serviceAvailable && missingModules.length === 0,
      requires: {
        modules: def.requires.modules || [],
        services: def.requires.services || [],
        missingModules,
        missingServices: missingServices.map((s) => s.service),
      },
      views: def.views,
      widgets: def.widgets,
      capabilities: def.capabilities || [],
      reason,
    });
  }

  return described;
}

/**
 * Fastify preHandler that rejects requests to a disabled module's endpoints.
 * It must be registered *after* `requireAuth` so an unauthenticated request
 * still receives 401 rather than leaking module state.
 */
function requireModule(id) {
  return async function moduleGuard(request, reply) {
    const def = getModuleDefinition(id);
    if (!def || def.core || isEnabled(id)) return;
    return reply.status(403).send({
      error: 'Module disabled',
      module: id,
      message: `The "${def ? def.name : id}" module is disabled. Enable it from Modules to use this feature.`,
    });
  };
}

function resetProbeCache() {
  _probeCache.clear();
}

module.exports = {
  MODULES,
  getModuleDefinition,
  isEnabled,
  seedDefaults,
  validateRequirements,
  setEnabled,
  listModules,
  requireModule,
  resetProbeCache,
  SEED_MARKER,
};
