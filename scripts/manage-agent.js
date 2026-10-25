#!/usr/bin/env node
/**
 * Run a fixed agent lifecycle action in the service user's terminal.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const catalogue = require('../server/services/agentCatalogue');
const { run, isManaged } = require('../server/services/agentLifecycle');
const [action, id] = process.argv.slice(2);
try {
  const agent = catalogue.find((item) => item.id === id);
  if (!agent) throw new Error('Unknown agent.');
  let root = process.env.CITADEL_AGENTS_DIR || '/opt/citadel/agents';
  const fallback = path.join(os.homedir(), '.citadel/agents');
  if (action === 'remove' && !isManaged(agent.binaryName, root) && isManaged(agent.binaryName, fallback)) root = fallback;
  try { fs.mkdirSync(root, { recursive: true }); fs.accessSync(root, fs.constants.W_OK); }
  catch {
    if (action === 'remove') throw new Error('Managed installation directory is not writable.');
    root = path.join(os.homedir(), '.citadel/agents');
    console.log(`[Citadel] Shared directory unavailable; using ${root} for this account only.`);
  }
  run(agent, action, root);
} catch (error) {
  console.error(`[Citadel] ${error.message}`);
  process.exitCode = 1;
}
