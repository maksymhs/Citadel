const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
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

  test('mission detection skips probes while normal detection requires a working CLI', () => {
    const find = agentRegistry.findBinary;
    const version = agentRegistry.getBinaryVersion;
    let probes = 0;
    agentRegistry.findBinary = () => process.execPath;
    agentRegistry.getBinaryVersion = () => { probes++; return null; };
    try {
      const quick = agentRegistry.listAgents({ versions: false });
      assert.equal(probes, 0, 'mission planning must not execute version commands per subtask');
      assert.ok(quick.every((agent) => agent.detected && agent.installed && agent.version === null));
      assert.ok(quick.every((agent) => typeof agent.managed === 'boolean'));
      const full = agentRegistry.listAgents();
      assert.ok(probes > 0);
      assert.ok(full.every((agent) => agent.detected && !agent.installed), 'an executable with a failing version probe is not a validated install');
    } finally {
      agentRegistry.findBinary = find;
      agentRegistry.getBinaryVersion = version;
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

  test('built-in agents advertise an official one-line installer', () => {
    const list = agentRegistry.listAgents();
    for (const id of ['claude', 'codex', 'opencode', 'antigravity', 'kilocode', 'qwen']) {
      const agent = list.find((a) => a.id === id);
      assert.ok(agent, `${id} should be registered`);
      assert.equal(typeof agent.installCommand, 'string');
      assert.match(agent.installCommand, /install|npm/i);
    }
  });

  test('lifecycle command selects only a fixed agent through the service helper', () => {
    for (const agent of agentRegistry.listAgents().filter((a) => a.installCommand)) {
      const cmd = agentRegistry.buildInstallCommand(agent);
      assert.match(cmd, /manage-agent\.js/);
      assert.ok(cmd.includes(agent.id), 'should select a fixed catalogue entry');
      assert.doesNotMatch(cmd, /\bsudo\b/, 'the service user has no sudo (NoNewPrivileges)');
      const res = spawnSync('bash', ['-n'], { input: cmd, encoding: 'utf8' });
      assert.equal(res.status, 0, `bash syntax error: ${res.stderr}`);
    }
  });

  test('install command rejects an unsafe binary name', () => {
    assert.throws(() => {
      agentRegistry.buildInstallCommand({ name: 'Evil', binaryName: 'x; rm -rf /', installCommand: 'true' });
    }, /Invalid binary name/i);
  });

  test('Installing an unknown agent is rejected', () => {
    assert.throws(() => {
      agentRegistry.installAgent({ agentId: 'non_existent_agent_xyz' });
    }, /not found in registry/i);
  });

  test('Installing a missing built-in agent starts a terminal session', () => {
    const missing = agentRegistry.listAgents().find((a) => a.installCommand && !a.installed);
    if (!missing) {
      assert.ok(true, 'Every built-in agent is already installed on this host.');
      return;
    }
    const res = agentRegistry.installAgent({ agentId: missing.id });
    assert.ok(res.session.sessionId);
    assert.equal(res.agent.installCommand, missing.installCommand);
    terminalManager.killSession(res.session.sessionId);
  });
});
