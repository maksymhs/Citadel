/**
 * Deployments and Docker: domain publishing (Caddy) and container inspection screens
 * Loaded before app.js; app.js passes the shared helpers in through init(), so
 * this file does not reach into app.js internals.
 */
(function () {
  'use strict';

  let api, escapeHtml, openModal, showToast, state;

  const REQUIRED = ['api', 'escapeHtml', 'openModal', 'showToast', 'state'];

  function init(ctx) {
    const missing = REQUIRED.filter((k) => ctx[k] === undefined);
    if (missing.length) throw new Error(`deployments.js: app.js did not provide ${missing.join(', ')}`);
    ({ api, escapeHtml, openModal, showToast, state } = ctx);
  }

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
  function connectSourceNote(source, url = '') {
    if (source === 'tunnel' && url && !/\.trycloudflare\.com(\/|$)/i.test(url)) {
      return 'Cloudflare Tunnel on your own domain — works from anywhere and the address is stable across restarts.';
    }
    return {
      configured: 'Using the public URL configured in Settings — works from anywhere it points to.',
      tunnel: 'Public Cloudflare Quick Tunnel — works from anywhere. The URL changes when the tunnel restarts.',
      tailscale: 'Reachable from anywhere over your Tailscale network. Install Tailscale on the phone and sign in to the same account.',
      lan: '<span style="color:var(--warning-color);">This is a LAN address — it only works on the same Wi-Fi.</span> For access from anywhere, run <code>citadel tunnel</code> (public, one command) or set up Tailscale (<code>tailscale serve</code>).',
      localhost: '<span style="color:var(--warning-color);">Only reachable on this machine.</span> Run <code>citadel tunnel</code> or set up Tailscale for remote access.',
    }[source] || '';
  }

  // 7. Settings View (host tools: public URL, connection, modules, updates, diagnostics)
  // Settings is a hub of tiles; each tile opens a secondary screen. The back
  // button in the top bar returns to the hub.

  window.CitadelDeployments = { init, renderDeploymentsView, renderDockerView, connectSourceNote };
})();
