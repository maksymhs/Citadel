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
  };
}

async function checkForUpdates({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const result = {
    version: APP_VERSION,
    latest: null,
    releaseName: null,
    releaseUrl: null,
    publishedAt: null,
    updateAvailable: false,
    checkedAt: new Date().toISOString(),
  };

  const headers = { 'User-Agent': 'Citadel', Accept: 'application/vnd.github+json' };
  try {
    // GitHub's /releases/latest only returns the single release flagged as
    // "latest", which goes stale whenever newer versions are published as plain
    // tags (as this repo does). Read every tag, keep the ones that look like a
    // version, and pick the highest one instead.
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

    // Fall back to the published release if no usable tags were found.
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

    if (latest) {
      result.latest = latest.version;
      result.releaseName = latest.name;
      result.releaseUrl = latest.url;
      result.publishedAt = latest.publishedAt;
      result.updateAvailable = compareVersions(latest.version, APP_VERSION) > 0;
    }
  } catch (err) {
    result.error = err.message;
  }

  cache = { at: now, data: result };
  return result;
}

/**
 * Launch the root-owned updater helper in the background. The helper restarts
 * the service (--no-block), so the current process will be replaced.
 */
function triggerUpdate() {
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
  return { started: true };
}

module.exports = {
  stripV,
  compareVersions,
  getVersionInfo,
  checkForUpdates,
  triggerUpdate,
};
