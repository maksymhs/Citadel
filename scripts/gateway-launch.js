#!/usr/bin/env node
/** Starts Claude Code, OpenCode or a project shell with scoped gateway settings; no credentials in argv. */
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function gatewayEnvironment(base, settings) {
  const env = { ...base };
  // Avoid inherited credentials/provider selections overriding the local gateway.
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY))/.test(name)) delete env[name];
  }
  return { ...env, ANTHROPIC_BASE_URL: settings.baseUrl, ANTHROPIC_AUTH_TOKEN: settings.token,
    ANTHROPIC_MODEL: 'opusplan', ANTHROPIC_DEFAULT_OPUS_MODEL: settings.aliases?.planning || settings.planningModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: settings.aliases?.execution || settings.executionModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.aliases?.small || settings.smallModel,
    ...(settings.contextTokens ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(settings.contextTokens) } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
/** Runtime-only OpenCode overrides; never write credentials into project/global config. */
function opencodeEnvironment(base, settings) {
  const existing = base.OPENCODE_CONFIG_CONTENT ? JSON.parse(base.OPENCODE_CONFIG_CONTENT) : {};
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Invalid OpenCode inline configuration.');
  const aliases = settings.aliases || { planning: 'citadel-planning', execution: 'citadel-execution', small: 'citadel-small' };
  const model = role => `citadel/${aliases[role]}`;
  const context = settings.contextTokens || 1000000;
  const output = Math.min(16000, Math.floor(context / 4));
  const reserved = Math.min(16000, Math.floor(context / 8));
  const models = Object.fromEntries(Object.entries(aliases).map(([role, id]) => [id, {
    name: `Citadel ${role}`, limit: { context, output },
  }]));
  const config = { ...existing, model: model('execution'), small_model: model('small'),
    enabled_providers: ['citadel'],
    disabled_providers: (existing.disabled_providers || []).filter(id => id !== 'citadel'),
    provider: { ...existing.provider, citadel: { npm: '@ai-sdk/openai-compatible', name: 'Citadel Gateway',
      options: { baseURL: `${settings.baseUrl}/v1`, apiKey: '{env:CITADEL_GATEWAY_TOKEN}' }, models } },
    agent: { ...existing.agent,
      plan: { ...existing.agent?.plan, model: model('planning') },
      build: { ...existing.agent?.build, model: model('execution') } },
    compaction: { ...existing.compaction, auto: true, prune: true, reserved },
  };
  return { ...base, CITADEL_GATEWAY_TOKEN: settings.token, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
function main() {
  const input = process.argv.slice(2);
  const shellMode = input[0] === '--shell';
  const launch = shellMode ? input.slice(1) : input;
  const file = launch.shift();
  let client = 'claude';
  if (!shellMode && launch[0] === '--client') { launch.shift(); client = launch.shift(); }
  const [binary, ...args] = launch;
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!['claude', 'opencode'].includes(client) || !binary || !settings.token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.baseUrl)) throw new Error();
    if (shellMode) console.error(`[Citadel] Claude Code Gateway active for this project terminal: stable model aliases; routing at launch: ${settings.mode || 'chatgpt'}. Change routes in Settings → Claude Code Gateway.`);
    if (client === 'opencode' && !settings.opencodeEnabled) throw new Error();
    let env = client === 'opencode' ? opencodeEnvironment(process.env, settings) : gatewayEnvironment(process.env, settings);
    if (shellMode && settings.opencodeEnabled) env = opencodeEnvironment(env, settings);
    if (shellMode && settings.opencodeEnabled) console.error('[Citadel] OpenCode Gateway active: Plan uses planning, Build uses execution; switch with Tab.');
    const child = spawn(binary, shellMode || client === 'opencode' ? args : ['--model', 'opusplan', ...args], { stdio: 'inherit', env });
    child.on('error', () => { console.error('Could not launch agent through AI Gateway.'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  } catch {
    console.error('AI Gateway launch settings are unavailable. Check Settings → Claude Code Gateway.');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { gatewayEnvironment, opencodeEnvironment };
