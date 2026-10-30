/**
 * System management for the selected machine: processes, terminals, shared VS Code and tools.
 * Destructive actions capture the machine and account and require explicit confirmation.
 */
(function () {
  'use strict';
  const REQUIRED = ['state', 'localApi', 'escapeHtml', 'openModal', 'showToast', 'forgetTerminal', 'installAgent'];
  let ctx, timer, generation = 0;
  const SECTIONS = [['processes', 'Processes'], ['terminals', 'Terminals'], ['editor', 'VS Code'], ['tools', 'Tools']];
  function init(context) {
    const missing = REQUIRED.filter(key => context[key] === undefined);
    if (missing.length) throw new Error(`system.js: missing ${missing.join(', ')}`);
    ctx = context;
  }
  function dispose() { generation++; clearInterval(timer); timer = undefined; }
  function bytes(value) {
    if (!Number.isFinite(value)) return '—';
    return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${Math.round(value / 1024)} KiB`;
  }
  async function render() {
    dispose();
    const attempt = generation, hostId = ctx.state.activeHostId, user = ctx.state.user;
    const owner = user?.id ?? user?.username;
    const admin = user?.role === 'admin';
    const root = document.getElementById('main-content');
    const esc = ctx.escapeHtml;
    const pane = document.createElement('section');
    pane.id = 'system-management';
    pane.className = 'management-screen system-screen';
    root.replaceChildren(pane);
    const present = () => attempt === generation && pane.isConnected && hostId === ctx.state.activeHostId && owner === (ctx.state.user?.id ?? ctx.state.user?.username);
    const path = suffix => hostId === 'local' ? `/api${suffix}` : `/api/remote/${encodeURIComponent(hostId)}${suffix}`;
    const request = (suffix, options) => ctx.localApi(path(suffix), options);
    const hostName = hostId === 'local' ? (ctx.state.hostIdentity?.name || 'This machine') : (ctx.state.hosts.find(host => host.id === hostId)?.name || hostId);
    pane.innerHTML = `<div class="mon-tab-toolbar"><span class="mon-muted">${esc(hostName)}</span><button type="button" class="btn btn-secondary btn-sm" id="system-refresh">Refresh</button></div>
      <div class="system-sections">${SECTIONS.map(([id, label]) => `<section class="card system-section${id === 'processes' || id === 'tools' ? ' system-section-wide' : ''}" data-system-section="${id}" aria-labelledby="system-${id}-heading"><div class="system-section-head"><h2 id="system-${id}-heading">${label}</h2></div><div id="system-${id}-body"><div class="mon-muted">Loading…</div></div></section>`).join('')}</div>`;
    const bodies = Object.fromEntries(SECTIONS.map(([id]) => [id, pane.querySelector(`#system-${id}-body`)]));
    const pending = {};
    let refreshTimer;
    function stopPolling() {
      clearInterval(refreshTimer);
      if (timer === refreshTimer) timer = undefined;
      refreshTimer = undefined;
    }
    // Each mount owns its errors and in-flight request; slow sections cannot hide the others.
    function loadSection(id) {
      if (!present()) { stopPolling(); return Promise.resolve(false); }
      if (pending[id]) return pending[id];
      pending[id] = (async () => {
        try {
          await loaders[id]();
          return present();
        } catch (error) {
          if (present()) bodies[id].innerHTML = `<div class="mon-muted">${esc(error.message)}</div>`;
          return false;
        } finally { delete pending[id]; }
      })();
      return pending[id];
    }
    async function refreshProcesses() {
      const loaded = await loadSection('processes');
      if (!present()) { stopPolling(); return; }
      if (!loaded) { stopPolling(); return; }
      if (refreshTimer === undefined) timer = refreshTimer = setInterval(() => {
        if (!present()) { stopPolling(); return; }
        if (!document.hidden) refreshProcesses();
      }, 5000);
    }
    function refreshAll() {
      return Promise.all([refreshProcesses(), ...['terminals', 'editor', 'tools'].map(loadSection)]);
    }
    pane.querySelector('#system-refresh').onclick = refreshAll;
    function confirm({ title, warning, run, success, section }) {
      if (!present() || !admin || ctx.state.user?.role !== 'admin') return;
      let open = true, confirming = false;
      ctx.openModal({ title, bodyHtml: `<p>${esc(warning)}</p><p>Machine: <strong>${esc(hostName)}</strong></p>`, confirmText: 'Confirm',
        onClose: () => { open = false; },
        onConfirm: async () => {
          if (!open || !present() || ctx.state.user?.role !== 'admin') throw new Error('Machine or user changed. Reopen this action.');
          if (confirming) return;
          confirming = true;
          try {
            await run();
            open = false;
            if (!present()) return;
            ctx.showToast(success, 'success');
            await (section === 'processes' ? refreshProcesses() : loadSection(section));
          } finally { confirming = false; }
        },
      });
    }
    const loaders = {
      terminals: async () => {
        const [result, projects] = await Promise.all([request('/terminals'), request('/projects').catch(() => ({ projects: [] }))]);
        if (!present()) return;
        const body = bodies.terminals;
        const names = new Map((projects.projects || []).map(project => [project.id, project.name]));
        const sessions = (result.sessions || []).filter(session => session.isAlive || session.status === 'active');
        body.innerHTML = `<p class="mon-muted">Persistent sessions keep running when you leave this view.</p>${sessions.length ? `<div class="mon-rows">${sessions.map((session, index) => `<div class="mon-row"><div class="mon-row-main"><strong>${esc(session.name)}</strong><span class="mon-muted">${esc(session.project_id ? names.get(session.project_id) || 'Project' : 'System (host)')}</span></div><span class="badge badge-success">Running</span>${admin ? `<button type="button" class="btn btn-danger btn-sm" data-stop-terminal="${index}">Stop</button>` : ''}</div>`).join('')}</div>` : '<div class="mon-muted">No persistent terminals are running.</div>'}`;
        body.querySelectorAll('[data-stop-terminal]').forEach(button => {
          const session = sessions[Number(button.dataset.stopTerminal)];
          button.onclick = () => confirm({ title: `Stop ${session.name}?`, warning: 'This ends the terminal and the commands running inside it. Unsaved work may be lost.', section: 'terminals',
            run: async () => { await request(`/terminals/${encodeURIComponent(session.id)}`, { method: 'DELETE' }); ctx.forgetTerminal(hostId, session.id); }, success: 'Terminal stopped.' });
        });
      },
      editor: async () => {
        const body = bodies.editor;
        if (!admin) { body.innerHTML = '<div class="mon-muted">Administrator privileges are required to inspect or stop VS Code.</div>'; return; }
        let result;
        try { result = await request('/editor'); } catch (error) { throw new Error(`VS Code status unavailable: ${error.message}`); }
        if (!present()) return;
        const editor = result.editor;
        if (!editor || typeof editor.running !== 'boolean') throw new Error('VS Code status unavailable.');
        body.innerHTML = `<div class="mon-row"><div class="mon-row-main"><strong>Browser VS Code</strong><span class="mon-muted">One shared code-server instance for all projects on this machine.</span></div><span class="badge ${editor.running ? 'badge-success' : 'badge-muted'}">${editor.running ? 'Running' : 'Stopped'}</span>${editor.running ? '<button type="button" class="btn btn-danger btn-sm" id="system-stop-editor">Stop</button>' : ''}</div>`;
        body.querySelector('#system-stop-editor')?.addEventListener('click', () => confirm({ title: 'Stop shared VS Code?', warning: 'This disconnects every project and browser using this editor. Unsaved work may be lost.', section: 'editor',
          run: async () => { const stopped = await request('/editor', { method: 'DELETE' }); if (stopped.editor?.running !== false) throw new Error('Editor shutdown could not be verified.'); }, success: 'Shared VS Code stopped.' }));
      },
      processes: async () => {
        const result = await request('/system/processes?limit=50');
        if (!present()) return;
        const body = bodies.processes;
        const data = result.processes || {}, rows = data.processes || [];
        body.innerHTML = `<p class="mon-muted">${rows.length} of ${esc(data.total ?? rows.length)} processes · refreshes every 5 s. Process controls are available only for eligible service-user processes on Linux.</p><div class="table-container"><table class="data-table"><thead><tr><th>PID</th><th>Process</th><th>CPU</th><th>Memory</th><th>Actions</th></tr></thead><tbody>${rows.map((process, index) => `<tr><td data-label="PID">${esc(process.pid)}</td><td data-label="Process">${esc(process.name)}</td><td data-label="CPU">${Number.isFinite(process.cpuPercent) ? `${process.cpuPercent.toFixed(1)}%` : '—'}</td><td data-label="Memory">${bytes(process.rssBytes)}</td><td data-label="Actions">${admin && process.canTerminate && process.identity ? `<div class="proj-actions"><button type="button" class="btn btn-secondary btn-sm" data-process="${index}" data-signal="TERM">Stop</button><button type="button" class="btn btn-danger btn-sm" data-process="${index}" data-signal="KILL">Force kill</button></div>` : '<span class="mon-muted">Read-only</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="mon-muted">No process data available.</td></tr>'}</tbody></table></div>`;
        body.querySelectorAll('[data-process]').forEach(button => {
          const process = rows[Number(button.dataset.process)], signal = button.dataset.signal;
          button.onclick = () => confirm({ title: `${signal === 'KILL' ? 'Force kill' : 'Stop'} ${process.name} (${process.pid})?`, warning: signal === 'KILL' ? 'Force kill prevents cleanup and may lose data. Use only if a normal stop did not work.' : 'Send SIGTERM to this process. It may stop running commands or services and lose unsaved work.', section: 'processes',
            run: async () => { const result = await request(`/system/processes/${encodeURIComponent(process.pid)}/terminate`, { method: 'POST', body: { identity: process.identity, signal } }); if (result.signalSent !== true) throw new Error('Signal delivery could not be verified.'); }, success: `SIG${signal} sent. Process exit is not guaranteed.` });
        });
      },
      tools: async () => {
        const [result, toolsResult] = await Promise.all([request('/system/integrations'), request('/system/tools').catch(() => null)]);
        if (!present()) return;
        const body = bodies.tools;
        const integrations = result.integrations || {};
        const tools = toolsResult?.tools || ['tmux', 'git', 'docker', 'caddy'].map(id => ({ id, name: id, group: 'System', installed: Boolean(integrations[id]?.available) }));
        body.innerHTML = `<div class="system-tools-grid"><div><h3>AI coding agents</h3><div class="mon-rows">${(integrations.agents || []).map(agent => `<div class="mon-row"><div class="mon-row-main"><strong>${esc(agent.name)}</strong>${agent.version ? `<span class="mon-muted">${esc(agent.version)}</span>` : agent.detected ? '<span class="mon-muted">Executable found; version check failed</span>' : ''}${agent.warning ? `<span class="mon-muted">${esc(agent.warning)}</span>` : ''}</div>${agent.available ? '<span class="badge badge-success">Installed</span>' : `<button type="button" class="btn btn-secondary btn-sm" data-agent="${esc(agent.id)}" data-action="install" ${admin ? '' : 'disabled'}>Install</button>`}${agent.available || agent.detected ? `<button type="button" class="btn btn-secondary btn-sm" data-agent="${esc(agent.id)}" data-action="reinstall" ${admin ? '' : 'disabled'}>Reinstall / update</button>` : ''}${agent.managed ? `<button type="button" class="btn btn-secondary btn-sm" data-agent="${esc(agent.id)}" data-action="remove" ${admin ? '' : 'disabled'}>Remove</button>` : ''}</div>`).join('') || '<p class="mon-muted">No AI coding agents detected.</p>'}</div></div>
          <div><h3>Installed tools</h3>${['Runtimes', 'Development', 'Containers', 'Network', 'System'].map(group => {
    const installed = tools.filter(tool => tool.group === group && tool.installed);
    return installed.length ? `<div class="mon-tool-group"><div class="mon-tool-title">${esc(group)}</div><div class="mon-rows">${installed.map(tool => `<div class="mon-row"><strong>${esc(tool.name)}</strong><span class="mon-muted">${esc(tool.version || 'Installed')}</span></div>`).join('')}</div></div>` : '';
  }).join('') || '<p class="mon-muted">No common tools detected.</p>'}</div></div>`;
        body.querySelectorAll('[data-agent]').forEach(button => {
          button.onclick = () => {
            if (!present() || !admin || ctx.state.user?.role !== 'admin') return;
            const agent = integrations.agents.find(item => item.id === button.dataset.agent);
            ctx.installAgent(hostId, agent.id, agent.name, button.dataset.action);
          };
        });
      },
    };
    await refreshAll();
  }
  window.CitadelSystem = { init, render, dispose };
})();
