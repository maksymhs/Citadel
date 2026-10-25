const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const testRoot = path.resolve(__dirname, '../data/test-missions-budget-data');
process.env.DATA_DIR = testRoot;
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
process.env.CITADEL_MISSIONS_DIR = path.join(testRoot, 'missions');
process.env.CITADEL_AUTONOMOUS_DAILY_BUDGET = '1';

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

describe('Autonomous daily budget', () => {
  const testDb = path.resolve(__dirname, '../data/test-missions-budget.db');

  before(() => {
    cleanDb(testDb);
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    initDatabase(testDb);
    fakeAgents();
  });

  after(() => {
    agentRegistry.listAgents = originalListAgents;
    closeDatabase();
    cleanDb(testDb);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('the configured daily budget stops new autonomous attempts but not manual work', () => {
    const before = taskService.autonomousBudgetStatus();
    assert.equal(before.limit, 1);
    assert.equal(before.exhausted, false);

    const mission = missionService.createMission({
      goal: 'Budgeted work',
      plan: {
        tasks: [
          { title: 'First check', role: 'qa' },
          { title: 'Second check', role: 'analyst' },
        ],
      },
    });

    const first = taskService.claimTask('node-b');
    assert.ok(first);
    assert.equal(first.autonomous, true);
    const used = taskService.autonomousBudgetStatus();
    assert.equal(used.used, 1);
    assert.equal(used.exhausted, true);

    taskService.completeTask(first.id, { status: 'done', exitCode: 0, claimToken: first.claimToken });
    assert.equal(taskService.claimTask('node-b'), null, 'the budget stops the second autonomous attempt');

    taskService.enqueue({ agent: 'claude', prompt: 'Manual work', title: 'Manual task' });
    const claimedManual = taskService.claimTask('node-b');
    assert.ok(claimedManual, 'manual queue work is never blocked by the autonomous budget');
    taskService.completeTask(claimedManual.id, { status: 'done', exitCode: 0, claimToken: claimedManual.claimToken });

    // Move the usage row to yesterday to simulate the next local day.
    getDatabase().prepare("UPDATE autonomous_daily_usage SET day = '2000-01-01' WHERE day = ?").run(used.day);
    assert.equal(taskService.autonomousBudgetStatus().exhausted, false);
    const second = taskService.claimTask('node-b');
    assert.ok(second, 'the next day allows a new autonomous attempt');
    taskService.completeTask(second.id, { status: 'done', exitCode: 0, claimToken: second.claimToken });
    assert.equal(missionService.getMission(mission.mission.id).mission.status, 'done');
  });
  test('a retry consumes another attempt, including tasks first started on an earlier day', () => {
    const db = getDatabase();
    db.prepare('DELETE FROM autonomous_daily_usage').run();
    const task = taskService.enqueue({ cmd: '/usr/bin/true', autonomous: true });
    const first = taskService.claimTask('node-b');
    assert.equal(first.id, task.id);
    taskService.completeTask(task.id, { status: 'failed', error: 'demo failure', claimToken: first.claimToken });
    taskService.retryTask(task.id);
    assert.equal(taskService.claimTask('node-b'), null, 'retry must respect today’s exhausted budget');
    db.prepare("UPDATE tasks SET started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(task.id);
    db.prepare('DELETE FROM autonomous_daily_usage').run();
    const second = taskService.claimTask('node-b');
    assert.equal(second.attempt, 2);
    assert.equal(taskService.autonomousBudgetStatus().used, 1, 'an old task still consumes today’s budget');
    taskService.completeTask(task.id, { status: 'done', claimToken: second.claimToken });
    // Removing task history must not restore a spent budget.
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    assert.equal(taskService.autonomousBudgetStatus().used, 1);
  });

});
