const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildServer } = require('../server/index');
const { closeDatabase, getDatabase } = require('../server/database/db');
const gitCredentialsService = require('../server/services/gitCredentialsService');
const gitOAuthService = require('../server/services/gitOAuthService');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async json() {
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
}

function mockFetch(routes) {
  return async (url, opts = {}) => {
    const target = String(url);
    for (const route of routes) {
      if (target.includes(route.match)) {
        return route.respond(opts);
      }
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
}

describe('Git OAuth device flow', () => {
  let app;
  let authCookie;
  const testDb = path.resolve(__dirname, '../data/test-git-oauth.db');

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    app = await buildServer({ customDbPath: testDb, logger: false });

    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'oauthadmin', password: 'SuperPassword123!' },
    });
    authCookie = setupRes.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    gitOAuthService._reset();
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = testDb + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  beforeEach(() => {
    gitCredentialsService.deleteCredential('github');
    gitCredentialsService.deleteCredential('gitlab');
    getDatabase().prepare("DELETE FROM app_config WHERE key LIKE 'git.oauth.%'").run();
    gitOAuthService._reset();
  });

  afterEach(() => {
    gitOAuthService._reset();
  });

  test('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/git/oauth/providers' });
    assert.equal(res.statusCode, 401);
  });

  test('reports providers as unconfigured until a client id is set', async () => {
    const before = JSON.parse((await app.inject({
      method: 'GET', url: '/api/git/oauth/providers', cookies: { session_id: authCookie },
    })).payload);
    const gh = before.providers.find((p) => p.id === 'github');
    assert.equal(gh.oauth.configured, false);
    assert.equal(gh.oauth.flow, 'device_code');

    const save = await app.inject({
      method: 'POST',
      url: '/api/git/oauth/github/client-id',
      cookies: { session_id: authCookie },
      payload: { clientId: 'gh-client-id-123' },
    });
    assert.equal(save.statusCode, 200);

    const after = JSON.parse((await app.inject({
      method: 'GET', url: '/api/git/oauth/providers', cookies: { session_id: authCookie },
    })).payload);
    assert.equal(after.providers.find((p) => p.id === 'github').oauth.configured, true);
  });

  test('rejects an empty client id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/oauth/gitlab/client-id',
      cookies: { session_id: authCookie },
      payload: { clientId: '   ' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('refuses to start a flow without a configured client id', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/git/oauth/github/start', cookies: { session_id: authCookie },
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /not configured/i);
  });

  test('runs a device flow from start to connected and stores an OAuth credential', async () => {
    gitOAuthService.setClientId('github', 'gh-client-id-123');

    let tokenCalls = 0;
    gitOAuthService._setFetchImpl(mockFetch([
      {
        match: 'github.com/login/device/code',
        respond: () => jsonResponse({
          device_code: 'dev-code-abc',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-EFGH',
          expires_in: 900,
          interval: 5,
        }),
      },
      {
        match: 'github.com/login/oauth/access_token',
        respond: () => {
          tokenCalls += 1;
          if (tokenCalls === 1) return jsonResponse({ error: 'authorization_pending' });
          return jsonResponse({ access_token: 'gho_token_value_123456', token_type: 'bearer', scope: 'repo' });
        },
      },
      {
        match: 'api.github.com/user',
        respond: () => jsonResponse({ login: 'octocat' }),
      },
    ]));

    const start = await app.inject({
      method: 'POST', url: '/api/git/oauth/github/start', cookies: { session_id: authCookie },
    });
    assert.equal(start.statusCode, 200);
    const startBody = JSON.parse(start.payload);
    assert.equal(startBody.userCode, 'ABCD-EFGH');
    assert.ok(startBody.sessionId);
    assert.equal(gitOAuthService._pendingSessions(), 1);

    const pending = JSON.parse((await app.inject({
      method: 'POST',
      url: '/api/git/oauth/github/poll',
      cookies: { session_id: authCookie },
      payload: { sessionId: startBody.sessionId },
    })).payload);
    assert.equal(pending.status, 'pending');

    const connected = JSON.parse((await app.inject({
      method: 'POST',
      url: '/api/git/oauth/github/poll',
      cookies: { session_id: authCookie },
      payload: { sessionId: startBody.sessionId },
    })).payload);
    assert.equal(connected.status, 'connected');
    assert.equal(connected.username, 'octocat');
    assert.equal(gitOAuthService._pendingSessions(), 0);

    const providers = JSON.parse((await app.inject({
      method: 'GET', url: '/api/git/oauth/providers', cookies: { session_id: authCookie },
    })).payload);
    const gh = providers.providers.find((p) => p.id === 'github');
    assert.equal(gh.configured, true);
    assert.equal(gh.authMethod, 'oauth');
    assert.equal(gh.username, 'octocat');

    const cred = gitCredentialsService.getDecryptedCredential('github');
    assert.equal(cred.token, 'gho_token_value_123456');
  });

  test('slow_down extends the polling interval', async () => {
    gitOAuthService.setClientId('gitlab', 'gl-client-id-123');
    let calls = 0;
    gitOAuthService._setFetchImpl(mockFetch([
      {
        match: 'gitlab.com/oauth/authorize_device',
        respond: () => jsonResponse({
          device_code: 'gl-dev', user_code: 'WXYZ-1234',
          verification_uri: 'https://gitlab.com/oauth/device', expires_in: 300, interval: 5,
        }),
      },
      {
        match: 'gitlab.com/oauth/token',
        respond: () => {
          calls += 1;
          return jsonResponse({ error: calls === 1 ? 'slow_down' : 'authorization_pending' });
        },
      },
    ]));

    const session = await gitOAuthService.startDeviceFlow('gitlab');
    const slow = await gitOAuthService.pollDeviceFlow('gitlab', session.sessionId);
    assert.equal(slow.status, 'pending');
    assert.equal(slow.interval, 10);
  });

  test('an expired flow reports expired and drops the session', async () => {
    gitOAuthService.setClientId('github', 'gh-client-id-123');
    gitOAuthService._setFetchImpl(mockFetch([
      {
        match: 'login/device/code',
        respond: () => jsonResponse({
          device_code: 'd', user_code: 'AAAA-BBBB',
          verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
        }),
      },
      { match: 'login/oauth/access_token', respond: () => jsonResponse({ error: 'expired_token' }) },
    ]));

    const session = await gitOAuthService.startDeviceFlow('github');
    const result = await gitOAuthService.pollDeviceFlow('github', session.sessionId);
    assert.equal(result.status, 'expired');
    assert.equal(gitOAuthService._pendingSessions(), 0);
  });

  test('refreshes an expiring OAuth credential', async () => {
    gitOAuthService.setClientId('gitlab', 'gl-client-id-123');
    gitCredentialsService.saveCredential({
      provider: 'gitlab',
      token: 'gl_old_token_value_123',
      username: 'dev',
      refreshToken: 'gl_refresh_token_123',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      scope: 'api',
      authMethod: 'oauth',
    });

    assert.deepEqual(gitCredentialsService.listExpiringCredentials(), ['gitlab']);

    gitOAuthService._setFetchImpl(mockFetch([
      {
        match: 'gitlab.com/oauth/token',
        respond: () => jsonResponse({
          access_token: 'gl_new_token_value_456', refresh_token: 'gl_refresh_token_456', expires_in: 7200,
        }),
      },
    ]));

    const refreshed = await gitCredentialsService.refreshCredentialIfNeeded('gitlab');
    assert.equal(refreshed, true);
    assert.equal(gitCredentialsService.getDecryptedCredential('gitlab').token, 'gl_new_token_value_456');
    assert.deepEqual(gitCredentialsService.listExpiringCredentials(), []);
  });
});
