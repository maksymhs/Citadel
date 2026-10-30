/**
 * Staged update propagation across paired machines.
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

const LAST_VERSION_KEY = 'update.last_version';
const SKIP_KEY = 'update.skip_propagation';
const ROLLOUT_KEY = 'update.rollout';
const PENDING_KEY = 'update.fleet_pending';
const FORCE_POLL_MS = 3000;
const POLL_MS = 10000;
const COME_BACK_TIMEOUT_MS = 6 * 60 * 1000;

let running = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function peerUpdateStatus(hostId) {
  try {
    const res = await hostService.requestHost(hostId, '/api/system/update/status', { timeout: 8000, maxCandidates: 3 });
    const update = res.ok && res.data && res.data.update;
    return (update && update.status) || null;
  } catch {
    return null;
  }
}

/**
 * Wait for a peer that was asked to update unconditionally (same commit or
 * version is possible, e.g. on the main channel), so the version cannot be the
 * signal. The built-in updater reports a status file; the root helper does
 * not, so a version/commit change or a down-then-up restart also counts.
 * Returns the version the peer reports once done, null on timeout, and throws
 * when the peer reports that its update failed.
 */
async function waitForUpdate(hostId, before, { timeoutMs = COME_BACK_TIMEOUT_MS, pollMs = FORCE_POLL_MS, target } = {}) {
  const deadline = Date.now() + timeoutMs;
  let sawDown = false;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let info;
    try {
      info = await peerVersion(hostId);
    } catch {
      sawDown = true;
      continue;
    }
    const status = await peerUpdateStatus(hostId);
    if (status && status.startedAt && status.startedAt !== before.startedAt) {
      if (status.state === 'failed') throw new Error(status.error || 'the update failed on that machine');
      if (status.state === 'success') {
        if (target && updateService.compareVersions(info.version, target) !== 0) throw new Error(`expected stable v${target}, but the machine reports v${info.version}`);
        return info.version;
      }
      continue; // still running
    }
    if (info.version !== before.version || info.commit !== before.commit || sawDown) {
      if (target && updateService.compareVersions(info.version, target) !== 0) throw new Error(`expected stable v${target}, but the machine reports v${info.version} (possibly rolled back)`);
      return info.version;
    }
  }
  return null;
}

/** Persist the local-first request across the updater's service restart. */
function getPendingUpdate() {
  const value = hostService.readConfig(PENDING_KEY);
  if (value === '1') return { channel: null, requestedAt: null }; // older installs
  try {
    const pending = JSON.parse(value || 'null');
    return pending && pending.requestedAt ? pending : null;
  } catch {
    return null;
  }
}

function requestFleetUpdate({ channel = updateService.getChannel(), target = null } = {}) {
  if (running) throw new Error('A paired-machine rollout is already running.');
  hostService.writeConfig(PENDING_KEY, JSON.stringify({ channel, target, requestedAt: new Date().toISOString() }));
}

function cancelFleetUpdate() {
  hostService.writeConfig(PENDING_KEY, '0');
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
async function rollout({ target = APP_VERSION, pollMs = POLL_MS, timeoutMs = COME_BACK_TIMEOUT_MS, force = false, channel } = {}) {
  if (running) return { skipped: 'a rollout is already running' };
  running = true;
  const summary = {
    target,
    channel: channel || null,
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
        if (!force && updateService.compareVersions(info.version, target) >= 0) {
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
        const before = force
          ? { version: info.version, commit: info.commit, startedAt: ((await peerUpdateStatus(row.id)) || {}).startedAt }
          : null;
        // Older paired releases ignore a channel in the update body, but expose
        // this authenticated admin endpoint. Set it before asking them to update.
        if (channel) {
          const selected = await hostService.requestHost(row.id, '/api/system/update/channel', {
            method: 'PUT', body: { channel }, timeout: 20000, maxCandidates: 3,
          });
          if (!selected.ok) throw new Error((selected.data && selected.data.error) || `channel HTTP ${selected.status}`);
        }
        const res = await hostService.requestHost(row.id, '/api/system/update', {
          method: 'POST', body: { propagated: true }, timeout: 20000, maxCandidates: 3,
        });
        if (!res.ok) throw new Error((res.data && res.data.error) || `update HTTP ${res.status}`);
        const reached = force
          ? await waitForUpdate(row.id, before, { pollMs: Math.min(pollMs, FORCE_POLL_MS), timeoutMs, target: channel === 'stable' ? target : null })
          : await waitForVersion(row.id, target, { pollMs, timeoutMs });
        if (!reached) {
          entry.status = 'failed';
          entry.error = force ? 'did not finish updating in time' : 'did not come back with the new version in time';
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
async function maybePropagateAfterUpdate({ pollMs, timeoutMs } = {}) {
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

  // "Update now" asked for the whole fleet: this machine went first (it is the
  // canary), so now update every paired machine regardless
  // of whether the version number changed.
  const pending = getPendingUpdate();
  hostService.writeConfig(PENDING_KEY, '0');
  if (pending) {
    hostService.writeConfig(SKIP_KEY, '0');
    // Do not push a failed/rolled-back release to peers. Ignore failures from a
    // previous attempt: the root helper does not replace the built-in status.
    const local = (updateService.getUpdateStatus() || {}).status;
    const failed = local && local.state === 'failed' && (!pending.requestedAt || local.finishedAt >= pending.requestedAt);
    const wrongVersion = pending.target && updateService.compareVersions(APP_VERSION, pending.target) !== 0;
    if (failed || wrongVersion) {
      const problem = failed ? local.error || 'unknown error' : `expected v${pending.target}, but this machine restarted on v${APP_VERSION} (possibly rolled back)`;
      const summary = {
        target: pending.target || APP_VERSION, channel: pending.channel, startedAt: pending.requestedAt,
        finishedAt: new Date().toISOString(), hosts: [],
        halted: `Local update failed: ${problem}; paired machines were left untouched`,
      };
      saveRollout(summary);
      return summary;
    }
    return rollout({ target: APP_VERSION, force: true, channel: pending.channel, pollMs, timeoutMs });
  }
  if (!last || updateService.compareVersions(APP_VERSION, last) <= 0) return null;

  const skip = hostService.readConfig(SKIP_KEY) === '1';
  hostService.writeConfig(SKIP_KEY, '0');
  if (skip) return null;
  return rollout({ target: APP_VERSION });
}

module.exports = {
  getLastRollout,
  getPendingUpdate,
  isRolloutRunning: () => running,
  markPropagatedUpdate,
  clearPropagatedUpdate,
  rollout,
  requestFleetUpdate,
  cancelFleetUpdate,
  maybePropagateAfterUpdate,
};
