/**
 * Citadel Node Abstraction Layer
 * Provides uniform node interface for local VPS (MVP) and future remote VPS nodes
 */
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { getDatabase } = require('../database/db');
const { DATA_DIR } = require('../config');
const { getMemory } = require('./memoryStats');
const { getTemperature } = require('./temperature');

const PROCESS_LIMIT_DEFAULT = 15;
const PROCESS_LIMIT_MAX = 100;
const PROC_SAMPLE_INTERVAL_MS = 150;

function clampLimit(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n < 1) return PROCESS_LIMIT_DEFAULT;
  return Math.min(n, PROCESS_LIMIT_MAX);
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Linux start ticks plus the current boot ID distinguish a PID from an older
// process that occupied the same number. Never use command text as an identity.
function parseLinuxProcessIdentity(pid, stat, status, bootId) {
  const closeParen = stat.lastIndexOf(')');
  if (!stat.startsWith(`${pid} (`) || closeParen < 0) return null;
  const rest = stat.slice(closeParen + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const startTicks = rest[19]; // /proc/PID/stat field 22, after stripping comm.
  const owner = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m);
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !/^\d+$/.test(startTicks || '') || !owner) return null;
  const uids = owner.slice(1).map(Number);
  if (uids.some(uid => !Number.isSafeInteger(uid) || uid < 0 || uid > 4294967295)) return null;
  return { pid, ppid, uid: uids[0], uids, identity: `linux:${bootId}:${pid}:${startTicks}` };
}

class INodeService {
  async getNodeInfo() {
    throw new Error('getNodeInfo() must be implemented.');
  }
  async getMetrics() {
    throw new Error('getMetrics() must be implemented.');
  }
}

class LocalNodeService extends INodeService {
  constructor() {
    super();
    this.nodeId = 'local';
    this.isLocal = true;
    // Previous /proc snapshot used to compute per-process CPU deltas.
    this._lastProcSample = null;
  }

