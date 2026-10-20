/**
 * Citadel Git Credentials Service
 *
 * Thin facade over the unified secret vault (secretStore). Provider tokens are
 * stored as `GITHUB_TOKEN` / `GITLAB_TOKEN` entries (kind='git'), so git, the
 * provider APIs and agents all read from one encrypted place.
 */
const secretStore = require('./secretStore');

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

function gitSecretName(provider) {
  return `${String(provider).toUpperCase()}_TOKEN`;
}

function providerFromName(name) {
  return String(name).replace(/_TOKEN$/i, '').toLowerCase();
}

function listCredentials() {
  return secretStore
    .listSecrets()
    .filter((s) => s.kind === 'git')
    .map((s) => {
      const provider = (s.metadata && s.metadata.provider) || providerFromName(s.name);
      return {
        provider,
        username: (s.metadata && s.metadata.username) || null,
        created_at: s.created_at,
        updated_at: s.updated_at,
        label: PROVIDERS[provider]?.label || provider,
      };
    });
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

  const cleanUser = username ? String(username).trim() : null;
  const res = secretStore.setSecret(gitSecretName(p.id), token.trim(), {
    kind: 'git',
    metadata: { provider: p.id, username: cleanUser },
  });

  return { provider: p.id, username: cleanUser, updated_at: res.updated_at };
}

function deleteCredential(provider) {
  const p = getProvider(provider);
  const id = p ? p.id : provider;
  const res = secretStore.removeSecret(gitSecretName(id));
  return { success: res.success, provider: id };
}

function getDecryptedCredential(provider) {
  const p = getProvider(provider);
  if (!p) return null;
  const secret = secretStore.getSecret(gitSecretName(p.id));
  if (!secret) return null;
  return {
    provider: p.id,
    username: (secret.metadata && secret.metadata.username) || null,
    token: secret.value,
  };
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

const MAX_REPO_PAGES = 30;

function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
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

  // Both APIs cap a page at 100 entries; follow the Link header so accounts
  // with many repositories (or organisations) are listed in full.
  const all = [];
  let next = url;
  for (let page = 0; next && page < MAX_REPO_PAGES; page++) {
    const res = await fetch(next, { headers });
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
    all.push(...data);
    next = parseNextLink(res.headers && res.headers.get('link'));
  }
  return all.map((r) => normalizeRepo(p.id, r));
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
