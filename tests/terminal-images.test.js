const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-terminal-images-test-'));
const dataDir = path.join(sandbox, 'data');
Object.assign(process.env, {
  NODE_ENV: 'test',
  HOME: path.join(sandbox, 'home'),
  TMPDIR: path.join(sandbox, 'tmp'),
  DATA_DIR: dataDir,
  DATABASE_PATH: path.join(dataDir, 'citadel.db'),
  PROJECTS_DIR: path.join(dataDir, 'projects'),
  LOGS_DIR: path.join(dataDir, 'logs'),
  CITADEL_SELF_UPDATE: '0',
  CITADEL_REQUIRE_SETUP_CODE: '0',
  TERMINAL_ADMIN_USER: '',
});
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const imageService = require('../server/services/terminalImageService');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/k1sAAAAASUVORK5CYII=';
const pngBytes = Buffer.from(PNG, 'base64');
const storageDir = path.join(process.env.TMPDIR, `citadel-terminal-images-${process.getuid()}`);

function saveRequest(app, cookie, sessionId, payload = { mimeType: 'image/png', content: PNG }) {
  return app.inject({
    method: 'POST',
    url: `/api/terminals/${sessionId}/clipboard-image`,
    headers: { cookie },
    payload,
  });
}

describe('Terminal clipboard images', () => {
  test('validates supported MIME, strict base64 and signatures', () => {
    assert.equal(imageService.validateImage('image/png', PNG), pngBytes.length);
    assert.throws(() => imageService.validateImage('image/svg+xml', PNG), /Unsupported or invalid image/);
    assert.throws(() => imageService.validateImage('image/png', '!!!!'), /Unsupported or invalid image/);
    assert.throws(() => imageService.validateImage('image/jpeg', PNG), /Unsupported or invalid image/);
    assert.throws(() => imageService.validateImage('image/png', `${PNG}${'A'.repeat(7 * 1024 * 1024)}`), /Unsupported or invalid image/);
  });

  test('stores private files and cleans only expired generated files', async () => {
    const saved = await imageService.save({ mimeType: 'image/png', content: PNG });
    assert.deepEqual(fs.readFileSync(saved.path), pngBytes);
    assert.equal(fs.statSync(storageDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
    assert.equal(saved.size, pngBytes.length);

    const expired = path.join(storageDir, `image-${'a'.repeat(32)}.png`);
    fs.writeFileSync(expired, pngBytes, { mode: 0o600 });
    fs.utimesSync(expired, new Date(Date.now() - 25 * 60 * 60 * 1000), new Date(Date.now() - 25 * 60 * 60 * 1000));
    const outside = path.join(process.env.TMPDIR, 'keep-this-file');
    fs.writeFileSync(outside, 'keep');
    const link = path.join(storageDir, `image-${'b'.repeat(32)}.png`);
    fs.symlinkSync(outside, link);

    await imageService.save({ mimeType: 'image/png', content: PNG });
    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  });

  test('enforces the per-identity quota atomically for concurrent uploads', async () => {
    const filler = path.join(storageDir, `image-${'c'.repeat(32)}.png`);
    fs.closeSync(fs.openSync(filler, 'wx', 0o600));
    fs.truncateSync(filler, 45 * 1024 * 1024);
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    const content = bytes.toString('base64');
    const attempts = await Promise.allSettled([
      imageService.save({ mimeType: 'image/png', content }),
      imageService.save({ mimeType: 'image/png', content }),
    ]);
    assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((x) => x.status === 'rejected').length, 1);
    assert.match(attempts.find((x) => x.status === 'rejected').reason.message, /storage is full/i);
    for (const name of fs.readdirSync(storageDir)) {
      if (/^image-[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(name)) fs.unlinkSync(path.join(storageDir, name));
    }
  });

  describe('authenticated upload route', () => {
    const testDb = path.join(dataDir, 'route.db');
    let app;
    let cookie;
    let sessionId;

    before(async () => {
      const { buildServer } = require('../server/index');
      app = await buildServer({ customDbPath: testDb, logger: false });
      const setup = await app.inject({
        method: 'POST', url: '/api/auth/setup',
        payload: { username: 'image-admin', password: 'fixture-password-only' },
      });
      assert.equal(setup.statusCode, 200);
      cookie = `session_id=${setup.cookies[0].value}`;
      sessionId = crypto.randomUUID();
      const { getDatabase } = require('../server/database/db');
      getDatabase().prepare(`INSERT INTO term_sessions
        (id, project_id, name, tmux_session, status, created_at, last_active)
        VALUES (?, NULL, 'Image fixture', ?, 'active', ?, ?)`)
        .run(sessionId, `image_fixture_${sessionId.slice(0, 8)}`, new Date().toISOString(), new Date().toISOString());
    });

    after(async () => {
      if (app) await app.close();
      try { require('../server/database/db').closeDatabase(); } catch { /* already closed */ }
    });

    test('stores the upload on the terminal host and returns only its path', async () => {
      const res = await saveRequest(app, cookie, sessionId);
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(typeof body.path, 'string');
      assert.deepEqual(fs.readFileSync(body.path), pngBytes);
      assert.equal(Object.hasOwn(body, 'content'), false);
    });

    test('rejects JSON bodies above the image route limit', async () => {
      const res = await saveRequest(app, cookie, sessionId, {
        mimeType: 'image/png', content: 'A'.repeat(7 * 1024 * 1024),
      });
      assert.equal(res.statusCode, 413);
    });

    test('rejects closed sessions and non-admin System access before storage', async () => {
      const { getDatabase } = require('../server/database/db');
      getDatabase().prepare("UPDATE term_sessions SET status = 'closed' WHERE id = ?").run(sessionId);
      const closed = await saveRequest(app, cookie, sessionId);
      assert.equal(closed.statusCode, 404);
      getDatabase().prepare("UPDATE term_sessions SET status = 'active' WHERE id = ?").run(sessionId);
      getDatabase().prepare("UPDATE users SET role = 'viewer'").run();
      try {
        const denied = await saveRequest(app, cookie, sessionId);
        assert.equal(denied.statusCode, 403);
      } finally { getDatabase().prepare("UPDATE users SET role = 'admin'").run(); }
    });
  });

  after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
});
