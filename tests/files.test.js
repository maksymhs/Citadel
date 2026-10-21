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
    // The Files module is optional and disabled by default on new installs.
    const enable = await app.inject({
      method: 'POST',
      url: '/api/modules/files/state',
      cookies: { session_id: authCookie },
      payload: { enabled: true },
    });
    assert.equal(enable.statusCode, 200);
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

describe('Disk usage and cleanup', () => {
  let app;
  let authCookie;
  let realHome;
  const testDb = path.resolve(__dirname, '../data/test-files-usage.db');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-home-'));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-tree-'));

  before(async () => {
    realHome = process.env.HOME;
    process.env.HOME = home; // the agent resolves its cache locations from HOME
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    app = await buildServer({ customDbPath: testDb, logger: false });
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'diskadmin', password: 'SuperPassword123!' },
    });
    authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
    await app.inject({
      method: 'POST',
      url: '/api/modules/files/state',
      cookies: { session_id: authCookie },
      payload: { enabled: true },
    });
  });

  after(async () => {
    process.env.HOME = realHome;
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tree, { recursive: true, force: true });
  });

  test('usage ranks children by size and lists the largest files', async () => {
    fs.mkdirSync(path.join(tree, 'big'));
    fs.mkdirSync(path.join(tree, 'small'));
    fs.writeFileSync(path.join(tree, 'big', 'blob.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
    fs.writeFileSync(path.join(tree, 'small', 'note.txt'), 'x');
    const res = await app.inject({ method: 'GET', url: `/api/files/usage?path=${encodeURIComponent(tree)}`, cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    const { usage } = JSON.parse(res.payload);
    assert.deepEqual(usage.children.map((c) => c.name), ['big', 'small']);
    assert.ok(usage.children[0].size >= 2 * 1024 * 1024);
    assert.equal(usage.largest[0].path, path.join(tree, 'big', 'blob.bin'));
    assert.ok(usage.disk.total > 0);
  });

  test('cleanup requires authentication and a selection', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/files/cleanup' });
    assert.equal(res.statusCode, 401);
    res = await app.inject({ method: 'POST', url: '/api/files/cleanup', cookies: { session_id: authCookie }, payload: { ids: [] } });
    assert.equal(res.statusCode, 400);
  });

  test('cleanup scans and removes only the selected category', async () => {
    const cache = path.join(home, '.cache');
    const npm = path.join(home, '.npm', '_cacache');
    fs.mkdirSync(path.join(cache, 'pip'), { recursive: true });
    fs.mkdirSync(npm, { recursive: true });
    fs.writeFileSync(path.join(cache, 'pip', 'wheel.whl'), Buffer.alloc(64 * 1024, 2));
    fs.writeFileSync(path.join(npm, 'entry'), 'keep me');

    let res = await app.inject({ method: 'GET', url: '/api/files/cleanup', cookies: { session_id: authCookie } });
    assert.equal(res.statusCode, 200);
    const scan = JSON.parse(res.payload);
    const userCache = scan.candidates.find((c) => c.id === 'user-cache');
    assert.ok(userCache && userCache.size >= 64 * 1024);

    res = await app.inject({ method: 'POST', url: '/api/files/cleanup', cookies: { session_id: authCookie }, payload: { ids: ['user-cache'] } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.freed >= 64 * 1024);
    assert.deepEqual(fs.readdirSync(cache), []);
    assert.ok(fs.existsSync(path.join(npm, 'entry')), 'unselected categories stay untouched');
  });

  test('cleanup can be narrowed to chosen items and ignores foreign paths', async () => {
    const cache = path.join(home, '.cache');
    fs.mkdirSync(path.join(cache, 'drop'), { recursive: true });
    fs.mkdirSync(path.join(cache, 'keep'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'drop', 'a'), Buffer.alloc(8 * 1024, 3));
    fs.writeFileSync(path.join(cache, 'keep', 'b'), Buffer.alloc(8 * 1024, 4));
    const outside = path.join(tree, 'outside.txt');
    fs.writeFileSync(outside, 'not part of any category');

    let res = await app.inject({ method: 'GET', url: '/api/files/cleanup', cookies: { session_id: authCookie } });
    const cand = JSON.parse(res.payload).candidates.find((c) => c.id === 'user-cache');
    assert.ok(cand.group && cand.access && Array.isArray(cand.items));
    assert.ok(cand.items.some((i) => i.path === path.join(cache, 'drop')));

    res = await app.inject({
      method: 'POST',
      url: '/api/files/cleanup',
      cookies: { session_id: authCookie },
      payload: { ids: ['user-cache'], items: { 'user-cache': [path.join(cache, 'drop'), outside] } },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(!fs.existsSync(path.join(cache, 'drop')));
    assert.ok(fs.existsSync(path.join(cache, 'keep', 'b')), 'unselected items stay');
    assert.ok(fs.existsSync(outside), 'paths outside the category are ignored');

    res = await app.inject({
      method: 'POST',
      url: '/api/files/cleanup',
      cookies: { session_id: authCookie },
      payload: { ids: ['user-cache'], items: { trash: ['/x'] } },
    });
    assert.equal(res.statusCode, 400, 'items for a category that was not selected are rejected');
  });

  test('cleanup ignores ids that are not known categories', async () => {
    const victim = path.join(tree, 'victim.txt');
    fs.writeFileSync(victim, 'important');
    const res = await app.inject({
      method: 'POST',
      url: '/api/files/cleanup',
      cookies: { session_id: authCookie },
      payload: { ids: [`nm:${tree}`, victim, '../../etc'] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).freed, 0);
    assert.ok(fs.existsSync(victim));
  });
});
