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
    // Install commands run with HOME pointed at the shared agents directory
    // (see buildInstallCommand), so "$HOME" below means AGENTS_DIR.
    this.builtinAgents = [
      {
        id: 'opencode',
        name: 'OpenCode',
        binaryName: 'opencode',
        description: 'Open-source interactive coding agent for developers',
        defaultArgs: [],
        versionArg: '--version',
        installCommand: 'curl -fsSL https://opencode.ai/install | bash',
      },
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
        // A user prefix: the global npm prefix (/usr) is read-only for the
        // service user and inside the systemd sandbox.
        installCommand: 'npm install -g --prefix "$HOME/.local" @openai/codex',
      },
      {
        id: 'antigravity',
        name: 'Antigravity CLI',
        binaryName: 'agy',
        description: "Google's Antigravity terminal coding agent",
        defaultArgs: [],
        versionArg: '--version',
        installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      },
      {
        id: 'kilocode',
        name: 'Kilo Code CLI',
        binaryName: 'kilo',
        description: 'Open-source agentic coding CLI from Kilo Code',
        defaultArgs: [],
        versionArg: '--version',
        installCommand: 'npm install -g --prefix "$HOME/.local" @kilocode/cli',
      },
      {
        id: 'qwen',
        name: 'Qwen Code',
        binaryName: 'qwen',
        description: "Alibaba's open-source terminal coding agent",
        defaultArgs: [],
        versionArg: '--version',
        installCommand: 'npm install -g --prefix "$HOME/.local" @qwen-code/qwen-code',
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
   * Build the fixed shell script that installs one agent for every user.
   * Pure (no side effects) so it can be unit-tested. The only interpolated
   * values are the server-controlled AGENTS_DIR, the agent's display name
   * (quoted) and the validated binary name.
   *
   * It always runs as the service user, which owns AGENTS_DIR (prepared by
   * install.sh), so no sudo is involved: the systemd unit sets
   * NoNewPrivileges and the service account has no sudo rights anyway.
   *
   *  1. Point HOME at the shared, world-readable AGENTS_DIR (falling back to
   *     ~/.citadel/agents when it is not writable) inside a subshell, so the
   *     official installer's per-user drops land there and the override never
   *     leaks into the interactive shell left open afterwards.
   *  2. Put the target bin directories on PATH so installers that verify PATH
   *     (Claude Code, Antigravity) do not stop to ask for shell-profile edits.
   *  3. Fail loudly when the download/installer fails (pipefail) or produces
   *     no binary, relax permissions and link the binary into AGENTS_DIR/bin,
   *     which every Citadel terminal and /etc/profile.d puts on PATH.
   */
  buildInstallCommand(agent) {
    const bin = String(agent.binaryName || '');
    if (!/^[A-Za-z0-9._-]+$/.test(bin)) {
      throw new Error(`Invalid binary name for agent "${agent.name}".`);
    }

    const sources = AGENT_BIN_SUBDIRS.filter((sub) => sub !== 'bin').map((sub) => `"$AG/${sub}/${bin}"`).join(' ');
    return [
      '(',
      'set -o pipefail',
      `NAME=${shellQuote(agent.name)}`,
      `AG=${shellQuote(AGENTS_DIR)}`,
      'SCOPE="every user"',
      'mkdir -p "$AG" 2>/dev/null',
      'if [ ! -w "$AG" ]; then',
      '  echo "[Citadel] $AG is not writable by $(id -un); installing under ~/.citadel/agents (only this account will see it)."',
      '  echo "[Citadel] Re-run the Citadel installer to share agents with every user."',
      '  SCOPE="this account only"',
      '  AG="$HOME/.citadel/agents"',
      '  mkdir -p "$AG" || exit 1',
      'fi',
      'export HOME="$AG"',
      'unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME XDG_BIN_HOME',
      `export PATH="${AGENT_BIN_SUBDIRS.map((sub) => `$AG/${sub}`).join(':')}:$PATH"`,
      'cd "$AG" || exit 1',
      'echo "[Citadel] Installing $NAME into $AG ..."',
      `${agent.installCommand} || { status=$?; echo "[Citadel] $NAME installer failed (exit $status)."; exit 1; }`,
      'chmod -R a+rX "$AG" 2>/dev/null',
      'mkdir -p "$AG/bin"',
      'found=""',
      `for b in ${sources}; do`,
      `  if [ -x "$b" ]; then ln -sfn "$b" "$AG/bin/${bin}"; found="$b"; break; fi`,
      'done',
      `[ -n "$found" ] || { echo "[Citadel] $NAME installer finished but no '${bin}' binary was found under $AG."; exit 1; }`,
      `echo "[Citadel] $NAME installed for $SCOPE: $AG/bin/${bin}"`,
      ')',
      'echo',
      'echo "[Citadel] Reload the panel to refresh the agent status."',
    ].join('\n');
  }

  /**
   * Install a CLI agent by running its official one-line installer inside a
   * fresh System Terminal session, so the user can watch the output live. The
   * command is a fixed server-side string (never user input), so there is no
   * shell-injection surface. It runs as the service user (not the privileged
   * System Terminal user) so the result lands in the shared AGENTS_DIR that
   * the service owns, then leaves a shell open to inspect the outcome.
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
      command: '/bin/bash',
      args: ['-lc', `${this.buildInstallCommand(agent)}\nexec /bin/bash -l`],
    });

    return {
      session,
      agent: { id: agent.id, name: agent.name, installCommand: agent.installCommand },
    };
  }
}

module.exports = new AgentRegistry();
