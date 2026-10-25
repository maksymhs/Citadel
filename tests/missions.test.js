const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const testRoot = path.resolve(__dirname, '../data/test-missions-data');
const workspaceRoot = path.join(testRoot, 'missions');
// All four persistent paths point at a temp directory: a live host may export
// the real install's paths, and this test must never touch them.
process.env.DATA_DIR = testRoot;
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
process.env.CITADEL_MISSIONS_DIR = workspaceRoot;

const { initDatabase, getDatabase, closeDatabase } = require('../server/database/db');
const agentRegistry = require('../server/services/agentRegistry');
const taskService = require('../server/services/taskService');
const missionService = require('../server/services/missionService');

const HEADLESS = ['claude', 'opencode', 'codex'];
const originalListAgents = agentRegistry.listAgents.bind(agentRegistry);

function fakeAgents() {
  agentRegistry.listAgents = (options) => originalListAgents(options).map((agent) => (
    HEADLESS.includes(agent.id)
      ? { ...agent, installed: true, path: '/usr/bin/true', version: 'test' }
      : agent
  ));
}

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

const SIMPLE_PLAN = {
  tasks: [
    { title: 'Inspect the code', role: 'analyst', description: 'Read the relevant files.' },
    { title: 'Implement the change', role: 'backend', deps: [0], exclusive: true },
    { title: 'Run the tests', role: 'qa', deps: [1] },
  ],
};

