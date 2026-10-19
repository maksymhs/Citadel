/**
 * Citadel Git Credentials Service
 * Stores provider access tokens encrypted at rest and talks to provider APIs.
 */
const { getDatabase } = require('../database/db');
const { encrypt, decrypt } = require('../security/secrets');

const PROVIDERS = {
  github: {
    id: 'github',
    label: 'GitHub',
    host: 'github.com',
    apiBase: 'https://api.github.com',
    cloneUser: 'x-access-token',
  },
  gitlab: {
    id: 'gitlab',
    label: 'GitLab',
    host: 'gitlab.com',
    apiBase: 'https://gitlab.com/api/v4',
    cloneUser: 'oauth2',
  },
};

function getProvider(provider) {
  return PROVIDERS[provider] || null;
}

function listCredentials() {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT provider, username, expires_at, scope, auth_method, created_at, updated_at FROM git_credentials ORDER BY provider')
    .all();
  return rows.map((r) => ({ ...r, label: PROVIDERS[r.provider]?.label || r.provider }));
}

function listProviderStatus() {
  const configured = new Map(listCredentials().map((c) => [c.provider, c]));
  return Object.values(PROVIDERS).map((p) => {
    const c = configured.get(p.id);
    return {
      id: p.id,
      label: p.label,
      host: p.host,
      configured: Boolean(c),
      username: c?.username || null,
      authMethod: c?.auth_method || null,
      expires_at: c?.expires_at || null,
      updated_at: c?.updated_at || null,
    };
  });
}

function saveCredential({
  provider,
  token,
  username = null,
  refreshToken = null,
  expiresAt = null,
  scope = null,
  authMethod = 'token',
}) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Unsupported provider: ${provider}`);
  if (!token || typeof token !== 'string' || token.trim().length < 8) {
    throw new Error('A valid access token is required.');
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const encrypted = encrypt(token.trim());
  const cleanUser = username ? String(username).trim() : null;
  const cleanRefresh = refreshToken ? encrypt(String(refreshToken).trim()) : null;
  const cleanExpires = expiresAt || null;
  const cleanScope = scope ? String(scope).trim() : null;
  const cleanMethod = authMethod === 'oauth' ? 'oauth' : 'token';

  const existing = db.prepare('SELECT provider FROM git_credentials WHERE provider = ?').get(p.id);
  if (existing) {
    db.prepare(
      `UPDATE git_credentials
         SET username = ?, token_encrypted = ?, refresh_token_encrypted = ?,
             expires_at = ?, scope = ?, auth_method = ?, updated_at = ?
       WHERE provider = ?`
    ).run(cleanUser, encrypted, cleanRefresh, cleanExpires, cleanScope, cleanMethod, now, p.id);
  } else {
    db.prepare(
      `INSERT INTO git_credentials
         (provider, username, token_encrypted, refresh_token_encrypted, expires_at, scope, auth_method, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(p.id, cleanUser, encrypted, cleanRefresh, cleanExpires, cleanScope, cleanMethod, now, now);
  }

  return { provider: p.id, username: cleanUser, authMethod: cleanMethod, expires_at: cleanExpires, updated_at: now };
}

/**
 * Refresh an OAuth credential that is past (or within a minute of) its expiry,
 * if the provider issued a refresh token. Returns true when a new token was
 * stored. Failures bubble up so callers can decide whether to continue with the
 * existing token.
 */
async function refreshCredentialIfNeeded(provider, { force = false } = {}) {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM git_credentials WHERE provider = ?').get(provider);
  if (!row || !row.refresh_token_encrypted) return false;

  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : null;
  if (!force && !expiresAt) return false;
  if (!force && expiresAt && Date.now() < expiresAt - 60_000) return false;

  let refreshToken = null;
  try {
    refreshToken = decrypt(row.refresh_token_encrypted);
  } catch {
    return false;
  }
  if (!refreshToken) return false;

  const gitOAuthService = require('./gitOAuthService');
  const tokens = await gitOAuthService.refreshAccessToken(provider, refreshToken);
  saveCredential({
    provider,
    token: tokens.accessToken,
    username: row.username,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : null,
    scope: tokens.scope || row.scope,
    authMethod: 'oauth',
  });
  return true;
}

