const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { AGENTS_DIR } = require('../server/config');
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

  test('built-in agents advertise an official one-line installer', () => {
    const list = agentRegistry.listAgents();
    for (const id of ['claude', 'codex', 'opencode', 'antigravity', 'kilocode', 'qwen']) {
      const agent = list.find((a) => a.id === id);
      assert.ok(agent, `${id} should be registered`);
      assert.equal(typeof agent.installCommand, 'string');
      assert.match(agent.installCommand, /install|npm/i);
    }
  });

  test('install command installs into a shared location for all users', () => {
    for (const agent of agentRegistry.listAgents().filter((a) => a.installCommand)) {
      const cmd = agentRegistry.buildInstallCommand(agent);
      assert.match(cmd, /export HOME=/);
      assert.ok(cmd.includes(AGENTS_DIR), 'should install under the shared AGENTS_DIR');
      assert.ok(cmd.includes(`"$AG/bin/${agent.binaryName}"`), 'should link the binary into AGENTS_DIR/bin');
      assert.doesNotMatch(cmd, /\bsudo\b/, 'the service user has no sudo (NoNewPrivileges)');
      const res = spawnSync('bash', ['-n'], { input: cmd, encoding: 'utf8' });
      assert.equal(res.status, 0, `bash syntax error: ${res.stderr}`);
    }
  });

  describe('install script behaviour', () => {
    const os = require('node:os');
    const REGISTRY = path.join(__dirname, '../server/services/agentRegistry');
    const FAKE_INSTALL = 'mkdir -p "$HOME/.local/bin" && printf \'#!/bin/sh\\necho fake-1.0\\n\' > "$HOME/.local/bin/fakeagent" && chmod 700 "$HOME/.local/bin/fakeagent"';

    function runInstall(installCommand) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-agents-'));
      const shared = path.join(tmp, 'shared');
      const home = path.join(tmp, 'home');
      fs.mkdirSync(home);
      const agent = { name: "Fake 'Agent'", binaryName: 'fakeagent', installCommand };
      const gen = spawnSync(process.execPath, ['-e',
        'process.stdout.write(require(process.env.REG).buildInstallCommand(JSON.parse(process.env.AGENT)))'], {
        env: { ...process.env, CITADEL_AGENTS_DIR: shared, REG: REGISTRY, AGENT: JSON.stringify(agent) },
        encoding: 'utf8',
      });
      assert.equal(gen.status, 0, gen.stderr);
      const run = spawnSync('bash', ['-c', `${gen.stdout}\necho "HOME_AFTER=$HOME"`], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      return { tmp, shared, home, run, output: `${run.stdout}${run.stderr}` };
    }

    test('installs with HOME at the shared dir, links the binary and keeps HOME intact', () => {
      const { tmp, shared, home, output } = runInstall(FAKE_INSTALL);
      try {
        const link = path.join(shared, 'bin', 'fakeagent');
        assert.equal(spawnSync(link, [], { encoding: 'utf8' }).stdout.trim(), 'fake-1.0', output);
        const real = path.join(shared, '.local', 'bin', 'fakeagent');
        assert.equal(fs.statSync(real).mode & 0o055, 0o055, 'other users must be able to run it');
        assert.match(output, /installed for every user/);
        assert.match(output, new RegExp(`HOME_AFTER=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('reports a failing installer, including a failed download in a pipe', () => {
      for (const cmd of ['false', 'false | cat']) {
        const { tmp, output } = runInstall(cmd);
        try {
          assert.match(output, /installer failed/, `${cmd}: ${output}`);
          assert.doesNotMatch(output, /installed for every user/);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
    });

    test('reports an installer that produced no binary', () => {
      const { tmp, output } = runInstall('true');
      try {
        assert.match(output, /no 'fakeagent' binary was found/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
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
