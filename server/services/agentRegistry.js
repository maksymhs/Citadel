/**
 * Citadel CLI Agent Registry & Launcher
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { getDatabase } = require('../database/db');
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
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        binaryName: 'codex',
        description: 'CLI tool for code assistance and generation',
        defaultArgs: [],
        versionArg: '--version',
      },
      {
        id: 'opencode',
        name: 'OpenCode',
        binaryName: 'opencode',
        description: 'Open-source interactive coding agent for developers',
        defaultArgs: [],
        versionArg: '--version',
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

    // Common user and system paths
    const home = os.homedir();
    const candidatePaths = [
      path.join(home, '.local', 'bin', binaryName),
      path.join(home, '.npm-global', 'bin', binaryName),
      path.join(home, '.cargo', 'bin', binaryName),
      `/usr/local/bin/${binaryName}`,
      `/usr/bin/${binaryName}`,
      `/bin/${binaryName}`,
    ];

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
}

module.exports = new AgentRegistry();
