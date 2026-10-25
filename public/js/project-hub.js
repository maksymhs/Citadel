/**
 * One project management view: priorities, tasks, Markdown, a static code graph
 * and a bounded live trace. Uses existing queue/review helpers and project APIs.
 */
(function () {
  'use strict';
  const REQUIRED = ['api', 'escapeHtml', 'openModal', 'showToast', 'state', 'openProject', 'loadProjects', 'saveUiState'];
  let api, escapeHtml, openModal, showToast, state, openProject, loadProjects, saveUiState;
  let projectId = null, snapshot = null, meta = null, graph = null, doc = null;
  let generation = 0, timer = null, controller = null, running = false;
  let events = [], cursor = null, paused = false, traceFilter = 'all', traceTask = '';
  let active = false, hostId = null;
  const COLUMNS = [
    ['next', 'Next', ['queued', 'blocked', 'quota']],
    ['running', 'In progress', ['running', 'cancelling']],
    ['review', 'Review', ['review', 'failed']],
    ['done', 'Finished', ['done', 'cancelled']],
  ];
  const labels = { queued: 'Ready', blocked: 'Dependencies', quota: 'Provider cooldown', running: 'Running', cancelling: 'Stopping', review: 'Needs acceptance', failed: 'Failed', done: 'Accepted / done', cancelled: 'Cancelled' };
  const esc = (value) => escapeHtml(String(value ?? ''));
  const time = (value) => new Date(value).toLocaleTimeString();
  const base = () => `/api/projects/${encodeURIComponent(projectId)}`;

  function init(ctx) {
    const missing = REQUIRED.filter((key) => ctx[key] === undefined);
    if (missing.length) throw new Error(`project-hub.js: missing ${missing.join(', ')}`);
    ({ api, escapeHtml, openModal, showToast, state, openProject, loadProjects, saveUiState } = ctx);
  }
  function current(token) { return active && token === generation && hostId === state.activeHostId && Boolean(document.getElementById('ph-shell')); }
  function stop() {
    active = false; generation++; running = false;
    clearTimeout(timer); timer = null;
    if (controller) controller.abort();
    controller = null;
    document.removeEventListener('visibilitychange', onVisibility);
  }
  function onVisibility() { if (!document.hidden) refresh(); }
  function schedule(token, delay = 4000) {
    clearTimeout(timer);
    if (current(token)) timer = setTimeout(() => refresh(), delay);
  }

  async function render() {
    stop(); active = true; hostId = state.activeHostId;
    const token = generation;
    document.getElementById('top-bar-actions').innerHTML = '';
    const content = document.getElementById('main-content');
    content.innerHTML = '<div class="ms-loading">Loading project workspace…</div>';
    try {
      await loadProjects();
      if (!active || token !== generation || hostId !== state.activeHostId) return;
      const projects = state.projects || [];
      if (!projects.some((p) => p.id === projectId)) projectId = projects.some((p) => p.id === state.activeProjectId) ? state.activeProjectId : projects[0]?.id;
      if (!projectId) {
        content.innerHTML = '<div class="ms-empty"><h3>Choose a project to manage</h3><p>Create or import a folder in Projects, then return here. Its tasks, documentation and execution traces will appear together.</p></div>';
        return;
      }
      content.innerHTML = `<div class="ph-shell" id="ph-shell">
        <header class="ph-header">
          <div><div class="ph-eyebrow">PROJECT WORKSPACE</div><label class="sr-only" for="ph-project">Project</label>
            <select id="ph-project" class="form-input">${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
          <div class="ph-actions"><span id="ph-status" role="status">Connecting…</span>
            <button class="btn btn-secondary btn-sm" data-ph="refresh">Refresh</button>
            <button class="btn btn-secondary btn-sm" data-ph="terminal">Open terminal</button>
            <button class="btn btn-primary btn-sm" data-ph="new-task">+ Task</button></div>
        </header>
        <div class="ph-summary" id="ph-summary"></div>
        <div class="ph-grid">
          <div class="ph-primary"><section class="ph-panel ph-work"><div class="ph-panel-head"><h2>Work</h2><span>Set the next priority · inspect results before accepting</span></div><div id="ph-board" class="ph-board"></div></section>
        <section class="ph-panel ph-trace" aria-label="Project execution trace">
          <div class="ph-panel-head"><div><h2>Execution trace</h2><span id="ph-trace-state">Waiting for events…</span></div>
            <div class="ph-actions"><label class="sr-only" for="ph-trace-level">Trace level</label><select id="ph-trace-level" class="form-input"><option value="all">All events</option><option value="problems">Warnings & errors</option></select>
              <label class="sr-only" for="ph-trace-task">Trace task</label><select id="ph-trace-task" class="form-input"><option value="">All tasks</option></select>
              <button class="btn btn-secondary btn-sm" data-ph="pause">Pause trace</button></div></div>
          <div class="ph-trace-list" id="ph-trace-list" role="log" aria-live="off"></div>
          <p class="ph-trace-caption">Structured project events and task outcomes. Terminal keystrokes and hidden model reasoning are not recorded.</p>
        </section>
          </div><aside class="ph-context">
            <section class="ph-panel"><div class="ph-panel-head"><h2>Documentation</h2><button class="btn btn-secondary btn-sm" data-ph="new-doc">+ Page</button></div><div id="ph-docs" class="ph-docs">Loading pages…</div></section>
            <section class="ph-panel"><div class="ph-panel-head"><h2>Code graph</h2><button class="btn btn-secondary btn-sm" data-ph="graph">Scan code</button></div><div id="ph-graph" class="ph-graph"><p class="mon-muted">Explore file dependencies on demand.</p></div></section>
            <section class="ph-panel"><div class="ph-panel-head"><h2>Project context</h2></div><div id="ph-context" class="ph-docs">Loading confirmed decisions…</div></section>
          </aside>
        </div>

      </div>`;
      content.onclick = handleClick;
      document.getElementById('ph-project').onchange = (event) => { projectId = event.target.value; switchProject(); };
      document.getElementById('ph-trace-level').onchange = (event) => { traceFilter = event.target.value; paintTrace(); };
      document.getElementById('ph-trace-task').onchange = (event) => { traceTask = event.target.value; paintTrace(); };
      events = []; cursor = null; doc = null; graph = null; snapshot = null; paused = false; traceTask = ''; traceFilter = 'all';
      document.addEventListener('visibilitychange', onVisibility);
      await Promise.all([refresh(), loadDocuments(token), loadContext(token)]);
    } catch (err) {
      if (active && token === generation) content.innerHTML = `<div class="ms-empty"><h3>Could not open the project</h3><p>${esc(err.message)}</p></div>`;
    }
  }
  function switchProject() {
    state.activeProjectId = projectId;
    saveUiState({ activeProjectId: projectId });
    render();
  }

  async function refresh() {
    const token = generation;
    if (!current(token) || running) return;
    if (document.hidden) { schedule(token); return; }
    running = true;
    controller = new AbortController();
    const opts = { signal: controller.signal };
    try {
      const results = await Promise.allSettled([
        api(base() + '/hub', opts),
        paused ? Promise.resolve(null) : api(base() + '/trace' + (cursor === null ? '' : `?after=${cursor}`), opts),
      ]);
      if (!current(token)) return;
      const [work, trace] = results;
      const status = document.getElementById('ph-status');
      if (work.status === 'fulfilled') {
        snapshot = work.value;
        paintWork();
        status.textContent = `Updated ${time(snapshot.updatedAt)}`;
      } else status.textContent = `Workspace stale: ${work.reason.message}`;
      if (trace.status === 'fulfilled' && trace.value && !paused) {
        const known = new Set(events.map((event) => event.id));
        events = [...events, ...trace.value.events.filter((event) => !known.has(event.id))].slice(-300);
        cursor = trace.value.cursor;
        paintTrace();
        document.getElementById('ph-trace-state').textContent = `Live · checked ${time(new Date())}${trace.value.hasMore ? ' · catching up' : ''}`;
      } else if (trace.status === 'rejected') {
        document.getElementById('ph-trace-state').textContent = `Trace disconnected: ${trace.reason.message}`;
      }
      schedule(token, trace.status === 'fulfilled' && trace.value?.hasMore ? 100 : 4000);
    } finally {
      if (token === generation) { running = false; controller = null; }
      if (current(token) && !timer) schedule(token);
    }
  }

  function paintWork() {
    const tasks = snapshot.tasks;
    const budget = snapshot.budget;
    const activeTasks = tasks.filter((task) => ['running', 'cancelling'].includes(task.status)).length;
    document.getElementById('ph-summary').innerHTML = `<span><strong>${activeTasks}</strong> running</span><span><strong>${tasks.filter((task) => ['queued', 'blocked', 'quota'].includes(task.status)).length}</strong> pending</span><span><strong>${snapshot.counts.review || 0}</strong> need acceptance</span><span><strong>${snapshot.sessions.length}</strong> terminals</span><span>Attempts today <strong>${budget.used}/${budget.limit}</strong></span>${!snapshot.workers ? '<span class="ph-warning">No worker connected · queued work waits</span>' : ''}${budget.exhausted ? '<span class="ph-warning">Autonomous budget paused</span>' : ''}`;
    const board = document.getElementById('ph-board');
    const markup = COLUMNS.map(([id, title, states]) => {
      const list = tasks.filter((task) => states.includes(task.status));
      return `<div class="ph-column" data-ph-column="${id}"><h3>${title}<span>${list.length}</span></h3>${list.map((task) => `<article class="ph-task ${esc(task.status)}">
        <button class="ph-task-open" data-ph="task" data-id="${esc(task.id)}"><span class="ph-task-title">${esc(task.title)}</span><span class="ph-task-meta">${esc(task.agent || task.role || 'shell')} · ${esc(labels[task.status] || task.status)}</span>${task.blockedReason ? `<span class="ph-task-meta">${esc(task.blockedReason)}</span>` : ''}</button>
        <div class="ph-task-footer"><span>Priority ${task.priority} · try ${task.attempt}/${task.maxAttempts}</span>${task.missionId && ['queued', 'blocked'].includes(task.status) ? `<div><button class="ph-priority" data-ph="priority" data-id="${esc(task.id)}" data-delta="10" aria-label="Raise priority for ${esc(task.title)}">↑</button><button class="ph-priority" data-ph="priority" data-id="${esc(task.id)}" data-delta="-10" aria-label="Lower priority for ${esc(task.title)}">↓</button></div>` : ''}</div>
      </article>`).join('') || '<p class="ph-empty">No tasks</p>'}</div>`;
    }).join('');
    if (board.innerHTML !== markup) board.innerHTML = markup;
    if (snapshot.truncated && !document.getElementById('ph-truncated')) board.insertAdjacentHTML('afterend', '<p class="mon-muted" id="ph-truncated">Showing recent work; older history remains stored.</p>');
    const select = document.getElementById('ph-trace-task');
    if (document.activeElement !== select) {
      select.innerHTML = '<option value="">All tasks</option>' + tasks.map((task) => `<option value="${esc(task.id)}">${esc(task.title)}</option>`).join('');
      select.value = traceTask;
    }
  }
  function paintTrace() {
    const list = document.getElementById('ph-trace-list');
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
    const filtered = events.filter((event) => (!traceTask || event.taskId === traceTask) && (traceFilter !== 'problems' || ['warn', 'error'].includes(event.level)));
    // Preserve expanded details while new events arrive.
    const expanded = new Set([...list.querySelectorAll('details[open]')].map((el) => el.dataset.event));
    list.innerHTML = filtered.map((event) => `<details class="ph-event ${esc(event.level)}" data-event="${event.id}" ${expanded.has(String(event.id)) ? 'open' : ''}><summary><time>${esc(time(event.ts))}</time><span class="ph-event-level">${esc(event.level)}</span><span class="ph-event-message">${esc(event.message || event.action || 'Event')}</span>${event.taskId ? `<code>${esc(event.taskId.slice(0, 8))}</code>` : ''}</summary><div class="ph-event-details"><span>${esc(event.action)}${event.node ? ' · ' + esc(event.node) : ''}</span><pre>${esc(JSON.stringify(event.details, null, 2) || 'No additional details.')}</pre></div></details>`).join('') || '<p class="ph-empty">No matching events. Task execution and project actions will appear here.</p>';
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  async function loadDocuments(token) {
    try {
      const result = await api(`/api/docs?projectId=${encodeURIComponent(projectId)}&limit=50`);
      if (!current(token)) return;
      document.getElementById('ph-docs').innerHTML = result.docs.map((page) => `<button class="ph-doc-link" data-ph="doc" data-path="${esc(page.path)}"><strong>${esc(page.title)}</strong><span>${esc(page.path)}${page.pending ? ' · uncommitted' : ''}</span></button>`).join('') || '<p class="ph-empty">No pages yet. Markdown written by you or an agent appears here.</p>';
    } catch (err) { if (current(token)) document.getElementById('ph-docs').textContent = err.message; }
  }
  async function loadContext(token) {
    try {
      const result = await api(`/api/learning?projectId=${encodeURIComponent(projectId)}&scope=project&status=confirmed&limit=5`);
      if (!current(token)) return;
      document.getElementById('ph-context').innerHTML = result.lessons.map((lesson) => `<div class="ph-decision"><strong>${esc(lesson.title)}</strong><p>${esc(lesson.rule || lesson.solution)}</p></div>`).join('') || '<p class="ph-empty">Accepted corrections and confirmed project decisions appear here.</p>';
    } catch (err) { if (current(token)) document.getElementById('ph-context').textContent = err.message; }
  }

  async function inspectTask(id) {
    const token = generation;
    const task = snapshot?.tasks.find((item) => item.id === id);
    if (!task) return;
    if (task.missionId) {
      const data = await api(`/api/missions/${encodeURIComponent(task.missionId)}`);
      if (!current(token)) return;
      window.CitadelMissions.inspectTask(data, id, () => {
        if (current(token)) { refresh(); loadDocuments(token); loadContext(token); }
      });
    } else {
      const result = await api(`/api/tasks/${encodeURIComponent(id)}`);
      if (!current(token)) return;
      openModal({ title: task.title, confirmText: 'Close', bodyHtml: `<p>${esc(labels[task.status])}</p><pre class="ms-doc">${esc(result.task.result || result.task.error || 'No result yet.')}</pre>` });
    }
  }

  async function openDoc(path) {
    const token = generation;
    const result = await api(`/api/docs/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`);
    if (!current(token)) return;
    doc = result.doc;
    openModal({ title: doc.title, confirmText: 'Close', bodyHtml: `<div class="ph-doc-modal"><p class="mon-muted">${esc(doc.path)}</p><article class="kn-markdown ms-doc">${window.CitadelKnowledge.renderMarkdown(doc.content)}</article><button class="btn btn-secondary btn-sm" id="ph-edit-doc">Edit Markdown</button></div>` });
    document.getElementById('ph-edit-doc').onclick = () => { document.getElementById('modal-cancel-btn').click(); editDoc(doc); };
  }
  function editDoc(existing = null) {
    const pid = projectId, token = generation;
    openModal({ title: existing ? `Edit ${existing.path}` : 'New project page', confirmText: 'Save page', bodyHtml: `<div class="ms-form">${existing ? '' : '<label for="ph-doc-path">Path within project docs</label><input id="ph-doc-path" class="form-input" placeholder="guides/overview.md">'}<label for="ph-doc-content">Markdown</label><textarea id="ph-doc-content" rows="16" spellcheck="false">${esc(existing?.content || '# Overview\n\n')}</textarea></div>`, onConfirm: async () => {
      const content = document.getElementById('ph-doc-content').value;
      const path = existing?.path || document.getElementById('ph-doc-path').value.trim();
      await api('/api/docs', { method: existing ? 'PUT' : 'POST', body: { projectId: pid, path, content, ...(existing ? { expectedUpdatedAt: existing.modifiedAt } : {}) } });
      if (current(token)) { loadDocuments(token); refresh(); }
      showToast('Page saved in the project checkout.', 'success');
    } });
  }
  async function newTask() {
    const token = generation, pid = projectId;
    meta = await api('/api/missions/meta');
    if (!current(token)) return;
    const agents = meta.agents.filter((agent) => agent.installed);
    openModal({ title: 'Direct the next work', confirmText: 'Queue task', bodyHtml: `<div class="ms-form"><label for="ph-task-title">Task</label><input id="ph-task-title" class="form-input" placeholder="What should happen next?"><label for="ph-task-goal">Instructions and constraints</label><textarea id="ph-task-goal" rows="5"></textarea><label for="ph-task-acceptance">Acceptance criteria · one per line</label><textarea id="ph-task-acceptance" rows="3">Relevant checks pass and the result is reviewed.</textarea><label for="ph-task-agent">Tool</label><select id="ph-task-agent">${agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join('') || '<option value="">No headless agent installed</option>'}</select><p class="ms-hint">A connected worker runs queued tasks. Use Open terminal for any other tool.</p></div>`, onConfirm: async () => {
      const title = document.getElementById('ph-task-title').value.trim();
      const instructions = document.getElementById('ph-task-goal').value.trim();
      const agent = document.getElementById('ph-task-agent').value;
      if (!title || !agent) throw new Error('Enter a task and select an installed tool.');
      const acceptance = document.getElementById('ph-task-acceptance').value.split('\n').map((line) => line.trim()).filter(Boolean);
      await api('/api/missions', { method: 'POST', body: { projectId: pid, title, goal: instructions || title, plan: { tasks: [{ title, role: 'developer', agent, description: instructions, acceptance }] } } });
      if (current(token)) refresh();
      showToast('Task queued for the project.', 'success');
    } });
  }

  async function scanGraph() {
    const token = generation;
    const panel = document.getElementById('ph-graph');
    panel.textContent = 'Scanning relative JS/TS imports…';
    const result = await api(base() + '/code-graph?refresh=1');
    if (!current(token)) return;
    graph = result;
    const sorted = graph.nodes.map((node) => ({ ...node, links: graph.edges.filter((edge) => edge.from === node.id || edge.to === node.id).length })).sort((a, b) => b.links - a.links || a.id.localeCompare(b.id));
    const preview = sorted.slice(0, 6).map((node, index) => ({ ...node, x: index % 2 ? 195 : 65, y: 25 + Math.floor(index / 2) * 50 }));
    const points = new Map(preview.map((node) => [node.id, node]));
    const mini = `<svg class="ph-mini-graph" viewBox="0 0 260 ${Math.max(70, Math.ceil(preview.length / 2) * 50)}" role="img" aria-label="Code dependency overview">${graph.edges.filter((edge) => points.has(edge.from) && points.has(edge.to)).map((edge) => `<line x1="${points.get(edge.from).x}" y1="${points.get(edge.from).y}" x2="${points.get(edge.to).x}" y2="${points.get(edge.to).y}"/>`).join('')}${preview.map((node) => `<circle cx="${node.x}" cy="${node.y}" r="7"/><text x="${node.x}" y="${node.y + 20}" text-anchor="middle">${esc(node.id.split('/').pop().slice(0, 19))}</text>`).join('')}</svg>`;
    panel.innerHTML = `<p class="mon-muted">${graph.nodes.length} files · ${graph.edges.length} dependencies${graph.truncated ? ' · limited scan' : ''}</p>${mini}<div class="ph-graph-nodes">${sorted.map((node) => `<button data-ph="graph-node" data-path="${esc(node.id)}"><span>${esc(node.id)}</span><strong>${node.links}</strong></button>`).join('') || '<p class="ph-empty">No supported JS/TS files found.</p>'}</div><p class="ph-trace-caption">Static relative imports · select a file to explore its dependency graph.</p>`;
    refresh();
  }
  function graphNode(path) {
    const outbound = graph.edges.filter((edge) => edge.from === path).map((edge) => edge.to);
    const inbound = graph.edges.filter((edge) => edge.to === path).map((edge) => edge.from);
    const neighbors = [...new Set([...outbound, ...inbound])].slice(0, 12);
    const centerY = Math.max(80, neighbors.length * 17);
    const nodes = neighbors.map((id, index) => ({ id, x: index % 2 ? 420 : 20, y: 20 + Math.floor(index / 2) * 58 }));
    openModal({ title: path, confirmText: 'Close', bodyHtml: `<div class="ph-node-graph"><svg viewBox="0 0 620 ${Math.max(170, centerY * 2)}" role="img" aria-label="File dependency neighborhood">${nodes.map((node) => `<line x1="300" y1="${centerY}" x2="${node.x + 85}" y2="${node.y + 14}"/>`).join('')}<rect x="210" y="${centerY - 14}" width="180" height="28"/><text x="300" y="${centerY + 4}" text-anchor="middle">${esc(path.split('/').pop())}</text>${nodes.map((node) => `<rect x="${node.x}" y="${node.y}" width="170" height="28"/><text x="${node.x + 85}" y="${node.y + 18}" text-anchor="middle">${esc(node.id.split('/').pop())}</text>`).join('')}</svg></div><h4>Imports</h4><pre class="ms-doc">${esc(outbound.join('\n') || 'None resolved')}</pre><h4>Imported by</h4><pre class="ms-doc">${esc(inbound.join('\n') || 'None resolved')}</pre><p class="mon-muted">${esc(graph.scope)}${graph.truncated ? ' · Scan was limited.' : ''}</p>` });
  }

  async function handleClick(event) {
    const button = event.target.closest('[data-ph]');
    if (!button || !active) return;
    try {
      const action = button.dataset.ph;
      if (action === 'refresh') { await refresh(); await loadDocuments(generation); }
      else if (action === 'terminal') openProject(projectId);
      else if (action === 'new-task') await newTask();
      else if (action === 'task') await inspectTask(button.dataset.id);
      else if (action === 'new-doc') editDoc();
      else if (action === 'doc') await openDoc(button.dataset.path);
      else if (action === 'graph') await scanGraph();
      else if (action === 'graph-node') graphNode(button.dataset.path);
      else if (action === 'pause') {
        paused = !paused;
        button.textContent = paused ? 'Resume trace' : 'Pause trace';
        document.getElementById('ph-trace-state').textContent = paused ? 'Paused · work continues' : 'Resuming…';
        if (!paused) refresh();
      } else if (action === 'priority') {
        const task = snapshot.tasks.find((item) => item.id === button.dataset.id);
        await api(`/api/missions/${encodeURIComponent(task.missionId)}/prioritize`, { method: 'POST', body: { taskId: task.id, priority: task.priority + Number(button.dataset.delta) } });
        await refresh();
      }
    } catch (err) { showToast(err.message, 'error'); }
  }

  window.CitadelProjectHub = { init, render, stop };
})();
