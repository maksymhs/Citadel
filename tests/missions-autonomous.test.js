const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const testRoot = path.resolve(__dirname, '../data/test-missions-auto-data');
process.env.DATA_DIR = testRoot;
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
process.env.CITADEL_MISSIONS_DIR = path.join(testRoot, 'missions');
process.env.CITADEL_QUOTA_COOLDOWN_MS = '60000';

const { initDatabase, getDatabase, closeDatabase } = require('../server/database/db');
const agentRegistry = require('../server/services/agentRegistry');
const taskService = require('../server/services/taskService');
const missionService = require('../server/services/missionService');
const projectService = require('../server/services/projectService');
const docService = require('../server/services/docService');

const HEADLESS = ['claude', 'opencode', 'codex'];
const originalListAgents = agentRegistry.listAgents.bind(agentRegistry);
function fakeAgents() {
  agentRegistry.listAgents = (options) => originalListAgents(options).map((agent) => (
    HEADLESS.includes(agent.id) ? { ...agent, installed: true, path: '/usr/bin/true', version: 'test' } : agent
  ));
}

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

const PLAN = {
  tasks: [
    { title: 'Inspect', role: 'analyst', acceptance: ['A brief exists'] },
    { title: 'Implement', role: 'backend', deps: [0], exclusive: true, acceptance: ['Tests pass'] },
  ],
};

