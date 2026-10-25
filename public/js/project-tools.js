/**
 * Project folder discovery and browser editor entry point.
 */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'renderProjectsView', 'showToast', 'state'];
  let api, escapeHtml, renderProjectsView, showToast, state;

  function init(ctx) {
    const missing = REQUIRED.filter((key) => ctx[key] === undefined);
    if (missing.length) throw new Error(`project-tools.js: missing ${missing.join(', ')}`);
    ({ api, escapeHtml, renderProjectsView, showToast, state } = ctx);
  }

  async function mountDiscovery(content) {
    const panel = document.createElement('section');
    panel.className = 'card project-discovery';
    panel.hidden = true;
    content.prepend(panel);
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

  function showEditor(project) { return window.CitadelBrowserEditor.open(project); }

  window.CitadelProjectTools = { init, mountDiscovery, showEditor };
})();
