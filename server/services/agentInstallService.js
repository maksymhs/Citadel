/**
 * AI coding agent integrations.
 *
 * Detects whether the supported coding-agent CLIs are installed and exposes a
 * fixed, server-side catalogue of install commands. The client can only ask to
 * install a known tool by id — it can never supply a raw command — so the panel
 * cannot be turned into an arbitrary command runner.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TERMINAL_ADMIN_USER } = require('../config');

const AGENTS = [
  {
    id: 'opencode',
    name: 'opencode',
    bin: 'opencode',
    install: 'curl -fsSL https://opencode.ai/install | bash',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
  },
];

function homeForUser(user) {
  if (!user) return null;
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${user}:`));
    if (line) {
      const home = line.split(':')[5];
      if (home && fs.existsSync(home)) return home;
    }
  } catch {
    // Fall through to the conventional path below.
  }
  const fallback = `/home/${user}`;
  return fs.existsSync(fallback) ? fallback : null;
}

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories worth probing for an installed CLI. Coding agents land in a
 * handful of well-known prefixes, and the panel process PATH rarely matches the
 * login shell of the user that ran the installer, so we look explicitly.
 */
function candidateDirs() {
  const dirs = [];
  const add = (dir) => { if (dir && !dirs.includes(dir)) dirs.push(dir); };
  const homes = [process.env.HOME, homeForUser(TERMINAL_ADMIN_USER), os.homedir(), '/root'];
  for (const home of homes) {
    if (!home) continue;
    for (const sub of ['.local/bin', '.opencode/bin', '.bun/bin', '.npm-global/bin', '.cargo/bin', 'bin']) {
      add(path.join(home, sub));
    }
  }
  for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin']) add(dir);
  return dirs;
}

function findBin(bin) {
  for (const dir of candidateDirs()) {
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  // Fall back to the login shell PATH (covers custom install prefixes).
  try {
    const res = spawnSync('/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8', timeout: 2000 });
    if (res.status === 0 && res.stdout && res.stdout.trim()) return res.stdout.trim().split('\n')[0];
  } catch {
    // Fall through: treat as not installed.
  }
  return null;
}

function binVersion(path) {
  try {
    const res = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 2000 });
    if (res.status === 0 && res.stdout && res.stdout.trim()) return res.stdout.trim().split('\n')[0];
  } catch {
    // Version probing is best-effort.
  }
  return null;
}

function getAgent(id) {
  return AGENTS.find((a) => a.id === id) || null;
}

/**
 * Describe each supported agent and whether its CLI is present on the host.
 */
function detectAgents() {
  return AGENTS.map((agent) => {
    const path = findBin(agent.bin);
    return {
      id: agent.id,
      name: agent.name,
      available: Boolean(path),
      version: path ? binVersion(path) : null,
    };
  });
}

/**
 * Build the shell invocation that runs a known agent's install command and then
 * leaves an interactive shell open. When `adminUser` is configured the install
 * runs as that user (mirroring the privileged System Terminal).
 */
function buildInstallSpec(agent, adminUser = null) {
  const script = `${agent.install}; echo; echo "${agent.name} install finished."; exec /bin/bash -l`;
  if (adminUser) {
    return { command: 'sudo', args: ['-u', adminUser, '-H', '/bin/bash', '-lc', script] };
  }
  return { command: '/bin/bash', args: ['-lc', script] };
}

module.exports = { AGENTS, getAgent, detectAgents, buildInstallSpec, findBin };
