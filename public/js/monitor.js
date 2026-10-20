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

  function gauge(esc, label, value, text, warn, crit) {
    const v = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
    return `<div class="mon-gauge ${levelClass(v, warn, crit)}">
      <div class="mon-gauge-head"><span>${esc(label)}</span><strong>${v === null ? '—' : esc(text)}</strong></div>
      <div class="mon-bar"><div class="mon-bar-fill" style="width:${v === null ? 0 : v}%"></div></div>
    </div>`;
  }

  function statusOf(h) {
    if (h.online === true) return h.alerts.length ? 'warn' : 'ok';
    if (h.online === false) return 'down';
    return 'unknown';
  }

  function cardHtml(h, ctx) {
    const esc = ctx.escapeHtml;
    const status = statusOf(h);
    const health = h.health;
    const dot = status === 'ok' ? 'host-dot-on' : status === 'down' ? 'host-dot-off' : status === 'warn' ? 'mon-dot-warn' : '';
    const chips = h.alerts.map((k) => `<span class="badge ${k === 'offline' ? 'badge-danger' : 'badge-warning'}">${esc(ALERT_LABELS[k] || k)}</span>`).join('');

    let body;
    if (h.online === false) {
      body = `<div class="mon-down">
        <strong>Not responding</strong>
        <span>${esc(h.error || 'Unreachable')}</span>
        <span class="mon-muted">Offline since ${esc(fmtAgo(h.since))}. Last seen ${esc(fmtAgo(h.lastSeen))}.</span>
      </div>`;
    } else if (h.online === null) {
      body = '<div class="mon-muted">Checking…</div>';
    } else if (!health) {
      body = '<div class="mon-muted">Online. This machine runs an older Citadel without detailed health; update it to see load, memory and disk.</div>';
    } else {
      const loadPct = Math.min(100, Math.round((health.loadPerCore || 0) * 100));
      body = `<div class="mon-gauges">
        ${gauge(esc, 'CPU', loadPct, `${loadPct}%`, 70, 100)}
        ${gauge(esc, 'Memory', health.memory && health.memory.usedPercent, `${health.memory ? health.memory.usedPercent : 0}%`, 80, 95)}
        ${gauge(esc, 'Disk', health.disk && health.disk.usedPercent, health.disk ? `${health.disk.usedPercent}% of ${fmtBytes(health.disk.totalBytes)}` : '', 80, 90)}
      </div>
      <div class="mon-meta">
        <span title="Machine uptime">⏱ ${esc(fmtDuration(health.uptimeSeconds))}</span>
        ${h.latencyMs !== null && !h.isLocal ? `<span title="Round-trip to this machine">⇄ ${h.latencyMs} ms</span>` : ''}
        ${h.uptime24h !== null ? `<span title="Availability, last 24 hours">${h.uptime24h}% 24h</span>` : ''}
        ${Number.isFinite(health.activeTerminals) ? `<span title="Persistent terminals">▣ ${health.activeTerminals}</span>` : ''}
      </div>`;
    }

    return `<div class="card mon-card mon-${status}" data-mon-id="${esc(h.id)}">
      <div class="mon-card-head">
        <span class="host-dot ${dot}"></span>
        <div class="mon-card-name">
          <strong>${esc(h.name)}</strong>
          <span class="mon-muted">${h.isLocal ? 'This machine' : esc((h.address || '').replace(/^https?:\/\//, ''))}${h.version ? ` · v${esc(h.version)}` : ''}</span>
        </div>
        <div class="mon-chips">${chips}</div>
      </div>
      ${body}
      <div class="mon-actions">
        <button class="btn btn-primary btn-sm" data-mon-open="${esc(h.id)}" ${h.online === false ? 'disabled' : ''}>Open</button>
        <button class="btn btn-secondary btn-sm" data-mon-details="${esc(h.id)}">Details</button>
      </div>
    </div>`;
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

  function summaryText(data) {
    const online = data.hosts.filter((h) => h.online === true).length;
    const down = data.hosts.filter((h) => h.online === false).length;
    const parts = [`${online} online`];
    if (down) parts.push(`${down} offline`);
    if (data.alerts.length) parts.push(`${data.alerts.length} alert${data.alerts.length === 1 ? '' : 's'}`);
    return `${parts.join(' · ')} — checked ${fmtAgo(data.checkedAt)} (every ${data.intervalSec}s)`;
  }

  // --- Main view ------------------------------------------------------------

  async function renderView(ctx) {
    const { localApi, escapeHtml: esc, showToast } = ctx;
    const content = document.getElementById('main-content');
    const actions = document.getElementById('top-bar-actions');
    clearInterval(refreshTimer);

    if (ctx.isAdmin) {
      actions.innerHTML = `<button class="btn btn-secondary btn-sm" id="mon-alerts-btn">Alerts…</button>
        <button class="btn btn-secondary btn-sm" id="mon-refresh-btn">Check now</button>`;
    }
    content.innerHTML = '<div id="mon-root"><div class="mon-muted">Loading machines…</div></div>';

    let data = null;
    const draw = () => {
      const root = document.getElementById('mon-root');
      if (!root || !data) return;
      if (!data.hosts.length) {
        root.innerHTML = '<div class="mon-muted">First check in progress…</div>';
        return;
      }
      const paired = data.hosts.length > 1;
      root.innerHTML = `${alertsHtml(data.alerts, ctx)}
        <div class="mon-summary">${esc(summaryText(data))}</div>
        <div class="mon-grid">${data.hosts.map((h) => cardHtml(h, ctx)).join('')}</div>
        ${paired ? '' : `<div class="card mon-empty">
          <strong>Add more machines</strong>
          <span class="mon-muted">Pair your other devices (home server, VPS, laptop) from the machine selector at the top of the sidebar and they appear here with live health and alerts.</span>
        </div>`}`;
      root.querySelectorAll('[data-mon-open]').forEach((b) => {
        b.onclick = () => ctx.switchHost(b.getAttribute('data-mon-open'));
      });
      root.querySelectorAll('[data-mon-details]').forEach((b) => {
        b.onclick = () => {
          const host = data.hosts.find((x) => x.id === b.getAttribute('data-mon-details'));
          if (host) showDetails(host, ctx, () => load(false));
        };
      });
    };

    const load = async (force) => {
      try {
        data = force
          ? await localApi('/api/monitor/refresh', { method: 'POST' })
          : await localApi('/api/monitor/overview');
        draw();
      } catch (err) {
        if (force) showToast(err.message, 'error');
        const root = document.getElementById('mon-root');
        if (root && !data) root.innerHTML = `<div style="color:var(--danger-color);">${esc(err.message)}</div>`;
      }
    };

    document.getElementById('mon-refresh-btn')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      await load(true);
      const btn = document.getElementById('mon-refresh-btn');
      if (btn) btn.disabled = false;
    });
    document.getElementById('mon-alerts-btn')?.addEventListener('click', () => showAlertSettings(ctx));

    await load(false);
    // Stops by itself once the view is replaced.
    refreshTimer = setInterval(() => {
      if (!document.getElementById('mon-root')) { clearInterval(refreshTimer); return; }
      load(false);
    }, 15000);
  }

  // --- Dashboard widget -----------------------------------------------------

  async function renderWidget(ctx) {
    const body = document.getElementById('dash-machines-body');
    if (!body) return;
    const esc = ctx.escapeHtml;
    try {
      const data = await ctx.localApi('/api/monitor/overview');
      const summary = document.getElementById('dash-machines-summary');
      if (summary) summary.textContent = data.hosts.length ? summaryText(data) : 'First check in progress…';
      body.innerHTML = `${data.alerts.length ? alertsHtml(data.alerts.slice(0, 3), ctx) : ''}
        <div class="mon-mini">
          ${data.hosts.map((h) => {
            const status = statusOf(h);
            const dot = status === 'ok' ? 'host-dot-on' : status === 'down' ? 'host-dot-off' : status === 'warn' ? 'mon-dot-warn' : '';
            const hl = h.health;
            const stats = h.online === false ? `<span style="color:var(--danger-color);">offline</span>`
              : hl ? `<span>CPU ${Math.min(100, Math.round((hl.loadPerCore || 0) * 100))}%</span><span>RAM ${hl.memory ? hl.memory.usedPercent : '—'}%</span><span>Disk ${hl.disk ? `${hl.disk.usedPercent}%` : '—'}</span>`
                : '<span class="mon-muted">online</span>';
            return `<div class="mon-mini-row"><span class="host-dot ${dot}"></span><strong>${esc(h.name)}</strong><span class="mon-mini-stats">${stats}</span></div>`;
          }).join('')}
        </div>`;
    } catch (err) {
      body.innerHTML = `<div class="mon-muted">${esc(err.message)}</div>`;
    }
  }

  // --- Details, logs, restart ----------------------------------------------

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

  async function showDetails(host, ctx, onChange) {
    const { localApi, escapeHtml: esc } = ctx;
    ctx.openModal({
      title: host.name,
      confirmText: 'Close',
      bodyHtml: '<div id="mon-detail"><div class="mon-muted">Loading history…</div></div>',
    });
    try {
      const hist = await localApi(`/api/monitor/hosts/${encodeURIComponent(host.id)}/history?hours=24`);
      const root = document.getElementById('mon-detail');
      if (!root) return;
      const events = (hist.events || []).slice(0, 8);
      root.innerHTML = `
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
        <div class="mon-muted" style="margin-top:12px;">Recent incidents</div>
        ${events.length ? `<ul class="mon-events">${events.map((e) => `<li><span class="mon-muted">${esc(new Date(e.ts).toLocaleString())}</span> ${esc(e.message || e.action)}</li>`).join('')}</ul>`
    : '<div class="mon-muted">None in the last 30 days.</div>'}
        ${ctx.isAdmin ? `<div class="mon-actions" style="margin-top:14px;">
          <button class="btn btn-secondary btn-sm" id="mon-logs-btn" ${host.online === false ? 'disabled' : ''}>View logs</button>
          <button class="btn btn-secondary btn-sm" id="mon-restart-btn" ${host.online === false ? 'disabled' : ''}>Restart Citadel</button>
        </div>` : ''}`;
      document.getElementById('mon-logs-btn')?.addEventListener('click', () => showLogs(host, ctx));
      document.getElementById('mon-restart-btn')?.addEventListener('click', () => confirmRestart(host, ctx, onChange));
    } catch (err) {
      const root = document.getElementById('mon-detail');
      if (root) root.innerHTML = `<div style="color:var(--danger-color);">${esc(err.message)}</div>`;
    }
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

  window.CitadelMonitor = { renderView, renderWidget };
})();
