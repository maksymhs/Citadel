/** Settings → AI Gateway: provider connections, model preferences and usage. */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'showToast'];
  const FIELDS = ['claudeEnabled', 'codexEnabled', 'opencodeEnabled', 'mode', 'planningProvider', 'executionProvider', 'smallProvider', 'contextTokens', 'planningModel', 'executionModel', 'smallModel', 'claudePlanningModel', 'claudeExecutionModel', 'claudeSmallModel', 'port'];
  const MODEL_IDS = { planningModel: 'gateway-planning', executionModel: 'gateway-execution', smallModel: 'gateway-small', claudePlanningModel: 'gateway-claude-planning', claudeExecutionModel: 'gateway-claude-execution', claudeSmallModel: 'gateway-claude-small' };
  const ROLE_IDS = { planningProvider: 'gateway-role-planning', executionProvider: 'gateway-role-execution', smallProvider: 'gateway-role-small' };
  const ROLE_LABELS = { planningProvider: 'Planning', executionProvider: 'Execution', smallProvider: 'Background' };
  const MODE_OPTIONS = [
    ['chatgpt', 'ChatGPT'], ['claude', 'Claude'],
    ['auto-chatgpt', 'Auto: ChatGPT first, then Claude'], ['auto', 'Auto: Claude first, then ChatGPT'],
    ['balanced', 'Balanced: most headroom first'], ['roles', 'By role'],
  ];
  const MODE_HELP = {
    roles: 'Each role uses one provider with no fallback: if that provider runs out, requests for that role fail.',
    balanced: 'Balanced is opt-in: the provider with more remaining subscription headroom goes first and the other is the fallback. It reads best-effort usage every 5 minutes and keeps the current choice when data is missing.',
  };
  let timer = null;
  let instance = 0;
  function requiredProviders(config) {
    if (config.mode === 'roles') return [...new Set(Object.keys(ROLE_IDS).map(key => config[key]))];
    if (config.mode === 'chatgpt') return ['codex'];
    if (config.mode === 'claude') return ['claude'];
    return ['codex', 'claude'];
  }
  function balanceLine(balance, esc) {
    if (!balance) return '';
    const name = provider => provider === 'codex' ? 'ChatGPT' : 'Claude';
    const free = value => typeof value === 'number' ? `${Math.round(value)}% free` : 'usage unavailable';
    const checked = balance.evaluatedAt && Number.isFinite(Date.parse(balance.evaluatedAt)) ? ` · checked ${esc(new Date(balance.evaluatedAt).toLocaleTimeString())}` : ' · not checked yet';
    const headroom = balance.headroom ? ` · Claude ${free(balance.headroom.claude)}, ChatGPT ${free(balance.headroom.codex)}` : '';
    return `<p class="gateway-muted gateway-balance" role="status">Balanced primary: <strong>${esc(name(balance.primary))}</strong>${headroom}${checked}.${balance.reason ? ` ${esc(balance.reason)}` : ''}</p>`;
  }
  function roleSelectors(draftConfig, disabled) {
    return `<div class="gateway-role-grid">${Object.keys(ROLE_IDS).map(key => `<label class="settings-field"><span>${ROLE_LABELS[key]}</span><select class="form-input" id="${ROLE_IDS[key]}" data-role-select="${key}" ${disabled}><option value="claude" ${draftConfig[key] === 'claude' ? 'selected' : ''}>Claude</option><option value="codex" ${draftConfig[key] === 'codex' ? 'selected' : ''}>ChatGPT</option></select></label>`).join('')}</div>`;
  }
  function dispose() { clearTimeout(timer); timer = null; instance++; }
  const escapeAttr = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  function configFrom(gateway) { return Object.fromEntries(FIELDS.map(key => [key, key === 'claudeEnabled' ? gateway[key] !== false : gateway[key]])); }
  function sameConfig(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function modelOptions(id, field, value, provider, discovery, esc) {
    const catalog = discovery?.providers?.[provider]?.models?.items || [];
    const items = catalog.filter(item => !/(?:^|[-_/])(image|embedding|embeddings|tts|whisper|audio|moderation)(?:$|[-_/])/i.test(item.id));
    const known = items.some(item => item.id === value);
    const options = [];
    if (!value) options.push('<option value="" selected disabled>Select a model</option>');
    if (value && !known) options.push(`<option value="${escapeAttr(value)}" selected>${esc(value)} · ${catalog.some(item => item.id === value) ? 'Saved, outside coding list' : 'Saved, not verified'}</option>`);
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
        const id = key === 'claudeEnabled' ? 'gateway-claude' : key === 'codexEnabled' ? 'gateway-codex' : key === 'opencodeEnabled' ? 'gateway-opencode' : key === 'mode' ? 'gateway-mode' : ROLE_IDS[key] ? ROLE_IDS[key] : key === 'contextTokens' ? 'gateway-context' : key === 'port' ? 'gateway-port' : MODEL_IDS[key];
        const field = body.querySelector(`#${id}`);
        if (field) draftConfig[key] = key.endsWith('Enabled') ? field.checked : key === 'contextTokens' || key === 'port' ? Number(field.value) : field.value;
      }
    }
    function quotaMarkup(provider) {
      const state = discovery?.providers?.[provider];
      const usage = state?.usage;
      if (!state?.connected) return '<p class="gateway-muted">Connect to see provider-reported usage.</p>';
      if (!usage || usage.status === 'unavailable' || !usage.accounts?.length) return '<p class="gateway-muted">Usage unavailable. Model settings still work.</p>';
      const accounts = usage.accounts.map((account, accountIndex) => {
        const renderWindow = window => {
          const percent = window.usedPercent;
          const valid = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100;
          const duration = window.durationSeconds;
          const suffix = /^seven_day_(opus|sonnet)$/.exec(window.id || '')?.[1];
          const label = duration === 18000 ? '5-hour window' : duration === 604800 ? `7-day window${suffix ? ` · ${suffix === 'opus' ? 'Opus' : 'Sonnet'}` : ''}` : window.label || window.id || 'Additional limit';
          const meter = valid ? `<div class="gateway-meter" role="meter" aria-label="${esc(`${account.label || `Account ${accountIndex + 1}`} ${label} usage`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${percent}% used"><span style="width:${percent}%"></span></div>` : '';
          const reset = formatReset(window.resetsAt);
          return `<div class="gateway-usage-row"><div class="gateway-usage-label"><span>${esc(label)}</span><strong>${valid ? `${percent}% used` : 'Unavailable'}</strong></div>${meter}${reset ? `<span class="gateway-reset">${reset}</span>` : ''}</div>`;
        };
        const windows = account.windows || [];
        const primary = windows.filter(window => window.durationSeconds === 18000 || window.durationSeconds === 604800);
        const extra = windows.filter(window => !primary.includes(window));
        const rows = primary.map(renderWindow).join('') + (extra.length ? `<details id="gateway-limits-${provider}-${accountIndex}" class="gateway-extra-limits"><summary>Additional limits (${extra.length})</summary><p class="gateway-muted">Provider-reported limits with no standard 5-hour or 7-day window. Labels are shown as received.</p>${extra.map(renderWindow).join('')}</details>` : '');
        return `<section class="gateway-account" aria-label="${esc(account.label || `Account ${accountIndex + 1}`)}">${usage.accounts.length > 1 ? `<strong>${esc(account.label || `Account ${accountIndex + 1}`)}</strong>` : ''}${rows || '<span class="gateway-muted">Usage unavailable.</span>'}</section>`;
      }).join('');
      const updated = usage.fetchedAt && Number.isFinite(Date.parse(usage.fetchedAt)) ? ` · updated ${esc(new Date(usage.fetchedAt).toLocaleString())}` : '';
      return `<div class="gateway-usage" aria-live="polite">${usage.stale ? `<p class="gateway-muted">Showing possibly stale usage${updated}.</p>` : ''}${accounts}</div>`;
    }
    function modelSource(provider) {
      const models = discovery?.providers?.[provider]?.models;
      if (!models || models.status === 'unavailable') return `<details id="gateway-model-source-${provider}" class="gateway-model-help"><summary>About model lists</summary><p class="gateway-muted">Catalog unavailable; saved model IDs are preserved. A listed model does not guarantee account access.</p></details>`;
      if (models.stale) return `<p class="gateway-muted">Showing possibly outdated catalog${models.fetchedAt ? ` · updated ${esc(new Date(models.fetchedAt).toLocaleString())}` : ''}.</p>`;
      return `<details id="gateway-model-source-${provider}" class="gateway-model-help"><summary>About model lists</summary><p class="gateway-muted">${models.source === 'credential_catalog' ? 'Models reported for this account' : 'Proxy catalog; account access not verified'}${models.fetchedAt ? ` · updated ${esc(new Date(models.fetchedAt).toLocaleString())}` : ''}. A listed model is not guaranteed to be available to your subscription.</p></details>`;
    }
    function draw(preserve = false) {
      if (!present() || !gateway) return;
      if (preserve) readDraft();
      const callback = body.querySelector('#gateway-callback')?.value || '';
      const focusedId = body.contains(document.activeElement) ? document.activeElement.id : '';
      const detailsOpen = new Map([...body.querySelectorAll('details[id]')].map(detail => [detail.id, detail.open]));
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
        return `<section class="gateway-provider" aria-labelledby="gateway-${provider}-heading"><div class="gateway-provider-heading"><div><h3 id="gateway-${provider}-heading">${label}</h3><span class="gateway-status">${connected ? 'Connected' : 'Not connected'}</span></div><div class="gateway-provider-actions"><button type="button" id="${loginButton}" class="btn btn-secondary btn-sm" ${!gateway.installed || working || waiting || ['starting', 'exchanging'].includes(loginState) ? 'disabled' : ''}>${actionLabel}</button><button type="button" class="btn btn-secondary btn-sm" data-refresh-provider="${provider}" ${!connected || working || refreshPending ? 'disabled' : ''}>Refresh</button></div></div>${authMarkup}${info?.message ? `<p class="gateway-muted">${esc(info.message)}</p>` : ''}<details id="gateway-models-${provider}" class="gateway-model-editor"><summary>Models <span class="gateway-muted">${esc(draftConfig[fields[1][1]] || 'Choose a coding model')}</span></summary><div class="gateway-model-grid">${fields.map(([title, key]) => `<label class="settings-field"><span>${title}</span>${modelOptions(MODEL_IDS[key], key, draftConfig[key] || '', provider, discovery, esc)}</label>`).join('')}</div>${modelSource(provider)}<p class="gateway-muted">Planning for difficult decisions, execution for coding, background for small tasks. Image and audio models are hidden; saved choices are kept.</p></details>${quotaMarkup(provider)}</section>`;
      };
      body.innerHTML = `<div class="gateway-settings">
        <section class="gateway-card gateway-power"><div><strong class="gateway-live-status" role="status">${esc(gateway.running ? 'Gateway running' : gateway.enabled ? 'Enabled · start required' : 'Gateway off')}</strong><p class="gateway-muted">One connection for your coding tools.</p></div><label class="gateway-enable"><input type="checkbox" id="gateway-enabled" ${gateway.enabled ? 'checked' : ''} ${(!gateway.enabled && (!gateway.installed || (!gateway.connected && !gateway.connections?.claude))) || working ? 'disabled' : ''}> Enable gateway</label><p class="gateway-muted">The power switch applies immediately. Save other changes below.</p></section>
        ${gateway.error ? `<p class="settings-warn">${esc(gateway.error)}</p>` : ''}
        ${!gateway.installed ? `<section class="gateway-card"><div><strong>Gateway component not installed</strong><p class="gateway-muted">Optional local component; it listens only on this machine.</p></div><button id="gateway-install" class="btn btn-secondary btn-sm" ${!gateway.supported || working ? 'disabled' : ''}>Install component</button>${!gateway.supported ? '<p class="settings-warn">Installation supports Linux/macOS x64/arm64.</p>' : ''}</section>` : ''}
        <section class="gateway-step" aria-labelledby="gateway-accounts-title"><h3 id="gateway-accounts-title">1. Connect your accounts</h3><p class="gateway-muted">Connect once. All selected tools share these accounts and their limits.</p><div class="gateway-provider-grid">${providerSection('codex', 'ChatGPT', [['Planning', 'planningModel'], ['Execution', 'executionModel'], ['Background', 'smallModel']], gateway.connected)}${providerSection('claude', 'Claude', [['Planning', 'claudePlanningModel'], ['Execution', 'claudeExecutionModel'], ['Background', 'claudeSmallModel']], gateway.connections?.claude)}</div></section>
        <section class="gateway-card gateway-step" aria-labelledby="gateway-route-title"><h3 id="gateway-route-title">2. Choose a route</h3><label class="settings-field gateway-route">Use accounts<select class="form-input" id="gateway-mode" ${disabled}>${MODE_OPTIONS.map(([value, label]) => `<option value="${value}" ${draftConfig.mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${draftConfig.mode === 'roles' ? roleSelectors(draftConfig, disabled) : ''}<p class="gateway-muted">${MODE_HELP[draftConfig.mode] || 'Auto uses the first provider and falls back to the other if quota or availability allows. Both accounts must be connected.'}</p>${draftConfig.mode === 'balanced' && gateway.mode === 'balanced' ? balanceLine(gateway.balance, esc) : ''}<p id="gateway-route-status" role="status" class="gateway-muted"></p></section>
        <section class="gateway-card gateway-step" aria-labelledby="gateway-tools-title"><h3 id="gateway-tools-title">3. Choose your tools</h3><p class="gateway-muted">On: use AI Gateway. Off: use the tool’s own configuration.</p><div class="gateway-tools">
          <label class="gateway-tool"><input type="checkbox" id="gateway-claude" ${draftConfig.claudeEnabled ? 'checked' : ''} ${disabled}><span><strong>Claude Code</strong><small>Planning + execution · opusplan</small></span><code>claude</code></label>
          <label class="gateway-tool"><input type="checkbox" id="gateway-opencode" ${draftConfig.opencodeEnabled ? 'checked' : ''} ${disabled}><span><strong>OpenCode <span class="gateway-muted">Experimental</span></strong><small>Plan + Build · switch with Tab</small></span><code>opencode</code></label>
          <label class="gateway-tool"><input type="checkbox" id="gateway-codex" ${draftConfig.codexEnabled ? 'checked' : ''} ${disabled}><span><strong>Codex CLI <span class="gateway-muted">Experimental</span></strong><small>Uses the execution model</small></span><code>codex</code></label>
        </div><p class="gateway-muted">Save changes, then open a new project terminal and run the selected command. Install missing tools in Machines → Tools.</p></section>
        <details id="gateway-advanced" class="gateway-card"><summary>Advanced settings</summary><div class="gateway-advanced"><p class="gateway-muted gateway-context-summary">Saved shared context budget: <strong>${Number(gateway.contextTokens || 1000000).toLocaleString()} tokens${Number(gateway.contextTokens || 1000000) === 1000000 ? ' (1M)' : ''}</strong>. Keep this within every selected model’s capacity.</p><label class="settings-field">Shared context budget (tokens)<input class="form-input" type="number" min="32000" max="1000000" id="gateway-context" value="${draftConfig.contextTokens || 1000000}" ${disabled}></label>${Number(draftConfig.contextTokens) < 1000000 ? '<button type="button" class="btn btn-secondary btn-sm" id="gateway-context-restore">Restore 1M context in draft</button>' : ''}<label class="settings-field">Local port<input class="form-input" type="number" min="1024" max="65535" id="gateway-port" value="${draftConfig.port}" ${gateway.running || working ? 'disabled' : ''}></label><button id="gateway-test" class="btn btn-secondary btn-sm" ${!gateway.running || working ? 'disabled' : ''}>Test saved configuration</button><button id="gateway-disconnect" class="btn btn-secondary btn-sm" ${!(gateway.connected || gateway.connections?.claude) || working ? 'disabled' : ''}>Disconnect all accounts</button><p class="gateway-muted">The test sends a small request and consumes provider allowance. Model changes apply to future requests; context changes require a new terminal. Disabling stops the proxy and may interrupt its sessions. Disconnecting removes all gateway accounts but does not revoke provider authorization.</p></div></details>
        <div class="gateway-save-row"><span class="gateway-muted" id="gateway-dirty" role="status">${changed ? 'You have unsaved changes.' : 'Configuration saved.'}</span><button id="gateway-discard" class="btn btn-secondary btn-sm" ${!changed || working ? 'disabled' : ''}>Discard changes</button><button id="gateway-save" class="btn btn-primary btn-sm" ${!changed || working ? 'disabled' : ''}>Save changes</button></div>
      </div>`;
      body.querySelectorAll('details[id]').forEach(detail => { detail.open = detailsOpen.get(detail.id) || false; });
      body.querySelector('#gateway-install')?.addEventListener('click', () => action('/install', 'POST', null, 'Component installed.'));
      body.querySelector('#gateway-login')?.addEventListener('click', () => action('/login', 'POST', { provider: 'codex' }));
      body.querySelector('#gateway-login-claude')?.addEventListener('click', () => action('/login', 'POST', { provider: 'claude' }));
      body.querySelector('#gateway-submit-callback')?.addEventListener('click', () => action('/callback', 'POST', { redirectUrl: body.querySelector('#gateway-callback').value.trim() }));
      body.querySelector('#gateway-disconnect')?.addEventListener('click', () => { if (window.confirm('This will disconnect all AI Gateway accounts and stop sessions using them. Continue?')) action('/login', 'DELETE', null, 'All accounts disconnected.'); });
      body.querySelector('#gateway-enabled')?.addEventListener('change', event => action('', 'PUT', { enabled: event.target.checked }, event.target.checked ? 'Gateway enabled.' : 'Gateway disabled.'));
      body.querySelector('#gateway-save')?.addEventListener('click', () => { readDraft(); action('', 'PUT', { ...draftConfig, enabled: Boolean(gateway.enabled) }, 'Configuration saved.', true); });
      body.querySelector('#gateway-discard')?.addEventListener('click', () => { draftConfig = { ...savedConfig }; draw(); });
      body.querySelector('#gateway-test')?.addEventListener('click', () => action('/test', 'POST', null, 'Model request succeeded.'));
      body.querySelectorAll('[data-refresh-provider]').forEach(button => button.addEventListener('click', () => refreshDiscovery(button.dataset.refreshProvider)));
      body.querySelectorAll('[data-model-select]').forEach(select => select.addEventListener('change', () => { draftConfig[select.dataset.modelSelect] = select.value; updateDirty(); }));
      body.querySelector('#gateway-claude')?.addEventListener('change', event => { draftConfig.claudeEnabled = event.target.checked; updateDirty(); });
      body.querySelector('#gateway-codex')?.addEventListener('change', event => { draftConfig.codexEnabled = event.target.checked; updateDirty(); });
      body.querySelector('#gateway-opencode')?.addEventListener('change', event => { draftConfig.opencodeEnabled = event.target.checked; updateDirty(); });
      body.querySelector('#gateway-mode')?.addEventListener('change', event => { draftConfig.mode = event.target.value; draw(true); });
      body.querySelectorAll('[data-role-select]').forEach(select => select.addEventListener('change', () => { draftConfig[select.dataset.roleSelect] = select.value; updateDirty(); }));
      body.querySelector('#gateway-context')?.addEventListener('input', event => { draftConfig.contextTokens = Number(event.target.value); updateDirty(); });
      body.querySelector('#gateway-context-restore')?.addEventListener('click', () => {
        draftConfig.contextTokens = 1000000;
        draw();
      });
      body.querySelector('#gateway-port')?.addEventListener('input', event => { draftConfig.port = Number(event.target.value); updateDirty(); });
      function updateDirty() {
        const required = requiredProviders(draftConfig);
        const missing = required.filter(provider => provider === 'codex' ? !gateway.connected : !gateway.connections?.claude);
        const routeStatus = body.querySelector('#gateway-route-status');
        if (routeStatus) routeStatus.textContent = missing.length ? `Connect ${missing.map(provider => provider === 'codex' ? 'ChatGPT' : 'Claude').join(' and ')} to use this route.` : required.length > 1 ? 'Both accounts are connected.' : `${required[0] === 'codex' ? 'ChatGPT' : 'Claude'} is connected.`;
        const dirty = !sameConfig(draftConfig, savedConfig);
        const label = body.querySelector('#gateway-dirty'); if (label) label.textContent = dirty ? 'You have unsaved changes.' : 'Configuration saved.';
        const save = body.querySelector('#gateway-save'); if (save) save.disabled = !dirty || working;
        const discard = body.querySelector('#gateway-discard'); if (discard) discard.disabled = !dirty || working;
      }
      updateDirty();
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
