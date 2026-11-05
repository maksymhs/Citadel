#!/usr/bin/env node
/** Sentinel child: bounded Codex turns with explicit sessions and durable results. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { command, workerPrompt } = require('../../server/services/directorAdapters');
const { scrub } = require('../../server/security/redact');

function runCodex(input, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const schema = path.join(__dirname, input.kind === 'route' ? 'router.schema.json' : 'result.schema.json');
    const output = input.resultFile + '.message';
    fs.rmSync(output, { force: true });
    // Resuming by --last could attach one project's answer to another project.
    const args = input.sessionId
      ? ['exec', 'resume', input.sessionId, '--json', '--output-schema', schema, '-c', `sandbox_mode="${input.kind === 'execute' ? 'workspace-write' : 'read-only'}"`, '-c', 'approval_policy="never"', '--output-last-message', output, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', '--sandbox', input.kind === 'execute' ? 'workspace-write' : 'read-only', '--output-schema', schema, '--output-last-message', output, '-'];
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(CITADEL_.*TOKEN|CITADEL_SECRET_KEY|SESSION_SECRET|OPENAI_API_KEY|TELEGRAM_.*)$/.test(key)) delete env[key];
    const child = spawnImpl(input.codex || 'codex', args, { cwd: input.directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let sessionId = input.sessionId || null, pending = '', usage = null, stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.env.CITADEL_EXEC_ID && process.platform === 'linux') {
        try { process.kill(-process.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      } else child.kill('SIGTERM');
    }, input.timeoutMs || 1800000);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), (input.timeoutMs || 1800000) + 10000);
    const finishTimers = () => { clearTimeout(timer); clearTimeout(killTimer); };
    child.stdout.on('data', bytes => {
      pending += bytes.toString();
      if (pending.length > 2 * 1024 * 1024) { child.kill('SIGTERM'); return; }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started') {
            sessionId = event.thread_id;
            fs.writeFileSync(input.resultFile + '.progress.json', JSON.stringify({ sessionId, worktree: input.directory }), { mode: 0o600 });
          }
          if (event.type === 'turn.completed') usage = event.usage;
        } catch { /* Non-JSON CLI diagnostics do not become actions. */ }
      }
    });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000); });
    child.on('error', err => { finishTimers(); reject(err); });
    child.on('close', code => {
      finishTimers();
      if (timedOut) return resolve({ outcome: 'blocked', summary: 'Execution time limit reached; reconcile before continuing.', sessionId, interrupted: true });
      if (code !== 0) {
        const quota = /quota|usage limit|rate.limit|limit reached/i.test(stderr);
        return resolve({ outcome: 'blocked', summary: quota ? 'Provider quota unavailable.' : 'Codex failed. Check native login and runtime diagnostics.', quota, sessionId });
      }
      try {
        const result = JSON.parse(fs.readFileSync(output, 'utf8'));
        fs.rmSync(output, { force: true });
        resolve({ ...result, sessionId, usage });
      } catch { reject(new Error('Codex did not return a valid structured result.')); }
    });
    child.stdin.end(input.prompt);
  });
}
async function work(input, deps = {}) {
  const invoke = deps.runCodex || runCodex, run = deps.command || command;
  let directory = input.directory;
  if (input.kind === 'execute' && input.project.adapter === 'general' && !input.sessionId) {
    const dirty = await run('git', ['status', '--porcelain'], directory);
    if (dirty) return { outcome: 'blocked', summary: 'The registered repository has existing changes. Preserve them before starting.', sessionId: null };
    const root = path.join(input.workRoot, input.job.id);
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    await run('git', ['worktree', 'add', '-b', `work/${input.job.id}`, root, 'HEAD'], directory);
    directory = root;
  } else if (input.worktree) directory = input.worktree;
  const prompt = input.kind === 'route' ? input.prompt : workerPrompt(input.job, input.project, input.policy);
  fs.writeFileSync(input.resultFile + '.progress.json', JSON.stringify({ sessionId: input.sessionId || null, worktree: directory }), { mode: 0o600 });
  const result = await invoke({ ...input, directory, prompt });
  result.worktree = directory;
  if (input.kind === 'execute' && input.project.adapter === 'general' && result.outcome === 'done') {
    if (!(input.policy.tests || []).length) return { ...result, outcome: 'needs_input', question: 'Configure project verification commands before publication.', options: [], summary: 'Implementation prepared; verification is not configured.' };
    const before = await run('git', ['diff', '--name-only', 'HEAD'], directory);
    const untracked = await run('git', ['ls-files', '--others', '--exclude-standard'], directory);
    const sensitive = (before + '\n' + untracked).split('\n').filter(Boolean).some(p => /(^|\/)(\.env(?:\..*)?|\.agent|\.github|\.claude|AGENTS.md|CLAUDE.md|.*\.(pem|key))($|\/)/.test(p));
    if (sensitive) return { ...result, outcome: 'needs_input', question: 'The change includes policy, workflow or credential-related paths. Review it before publication.', options: [], summary: 'Prepared changes require human review.' };
    for (const test of input.policy.tests) {
      try { await run(test.cmd, test.args, directory, input.timeoutMs); }
      catch (err) { return { ...result, outcome: 'blocked', summary: 'Independent project verification failed. Changes are preserved. ' + scrub(err.stdout || err.stderr || '', 1500), verification: 'FAIL' }; }
    }
    result.verification = 'PASS';
    result.head = await run('git', ['rev-parse', 'HEAD'], directory);
  }
  return result;
}
async function main() {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  let result;
  try { result = await work(input); }
  catch { result = { outcome: 'blocked', summary: 'Worker failed; reconcile the worktree and native session before retrying.', interrupted: true }; }
  // Output is private and atomically replaced; only a completed sentinel task
  // authorizes the server to consume it. Never print raw model/tool output.
  const clean = JSON.parse(JSON.stringify(result, (key, value) => typeof value === 'string' && !['sessionId', 'worktree', 'head'].includes(key) ? scrub(value, 12000) : value));
  fs.writeFileSync(input.resultFile + '.tmp', JSON.stringify(clean), { mode: 0o600 });
  fs.renameSync(input.resultFile + '.tmp', input.resultFile);
  console.log('Director result persisted.');
}
if (require.main === module) main().catch(() => { console.error('Director worker failed.'); process.exitCode = 1; });
module.exports = { runCodex, work };