  /**
   * Return hardware, OS, and software info for the current node
   */
  async getNodeInfo() {
    const { totalBytes: totalMem, freeBytes: freeMem, usedBytes: usedMem } = getMemory();
    const cpus = os.cpus();

    // Query active counts from SQLite
    let activeProjects = 0;
    let activeSessions = 0;
    try {
      const db = getDatabase();
      const pCount = db.prepare('SELECT COUNT(*) AS c FROM projects').get();
      const sCount = db.prepare("SELECT COUNT(*) AS c FROM term_sessions WHERE status = 'active'").get();
      activeProjects = pCount.c;
      activeSessions = sCount.c;
    } catch {
      // Ignore if db is busy
    }

    return {
      id: this.nodeId,
      isLocal: true,
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: os.uptime(),
      loadAverage: os.loadavg(),
      cpu: {
        model: cpus[0]?.model || 'Generic CPU',
        cores: cpus.length,
        speedMhz: cpus[0]?.speed || 0,
      },
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedBytes: usedMem,
        usedPercent: Math.round((usedMem / totalMem) * 100),
      },
      stats: {
        activeProjects,
        activeSessions,
      },
      nodeVersion: process.version,
    };
  }

  /**
   * Return lightweight current metrics for real-time monitoring
   */
  async getMetrics() {
    const { totalBytes: totalMem, freeBytes: freeMem, usedBytes: usedMem } = getMemory();

    return {
      nodeId: this.nodeId,
      timestamp: Date.now(),
      loadAvg: os.loadavg()[0],
      memoryUsedPercent: Math.round((usedMem / totalMem) * 100),
      freeMemMB: Math.round(freeMem / (1024 * 1024)),
      totalMemMB: Math.round(totalMem / (1024 * 1024)),
    };
  }

  /**
   * One compact snapshot for the fleet monitor: load, memory, disk and uptime.
   * Disk usage covers the data directory's filesystem (where projects live).
   */
  async getHealth() {
    const mem = getMemory();
    const cores = os.cpus().length || 1;
    const load1 = os.loadavg()[0];

    let disk = null;
    try {
      const st = fs.statfsSync(DATA_DIR);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      if (total > 0) {
        disk = {
          totalBytes: total,
          freeBytes: free,
          usedPercent: Math.round(((total - free) / total) * 100),
        };
      }
    } catch {
      // statfs is unavailable on some platforms; the disk gauge is optional.
    }

    let activeTerminals = 0;
    try {
      activeTerminals = getDatabase()
        .prepare("SELECT COUNT(*) AS c FROM term_sessions WHERE status = 'active'").get().c;
    } catch {
      // Ignore if db is busy.
    }

    return {
      timestamp: Date.now(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
      cores,
      load1: round(load1, 2),
      loadPerCore: round(load1 / cores, 2),
      memory: {
        totalBytes: mem.totalBytes,
        usedPercent: mem.usedPercent,
      },
      disk,
      temperature: getTemperature(),
      activeTerminals,
    };
  }

  /**
   * Return the top processes ordered by instantaneous CPU usage (or by memory with options.sort).
   * On Linux we sample /proc and compute deltas between calls (accurate,
   * non-blocking). On any other platform we fall back to `ps`.
   */
  async getProcesses(options = {}) {
    const limit = clampLimit(options.limit);
    const sort = options.sort === 'memory' ? 'memory' : 'cpu';
    const totalMem = os.totalmem();

    if (process.platform === 'linux') {
      // First call has no baseline: prime one so CPU deltas are meaningful.
      if (!this._lastProcSample) {
        this._sampleLinuxProcesses();
        await new Promise((resolve) => setTimeout(resolve, PROC_SAMPLE_INTERVAL_MS));
      }
      const procs = this._sampleLinuxProcesses();
      if (procs) {
        return this._formatProcessResult(procs, limit, totalMem, sort);
      }
    }

    const fallback = this._getPsProcesses(totalMem);
    return this._formatProcessResult(fallback, limit, totalMem, sort);
  }

  _getLinuxBootId() {
    if (!this._linuxBootId) {
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) {
        throw Object.assign(new Error('Process identity is unavailable.'), { code: 'EPROCESS' });
      }
      this._linuxBootId = bootId;
    }
    return this._linuxBootId;
  }

  /** Fresh synchronous identity/ownership read used by the process-control guard. */
  readProcessIdentity(pid) {
    if (process.platform !== 'linux' || typeof process.geteuid !== 'function') {
      throw Object.assign(new Error('Safe process control is unavailable on this platform.'), { code: 'ENOTSUP' });
    }
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) {
      throw Object.assign(new Error('Invalid process ID.'), { code: 'EINVAL' });
    }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const bootId = this._getLinuxBootId();
    const identity = parseLinuxProcessIdentity(pid, stat, status, bootId);
    if (!identity) throw Object.assign(new Error('Process identity is unavailable.'), { code: 'EPROCESS' });
    const verified = parseLinuxProcessIdentity(pid, fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), status, bootId);
    if (!verified || verified.identity !== identity.identity) {
      throw Object.assign(new Error('Process identity changed during inspection.'), { code: 'ESTALE' });
    }
    return identity;
  }

  /** Fail closed if the complete current service ancestry cannot be established. */
  getProcessControlContext() {
    if (process.platform !== 'linux' || typeof process.geteuid !== 'function') {
      throw Object.assign(new Error('Safe process control is unavailable on this platform.'), { code: 'ENOTSUP' });
    }
    const protectedPids = new Set([1, process.pid, process.ppid]);
    const visited = new Set();
    let pid = process.pid;
    while (pid > 1) {
      if (visited.has(pid) || visited.size >= 128) {
        throw Object.assign(new Error('Process ancestry is unavailable.'), { code: 'EPROCESS' });
      }
      visited.add(pid);
      const info = this.readProcessIdentity(pid);
      protectedPids.add(pid);
      protectedPids.add(info.ppid);
      pid = info.ppid;
    }
    return { uid: process.geteuid(), protectedPids };
  }

  /**
   * Read /proc once and compute per-process CPU from the previous sample.
   * Returns null when /proc is unavailable so the caller can fall back to ps.
   */
  _sampleLinuxProcesses() {
    const now = Date.now();
    let statContent;
    try {
      statContent = fs.readFileSync('/proc/stat', 'utf8');
    } catch {
      return null;
    }

    const cpuFields = statContent.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const totalJiffies = cpuFields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);

    let pids;
    try {
      pids = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
    } catch {
      return null;
    }

    const prev = this._lastProcSample;
    const totalDelta = prev ? totalJiffies - prev.totalJiffies : 0;
    const coreCount = os.cpus().length || 1;

    const sample = new Map();
    const processes = [];
    let bootId = null;
    try { bootId = this._getLinuxBootId(); } catch { /* Listing remains read-only when safe control is unavailable. */ }

    for (const pidStr of pids) {
      const pid = Number(pidStr);
      let stat;
      let status;
      try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      } catch {
        continue; // Process exited between listing and reading.
      }

      const closeParen = stat.lastIndexOf(')');
      const openParen = stat.indexOf('(');
      if (openParen === -1 || closeParen === -1) continue;
      const name = stat.slice(openParen + 1, closeParen) || 'unknown';

      // Fields after "comm)" start at field 3 (state). utime is field 14 and
      // stime field 15, i.e. indices 11 and 12 once comm is stripped.
      const rest = stat.slice(closeParen + 2).trim().split(/\s+/);
      const utime = Number(rest[11]) || 0;
      const stime = Number(rest[12]) || 0;
      const jiffies = utime + stime;
      sample.set(pid, jiffies);

      let cpuPercent = 0;
      if (prev && totalDelta > 0) {
        const prevJiffies = prev.procs.get(pid);
        if (prevJiffies !== undefined) {
          cpuPercent = ((jiffies - prevJiffies) / totalDelta) * coreCount * 100;
        }
      }

      let rssBytes = 0;
      const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (rssMatch) rssBytes = Number(rssMatch[1]) * 1024;

      const identity = bootId ? parseLinuxProcessIdentity(pid, stat, status, bootId) : null;
      processes.push({ pid, name, cpuPercent, rssBytes, ...identity });
    }

    this._lastProcSample = { time: now, totalJiffies, procs: sample };
    return processes;
  }

  /**
   * Portable fallback using the native ps CLI (Linux and macOS).
   * Note: %cpu reported by ps is a lifetime average, not instantaneous.
   */
  _getPsProcesses() {
    try {
      const res = spawnSync('ps', ['-A', '-o', 'pid=,comm=,%cpu=,%mem=,rss='], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (res.status !== 0 || !res.stdout) return [];

      const processes = [];
      for (const line of res.stdout.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const pid = Number(parts[0]);
        if (!Number.isFinite(pid)) continue;
        const rssKB = Number(parts[parts.length - 1]) || 0;
        const cpuPercent = Number(parts[parts.length - 3]) || 0;
        const name = parts.slice(1, parts.length - 3).join(' ') || 'unknown';
        processes.push({ pid, name, cpuPercent, rssBytes: rssKB * 1024 });
      }
      return processes;
    } catch {
      return [];
    }
  }

  _formatProcessResult(processes, limit, totalMem, sort = 'cpu') {
    // Rank before slicing: sorting only the CPU top-N would hide idle but memory-hungry processes.
    processes.sort(sort === 'memory'
      ? (a, b) => (b.rssBytes - a.rssBytes) || (b.cpuPercent - a.cpuPercent)
      : (a, b) => (b.cpuPercent - a.cpuPercent) || (b.rssBytes - a.rssBytes));
    let control = null;
    try { control = this.getProcessControlContext(); } catch { /* Read-only fallback, never guess ownership/ancestry. */ }

    const top = processes.slice(0, limit).map((proc) => ({
      pid: proc.pid,
      name: proc.name,
      cpuPercent: round(Math.max(proc.cpuPercent, 0), 1),
      memPercent: totalMem ? round((proc.rssBytes / totalMem) * 100, 1) : 0,
      rssBytes: proc.rssBytes,
      identity: proc.identity || null,
      uid: proc.uid ?? null,
      canTerminate: !!(control && proc.identity && proc.uids?.length === 4 &&
        proc.uids.every(uid => uid === control.uid) && !control.protectedPids.has(proc.pid)),
    }));

    return {
      timestamp: Date.now(),
      total: processes.length,
      totalMemBytes: totalMem,
      processes: top,
    };
  }
}

module.exports = new LocalNodeService();
