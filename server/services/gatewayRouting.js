/** Stable client aliases and explicit provider policy for the local gateway. */
const ALIASES = Object.freeze({ planning: 'citadel-planning', execution: 'citadel-execution', small: 'citadel-small' });
const ROLES = Object.freeze([
  { key: 'planning', provider: 'planningProvider', codexModel: 'planningModel', claudeModel: 'claudePlanningModel' },
  { key: 'execution', provider: 'executionProvider', codexModel: 'executionModel', claudeModel: 'claudeExecutionModel' },
  { key: 'small', provider: 'smallProvider', codexModel: 'smallModel', claudeModel: 'claudeSmallModel' },
]);
const DEFAULTS = Object.freeze({ mode: 'chatgpt', contextTokens: 1000000,
  claudePlanningModel: 'claude-opus-5-5', claudeExecutionModel: 'claude-sonnet-5-5', claudeSmallModel: 'claude-haiku-5-5',
  planningProvider: 'claude', executionProvider: 'codex', smallProvider: 'codex' });
// 'auto' keeps its historical meaning (Claude first); 'auto-chatgpt' reverses it.
// 'roles' pins each role to one provider with no fallback; 'balanced' behaves like
// an auto mode whose first provider follows the remaining subscription headroom.
const MODES = Object.freeze(['chatgpt', 'claude', 'auto', 'auto-chatgpt', 'roles', 'balanced']);
const ROLE_PROVIDERS = Object.freeze(['claude', 'codex']);
const BALANCE = Object.freeze({ minDifference: 15, minIntervalMs: 30 * 60 * 1000, maxUsageAgeMs: 10 * 60 * 1000, defaultPrimary: 'claude' });

function priorityFor(mode, provider, balancedPrimary = BALANCE.defaultPrimary) {
  if (mode === 'roles') return 100;
  const first = mode === 'auto-chatgpt' ? 'codex' : mode === 'balanced' ? balancedPrimary : 'claude';
  return provider === first ? 100 : 50;
}
function providerOf(name, metadata) {
  if (metadata.type === 'claude' || metadata.type === 'anthropic') return 'claude';
  if (metadata.type === 'codex' || (!metadata.type && name.startsWith('codex-'))) return 'codex';
  return null;
}
function rolesFor(config) {
  return ROLES.map(role => ({ ...role, assigned: config[role.provider] }));
}
function aliasesFor(config) {
  const aliases = {};
  if (config.mode === 'roles') {
    for (const role of rolesFor(config)) {
      if (role.assigned === 'codex') (aliases.codex ||= []).push({ name: config[role.codexModel], alias: ALIASES[role.key], fork: true });
      else if (role.assigned === 'claude') (aliases.claude ||= []).push({ name: config[role.claudeModel], alias: ALIASES[role.key], fork: true });
    }
    return aliases;
  }
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
  if (config.mode === 'roles') {
    const used = new Set(rolesFor(config).map(role => role.assigned));
    if (used.has('codex') && !connections.codex) throw new Error('Connect ChatGPT before enabling this mode.');
    if (used.has('claude') && !connections.claude) throw new Error('Connect Claude before enabling this mode.');
    return;
  }
  if (config.mode !== 'claude' && !connections.codex) throw new Error('Connect ChatGPT before enabling this mode.');
  if (config.mode !== 'chatgpt' && !connections.claude) throw new Error('Connect Claude before enabling this mode.');
}

// Free percentage of the tightest window on the best account, or null when the
// provider reported nothing usable or the reading is too old to act on.
function headroomFrom(usage, now = Date.now()) {
  if (!usage || !Array.isArray(usage.accounts)) return null;
  const fetched = Date.parse(usage.fetchedAt || '');
  if (!Number.isFinite(fetched) || now - fetched > BALANCE.maxUsageAgeMs || usage.stale) return null;
  let best = null;
  for (const account of usage.accounts) {
    const used = (account.windows || []).map(window => window.usedPercent).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
    if (!used.length) continue;
    const free = 100 - Math.max(...used);
    if (best === null || free > best) best = free;
  }
  return best;
}
// Hysteresis (difference + minimum interval) prevents flapping between
// providers on small or noisy readings. Missing data never causes a switch.
function chooseBalancedPrimary({ headroom, current = BALANCE.defaultPrimary, switchedAt = 0, now = Date.now() }) {
  const other = current === 'claude' ? 'codex' : 'claude';
  const mine = headroom?.[current];
  const theirs = headroom?.[other];
  if (typeof mine !== 'number' || typeof theirs !== 'number') return { primary: current, switched: false, reason: 'Usage unavailable; keeping the current primary.' };
  if (theirs - mine < BALANCE.minDifference) return { primary: current, switched: false, reason: 'Headroom is similar; keeping the current primary.' };
  if (now - switchedAt < BALANCE.minIntervalMs) return { primary: current, switched: false, reason: 'Switched recently; waiting before changing again.' };
  return { primary: other, switched: true, reason: `${other === 'claude' ? 'Claude' : 'ChatGPT'} has more headroom (${Math.round(theirs)}% free vs ${Math.round(mine)}%).` };
}
module.exports = { ALIASES, ROLES, DEFAULTS, MODES, ROLE_PROVIDERS, BALANCE, priorityFor, providerOf, aliasesFor, errorRules, requireConnections, headroomFrom, chooseBalancedPrimary };
