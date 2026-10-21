/**
 * Cross-platform RAM usage.
 *
 * Node's os.freemem() is only "available" memory on Linux (MemAvailable). On
 * macOS it reports just the truly free pages, so file cache and inactive pages
 * count as used and the gauge sits near 95% on a healthy machine. On macOS we
 * read vm_stat and use the same formula as Activity Monitor's "Memory Used":
 * app memory (anonymous - purgeable) + wired + compressed.
 */
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const CACHE_MS = 2000;

let cached = null;

function parseVmStat(text) {
  const pageSize = parseInt(/page size of (\d+) bytes/.exec(text)?.[1], 10);
  if (!Number.isFinite(pageSize)) return null;
  const pages = (label) => {
    const m = new RegExp(`^"?${label}"?:\\s+(\\d+)\\.`, 'm').exec(text);
    return m ? parseInt(m[1], 10) : null;
  };
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable') || 0;
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor') || 0;
  if (anonymous === null || wired === null) return null;
  const app = Math.max(0, anonymous - purgeable);
  return { usedBytes: (app + wired + compressed) * pageSize };
}

function readDarwinUsed() {
  const res = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 1500 });
  if (res.status !== 0 || !res.stdout) return null;
  return parseVmStat(res.stdout);
}

/** @returns {{ totalBytes: number, usedBytes: number, freeBytes: number, usedPercent: number }} */
function getMemory() {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;

  const totalBytes = os.totalmem();
  let usedBytes = totalBytes - os.freemem();
  if (os.platform() === 'darwin') {
    const mac = readDarwinUsed();
    if (mac) usedBytes = Math.min(mac.usedBytes, totalBytes);
  }

  const value = {
    totalBytes,
    usedBytes,
    freeBytes: totalBytes - usedBytes,
    usedPercent: Math.round((usedBytes / totalBytes) * 100),
  };
  cached = { at: now, value };
  return value;
}

module.exports = { getMemory, parseVmStat };
