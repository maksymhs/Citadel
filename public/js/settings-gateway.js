/** Settings → AI Gateway: provider connections, model preferences and usage. */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'showToast'];
  const FIELDS = ['mode', 'contextTokens', 'planningModel', 'executionModel', 'smallModel', 'claudePlanningModel', 'claudeExecutionModel', 'claudeSmallModel', 'port'];
  let timer = null;
  let instance = 0;
  function dispose() { clearTimeout(timer); timer = null; instance++; }
  const escapeAttr = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  function configFrom(gateway) { return Object.fromEntries(FIELDS.map(key => [key, gateway[key]])); }
  function sameConfig(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function modelOptions(id, field, value, provider, discovery, esc) {
    const items = discovery?.providers?.[provider]?.models?.items || [];
    const known = items.some(item => item.id === value);
    const options = [];
    if (!value) options.push('<option value="" selected disabled>Select a model</option>');
    if (value && !known) options.push(`<option value="${escapeAttr(value)}" selected>${esc(value)} · Configured, not verified</option>`);
    options.push(...items.map(item => `<option value="${escapeAttr(item.id)}" ${item.id === value && known ? 'selected' : ''}>${esc(item.label || item.id)}</option>`));
    options.push(`<option value="__manual__">Enter a model ID manually…</option>`);
    const manual = Boolean(value && !known);
    return `<select class="form-input" id="${id}" data-model-select="${field}" aria-label="Model">${options.join('')}</select>
      <div class="gateway-manual-model" id="${id}-manual-wrap" ${manual ? '' : 'hidden'}><label for="${id}-manual">Custom model ID</label><input class="form-input" id="${id}-manual" data-manual-field="${field}" maxlength="160" value="${manual ? escapeAttr(value) : ''}" autocomplete="off"></div>`;
  }
  function formatReset(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp);
    const when = date.toLocaleString();
    const seconds = Math.max(0, Math.floor((timestamp - Date.now()) / 1000));
    const remaining = seconds >= 86400 ? `${Math.floor(seconds / 86400)} d ${Math.floor(seconds % 86400 / 3600)} h` : seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min` : `${Math.floor(seconds / 60)} min`;
    return timestamp <= Date.now() ? `Reported reset: ${when} (in the past)` : `Resets ${when} (in ${remaining})`;
  }
  async function init(ctx) {
    for (const key of REQUIRED) if (typeof ctx[key] !== 'function') throw new Error(`AI Gateway requires ${key}`);
    dispose();
    const currentInstance = instance;
    const { api, escapeHtml: esc, showToast } = ctx;
    const body = document.getElementById('gateway-body');
    if (!body) return;
    let gateway, working = false, discovery = null, savedConfig = null, draftConfig = null, refreshPending = false;
    const present = () => currentInstance === instance && document.getElementById('gateway-body') === body;
    function readDraft() {
      if (!draftConfig) return;
      for (const key of FIELDS) {
        const id = ({ mode: 'gateway-mode', contextTokens: 'gateway-context', port: 'gateway-port', planningModel: 'gateway-planning', executionModel: 'gateway-execution', smallModel: 'gateway-small', claudePlanningModel: 'gateway-claude-planning', claudeExecutionModel: 'gateway-claude-execution', claudeSmallModel: 'gateway-claude-small' })[key];
        const field = body.querySelector(`#${id}`);
        if (!field) continue;
        if (key.endsWith('Model') && field.value === '__manual__') draftConfig[key] = body.querySelector(`#${id}-manual`)?.value.trim() || '';
        else draftConfig[key] = key === 'contextTokens' || key === 'port' ? Number(field.value) : field.value;
      }
    }
    function quotaMarkup(provider) {
      const state = discovery?.providers?.[provider];
      const usage = state?.usage;
      if (!state?.connected) return '<p class="gateway-muted">Connect this provider to see its models and usage.</p>';
      if (!usage || usage.status === 'unavailable' || !usage.accounts?.length) return '<p class="gateway-muted">Subscription limits are unavailable. Gateway settings still work.</p>';
      const accounts = usage.accounts.map(account => {
        if (!account.windows?.length) return `<div class="gateway-account"><strong>${esc(account.label || 'Account')}</strong><span>Usage unavailable</span></div>`;
        return `<div class="gateway-account"><strong>${esc(account.label || 'Account')}</strong>${account.windows.map(window => {
          const percent = Number.isFinite(window.usedPercent) ? `${window.usedPercent}% used` : 'Percentage not reported';
          const reset = formatReset(window.resetsAt);
          return `<span>${esc(window.label || window.id)} · ${esc(percent)}${reset ? ` · ${esc(reset)}` : ''}</span>`;
        }).join('')}</div>`;
      }).join('');
      return `<div class="gateway-usage" aria-live="polite">${usage.stale ? '<p class="gateway-muted">Usage data may be stale.</p>' : ''}${accounts}</div>`;
    }
    function modelSource(provider) {
      const models = discovery?.providers?.[provider]?.models;
      if (!models || models.status === 'unavailable') return '<p class="gateway-muted">Catalog unavailable; configured model IDs are preserved.</p>';
      if (models.stale) return '<p class="gateway-muted">Showing the last catalog; it may be out of date.</p>';
      return `<p class="gateway-muted">${models.source === 'credential_catalog' ? 'Models reported for this account' : 'Proxy catalog; account access not verified'} · ${models.fetchedAt ? `updated ${esc(new Date(models.fetchedAt).toLocaleTimeString())}` : ''}. A listed model is not guaranteed to be available to your subscription.</p>`;
    }
    function draw(preserve = false) {
      if (!present() || !gateway) return;
      if (preserve) readDraft();
      const callback = body.querySelector('#gateway-callback')?.value || '';
      const focusedId = body.contains(document.activeElement) ? document.activeElement.id : '';
      const waiting = ['starting', 'waiting', 'waiting_callback', 'exchanging'].includes(gateway.login?.state);
      const disabled = working ? 'disabled' : '';
      const changed = !sameConfig(draftConfig, savedConfig);
      const providerSection = (provider, label, modelFields, connected) => {
        const info = discovery?.providers?.[provider];
        const status = connected ? 'Connected' : 'Not connected';
        return `<section class="gateway-provider" aria-labelledby="gateway-${provider}-heading">
          <div class="gateway-provider-heading"><div><h3 id="gateway-${provider}-heading">${label}</h3><span class="gateway-status">${status}</span></div><div class="gateway-provider-actions"><button type="button" class="btn btn-secondary btn-sm" data-refresh-provider="${provider}" ${!connected || working || refreshPending ? 'disabled' : ''}>Refresh</button></div></div>
          ${modelSource(provider)}
          <div class="gateway-model-grid">${modelFields.map(([title, key]) => `<div class="settings-field"><span>${title}</span>${modelOptions(({ planningModel: 'gateway-planning', executionModel: 'gateway-execution', smallModel: 'gateway-small', claudePlanningModel: 'gateway-claude-planning', claudeExecutionModel: 'gateway-claude-execution', claudeSmallModel: 'gateway-claude-small' })[key], key, draftConfig[key] || '', provider, discovery, esc)}</div>`).join('')}</div>
          ${quotaMarkup(provider)}
          ${info?.message ? `<p class="gateway-muted">${esc(info.message)}</p>` : ''}
        </section>`;
      };
      body.innerHTML = `<div class="gateway-settings">
        <div class="gateway-topline"><div><h2>AI Gateway</h2><p class="gateway-muted">Connect your accounts and choose models for each task.</p></div><span class="gateway-live-status" role="status">${esc(gateway.running ? 'Gateway running' : gateway.enabled ? 'Enabled · start required' : 'Disabled')}</span></div>
        ${gateway.error ? `<p class="settings-warn">${esc(gateway.error)}</p>` : ''}
        ${!gateway.installed ? `<section class="gateway-card"><h3>1. Install local component</h3><p class="gateway-muted">The proxy runs on this machine and only accepts local connections.</p><button id="gateway-install" class="btn btn-secondary btn-sm" ${!gateway.supported || working ? 'disabled' : ''}>Install component</button>${!gateway.supported ? '<p class="settings-warn">Installation supports Linux/macOS x64/arm64.</p>' : ''}</section>` : ''}
        <section class="gateway-card"><div class="gateway-topline"><div><h3>Connections</h3><p class="gateway-muted">Accounts are managed separately. Auto requires both providers to be connected.</p></div><button id="gateway-disconnect" class="btn btn-secondary btn-sm" ${!(gateway.connected || gateway.connections?.claude) || working ? 'disabled' : ''}>Disconnect all accounts</button></div>
          ${gateway.login?.state === 'waiting' ? `<p>Open <a href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">ChatGPT device login</a> and enter <strong>${esc(gateway.login.code)}</strong>.</p>` : ''}
          ${gateway.login?.state === 'waiting_callback' ? `<p>Authorize Claude, then paste the complete localhost address shown in your browser.</p><label class="settings-field">Claude callback URL<input type="password" class="form-input" id="gateway-callback" maxlength="8192" autocomplete="off" value="${esc(callback)}"></label><button id="gateway-submit-callback" class="btn btn-primary btn-sm" ${disabled}>Finish connection</button>` : ''}
          ${gateway.login?.state === 'starting' || gateway.login?.state === 'exchanging' ? '<p role="status">Connecting to provider…</p>' : ''}
          ${gateway.login?.state === 'failed' ? '<p class="settings-warn">Connection failed or expired. Start it again.</p>' : ''}
          <div class="gateway-connection-grid"><div class="gateway-connection"><strong>ChatGPT</strong><span>${gateway.connected ? 'Connected' : 'Not connected'}</span><button id="gateway-login" class="btn btn-secondary btn-sm" ${!gateway.installed || working || waiting ? 'disabled' : ''}>${gateway.connected ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}</button></div><div class="gateway-connection"><strong>Claude</strong><span>${gateway.connections?.claude ? 'Connected' : 'Not connected'}</span><button id="gateway-login-claude" class="btn btn-secondary btn-sm" ${!gateway.installed || working || waiting ? 'disabled' : ''}>${gateway.connections?.claude ? 'Reconnect Claude' : 'Connect Claude'}</button></div></div>
        </section>
        <section class="gateway-card"><div class="gateway-topline"><div><h3>Routing</h3><p class="gateway-muted">Choose which provider handles new conversations.</p></div><label class="gateway-enable"><input type="checkbox" id="gateway-enabled" ${gateway.enabled ? 'checked' : ''} ${(!gateway.connected && !gateway.connections?.claude) || working ? 'disabled' : ''}> Use in new terminals</label></div>
          <label class="settings-field">Route mode<select class="form-input" id="gateway-mode" ${disabled}><option value="chatgpt" ${draftConfig.mode === 'chatgpt' ? 'selected' : ''}>ChatGPT only</option><option value="claude" ${draftConfig.mode === 'claude' ? 'selected' : ''}>Claude only</option><option value="auto" ${draftConfig.mode === 'auto' ? 'selected' : ''}>Auto · Claude first, ChatGPT fallback</option></select></label>
          <p class="gateway-muted">Auto switches providers only for eligible quota or availability errors. It is never enabled automatically.</p>
        </section>
        <section class="gateway-card"><h3>Models by provider</h3><p class="gateway-muted">Saved models remain selected even when absent from the catalog. You can enter a model ID manually.</p>
          ${providerSection('codex', 'ChatGPT', [['Planning', 'planningModel'], ['Execution', 'executionModel'], ['Background', 'smallModel']], gateway.connected)}
          ${providerSection('claude', 'Claude', [['Planning', 'claudePlanningModel'], ['Execution', 'claudeExecutionModel'], ['Background', 'claudeSmallModel']], gateway.connections?.claude)}
          <div class="gateway-save-row"><span class="gateway-muted" id="gateway-dirty" role="status">${changed ? 'You have unsaved changes.' : 'Configuration saved.'}</span><button id="gateway-discard" class="btn btn-secondary btn-sm" ${!changed || working ? 'disabled' : ''}>Discard changes</button><button id="gateway-save" class="btn btn-primary btn-sm" ${!changed || working ? 'disabled' : ''}>Save configuration</button></div>
        </section>
        <details class="gateway-card"><summary>Advanced options and help</summary><div class="gateway-advanced"><label class="settings-field">Shared context budget (tokens)<input class="form-input" type="number" min="32000" max="1000000" id="gateway-context" value="${draftConfig.contextTokens || 1000000}" ${disabled}></label><label class="settings-field">Local port<input class="form-input" type="number" min="1024" max="65535" id="gateway-port" value="${draftConfig.port}" ${gateway.running || working ? 'disabled' : ''}></label><button id="gateway-test" class="btn btn-secondary btn-sm" ${!gateway.running || working ? 'disabled' : ''}>Test saved configuration</button><p class="gateway-muted">This sends a small request and consumes your provider allowance. Model changes apply to future requests; context changes require a new terminal. Disabling stops the proxy and may interrupt its sessions. Disconnecting removes all gateway accounts but does not revoke provider authorization.</p></div></details>
      </div>`;
      body.querySelector('#gateway-install')?.addEventListener('click', () => action('/install', 'POST', null, 'Component installed.'));
      body.querySelector('#gateway-login')?.addEventListener('click', () => action('/login', 'POST', { provider: 'codex' }));
      body.querySelector('#gateway-login-claude')?.addEventListener('click', () => action('/login', 'POST', { provider: 'claude' }));
      body.querySelector('#gateway-submit-callback')?.addEventListener('click', () => action('/callback', 'POST', { redirectUrl: body.querySelector('#gateway-callback').value.trim() }));
      body.querySelector('#gateway-disconnect')?.addEventListener('click', () => { if (window.confirm('This will disconnect all AI Gateway accounts and stop sessions using them. Continue?')) action('/login', 'DELETE', null, 'All accounts disconnected.'); });
      body.querySelector('#gateway-enabled')?.addEventListener('change', event => action('', 'PUT', { enabled: event.target.checked }, event.target.checked ? 'Gateway enabled.' : 'Gateway disabled.'));
      body.querySelector('#gateway-form')?.addEventListener('submit', event => event.preventDefault());
      body.querySelector('#gateway-save')?.addEventListener('click', () => { readDraft(); action('', 'PUT', { ...draftConfig, enabled: Boolean(gateway.enabled) }, 'Configuration saved.', true); });
      body.querySelector('#gateway-discard')?.addEventListener('click', () => { draftConfig = { ...savedConfig }; draw(); });
      body.querySelector('#gateway-test')?.addEventListener('click', () => action('/test', 'POST', null, 'Model request succeeded.'));
      body.querySelectorAll('[data-refresh-provider]').forEach(button => button.addEventListener('click', () => refreshDiscovery(button.dataset.refreshProvider)));
      body.querySelectorAll('[data-model-select]').forEach(select => select.addEventListener('change', () => {
        const field = select.dataset.modelSelect.replace('gateway-', '');
        if (select.value === '__manual__') {
          const wrap = body.querySelector(`#${select.id}-manual-wrap`); wrap.hidden = false;
          body.querySelector(`#${select.id}-manual`)?.focus();
        } else { draftConfig[field] = select.value; draw(true); }
        updateDirty();
      }));
      body.querySelectorAll('.gateway-manual-model input').forEach(input => input.addEventListener('input', () => {
        const field = input.dataset.manualField;
        draftConfig[field] = input.value.trim(); updateDirty();
      }));
      body.querySelector('#gateway-mode')?.addEventListener('change', event => { draftConfig.mode = event.target.value; updateDirty(); });
      body.querySelector('#gateway-context')?.addEventListener('input', event => { draftConfig.contextTokens = Number(event.target.value); updateDirty(); });
      body.querySelector('#gateway-port')?.addEventListener('input', event => { draftConfig.port = Number(event.target.value); updateDirty(); });
      function updateDirty() {
        const dirty = !sameConfig(draftConfig, savedConfig);
        const label = body.querySelector('#gateway-dirty'); if (label) label.textContent = dirty ? 'You have unsaved changes.' : 'Configuration saved.';
        const save = body.querySelector('#gateway-save'); if (save) save.disabled = !dirty || working;
        const discard = body.querySelector('#gateway-discard'); if (discard) discard.disabled = !dirty || working;
      }
      if (focusedId) body.querySelector(`#${focusedId}`)?.focus({ preventScroll: true });
    }
    async function action(route, method, payload, success, saving = false) {
      if (working || !present()) return;
      if (!saving) readDraft();
      const current = { ...draftConfig };
      working = true; draw(true);
      try {
        const res = await api(`/api/settings/gateway${route}`, { method, ...(payload ? { body: payload } : {}) });
        if (!present()) return;
        if (res.gateway) gateway = res.gateway;
        if (saving && res.gateway) { savedConfig = configFrom(res.gateway); draftConfig = { ...savedConfig }; }
        if (success) showToast(route === '/test' && res.model ? `El modelo respondió: ${res.model}` : success, 'success');
      } catch (err) { if (present()) showToast(err.message, 'error'); }
      finally {
        if (!present()) return;
        working = false;
        if (method !== 'PUT' && !['/login', '/callback'].includes(route)) draftConfig = current;
        await refresh(true);
        if (gateway.connections?.claude || gateway.connected) loadDiscovery();
      }
    }
    async function refreshDiscovery(provider) {
      if (refreshPending || working || !present()) return;
      refreshPending = true; draw(true);
      try {
        discovery = await api('/api/settings/gateway/discovery/refresh', { method: 'POST', body: provider ? { provider } : {} });
      } catch (err) { if (present()) showToast(err.message, 'error'); }
      finally { refreshPending = false; if (present()) draw(true); }
    }
    async function loadDiscovery() {
      if (!present()) return;
      try {
        discovery = await api('/api/settings/gateway/discovery');
        if (present()) draw(true);
      } catch { /* Provider discovery is optional; model IDs remain editable. */ }
    }
    async function refresh(preserve = false) {
      clearTimeout(timer); timer = null;
      if (!present()) return;
      try {
        const result = await api('/api/settings/gateway');
        if (!present()) return;
        gateway = result.gateway;
        if (!savedConfig) { savedConfig = configFrom(gateway); draftConfig = { ...savedConfig }; }
        else if (!preserve) { savedConfig = configFrom(gateway); draftConfig = { ...savedConfig }; }
        draw(preserve);
        if (['starting', 'waiting', 'waiting_callback', 'exchanging'].includes(gateway.login?.state)) timer = setTimeout(() => refresh(true), document.hidden ? 4000 : 2000);
      } catch (err) { if (present()) body.textContent = err.message; }
    }
    await refresh();
    if (gateway?.connected || gateway?.connections?.claude) {
      await loadDiscovery();
      if (discovery?.providers?.codex?.models?.stale || discovery?.providers?.claude?.models?.stale || discovery?.providers?.codex?.usage?.stale || discovery?.providers?.claude?.usage?.stale || (!discovery?.providers?.codex?.models?.fetchedAt && !discovery?.providers?.claude?.models?.fetchedAt)) refreshDiscovery();
    }
  }
  window.CitadelGatewaySettings = { init, dispose };
})();
