/**
 * Settings → Tunnel card: link a Cloudflare-managed domain without leaving the
 * panel. Loaded before app.js; app.js passes the shared helpers in, so this
 * file has no access to (or dependency on) app.js internals. New screens
 * should follow the same pattern instead of growing app.js.
 */
(function () {
  'use strict';

  // Settings → Tunnel state, kept across re-renders of the settings view.
  let tunnelPollTimer = null;
  let tunnelWatching = false;
  async function init(ctx) {
    const { api, escapeHtml, showToast, reload } = ctx;
    const body = document.getElementById('tunnel-body');
    if (!body) return;
    clearTimeout(tunnelPollTimer);

    const draw = (t) => {
      if (!document.getElementById('tunnel-body')) return;
      const job = t.job || {};
      const active = job.phase === 'login' || job.phase === 'working';
      let html = '';
      if (!t.supported) {
        html = 'Tunnel setup is only available on Linux hosts.';
      } else if (!t.cloudflaredInstalled || !t.helperInstalled) {
        html = `One-time step on this machine: <code>sudo citadel tunnel setup</code>, then reload this page.`;
      } else if (active) {
        html = job.phase === 'login' && job.loginUrl
          ? `<p>1. Open Cloudflare, pick the domain <strong>${escapeHtml((job.domain || '').split('.').slice(-2).join('.'))}</strong> and authorize:</p>
             <p style="margin:8px 0;"><a class="btn btn-primary btn-sm" href="${escapeHtml(job.loginUrl)}" target="_blank" rel="noopener">Authorize in Cloudflare</a></p>
             <p>2. This page continues on its own once you approve. Cloudflare lists only your root domain: pick it even though you are linking <code>${escapeHtml(job.domain || '')}</code>; the subdomain is created for you.</p>`
          : `<p>${escapeHtml(job.message || 'Working…')}</p>${job.detail ? `<p style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);word-break:break-all;">${escapeHtml(job.detail)}</p>` : ''}<p style="font-size:12px;color:var(--text-muted);">Log: logs/tunnel-setup.log</p>`;
        html += '<p style="margin-top:8px;"><button class="btn btn-secondary btn-sm" id="tunnel-cancel">Cancel</button></p>';
      } else {
        const current = t.mode === 'named'
          ? `<p>Active: <a href="https://${escapeHtml(t.domain)}" target="_blank" rel="noopener" style="color:var(--accent-color);font-family:var(--font-mono);">https://${escapeHtml(t.domain)}</a> — stable across restarts.</p>`
          : `<p>${t.mode === 'quick' ? 'Using a temporary trycloudflare.com URL that changes on every restart.' : 'No tunnel is running.'} Link a domain you manage in Cloudflare for a permanent address.</p>`;
        html = `${current}
          ${job.phase === 'error' ? `<p class="settings-warn">${escapeHtml(job.message)}</p>` : ''}
          <div class="settings-row" style="margin-top:10px;">
            <input type="text" id="tunnel-domain" class="form-input" placeholder="citadel.example.com" value="${escapeHtml(t.domain || '')}" />
            <button class="btn btn-primary btn-sm" id="tunnel-start">${t.mode === 'named' ? 'Relink' : 'Connect domain'}</button>
            ${t.mode === 'named' ? '<button class="btn btn-secondary btn-sm" id="tunnel-revert">Use temporary URL</button>' : ''}
          </div>`;
      }
      body.innerHTML = html;

      const startBtn = document.getElementById('tunnel-start');
      if (startBtn) {
        startBtn.onclick = async () => {
          startBtn.disabled = true;
          try {
            const res = await api('/api/settings/tunnel', {
              method: 'POST',
              body: { domain: document.getElementById('tunnel-domain').value },
            });
            tunnelWatching = true;
            draw(res.tunnel);
            poll();
          } catch (err) {
            startBtn.disabled = false;
            showToast(err.message, 'error');
          }
        };
      }
      const cancelBtn = document.getElementById('tunnel-cancel');
      if (cancelBtn) {
        cancelBtn.onclick = async () => {
          const res = await api('/api/settings/tunnel/setup', { method: 'DELETE' });
          draw(res.tunnel);
        };
      }
      const revertBtn = document.getElementById('tunnel-revert');
      if (revertBtn) {
        revertBtn.onclick = async () => {
          revertBtn.disabled = true;
          try {
            await api('/api/settings/tunnel', { method: 'DELETE' });
            showToast('Back to a temporary URL.', 'success');
            reload();
          } catch (err) {
            revertBtn.disabled = false;
            showToast(err.message, 'error');
          }
        };
      }
    };

    const poll = async () => {
      if (!document.getElementById('tunnel-body')) return;
      try {
        const { tunnel } = await api('/api/settings/tunnel');
        const phase = tunnel.job && tunnel.job.phase;
        if (phase === 'done' && tunnelWatching) {
          tunnelWatching = false;
          showToast(`Tunnel active at https://${tunnel.domain}`, 'success');
          reload();
          return;
        }
        draw(tunnel);
        if (phase === 'login' || phase === 'working') tunnelWatching = true;
        if (phase === 'login' || phase === 'working') tunnelPollTimer = setTimeout(poll, 2000);
      } catch {
        tunnelPollTimer = setTimeout(poll, 4000);
      }
    };
    poll();
  }

  window.CitadelTunnelCard = { init };
})();
