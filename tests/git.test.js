const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildServer } = require('../server/index');
const { closeDatabase, getDatabase } = require('../server/database/db');
const { encrypt, decrypt } = require('../server/security/secrets');
const gitCredentialsService = require('../server/services/gitCredentialsService');

describe('Git Credentials & Repository Discovery', () => {
  let app;
  let authCookie;
  const testDb = path.resolve(__dirname, '../data/test-git.db');

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    app = await buildServer({ customDbPath: testDb, logger: false });

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'gitadmin', password: 'SuperPassword123!' },
    });
    authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  test('secrets encrypt/decrypt roundtrip and tamper detection', () => {
    const secret = 'ghp_exampleTokenValue123456789';
    const ciphertext = encrypt(secret);
    assert.notEqual(ciphertext, secret);
    assert.ok(ciphertext.startsWith('v1:'));
    assert.equal(decrypt(ciphertext), secret);

    const parts = ciphertext.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    assert.throws(() => decrypt(parts.join(':')));
    assert.equal(decrypt('garbage'), null);
  });

  test('GET /api/git/credentials lists providers without tokens', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/git/credentials', cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.providers.length, 2);
    assert.ok(body.providers.every((p) => p.configured === false));
  });

  test('POST /api/git/credentials stores an encrypted token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/credentials',
      cookies: { session_id: authCookie },
      payload: { provider: 'github', token: 'ghp_secretToken123456', username: 'octocat' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.credential.provider, 'github');
    assert.equal(body.credential.username, 'octocat');
    assert.equal(res.payload.includes('ghp_secretToken123456'), false);

    const db = getDatabase();
    const row = db.prepare("SELECT value_encrypted AS token_encrypted FROM secrets WHERE name = 'GITHUB_TOKEN'").get();
    assert.ok(row.token_encrypted.startsWith('v1:'));
    assert.equal(row.token_encrypted.includes('ghp_secretToken123456'), false);
  });

  test('POST /api/git/credentials rejects an unknown provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/credentials',
      cookies: { session_id: authCookie },
      payload: { provider: 'bitbucket', token: 'whatever12345' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('resolveAuthForUrl maps known hosts to stored credentials', () => {
    const auth = gitCredentialsService.resolveAuthForUrl('https://github.com/octocat/hello-world.git');
    assert.ok(auth);
    assert.equal(auth.provider, 'github');
    assert.equal(auth.host, 'github.com');
    assert.equal(auth.token, 'ghp_secretToken123456');
    assert.equal(auth.cloneUser, 'x-access-token');
    assert.equal(gitCredentialsService.resolveAuthForUrl('https://example.com/a/b.git'), null);
  });

  test('GET /api/git/repos requires a configured provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/git/repos?provider=gitlab', cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 400);
  });

  test('GET /api/git/repos normalizes provider repositories', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 42,
          full_name: 'octocat/hello-world',
          name: 'hello-world',
          private: true,
          clone_url: 'https://github.com/octocat/hello-world.git',
          ssh_url: 'git@github.com:octocat/hello-world.git',
          default_branch: 'main',
          description: 'Demo repo',
        },
      ],
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/git/repos?provider=github', cookies: { session_id: authCookie } });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.repos.length, 1);
      assert.equal(body.repos[0].fullName, 'octocat/hello-world');
      assert.equal(body.repos[0].private, true);
      assert.equal(body.repos[0].defaultBranch, 'main');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('GET /api/git/repos surfaces invalid token errors', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/git/repos?provider=github', cookies: { session_id: authCookie } });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /token/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('DELETE /api/git/credentials removes the stored token', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/git/credentials/github', cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).success, true);
    assert.equal(gitCredentialsService.getDecryptedCredential('github'), null);
  });
});
