/* Telegram director configuration and observed project execution status. */
(() => {
  async function init(ctx) {
    for (const key of ['api', 'escapeHtml', 'showToast']) if (!ctx[key]) throw new Error('Director settings requires ' + key);
    const { api, escapeHtml: esc, showToast } = ctx;
    const root = document.getElementById('director-body');
    if (!root) return;
    let snapshot;
    try { snapshot = await api('/api/director'); } catch { root.textContent = 'Director settings are unavailable.'; return; }
    if (!root.isConnected) return;
    const cfg = snapshot.config;
    root.innerHTML = `<h3>One bot, several projects</h3>
      <p>Ask how a project is going, request the next step, or start another project while it works. Only your private Telegram chat is accepted.</p>
      <section class="card"><h3>Coordinator AI</h3><div id="director-ai-setup">Checking Codex…</div></section>
      <form id="director-config">
        <label><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}> Enable Telegram director</label>
        <p><label>Telegram user ID <input class="form-input" name="ownerId" value="${esc(cfg.ownerId)}" inputmode="numeric" required></label></p>
        <p><label>Private chat ID <input class="form-input" name="chatId" value="${esc(cfg.chatId)}" inputmode="numeric" required></label></p>
        <p><label>Bot token <input class="form-input" type="password" autocomplete="new-password" name="token" placeholder="${cfg.tokenSet ? 'Configured; leave blank to keep' : 'Token from BotFather'}"></label></p>
        <p><label>Parallel projects <input class="form-input" type="number" name="concurrency" min="1" max="6" value="${cfg.concurrency}"></label></p>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
      <p role="status">${esc(snapshot.runtime.lastError || (snapshot.runtime.worker ? 'Execution worker is running.' : 'Execution worker is idle.'))}</p>
      <button class="btn btn-secondary" id="director-refresh">Refresh status</button>
      <button class="btn btn-secondary" id="director-pause">Pause all</button>
      <button class="btn btn-secondary" id="director-resume">Resume all</button>
      <h3>Projects</h3><div id="director-projects"></div>
      <h3>Pending decisions</h3><div id="director-decisions"></div>`;
    const act = async fn => { try { await fn(); showToast('Saved', 'success'); await init(ctx); } catch (err) { showToast(err.message || 'Operation failed', 'error'); } };
    async function refreshSetup() {
      const box = root.querySelector('#director-ai-setup');
      if (!root.isConnected || !box) return;
      try {
        const status = await api('/api/director/setup');
        if (!root.isConnected) return;
        const op = status.operation || {}, busy = op.phase === 'running';
        box.innerHTML = `<p>Codex: <strong>${status.installed ? 'Installed' : 'Not installed'}</strong> · ChatGPT: <strong>${status.connected ? 'Connected' : 'Not connected'}</strong></p>
          ${status.authIssue ? `<p>${esc(status.authIssue)}</p>` : ''}
          <p role="status">${esc(op.message || 'Install Codex, connect ChatGPT, then test the coordinator. No SSH commands are needed.')}</p>
          ${!status.connected && op.url && op.code ? `<p><a href="${esc(op.url)}" target="_blank" rel="noopener noreferrer">Open OpenAI authorization</a></p><p>Enter this code: <strong>${esc(op.code)}</strong></p>` : ''}
          ${busy && op.action !== 'test' ? '<button class="btn btn-secondary" data-ai="cancel">Cancel setup / request a new code</button>' : ''}
          <button class="btn btn-secondary" data-ai="install" ${busy ? 'disabled' : ''}>${status.installed ? 'Reinstall Codex' : 'Install Codex'}</button>
          <button class="btn btn-secondary" data-ai="login" ${busy || !status.installed ? 'disabled' : ''}>Connect ChatGPT</button>
          <button class="btn btn-primary" data-ai="test" ${busy || !status.ready ? 'disabled' : ''}>Test coordinator</button>
          ${!status.ready ? '<p>The coordinator test becomes available after OpenAI confirms authorization and ChatGPT shows Connected.</p>' : ''}`;
        box.querySelectorAll('[data-ai]').forEach(button => {
          button.onclick = async () => {
            box.querySelectorAll('button').forEach(b => { b.disabled = true; });
            box.querySelector('[role="status"]').textContent = button.dataset.ai === 'test' ? 'Testing one real coordinator response…' : 'Starting setup…';
            try { await api('/api/director/setup/' + button.dataset.ai, { method: 'POST' }); }
            catch (err) { showToast(err.message || 'Codex setup failed', 'error'); }
            if (root.isConnected) await refreshSetup();
          };
        });
        if (busy) setTimeout(() => { if (root.isConnected) void refreshSetup(); }, 2500);
      } catch { box.textContent = 'Could not check Codex setup. Refresh this screen after updating Citadel.'; }
    }
    void refreshSetup();
    root.querySelector('#director-config').onsubmit = event => {
      event.preventDefault();
      const f = event.currentTarget.elements;
      const body = { enabled: f.enabled.checked, ownerId: f.ownerId.value.trim(), chatId: f.chatId.value.trim(), concurrency: Number(f.concurrency.value) };
      if (f.token.value) body.token = f.token.value;
      f.token.value = '';
      void act(() => api('/api/director/config', { method: 'PUT', body }));
    };
    root.querySelector('#director-refresh').onclick = () => init(ctx);
    root.querySelector('#director-pause').onclick = () => act(() => api('/api/director/control', { method: 'POST', body: { action: 'pause' } }));
    root.querySelector('#director-resume').onclick = () => act(() => api('/api/director/control', { method: 'POST', body: { action: 'resume' } }));
    const list = root.querySelector('#director-projects');
    for (const project of snapshot.projects) {
      const card = document.createElement('section'); card.className = 'card';
      const last = project.jobs[0];
      card.innerHTML = `<h4>${esc(project.name)} · ${esc(project.adapter)}</h4><p>${esc(last?.state || 'idle')} · ${esc(project.summary || 'No recent backlog observation.')}</p>
        <p><button class="btn btn-secondary" data-action="diagnose">Check compatibility</button>
        <button class="btn btn-secondary" data-action="consult">Find next work</button>
        <button class="btn btn-secondary" data-action="pause">Pause</button>
        <button class="btn btn-secondary" data-action="resume">Resume</button></p>
        <pre data-diagnostics></pre>
        <details><summary>Verification and publication policy</summary>
          <p>These commands and publication targets authorize automation. Oceans retains its own kernel policy.</p>
          <label>Project policy (JSON)<textarea class="form-input" rows="8">${esc(JSON.stringify({ adapter: project.adapter, priority: project.priority, ...project.policy }, null, 2))}</textarea></label>
          <button class="btn btn-primary" data-action="save-policy">Save project policy</button>
        </details>`;
      card.querySelectorAll('[data-action]').forEach(button => {
        button.onclick = () => {
          const action = button.dataset.action;
          if (action === 'diagnose') {
            void api(`/api/director/projects/${project.id}/diagnose`, { method: 'POST' }).then(result => { card.querySelector('[data-diagnostics]').textContent = JSON.stringify(result, null, 2); }).catch(err => showToast(err.message, 'error'));
          } else if (action === 'save-policy') {
            void act(() => api(`/api/director/projects/${project.id}`, { method: 'PUT', body: JSON.parse(card.querySelector('textarea').value) }));
          } else if (action === 'consult') {
            void act(() => api(`/api/director/projects/${project.id}/instructions`, { method: 'POST', body: { kind: 'consult', instruction: 'Inspect the authoritative backlog and recommend the next executable work. Explain blockers and missing observations.' } }));
          } else void act(() => api(`/api/director/projects/${project.id}/control`, { method: 'POST', body: { action } }));
        };
      });
      list.appendChild(card);
    }
    const decisions = root.querySelector('#director-decisions');
    const pending = snapshot.jobs.filter(j => j.state === 'waiting_input');
    if (!pending.length) decisions.textContent = 'No pending decisions.';
    for (const job of pending) {
      const form = document.createElement('form');
      form.innerHTML = `<p>${esc(snapshot.projects.find(p => p.id === job.project_id)?.name || 'Project')}: ${esc(job.question?.question || 'Decision required')}</p><input class="form-input" aria-label="Decision answer" required><button type="submit" class="btn btn-primary">Answer</button>`;
      form.onsubmit = event => { event.preventDefault(); void act(() => api(`/api/director/decisions/${job.id}/answer`, { method: 'POST', body: { answer: form.querySelector('input').value } })); };
      decisions.appendChild(form);
    }
  }
  window.CitadelDirectorSettings = { init };
})();
