/** Discovery is read-only; destructive folder removal is confirmed, admin-only and ownership-safe. */
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-discovery-')));
const projectsDir = path.join(root, 'projects');
const fixturesDir = path.join(root, 'fixtures');
Object.assign(process.env, {
  DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'),
  PROJECTS_DIR: projectsDir, LOGS_DIR: path.join(root, 'logs'),
  CITADEL_SELF_UPDATE: '0', CITADEL_REQUIRE_SETUP_CODE: '0',
});
const { buildServer } = require('../server/index');
const { getDatabase, closeDatabase } = require('../server/database/db');
const projects = require('../server/services/projectService');
let app, cookie, viewerCookie;

function folder(name, base = projectsDir) {
  const target = path.join(base, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'fixture data');
  return target;
}

function deleteFolder(payload, session = cookie) {
  return app.inject({
    method: 'DELETE', url: '/api/projects/discover', payload,
    cookies: session ? { session_id: session } : {},
  });
}

function deletionAudits() {
  return getDatabase().prepare("SELECT * FROM audit_logs WHERE action = 'detected_folder_deleted'").all();
}

before(async () => {
  app = await buildServer({ logger: false });
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'discovery', password: 'Discovery-password-123' } });
  assert.equal(res.statusCode, 200);
  cookie = res.cookies.find((c) => c.name === 'session_id').value;
  getDatabase().prepare(`
    INSERT INTO users (id, username, password_hash, salt, role, created_at, updated_at)
    SELECT 'discovery-viewer', 'viewer', password_hash, salt, 'viewer', created_at, updated_at FROM users LIMIT 1
  `).run();
  const viewer = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'viewer', password: 'Discovery-password-123' } });
  assert.equal(viewer.statusCode, 200);
  viewerCookie = viewer.cookies.find((c) => c.name === 'session_id').value;
});
beforeEach(() => {
  getDatabase().prepare('DELETE FROM projects').run();
  getDatabase().prepare('DELETE FROM audit_logs').run();
  for (const dir of [projectsDir, fixturesDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
});
after(async () => {
  await app.close();
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('discovery returns only immediate unregistered folders without mutating projects', async () => {
  for (const name of ['new folder', '.hidden', 'node_modules', 'registered', 'linked-repo']) folder(name);
  const outside = folder('outside', fixturesDir);
  fs.symlinkSync(outside, path.join(projectsDir, 'symlink'));
  fs.writeFileSync(path.join(projectsDir, 'file'), 'not a directory');
  const project = projects.importProject({ name: 'Existing', targetPath: path.join(projectsDir, 'registered') });
  projects.addRepo({ projectId: project.id, targetPath: path.join(projectsDir, 'linked-repo') });
  assert.equal((await app.inject({ url: '/api/projects/discover' })).statusCode, 401);
  const res = await app.inject({ url: '/api/projects/discover', cookies: { session_id: cookie } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().directories.map((d) => d.name), ['new folder']);
  assert.equal(projects.listProjects().length, 1, 'discovery never imports implicitly');
  assert.equal(res.json().truncated, false);
  const imported = await app.inject({ method: 'POST', url: '/api/projects/import', cookies: { session_id: cookie }, payload: { name: 'new folder', targetPath: res.json().directories[0].path } });
  assert.equal(imported.statusCode, 200);
  assert.equal((await projects.discoverProjects()).directories.length, 0, 'registered folders are no longer suggested');
});

test('discovery limits response size in large directories', async () => {
  for (let i = 0; i < 105; i++) fs.mkdirSync(path.join(projectsDir, `large-${i}`));
  const result = await projects.discoverProjects();
  assert.equal(result.directories.length, 100);
  assert.equal(result.truncated, true);
});

test('folder deletion requires authentication and administrator privileges', async () => {
  const targetPath = folder('protected');
  const payload = { targetPath, confirmPath: targetPath };
  assert.equal((await deleteFolder(payload, null)).statusCode, 401);
  assert.equal((await deleteFolder(payload, viewerCookie)).statusCode, 403);
  assert.equal(fs.readFileSync(path.join(targetPath, 'keep.txt'), 'utf8'), 'fixture data');
  assert.equal(deletionAudits().length, 0);
});

test('folder deletion enforces exact typed confirmation on the server', async () => {
  const targetPath = folder('confirm me');
  for (const payload of [
    {}, { targetPath }, { targetPath, confirmPath: null }, { targetPath, confirmPath: true },
    { targetPath, confirmPath: '' }, { targetPath, confirmPath: 'confirm me' },
    { targetPath, confirmPath: `${targetPath} ` }, { targetPath, confirmPath: `${targetPath}/` },
    { targetPath: null, confirmPath: null }, { targetPath: [], confirmPath: [] },
    { targetPath: `${targetPath}\0`, confirmPath: `${targetPath}\0` },
  ]) {
    const res = await deleteFolder(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
  }
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/projects/discover', cookies: { session_id: cookie } })).statusCode, 400);
  assert.equal(projects.listProjects().length, 0);
  assert.equal(deletionAudits().length, 0);
});

test('folder deletion refuses roots, nested/outside paths, traversal, hidden folders and aliases', async () => {
  const target = folder('candidate');
  const nested = folder('nested', target);
  const outside = folder('outside', fixturesDir);
  const sibling = folder('projects-other', root);
  const hidden = folder('.hidden');
  const dependencies = folder('node_modules');
  const linked = path.join(projectsDir, 'linked');
  const internalLink = path.join(projectsDir, 'internal-link');
  fs.symlinkSync(outside, linked);
  fs.symlinkSync(target, internalLink);
  const rootAlias = path.join(fixturesDir, 'projects-alias');
  fs.symlinkSync(projectsDir, rootAlias);
  const ancestorAlias = path.join(fixturesDir, 'ancestor-alias');
  fs.symlinkSync(root, ancestorAlias);
  for (const targetPath of [
    projectsDir, root, '/', nested, outside, sibling, hidden, dependencies,
    `${target}/../candidate`, `${projectsDir}/../fixtures/outside`,
    `${target}/.`, `${target}/`, path.relative(process.cwd(), target),
    linked, internalLink, path.join(rootAlias, 'candidate'),
    path.join(ancestorAlias, 'projects', 'candidate'),
  ]) {
    const res = await deleteFolder({ targetPath, confirmPath: targetPath });
    assert.equal(res.statusCode, 400, targetPath);
    for (const preserved of [target, nested, outside, sibling, hidden, dependencies]) {
      assert.ok(fs.existsSync(path.join(preserved, 'keep.txt')), preserved);
    }
  }
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.ok(fs.lstatSync(internalLink).isSymbolicLink());
  assert.equal(deletionAudits().length, 0);
});

test('the managed root is never deletable even if projectsDir resolves to the filesystem root', (t) => {
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target, ...args) => target === projectsDir ? path.parse(projectsDir).root : realpath(target, ...args));
  const lstat = t.mock.method(fs, 'lstatSync', () => { throw new Error('Root must not be inspected for removal.'); });
  assert.throws(() => projects.deleteDiscoveredFolder({ targetPath: '/', confirmPath: '/' }), { statusCode: 400 });
  assert.equal(lstat.mock.calls.length, 0);
});

test('a project imported after discovery is protected at deletion time', async () => {
  const targetPath = folder('import-after-scan');
  assert.equal((await projects.discoverProjects()).directories.length, 1);
  const project = projects.importProject({ name: 'Imported after scan', targetPath });
  const res = await deleteFolder({ targetPath, confirmPath: targetPath });
  assert.equal(res.statusCode, 409);
  assert.ok(projects.getProject(project.id));
  assert.equal(projects.listRepos(project.id).length, 1);
  assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
  assert.equal(deletionAudits().length, 0);
});

test('a repository associated after discovery is protected at deletion time', async () => {
  const owner = projects.importProject({ name: 'Owner', targetPath: folder('owner') });
  const targetPath = folder('repo-after-scan');
  assert.ok((await projects.discoverProjects()).directories.some(d => d.path === targetPath));
  const repo = projects.addRepo({ projectId: owner.id, targetPath });
  const res = await deleteFolder({ targetPath, confirmPath: targetPath });
  assert.equal(res.statusCode, 409);
  assert.ok(projects.getRepo(owner.id, repo.id));
  assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
  assert.equal(deletionAudits().length, 0);
});

test('deleting an unregistered parent preserves a registered nested project', async () => {
  const targetPath = folder('parent');
  const nested = folder('deep/project', targetPath);
  const project = projects.importProject({ name: 'Nested project', targetPath: nested });
  // Isolate the projects-table check from the automatically inserted primary repo.
  getDatabase().prepare('DELETE FROM project_repos WHERE project_id = ?').run(project.id);
  assert.ok((await projects.discoverProjects()).directories.some(d => d.path === targetPath));
  const res = await deleteFolder({ targetPath, confirmPath: targetPath });
  assert.equal(res.statusCode, 409);
  assert.ok(projects.getProject(project.id));
  assert.ok(fs.existsSync(path.join(nested, 'keep.txt')));
  assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
  assert.equal(deletionAudits().length, 0);
});

test('deleting an unregistered parent preserves a registered nested repository', async () => {
  const owner = projects.importProject({ name: 'Owner', targetPath: folder('owner') });
  const targetPath = folder('parent');
  const nested = folder('deep/repo', targetPath);
  const repo = projects.addRepo({ projectId: owner.id, targetPath: nested });
  const res = await deleteFolder({ targetPath, confirmPath: targetPath });
  assert.equal(res.statusCode, 409);
  assert.ok(projects.getRepo(owner.id, repo.id));
  assert.ok(fs.existsSync(path.join(nested, 'keep.txt')));
  assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
  assert.equal(deletionAudits().length, 0);
});

test('canonical aliases in either ownership table protect folders and descendants, including missing descendants', async () => {
  for (const table of ['projects', 'project_repos']) {
    for (const suffix of ['', 'deep/registered', 'missing/registered']) {
      const label = `${table}-${suffix.split('/')[0] || 'self'}`;
      const targetPath = folder(label);
      const registeredPath = suffix ? folder(suffix, targetPath) : targetPath;
      const project = projects.importProject({ name: label, targetPath: registeredPath });
      const alias = path.join(fixturesDir, label);
      fs.symlinkSync(targetPath, alias);
      const storedPath = path.join(alias, suffix);
      if (table === 'projects') {
        getDatabase().prepare('DELETE FROM project_repos WHERE project_id = ?').run(project.id);
        getDatabase().prepare('UPDATE projects SET path = ? WHERE id = ?').run(storedPath, project.id);
      } else {
        const ownerPath = folder(`${label}-owner`, fixturesDir);
        getDatabase().prepare('UPDATE projects SET path = ? WHERE id = ?').run(ownerPath, project.id);
        getDatabase().prepare('UPDATE project_repos SET path = ? WHERE project_id = ?').run(storedPath, project.id);
      }
      if (suffix.startsWith('missing')) fs.rmSync(path.join(targetPath, 'missing'), { recursive: true });
      const res = await deleteFolder({ targetPath, confirmPath: targetPath });
      assert.equal(res.statusCode, 409, `${table}: ${suffix}`);
      assert.ok(projects.getProject(project.id));
      assert.equal(getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE path = ?`).get(storedPath).count, 1);
      assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
      if (!suffix.startsWith('missing')) assert.ok(fs.existsSync(path.join(registeredPath, 'keep.txt')));
    }
  }
  assert.equal(deletionAudits().length, 0);
});

test('a folder disappearing or changing to a file or symlink since discovery is refused', async () => {
  const outside = folder('outside', fixturesDir);
  for (const replacement of ['missing', 'file', 'symlink']) {
    const targetPath = folder(replacement);
    assert.ok((await projects.discoverProjects()).directories.some(d => d.path === targetPath));
    fs.rmSync(targetPath, { recursive: true });
    if (replacement === 'file') fs.writeFileSync(targetPath, 'replacement data');
    if (replacement === 'symlink') fs.symlinkSync(outside, targetPath);
    const res = await deleteFolder({ targetPath, confirmPath: targetPath });
    assert.equal(res.statusCode, replacement === 'missing' ? 404 : 400);
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
    if (replacement === 'file') assert.equal(fs.readFileSync(targetPath, 'utf8'), 'replacement data');
    if (replacement === 'symlink') assert.ok(fs.lstatSync(targetPath).isSymbolicLink());
  }
  assert.equal(deletionAudits().length, 0);
});

test('a directory identity change during validation prevents removal', async (t) => {
  const targetPath = folder('changed-during-check');
  const lstat = fs.lstatSync;
  let checks = 0;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    const stat = lstat(target, ...args);
    if (target === targetPath && ++checks === 2) stat.ino += 1;
    return stat;
  });
  const res = await deleteFolder({ targetPath, confirmPath: targetPath });
  assert.equal(res.statusCode, 409);
  assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
  assert.equal(deletionAudits().length, 0);
});

test('filesystem failures never report success or expose descendant error details', async (t) => {
  const targetPath = folder('failure');
  t.mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('private descendant secret contents'), { code: 'EACCES' });
  });
  const res = await deleteFolder({ targetPath, confirmPath: targetPath });
  assert.equal(res.statusCode, 400);
  assert.doesNotMatch(res.json().error, /private|secret|contents/);
  assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
  assert.equal(deletionAudits().length, 0);
});

test('folder deletion verifies actual removal before returning success or auditing', async (t) => {
  const targetPath = folder('not-removed');
  t.mock.method(fs, 'rmSync', () => {});
  const res = await deleteFolder({ targetPath, confirmPath: targetPath });
  assert.equal(res.statusCode, 409);
  assert.ok(fs.existsSync(path.join(targetPath, 'keep.txt')));
  assert.equal(deletionAudits().length, 0);
});

test('successful deletion removes only the confirmed fixture, audits metadata, and disappears on rediscovery', async () => {
  const targetPath = folder('delete me');
  folder('nested/files', targetPath);
  const retained = folder('retained');
  const outside = folder('outside', fixturesDir);
  fs.symlinkSync(outside, path.join(targetPath, 'external-link'));
  assert.deepEqual((await projects.discoverProjects()).directories.map(d => d.path), [targetPath, retained]);
  const res = await deleteFolder({ targetPath, confirmPath: targetPath, secret: 'must not be audited' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { success: true, path: targetPath, filesDeleted: true });
  assert.equal(fs.existsSync(targetPath), false);
  assert.ok(fs.existsSync(path.join(retained, 'keep.txt')));
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'recursive deletion never follows a child symlink');
  assert.equal(projects.listProjects().length, 0, 'folder removal never implicitly imports');
  const rediscovery = await app.inject({ url: '/api/projects/discover', cookies: { session_id: cookie } });
  assert.deepEqual(rediscovery.json().directories.map(d => d.path), [retained]);
  const [audit] = deletionAudits();
  assert.equal(deletionAudits().length, 1);
  assert.equal(audit.target_type, 'directory');
  assert.equal(audit.target_id, targetPath);
  assert.equal(audit.user_id, getDatabase().prepare("SELECT id FROM users WHERE username = 'discovery'").get().id);
  assert.deepEqual(JSON.parse(audit.details), { path: targetPath, filesDeleted: true });
  assert.doesNotMatch(audit.details, /must not be audited|fixture data/);
});

test('the ownership validation and removal service stays synchronous', async () => {
  const targetPath = folder('synchronous');
  let nextTurn = false;
  const queued = Promise.resolve().then(() => { nextTurn = true; });
  const result = projects.deleteDiscoveredFolder({ targetPath, confirmPath: targetPath });
  assert.equal(nextTurn, false, 'no promise gap before deletion');
  assert.equal(result.then, undefined, 'service must not return a promise');
  assert.deepEqual(result, { success: true, path: targetPath, filesDeleted: true });
  assert.equal(fs.existsSync(targetPath), false);
  await queued;
});
