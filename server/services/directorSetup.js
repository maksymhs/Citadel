/**
 * Native Codex setup for the Telegram director, always as Citadel's service user.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const registry = require('./agentRegistry');
const { DATA_DIR, ROOT_DIR } = require('../config');
const execute = promisify(execFile);
function createDirectorSetup({ findBinary = () => registry.findBinary('codex'), spawnImpl = spawn, execImpl = execute, dataDir = DATA_DIR } = {}) {
  let child = null, timer, operation = { phase: 'idle', action: null, message: '' };
  function environment() {
    const env = { ...process.env };
    // Native ChatGPT authorization must not silently use a metered API key.
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CITADEL_TOKEN', 'CITADEL_NODE_TOKEN', 'CITADEL_NODE_TOKENS', 'CITADEL_SECRET_KEY', 'SESSION_SECRET']) delete env[key];
    return env;
  }
  async function status() {
    const binary = findBinary();
    let installed = false, connected = false;
    if (binary) {
      try {
        await execImpl(binary, ['--version'], { env: environment(), timeout: 5000 }); installed = true;
        const auth = await execImpl(binary, ['login', 'status'], { env: environment(), timeout: 5000 });
        connected = /ChatGPT/i.test(auth.stdout + auth.stderr) && !/API key/i.test(auth.stdout + auth.stderr);
      } catch { /* An executable is not proof of a valid native login. */ }
    }
    return { installed, connected, ready: installed && connected, operation: { ...operation } };
  }
  function stop() {
    clearTimeout(timer);
    if (child) {
      try { if (process.platform === 'linux') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { child.kill('SIGTERM'); }
      child = null;
    }
  }
  function start(action) {
    if (child || operation.phase === 'running') throw new Error('A Codex setup operation is already running.');
    if (!['install', 'login'].includes(action)) throw new Error('Unknown setup action.');
    const binary = action === 'login' ? findBinary() : null;
    if (action === 'login' && !binary) throw new Error('Install Codex first.');
    operation = { phase: 'running', action, message: action === 'install' ? 'Installing and validating Codex…' : 'Preparing browser authorization…' };
    const args = action === 'install' ? [path.join(ROOT_DIR, 'scripts/manage-agent.js'), 'install', 'codex'] : ['login', '--device-auth'];
    const proc = spawnImpl(action === 'install' ? process.execPath : binary, args, { env: environment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform === 'linux' });
    child = proc; let output = '';
    const scan = bytes => {
      if (child !== proc || action !== 'login') return;
      output = (output + bytes.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(-12000);
      const url = output.match(/https:\/\/auth\.openai\.com\/(?:codex\/)?device\b/);
      const code = output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/);
      if (url && code) operation = { ...operation, message: 'Open OpenAI authorization and enter this code. Enable device-code login in your account security settings if requested.', url: url[0], code: code[0] };
    };
    proc.stdout.on('data', scan); proc.stderr.on('data', scan);
    timer = setTimeout(() => { stop(); operation = { phase: 'error', action, message: 'Setup timed out. You can retry from this screen.' }; }, 15 * 60 * 1000);
    proc.on('error', () => { if (child !== proc) return; clearTimeout(timer); child = null; operation = { phase: 'error', action, message: 'Could not start Codex setup. Check the installed tools and service permissions.' }; });
    proc.on('close', code => { if (child !== proc) return; clearTimeout(timer); child = null; operation = { phase: code === 0 ? 'done' : 'error', action, message: code === 0 ? 'Completed. Refreshing Codex status…' : 'Setup did not complete. Retry authorization or installation; no credentials are shown in logs.' }; });
    return { ...operation };
  }
  async function test() {
    if (child || operation.phase === 'running') throw new Error('Wait for the current setup operation.');
    operation = { phase: 'running', action: 'test', message: 'Testing a real coordinator response…' };
    const current = await status();
    if (!current.ready) { operation = { phase: 'error', action: 'test', message: 'Install Codex and connect your ChatGPT account first.' }; throw new Error(operation.message); }
    const dir = path.join(dataDir, 'director', 'control');
    const file = path.join(dir, `setup-test-${Date.now()}.txt`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await execImpl(findBinary(), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--output-last-message', file, 'Reply exactly CITADEL_COORDINATOR_READY. Do not use tools or perform any actions.'], { env: environment(), cwd: dir, timeout: 45000, maxBuffer: 128 * 1024 });
      const ok = fs.readFileSync(file, 'utf8').trim() === 'CITADEL_COORDINATOR_READY';
      operation = { phase: ok ? 'done' : 'error', action: 'test', message: ok ? 'The coordinator answered successfully. You can now talk to your Telegram bot.' : 'Codex responded, but the coordinator check did not pass.' };
    } catch { operation = { phase: 'error', action: 'test', message: 'Codex could not answer. Check account authorization, subscription quota and server connectivity.' }; }
    finally { fs.rmSync(file, { force: true }); }
    return { ...operation };
  }
  return { status, start, test, close: stop };
}
module.exports = { createDirectorSetup };
