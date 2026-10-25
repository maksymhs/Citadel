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
    const draft = () => ({ mode: body.querySelector('#gateway-mode')?.value || 'chatgpt',
      contextTokens: Number(body.querySelector('#gateway-context')?.value),
      claudePlanningModel: body.querySelector('#gateway-claude-planning')?.value.trim(),
      claudeExecutionModel: body.querySelector('#gateway-claude-execution')?.value.trim(),
      claudeSmallModel: body.querySelector('#gateway-claude-small')?.value.trim(), enabled: Boolean(body.querySelector('#gateway-enabled')?.checked),
      port: Number(body.querySelector('#gateway-port')?.value),
      planningModel: body.querySelector('#gateway-planning')?.value.trim(),
      executionModel: body.querySelector('#gateway-execution')?.value.trim(),
      smallModel: body.querySelector('#gateway-small')?.value.trim() });
    function draw(preserve = false) {
      if (!present()) return;
      const callbackDraft = preserve ? body.querySelector('#gateway-callback')?.value || '' : '';
      const c = preserve && body.querySelector('#gateway-enabled') ? draft() : gateway;
      const disabled = working ? 'disabled' : '';
      const waiting = ['starting', 'waiting', 'waiting_callback', 'exchanging'].includes(gateway.login?.state);
      const state = gateway.running ? 'Running' : gateway.enabled ? 'Stopped — restart required' : 'Disabled';
      body.innerHTML = `<p class="settings-hero-status" role="status">${esc(state)} · CLIProxyAPI ${esc(gateway.version)} · ${gateway.connected ? 'ChatGPT connected' : 'ChatGPT not connected'} · ${gateway.connections?.claude ? 'Claude connected' : 'Claude not connected'} · Mode: ${esc(gateway.mode || 'chatgpt')}</p>
        ${gateway.error ? `<p class="settings-warn">${esc(gateway.error)}</p>` : ''}
        <div class="settings-hero-actions">
          <button id="gateway-install" class="btn btn-secondary btn-sm" ${gateway.installed || !gateway.supported || working ? 'disabled' : ''}>${gateway.installed ? 'Component installed' : 'Install local gateway'}</button>
          <button id="gateway-login" class="btn btn-secondary btn-sm" ${!gateway.installed || working || waiting ? 'disabled' : ''}>${gateway.connected ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}</button>
          <button id="gateway-login-claude" class="btn btn-secondary btn-sm" ${!gateway.installed || working || waiting ? 'disabled' : ''}>${gateway.connections?.claude ? 'Reconnect Claude' : 'Connect Claude'}</button>
          ${gateway.connected || gateway.connections?.claude || waiting ? `<button id="gateway-disconnect" class="btn btn-secondary btn-sm" ${disabled}>Disconnect</button>` : ''}
        </div>
        ${!gateway.supported ? '<p class="settings-warn">Installation supports Linux/macOS on x64/arm64.</p>' : ''}
        ${gateway.login?.state === 'waiting' ? `<p>Open <a href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">ChatGPT device login</a> and enter <strong>${esc(gateway.login.code)}</strong>.</p><p class="settings-hero-status">If requested, enable device login in ChatGPT security settings. This code expires at ${esc(new Date(gateway.login.expiresAt).toLocaleTimeString())}.</p>` : ''}
        ${gateway.login?.state === 'starting' ? '<p role="status">Requesting a device code…</p>' : ''}
        ${gateway.login?.state === 'waiting_callback' ? `<p>Open <a href="${esc(gateway.login.url)}" target="_blank" rel="noopener noreferrer">Claude authorization</a>. After approving, the browser may show a localhost connection error. Copy that complete address into the field below.</p><label class="settings-field">Claude callback URL<input type="password" class="form-input" id="gateway-callback" maxlength="8192" autocomplete="off" value="${esc(callbackDraft)}"></label><button id="gateway-submit-callback" class="btn btn-primary btn-sm" ${disabled}>Finish Claude connection</button>` : ''}
        ${gateway.login?.state === 'exchanging' ? '<p role="status">Completing Claude authorization…</p>' : ''}
        ${gateway.login?.state === 'failed' ? '<p class="settings-warn">Login failed or expired. Connect that provider again.</p>' : ''}
        <form id="gateway-form" style="margin-top:18px;">
          <label class="settings-field"><span><input type="checkbox" id="gateway-enabled" ${c.enabled ? 'checked' : ''} ${(!gateway.connected && !gateway.connections?.claude) || working ? 'disabled' : ''}> Use gateway for Claude Code in new project terminals</span></label>
          <label class="settings-field">Route mode<select class="form-input" id="gateway-mode" ${disabled}><option value="chatgpt" ${c.mode === 'chatgpt' ? 'selected' : ''}>ChatGPT only</option><option value="claude" ${c.mode === 'claude' ? 'selected' : ''}>Claude only</option><option value="auto" ${c.mode === 'auto' ? 'selected' : ''}>Auto — Claude first, ChatGPT fallback</option></select></label>
          <h3>ChatGPT models</h3>
          <label class="settings-field">Planning model<input class="form-input" id="gateway-planning" list="gateway-models" value="${esc(c.planningModel)}" required maxlength="160" ${disabled}></label>
          <label class="settings-field">Execution model<input class="form-input" id="gateway-execution" list="gateway-models" value="${esc(c.executionModel)}" required maxlength="160" ${disabled}></label>
          <label class="settings-field">Small/background model<input class="form-input" id="gateway-small" list="gateway-models" value="${esc(c.smallModel)}" required maxlength="160" ${disabled}></label>
          <h3>Claude models</h3>
          <label class="settings-field">Planning model<input class="form-input" id="gateway-claude-planning" list="gateway-models" value="${esc(c.claudePlanningModel || '')}" required maxlength="160" ${disabled}></label>
          <label class="settings-field">Execution model<input class="form-input" id="gateway-claude-execution" list="gateway-models" value="${esc(c.claudeExecutionModel || '')}" required maxlength="160" ${disabled}></label>
          <label class="settings-field">Small/background model<input class="form-input" id="gateway-claude-small" list="gateway-models" value="${esc(c.claudeSmallModel || '')}" required maxlength="160" ${disabled}></label>
          <label class="settings-field">Shared context budget (tokens)<input class="form-input" type="number" min="32000" max="1000000" id="gateway-context" value="${c.contextTokens || 200000}" ${disabled}></label>
          <datalist id="gateway-models">${knownModels.map(id => `<option value="${esc(id)}"></option>`).join('')}</datalist>
          <label class="settings-field">Local port<input class="form-input" id="gateway-port" type="number" min="1024" max="65535" value="${c.port}" ${gateway.running || working ? 'disabled' : ''}></label>
          <div class="settings-hero-actions">
            <button class="btn btn-primary btn-sm" type="submit" ${disabled}>Save</button>
            <button class="btn btn-secondary btn-sm" type="button" id="gateway-test" ${!gateway.running || working ? 'disabled' : ''}>Test model</button>
            <button class="btn btn-secondary btn-sm" type="button" id="gateway-refresh" ${disabled}>Refresh status / models</button>
          </div>
        </form>
        <p class="settings-hero-status">Enabling this switch saves immediately. Open a new project terminal, then run claude. Reopen old terminals once to adopt stable aliases. Mode/model changes then apply to the next request without reopening Claude. In-flight requests finish on their original route. Context budget changes still need a new terminal. The budget must fit every configured model. Model availability depends on your account. Test model sends a small request using your allowance.</p>
        <p class="settings-hero-status">The gateway listens only on this machine. Disabling it stops the gateway and interrupts sessions using it. Existing native sessions keep their configuration. Auto requires both providers connected. It prefers Claude and falls back on eligible quota/availability failures, staying with the fallback during the conversation. Existing conversations may keep their current provider; choose Claude only to force a return. Authentication, billing and policy errors are surfaced. This does not switch back to your separate native Claude CLI login.</p>`;
      body.querySelector('#gateway-install').onclick = () => action('/install', 'POST', null, 'Gateway component installed.');
      body.querySelector('#gateway-login').onclick = () => action('/login', 'POST', { provider: 'codex' });
      body.querySelector('#gateway-login-claude').onclick = () => action('/login', 'POST', { provider: 'claude' });
      body.querySelector('#gateway-submit-callback')?.addEventListener('click', () => action('/callback', 'POST', { redirectUrl: body.querySelector('#gateway-callback').value.trim() }));
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
        if (success) showToast(route === '/test' && res.model ? `Model responded: ${res.model}` : success, 'success');
      } catch (err) { showToast(err.message, 'error'); }
      finally {
        working = false;
        // Preserve edits during login/install; after Save reflect the actual state.
        if (method !== 'PUT' && !['/login', '/callback'].includes(route)) gateway = { ...gateway, ...current, enabled: gateway.enabled };
        await refresh(method !== 'PUT' && method !== 'DELETE');
      }
    }
    async function refresh(preserve = false) {
      dispose();
      if (!present()) return;
      try {
        gateway = (await api('/api/settings/gateway')).gateway;
        draw(preserve);
        if (['starting', 'waiting', 'waiting_callback', 'exchanging'].includes(gateway.login?.state)) {
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
