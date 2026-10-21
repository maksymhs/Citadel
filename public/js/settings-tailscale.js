/**
 * Settings → Tailscale card: a step-by-step wizard that gives this panel a
 * private HTTPS address on the user's tailnet, reachable from their own devices
 * (phones, other machines) behind any NAT and never from the public Internet.
 * Loaded before app.js; app.js passes the shared helpers in.
 *
 * Signing in and allowing this service to manage Tailscale need root, so those
 * steps show the exact command to run in a terminal; the card notices when it
 * has been done (it re-checks every few seconds) and moves on by itself.
 */
(function () {
  'use strict';

  let timer = null;

  function init(ctx) {
    const { api, escapeHtml, showToast } = ctx;
    const body = document.getElementById('tailscale-body');
    if (!body) return;
    clearTimeout(timer);
    let hint = null; // last failure from "Enable", shown under step 3
    let busy = false;

    const copyBtn = (text) => `<button type="button" class="btn btn-secondary btn-sm ts-copy" data-copy="${escapeHtml(text)}" aria-label="Copy command">Copy</button>`;
    const command = (text) => `<div class="ts-cmd"><code>${escapeHtml(text)}</code>${copyBtn(text)}</div>`;
    const step = (n, state, title, content) => `<li class="ts-step ts-${state}">
      <span class="ts-mark" aria-hidden="true">${state === 'done' ? '✓' : n}</span>
      <div class="ts-step-body"><strong>${escapeHtml(title)}</strong>${content ? `<div class="ts-step-detail">${content}</div>` : ''}</div>
    </li>`;

    function draw(t) {
      if (!document.getElementById('tailscale-body')) return;
      const running = t.installed && t.backendState === 'Running';
      const needsLogin = t.installed && (t.backendState === 'NeedsLogin' || t.backendState === 'NeedsMachineAuth');
      const done = running && t.serving;

      const install = t.install || {};
      const s1 = t.installed
        ? step(1, 'done', 'Tailscale is installed', '')
        : step(1, 'todo', 'Install Tailscale on this machine',
          `${(install.commands || []).map(command).join('')}${install.note ? `<p class="mon-muted">${escapeHtml(install.note)}</p>` : ''}`);

      let s2;
      if (running) {
        s2 = step(2, 'done', `Signed in${t.tailnet ? ` as ${t.tailnet}` : ''}`, `<span class="mon-muted">${escapeHtml(t.hostName || '')} · ${t.peers} other device${t.peers === 1 ? '' : 's'} on your tailnet</span>`);
      } else if (needsLogin) {
        s2 = step(2, 'todo', t.backendState === 'NeedsMachineAuth' ? 'Approve this machine in the Tailscale admin console' : 'Sign in to Tailscale',
          t.loginUrl ? `<a class="btn btn-primary btn-sm" href="${escapeHtml(t.loginUrl)}" target="_blank" rel="noopener">Sign in</a> <span class="mon-muted">or run in a terminal:</span>${command('sudo tailscale up')}` : command('sudo tailscale up'));
      } else {
        s2 = step(2, t.installed ? 'todo' : 'wait', 'Sign in to Tailscale', t.installed ? `${t.error ? `<p class="mon-muted">${escapeHtml(t.error)}</p>` : ''}${command('sudo tailscale up')}` : '');
      }

      let s3 = '';
      if (hint && hint.needsOperator) {
        s3 = `<p>Allow Citadel to manage Tailscale (one time), then press the button again:</p>${command(hint.command || t.operatorCommand)}`;
      } else if (hint && hint.actionUrl) {
        s3 = `<p class="settings-warn">${escapeHtml(hint.message || 'Tailscale needs one more setting.')}</p><a class="btn btn-secondary btn-sm" href="${escapeHtml(hint.actionUrl)}" target="_blank" rel="noopener">Open Tailscale to enable it</a> <span class="mon-muted">then press the button again.</span>`;
      } else if (hint) {
        s3 = `<p class="settings-warn">${escapeHtml(hint.message || 'Could not enable the address.')}</p>`;
      }
      const s3state = done ? 'done' : running ? 'todo' : 'wait';
      const s3body = done
        ? `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener" class="ts-url">${escapeHtml(t.url)}</a>
           <p class="mon-muted">Private: only your own devices signed in to Tailscale can open it, and the panel login still applies. Nothing is exposed to the public Internet.</p>
           <button class="btn btn-secondary btn-sm" id="ts-disable" ${busy ? 'disabled' : ''}>Turn off</button>`
        : `${running ? `<button class="btn btn-primary btn-sm" id="ts-enable" ${busy ? 'disabled' : ''}>${busy ? 'Enabling…' : 'Enable private address'}</button>` : ''}${s3}`;
      const s3html = step(3, s3state, done ? 'Private HTTPS address is on' : 'Give this panel a private HTTPS address', s3body);

      body.innerHTML = `<ol class="ts-steps">${s1}${s2}${s3html}</ol>`;

      body.querySelectorAll('.ts-copy').forEach((btn) => {
        btn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(btn.dataset.copy);
            showToast('Command copied.', 'success');
          } catch {
            showToast('Select the command and copy it.', 'info');
          }
        };
      });
      const enable = document.getElementById('ts-enable');
      if (enable) enable.onclick = () => act('POST');
      const disable = document.getElementById('ts-disable');
      if (disable) disable.onclick = () => act('DELETE');
      return done;
    }

    async function act(method) {
      clearTimeout(timer);
      busy = true;
      hint = null;
      refresh(false);
      try {
        const res = await api('/api/network/tailscale/serve', { method });
        busy = false;
        draw(res.tailscale);
        showToast(method === 'POST' ? 'Private address enabled.' : 'Private address turned off.', 'success');
      } catch (err) {
        busy = false;
        hint = err.details || { message: err.message };
        refresh(true); // keep watching: the user is about to run the command it shows
      }
    }

    async function refresh(schedule = true) {
      try {
        const { tailscale } = await api('/api/network/tailscale');
        const done = draw(tailscale);
        // Keep watching until everything is set up: the user is running commands
        // in another window and expects the card to notice.
        if (schedule && !done) timer = setTimeout(refresh, 4000);
      } catch (err) {
        if (document.getElementById('tailscale-body')) {
          body.innerHTML = `<p class="settings-warn">${escapeHtml(err.message)}</p>`;
        }
      }
    }

    refresh();
  }

  window.CitadelTailscaleCard = { init };
})();
