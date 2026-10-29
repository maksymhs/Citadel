/** Browser VS Code session with local optional setup and an always-visible Citadel return action. */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'showToast', 'state'];
  let ctx, overlay, mounted = [], hostContent;
  function init(context) {
    for (const name of REQUIRED) if (context[name] === undefined) throw new Error(`browser-editor.js requires ${name}`);
    ctx = context;
  }
  function close() {
    overlay?.remove(); overlay = null;
    hostContent?.classList.remove('editor-host'); hostContent = null;
    for (const { element, inert } of mounted) if (!inert) element.removeAttribute('inert');
    mounted = [];
  }
  async function open(project, options = {}) {
    const { api, escapeHtml: esc, showToast, state } = ctx;
    if (state.activeHostId && state.activeHostId !== 'local') {
      showToast('Open this machine’s own Citadel panel to use its browser editor. Paired-machine editor transport is not available yet.', 'error');
      return;
    }
    close();
    const current = document.createElement('section');
    current.className = `browser-editor${options.content ? ' browser-editor-embedded' : ''}`;
    current.setAttribute('aria-label', `Browser editor: ${project.name}`);
    current.innerHTML = `<header class="browser-editor-bar"><button class="btn btn-secondary btn-sm" id="editor-back">← Back to Citadel</button><strong>${esc(project.name)} · VS Code web</strong><button class="btn btn-secondary btn-sm" id="editor-stop" hidden>Stop editor</button></header><div class="browser-editor-body" id="browser-editor-body"><p>Preparing editor…</p></div>`;
    overlay = current;
    if (options.content) {
      hostContent = options.content;
      mounted = [...hostContent.children].map(element => ({ element, inert: element.hasAttribute('inert') }));
      for (const { element } of mounted) element.setAttribute('inert', '');
      hostContent.classList.add('editor-host');
    }
    (options.content || document.body).append(current);
    const body = current.querySelector('#browser-editor-body');
    if (options.content) current.querySelector('.browser-editor-bar').remove();
    else current.querySelector('#editor-back').onclick = () => { if (present()) { close(); options.onClose?.(); } };
    const stop = current.querySelector('#editor-stop');
    if (stop) stop.onclick = async () => {
      if (!present() || stop.disabled) return;
      stop.disabled = true;
      try {
        await api('/api/editor', { method: 'DELETE' });
        if (present()) close();
      } catch (err) {
        if (present()) { stop.disabled = false; showToast(err.message, 'error'); }
      }
    };
    const scope = JSON.stringify([state.user?.id ?? state.user?.username, state.hostIdentity?.instanceId, state.activeHostId]);
    const present = () => overlay === current && current.isConnected && scope === JSON.stringify([state.user?.id ?? state.user?.username, state.hostIdentity?.instanceId, state.activeHostId]);
    async function launch() {
      if (!present()) return;
      body.innerHTML = '<p role="status">Starting browser editor…</p>';
      try {
        const result = await api(`/api/projects/${encodeURIComponent(project.id)}/editor`, { method: 'POST' });
        if (!present()) return;
        // The server supplies only a local project editor path, never an arbitrary iframe URL.
        if (!result.url?.startsWith(`/editor/${encodeURIComponent(project.id)}/?folder=`)) throw new Error('Invalid editor address.');
        body.innerHTML = `<iframe class="browser-editor-frame" title="VS Code · ${esc(project.name)}" src="${esc(result.url)}" allow="clipboard-read; clipboard-write"></iframe>`;
        window.CitadelProjectTools?.workspacePreference(project.id, { editorOpened: true });
        options.onOpened?.();
        if (stop) stop.hidden = false;
      } catch (err) { if (present()) showError(err); }
    }
    function showError(err) {
      body.innerHTML = `<div class="card browser-editor-setup"><p class="settings-warn">${esc(err.message)}</p><button class="btn btn-primary" id="editor-retry">Try again</button></div>`;
      body.querySelector('#editor-retry').onclick = launch;
    }
    try {
      const { editor } = await api('/api/editor');
      if (!present()) return;
      if (editor.installed) { await launch(); return; }
      body.innerHTML = `<div class="card browser-editor-setup"><h2>VS Code in your browser</h2><p>Install the optional editor on this Citadel machine. Your project opens here, without SSH or a desktop app.</p><p class="mon-muted">Downloads about 230 MB and uses additional disk space and memory while running. Available for Linux/macOS x64/arm64. Administrator access is required.</p><button class="btn btn-primary" id="editor-install" ${editor.supported && !editor.installing ? '' : 'disabled'}>${editor.installing ? 'Installation in progress — reopen when ready' : 'Install browser editor and open project'}</button></div>`;
      body.querySelector('#editor-install').onclick = async e => {
        if (!present() || e.currentTarget.disabled) return;
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Installing editor…';
        try { await api('/api/editor/install', { method: 'POST' }); if (present()) await launch(); }
        catch (err) { if (present()) { showError(err); body.querySelector('#editor-retry').onclick = () => { if (present()) open(project, options); }; } }
      };
    } catch (err) { if (present()) showError(err); }
  }
  window.CitadelBrowserEditor = { init, open, close };
})();
