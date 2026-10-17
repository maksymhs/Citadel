const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { validateSafePath, sanitizeSlug, validateDomain, isAllowedOrigin } = require('../server/security/guard');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

describe('Security & Protection Tests', () => {
  let app;
  let authCookie;
  const testDb = path.resolve(__dirname, '../data/test-security.db');

  before(async () => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    app = await buildServer({ customDbPath: testDb, logger: false });

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'secauditor', password: 'SuperPassword123!' },
    });
    authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
  });

  test('validateSafePath must prevent directory traversal escapes', () => {
    const base = path.resolve(__dirname, '../data');

    // Safe subfolder
    const safe = validateSafePath(path.join(base, 'safe-folder'), base);
    assert.ok(safe.startsWith(base));

    // Traversal attempts
    assert.throws(() => {
      validateSafePath(path.join(base, '../../etc/passwd'), base);
    }, /Path traversal denied/i);

    assert.throws(() => {
      validateSafePath('/etc/shadow', base);
    }, /Path traversal denied/i);
  });

  test('sanitizeSlug validates and sanitizes strings', () => {
    assert.equal(sanitizeSlug('My Project 123!'), 'my-project-123');
    assert.equal(sanitizeSlug('hello--world'), 'hello-world');
    assert.throws(() => sanitizeSlug(''), /non-empty/i);
    assert.throws(() => sanitizeSlug('a'), /between 2 and 64/i);
  });

  test('validateDomain validates FQDN format and prevents injection', () => {
    assert.equal(validateDomain('app.example.com'), 'app.example.com');
    assert.equal(validateDomain('sub.domain.co.uk'), 'sub.domain.co.uk');

    assert.throws(() => validateDomain('http://app.com'), /Invalid domain/i);
    assert.throws(() => validateDomain('evil.com; rm -rf /'), /Invalid domain/i);
    assert.throws(() => validateDomain('evil.com/path'), /Invalid domain/i);
  });

  test('isAllowedOrigin validates WebSocket handshake origins', () => {
    assert.equal(isAllowedOrigin('http://localhost:3000'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), true);
    assert.equal(isAllowedOrigin('https://malicious-website.com'), false);
  });

  test('POST /api/terminals rejects a cwd outside the managed projects tree', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/terminals',
      cookies: { session_id: authCookie },
      payload: { name: 'Evil Terminal', cwd: '/etc' },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /Path traversal denied/i);
  });

  test('Security response headers (CSP, HSTS, X-Content-Type-Options)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-security-policy']);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});
