/**
 * Citadel Self-Update Service
 * Reports the running version and checks GitHub for newer releases.
 * The actual update runs through a root-owned helper (see scripts/update.sh).
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const {
  APP_VERSION,
  ROOT_DIR,
  UPDATE_REPO,
  UPDATE_BRANCH,
  UPDATER_PATH,
  SERVICE_NAME,
  PEER_TOKEN,
  PEER_URLS,
} = require('../config');

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, data: null };

function stripV(value) {
  return String(value || '').replace(/^v/i, '').trim();
}

function compareVersions(a, b) {
  const pa = stripV(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = stripV(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i += 1) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function getCurrentCommit() {
  try {
    const res = spawnSync('git', ['-C', ROOT_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    if (res.status === 0) return res.stdout.trim();
  } catch {
    // Not a git checkout; ignore.
  }
  return null;
}

function getVersionInfo() {
  const updaterInstalled = fs.existsSync(UPDATER_PATH);
  return {
    version: APP_VERSION,
    commit: getCurrentCommit(),
    repo: UPDATE_REPO,
    branch: UPDATE_BRANCH,
    service: SERVICE_NAME,
    updaterAvailable: updaterInstalled,
    updaterPath: updaterInstalled ? UPDATER_PATH : null,
    peers: PEER_URLS,
    peerSync: Boolean(PEER_TOKEN && PEER_URLS.length > 0),
  };
}

// What the updater actually deploys: the head of the tracked branch and the
// version declared in its package.json. This is authoritative — a tag that is
// not reachable from the branch would be irrelevant to the self-updater.
async function fetchRemoteBranch(headers) {
  const [commitRes, pkgRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${UPDATE_REPO}/commits/${encodeURIComponent(UPDATE_BRANCH)}`, { headers }),
    fetch(`https://raw.githubusercontent.com/${UPDATE_REPO}/${encodeURIComponent(UPDATE_BRANCH)}/package.json`, { headers }),
  ]);
  let commit = null;
  let url = null;
  let date = null;
  let version = null;
  if (commitRes.ok) {
    const c = await commitRes.json();
    if (c && c.sha) {
      commit = c.sha;
      url = c.html_url || `https://github.com/${UPDATE_REPO}/commit/${commit}`;
      date = c.commit && c.commit.committer ? c.commit.committer.date : null;
    }
  }
  if (pkgRes.ok) {
    try {
      const pkg = await pkgRes.json();
      if (pkg && pkg.version) version = stripV(pkg.version);
    } catch {
      // Ignore malformed package.json response.
    }
  }
  return { commit, url, date, version };
}

// Fallback when the branch is unreachable: pick the highest version-like tag
// (or the flagged release if there are no tags).
async function fetchLatestTag(headers) {
  let candidates = [];
  const tagsRes = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/tags?per_page=100`, { headers });
  if (tagsRes.ok) {
    const tags = await tagsRes.json();
    if (Array.isArray(tags)) {
      candidates = tags
        .map((t) => (t ? t.name : null))
        .filter((name) => /^v?\d+\.\d+/.test(String(name || '')))
        .map((name) => ({
          version: stripV(name),
          name,
          url: `https://github.com/${UPDATE_REPO}/releases/tag/${encodeURIComponent(name)}`,
          publishedAt: null,
        }));
    }
  }
  if (candidates.length === 0) {
    const releaseRes = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers });
    if (releaseRes.ok) {
      const rel = await releaseRes.json();
      if (rel && rel.tag_name) {
        candidates.push({
          version: stripV(rel.tag_name),
          name: rel.name || rel.tag_name,
          url: rel.html_url,
          publishedAt: rel.published_at || null,
        });
      }
    }
  }
  let latest = null;
  for (const candidate of candidates) {
    if (!latest || compareVersions(candidate.version, latest.version) > 0) {
      latest = candidate;
    }
  }
  return latest;
}

async function checkForUpdates({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const result = {
    version: APP_VERSION,
    commit: getCurrentCommit(),
    latest: null,
    latestCommit: null,
    releaseName: null,
    releaseUrl: null,
    publishedAt: null,
    updateAvailable: false,
    checkedAt: new Date().toISOString(),
  };

  const headers = { 'User-Agent': 'Citadel', Accept: 'application/vnd.github+json' };
  try {
    const remote = await fetchRemoteBranch(headers);
    if (remote.version || remote.commit) {
      result.latest = remote.version || APP_VERSION;
      result.latestCommit = remote.commit ? remote.commit.slice(0, 7) : null;
      result.releaseName = remote.version ? `v${remote.version}` : result.latestCommit;
      result.releaseUrl = remote.url;
      result.publishedAt = remote.date;
      const localCommit = result.commit;
      const commitDiffers = Boolean(remote.commit && localCommit && !remote.commit.startsWith(localCommit));
      const versionNewer = Boolean(remote.version && compareVersions(remote.version, APP_VERSION) > 0);
      result.updateAvailable = versionNewer || commitDiffers;
    } else {
      const latest = await fetchLatestTag(headers);
      if (latest) {
        result.latest = latest.version;
        result.releaseName = latest.name;
        result.releaseUrl = latest.url;
        result.publishedAt = latest.publishedAt;
        result.updateAvailable = compareVersions(latest.version, APP_VERSION) > 0;
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  cache = { at: now, data: result };
  return result;
}

/**
 * Ask every configured peer host to run its own updater, so one "Update" action
 * rolls out across the fleet. Best-effort: a peer that is unreachable is logged
 * but never blocks this host's update.
 */
async function notifyPeers() {
  if (!PEER_TOKEN || PEER_URLS.length === 0) return [];
  const results = await Promise.allSettled(PEER_URLS.map(async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${base}/api/system/peer-update`, {
        method: 'POST',
        headers: {
          'X-Citadel-Peer-Token': PEER_TOKEN,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: controller.signal,
      });
      return { url: base, ok: res.ok, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }));
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason) }));
}

/**
 * Launch the root-owned updater helper in the background. The helper restarts
 * the service, so the current process will be replaced. When `fanout` is true
 * (default) and peers are configured, also ask each peer to update.
 */
async function triggerUpdate({ fanout = true } = {}) {
  if (!fs.existsSync(UPDATER_PATH)) {
    throw new Error('Updater is not installed on this host. Re-run install.sh with --enable-updater.');
  }

  const precheck = spawnSync('sudo', ['-n', UPDATER_PATH, '--check'], { encoding: 'utf8' });
  if (precheck.status !== 0) {
    const detail = (precheck.stderr || precheck.stdout || '').trim();
    throw new Error(`Updater precheck failed: ${detail || 'not permitted (check sudoers)'}`);
  }

  const child = spawn('sudo', ['-n', UPDATER_PATH], { detached: true, stdio: 'ignore' });
  child.unref();

  let peers = [];
  if (fanout) {
    try {
      peers = await notifyPeers();
    } catch (err) {
      peers = [{ ok: false, error: err.message }];
    }
  }
  return { started: true, peers };
}

module.exports = {
  stripV,
  compareVersions,
  getVersionInfo,
  checkForUpdates,
  triggerUpdate,
};
