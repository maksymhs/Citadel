/**
 * Machines: live health of every paired machine, alerts, history and quick
 * actions (open, logs, restart). Loaded before app.js; app.js passes the
 * shared helpers in, so this file does not depend on app.js internals.
 */
(function () {
  'use strict';

  let refreshTimer = null;

  const ALERT_LABELS = {
    offline: 'Offline',
    disk: 'Disk full',
    memory: 'Memory',
    load: 'CPU load',
  };

  function fmtDuration(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtAgo(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${fmtDuration(s)} ago`;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function levelClass(value, warn, crit) {
    if (value === null || value === undefined) return 'mon-lvl-none';
    if (value >= crit) return 'mon-lvl-crit';
    if (value >= warn) return 'mon-lvl-warn';
    return 'mon-lvl-ok';
  }

  function remotePath(host, apiPath) {
    // apiPath is like "/system/logs"; the proxy mirrors the remote /api tree.
    return host.isLocal ? `/api${apiPath}` : `/api/remote/${encodeURIComponent(host.id)}${apiPath}`;
  }

  function statusOf(h) {
    if (h.online === true) return h.alerts.length ? 'warn' : 'ok';
    if (h.online === false) return 'down';
    return 'unknown';
  }

  function alertsHtml(alerts, ctx) {
    if (!alerts.length) return '';
    const esc = ctx.escapeHtml;
    return `<div class="mon-alerts">
      ${alerts.map((a) => `<div class="mon-alert mon-alert-${esc(a.severity)}">
        <strong>${esc(a.label)}</strong>
        <span>${esc(a.message)}</span>
        <span class="mon-muted">${esc(fmtAgo(a.since))}</span>
      </div>`).join('')}
    </div>`;
  }

  // Donut gauge: the ring fills with the value and takes the level colour.
  function ring(esc, label, value, warn, crit) {
    const v = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
    const c = 2 * Math.PI * 18;
    const dash = v === null ? 0 : (v / 100) * c;
    return `<div class="mon-ring ${levelClass(v, warn, crit)}" title="${esc(label)} ${v === null ? 'n/a' : `${v}%`}">
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle class="mon-ring-bg" cx="22" cy="22" r="18"/>
        <circle class="mon-ring-fg" cx="22" cy="22" r="18" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 22 22)"/>
      </svg>
      <strong>${v === null ? '—' : v}<small>${v === null ? '' : '%'}</small></strong>
      <span>${esc(label)}</span>
    </div>`;
  }

  function miniCardHtml(h, ctx) {
    const esc = ctx.escapeHtml;
    const status = statusOf(h);
    const dot = status === 'ok' ? 'host-dot-on' : status === 'down' ? 'host-dot-off' : status === 'warn' ? 'mon-dot-warn' : '';
    const hl = h.health;
    const chips = h.alerts.map((k) => `<span class="badge ${k === 'offline' ? 'badge-danger' : 'badge-warning'}">${esc(ALERT_LABELS[k] || k)}</span>`).join('');
    let body;
    if (h.online === false) {
      body = `<div class="mon-mini-down"><strong>Offline</strong><span>since ${esc(fmtAgo(h.since))}</span></div>`;
    } else if (!hl) {
      body = `<div class="mon-mini-down mon-muted">${h.online ? 'Online — update this machine for live metrics' : 'Checking…'}</div>`;
    } else {
      const load = Math.min(100, Math.round((hl.loadPerCore || 0) * 100));
      body = `<div class="mon-rings">
        ${ring(esc, 'CPU', load, 70, 100)}
        ${ring(esc, 'RAM', hl.memory && hl.memory.usedPercent, 80, 95)}
        ${ring(esc, 'Disk', hl.disk && hl.disk.usedPercent, 80, 90)}
      </div>`;
    }
    const foot = [
      hl ? `⏱ ${fmtDuration(hl.uptimeSeconds)}` : null,
      h.latencyMs !== null && !h.isLocal ? `⇄ ${h.latencyMs} ms` : null,
      h.version ? `v${h.version}` : null,
    ].filter(Boolean).map(esc).join(' · ');
    return `<button type="button" class="mon-mini-card mon-${status}${h.id === ctx.activeHostId() ? ' active' : ''}" data-mon-machine="${esc(h.id)}" title="Open ${esc(h.name)}">
      <span class="mon-mini-inner">
        <span class="mon-mini-info">
          <span class="mon-mini-head">
            <span class="host-dot ${dot}"></span>
            <strong>${esc(h.name)}</strong>
            ${h.isLocal ? '<span class="mon-tag">this machine</span>' : ''}
            <span class="mon-chips">${chips}</span>
          </span>
          <span class="mon-mini-foot">${foot || '&nbsp;'}</span>
        </span>
        ${body}
      </span>
    </button>`;
  }

  // --- Dashboard ------------------------------------------------------------

  async function renderWidget(ctx) {
    const body = document.getElementById('dash-machines-body');
    if (!body) return;
    clearInterval(refreshTimer);
    const draw = async () => {
      const target = document.getElementById('dash-machines-body');
      if (!target) { clearInterval(refreshTimer); return; }
      try {
        const data = await ctx.localApi('/api/monitor/overview');
        target.innerHTML = `${data.alerts.length ? alertsHtml(data.alerts.slice(0, 3), ctx) : ''}
          ${data.hosts.length ? `<div class="mon-mini-grid">${data.hosts.map((h) => miniCardHtml(h, ctx)).join('')}</div>`
    : '<div class="mon-muted">First check in progress…</div>'}`;
        target.querySelectorAll('[data-mon-machine]').forEach((el) => {
          el.onclick = () => ctx.openMachine(el.getAttribute('data-mon-machine'));
        });
      } catch (err) {
        target.innerHTML = `<div class="mon-muted">${ctx.escapeHtml(err.message)}</div>`;
      }
    };
    await draw();
    refreshTimer = setInterval(draw, 15000);
  }

  // Top-bar actions of the dashboard (administrators only).
  function setupDashboardActions(ctx) {
    const actions = document.getElementById('top-bar-actions');
    if (!actions || !ctx.isAdmin) return;
    actions.innerHTML = `<button class="btn btn-secondary btn-sm" id="mon-alerts-btn">Alerts…</button>
      <button class="btn btn-secondary btn-sm" id="mon-refresh-btn">Check now</button>`;
    document.getElementById('mon-alerts-btn').onclick = () => showAlertSettings(ctx);
    document.getElementById('mon-refresh-btn').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await ctx.localApi('/api/monitor/refresh', { method: 'POST' });
        await renderWidget(ctx);
      } catch (err) {
        ctx.showToast(err.message, 'error');
      }
      btn.disabled = false;
    };
  }

  function spark(points, key, { max = 100, cls = '' } = {}) {
    const vals = points.map((p) => p[key]);
    if (vals.filter((v) => v !== null && v !== undefined).length < 2) return '<div class="mon-muted">Not enough data yet.</div>';
    const w = 300;
    const h = 44;
    const top = Math.max(max, ...vals.filter((v) => v !== null));
    const step = w / Math.max(1, points.length - 1);
    const path = vals.map((v, i) => (v === null || v === undefined ? null : `${(i * step).toFixed(1)},${(h - (v / top) * (h - 4) - 2).toFixed(1)}`))
      .filter(Boolean).join(' ');
    return `<svg class="mon-spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"><polyline fill="none" stroke="currentColor" stroke-width="1.6" points="${path}"/></svg>`;
  }

  function downBand(points) {
    if (!points.length) return '';
    return `<div class="mon-band">${points.map((p) => `<span class="${p.online === 1 ? 'up' : p.online === 0 ? 'down' : 'part'}" title="${new Date(p.ts).toLocaleString()}"></span>`).join('')}</div>`;
  }

  async function showLogs(host, ctx) {
    const { localApi, escapeHtml: esc } = ctx;
    ctx.openModal({
      title: `Logs — ${host.name}`,
      confirmText: 'Close',
      bodyHtml: '<pre class="mon-logs" id="mon-logs">Loading…</pre>',
    });
    try {
      const res = await localApi(`${remotePath(host, '/system/logs')}?lines=300`);
      const pre = document.getElementById('mon-logs');
      if (!pre) return;
      pre.innerHTML = `${esc(res.text || '(empty)')}`;
      pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      const pre = document.getElementById('mon-logs');
      if (pre) pre.textContent = err.message;
    }
  }

  function confirmRestart(host, ctx, onChange) {
    const { localApi, escapeHtml: esc, showToast } = ctx;
    ctx.openModal({
      title: `Restart Citadel on ${host.name}?`,
      confirmText: 'Restart',
      bodyHtml: `<p>The Citadel service on <strong>${esc(host.name)}</strong> restarts and is unreachable for a few seconds.
        Persistent terminals keep running.${host.isLocal ? ' This page reloads itself afterwards.' : ''}</p>`,
      onConfirm: async () => {
        await localApi(remotePath(host, '/system/restart'), { method: 'POST' });
        showToast(`Restarting ${host.name}…`, 'success');
        if (host.isLocal) ctx.reloadWhenServerReady();
        else setTimeout(() => { if (typeof onChange === 'function') onChange(); }, 9000);
      },
    });
  }

  // --- Machine screen -------------------------------------------------------
  // Everything about one machine behind a single card: health, projects,
  // terminals, processes and tools. Data comes through the host proxy, so any
  // paired machine can be inspected without switching to it first.

  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'projects', label: 'Projects' },
    { id: 'terminals', label: 'Terminals' },
    { id: 'processes', label: 'Processes' },
    { id: 'tools', label: 'Tools' },
  ];
  let machineTab = 'overview';
  let machineTimer = null;

  // Renders the detail of one machine into the dashboard pane under the cards.
  async function renderMachine(ctx, hostId, tab, retry = true) {
    const { localApi, escapeHtml: esc } = ctx;
    const content = document.getElementById('dash-machine-pane');
    if (!content) return;
    clearInterval(machineTimer);
    if (tab) machineTab = tab;
    content.innerHTML = '<div id="mon-machine"><div class="mon-muted">Loading…</div></div>';

    let host;
    try {
      const data = await localApi('/api/monitor/overview');
      host = data.hosts.find((h) => h.id === hostId);
    } catch (err) {
      content.innerHTML = `<div style="color:var(--danger-color);">${esc(err.message)}</div>`;
      return;
    }
    if (!host) {
      // The first health check runs a few seconds after boot.
      content.innerHTML = '<div class="mon-muted">Waiting for the first health check…</div>';
      if (retry) setTimeout(() => { if (document.getElementById('dash-machine-pane')) renderMachine(ctx, hostId, undefined, false); }, 5000);
      return;
    }

    const status = statusOf(host);
    const dot = status === 'ok' ? 'host-dot-on' : status === 'down' ? 'host-dot-off' : status === 'warn' ? 'mon-dot-warn' : '';
    const offline = host.online === false;
    const root = document.getElementById('mon-machine');
    root.innerHTML = `
      <div class="card mon-machine-head">
        <span class="host-dot ${dot}"></span>
        <div class="mon-machine-title">
          <strong>${esc(host.name)}</strong>
          <span class="mon-muted">${host.isLocal ? 'This machine' : esc((host.address || '').replace(/^https?:\/\//, ''))}${host.version ? ` · v${esc(host.version)}` : ''}${offline ? ` · offline since ${esc(fmtAgo(host.since))}` : ''}</span>
        </div>
        <div class="mon-chips">${host.alerts.map((k) => `<span class="badge ${k === 'offline' ? 'badge-danger' : 'badge-warning'}">${esc(ALERT_LABELS[k] || k)}</span>`).join('')}</div>
        <div class="mon-actions mon-machine-actions">
          ${host.id === ctx.activeHostId() ? '' : `<button class="btn btn-primary btn-sm" id="mon-use-btn" ${offline ? 'disabled' : ''}>Work on this machine</button>`}
          ${ctx.isAdmin ? `<button class="btn btn-secondary btn-sm" id="mon-logs-btn" ${offline ? 'disabled' : ''}>Logs</button>
          <button class="btn btn-secondary btn-sm" id="mon-restart-btn" ${offline ? 'disabled' : ''}>Restart</button>` : ''}
        </div>
      </div>
      <div class="mon-tabs" role="tablist">
        ${TABS.map((t) => `<button type="button" role="tab" class="mon-tab${t.id === machineTab ? ' active' : ''}" data-mon-tab="${t.id}" ${offline && t.id !== 'overview' ? 'disabled' : ''}>${t.label}</button>`).join('')}
      </div>
      <div id="mon-tab-body"></div>`;

    document.getElementById('mon-use-btn')?.addEventListener('click', () => ctx.useMachine(host.id));
    document.getElementById('mon-logs-btn')?.addEventListener('click', () => showLogs(host, ctx));
    document.getElementById('mon-restart-btn')?.addEventListener('click', () => confirmRestart(host, ctx, () => renderMachine(ctx, hostId, undefined, false)));
    root.querySelectorAll('[data-mon-tab]').forEach((b) => {
      b.onclick = () => renderMachine(ctx, hostId, b.getAttribute('data-mon-tab'), false);
    });

    const body = document.getElementById('mon-tab-body');
    const loading = () => { body.innerHTML = '<div class="mon-muted">Loading…</div>'; };
    const fail = (err) => { body.innerHTML = `<div style="color:var(--danger-color);">${esc(err.message)}</div>`; };
    const tabId = offline ? 'overview' : machineTab;

    if (tabId === 'overview') {
      loading();
      try {
        const hist = await localApi(`/api/monitor/hosts/${encodeURIComponent(host.id)}/history?hours=24`);
        const hl = host.health;
        const load = hl ? Math.min(100, Math.round((hl.loadPerCore || 0) * 100)) : null;
        const events = (hist.events || []).slice(0, 8);
        body.innerHTML = `
          ${hl ? `<div class="card mon-overview-rings">
            ${ring(esc, 'CPU', load, 70, 100)}
            ${ring(esc, 'Memory', hl.memory && hl.memory.usedPercent, 80, 95)}
            ${ring(esc, 'Disk', hl.disk && hl.disk.usedPercent, 80, 90)}
            <div class="mon-facts">
              <div><span>Uptime</span><strong>${esc(fmtDuration(hl.uptimeSeconds))}</strong></div>
              <div><span>Load (1m)</span><strong>${esc(String(hl.load1))}</strong></div>
              <div><span>Cores</span><strong>${esc(String(hl.cores))}</strong></div>
              ${hl.disk ? `<div><span>Disk size</span><strong>${esc(fmtBytes(hl.disk.totalBytes))}</strong></div>` : ''}
              ${host.latencyMs !== null && !host.isLocal ? `<div><span>Latency</span><strong>${host.latencyMs} ms</strong></div>` : ''}
              <div><span>Terminals</span><strong>${esc(String(hl.activeTerminals ?? 0))}</strong></div>
            </div>
          </div>` : `<div class="card mon-muted">${offline ? esc(host.error || 'Not responding.') : 'No detailed metrics: update this machine to see load, memory and disk.'}</div>`}
          <div class="card">
            <div class="mon-detail-grid">
              <div><div class="mon-muted">Availability 24h</div><strong>${hist.uptime === null ? '—' : `${hist.uptime}%`}</strong></div>
              <div><div class="mon-muted">Availability 7d</div><strong>${host.uptime7d === null ? '—' : `${host.uptime7d}%`}</strong></div>
              <div><div class="mon-muted">Version</div><strong>${esc(host.version || '—')}</strong></div>
            </div>
            ${downBand(hist.points)}
            <div class="mon-charts">
              <div><div class="mon-muted">Memory %</div>${spark(hist.points, 'memPercent')}</div>
              <div><div class="mon-muted">Disk %</div>${spark(hist.points, 'diskPercent')}</div>
              <div><div class="mon-muted">CPU load / core</div>${spark(hist.points, 'loadPerCore', { max: 1 })}</div>
              ${host.isLocal ? '' : `<div><div class="mon-muted">Latency ms</div>${spark(hist.points, 'latencyMs', { max: 100 })}</div>`}
            </div>
          </div>
          <div class="card">
            <div class="mon-muted" style="margin-bottom:6px;">Recent incidents</div>
            ${events.length ? `<ul class="mon-events">${events.map((e) => `<li><span class="mon-muted">${esc(new Date(e.ts).toLocaleString())}</span> ${esc(e.message || e.action)}</li>`).join('')}</ul>`
    : '<div class="mon-muted">None in the last 30 days.</div>'}
          </div>`;
      } catch (err) { fail(err); }
      return;
    }

    if (tabId === 'projects') {
      loading();
      try {
        const res = await localApi(remotePath(host, '/projects'));
        const list = res.projects || [];
        body.innerHTML = `<div class="card">
          <div class="mon-tab-toolbar"><span class="mon-muted">${list.length} project${list.length === 1 ? '' : 's'}</span>
            <button class="btn btn-secondary btn-sm" id="mon-manage-projects">Manage projects</button></div>
          ${list.length === 0 ? '<div class="mon-muted">No projects on this machine yet.</div>' : `<div class="mon-rows">
            ${list.map((p) => `<div class="mon-row">
              <div class="mon-row-main"><strong>${esc(p.name)}</strong>
                <span class="mon-muted mon-ellipsis">${esc(p.path)}</span></div>
              ${p.active_sessions_count > 0 ? `<span class="badge badge-success">${p.active_sessions_count} terminal${p.active_sessions_count === 1 ? '' : 's'}</span>` : ''}
              <button class="btn btn-primary btn-sm" data-mon-open-project="${esc(p.id)}">Open</button>
            </div>`).join('')}</div>`}
        </div>`;
        document.getElementById('mon-manage-projects').onclick = () => ctx.useMachine(host.id, 'projects');
        body.querySelectorAll('[data-mon-open-project]').forEach((b) => {
          b.onclick = () => ctx.openProject(host.id, b.getAttribute('data-mon-open-project'));
        });
      } catch (err) { fail(err); }
      return;
    }

    if (tabId === 'terminals') {
      const load = async () => {
        try {
          const [t, pr] = await Promise.all([
            localApi(remotePath(host, '/terminals')),
            localApi(remotePath(host, '/projects')).catch(() => ({ projects: [] })),
          ]);
          const names = new Map((pr.projects || []).map((p) => [p.id, p.name]));
          const list = (t.sessions || []).filter((x) => x.isAlive || x.status === 'active');
          body.innerHTML = `<div class="card">
            <div class="mon-tab-toolbar">
              <span class="mon-muted">${list.length} persistent terminal${list.length === 1 ? '' : 's'} — they keep running when you close the browser</span>
              <button class="btn btn-danger btn-sm" id="mon-kill-selected" disabled>Kill selected</button>
            </div>
            ${list.length === 0 ? '<div class="mon-muted">No persistent terminals are running.</div>' : `
            <label class="mon-selectall"><input type="checkbox" id="mon-term-all"> Select all</label>
            <div class="mon-rows">${list.map((x) => `<label class="mon-row">
              <input type="checkbox" class="mon-term-check" value="${esc(x.id)}">
              <div class="mon-row-main"><strong>${esc(x.name)}</strong>
                <span class="mon-muted">${esc(x.project_id ? (names.get(x.project_id) || 'Unknown project') : 'System')} · started ${esc(new Date(x.created_at).toLocaleString())}</span></div>
              <span class="badge ${x.isAlive ? 'badge-success' : 'badge-danger'}">${x.isAlive ? 'running' : 'dead'}</span>
            </label>`).join('')}</div>`}
          </div>`;
          const checks = () => Array.from(body.querySelectorAll('.mon-term-check'));
          const kill = document.getElementById('mon-kill-selected');
          const sync = () => {
            const n = checks().filter((c) => c.checked).length;
            kill.disabled = n === 0;
            kill.textContent = n ? `Kill selected (${n})` : 'Kill selected';
          };
          checks().forEach((c) => { c.onchange = sync; });
          document.getElementById('mon-term-all')?.addEventListener('change', (e) => {
            checks().forEach((c) => { c.checked = e.target.checked; });
            sync();
          });
          kill.onclick = () => {
            const ids = checks().filter((c) => c.checked).map((c) => c.value);
            if (!ids.length) return;
            ctx.openModal({
              title: `Kill ${ids.length} terminal${ids.length === 1 ? '' : 's'}?`,
              confirmText: 'Kill',
              bodyHtml: '<p>This ends the selected terminals and everything running inside them. It cannot be undone.</p>',
              onConfirm: async () => {
                for (const id of ids) {
                  ctx.forgetTerminal(host.id, id);
                  await localApi(remotePath(host, `/terminals/${encodeURIComponent(id)}`), { method: 'DELETE' }).catch(() => {});
                }
                ctx.showToast(`${ids.length} terminal${ids.length === 1 ? '' : 's'} killed.`, 'success');
                load();
              },
            });
          };
        } catch (err) { fail(err); }
      };
      loading();
      await load();
      return;
    }

    if (tabId === 'processes') {
      const load = async () => {
        if (!document.getElementById('mon-proc-body') && body.dataset.ready) { clearInterval(machineTimer); return; }
        try {
          const res = await localApi(remotePath(host, '/system/processes?limit=15'));
          const d = res.processes || {};
          const rows = d.processes || [];
          if (!body.dataset.ready) {
            body.dataset.ready = '1';
            body.innerHTML = `<div class="card">
              <div class="mon-tab-toolbar"><span class="mon-muted" id="mon-proc-meta"></span><span class="mon-muted">Updates every 5 s</span></div>
              <div class="table-container"><table class="data-table"><thead><tr>
                <th style="width:80px;">PID</th><th>Process</th><th style="width:90px;">CPU</th><th style="width:110px;">Memory</th><th style="width:80px;">MEM %</th>
              </tr></thead><tbody id="mon-proc-body"></tbody></table></div></div>`;
          }
          document.getElementById('mon-proc-body').innerHTML = rows.length ? rows.map((x) => `<tr>
              <td data-label="PID" style="font-family:var(--font-mono);color:var(--text-secondary);">${x.pid}</td>
              <td data-label="Process">${esc(x.name)}</td>
              <td data-label="CPU"><span class="badge ${x.cpuPercent >= 50 ? 'badge-danger' : x.cpuPercent >= 10 ? 'badge-warning' : 'badge-muted'}">${x.cpuPercent.toFixed(1)}%</span></td>
              <td data-label="Memory" style="font-family:var(--font-mono);">${esc(fmtBytes(x.rssBytes))}</td>
              <td data-label="MEM %" style="font-family:var(--font-mono);color:var(--text-secondary);">${x.memPercent.toFixed(1)}%</td>
            </tr>`).join('') : '<tr><td colspan="5" class="mon-muted">No process data on this platform.</td></tr>';
          const meta = document.getElementById('mon-proc-meta');
          if (meta) meta.textContent = `${rows.length} of ${d.total} processes · ${new Date(d.timestamp).toLocaleTimeString()}`;
        } catch (err) { fail(err); clearInterval(machineTimer); }
      };
      loading();
      await load();
      machineTimer = setInterval(() => { if (!document.hidden) load(); }, 5000);
      return;
    }

    if (tabId === 'tools') {
      loading();
      try {
        const res = await localApi(remotePath(host, '/system/integrations'));
        const integ = res.integrations || {};
        const chip = (name, ok, hint) => `<div class="mon-tool ${ok ? 'on' : 'off'}" title="${esc(hint || '')}"><span class="status-dot ${ok ? 'ok' : 'off'}"></span>${esc(name)}</div>`;
        body.innerHTML = `
          <div class="card">
            <div class="mon-muted" style="margin-bottom:8px;">Platform</div>
            <div class="mon-tools">
              ${chip('tmux', integ.tmux && integ.tmux.available, integ.tmux && integ.tmux.description)}
              ${chip('Git', integ.git && integ.git.available, integ.git && integ.git.description)}
              ${chip('Caddy', integ.caddy && integ.caddy.available, integ.caddy && integ.caddy.helpMessage)}
              ${chip('Docker', integ.docker && integ.docker.available, '')}
            </div>
          </div>
          <div class="card">
            <div class="mon-muted" style="margin-bottom:8px;">AI coding agents</div>
            <div class="mon-rows">
              ${(integ.agents || []).map((a) => `<div class="mon-row">
                <span class="status-dot ${a.available ? 'ok' : 'off'}"></span>
                <div class="mon-row-main"><strong>${esc(a.name)}</strong>${a.version ? `<span class="mon-muted">${esc(a.version)}</span>` : ''}</div>
                ${a.available ? '<span class="badge badge-success">Installed</span>'
    : `<button class="btn btn-secondary btn-sm" data-mon-install="${esc(a.id)}" data-name="${esc(a.name)}" ${ctx.isAdmin ? '' : 'disabled'}>Install</button>`}
              </div>`).join('')}
            </div>
          </div>`;
        body.querySelectorAll('[data-mon-install]').forEach((b) => {
          b.onclick = () => ctx.installAgent(host.id, b.getAttribute('data-mon-install'), b.getAttribute('data-name'));
        });
      } catch (err) { fail(err); }
    }
  }

  // --- Alert settings -------------------------------------------------------

  async function showAlertSettings(ctx) {
    const { localApi, escapeHtml: esc, showToast } = ctx;
    let cfg;
    try {
      cfg = (await localApi('/api/monitor/config')).config;
    } catch (err) {
      showToast(err.message, 'error');
      return;
    }
    const ch = cfg.channels;
    const secretHint = (c) => (c.set ? `Configured (${esc(c.label || 'hidden')}) — leave blank to keep` : '');
    ctx.openModal({
      title: 'Alerts',
      confirmText: 'Save',
      bodyHtml: `
        <p class="mon-muted" style="margin-bottom:12px;">This Citadel watches the machines paired with it. To be told when <em>this</em> machine goes down, set up alerts on another machine too.</p>
        <label class="mon-field"><input type="checkbox" id="mon-cfg-enabled" ${cfg.enabled ? 'checked' : ''}/> Alerts enabled</label>
        <div class="mon-field-row">
          <label class="mon-field">Disk ≥ %<input type="number" class="form-input" id="mon-cfg-disk" min="50" max="99" value="${cfg.thresholds.diskPercent}"/></label>
          <label class="mon-field">Memory ≥ %<input type="number" class="form-input" id="mon-cfg-mem" min="50" max="99" value="${cfg.thresholds.memPercent}"/></label>
          <label class="mon-field">CPU load per core ≥<input type="number" step="0.1" class="form-input" id="mon-cfg-load" min="0.5" max="20" value="${cfg.thresholds.loadPerCore}"/></label>
        </div>
        <div class="mon-muted" style="margin:6px 0 10px;">A machine is reported offline after two failed checks in a row. Notifications are sent once when an alert starts and once when it recovers.</div>
        <label class="mon-field">Webhook URL (Slack, Discord, anything that accepts JSON)
          <input type="url" class="form-input" id="mon-cfg-webhook" placeholder="${secretHint(ch.webhook) || 'https://…'}" autocomplete="off"/></label>
        <label class="mon-field">ntfy topic URL
          <input type="url" class="form-input" id="mon-cfg-ntfy" placeholder="${secretHint(ch.ntfy) || 'https://ntfy.sh/your-topic'}" autocomplete="off"/></label>
        <div class="mon-field-row">
          <label class="mon-field">Telegram bot token
            <input type="password" class="form-input" id="mon-cfg-tgtoken" placeholder="${ch.telegram.set ? 'Configured — leave blank to keep' : '123456:ABC…'}" autocomplete="off"/></label>
          <label class="mon-field">Telegram chat id
            <input type="text" class="form-input" id="mon-cfg-tgchat" value="${esc(ch.telegram.chatId || '')}" placeholder="12345678"/></label>
        </div>
        <div class="mon-muted">Secrets are stored encrypted and never shown again. Leave a field blank to keep its current value.</div>
        <div class="mon-actions" style="margin-top:8px;">
          <button class="btn btn-secondary btn-sm" id="mon-test-btn">Save &amp; send test</button>
          <button class="btn btn-secondary btn-sm" id="mon-clear-btn">Remove all channels</button>
        </div>`,
      onConfirm: async () => { await save(false); showToast('Alert settings saved.', 'success'); },
    });

    const val = (id) => document.getElementById(id).value.trim();
    const payload = (clear) => {
      const channels = {};
      if (clear) {
        Object.assign(channels, { webhook: '', ntfy: '', telegramToken: '', telegramChatId: '' });
      } else {
        // Blank secret fields mean "keep what is stored" (field left out).
        if (val('mon-cfg-webhook')) channels.webhook = val('mon-cfg-webhook');
        if (val('mon-cfg-ntfy')) channels.ntfy = val('mon-cfg-ntfy');
        if (val('mon-cfg-tgtoken')) channels.telegramToken = val('mon-cfg-tgtoken');
        channels.telegramChatId = val('mon-cfg-tgchat');
      }
      return {
        enabled: document.getElementById('mon-cfg-enabled').checked,
        thresholds: {
          diskPercent: Number(val('mon-cfg-disk')),
          memPercent: Number(val('mon-cfg-mem')),
          loadPerCore: Number(val('mon-cfg-load')),
        },
        channels,
      };
    };
    const save = (clear) => localApi('/api/monitor/config', { method: 'PUT', body: payload(clear) });

    document.getElementById('mon-test-btn').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        await save(false);
        const res = await localApi('/api/monitor/test', { method: 'POST' });
        if (!res.results.length) showToast('No channel configured yet.', 'info');
        else {
          const bad = res.results.filter((r) => !r.ok);
          if (bad.length) showToast(`Failed: ${bad.map((r) => `${r.channel} (${r.error})`).join(', ')}`, 'error');
          else showToast(`Test sent to ${res.results.map((r) => r.channel).join(', ')}.`, 'success');
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
      const btn = document.getElementById('mon-test-btn');
      if (btn) btn.disabled = false;
    };
    document.getElementById('mon-clear-btn').onclick = async () => {
      try {
        await save(true);
        showToast('All notification channels removed.', 'success');
        showAlertSettings(ctx);
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  }

  window.CitadelMonitor = { renderWidget, renderMachine, setupDashboardActions };
})();
