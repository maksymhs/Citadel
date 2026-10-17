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
  function openModal({ title, bodyHtml, confirmText = 'Confirmar', onConfirm }) {
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
            <button class="btn btn-secondary" id="modal-cancel-btn">Cancelar</button>
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
        btn.textContent = 'Procesando...';
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
          <h2>Error al conectar con Citadel</h2>
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
            <h1>Configurar Citadel</h1>
            <p>Crea la cuenta administradora inicial para proteger tu servidor</p>
          </div>
          <form id="setup-form">
            <div class="form-group">
              <label class="form-label">Usuario Administrador</label>
              <input type="text" class="form-input" id="setup-username" placeholder="admin" required minlength="3">
            </div>
            <div class="form-group">
              <label class="form-label">Contraseña Maestra</label>
              <input type="password" class="form-input" id="setup-password" placeholder="Mínimo 8 caracteres" required minlength="8">
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:10px;">
              Inicializar Citadel
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
        showToast('Cuenta de administrador creada exitosamente.', 'success');
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
            <p>Acceso seguro al panel de control de tu VPS</p>
          </div>
          <form id="login-form">
            <div class="form-group">
              <label class="form-label">Usuario</label>
              <input type="text" class="form-input" id="login-username" required autocomplete="username">
            </div>
            <div class="form-group">
              <label class="form-label">Contraseña</label>
              <input type="password" class="form-input" id="login-password" required autocomplete="current-password">
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:10px;">
              Iniciar Sesión
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
        showToast('Sesión iniciada.', 'success');
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
            <div class="nav-section-title">Desarrollo</div>
            <a class="nav-item active" data-view="dashboard">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
              <span>Dashboard</span>
            </a>
            <a class="nav-item" data-view="projects">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
              <span>Proyectos</span>
              <span class="nav-badge" id="nav-projects-count">0</span>
            </a>
            <a class="nav-item" data-view="workspace">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              <span>Workspace & PTY</span>
            </a>
            <a class="nav-item" data-view="agents">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              <span>Agentes IA</span>
            </a>

            <div class="nav-section-title">Infraestructura</div>
            <a class="nav-item" data-view="deployments">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>
              <span>Proxy & Dominios</span>
            </a>
            <a class="nav-item" data-view="docker">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
              <span>Docker (Opcional)</span>
            </a>
            <a class="nav-item" data-view="plugins">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/></svg>
              <span>Plugins</span>
            </a>
            <a class="nav-item" data-view="system">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
              <span>Sistema & Auditoría</span>
            </a>
          </nav>
          <div class="sidebar-footer">
            <div class="user-profile">
              <div class="user-avatar">${(state.user.username || 'A')[0].toUpperCase()}</div>
              <div class="user-name">${escapeHtml(state.user.username)}</div>
            </div>
            <button class="btn btn-secondary btn-sm" id="logout-btn" title="Cerrar sesión">
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
      titleEl.textContent = 'Gestión de Proyectos';
      renderProjectsView();
    } else if (view === 'workspace') {
      titleEl.textContent = 'Workspace & Terminales Persistentes';
      renderWorkspaceView();
    } else if (view === 'agents') {
      titleEl.textContent = 'Lanzador de Agentes de IA';
      renderAgentsView();
    } else if (view === 'deployments') {
      titleEl.textContent = 'Proxy & Publicación de Dominios';
      renderDeploymentsView();
    } else if (view === 'docker') {
      titleEl.textContent = 'Monitor de Docker';
      renderDockerView();
    } else if (view === 'plugins') {
      titleEl.textContent = 'Extensiones & Plugins';
      renderPluginsView();
    } else if (view === 'system') {
      titleEl.textContent = 'Diagnóstico del Sistema & Auditoría';
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
    content.innerHTML = '<div style="color:var(--text-secondary);">Cargando métricas del sistema...</div>';

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
            <div class="card-title">USO DE MEMORIA</div>
            <div class="card-value">${metrics.memoryUsedPercent}%</div>
            <div class="card-subtitle">${Math.round(node.memory.usedBytes / 1024 / 1024)} MB de ${Math.round(node.memory.totalBytes / 1024 / 1024)} MB</div>
          </div>
          <div class="card">
            <div class="card-title">CARGA CPU (1m)</div>
            <div class="card-value">${metrics.loadAvg.toFixed(2)}</div>
            <div class="card-subtitle">${node.cpu.cores} cores (${node.cpu.model.split('@')[0].trim()})</div>
          </div>
          <div class="card">
            <div class="card-title">PROYECTOS ACTIVOS</div>
            <div class="card-value">${state.projects.length}</div>
            <div class="card-subtitle">${node.stats.activeSessions} terminales persistentes</div>
          </div>
          <div class="card">
            <div class="card-title">HOST VPS</div>
            <div class="card-value" style="font-size:18px;">${escapeHtml(node.hostname)}</div>
            <div class="card-subtitle">${escapeHtml(node.platform)} ${escapeHtml(node.release)} (${node.arch})</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;">
          <!-- Integrations status -->
          <div class="card">
            <h3 style="font-size:14px;font-weight:600;margin-bottom:14px;">Integraciones de Plataforma</h3>
            <div style="display:flex;flex-direction:column;gap:12px;">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <strong>tmux (Persistencia PTY)</strong>
                  <div style="font-size:12px;color:var(--text-secondary);">${integ.tmux.description}</div>
                </div>
                <span class="badge ${integ.tmux.available ? 'badge-success' : 'badge-warning'}">
                  ${integ.tmux.available ? 'Disponible' : 'Sin tmux'}
                </span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <strong>Git CLI</strong>
                  <div style="font-size:12px;color:var(--text-secondary);">${integ.git.description}</div>
                </div>
                <span class="badge ${integ.git.available ? 'badge-success' : 'badge-danger'}">
                  ${integ.git.available ? 'Activo' : 'Ausente'}
                </span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <strong>Caddy Proxy (HTTPS)</strong>
                  <div style="font-size:12px;color:var(--text-secondary);">${integ.caddy.helpMessage}</div>
                </div>
                <span class="badge ${integ.caddy.available ? 'badge-success' : 'badge-muted'}">
                  ${integ.caddy.available ? 'Conectado' : 'Opcional / Inactivo'}
                </span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <div>
                  <strong>Docker Engine</strong>
                  <div style="font-size:12px;color:var(--text-secondary);">${integ.docker.available ? 'Socket conectado' : 'Desactivado / Opcional'}</div>
                </div>
                <span class="badge ${integ.docker.available ? 'badge-success' : 'badge-muted'}">
                  ${integ.docker.available ? 'Activo' : 'Opcional'}
                </span>
              </div>
            </div>
          </div>

          <!-- Quick Actions & Projects -->
          <div class="card">
            <h3 style="font-size:14px;font-weight:600;margin-bottom:14px;">Acceso Rápido a Proyectos</h3>
            <div style="display:flex;gap:10px;margin-bottom:16px;">
              <button class="btn btn-primary btn-sm" id="dash-new-project-btn">+ Nuevo Proyecto</button>
              <button class="btn btn-secondary btn-sm" id="dash-clone-btn">Clonar Git</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${state.projects.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">No hay proyectos registrados aún.</div>' : ''}
              ${state.projects.slice(0, 5).map((p) => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-tertiary);border-radius:6px;">
                  <div>
                    <strong style="color:var(--accent-color);">${escapeHtml(p.name)}</strong>
                    <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${escapeHtml(p.path)}</div>
                  </div>
                  <button class="btn btn-secondary btn-sm open-workspace-btn" data-project-id="${p.id}">Abrir Terminal</button>
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
      content.innerHTML = `<div style="color:var(--danger-color);">Error cargando dashboard: ${escapeHtml(err.message)}</div>`;
    }
  }

  // 2. Projects View
  async function renderProjectsView() {
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="proj-import-btn">Importar Carpeta</button>
      <button class="btn btn-secondary btn-sm" id="proj-clone-btn">Clonar Git</button>
      <button class="btn btn-primary btn-sm" id="proj-create-btn">+ Nuevo Proyecto</button>
    `;

    document.getElementById('proj-create-btn').onclick = showCreateProjectModal;
    document.getElementById('proj-import-btn').onclick = showImportProjectModal;
    document.getElementById('proj-clone-btn').onclick = showCloneProjectModal;

    const content = document.getElementById('main-content');
    await loadProjects();

    if (state.projects.length === 0) {
      content.innerHTML = `
        <div class="card" style="text-align:center;padding:60px 20px;">
          <h3 style="font-size:18px;margin-bottom:8px;">No hay proyectos registrados</h3>
          <p style="color:var(--text-secondary);max-width:400px;margin:0 auto 20px auto;">
            Registra tu primer repositorio o directorio de trabajo para abrir terminales interactivas y lanzar agentes de IA.
          </p>
          <div style="display:flex;justify-content:center;gap:12px;">
            <button class="btn btn-primary" id="empty-create-btn">Crear Proyecto</button>
            <button class="btn btn-secondary" id="empty-clone-btn">Clonar Repositorio</button>
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
              <th>Nombre</th>
              <th>Directorio en VPS</th>
              <th>Git / Rama</th>
              <th>Sesiones PTY</th>
              <th>Acciones</th>
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
                  ${p.existsOnDisk ? '' : '<span class="badge badge-danger" style="margin-left:6px;">No existe</span>'}
                </td>
                <td>
                  ${p.git_remote ? `
                    <div style="font-size:12px;color:var(--accent-color);">${escapeHtml(p.git_branch || 'main')}</div>
                    <div style="font-size:10px;color:var(--text-muted);">${escapeHtml(p.git_remote)}</div>
                  ` : '<span style="color:var(--text-muted);">Sin Git</span>'}
                </td>
                <td>
                  <span class="badge ${p.active_sessions_count > 0 ? 'badge-success' : 'badge-muted'}">
                    ${p.active_sessions_count} activas
                  </span>
                </td>
                <td>
                  <div style="display:flex;gap:6px;">
                    <button class="btn btn-primary btn-sm open-workspace-btn" data-project-id="${p.id}">Abrir Workspace</button>
                    <button class="btn btn-danger btn-sm delete-project-btn" data-project-id="${p.id}" data-project-name="${escapeHtml(p.name)}">Eliminar</button>
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
          title: `Eliminar Proyecto "${name}"`,
          bodyHtml: `
            <p style="margin-bottom:12px;color:var(--text-secondary);">
              ¿Deseas desvincular este proyecto de Citadel?
            </p>
            <div style="background:var(--bg-tertiary);padding:12px;border-radius:6px;margin-bottom:12px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="del-files-check">
                <span style="color:var(--danger-color);font-weight:600;">Eliminar también los archivos del disco duro</span>
              </label>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
                Por defecto, tus archivos se conservan intactos en el VPS.
              </div>
            </div>
          `,
          confirmText: 'Eliminar Proyecto',
          onConfirm: async () => {
            const delFiles = document.getElementById('del-files-check')?.checked || false;
            await api(`/api/projects/${id}?deleteFiles=${delFiles}`, { method: 'DELETE' });
            showToast('Proyecto eliminado.', 'success');
            renderProjectsView();
          },
        });
      };
    });
  }

  // Modals for project creation/import/clone
  function showCreateProjectModal() {
    openModal({
      title: 'Crear Nuevo Proyecto',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Nombre del Proyecto</label>
          <input type="text" class="form-input" id="m-proj-name" placeholder="mi-aplicacion" required>
        </div>
        <div class="form-group">
          <label class="form-label">Slug / Identificador (opcional)</label>
          <input type="text" class="form-input" id="m-proj-slug" placeholder="mi-aplicacion">
        </div>
        <div class="form-group">
          <label class="form-label">Descripción (opcional)</label>
          <input type="text" class="form-input" id="m-proj-desc" placeholder="Backend de producción">
        </div>
      `,
      confirmText: 'Crear Proyecto',
      onConfirm: async () => {
        const name = document.getElementById('m-proj-name').value;
        const slug = document.getElementById('m-proj-slug').value;
        const description = document.getElementById('m-proj-desc').value;
        await api('/api/projects', {
          method: 'POST',
          body: { name, slug, description },
        });
        showToast('Proyecto creado exitosamente.', 'success');
        await loadProjects();
        if (state.currentView === 'projects') renderProjectsView();
        else if (state.currentView === 'dashboard') renderDashboardView();
      },
    });
  }

  function showImportProjectModal() {
    openModal({
      title: 'Importar Directorio Existente del VPS',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Ruta Absoluta en el Servidor</label>
          <input type="text" class="form-input" id="m-import-path" placeholder="/srv/mis-proyectos/app" required>
        </div>
        <div class="form-group">
          <label class="form-label">Nombre para el Panel</label>
          <input type="text" class="form-input" id="m-import-name" placeholder="Mi App Existente" required>
        </div>
        <div class="form-group">
          <label class="form-label">Descripción (opcional)</label>
          <input type="text" class="form-input" id="m-import-desc">
        </div>
      `,
      confirmText: 'Importar Directorio',
      onConfirm: async () => {
        const targetPath = document.getElementById('m-import-path').value;
        const name = document.getElementById('m-import-name').value;
        const description = document.getElementById('m-import-desc').value;
        await api('/api/projects/import', {
          method: 'POST',
          body: { targetPath, name, description },
        });
        showToast('Directorio importado correctamente.', 'success');
        await loadProjects();
        if (state.currentView === 'projects') renderProjectsView();
      },
    });
  }

  function showCloneProjectModal() {
    openModal({
      title: 'Clonar Repositorio Git',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">URL del Repositorio Git</label>
          <input type="text" class="form-input" id="m-clone-url" placeholder="https://github.com/usuario/repo.git" required>
        </div>
        <div class="form-group">
          <label class="form-label">Nombre del Proyecto (opcional)</label>
          <input type="text" class="form-input" id="m-clone-name" placeholder="repo">
        </div>
        <div class="form-group">
          <label class="form-label">Rama (opcional)</label>
          <input type="text" class="form-input" id="m-clone-branch" placeholder="main">
        </div>
      `,
      confirmText: 'Clonar e Importar',
      onConfirm: async () => {
        const repoUrl = document.getElementById('m-clone-url').value;
        const name = document.getElementById('m-clone-name').value;
        const branch = document.getElementById('m-clone-branch').value;
        showToast('Clonando repositorio en el servidor...', 'info');
        await api('/api/projects/clone', {
          method: 'POST',
          body: { repoUrl, name, branch },
        });
        showToast('Repositorio clonado e importado con éxito.', 'success');
        await loadProjects();
        if (state.currentView === 'projects') renderProjectsView();
      },
    });
  }

  // 3. Project Workspace & Terminal View (xterm.js + WebSockets + node-pty + tmux)
  async function renderWorkspaceView() {
    await loadProjects();
    const content = document.getElementById('main-content');
    content.style.padding = '0'; // Terminal takes full viewport

    if (state.projects.length === 0) {
      content.innerHTML = `
        <div style="padding:40px;text-align:center;">
          <h3>Crea un proyecto primero para abrir una terminal</h3>
          <button class="btn btn-primary" style="margin-top:16px;" id="ws-create-proj-btn">+ Crear Proyecto</button>
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
        <span>Lanzar Agente IA</span>
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
            + Nueva Terminal
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
      showToast(`Error al crear terminal: ${err.message}`, 'error');
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
            term.write(`\r\n\x1b[33m[Proceso de terminal finalizado]\x1b[0m\r\n`);
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m[Error]: ${msg.message}\x1b[0m\r\n`);
          }
        } catch {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        term.write(`\r\n\x1b[90m[Conexión WebSocket cerrada]\x1b[0m\r\n`);
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
    content.innerHTML = '<div style="color:var(--text-secondary);">Consultando agentes disponibles...</div>';
    await loadAgents();
    await loadProjects();

    content.innerHTML = `
      <div style="margin-bottom:24px;">
        <h2 style="font-size:18px;margin-bottom:6px;">Agentes de IA y Herramientas CLI</h2>
        <p style="color:var(--text-secondary);">
          Citadel detecta y ejecuta herramientas CLI bajo tu cuenta autorizada sin exigir suscripciones API comerciales.
        </p>
      </div>

      <div class="grid-cards">
        ${state.agents.map((a) => `
          <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;">
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                <h3 style="font-size:16px;font-weight:600;">${escapeHtml(a.name)}</h3>
                <span class="badge ${a.installed ? 'badge-success' : 'badge-muted'}">
                  ${a.installed ? 'Instalado' : 'No en PATH'}
                </span>
              </div>
              <p style="color:var(--text-secondary);font-size:13px;margin-bottom:14px;">
                ${escapeHtml(a.description)}
              </p>
              ${a.installed ? `
                <div style="background:var(--bg-tertiary);padding:8px 12px;border-radius:6px;font-family:var(--font-mono);font-size:11px;margin-bottom:14px;">
                  <div style="color:var(--text-muted);">Ruta: ${escapeHtml(a.path)}</div>
                  ${a.version ? `<div style="color:var(--accent-color);margin-top:4px;">Versión: ${escapeHtml(a.version)}</div>` : ''}
                </div>
              ` : `
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;">
                  Instálalo en tu VPS (ej. npm i -g @anthropic-ai/claude-code) para habilitarlo directamente.
                </div>
              `}
            </div>
            <div>
              <button class="btn btn-primary btn-sm launch-agent-btn" data-agent-id="${a.id}" ${!a.installed ? 'disabled' : ''} style="width:100%;justify-content:center;">
                Lanzar en Proyecto...
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
      showToast('Crea al menos un proyecto antes de lanzar un agente.', 'error');
      return;
    }

    const installedAgents = state.agents.filter((a) => a.installed);
    if (installedAgents.length === 0) {
      showToast('No se encontró ningún agente CLI instalado en el sistema.', 'error');
      return;
    }

    openModal({
      title: 'Lanzar Agente de IA en Proyecto',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Selecciona Proyecto</label>
          <select class="form-input" id="m-launch-proj">
            ${state.projects.map((p) => `
              <option value="${p.id}" ${p.id === preselectedProjectId ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.path)})</option>
            `).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Selecciona Agente CLI</label>
          <select class="form-input" id="m-launch-agent">
            ${installedAgents.map((a) => `
              <option value="${a.id}" ${a.id === preselectedAgentId ? 'selected' : ''}>${escapeHtml(a.name)} (${escapeHtml(a.version || a.binaryName)})</option>
            `).join('')}
          </select>
        </div>
      `,
      confirmText: 'Lanzar Agente',
      onConfirm: async () => {
        const projectId = document.getElementById('m-launch-proj').value;
        const agentId = document.getElementById('m-launch-agent').value;

        showToast('Iniciando sesión del agente...', 'info');
        const res = await api('/api/agents/launch', {
          method: 'POST',
          body: { projectId, agentId },
        });

        state.activeProjectId = projectId;
        navigateTo('workspace');
        await activateTerminalSession(res.session.sessionId, res.session.name);
        showToast('Agente lanzado en terminal persistente.', 'success');
      },
    });
  }

  // 5. Deployments & Proxy View (Caddy)
  async function renderDeploymentsView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Cargando estado de Caddy...</div>';

    try {
      const [statusRes, depRes] = await Promise.all([
        api('/api/proxy/status'),
        api('/api/proxy/deployments'),
      ]);

      content.innerHTML = `
        <div class="card" style="margin-bottom:24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h3 style="font-size:16px;font-weight:600;">Estado de Caddy Proxy</h3>
            <span class="badge ${statusRes.available ? 'badge-success' : 'badge-muted'}">
              ${statusRes.available ? 'Activo (127.0.0.1:2019)' : 'No disponible'}
            </span>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">
            ${escapeHtml(statusRes.helpMessage)}
          </p>
          <div>
            <button class="btn btn-primary btn-sm" id="pub-domain-btn" ${!statusRes.available ? 'disabled' : ''}>
              + Publicar Dominio / Subdominio
            </button>
          </div>
        </div>

        <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">Dominios Mapeados</h3>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Dominio</th>
                <th>Proyecto</th>
                <th>Puerto Destino</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              ${(depRes.deployments || []).length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No hay dominios publicados</td></tr>' : ''}
              ${(depRes.deployments || []).map((d) => `
                <tr>
                  <td>
                    <a href="https://${escapeHtml(d.domain)}" target="_blank" style="color:var(--accent-color);font-weight:600;">
                      ${escapeHtml(d.domain)}
                    </a>
                  </td>
                  <td>${escapeHtml(d.project_name || 'Desconocido')}</td>
                  <td style="font-family:var(--font-mono);">${d.target_port}</td>
                  <td>
                    <span class="badge ${d.status === 'active' ? 'badge-success' : 'badge-warning'}">
                      ${escapeHtml(d.status)}
                    </span>
                  </td>
                  <td>
                    <button class="btn btn-danger btn-sm unpub-btn" data-domain="${escapeHtml(d.domain)}">Despublicar</button>
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
          showToast(`Dominio ${domain} despublicado.`, 'success');
          renderDeploymentsView();
        };
      });
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  function showPublishDomainModal() {
    openModal({
      title: 'Publicar Dominio con HTTPS Automático',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Proyecto</label>
          <select class="form-input" id="m-pub-proj">
            ${state.projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Nombre de Dominio o Subdominio (ej: app.tudominio.com)</label>
          <input type="text" class="form-input" id="m-pub-domain" placeholder="app.ejemplo.com" required>
        </div>
        <div class="form-group">
          <label class="form-label">Puerto Local del Proyecto</label>
          <input type="number" class="form-input" id="m-pub-port" placeholder="3000" min="1" max="65535" required>
        </div>
      `,
      confirmText: 'Publicar con Caddy',
      onConfirm: async () => {
        const projectId = document.getElementById('m-pub-proj').value;
        const domain = document.getElementById('m-pub-domain').value;
        const targetPort = parseInt(document.getElementById('m-pub-port').value, 10);
        await api('/api/proxy/publish', {
          method: 'POST',
          body: { projectId, domain, targetPort },
        });
        showToast('Dominio publicado exitosamente.', 'success');
        renderDeploymentsView();
      },
    });
  }

  // 6. Docker View (Optional)
  async function renderDockerView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Comprobando Docker Socket...</div>';

    try {
      const [statusRes, containersRes] = await Promise.all([
        api('/api/docker/status'),
        api('/api/docker/containers'),
      ]);

      content.innerHTML = `
        <div class="card" style="margin-bottom:24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <h3 style="font-size:16px;font-weight:600;">Integración Docker</h3>
            <span class="badge ${statusRes.available ? 'badge-success' : 'badge-muted'}">
              ${statusRes.available ? `v${statusRes.version}` : 'No disponible'}
            </span>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);">
            ${statusRes.available ? `Conectado a Docker Engine ${statusRes.version} (${statusRes.os}/${statusRes.arch})` : escapeHtml(statusRes.message)}
          </p>
        </div>

        <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">Contenedores en el Host</h3>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Nombre</th>
                <th>Imagen</th>
                <th>Estado</th>
                <th>Puertos</th>
              </tr>
            </thead>
            <tbody>
              ${(containersRes.containers || []).length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No hay contenedores disponibles o Docker está inactivo</td></tr>' : ''}
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
    content.innerHTML = '<div style="color:var(--text-secondary);">Cargando diagnóstico y registros de auditoría...</div>';

    try {
      const [nodeRes, auditRes] = await Promise.all([
        api('/api/system/node'),
        api('/api/audit?limit=25'),
      ]);

      const node = nodeRes.node;
      const logs = auditRes.logs || [];

      content.innerHTML = `
        <div class="card" style="margin-bottom:24px;">
          <h3 style="font-size:16px;font-weight:600;margin-bottom:14px;">Diagnóstico de Nodo</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:16px;font-size:13px;">
            <div>
              <span style="color:var(--text-muted);">Hostname:</span>
              <strong style="display:block;margin-top:2px;">${escapeHtml(node.hostname)}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Sistema Operativo:</span>
              <strong style="display:block;margin-top:2px;">${escapeHtml(node.platform)} ${escapeHtml(node.release)}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Node.js Runtime:</span>
              <strong style="display:block;margin-top:2px;color:var(--accent-color);">${escapeHtml(node.nodeVersion)}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted);">Tiempo Activo (Uptime):</span>
              <strong style="display:block;margin-top:2px;">${Math.round(node.uptimeSeconds / 3600)} horas</strong>
            </div>
          </div>
        </div>

        <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">Registro de Auditoría de Seguridad</h3>
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acción</th>
                <th>Usuario</th>
                <th>Objetivo</th>
                <th>Detalles</th>
              </tr>
            </thead>
            <tbody>
              ${logs.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No hay eventos de auditoría registrados</td></tr>' : ''}
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
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  // 8. Plugins View
  async function renderPluginsView() {
    const content = document.getElementById('main-content');
    content.innerHTML = '<div style="color:var(--text-secondary);">Cargando plugins...</div>';

    try {
      const res = await api('/api/plugins');
      const plugins = res.plugins || [];

      content.innerHTML = `
        <div style="margin-bottom:24px;">
          <h2 style="font-size:18px;margin-bottom:6px;">Plugins y Extensiones Modulares</h2>
          <p style="color:var(--text-secondary);">
            Citadel carga plugins desde el directorio <code>plugins/</code> basados en el estándar <code>plugin.json</code>.
          </p>
        </div>

        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nombre / ID</th>
                <th>Versión</th>
                <th>Capacidades</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              ${plugins.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No hay plugins instalados</td></tr>' : ''}
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
                      ${p.enabled ? 'Deshabilitar' : 'Habilitar'}
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
          showToast(`Plugin ${!isCurrentlyEnabled ? 'habilitado' : 'deshabilitado'}.`, 'success');
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
