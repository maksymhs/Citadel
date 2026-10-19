const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { buildServer } = require('../server/index');
const { initDatabase, closeDatabase, getDatabase } = require('../server/database/db');
const { encrypt } = require('../server/security/secrets');
const secretStore = require('../server/services/secretStore');
const gitCredentialsService = require('../server/services/gitCredentialsService');
const config = require('../server/config');

const CLI = path.resolve(__dirname, '../scripts/citadel-creds.js');

function removeDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  }
}

describe('Secret Vault & Agent Access', () => {
  let app;
  let authCookie;
  const testDb = path.resolve(__dirname, '../data/test-secrets.db');

  before(async () => {
    removeDb(testDb);
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'vaultadmin', password: 'SuperPassword123!' },
    });
    authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    removeDb(testDb);
  });

  test('stores secrets encrypted, never in plaintext', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/secrets',
      cookies: { session_id: authCookie },
      payload: { name: 'MY_API_KEY', value: 'sk-super-secret-value', kind: 'env' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.includes('sk-super-secret-value'), false);

    const db = getDatabase();
    const row = db.prepare("SELECT kind, value_encrypted FROM secrets WHERE name = 'MY_API_KEY'").get();
    assert.equal(row.kind, 'env');
    assert.ok(row.value_encrypted.startsWith('v1:'));
    assert.equal(row.value_encrypted.includes('sk-super-secret-value'), false);
  });

  test('GET /api/secrets lists metadata only (never the value)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/secrets', cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    const entry = body.secrets.find((s) => s.name === 'MY_API_KEY');
    assert.ok(entry);
    assert.equal(entry.kind, 'env');
    assert.equal(entry.value, undefined);
    assert.equal(res.payload.includes('sk-super-secret-value'), false);
  });

  test('rejects invalid names, empty values and unknown kinds', async () => {
    const post = (payload) => app.inject({ method: 'POST', url: '/api/secrets', cookies: { session_id: authCookie }, payload });

    assert.equal((await post({ name: 'bad name', value: 'x', kind: 'env' })).statusCode, 400);
    assert.equal((await post({ name: 'OK_NAME', value: '', kind: 'env' })).statusCode, 400);
    assert.equal((await post({ name: 'OK_NAME', value: 'x', kind: 'nope' })).statusCode, 400);
  });

  test('envVars exposes env and git entries but not file/ssh', () => {
    secretStore.setSecret('FILE_ONLY', 'contents', { kind: 'file' });
    secretStore.setSecret('SSH_KEY', 'private', { kind: 'ssh' });
    const vars = secretStore.envVars();
    assert.equal(vars.MY_API_KEY, 'sk-super-secret-value');
    assert.equal(vars.FILE_ONLY, undefined);
    assert.equal(vars.SSH_KEY, undefined);
  });

  test('gitCredentialsService stores provider tokens in the vault', () => {
    gitCredentialsService.saveCredential({ provider: 'github', token: 'ghp_vaultToken123456', username: 'octocat' });

    const secret = secretStore.getSecret('GITHUB_TOKEN');
    assert.ok(secret);
    assert.equal(secret.kind, 'git');
    assert.equal(secret.metadata.provider, 'github');
    assert.equal(secret.value, 'ghp_vaultToken123456');

    const auth = gitCredentialsService.resolveAuthForUrl('https://github.com/octocat/hello.git');
    assert.ok(auth);
    assert.equal(auth.token, 'ghp_vaultToken123456');
    assert.equal(auth.cloneUser, 'x-access-token');

    // Provider tokens are env-exposed too, so agents get them without the CLI.
    assert.equal(secretStore.envVars().GITHUB_TOKEN, 'ghp_vaultToken123456');
  });

  test('DELETE /api/secrets removes an entry; unknown names 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/secrets/MY_API_KEY',
      cookies: { session_id: authCookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(secretStore.getSecret('MY_API_KEY'), null);

    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/secrets/DOES_NOT_EXIST',
      cookies: { session_id: authCookie },
    });
    assert.equal(missing.statusCode, 404);
  });

  test('citadel-creds CLI reads the vault (list/get/env/exec/materialize)', () => {
    const cliEnv = {
      ...process.env,
      DATA_DIR: config.DATA_DIR,
      DATABASE_PATH: testDb,
      PROJECTS_DIR: config.PROJECTS_DIR,
      LOGS_DIR: config.LOGS_DIR,
    };

    const list = execFileSync(process.execPath, [CLI, 'list'], { env: cliEnv, encoding: 'utf8' });
    assert.match(list, /GITHUB_TOKEN\tgit/);

    const value = execFileSync(process.execPath, [CLI, 'get', 'GITHUB_TOKEN'], { env: cliEnv, encoding: 'utf8' });
    assert.equal(value, 'ghp_vaultToken123456');

    const envOut = execFileSync(process.execPath, [CLI, 'env'], { env: cliEnv, encoding: 'utf8' });
    assert.match(envOut, /export GITHUB_TOKEN='ghp_vaultToken123456'/);

    const execOut = execFileSync(process.execPath, [CLI, 'exec', '--', 'node', '-e', 'process.stdout.write(process.env.GITHUB_TOKEN || "")'], { env: cliEnv, encoding: 'utf8' });
    assert.equal(execOut, 'ghp_vaultToken123456');

    const target = path.resolve(__dirname, '../data/test-secret-materialized.txt');
    if (fs.existsSync(target)) fs.unlinkSync(target);
    execFileSync(process.execPath, [CLI, 'materialize', 'GITHUB_TOKEN', target], { env: cliEnv, encoding: 'utf8' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'ghp_vaultToken123456');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    fs.unlinkSync(target);
  });
});

describe('Secret Vault migration', () => {
  const legacyDb = path.resolve(__dirname, '../data/test-secrets-legacy.db');

  after(() => {
    closeDatabase();
    removeDb(legacyDb);
  });

  test('migrates legacy git_credentials rows into the vault', () => {
    removeDb(legacyDb);

    const raw = new Database(legacyDb);
    raw.pragma('journal_mode = WAL');
    raw.exec(`
      CREATE TABLE git_credentials (
        provider TEXT PRIMARY KEY,
        username TEXT,
        token_encrypted TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const ciphertext = encrypt('ghp_legacyToken123456');
    raw.prepare('INSERT INTO git_credentials VALUES (?, ?, ?, ?, ?)')
      .run('github', 'legacy', ciphertext, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    raw.close();

    initDatabase(legacyDb);
    const db = getDatabase();
    const row = db.prepare("SELECT kind, value_encrypted, metadata FROM secrets WHERE name = 'GITHUB_TOKEN'").get();
    assert.ok(row);
    assert.equal(row.kind, 'git');
    assert.equal(row.value_encrypted, ciphertext);
    assert.equal(JSON.parse(row.metadata).provider, 'github');
    assert.equal(JSON.parse(row.metadata).username, 'legacy');
  });
});
