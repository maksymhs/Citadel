/**
 * Activity: operational events, service log, audit trail and the Logs and Metrics views
 * Loaded before app.js; app.js passes the shared helpers in through init(), so
 * this file does not reach into app.js internals.
 */
(function () {
  'use strict';

  let api, escapeHtml, hostApiPath, moduleEnabled, navigateTo, saveUiState, state;
  let requestGeneration = 0;

  const REQUIRED = ['api', 'escapeHtml', 'hostApiPath', 'moduleEnabled', 'navigateTo', 'saveUiState', 'state'];

  function init(ctx) {
    const missing = REQUIRED.filter((k) => ctx[k] === undefined);
    if (missing.length) throw new Error(`activity.js: app.js did not provide ${missing.join(', ')}`);
    ({ api, escapeHtml, hostApiPath, moduleEnabled, navigateTo, saveUiState, state } = ctx);
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

  function requestIsCurrent(tab) {
    const attempt = ++requestGeneration;
    const hostId = state.activeHostId, userId = state.user?.id, role = state.user?.role;
    return () => attempt === requestGeneration && state.currentView === 'activity'
      && (state.activityTab || 'activity') === tab && state.activeHostId === hostId
      && state.user?.id === userId && state.user?.role === role;
  }

  async function renderActivityView() {
    const content = document.getElementById('main-content');
    const actions = document.getElementById('top-bar-actions');
    const tab = ['audit', 'service'].includes(state.activityTab) ? state.activityTab : 'activity';

    actions.innerHTML = `
      <div class="segmented" role="tablist">
        <button class="seg-btn ${tab === 'activity' ? 'active' : ''}" data-activity-tab="activity" role="tab">Activity</button>
        <button class="seg-btn ${tab === 'audit' ? 'active' : ''}" data-activity-tab="audit" role="tab">Audit</button>
        <button class="seg-btn ${tab === 'service' ? 'active' : ''}" data-activity-tab="service" role="tab">Service log</button>
      </div>
      ${tab === 'service' ? '' : `<button class="btn btn-secondary btn-sm" id="logs-export-json">Export JSON</button>
      <button class="btn btn-secondary btn-sm" id="logs-export-csv">Export CSV</button>`}
      <button class="btn btn-secondary btn-sm" id="logs-refresh">Refresh</button>`;

    document.querySelectorAll('[data-activity-tab]').forEach((btn) => {
      btn.onclick = () => {
        state.activityTab = btn.getAttribute('data-activity-tab');
        saveUiState({ activityTab: state.activityTab });
        renderActivityView();
      };
    });
    document.getElementById('logs-export-json')?.addEventListener('click', () => exportLogs('json'));
    document.getElementById('logs-export-csv')?.addEventListener('click', () => exportLogs('csv'));
    document.getElementById('logs-refresh').onclick = () => (tab === 'audit' ? refreshAudit() : tab === 'service' ? refreshServiceLog() : refreshLogs());

    content.innerHTML = `<div style="color:var(--text-secondary);">Loading ${tab === 'audit' ? 'audit trail' : tab === 'service' ? 'service log' : 'activity'}…</div>`;
    if (tab === 'service') {
      await refreshServiceLog();
    } else if (tab === 'audit') {
      await refreshAudit();
    } else {
      await refreshLogs();
    }
  }

  // Tail of the Citadel service log on the active machine.
  async function refreshServiceLog() {
    const content = document.getElementById('main-content');
    if (!content) return;
    const present = requestIsCurrent('service');
    let res;
    try {
      res = await api('/api/system/logs?lines=500');
    } catch (err) {
      if (!present()) return;
      content.innerHTML = `<div style="color:var(--danger-color);">Failed to load the service log: ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (!present()) return;
    const sources = { journal: 'System journal', file: 'Log file', events: 'Panel events (no journal access)' };
    const lines = String(res.text || '').split('\n');
    state.serviceLogLines = lines;
    content.innerHTML = `
      <div class="act-toolbar">
        <div class="act-chips"><span class="act-count">${escapeHtml(sources[res.source] || res.source)} · last ${lines.length} lines</span></div>
        <div class="act-controls">
          <input type="search" class="form-input" id="service-log-search" placeholder="Filter lines…" autocomplete="off">
          <label class="act-live"><input type="checkbox" id="service-log-problems"> Errors &amp; warnings only</label>
        </div>
      </div>
      <div class="card"><pre class="mon-logs" id="service-log-text" style="max-height:none;height:calc(100vh - 270px);min-height:240px;"></pre></div>`;
    const pre = document.getElementById('service-log-text');
    const draw = () => {
      const q = document.getElementById('service-log-search').value.trim().toLowerCase();
      const problems = document.getElementById('service-log-problems').checked;
      const shown = state.serviceLogLines.filter((l) => (!q || l.toLowerCase().includes(q)) && (!problems || /error|warn|fail|fatal|exception|denied/i.test(l)));
      pre.innerHTML = shown.length ? shown.map((l) => {
        const cls = /error|fail|fatal|exception/i.test(l) ? 'log-err' : /warn|denied/i.test(l) ? 'log-warn' : '';
        return `<span class="${cls}">${escapeHtml(l)}</span>`;
      }).join('\n') : '(no lines match)';
      pre.scrollTop = pre.scrollHeight;
    };
    document.getElementById('service-log-search').oninput = draw;
    document.getElementById('service-log-problems').onchange = draw;
    draw();
  }

  async function refreshAudit() {
    const content = document.getElementById('main-content');
    if (!content) return;
    const present = requestIsCurrent('audit');
    try {
      const res = await api(`/api/audit?limit=${state.auditLimit || 100}`);
      if (!present()) return;
      state.auditLogs = res.logs || [];
    } catch (err) {
      if (!present()) return;
      content.innerHTML = `<div style="color:var(--danger-color);">Failed to load audit logs: ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderAuditContent();
  }

  function renderAuditContent() {
    const content = document.getElementById('main-content');
    const all = state.auditLogs || [];
    const needle = (state.auditSearch || '').trim().toLowerCase();
    const logs = all.filter((l) => !needle
      || `${l.user_id || ''} ${l.action || ''} ${l.target_type || ''} ${l.target_id || ''} ${l.ip || ''} ${typeof l.details === 'string' ? l.details : JSON.stringify(l.details || '')}`.toLowerCase().includes(needle));
    const sensitive = (a) => /delete|revoke|unpair|kill|restart|update|login_failed|secret|credential/i.test(a || '');

    content.innerHTML = `
      <div class="act-toolbar">
        <div class="act-chips"><span class="act-count">${logs.length} of ${all.length} recent events</span></div>
        <div class="act-controls">
          <input type="search" class="form-input" id="audit-search" placeholder="Search user, action, target, IP…" value="${escapeHtml(state.auditSearch || '')}" autocomplete="off">
          <select class="form-input" id="audit-limit" title="How many events to load">
            ${[100, 250, 500].map((n) => `<option value="${n}" ${state.auditLimit === n ? 'selected' : ''}>Last ${n}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="card act-feed">
        ${logs.length === 0 ? '<div class="mon-muted" style="padding:18px;text-align:center;">No audit events match.</div>' : logs.map((l, i) => {
    const details = l.details ? (typeof l.details === 'string' ? l.details : JSON.stringify(l.details, null, 2)) : '';
    return `<div class="act-item audit${details ? ' has-details' : ''}" data-act-i="${i}">
            <span class="act-dot ${sensitive(l.action) ? 'warn' : ''}"></span>
            <span class="act-time" title="${escapeHtml(new Date(l.created_at).toLocaleString())}">${escapeHtml(relativeTime(l.created_at))}</span>
            <span class="act-cat">${escapeHtml(l.user_id || 'system')}</span>
            <span class="act-msg"><b>${escapeHtml(l.action)}</b>${l.target_type ? ` <span class="mon-muted">${escapeHtml(l.target_type)}${l.target_id ? `: ${escapeHtml(String(l.target_id).slice(0, 12))}` : ''}</span>` : ''}</span>
            ${l.ip ? `<span class="act-node">${escapeHtml(l.ip)}</span>` : ''}
            ${details ? `<pre class="act-details" hidden>${escapeHtml(details)}</pre>` : ''}
          </div>`;
  }).join('')}
      </div>`;

    const search = document.getElementById('audit-search');
    search.oninput = () => {
      state.auditSearch = search.value;
      const pos = search.selectionStart;
      renderAuditContent();
      const again = document.getElementById('audit-search');
      again.focus();
      again.setSelectionRange(pos, pos);
    };
    document.getElementById('audit-limit').onchange = (e) => { state.auditLimit = Number(e.target.value); refreshAudit(); };
    content.querySelectorAll('.act-item.has-details').forEach((el) => {
      el.onclick = () => { el.querySelector('.act-details').hidden = !el.querySelector('.act-details').hidden; el.classList.toggle('open'); };
    });
  }

  function exportLogs(format, type = 'events') {
    const qs = new URLSearchParams({ type, format });
    if (state.logsFilter.level) qs.set('level', state.logsFilter.level);
    if (state.logsFilter.category) qs.set('category', state.logsFilter.category);
    const a = document.createElement('a');
    a.href = hostApiPath(`/api/logs/export?${qs.toString()}`);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const LOG_RANGES = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };

  async function refreshLogs() {
    const content = document.getElementById('main-content');
    if (!content) return;
    const present = requestIsCurrent('activity');
    const f = state.logsFilter;
    const since = new Date(Date.now() - (LOG_RANGES[f.range] || LOG_RANGES['24h'])).toISOString();
    const qs = new URLSearchParams({ since });
    if (f.level) qs.set('level', f.level);
    if (f.category) qs.set('category', f.category);
    qs.set('limit', String(f.limit || 200));
    // Metrics are an optional module; skip them (and never fail the view) when
    // the module is disabled. Events and summary stay available either way.
    const wantMetrics = moduleEnabled('metrics');
    try {
      const [ev, su, me] = await Promise.all([
        api(`/api/logs/events?${qs.toString()}`),
        api(`/api/logs/summary?since=${encodeURIComponent(since)}`),
        wantMetrics ? api('/api/logs/metrics?limit=120') : Promise.resolve({ metrics: [] }),
      ]);
      if (!present()) return;
      state.logsEvents = ev.events || [];
      state.logsMetrics = me.metrics || [];
      state.logsSummary = su.summary || null;
    } catch (err) {
      if (!present()) return;
      content.innerHTML = `<div style="color:var(--danger-color);">Failed to load logs: ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderLogsContent();
  }

  function relativeTime(ts) {
    const secs = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    if (!Number.isFinite(secs)) return '—';
    if (secs < 10) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
    return `${Math.round(secs / 86400)} d ago`;
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function logEventItem(ev, i) {
    const hasDetails = ev.details && (typeof ev.details !== 'object' || Object.keys(ev.details).length > 0);
    return `<div class="act-item act-${escapeHtml(ev.level)}${hasDetails ? ' has-details' : ''}" data-act-i="${i}">
      <span class="act-dot" title="${escapeHtml(ev.level)}"></span>
      <span class="act-time" title="${escapeHtml(new Date(ev.ts).toLocaleString())}">${escapeHtml(new Date(ev.ts).toLocaleTimeString())}</span>
      <span class="act-cat">${escapeHtml(ev.category || '')}</span>
      <span class="act-msg">${escapeHtml(ev.message || ev.action || '')}</span>
      ${ev.node ? `<span class="act-node">${escapeHtml(ev.node)}</span>` : ''}
      ${hasDetails ? `<pre class="act-details" hidden>${escapeHtml(typeof ev.details === 'string' ? ev.details : JSON.stringify(ev.details, null, 2))}</pre>` : ''}
    </div>`;
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
    const f = state.logsFilter;
    const metrics = state.logsMetrics || [];
    const totalEvents = (level.info || 0) + (level.warn || 0) + (level.error || 0) + (level.debug || 0);
    const categories = Array.from(new Set([...(s.eventsByCategory || []).map((c) => c.category), f.category].filter(Boolean))).sort();
    const needle = f.search.trim().toLowerCase();
    const events = (state.logsEvents || []).filter((ev) => !needle
      || `${ev.message || ''} ${ev.action || ''} ${ev.category || ''} ${ev.node || ''}`.toLowerCase().includes(needle));
    const last = (state.logsEvents || [])[0];

    const chip = (value, label, count, tone) => `<button type="button" class="act-chip${f.level === value ? ' active' : ''} ${tone}" data-act-level="${value}">${label}<b>${count}</b></button>`;

    // Group the (newest first) events by day.
    let feed = '';
    let currentDay = null;
    events.forEach((ev, i) => {
      const day = dayLabel(ev.ts);
      if (day !== currentDay) {
        currentDay = day;
        feed += `<div class="act-day">${escapeHtml(day)}</div>`;
      }
      feed += logEventItem(ev, i);
    });

    content.innerHTML = `
      <div class="act-stats">
        <div class="act-stat"><span>Events</span><strong>${totalEvents}</strong></div>
        <div class="act-stat ${level.error ? 'bad' : ''}"><span>Errors</span><strong>${level.error || 0}</strong></div>
        <div class="act-stat ${level.warn ? 'warn' : ''}"><span>Warnings</span><strong>${level.warn || 0}</strong></div>
        <div class="act-stat"><span>Last event</span><strong>${last ? escapeHtml(relativeTime(last.ts)) : '—'}</strong></div>
      </div>

      <div class="act-toolbar">
        <div class="act-chips">
          ${chip('', 'All', totalEvents, '')}
          ${chip('error', 'Errors', level.error || 0, 'bad')}
          ${chip('warn', 'Warnings', level.warn || 0, 'warn')}
          ${chip('info', 'Info', level.info || 0, '')}
        </div>
        <div class="act-controls">
          <input type="search" class="form-input" id="logs-search" placeholder="Search events…" value="${escapeHtml(f.search)}" autocomplete="off">
          <select class="form-input" id="logs-category-filter" title="Category">
            <option value="">All categories</option>
            ${categories.map((c) => `<option value="${escapeHtml(c)}" ${f.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
          <select class="form-input" id="logs-range" title="Time range">
            ${Object.keys(LOG_RANGES).map((r) => `<option value="${r}" ${f.range === r ? 'selected' : ''}>Last ${r === '1h' ? 'hour' : r === '24h' ? '24 hours' : '7 days'}</option>`).join('')}
          </select>
          <label class="act-live" title="Refresh every 5 seconds"><input type="checkbox" id="logs-live" ${f.live ? 'checked' : ''}> Live</label>
        </div>
      </div>

      <div class="card act-feed">
        ${events.length ? feed : `<div class="mon-muted" style="padding:18px;text-align:center;">No events match${f.level || f.category || needle ? ' these filters' : ' in this period'}.</div>`}
      </div>

      ${moduleEnabled('metrics') ? renderMetricsChart(metrics) : ''}
      ${s.slowestTasks && s.slowestTasks.length ? `<details class="act-more"><summary>Slowest tasks (${s.slowestTasks.length})</summary>${renderSlowTasks(s.slowestTasks)}</details>` : ''}
    `;

    content.querySelectorAll('[data-act-level]').forEach((b) => {
      b.onclick = () => { f.level = b.getAttribute('data-act-level'); refreshLogs(); };
    });
    document.getElementById('logs-category-filter').onchange = (e) => { f.category = e.target.value; refreshLogs(); };
    document.getElementById('logs-range').onchange = (e) => { f.range = e.target.value; refreshLogs(); };
    // Search filters what is already loaded, so it needs no round trip.
    const search = document.getElementById('logs-search');
    search.oninput = () => {
      f.search = search.value;
      const pos = search.selectionStart;
      renderLogsContent();
      const again = document.getElementById('logs-search');
      again.focus();
      again.setSelectionRange(pos, pos);
    };
    content.querySelectorAll('.act-item.has-details').forEach((el) => {
      el.onclick = () => { el.querySelector('.act-details').hidden = !el.querySelector('.act-details').hidden; el.classList.toggle('open'); };
    });
    document.getElementById('logs-live').onchange = (e) => {
      f.live = e.target.checked;
      syncLogsLive();
    };
    syncLogsLive();
  }

  // Keeps the 5 s refresh in step with the Live checkbox (the shared timer is
  // dropped whenever the user leaves the screen).
  function syncLogsLive() {
    if (state.dashboardTimer) { clearInterval(state.dashboardTimer); state.dashboardTimer = null; }
    if (!state.logsFilter.live) return;
    state.dashboardTimer = setInterval(() => {
      if (state.currentView !== 'activity' || state.activityTab !== 'activity' || document.hidden) return;
      refreshLogs();
    }, 5000);
  }

  // 5. Deployments & Proxy View (Caddy)

  window.CitadelActivity = { init, renderActivityView, bindActivityButtons };
})();
