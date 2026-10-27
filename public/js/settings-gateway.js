/** Settings → Claude Code Gateway: provider connections, model preferences and usage. */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'showToast'];
  const FIELDS = ['opencodeEnabled', 'mode', 'contextTokens', 'planningModel', 'executionModel', 'smallModel', 'claudePlanningModel', 'claudeExecutionModel', 'claudeSmallModel', 'port'];
  const MODEL_IDS = { planningModel: 'gateway-planning', executionModel: 'gateway-execution', smallModel: 'gateway-small', claudePlanningModel: 'gateway-claude-planning', claudeExecutionModel: 'gateway-claude-execution', claudeSmallModel: 'gateway-claude-small' };
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
    if (value && !known) options.push(`<option value="${escapeAttr(value)}" selected>${esc(value)} · Saved, not verified</option>`);
    options.push(...items.map(item => `<option value="${escapeAttr(item.id)}" ${item.id === value && known ? 'selected' : ''}>${esc(item.label || item.id)}</option>`));
    return `<select class="form-input" id="${id}" data-model-select="${field}" aria-label="${field.includes('Small') || field === 'smallModel' ? 'Background' : field.includes('Execution') || field === 'executionModel' ? 'Execution' : 'Planning'} model">${options.join('')}</select>`;
  }
  function formatReset(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp);
    const seconds = Math.max(0, Math.floor((timestamp - Date.now()) / 1000));
    const remaining = seconds >= 86400 ? `${Math.floor(seconds / 86400)} d ${Math.floor(seconds % 86400 / 3600)} h` : seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min` : seconds >= 60 ? `${Math.floor(seconds / 60)} min` : '<1 min';
    const relative = timestamp <= Date.now() ? 'reported reset is in the past' : `resets in ${remaining}`;
    const fullDate = date.toLocaleString();
    return `<time datetime="${date.toISOString()}" tabindex="0" aria-label="Reset ${escapeAttr(fullDate)}; ${relative}" title="${escapeAttr(fullDate)}">${relative}</time>`;
  }
  function safeAuthorizationUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === 'https://claude.ai' && url.pathname === '/oauth/authorize' ? url.href : '';
    } catch { return ''; }
  }
  async function init(ctx) {
    for (const key of REQUIRED) if (typeof ctx[key] !== 'function') throw new Error(`Claude Code Gateway requires ${key}`);
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
        const id = key === 'opencodeEnabled' ? 'gateway-opencode' : key === 'mode' ? 'gateway-mode' : key === 'contextTokens' ? 'gateway-context' : key === 'port' ? 'gateway-port' : MODEL_IDS[key];
        const field = body.querySelector(`#${id}`);
        if (field) draftConfig[key] = key === 'opencodeEnabled' ? field.checked : key === 'contextTokens' || key === 'port' ? Number(field.value) : field.value;
      }
    }
    function quotaMarkup(provider) {
      const state = discovery?.providers?.[provider];
      const usage = state?.usage;
      if (!state?.connected) return '<p class="gateway-muted">Connect to see provider-reported usage.</p>';
      if (!usage || usage.status === 'unavailable' || !usage.accounts?.length) return '<p class="gateway-muted">Usage unavailable. Model settings still work.</p>';
      const accounts = usage.accounts.map((account, accountIndex) => {
        const rows = (account.windows || []).map((window, windowIndex) => {
          const percent = window.usedPercent;
          const valid = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100;
          const label = window.label || window.id || 'Usage window';
          const meter = valid ? `<div class="gateway-meter" role="meter" aria-label="${esc(`${account.label || `Account ${accountIndex + 1}`} ${label} usage`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${percent}% used"><span style="width:${percent}%"></span></div>` : '';
          const reset = formatReset(window.resetsAt);
          return `<div class="gateway-usage-row"><div class="gateway-usage-label"><span>${esc(label)}</span><strong>${valid ? `${percent}% used` : 'Unavailable'}</strong></div>${meter}${reset ? `<span class="gateway-reset">${reset}</span>` : ''}</div>`;
        }).join('');
        return `<section class="gateway-account" aria-label="${esc(account.label || `Account ${accountIndex + 1}`)}"><strong>${esc(account.label || `Account ${accountIndex + 1}`)}</strong>${rows || '<span class="gateway-muted">Usage unavailable.</span>'}</section>`;
      }).join('');
      const updated = usage.fetchedAt && Number.isFinite(Date.parse(usage.fetchedAt)) ? ` · updated ${esc(new Date(usage.fetchedAt).toLocaleString())}` : '';
      return `<div class="gateway-usage" aria-live="polite">${usage.stale ? `<p class="gateway-muted">Showing possibly stale usage${updated}.</p>` : ''}${accounts}</div>`;
    }
    function modelSource(provider) {
      const models = discovery?.providers?.[provider]?.models;
      if (!models || models.status === 'unavailable') return '<details class="gateway-model-help"><summary>About model lists</summary><p class="gateway-muted">Catalog unavailable; saved model IDs are preserved. A listed model does not guarantee account access.</p></details>';
      if (models.stale) return `<p class="gateway-muted">Showing possibly outdated catalog${models.fetchedAt ? ` · updated ${esc(new Date(models.fetchedAt).toLocaleString())}` : ''}.</p>`;
      return `<details class="gateway-model-help"><summary>About model lists</summary><p class="gateway-muted">${models.source === 'credential_catalog' ? 'Models reported for this account' : 'Proxy catalog; account access not verified'}${models.fetchedAt ? ` · updated ${esc(new Date(models.fetchedAt).toLocaleString())}` : ''}. A listed model is not guaranteed to be available to your subscription.</p></details>`;
    }
    function draw(preserve = false) {
      if (!present() || !gateway) return;
      if (preserve) readDraft();
      const callback = body.querySelector('#gateway-callback')?.value || '';
      const focusedId = body.contains(document.activeElement) ? document.activeElement.id : '';
      const detailsOpen = [...body.querySelectorAll('details')].map(detail => detail.open);
      const waiting = ['starting', 'waiting', 'waiting_callback', 'exchanging'].includes(gateway.login?.state);
      const disabled = working ? 'disabled' : '';
      const changed = !sameConfig(draftConfig, savedConfig);
      const providerSection = (provider, label, fields, connected) => {
        const info = discovery?.providers?.[provider];
        const loginProvider = provider === 'codex' ? 'codex' : 'claude';
        const loginState = gateway.login?.provider === loginProvider ? gateway.login.state : '';
        const loginButton = provider === 'codex' ? 'gateway-login' : 'gateway-login-claude';
        const actionLabel = loginState === 'waiting' ? 'Waiting for authorization…' : connected ? `Reconnect ${label}` : `Connect ${label}`;
        const oauthUrl = provider === 'claude' && loginState === 'waiting_callback' ? safeAuthorizationUrl(gateway.login?.url) : '';
        const authMarkup = loginState === 'waiting' && provider === 'codex' ? `<p class="gateway-auth-prompt">Open <a href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">ChatGPT device login</a> and enter <strong>${esc(gateway.login.code || '')}</strong>.</p>` : loginState === 'waiting_callback' && provider === 'claude' ? `<div class="gateway-auth-prompt"><p>${oauthUrl ? `Authorize Claude in <a href="${escapeAttr(oauthUrl)}" target="_blank" rel="noopener noreferrer">the opened authorization page</a>, then paste the complete localhost address shown in your browser.` : 'Authorize Claude, then paste the complete localhost address shown in your browser.'}</p><label class="settings-field">Claude callback URL<input type="password" class="form-input" id="gateway-callback" maxlength="8192" autocomplete="off" value="${esc(callback)}"></label><button id="gateway-submit-callback" class="btn btn-primary btn-sm" ${disabled}>Finish connection</button></div>` : loginState === 'failed' ? '<p class="settings-warn">Connection failed or expired. Start it again.</p>' : loginState === 'starting' || loginState === 'exchanging' ? '<p class="gateway-muted" role="status">Connecting…</p>' : '';
        return `<section class="gateway-provider" aria-labelledby="gateway-${provider}-heading"><div class="gateway-provider-heading"><div><h3 id="gateway-${provider}-heading">${label}</h3><span class="gateway-status">${connected ? 'Connected' : 'Not connected'}</span></div><div class="gateway-provider-actions"><button type="button" id="${loginButton}" class="btn btn-secondary btn-sm" ${!gateway.installed || working || waiting || ['starting', 'exchanging'].includes(loginState) ? 'disabled' : ''}>${actionLabel}</button><button type="button" class="btn btn-secondary btn-sm" data-refresh-provider="${provider}" ${!connected || working || refreshPending ? 'disabled' : ''}>Refresh</button></div></div>${authMarkup}${info?.message ? `<p class="gateway-muted">${esc(info.message)}</p>` : ''}<div class="gateway-model-grid">${fields.map(([title, key]) => `<label class="settings-field"><span>${title}</span>${modelOptions(MODEL_IDS[key], key, draftConfig[key] || '', provider, discovery, esc)}</label>`).join('')}</div>${modelSource(provider)}${quotaMarkup(provider)}</section>`;
      };
      body.innerHTML = `<div class="gateway-settings">
        <section class="gateway-card gateway-control-row"><div><span class="gateway-live-status" role="status">${esc(gateway.running ? 'Gateway running' : gateway.enabled ? 'Enabled · start required' : 'Gateway disabled')}</span><label class="gateway-enable"><input type="checkbox" id="gateway-enabled" ${gateway.enabled ? 'checked' : ''} ${(!gateway.connected && !gateway.connections?.claude) || working ? 'disabled' : ''}> Use in new terminals</label></div><label class="settings-field gateway-route">Route<select class="form-input" id="gateway-mode" ${disabled}><option value="chatgpt" ${draftConfig.mode === 'chatgpt' ? 'selected' : ''}>ChatGPT</option><option value="claude" ${draftConfig.mode === 'claude' ? 'selected' : ''}>Claude</option><option value="auto" ${draftConfig.mode === 'auto' ? 'selected' : ''}>Auto</option></select></label><p class="gateway-muted">Auto is opt-in: Claude first, ChatGPT fallback for eligible availability or quota errors. Both accounts must be connected.</p></section>
        <section class="gateway-card"><label class="gateway-enable"><input type="checkbox" id="gateway-opencode" ${draftConfig.opencodeEnabled ? 'checked' : ''} ${disabled}> Use this gateway in OpenCode (experimental)</label><p class="gateway-muted">Applies to new project terminals and agent launches after saving. OpenCode uses the same connected accounts and routes, with Plan for the planning model, Build for execution, automatic compaction and old tool-output pruning. Switch Plan/Build with Tab. Leave off for native OpenCode. Codex CLI retains its native configuration.</p></section>
        <p class="gateway-muted gateway-context-summary">Saved shared context budget: <strong>${Number(gateway.contextTokens || 1000000).toLocaleString()} tokens${Number(gateway.contextTokens || 1000000) === 1000000 ? ' (1M)' : ''}</strong>. This is a launch budget, not a guarantee of model access or output size.</p>
        ${gateway.error ? `<p class="settings-warn">${esc(gateway.error)}</p>` : ''}
        ${!gateway.installed ? `<section class="gateway-card"><div><strong>Gateway component not installed</strong><p class="gateway-muted">Optional local component; it listens only on this machine.</p></div><button id="gateway-install" class="btn btn-secondary btn-sm" ${!gateway.supported || working ? 'disabled' : ''}>Install component</button>${!gateway.supported ? '<p class="settings-warn">Installation supports Linux/macOS x64/arm64.</p>' : ''}</section>` : ''}
        <div class="gateway-provider-grid">${providerSection('codex', 'ChatGPT', [['Planning', 'planningModel'], ['Execution', 'executionModel'], ['Background', 'smallModel']], gateway.connected)}${providerSection('claude', 'Claude', [['Planning', 'claudePlanningModel'], ['Execution', 'claudeExecutionModel'], ['Background', 'claudeSmallModel']], gateway.connections?.claude)}</div>
        <details class="gateway-card"><summary>Advanced options and help</summary><div class="gateway-advanced"><label class="settings-field">Shared context budget (tokens)<input class="form-input" type="number" min="32000" max="1000000" id="gateway-context" value="${draftConfig.contextTokens || 1000000}" ${disabled}></label>${Number(draftConfig.contextTokens) < 1000000 ? '<button type="button" class="btn btn-secondary btn-sm" id="gateway-context-restore">Restore 1M context in draft</button>' : ''}<label class="settings-field">Local port<input class="form-input" type="number" min="1024" max="65535" id="gateway-port" value="${draftConfig.port}" ${gateway.running || working ? 'disabled' : ''}></label><button id="gateway-test" class="btn btn-secondary btn-sm" ${!gateway.running || working ? 'disabled' : ''}>Test saved configuration</button><button id="gateway-disconnect" class="btn btn-secondary btn-sm" ${!(gateway.connected || gateway.connections?.claude) || working ? 'disabled' : ''}>Disconnect all accounts</button><p class="gateway-muted">The test sends a small request and consumes provider allowance. Model changes apply to future requests; context changes require a new terminal. Disabling stops the proxy and may interrupt its sessions. Disconnecting removes all gateway accounts but does not revoke provider authorization.</p></div></details>
        <div class="gateway-save-row"><span class="gateway-muted" id="gateway-dirty" role="status">${changed ? 'You have unsaved changes.' : 'Configuration saved.'}</span><button id="gateway-discard" class="btn btn-secondary btn-sm" ${!changed || working ? 'disabled' : ''}>Discard changes</button><button id="gateway-save" class="btn btn-primary btn-sm" ${!changed || working ? 'disabled' : ''}>Save configuration</button></div>
      </div>`;
      body.querySelectorAll('details').forEach((detail, index) => { detail.open = detailsOpen[index] || false; });
      body.querySelector('#gateway-install')?.addEventListener('click', () => action('/install', 'POST', null, 'Component installed.'));
      body.querySelector('#gateway-login')?.addEventListener('click', () => action('/login', 'POST', { provider: 'codex' }));
      body.querySelector('#gateway-login-claude')?.addEventListener('click', () => action('/login', 'POST', { provider: 'claude' }));
      body.querySelector('#gateway-submit-callback')?.addEventListener('click', () => action('/callback', 'POST', { redirectUrl: body.querySelector('#gateway-callback').value.trim() }));
      body.querySelector('#gateway-disconnect')?.addEventListener('click', () => { if (window.confirm('This will disconnect all Claude Code Gateway accounts and stop sessions using them. Continue?')) action('/login', 'DELETE', null, 'All accounts disconnected.'); });
      body.querySelector('#gateway-enabled')?.addEventListener('change', event => action('', 'PUT', { enabled: event.target.checked }, event.target.checked ? 'Gateway enabled.' : 'Gateway disabled.'));
      body.querySelector('#gateway-save')?.addEventListener('click', () => { readDraft(); action('', 'PUT', { ...draftConfig, enabled: Boolean(gateway.enabled) }, 'Configuration saved.', true); });
      body.querySelector('#gateway-discard')?.addEventListener('click', () => { draftConfig = { ...savedConfig }; draw(); });
      body.querySelector('#gateway-test')?.addEventListener('click', () => action('/test', 'POST', null, 'Model request succeeded.'));
      body.querySelectorAll('[data-refresh-provider]').forEach(button => button.addEventListener('click', () => refreshDiscovery(button.dataset.refreshProvider)));
      body.querySelectorAll('[data-model-select]').forEach(select => select.addEventListener('change', () => { draftConfig[select.dataset.modelSelect] = select.value; updateDirty(); }));
      body.querySelector('#gateway-opencode')?.addEventListener('change', event => { draftConfig.opencodeEnabled = event.target.checked; updateDirty(); });
      body.querySelector('#gateway-mode')?.addEventListener('change', event => { draftConfig.mode = event.target.value; updateDirty(); });
      body.querySelector('#gateway-context')?.addEventListener('input', event => { draftConfig.contextTokens = Number(event.target.value); updateDirty(); });
      body.querySelector('#gateway-context-restore')?.addEventListener('click', () => {
        draftConfig.contextTokens = 1000000;
        draw();
      });
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
        if (success) showToast(route === '/test' && res.model ? `The model responded: ${res.model}` : success, 'success');
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
      try { discovery = await api('/api/settings/gateway/discovery/refresh', { method: 'POST', body: provider ? { provider } : {} }); }
      catch (err) { if (present()) showToast(err.message, 'error'); }
      finally { refreshPending = false; if (present()) draw(true); }
    }
    async function loadDiscovery() {
      if (!present()) return;
      try { discovery = await api('/api/settings/gateway/discovery'); if (present()) draw(true); }
      catch { /* Provider discovery is optional; saved model IDs remain available. */ }
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
