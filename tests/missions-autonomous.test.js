const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

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
    assert.equal(missionService.getMission(created.mission.id).mission.status, 'done');

    const rejected = missionService.reviewTask(created.mission.id, claim.id, {
      accepted: false,
      note: 'Acceptance criterion was not demonstrated.',
      reviewedBy: 'admin',
    });
    assert.equal(rejected.mission.status, 'review');
    const task = rejected.tasks.find((t) => t.id === claim.id);
    assert.equal(task.status, 'failed');
    assert.match(task.error, /Acceptance criterion/);
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
});
