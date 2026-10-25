#!/usr/bin/env node
/** Starts one Claude Code process with scoped gateway settings; no credentials in argv. */
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function gatewayEnvironment(base, settings) {
  const env = { ...base };
  // Avoid inherited credentials/provider selections overriding the local gateway.
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY))/.test(name)) delete env[name];
  }
  return { ...env, ANTHROPIC_BASE_URL: settings.baseUrl, ANTHROPIC_AUTH_TOKEN: settings.token,
    ANTHROPIC_MODEL: 'opusplan', ANTHROPIC_DEFAULT_OPUS_MODEL: settings.planningModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: settings.executionModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.smallModel,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
function main() {
  const [file, binary, ...args] = process.argv.slice(2);
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!binary || !settings.token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.baseUrl)) throw new Error();
    const child = spawn(binary, ['--model', 'opusplan', ...args], { stdio: 'inherit', env: gatewayEnvironment(process.env, settings) });
    child.on('error', () => { console.error('Could not launch Claude Code through AI Gateway.'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  } catch {
    console.error('AI Gateway launch settings are unavailable. Check Settings → AI Gateway.');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { gatewayEnvironment };
