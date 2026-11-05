/** Project adapters: native Codex execution and fail-closed Oceans kernel checks. */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { repositoryIdentity } = require('./repositoryIdentity');

async function command(cmd, args, cwd, timeout = 15000) {
  const { stdout, stderr } = await run(cmd, args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024 });
  return (args[0] === 'login' && args[1] === 'status' ? stdout + stderr : stdout).trim();
}
async function diagnose(project, policy = {}, { runCommand = command } = {}) {
  const checks = [], cwd = project.path;
  const check = async (name, cmd, args) => {
    try { const output = await runCommand(cmd, args, cwd); checks.push({ name, ready: true }); return output; }
    catch { checks.push({ name, ready: false }); return null; }
  };
  const head = await check('repository', 'git', ['rev-parse', 'HEAD']);
  const binary = require('./agentRegistry').findBinary('codex') || 'codex';
  await check('codex', binary, ['--version']);
  const login = await check('subscription-login', binary, ['login', 'status']);
  if (login && (!/ChatGPT/i.test(login) || /API key/i.test(login))) checks[checks.length - 1].ready = false;
  const hasKernel = fs.existsSync(path.join(cwd, '.agent/policy.yml'));
  const oceans = project.adapter === 'oceans' || hasKernel;
  if (oceans) {
    await check('kernel-context', 'python3', ['.agent/context.py', 'start', '--profile', 'consult', '--compact']);
    await check('kernel-tools', 'python3', ['.agent/tools.py', 'doctor']);
    // This must be supported by the kernel itself. Never replace a missing
    // renderer with broad CLI permissions or accept an administrator checkbox.
    await check('kernel-codex-permissions', 'python3', ['.agent/permissions.py', 'check', '--runtime', 'codex']);
    await check('kernel-telegram-bridge', 'python3', ['.agent/telegram_bridge.py', 'check']);
  }
  return { adapter: oceans ? 'oceans' : 'general', repoKey: repositoryIdentity(cwd), head,
    ready: checks.every(c => c.ready), checks,
    reason: checks.filter(c => !c.ready).map(c => c.name).join(', ') || null };
}
function workerPrompt(job, project, policy) {
  const intro = `You are the sole executor for this repository. Follow its AGENTS.md and all applicable project instructions. Never spawn subagents or another implementation session. Do not disclose credentials. Respond in the language of the owner.\n`;
  if (project.adapter === 'oceans') return intro + `The Oceans kernel is authoritative. Start with context.py using ${job.kind === 'consult' ? 'consult' : 'solo'} profile and load every required policy/procedure section. Use tools.py and the kernel checkpoints. All effects must follow act.py/operation_log, and merges use the kernel guardians and valid charter. Jira is the backlog; do not create a local replacement. Reconcile PENDING before any mutation. Never change your permissions or kernel. Preserve the same session. For a human decision, return needs_input and the kernel decision reference; never claim an agent comment is human. Observe all deployment restrictions.\nRequest: ${job.instruction}`;
  return intro + `You are in a worktree. Do not commit, push, merge, deploy, modify .github, change credentials or policies; Citadel performs authorized publication after independent tests. ${job.kind === 'consult' ? 'Inspect only, discover current work and recommend a concrete next step. Do not edit files.' : 'Implement the requested change and inspect it. If a product decision or missing access blocks you, return needs_input with options and a recommendation.'}\nPreviously confirmed project context: ${project.summary || '(none)'}\nVerification commands: ${JSON.stringify(policy.tests || [])}\nRequest: ${job.instruction}`;
}
module.exports = { diagnose, workerPrompt, command };
