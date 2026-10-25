/**
 * AI coding agent integrations.
 *
 * Detects whether the supported coding-agent CLIs are installed and installs
 * them from a fixed, server-side catalogue: the client can only ask to install
 * a known built-in tool by id — it can never supply a raw command — so the
 * panel cannot be turned into an arbitrary command runner.
 *
 * Detection and installation are delegated to the agent registry so the
 * dashboard, the agents API and the fleet all agree on where an agent lives
 * (the shared AGENTS_DIR) and how it is installed.
 */
const agentRegistry = require('./agentRegistry');

function getAgent(id) {
  return agentRegistry.builtinAgents.find((a) => a.id === id) || null;
}

/**
 * Describe each supported agent and whether its CLI is present on the host.
 */
function detectAgents() {
  const builtin = new Set(agentRegistry.builtinAgents.map((a) => a.id));
  return agentRegistry.listAgents()
    .filter((agent) => builtin.has(agent.id))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      available: agent.installed,
      version: agent.version,
      managed: agent.managed,
      detected: agent.detected,
      warning: agent.warning,
    }));
}

/**
 * Start the shared, all-users install of a built-in agent in a terminal
 * session. Returns `{ session, agent }`.
 */
function installAgent(id, action = 'install') {
  const agent = getAgent(id);
  if (!agent) throw new Error('Unknown tool.');
  return agentRegistry.installAgent({ agentId: agent.id, action });
}

module.exports = { getAgent, detectAgents, installAgent };
