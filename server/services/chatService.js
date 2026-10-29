const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('../config');
const { validateSafePath } = require('../security/guard');
const registryDefault = require('./agentRegistry');
const gatewayDefault = require('./gatewayService');
const projectService = require('./projectService');

function failure(message, statusCode = 503) { return Object.assign(new Error(message), { statusCode }); }
function getChildEnv(base = process.env) {
  return Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].filter(key => typeof base[key] === 'string').map(key => [key, base[key]]));
}
const bounded = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const counter = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const tokenUsage = value => ({ input: counter(value?.input), output: counter(value?.output), reasoning: counter(value?.reasoning), cache: { read: counter(value?.cache?.read), write: counter(value?.cache?.write) } });
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(value);
const rules = role => [{ permission: '*', pattern: '*', action: 'ask' }, ...(role === 'plan' ? ['edit', 'bash', 'task', 'external_directory'].map(permission => ({ permission, pattern: '*', action: 'deny' })) : [])];

function createChatService({ dataDir = DATA_DIR, getProject = id => projectService.getProject(id), registry = registryDefault, gateway = gatewayDefault, spawnImpl = spawn, fetchImpl = fetch, validatePath = validateSafePath } = {}) {
  const root = path.join(dataDir, 'chat');
  let database, runtime, closing = false, lastError = null, active = null, tail = Promise.resolve(), queued = 0;
  const listeners = new Set();
  function db() {
    if (!database) {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(root) !== path.join(fs.realpathSync(dataDir), 'chat')) throw failure('Chat storage must not be a symlink.');
      fs.chmodSync(root, 0o700);
      const file = path.join(root, 'metadata.sqlite');
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw failure('Invalid chat storage.');
      database = new Database(file);
      fs.chmodSync(file, 0o600);
      database.pragma('journal_mode = WAL');
      database.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS session_scope ON sessions(owner, project, directory); CREATE TABLE IF NOT EXISTS requests (session TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(session, id));');
    }
    return database;
  }
  function exclusive(work) {
    if (closing) return Promise.reject(failure('Chat is shutting down.'));
    if (queued >= 32) return Promise.reject(failure('Chat is busy. Try again shortly.', 409));
    queued++;
    const result = tail.then(() => { if (closing) throw failure('Chat is shutting down.'); return work(); });
    tail = result.catch(() => {}).finally(() => { queued--; });
    return result;
  }
  function eligibility() {
    if (!registry.findBinary('opencode')) throw failure('Install OpenCode in Settings → Tools.');
    const state = gateway.status();
    if (!state.enabled || !state.opencodeEnabled || !state.running) throw failure('Enable OpenCode and start AI Gateway in Settings → AI Gateway. Native provider fallback is disabled.');
    const launch = gateway.launchOptions('opencode');
    if (!launch) throw failure('Enable OpenCode in Settings → AI Gateway. Native provider fallback is disabled.');
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(launch.args[1], 'utf8'));
      if (!settings.opencodeEnabled || typeof settings.token !== 'string' || !settings.token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.baseUrl)) throw new Error();
    } catch { throw failure('AI Gateway runtime settings are unavailable. Restart AI Gateway. Native provider fallback is disabled.'); }
    return { ...launch, settings, fingerprint: crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex') };
  }
  function status() {
    const installed = Boolean(registry.findBinary('opencode'));
    try { eligibility(); return { installed, ready: true }; }
    catch (err) { return { installed, ready: false, error: err.message }; }
  }
  function scope(owner, project) {
    if (!identifier(owner) || !identifier(project)) throw failure('Chat not found.', 404);
    const found = getProject(project);
    if (!found) throw failure('Project not found.', 404);
    let directory;
    try { directory = fs.realpathSync(validatePath(found.path)); if (!fs.statSync(directory).isDirectory()) throw new Error(); }
    catch { throw failure('Project directory is unavailable.', 409); }
    return { owner, project, directory, key: crypto.createHash('sha256').update(JSON.stringify([owner, project, directory])).digest('hex') };
  }
  function owned(s, id) {
    if (!identifier(id)) throw failure('Chat not found.', 404);
    const row = db().prepare('SELECT * FROM sessions WHERE id = ? AND owner = ? AND project = ? AND directory = ?').get(id, s.owner, s.project, s.directory);
    if (!row) throw failure('Chat not found.', 404);
    return row;
  }
  const publicSession = row => ({ id: row.id, title: bounded(row.title, 200), updatedAt: new Date(row.updated).toISOString() });
  async function request(rt, route, method = 'GET', body, limit = 2 * 1024 * 1024, timeout = 10000) {
    try {
      const url = new URL(`http://127.0.0.1:${rt.port}${route}`);
      url.searchParams.set('directory', rt.scope.directory);
      const response = await fetchImpl(url, { method, headers: { authorization: rt.auth, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(), { engineStatus: response.status }); }
      const optional = method === 'POST' && /\/(prompt_async|abort|reply|reject)$/.test(route);
      if (response.status === 204) {
        await response.body?.cancel();
        if (optional) return null;
        throw Object.assign(new Error(), { reason: 'empty response' });
      }
      let size = 0; const chunks = [];
      try { for await (const chunk of response.body || []) { size += chunk.length; if (size > limit) throw Object.assign(new Error(), { reason: 'response too large' }); chunks.push(chunk); } }
      catch (err) { await response.body?.cancel().catch(() => {}); throw err; }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        if (optional) return null;
        throw Object.assign(new Error(), { reason: 'empty response' });
      }
      try { return JSON.parse(text); }
      catch { throw Object.assign(new Error(), { reason: 'invalid JSON response' }); }
    } catch (err) {
      const endpoint = route.split('?')[0].replace(/\/session\/[^/]+/, match => match === '/session/status' ? match : '/session/:id').replace(/\/(permission|question)\/[^/]+/, '/$1/:id');
      const detail = err.engineStatus ? `HTTP ${err.engineStatus}` : err.reason || (['TimeoutError', 'AbortError'].includes(err.name) ? 'timed out' : 'connection failed');
      const missing = err.engineStatus === 404 && /^\/session\/[^/]+$/.test(route) && route !== '/session/status';
      throw failure(`Chat engine request failed (${method} ${endpoint}: ${detail}). ${missing ? 'This saved session is unavailable in OpenCode. Create a new chat.' : 'Retry; if this persists, check OpenCode and AI Gateway in Settings.'}`, missing ? 409 : 503);
    }
  }
  async function pending(rt) {
    const [statuses, permissions, questions] = await Promise.all([request(rt, '/session/status'), request(rt, '/permission'), request(rt, '/question')]);
    if (!statuses || typeof statuses !== 'object' || !Array.isArray(permissions) || !Array.isArray(questions)) throw failure('Unsupported OpenCode API. Update OpenCode in Settings → Tools.');
    const prompt = active;
    if (prompt && (!statuses[prompt.id] || statuses[prompt.id].type === 'idle') && !permissions.some(p => p.sessionID === prompt.id) && !questions.some(p => p.sessionID === prompt.id)) {
      const messages = await request(rt, `/session/${prompt.id}/message?limit=100`);
      if (Array.isArray(messages) && messages.some(m => m.info?.sessionID === prompt.id && m.info.role === 'assistant' && m.info.parentID === prompt.messageID && (m.info.error || m.info.time?.completed && m.info.finish && !['tool-calls', 'unknown'].includes(m.info.finish))) && active === prompt) { active = null; lastError = null; }
    }
    return { statuses, permissions, questions, busy: Boolean(active || Object.values(statuses).some(v => v.type !== 'idle') || permissions.length || questions.length) };
  }
  function notify(id) { for (const listener of listeners) if (listener.id === id) listener.update(); }
  async function stream(rt) {
    rt.streaming = true;
    try {
      const url = new URL(`http://127.0.0.1:${rt.port}/event`); url.searchParams.set('directory', rt.scope.directory);
      const response = await fetchImpl(url, { headers: { authorization: rt.auth }, redirect: 'error', signal: rt.abort.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error();
      rt.streamError = false;
      let buffer = ''; const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
        if (buffer.length > 262144) throw new Error();
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const text = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!text) continue;
          const event = JSON.parse(text), props = event.properties || {};
          const id = props.sessionID || props.info?.sessionID || props.part?.sessionID || (event.type === 'session.updated' ? props.info?.id : null);
          if (identifier(id) && db().prepare('SELECT id FROM sessions WHERE id = ? AND owner = ? AND project = ? AND directory = ?').get(id, rt.scope.owner, rt.scope.project, rt.scope.directory)) notify(id);
        }
      }
      if (!rt.abort.signal.aborted) throw new Error();
    } catch {
      rt.streaming = false;
      if (!rt.abort.signal.aborted && runtime === rt) { rt.streamError = true; for (const listener of listeners) listener.update(); }
    }
  }
  async function stopRuntime() {
    const rt = runtime; runtime = null; active = null;
    if (!rt) return;
    rt.abort.abort();
    const signal = name => { try { if (rt.child.pid) process.kill(-rt.child.pid, name); else rt.child.kill(name); } catch {} };
    if (rt.child.exitCode === null && !rt.child.signalCode) await new Promise(resolve => {
      const timer = setTimeout(() => { signal('SIGKILL'); resolve(); }, 2000);
      rt.child.once('close', () => { clearTimeout(timer); resolve(); }); signal('SIGTERM');
    });
    signal('SIGKILL');
  }
  async function ensure(s) {
    const launch = eligibility();
    if (runtime && runtime.scope.key === s.key && !runtime.dead && (runtime.fingerprint === launch.fingerprint || (await pending(runtime)).busy)) {
      if (!runtime.streaming) stream(runtime);
      return runtime;
    }
    if (runtime && !runtime.dead && (await pending(runtime)).busy) throw failure('Chat engine is busy in another session. Finish or cancel it before switching projects or users.', 409);
    await stopRuntime();
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    db();
    const home = path.join(fs.realpathSync(root), s.key);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(home) !== home) throw failure('Invalid chat runtime storage.');
    for (const name of ['config', 'data', 'state', 'cache', 'logs']) {
      const directory = path.join(home, name);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(directory) !== directory) throw failure('Invalid chat runtime storage.');
      fs.chmodSync(directory, 0o700);
    }
    const password = crypto.randomBytes(32).toString('hex');
    const env = { ...getChildEnv(), HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), DATA_DIR: home, DATABASE_PATH: path.join(home, 'unused.sqlite'), PROJECTS_DIR: s.directory, LOGS_DIR: path.join(home, 'logs'), DOTENV_CONFIG_PATH: '/dev/null', OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'ask', share: 'disabled', autoupdate: false, plugin: [], mcp: {}, agent: { plan: { permission: { edit: 'deny', bash: 'deny', task: 'deny', external_directory: 'deny' } } } }) };
    const binary = registry.findBinary('opencode');
    const child = spawnImpl(launch.command, [...launch.args, binary, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: s.directory, env, detached: true, stdio: 'ignore' });
    const rt = { child, port, auth: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, scope: s, fingerprint: launch.fingerprint, abort: new AbortController(), dead: false };
    runtime = rt;
    child.once('error', () => { rt.dead = true; });
    child.once('close', () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } rt.dead = true; rt.abort.abort(); if (runtime === rt) { lastError = 'Chat engine stopped. Reopen chat to restart.'; for (const listener of listeners) listener.update(); } });
    try {
      let health;
      for (let i = 0; i < 100 && !rt.dead; i++) {
        try { health = await request(rt, '/global/health', 'GET', undefined, 4096, 300); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!health?.healthy) throw failure('Chat engine startup failed (GET /global/health: unavailable). Check OpenCode and AI Gateway in Settings.');
      if (!/^1\.19\./.test(health.version)) throw failure('Native chat requires OpenCode 1.19.x. Update OpenCode in Settings → Tools.');
      const doc = await request(rt, '/doc', 'GET', undefined, 4 * 1024 * 1024);
      for (const [route, method] of [['/provider', 'get'], ['/event', 'get'], ['/session', 'post'], ['/session/status', 'get'], ['/session/{sessionID}', 'get'], ['/session/{sessionID}', 'patch'], ['/session/{sessionID}/message', 'get'], ['/session/{sessionID}/prompt_async', 'post'], ['/session/{sessionID}/abort', 'post'], ['/permission', 'get'], ['/question', 'get'], ['/permission/{requestID}/reply', 'post'], ['/question/{requestID}/reply', 'post'], ['/question/{requestID}/reject', 'post']]) if (!doc.paths?.[route]?.[method]) throw failure('Unsupported OpenCode API. Update OpenCode in Settings → Tools.');
      const config = await request(rt, '/config');
      const provider = config?.provider?.citadel;
      if (config?.enabled_providers?.length !== 1 || config.enabled_providers[0] !== 'citadel' || provider?.npm !== '@ai-sdk/openai-compatible' || provider.options?.baseURL !== `${launch.settings.baseUrl}/v1` || !['{env:CITADEL_GATEWAY_TOKEN}', launch.settings.token].includes(provider.options?.apiKey) || !['model', 'small_model'].every(key => typeof config[key] === 'string' && config[key].startsWith('citadel/')) || !['build', 'plan'].every(role => config.agent?.[role]?.model?.startsWith('citadel/'))) throw failure('Chat engine is not configured exclusively for AI Gateway. Restart AI Gateway and chat.');
      const aliases = launch.settings.aliases || { planning: 'citadel-planning', execution: 'citadel-execution', small: 'citadel-small' };
      if (config.model !== `citadel/${aliases.execution}` || config.small_model !== `citadel/${aliases.small}` || config.agent.build.model !== `citadel/${aliases.execution}` || config.agent.plan.model !== `citadel/${aliases.planning}` || !Object.values(aliases).every(alias => Object.hasOwn(provider.models || {}, alias))) throw failure('Chat engine gateway model aliases do not match AI Gateway. Restart AI Gateway and chat.');
      if (config.permission !== 'ask' && config.permission?.['*'] !== 'ask' || !['edit', 'bash', 'task', 'external_directory'].every(key => config.agent.plan.permission?.[key] === 'deny')) throw failure('Chat engine permission configuration is unsafe. Reopen chat.');
      const providers = await request(rt, '/provider');
      const models = Array.isArray(providers?.all) ? providers.all.find(item => item.id === 'citadel')?.models : null;
      rt.models = Object.fromEntries(['build', 'plan'].map(role => {
        const model = config.agent[role].model;
        const limit = counter(models?.[model.slice('citadel/'.length)]?.limit?.context);
        return [role, { model: bounded(model, 200), limitTokens: limit > 0 ? limit : null }];
      }));
      lastError = null; stream(rt); return rt;
    } catch (err) { await stopRuntime(); lastError = err.message; throw err; }
  }
  async function verified(s, id) {
    const row = owned(s, id), rt = await ensure(s);
    const session = await request(rt, `/session/${id}`);
    if (session?.id !== id || session.directory !== s.directory) throw failure('Chat session directory does not match its registered project.', 409);
    return { row, rt, session };
  }
  function list(owner, project) { const s = scope(owner, project); eligibility(); return { sessions: db().prepare('SELECT * FROM sessions WHERE owner = ? AND project = ? AND directory = ? ORDER BY updated DESC LIMIT 200').all(s.owner, s.project, s.directory).map(publicSession) }; }
  const create = (owner, project) => exclusive(async () => {
    const s = scope(owner, project), rt = await ensure(s);
    if ((await pending(rt)).busy) throw failure('Chat engine is busy. Finish or cancel the active session first.', 409);
    if (db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE owner = ? AND project = ? AND directory = ?').get(owner, project, s.directory).n >= 200 || db().prepare('SELECT COUNT(*) AS n FROM sessions').get().n >= 2000) throw failure('Chat session limit reached.', 409);
    const session = await request(rt, '/session', 'POST', { title: 'Citadel Chat', permission: rules('build') });
    if (!identifier(session?.id) || !session.id.startsWith('ses_') || session.directory !== s.directory) throw failure('Chat engine returned an invalid session.');
    const check = await request(rt, `/session/${session.id}`);
    if (check?.id !== session.id || check.directory !== s.directory) throw failure('Chat engine returned an invalid session directory.');
    const row = { id: session.id, owner, project, directory: s.directory, title: 'Citadel Chat', updated: Date.now() };
    db().prepare('INSERT INTO sessions VALUES (@id, @owner, @project, @directory, @title, @updated)').run(row);
    return { session: publicSession(row) };
  });
  const snapshot = (owner, project, id) => exclusive(async () => {
    const s = scope(owner, project), { row, rt } = await verified(s, id);
    const [raw, state] = await Promise.all([request(rt, `/session/${id}/message?limit=100`), pending(rt)]);
    if (!Array.isArray(raw)) throw failure('Invalid chat messages.');
    let budget = 400000;
    const text = (value, limit = 16000) => { const result = bounded(value, Math.min(limit, Math.max(0, budget))); budget -= result.length; return result; };
    const messages = raw.slice(-100).filter(m => m.info?.sessionID === id && ['user', 'assistant'].includes(m.info.role)).map(m => ({ id: bounded(m.info.id, 180), role: m.info.role, ...(m.info.role === 'assistant' ? { tokens: tokenUsage(m.info.tokens), model: m.info.providerID === 'citadel' && Object.values(rt.models).some(item => item.model === `citadel/${m.info.modelID}`) ? bounded(`citadel/${m.info.modelID}`, 200) : null } : {}), parts: (Array.isArray(m.parts) ? m.parts : []).slice(0, 100).filter(p => ['text', 'reasoning', 'tool'].includes(p.type)).map(p => ({ id: bounded(p.id, 180), type: p.type, text: p.type === 'tool' ? text(p.tool, 120) : text(p.text), ...(p.type === 'tool' ? { state: { status: bounded(p.state?.status, 30) } } : {}) })) }));
    const permissions = state.permissions.filter(p => p.sessionID === id).slice(0, 30).map(p => ({ id: bounded(p.id, 180), permission: text(p.permission, 120), patterns: (Array.isArray(p.patterns) ? p.patterns : []).slice(0, 20).map(v => text(v, 500)) }));
    const questions = state.questions.filter(q => q.sessionID === id).slice(0, 20).map(q => ({ id: bounded(q.id, 180), questions: (q.questions || []).slice(0, 20).map(v => ({ header: text(v.header, 200), question: text(v.question, 2000), multiple: v.multiple === true, custom: v.custom !== false, options: (v.options || []).slice(0, 30).map(o => ({ label: text(o.label, 200), description: text(o.description, 1000) })) })) }));
    return { session: publicSession(row), messages, models: rt.models, status: state.statuses[id]?.type && state.statuses[id].type !== 'idle' || active?.id === id || permissions.length || questions.length ? 'busy' : rt.dead || rt.streamError || lastError ? 'error' : 'idle', permissions, questions };
  });
  const message = (owner, project, id, input) => exclusive(async () => {
    const s = scope(owner, project), { rt } = await verified(s, id);
    const digest = crypto.createHash('sha256').update(JSON.stringify([input.role, input.text])).digest('hex');
    const previous = db().prepare('SELECT digest FROM requests WHERE session = ? AND id = ?').get(id, input.requestId);
    if (previous) { if (previous.digest !== digest) throw failure('requestId was already used for different content.', 409); return { accepted: true }; }
    if ((await pending(rt)).busy) throw failure('Chat engine is busy. Finish or cancel the active session first.', 409);
    if (db().prepare('SELECT COUNT(*) AS n FROM requests WHERE session = ?').get(id).n >= 10000) throw failure('Chat message limit reached. Create another session.', 409);
    await request(rt, `/session/${id}`, 'PATCH', { permission: rules(input.role) });
    db().prepare('INSERT INTO requests VALUES (?, ?, ?)').run(id, input.requestId, digest);
    const messageID = `msg_${crypto.createHash('sha256').update(id + ':' + input.requestId).digest('hex').slice(0, 32)}`;
    active = { id, messageID };
    try {
      await request(rt, `/session/${id}/prompt_async`, 'POST', { agent: input.role, messageID, parts: [{ type: 'text', text: input.text }] });
    } catch (err) { lastError = 'Chat submission could not be confirmed. Check the snapshot before sending a new requestId.'; throw err; }
    db().prepare('UPDATE sessions SET updated = ? WHERE id = ?').run(Date.now(), id); notify(id);
    return { accepted: true };
  });
  const action = (owner, project, id, kind, requestId, body) => exclusive(async () => {
    const s = scope(owner, project), { rt } = await verified(s, id);
    if (kind === 'cancel') { await request(rt, `/session/${id}/abort`, 'POST', {}); if (active?.id === id) { active = null; lastError = null; } notify(id); return { ok: true }; }
    const state = await pending(rt), items = kind === 'permission' ? state.permissions : state.questions;
    if (!identifier(requestId) || !items.some(item => item.id === requestId && item.sessionID === id)) throw failure('Approval request not found.', 404);
    if (kind === 'permission') await request(rt, `/permission/${requestId}/reply`, 'POST', body);
    else await request(rt, `/question/${requestId}/${kind === 'question' ? 'reply' : 'reject'}`, 'POST', body);
    notify(id); return { ok: true };
  });
  async function subscribe(owner, project, id, update) {
    await exclusive(async () => { await verified(scope(owner, project), id); });
    if (listeners.size >= 64) throw failure('Too many chat event streams.', 429);
    const listener = { owner, project, id, update }; listeners.add(listener);
    return () => listeners.delete(listener);
  }
  async function check(owner, project, id) { return exclusive(async () => { await verified(scope(owner, project), id); }); }
  const activity = (owner, project) => exclusive(() => {
    const s = scope(owner, project);
    return { running: Boolean(runtime && !runtime.dead && runtime.scope.key === s.key) };
  });
  const stopProject = (owner, project) => exclusive(async () => {
    const s = scope(owner, project), rt = runtime;
    if (!rt || rt.dead || rt.scope.key !== s.key) return { stopped: false };
    const state = await pending(rt);
    const ids = new Set([...Object.entries(state.statuses).filter(([, value]) => value.type !== 'idle').map(([id]) => id), ...state.permissions.map(item => item.sessionID), ...state.questions.map(item => item.sessionID), ...(active ? [active.id] : [])]);
    for (const id of ids) owned(s, id);
    for (const id of ids) await request(rt, `/session/${id}/abort`, 'POST', {});
    for (const listener of listeners) if (listener.owner === owner && listener.project === project) { listener.update(true); listeners.delete(listener); }
    await stopRuntime();
    lastError = null;
    return { stopped: true };
  });
  const withProjectRemoval = (project, remove) => exclusive(() => {
    if (runtime && !runtime.dead && runtime.scope.project === project) throw failure('Project has a running Chat engine. Stop it before removal.', 409);
    return remove();
  });
  async function close() { closing = true; for (const listener of listeners) listener.update(true); listeners.clear(); await tail; await stopRuntime(); if (database) { database.close(); database = null; } }
  return { status, activity, stopProject, withProjectRemoval, list, create, snapshot, message, action, subscribe, check, close };
}
module.exports = { ...createChatService(), createChatService, getChildEnv };
