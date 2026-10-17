const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const gitService = require('../server/services/gitService');
const proxyProvider = require('../server/services/proxyProvider');
const dockerService = require('../server/services/dockerService');
const { initDatabase, closeDatabase } = require('../server/database/db');

describe('Integrations & Optional Services Tests', () => {
  const testDb = path.resolve(__dirname, '../data/test-integ.db');
  const rootRepo = path.resolve(__dirname, '..');

  before(() => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    initDatabase(testDb);
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  });

  test('gitService detects git repo and extracts status & commit history', async () => {
    assert.equal(gitService.isGitRepo(rootRepo), true);
    assert.equal(gitService.isGitRepo('/non/existent/path'), false);

    const status = await gitService.getStatus(rootRepo);
    assert.equal(status.isGitRepo, true);
    assert.ok(status.branch);

    const commits = await gitService.getRecentCommits(rootRepo, 5);
    assert.ok(Array.isArray(commits));
  });

  test('proxyProvider handles offline Caddy gracefully without throwing', async () => {
    const status = await proxyProvider.getStatus();
    assert.equal(status.provider, 'caddy');
    assert.equal(typeof status.available, 'boolean');
    assert.ok(status.helpMessage);

    // Publishing domain when Caddy is offline still records deployment in SQLite as saved_offline
    const testProjectId = require('node:crypto').randomUUID();
    // Insert mock project
    const { getDatabase } = require('../server/database/db');
    getDatabase().prepare(`
      INSERT INTO projects (id, name, slug, path, created_at, updated_at)
      VALUES (?, 'Deploy Test', 'deploy-test', '/tmp', 'now', 'now')
    `).run(testProjectId);

    const res = await proxyProvider.publishDomain(testProjectId, 'test.app.nexusvps.local', 8080);
    assert.ok(res.id);
    assert.equal(res.domain, 'test.app.nexusvps.local');
    assert.equal(res.targetPort, 8080);

    // Unpublish
    const unpub = await proxyProvider.unpublishDomain('test.app.nexusvps.local');
    assert.equal(unpub.success, true);
  });

  test('dockerService handles offline / absent Docker socket safely', async () => {
    const status = await dockerService.getStatus();
    assert.equal(typeof status.available, 'boolean');
    if (!status.available) {
      assert.ok(status.message);
    }

    const containers = await dockerService.listContainers();
    assert.ok(Array.isArray(containers));
  });
});
