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
   * Return the top processes ordered by instantaneous CPU usage.
   * On Linux we sample /proc and compute deltas between calls (accurate,
   * non-blocking). On any other platform we fall back to `ps`.
   */
  async getProcesses(options = {}) {
    const limit = clampLimit(options.limit);
    const totalMem = os.totalmem();

    if (process.platform === 'linux') {
      // First call has no baseline: prime one so CPU deltas are meaningful.
      if (!this._lastProcSample) {
        this._sampleLinuxProcesses();
        await new Promise((resolve) => setTimeout(resolve, PROC_SAMPLE_INTERVAL_MS));
      }
      const procs = this._sampleLinuxProcesses();
      if (procs) {
        return this._formatProcessResult(procs, limit, totalMem);
      }
    }

    const fallback = this._getPsProcesses(totalMem);
    return this._formatProcessResult(fallback, limit, totalMem);
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

      processes.push({ pid, name, cpuPercent, rssBytes });
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

  _formatProcessResult(processes, limit, totalMem) {
    processes.sort((a, b) => (b.cpuPercent - a.cpuPercent) || (b.rssBytes - a.rssBytes));

    const top = processes.slice(0, limit).map((proc) => ({
      pid: proc.pid,
      name: proc.name,
      cpuPercent: round(Math.max(proc.cpuPercent, 0), 1),
      memPercent: totalMem ? round((proc.rssBytes / totalMem) * 100, 1) : 0,
      rssBytes: proc.rssBytes,
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
