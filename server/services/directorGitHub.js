/** Reconciled publication through preauthorized GitHub repositories and workflows. */
const { command } = require('./directorAdapters');
async function publish(job, project, result, policy, { run = command, save = () => {} } = {}) {
  if (!policy.publish) return { ...result, publication: 'not_requested' };
  const repo = policy.repository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !policy.base || !policy.workflow || !(policy.requiredChecks || []).length) {
    return { ...result, outcome: 'needs_input', question: 'Configure repository, base branch, required checks and deployment workflow in project policy.', publication: 'not_authorized' };
  }
  if (result.verification !== 'PASS') throw new Error('Publication requires independent verification.');
  const cwd = result.worktree, branch = `work/${job.id}`;
  // Read state before every effect: timeout means pending, never permission to
  // create another PR or repeat a merge against a newer head.
  let stage = result.publication || 'prepared';
  if (stage === 'prepared') {
    const diff = await run('git', ['status', '--porcelain'], cwd);
    if (diff) {
      await run('git', ['add', '--all'], cwd);
      await run('git', ['diff', '--cached', '--check'], cwd);
      await run('git', ['commit', '-m', `feat: ${project.name.replace(/[\r\n]/g, ' ').slice(0, 65)} update`], cwd);
    }
    result.head = await run('git', ['rev-parse', 'HEAD'], cwd);
    result.publication = stage = 'pushing'; save(result);
  }
  if (stage === 'pushing') {
    const remote = await run('git', ['remote', 'get-url', 'origin'], cwd);
    if (!new RegExp(`^(https://github\\.com/|git@github\\.com:)${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.git)?$`).test(remote)) throw new Error('Git remote does not match the authorized repository.');
    await run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], cwd, 120000);
    result.publication = stage = 'opening_pr'; save(result);
  }
  let prs = JSON.parse(await run('gh', ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,url,state,headRefOid,mergeCommit'], cwd));
  let pr = prs[0];
  if (!pr && stage === 'opening_pr') {
    const body = 'Requested project change. Independent configured verification passed before publication.';
    await run('gh', ['pr', 'create', '--repo', repo, '--base', policy.base, '--head', branch, '--title', `${project.name}: requested update`, '--body', body], cwd, 30000);
    prs = JSON.parse(await run('gh', ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,url,state,headRefOid,mergeCommit'], cwd));
    pr = prs[0];
  }
  if (!pr) return { ...result, publication: 'opening_pr' };
  result.pr = pr.url;
  if (pr.state === 'CLOSED') throw new Error('Pull request was closed without merge.');
  if (pr.state !== 'MERGED') {
    const view = JSON.parse(await run('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'headRefOid,statusCheckRollup,mergeStateStatus'], cwd));
    if (view.headRefOid !== result.head) throw new Error('Pull request head changed; verification is stale.');
    const checks = view.statusCheckRollup || [];
    const complete = policy.requiredChecks.every(name => checks.some(c => (c.name || c.context) === name && (c.conclusion === 'SUCCESS' || c.state === 'SUCCESS')));
    if (checks.some(c => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(c.conclusion || c.state))) return { ...result, outcome: 'blocked', publication: 'checks_failed', summary: 'GitHub verification failed; the PR remains available for review.' };
    if (!complete) return { ...result, publication: 'waiting_checks' };
    result.publication = 'merging'; save(result);
    await run('gh', ['pr', 'merge', String(pr.number), '--repo', repo, '--squash', '--match-head-commit', result.head], cwd, 30000);
    return { ...result, publication: 'waiting_deployment' };
  }
  const sha = pr.mergeCommit?.oid;
  if (!sha) return { ...result, publication: 'waiting_deployment' };
  const runs = JSON.parse(await run('gh', ['run', 'list', '--repo', repo, '--workflow', policy.workflow, '--commit', sha, '--json', 'databaseId,status,conclusion,url,headSha', '--limit', '20'], cwd));
  const deployment = runs.find(r => r.headSha === sha);
  if (!deployment || deployment.status !== 'completed') return { ...result, publication: 'waiting_deployment', mergeSha: sha };
  if (deployment.conclusion !== 'success') return { ...result, outcome: 'blocked', publication: 'deployment_failed', deployment: deployment.url, summary: 'Changes merged, but deployment did not succeed.' };
  return { ...result, publication: 'deployed', deployment: deployment.url, mergeSha: sha, summary: 'Changes verified, merged and deployed by the authorized workflow.' };
}
module.exports = { publish };
