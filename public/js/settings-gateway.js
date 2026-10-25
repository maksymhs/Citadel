/** Settings → AI Gateway: opt-in local setup, device login and scoped Claude models. */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'showToast'];
  let timer = null;
  function dispose() { clearTimeout(timer); timer = null; }
  async function init(ctx) {
    for (const key of REQUIRED) if (typeof ctx[key] !== 'function') throw new Error(`AI Gateway requires ${key}`);
    dispose();
    const { api, escapeHtml: esc, showToast } = ctx;
    const body = document.getElementById('gateway-body');
    if (!body) return;
    let gateway, working = false, knownModels = [];
    const present = () => document.getElementById('gateway-body') === body;
    const draft = () => ({ enabled: Boolean(body.querySelector('#gateway-enabled')?.checked),
      port: Number(body.querySelector('#gateway-port')?.value),
      planningModel: body.querySelector('#gateway-planning')?.value.trim(),
      executionModel: body.querySelector('#gateway-execution')?.value.trim(),
      smallModel: body.querySelector('#gateway-small')?.value.trim() });
    function draw(preserve = false) {
      if (!present()) return;
      const c = preserve && body.querySelector('#gateway-enabled') ? draft() : gateway;
      const disabled = working ? 'disabled' : '';
      const waiting = ['starting', 'waiting'].includes(gateway.login?.state);
      const state = gateway.running ? 'Running' : gateway.enabled ? 'Stopped — restart required' : 'Disabled';
      body.innerHTML = `<p class="settings-hero-status" role="status">${esc(state)} · CLIProxyAPI ${esc(gateway.version)} · ${gateway.connected ? 'ChatGPT connected' : 'ChatGPT not connected'}</p>
        ${gateway.error ? `<p class="settings-warn">${esc(gateway.error)}</p>` : ''}
        <div class="settings-hero-actions">
          <button id="gateway-install" class="btn btn-secondary btn-sm" ${gateway.installed || !gateway.supported || working ? 'disabled' : ''}>${gateway.installed ? 'Component installed' : 'Install local gateway'}</button>
          <button id="gateway-login" class="btn btn-secondary btn-sm" ${!gateway.installed || working || waiting ? 'disabled' : ''}>${gateway.connected ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}</button>
          ${gateway.connected || waiting ? `<button id="gateway-disconnect" class="btn btn-secondary btn-sm" ${disabled}>Disconnect</button>` : ''}
        </div>
        ${!gateway.supported ? '<p class="settings-warn">Installation supports Linux/macOS on x64/arm64.</p>' : ''}
        ${gateway.login?.state === 'waiting' ? `<p>Open <a href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">ChatGPT device login</a> and enter <strong>${esc(gateway.login.code)}</strong>.</p><p class="settings-hero-status">If requested, enable device login in ChatGPT security settings. This code expires at ${esc(new Date(gateway.login.expiresAt).toLocaleTimeString())}.</p>` : ''}
        ${gateway.login?.state === 'starting' ? '<p role="status">Requesting a device code…</p>' : ''}
        ${gateway.login?.state === 'failed' ? '<p class="settings-warn">Login failed or expired. Connect ChatGPT again to obtain a fresh code.</p>' : ''}
        <form id="gateway-form" style="margin-top:18px;">
          <label class="settings-field"><span><input type="checkbox" id="gateway-enabled" ${c.enabled ? 'checked' : ''} ${!gateway.connected || working ? 'disabled' : ''}> Use gateway for Claude Code in new project terminals</span></label>
          <label class="settings-field">Planning model<input class="form-input" id="gateway-planning" list="gateway-models" value="${esc(c.planningModel)}" required maxlength="160" ${disabled}></label>
          <label class="settings-field">Execution model<input class="form-input" id="gateway-execution" list="gateway-models" value="${esc(c.executionModel)}" required maxlength="160" ${disabled}></label>
          <label class="settings-field">Small/background model<input class="form-input" id="gateway-small" list="gateway-models" value="${esc(c.smallModel)}" required maxlength="160" ${disabled}></label>
          <datalist id="gateway-models">${knownModels.map(id => `<option value="${esc(id)}"></option>`).join('')}</datalist>
          <label class="settings-field">Local port<input class="form-input" id="gateway-port" type="number" min="1024" max="65535" value="${c.port}" ${gateway.running || working ? 'disabled' : ''}></label>
          <div class="settings-hero-actions">
            <button class="btn btn-primary btn-sm" type="submit" ${disabled}>Save</button>
            <button class="btn btn-secondary btn-sm" type="button" id="gateway-test" ${!gateway.running || working ? 'disabled' : ''}>Test model</button>
            <button class="btn btn-secondary btn-sm" type="button" id="gateway-refresh" ${disabled}>Refresh status / models</button>
          </div>
        </form>
        <p class="settings-hero-status">Enabling this switch saves immediately. Open a new project terminal, then run claude. Existing terminals and running Claude processes keep their previous connection. Planning uses the planning model; execution uses the execution model. Model availability depends on your account. Test model sends a small request using your allowance.</p>
        <p class="settings-hero-status">The gateway listens only on this machine. Disabling it stops the gateway and interrupts sessions using it. Existing native sessions keep their configuration. Automatic quota fallback is not enabled yet.</p>`;
      body.querySelector('#gateway-install').onclick = () => action('/install', 'POST', null, 'Gateway component installed.');
      body.querySelector('#gateway-login').onclick = () => action('/login', 'POST');
      body.querySelector('#gateway-disconnect')?.addEventListener('click', () => action('/login', 'DELETE', null, 'ChatGPT disconnected.'));
      body.querySelector('#gateway-enabled').onchange = () => action('', 'PUT', draft(), 'Gateway setting applied. Open a new project terminal before running claude.');
      body.querySelector('#gateway-form').onsubmit = e => { e.preventDefault(); action('', 'PUT', draft(), 'Gateway settings saved.'); };
      body.querySelector('#gateway-test').onclick = () => action('/test', 'POST', null, 'Model connection succeeded.');
      body.querySelector('#gateway-refresh').onclick = async () => {
        await refresh(true);
        if (gateway.running) {
          try { knownModels = (await api('/api/settings/gateway/models')).models; draw(true); } catch (err) { showToast(err.message, 'error'); }
        }
      };
    }
    async function action(route, method, payload, success) {
      if (working) return;
      const current = draft();
      working = true; draw(true);
      try {
        const res = await api(`/api/settings/gateway${route}`, { method, ...(payload ? { body: payload } : {}) });
        if (res.gateway) gateway = res.gateway;
        if (success) showToast(success, 'success');
      } catch (err) { showToast(err.message, 'error'); }
      finally {
        working = false;
        // Preserve edits during login/install; after Save reflect the actual state.
        if (method !== 'PUT' && route !== '/login') gateway = { ...gateway, ...current, enabled: gateway.enabled };
        await refresh(method !== 'PUT' && method !== 'DELETE');
      }
    }
    async function refresh(preserve = false) {
      dispose();
      if (!present()) return;
      try {
        gateway = (await api('/api/settings/gateway')).gateway;
        draw(preserve);
        if (['starting', 'waiting'].includes(gateway.login?.state)) {
          timer = setTimeout(() => { if (present() && !document.hidden) refresh(true); else if (present()) timer = setTimeout(() => refresh(true), 4000); }, 2000);
        }
      } catch (err) {
        if (present()) body.textContent = err.message;
      }
    }
    await refresh();
  }
  window.CitadelGatewaySettings = { init, dispose };
})();