describe('Autonomous loop guarantees', () => {
  const testDb = path.resolve(__dirname, '../data/test-missions-auto.db');

  before(() => {
    cleanDb(testDb);
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    initDatabase(testDb);
    fakeAgents();
  });

  afterEach(() => {
    // Settle any running task so the next test starts from an empty queue.
    for (const task of taskService.listTasks({ limit: 500 })) {
      if (!['done', 'failed', 'cancelled'].includes(task.status)) {
        try { taskService.cancelTask(task.id); } catch { /* already terminal */ }
      }
    }
    getDatabase().prepare('DELETE FROM tasks').run();
    getDatabase().prepare('DELETE FROM missions').run();
  });

  after(() => {
    agentRegistry.listAgents = originalListAgents;
    closeDatabase();
    cleanDb(testDb);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('only one autonomous agent runs at a time, while independent work waits, not fails', () => {
    const created = missionService.createMission({
      goal: 'Two independent checks',
      plan: {
        tasks: [
          { title: 'Check A', role: 'qa' },
          { title: 'Check B', role: 'analyst' },
        ],
      },
    });
    const first = taskService.claimTask('node-a');
    assert.ok(first);
    assert.equal(first.autonomous, true);
    const second = taskService.claimTask('node-b');
    assert.equal(second, null, 'a second autonomous attempt must not start');

    taskService.completeTask(first.id, { status: 'done', exitCode: 0, claimToken: first.claimToken });
    const next = taskService.claimTask('node-b');
    assert.ok(next, 'independent work becomes eligible once the first attempt ends');
    assert.notEqual(next.id, first.id);
    taskService.completeTask(next.id, { status: 'done', exitCode: 0, claimToken: next.claimToken });
    const after = missionService.getMission(created.mission.id);
    assert.equal(after.mission.status, 'done');
  });

  test('a quota failure pauses the task and resumes only after the cooldown', () => {
    const created = missionService.createMission({
      goal: 'Quota handling',
      plan: { tasks: [{ title: 'Call the provider', role: 'developer' }] },
    });
    const claim = taskService.claimTask('node-q');
    taskService.completeTask(claim.id, {
      status: 'failed', exitCode: 1, claimToken: claim.claimToken,
      error: 'HTTP 429 Too Many Requests: usage limit reached',
    });

    const paused = missionService.getMission(created.mission.id);
    assert.equal(paused.mission.status, 'quota');
    const task = paused.tasks[0];
    assert.equal(task.status, 'quota');
    assert.equal(task.blockedReason, 'quota');
    assert.ok(new Date(task.retryAt).getTime() > Date.now());
    assert.equal(taskService.claimTask('node-q'), null, 'a paused task is not claimed');

    // Simulate the cooldown elapsing; no provider reset time is invented.
    getDatabase().prepare("UPDATE tasks SET retry_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(task.id);
    const resumed = missionService.getMission(created.mission.id);
    assert.equal(resumed.tasks[0].status, 'queued');
    assert.equal(resumed.mission.status, 'running');

    const again = taskService.claimTask('node-q');
    assert.equal(again.id, task.id);
    taskService.completeTask(again.id, { status: 'done', exitCode: 0, claimToken: again.claimToken });
    assert.equal(missionService.getMission(created.mission.id).mission.status, 'done');
  });

  test('a failed attempt is classified and shown without guessing a root cause', () => {
    const created = missionService.createMission({
      goal: 'Classify a failure',
      plan: { tasks: [{ title: 'Reach the provider', role: 'developer' }] },
    });
    const claim = taskService.claimTask('node-f');
    taskService.completeTask(claim.id, {
      status: 'failed', exitCode: 1, claimToken: claim.claimToken,
      error: 'fetch failed: ECONNREFUSED 127.0.0.1:443 password=demo-credential',
      result: '{"token":"demo-credential"}',
    });
    const mission = missionService.getMission(created.mission.id);
    const task = mission.tasks[0];
    assert.doesNotMatch(JSON.stringify(task), /demo-credential/);
    assert.equal(task.failureKind, 'network');
    assert.equal(task.blockedReason, 'network');
    assert.equal(mission.mission.status, 'review');
  });

  test('a result that names a document links it to the task and mission', () => {
    const repoPath = path.join(testRoot, 'repo-link');
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    const project = projectService.importProject({ name: 'Link repo', targetPath: repoPath });
    // A CLI agent writes directly to the checkout, without a prior Docs visit.
    fs.mkdirSync(path.join(repoPath, 'docs'));
    fs.writeFileSync(path.join(repoPath, 'docs', 'architecture.md'), '# Architecture\n\nDecisions live here.\n');

    const created = missionService.createMission({
      goal: 'Document the result',
      projectId: project.id,
      plan: { tasks: [{ title: 'Describe the change', role: 'docs', refs: ['docs/architecture.md'] }] },
    });
    const claim = taskService.claimTask('node-d');
    taskService.completeTask(claim.id, {
      status: 'done', exitCode: 0, claimToken: claim.claimToken,
      result: 'Updated docs/architecture.md with the decision.',
    });

    const mission = missionService.getMission(created.mission.id);
    assert.equal(mission.tasks[0].docsLinked, true);
    const doc = docService.readDoc({ projectId: project.id, relPath: 'architecture.md' });
    assert.ok(doc.refs.some((ref) => ref.kind === 'task' && ref.id === claim.id));
    assert.ok(doc.refs.some((ref) => ref.kind === 'mission' && ref.id === created.mission.id));
  });

  test('the plan and queue survive a restart without duplicating tasks', () => {
    const created = missionService.createMission({ goal: 'Restart recovery', plan: PLAN });
    const before = missionService.getMission(created.mission.id);
    assert.equal(before.tasks.length, 2);

    closeDatabase();
    initDatabase(testDb);
    fakeAgents();

    const after = missionService.getMission(created.mission.id);
    assert.equal(after.tasks.length, 2);
    assert.equal(after.mission.status, 'running');
    assert.equal(after.tasks.find((t) => t.role === 'backend').status, 'blocked');
    assert.equal(after.tasks.find((t) => t.role === 'analyst').acceptance[0], 'A brief exists');
    assert.equal(after.plan.tasks.length, 2);
    const autonomous = taskService.listTasks({ missionId: created.mission.id, autonomous: true, limit: 20 });
    assert.equal(autonomous.length, 2);
  });

  test('a plan revision keeps the previous version and detaches superseded pending work', () => {
    const created = missionService.createMission({ goal: 'Revise me', plan: PLAN });
    const revised = missionService.revisePlan(created.mission.id, {
      tasks: [{ title: 'New approach', role: 'developer' }],
    }, { reason: 'The original approach failed' });

    assert.equal(revised.mission.planVersion, 2);
    assert.equal(revised.planVersions, 2);
    assert.equal(revised.tasks.length, 1);
    assert.equal(revised.tasks[0].title, 'New approach');
    const detached = getDatabase().prepare('SELECT COUNT(*) c FROM tasks WHERE mission_id IS NULL').get().c;
    assert.ok(detached >= 1, 'superseded pending tasks are kept but detached from the mission');
    const versions = missionService.listPlanVersions(created.mission.id);
    assert.deepEqual(versions.map((v) => v.version), [2, 1]);
    assert.match(versions[0].reason, /original approach/i);
  });


  test('a finished result is not done until review accepts it', () => {
    const created = missionService.createMission({
      goal: 'Review gate',
      plan: { tasks: [{ title: 'Produce a result', role: 'developer', acceptance: ['The result is verified'] }] },
    });
    const claim = taskService.claimTask('node-r');
    taskService.completeTask(claim.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken });
    const waiting = missionService.getMission(created.mission.id);
    assert.equal(waiting.mission.status, 'review');
    assert.equal(waiting.tasks[0].status, 'review');
    assert.equal(taskService.claimTask('node-r'), null, 'review work is not claimed again');

    const accepted = missionService.reviewTask(created.mission.id, claim.id, {
      accepted: true,
      note: 'Verified manually.',
      reviewedBy: 'admin',
    });
    assert.equal(accepted.mission.status, 'done');
    const task = accepted.tasks.find((t) => t.id === claim.id);
    assert.equal(task.status, 'done');
    assert.equal(task.reviewedBy, 'admin');
    assert.ok(task.reviewedAt);

    const rejectedMission = missionService.createMission({
      goal: 'Reject gate',
      plan: { tasks: [{ title: 'Produce another result', role: 'developer', acceptance: ['Verified'] }] },
    });
    const rejectedClaim = taskService.claimTask('node-r');
    taskService.completeTask(rejectedClaim.id, { status: 'done', exitCode: 0, claimToken: rejectedClaim.claimToken });
    const rejected = missionService.reviewTask(rejectedMission.mission.id, rejectedClaim.id, {
      accepted: false,
      note: 'Acceptance criterion was not demonstrated.',
      reviewedBy: 'admin',
    });
    assert.equal(rejected.mission.status, 'review');
    const rejectedTask = rejected.tasks.find((t) => t.id === rejectedClaim.id);
    assert.equal(rejectedTask.status, 'failed');
    assert.equal(rejectedTask.blockedReason, 'rejected');
    assert.match(rejectedTask.error, /Acceptance criterion/);

    const retried = taskService.retryTask(rejectedClaim.id);
    assert.equal(retried.status, 'queued');
    assert.equal(retried.error, null, 'a retry starts without stale evidence');
    const reopened = missionService.getMission(rejectedMission.mission.id);
    assert.equal(reopened.mission.status, 'running');
    assert.equal(reopened.mission.finishedAt, null, 'a retried mission is open again');
    const again = taskService.claimTask('node-r');
    assert.equal(again.id, rejectedClaim.id);
    taskService.completeTask(again.id, { status: 'done', exitCode: 0, claimToken: again.claimToken });
    assert.equal(missionService.getMission(rejectedMission.mission.id).mission.status, 'review');
  });

  test('a user correction becomes confirmed project memory and is attributed to the task', () => {
    const created = missionService.createMission({
      goal: 'Correction flow',
      plan: { tasks: [{ title: 'Tune the scheduler', role: 'backend' }] },
    });
    const claim = taskService.claimTask('node-c');
    taskService.completeTask(claim.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken });
    const result = missionService.addCorrection(created.mission.id, claim.id, 'Inspect the existing recovery mechanism and extend its tests.', { createdBy: 'admin' });
    assert.equal(result.lesson.status, 'confirmed');
    assert.equal(result.lesson.scope, 'project');
    assert.equal(result.lesson.taskId, claim.id);
    const task = result.mission.tasks.find((t) => t.id === claim.id);
    assert.match(task.reviewNote, /existing recovery/i);
  });
  test('a failed enqueue rolls back the entire plan publication', () => {
    const original = taskService.enqueue;
    let calls = 0;
    taskService.enqueue = (options) => {
      if (++calls === 2) throw new Error('Injected enqueue failure');
      return original(options);
    };
    try {
      assert.throws(() => missionService.createMission({ goal: 'Atomic publication', plan: PLAN }), /Injected enqueue failure/);
      const db = getDatabase();
      assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
      const mission = db.prepare("SELECT * FROM missions WHERE goal = 'Atomic publication'").get();
      assert.equal(mission.plan, null);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM mission_plan_versions WHERE mission_id = ?').get(mission.id).n, 0);
    } finally {
      taskService.enqueue = original;
    }
  });

  test('rejection mentioning quota stays failed and exhausted quota does not loop forever', () => {
    const created = missionService.createMission({ goal: 'Quota review', plan: { tasks: [{ title: 'Check quota', role: 'qa', acceptance: ['Verified'] }] } });
    const first = taskService.claimTask('node-q');
    taskService.completeTask(first.id, { status: 'done', claimToken: first.claimToken });
    const rejected = missionService.reviewTask(created.mission.id, first.id, { accepted: false, note: 'Handle the rate limit correctly' });
    assert.equal(rejected.tasks[0].status, 'failed');
    assert.equal(rejected.tasks[0].blockedReason, 'rejected');
    taskService.retryTask(first.id);
    const second = taskService.claimTask('node-q');
    taskService.completeTask(first.id, { status: 'failed', claimToken: second.claimToken, error: 'HTTP 429' });
    getDatabase().prepare("UPDATE tasks SET attempt = max_attempts, retry_at = '2000-01-01' WHERE id = ?").run(first.id);
    assert.equal(missionService.getMission(created.mission.id).tasks[0].status, 'failed');
    assert.equal(missionService.getMission(created.mission.id).tasks[0].status, 'failed');
  });

  test('handoff symlinks cannot attach docs mentioned outside the mission workspace', () => {
    const repo = path.join(testRoot, 'symlink-repo');
    fs.mkdirSync(repo, { recursive: true });
    const project = projectService.importProject({ name: 'Symlink handoff', targetPath: repo });
    docService.createDoc({ projectId: project.id, relPath: 'outside-reference.md', content: '# Outside reference\n' });
    const created = missionService.createMission({ projectId: project.id, goal: 'Safe handoff', plan: { tasks: [{ title: 'Inspect', role: 'qa' }] } });
    const task = taskService.claimTask('node-s');
    const outside = path.join(testRoot, 'outside-handoff.md');
    fs.writeFileSync(outside, 'docs/outside-reference.md');
    fs.symlinkSync(outside, path.join(created.mission.workspace, task.handoffRef));
    taskService.completeTask(task.id, { status: 'done', claimToken: task.claimToken });
    assert.deepEqual(docService.readDoc({ projectId: project.id, relPath: 'outside-reference.md' }).refs, []);
  });

  test('failed revision preserves the previous plan and its pending tasks', () => {
    const original = taskService.enqueue;
    const created = missionService.createMission({ goal: 'Atomic revision', plan: PLAN });
    const before = missionService.getMission(created.mission.id);
    let calls = 0;
    taskService.enqueue = (options) => {
      if (++calls === 2) throw new Error('Injected revision failure');
      return original(options);
    };
    try {
      assert.throws(() => missionService.revisePlan(created.mission.id, PLAN), /Injected revision failure/);
      const after = missionService.getMission(created.mission.id);
      assert.equal(after.mission.planVersion, before.mission.planVersion);
      assert.deepEqual(after.tasks.map((t) => [t.id, t.status]), before.tasks.map((t) => [t.id, t.status]));
    } finally { taskService.enqueue = original; }
  });

});
