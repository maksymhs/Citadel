const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('Project repositories (associate, clone, remove)', () => {
  const testDb = path.resolve(__dirname, '../data/test-repos.db');
  let app;
  let cookie;
  let externalRepo;
  let project;

  before(async () => {
    cleanDb(testDb);
    externalRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-repo-'));
    fs.writeFileSync(path.join(externalRepo, 'README.md'), '# external\n');

    const { buildServer } = require('../server/index');
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'repoadmin', password: 'SuperPassword123!' },
    });
    cookie = setup.cookies.find((c) => c.name === 'session_id').value;

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { session_id: cookie },
      payload: { name: 'Repo Host', description: 'holds repos' },
    });
    project = JSON.parse(created.payload).project;
  });

  after(async () => {
    await app.close();
    const { closeDatabase } = require('../server/database/db');
    closeDatabase();
    cleanDb(testDb);
    if (externalRepo && fs.existsSync(externalRepo)) fs.rmSync(externalRepo, { recursive: true, force: true });
  });

  test('a new project exposes exactly one primary repository', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/repos`,
      cookies: { session_id: cookie },
    });
    assert.equal(res.statusCode, 200);
    const { repos } = JSON.parse(res.payload);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].is_primary, true);
    assert.equal(repos[0].path, project.path);
  });

  test('associating an existing directory does not move or copy it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/repos`,
      cookies: { session_id: cookie },
      payload: { targetPath: externalRepo, name: 'external' },
    });
    assert.equal(res.statusCode, 200);
    const { repo } = JSON.parse(res.payload);
    assert.equal(repo.path, fs.realpathSync(externalRepo));
    assert.ok(fs.existsSync(path.join(externalRepo, 'README.md')));
  });

  test('the same directory cannot be associated twice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/repos`,
      cookies: { session_id: cookie },
      payload: { targetPath: externalRepo, name: 'external-again' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a missing directory is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/repos`,
      cookies: { session_id: cookie },
      payload: { targetPath: '/definitely/not/here-xyz', name: 'ghost' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('git status is available per repository', async () => {
    const repoRoot = path.resolve(__dirname, '..');
    const add = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/repos`,
      cookies: { session_id: cookie },
      payload: { targetPath: repoRoot, name: 'citadel' },
    });
    assert.equal(add.statusCode, 200);
    const { repo } = JSON.parse(add.payload);

    const status = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/repos/${repo.id}/git/status`,
      cookies: { session_id: cookie },
    });
    assert.equal(status.statusCode, 200);
    const { status: gitStatus } = JSON.parse(status.payload);
    assert.equal(gitStatus.isGitRepo, true);
    assert.ok(gitStatus.branch);
  });

  test('cloning rejects an invalid repository URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/repos/clone`,
      cookies: { session_id: cookie },
      payload: { repoUrl: 'not a url', name: 'bad' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('cloning never overwrites an existing, non-empty directory', async () => {
    const target = path.join(project.path, 'occupied');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'do not clobber');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/repos/clone`,
      cookies: { session_id: cookie },
      payload: { repoUrl: 'https://example.com/example.git', name: 'occupied' },
    });
    assert.equal(res.statusCode, 409);
    assert.ok(fs.existsSync(path.join(target, 'keep.txt')));
    fs.rmSync(target, { recursive: true, force: true });
  });

  test('removing a repository preserves its files by default', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/repos`,
      cookies: { session_id: cookie },
    });
    const external = JSON.parse(list.payload).repos.find((r) => r.name === 'external');
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}/repos/${external.id}`,
      cookies: { session_id: cookie },
    });
    assert.equal(del.statusCode, 200);
    assert.ok(fs.existsSync(externalRepo));
  });

  test('a project terminal can start inside a chosen repository', async () => {
    const projectService = require('../server/services/projectService');
    const terminalManager = require('../server/services/terminalManager');
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-repo-cwd-'));
    try {
      const repo = projectService.addRepo({ projectId: project.id, targetPath: repoDir, name: 'cwd-repo' });
      const session = terminalManager.createSession({ projectId: project.id, repoId: repo.id, name: 'repo shell' });
      assert.equal(session.cwd, fs.realpathSync(repoDir));
      assert.equal(session.projectId, project.id);
      terminalManager.killSession(session.sessionId);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
