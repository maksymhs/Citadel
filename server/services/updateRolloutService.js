/**
 * Staged update propagation across paired machines (opt-in).
 *
 * After this machine has been updated and restarted healthy, it updates the
 * machines paired with it one at a time: ask the next peer to update, wait for
 * it to come back reporting the new version, then continue. The rollout stops at
 * the first peer that does not come back, so a bad release never reaches the
 * whole fleet. A peer updated this way does not propagate further.
 */
const hostService = require('./hostService');
const updateService = require('./updateService');
const logService = require('./logService');
const { APP_VERSION } = require('../config');

const PROPAGATE_KEY = 'update.propagate';
const LAST_VERSION_KEY = 'update.last_version';
const SKIP_KEY = 'update.skip_propagation';
const ROLLOUT_KEY = 'update.rollout';
const POLL_MS = 10000;
const COME_BACK_TIMEOUT_MS = 6 * 60 * 1000;

let running = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPropagationEnabled() {
  return hostService.readConfig(PROPAGATE_KEY) === '1';
}

function setPropagationEnabled(enabled) {
  hostService.writeConfig(PROPAGATE_KEY, enabled ? '1' : '0');
  return isPropagationEnabled();
}

function getLastRollout() {
  try {
    return JSON.parse(hostService.readConfig(ROLLOUT_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveRollout(rollout) {
  hostService.writeConfig(ROLLOUT_KEY, JSON.stringify(rollout));
}

/** Mark that this machine was updated because a peer asked it to. */
function markPropagatedUpdate() {
  hostService.writeConfig(SKIP_KEY, '1');
}

function clearPropagatedUpdate() {
  hostService.writeConfig(SKIP_KEY, '0');
}

async function peerVersion(hostId) {
  const res = await hostService.requestHost(hostId, '/api/system/version', { timeout: 8000, maxCandidates: 3 });
  if (!res.ok || !res.data || !res.data.version) throw new Error(`HTTP ${res.status}`);
  return res.data.version;
}

async function waitForVersion(hostId, target, { timeoutMs = COME_BACK_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const info = await peerVersion(hostId);
      if (updateService.compareVersions(info.version, target) >= 0) return info.version;
    } catch {
      // The peer is restarting; keep polling until the deadline.
    }
  }
  return null;
}

/**
 * Update every paired machine that is behind `target`, one at a time.
 * Returns the stored summary.
 */
async function rollout({ target = APP_VERSION, pollMs = POLL_MS, timeoutMs = COME_BACK_TIMEOUT_MS } = {}) {
  if (running) return { skipped: 'a rollout is already running' };
  running = true;
  const summary = {
    target,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    halted: null,
    hosts: [],
  };
  saveRollout(summary);
  try {
    const rows = hostService.listHostRows().filter((row) => row.instance_id);
    for (const row of rows) {
      const entry = { name: row.name, status: 'pending', from: null, to: null, error: null };
      summary.hosts.push(entry);
      saveRollout(summary);
      try {
        const info = await peerVersion(row.id);
        entry.from = info.version;
        if (updateService.compareVersions(info.version, target) >= 0) {
          entry.status = 'up-to-date';
          entry.to = info.version;
          continue;
        }
        if (info.canUpdate === false) {
          entry.status = 'skipped';
          entry.error = info.updateProblem || 'the updater is not available on that machine';
          continue;
        }
        entry.status = 'updating';
        saveRollout(summary);
        const res = await hostService.requestHost(row.id, '/api/system/update', {
          method: 'POST', body: { propagated: true }, timeout: 20000, maxCandidates: 3,
        });
        if (!res.ok) throw new Error((res.data && res.data.error) || `update HTTP ${res.status}`);
        const reached = await waitForVersion(row.id, target, { pollMs, timeoutMs });
        if (!reached) {
          entry.status = 'failed';
          entry.error = 'did not come back with the new version in time';
          summary.halted = `${row.name} did not come back; remaining machines were left untouched`;
          break;
        }
        entry.status = 'updated';
        entry.to = reached;
      } catch (err) {
        entry.status = 'failed';
        entry.error = err.message;
        summary.halted = `${row.name}: ${err.message}`;
        break;
      } finally {
        saveRollout(summary);
      }
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    saveRollout(summary);
    running = false;
    logService.record({
      category: 'system',
      action: 'update_rollout',
      message: summary.halted
        ? `Update rollout to v${target} halted: ${summary.halted}`
        : `Update rollout to v${target} finished (${summary.hosts.filter((h) => h.status === 'updated').length} updated).`,
    });
  }
  return summary;
}

/**
 * Called after startup: when this machine just moved to a newer version and
 * propagation is on, roll the update out to its peers.
 */
async function maybePropagateAfterUpdate() {
  // A rollout record without an end time belongs to a process that restarted
  // mid-run; close it so the panel does not show it as running forever.
  const stale = getLastRollout();
  if (stale && !stale.finishedAt && !running) {
    stale.finishedAt = new Date().toISOString();
    stale.halted = stale.halted || 'interrupted by a restart';
    saveRollout(stale);
  }

  const last = hostService.readConfig(LAST_VERSION_KEY);
  hostService.writeConfig(LAST_VERSION_KEY, APP_VERSION);
  if (!last || updateService.compareVersions(APP_VERSION, last) <= 0) return null;

  const skip = hostService.readConfig(SKIP_KEY) === '1';
  hostService.writeConfig(SKIP_KEY, '0');
  if (skip || !isPropagationEnabled()) return null;
  return rollout({ target: APP_VERSION });
}

module.exports = {
  isPropagationEnabled,
  setPropagationEnabled,
  getLastRollout,
  markPropagatedUpdate,
  clearPropagatedUpdate,
  rollout,
  maybePropagateAfterUpdate,
};
