/**
 * Mesh pairing: machines that opted in (Settings → Machines) are introduced to
 * each other by any machine they are already paired with, so every machine ends
 * up paired with every other one.
 *
 * An introducer A that is paired with X and Y (and sees they are not paired
 * with each other) asks Y for a single-use invitation and hands it to X, which
 * redeems it through the normal handshake. Each side keeps its own token for
 * the other, and no credential vault is merged. Both X and Y must have mesh
 * enabled locally, so nothing happens on a machine whose admin did not opt in.
 */
const hostService = require('./hostService');

const MAX_INTRODUCTIONS_PER_RUN = 10;
const JOIN_TIMEOUT_MS = 40000;

let running = false;
let pending = null;

/**
 * Pure planning step. `peers` is [{ row, known: Set<instanceId> }] for the hosts
 * that answered; returns the unordered pairs that are not paired yet.
 */
function planIntroductions(peers) {
  const plan = [];
  for (let i = 0; i < peers.length; i += 1) {
    for (let j = i + 1; j < peers.length; j += 1) {
      const a = peers[i];
      const b = peers[j];
      if (a.known.has(b.row.instance_id) || b.known.has(a.row.instance_id)) continue;
      plan.push({ joiner: a.row, inviter: b.row });
    }
  }
  return plan;
}

async function syncMesh() {
  if (!hostService.getMeshEnabled()) return { enabled: false, introduced: [], skipped: 'mesh is off' };
  if (running) return { enabled: true, introduced: [], skipped: 'already running' };
  running = true;
  const introduced = [];
  const failed = [];
  try {
    const rows = hostService.listHostRows().filter((row) => row.instance_id);
    const answered = [];
    await Promise.allSettled(rows.map(async (row) => {
      const res = await hostService.requestHost(row.id, '/api/host/peers/known', { timeout: 5000, maxCandidates: 3 });
      if (!res.ok || !res.data || !Array.isArray(res.data.peers)) return;
      answered.push({ row, known: new Set(res.data.peers.map((p) => p.instanceId)) });
    }));

    const plan = planIntroductions(answered).slice(0, MAX_INTRODUCTIONS_PER_RUN);
    for (const { joiner, inviter } of plan) {
      try {
        const invite = await hostService.requestHost(inviter.id, '/api/host/peers/mesh/invite', {
          method: 'POST', body: {}, timeout: 8000, maxCandidates: 3,
        });
        if (!invite.ok || !invite.data || !invite.data.link) {
          throw new Error((invite.data && invite.data.error) || `invite HTTP ${invite.status}`);
        }
        const join = await hostService.requestHost(joiner.id, '/api/host/peers/mesh/join', {
          method: 'POST', body: { link: invite.data.link }, timeout: JOIN_TIMEOUT_MS, maxCandidates: 3,
        });
        if (!join.ok) throw new Error((join.data && join.data.error) || `join HTTP ${join.status}`);
        introduced.push({ a: joiner.name, b: inviter.name });
      } catch (err) {
        failed.push({ a: joiner.name, b: inviter.name, error: err.message });
      }
    }
  } finally {
    running = false;
  }
  return { enabled: true, introduced, failed };
}

/** Debounced background sync, e.g. right after a pairing completes. */
function scheduleSync(delayMs = 3000) {
  if (!hostService.getMeshEnabled()) return;
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    syncMesh().catch(() => {});
  }, delayMs);
  if (typeof pending.unref === 'function') pending.unref();
}

module.exports = { planIntroductions, syncMesh, scheduleSync };
