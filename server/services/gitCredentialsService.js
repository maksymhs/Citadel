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
    .prepare('SELECT provider, username, created_at, updated_at FROM git_credentials ORDER BY provider')
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
      updated_at: c?.updated_at || null,
    };
  });
}

function saveCredential({ provider, token, username = null }) {
  const p = getProvider(provider);
  if (!p) throw new Error(`Unsupported provider: ${provider}`);
  if (!token || typeof token !== 'string' || token.trim().length < 8) {
    throw new Error('A valid access token is required.');
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const encrypted = encrypt(token.trim());
  const cleanUser = username ? String(username).trim() : null;

  const existing = db.prepare('SELECT provider FROM git_credentials WHERE provider = ?').get(p.id);
  if (existing) {
    db.prepare('UPDATE git_credentials SET username = ?, token_encrypted = ?, updated_at = ? WHERE provider = ?')
      .run(cleanUser, encrypted, now, p.id);
  } else {
    db.prepare(
      'INSERT INTO git_credentials (provider, username, token_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(p.id, cleanUser, encrypted, now, now);
  }

  return { provider: p.id, username: cleanUser, updated_at: now };
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
  resolveAuthForUrl,
  listRepos,
};
