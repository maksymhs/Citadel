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
    projects: [],
    activeProjectId: null,
    agents: [],
    terminals: new Map(), // sessionId -> { session, term, fitAddon, ws, containerEl }
    activeTerminalId: null,
    sysTerminals: new Map(), // host (non-project) terminal sessions
    activeSysTerminalId: null,
    systemInfo: null,
    metrics: null,
    integrations: null,
    deployments: [],
    plugins: [],
    docker: null,
    containers: [],
  };

  // API helper with cookie credentials
  async function api(path, options = {}) {
    const opts = {
      headers: {
        'Content-Type': 'application/json',
      },
      ...options,
    };
    if (opts.body && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
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

  // Generic modal helper
  function openModal({ title, bodyHtml, confirmText = 'Confirm', onConfirm }) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-overlay" id="active-modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">${escapeHtml(title)}</h3>
            <button class="tab-close-btn" id="modal-close-btn">&times;</button>
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
    const close = () => { root.innerHTML = ''; };

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
        renderAppShell();
        navigateTo('dashboard');
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
        renderAppShell();
        navigateTo('dashboard');
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
        renderAppShell();
        navigateTo('dashboard');
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
        <!-- Sidebar Navigation -->
        <aside class="sidebar">
          <div class="sidebar-header">
            <div class="logo-icon">C</div>
            <span class="logo-text">Citadel</span>
            <span class="version-tag">v0.1.0</span>
          </div>
          <nav class="sidebar-nav">
            <div class="nav-section-title">Development</div>
            <a class="nav-item active" data-view="dashboard">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
              <span>Dashboard</span>
            </a>
            <a class="nav-item" data-view="projects">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
              <span>Projects</span>
              <span class="nav-badge" id="nav-projects-count">0</span>
            </a>
            <a class="nav-item" data-view="repos">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
              <span>Repositories</span>
            </a>
            <a class="nav-item" data-view="workspace">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              <span>Workspace & PTY</span>
            </a>
            <a class="nav-item" data-view="terminal">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 9l3 3-3 3m5 0h5"/></svg>
              <span>Terminal</span>
            </a>
            <a class="nav-item" data-view="agents">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              <span>AI Agents</span>
            </a>

            <div class="nav-section-title">Infrastructure</div>
            <a class="nav-item" data-view="deployments">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>
              <span>Proxy & Domains</span>
            </a>
            <a class="nav-item" data-view="docker">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
              <span>Docker (Optional)</span>
            </a>
            <a class="nav-item" data-view="plugins">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/></svg>
              <span>Plugins</span>
            </a>
            <a class="nav-item" data-view="system">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
              <span>System & Audit</span>
            </a>
          </nav>
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
            <div class="top-bar-title" id="top-bar-title">Dashboard</div>
            <div class="top-bar-actions" id="top-bar-actions"></div>
          </header>
          <main class="content-body" id="main-content"></main>
        </div>
      </div>
    `;

    // Bind sidebar clicks
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((item) => {
      item.onclick = (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        navigateTo(view);
      };
    });

    document.getElementById('logout-btn').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      renderLoginView();
    };

    // Load initial data
    loadProjects();
    loadAgents();
  }

  function navigateTo(view) {
    state.currentView = view;
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((item) => {
      if (item.getAttribute('data-view') === view) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    const titleEl = document.getElementById('top-bar-title');
    const actionsEl = document.getElementById('top-bar-actions');
    actionsEl.innerHTML = '';

    if (view === 'dashboard') {
      titleEl.textContent = 'Dashboard';
      renderDashboardView();
    } else if (view === 'projects') {
      titleEl.textContent = 'Project Management';
      renderProjectsView();
    } else if (view === 'repos') {
      titleEl.textContent = 'Git Repositories';
      renderReposView();
    } else if (view === 'workspace') {
      titleEl.textContent = 'Workspace & Persistent Terminals';
      renderWorkspaceView();
    } else if (view === 'terminal') {
      titleEl.textContent = 'System Terminal';
      renderTerminalView();
    } else if (view === 'agents') {
      titleEl.textContent = 'AI Agent Launcher';
      renderAgentsView();
    } else if (view === 'deployments') {
      titleEl.textContent = 'Proxy & Domain Publishing';
      renderDeploymentsView();
    } else if (view === 'docker') {
      titleEl.textContent = 'Docker Monitor';
      renderDockerView();
    } else if (view === 'plugins') {
      titleEl.textContent = 'Extensions & Plugins';
      renderPluginsView();
    } else if (view === 'system') {
      titleEl.textContent = 'System Diagnostics & Audit';
      renderSystemView();
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
    } catch (err) {
      console.warn('Error loading projects:', err.message);
    }
  }

  async function loadAgents() {
    try {
      const res = await api('/api/agents');
      state.agents = res.agents || [];
    } catch (err) {
      console.warn('Error loading agents:', err.message);
    }
  }

  // --- Views Implementation ---

  // 1. Dashboard View
  async function renderDashboardView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Loading system metrics...</div>';

    try {
      const [nodeRes, metricsRes, integRes] = await Promise.all([
        api('/api/system/node'),
        api('/api/system/metrics'),
        api('/api/system/integrations'),
      ]);

      const node = nodeRes.node;
      const metrics = metricsRes.metrics;
      const integ = integRes.integrations;

      content.innerHTML = `
        <div class="grid-cards">
          <div class="card">
            <div class="card-title">MEMORY USAGE</div>
            <div class="card-value">${metrics.memoryUsedPercent}%</div>
            <div class="card-subtitle">${Math.round(node.memory.usedBytes / 1024 / 1024)} MB of ${Math.round(node.memory.totalBytes / 1024 / 1024)} MB</div>
          </div>
          <div class="card">
            <div class="card-title">CPU LOAD (1m)</div>
            <div class="card-value">${metrics.loadAvg.toFixed(2)}</div>
            <div class="card-subtitle">${node.cpu.cores} cores (${node.cpu.model.split('@')[0].trim()})</div>
          </div>
          <div class="card">
            <div class="card-title">ACTIVE PROJECTS</div>
            <div class="card-value">${state.projects.length}</div>
            <div class="card-subtitle">${node.stats.activeSessions} persistent terminals</div>
          </div>
          <div class="card">
            <div class="card-title">VPS HOST</div>
            <div class="card-value" style="font-size:18px;">${escapeHtml(node.hostname)}</div>
            <div class="card-subtitle">${escapeHtml(node.platform)} ${escapeHtml(node.release)} (${node.arch})</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;">
          <!-- Integrations status -->
          <div class="card">
            <h3 style="font-size:14px;font-weight:600;margin-bottom:14px;">Platform Integrations</h3>
            <div style="display:flex;flex-direction:column;gap:12px;">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <strong>tmux (PTY Persistence)</strong>
                  <div style="font-size:12px;color:var(--text-secondary);">${integ.tmux.description}</div>
                </div>
                <span class="badge ${integ.tmux.available ? 'badge-success' : 'badge-warning'}">
                  ${integ.tmux.available ? 'Available' : 'No tmux'}
                </span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <strong>Git CLI</strong>
                  <div style="font-size:12px;color:var(--text-secondary);">${integ.git.description}</div>
                </div>
                <span class="badge ${integ.git.available ? 'badge-success' : 'badge-danger'}">
                  ${integ.git.available ? 'Active' : 'Missing'}
                </span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <strong>Caddy Proxy (HTTPS)</strong>
                  <div style="font-size:12px;color:var(--text-secondary);">${integ.caddy.helpMessage}</div>
                </div>
                <span class="badge ${integ.caddy.available ? 'badge-success' : 'badge-muted'}">
                  ${integ.caddy.available ? 'Connected' : 'Optional / Inactive'}
                </span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <strong>Docker Engine</strong>
                  <div style="font-size:12px;color:var(--text-secondary);">${integ.docker.available ? 'Socket connected' : 'Disabled / Optional'}</div>
                </div>
                <span class="badge ${integ.docker.available ? 'badge-success' : 'badge-muted'}">
                  ${integ.docker.available ? 'Active' : 'Optional'}
                </span>
              </div>
            </div>
          </div>

          <!-- Quick Actions & Projects -->
          <div class="card">
            <h3 style="font-size:14px;font-weight:600;margin-bottom:14px;">Quick Project Access</h3>
            <div style="display:flex;gap:10px;margin-bottom:16px;">
              <button class="btn btn-primary btn-sm" id="dash-new-project-btn">+ New Project</button>
              <button class="btn btn-secondary btn-sm" id="dash-clone-btn">Clone Git</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${state.projects.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">No projects registered yet.</div>' : ''}
              ${state.projects.slice(0, 5).map((p) => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-tertiary);border-radius:6px;">
                  <div>
                    <strong style="color:var(--accent-color);">${escapeHtml(p.name)}</strong>
                    <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${escapeHtml(p.path)}</div>
                  </div>
                  <button class="btn btn-secondary btn-sm open-workspace-btn" data-project-id="${p.id}">Open Terminal</button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;

      document.getElementById('dash-new-project-btn')?.addEventListener('click', showCreateProjectModal);
      document.getElementById('dash-clone-btn')?.addEventListener('click', showCloneProjectModal);

      document.querySelectorAll('.open-workspace-btn').forEach((btn) => {
        btn.onclick = () => {
          state.activeProjectId = btn.getAttribute('data-project-id');
          navigateTo('workspace');
        };
      });
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error loading dashboard: ${escapeHtml(err.message)}</div>`;
    }
  }

  // 2. Projects View
  async function renderProjectsView() {
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="proj-import-btn">Import Folder</button>
      <button class="btn btn-secondary btn-sm" id="proj-clone-btn">Clone Git</button>
      <button class="btn btn-primary btn-sm" id="proj-create-btn">+ New Project</button>
    `;

    document.getElementById('proj-create-btn').onclick = showCreateProjectModal;
    document.getElementById('proj-import-btn').onclick = showImportProjectModal;
    document.getElementById('proj-clone-btn').onclick = showCloneProjectModal;

    const content = document.getElementById('main-content');
    await loadProjects();

    if (state.projects.length === 0) {
      content.innerHTML = `
        <div class="card" style="text-align:center;padding:60px 20px;">
          <h3 style="font-size:18px;margin-bottom:8px;">No projects registered</h3>
          <p style="color:var(--text-secondary);max-width:400px;margin:0 auto 20px auto;">
            Register your first repository or working directory to open interactive terminals and launch AI agents.
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
              <th>Git / Branch</th>
              <th>PTY Sessions</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${state.projects.map((p) => `
              <tr>
                <td>
                  <strong style="color:var(--text-primary);">${escapeHtml(p.name)}</strong>
                  <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.description || '')}</div>
                </td>
                <td style="font-family:var(--font-mono);font-size:12px;">
                  ${escapeHtml(p.path)}
                  ${p.existsOnDisk ? '' : '<span class="badge badge-danger" style="margin-left:6px;">Missing</span>'}
                </td>
                <td>
                  ${p.git_remote ? `
                    <div style="font-size:12px;color:var(--accent-color);">${escapeHtml(p.git_branch || 'main')}</div>
                    <div style="font-size:10px;color:var(--text-muted);">${escapeHtml(p.git_remote)}</div>
                  ` : '<span style="color:var(--text-muted);">No Git</span>'}
                </td>
                <td>
                  <span class="badge ${p.active_sessions_count > 0 ? 'badge-success' : 'badge-muted'}">
                    ${p.active_sessions_count} active
                  </span>
                </td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-primary btn-sm open-workspace-btn" data-project-id="${p.id}">Open Workspace</button>
                    <button class="btn btn-danger btn-sm delete-project-btn" data-project-id="${p.id}" data-project-name="${escapeHtml(p.name)}">Delete</button>
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
        state.activeProjectId = btn.getAttribute('data-project-id');
        navigateTo('workspace');
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
          Private repositories use the credentials configured under <strong>Repositories</strong>.
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
                  <td>
                    <strong>${escapeHtml(r.fullName)}</strong>
                    ${r.description ? `<div style="font-size:11px;color:var(--text-muted);">${escapeHtml(r.description)}</div>` : ''}
                  </td>
                  <td><span class="badge ${r.private ? 'badge-muted' : 'badge-success'}">${r.private ? 'Private' : 'Public'}</span></td>
                  <td style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(r.defaultBranch)}</td>
                  <td><button class="btn btn-primary btn-sm repos-clone-btn" data-index="${i}">Clone</button></td>
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

  // --- System (host) Terminal View ---
  async function renderTerminalView() {
    const content = document.getElementById('main-content');
    content.style.padding = '0'; // Terminal takes full viewport

    // Tear down any existing client sockets; tmux keeps the real shell alive.
    for (const item of state.sysTerminals.values()) {
      try {
        if (item.ws) item.ws.close();
        if (item.term) item.term.dispose();
      } catch {
        // Ignore
      }
    }
    state.sysTerminals.clear();
    state.activeSysTerminalId = null;

    content.innerHTML = `
      <div class="workspace-container">
        <div class="terminal-tabs-bar" id="sys-terminal-tabs-container">
          <button class="btn btn-secondary btn-sm" id="sys-tab-new-terminal-btn" style="margin-left:auto;">
            + New Terminal
          </button>
        </div>
        <div class="terminal-view-wrapper" id="sys-terminal-viewport"></div>
      </div>
    `;

    document.getElementById('sys-tab-new-terminal-btn').onclick = () => spawnSysTerminal();

    try {
      const termRes = await api('/api/terminals?scope=global');
      const actions = document.getElementById('top-bar-actions');
      actions.innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Host shell${termRes.runAsUser ? ` (as ${escapeHtml(termRes.runAsUser)})` : ''}</span>`;

      const sessions = termRes.sessions || [];
      if (sessions.length > 0) {
        await activateSysTerminal(sessions[0].id, sessions[0].name);
      } else {
        await spawnSysTerminal();
      }
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
      await activateSysTerminal(res.session.sessionId, res.session.name);
    } catch (err) {
      showToast(`Failed to create terminal: ${err.message}`, 'error');
    }
  }

  async function activateSysTerminal(sessionId, name = 'Terminal') {
    state.activeSysTerminalId = sessionId;
    const viewport = document.getElementById('sys-terminal-viewport');
    if (!viewport) return;

    for (const [id, item] of state.sysTerminals.entries()) {
      if (item.containerEl) {
        item.containerEl.style.display = (id === sessionId) ? 'block' : 'none';
      }
    }

    let item = state.sysTerminals.get(sessionId);

    if (!item) {
      const termDiv = document.createElement('div');
      termDiv.className = 'terminal-element';
      viewport.appendChild(termDiv);

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
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
      term.open(termDiv);
      fitAddon.fit();

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${sessionId}`);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output' && msg.data) {
            term.write(msg.data);
          } else if (msg.type === 'exit') {
            term.write(`\r\n\x1b[33m[Terminal process finished]\x1b[0m\r\n`);
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m[Error]: ${msg.message}\x1b[0m\r\n`);
          }
        } catch {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        term.write(`\r\n\x1b[90m[WebSocket connection closed]\x1b[0m\r\n`);
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      term.onResize((size) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
        }
      });

      item = { sessionId, name, term, fitAddon, ws, containerEl: termDiv };
      state.sysTerminals.set(sessionId, item);

      window.addEventListener('resize', () => {
        if (state.activeSysTerminalId === sessionId) {
          fitAddon.fit();
        }
      });
    }

    renderSysTerminalTabs();
    setTimeout(() => {
      item.fitAddon.fit();
      item.term.focus();
    }, 50);
  }

  function renderSysTerminalTabs() {
    const tabsContainer = document.getElementById('sys-terminal-tabs-container');
    if (!tabsContainer) return;

    const existingNewBtn = document.getElementById('sys-tab-new-terminal-btn');
    tabsContainer.querySelectorAll('.terminal-tab').forEach((el) => el.remove());

    for (const [id, item] of state.sysTerminals.entries()) {
      const tab = document.createElement('div');
      tab.className = `terminal-tab ${id === state.activeSysTerminalId ? 'active' : ''}`;
      tab.innerHTML = `
        <span>${escapeHtml(item.name)}</span>
        <button class="tab-close-btn" data-id="${id}">&times;</button>
      `;

      tab.onclick = (e) => {
        if (!e.target.classList.contains('tab-close-btn')) {
          activateSysTerminal(id, item.name);
        }
      };

      tab.querySelector('.tab-close-btn').onclick = async (e) => {
        e.stopPropagation();
        await closeSysTerminal(id);
      };

      tabsContainer.insertBefore(tab, existingNewBtn);
    }
  }

  async function closeSysTerminal(sessionId) {
    const item = state.sysTerminals.get(sessionId);
    if (item) {
      try {
        if (item.ws) item.ws.close();
        if (item.term) item.term.dispose();
        if (item.containerEl) item.containerEl.remove();
      } catch {
        // Ignore
      }
      state.sysTerminals.delete(sessionId);
      await api(`/api/terminals/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }

    if (state.sysTerminals.size > 0) {
      const nextId = Array.from(state.sysTerminals.keys())[0];
      const nextItem = state.sysTerminals.get(nextId);
      activateSysTerminal(nextId, nextItem.name);
    } else {
      renderSysTerminalTabs();
    }
  }

  // 3. Project Workspace & Terminal View (xterm.js + WebSockets + node-pty + tmux)
  async function renderWorkspaceView() {
    await loadProjects();
    const content = document.getElementById('main-content');
    content.style.padding = '0'; // Terminal takes full viewport

    if (state.projects.length === 0) {
      content.innerHTML = `
        <div style="padding:40px;text-align:center;">
          <h3>Create a project first to open a terminal</h3>
          <button class="btn btn-primary" style="margin-top:16px;" id="ws-create-proj-btn">+ Create Project</button>
        </div>
      `;
      document.getElementById('ws-create-proj-btn').onclick = showCreateProjectModal;
      return;
    }

    const currentProject = state.projects.find((p) => p.id === state.activeProjectId) || state.projects[0];
    state.activeProjectId = currentProject.id;

    // Top action bar
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = `
      <select class="form-input" id="ws-project-selector" style="padding:4px 8px;font-size:12px;width:180px;">
        ${state.projects.map((p) => `
          <option value="${p.id}" ${p.id === currentProject.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>
        `).join('')}
      </select>
      <button class="btn btn-primary btn-sm" id="ws-launch-agent-btn">
        <svg style="width:14px;height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        <span>Launch AI Agent</span>
      </button>
    `;

    document.getElementById('ws-project-selector').onchange = (e) => {
      state.activeProjectId = e.target.value;
      renderWorkspaceView();
    };

    document.getElementById('ws-launch-agent-btn').onclick = () => {
      showLaunchAgentModal(currentProject.id);
    };

    content.innerHTML = `
      <div class="workspace-container">
        <!-- Tabs bar -->
        <div class="terminal-tabs-bar" id="terminal-tabs-container">
          <button class="btn btn-secondary btn-sm" id="tab-new-terminal-btn" style="margin-left:auto;">
            + New Terminal
          </button>
        </div>
        <!-- Terminal Body -->
        <div class="terminal-view-wrapper" id="terminal-viewport"></div>
      </div>
    `;

    document.getElementById('tab-new-terminal-btn').onclick = async () => {
      await spawnNewTerminal(currentProject.id);
    };

    // Load active sessions for this project from backend
    try {
      const termRes = await api(`/api/terminals?projectId=${currentProject.id}`);
      const sessions = termRes.sessions || [];

      if (sessions.length > 0) {
        // Attach to the first active session
        const first = sessions[0];
        await activateTerminalSession(first.id, first.name);
      } else {
        // Automatically spawn an initial terminal for this project
        await spawnNewTerminal(currentProject.id);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function spawnNewTerminal(projectId, customName = null, agentId = null) {
    try {
      const res = await api('/api/terminals', {
        method: 'POST',
        body: {
          projectId,
          name: customName || `Terminal ${state.terminals.size + 1}`,
        },
      });
      await activateTerminalSession(res.session.sessionId, res.session.name);
    } catch (err) {
      showToast(`Failed to create terminal: ${err.message}`, 'error');
    }
  }

  async function activateTerminalSession(sessionId, name = 'Terminal') {
    state.activeTerminalId = sessionId;
    const viewport = document.getElementById('terminal-viewport');
    if (!viewport) return;

    // Hide all existing terminal containers
    for (const [id, item] of state.terminals.entries()) {
      if (item.containerEl) {
        item.containerEl.style.display = (id === sessionId) ? 'block' : 'none';
      }
    }

    // Check if xterm instance already initialized
    let item = state.terminals.get(sessionId);

    if (!item) {
      // Create new DOM container for xterm
      const termDiv = document.createElement('div');
      termDiv.className = 'terminal-element';
      viewport.appendChild(termDiv);

      // Initialize xterm.js
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
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

      term.open(termDiv);
      fitAddon.fit();

      // Establish WebSocket
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${location.host}/ws/terminal/${sessionId}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Send initial dimensions
        ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output' && msg.data) {
            term.write(msg.data);
          } else if (msg.type === 'exit') {
            term.write(`\r\n\x1b[33m[Terminal process finished]\x1b[0m\r\n`);
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m[Error]: ${msg.message}\x1b[0m\r\n`);
          }
        } catch {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        term.write(`\r\n\x1b[90m[WebSocket connection closed]\x1b[0m\r\n`);
      };

      // Client input to WS
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // Terminal resize handler
      term.onResize((size) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
        }
      });

      item = {
        sessionId,
        name,
        term,
        fitAddon,
        ws,
        containerEl: termDiv,
      };

      state.terminals.set(sessionId, item);

      // Auto fit on window resize
      window.addEventListener('resize', () => {
        if (state.activeTerminalId === sessionId) {
          fitAddon.fit();
        }
      });
    }

    // Update UI tabs
    renderTerminalTabs();
    setTimeout(() => {
      item.fitAddon.fit();
      item.term.focus();
    }, 50);
  }

  function renderTerminalTabs() {
    const tabsContainer = document.getElementById('terminal-tabs-container');
    if (!tabsContainer) return;

    const existingNewBtn = document.getElementById('tab-new-terminal-btn');

    // Remove old tabs
    tabsContainer.querySelectorAll('.terminal-tab').forEach((el) => el.remove());

    for (const [id, item] of state.terminals.entries()) {
      const tab = document.createElement('div');
      tab.className = `terminal-tab ${id === state.activeTerminalId ? 'active' : ''}`;
      tab.innerHTML = `
        <span>${escapeHtml(item.name)}</span>
        <button class="tab-close-btn" data-id="${id}">&times;</button>
      `;

      tab.onclick = (e) => {
        if (!e.target.classList.contains('tab-close-btn')) {
          activateTerminalSession(id, item.name);
        }
      };

      tab.querySelector('.tab-close-btn').onclick = async (e) => {
        e.stopPropagation();
        await closeTerminalSession(id);
      };

      tabsContainer.insertBefore(tab, existingNewBtn);
    }
  }

  async function closeTerminalSession(sessionId) {
    const item = state.terminals.get(sessionId);
    if (item) {
      try {
        if (item.ws) item.ws.close();
        if (item.term) item.term.dispose();
        if (item.containerEl) item.containerEl.remove();
      } catch {
        // Ignore
      }
      state.terminals.delete(sessionId);

      // Tell backend to kill PTY / tmux
      await api(`/api/terminals/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }

    if (state.terminals.size > 0) {
      const nextId = Array.from(state.terminals.keys())[0];
      const nextItem = state.terminals.get(nextId);
      activateTerminalSession(nextId, nextItem.name);
    } else {
      renderTerminalTabs();
    }
  }

  // 4. Agents View
  async function renderAgentsView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Checking available agents...</div>';
    await loadAgents();
    await loadProjects();

    content.innerHTML = `
      <div style="margin-bottom:24px;">
        <h2 style="font-size:18px;margin-bottom:6px;">AI Agents & CLI Tools</h2>
        <p style="color:var(--text-secondary);">
          Citadel detects and runs CLI tools under your authorized account without requiring commercial API subscriptions.
        </p>
      </div>

      <div class="grid-cards">
        ${state.agents.map((a) => `
          <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;">
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                <h3 style="font-size:16px;font-weight:600;">${escapeHtml(a.name)}</h3>
                <span class="badge ${a.installed ? 'badge-success' : 'badge-muted'}">
                  ${a.installed ? 'Installed' : 'Not in PATH'}
                </span>
              </div>
              <p style="color:var(--text-secondary);font-size:13px;margin-bottom:14px;">
                ${escapeHtml(a.description)}
              </p>
              ${a.installed ? `
                <div style="background:var(--bg-tertiary);padding:8px 12px;border-radius:6px;font-family:var(--font-mono);font-size:11px;margin-bottom:14px;">
                  <div style="color:var(--text-muted);">Path: ${escapeHtml(a.path)}</div>
                  ${a.version ? `<div style="color:var(--accent-color);margin-top:4px;">Version: ${escapeHtml(a.version)}</div>` : ''}
                </div>
              ` : `
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;">
                  Install it on your VPS (e.g. npm i -g @anthropic-ai/claude-code) to enable it directly.
                </div>
              `}
            </div>
            <div>
              <button class="btn btn-primary btn-sm launch-agent-btn" data-agent-id="${a.id}" ${!a.installed ? 'disabled' : ''} style="width:100%;justify-content:center;">
                Launch in Project...
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    document.querySelectorAll('.launch-agent-btn').forEach((btn) => {
      btn.onclick = () => {
        const agentId = btn.getAttribute('data-agent-id');
        showLaunchAgentModal(state.activeProjectId, agentId);
      };
    });
  }

  function showLaunchAgentModal(preselectedProjectId = null, preselectedAgentId = null) {
    if (state.projects.length === 0) {
      showToast('Create at least one project before launching an agent.', 'error');
      return;
    }

    const installedAgents = state.agents.filter((a) => a.installed);
    if (installedAgents.length === 0) {
      showToast('No CLI agent installed on the system was found.', 'error');
      return;
    }

    openModal({
      title: 'Launch AI Agent in Project',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Select Project</label>
          <select class="form-input" id="m-launch-proj">
            ${state.projects.map((p) => `
              <option value="${p.id}" ${p.id === preselectedProjectId ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.path)})</option>
            `).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Select CLI Agent</label>
          <select class="form-input" id="m-launch-agent">
            ${installedAgents.map((a) => `
              <option value="${a.id}" ${a.id === preselectedAgentId ? 'selected' : ''}>${escapeHtml(a.name)} (${escapeHtml(a.version || a.binaryName)})</option>
            `).join('')}
          </select>
        </div>
      `,
      confirmText: 'Launch Agent',
      onConfirm: async () => {
        const projectId = document.getElementById('m-launch-proj').value;
        const agentId = document.getElementById('m-launch-agent').value;

        showToast('Starting agent session...', 'info');
        const res = await api('/api/agents/launch', {
          method: 'POST',
          body: { projectId, agentId },
        });

        state.activeProjectId = projectId;
        navigateTo('workspace');
        await activateTerminalSession(res.session.sessionId, res.session.name);
        showToast('Agent launched in persistent terminal.', 'success');
      },
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
                  <td>
                    <a href="https://${escapeHtml(d.domain)}" target="_blank" style="color:var(--accent-color);font-weight:600;">
                      ${escapeHtml(d.domain)}
                    </a>
                  </td>
                  <td>${escapeHtml(d.project_name || 'Unknown')}</td>
                  <td style="font-family:var(--font-mono);">${d.target_port}</td>
                  <td>
                    <span class="badge ${d.status === 'active' ? 'badge-success' : 'badge-warning'}">
                      ${escapeHtml(d.status)}
                    </span>
                  </td>
                  <td>
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
                  <td style="font-family:var(--font-mono);">${escapeHtml(c.id)}</td>
                  <td><strong>${escapeHtml(c.names.join(', '))}</strong></td>
                  <td style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(c.image)}</td>
                  <td>
                    <span class="badge ${c.state === 'running' ? 'badge-success' : 'badge-muted'}">
                      ${escapeHtml(c.status)}
                    </span>
                  </td>
                  <td style="font-size:11px;font-family:var(--font-mono);">
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

  // 7. System & Audit View
  async function renderSystemView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Loading diagnostics and audit logs...</div>';

    try {
      const [nodeRes, auditRes, versionRes] = await Promise.all([
        api('/api/system/node'),
        api('/api/audit?limit=25'),
        api('/api/system/version'),
      ]);

      const node = nodeRes.node;
      const logs = auditRes.logs || [];
      const ver = versionRes.version || {};

      content.innerHTML = `
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
                ${ver.updaterAvailable
                  ? 'The in-panel updater is enabled.'
                  : 'In-panel updater not installed. Run install.sh --enable-updater to enable one-click updates.'}
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0;">
              <button class="btn btn-secondary btn-sm" id="check-updates-btn">Check for updates</button>
              ${ver.updaterAvailable ? '<button class="btn btn-primary btn-sm" id="apply-update-btn">Update now</button>' : ''}
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:24px;">
          <h3 style="font-size:16px;font-weight:600;margin-bottom:14px;">Node Diagnostics</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:16px;font-size:13px;">
            <div>
              <span style="color:var(--text-muted);">Hostname:</span>
              <strong style="display:block;margin-top:2px;">${escapeHtml(node.hostname)}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Operating System:</span>
              <strong style="display:block;margin-top:2px;">${escapeHtml(node.platform)} ${escapeHtml(node.release)}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Node.js Runtime:</span>
              <strong style="display:block;margin-top:2px;color:var(--accent-color);">${escapeHtml(node.nodeVersion)}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Uptime:</span>
              <strong style="display:block;margin-top:2px;">${Math.round(node.uptimeSeconds / 3600)} hours</strong>
            </div>
          </div>
        </div>

        <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">Security Audit Log</h3>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Action</th>
                <th>User</th>
                <th>Target</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              ${logs.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No audit events recorded</td></tr>' : ''}
              ${logs.map((l) => `
                <tr>
                  <td style="font-size:11px;color:var(--text-muted);white-space:nowrap;">
                    ${new Date(l.created_at).toLocaleString()}
                  </td>
                  <td><strong style="color:var(--accent-color);">${escapeHtml(l.action)}</strong></td>
                  <td>${escapeHtml(l.user_id || 'system')}</td>
                  <td>${escapeHtml(l.target_type || '-')} ${escapeHtml(l.target_id ? `(${l.target_id.slice(0, 8)})` : '')}</td>
                  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);">
                    ${escapeHtml(typeof l.details === 'object' ? JSON.stringify(l.details) : (l.details || '-'))}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

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
              statusEl.innerHTML = `Update available: <strong>v${escapeHtml(u.latest)}</strong>${u.releaseUrl ? ` — <a href="${escapeHtml(u.releaseUrl)}" target="_blank" rel="noopener" style="color:var(--accent-color);">release notes</a>` : ''}`;
            } else {
              statusEl.style.color = 'var(--success-color)';
              statusEl.textContent = `You are running the latest version (v${u.latest}).`;
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
            statusEl.textContent = 'Update in progress. Reload this page in ~20 seconds.';
          } catch (err) {
            applyBtn.disabled = false;
            statusEl.style.color = 'var(--danger-color)';
            statusEl.textContent = `Error: ${err.message}`;
          }
        };
      }
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // 8. Plugins View
  async function renderPluginsView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Loading plugins...</div>';

    try {
      const res = await api('/api/plugins');
      const plugins = res.plugins || [];

      content.innerHTML = `
        <div style="margin-bottom:24px;">
          <h2 style="font-size:18px;margin-bottom:6px;">Modular Plugins & Extensions</h2>
          <p style="color:var(--text-secondary);">
            Citadel loads plugins from the <code>plugins/</code> directory based on the <code>plugin.json</code> standard.
          </p>
        </div>

        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name / ID</th>
                <th>Version</th>
                <th>Capabilities</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${plugins.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No plugins installed</td></tr>' : ''}
              ${plugins.map((p) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(p.name)}</strong>
                    <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.description)} (${escapeHtml(p.id)})</div>
                  </td>
                  <td style="font-family:var(--font-mono);">v${escapeHtml(p.version)}</td>
                  <td>
                    ${(p.capabilities || []).map((c) => `<span class="badge badge-muted">${escapeHtml(c)}</span>`).join(' ')}
                  </td>
                  <td>
                    <span class="badge ${p.status === 'active' ? 'badge-success' : (p.status === 'error' ? 'badge-danger' : 'badge-muted')}">
                      ${escapeHtml(p.status)}
                    </span>
                  </td>
                  <td>
                    <button class="btn btn-secondary btn-sm toggle-plugin-btn" data-id="${p.id}" data-enabled="${p.enabled ? '1' : '0'}">
                      ${p.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      document.querySelectorAll('.toggle-plugin-btn').forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.getAttribute('data-id');
          const isCurrentlyEnabled = btn.getAttribute('data-enabled') === '1';
          await api(`/api/plugins/${id}/toggle`, {
            method: 'POST',
            body: { enabled: !isCurrentlyEnabled },
          });
          showToast(`Plugin ${!isCurrentlyEnabled ? 'enabled' : 'disabled'}.`, 'success');
          renderPluginsView();
        };
      });
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Run on page load
  document.addEventListener('DOMContentLoaded', init);
})();