/**
 * Providers holding an OAuth credential whose token expires soon (or already
 * has). Used by the background refresher so plain `git push` inside terminals
 * keeps working even when the panel is idle.
 */
function listExpiringCredentials(windowMs = 30 * 60 * 1000) {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT provider, expires_at FROM git_credentials WHERE refresh_token_encrypted IS NOT NULL AND auth_method = 'oauth'")
    .all();
  const cutoff = Date.now() + windowMs;
  return rows
    .filter((r) => r.expires_at && Date.parse(r.expires_at) <= cutoff)
    .map((r) => r.provider);
}

function deleteCredential(provider) {
  const db = getDatabase();
  const res = db.prepare('DELETE FROM git_credentials WHERE provider = ?').run(provider);
  return { success: res.changes > 0, provider };
}

function getDecryptedCredential(provider) {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM git_credentials WHERE provider = ?').get(provider);
  if (!row) return null;

  let token = null;
  try {
    token = decrypt(row.token_encrypted);
  } catch {
    token = null;
  }
  if (!token) return null;

  return { provider: row.provider, username: row.username, token };
}

/**
 * Resolve stored credentials suitable for authenticating git over HTTP(S)
 * against the provider that owns the given repository URL.
 */
function resolveAuthForUrl(repoUrl) {
  let host;
  try {
    host = new URL(repoUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  const provider = Object.values(PROVIDERS).find(
    (p) => host === p.host || host.endsWith(`.${p.host}`)
  );
  if (!provider) return null;

  const cred = getDecryptedCredential(provider.id);
  if (!cred) return null;

  return {
    provider: provider.id,
    host,
    cloneUser: provider.cloneUser,
    token: cred.token,
  };
}

function normalizeRepo(provider, r) {
  if (provider === 'github') {
    return {
      id: String(r.id),
      fullName: r.full_name,
      name: r.name,
      private: Boolean(r.private),
      cloneUrl: r.clone_url,
      sshUrl: r.ssh_url,
      defaultBranch: r.default_branch || 'main',
      description: r.description || '',
    };
  }
  return {
    id: String(r.id),
    fullName: r.path_with_namespace,
    name: r.path,
    private: r.visibility !== 'public',
    cloneUrl: r.http_url_to_repo,
    sshUrl: r.ssh_url_to_repo,
    defaultBranch: r.default_branch || 'main',
    description: r.description || '',
  };
}

async function listRepos(provider) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Unsupported provider: ${provider}`);

  // Keep short-lived OAuth tokens usable without waiting for the background job.
  try {
    await refreshCredentialIfNeeded(p.id);
  } catch {
    // Refresh is best-effort; fall through and try with the current token.
  }

  const cred = getDecryptedCredential(p.id);
  if (!cred) throw new Error(`No ${p.label} credentials configured.`);

  const headers = {
    'User-Agent': 'Citadel',
    Accept: 'application/json',
    Authorization: `Bearer ${cred.token}`,
  };

  const url =
    p.id === 'github'
      ? `${p.apiBase}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`
      : `${p.apiBase}/projects?membership=true&per_page=100&order_by=last_activity_at`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Invalid or insufficient ${p.label} token (HTTP ${res.status}).`);
    }
    throw new Error(`${p.label} API error (HTTP ${res.status}).`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected ${p.label} API response.`);
  }
  return data.map((r) => normalizeRepo(p.id, r));
}

module.exports = {
  PROVIDERS,
  getProvider,
  listCredentials,
  listProviderStatus,
  saveCredential,
  deleteCredential,
  getDecryptedCredential,
  refreshCredentialIfNeeded,
  listExpiringCredentials,
  resolveAuthForUrl,
  listRepos,
};
