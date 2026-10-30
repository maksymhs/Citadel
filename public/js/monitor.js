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

  // A dismissed alert stays hidden until that incident ends: the key includes
  // `since`, so the same condition firing again later is a new alert and shows.
  // Per-viewer convenience only, so it lives in localStorage and degrades to
  // "nothing dismissed" when storage is unavailable.
  const DISMISS_KEY = 'citadel.monitor.dismissedAlerts';

  function alertKey(a) {
    return `${a.id}@${a.since}`;
  }

  function readDismissed() {
    try {
      const list = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
      return new Set(Array.isArray(list) ? list : []);
    } catch {
      return new Set();
    }
  }

  function writeDismissed(keys) {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(keys)));
    } catch {
      // Storage blocked: the alert simply comes back on the next refresh.
    }
  }

  function dismissAlert(key) {
    const keys = readDismissed();
    keys.add(key);
    writeDismissed(keys);
  }

  // Forget dismissals of alerts that no longer exist so the list cannot grow.
  function pruneDismissed(alerts) {
    const live = new Set(alerts.map(alertKey));
    const keys = readDismissed();
    const kept = Array.from(keys).filter((k) => live.has(k));
    if (kept.length !== keys.size) writeDismissed(kept);
  }

  function alertsHtml(alerts, ctx) {
    if (!alerts.length) return '';
    const esc = ctx.escapeHtml;
    return `<div class="mon-alerts">
      ${alerts.map((a) => `<div class="mon-alert mon-alert-${esc(a.severity)}">
        <strong>${esc(a.label)}</strong>
        <span>${esc(a.message)}</span>
        <span class="mon-muted">${esc(fmtAgo(a.since))}</span>
        <button type="button" class="mon-alert-close" data-alert-key="${esc(alertKey(a))}" aria-label="Dismiss alert" title="Dismiss until it happens again">&times;</button>
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

  // --- Dashboard ------------------------------------------------------------

  // Cross-machine alerts strip. The machines themselves are chosen in the
  // selector; this only surfaces problems on any of them.
  async function renderWidget(ctx) {
    const body = document.getElementById('dash-machines-body');
    if (!body) return;
    clearInterval(refreshTimer);
    const draw = async () => {
      const target = document.getElementById('dash-machines-body');
      if (!target) { clearInterval(refreshTimer); return; }
      try {
        const data = await ctx.localApi('/api/monitor/overview');
        pruneDismissed(data.alerts);
        const dismissed = readDismissed();
        const visible = data.alerts.filter((a) => !dismissed.has(alertKey(a)));
        target.innerHTML = visible.length ? alertsHtml(visible.slice(0, 3), ctx) : '';
      } catch {
        target.innerHTML = '';
      }
    };
    body.onclick = (event) => {
      const btn = event.target.closest('.mon-alert-close');
      if (!btn) return;
      dismissAlert(btn.dataset.alertKey);
      draw();
    };
    await draw();
    refreshTimer = setInterval(draw, 15000);
  }

  // Filled sparkline for the gauge cards: line + soft gradient underneath,
  // coloured by the card's level through currentColor.
  function areaSpark(points, key, { max = 100 } = {}) {
    const vals = points.map((p) => p[key]);
    if (vals.filter((v) => v !== null && v !== undefined).length < 2) return '<div class="mon-spark-empty">Collecting data…</div>';
    const w = 300;
    const h = 56;
    const top = Math.max(max, ...vals.filter((v) => v !== null && v !== undefined));
    const step = w / Math.max(1, points.length - 1);
    const pts = vals
      .map((v, i) => (v === null || v === undefined ? null : [i * step, h - (v / top) * (h - 6) - 3]))
      .filter(Boolean);
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${pts[0][0].toFixed(1)},${h} ${line} ${pts[pts.length - 1][0].toFixed(1)},${h}`;
    return `<svg class="mon-area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-hidden="true">
      <polygon points="${area}" fill="currentColor" opacity="0.14"/>
      <polyline fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${line}"/>
    </svg>`;
  }

  function levelLabel(cls) {
    return { 'mon-lvl-ok': 'Healthy', 'mon-lvl-warn': 'Elevated', 'mon-lvl-crit': 'Critical', 'mon-lvl-none': 'No data' }[cls];
  }

  // One metric card: ring, status pill, human detail line and 24h trend.
  function gaugeCard(esc, { label, value, warn, crit, detail, points, key, max }) {
    const v = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
    const cls = levelClass(v, warn, crit);
    const action = { loadPerCore: 'cpu', memPercent: 'memory', diskPercent: 'disk' }[key];
    return `<button type="button" class="card mon-gauge mon-metric-link ${cls}" data-metric="${action}">
      <div class="mon-gauge-top">
        ${ring(esc, label, v, warn, crit)}
        <div class="mon-gauge-meta">
          <span class="mon-gauge-label">${esc(label)}</span>
          <span class="mon-pill">${esc(levelLabel(cls))}</span>
          <span class="mon-gauge-detail">${esc(detail || '')}</span>
        </div>
      </div>
      <div class="mon-gauge-trend">${areaSpark(points, key, { max })}<span class="mon-muted">last 24 h</span></div>
    </button>`;
  }

  function kpiTile(esc, label, value, sub, tone, action) {
    const tag = action ? 'button' : 'div';
    return `<${tag}${action ? ` type="button" data-metric="${action}"` : ''} class="mon-kpi${tone ? ` mon-kpi-${tone}` : ''}${action ? ' mon-metric-link' : ''}">
      <span class="mon-kpi-label">${esc(label)}</span>
      <strong class="mon-kpi-value">${esc(String(value))}</strong>
      ${sub ? `<span class="mon-kpi-sub">${esc(sub)}</span>` : ''}
    </${tag}>`;
  }

  function uptimeTone(p) {
    if (p === null || p === undefined) return '';
    return p >= 99 ? 'ok' : p >= 95 ? 'warn' : 'crit';
  }

  function downBand(points) {
    if (!points.length) return '';
    return `<div class="mon-band">${points.map((p) => `<span class="${p.online === 1 ? 'up' : p.online === 0 ? 'down' : 'part'}" title="${new Date(p.ts).toLocaleString()}"></span>`).join('')}</div>`;
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
  // Dashboard shows health and history only. Runtime management lives in System.

  let machineGeneration = 0;

  // Renders the detail of one machine into the dashboard pane under the cards.
  async function renderMachine(ctx, hostId, tab, retry = true) {
    const { localApi, escapeHtml: esc } = ctx;
    const content = document.getElementById('dash-machine-pane');
    if (!content) return;
    const attempt = ++machineGeneration;
    const present = () => content.isConnected && attempt === machineGeneration;
    content.innerHTML = '<div id="mon-machine"><div class="mon-muted">Loading…</div></div>';

    let host;
    try {
      const data = await localApi('/api/monitor/overview');
      if (!present()) return;
      host = data.hosts.find((h) => h.id === hostId);
    } catch (err) {
      if (present()) content.innerHTML = `<div style="color:var(--danger-color);">${esc(err.message)}</div>`;
      return;
    }
    if (!host) {
      // The first health check runs a few seconds after boot.
      content.innerHTML = '<div class="mon-muted">Waiting for the first health check…</div>';
      if (retry) setTimeout(() => { if (present()) renderMachine(ctx, hostId, undefined, false); }, 5000);
      return;
    }

    const status = statusOf(host);
    const dot = status === 'ok' ? 'host-dot-on' : status === 'down' ? 'host-dot-off' : status === 'warn' ? 'mon-dot-warn' : '';
    const offline = host.online === false;
    const root = content.querySelector('#mon-machine');
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
          ${ctx.isAdmin ? `<button class="btn btn-secondary btn-sm" id="mon-rename-btn" title="Rename this machine">Rename</button>
          <button class="btn btn-secondary btn-sm" id="mon-logs-btn" ${offline ? 'disabled' : ''}>Logs</button>
          <button class="btn btn-secondary btn-sm" id="mon-restart-btn" ${offline ? 'disabled' : ''}>Restart</button>` : ''}
        </div>
      </div>
      <div id="mon-machine-body"></div>`;

    document.getElementById('mon-use-btn')?.addEventListener('click', () => ctx.useMachine(host.id));
    document.getElementById('mon-rename-btn')?.addEventListener('click', () => ctx.renameMachine(host.id));
    document.getElementById('mon-logs-btn')?.addEventListener('click', () => ctx.openLogs());
    document.getElementById('mon-restart-btn')?.addEventListener('click', () => confirmRestart(host, ctx, () => renderMachine(ctx, hostId, undefined, false)));

    const body = root.querySelector('#mon-machine-body');
    const loading = () => { body.innerHTML = '<div class="mon-muted">Loading…</div>'; };
    const fail = (err) => { if (present()) body.innerHTML = `<div style="color:var(--danger-color);">${esc(err.message)}</div>`; };
    loading();
    try {
      const hist = await localApi(`/api/monitor/hosts/${encodeURIComponent(host.id)}/history?hours=24`);
      if (!present()) return;
      const hl = host.health;
      const load = hl ? Math.min(100, Math.round((hl.loadPerCore || 0) * 100)) : null;
      const events = (hist.events || []).slice(0, 8);
      const mem = hl && hl.memory;
      const dsk = hl && hl.disk;
      const memDetail = mem && Number.isFinite(mem.totalBytes)
        ? `${fmtBytes(Number.isFinite(mem.usedBytes) ? mem.usedBytes : (mem.totalBytes * (mem.usedPercent || 0)) / 100)} of ${fmtBytes(mem.totalBytes)} in use`
        : '';
      const dskDetail = dsk && Number.isFinite(dsk.totalBytes)
        ? `${fmtBytes(Number.isFinite(dsk.freeBytes) ? dsk.freeBytes : dsk.totalBytes * (1 - (dsk.usedPercent || 0) / 100))} free of ${fmtBytes(dsk.totalBytes)}`
        : '';
      const cpuDetail = hl ? `Load ${hl.load1} · ${hl.cores} core${hl.cores === 1 ? '' : 's'}` : '';
      const av24 = hist.uptime;
      const av7 = host.uptime7d;
      body.innerHTML = `
        ${hl ? `<div class="mon-gauges">
          ${gaugeCard(esc, { label: 'CPU', value: load, warn: 70, crit: 100, detail: cpuDetail, points: hist.points, key: 'loadPerCore', max: 1 })}
          ${gaugeCard(esc, { label: 'Memory', value: mem && mem.usedPercent, warn: 80, crit: 95, detail: memDetail, points: hist.points, key: 'memPercent' })}
          ${gaugeCard(esc, { label: 'Disk', value: dsk && dsk.usedPercent, warn: 80, crit: 90, detail: dskDetail, points: hist.points, key: 'diskPercent' })}
        </div>
        <div class="mon-kpis">
          ${kpiTile(esc, 'Uptime', fmtDuration(hl.uptimeSeconds), 'since last boot')}
          ${kpiTile(esc, 'Terminals', hl.activeTerminals ?? 0, 'persistent sessions')}
          ${hl.temperature ? kpiTile(esc, hl.temperature.source === 'battery' ? 'Battery temp' : 'CPU temp', `${Math.round(hl.temperature.celsius)} °C`, 'current', hl.temperature.celsius >= 85 ? 'crit' : hl.temperature.celsius >= 70 ? 'warn' : 'ok') : ''}
          ${kpiTile(esc, 'Availability 24h', av24 === null || av24 === undefined ? '—' : `${av24}%`, 'reachable', uptimeTone(av24), 'audit')}
          ${kpiTile(esc, 'Availability 7d', av7 === null || av7 === undefined ? '—' : `${av7}%`, 'reachable', uptimeTone(av7), 'audit')}
          ${host.latencyMs !== null && host.latencyMs !== undefined && !host.isLocal ? kpiTile(esc, 'Latency', `${host.latencyMs} ms`, 'round trip') : ''}
          ${kpiTile(esc, 'Version', host.version ? `v${host.version}` : '—', 'Citadel', null, 'updates')}
        </div>` : `<div class="card mon-muted">${offline ? esc(host.error || 'Not responding.') : 'No detailed metrics: update this machine to see load, memory and disk.'}</div>
        <div class="mon-kpis">
          ${kpiTile(esc, 'Availability 24h', av24 === null || av24 === undefined ? '—' : `${av24}%`, 'reachable', uptimeTone(av24), 'audit')}
          ${kpiTile(esc, 'Availability 7d', av7 === null || av7 === undefined ? '—' : `${av7}%`, 'reachable', uptimeTone(av7), 'audit')}
        </div>`}
        <div class="mon-panels">
          <div class="card mon-panel">
            <div class="mon-panel-head"><h3>Availability</h3><span class="mon-muted">last 24 h</span></div>
            ${downBand(hist.points) || '<div class="mon-muted">No history yet.</div>'}
            <div class="mon-band-legend"><span><i class="up"></i>Online</span><span><i class="part"></i>Degraded</span><span><i class="down"></i>Offline</span></div>
            ${host.isLocal ? '' : `<div class="mon-panel-sub"><div class="mon-muted">Latency (ms)</div>${areaSpark(hist.points, 'latencyMs', { max: 100 })}</div>`}
          </div>
          <div class="card mon-panel">
            <div class="mon-panel-head"><h3>Recent incidents</h3><span class="mon-muted">${events.length ? `${events.length} latest` : 'last 30 days'}</span></div>
            ${events.length ? `<ul class="mon-timeline">${events.map((e) => `<li><i></i><div><span>${esc(e.message || e.action)}</span><small class="mon-muted">${esc(new Date(e.ts).toLocaleString())}</small></div></li>`).join('')}</ul>`
  : '<div class="mon-allclear"><span>✓</span>All clear — no incidents in the last 30 days.</div>'}
          </div>
        </div>`;
      body.querySelectorAll('[data-metric]').forEach(button => {
        button.onclick = () => { if (present()) ctx.openMetric?.(host.id, button.dataset.metric); };
      });
    } catch (err) { fail(err); }
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
        <label class="mon-field"><input type="checkbox" id="mon-cfg-security" ${cfg.securityAlerts !== false ? 'checked' : ''}/> Security alerts: sign-ins from a new address, repeated failed sign-ins, machines that pair with this one, password resets</label>
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
      dialogClass: 'settings-alert-modal',
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
        securityAlerts: document.getElementById('mon-cfg-security').checked,
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

  window.CitadelMonitor = { renderWidget, renderMachine, showAlertSettings };
})();
