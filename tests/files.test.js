const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Force unprivileged mode so the suite never shells out to sudo, and keep the
// updater path pointing nowhere as a safety net.
process.env.TERMINAL_ADMIN_USER = '';
process.env.CITADEL_UPDATER_PATH = '/nonexistent/citadel-update-test';

const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

describe('Filesystem explorer', () => {
  let app;
  let authCookie;
  const testDb = path.resolve(__dirname, '../data/test-files.db');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-files-'));

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'fileadmin', password: 'SuperPassword123!' },
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
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('GET /api/files/capabilities reports the mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/files/capabilities', cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).privileged, false);
  });

  test('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/files?path=/' });
    assert.equal(res.statusCode, 401);
  });

  test('write, read, rename, list and delete round-trip', async () => {
    const fileA = path.join(workDir, 'hello.txt');
    const fileB = path.join(workDir, 'renamed.txt');
    const subDir = path.join(workDir, 'sub');

    // write
    let res = await app.inject({
      method: 'PUT',
      url: '/api/files/write',
      cookies: { session_id: authCookie },
      payload: { path: fileA, content: 'hello world' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'hello world');

    // read
    res = await app.inject({ method: 'GET', url: `/api/files/read?path=${encodeURIComponent(fileA)}`, cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).file.content, 'hello world');

    // mkdir
    res = await app.inject({
      method: 'POST',
      url: '/api/files/mkdir',
      cookies: { session_id: authCookie },
      payload: { path: subDir },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(fs.statSync(subDir).isDirectory());

    // list
    res = await app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(workDir)}`, cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    const names = JSON.parse(res.payload).listing.items.map((i) => i.name);
    assert.ok(names.includes('hello.txt'));
    assert.ok(names.includes('sub'));

    // rename
    res = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      cookies: { session_id: authCookie },
      payload: { from: fileA, to: fileB },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(fs.existsSync(fileB));
    assert.ok(!fs.existsSync(fileA));

    // delete
    res = await app.inject({ method: 'DELETE', url: `/api/files?path=${encodeURIComponent(fileB)}`, cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    assert.ok(!fs.existsSync(fileB));
  });

  test('downloads a file', async () => {
    const f = path.join(workDir, 'download.txt');
    fs.writeFileSync(f, 'download me');
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/download?path=${encodeURIComponent(f)}`,
      cookies: { session_id: authCookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'download me');
  });

  test('returns a clean error for a missing path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/read?path=${encodeURIComponent(path.join(workDir, 'nope.txt'))}`,
      cookies: { session_id: authCookie },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.payload).error);
  });
});
