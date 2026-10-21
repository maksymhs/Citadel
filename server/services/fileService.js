/**
 * Filesystem service.
 *
 * Runs the fs agent (scripts/fsAgent.js) to perform privileged file operations.
 * When an admin user is configured (TERMINAL_ADMIN_USER, set by
 * `install.sh --admin-terminal`), the agent runs as that user via the existing
 * "bash as admin" sudoers rule, which grants access to the whole host. Without
 * it, operations run as the unprivileged service user (limited to what it can
 * read/write).
 *
 * Requests are passed as JSON over stdin and paths as positional arguments, so
 * no user input is ever interpolated into a shell command.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR, TERMINAL_ADMIN_USER, PROJECTS_DIR } = require('../config');

const AGENT_PATH = path.join(ROOT_DIR, 'scripts', 'fsAgent.js');
const NODE_BIN = process.execPath;
const ADMIN_USER = TERMINAL_ADMIN_USER || null;

function isPrivileged() {
  return Boolean(ADMIN_USER);
}

function spawnAgent() {
  if (ADMIN_USER) {
    // `bash -c 'exec "$0" "$1"' <node> <agent>` keeps the path as data.
    return spawn('sudo', ['-n', '-u', ADMIN_USER, '/bin/bash', '-c', 'exec "$0" "$1"', NODE_BIN, AGENT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawn(NODE_BIN, [AGENT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function runAgent(req, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnAgent();
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Filesystem operation timed out.'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout) {
        reject(new Error(stderr.trim() || `Filesystem agent exited with code ${code}.`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.ok) {
          reject(new Error(parsed.error || 'Filesystem error.'));
          return;
        }
        resolve(parsed.data);
      } catch {
        reject(new Error(stderr.trim() || 'Invalid filesystem agent response.'));
      }
    });

    child.stdin.on('error', () => { /* ignore broken pipe on early exit */ });
    child.stdin.end(JSON.stringify(req));
  });
}

// Streaming download: cat as the admin user (via the same allowed bash) or a
// plain read stream as the service user. Callers must stat() first.
function openReadStream(targetPath) {
  if (ADMIN_USER) {
    const child = spawn('sudo', ['-n', '-u', ADMIN_USER, '/bin/bash', '-c', 'exec /bin/cat -- "$1"', 'cat', targetPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return child.stdout;
  }
  return fs.createReadStream(targetPath);
}

module.exports = {
  isPrivileged,
  list: (p) => runAgent({ op: 'list', path: p }),
  read: (p) => runAgent({ op: 'read', path: p }),
  stat: (p) => runAgent({ op: 'stat', path: p }),
  write: (p, content, encoding) => runAgent({ op: 'write', path: p, content, encoding }),
  mkdir: (p) => runAgent({ op: 'mkdir', path: p }),
  rename: (from, to) => runAgent({ op: 'rename', from, to }),
  remove: (p) => runAgent({ op: 'remove', path: p }),
  usage: (p) => runAgent({ op: 'usage', path: p }, { timeoutMs: 60000 }),
  cleanupScan: () => runAgent({ op: 'cleanup-scan', projectsDir: PROJECTS_DIR, privileged: isPrivileged() }, { timeoutMs: 120000 }),
  cleanupRun: (ids, items) => runAgent({ op: 'cleanup-run', ids, items, projectsDir: PROJECTS_DIR, privileged: isPrivileged() }, { timeoutMs: 180000 }),
  openReadStream,
};
