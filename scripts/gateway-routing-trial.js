#!/usr/bin/env node
/** Isolated CLIProxyAPI hot-swap / cross-provider quota fallback trial; fixture credentials only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
async function main() {
  const binary = process.env.GATEWAY_TRIAL_BINARY;
  if (!binary || !path.isAbsolute(binary)) throw new Error('Set GATEWAY_TRIAL_BINARY to CLIProxyAPI v8.0.43 (absolute path).');
  const atomic = process.env.GATEWAY_TRIAL_ATOMIC === '1';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-routing-trial-'));
  const seen = [];
  let primaryQuota = false, secondaryQuota = false, releaseHeld = null, child;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const primary = req.url.startsWith('/claude/');
    seen.push({ primary, model: body.model, messages: body.messages });
    if ((primary && primaryQuota) || (!primary && secondaryQuota)) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Fixture quota exhausted' } })); return;
    }
    const send = () => {
      const text = `MODEL:${body.model}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (primary) {
          const events = [
            ['message_start', { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }],
            ['message_stop', { type: 'message_stop' }],
          ];
          for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } else {
          for (const [delta, finish] of [[{ role: 'assistant', content: text }, null], [{}, 'stop']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        res.end(); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(primary
        ? { id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }
        : { id: 'fixture', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    };
    if (primary && JSON.stringify(body.messages).includes('HOLD_FIXTURE')) releaseHeld = send;
    else send();
  });
  const reservation = http.createServer();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(100); } throw new Error('Timed out waiting for route reload.'); }
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const mock = `http://127.0.0.1:${upstream.address().port}`;
    const configFile = path.join(root, 'config.json');
    const stableAlias = 'citadel-execution';
    function configure(mode) {
      const groups = {};
      if (mode !== 'chatgpt') groups.claude = [{ name: 'fixture-claude', priority: 100, 'base-url': `${mock}/claude`, keys: [{ 'api-key': 'fixture-primary-key' }], models: [{ name: 'claude-fixture', alias: stableAlias }] }];
      if (mode !== 'claude') groups['openai-compatibility'] = [{ name: 'fixture-openai', priority: 50, 'base-url': `${mock}/openai/v1`, keys: [{ 'api-key': 'fixture-secondary-key' }], models: [{ name: 'gpt-fixture', alias: stableAlias }] }];
      const config = {
        'config-version': 8, server: { host: '127.0.0.1', port, 'commercial-mode': true, discovery: { enabled: false } },
        management: { 'secret-key': '', 'disable-control-panel': true, 'disable-auto-update-panel': true },
        access: { 'api-keys': ['fixture-client-key'] }, oauth: { 'auth-dir': path.join(root, 'auth') },
        routing: { strategy: 'fill-first', 'session-affinity': true, 'session-affinity-rebind-on': 'quota', retry: { 'request-retry': 0, 'max-retry-interval': 0 } },
        'api-keys': groups,
      };
      // The pinned watcher watches this inode; replacing it can drop its watch.
      if (atomic) {
        fs.writeFileSync(`${configFile}.next`, JSON.stringify(config), { mode: 0o600 });
        fs.renameSync(`${configFile}.next`, configFile);
      } else fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    }
    async function request(content = 'Reply with the fixture model.', session = 'fixture-session', messages = null) {
      const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer fixture-client-key', 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-session-id': session }, body: JSON.stringify({ model: stableAlias, max_tokens: 64, messages: messages || [{ role: 'user', content }] }), signal: AbortSignal.timeout(content === 'HOLD_FIXTURE' ? 60000 : 10000) });
      const data = await response.json();
      return { status: response.status, text: data.content?.map(c => c.text || '').join('') || '' };
    }
    async function chatRequest() {
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer fixture-client-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: stableAlias, max_tokens: 64, messages: [{ role: 'user', content: 'OpenCode protocol fixture' }] }), signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data.choices?.[0]?.message?.content;
    }
    configure('claude');
    child = spawn(binary, ['--config', configFile, '--local-model'], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', () => {});
    child.stdout.resume(); child.stderr.resume();
    const originalPid = child.pid;
    await until(async () => { try { return (await request()).text === 'MODEL:claude-fixture'; } catch { return false; } });
    assert.equal(await chatRequest(), 'MODEL:claude-fixture', 'OpenCode-compatible requests reach Claude');
    await pause(500);
    const held = request('HOLD_FIXTURE');
    held.catch(() => {});
    await until(() => Boolean(releaseHeld));
    configure('chatgpt');
    await until(async () => (await request()).text === 'MODEL:gpt-fixture');
    assert.equal(await chatRequest(), 'MODEL:gpt-fixture', 'OpenCode-compatible requests reach ChatGPT');
    releaseHeld(); releaseHeld = null;
    assert.equal((await held).text, 'MODEL:claude-fixture', 'an in-flight request must retain its original route');
    const messages = [
      { role: 'user', content: 'Fixture context' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fixture-tool', name: 'Read', input: { file_path: '/fixture' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-tool', content: 'fixture tool result' }] },
    ];
    assert.equal((await request('', 'fixture-context', messages)).text, 'MODEL:gpt-fixture');
    assert.ok(seen.some(r => !r.primary && r.messages?.some(m => m.role === 'tool' && m.tool_call_id === 'fixture-tool')), 'tool-result context must survive route change');
    configure('auto');
    await until(async () => (await request('Primary priority probe.', `priority-${seen.length}`)).text === 'MODEL:claude-fixture');
    assert.equal((await request('Start auto session.', 'sticky-auto')).text, 'MODEL:claude-fixture');
    primaryQuota = true;
    assert.equal((await request('Continue after quota.', 'sticky-auto')).text, 'MODEL:gpt-fixture');
    const primaryCalls = seen.filter(r => r.primary).length;
    assert.equal((await request('Continue on fallback.', 'sticky-auto')).text, 'MODEL:gpt-fixture');
    assert.equal(seen.filter(r => r.primary).length, primaryCalls, 'do not keep retrying exhausted primary');
    secondaryQuota = true;
    const exhausted = await request('Both exhausted.', 'sticky-auto');
    assert.ok(exhausted.status >= 400, 'all-exhausted must fail explicitly');
    assert.equal(child.pid, originalPid); assert.equal(child.exitCode, null);
    console.log(JSON.stringify({ passed: true, gatewayVersion: '8.0.43', stableClientAlias: stableAlias, openaiCompatibleClients: true, hotSwap: true, inFlightRoutePreserved: true, toolResultPreserved: true, priorityFallback429: true, exhaustedPrimarySkipped: true, bothExhaustedFails: true, gatewayRestarted: false, atomicConfigWrites: atomic, liveSubscriptions: false }));
  } finally {
    if (releaseHeld) releaseHeld();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), pause(2000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    upstream.closeAllConnections(); upstream.close(); reservation.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
