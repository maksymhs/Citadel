/**
 * Project folder discovery and desktop VS Code handoff; no background processes.
 */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'openModal', 'renderProjectsView', 'showToast', 'state'];
  let api, escapeHtml, openModal, renderProjectsView, showToast, state;

  function init(ctx) {
    const missing = REQUIRED.filter((key) => ctx[key] === undefined);
    if (missing.length) throw new Error(`project-tools.js: missing ${missing.join(', ')}`);
    ({ api, escapeHtml, openModal, renderProjectsView, showToast, state } = ctx);
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

  function editorUrl(projectPath, sshHost = '') {
    if (typeof projectPath !== 'string' || !projectPath.startsWith('/') || /[\x00-\x1f\x7f]/.test(projectPath)) {
      throw new Error('A valid absolute project path is required.');
    }
    const encodedPath = projectPath.split('/').map(encodeURIComponent).join('/').replace(/\/$/, '') + '/';
    if (!sshHost) return `vscode://file${encodedPath}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(sshHost)) {
      throw new Error('Use an SSH config host alias, such as citadel-vps.');
    }
    return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${encodedPath}`;
  }

  function showEditor(project) {
    const storageKey = `citadel.editor.${state.activeHostId}`;
    let saved = '';
    try { saved = localStorage.getItem(storageKey) || ''; } catch { /* optional preference */ }
    openModal({
      title: `Open ${project.name} in VS Code`,
      bodyHtml: `<p class="mon-muted">Opens VS Code on your computer. For a server, install Remote - SSH and use a host alias from your SSH config.</p>
        <div class="form-group"><label for="editor-mode">Project location</label><select class="form-input" id="editor-mode">
          <option value="ssh">Remote machine (SSH)</option><option value="local">This computer</option>
        </select></div>
        <div class="form-group"><label for="editor-ssh-host">SSH host alias (remote only)</label><input class="form-input" id="editor-ssh-host" value="${escapeHtml(saved)}" placeholder="citadel-vps" autocomplete="off"></div>
        <p class="proj-path">${escapeHtml(project.path)}</p>
        <p class="mon-muted" id="editor-link-hint"></p>
        <a class="btn btn-primary" id="editor-open-link" hidden>Open VS Code</a>`,
      confirmText: 'Close',
    });
    const mode = document.getElementById('editor-mode');
    const input = document.getElementById('editor-ssh-host');
    const link = document.getElementById('editor-open-link');
    const hint = document.getElementById('editor-link-hint');
    const updateLink = () => {
      const remote = mode.value === 'ssh';
      input.disabled = !remote;
      try {
        if (remote && !input.value.trim()) throw new Error('Enter the SSH host alias configured on your computer.');
        link.href = editorUrl(project.path, remote ? input.value.trim() : '');
        link.hidden = false;
        hint.textContent = remote ? 'Connects using your existing SSH configuration.' : 'The project path must exist on this computer.';
      } catch (err) {
        link.hidden = true;
        link.removeAttribute('href');
        hint.textContent = err.message;
      }
    };
    mode.onchange = updateLink;
    input.oninput = updateLink;
    link.onclick = () => {
      if (mode.value === 'ssh') {
        try { localStorage.setItem(storageKey, input.value.trim()); } catch { /* optional preference */ }
      }
    };
    updateLink();
  }

  window.CitadelProjectTools = { init, mountDiscovery, showEditor, editorUrl };
})();
