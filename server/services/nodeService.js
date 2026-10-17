/**
 * Citadel Node Abstraction Layer
 * Provides uniform node interface for local VPS (MVP) and future remote VPS nodes
 */
const os = require('node:os');
const { getDatabase } = require('../database/db');

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
  }

  /**
   * Return hardware, OS, and software info for the current node
   */
  async getNodeInfo() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
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
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    return {
      nodeId: this.nodeId,
      timestamp: Date.now(),
      loadAvg: os.loadavg()[0],
      memoryUsedPercent: Math.round((usedMem / totalMem) * 100),
      freeMemMB: Math.round(freeMem / (1024 * 1024)),
      totalMemMB: Math.round(totalMem / (1024 * 1024)),
    };
  }
}

module.exports = new LocalNodeService();
