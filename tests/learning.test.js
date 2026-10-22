const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const testRoot = path.resolve(__dirname, '../data/test-learning-data');
process.env.DATA_DIR = testRoot;
process.env.DATABASE_PATH = path.join(testRoot, 'citadel.db');
process.env.PROJECTS_DIR = path.join(testRoot, 'projects');
process.env.LOGS_DIR = path.join(testRoot, 'logs');
process.env.CITADEL_MISSIONS_DIR = path.join(testRoot, 'missions');

const { initDatabase, getDatabase, closeDatabase } = require('../server/database/db');
const learningService = require('../server/services/learningService');

function cleanDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('Learning memory', () => {
  const testDb = path.join(testRoot, 'citadel.db');

  before(() => {
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    cleanDb(testDb);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('a failure is project-scoped and a repeat updates occurrences instead of duplicating', () => {
    const task = {
      id: 'task-1', title: 'Run tests', role: 'qa', agent: 'opencode', attempt: 1, maxAttempts: 3,
      error: 'AssertionError: expected 1 but got 2', result: '', handoffRef: 'handoff/qa.md',
    };
    const first = learningService.recordFailure({ task, projectId: 'proj-a', missionId: 'mission-1' });
    const second = learningService.recordFailure({
      task: { ...task, id: 'task-2', attempt: 2 },
      projectId: 'proj-a',
      missionId: 'mission-1',
    });
    assert.equal(first.id, second.id);
    assert.equal(second.occurrences, 2);
    assert.equal(second.scope, 'project');
    assert.equal(second.rootCauseConfirmed, false);
    const count = getDatabase().prepare('SELECT COUNT(*) c FROM lessons').get().c;
    assert.equal(count, 1);
    assert.match(second.evidence.join(' '), /AssertionError/);
  });

  test('project memory is isolated and global knowledge is only reachable explicitly', () => {
    learningService.recordFailure({
      task: { id: 'task-b', title: 'Lint', role: 'backend', error: 'eslint failed', attempt: 1 },
      projectId: 'proj-b',
      missionId: 'mission-b',
    });
    const forA = learningService.relevantLessons({ projectId: 'proj-a', text: 'qa tests assertions', limit: 20 });
    assert.ok(forA.every((lesson) => lesson.projectId !== 'proj-b'), 'project A must not see project B lessons');
    assert.ok(forA.some((lesson) => lesson.projectId === 'proj-a'));

    const all = learningService.listLessons({ projectId: 'proj-a' });
    assert.ok(all.every((lesson) => lesson.scope === 'global' || lesson.projectId === 'proj-a'));

    const pending = learningService.listLessons({ projectId: 'proj-b' })[0];
    assert.equal(pending.scope, 'project');
    const promoted = learningService.promoteLesson(pending.id);
    assert.equal(promoted.scope, 'global');
    assert.equal(promoted.projectId, null);
    const forA2 = learningService.relevantLessons({ projectId: 'proj-a', text: 'lint eslint', limit: 20 });
    assert.ok(forA2.some((lesson) => lesson.scope === 'global'), 'promoted global lesson should be visible everywhere');
  });

  test('user corrections are confirmed project context and never auto-promoted', () => {
    const lesson = learningService.recordCorrection({
      task: { id: 'task-c', title: 'Change scheduler', role: 'developer', attempt: 1, error: '' },
      projectId: 'proj-a',
      missionId: 'mission-c',
      text: 'Inspect the existing recovery mechanism first and extend its tests; do not add a second scheduler.',
    });
    assert.equal(lesson.status, 'confirmed');
    assert.equal(lesson.scope, 'project');
    assert.equal(lesson.rootCauseConfirmed, true);
    const relevant = learningService.relevantLessons({ projectId: 'proj-a', text: 'scheduler recovery', limit: 10 });
    assert.ok(relevant.some((l) => l.id === lesson.id), 'a clear correction is immediately retrievable for its project');
    const other = learningService.relevantLessons({ projectId: 'proj-b', text: 'scheduler recovery', limit: 20 });
    assert.ok(!other.some((l) => l.id === lesson.id), 'the correction must not leak to another project');
  });

  test('a discarded or superseded lesson stops being applied', () => {
    const oldLesson = learningService.recordLesson({
      scope: 'project', projectId: 'proj-a', title: 'Old convention', rule: 'Use the old scheduler', status: 'confirmed',
    });
    const replacement = learningService.recordLesson({
      scope: 'project', projectId: 'proj-a', title: 'New convention', rule: 'Use the unified scheduler', status: 'confirmed',
    });
    learningService.supersedeLesson(oldLesson.id, replacement.id);
    const old = learningService.getLesson(oldLesson.id);
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, replacement.id);
    const relevant = learningService.relevantLessons({ projectId: 'proj-a', text: 'scheduler', limit: 20 });
    assert.ok(!relevant.some((l) => l.id === oldLesson.id), 'superseded lessons are not applied');

    const toDiscard = learningService.recordLesson({ scope: 'project', projectId: 'proj-a', title: 'Noise', status: 'confirmed' });
    learningService.discardLesson(toDiscard.id);
    assert.equal(learningService.getLesson(toDiscard.id).status, 'discarded');
  });

  test('secrets are redacted and quota failures get a bounded, honest lesson', () => {
    const lesson = learningService.recordFailure({
      task: {
        id: 'task-q', title: 'Agent call', role: 'developer', attempt: 1,
        error: 'HTTP 429 quota exceeded; Authorization: Bearer abcdefghijklmnop; reset in 12:30',
      },
      projectId: 'proj-a',
      missionId: 'mission-q',
    });
    const serialised = JSON.stringify(lesson);
    assert.ok(!serialised.includes('abcdefghijklmnop'), 'bearer token must be redacted');
    assert.equal(learningService.isQuotaError('HTTP 429 too many requests'), true);
    assert.match(lesson.rule, /quota/i);
    assert.match(lesson.rootCause, /12:30|reset/i);
  });

  test('a manual row cannot be created directly as global', async () => {
    const lesson = learningService.recordLesson({ scope: 'global', title: 'Try global', status: 'confirmed' });
    assert.equal(lesson.scope, 'project');
  });
});
