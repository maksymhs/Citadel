const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const testRoot = path.resolve(__dirname, '../data/test-docs-data');
process.env.DATA_DIR = testRoot;
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
process.env.CITADEL_MISSIONS_DIR = path.join(testRoot, 'missions');
process.env.CITADEL_DOCS_SUBDIR = 'docs';

const { initDatabase, getDatabase, closeDatabase } = require('../server/database/db');
const projectService = require('../server/services/projectService');
const docService = require('../server/services/docService');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('Project docs', () => {
  const testDb = path.join(testRoot, 'citadel.db');
  const repoPath = path.join(testRoot, 'repo');
  let project;

  before(() => {
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Repo\n');
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    initDatabase(testDb);
    project = projectService.importProject({ name: 'Docs repo', targetPath: repoPath });
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('creates, lists and reads Markdown without touching existing content', async () => {
    const created = docService.createDoc({
      projectId: project.id,
      relPath: 'architecture.md',
      content: '# Architecture\n\nKeep it small.\n',
    });
    assert.equal(created.path, 'architecture.md');
    assert.ok(fs.existsSync(path.join(repoPath, 'docs', 'architecture.md')));

    const list = await docService.listDocs({ projectId: project.id });
    assert.ok(list.docs.some((doc) => doc.path === 'architecture.md'));
    assert.ok(list.docs.find((doc) => doc.path === 'architecture.md').pending, 'a new doc should be uncommitted');

    const read = docService.readDoc({ projectId: project.id, relPath: 'architecture.md' });
    assert.match(read.content, /Keep it small/);
    assert.equal(read.title, 'Architecture');

    assert.throws(() => docService.createDoc({
      projectId: project.id, relPath: 'architecture.md', content: '# Replacement\n',
    }), /already exists/i);
    assert.match(fs.readFileSync(path.join(repoPath, 'docs', 'architecture.md'), 'utf8'), /Keep it small/);
  });

  test('updates a page and records links to a task and mission', () => {
    const updated = docService.updateDoc({
      projectId: project.id,
      relPath: 'architecture.md',
      content: '# Architecture\n\nUpdated behaviour.\n',
    });
    assert.match(updated.content, /Updated behaviour/);
    assert.throws(() => docService.updateDoc({
      projectId: project.id,
      relPath: 'architecture.md',
      content: '# Stale\n',
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
    }), /changed since it was loaded/i);

    const linked = docService.linkDoc({
      projectId: project.id, relPath: 'architecture.md', taskId: 'task-1', missionId: 'mission-1',
    });
    assert.equal(linked.taskId, 'task-1');
    assert.equal(linked.missionId, 'mission-1');
    const row = getDatabase().prepare('SELECT * FROM documents WHERE project_id = ? AND path = ?').get(project.id, 'architecture.md');
    assert.equal(row.task_id, 'task-1');
  });

  test('path traversal, symlinks and credentials are refused', () => {
    assert.throws(() => docService.readDoc({ projectId: project.id, relPath: '../citadel.db' }), /invalid/i);
    assert.throws(() => docService.createDoc({
      projectId: project.id, relPath: '../../outside.md', content: '# x\n',
    }), /invalid/i);
    assert.throws(() => docService.createDoc({
      projectId: project.id, relPath: 'notes.txt', content: 'x',
    }), /markdown/i);

    const outside = path.join(testRoot, 'outside.md');
    fs.writeFileSync(outside, '# secret\n');
    fs.symlinkSync(outside, path.join(repoPath, 'docs', 'escape.md'));
    assert.throws(() => docService.readDoc({ projectId: project.id, relPath: 'escape.md' }), /invalid/i);
    const list = docService.listDocs({ projectId: project.id });
    return list.then((result) => {
      assert.ok(!result.docs.some((doc) => doc.path === 'escape.md'), 'symlinks are not listed');
    });
  });

  test('refuses to write a document that looks like it contains a token', () => {
    assert.throws(() => docService.createDoc({
      projectId: project.id,
      relPath: 'leak.md',
      content: '# Leak\n\nsecret sk-abcdefghijklmnop\n',
    }), /credential/i);
    assert.ok(!fs.existsSync(path.join(repoPath, 'docs', 'leak.md')));
  });

  test('wiki links and task/mission references become navigable relations', () => {
    docService.createDoc({
      projectId: project.id,
      relPath: 'guide.md',
      content: '# Guide\n\nSee [[architecture]] for the design. Link to [[missing-page]] too.\n',
      taskId: 'task-9',
      missionId: 'mission-9',
    });
    const guide = docService.readDoc({ projectId: project.id, relPath: 'guide.md' });
    assert.deepEqual(guide.links, ['architecture.md', 'missing-page.md']);
    assert.deepEqual(guide.refs, [{ kind: 'mission', id: 'mission-9' }, { kind: 'task', id: 'task-9' }]);

    const architecture = docService.readDoc({ projectId: project.id, relPath: 'architecture.md' });
    assert.ok(architecture.backlinks.includes('guide.md'));

    docService.linkDoc({ projectId: project.id, relPath: 'guide.md', taskId: 'task-10' });
    const relinked = docService.readDoc({ projectId: project.id, relPath: 'guide.md' });
    assert.deepEqual(relinked.refs, [
      { kind: 'mission', id: 'mission-9' },
      { kind: 'task', id: 'task-10' },
      { kind: 'task', id: 'task-9' },
    ], 'linking another task keeps the earlier task relation');
    assert.deepEqual(relinked.links, ['architecture.md', 'missing-page.md'], 'refreshing a link keeps wiki links');
  });

  test('relevantDocs only returns paths and titles, never the body', () => {
    const docs = docService.relevantDocs({ projectId: project.id, q: 'architecture' });
    assert.ok(docs.some((doc) => doc.path === 'architecture.md'));
    assert.ok(docs.every((doc) => !('content' in doc)));
  });
  test('directly written Markdown is registered on linking and updates preserve earlier refs', () => {
    fs.writeFileSync(path.join(repoPath, 'docs', 'agent.md'), '# Agent output\n');
    const linked = docService.linkDoc({ projectId: project.id, relPath: 'agent.md', taskId: 'first' });
    assert.equal(linked.taskId, 'first');
    docService.updateDoc({ projectId: project.id, relPath: 'agent.md', content: '# Updated\n', taskId: 'second' });
    const doc = docService.readDoc({ projectId: project.id, relPath: 'agent.md' });
    assert.deepEqual(doc.refs, [{ kind: 'task', id: 'first' }, { kind: 'task', id: 'second' }]);
  });

  test('reading unchanged Markdown does not rewrite metadata or links', () => {
    const input = { projectId: project.id, relPath: 'guide.md' };
    docService.readDoc(input);
    const before = getDatabase().prepare('SELECT total_changes() n').get().n;
    docService.readDoc(input);
    const after = getDatabase().prepare('SELECT total_changes() n').get().n;
    assert.equal(after, before, 'polling unchanged docs must not generate SQLite writes');
  });

});
