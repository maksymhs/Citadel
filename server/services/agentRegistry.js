/**
 * Citadel CLI Agent Registry & Launcher
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { getDatabase } = require('../database/db');
const { TERMINAL_ADMIN_USER } = require('../config');
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

class AgentRegistry {
  constructor() {
    this.builtinAgents = [
      {
        id: 'claude',
        name: 'Claude Code',
        binaryName: 'claude',
        description: "Anthropic's CLI coding and engineering agent",
        defaultArgs: [],
        versionArg: '--version',
        installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        binaryName: 'codex',
        description: 'CLI tool for code assistance and generation',
        defaultArgs: [],
        versionArg: '--version',
        installCommand: 'npm install -g --prefix "$HOME/.local" @openai/codex',
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        binaryName: 'opencode',
        description: 'Open-source interactive coding agent for developers',
        defaultArgs: [],
        versionArg: '--version',
        installCommand: 'curl -fsSL https://opencode.ai/install | bash',
      },
    ];
  }

  /**
   * Search for binary across PATH and typical installation directories
   */
  findBinary(binaryName, customPath = null) {
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }

    // Try `which` first
    try {
      const res = spawnSync('which', [binaryName], { encoding: 'utf8' });
      if (res.status === 0 && res.stdout) {
        const found = res.stdout.trim().split('\n')[0];
        if (fs.existsSync(found)) {
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

    const candidatePaths = [];
    for (const home of homes) {
      candidatePaths.push(
        path.join(home, '.local', 'bin', binaryName),
        path.join(home, '.npm-global', 'bin', binaryName),
        path.join(home, '.opencode', 'bin', binaryName),
        path.join(home, '.cargo', 'bin', binaryName),
        path.join(home, 'bin', binaryName)
      );
    }
    candidatePaths.push(
      `/usr/local/bin/${binaryName}`,
      `/usr/bin/${binaryName}`,
      `/bin/${binaryName}`
    );

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
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
   * Get all registered agents with their live detection status
   */
  listAgents() {
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
      const installed = Boolean(resolvedPath);
      const version = installed ? this.getBinaryVersion(resolvedPath, def.versionArg) : null;

      return {
        id: def.id,
        name: def.name,
        binaryName: def.binaryName,
        description: def.description,
        installed,
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
  getAgent(agentId) {
    const list = this.listAgents();
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

  /**
   * Install a CLI agent by running its official one-line installer inside a
   * fresh System Terminal session, so the user can watch the output live. The
   * command is a fixed server-side string (never user input), so there is no
   * shell-injection surface.
   */
  installAgent({ agentId }) {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found in registry.`);
    }
    if (agent.installed) {
      throw new Error(`Agent "${agent.name}" is already installed.`);
    }
    if (!agent.installCommand) {
      throw new Error(`No automatic installer is available for "${agent.name}".`);
    }

    const session = terminalManager.createSession({
      projectId: null,
      name: `Install ${agent.name}`,
      agentId: null,
    });

    const activeSession = terminalManager.activePtySessions.get(session.sessionId);
    if (activeSession) {
      activeSession.ptyProcess.write(`${agent.installCommand}\r`);
    }

    return {
      session,
      agent: { id: agent.id, name: agent.name, installCommand: agent.installCommand },
    };
  }
}

module.exports = new AgentRegistry();
