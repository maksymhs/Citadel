const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Config reads DATA_DIR once at load, so it must be set before anything is required.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-setupcode-'));
process.env.DATA_DIR = dataDir;
delete process.env.CITADEL_SETUP_CODE;

const setupCode = require('../server/security/setupCode');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

const ROOT = path.join(__dirname, '..');
const codeFile = path.join(dataDir, 'setup-code');

describe('Setup code (module)', () => {
  test('is short, typeable and uses no ambiguous characters', () => {
    for (let i = 0; i < 50; i += 1) assert.match(setupCode.generate(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  test('ensure() creates a private file once and returns the same code', () => {
    setupCode.clear();
    const first = setupCode.ensure();
    assert.equal(setupCode.ensure(), first);
    assert.equal(fs.statSync(codeFile).mode & 0o777, 0o600);
    assert.equal(setupCode.read(), first);
  });

  test('accepts the code however it is typed, rejects anything else', () => {
    const code = setupCode.ensure();
    assert.equal(setupCode.verify(code.toLowerCase()).ok, true);
    assert.equal(setupCode.verify(code.replace('-', ' ')).ok, true);
    assert.equal(setupCode.verify('AAAA-AAAA').ok, false);
    assert.equal(setupCode.verify('').ok, false);
    assert.equal(setupCode.verify(undefined).ok, false);
  });

  test('five wrong guesses replace the code and pause attempts', () => {
    setupCode.clear();
    const original = setupCode.ensure();
    let last;
    for (let i = 0; i < setupCode.MAX_FAILURES; i += 1) last = setupCode.verify('ZZZZ-ZZZZ', 1000);
    assert.equal(last.rotated, true);
    assert.notEqual(setupCode.read(), original, 'guesses made so far are now worthless');
    const during = setupCode.verify(setupCode.read(), 1000 + 5000);
    assert.equal(during.ok, false);
    assert.equal(during.reason, 'locked');
    assert.equal(setupCode.verify(setupCode.read(), 1000 + 61000).ok, true, 'works again after the pause');
  });

  test('a code from the environment is honoured and never rotated', () => {
    process.env.CITADEL_SETUP_CODE = 'ABCD-2345';
    try {
      assert.equal(setupCode.verify('abcd2345').ok, true);
      let last;
      for (let i = 0; i < setupCode.MAX_FAILURES; i += 1) last = setupCode.verify('ZZZZ-ZZZZ', 5e6);
      assert.equal(last.rotated, false);
      assert.equal(setupCode.verify('ABCD-2345', 5e6 + 61000).ok, true);
    } finally {
      delete process.env.CITADEL_SETUP_CODE;
    }
  });
});

describe('Setup code (first-run API)', () => {
  const testDb = path.resolve(__dirname, '../data/test-setup-code.db');
  let app;
  const wipe = () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(testDb + s, { force: true }); };
  // The credential rate limit is per client IP, so each test uses its own.
  const setup = (payload, remoteAddress = '10.0.0.1') => app.inject({ method: 'POST', url: '/api/auth/setup', payload, remoteAddress });

  before(async () => {
    wipe();
    setupCode.clear();
    app = await buildServer({ customDbPath: testDb, logger: false, requireSetupCode: true });
  });

  after(async () => {
    await app.close();
    closeDatabase();
    wipe();
  });

  test('status tells the screen a code is needed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.deepEqual(JSON.parse(res.payload), { setupComplete: false, setupCodeRequired: true });
  });

  test('refuses to create the admin without the right code', async () => {
    setupCode.ensure();
    const creds = { username: 'guesser', password: 'SuperPassword123!' };
    let res = await setup(creds, '10.0.0.2');
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /citadel setup-code/);
    res = await setup({ ...creds, setupCode: 'AAAA-AAAA' }, '10.0.0.2');
    assert.equal(res.statusCode, 403);
    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.equal(JSON.parse(status.payload).setupComplete, false, 'nothing was created');
  });

  test('repeated wrong codes lock the screen, and the code is replaced', async () => {
    setupCode.clear();
    const original = setupCode.ensure();
    let res;
    for (let i = 0; i < setupCode.MAX_FAILURES; i += 1) res = await setup({ username: `guess${i}`, password: 'SuperPassword123!', setupCode: 'ZZZZ-ZZZZ' }, '10.0.0.3');
    assert.match(JSON.parse(res.payload).error, /new code was generated/);
    res = await setup({ username: 'latecomer', password: 'SuperPassword123!', setupCode: setupCode.read() }, '10.0.0.4');
    assert.equal(res.statusCode, 429, 'even the right code waits out the pause');
    assert.notEqual(setupCode.read(), original);
  });

  test('the right code creates the admin, signs in and removes the code', async () => {
    setupCode.clear();
    const code = setupCode.ensure();
    // clear() also resets the pause left by the previous test.
    const res = await setup({ username: 'owner', password: 'SuperPassword123!', setupCode: code.toLowerCase() }, '10.0.0.5');
    assert.equal(res.statusCode, 200, `${res.statusCode} ${res.payload}`);
    assert.ok(res.cookies.find((c) => c.name === 'session_id'));
    assert.equal(fs.existsSync(codeFile), false, 'the code is gone once the account exists');
    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.deepEqual(JSON.parse(status.payload), { setupComplete: true, setupCodeRequired: false });
  });

  test('once an admin exists nobody can set up again, code or not', async () => {
    const res = await setup({ username: 'intruder', password: 'AnotherPassword123!', setupCode: 'AAAA-AAAA' }, '10.0.0.6');
    assert.equal(res.statusCode, 400);
  });
});

describe('citadel setup-code command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-setupcode-cli-'));
  const env = { ...process.env, DATA_DIR: dir, DATABASE_PATH: path.join(dir, 'citadel.db') };
  delete env.CITADEL_SETUP_CODE;
  const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-code.js'), ...args], { env, encoding: 'utf8' });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('prints a stable code while setup is open, and nothing once it is done', () => {
    const code = run('--quiet').trim();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(run('--quiet').trim(), code, 'same code every time');
    assert.match(run(), new RegExp(`Setup code: ${code}`));
    assert.equal(fs.statSync(path.join(dir, 'setup-code')).mode & 0o777, 0o600);

    execFileSync(process.execPath, ['-e', `
      const { initDatabase, closeDatabase } = require('./server/database/db');
      const auth = require('./server/security/auth');
      initDatabase(); auth.createInitialAdmin('owner', 'SuperPassword123!'); closeDatabase();
    `], { cwd: ROOT, env });
    assert.equal(run('--quiet').trim(), '', 'no code once an administrator exists');
    assert.match(run(), /already complete/);
  });
});
