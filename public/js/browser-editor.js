/** Browser VS Code session with local optional setup and an always-visible Citadel return action. */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'showToast', 'state'];
  let ctx, overlay, mounted = [], hostContent, cancelStartup;
  function init(context) {
    for (const name of REQUIRED) if (context[name] === undefined) throw new Error(`browser-editor.js requires ${name}`);
    ctx = context;
  }
  function close() {
    cancelStartup?.();
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
    current.innerHTML = `<header class="browser-editor-bar"><button class="btn btn-secondary btn-sm" id="editor-back">← Back to Citadel</button><strong>${esc(project.name)} · VS Code web</strong><button class="btn btn-secondary btn-sm" id="editor-stop" hidden>Stop editor</button></header><div class="browser-editor-body" id="browser-editor-body"><p class="browser-editor-loading" role="status">Preparing editor…</p></div>`;
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
    let launchGeneration = 0;
    async function launch() {
      if (!present()) return;
      const generation = ++launchGeneration;
      const active = () => present() && generation === launchGeneration;
      cancelStartup?.();
      body.innerHTML = '<p class="browser-editor-loading" role="status">Starting browser editor…</p>';
      try {
        const result = await api(`/api/projects/${encodeURIComponent(project.id)}/editor`, { method: 'POST' });
        if (!active()) return;
        // The server supplies only a local project editor path, never an arbitrary iframe URL.
        if (!result.url?.startsWith(`/editor/${encodeURIComponent(project.id)}/?folder=`)) throw new Error('Invalid editor address.');
        body.innerHTML = `<p class="browser-editor-loading" role="status">Loading VS Code…</p><iframe class="browser-editor-frame browser-editor-frame-loading" title="VS Code · ${esc(project.name)}" src="${esc(result.url)}" allow="clipboard-read; clipboard-write" aria-hidden="true" tabindex="-1"></iframe>`;
        waitForWorkbench(body.querySelector('iframe'), result.url);
        window.CitadelProjectTools?.workspacePreference(project.id, { editorOpened: true });
        options.onOpened?.();
        if (stop) stop.hidden = false;
      } catch (err) { if (active()) showError(err); }
    }
    function waitForWorkbench(frame, url) {
      // The proxy streams code-server's document unchanged: a black iframe element
      // cannot paint over its white canvas or theme splash. Keep that document
      // hidden until VS Code has replaced its splash with the actual workbench.
      const active = () => present() && frame.parentElement === body;
      const stopWaiting = () => {
        clearInterval(poll); clearTimeout(timeout);
        frame.onerror = null;
        if (cancelStartup === stopWaiting) cancelStartup = null;
      };
      const check = () => {
        if (!active()) { stopWaiting(); return; }
        try {
          const doc = frame.contentDocument;
          const splash = doc?.getElementById('monaco-parts-splash');
          if (!doc?.querySelector('.monaco-workbench') || doc.getElementById('vscode-startup-fallback') || doc.querySelector('.initialShellColors')) return;
          // VS Code hides this splash on first layout instead of removing it.
          if (splash && doc.defaultView.getComputedStyle(splash).display !== 'none') return;
          stopWaiting();
          frame.classList.remove('browser-editor-frame-loading');
          frame.removeAttribute('aria-hidden'); frame.removeAttribute('tabindex');
          body.querySelector('.browser-editor-loading')?.remove();
        } catch { /* An inaccessible or unexpected document stays masked until timeout. */ }
      };
      const fail = message => {
        stopWaiting();
        if (active()) showError(new Error(message), url);
      };
      const poll = setInterval(check, 100);
      const timeout = setTimeout(() => fail('VS Code is taking longer than expected to load. Try again or open it in a new tab.'), 60000);
      cancelStartup = stopWaiting;
      frame.onerror = () => fail('VS Code could not load. Try again or open it in a new tab.');
      check();
    }
    function showError(err, url) {
      body.innerHTML = `<div class="card browser-editor-setup"><p class="settings-warn">${esc(err.message)}</p><button class="btn btn-primary" id="editor-retry">Try again</button>${url ? ` <a class="btn btn-secondary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in new tab</a>` : ''}</div>`;
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
