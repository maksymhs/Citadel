/**
 * Citadel Git OAuth Service
 *
 * Lets the panel connect a Git provider without asking the user to paste a
 * personal access token by hand. Both GitHub and GitLab are driven through the
 * OAuth 2.0 Device Authorization Grant: the panel asks the provider for a short
 * user code, the user approves it in their own browser, and the panel polls for
 * the resulting token. The flow needs only a public client/application id and
 * no redirect URI, which keeps it working behind an ephemeral public URL.
 *
 * The service is intentionally free of database writes for the token itself:
 * once a token is obtained it is handed to gitCredentialsService, which stores
 * it encrypted at rest exactly like a manually pasted token.
 */
const crypto = require('node:crypto');
const { getDatabase } = require('../database/db');

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const PROVIDERS = {
  github: {
    id: 'github',
    label: 'GitHub',
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    userLoginField: 'login',
    scope: 'repo',
    appUrl: 'https://github.com/settings/applications/new',
    envVars: ['CITADEL_GITHUB_CLIENT_ID', 'GITHUB_CLIENT_ID'],
  },
  gitlab: {
    id: 'gitlab',
    label: 'GitLab',
    deviceCodeUrl: 'https://gitlab.com/oauth/authorize_device',
    tokenUrl: 'https://gitlab.com/oauth/token',
    userUrl: 'https://gitlab.com/api/v4/user',
    userLoginField: 'username',
    scope: 'api',
    appUrl: 'https://gitlab.com/-/user_settings/applications',
    envVars: ['CITADEL_GITLAB_CLIENT_ID', 'GITLAB_CLIENT_ID'],
  },
};

// Short-lived, in-memory device-flow sessions. They only live for the couple of
// minutes the user needs to approve the code, so losing them on restart is fine.
const sessions = new Map();

let fetchImpl = (...args) => fetch(...args);

function getProvider(provider) {
  return PROVIDERS[provider] || null;
}

function clientIdKey(provider) {
  return `git.oauth.${provider}.client_id`;
}

function getClientId(provider) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Unsupported provider: ${provider}`);

  for (const name of p.envVars) {
    const value = process.env[name];
    if (value && value.trim()) return { clientId: value.trim(), source: 'env' };
  }

  try {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(clientIdKey(provider));
    if (row?.value && String(row.value).trim()) {
      return { clientId: String(row.value).trim(), source: 'config' };
    }
  } catch {
    // Database not ready (e.g. early boot): treat as unconfigured.
  }
  return { clientId: null, source: null };
}

function setClientId(provider, clientId) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Unsupported provider: ${provider}`);
  const value = typeof clientId === 'string' ? clientId.trim() : '';
  if (!value) throw new Error('A client/application id is required.');

  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(clientIdKey(provider), value, now);
  return { provider, clientId: value };
}

function providerStatus() {
  return Object.values(PROVIDERS).map((p) => {
    const { clientId, source } = getClientId(p.id);
    return {
      id: p.id,
      label: p.label,
      scope: p.scope,
      appUrl: p.appUrl,
      flow: 'device_code',
      configured: Boolean(clientId),
      clientIdSource: source,
    };
  });
}

function formEncode(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function postForm(url, fields, { token = null } = {}) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Citadel',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchImpl(url, { method: 'POST', headers, body: formEncode(fields) });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Some providers answer urlencoded unless JSON is requested; parse fallback.
    data = Object.fromEntries(new URLSearchParams(text));
  }
  return { ok: res.ok, status: res.status, data };
}

