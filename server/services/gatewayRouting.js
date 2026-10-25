/** Stable client aliases and explicit provider policy for the local gateway. */
const ALIASES = Object.freeze({ planning: 'citadel-planning', execution: 'citadel-execution', small: 'citadel-small' });
const DEFAULTS = Object.freeze({ mode: 'chatgpt', contextTokens: 200000,
  claudePlanningModel: 'claude-opus-5-5', claudeExecutionModel: 'claude-sonnet-5-5', claudeSmallModel: 'claude-haiku-5-5' });
function providerOf(name, metadata) {
  if (metadata.type === 'claude' || metadata.type === 'anthropic') return 'claude';
  if (metadata.type === 'codex' || (!metadata.type && name.startsWith('codex-'))) return 'codex';
  return null;
}
function aliasesFor(config) {
  const aliases = {};
  if (config.mode !== 'claude') aliases.codex = [
    { name: config.planningModel, alias: ALIASES.planning, fork: true },
    { name: config.executionModel, alias: ALIASES.execution, fork: true },
    { name: config.smallModel, alias: ALIASES.small, fork: true },
  ];
  if (config.mode !== 'chatgpt') aliases.claude = [
    { name: config.claudePlanningModel, alias: ALIASES.planning, fork: true },
    { name: config.claudeExecutionModel, alias: ALIASES.execution, fork: true },
    { name: config.claudeSmallModel, alias: ALIASES.small, fork: true },
  ];
  return aliases;
}
function errorRules() {
  // Surface invalid requests, authentication, billing and policy denials. Only
  // quota/availability failures should reach the next configured provider.
  return [400, 401, 402, 403, 404, 413].map(status => ({ status, 'match-regexr': ['(?s).*'], action: 'stop' }));
}
function requireConnections(config, connections) {
  if (config.mode !== 'claude' && !connections.codex) throw new Error('Connect ChatGPT before enabling this mode.');
  if (config.mode !== 'chatgpt' && !connections.claude) throw new Error('Connect Claude before enabling this mode.');
}
module.exports = { ALIASES, DEFAULTS, providerOf, aliasesFor, errorRules, requireConnections };
