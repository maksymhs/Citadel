#!/usr/bin/env node
/** Starts Claude Code, OpenCode, Codex or a project shell with scoped gateway settings; no credentials in argv. */
const fs = require('node:fs');
const path = require('node:path');
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
/** Codex uses Responses with per-process config overrides and a local proxy key. */
function codexLaunch(base, settings, args = []) {
  const values = { model_provider: 'citadel', model: settings.aliases?.execution || 'citadel-execution',
    'model_providers.citadel.name': 'Citadel Gateway',
    'model_providers.citadel.base_url': `${settings.baseUrl}/v1`,
    'model_providers.citadel.env_key': 'CITADEL_GATEWAY_TOKEN',
    'model_providers.citadel.wire_api': 'responses',
    'model_providers.citadel.requires_openai_auth': false,
    'model_providers.citadel.supports_websockets': false,
    model_context_window: settings.contextTokens || 1000000 };
  return { env: { ...base, CITADEL_GATEWAY_TOKEN: settings.token },
    args: [...Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), ...args] };
}
/** Resolve the native Codex binary outside the private shim PATH, without shell evaluation. */
function codexShell() {
  try {
    const nativePath = process.env.CITADEL_GATEWAY_NATIVE_PATH;
    const file = process.env.CITADEL_GATEWAY_LAUNCH_FILE;
    if (!nativePath || !file) throw new Error();
    const binary = nativePath.split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, 'codex')).find(candidate => {
      try {
        if (fs.realpathSync(candidate) === fs.realpathSync(process.argv[1])) return false;
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch { return false; }
    });
    if (!binary) throw new Error();
    main([file, '--client', 'codex', binary, ...process.argv.slice(2)]);
  } catch {
    console.error('Could not find native Codex for AI Gateway. Check its installation and open a new project terminal.');
    process.exitCode = 1;
  }
}
function main(input = process.argv.slice(2)) {
  const shellMode = input[0] === '--shell';
  const launch = shellMode ? input.slice(1) : input;
  const file = launch.shift();
  let client = 'claude';
  if (!shellMode && launch[0] === '--client') { launch.shift(); client = launch.shift(); }
  const [binary, ...args] = launch;
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!['claude', 'opencode', 'codex'].includes(client) || !binary || !settings.token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.baseUrl)) throw new Error();
    if (shellMode) console.error(`[Citadel] AI Gateway active for this project terminal: stable model aliases; routing at launch: ${settings.mode || 'chatgpt'}. Change routes in Settings → AI Gateway.`);
    if (!shellMode && (client === 'claude' ? settings.claudeEnabled === false : !settings[`${client}Enabled`])) throw new Error();
    let env = { ...process.env };
    if (client === 'opencode') env = opencodeEnvironment(env, settings);
    else if (client === 'claude' && (!shellMode || settings.claudeEnabled !== false)) env = gatewayEnvironment(env, settings);
    let childArgs = shellMode || client !== 'claude' ? args : ['--model', 'opusplan', ...args];
    if (client === 'codex') ({ env, args: childArgs } = codexLaunch(env, settings, args));
    if (shellMode && settings.opencodeEnabled) env = opencodeEnvironment(env, settings);
    if (shellMode && settings.opencodeEnabled) console.error('[Citadel] OpenCode Gateway active: Plan uses planning, Build uses execution; switch with Tab.');
    if (shellMode && settings.codexEnabled) {
      env = { ...env, CITADEL_GATEWAY_NATIVE_PATH: env.PATH, CITADEL_GATEWAY_LAUNCH_FILE: file,
        PATH: `${settings.codexBinDir}${path.delimiter}${env.PATH || ''}` };
      console.error('[Citadel] Codex AI Gateway active for this project terminal (Responses).');
    }
    const child = spawn(binary, childArgs, { stdio: 'inherit', env });
    child.on('error', () => { console.error('Could not launch agent through AI Gateway.'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  } catch {
    console.error('AI Gateway launch settings are unavailable. Check Settings → AI Gateway.');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { gatewayEnvironment, opencodeEnvironment, codexLaunch, codexShell };