async function requestDeviceCode(provider) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Unsupported provider: ${provider}`);

  const { clientId } = getClientId(provider);
  if (!clientId) {
    throw new Error(`${p.label} OAuth is not configured. Add a client/application id first.`);
  }

  const { ok, status, data } = await postForm(p.deviceCodeUrl, {
    client_id: clientId,
    scope: p.scope,
  });

  if (!ok || !data?.device_code || !data?.user_code) {
    throw new Error(data?.error_description || data?.error || `${p.label} device authorization failed (HTTP ${status}).`);
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || data.verification_url,
    verificationUriComplete: data.verification_uri_complete || null,
    expiresIn: Number(data.expires_in) || 900,
    interval: Math.max(Number(data.interval) || 5, 1),
    scope: data.scope || p.scope,
  };
}

/**
 * Poll the token endpoint once. Returns a normalized result the caller can act
 * on: { status: 'pending'|'slow_down'|'connected'|'expired'|'denied', ... }.
 */
async function pollDeviceToken(provider, deviceCode) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Unsupported provider: ${provider}`);
  const { clientId } = getClientId(provider);
  if (!clientId) throw new Error(`${p.label} OAuth is not configured.`);

  const { ok, status, data } = await postForm(p.tokenUrl, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  });

  if (data?.access_token) {
    return {
      status: 'connected',
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresIn: data.expires_in ? Number(data.expires_in) : null,
      scope: data.scope || null,
    };
  }

  const error = data?.error || (ok ? 'unknown_error' : `HTTP ${status}`);
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow_down' };
  if (error === 'expired_token') return { status: 'expired' };
  if (error === 'access_denied') return { status: 'denied' };
  throw new Error(data?.error_description || `OAuth token exchange failed (${error}).`);
}

async function fetchUserLogin(provider, accessToken) {
  const p = getProvider(provider);
  if (!p) return null;
  try {
    const res = await fetchImpl(p.userUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'Citadel', Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[p.userLoginField] ? String(data[p.userLoginField]) : null;
  } catch {
    return null; // Username is a nicety; never fail the connection over it.
  }
}

async function refreshAccessToken(provider, refreshToken) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Unsupported provider: ${provider}`);
  const { clientId } = getClientId(provider);
  if (!clientId) throw new Error(`${p.label} OAuth is not configured.`);

  const { ok, status, data } = await postForm(p.tokenUrl, {
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  if (!ok || !data?.access_token) {
    throw new Error(data?.error_description || `${p.label} token refresh failed (HTTP ${status}).`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in ? Number(data.expires_in) : null,
    scope: data.scope || null,
  };
}

/**
 * Start a device flow: request a user code and remember the pending device code
 * server-side so the raw code never round-trips through the browser.
 */
async function startDeviceFlow(provider) {
  const code = await requestDeviceCode(provider);
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    provider,
    deviceCode: code.deviceCode,
    interval: code.interval,
    expiresAt: Date.now() + code.expiresIn * 1000,
  });

  return {
    sessionId,
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    verificationUriComplete: code.verificationUriComplete,
    expiresIn: code.expiresIn,
    interval: code.interval,
    scope: code.scope,
  };
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

/**
 * Poll a pending device flow. On success the token is stored (encrypted) by
 * gitCredentialsService and the flow is completed; otherwise the status tells
 * the client whether to keep polling.
 */
async function pollDeviceFlow(provider, sessionId) {
  const session = getSession(sessionId);
  if (!session || session.provider !== provider) {
    return { status: 'expired' };
  }

  const result = await pollDeviceToken(provider, session.deviceCode);
  if (result.status === 'slow_down') {
    session.interval += 5;
    return { status: 'pending', interval: session.interval };
  }
  if (result.status !== 'connected') {
    if (result.status === 'expired' || result.status === 'denied') sessions.delete(sessionId);
    return { status: result.status };
  }

  sessions.delete(sessionId);

  const gitCredentialsService = require('./gitCredentialsService');
  const username = await fetchUserLogin(provider, result.accessToken);
  const expiresAt = result.expiresIn ? new Date(Date.now() + result.expiresIn * 1000).toISOString() : null;

  gitCredentialsService.saveCredential({
    provider,
    token: result.accessToken,
    username,
    refreshToken: result.refreshToken,
    expiresAt,
    scope: result.scope,
    authMethod: 'oauth',
  });

  return { status: 'connected', username };
}

function cancelDeviceFlow(sessionId) {
  return sessions.delete(sessionId);
}

function _setFetchImpl(fn) {
  fetchImpl = fn;
}

function _reset() {
  fetchImpl = (...args) => fetch(...args);
  sessions.clear();
}

function _pendingSessions() {
  return sessions.size;
}

module.exports = {
  PROVIDERS,
  DEVICE_GRANT_TYPE,
  getProvider,
  getClientId,
  setClientId,
  providerStatus,
  requestDeviceCode,
  pollDeviceToken,
  fetchUserLogin,
  refreshAccessToken,
  startDeviceFlow,
  pollDeviceFlow,
  cancelDeviceFlow,
  _setFetchImpl,
  _reset,
  _pendingSessions,
};
