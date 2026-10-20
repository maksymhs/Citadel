/**
 * Service log tail and restart for the Citadel process itself.
 *
 * Logs come from the first source that works: journald (Linux service), the
 * launchd log file (macOS) or, as a last resort, the panel's own event trace.
 * Restarting only ends the process; the service manager restarts it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { SERVICE_NAME, LOGS_DIR, NODE_ENV } = require('../config');
const logService = require('./logService');

const MAX_BYTES = 128 * 1024;
const RESTART_DELAY_MS = 600;

function readFileTail(file, lines) {
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, MAX_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    return buf.toString('utf8').split('\n').slice(-lines).join('\n').trimEnd();
  } finally {
    fs.closeSync(fd);
  }
}

function journal(lines) {
  return new Promise((resolve) => {
    if (process.platform !== 'linux' || !/^[A-Za-z0-9_.@-]+$/.test(SERVICE_NAME)) return resolve(null);
    execFile('journalctl', ['-u', SERVICE_NAME, '-n', String(lines), '--no-pager', '-o', 'short-iso'],
      { timeout: 5000, maxBuffer: MAX_BYTES * 2 }, (err, stdout) => {
        // Without journal access journalctl exits 0 with a hint instead of logs.
        if (err || !stdout || /no journal files were opened|not seeing messages from other users/i.test(stdout)) {
          return resolve(null);
        }
        resolve(stdout.trimEnd());
      });
  });
}

async function tail(lines = 200) {
  const fromJournal = await journal(lines);
  if (fromJournal) return { source: 'journal', text: fromJournal };

  for (const file of [path.join(LOGS_DIR, 'citadel.log')]) {
    try {
      return { source: 'file', text: readFileTail(file, lines) };
    } catch {
      // Try the next source.
    }
  }

  const events = logService.listEvents({ limit: lines }).reverse();
  const text = events.map((e) => `${e.ts} ${String(e.level).toUpperCase()} [${e.category}] ${e.message || e.action || ''}`).join('\n');
  return { source: 'events', text };
}

/**
 * End the process shortly after the HTTP response went out. Disabled under
 * test and when running outside a supervised service (`npm run dev` still
 * restarts through --watch only on file changes, so refuse there too).
 */
function scheduleRestart() {
  if (NODE_ENV === 'test' || process.env.CITADEL_ALLOW_RESTART === '0') return false;
  logService.record({ category: 'system', action: 'restart_requested', message: 'Restart requested from the panel.' });
  const t = setTimeout(() => process.kill(process.pid, 'SIGTERM'), RESTART_DELAY_MS);
  if (typeof t.unref === 'function') t.unref();
  return true;
}

module.exports = { tail, scheduleRestart };
