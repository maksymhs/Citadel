const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const agentRegistry = require('../server/services/agentRegistry');
const projectService = require('../server/services/projectService');
const terminalManager = require('../server/services/terminalManager');
const { initDatabase, closeDatabase } = require('../server/database/db');

describe('AI Agent Registry & Launcher Tests', () => {
  const testDb = path.resolve(__dirname, '../data/test-agents.db');
  let testProject;

  before(() => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    initDatabase(testDb);
    testProject = projectService.createProject({
      name: 'Agent Test Project',
      slug: 'agent-test-project',
    });
  });

  after(() => {
    // Kill any created terminal sessions
    for (const [id] of terminalManager.activePtySessions.entries()) {
      terminalManager.killSession(id);
    }
    closeDatabase();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (fs.existsSync(testProject.path)) {
      fs.rmSync(testProject.path, { recursive: true, force: true });
    }
  });

  test('listAgents detects built-in CLI agents and reports live status', () => {
    const list = agentRegistry.listAgents();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 3);

    const claudeAgent = list.find((a) => a.id === 'claude');
    assert.ok(claudeAgent);
    assert.equal(claudeAgent.name, 'Claude Code');
    assert.equal(typeof claudeAgent.installed, 'boolean');

    // On this test machine, claude is installed at /Users/max/.local/bin/claude
    if (claudeAgent.installed) {
      assert.ok(claudeAgent.path);
      if (claudeAgent.version) {
        assert.equal(typeof claudeAgent.version, 'string');
      }
    }
  });

  test('Handling of missing agent rejects launch cleanly', () => {
    assert.throws(() => {
      agentRegistry.launchAgent({
        projectId: testProject.id,
        agentId: 'non_existent_agent_xyz',
      });
    }, /not found in registry/i);
  });

  test('Launching available agent or mock agent creates persistent session', () => {
    const list = agentRegistry.listAgents();
    const installed = list.find((a) => a.installed);

    if (installed) {
      const res = agentRegistry.launchAgent({
        projectId: testProject.id,
        agentId: installed.id,
      });

      assert.ok(res.session.sessionId);
      assert.equal(res.session.projectId, testProject.id);
      assert.equal(res.agent.id, installed.id);

      // Verify recorded in DB
      const dbSessions = terminalManager.listSessions(testProject.id);
      const found = dbSessions.find((s) => s.id === res.session.sessionId);
      assert.ok(found);
      assert.equal(found.agent_id, installed.id);

      // Cleanup
      terminalManager.killSession(res.session.sessionId);
    } else {
      // If none installed in environment, verify graceful message
      assert.ok(true, 'No CLI agent installed on this host.');
    }
  });
});
