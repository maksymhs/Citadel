/**
 * Citadel Client-Side Application
 * Zero-framework, modular SPA for project, terminal, and AI agent management
 */

(function () {
  'use strict';

  // Application State
  const state = {
    setupComplete: true,
    user: null,
    currentView: 'dashboard',
    modules: [], // module descriptors from GET /api/modules
    modulesById: {},
    projects: [],
    activeProjectId: null,
    activeRepoId: null,
    workspaceContext: null, // 'system', a project id, or null for the overview
    activityTab: 'activity',
    terminals: new Map(), // sessionId -> { session, term, fitAddon, ws, containerEl }
    activeTerminalId: null,
    sysTerminals: new Map(), // host (non-project) terminal sessions
    activeSysTerminalId: null,
    allSessions: [], // every terminal session, drives the sidebar workspace tree
    workspaceNavOpen: true, // sidebar "Workspace" group expanded
    workspaceNavContexts: [], // workspace contexts whose terminals are expanded
    systemInfo: null,
    metrics: null,
    integrations: null,
    deployments: [],
    plugins: [],
    fleetHosts: [],
    fleetAgents: {}, // hostId -> agents[]
    fleetStatus: {}, // hostId -> { ok, version, commit } | { error }
    logsEvents: [],
    logsMetrics: [],
    logsSummary: null,
    logsFilter: { level: '', category: '', limit: 200 },
    auditLogs: [],
    docker: null,
    containers: [],
    dashboardTimer: null,
    dashboardPaused: false,
    tmuxAvailable: false,
    filesPath: '/',
    filesMode: 'list', // 'list' (tree) | 'grid' (folder view)
    dashboardWidgets: null, // ordered widget ids, persisted per browser
  };

  // Persist lightweight UI state so a page reload returns to the same view,
  // project and active terminal instead of always resetting to the dashboard.
  const UI_STATE_KEY = 'citadel.uiState';

  // The three primary views plus always-on core tool views. Optional module
  // views only appear in the sidebar when their module is enabled. System is
  // gone: host diagnostics/updates and Activity & Audit live in Settings.
  const PRIMARY_VIEWS = ['dashboard', 'projects', 'workspace'];
  const CORE_NAV = [
    { view: 'files', label: 'Files', icon: 'files' },
  ];
  const OPTIONAL_NAV = [
    { module: 'proxy', view: 'proxy', label: 'Proxy & Domains', icon: 'globe-icon' },
    { module: 'docker', view: 'docker', label: 'Docker', icon: 'docker-icon' },
    { module: 'fleet', view: 'fleet', label: 'Fleet', icon: 'cloud-icon' },
  ];
  const KNOWN_VIEWS = [
    ...PRIMARY_VIEWS, ...CORE_NAV.map((n) => n.view), 'settings', 'activity', 'processes',
    ...OPTIONAL_NAV.map((n) => n.view),
  ];
  // Legacy view ids → current ids, so a persisted view still resolves.
  const LEGACY_VIEW_MAP = {
    repos: 'projects', terminal: 'workspace', logs: 'activity',
    plugins: 'settings', modules: 'settings', deployments: 'proxy',
    system: 'settings',
  };

  // Default dashboard widget order. Widgets whose module is disabled/unavailable
  // are dropped at render time so the layout always stays valid.
  const DEFAULT_DASHBOARD_WIDGETS = [
    'memory', 'cpu', 'projects', 'host', 'fleet',
    'integrations', 'quick-access',
  ];
  const WIDGET_REQUIRES = { fleet: 'fleet', metrics: 'metrics' };

  function loadUiState() {
    try {
      return JSON.parse(localStorage.getItem(UI_STATE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveUiState(partial) {
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify({ ...loadUiState(), ...partial }));
    } catch {
      // Ignore storage errors (private mode / quota).
    }
  }

  // --- Module helpers -------------------------------------------------------
  // Core modules are always on; optional ones follow the registry state.
  const CORE_MODULE_IDS = ['dashboard', 'projects', 'workspace', 'activity', 'audit', 'files', 'metrics'];

  function moduleEnabled(id) {
    if (CORE_MODULE_IDS.includes(id)) return true;
    const m = state.modulesById[id];
    return m ? Boolean(m.enabled) : false;
  }

  function moduleState(id) {
    return state.modulesById[id] || null;
  }

  async function loadModules() {
    try {
      const res = await api('/api/modules');
      state.modules = res.modules || [];
      state.modulesById = Object.fromEntries(state.modules.map((m) => [m.id, m]));
    } catch (err) {
      // Fail closed: no optional module is enabled if the registry is unreachable.
      state.modules = [];
      state.modulesById = {};
      console.warn('Error loading modules:', err.message);
    }
  }

  // Sidebar icons (reused across nav entries).
  const NAV_ICONS = {
    dashboard: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>',
    projects: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>',
    workspace: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>',
    activity: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>',
    modules: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/>',
    system: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>',
    settings: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    agents: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>',
    files: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 13h6"/>',
    proxy: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/>',
    docker: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>',
    fleet: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.003 0 003 15z"/>',
  };

  function navItemHtml(view, label, iconKey, badgeHtml = '') {
    const icon = NAV_ICONS[iconKey] || NAV_ICONS.dashboard;
    return `<a class="nav-item" data-view="${view}">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">${icon}</svg>
      <span>${escapeHtml(label)}</span>
      ${badgeHtml}
    </a>`;
  }

  // API helper with cookie credentials
  async function api(path, options = {}) {
    const opts = { ...options, headers: { ...(options.headers || {}) } };
    if (opts.body && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }
    return data;
  }

  // Toast notification
  function showToast(message, type = 'info') {
    const root = document.getElementById('toast-root');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    root.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Lightweight popup menu anchored to an element. `items` is a list of
  // { label, onSelect, danger?, sep? } entries. Closes on outside click/Escape.
  let contextMenuEl = null;
  function closeContextMenu() {
    if (contextMenuEl) {
      contextMenuEl.remove();
      contextMenuEl = null;
    }
    document.removeEventListener('mousedown', onContextMenuOutside, true);
    document.removeEventListener('keydown', onContextMenuKey, true);
  }
  function onContextMenuOutside(e) {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) closeContextMenu();
  }
  function onContextMenuKey(e) {
    if (e.key === 'Escape') closeContextMenu();
  }
  function openContextMenu(anchorEl, items) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = items.map((it, i) => (it.sep
      ? '<div class="ctx-sep"></div>'
      : `<button type="button" class="ctx-item${it.danger ? ' ctx-danger' : ''}" data-ctx-idx="${i}">${escapeHtml(it.label)}</button>`)).join('');
    document.body.appendChild(menu);
    contextMenuEl = menu;

    const rect = anchorEl.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;

    menu.onclick = (e) => {
      const btn = e.target.closest('[data-ctx-idx]');
      if (!btn) return;
      const it = items[Number(btn.getAttribute('data-ctx-idx'))];
      closeContextMenu();
      if (it && it.onSelect) it.onSelect();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', onContextMenuOutside, true);
      document.addEventListener('keydown', onContextMenuKey, true);
    }, 0);
  }

  // Generic modal helper
  function openModal({ title, bodyHtml, confirmText = 'Confirm', onConfirm }) {
    const root = document.getElementById('modal-root');
    const previouslyFocused = document.activeElement;
    root.innerHTML = `
      <div class="modal-overlay" id="active-modal-overlay">
        <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="active-modal-title">
          <div class="modal-header">
            <h3 class="modal-title" id="active-modal-title">${escapeHtml(title)}</h3>
            <button class="tab-close-btn" id="modal-close-btn" aria-label="Close dialog">&times;</button>
          </div>
          <div class="modal-body">
            ${bodyHtml}
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="modal-confirm-btn">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      </div>
    `;

    const overlay = document.getElementById('active-modal-overlay');
    const close = () => {
      document.removeEventListener('keydown', onKeydown);
      root.innerHTML = '';
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };

    // Escape closes; Tab is trapped inside the dialog.
    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = root.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeydown);

    document.getElementById('modal-close-btn').onclick = close;
    document.getElementById('modal-cancel-btn').onclick = close;
    document.getElementById('modal-confirm-btn').onclick = async () => {
      if (onConfirm) {
        const btn = document.getElementById('modal-confirm-btn');
        btn.disabled = true;
        btn.textContent = 'Processing...';
        try {
          await onConfirm();
          close();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = confirmText;
          showToast(err.message, 'error');
        }
      } else {
        close();
      }
    };

    // Move focus into the dialog.
    const firstField = root.querySelector('input, textarea, select, button');
    if (firstField) firstField.focus();
  }

  // Bootstrap check
  async function init() {
    try {
      const statusRes = await api('/api/auth/status');
      state.setupComplete = statusRes.setupComplete;

      if (!state.setupComplete) {
        renderSetupView();
        return;
      }

      // Check current user session
      try {
        const meRes = await api('/api/auth/me');
        state.user = meRes.user;
        startApp();
      } catch {
        renderLoginView();
      }
    } catch (err) {
      document.getElementById('app-root').innerHTML = `
        <div style="padding: 40px; text-align: center; color: #f85149;">
          <h2>Failed to connect to Citadel</h2>
          <p>${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }

  // --- Auth Views ---
  function renderSetupView() {
    const root = document.getElementById('app-root');
    root.innerHTML = `
      <div class="auth-page">
        <div class="auth-card">
          <div class="logo">
            <div style="width:48px;height:48px;background:linear-gradient(135deg,#1f6feb,#8a2be2);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:bold;margin-bottom:12px;">C</div>
            <h1>Set up Citadel</h1>
            <p>Create the initial admin account to protect your server</p>
          </div>
          <form id="setup-form">
            <div class="form-group">
              <label class="form-label">Admin Username</label>
              <input type="text" class="form-input" id="setup-username" placeholder="admin" required minlength="3">
            </div>
            <div class="form-group">
              <label class="form-label">Master Password</label>
              <input type="password" class="form-input" id="setup-password" placeholder="Minimum 8 characters" required minlength="8">
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:10px;">
              Initialize Citadel
            </button>
          </form>
        </div>
      </div>
    `;

    document.getElementById('setup-form').onsubmit = async (e) => {
      e.preventDefault();
      const username = document.getElementById('setup-username').value;
      const password = document.getElementById('setup-password').value;
      try {
        const res = await api('/api/auth/setup', {
          method: 'POST',
          body: { username, password },
        });
        state.user = res.user;
        state.setupComplete = true;
        showToast('Admin account created successfully.', 'success');
        startApp();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  }

  function renderLoginView() {
    const root = document.getElementById('app-root');
    root.innerHTML = `
      <div class="auth-page">
        <div class="auth-card">
          <div class="logo">
            <div style="width:48px;height:48px;background:linear-gradient(135deg,#1f6feb,#8a2be2);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:bold;margin-bottom:12px;">C</div>
            <h1>Citadel</h1>
            <p>Secure access to your VPS control panel</p>
          </div>
          <form id="login-form">
            <div class="form-group">
              <label class="form-label">Username</label>
              <input type="text" class="form-input" id="login-username" required autocomplete="username">
            </div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input type="password" class="form-input" id="login-password" required autocomplete="current-password">
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:10px;">
              Sign In
            </button>
          </form>
        </div>
      </div>
    `;

    document.getElementById('login-form').onsubmit = async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value;
      const password = document.getElementById('login-password').value;
      try {
        const res = await api('/api/auth/login', {
          method: 'POST',
          body: { username, password },
        });
        state.user = res.user;
        showToast('Signed in.', 'success');
        startApp();
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  }

  // --- Main Application Shell ---
  function renderAppShell() {
    const root = document.getElementById('app-root');
    root.innerHTML = `
      <div id="app-container">
        <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
        <!-- Sidebar Navigation -->
        <aside class="sidebar" id="app-sidebar">
          <div class="sidebar-header">
            <div class="logo-icon">C</div>
            <span class="logo-text">Citadel</span>
            <span class="version-tag" id="app-version-tag"></span>
          </div>
          <nav class="sidebar-nav" id="sidebar-nav"></nav>
          <div class="sidebar-footer">
            <div class="user-profile">
              <div class="user-avatar">${(state.user.username || 'A')[0].toUpperCase()}</div>
              <div class="user-name">${escapeHtml(state.user.username)}</div>
            </div>
            <button class="btn btn-secondary btn-sm" id="logout-btn" title="Log out">
              <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
            </button>
          </div>
        </aside>

        <!-- Main Wrapper -->
        <div class="main-wrapper">
          <header class="top-bar">
            <button class="hamburger-btn" id="mobile-menu-btn" aria-label="Toggle navigation">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
            </button>
            <div class="top-bar-title" id="top-bar-title">Dashboard</div>
            <div class="top-bar-actions" id="top-bar-actions"></div>
          </header>
          <main class="content-body" id="main-content"></main>
        </div>
      </div>
    `;

    const sidebarEl = document.getElementById('app-sidebar');
    const backdropEl = document.getElementById('sidebar-backdrop');
    const closeSidebar = () => {
      sidebarEl.classList.remove('open');
      backdropEl.classList.remove('open');
    };

    document.getElementById('mobile-menu-btn').onclick = () => {
      sidebarEl.classList.toggle('open');
      backdropEl.classList.toggle('open');
    };
    backdropEl.onclick = closeSidebar;

    renderSidebarNav();
    bindSidebarNav(closeSidebar);

    document.getElementById('logout-btn').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      teardownSession();
      state.user = null;
      renderLoginView();
    };

    // Load initial data (only fetch optional-module data when it is enabled).
    loadProjects();
    loadSessions();
    loadVersionTag();

    // Force the mobile (off-canvas) layout for any touch/narrow device, even
    // when the browser requests the desktop site and reports a wide viewport.
    // The `is-mobile-ui` class drives the CSS, so it does not rely on media
    // queries matching.
    const applyDeviceMode = () => {
      const isMobile = window.matchMedia('(pointer: coarse)').matches
        || (navigator.maxTouchPoints || 0) > 0
        || window.innerWidth <= 768;
      document.documentElement.classList.toggle('is-mobile-ui', isMobile);
      if (!isMobile) closeSidebar();
    };
    applyDeviceMode();
    window.addEventListener('resize', applyDeviceMode);
    window.addEventListener('orientationchange', applyDeviceMode);
  }

  // Build the sidebar from the primary views plus any enabled optional module
  // views. Core modules always show; disabled modules are hidden entirely
  // (never rendered-but-hidden) so the navigation never advertises dead links.
  // "Workspace" is a two-level tree: the parent opens the overview selector and
  // each entry opens (or creates) that context's single terminal. The per-entry
  // menu closes it.
  function renderSidebarNav() {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;
    const optional = OPTIONAL_NAV.filter((n) => moduleEnabled(n.module));

    let html = '<div class="nav-section-title">Platform</div>';
    html += navItemHtml('dashboard', 'Dashboard', 'dashboard');
    html += navItemHtml('projects', 'Projects', 'projects', '<span class="nav-badge" id="nav-projects-count">' + (state.projects.length || 0) + '</span>');
    html += workspaceNavHtml();
    for (const item of CORE_NAV) html += navItemHtml(item.view, item.label, item.icon);

    if (optional.length) {
      html += '<div class="nav-section-title">Modules</div>';
      for (const item of optional) {
        html += navItemHtml(item.view, item.label, item.icon);
      }
    }

    html += '<div class="nav-section-title">Host</div>';
    html += navItemHtml('settings', 'Settings', 'settings');
    nav.innerHTML = html;
  }

  function navChevron(toggleKey, expanded) {
    return `<span class="nav-chevron${expanded ? ' open' : ''}" data-nav-toggle="${toggleKey}"
      role="button" tabindex="0" aria-label="${expanded ? 'Collapse' : 'Expand'}">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
    </span>`;
  }

  function workspaceNavHtml() {
    const open = state.workspaceNavOpen !== false;
    const parentActive = state.currentView === 'workspace' ? ' active' : '';
    let html = `<a class="nav-item nav-parent${parentActive}" data-view="workspace">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">${NAV_ICONS.workspace}</svg>
      <span>Workspace</span>${navChevron('workspace', open)}</a>`;
    if (!open) return html;

    html += '<div class="nav-sub">';
    html += workspaceNodeHtml('system', 'System (host)', null);
    for (const p of state.projects) {
      html += workspaceNodeHtml(p.id, p.name, p.path);
    }
    html += '</div>';
    return html;
  }

  // Two-level workspace tree: the "Workspace" parent (overview) and one entry
  // per context (the host plus every project). Each context owns a single
  // persistent terminal, opened by clicking the entry and closed from its menu.
  function workspaceNodeHtml(context, label, subtitle) {
    const session = sessionForContext(context);
    const isActiveCtx = state.currentView === 'workspace' && state.workspaceContext === context;
    const activeClass = isActiveCtx ? ' active' : '';
    const running = Boolean(session);
    return `<a class="nav-item nav-subitem${activeClass}" data-workspace-context="${context}" title="${escapeHtml(subtitle || label)}">
      <span class="nav-dot${running ? ' nav-dot-on' : ''}"></span><span class="nav-label">${escapeHtml(label)}</span>
      ${running ? `<button class="nav-item-menu" data-ws-menu-context="${context}" title="Terminal menu" aria-label="Terminal menu">&#8942;</button>` : ''}</a>`;
  }

  // Live terminal sessions belonging to a workspace context ('system' = host).
  function sessionsForContext(context) {
    const all = state.allSessions || [];
    return all.filter((s) => (context === 'system' ? !s.project_id : s.project_id === context));
  }

  // A context owns a single terminal: its currently-running session, or none.
  function sessionForContext(context) {
    const list = sessionsForContext(context);
    return list.find((s) => s.isAlive) || list[0] || null;
  }

  // One delegated listener on the (stable) nav container so re-rendering the
  // tree never loses handlers.
  function bindSidebarNav(closeSidebar) {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;

    const activate = (fn) => {
      fn();
      if (closeSidebar) closeSidebar();
    };

    nav.onclick = (e) => {
      const toggle = e.target.closest('[data-nav-toggle]');
      if (toggle) {
        e.preventDefault();
        toggleWorkspaceNav(toggle.getAttribute('data-nav-toggle'));
        return;
      }
      const menu = e.target.closest('[data-ws-menu-context]');
      if (menu) {
        e.preventDefault();
        e.stopPropagation();
        const context = menu.getAttribute('data-ws-menu-context');
        openContextMenu(menu, [
          { label: 'Open terminal', onSelect: () => openWorkspace(context) },
          { label: 'Close terminal', danger: true, onSelect: () => closeWorkspaceTerminal(context) },
        ]);
        return;
      }
      const ctx = e.target.closest('[data-workspace-context]');
      if (ctx) {
        e.preventDefault();
        activate(() => openWorkspace(ctx.getAttribute('data-workspace-context')));
        return;
      }
      const item = e.target.closest('[data-view]');
      if (item) {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        // Clicking the Workspace parent opens the overview selector.
        if (view === 'workspace') activate(openWorkspaceOverview);
        else activate(() => navigateTo(view));
      }
    };
  }

  function toggleWorkspaceNav(key) {
    if (key === 'workspace') {
      state.workspaceNavOpen = state.workspaceNavOpen === false;
      saveUiState({ workspaceNavOpen: state.workspaceNavOpen });
    } else if (key.startsWith('ctx:')) {
      const ctx = key.slice(4);
      const set = new Set(state.workspaceNavContexts || []);
      if (set.has(ctx)) set.delete(ctx); else set.add(ctx);
      state.workspaceNavContexts = Array.from(set);
      saveUiState({ workspaceNavContexts: state.workspaceNavContexts });
    }
    renderSidebarNav();
  }

  async function loadVersionTag() {
    const tag = document.getElementById('app-version-tag');
    if (!tag) return;
    try {
      const res = await api('/api/system/version');
      if (res.version && res.version.version) {
        tag.textContent = `v${res.version.version}`;
        tag.title = res.version.commit ? `commit ${res.version.commit}` : '';
      }
    } catch {
      // Non-fatal: leave the tag empty if the version cannot be fetched.
    }
  }

  async function startApp() {
    const ui = loadUiState();
    state.activeProjectId = ui.activeProjectId || null;
    state.activeTerminalId = ui.activeTerminalId || null;
    state.activeSysTerminalId = ui.activeSysTerminalId || null;
    state.workspaceContext = ui.workspaceContext || null;
    state.workspaceNavOpen = ui.workspaceNavOpen !== false;
    state.workspaceNavContexts = Array.isArray(ui.workspaceNavContexts) ? ui.workspaceNavContexts.slice() : [];
    state.activityTab = ui.activityTab === 'audit' ? 'audit' : 'activity';
    state.filesMode = ui.filesMode === 'grid' ? 'grid' : 'list';
    state.dashboardWidgets = Array.isArray(ui.dashboardWidgets) ? ui.dashboardWidgets.slice() : null;
    await loadModules();
    renderAppShell();
    navigateTo(resolveView(ui.currentView));
  }

  // Resolve a (possibly legacy/persisted) view id to a view that is currently
  // reachable, falling back to the dashboard for disabled/unknown modules.
  function resolveView(viewId) {
    let view = LEGACY_VIEW_MAP[viewId] || viewId;
    if (!KNOWN_VIEWS.includes(view)) view = 'dashboard';
    const optional = OPTIONAL_NAV.find((n) => n.view === view);
    if (optional && !moduleEnabled(optional.module)) view = 'dashboard';
    return view;
  }

  // Highlight the sidebar entry for the current view (used by navigateTo and by
  // screens opened directly, such as the Git Repositories screen).
  function setActiveNav(view) {
    document.querySelectorAll('.sidebar-nav [data-view]').forEach((item) => {
      if (item.getAttribute('data-view') === view) {
        item.classList.add('active');
        item.setAttribute('aria-current', 'page');
      } else {
        item.classList.remove('active');
        item.removeAttribute('aria-current');
      }
    });
  }

  function navigateTo(view) {
    view = resolveView(view);
    state.currentView = view;
    saveUiState({ currentView: view });
    if (state.dashboardTimer) {
      clearInterval(state.dashboardTimer);
      state.dashboardTimer = null;
    }
    state.dashboardPaused = false;
    setActiveNav(view);

    const titleEl = document.getElementById('top-bar-title');
    const actionsEl = document.getElementById('top-bar-actions');
    actionsEl.innerHTML = '';
    const contentEl = document.getElementById('main-content');
    if (contentEl) contentEl.style.padding = '';

    if (view === 'dashboard') {
      titleEl.textContent = 'Dashboard';
      renderDashboardView();
    } else if (view === 'projects') {
      titleEl.textContent = 'Projects & Repositories';
      renderProjectsView();
    } else if (view === 'workspace') {
      titleEl.textContent = 'Workspace';
      renderWorkspaceView();
    } else if (view === 'activity') {
      titleEl.textContent = 'Activity & Audit';
      renderActivityView();
    } else if (view === 'settings') {
      titleEl.textContent = 'Settings';
      renderSettingsView();
    } else if (view === 'processes') {
      titleEl.textContent = 'Top processes';
      renderProcessesView();
    } else if (view === 'files') {
      titleEl.textContent = 'File Explorer';
      renderFilesView();
    } else if (view === 'proxy') {
      titleEl.textContent = 'Proxy & Domains';
      renderDeploymentsView();
    } else if (view === 'docker') {
      titleEl.textContent = 'Docker';
      renderDockerView();
    } else if (view === 'fleet') {
      titleEl.textContent = 'Fleet — Remote Hosts';
      renderFleetView();
    }
  }

  // --- Data Loading ---
  async function loadProjects() {
    try {
      const res = await api('/api/projects');
      state.projects = res.projects || [];
      const badge = document.getElementById('nav-projects-count');
      if (badge) badge.textContent = state.projects.length;

      if (!state.activeProjectId && state.projects.length > 0) {
        state.activeProjectId = state.projects[0].id;
      }
      // The sidebar workspace tree lists projects, so refresh it.
      renderSidebarNav();
    } catch (err) {
      console.warn('Error loading projects:', err.message);
    }
  }

  // --- Views Implementation ---
  function formatMegabytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
  }

  // Refresh only the process table body so the rest of the screen stays still.
  async function refreshProcessTable() {
    const tbody = document.getElementById('process-table-body');
    if (!tbody) return;
    try {
      const res = await api('/api/system/processes?limit=15');
      const data = res.processes || {};
      const rows = data.processes || [];

      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);">No process data available on this platform.</td></tr>';
      } else {
        tbody.innerHTML = rows.map((p) => `
          <tr>
            <td data-label="PID" style="font-family:var(--font-mono);color:var(--text-secondary);">${p.pid}</td>
            <td data-label="Process">${escapeHtml(p.name)}</td>
            <td data-label="CPU"><span class="badge ${p.cpuPercent >= 50 ? 'badge-danger' : p.cpuPercent >= 10 ? 'badge-warning' : 'badge-muted'}">${p.cpuPercent.toFixed(1)}%</span></td>
            <td data-label="Memory" style="font-family:var(--font-mono);">${formatMegabytes(p.rssBytes)}</td>
            <td data-label="MEM %" style="font-family:var(--font-mono);color:var(--text-secondary);">${p.memPercent.toFixed(1)}%</td>
          </tr>
        `).join('');
      }

      const updatedEl = document.getElementById('process-updated');
      if (updatedEl) updatedEl.textContent = `${rows.length} of ${data.total} · ${new Date(data.timestamp).toLocaleTimeString()}`;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger-color);">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // 1. Dashboard View
  // --- Dashboard widgets ----------------------------------------------------
  // Each widget is independently ordered/toggled and persisted per browser.
  // Widgets backed by an optional module disappear when that module is off.
  const DASHBOARD_WIDGETS = {
    memory: { title: 'Memory usage', size: 3, module: 'dashboard' },
    cpu: { title: 'CPU load (1m)', size: 3, module: 'dashboard' },
    projects: { title: 'Active projects', size: 3, module: 'projects' },
    host: { title: 'VPS host', size: 3, module: 'dashboard' },
    integrations: { title: 'Platform integrations', size: 6, module: 'dashboard' },
    'quick-access': { title: 'Quick project access', size: 6, module: 'projects' },
    fleet: { title: 'Fleet — remote hosts', size: 12, module: 'fleet' },
  };

  // Visible widgets, in the user's saved order (or the defaults).
  function dashboardWidgetOrder() {
    const stored = Array.isArray(state.dashboardWidgets) && state.dashboardWidgets.length
      ? state.dashboardWidgets
      : DEFAULT_DASHBOARD_WIDGETS;
    const seen = new Set();
    const order = [];
    for (const id of stored) {
      if (!DASHBOARD_WIDGETS[id] || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
    // Built-in widgets added by an update should still surface for browsers
    // holding an older saved order, so append any defaults not yet listed.
    for (const id of DEFAULT_DASHBOARD_WIDGETS) {
      if (DASHBOARD_WIDGETS[id] && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    return order;
  }

  function widgetAvailable(id) {
    const def = DASHBOARD_WIDGETS[id];
    return def && moduleEnabled(def.module);
  }

  function dashboardWidgetHtml(id, ctx) {
    const { node, metrics, integ } = ctx;
    switch (id) {
      case 'memory':
        return card(`<div class="card-title">MEMORY USAGE</div>
          <div class="card-value">${metrics.memoryUsedPercent}%</div>
          <div class="card-subtitle">${Math.round(node.memory.usedBytes / 1024 / 1024)} MB of ${Math.round(node.memory.totalBytes / 1024 / 1024)} MB</div>`, 'processes');
      case 'cpu':
        return card(`<div class="card-title">CPU LOAD (1m)</div>
          <div class="card-value">${metrics.loadAvg.toFixed(2)}</div>
          <div class="card-subtitle">${node.cpu.cores} cores (${escapeHtml(node.cpu.model.split('@')[0].trim())})</div>`, 'processes');
      case 'projects':
        return card(`<div class="card-title">ACTIVE PROJECTS</div>
          <div class="card-value">${state.projects.length}</div>
          <div class="card-subtitle">${node.stats.activeSessions} persistent terminals</div>`);
      case 'host':
        return card(`<div class="card-title">VPS HOST</div>
          <div class="card-value" style="font-size:18px;">${escapeHtml(node.hostname)}</div>
          <div class="card-subtitle">${escapeHtml(node.platform)} ${escapeHtml(node.release)} (${node.arch})</div>`);
      case 'integrations':
        return card(`<h3 class="widget-heading">Platform integrations</h3>
          <div class="integration-list">
            ${integrationRow('tmux', integ.tmux.available, integ.tmux.available ? 'Available' : 'Not installed', integ.tmux.description)}
            ${integrationRow('Git CLI', integ.git.available, integ.git.available ? 'Active' : 'Not installed', integ.git.description)}
            ${integrationRow('Caddy proxy', integ.caddy.available, integ.caddy.available ? 'Active' : 'Optional', integ.caddy.helpMessage)}
            ${integrationRow('Docker engine', integ.docker.available, integ.docker.available ? 'Active' : 'Optional')}
          </div>
          <div class="integration-section-title">AI coding agents</div>
          <div class="integration-list">
            ${(integ.agents || []).map(agentRow).join('')}
          </div>`);
      case 'quick-access':
        return card(`<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <h3 class="widget-heading">Quick project access</h3>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-primary btn-sm" id="dash-new-project-btn">+ New</button>
              <button class="btn btn-secondary btn-sm" id="dash-clone-btn">Clone Git</button>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">
            ${state.projects.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">No projects registered yet.</div>' : ''}
            ${state.projects.slice(0, 5).map((p) => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-tertiary);border-radius:6px;">
                <div>
                  <strong style="color:var(--accent-color);">${escapeHtml(p.name)}</strong>
                  <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${escapeHtml(p.path)}</div>
                </div>
                <button class="btn btn-secondary btn-sm open-workspace-btn" data-project-id="${p.id}">Open</button>
              </div>`).join('')}
          </div>`);
      case 'fleet':
        return card(`<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;">
            <div>
              <h3 class="widget-heading">Fleet — remote hosts</h3>
              <div id="dash-fleet-summary" style="font-size:12px;color:var(--text-muted);margin-top:2px;">Checking all devices…</div>
            </div>
            <div style="display:flex;gap:10px;">
              <button class="btn btn-secondary btn-sm" id="dash-fleet-check-all">Check All</button>
              <button class="btn btn-secondary btn-sm" id="dash-fleet-update-all">Update All</button>
            </div>
          </div>
          <div id="dash-fleet-body"><div style="color:var(--text-muted);font-size:13px;">Loading…</div></div>`);
      default:
        return '';
    }

    function card(inner, targetView) {
      const clickableClass = targetView ? ' dash-widget-clickable' : '';
      const clickableAttrs = targetView
        ? ` role="button" tabindex="0" data-target-view="${targetView}"`
        : '';
      return `<div class="card dash-widget${clickableClass}" data-widget="${id}"${clickableAttrs}>${inner}</div>`;
    }
  }

  function integrationRow(name, ok, label, title) {
    return `<div class="integration-item"${title ? ` title="${escapeHtml(title)}"` : ''}>
      <span class="integration-name"><span class="status-dot ${ok ? 'ok' : 'off'}"></span>${escapeHtml(name)}</span>
      <span class="integration-status">${escapeHtml(label)}</span>
    </div>`;
  }

  function agentRow(agent) {
    const right = agent.available
      ? `<span class="integration-status"${agent.version ? ` title="${escapeHtml(agent.version)}"` : ''}>Installed</span>`
      : `<button class="btn btn-secondary btn-sm install-agent-btn" data-tool="${agent.id}" data-name="${escapeHtml(agent.name)}">Install</button>`;
    return `<div class="integration-item">
      <span class="integration-name"><span class="status-dot ${agent.available ? 'ok' : 'off'}"></span>${escapeHtml(agent.name)}</span>
      ${right}
    </div>`;
  }

  // Launch an agent's official install one-liner in a System Terminal session.
  async function installAgent(tool, name, btn) {
    if (!window.confirm(`Install ${name} now? It runs in a System Terminal session.`)) return;
    btn.disabled = true;
    try {
      const res = await api('/api/system/integrations/install', { method: 'POST', body: { tool } });
      const sessionId = res.session?.sessionId;
      if (sessionId) {
        state.activeSysTerminalId = sessionId;
        saveUiState({ activeSysTerminalId: sessionId });
      }
      showToast(`${name} install started in the System Terminal.`, 'success');
      state.workspaceContext = 'system';
      saveUiState({ workspaceContext: 'system' });
      navigateTo('workspace');
    } catch (err) {
      btn.disabled = false;
      showToast(err.message, 'error');
    }
  }
  async function renderDashboardView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Loading system metrics...</div>';

    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = '';

    try {
      const [nodeRes, metricsRes, integRes] = await Promise.all([
        api('/api/system/node'),
        api('/api/system/metrics'),
        api('/api/system/integrations'),
      ]);

      const node = nodeRes.node;
      const metrics = metricsRes.metrics;
      const integ = integRes.integrations;
      const ctx = { node, metrics, integ };

      const widgets = dashboardWidgetOrder().filter(widgetAvailable);
      content.innerHTML = `<div class="dash-widgets">${widgets.map((id) => dashboardWidgetHtml(id, ctx)).join('')}</div>`;

      document.getElementById('dash-new-project-btn')?.addEventListener('click', showCreateProjectModal);
      document.getElementById('dash-clone-btn')?.addEventListener('click', openGitRepositories);
      document.getElementById('dash-fleet-check-all')?.addEventListener('click', () => refreshDashboardFleet(true));
      document.getElementById('dash-fleet-update-all')?.addEventListener('click', fleetUpdateAll);
      bindActivityButtons();
      document.querySelectorAll('.open-workspace-btn').forEach((btn) => {
        btn.onclick = () => {
          state.workspaceContext = btn.getAttribute('data-project-id');
          saveUiState({ workspaceContext: state.workspaceContext });
          navigateTo('workspace');
        };
      });

      // Memory/CPU cards open the dedicated live processes screen.
      document.querySelectorAll('.dash-widget-clickable[data-target-view]').forEach((el) => {
        const go = () => navigateTo(el.getAttribute('data-target-view'));
        el.onclick = go;
        el.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            go();
          }
        };
      });

      if (widgets.includes('fleet')) refreshDashboardFleet();

      document.querySelectorAll('.install-agent-btn').forEach((btn) => {
        btn.onclick = () => installAgent(btn.getAttribute('data-tool'), btn.getAttribute('data-name') || btn.getAttribute('data-tool'), btn);
      });
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error loading dashboard: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Dedicated live process screen, opened from the Memory/CPU dashboard cards.
  async function renderProcessesView() {
    const content = document.getElementById('main-content');
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = '';

    content.innerHTML = `
      <div style="margin-bottom:20px;">
        <h2 style="font-size:18px;margin-bottom:6px;">Top processes</h2>
        <p style="color:var(--text-secondary);font-size:13px;">Live CPU &amp; memory usage per process.</p>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:12px;flex-wrap:wrap;">
          <div id="process-summary" style="font-size:12px;color:var(--text-muted);">Updates every 5 seconds</div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="badge badge-muted" id="process-updated">—</span>
            <button class="btn btn-secondary btn-sm" id="process-pause-btn">Pause</button>
          </div>
        </div>
        <div class="table-container">
          <table class="data-table">
            <thead><tr>
              <th style="width:90px;">PID</th><th>Process</th>
              <th style="width:100px;">CPU</th><th style="width:120px;">Memory</th><th style="width:100px;">MEM %</th>
            </tr></thead>
            <tbody id="process-table-body">
              <tr><td colspan="5" style="color:var(--text-muted);">Loading processes...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const pauseBtn = document.getElementById('process-pause-btn');
    pauseBtn.onclick = () => {
      state.dashboardPaused = !state.dashboardPaused;
      pauseBtn.textContent = state.dashboardPaused ? 'Resume' : 'Pause';
    };

    await refreshProcessTable();
    if (state.dashboardTimer) clearInterval(state.dashboardTimer);
    state.dashboardTimer = setInterval(() => {
      if (state.dashboardPaused || document.hidden) return;
      refreshProcessTable();
    }, 5000);
  }

  // 2. Projects View
  function renderProjectsActions() {
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="proj-creds-btn">Git</button>
      <button class="btn btn-secondary btn-sm" id="proj-import-btn">Import Folder</button>
      <button class="btn btn-primary btn-sm" id="proj-create-btn">+ New Project</button>
    `;
    document.getElementById('proj-create-btn').onclick = showCreateProjectModal;
    document.getElementById('proj-import-btn').onclick = showImportProjectModal;
    document.getElementById('proj-creds-btn').onclick = () => renderReposView();
  }

  // Open the Git Repositories screen from anywhere (e.g. the dashboard) without
  // showing a modal: switch to the Projects section and render that screen.
  function openGitRepositories() {
    state.currentView = 'projects';
    saveUiState({ currentView: 'projects' });
    setActiveNav('projects');
    const titleEl = document.getElementById('top-bar-title');
    if (titleEl) titleEl.textContent = 'Projects & Repositories';
    renderProjectsActions();
    renderReposView();
  }

  async function renderProjectsView() {
    renderProjectsActions();

    const content = document.getElementById('main-content');
    await loadProjects();

    if (state.projects.length === 0) {
      content.innerHTML = `
        <div class="card" style="text-align:center;padding:60px 20px;">
          <h3 style="font-size:18px;margin-bottom:8px;">No projects registered</h3>
          <p style="color:var(--text-secondary);max-width:400px;margin:0 auto 20px auto;">
            Register your first repository or working directory to open interactive terminals.
          </p>
          <div style="display:flex;justify-content:center;gap:12px;">
            <button class="btn btn-primary" id="empty-create-btn">Create Project</button>
            <button class="btn btn-secondary" id="empty-clone-btn">Clone Repository</button>
          </div>
        </div>
      `;
      document.getElementById('empty-create-btn').onclick = showCreateProjectModal;
      document.getElementById('empty-clone-btn').onclick = showCloneProjectModal;
      return;
    }

    content.innerHTML = `
      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Directory on VPS</th>
              <th>Repositories</th>
              <th>PTY Sessions</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${state.projects.map((p) => `
              <tr>
                <td data-label="Name">
                  <strong style="color:var(--text-primary);">${escapeHtml(p.name)}</strong>
                  <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.description || '')}</div>
                </td>
                <td data-label="Directory" style="font-family:var(--font-mono);font-size:12px;">
                  ${escapeHtml(p.path)}
                  ${p.existsOnDisk ? '' : '<span class="badge badge-danger" style="margin-left:6px;">Missing</span>'}
                </td>
                <td data-label="Repositories">
                  <button class="btn btn-secondary btn-sm toggle-repos-btn" data-project-id="${p.id}">
                    ${p.repos_count || 0} repo${(p.repos_count || 0) === 1 ? '' : 's'} &#9662;
                  </button>
                </td>
                <td data-label="PTY Sessions">
                  <span class="badge ${p.active_sessions_count > 0 ? 'badge-success' : 'badge-muted'}">
                    ${p.active_sessions_count} active
                  </span>
                </td>
                <td data-label="Actions">
                  <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <button class="btn btn-primary btn-sm open-workspace-btn" data-project-id="${p.id}">Open Workspace</button>
                    <button class="btn btn-secondary btn-sm assoc-repo-btn" data-project-id="${p.id}" data-project-name="${escapeHtml(p.name)}">+ Repository</button>
                    <button class="btn btn-danger btn-sm delete-project-btn" data-project-id="${p.id}" data-project-name="${escapeHtml(p.name)}">Delete</button>
                  </div>
                </td>
              </tr>
              <tr class="repo-detail-row" id="repos-row-${p.id}" hidden>
                <td colspan="5" style="background:var(--bg-tertiary);">
                  <div class="repo-detail-body" data-project-id="${p.id}">
                    <div style="color:var(--text-muted);font-size:13px;">Loading repositories...</div>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.querySelectorAll('.open-workspace-btn').forEach((btn) => {
      btn.onclick = () => {
        state.workspaceContext = btn.getAttribute('data-project-id');
        state.activeRepoId = null;
        saveUiState({ workspaceContext: state.workspaceContext, activeRepoId: null });
        navigateTo('workspace');
      };
    });

    document.querySelectorAll('.toggle-repos-btn').forEach((btn) => {
      btn.onclick = () => {
        const row = document.getElementById(`repos-row-${btn.getAttribute('data-project-id')}`);
        if (!row) return;
        row.hidden = !row.hidden;
        if (!row.hidden) loadProjectRepos(btn.getAttribute('data-project-id'));
      };
    });

    document.querySelectorAll('.assoc-repo-btn').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-project-id');
        const project = state.projects.find((p) => p.id === id);
        showAssociateRepoModal(project);
      };
    });

    document.querySelectorAll('.delete-project-btn').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-project-id');
        const name = btn.getAttribute('data-project-name');
        openModal({
          title: `Delete Project "${name}"`,
          bodyHtml: `
            <p style="margin-bottom:12px;color:var(--text-secondary);">
              Do you want to unlink this project from Citadel?
            </p>
            <div style="background:var(--bg-tertiary);padding:12px;border-radius:6px;margin-bottom:12px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="del-files-check">
                <span style="color:var(--danger-color);font-weight:600;">Also delete the files from disk</span>
              </label>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
                By default, your files are preserved untouched on the VPS.
              </div>
            </div>
          `,
          confirmText: 'Delete Project',
          onConfirm: async () => {
            const delFiles = document.getElementById('del-files-check')?.checked || false;
            await api(`/api/projects/${id}?deleteFiles=${delFiles}`, { method: 'DELETE' });
            showToast('Project deleted.', 'success');
            renderProjectsView();
          },
        });
      };
    });
  }

  // Render the expandable repository list for a project row.
  async function loadProjectRepos(projectId) {
    const body = document.querySelector(`.repo-detail-body[data-project-id="${projectId}"]`);
    if (!body) return;
    body.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Loading repositories...</div>';
    try {
      const res = await api(`/api/projects/${projectId}/repos`);
      const repos = res.repos || [];
      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;">
          <strong style="font-size:13px;">Repositories</strong>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-secondary btn-sm clone-repo-btn" data-project-id="${projectId}">Clone Repository</button>
            <button class="btn btn-secondary btn-sm assoc-repo-btn" data-project-id="${projectId}">Associate Folder</button>
          </div>
        </div>
        ${repos.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">No repositories yet.</div>' : `
          <div class="repo-list">
            ${repos.map((r) => `
              <div class="repo-item">
                <div class="repo-item-main">
                  <div>
                    <strong style="font-size:13px;">${escapeHtml(r.name)}</strong>
                    ${r.is_primary ? '<span class="badge badge-muted" style="margin-left:6px;">primary</span>' : ''}
                    <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escapeHtml(r.path)}</div>
                  </div>
                  <div style="font-size:12px;color:var(--text-secondary);">
                    ${r.git_branch ? `<span class="badge badge-muted">${escapeHtml(r.git_branch)}</span>` : '<span style="color:var(--text-muted);">no git</span>'}
                  </div>
                </div>
                <div class="repo-item-actions">
                  <button class="btn btn-secondary btn-sm open-repo-workspace-btn" data-project-id="${projectId}" data-repo-id="${r.id}">Open</button>
                  <button class="btn btn-secondary btn-sm repo-status-btn" data-project-id="${projectId}" data-repo-id="${r.id}" data-repo-name="${escapeHtml(r.name)}">Status</button>
                  <button class="btn btn-danger btn-sm repo-remove-btn" data-project-id="${projectId}" data-repo-id="${r.id}" data-repo-name="${escapeHtml(r.name)}">Remove</button>
                </div>
              </div>`).join('')}
          </div>`}
      `;
      bindRepoRowActions(projectId);
    } catch (err) {
      body.innerHTML = `<div style="color:var(--danger-color);font-size:13px;">Failed to load repositories: ${escapeHtml(err.message)}</div>`;
    }
  }

  function bindRepoRowActions(projectId) {
    const scope = document.querySelector(`.repo-detail-body[data-project-id="${projectId}"]`);
    if (!scope) return;
    const project = state.projects.find((p) => p.id === projectId);
    scope.querySelectorAll('.assoc-repo-btn').forEach((btn) => { btn.onclick = () => showAssociateRepoModal(project); });
    scope.querySelectorAll('.clone-repo-btn').forEach((btn) => { btn.onclick = () => showCloneRepoModal(project); });
    scope.querySelectorAll('.open-repo-workspace-btn').forEach((btn) => {
      btn.onclick = () => {
        state.workspaceContext = btn.getAttribute('data-project-id');
        state.activeRepoId = btn.getAttribute('data-repo-id');
        saveUiState({ workspaceContext: state.workspaceContext, activeRepoId: state.activeRepoId });
        navigateTo('workspace');
      };
    });
    scope.querySelectorAll('.repo-status-btn').forEach((btn) => {
      btn.onclick = () => showRepoStatusModal(
        btn.getAttribute('data-project-id'),
        btn.getAttribute('data-repo-id'),
        btn.getAttribute('data-repo-name'),
      );
    });
    scope.querySelectorAll('.repo-remove-btn').forEach((btn) => {
      btn.onclick = () => {
        const projectId = btn.getAttribute('data-project-id');
        const repoId = btn.getAttribute('data-repo-id');
        const repoName = btn.getAttribute('data-repo-name');
        openModal({
          title: `Remove repository "${repoName}"`,
          bodyHtml: `
            <p style="color:var(--text-secondary);margin-bottom:12px;">Unlink this repository from the project.</p>
            <div style="background:var(--bg-tertiary);padding:12px;border-radius:6px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="repo-del-files-check">
                <span style="color:var(--danger-color);font-weight:600;">Also delete the files from disk</span>
              </label>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Files are preserved by default.</div>
            </div>`,
          confirmText: 'Remove',
          onConfirm: async () => {
            const delFiles = document.getElementById('repo-del-files-check')?.checked || false;
            await api(`/api/projects/${projectId}/repos/${repoId}?deleteFiles=${delFiles}`, { method: 'DELETE' });
            showToast('Repository removed.', 'success');
            await loadProjects();
            renderProjectsView();
          },
        });
      };
    });
  }

  function showAssociateRepoModal(project) {
    openModal({
      title: `Associate folder to "${project ? project.name : 'project'}"`,
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Absolute path on server</label>
          <input type="text" class="form-input" id="m-repo-path" placeholder="/srv/apps/other-repo" required>
        </div>
        <div class="form-group">
          <label class="form-label">Display name (optional)</label>
          <input type="text" class="form-input" id="m-repo-name" placeholder="other-repo">
        </div>
        <p style="font-size:12px;color:var(--text-muted);">The folder stays exactly where it is; nothing is moved or copied.</p>`,
      confirmText: 'Associate',
      onConfirm: async () => {
        const targetPath = document.getElementById('m-repo-path').value;
        const name = document.getElementById('m-repo-name').value;
        await api(`/api/projects/${project.id}/repos`, { method: 'POST', body: { targetPath, name } });
        showToast('Folder associated.', 'success');
        await loadProjects();
        await loadProjectRepos(project.id);
      },
    });
  }

  function showCloneRepoModal(project) {
    openModal({
      title: `Clone repository into "${project ? project.name : 'project'}"`,
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Git URL</label>
          <input type="text" class="form-input" id="m-repo-clone-url" placeholder="https://github.com/user/repo.git" required>
        </div>
        <div class="form-group">
          <label class="form-label">Folder name (optional)</label>
          <input type="text" class="form-input" id="m-repo-clone-name" placeholder="repo">
        </div>
        <div class="form-group">
          <label class="form-label">Branch (optional)</label>
          <input type="text" class="form-input" id="m-repo-clone-branch" placeholder="main">
        </div>`,
      confirmText: 'Clone',
      onConfirm: async () => {
        const repoUrl = document.getElementById('m-repo-clone-url').value;
        const name = document.getElementById('m-repo-clone-name').value;
        const branch = document.getElementById('m-repo-clone-branch').value;
        showToast('Cloning repository on the server...', 'info');
        await api(`/api/projects/${project.id}/repos/clone`, { method: 'POST', body: { repoUrl, name, branch } });
        showToast('Repository cloned.', 'success');
        await loadProjects();
        await loadProjectRepos(project.id);
      },
    });
  }

  async function showRepoStatusModal(projectId, repoId, repoName) {
    openModal({
      title: `Git status — ${repoName}`,
      bodyHtml: '<div id="repo-status-body" style="color:var(--text-muted);">Loading…</div>',
      confirmText: 'Close',
      onConfirm: () => {},
    });
    const body = document.getElementById('repo-status-body');
    try {
      const { status } = await api(`/api/projects/${projectId}/repos/${repoId}/git/status`);
      if (!status.isGitRepo) {
        body.innerHTML = '<div style="color:var(--text-muted);">This folder is not a Git repository.</div>';
        return;
      }
      body.innerHTML = `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:13px;">
          <strong>Branch</strong><span>${escapeHtml(status.branch || '—')}</span>
          <strong>Remote</strong><span style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(status.remote || '—')}</span>
          <strong>Ahead / behind</strong><span>${status.ahead ?? 0} / ${status.behind ?? 0}</span>
        </div>`;
    } catch (err) {
      body.innerHTML = `<div style="color:var(--danger-color);">Failed to read status: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Modals for project creation/import/clone
  function showCreateProjectModal() {
    openModal({
      title: 'Create New Project',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Project Name</label>
          <input type="text" class="form-input" id="m-proj-name" placeholder="my-application" required>
        </div>
        <div class="form-group">
          <label class="form-label">Slug / Identifier (optional)</label>
          <input type="text" class="form-input" id="m-proj-slug" placeholder="my-application">
        </div>
        <div class="form-group">
          <label class="form-label">Description (optional)</label>
          <input type="text" class="form-input" id="m-proj-desc" placeholder="Production backend">
        </div>
      `,
      confirmText: 'Create Project',
      onConfirm: async () => {
        const name = document.getElementById('m-proj-name').value;
        const slug = document.getElementById('m-proj-slug').value;
        const description = document.getElementById('m-proj-desc').value;
        await api('/api/projects', {
          method: 'POST',
          body: { name, slug, description },
        });
        showToast('Project created successfully.', 'success');
        await loadProjects();
        if (state.currentView === 'projects') renderProjectsView();
        else if (state.currentView === 'dashboard') renderDashboardView();
      },
    });
  }

  function showImportProjectModal() {
    openModal({
      title: 'Import Existing VPS Directory',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Absolute Path on Server</label>
          <input type="text" class="form-input" id="m-import-path" placeholder="/srv/my-projects/app" required>
        </div>
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input type="text" class="form-input" id="m-import-name" placeholder="My Existing App" required>
        </div>
        <div class="form-group">
          <label class="form-label">Description (optional)</label>
          <input type="text" class="form-input" id="m-import-desc">
        </div>
      `,
      confirmText: 'Import Directory',
      onConfirm: async () => {
        const targetPath = document.getElementById('m-import-path').value;
        const name = document.getElementById('m-import-name').value;
        const description = document.getElementById('m-import-desc').value;
        await api('/api/projects/import', {
          method: 'POST',
          body: { targetPath, name, description },
        });
        showToast('Directory imported successfully.', 'success');
        await loadProjects();
        if (state.currentView === 'projects') renderProjectsView();
      },
    });
  }

  function showCloneProjectModal() {
    openModal({
      title: 'Clone Git Repository',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Git Repository URL</label>
          <input type="text" class="form-input" id="m-clone-url" placeholder="https://github.com/user/repo.git" required>
        </div>
        <div class="form-group">
          <label class="form-label">Project Name (optional)</label>
          <input type="text" class="form-input" id="m-clone-name" placeholder="repo">
        </div>
        <div class="form-group">
          <label class="form-label">Branch (optional)</label>
          <input type="text" class="form-input" id="m-clone-branch" placeholder="main">
        </div>
        <p style="font-size:12px;color:var(--text-muted);">
          Private repositories use the credentials configured under <strong>Projects → Git</strong>.
        </p>
      `,
      confirmText: 'Clone & Import',
      onConfirm: async () => {
        const repoUrl = document.getElementById('m-clone-url').value;
        const name = document.getElementById('m-clone-name').value;
        const branch = document.getElementById('m-clone-branch').value;
        showToast('Cloning repository on the server...', 'info');
        await api('/api/projects/clone', {
          method: 'POST',
          body: { repoUrl, name, branch },
        });
        showToast('Repository cloned and imported successfully.', 'success');
        await loadProjects();
        if (state.currentView === 'projects') renderProjectsView();
      },
    });
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
      <div style="margin-bottom:24px;">
        <h2 style="font-size:18px;margin-bottom:6px;">Git Repositories</h2>
        <p style="color:var(--text-secondary);">
          Connect a provider with a personal access token to browse and clone your private repositories.
          Tokens are encrypted at rest on the server.
        </p>
      </div>

      <div class="card" style="margin-bottom:24px;">
        <h3 style="font-size:15px;font-weight:600;margin-bottom:14px;">Provider Connections</h3>
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
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr><th>Repository</th><th>Visibility</th><th>Default Branch</th><th>Action</th></tr>
            </thead>
            <tbody>
              ${repos.map((r, i) => `
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
      container.querySelectorAll('.repos-clone-btn').forEach((btn) => {
        btn.onclick = () => cloneRepoPrompt(repos[parseInt(btn.getAttribute('data-index'), 10)]);
      });
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

  // --- Shared terminal client helpers (xterm + WebSocket) ---
  // Terminal instances are kept alive across view changes: navigating away only
  // detaches their DOM containers. Returning to the view re-mounts the existing
  // containers into the new viewport and re-fits them, while the server keeps the
  // tmux/PTY session running, so nothing is lost.
  function createXterm() {
    // Smaller font on phones/tablets so more columns and rows fit on screen.
    const mobile = document.documentElement.classList.contains('is-mobile-ui');
    const term = new Terminal({
      cursorBlink: true,
      fontSize: mobile ? 10 : 12,
      lineHeight: 1.0,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#000000',
        foreground: '#f0f6fc',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(88, 166, 255, 0.3)',
        black: '#161b22',
        red: '#f85149',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
      },
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    return { term, fitAddon };
  }

  function createTerminalItem({ sessionId, name, projectId = null, kind = 'project', viewport = null }) {
    const containerEl = document.createElement('div');
    containerEl.className = 'terminal-element';
    containerEl.style.display = 'none';
    if (viewport) viewport.appendChild(containerEl);

    const { term, fitAddon } = createXterm();
    term.open(containerEl);

    const item = {
      sessionId, name, projectId, kind, term, fitAddon,
      ws: null, containerEl, copyMode: false, disposed: false,
      reconnectStopped: false, reconnectTimer: null, reconnectDelay: 1000,
    };

    term.onData((data) => {
      if (item.ws && item.ws.readyState === WebSocket.OPEN) {
        item.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onResize((size) => {
      if (item.ws && item.ws.readyState === WebSocket.OPEN) {
        item.ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });

    enableTouchScroll(containerEl, term, () => item);
    connectTerminalSocket(item);
    return item;
  }

  function connectTerminalSocket(item) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${item.sessionId}`);
    item.ws = ws;

    ws.onopen = () => {
      item.reconnectDelay = 1000;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: item.term.cols, rows: item.term.rows }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && msg.data) {
          item.term.write(msg.data);
        } else if (msg.type === 'exit') {
          item.term.write('\r\n\x1b[33m[Terminal process finished]\x1b[0m\r\n');
        } else if (msg.type === 'error') {
          item.term.write(`\r\n\x1b[31m[Error]: ${msg.message}\x1b[0m\r\n`);
          if (/not found|unauthoriz|forbidden/i.test(msg.message || '')) {
            item.reconnectStopped = true;
          }
        }
      } catch {
        item.term.write(event.data);
      }
    };

    ws.onclose = () => {
      if (!item.disposed && !item.reconnectStopped) scheduleTerminalReconnect(item);
    };
  }

  function scheduleTerminalReconnect(item) {
    if (item.disposed || item.reconnectStopped || item.reconnectTimer) return;
    const delay = item.reconnectDelay;
    item.reconnectDelay = Math.min(item.reconnectDelay * 2, 15000);
    item.term.write('\r\n\x1b[90m[Connection lost — reconnecting…]\x1b[0m\r\n');
    item.reconnectTimer = setTimeout(() => {
      item.reconnectTimer = null;
      if (item.disposed) return;
      try {
        item.term.reset();
      } catch {
        // Ignore
      }
      connectTerminalSocket(item);
    }, delay);
  }

  // Re-attach existing containers to a freshly rendered viewport and show only
  // the active one. Containers survive innerHTML replacement because we move the
  // same DOM node back into the new viewport.
  function mountTerminalItems(viewport, items, activeId, filterFn = null) {
    for (const [id, item] of items.entries()) {
      if (filterFn && !filterFn(item)) continue;
      if (item.containerEl.parentElement !== viewport) {
        viewport.appendChild(item.containerEl);
      }
      item.containerEl.style.display = (id === activeId) ? 'block' : 'none';
    }
  }

  function fitTerminalItem(item) {
    if (!item) return;
    requestAnimationFrame(() => {
      try {
        if (item.containerEl.style.display !== 'none') {
          item.fitAddon.fit();
          item.term.focus();
        }
      } catch {
        // Ignore fit errors on detached/hidden elements.
      }
    });
  }

  function disposeTerminalItem(item) {
    if (!item) return;
    item.disposed = true;
    if (item.reconnectTimer) {
      clearTimeout(item.reconnectTimer);
      item.reconnectTimer = null;
    }
    try {
      if (item.ws) item.ws.close();
      if (item.term) item.term.dispose();
      if (item.containerEl) item.containerEl.remove();
    } catch {
      // Ignore
    }
  }

  // Drop every background resource owned by the current session: the dashboard
  // poll timer and all open terminal sockets/timers. Called on logout so a
  // signed-out browser stops talking to the server.
  function teardownSession() {
    if (state.dashboardTimer) {
      clearInterval(state.dashboardTimer);
      state.dashboardTimer = null;
    }
    for (const item of state.terminals.values()) disposeTerminalItem(item);
    state.terminals.clear();
    state.activeTerminalId = null;
    for (const item of state.sysTerminals.values()) disposeTerminalItem(item);
    state.sysTerminals.clear();
    state.activeSysTerminalId = null;
  }

  // Re-fit the currently visible terminals when the window changes size.
  function refitActiveTerminals() {
    const activeProject = state.terminals.get(state.activeTerminalId);
    if (activeProject && activeProject.containerEl.isConnected) fitTerminalItem(activeProject);
    const activeSys = state.sysTerminals.get(state.activeSysTerminalId);
    if (activeSys && activeSys.containerEl.isConnected) fitTerminalItem(activeSys);
  }

  // Mirror the *visible* viewport (window.visualViewport) into CSS variables.
  // Mobile browsers do not shrink the layout viewport (100dvh) when the on-screen
  // keyboard opens, so without this the keyboard covers the terminal input line.
  function setupVisualViewport() {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const apply = () => {
      if (!vv) return;
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
    };
    apply();
    if (vv) {
      vv.addEventListener('resize', () => {
        apply();
        refitActiveTerminals();
      });
      vv.addEventListener('scroll', apply);
    }
  }

  window.addEventListener('resize', refitActiveTerminals);
  setupVisualViewport();

  // --- File Explorer View ---
  // Two complementary modes over the host filesystem:
  //   • "list" — a lazy, hierarchical tree (Wunderbaum) for deep navigation.
  //   • "grid" — a folder view with large tiles, ideal for touch screens.
  // Both work with mouse, keyboard and touch and share the same create / edit /
  // delete actions (right-click, long-press or the context-menu key opens them).
  let filesTree = null;
  let filesGridItems = [];
  let filesGridIndex = -1;

  // Wunderbaum's default expander icons come from Bootstrap Icons, which this
  // panel does not ship, so we map them to our own CSS chevrons (see app.css).
  // File/folder glyphs are inlined as SVG so they inherit the row colour.
  const FILES_ICON_MAP = {
    loading: 'wb-exp wb-exp-closed',
    expanderExpanded: 'wb-exp wb-exp-open',
    expanderCollapsed: 'wb-exp wb-exp-closed',
    expanderLazy: 'wb-exp wb-exp-closed',
  };
  const FILES_FOLDER_ICON = '<svg class="wb-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const FILES_FILE_ICON = '<svg class="wb-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/></svg>';
  const FILES_ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';
  const FILES_ICON_GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  const FILES_ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';

  function filesIsDir(item) {
    return item.type === 'dir' || item.type === 'symlink-dir';
  }

  function filesIsLink(item) {
    return item.type === 'symlink' || item.type === 'symlink-file' || item.type === 'symlink-dir';
  }

  function filesListing(dir) {
    return api(`/api/files?path=${encodeURIComponent(dir)}`).then((res) => res.listing);
  }

  function filesTouchMode() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  function filesRowHeight() {
    return window.matchMedia('(max-width: 768px), (hover: none) and (pointer: coarse)').matches ? 40 : 28;
  }

  function setFilesStatus(html) {
    const el = document.getElementById('files-status');
    if (el) el.innerHTML = html || '';
  }

  function filesNodeData(item) {
    const isDir = filesIsDir(item);
    return {
      key: item.path,
      title: item.name,
      // Custom fields must sit at the top level: Wunderbaum stores every
      // unknown property on `node.data` (it does not unwrap a nested `data`).
      path: item.path,
      kind: isDir ? 'dir' : 'file',
      lazy: isDir,
      icon: isDir ? FILES_FOLDER_ICON : FILES_FILE_ICON,
    };
  }

  function filesNodeFromRow(rowEl) {
    if (!rowEl) return null;
    return mar10.Wunderbaum.getNode(rowEl);
  }

  function filesMenuItems(nodePath, kind) {
    const items = [];
    if (kind === 'dir') {
      items.push({ label: 'New file', onSelect: () => promptNewEntry('file', nodePath) });
      items.push({ label: 'New folder', onSelect: () => promptNewEntry('dir', nodePath) });
    } else {
      items.push({ label: 'Edit', onSelect: () => openFileEditor(nodePath) });
      items.push({
        label: 'Download',
        onSelect: () => { window.location.href = `/api/files/download?path=${encodeURIComponent(nodePath)}`; },
      });
    }
    items.push({ sep: true });
    items.push({ label: 'Delete', danger: true, onSelect: () => removeEntry(nodePath) });
    return items;
  }

  function filesItemMeta(item) {
    if (filesIsDir(item)) return 'folder';
    const size = formatBytes(item.size);
    return filesIsLink(item) ? `${size} · link` : size;
  }

  function filesTileHtml(item, index) {
    const isDir = filesIsDir(item);
    const glyph = isDir ? FILES_FOLDER_ICON : FILES_FILE_ICON;
    return `<button type="button" class="files-tile${isDir ? ' is-dir' : ''}" data-idx="${index}" role="option" aria-selected="false" title="${escapeHtml(item.name)}">
      <span class="files-tile-icon">${glyph}</span>
      <span class="files-tile-name">${escapeHtml(item.name)}</span>
      <span class="files-tile-meta">${escapeHtml(filesItemMeta(item))}</span>
    </button>`;
  }

  function filesCrumbHtml(dir) {
    const parts = String(dir || '/').split('/').filter(Boolean);
    let acc = '';
    let html = `<button type="button" class="files-crumb${parts.length ? '' : ' is-current'}" data-path="/" title="/">/</button>`;
    parts.forEach((part, i) => {
      acc += `/${part}`;
      const current = i === parts.length - 1;
      html += `<span class="files-crumb-sep" aria-hidden="true">›</span><button type="button" class="files-crumb${current ? ' is-current' : ''}" data-path="${escapeHtml(acc)}">${escapeHtml(part)}</button>`;
    });
    return html;
  }

  function filesToolbarHtml() {
    const isList = state.filesMode !== 'grid';
    return `
      <div class="files-toolbar">
        <div class="files-crumbs" id="files-crumbs"${isList ? ' hidden' : ''}>${filesCrumbHtml(state.filesPath)}</div>
        <div class="files-toolbar-spacer"></div>
        <div class="files-view-toggle" role="group" aria-label="View mode">
          <button type="button" class="files-toggle-btn${isList ? ' is-active' : ''}" data-mode="list" title="List view" aria-label="List view" aria-pressed="${isList}">${FILES_ICON_LIST}</button>
          <button type="button" class="files-toggle-btn${isList ? '' : ' is-active'}" data-mode="grid" title="Grid (folder) view" aria-label="Grid view" aria-pressed="${!isList}">${FILES_ICON_GRID}</button>
        </div>
        <button class="btn btn-secondary btn-sm" id="files-new-file">+ File</button>
        <button class="btn btn-secondary btn-sm" id="files-new-folder">+ Folder</button>
        <button class="btn btn-secondary btn-sm" id="files-refresh" title="Refresh" aria-label="Refresh">${FILES_ICON_REFRESH}</button>
      </div>`;
  }

  async function renderFilesView() {
    const content = document.getElementById('main-content');
    document.getElementById('top-bar-actions').innerHTML = '';
    content.style.padding = '0'; // The explorer manages its own full-height layout.

    if (filesTree) {
      filesTree.destroy();
      filesTree = null;
    }

    content.innerHTML = `
      <div class="files-view">
        ${filesToolbarHtml()}
        <div class="files-body" id="files-body"></div>
        <div class="files-statusbar" id="files-status"></div>
      </div>`;

    document.querySelectorAll('.files-toggle-btn').forEach((btn) => {
      btn.onclick = () => {
        const mode = btn.getAttribute('data-mode');
        if (mode === state.filesMode) return;
        state.filesMode = mode;
        saveUiState({ filesMode: mode });
        renderFilesView();
      };
    });
    document.getElementById('files-new-file').onclick = () => promptNewEntry('file', state.filesPath);
    document.getElementById('files-new-folder').onclick = () => promptNewEntry('dir', state.filesPath);
    document.getElementById('files-refresh').onclick = () => renderFilesView();

    const crumbs = document.getElementById('files-crumbs');
    crumbs.onclick = (ev) => {
      const btn = ev.target.closest('.files-crumb');
      if (!btn) return;
      state.filesPath = btn.getAttribute('data-path');
      renderFilesView();
    };

    if (state.filesMode === 'grid') await renderFilesGrid();
    else await renderFilesList();
  }

  async function renderFilesList() {
    const body = document.getElementById('files-body');
    body.innerHTML = '<div id="files-tree" class="files-tree"></div>';
    setFilesStatus('Loading…');

    let rootListing;
    try {
      rootListing = await filesListing('/');
    } catch (err) {
      body.innerHTML = `<div class="files-empty" style="color:var(--danger-color);">${escapeHtml(err.message)}</div>`;
      setFilesStatus('');
      return;
    }

    const treeEl = document.getElementById('files-tree');
    filesTree = new mar10.Wunderbaum({
      id: 'files-tree',
      element: treeEl,
      iconMap: FILES_ICON_MAP,
      autoCollapse: false,
      rowHeightPx: filesRowHeight(),
      source: rootListing.items.map(filesNodeData),
      // In Wunderbaum 0.14 the `lazyLoad` handler must *return* the child list
      // (calling addChildren here would leave the node in a broken state).
      lazyLoad: async (e) => {
        try {
          return (await filesListing(e.node.data.path)).items.map(filesNodeData);
        } catch (err) {
          showToast(err.message, 'error');
          return false;
        }
      },
      activate: (e) => {
        const { path: nodePath, kind } = e.node.data;
        if (kind === 'dir') {
          state.filesPath = nodePath;
          e.node.setExpanded(!e.node.isExpanded());
        } else {
          openFileEditor(nodePath);
        }
      },
    });

    treeEl.addEventListener('contextmenu', (ev) => {
      const row = ev.target.closest('.wb-row');
      if (!row) return;
      const node = filesNodeFromRow(row);
      if (!node) return;
      ev.preventDefault();
      state.filesPath = node.data.path;
      openContextMenu(row, filesMenuItems(node.data.path, node.data.kind));
    });

    setFilesStatus(`${rootListing.items.length} items at / · click a folder to expand it`);
  }

  async function renderFilesGrid() {
    const body = document.getElementById('files-body');
    body.innerHTML = '<div class="files-empty">Loading…</div>';
    setFilesStatus('Loading…');

    let listing;
    try {
      listing = await filesListing(state.filesPath);
    } catch (err) {
      body.innerHTML = `<div class="files-empty" style="color:var(--danger-color);">${escapeHtml(err.message)}</div>`;
      setFilesStatus('');
      return;
    }

    filesGridItems = listing.items;
    filesGridIndex = -1;
    const touch = filesTouchMode();

    if (!filesGridItems.length) {
      body.innerHTML = '<div class="files-empty">This folder is empty.</div>';
      setFilesStatus('0 items');
      return;
    }

    body.innerHTML = `<div class="files-grid" id="files-grid" tabindex="0" role="listbox" aria-label="Folder contents">${filesGridItems.map(filesTileHtml).join('')}</div>`;
    const grid = body.querySelector('.files-grid');
    if (!grid) return;

    grid.addEventListener('click', (ev) => {
      const tile = ev.target.closest('.files-tile');
      if (!tile) return;
      const idx = Number(tile.getAttribute('data-idx'));
      filesGridSelect(idx, { focus: false });
      if (touch) filesGridOpen(idx); // A single tap opens on touch devices.
    });
    grid.addEventListener('dblclick', (ev) => {
      const tile = ev.target.closest('.files-tile');
      if (!tile || touch) return;
      filesGridOpen(Number(tile.getAttribute('data-idx')));
    });
    grid.addEventListener('contextmenu', (ev) => {
      const tile = ev.target.closest('.files-tile');
      if (!tile) return;
      ev.preventDefault();
      filesGridSelect(Number(tile.getAttribute('data-idx')), { focus: false });
      const item = filesGridItems[filesGridIndex];
      openContextMenu(tile, filesMenuItems(item.path, filesIsDir(item) ? 'dir' : 'file'));
    });
    grid.addEventListener('keydown', onFilesGridKeydown);

    setFilesStatus(`${filesGridItems.length} items · double-click (or press Enter) to open`);
  }

  function filesGridSelect(idx, { focus = true } = {}) {
    const grid = document.getElementById('files-grid');
    if (!grid || idx < 0 || idx >= filesGridItems.length) return;
    filesGridIndex = idx;
    grid.querySelectorAll('.files-tile.is-selected').forEach((el) => {
      el.classList.remove('is-selected');
      el.setAttribute('aria-selected', 'false');
    });
    const tile = grid.querySelector(`.files-tile[data-idx="${idx}"]`);
    if (!tile) return;
    tile.classList.add('is-selected');
    tile.setAttribute('aria-selected', 'true');
    if (focus) {
      if (tile.focus) tile.focus({ preventScroll: true });
      if (tile.scrollIntoView) tile.scrollIntoView({ block: 'nearest' });
    }
    const item = filesGridItems[idx];
    setFilesStatus(`${filesGridItems.length} items · <b>${escapeHtml(item.name)}</b> · ${escapeHtml(filesItemMeta(item))}${filesIsDir(item) ? ' — Enter to open' : ''}`);
  }

  function filesGridOpen(idx) {
    const item = filesGridItems[idx];
    if (!item) return;
    if (filesIsDir(item)) {
      state.filesPath = item.path;
      renderFilesView();
    } else {
      openFileEditor(item.path);
    }
  }

  function filesGridMove(delta) {
    if (!filesGridItems.length) return;
    let idx = filesGridIndex;
    if (idx < 0) idx = delta >= 0 ? 0 : filesGridItems.length - 1;
    else idx = Math.min(filesGridItems.length - 1, Math.max(0, idx + delta));
    filesGridSelect(idx);
  }

  function filesGridColumns() {
    const grid = document.getElementById('files-grid');
    if (!grid) return 1;
    const tiles = grid.querySelectorAll('.files-tile');
    if (!tiles.length) return 1;
    const firstTop = tiles[0].offsetTop;
    let cols = 0;
    for (const t of tiles) {
      if (t.offsetTop === firstTop) cols += 1;
      else break;
    }
    return Math.max(1, cols);
  }

  function filesGridGoUp() {
    if (state.filesPath === '/') return;
    state.filesPath = state.filesPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
    renderFilesView();
  }

  function onFilesGridKeydown(ev) {
    const cols = filesGridColumns();
    let handled = true;
    switch (ev.key) {
      case 'ArrowRight': filesGridMove(1); break;
      case 'ArrowLeft': filesGridMove(-1); break;
      case 'ArrowDown': filesGridMove(cols); break;
      case 'ArrowUp': filesGridMove(-cols); break;
      case 'Home': filesGridSelect(0); break;
      case 'End': filesGridSelect(filesGridItems.length - 1); break;
      case 'Enter': if (filesGridIndex >= 0) filesGridOpen(filesGridIndex); break;
      case 'Backspace': filesGridGoUp(); break;
      case 'Delete': if (filesGridIndex >= 0) removeEntry(filesGridItems[filesGridIndex].path); break;
      case 'F10': {
        if (ev.shiftKey && filesGridIndex >= 0) {
          const grid = document.getElementById('files-grid');
          const tile = grid.querySelector(`.files-tile[data-idx="${filesGridIndex}"]`);
          const item = filesGridItems[filesGridIndex];
          if (tile) openContextMenu(tile, filesMenuItems(item.path, filesIsDir(item) ? 'dir' : 'file'));
        } else handled = false;
        break;
      }
      default: handled = false;
    }
    if (handled) ev.preventDefault();
  }

  async function openFileEditor(filePath) {
    let file;
    try {
      file = (await api(`/api/files/read?path=${encodeURIComponent(filePath)}`)).file;
    } catch (err) {
      showToast(err.message, 'error');
      return;
    }

    const editable = !file.binary && !file.truncated;
    const meta = `${formatBytes(file.size)} · mode ${file.mode}${file.truncated ? ' · showing first 1 MB' : ''}${file.binary ? ' · binary (read-only)' : ''}`;
    const bodyHtml = editable
      ? `<div class="file-editor-meta">${escapeHtml(meta)}</div><textarea id="files-editor" class="file-editor" spellcheck="false">${escapeHtml(file.content)}</textarea>`
      : `<div class="file-editor-meta">${escapeHtml(meta)}</div><pre class="file-editor preview">${escapeHtml(file.binary ? '[binary content]' : file.content)}</pre>`;

    openModal({
      title: filePath,
      confirmText: editable ? 'Save' : 'Close',
      bodyHtml,
      onConfirm: editable ? async () => {
        const value = document.getElementById('files-editor').value;
        await api('/api/files/write', { method: 'PUT', body: { path: filePath, content: value } });
        showToast('File saved.', 'success');
        renderFilesView();
      } : null,
    });
  }

  function promptNewEntry(kind, basePath) {
    const base = basePath || state.filesPath || '/';
    openModal({
      title: kind === 'dir' ? 'New Folder' : 'New File',
      confirmText: 'Create',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Name</label>
          <input type="text" class="form-input" id="files-new-name" placeholder="${kind === 'dir' ? 'folder' : 'file.txt'}">
        </div>
        <p style="font-size:12px;color:var(--text-muted);">Created in <code>${escapeHtml(base)}</code></p>
      `,
      onConfirm: async () => {
        const name = (document.getElementById('files-new-name').value || '').trim();
        if (!name || name.includes('/')) throw new Error('Enter a simple file name (no slashes).');
        const target = base === '/' ? `/${name}` : `${base}/${name}`;
        if (kind === 'dir') {
          await api('/api/files/mkdir', { method: 'POST', body: { path: target } });
        } else {
          await api('/api/files/write', { method: 'PUT', body: { path: target, content: '' } });
        }
        showToast(kind === 'dir' ? 'Folder created.' : 'File created.', 'success');
        renderFilesView();
      },
    });
  }

  function removeEntry(targetPath) {
    openModal({
      title: 'Delete',
      confirmText: 'Delete',
      bodyHtml: `<p>Delete <strong>${escapeHtml(targetPath)}</strong>? This cannot be undone.</p>`,
      onConfirm: async () => {
        await api(`/api/files?path=${encodeURIComponent(targetPath)}`, { method: 'DELETE' });
        showToast('Deleted.', 'success');
        renderFilesView();
      },
    });
  }

  // --- System (host) Terminal View ---
  // Host (non-project) shell, rendered inside the Workspace view when the
  // context selector points at "System".
  async function renderSystemTerminals() {
    const content = document.getElementById('main-content');
    content.style.padding = '0'; // Terminal takes full viewport
    const titleEl = document.getElementById('top-bar-title');
    if (titleEl) titleEl.textContent = 'Workspace — System (host)';

    content.innerHTML = `
      <div class="workspace-container">
        <div class="terminal-tabs-bar" id="sys-terminal-tabs-container">
          <span class="badge badge-muted" id="sys-host-badge" style="margin-right:6px;">Host shell</span>
          <button class="btn btn-secondary btn-sm paste-btn" id="sys-paste-btn" style="margin-left:auto;" title="Paste from clipboard">
            <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>
            <span class="paste-label">Paste</span>
          </button>
          <button class="btn btn-secondary btn-sm copy-mode-btn" id="sys-copy-mode-btn" title="Browse scrollback (tmux copy-mode)" disabled>
            <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            <span class="copy-mode-label">History</span>
          </button>
        </div>
        <div class="terminal-view-wrapper" id="sys-terminal-viewport"></div>
      </div>
    `;

    document.getElementById('sys-copy-mode-btn').onclick = () => {
      toggleCopyMode(() => state.sysTerminals.get(state.activeSysTerminalId), 'sys-copy-mode-btn');
    };
    document.getElementById('sys-paste-btn').onclick = () => {
      pasteIntoTerminal(() => state.sysTerminals.get(state.activeSysTerminalId));
    };

    const viewport = document.getElementById('sys-terminal-viewport');

    try {
      const termRes = await api('/api/terminals?scope=global');
      state.tmuxAvailable = !!termRes.tmuxAvailable;
      const hostBadge = document.getElementById('sys-host-badge');
      if (hostBadge) hostBadge.textContent = termRes.runAsUser ? `Host shell (as ${termRes.runAsUser})` : 'Host shell';

      const alive = (termRes.sessions || []).filter((s) => s.isAlive);

      // Drop client-side terminals whose server session no longer exists.
      for (const [id, item] of state.sysTerminals.entries()) {
        if (!alive.some((s) => s.id === id)) {
          disposeTerminalItem(item);
          state.sysTerminals.delete(id);
        }
      }

      if (alive.length === 0) {
        await spawnSysTerminal();
        return;
      }

      for (const s of alive) {
        if (!state.sysTerminals.has(s.id)) {
          state.sysTerminals.set(s.id, createTerminalItem({
            sessionId: s.id, name: s.name, kind: 'system', viewport,
          }));
        }
      }

      const keepActive = state.activeSysTerminalId && alive.some((s) => s.id === state.activeSysTerminalId);
      const activeId = keepActive ? state.activeSysTerminalId : alive[0].id;
      const activeName = (alive.find((s) => s.id === activeId) || {}).name || 'Terminal';
      await activateSysTerminal(activeId, activeName);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function spawnSysTerminal() {
    try {
      const res = await api('/api/terminals', {
        method: 'POST',
        body: { name: `Host ${state.sysTerminals.size + 1}` },
      });
      await loadSessions();
      await activateSysTerminal(res.session.sessionId, res.session.name);
    } catch (err) {
      showToast(`Failed to create terminal: ${err.message}`, 'error');
    }
  }

  async function activateSysTerminal(sessionId, name = 'Terminal') {
    const viewport = document.getElementById('sys-terminal-viewport');
    if (!viewport) return;

    state.activeSysTerminalId = sessionId;
    saveUiState({ activeSysTerminalId: sessionId });
    let item = state.sysTerminals.get(sessionId);
    if (!item) {
      item = createTerminalItem({
        sessionId, name, kind: 'system', viewport,
      });
      state.sysTerminals.set(sessionId, item);
    }

    mountTerminalItems(viewport, state.sysTerminals, sessionId);
    renderSysTerminalTabs();
    updateCopyModeButton(document.getElementById('sys-copy-mode-btn'), item);
    setTimeout(() => fitTerminalItem(item), 30);
  }

  // Host terminals are listed in the sidebar tree alongside project ones.
  function renderSysTerminalTabs() {
    renderSidebarNav();
  }

  async function closeSysTerminal(sessionId) {
    const item = state.sysTerminals.get(sessionId);
    if (item) {
      disposeTerminalItem(item);
      state.sysTerminals.delete(sessionId);
    }
    await api(`/api/terminals/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    await loadSessions();

    if (state.sysTerminals.size > 0) {
      const nextId = Array.from(state.sysTerminals.keys())[0];
      const nextItem = state.sysTerminals.get(nextId);
      activateSysTerminal(nextId, nextItem.name);
    } else {
      renderSysTerminalTabs();
    }
  }

  // 3. Workspace (system shell or a project's persistent terminals)
  function resolveWorkspaceContext() {
    if (state.workspaceContext === 'system') return 'system';
    if (state.workspaceContext && state.projects.some((p) => p.id === state.workspaceContext)) {
      return state.workspaceContext;
    }
    return null;
  }

  // Open the overview selector (parent "Workspace" click).
  function openWorkspaceOverview() {
    state.workspaceContext = null;
    saveUiState({ workspaceContext: null });
    navigateTo('workspace');
  }

  // Open a workspace section (System or a project) from the sidebar/overview.
  function openWorkspace(context) {
    state.workspaceContext = context;
    state.activeRepoId = null;
    if (!(state.workspaceNavContexts || []).includes(context)) {
      state.workspaceNavContexts = [...(state.workspaceNavContexts || []), context];
    }
    saveUiState({
      workspaceContext: context,
      activeRepoId: null,
      workspaceNavContexts: state.workspaceNavContexts,
    });
    navigateTo('workspace');
  }

  // Close the single terminal owned by a workspace context (from the nav menu).
  async function closeWorkspaceTerminal(context) {
    const session = sessionForContext(context);
    if (!session) return;
    const map = context === 'system' ? state.sysTerminals : state.terminals;
    const item = map.get(session.id);
    if (item) {
      disposeTerminalItem(item);
      map.delete(session.id);
    }
    await api(`/api/terminals/${session.id}`, { method: 'DELETE' }).catch(() => {});
    await loadSessions();
    // If that context is on screen, fall back to the overview so the view does
    // not immediately re-create a shell.
    if (state.currentView === 'workspace' && state.workspaceContext === context) {
      state.workspaceContext = null;
      saveUiState({ workspaceContext: null });
      navigateTo('workspace');
    } else {
      renderSidebarNav();
    }
  }

  async function renderWorkspaceView() {
    await loadProjects();
    const content = document.getElementById('main-content');

    const context = resolveWorkspaceContext();
    state.workspaceContext = context;
    if (context && context !== 'system') state.activeProjectId = context;
    saveUiState({ workspaceContext: context, activeProjectId: state.activeProjectId });
    // Sidebar may have rendered from loadProjects() before the context was set.
    renderSidebarNav();

    const actions = document.getElementById('top-bar-actions');
    if (actions) actions.innerHTML = '';

    if (!context) {
      return renderWorkspaceOverview();
    }

    content.style.padding = '0'; // Terminal takes full viewport
    if (context === 'system') {
      return renderSystemTerminals();
    }

    const currentProject = state.projects.find((p) => p.id === context);
    if (!currentProject) return renderWorkspaceOverview();
    return renderProjectTerminals(currentProject);
  }

  // Landing selector shown when the "Workspace" parent is opened.
  function renderWorkspaceOverview() {
    const content = document.getElementById('main-content');
    content.style.padding = '24px';
    const titleEl = document.getElementById('top-bar-title');
    if (titleEl) titleEl.textContent = 'Workspaces';

    const sysCount = sessionsForContext('system').length;
    content.innerHTML = `
      <div style="margin-bottom:24px;">
        <h2 style="font-size:18px;margin-bottom:6px;">Workspaces</h2>
        <p style="color:var(--text-secondary);font-size:13px;">
          Open the host shell or a project's persistent terminal.
        </p>
      </div>
      <div class="ws-grid">
        ${workspaceCardHtml('system', 'System (host)', 'Host shell', sysCount)}
        ${state.projects.map((p) => workspaceCardHtml(p.id, p.name, p.path, sessionsForContext(p.id).length)).join('')}
      </div>
    `;

    document.querySelectorAll('.ws-open-btn').forEach((btn) => {
      btn.onclick = () => openWorkspace(btn.getAttribute('data-context'));
    });
  }

  function workspaceCardHtml(context, label, subtitle, count) {
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong>${escapeHtml(label)}</strong>
          <span class="badge ${count > 0 ? 'badge-success' : 'badge-muted'}">${count} terminal${count === 1 ? '' : 's'}</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:12px;min-height:16px;word-break:break-all;">${escapeHtml(subtitle || '')}</div>
        <button class="btn btn-primary btn-sm ws-open-btn" data-context="${context}">Open</button>
      </div>
    `;
  }

  async function loadSessions() {
    try {
      const res = await api('/api/terminals');
      state.allSessions = (res.sessions || []).filter((s) => s.isAlive);
      state.tmuxAvailable = !!res.tmuxAvailable;
    } catch {
      // Keep the previous list; the sidebar simply stays as it was.
    }
    renderSidebarNav();
  }


  async function renderProjectTerminals(currentProject) {
    const content = document.getElementById('main-content');
    content.style.padding = '0';
    const titleEl = document.getElementById('top-bar-title');
    if (titleEl) titleEl.textContent = `Workspace — ${currentProject.name}`;

    content.innerHTML = `
      <div class="workspace-container">
        <!-- Toolbar (terminal switching lives in the sidebar) -->
        <div class="terminal-tabs-bar" id="terminal-tabs-container">
          <span class="badge badge-muted ws-context-badge">${escapeHtml(currentProject.name)}</span>
          <button class="btn btn-secondary btn-sm paste-btn" id="ws-paste-btn" style="margin-left:auto;" title="Paste from clipboard">
            <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>
            <span class="paste-label">Paste</span>
          </button>
          <button class="btn btn-secondary btn-sm copy-mode-btn" id="ws-copy-mode-btn" title="Browse scrollback (tmux copy-mode)" disabled>
            <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            <span class="copy-mode-label">History</span>
          </button>
        </div>
        <!-- Terminal Body -->
        <div class="terminal-view-wrapper" id="terminal-viewport"></div>
      </div>
    `;

    document.getElementById('ws-copy-mode-btn').onclick = () => {
      toggleCopyMode(() => state.terminals.get(state.activeTerminalId), 'ws-copy-mode-btn');
    };
    document.getElementById('ws-paste-btn').onclick = () => {
      pasteIntoTerminal(() => state.terminals.get(state.activeTerminalId));
    };

    const viewport = document.getElementById('terminal-viewport');

    // When a project holds several repositories, let the user choose which one
    // new terminals start in (defaults to the most recently selected/primary).
    try {
      const repoRes = await api(`/api/projects/${currentProject.id}/repos`);
      const repos = repoRes.repos || [];
      if (repos.length > 1) {
        if (!state.activeRepoId || !repos.some((r) => r.id === state.activeRepoId)) {
          state.activeRepoId = (repos.find((r) => r.is_primary) || repos[0]).id;
        }
        const container = document.getElementById('terminal-tabs-container');
        const slot = document.createElement('select');
        slot.className = 'form-input ws-repo-selector';
        slot.id = 'ws-repo-selector';
        slot.title = 'New terminals open inside this repository';
        slot.innerHTML = repos.map((r) => `<option value="${r.id}" ${r.id === state.activeRepoId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
        slot.onchange = () => {
          state.activeRepoId = slot.value;
          saveUiState({ activeRepoId: slot.value });
        };
        container.insertBefore(slot, container.firstChild);
      } else {
        state.activeRepoId = repos[0] ? repos[0].id : null;
      }
    } catch {
      // Repositories are best-effort here; terminals still work at project root.
    }

    // Restore all live sessions for this project from the backend (tmux keeps
    // them running server-side), then attach/mount them as tabs.
    try {
      const termRes = await api(`/api/terminals?projectId=${currentProject.id}`);
      state.tmuxAvailable = !!termRes.tmuxAvailable;
      const alive = (termRes.sessions || []).filter((s) => s.isAlive);

      // Drop client-side terminals whose server session no longer exists.
      for (const [id, item] of state.terminals.entries()) {
        if (item.projectId === currentProject.id && !alive.some((s) => s.id === id)) {
          disposeTerminalItem(item);
          state.terminals.delete(id);
        }
      }

      if (alive.length === 0) {
        await spawnNewTerminal(currentProject.id, null, null, state.activeRepoId);
        return;
      }

      for (const s of alive) {
        if (!state.terminals.has(s.id)) {
          state.terminals.set(s.id, createTerminalItem({
            sessionId: s.id, name: s.name, projectId: currentProject.id, viewport,
          }));
        }
      }

      const keepActive = state.activeTerminalId && alive.some((s) => s.id === state.activeTerminalId);
      const activeId = keepActive ? state.activeTerminalId : alive[0].id;
      const activeName = (alive.find((s) => s.id === activeId) || {}).name || 'Terminal';
      await activateTerminalSession(activeId, activeName);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function spawnNewTerminal(projectId, customName = null, agentId = null, repoId = null) {
    try {
      const body = {
        projectId,
        name: customName || `Terminal ${state.terminals.size + 1}`,
      };
      if (repoId) body.repoId = repoId;
      const res = await api('/api/terminals', { method: 'POST', body });
      await loadSessions();
      await activateTerminalSession(res.session.sessionId, res.session.name);
    } catch (err) {
      showToast(`Failed to create terminal: ${err.message}`, 'error');
    }
  }

  async function activateTerminalSession(sessionId, name = 'Terminal') {
    const viewport = document.getElementById('terminal-viewport');
    if (!viewport) return;

    state.activeTerminalId = sessionId;
    saveUiState({ activeTerminalId: sessionId });
    let item = state.terminals.get(sessionId);
    if (!item) {
      item = createTerminalItem({
        sessionId, name, projectId: state.activeProjectId, viewport,
      });
      state.terminals.set(sessionId, item);
    }

    mountTerminalItems(viewport, state.terminals, sessionId, (it) => it.projectId === state.activeProjectId);
    renderTerminalTabs();
    updateCopyModeButton(document.getElementById('ws-copy-mode-btn'), item);
    setTimeout(() => fitTerminalItem(item), 30);
  }

  // Terminals are listed in the sidebar tree, so switching/highlighting is
  // handled there. Kept as a function so existing call sites stay valid.
  function renderTerminalTabs() {
    renderSidebarNav();
  }

  async function closeTerminalSession(sessionId) {
    const item = state.terminals.get(sessionId);
    if (item) {
      disposeTerminalItem(item);
      state.terminals.delete(sessionId);
    }

    // Tell backend to kill PTY / tmux (even if this client never attached it).
    await api(`/api/terminals/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    await loadSessions();

    const remaining = Array.from(state.terminals.entries())
      .filter(([, it]) => it.projectId === state.activeProjectId);

    if (remaining.length > 0) {
      const [nextId, nextItem] = remaining[0];
      activateTerminalSession(nextId, nextItem.name);
    } else {
      renderTerminalTabs();
    }
  }

  function enableTouchScroll(element, term, getItem) {
    let lastY = null;
    let residual = 0;
    const cellHeight = () => term._core?._renderService?.dimensions?.css?.cell?.height || 17;

    element.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) {
        lastY = null;
        return;
      }
      lastY = e.touches[0].clientY;
      residual = 0;
    }, { passive: true });

    element.addEventListener('touchmove', (e) => {
      if (lastY === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      residual += lastY - y;
      lastY = y;
      const rowHeight = cellHeight();
      const lines = Math.trunc(residual / rowHeight);
      const item = getItem ? getItem() : null;
      const wsOpen = !!(item && item.ws && item.ws.readyState === WebSocket.OPEN);
      const useTmux = !!(wsOpen && state.tmuxAvailable);
      if (lines !== 0) {
        residual -= lines * rowHeight;
        if (item && item.copyMode && wsOpen) {
          // Explicit tmux copy-mode: arrow keys move the viewport.
          const seq = lines > 0 ? '\x1b[B' : '\x1b[A';
          item.ws.send(JSON.stringify({ type: 'input', data: seq.repeat(Math.min(Math.abs(lines), 40)) }));
        } else if (useTmux) {
          // Everything runs inside tmux: xterm has no scrollback of its own, so
          // scrollLines() is a no-op. Synthesize SGR mouse-wheel events (64 =
          // up, 65 = down) at the finger position. tmux (mouse on) turns these
          // into copy-mode scrolling for shells, or forwards them to the app
          // for full-screen TUIs (opencode, vim, less…).
          const dims = term._core?._renderService?.dimensions?.css?.cell;
          const cw = dims?.width || 8;
          const chh = dims?.height || 17;
          const rect = element.getBoundingClientRect();
          const t = e.touches[0];
          const col = Math.max(1, Math.min(term.cols, Math.floor((t.clientX - rect.left) / cw) + 1));
          const row = Math.max(1, Math.min(term.rows, Math.floor((t.clientY - rect.top) / chh) + 1));
          const button = lines > 0 ? 65 : 64;
          const seq = `\x1b[<${button};${col};${row}M`.repeat(Math.min(Math.abs(lines), 25));
          item.ws.send(JSON.stringify({ type: 'input', data: seq }));
        } else {
          term.scrollLines(lines);
        }
      }
      e.preventDefault();
    }, { passive: false });

    const reset = () => {
      lastY = null;
      residual = 0;
    };
    element.addEventListener('touchend', reset);
    element.addEventListener('touchcancel', reset);
  }

  function updateCopyModeButton(buttonEl, item) {
    if (!buttonEl) return;
    const active = !!(item && item.copyMode);
    buttonEl.classList.toggle('active', active);
    buttonEl.disabled = !state.tmuxAvailable;
    const label = buttonEl.querySelector('.copy-mode-label');
    if (label) label.textContent = active ? 'Exit history' : 'History';
  }

  async function toggleCopyMode(getItem, buttonId) {
    const item = getItem ? getItem() : null;
    if (!item) return;
    const buttonEl = document.getElementById(buttonId);

    if (item.copyMode) {
      item.copyMode = false;
      updateCopyModeButton(buttonEl, item);
      item.term.focus();
      await api(`/api/terminals/${item.sessionId}/copy-mode`, {
        method: 'POST',
        body: { action: 'exit' },
      }).catch(() => {});
      showToast('History scroll off.', 'info');
      return;
    }

    try {
      await api(`/api/terminals/${item.sessionId}/copy-mode`, {
        method: 'POST',
        body: { action: 'enter' },
      });
      item.copyMode = true;
      updateCopyModeButton(buttonEl, item);
      showToast('History scroll on. Swipe up/down to browse output.', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // Paste button for the terminal toolbars. Long-press paste inside xterm is
  // unreliable on mobile browsers, and the async Clipboard API is blocked on
  // non-secure (plain HTTP) origins. Try the Clipboard API first, and when it is
  // unavailable fall back to a modal textarea where the user can paste manually.
  // Both paths deliver the text through term.paste() so bracketed paste mode
  // (used by full-screen TUIs like opencode) is honored.
  async function pasteIntoTerminal(getItem) {
    const item = getItem ? getItem() : null;
    if (!item || item.disposed) return;

    let text = null;
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch {
      text = null;
    }

    if (text !== null) {
      if (text === '') {
        showToast('Clipboard is empty.', 'info');
        return;
      }
      item.term.paste(text);
      return;
    }

    openModal({
      title: 'Paste into terminal',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label" for="terminal-paste-input">Long-press the box below and choose Paste</label>
          <textarea id="terminal-paste-input" class="form-input" rows="5" spellcheck="false" placeholder="Paste here..."></textarea>
        </div>
      `,
      confirmText: 'Send to terminal',
      onConfirm: async () => {
        const el = document.getElementById('terminal-paste-input');
        const value = el ? el.value : '';
        if (value && !item.disposed) item.term.paste(value);
      },
    });

    const input = document.getElementById('terminal-paste-input');
    if (input) input.focus();
  }

  // 4b. Fleet — manage and control remote Citadel instances
  async function renderFleetView() {
    const content = document.getElementById('main-content');
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="fleet-check-all-btn">Check All</button>
      <button class="btn btn-secondary btn-sm" id="fleet-update-all-btn">Update All</button>
      <button class="btn btn-primary btn-sm" id="fleet-add-btn">+ Add Host</button>`;
    document.getElementById('fleet-add-btn').onclick = () => showFleetHostModal();
    document.getElementById('fleet-check-all-btn').onclick = () => fleetCheckAll();
    document.getElementById('fleet-update-all-btn').onclick = () => fleetUpdateAll();

    content.innerHTML = '<div style="color:var(--text-secondary);">Loading fleet...</div>';
    await loadFleetHosts();
    renderFleetHosts(content);
    if (state.fleetHosts.length > 0) fleetCheckAll(true);
  }

  async function loadFleetHosts() {
    try {
      const res = await api('/api/fleet/hosts');
      state.fleetHosts = res.hosts || [];
    } catch (err) {
      state.fleetHosts = [];
      showToast(`Failed to load fleet: ${err.message}`, 'error');
    }
  }

  // One request fans out a status probe to every host; store the outcome so all
  // views (Fleet and Dashboard) render the same aggregate state.
  function applyFleetOverview(hosts) {
    hosts.forEach((h) => {
      if (h.online) {
        state.fleetStatus[h.id] = {
          version: h.version,
          commit: h.commit,
          updateAvailable: Boolean(h.updateAvailable),
          latest: h.latest,
          agentsInstalled: h.agentsInstalled,
          agentsTotal: h.agentsTotal,
        };
      } else {
        state.fleetStatus[h.id] = { error: h.error || 'Unreachable' };
      }
    });
  }

  async function fleetCheckAll(quiet = false) {
    if (state.fleetHosts.length === 0) return;
    const btn = document.getElementById('fleet-check-all-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const res = await api('/api/fleet/overview');
      const hosts = res.hosts || [];
      applyFleetOverview(hosts);
      if (!quiet) {
        const online = hosts.filter((h) => h.online).length;
        showToast(`Checked ${hosts.length} host(s): ${online} online.`, 'info');
      }
    } catch (err) {
      showToast(`Check all failed: ${err.message}`, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Check All'; }
    }
    renderFleetHosts(document.getElementById('main-content'));
  }

  function fleetUpdateAll() {
    if (state.fleetHosts.length === 0) return;
    openModal({
      title: 'Update all hosts',
      bodyHtml: `<p>Trigger the self-updater on <strong>${state.fleetHosts.length}</strong> host(s) at once?</p>`,
      confirmText: 'Update All',
      onConfirm: async () => {
        try {
          const res = await api('/api/fleet/update-all', { method: 'POST' });
          const results = res.results || [];
          const ok = results.filter((r) => r.ok).length;
          results.filter((r) => !r.ok).forEach((r) => showToast(`${r.name}: ${r.error}`, 'error'));
          showToast(`Update triggered on ${ok}/${results.length} host(s).`, ok === results.length ? 'success' : 'warning');
        } catch (err) {
          showToast(`Update all failed: ${err.message}`, 'error');
        }
      },
    });
  }

  function fleetHostName(hostId) {
    const h = state.fleetHosts.find((x) => x.id === hostId);
    return h ? h.name : hostId;
  }

  function fleetStatusBadge(hostId) {
    const st = state.fleetStatus[hostId];
    if (!st) return '<span class="badge badge-muted">Unknown</span>';
    if (st.error) return `<span class="badge badge-danger" title="${escapeHtml(st.error)}">Offline</span>`;
    const upd = st.updateAvailable
      ? ` <span class="badge badge-warning" title="Newer commit ${escapeHtml(st.latest || '')} available">Update available</span>`
      : '';
    return `<span class="badge badge-success">Online · v${escapeHtml(st.version || '?')}</span>${upd}`;
  }

  function renderFleetHosts(content) {
    if (state.fleetHosts.length === 0) {
      content.innerHTML = `
        <div style="text-align:center;padding:40px;">
          <h3>No remote hosts yet</h3>
          <p style="color:var(--text-secondary);">Add another Citadel instance (base URL + a session token) to manage it from here.</p>
          <button class="btn btn-primary" id="fleet-empty-add" style="margin-top:16px;">+ Add Host</button>
        </div>`;
      document.getElementById('fleet-empty-add').onclick = () => showFleetHostModal();
      return;
    }

    content.innerHTML = `
      <p style="color:var(--text-secondary);margin-bottom:20px;">
        Check status, list/install AI agents and trigger updates on other Citadel panels. Tokens are stored encrypted on this host only.
      </p>
      <div class="grid-cards">
        ${state.fleetHosts.map((h) => {
          const agents = state.fleetAgents[h.id];
          const st = state.fleetStatus[h.id];
          return `
            <div class="card">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <h3 style="font-size:16px;font-weight:600;">${escapeHtml(h.name)}</h3>
                ${fleetStatusBadge(h.id)}
              </div>
              <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-bottom:14px;">${escapeHtml(h.baseUrl)}</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
                <button class="btn btn-secondary btn-sm" data-fleet-action="status" data-host-id="${h.id}">Check</button>
                <button class="btn btn-secondary btn-sm" data-fleet-action="agents" data-host-id="${h.id}">Agents</button>
                <button class="btn btn-secondary btn-sm" data-fleet-action="update" data-host-id="${h.id}">Update Citadel</button>
                <button class="btn btn-secondary btn-sm" data-fleet-action="edit" data-host-id="${h.id}">Edit</button>
                <button class="btn btn-secondary btn-sm" data-fleet-action="remove" data-host-id="${h.id}">Remove</button>
              </div>
              ${st && !st.error && st.commit ? `<div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-bottom:10px;">commit ${escapeHtml(st.commit)}</div>` : ''}
              ${agents ? renderFleetAgents(h.id, agents) : (st && !st.error && typeof st.agentsTotal === 'number' ? `<div style="font-size:12px;color:var(--text-muted);">${st.agentsInstalled}/${st.agentsTotal} agents installed</div>` : '')}
            </div>`;
        }).join('')}
      </div>
    `;

    content.querySelectorAll('[data-fleet-action]').forEach((btn) => {
      const hostId = btn.getAttribute('data-host-id');
      const action = btn.getAttribute('data-fleet-action');
      btn.onclick = () => {
        if (action === 'status') return fleetCheck(hostId);
        if (action === 'agents') return fleetLoadAgents(hostId);
        if (action === 'update') return fleetUpdate(hostId);
        if (action === 'edit') return showFleetHostModal(hostId);
        if (action === 'remove') return fleetRemove(hostId);
      };
    });

    content.querySelectorAll('[data-fleet-install]').forEach((btn) => {
      btn.onclick = () => fleetInstallAgent(btn.getAttribute('data-host-id'), btn.getAttribute('data-fleet-install'));
    });
  }

  function renderFleetAgents(hostId, agents) {
    if (agents.length === 0) {
      return '<div style="color:var(--text-muted);font-size:12px;">No agents reported.</div>';
    }
    return `
      <div style="border-top:1px solid var(--border-color);padding-top:10px;">
        ${agents.map((a) => `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;">
            <span style="font-size:13px;">${escapeHtml(a.name)}
              <span class="badge ${a.installed ? 'badge-success' : 'badge-muted'}" style="margin-left:6px;">${a.installed ? 'Installed' : 'Missing'}</span>
            </span>
            ${a.installed ? '' : (a.installCommand
              ? `<button class="btn btn-primary btn-sm" data-fleet-install="${a.id}" data-host-id="${hostId}">Install</button>`
              : '')}
          </div>
        `).join('')}
      </div>`;
  }

  // Dashboard widget: a compact per-device row, refreshed from one overview call.
  async function refreshDashboardFleet(notify = false) {
    const body = document.getElementById('dash-fleet-body');
    if (!body) return;
    if (state.fleetHosts.length === 0) await loadFleetHosts();
    if (state.fleetHosts.length === 0) {
      const summary = document.getElementById('dash-fleet-summary');
      if (summary) summary.textContent = 'No remote hosts configured';
      body.innerHTML = `<div style="color:var(--text-muted);font-size:13px;">No remote hosts yet. <a href="#" id="dash-fleet-goto" style="color:var(--accent-color);">Add one in Fleet</a> to control multiple devices from here.</div>`;
      document.getElementById('dash-fleet-goto')?.addEventListener('click', (e) => { e.preventDefault(); navigateTo('fleet'); });
      return;
    }
    body.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Checking hosts…</div>';
    try {
      const res = await api('/api/fleet/overview');
      const hosts = res.hosts || [];
      applyFleetOverview(hosts);
      renderDashboardFleetRows(hosts);
      if (notify) {
        const online = hosts.filter((h) => h.online).length;
        showToast(`Checked ${hosts.length} host(s): ${online} online.`, 'info');
      }
    } catch (err) {
      body.innerHTML = `<div style="color:var(--danger-color);font-size:13px;">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderDashboardFleetRows(hosts) {
    const body = document.getElementById('dash-fleet-body');
    const summary = document.getElementById('dash-fleet-summary');
    if (!body) return;
    const online = hosts.filter((h) => h.online).length;
    const updates = hosts.filter((h) => h.updateAvailable).length;
    if (summary) summary.textContent = `${online}/${hosts.length} online${updates ? ` · ${updates} update(s) available` : ''}`;
    body.innerHTML = hosts.map((h) => {
      const status = h.online
        ? `<span class="badge badge-success">Online · v${escapeHtml(h.version || '?')}</span>${h.updateAvailable ? ' <span class="badge badge-warning">Update</span>' : ''}`
        : `<span class="badge badge-danger" title="${escapeHtml(h.error || '')}">Offline</span>`;
      const meta = h.online
        ? `${h.agentsInstalled ?? 0}/${h.agentsTotal ?? 0} agents${h.commit ? ` · ${escapeHtml(String(h.commit).slice(0, 7))}` : ''}`
        : escapeHtml(h.error || '');
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;background:var(--bg-tertiary);border-radius:6px;margin-bottom:8px;">
          <div style="min-width:0;">
            <strong style="color:var(--accent-color);">${escapeHtml(h.name)}</strong>
            <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(h.baseUrl)}</div>
            <div style="font-size:11px;color:var(--text-secondary);">${meta}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            ${status}
            <button class="btn btn-secondary btn-sm dash-fleet-manage">Manage</button>
          </div>
        </div>`;
    }).join('');
    body.querySelectorAll('.dash-fleet-manage').forEach((btn) => {
      btn.onclick = () => navigateTo('fleet');
    });
  }

  async function fleetCheck(hostId) {
    try {
      const res = await api(`/api/fleet/hosts/${hostId}/status`);
      const v = res.version || {};
      state.fleetStatus[hostId] = { version: v.version, commit: v.commit };
      showToast(`${fleetHostName(hostId)}: online (v${v.version || '?'})`, 'success');
    } catch (err) {
      state.fleetStatus[hostId] = { error: err.message };
      showToast(`${fleetHostName(hostId)}: ${err.message}`, 'error');
    }
    renderFleetHosts(document.getElementById('main-content'));
  }

  async function fleetLoadAgents(hostId) {
    try {
      const res = await api(`/api/fleet/hosts/${hostId}/agents`);
      state.fleetAgents[hostId] = res.agents || [];
      showToast(`${fleetHostName(hostId)}: ${state.fleetAgents[hostId].length} agents detected.`, 'info');
    } catch (err) {
      showToast(`Agents failed: ${err.message}`, 'error');
    }
    renderFleetHosts(document.getElementById('main-content'));
  }

  async function fleetInstallAgent(hostId, agentId) {
    try {
      await api(`/api/fleet/hosts/${hostId}/agents/install`, { method: 'POST', body: { agentId } });
      showToast(`Installing ${agentId} on ${fleetHostName(hostId)}… watch its System Terminal there.`, 'success');
      await fleetLoadAgents(hostId);
    } catch (err) {
      showToast(`Install failed: ${err.message}`, 'error');
    }
  }

  async function fleetUpdate(hostId) {
    try {
      await api(`/api/fleet/hosts/${hostId}/update`, { method: 'POST' });
      showToast(`Update started on ${fleetHostName(hostId)}.`, 'success');
    } catch (err) {
      showToast(`Update failed: ${err.message}`, 'error');
    }
  }

  function fleetRemove(hostId) {
    const host = state.fleetHosts.find((h) => h.id === hostId) || {};
    openModal({
      title: 'Remove host',
      bodyHtml: `<p>Remove <strong>${escapeHtml(host.name || '')}</strong> from the fleet? The remote host is not affected.</p>`,
      confirmText: 'Remove',
      onConfirm: async () => {
        await api(`/api/fleet/hosts/${hostId}`, { method: 'DELETE' });
        delete state.fleetAgents[hostId];
        delete state.fleetStatus[hostId];
        await loadFleetHosts();
        renderFleetHosts(document.getElementById('main-content'));
        showToast('Host removed.', 'success');
      },
    });
  }

  function showFleetHostModal(hostId = null) {
    const host = hostId ? state.fleetHosts.find((h) => h.id === hostId) : null;
    openModal({
      title: host ? 'Edit remote host' : 'Add remote host',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Name</label>
          <input class="form-input" id="fleet-name" value="${host ? escapeHtml(host.name) : ''}" placeholder="vps-2" />
        </div>
        <div class="form-group">
          <label class="form-label">Base URL</label>
          <input class="form-input" id="fleet-url" value="${host ? escapeHtml(host.baseUrl) : ''}" placeholder="https://vps2.example.com" />
        </div>
        <div class="form-group">
          <label class="form-label">Access token ${host ? '(leave empty to keep current)' : ''}</label>
          <input class="form-input" id="fleet-token" type="password" autocomplete="off" placeholder="remote session id" />
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
            On the remote host, copy the <code>session_id</code> cookie after logging in (or use an admin token). Stored encrypted on this host.
          </div>
        </div>
      `,
      confirmText: host ? 'Save' : 'Add Host',
      onConfirm: async () => {
        const name = document.getElementById('fleet-name').value.trim();
        const baseUrl = document.getElementById('fleet-url').value.trim();
        const token = document.getElementById('fleet-token').value.trim();
        if (host) {
          const body = { name, baseUrl };
          if (token) body.token = token;
          await api(`/api/fleet/hosts/${host.id}`, { method: 'PUT', body });
        } else {
          await api('/api/fleet/hosts', { method: 'POST', body: { name, baseUrl, token } });
        }
        await loadFleetHosts();
        renderFleetHosts(document.getElementById('main-content'));
        showToast(host ? 'Host updated.' : 'Host added.', 'success');
      },
    });
  }

  // 4c. Logs & Metrics — observability (event trace + resource samples)
  // Activity view: operational activity (events/logs) + the audit trail.
  // Wire any "Open Activity" / "Open Audit" buttons to the Activity view.
  function bindActivityButtons(root = document) {
    root.querySelectorAll('.open-activity-btn').forEach((btn) => {
      btn.onclick = () => {
        state.activityTab = btn.getAttribute('data-activity-tab') === 'audit' ? 'audit' : 'activity';
        saveUiState({ activityTab: state.activityTab });
        navigateTo('activity');
      };
    });
  }

  async function renderActivityView() {
    const content = document.getElementById('main-content');
    const actions = document.getElementById('top-bar-actions');
    const tab = state.activityTab === 'audit' ? 'audit' : 'activity';

    actions.innerHTML = `
      <div class="segmented" role="tablist">
        <button class="seg-btn ${tab === 'activity' ? 'active' : ''}" data-activity-tab="activity" role="tab">Activity</button>
        <button class="seg-btn ${tab === 'audit' ? 'active' : ''}" data-activity-tab="audit" role="tab">Audit</button>
      </div>
      <button class="btn btn-secondary btn-sm" id="logs-export-json">Export JSON</button>
      <button class="btn btn-secondary btn-sm" id="logs-export-csv">Export CSV</button>
      <button class="btn btn-secondary btn-sm" id="logs-refresh">Refresh</button>`;

    document.querySelectorAll('[data-activity-tab]').forEach((btn) => {
      btn.onclick = () => {
        state.activityTab = btn.getAttribute('data-activity-tab');
        saveUiState({ activityTab: state.activityTab });
        renderActivityView();
      };
    });
    document.getElementById('logs-export-json').onclick = () => exportLogs('json');
    document.getElementById('logs-export-csv').onclick = () => exportLogs('csv');
    document.getElementById('logs-refresh').onclick = () => (tab === 'audit' ? refreshAudit() : refreshLogs());

    content.innerHTML = `<div style="color:var(--text-secondary);">Loading ${tab === 'audit' ? 'audit trail' : 'activity'}…</div>`;
    if (tab === 'audit') {
      await refreshAudit();
    } else {
      await refreshLogs();
    }
  }

  async function refreshAudit() {
    const content = document.getElementById('main-content');
    if (!content) return;
    try {
      const res = await api('/api/audit?limit=100');
      state.auditLogs = res.logs || [];
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Failed to load audit logs: ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderAuditContent();
  }

  function renderAuditContent() {
    const content = document.getElementById('main-content');
    const logs = state.auditLogs || [];
    content.innerHTML = `
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <h3 style="font-size:14px;font-weight:600;">Audit trail</h3>
          <span style="font-size:12px;color:var(--text-muted);">${logs.length} recent events</span>
        </div>
        <div class="table-container">
          <table class="data-table">
            <thead><tr>
              <th style="width:150px;">Time</th><th style="width:120px;">User</th>
              <th style="width:160px;">Action</th><th style="width:150px;">Target</th>
              <th>Details</th><th style="width:130px;">IP</th>
            </tr></thead>
            <tbody>
              ${logs.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No audit events recorded</td></tr>' : logs.map((l) => `
                <tr>
                  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);">${escapeHtml(new Date(l.created_at).toLocaleString())}</td>
                  <td>${escapeHtml(l.user_id || 'system')}</td>
                  <td><span class="badge badge-muted">${escapeHtml(l.action)}</span></td>
                  <td style="font-size:12px;">${escapeHtml(l.target_type || '—')}${l.target_id ? `: ${escapeHtml(String(l.target_id).slice(0, 12))}` : ''}</td>
                  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(l.details ? JSON.stringify(l.details) : '')}</td>
                  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);">${escapeHtml(l.ip || '—')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function exportLogs(format, type = 'events') {
    const qs = new URLSearchParams({ type, format });
    if (state.logsFilter.level) qs.set('level', state.logsFilter.level);
    if (state.logsFilter.category) qs.set('category', state.logsFilter.category);
    const a = document.createElement('a');
    a.href = `/api/logs/export?${qs.toString()}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function refreshLogs() {
    const content = document.getElementById('main-content');
    if (!content) return;
    const f = state.logsFilter;
    const qs = new URLSearchParams();
    if (f.level) qs.set('level', f.level);
    if (f.category) qs.set('category', f.category);
    qs.set('limit', String(f.limit || 200));
    // Metrics are an optional module; skip them (and never fail the view) when
    // the module is disabled. Events and summary stay available either way.
    const wantMetrics = moduleEnabled('metrics');
    try {
      const [ev, su, me] = await Promise.all([
        api(`/api/logs/events?${qs.toString()}`),
        api('/api/logs/summary'),
        wantMetrics ? api('/api/logs/metrics?limit=120') : Promise.resolve({ metrics: [] }),
      ]);
      state.logsEvents = ev.events || [];
      state.logsMetrics = me.metrics || [];
      state.logsSummary = su.summary || null;
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Failed to load logs: ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderLogsContent();
  }

  function logEventRow(ev) {
    const badge = ev.level === 'error' ? 'badge-danger' : ev.level === 'warn' ? 'badge-warning' : 'badge-muted';
    const time = new Date(ev.ts).toLocaleTimeString();
    return `<tr>
      <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);">${escapeHtml(time)}</td>
      <td><span class="badge ${badge}">${escapeHtml(ev.level)}</span></td>
      <td>${escapeHtml(ev.category || '')}</td>
      <td>${escapeHtml(ev.message || ev.action || '')}</td>
      <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${escapeHtml(ev.node || '—')}</td>
    </tr>`;
  }

  function renderMetricsChart(metrics) {
    if (!metrics.length) return '';
    const w = 600;
    const h = 80;
    const pad = 4;
    const line = (vals, color) => {
      const max = Math.max(...vals, 1);
      const points = vals.map((v, i) => {
        const x = pad + (i / Math.max(vals.length - 1, 1)) * (w - 2 * pad);
        const y = h - pad - (v / max) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${points}" />`;
    };
    const load = line(metrics.map((m) => m.load1 || 0), 'var(--accent-color)');
    const mem = line(metrics.map((m) => m.memUsedPercent || 0), '#f59e0b');
    const last = metrics[metrics.length - 1];
    return `
      <div class="card" style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:12px;">
          <h3 style="font-size:14px;font-weight:600;">Resources</h3>
          <div style="font-size:12px;color:var(--text-muted);">
            <span style="color:var(--accent-color);">load1</span> · <span style="color:#f59e0b;">mem %</span>
            · now: ${last.load1 != null ? last.load1.toFixed(2) : '—'} / ${last.memUsedPercent ?? '—'}%
            · ${metrics.length} samples
          </div>
        </div>
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:90px;background:var(--bg-tertiary);border-radius:6px;">${load}${mem}</svg>
      </div>`;
  }

  function renderSlowTasks(list) {
    if (!list || list.length === 0) return '';
    return `
      <div class="card" style="margin-bottom:24px;">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:14px;">Slowest tasks (24h)</h3>
        <div class="table-container">
          <table class="data-table">
            <thead><tr><th>Task</th><th style="width:120px;">Node</th><th>Command</th><th style="width:100px;">Duration</th></tr></thead>
            <tbody>${list.map((t) => `<tr>
              <td style="font-family:var(--font-mono);font-size:11px;">${escapeHtml(String(t.id).slice(0, 8))}</td>
              <td>${escapeHtml(t.node || '—')}</td>
              <td style="font-family:var(--font-mono);font-size:11px;">${escapeHtml((t.cmd || '').split('/').pop())}</td>
              <td>${t.durationSeconds != null ? `${t.durationSeconds.toFixed(1)}s` : '—'}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }

  function renderLogsContent() {
    const content = document.getElementById('main-content');
    const s = state.logsSummary || {};
    const level = s.eventsByLevel || {};
    const events = state.logsEvents || [];
    const metrics = state.logsMetrics || [];
    const totalEvents = (level.info || 0) + (level.warn || 0) + (level.error || 0) + (level.debug || 0);
    const tasks = s.tasksByStatus || {};

    content.innerHTML = `
      <div class="grid-cards">
        <div class="card">
          <div class="card-title">EVENTS (24h)</div>
          <div class="card-value">${totalEvents}</div>
          <div class="card-subtitle">${level.error || 0} error · ${level.warn || 0} warn</div>
        </div>
        <div class="card">
          <div class="card-title">TASKS</div>
          <div class="card-value">${tasks.running || 0}</div>
          <div class="card-subtitle">${tasks.failed || 0} failed · ${tasks.done || 0} done</div>
        </div>
        <div class="card">
          <div class="card-title">PEAK LOAD / MEM</div>
          <div class="card-value">${s.peakLoad != null ? Number(s.peakLoad).toFixed(2) : '—'}</div>
          <div class="card-subtitle">mem ${s.peakMemPercent != null ? `${s.peakMemPercent}%` : '—'}</div>
        </div>
        <div class="card">
          <div class="card-title">NODES ONLINE</div>
          <div class="card-value">${s.nodesOnline ?? 0}/${s.nodesTotal ?? 0}</div>
          <div class="card-subtitle">${(s.staleNodes || []).length ? `stale: ${escapeHtml(s.staleNodes.join(', '))}` : 'all healthy'}</div>
        </div>
      </div>

      ${moduleEnabled('metrics') ? renderMetricsChart(metrics) : ''}

      <div class="card" style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;">
          <h3 style="font-size:14px;font-weight:600;">Event Timeline</h3>
          <div style="display:flex;gap:8px;">
            <select class="form-input" id="logs-level-filter" style="width:auto;padding:6px 10px;">
              <option value="">All levels</option>
              ${['info', 'warn', 'error', 'debug'].map((l) => `<option value="${l}" ${state.logsFilter.level === l ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <select class="form-input" id="logs-category-filter" style="width:auto;padding:6px 10px;">
              <option value="">All categories</option>
              ${['task', 'node', 'system'].map((c) => `<option value="${c}" ${state.logsFilter.category === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="table-container">
          <table class="data-table">
            <thead><tr><th style="width:100px;">Time</th><th style="width:80px;">Level</th><th style="width:100px;">Category</th><th>Message</th><th style="width:130px;">Node</th></tr></thead>
            <tbody>${events.length ? events.map(logEventRow).join('') : '<tr><td colspan="5" style="color:var(--text-muted);">No events.</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      ${renderSlowTasks(s.slowestTasks)}
    `;

    document.getElementById('logs-level-filter')?.addEventListener('change', (e) => {
      state.logsFilter.level = e.target.value;
      refreshLogs();
    });
    document.getElementById('logs-category-filter')?.addEventListener('change', (e) => {
      state.logsFilter.category = e.target.value;
      refreshLogs();
    });
  }

  // 5. Deployments & Proxy View (Caddy)
  async function renderDeploymentsView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Loading Caddy status...</div>';

    try {
      const [statusRes, depRes] = await Promise.all([
        api('/api/proxy/status'),
        api('/api/proxy/deployments'),
      ]);

      content.innerHTML = `
        <div class="card" style="margin-bottom:24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h3 style="font-size:16px;font-weight:600;">Caddy Proxy Status</h3>
            <span class="badge ${statusRes.available ? 'badge-success' : 'badge-muted'}">
              ${statusRes.available ? 'Active (127.0.0.1:2019)' : 'Unavailable'}
            </span>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">
            ${escapeHtml(statusRes.helpMessage)}
          </p>
          <div>
            <button class="btn btn-primary btn-sm" id="pub-domain-btn" ${!statusRes.available ? 'disabled' : ''}>
              + Publish Domain / Subdomain
            </button>
          </div>
        </div>

        <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">Mapped Domains</h3>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Project</th>
                <th>Target Port</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${(depRes.deployments || []).length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No published domains</td></tr>' : ''}
              ${(depRes.deployments || []).map((d) => `
                <tr>
                  <td data-label="Domain">
                    <a href="https://${escapeHtml(d.domain)}" target="_blank" style="color:var(--accent-color);font-weight:600;">
                      ${escapeHtml(d.domain)}
                    </a>
                  </td>
                  <td data-label="Project">${escapeHtml(d.project_name || 'Unknown')}</td>
                  <td data-label="Target Port" style="font-family:var(--font-mono);">${d.target_port}</td>
                  <td data-label="Status">
                    <span class="badge ${d.status === 'active' ? 'badge-success' : 'badge-warning'}">
                      ${escapeHtml(d.status)}
                    </span>
                  </td>
                  <td data-label="Actions">
                    <button class="btn btn-danger btn-sm unpub-btn" data-domain="${escapeHtml(d.domain)}">Unpublish</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      document.getElementById('pub-domain-btn')?.addEventListener('click', showPublishDomainModal);
      document.querySelectorAll('.unpub-btn').forEach((btn) => {
        btn.onclick = async () => {
          const domain = btn.getAttribute('data-domain');
          await api('/api/proxy/unpublish', { method: 'DELETE', body: { domain } });
          showToast(`Domain ${domain} unpublished.`, 'success');
          renderDeploymentsView();
        };
      });
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  function showPublishDomainModal() {
    openModal({
      title: 'Publish Domain with Automatic HTTPS',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Project</label>
          <select class="form-input" id="m-pub-proj">
            ${state.projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Domain or Subdomain Name (e.g. app.yourdomain.com)</label>
          <input type="text" class="form-input" id="m-pub-domain" placeholder="app.example.com" required>
        </div>
        <div class="form-group">
          <label class="form-label">Project Local Port</label>
          <input type="number" class="form-input" id="m-pub-port" placeholder="3000" min="1" max="65535" required>
        </div>
      `,
      confirmText: 'Publish with Caddy',
      onConfirm: async () => {
        const projectId = document.getElementById('m-pub-proj').value;
        const domain = document.getElementById('m-pub-domain').value;
        const targetPort = parseInt(document.getElementById('m-pub-port').value, 10);
        await api('/api/proxy/publish', {
          method: 'POST',
          body: { projectId, domain, targetPort },
        });
        showToast('Domain published successfully.', 'success');
        renderDeploymentsView();
      },
    });
  }

  // 6. Docker View (Optional)
  async function renderDockerView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Checking Docker socket...</div>';

    try {
      const [statusRes, containersRes] = await Promise.all([
        api('/api/docker/status'),
        api('/api/docker/containers'),
      ]);

      content.innerHTML = `
        <div class="card" style="margin-bottom:24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h3 style="font-size:16px;font-weight:600;">Docker Integration</h3>
            <span class="badge ${statusRes.available ? 'badge-success' : 'badge-muted'}">
              ${statusRes.available ? `v${statusRes.version}` : 'Unavailable'}
            </span>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);">
            ${statusRes.available ? `Connected to Docker Engine ${statusRes.version} (${statusRes.os}/${statusRes.arch})` : escapeHtml(statusRes.message)}
          </p>
        </div>

        <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">Containers on Host</h3>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Image</th>
                <th>State</th>
                <th>Ports</th>
              </tr>
            </thead>
            <tbody>
              ${(containersRes.containers || []).length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No containers available or Docker is inactive</td></tr>' : ''}
              ${(containersRes.containers || []).map((c) => `
                <tr>
                  <td data-label="ID" style="font-family:var(--font-mono);">${escapeHtml(c.id)}</td>
                  <td data-label="Name"><strong>${escapeHtml(c.names.join(', '))}</strong></td>
                  <td data-label="Image" style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(c.image)}</td>
                  <td data-label="State">
                    <span class="badge ${c.state === 'running' ? 'badge-success' : 'badge-muted'}">
                      ${escapeHtml(c.status)}
                    </span>
                  </td>
                  <td data-label="Ports" style="font-size:11px;font-family:var(--font-mono);">
                    ${c.ports.map((p) => `${p.publicPort ? `${p.publicPort}:` : ''}${p.privatePort}/${p.type}`).join(', ')}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Human-readable explanation of where the connect URL came from.
  function connectSourceNote(source) {
    return {
      configured: 'Using the public URL configured in Settings — works from anywhere it points to.',
      tunnel: 'Public Cloudflare Quick Tunnel — works from anywhere. The URL changes when the tunnel restarts.',
      tailscale: 'Reachable from anywhere over your Tailscale network. Install Tailscale on the phone and sign in to the same account.',
      lan: '<span style="color:var(--warning-color);">This is a LAN address — it only works on the same Wi-Fi.</span> For access from anywhere, run <code>citadel tunnel</code> (public, one command) or set up Tailscale (<code>tailscale serve</code>).',
      localhost: '<span style="color:var(--warning-color);">Only reachable on this machine.</span> Run <code>citadel tunnel</code> or set up Tailscale for remote access.',
    }[source] || '';
  }

  // 7. Settings View (host tools: public URL, connection, modules, updates, diagnostics)
  async function renderSettingsView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Loading settings...</div>';

    try {
      const [settingsRes, connectRes, nodeRes, versionRes, secretsRes] = await Promise.all([
        api('/api/settings/connect'),
        api('/api/system/connect'),
        api('/api/system/node'),
        api('/api/system/version'),
        api('/api/secrets'),
      ]);
      await loadModules();
      const s = settingsRes.connect || {};
      const connect = connectRes.connect || {};
      const node = nodeRes.node || {};
      const ver = versionRes.version || {};
      const secretsList = secretsRes.secrets || [];

      content.innerHTML = `
        <div style="margin-bottom:20px;">
          <h2 style="font-size:18px;margin-bottom:6px;">Settings</h2>
          <p style="color:var(--text-secondary);font-size:13px;">
            Configure how this panel is reached from other devices. This only changes the address
            Citadel advertises — it never opens ports or exposes anything by itself.
          </p>
        </div>

        <div class="card" style="margin-bottom:24px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">
            <div>
              <h3 style="font-size:16px;font-weight:600;">Updates</h3>
              <p style="color:var(--text-secondary);font-size:13px;margin-top:6px;">
                Running <strong style="color:var(--accent-color);">v${escapeHtml(ver.version || 'unknown')}</strong>
                ${ver.commit ? `<span style="color:var(--text-muted);">(${escapeHtml(ver.commit)})</span>` : ''}
                ${ver.repo ? `· <code>${escapeHtml(ver.repo)}</code>` : ''}
                ${ver.branch ? `· branch <code>${escapeHtml(ver.branch)}</code>` : ''}
              </p>
              <div id="update-status" style="margin-top:8px;font-size:13px;color:var(--text-muted);">
                ${ver.updateMode === 'helper'
                  ? 'The in-panel updater is enabled.'
                  : ver.updateMode === 'self'
                    ? 'Built-in updater enabled — updates run as the service user, no root helper required.'
                    : `Automatic updates are unavailable (${escapeHtml(ver.updateProblem || 'not configured')}).`}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0;">
              <button class="btn btn-secondary btn-sm" id="check-updates-btn">Check for updates</button>
              ${ver.canUpdate ? '<button class="btn btn-primary btn-sm" id="apply-update-btn">Update now</button>' : ''}
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:24px;">
          <h3 style="font-size:16px;font-weight:600;margin-bottom:14px;">About this host</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:16px;font-size:13px;">
            <div>
              <span style="color:var(--text-muted);">Hostname:</span>
              <strong style="display:block;margin-top:2px;">${escapeHtml(node.hostname || '')}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Operating System:</span>
              <strong style="display:block;margin-top:2px;">${escapeHtml(node.platform || '')} ${escapeHtml(node.release || '')}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Node.js Runtime:</span>
              <strong style="display:block;margin-top:2px;color:var(--accent-color);">${escapeHtml(node.nodeVersion || '')}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Uptime:</span>
              <strong style="display:block;margin-top:2px;">${node.uptimeSeconds ? `${Math.round(node.uptimeSeconds / 3600)} hours` : '—'}</strong>
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:24px;">
          <h3 class="widget-heading">Public URL</h3>
          <p style="color:var(--text-secondary);font-size:13px;margin-top:6px;line-height:1.6;">
            The address you use to reach this panel (your domain or server IP). It feeds the connection
            QR code and is trusted as a WebSocket origin, so terminals work when opened through it.
          </p>
          ${s.envLocked ? `<p class="settings-warn">Fixed by the <code>CITADEL_PUBLIC_URL</code> environment variable (<code>${escapeHtml(s.envPublicUrl)}</code>). Unset it to edit here.</p>` : ''}
          <div class="settings-row">
            <input type="text" id="settings-public-url" class="form-input" placeholder="https://panel.example.com or http://203.0.113.10:3000" value="${escapeHtml(s.publicUrl || '')}" ${s.envLocked ? 'disabled' : ''} />
            <button class="btn btn-primary btn-sm" id="settings-save-url" ${s.envLocked ? 'disabled' : ''}>Save</button>
            <button class="btn btn-secondary btn-sm" id="settings-clear-url" ${(!s.publicUrl || s.envLocked) ? 'disabled' : ''}>Clear</button>
          </div>
          <div style="margin-top:18px;">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Effective address</div>
            <a href="${escapeHtml(connect.url || '#')}" target="_blank" rel="noopener" style="display:inline-block;margin-top:2px;color:var(--accent-color);word-break:break-all;font-family:var(--font-mono);font-size:13px;">${escapeHtml(connect.url || '')}</a>
            <div style="margin-top:8px;font-size:12px;color:var(--text-secondary);line-height:1.5;">${connectSourceNote(connect.source)}</div>
          </div>
        </div>

        <div class="card">
          <h3 class="widget-heading">Connection</h3>
          <p style="color:var(--text-secondary);font-size:13px;margin-top:6px;">
            Scan this code with a phone to open the panel on another device.
          </p>
          <div class="connect-grid">
            <div class="connect-qr">${connect.qrSvg || ''}</div>
            <div style="min-width:0;flex:1;">
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Address</div>
              <a href="${escapeHtml(connect.url || '#')}" target="_blank" rel="noopener" style="display:inline-block;margin-top:2px;color:var(--accent-color);word-break:break-all;font-family:var(--font-mono);font-size:13px;">${escapeHtml(connect.url || '')}</a>
              <div style="margin-top:10px;">
                <button class="btn btn-secondary btn-sm" id="settings-copy-url">Copy link</button>
                <button class="btn btn-secondary btn-sm" id="connect-help-btn">Remote access help</button>
              </div>
            </div>
          </div>
        </div>

        <div style="margin-top:28px;margin-bottom:20px;">
          <h2 style="font-size:18px;margin-bottom:6px;">Credentials</h2>
          <p style="color:var(--text-secondary);font-size:13px;">
            One encrypted vault for everything agents and git need. Environment
            variables are injected into every terminal; agents can read any entry
            with the <code>citadel-creds</code> CLI. Values are never shown again.
          </p>
        </div>

        <div class="card" style="margin-bottom:24px;">
          ${secretsCardHtml(secretsList)}
        </div>

        <div style="margin-top:28px;margin-bottom:20px;">
          <h2 style="font-size:18px;margin-bottom:6px;">Activity &amp; Audit</h2>
          <p style="color:var(--text-secondary);font-size:13px;">
            The live event stream and the security audit trail for this host.
          </p>
        </div>

        <div class="card" style="margin-bottom:24px;">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm open-activity-btn" data-activity-tab="activity">Open Activity</button>
            <button class="btn btn-secondary btn-sm open-activity-btn" data-activity-tab="audit">Open Audit</button>
          </div>
        </div>

        <div style="margin-top:28px;margin-bottom:20px;">
          <h2 style="font-size:18px;margin-bottom:6px;">Optional modules</h2>
          <p style="color:var(--text-secondary);font-size:13px;">
            Enable only what you use. Disabled modules are hidden from navigation and their
            endpoints are locked, but your data is never deleted.
          </p>
        </div>
        ${modulesSectionHtml()}
      `;

      bindModuleToggles(renderSettingsView);
      bindUpdatesCard();
      bindSecretsCard();
      bindActivityButtons();

      const input = document.getElementById('settings-public-url');
      const saveBtn = document.getElementById('settings-save-url');
      const clearBtn = document.getElementById('settings-clear-url');

      const save = async (value) => {
        saveBtn.disabled = true;
        clearBtn.disabled = true;
        try {
          await api('/api/settings/connect', { method: 'PUT', body: { publicUrl: value } });
          showToast('Public URL saved.', 'success');
          renderSettingsView();
        } catch (err) {
          saveBtn.disabled = false;
          clearBtn.disabled = false;
          showToast(err.message, 'error');
        }
      };

      saveBtn.onclick = () => save(input.value);
      clearBtn.onclick = () => save('');
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          save(input.value);
        }
      };

      document.getElementById('settings-copy-url').onclick = async () => {
        try {
          await navigator.clipboard.writeText(connect.url || '');
          showToast('Link copied.', 'success');
        } catch {
          showToast('Could not copy the link.', 'error');
        }
      };

      const connectHelpBtn = document.getElementById('connect-help-btn');
      if (connectHelpBtn) {
        connectHelpBtn.onclick = () => {
          openModal({
            title: 'Access from anywhere',
            confirmText: 'Got it',
            bodyHtml: `
              <p style="font-size:13px;line-height:1.6;color:var(--text-secondary);">
                This address only works on your local network. To reach the panel from any
                network without a domain, use <strong>Tailscale</strong>:
              </p>
              <ol style="font-size:13px;line-height:1.7;color:var(--text-secondary);padding-left:18px;margin-top:10px;">
                <li>Install Tailscale on this host and on your phone, signing in to the same account.</li>
                <li>On the host run: <code>tailscale serve https / http://127.0.0.1:3000</code></li>
                <li>Reload this page — the QR will point to your <code>*.ts.net</code> address and work anywhere.</li>
              </ol>
            `,
          });
        };
      }
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Update controls moved out of the former System view into Settings.
  function bindUpdatesCard() {
    const statusEl = document.getElementById('update-status');
    const checkBtn = document.getElementById('check-updates-btn');
    if (checkBtn) {
      checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        statusEl.style.color = 'var(--text-muted)';
        statusEl.textContent = 'Checking GitHub for the latest release...';
        try {
          const res = await api('/api/system/updates?force=true');
          const u = res.updates || {};
          if (u.error) {
            statusEl.style.color = 'var(--warning-color)';
            statusEl.textContent = `Could not check for updates: ${u.error}`;
          } else if (!u.latest) {
            statusEl.style.color = 'var(--text-muted)';
            statusEl.textContent = 'No published releases or tags found yet.';
          } else if (u.updateAvailable) {
            statusEl.style.color = 'var(--warning-color)';
            const label = (u.latest && u.latest !== u.version)
              ? `v${escapeHtml(u.latest)}`
              : `commit ${escapeHtml(u.latestCommit || u.latest || '')}`;
            statusEl.innerHTML = `Update available: <strong>${label}</strong>${u.releaseUrl ? ` — <a href="${escapeHtml(u.releaseUrl)}" target="_blank" rel="noopener" style="color:var(--accent-color);">view changes</a>` : ''}`;
          } else {
            statusEl.style.color = 'var(--success-color)';
            statusEl.textContent = `You are running the latest version (v${u.version}).`;
          }
        } catch (err) {
          statusEl.style.color = 'var(--danger-color)';
          statusEl.textContent = `Error: ${err.message}`;
        } finally {
          checkBtn.disabled = false;
        }
      };
    }

    const applyBtn = document.getElementById('apply-update-btn');
    if (applyBtn) {
      applyBtn.onclick = async () => {
        if (!confirm('Update Citadel now? The service will restart and brief downtime is expected.')) return;
        applyBtn.disabled = true;
        statusEl.style.color = 'var(--text-muted)';
        statusEl.textContent = 'Starting update...';
        try {
          await api('/api/system/update', { method: 'POST' });
          showToast('Update started. The service will restart shortly.', 'success');
          statusEl.style.color = 'var(--warning-color)';
          statusEl.textContent = 'Update in progress. This page will reload automatically...';
          pollUpdateStatus(statusEl, applyBtn);
        } catch (err) {
          applyBtn.disabled = false;
          statusEl.style.color = 'var(--danger-color)';
          statusEl.textContent = `Error: ${err.message}`;
        }
      };
    }
  }

  // Follow a running update across the service restart, then reload the panel.
  async function pollUpdateStatus(statusEl, applyBtn) {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await api('/api/system/update/status');
        const s = (res.update && res.update.status) || {};
        if (s.state === 'success') {
          statusEl.style.color = 'var(--success-color)';
          statusEl.textContent = `Update complete${s.toCommit ? ` (${String(s.toCommit).slice(0, 7)})` : ''}. Reloading...`;
          setTimeout(() => location.reload(), 2500);
          return;
        }
        if (s.state === 'failed') {
          statusEl.style.color = 'var(--danger-color)';
          statusEl.textContent = `Update failed: ${s.error || 'unknown error'}.`;
          if (applyBtn) applyBtn.disabled = false;
          return;
        }
        statusEl.textContent = s.message || 'Update in progress...';
      } catch {
        statusEl.textContent = 'Service restarting...';
      }
    }
    statusEl.style.color = 'var(--warning-color)';
    statusEl.textContent = 'Update is taking longer than expected. Reload this page shortly.';
    if (applyBtn) applyBtn.disabled = false;
  }

  // Credentials vault card (Settings): add/rotate/delete. Values are write-only.
  function secretsCardHtml(secrets) {
    const rows = secrets.length === 0
      ? '<p style="color:var(--text-secondary);font-size:13px;">No credentials stored yet.</p>'
      : `<div class="secret-list">
          ${secrets.map((sec) => `
            <div class="secret-row">
              <div style="min-width:0;">
                <strong style="font-family:var(--font-mono);font-size:13px;">${escapeHtml(sec.name)}</strong>
                <span class="badge badge-muted" style="margin-left:8px;">${escapeHtml(sec.kind)}</span>
                ${sec.metadata && sec.metadata.provider ? `<span style="margin-left:8px;font-size:12px;color:var(--text-muted);">${escapeHtml(sec.metadata.provider)}</span>` : ''}
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Updated ${escapeHtml(sec.updated_at || '')}</div>
              </div>
              <button class="btn btn-secondary btn-sm secret-delete-btn" data-secret-name="${escapeHtml(sec.name)}">Delete</button>
            </div>`).join('')}
        </div>`;

    return `
      <h3 class="widget-heading">Stored credentials</h3>
      ${rows}
      <div class="settings-row" style="margin-top:16px;flex-wrap:wrap;">
        <input type="text" id="secret-name" class="form-input" placeholder="NAME (e.g. GITHUB_TOKEN, MY_API_KEY)" style="flex:1;min-width:180px;" />
        <select id="secret-kind" class="form-input" style="max-width:120px;">
          <option value="env">env</option>
          <option value="git">git</option>
          <option value="file">file</option>
          <option value="ssh">ssh</option>
        </select>
        <input type="password" id="secret-value" class="form-input" placeholder="Value" style="flex:1;min-width:180px;" autocomplete="new-password" />
        <button class="btn btn-primary btn-sm" id="secret-add-btn">Save</button>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:8px;">
        Agents read these with <code>citadel-creds list | get &lt;name&gt; | env | exec -- &lt;cmd&gt;</code>.
      </p>
    `;
  }

  function bindSecretsCard() {
    const addBtn = document.getElementById('secret-add-btn');
    if (addBtn) {
      const nameInput = document.getElementById('secret-name');
      const valueInput = document.getElementById('secret-value');
      addBtn.onclick = async () => {
        const name = nameInput.value.trim();
        const kind = document.getElementById('secret-kind').value;
        const value = valueInput.value;
        if (!name || !value) {
          showToast('Name and value are required.', 'error');
          return;
        }
        addBtn.disabled = true;
        try {
          await api('/api/secrets', { method: 'POST', body: { name, value, kind } });
          showToast('Credential saved.', 'success');
          renderSettingsView();
        } catch (err) {
          addBtn.disabled = false;
          showToast(err.message, 'error');
        }
      };
      valueInput.onkeydown = (e) => {
        if (e.key === 'Enter') addBtn.onclick();
      };
    }

    document.querySelectorAll('.secret-delete-btn').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api(`/api/secrets/${encodeURIComponent(btn.getAttribute('data-secret-name'))}`, { method: 'DELETE' });
          showToast('Credential deleted.', 'success');
          renderSettingsView();
        } catch (err) {
          btn.disabled = false;
          showToast(err.message, 'error');
        }
      };
    });
  }

  // Modules & Extensions management, rendered inside the Settings screen.
  function modulesSectionHtml() {
    const optional = state.modules.filter((m) => !m.core);
    return `
      <div class="card">
        <div class="module-grid">
          ${optional.map((m) => {
            const blocked = !m.ready && !m.enabled;
            const badge = m.enabled
              ? '<span class="badge badge-success">Enabled</span>'
              : (m.ready ? '<span class="badge badge-muted">Disabled</span>' : '<span class="badge badge-warning">Unavailable</span>');
            return `
              <div class="module-card">
                <div class="module-card-head">
                  <strong>${escapeHtml(m.name)}</strong>
                  ${badge}
                </div>
                <p class="module-desc">${escapeHtml(m.description)}</p>
                ${m.reason && !m.enabled ? `<p class="module-reason">${escapeHtml(m.reason)}</p>` : ''}
                <button class="btn ${m.enabled ? 'btn-secondary' : 'btn-primary'} btn-sm module-toggle-btn"
                  data-module-id="${m.id}" data-enabled="${m.enabled ? '1' : '0'}"
                  ${blocked ? 'disabled' : ''}>
                  ${m.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function bindModuleToggles(rerender) {
    document.querySelectorAll('.module-toggle-btn').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-module-id');
        const target = btn.getAttribute('data-enabled') !== '1';
        btn.disabled = true;
        try {
          await api(`/api/modules/${id}/state`, { method: 'POST', body: { enabled: target } });
          showToast(`Module "${id}" ${target ? 'enabled' : 'disabled'}.`, 'success');
          await loadModules();
          renderSidebarNav();
          rerender();
        } catch (err) {
          btn.disabled = false;
          showToast(err.message, 'error');
        }
      };
    });
  }

  // Run on page load
  document.addEventListener('DOMContentLoaded', init);
})();