describe('Agent missions (validated DAG over the task queue)', () => {
  const testDb = path.resolve(__dirname, '../data/test-missions.db');

  before(() => {
    cleanDb(testDb);
    rmDir(testRoot);
    initDatabase(testDb);
    fakeAgents();
  });

  afterEach(() => {
    getDatabase().prepare('DELETE FROM tasks').run();
    getDatabase().prepare('DELETE FROM missions').run();
  });

  after(() => {
    agentRegistry.listAgents = originalListAgents;
    closeDatabase();
    cleanDb(testDb);
    rmDir(testRoot);
  });

  test('validatePlan rejects unsafe or malformed plans', () => {
    assert.throws(() => missionService.validatePlan(null), /tasks/i);
    assert.throws(() => missionService.validatePlan({ tasks: [] }), /between 1 and/i);
    assert.throws(() => missionService.validatePlan({ tasks: [{ title: 'Do the thing', role: 'wizard' }] }), /unknown role/i);
    assert.throws(
      () => missionService.validatePlan({ tasks: [{ title: 'Alpha', role: 'qa' }, { title: 'Bravo', role: 'qa', deps: [1] }] }),
      /earlier task indices/i,
    );
    assert.throws(
      () => missionService.validatePlan({ tasks: [{ title: 'Same', role: 'qa' }, { title: 'Same', role: 'qa' }] }),
      /duplicate/i,
    );
    assert.throws(
      () => missionService.validatePlan({ tasks: [{ title: 'Alpha', role: 'qa', agent: 'rm -rf' }] }),
      /unsupported agent/i,
    );
  });

  test('validatePlan computes stages and keeps parallel work parallel', () => {
    const plan = missionService.validatePlan({
      tasks: [
        { title: 'Alpha', role: 'analyst' },
        { title: 'Bravo', role: 'backend' },
        { title: 'Charlie', role: 'qa', deps: [0, 1] },
      ],
    });
    assert.deepEqual(plan.tasks.map((t) => t.stage), [0, 0, 1]);
    assert.deepEqual(plan.tasks[2].deps, [0, 1]);
  });

  test('createMission writes the workspace and blocks dependants', () => {
    const result = missionService.createMission({
      goal: 'Make the thing work\nwith a short second line',
      plan: SIMPLE_PLAN,
      title: 'Thing mission',
    });
    assert.equal(result.mission.status, 'running');
    assert.equal(result.mission.total, 3);
    assert.equal(result.tasks.filter((t) => t.status === 'queued').length, 1);
    assert.equal(result.tasks.filter((t) => t.status === 'blocked').length, 2);
    assert.ok(fs.existsSync(path.join(result.mission.workspace, 'goal.md')));
    assert.ok(fs.existsSync(path.join(result.mission.workspace, 'plan.json')));
    assert.ok(fs.existsSync(path.join(result.mission.workspace, 'decisions.md')));
    assert.equal(result.mission.title, 'Thing mission');
  });

  test('the plan is persisted before the first task is enqueued', () => {
    const original = taskService.enqueue;
    let seen = null;
    let planAtFirstEnqueue = null;
    taskService.enqueue = (...args) => {
      if (seen === null) {
        seen = args[0].missionId;
        planAtFirstEnqueue = getDatabase()
          .prepare('SELECT plan FROM missions WHERE id = ?')
          .get(seen).plan;
      }
      return original.apply(taskService, args);
    };
    try {
      missionService.createMission({ goal: 'Plan before queue', plan: SIMPLE_PLAN });
    } finally {
      taskService.enqueue = original;
    }
    assert.ok(planAtFirstEnqueue, 'the mission already had a plan when the first task was enqueued');
    assert.equal(JSON.parse(planAtFirstEnqueue).tasks.length, 3);
  });

  test('completing a dependency releases the next task', () => {
    const created = missionService.createMission({ goal: 'Release dependants', plan: SIMPLE_PLAN });
    const claim = taskService.claimTask('node-a');
    assert.ok(claim);
    assert.equal(claim.role, 'analyst');
    taskService.completeTask(claim.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken });

    const after = missionService.getMission(created.mission.id);
    const backend = after.tasks.find((t) => t.role === 'backend');
    assert.equal(backend.status, 'queued');
    const qa = after.tasks.find((t) => t.role === 'qa');
    assert.equal(qa.status, 'blocked');
  });

  test('planner output is validated before any subtask is enqueued', () => {
    const created = missionService.createMission({ goal: 'Let an agent plan this' });
    assert.equal(created.mission.status, 'planning');
    assert.equal(created.tasks.length, 1);
    assert.equal(created.tasks[0].role, 'planner');
    assert.ok(created.mission.plannerTaskId);

    fs.writeFileSync(
      path.join(created.mission.workspace, 'plan.json'),
      JSON.stringify({
        tasks: [
          { title: 'Analyse', role: 'analyst' },
          { title: 'Verify', role: 'qa', deps: [0] },
        ],
      }),
    );

    const claim = taskService.claimTask('node-planner');
    assert.equal(claim.id, created.mission.plannerTaskId);
    taskService.completeTask(claim.id, {
      status: 'done',
      exitCode: 0,
      claimToken: claim.claimToken,
      result: '{"tasks":[]}',
    });

    const after = missionService.getMission(created.mission.id);
    assert.equal(after.mission.status, 'running');
    assert.equal(after.tasks.length, 3);
    assert.equal(after.tasks.filter((t) => t.role === 'planner').length, 1);
    assert.equal(after.mission.total, 2, 'planner does not count toward mission progress');
    assert.equal(after.mission.done, 0);
    assert.equal(after.tasks.find((t) => t.role === 'analyst').title, 'Analyse');
    const qa = after.tasks.find((t) => t.role === 'qa');
    assert.equal(qa.status, 'blocked');
  });

  test('an invalid planner plan is rejected and surfaced for review', () => {
    const created = missionService.createMission({ goal: 'Bad planner output' });
    fs.writeFileSync(path.join(created.mission.workspace, 'plan.json'), JSON.stringify({ tasks: [{ title: 'Do the thing', role: 'wizard' }] }));
    const claim = taskService.claimTask('node-bad-plan');
    taskService.completeTask(claim.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken });

    const after = missionService.getMission(created.mission.id);
    assert.equal(after.mission.status, 'review');
    assert.match(after.mission.error, /unknown role/i);
    assert.equal(after.tasks.length, 1);
  });

  test('a manual plan import recovers a failed planner', () => {
    const created = missionService.createMission({ goal: 'Recover the planner' });
    const plannerClaim = taskService.claimTask('node-recover');
    assert.equal(plannerClaim.id, created.mission.plannerTaskId);
    taskService.completeTask(plannerClaim.id, { status: 'failed', exitCode: 1, claimToken: plannerClaim.claimToken });
    assert.equal(missionService.getMission(created.mission.id).mission.status, 'review');

    const imported = missionService.importPlan(created.mission.id, SIMPLE_PLAN);
    assert.equal(imported.mission.status, 'running');
    assert.equal(imported.mission.error, null);

    for (const role of ['analyst', 'backend', 'qa']) {
      const claim = taskService.claimTask('node-recover');
      assert.equal(claim.role, role);
      taskService.completeTask(claim.id, { status: 'done', exitCode: 0, claimToken: claim.claimToken });
    }

    const after = missionService.getMission(created.mission.id);
    assert.equal(after.mission.status, 'done');
    assert.throws(() => missionService.cancelMission(created.mission.id), /already finished/i);
    assert.throws(() => missionService.importPlan(created.mission.id, SIMPLE_PLAN), /already finished/i);
  });

  test('prioritize only reorders queued/blocked tasks', () => {
    const created = missionService.createMission({ goal: 'Prioritize this', plan: SIMPLE_PLAN });
    const queued = created.tasks.filter((t) => ['queued', 'blocked'].includes(t.status));
    const reversed = [...queued].reverse().map((t) => t.id);
    const after = missionService.prioritize(created.mission.id, { order: reversed });
    const ordered = after.tasks
      .filter((t) => ['queued', 'blocked'].includes(t.status))
      .sort((a, b) => b.priority - a.priority)
      .map((t) => t.id);
    assert.deepEqual(ordered, reversed);

    const done = after.tasks.find((t) => t.status === 'done');
    if (done) {
      assert.throws(() => missionService.prioritize(created.mission.id, { order: [done.id] }), /queued or blocked/i);
    }
  });

  test('cancelMission cancels queued and blocked tasks', () => {
    const created = missionService.createMission({ goal: 'Cancel this', plan: SIMPLE_PLAN });
    const after = missionService.cancelMission(created.mission.id);
    assert.equal(after.mission.status, 'cancelled');
    assert.ok(after.tasks.every((t) => t.status === 'cancelled'));
  });

  test('mission files are confined to the workspace', () => {
    const created = missionService.createMission({ goal: 'File guard', plan: SIMPLE_PLAN });
    const goal = missionService.readMissionFile(created.mission.id, 'goal.md');
    assert.match(goal.content, /File guard/);
    assert.throws(() => missionService.readMissionFile(created.mission.id, '../etc/passwd'), /invalid/i);
    assert.throws(() => missionService.readMissionFile(created.mission.id, 'handoff/../../x'), /invalid/i);

    const outside = path.join(testRoot, 'outside.md');
    fs.writeFileSync(outside, 'secret');
    const link = path.join(created.mission.workspace, 'handoff', 'escape.md');
    fs.symlinkSync(outside, link);
    assert.throws(() => missionService.readMissionFile(created.mission.id, 'handoff/escape.md'), /invalid/i);
    assert.ok(!missionService.listFiles(created.mission.id).some((f) => f.path === 'handoff/escape.md'));
  });

  test('a note is appended to decisions.md', () => {
    const created = missionService.createMission({ goal: 'Notes', plan: SIMPLE_PLAN });
    const after = missionService.addNote(created.mission.id, 'Use the small approach.');
    const decisions = missionService.readMissionFile(after.mission.id, 'decisions.md');
    assert.match(decisions.content, /Use the small approach/);
  });

  test('goals and notes are redacted before they reach prompts or Markdown', () => {
    const created = missionService.createMission({
      goal: 'Deploy with token=supersecretvalue123 and sk-abcdefghijklmnop',
      plan: SIMPLE_PLAN,
    });
    const goalFile = missionService.readMissionFile(created.mission.id, 'goal.md');
    assert.doesNotMatch(goalFile.content, /supersecretvalue123|sk-abcdefghijklmnop/);
    assert.match(goalFile.content, /\[REDACTED\]/);

    const after = missionService.addNote(created.mission.id, 'Authorization: Bearer abcdefghijklmnop');
    const decisions = missionService.readMissionFile(after.mission.id, 'decisions.md');
    assert.doesNotMatch(decisions.content, /abcdefghijklmnop/);
    assert.match(decisions.content, /Bearer \[REDACTED\]/);

    const planned = missionService.createMission({
      goal: 'Plan redaction',
      plan: { tasks: [{
        title: 'Rotate token=plaintokenvalue123',
        role: 'developer',
        description: 'Use sk-abcdefghijklmnop for the call.',
        acceptance: ['No ghp_abcdefghijklmnop in the diff'],
      }] },
    });
    const plannedTask = planned.tasks[0];
    assert.doesNotMatch(JSON.stringify(plannedTask), /plaintokenvalue123|sk-abcdefghijklmnop|ghp_abcdefghijklmnop/);
    assert.match(plannedTask.title, /\[REDACTED\]/);
  });

  test('the task queue exposes mission metadata and the exclusive flag', () => {
    const created = missionService.createMission({ goal: 'Metadata', plan: SIMPLE_PLAN });
    const backend = created.tasks.find((t) => t.role === 'backend');
    assert.equal(backend.title, 'Implement the change');
    assert.equal(backend.missionId, created.mission.id);
    assert.equal(backend.exclusive, true);
    const rows = taskService.listTasks({ missionId: created.mission.id });
    assert.equal(rows.length, 3);
    assert.ok(getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='missions'").get());
  });
});
