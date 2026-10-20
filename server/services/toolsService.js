/**
 * Detects common developer and system tools installed on this machine.
 *
 * The catalogue is fixed (nothing user-supplied is ever executed). A tool counts
 * as installed when its binary is found on the service's PATH; its version comes
 * from running the binary with a harmless version flag, without a shell.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CACHE_TTL_MS = 60000;
const VERSION_TIMEOUT_MS = 3000;

const TOOLS = [
  { id: 'node', name: 'Node.js', group: 'Runtimes', bin: 'node', args: ['--version'] },
  { id: 'npm', name: 'npm', group: 'Runtimes', bin: 'npm', args: ['--version'] },
  { id: 'bun', name: 'Bun', group: 'Runtimes', bin: 'bun', args: ['--version'] },
  { id: 'deno', name: 'Deno', group: 'Runtimes', bin: 'deno', args: ['--version'] },
  { id: 'python', name: 'Python', group: 'Runtimes', bin: 'python3', args: ['--version'] },
  { id: 'pip', name: 'pip', group: 'Runtimes', bin: 'pip3', args: ['--version'] },
  { id: 'go', name: 'Go', group: 'Runtimes', bin: 'go', args: ['version'] },
  { id: 'rust', name: 'Rust', group: 'Runtimes', bin: 'rustc', args: ['--version'] },
  { id: 'java', name: 'Java', group: 'Runtimes', bin: 'java', args: ['-version'] },
  { id: 'ruby', name: 'Ruby', group: 'Runtimes', bin: 'ruby', args: ['--version'] },
  { id: 'php', name: 'PHP', group: 'Runtimes', bin: 'php', args: ['--version'] },

  { id: 'git', name: 'Git', group: 'Development', bin: 'git', args: ['--version'] },
  { id: 'gh', name: 'GitHub CLI', group: 'Development', bin: 'gh', args: ['--version'] },
  { id: 'make', name: 'make', group: 'Development', bin: 'make', args: ['--version'] },
  { id: 'gcc', name: 'GCC', group: 'Development', bin: 'gcc', args: ['--version'] },
  { id: 'vim', name: 'Vim', group: 'Development', bin: 'vim', args: ['--version'] },
  { id: 'nano', name: 'nano', group: 'Development', bin: 'nano', args: ['--version'] },

  { id: 'docker', name: 'Docker', group: 'Containers', bin: 'docker', args: ['--version'] },
  { id: 'podman', name: 'Podman', group: 'Containers', bin: 'podman', args: ['--version'] },
  { id: 'kubectl', name: 'kubectl', group: 'Containers', bin: 'kubectl', args: ['version', '--client'] },

  { id: 'curl', name: 'curl', group: 'Network', bin: 'curl', args: ['--version'] },
  { id: 'wget', name: 'wget', group: 'Network', bin: 'wget', args: ['--version'] },
  { id: 'ssh', name: 'OpenSSH', group: 'Network', bin: 'ssh', args: ['-V'] },
  { id: 'caddy', name: 'Caddy', group: 'Network', bin: 'caddy', args: ['version'] },
  { id: 'nginx', name: 'nginx', group: 'Network', bin: 'nginx', args: ['-v'] },
  { id: 'cloudflared', name: 'cloudflared', group: 'Network', bin: 'cloudflared', args: ['--version'] },
  { id: 'tailscale', name: 'Tailscale', group: 'Network', bin: 'tailscale', args: ['version'] },

  { id: 'tmux', name: 'tmux', group: 'System', bin: 'tmux', args: ['-V'] },
  { id: 'htop', name: 'htop', group: 'System', bin: 'htop', args: ['--version'] },
  { id: 'jq', name: 'jq', group: 'System', bin: 'jq', args: ['--version'] },
  { id: 'rsync', name: 'rsync', group: 'System', bin: 'rsync', args: ['--version'] },
  { id: 'sqlite', name: 'SQLite', group: 'System', bin: 'sqlite3', args: ['--version'] },
];

let cache = { at: 0, data: null };

function findBinary(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

function readVersion(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      // Some tools (java, ssh, nginx) print their version on stderr.
      const text = `${stdout || ''}\n${stderr || ''}`;
      const match = text.match(/\d+(?:\.\d+){1,3}[\w.+-]*/);
      resolve(match ? match[0] : (err ? null : ''));
    });
  });
}

async function detect(tool) {
  const file = findBinary(tool.bin);
  if (!file) return { id: tool.id, name: tool.name, group: tool.group, installed: false, version: null, path: null };
  const version = await readVersion(file, tool.args);
  return { id: tool.id, name: tool.name, group: tool.group, installed: true, version: version || null, path: file };
}

async function listTools({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;
  const tools = await Promise.all(TOOLS.map(detect));
  cache = { at: now, data: { checkedAt: now, tools } };
  return cache.data;
}

module.exports = { listTools, TOOLS };
