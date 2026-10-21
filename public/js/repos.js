/**
 * Repositories: Git provider connections and repository browsing and cloning
 * Loaded before app.js; app.js passes the shared helpers in through init(), so
 * this file does not reach into app.js internals.
 */
(function () {
  'use strict';

  let api, escapeHtml, loadProjects, openModal, renderProjectsView, showToast;

  const REQUIRED = ['api', 'escapeHtml', 'loadProjects', 'openModal', 'renderProjectsView', 'showToast'];

  function init(ctx) {
    const missing = REQUIRED.filter((k) => ctx[k] === undefined);
    if (missing.length) throw new Error(`repos.js: app.js did not provide ${missing.join(', ')}`);
    ({ api, escapeHtml, loadProjects, openModal, renderProjectsView, showToast } = ctx);
  }

  // --- Git Repositories & Provider Connections ---
  async function renderReposView() {
    const content = document.getElementById('main-content');
    content.style.padding = '24px';
    content.innerHTML = '<div style="color:var(--text-secondary);">Loading Git providers...</div>';

    let providers = [];
    try {
      const res = await api('/api/git/credentials');
      providers = res.providers || [];
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</div>`;
      return;
    }

    const configured = providers.filter((p) => p.configured);

    content.innerHTML = `
      <div class="proj-subhead">
        <button class="top-bar-back" id="repos-back-btn"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg><span>Projects</span></button>
        <div>
          <h2 style="font-size:18px;">Git providers</h2>
          <p class="mon-muted">Connect a provider with a personal access token to browse and clone your private repositories. Tokens are encrypted at rest.</p>
        </div>
      </div>

      <div class="card" style="margin-bottom:24px;">
        <h3 style="font-size:15px;font-weight:600;margin-bottom:14px;">Connections</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;">
          ${providers.map((p) => renderProviderCard(p)).join('')}
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px;flex-wrap:wrap;">
          <h3 style="font-size:15px;font-weight:600;">Repositories</h3>
          ${configured.length > 0 ? `
            <div style="display:flex;gap:8px;align-items:center;">
              <select class="form-input" id="repos-provider-select" style="width:auto;">
                ${configured.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('')}
              </select>
              <button class="btn btn-secondary btn-sm" id="repos-load-btn">Load Repositories</button>
            </div>
          ` : ''}
        </div>
        <div id="repos-list-container">
          ${configured.length === 0
            ? '<p style="color:var(--text-muted);">Connect a provider above to list your repositories.</p>'
            : '<p style="color:var(--text-muted);">Click "Load Repositories" to browse your projects.</p>'}
        </div>
      </div>
    `;

    document.getElementById('repos-back-btn').onclick = () => {
      content.style.padding = '';
      renderProjectsView();
    };
    document.querySelectorAll('.provider-connect-btn').forEach((btn) => {
      btn.onclick = () => connectProvider(btn.getAttribute('data-provider'));
    });
    document.querySelectorAll('.provider-disconnect-btn').forEach((btn) => {
      btn.onclick = () => disconnectProvider(btn.getAttribute('data-provider'));
    });
    const loadBtn = document.getElementById('repos-load-btn');
    if (loadBtn) {
      loadBtn.onclick = () => loadRepositories(document.getElementById('repos-provider-select').value);
    }
  }

  function renderProviderCard(p) {
    return `
      <div style="border:1px solid var(--border-color);border-radius:8px;padding:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong>${escapeHtml(p.label)}</strong>
          <span class="badge ${p.configured ? 'badge-success' : 'badge-muted'}">${p.configured ? 'Connected' : 'Not connected'}</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;min-height:16px;">
          ${p.configured
            ? `${p.username ? `Account: ${escapeHtml(p.username)}<br>` : ''}Updated: ${p.updated_at ? new Date(p.updated_at).toLocaleString() : '-'}`
            : `Host: ${escapeHtml(p.host)}`}
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn ${p.configured ? 'btn-secondary' : 'btn-primary'} btn-sm provider-connect-btn" data-provider="${p.id}">
            ${p.configured ? 'Update Token' : 'Connect'}
          </button>
          ${p.configured ? `<button class="btn btn-secondary btn-sm provider-disconnect-btn" data-provider="${p.id}">Disconnect</button>` : ''}
        </div>
      </div>
    `;
  }

  function connectProvider(providerId) {
    const label = providerId.charAt(0).toUpperCase() + providerId.slice(1);
    openModal({
      title: `Connect ${label}`,
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Personal Access Token</label>
          <input type="password" class="form-input" id="m-git-token" placeholder="${providerId === 'github' ? 'ghp_... (repo scope)' : 'glpat-... (api scope)'}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Account Username (optional)</label>
          <input type="text" class="form-input" id="m-git-username" placeholder="your-username">
        </div>
        <p style="font-size:12px;color:var(--text-muted);">
          The token is encrypted at rest and only sent to ${escapeHtml(providerId)}. Use the narrowest scopes possible.
        </p>
      `,
      confirmText: 'Save Token',
      onConfirm: async () => {
        const token = document.getElementById('m-git-token').value;
        const username = document.getElementById('m-git-username').value;
        await api('/api/git/credentials', { method: 'POST', body: { provider: providerId, token, username } });
        showToast(`${label} connected.`, 'success');
        renderReposView();
      },
    });
  }

  async function disconnectProvider(providerId) {
    if (!window.confirm(`Disconnect ${providerId} and delete the stored token?`)) return;
    try {
      await api(`/api/git/credentials/${providerId}`, { method: 'DELETE' });
      showToast(`${providerId} disconnected.`, 'success');
      renderReposView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function loadRepositories(provider) {
    const container = document.getElementById('repos-list-container');
    container.innerHTML = '<p style="color:var(--text-secondary);">Loading repositories...</p>';
    try {
      const res = await api(`/api/git/repos?provider=${encodeURIComponent(provider)}`);
      const repos = res.repos || [];
      if (repos.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);">No repositories found for this token.</p>';
        return;
      }
      container.innerHTML = `
        <div class="form-group" style="margin-bottom:12px;">
          <input type="search" class="form-input" id="repos-search" placeholder="Search ${repos.length} repositories..." autocomplete="off">
        </div>
        <div id="repos-table-wrap"></div>
      `;
      const wrap = document.getElementById('repos-table-wrap');
      const renderTable = (query) => {
        const q = query.trim().toLowerCase();
        const rows = repos
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => !q || `${r.fullName} ${r.description}`.toLowerCase().includes(q));
        if (rows.length === 0) {
          wrap.innerHTML = '<p style="color:var(--text-muted);">No repositories match your search.</p>';
          return;
        }
        wrap.innerHTML = `
          <div class="table-container">
            <table class="data-table">
              <thead>
                <tr><th>Repository</th><th>Visibility</th><th>Default Branch</th><th>Action</th></tr>
              </thead>
              <tbody>
                ${rows.map(({ r, i }) => `
                  <tr>
                    <td data-label="Repository">
                      <strong>${escapeHtml(r.fullName)}</strong>
                      ${r.description ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(r.description)}</div>` : ''}
                    </td>
                    <td data-label="Visibility"><span class="badge ${r.private ? 'badge-muted' : 'badge-success'}">${r.private ? 'Private' : 'Public'}</span></td>
                    <td data-label="Default Branch" style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(r.defaultBranch)}</td>
                    <td data-label="Action"><button class="btn btn-primary btn-sm repos-clone-btn" data-index="${i}">Clone</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
        wrap.querySelectorAll('.repos-clone-btn').forEach((btn) => {
          btn.onclick = () => cloneRepoPrompt(repos[parseInt(btn.getAttribute('data-index'), 10)]);
        });
      };
      renderTable('');
      document.getElementById('repos-search').addEventListener('input', (e) => renderTable(e.target.value));
    } catch (err) {
      container.innerHTML = `<p style="color:var(--danger-color);">${escapeHtml(err.message)}</p>`;
    }
  }

  function cloneRepoPrompt(repo) {
    openModal({
      title: `Clone ${repo.fullName}`,
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Project Name</label>
          <input type="text" class="form-input" id="m-repo-name" value="${escapeHtml(repo.name)}">
        </div>
        <div class="form-group">
          <label class="form-label">Branch</label>
          <input type="text" class="form-input" id="m-repo-branch" value="${escapeHtml(repo.defaultBranch)}">
        </div>
        <p style="font-size:12px;color:var(--text-muted);">Source: <code>${escapeHtml(repo.cloneUrl)}</code></p>
      `,
      confirmText: 'Clone & Import',
      onConfirm: async () => {
        const name = document.getElementById('m-repo-name').value;
        const branch = document.getElementById('m-repo-branch').value;
        showToast('Cloning repository on the server...', 'info');
        await api('/api/projects/clone', { method: 'POST', body: { repoUrl: repo.cloneUrl, name, branch } });
        showToast('Repository cloned and imported successfully.', 'success');
        await loadProjects();
        renderReposView();
      },
    });
  }

  window.CitadelRepos = { init, renderReposView };
})();
