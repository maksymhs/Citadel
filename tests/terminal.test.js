const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const terminalManager = require('../server/services/terminalManager');
const { initDatabase, closeDatabase } = require('../server/database/db');

describe('Terminal & Persistent Session Tests', () => {
  const testDb = path.resolve(__dirname, '../data/test-terminal.db');
  const projectDir1 = path.resolve(__dirname, '../data/test-term-proj1');
  const projectDir2 = path.resolve(__dirname, '../data/test-term-proj2');

  before(() => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    fs.mkdirSync(projectDir1, { recursive: true });
    fs.mkdirSync(projectDir2, { recursive: true });
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (fs.existsSync(projectDir1)) fs.rmSync(projectDir1, { recursive: true, force: true });
    if (fs.existsSync(projectDir2)) fs.rmSync(projectDir2, { recursive: true, force: true });
  });

  test('tmux availability check should return boolean', () => {
    const avail = terminalManager.isTmuxAvailable();
    assert.equal(typeof avail, 'boolean');
  });

  test('Create terminal session, verify PTY spawn and output buffer', async () => {
    const session = terminalManager.createSession({
      name: 'Test Shell',
      cwd: projectDir1,
      cols: 80,
      rows: 24,
    });

    assert.ok(session.sessionId);
    assert.ok(session.tmuxSession);
    assert.equal(session.cwd, projectDir1);

    // Verify PTY in active sessions
    const active = terminalManager.activePtySessions.get(session.sessionId);
    assert.ok(active);
    assert.ok(active.ptyProcess);

    // Send a command to PTY
    active.ptyProcess.write('echo "TEST_CITADEL_PTY_OK"\r');

    // Wait 500ms for stdout to appear in buffer
    await new Promise((r) => setTimeout(r, 600));

    assert.ok(active.buffer.includes('TEST_CITADEL_PTY_OK'));

    // Kill session
    const res = terminalManager.killSession(session.sessionId);
    assert.equal(res.success, true);
    assert.equal(terminalManager.activePtySessions.has(session.sessionId), false);
  });

  test('Two distinct projects maintain isolated terminal sessions', async () => {
    const s1 = terminalManager.createSession({
      name: 'Project 1 Terminal',
      cwd: projectDir1,
    });

    const s2 = terminalManager.createSession({
      name: 'Project 2 Terminal',
      cwd: projectDir2,
    });

    assert.notEqual(s1.sessionId, s2.sessionId);
    assert.notEqual(s1.tmuxSession, s2.tmuxSession);
    assert.equal(s1.cwd, projectDir1);
    assert.equal(s2.cwd, projectDir2);

    // Cleanup both
    terminalManager.killSession(s1.sessionId);
    terminalManager.killSession(s2.sessionId);
  });

  test('System Terminal run-as resolution honors the admin user', () => {
    // Project sessions always run as the unprivileged service user.
    assert.equal(terminalManager._buildRunAs('some-project-id', 'ubuntu'), null);

    // Global sessions run as the admin user when configured.
    const runAs = terminalManager._buildRunAs(null, 'ubuntu');
    assert.ok(runAs);
    assert.equal(runAs.command, 'sudo');
    assert.equal(runAs.user, 'ubuntu');
    assert.deepEqual(runAs.args, ['-u', 'ubuntu', '-H', '/bin/bash', '-lc', 'cd "$HOME" 2>/dev/null; exec /bin/bash -l']);

    // No admin user configured means no privilege escalation.
    assert.equal(terminalManager._buildRunAs(null, null), null);
  });

  test('tmuxCopyMode reports a clear error for unknown sessions', () => {
    const res = terminalManager.tmuxCopyMode('missing-session-id', 'enter');
    assert.equal(res.success, false);
    assert.ok(res.error);
  });

  test('createSession marks the row closed when the PTY cannot spawn', () => {
    const pty = require('node-pty');
    const original = pty.spawn;
    pty.spawn = () => { throw new Error('simulated pty failure'); };
    try {
      assert.throws(
        () => terminalManager.createSession({ name: 'Broken Session', cwd: projectDir1 }),
        /simulated pty failure/,
      );
    } finally {
      pty.spawn = original;
    }

    const { getDatabase } = require('../server/database/db');
    const row = getDatabase()
      .prepare("SELECT status FROM term_sessions WHERE name = 'Broken Session'")
      .get();
    assert.ok(row);
    assert.equal(row.status, 'closed');
  });

  test('an explicitly requested command never silently falls back to /bin/sh', () => {
    const pty = require('node-pty');
    const original = pty.spawn;
    let calls = 0;
    pty.spawn = (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated tmux failure');
      return original(...args);
    };
    try {
      assert.throws(
        () => terminalManager._spawnPty({
          sessionId: 'test-no-fallback',
          tmuxSessionName: 'citadel_test_no_fallback',
          cwd: projectDir1,
          cols: 80,
          rows: 24,
          command: '/bin/true',
          args: [],
        }),
        /Failed to spawn terminal session/,
      );
      // Exactly one attempt: no silent unprivileged fallback.
      assert.equal(calls, 1);
    } finally {
      pty.spawn = original;
    }
  });

  test('tmuxCopyMode enter/exit works on a tmux-backed session', async () => {
    if (!terminalManager.isTmuxAvailable()) return;

    const session = terminalManager.createSession({ name: 'Copy Mode Terminal', cwd: projectDir1 });
    await new Promise((r) => setTimeout(r, 300));

    const enter = terminalManager.tmuxCopyMode(session.sessionId, 'enter');
    assert.equal(enter.success, true);

    const exit = terminalManager.tmuxCopyMode(session.sessionId, 'exit');
    assert.equal(exit.success, true);

    terminalManager.killSession(session.sessionId);
  });
});
