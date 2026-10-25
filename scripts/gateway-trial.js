#!/usr/bin/env node
// Dev-only Claude Code / CLIProxyAPI protocol trial; no provider credentials or Citadel data.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const binary = process.env.GATEWAY_TRIAL_BINARY;
  if (!binary || !path.isAbsolute(binary)) throw new Error('Set GATEWAY_TRIAL_BINARY to the absolute CLIProxyAPI v8.0.43 binary path.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-gateway-test-'));
  const children = [];
  const requests = [];
  const outputPath = path.join(root, 'workspace', 'proof.txt');
  fs.mkdirSync(path.dirname(outputPath));
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.model === 'fixture-primary') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Injected fixture rate limit', type: 'rate_limit_error' } }));
      return;
    }
    const completed = body.messages?.some(m => m.role === 'tool');
    const tool = body.tools?.find(t => t.function?.name === 'Write');
    const message = completed || !tool
      ? { role: 'assistant', content: 'GATEWAY_TRIAL_OK' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-write-1', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: outputPath, content: 'gateway proof\n' }) } }] };
    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [{ index: 0, delta: message, finish_reason: null }, { index: 0, delta: {}, finish_reason: finish }]) {
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [choice] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  });
  const reservation = http.createServer();
  try {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    // JSON is a YAML subset. All credentials below are local fixtures.
    const config = {
      'config-version': 8,
      server: { host: '127.0.0.1', port, discovery: { enabled: false } },
      management: { 'secret-key': '', 'disable-control-panel': true, 'disable-auto-update-panel': true },
      access: { 'api-keys': ['citadel-fixture-only'] },
      oauth: { 'auth-dir': path.join(root, 'auth') },
      routing: { strategy: 'fill-first', retry: { 'request-retry': 0, 'max-retry-interval': 0 } },
      'api-keys': { 'openai-compatibility': [{ name: 'fixture', 'base-url': `http://127.0.0.1:${upstream.address().port}/v1`, keys: [{ 'api-key': 'fixture-upstream' }], models: [{ name: 'fixture-primary', alias: 'trial-model' }, { name: 'fixture-secondary', alias: 'trial-model' }] }] }
    };
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const gateway = spawn(binary, ['--config', configPath, '--local-model'], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(gateway);
    let gatewayLog = '';
    gateway.stdout.on('data', chunk => { gatewayLog += chunk; });
    gateway.stderr.on('data', chunk => { gatewayLog += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer citadel-fixture-only' } }); if (res.ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Gateway did not start: ${gatewayLog.slice(-2000)}`);
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${base}/v8/management/config`)).status, 404);
    const claude = spawn(process.env.GATEWAY_TRIAL_CLAUDE || 'claude', ['-p', `Use Write exactly once to write "gateway proof" followed by a newline to ${outputPath}. Then say GATEWAY_TRIAL_OK.`, '--model', 'trial-model', '--output-format', 'json', '--tools', 'Write', '--allowedTools', 'Write', '--permission-mode', 'acceptEdits', '--setting-sources', ''], {
      cwd: path.dirname(outputPath),
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'citadel-fixture-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(claude);
    let clientOutput = '';
    claude.stdout.on('data', chunk => { clientOutput += chunk; });
    claude.stderr.on('data', chunk => { clientOutput += chunk; });
    const timeout = setTimeout(() => claude.kill('SIGTERM'), 45000);
    const [code] = await once(claude, 'exit');
    clearTimeout(timeout);
    assert.equal(code, 0, `Claude trial failed: ${clientOutput.slice(-2000)}`);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'gateway proof\n');
    assert.ok(clientOutput.includes('GATEWAY_TRIAL_OK'));
    assert.ok(requests.some(r => r.model === 'fixture-primary'), '429 source was not exercised');
    assert.ok(requests.some(r => r.model === 'fixture-secondary'), 'Fallback was not exercised');
    assert.ok(requests.some(r => r.messages?.some(m => m.role === 'tool' && m.tool_call_id === 'fixture-write-1')), 'Tool result/context did not reach upstream');
    console.log(JSON.stringify({ passed: true, realClaudeClient: true, injected429: true, toolResultRoundTrip: true, liveProvider: false, requests: requests.length }));
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
    upstream.closeAllConnections();
    upstream.close();
    reservation.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
