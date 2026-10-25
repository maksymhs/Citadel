#!/usr/bin/env node
/**
 * Measures the core API in a throwaway database: idle CPU/RAM, request latency
 * and SQLite writes. No ports, agents, terminals or production data are used.
 * Run: node scripts/benchmark.js > /tmp/citadel-benchmark.json
 * This is a repeatable core baseline, not a full browser/host benchmark.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-bench-'));
// Override every live-install path before loading any application module.
Object.assign(process.env, {
  DATA_DIR: root, DATABASE_PATH: path.join(root, 'citadel.db'),
  PROJECTS_DIR: path.join(root, 'projects'), LOGS_DIR: path.join(root, 'logs'),
  CITADEL_SELF_UPDATE: '0', NODE_ENV: 'test',
});
const { buildServer } = require('../server/index');
const { getDatabase, closeDatabase } = require('../server/database/db');
const projects = require('../server/services/projectService');
const tasks = require('../server/services/taskService');
const round = (n) => Math.round(n * 100) / 100;
const memory = () => Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, round(v / 1024 / 1024)]));

async function main() {
  let app;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  try {
    app = await buildServer({ logger: false });
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'benchmark', password: crypto.randomBytes(24).toString('hex') } });
    if (setup.statusCode !== 200) throw new Error('Isolated setup failed.');
    const cookies = { session_id: setup.cookies.find((c) => c.name === 'session_id').value };
    for (let i = 0; i < 20; i++) projects.createProject({ name: `Project ${i}` });
    fs.mkdirSync(path.join(root, 'projects', 'unregistered'));
    const project = projects.listProjects()[0];
    tasks.enqueue({ projectId: project.id, title: 'Benchmark queue entry', cmd: process.execPath, args: ['--version'] });
    const urls = ['/api/projects', '/api/projects/discover', '/api/tasks', '/api/logs/events'];
    for (const url of urls) {
      const res = await app.inject({ url, cookies });
      if (res.statusCode !== 200) throw new Error(`Warmup failed: ${url} (${res.statusCode})`);
    }
    const db = getDatabase();
    const changes = () => db.prepare('SELECT total_changes() n').get().n;
    const idleMemory = memory();
    const idleCpu = process.cpuUsage();
    const idleStart = performance.now();
    lag.enable();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const idleDelta = process.cpuUsage(idleCpu);
    const idleMs = performance.now() - idleStart;
    const results = [];
    for (const url of urls) {
      const writes = changes();
      const cpu = process.cpuUsage();
      const times = [];
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        const res = await app.inject({ url, cookies });
        if (res.statusCode !== 200) throw new Error(`Request failed: ${url} (${res.statusCode})`);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      const used = process.cpuUsage(cpu);
      results.push({ route: url.split('?')[0], requests: times.length, p50Ms: round(times[19]), p95Ms: round(times[37]), cpuMs: round((used.user + used.system) / 1000), changedRows: changes() - writes });
    }
    lag.disable();
    console.log(JSON.stringify({
      scope: 'isolated core API; injection includes client overhead; no samplers, browser, agents or terminals',
      node: process.version, platform: process.platform, arch: process.arch,
      idle: { durationMs: round(idleMs), cpuMs: round((idleDelta.user + idleDelta.system) / 1000), memoryMiB: idleMemory },
      workloads: results, finalMemoryMiB: memory(),
      eventLoopP95Ms: round(lag.percentile(95) / 1e6),
      databaseBytes: ['', '-wal', '-shm'].reduce((total, suffix) => {
        try { return total + fs.statSync(path.join(root, `citadel.db${suffix}`)).size; } catch { return total; }
      }, 0),
    }, null, 2));
  } finally {
    lag.disable();
    if (app) await app.close();
    closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
