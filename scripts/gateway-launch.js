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
function nativeOpenCodeEnvironment(base) {
  const env = { ...base };
  delete env.CITADEL_GATEWAY_TOKEN;
  if (!env.OPENCODE_CONFIG_CONTENT) return env;
  try {
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    if (config.provider && typeof config.provider === 'object') {
      delete config.provider.citadel;
      if (!Object.keys(config.provider).length) delete config.provider;
    }
    if (Array.isArray(config.enabled_providers)) {
      config.enabled_providers = config.enabled_providers.filter(id => id !== 'citadel');
      if (!config.enabled_providers.length) delete config.enabled_providers;
    }
    if (Array.isArray(config.disabled_providers) && !config.disabled_providers.includes('citadel')) config.disabled_providers.push('citadel');
    if (typeof config.model === 'string' && config.model.startsWith('citadel/')) delete config.model;
    if (typeof config.small_model === 'string' && config.small_model.startsWith('citadel/')) delete config.small_model;
    for (const agent of Object.values(config.agent || {})) {
      if (typeof agent?.model === 'string' && agent.model.startsWith('citadel/')) delete agent.model;
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  } catch {
    delete env.OPENCODE_CONFIG_CONTENT;
  }
  return env;
}
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
function run(binary, args, env, failure) {
  const child = spawn(binary, args, { stdio: 'inherit', env });
  child.on('error', () => { console.error(failure); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
}
/** Resolve the native executable on PATH, skipping this shim, without shell evaluation. */
function nativeBinary(name, self) {
  const own = fs.realpathSync(self);
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, name)).find(candidate => {
    try {
      if (fs.realpathSync(candidate) === own) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch { return false; }
  });
}
/** A missing pointer means the gateway was disabled; a pointer to unreadable settings means it is enabled but stopped. */
function shimSettings(self) {
  let file;
  try { file = fs.readFileSync(path.join(path.dirname(self), 'current'), 'utf8').trim(); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile()) throw new Error();
  return { file, settings: JSON.parse(fs.readFileSync(file, 'utf8')) };
}
/**
 * Project shells only put this shim ahead of the native CLI. Deciding at run
 * time lets Settings changes apply to terminals that are already open: the
 * shell itself never carries gateway variables that could not be unset later.
 */
function clientShim(client) {
  const self = process.argv[1];
  const args = process.argv.slice(2);
  const binary = nativeBinary(client, self);
  if (!binary) {
    console.error(`Could not find native ${client}. Check its installation.`);
    process.exitCode = 127;
    return;
  }
  let launch;
  try { launch = shimSettings(self); } catch {
    console.error('AI Gateway is enabled but stopped. Restart it in Settings → AI Gateway, or disable it to use the native configuration.');
    process.exitCode = 1;
    return;
  }
  const active = launch && (client === 'claude' ? launch.settings.claudeEnabled !== false : launch.settings[`${client}Enabled`] === true);
  if (!active) {
    const env = client === 'opencode' ? nativeOpenCodeEnvironment(process.env) : { ...process.env };
    if (client === 'opencode' && !launch) delete env.CITADEL_GATEWAY_TOKEN;
    return run(binary, args, env, `Could not launch ${client}.`);
  }
  main([launch.file, '--client', client, binary, ...args]);
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
    let env = { ...process.env };
    if (shellMode) {
      if (!settings.binDir) throw new Error();
      console.error(`[Citadel] AI Gateway active for this project terminal: stable model aliases; routing at launch: ${settings.mode || 'chatgpt'}. Change routes in Settings → AI Gateway.`);
      if (settings.opencodeEnabled) console.error('[Citadel] OpenCode Gateway active: Plan uses planning, Build uses execution; switch with Tab.');
      if (settings.codexEnabled) console.error('[Citadel] Codex AI Gateway active for this project terminal (Responses).');
      run(binary, args, { ...env, PATH: `${settings.binDir}${path.delimiter}${env.PATH || ''}` }, 'Could not launch agent through AI Gateway.');
      return;
    }
    if (client === 'claude' ? settings.claudeEnabled === false : !settings[`${client}Enabled`]) throw new Error();
    if (client === 'opencode') env = opencodeEnvironment(env, settings);
    else if (client === 'claude') env = gatewayEnvironment(env, settings);
    let childArgs = client === 'claude' ? ['--model', 'opusplan', ...args] : args;
    if (client === 'codex') ({ env, args: childArgs } = codexLaunch(env, settings, args));
    run(binary, childArgs, env, 'Could not launch agent through AI Gateway.');
  } catch {
    console.error('AI Gateway launch settings are unavailable. Check Settings → AI Gateway.');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { gatewayEnvironment, opencodeEnvironment, nativeOpenCodeEnvironment, codexLaunch, clientShim };
