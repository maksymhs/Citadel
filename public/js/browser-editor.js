/** Browser VS Code session with local optional setup and an always-visible Citadel return action. */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'showToast', 'state'];
  let ctx, overlay, cleanup;
  function init(context) {
    for (const name of REQUIRED) if (context[name] === undefined) throw new Error(`browser-editor.js requires ${name}`);
    ctx = context;
  }
  function close() {
    cleanup?.(); cleanup = null;
    overlay?.remove(); overlay = null;
  }
  async function openCode(project) {
    const { api, escapeHtml: esc, showToast, state } = ctx;
    if (state.activeHostId && state.activeHostId !== 'local') { showToast('Open this machine’s own Citadel panel to use OpenCode web.', 'error'); return; }
    close();
    const current = document.createElement('section');
    const content = document.getElementById('main-content');
    if (!content) return;
    const returnTarget = document.activeElement;
    const scrollTop = content.scrollTop, scrollLeft = content.scrollLeft;
    const mounted = [...content.children].map(element => ({ element, inert: element.hasAttribute('inert') }));
    current.className = 'browser-editor browser-editor-embedded';
    current.setAttribute('aria-label', `OpenCode web: ${project.name}`);
    current.innerHTML = `<header class="browser-editor-bar"><button class="btn btn-secondary btn-sm" id="editor-back">Return to Terminal</button><strong>${esc(project.name)} · OpenCode web</strong><button class="btn btn-secondary btn-sm" id="editor-stop">Stop OpenCode</button></header><div class="browser-editor-body" id="browser-editor-body"><p role="status">Starting OpenCode…</p></div>`;
    for (const { element } of mounted) element.setAttribute('inert', '');
    content.classList.add('browser-editor-host');
    overlay = current; content.append(current);
    content.scrollTop = 0; content.scrollLeft = 0;
    const observer = new MutationObserver(() => {
      if (overlay === current && !current.isConnected) close();
    });
    observer.observe(content, { childList: true });
    cleanup = () => {
      observer.disconnect();
      content.classList.remove('browser-editor-host');
      for (const { element, inert } of mounted) if (!inert) element.removeAttribute('inert');
      if (current.isConnected) {
        content.scrollTop = scrollTop; content.scrollLeft = scrollLeft;
        if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
      }
    };
    const present = () => overlay === current && current.isConnected;
    const body = current.querySelector('#browser-editor-body');
    current.querySelector('#editor-back').onclick = close;
    current.querySelector('#editor-back').focus();
    current.querySelector('#editor-stop').onclick = async e => {
      const button = e.currentTarget;
      button.disabled = true;
      try { await api('/api/opencode-web', { method: 'DELETE' }); if (present()) close(); }
      catch (err) { if (present()) { button.disabled = false; showToast(err.message, 'error'); } }
    };
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/opencode-web`, { method: 'POST' });
      if (!present()) return;
      if (!result.url?.startsWith(`/opencode/${encodeURIComponent(project.id)}/`)) throw new Error('Invalid OpenCode address.');
      body.innerHTML = `<iframe class="browser-editor-frame" title="OpenCode · ${esc(project.name)}" src="${esc(result.url)}"></iframe>`;
    } catch (err) {
      if (!present()) return;
      body.innerHTML = `<div class="card browser-editor-setup"><p class="settings-warn">${esc(err.message)}</p><button class="btn btn-primary" id="editor-retry">Try again</button></div>`;
      body.querySelector('#editor-retry').onclick = () => openCode(project);
    }
  }
  async function open(project) {
    const { api, escapeHtml: esc, showToast, state } = ctx;
    if (state.activeHostId && state.activeHostId !== 'local') {
      showToast('Open this machine’s own Citadel panel to use its browser editor. Paired-machine editor transport is not available yet.', 'error');
      return;
    }
    close();
    const current = document.createElement('section');
    current.className = 'browser-editor';
    current.setAttribute('aria-label', `Browser editor: ${project.name}`);
    current.innerHTML = `<header class="browser-editor-bar"><button class="btn btn-secondary btn-sm" id="editor-back">← Back to Citadel</button><strong>${esc(project.name)} · VS Code web</strong><button class="btn btn-secondary btn-sm" id="editor-stop" hidden>Stop editor</button></header><div class="browser-editor-body" id="browser-editor-body"><p>Preparing editor…</p></div>`;
    overlay = current; document.body.append(current);
    const body = current.querySelector('#browser-editor-body');
    current.querySelector('#editor-back').onclick = close;
    current.querySelector('#editor-stop').onclick = async () => {
      try { await api('/api/editor', { method: 'DELETE' }); close(); } catch (err) { showToast(err.message, 'error'); }
    };
    const present = () => overlay === current && current.isConnected;
    async function launch() {
      body.innerHTML = '<p role="status">Starting browser editor…</p>';
      try {
        const result = await api(`/api/projects/${encodeURIComponent(project.id)}/editor`, { method: 'POST' });
        if (!present()) return;
        // The server supplies only a local project editor path, never an arbitrary iframe URL.
        if (!result.url?.startsWith(`/editor/${encodeURIComponent(project.id)}/?folder=`)) throw new Error('Invalid editor address.');
        body.innerHTML = `<iframe class="browser-editor-frame" title="VS Code · ${esc(project.name)}" src="${esc(result.url)}" allow="clipboard-read; clipboard-write"></iframe>`;
        current.querySelector('#editor-stop').hidden = false;
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
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Installing editor…';
        try { await api('/api/editor/install', { method: 'POST' }); if (present()) await launch(); }
        catch (err) { if (present()) { showError(err); body.querySelector('#editor-retry').onclick = () => open(project); } }
      };
    } catch (err) { if (present()) showError(err); }
  }
  window.CitadelBrowserEditor = { init, open, openCode, close };
})();
