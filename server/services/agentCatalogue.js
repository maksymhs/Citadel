/**
 * Fixed catalogue of supported CLI agents and official install commands.
 */
module.exports = [
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
