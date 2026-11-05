/** Opt-in Telegram polling and a journaled local sentinel; no additional system service. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const config = require('../config');
const { createDirectorService } = require('./directorService');

function createDirectorRuntime({ service = createDirectorService(), fetchImpl = fetch, spawnImpl = spawn } = {}) {
  let timer, polling, worker, stopped = true, busy = false, address, workerCapacity, workerToken;
  let lastError = null;
  async function telegram(method, body, timeout = 15000) {
    const token = service.settings(true).token;
    if (!token) throw new Error('Bot token is not configured.');
    // Token-bearing URLs/errors are deliberately never logged or returned.
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout), redirect: 'error',
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error();
      return data.result;
    } catch { throw new Error('Telegram request failed; check bot configuration and connectivity.'); }
  }
  async function poll() {
    if (stopped || !service.settings().enabled) return;
    try {
      const updates = await telegram('getUpdates', { offset: service.offset(), timeout: 20, allowed_updates: ['message', 'callback_query'] }, 25000);
      for (const update of updates) {
        const accepted = service.receive(update);
        // Offset advances only after durable acceptance (or explicit rejection).
        service.offset(Math.max(service.offset(), update.update_id + 1));
        if (accepted && update.callback_query?.id) await telegram('answerCallbackQuery', { callback_query_id: update.callback_query.id }).catch(() => {});
      }
      lastError = null;
    } catch { lastError = 'Telegram unavailable; updates will be retried.'; }
  }
  function ensureWorker() {
    const cfg = service.settings();
    if (worker || !cfg.enabled) return;
    if (process.platform !== 'linux') { lastError = 'Autonomous execution currently requires Linux.'; return; }
    if (config.NODE_TOKENS_CONFIGURED && config.NODE_TOKENS.size === 0) { lastError = 'Fix the invalid node-token configuration before enabling execution.'; return; }
    if (!workerToken) workerToken = crypto.randomBytes(32).toString('hex');
    config.NODE_TOKENS.set(config.DIRECTOR_NODE, workerToken);
    const stateDir = path.join(config.DATA_DIR, 'director', 'sentinel');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    workerCapacity = cfg.concurrency + 1; // one extra slot for conversational routing
    worker = spawnImpl(process.execPath, [path.join(config.ROOT_DIR, 'scripts/sentinel.js')], {
      cwd: config.ROOT_DIR, stdio: 'ignore', env: { ...process.env,
        CITADEL_URL: address, CITADEL_NODE: config.DIRECTOR_NODE, CITADEL_NODE_TOKEN: workerToken,
        CITADEL_TOKEN: '', CITADEL_CAPACITY: String(workerCapacity), CITADEL_SENTINEL_STATE_DIR: stateDir,
      },
    });
    worker.on('error', () => { worker = null; lastError = 'The local execution worker could not start.'; });
    worker.on('exit', () => { worker = null; });
  }
  async function cycle() {
    if (busy || stopped) return;
    busy = true;
    try {
      const cfg = service.settings();
      if (!cfg.enabled) return;
      ensureWorker();
      // Rotation of capacity waits until supervisor restart; journal recovery
      // preserves any live executions during that restart.
      if (worker && workerCapacity !== cfg.concurrency + 1) worker.kill('SIGTERM');
      if (!polling) polling = poll().finally(() => { polling = null; });
      await service.tick();
      for (const entry of service.outbox()) {
        try {
          const payload = JSON.parse(entry.payload);
          if (!service.settings().manualMode) delete payload.reply_markup;
          const sent = await telegram('sendMessage', { chat_id: cfg.chatId, ...payload });
          service.delivered(entry.id, sent.message_id);
        } catch { service.deliveryFailed(entry.id); lastError = 'Telegram delivery pending.'; break; }
      }
    } catch { lastError = 'Director encountered a recoverable error; inspect project state before retrying.'; }
    finally { busy = false; }
  }
  function start(url) {
    address = url; stopped = false;
    timer = setInterval(cycle, config.DIRECTOR_TICK_MS); timer.unref();
    void cycle();
  }
  async function close() {
    stopped = true; clearInterval(timer);
    if (worker) {
      const child = worker;
      await new Promise(resolve => { const deadline = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(deadline); resolve(); }); child.kill('SIGTERM'); });
    }
    // Keep the scoped token until Fastify has closed: in-flight journal reports
    // may still be completing. It exists only in this process and the sentinel.
  }
  return { service, start, close, cycle, telegram, status: () => ({ running: !stopped, worker: Boolean(worker), lastError }) };
}
module.exports = { createDirectorRuntime };
