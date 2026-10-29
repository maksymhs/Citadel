/**
 * Project folder discovery and browser editor entry point.
 */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'renderProjectsView', 'showToast', 'state', 'openWorkspace'];
  let api, escapeHtml, renderProjectsView, showToast, state, openWorkspace;

  function init(ctx) {
    const missing = REQUIRED.filter((key) => ctx[key] === undefined);
    if (missing.length) throw new Error(`project-tools.js: missing ${missing.join(', ')}`);
    ({ api, escapeHtml, renderProjectsView, showToast, state, openWorkspace } = ctx);
  }

  async function mountDiscovery(content) {
    const panel = document.createElement('section');
    panel.className = 'card project-discovery';
    panel.hidden = true;
    const system = content.querySelector('.project-system');
    if (system) system.after(panel);
    else content.prepend(panel);
    const hostId = state.activeHostId;
    try {
      const result = await api('/api/projects/discover');
      if (!panel.isConnected || hostId !== state.activeHostId) return;
      if (!result.directories.length && !result.truncated) return;
      panel.hidden = false;
      panel.innerHTML = `<h3>Folders found</h3>
        <p class="mon-muted">Found in the projects directory. Import a folder to work with it.</p>
        ${result.directories.map((dir, index) => `<div class="proj-row">
          <div class="proj-main"><strong>${escapeHtml(dir.name)}</strong><div class="proj-path">${escapeHtml(dir.path)}</div></div>
          <button class="btn btn-secondary btn-sm" data-discover-index="${index}">Import folder</button>
        </div>`).join('')}
        ${result.truncated ? '<p class="mon-muted">Showing a limited scan. Use Import folder for other directories.</p>' : ''}`;
      panel.querySelectorAll('[data-discover-index]').forEach((button) => {
        button.onclick = async () => {
          const folder = result.directories[Number(button.dataset.discoverIndex)];
          if (hostId !== state.activeHostId) return;
          button.disabled = true;
          try {
            await api('/api/projects/import', { method: 'POST', body: { name: folder.name, targetPath: folder.path } });
            showToast('Project imported.', 'success');
            if (hostId === state.activeHostId) await renderProjectsView();
          } catch (err) {
            showToast(err.message, 'error');
            button.disabled = false;
          }
        };
      });
    } catch (err) {
      if (!panel.isConnected || hostId !== state.activeHostId) return;
      panel.hidden = false;
      panel.textContent = `Could not scan project folders: ${err.message}`;
    }
  }

  function showEditor(project) { return openWorkspace(project.id, 'vscode'); }
  function scopeKey(projectId) {
    return JSON.stringify([state.user?.id ?? state.user?.username ?? null, state.hostIdentity?.instanceId ?? location.origin, state.activeHostId, projectId]);
  }

  const preferences = new Map();
  function workspacePreference(projectId, partial) {
    const key = `citadel.workspace.${scopeKey(projectId)}`;
    let value = preferences.get(key) || {};
    try {
      if (state.user) value = JSON.parse(localStorage.getItem(key)) || value;
    } catch {}
    if (partial) {
      value = { ...value, ...partial };
      preferences.set(key, value);
      try { if (state.user) localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }
    return value;
  }

  let runtime = new Map(), runtimeScope = null, refreshAttempt = 0;
  const hostScope = () => scopeKey(null);
  function projectRuntime(projectId) {
    return runtimeScope === hostScope() ? runtime.get(projectId) || {} : {};
  }
  let refreshedAt = 0;
  async function refreshRuntime(force = true) {
    const scope = hostScope();
    if (!state.user) return;
    if (!force && runtimeScope === scope && Date.now() - refreshedAt < 5000) return;
    const attempt = ++refreshAttempt;
    const projects = state.projects.slice();
    const next = new Map();
    let editor;
    if (state.activeHostId === 'local' && state.user?.role === 'admin') {
      try { editor = (await api('/api/editor')).editor.running; } catch {}
    }
    await Promise.all(projects.map(async project => {
      let chat;
      if (state.activeHostId === 'local' && state.user?.role === 'admin') {
        try { chat = (await api(`/api/projects/${encodeURIComponent(project.id)}/chat/activity`)).running; } catch {}
      }
      next.set(project.id, {
        chat,
        editor,
        vscode: editor === true && workspacePreference(project.id).editorOpened === true,
      });
    }));
    if (scope !== hostScope() || attempt !== refreshAttempt) return;
    if (editor === false) {
      for (const project of projects) workspacePreference(project.id, { editorOpened: false });
    }
    runtime = next; runtimeScope = scope; refreshedAt = Date.now();
  }
  function reset() { preferences.clear(); runtime.clear(); runtimeScope = null; refreshAttempt++; }
  function showChat(project) { return openWorkspace(project.id, 'chat'); }

  window.CitadelProjectTools = { init, mountDiscovery, showEditor, showChat, scopeKey, workspacePreference, projectRuntime, refreshRuntime, reset };
})();
