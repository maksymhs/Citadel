/**
 * Citadel CLI Agent Registry & Launcher
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { getDatabase } = require('../database/db');
const { TERMINAL_ADMIN_USER, AGENTS_DIR } = require('../config');
const terminalManager = require('./terminalManager');
const projectService = require('./projectService');

/**
 * Quote a single value for safe inclusion in a POSIX shell command line.
 * Prevents argument injection when writing a command into a PTY shell/tmux session.
 */
function shellQuote(value) {
  const str = String(value);
  if (str.length === 0) return "''";
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// Where the official installers drop their binaries relative to $HOME (which
// points at AGENTS_DIR during a shared install). `bin` holds Citadel's links.
const AGENT_BIN_SUBDIRS = ['bin', '.local/bin', '.opencode/bin', '.npm-global/bin'];

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

class AgentRegistry {
  constructor() {
    // Official installers run in a fresh release HOME through agentLifecycle.
    this.builtinAgents = require('./agentCatalogue');
  }

  /**
   * Search for binary across PATH and typical installation directories
   */
  findBinary(binaryName, customPath = null) {
    if (customPath && isExecutable(customPath)) {
      return customPath;
    }

    // Prefer an explicitly managed activation over an older PATH installation.
    for (const root of [AGENTS_DIR, path.join(os.homedir(), '.citadel/agents')]) {
      if (require('./agentLifecycle').isManaged(binaryName, root)) return path.join(root, 'bin', binaryName);
    }

    // Try `which` first
    try {
      const res = spawnSync('which', [binaryName], { encoding: 'utf8' });
      if (res.status === 0 && res.stdout) {
        const found = res.stdout.trim().split('\n')[0];
        if (isExecutable(found)) {
          return found;
        }
      }
    } catch {
      // Fall through to manual check
    }

    // Common user and system paths. Check the service user's home and, when a
    // privileged System Terminal user is configured, that user's home too (the
    // one-line installers often drop binaries in ~/.local/bin or ~/.opencode/bin).
    const homes = new Set([os.homedir()]);
    if (TERMINAL_ADMIN_USER) {
      try {
        const res = spawnSync('getent', ['passwd', TERMINAL_ADMIN_USER], { encoding: 'utf8' });
        if (res.status === 0 && res.stdout) {
          const home = res.stdout.trim().split(':')[5];
          if (home) homes.add(home);
        }
      } catch {
        // Ignore: fall back to the service user's home only.
      }
    }

    // Shared agents directory first: installing once here (HOME=$AGENTS_DIR)
    // makes the binary visible to every OS user.
    const candidatePaths = AGENT_BIN_SUBDIRS.map((sub) => path.join(AGENTS_DIR, sub, binaryName));
    for (const home of homes) {
      candidatePaths.push(
        path.join(home, '.local', 'bin', binaryName),
        path.join(home, '.npm-global', 'bin', binaryName),
        path.join(home, '.opencode', 'bin', binaryName),
        path.join(home, '.cargo', 'bin', binaryName),
        path.join(home, '.citadel', 'agents', 'bin', binaryName),
        path.join(home, 'bin', binaryName)
      );
    }
    candidatePaths.push(
      `/usr/local/bin/${binaryName}`,
      `/usr/bin/${binaryName}`,
      `/bin/${binaryName}`
    );

    // Only report binaries this (service) account can actually execute: an
    // agent installed in another user's private home is not usable here.
    return candidatePaths.find(isExecutable) || null;
  }

  /**
   * Query binary version safely
   */
  getBinaryVersion(binaryPath, versionArg = '--version') {
    if (!binaryPath) return null;
    try {
      const res = spawnSync(binaryPath, [versionArg], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (res.status === 0 && res.stdout) {
        const firstLine = res.stdout.trim().split('\n')[0];
        return firstLine.slice(0, 80);
      }
    } catch {
      // Ignore version probe failure
    }
    return null;
  }

  /**
   * Get all registered agents with their live detection status.
   *
   * `versions: false` skips the per-binary version probe (up to a few seconds
   * each). Mission planning only needs to know whether a binary is runnable, so
   * it must not pay that cost once per subtask.
   */
  listAgents({ versions = true } = {}) {
    const db = getDatabase();
    // Load custom configured paths or agents from DB
    const customConfigRow = db.prepare("SELECT value FROM app_config WHERE key = 'custom_agents'").get();
    let customAgents = [];
    if (customConfigRow) {
      try {
        customAgents = JSON.parse(customConfigRow.value);
      } catch {
        customAgents = [];
      }
    }

    const allDefs = [...this.builtinAgents, ...customAgents];

    return allDefs.map((def) => {
      const resolvedPath = this.findBinary(def.binaryName, def.customPath);
      const version = resolvedPath && versions ? this.getBinaryVersion(resolvedPath, def.versionArg) : null;
      // Full detection requires a working CLI; the mission fast path only
      // checks executable presence and leaves version probes off the hot path.
      const installed = versions ? Boolean(version) : Boolean(resolvedPath);
      const managed = [AGENTS_DIR, path.join(os.homedir(), '.citadel/agents')]
        .some((root) => require('./agentLifecycle').isManaged(def.binaryName, root));

      return {
        id: def.id,
        name: def.name,
        binaryName: def.binaryName,
        description: def.description,
        installed,
        managed,
        detected: Boolean(resolvedPath),
        warning: def.id === 'codex' ? require('./agentLifecycle').codexDaemonWarning(os.homedir()) : null,
        path: resolvedPath,
        version,
        defaultArgs: def.defaultArgs || [],
        installCommand: def.installCommand || null,
      };
    });
  }

  /**
   * Get single agent by ID
   */
  getAgent(agentId, options = {}) {
    const list = this.listAgents(options);
    return list.find((a) => a.id === agentId) || null;
  }

  /**
   * Launch an agent inside a persistent terminal session for a specific project
   */
  launchAgent({ projectId, agentId, extraArgs = [] }) {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found in registry.`);
    }

    if (!agent.installed || !agent.path) {
      throw new Error(`Agent "${agent.name}" is not installed or not found in PATH.`);
    }

    const project = projectService.getProject(projectId);
    if (!project) {
      throw new Error('Project not found.');
    }

    // Safe structured arguments
    const safeExtraArgs = Array.isArray(extraArgs) ? extraArgs.filter((a) => typeof a === 'string') : [];
    const commandArgs = [...agent.defaultArgs, ...safeExtraArgs];

    // Create session
    const sessionName = `${agent.name} — ${project.name}`;
    const session = terminalManager.createSession({
      projectId: project.id,
      name: sessionName,
      cwd: project.path,
      agentId: agent.id,
    });

    // Write command into the terminal PTY with structured execution.
    // Every argument is shell-quoted so user-supplied extraArgs cannot inject commands.
    const activeSession = terminalManager.activePtySessions.get(session.sessionId);
    if (activeSession) {
      // Send execution to the newly started shell/tmux
      const fullCmd = [agent.path, ...commandArgs].map(shellQuote).join(' ');
      activeSession.ptyProcess.write(`${fullCmd}\r`);
    }

    return {
      session,
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version,
      },
      project: {
        id: project.id,
        name: project.name,
        path: project.path,
      },
    };
  }

  /** Build a quoted invocation of the fixed, isolated lifecycle helper. */
  buildInstallCommand(agent, action = 'install') {
    if (!/^[A-Za-z0-9._-]+$/.test(String(agent.binaryName || '')) || ['.', '..'].includes(agent.binaryName)) {
      throw new Error(`Invalid binary name for agent "${agent.name}".`);
    }
    const helper = path.resolve(__dirname, '../../scripts/manage-agent.js');
    // Only fixed catalogue entries may reach an installer or removal command.
    const builtin = this.builtinAgents.find((a) => a.id === agent.id);
    if (!builtin || !['install', 'reinstall', 'remove'].includes(action)) {
      throw new Error('Unknown agent or action.');
    }
    return [process.execPath, helper, action, builtin.id].map(shellQuote).join(' ');
  }

  /**
   * Manage a built-in CLI agent through the isolated lifecycle helper in a
   * fresh System Terminal session, so the user can watch the output live. The
   * command is a fixed server-side string (never user input), so there is no
   * shell-injection surface. It runs as the service user (not the privileged
   * System Terminal user) so the result lands in the shared AGENTS_DIR that
   * the service owns, then leaves a shell open to inspect the outcome.
   */
  installAgent({ agentId, action = 'install' }) {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found in registry.`);
    }
    if (action === 'install' && agent.installed) {
      throw new Error(`Agent "${agent.name}" is already installed.`);
    }
    if (!agent.installCommand) {
      throw new Error(`No automatic installer is available for "${agent.name}".`);
    }

    const script = this.buildInstallCommand(agent, action);
    if (action === 'remove' && !agent.managed) throw new Error('Only installations managed by Citadel can be removed.');
    const session = terminalManager.createSession({
      projectId: null,
      name: `${action} ${agent.name}`,
      agentId: null,
      command: '/bin/bash',
      args: ['-lc', `${script}\nexec /bin/bash -l`],
    });

    return {
      session,
      agent: { id: agent.id, name: agent.name, installCommand: agent.installCommand },
    };
  }
}

module.exports = new AgentRegistry();
