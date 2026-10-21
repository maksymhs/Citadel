/**
 * Fleet: manage and control remote Citadel instances (legacy URL + token hosts) and the dashboard fleet rows
 * Loaded before app.js; app.js passes the shared helpers in through init(), so
 * this file does not reach into app.js internals.
 */
(function () {
  'use strict';

  let api, escapeHtml, navigateTo, openModal, showToast, state;

  const REQUIRED = ['api', 'escapeHtml', 'navigateTo', 'openModal', 'showToast', 'state'];

  function init(ctx) {
    const missing = REQUIRED.filter((k) => ctx[k] === undefined);
    if (missing.length) throw new Error(`fleet.js: app.js did not provide ${missing.join(', ')}`);
    ({ api, escapeHtml, navigateTo, openModal, showToast, state } = ctx);
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

  window.CitadelFleet = { init, renderFleetView, refreshDashboardFleet, fleetUpdateAll };
})();
