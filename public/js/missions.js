/**
 * Agent Missions: a local board and wiki over the mission DAG built by
 * missionService, plus the acceptance review for autonomous results. Loaded
 * before app.js; app.js passes the shared helpers through init(), so this file
 * never reaches into its scope.
 */
(function () {
  'use strict';

  let api, escapeHtml, openModal, showToast, state;

  const REQUIRED = ['api', 'escapeHtml', 'openModal', 'showToast', 'state'];
  const POLL_MS = 4000;
  const STATUS_LABELS = {
    planning: 'Planning',
    running: 'Running',
    review: 'Review',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
    cancelling: 'Cancelling',
    queued: 'Ready',
    blocked: 'Blocked',
    quota: 'Waiting quota',
  };
  const COLUMNS = [
    { id: 'blocked', label: 'Blocked' },
    { id: 'quota', label: 'Waiting quota' },
    { id: 'queued', label: 'Ready' },
    { id: 'running', label: 'In progress' },
    { id: 'cancelling', label: 'Cancelling' },
    { id: 'review', label: 'Needs review' },
    { id: 'done', label: 'Done' },
    { id: 'failed', label: 'Failed' },
    { id: 'cancelled', label: 'Cancelled' },
  ];
  const FINAL = new Set(['done', 'failed', 'cancelled']);
  const EXAMPLE_PLAN = {
    tasks: [
      { title: 'Inspect the code and write an implementation brief', role: 'analyst', description: 'Read the relevant files, list risks and concrete file pointers.' },
      { title: 'Implement the change', role: 'backend', description: 'Keep it small and follow the existing conventions.', deps: [0], exclusive: true },
      { title: 'Run the test suite and review the diff', role: 'qa', description: 'Run the relevant suites and report exact commands and outcomes.', deps: [1] },
    ],
  };

  let missions = [];
  let selectedId = null;
  let detail = null;
  let meta = null;
  let nodes = [];
  let tab = 'board';
  let wikiPath = 'goal.md';
  let wikiDoc = null;
  let pollTimer = null;
  let lastKey = '';
  let projectFilter = '';
  let statusFilter = '';

  function init(ctx) {
    const missing = REQUIRED.filter((k) => ctx[k] === undefined);
    if (missing.length) throw new Error(`missions.js: app.js did not provide ${missing.join(', ')}`);
    ({ api, escapeHtml, openModal, showToast, state } = ctx);
  }

  function roleOf(id) {
    const roles = (detail && detail.roles) || (meta && meta.roles) || [];
    return roles.find((r) => r.id === id) || { id, label: id || 'Agent', short: 'AG', color: 'var(--text-secondary)' };
  }

  function statusBadge(status) {
    const cls = {
      done: 'badge-success',
      running: 'badge-warning',
      cancelling: 'badge-warning',
      review: 'badge-danger',
      failed: 'badge-danger',
      quota: 'badge-warning',
      planning: 'badge-info',
      cancelled: 'badge-muted',
      queued: 'badge-info',
      blocked: 'badge-muted',
    }[status] || 'badge-muted';
    return `<span class="badge ${cls}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function projectName(id) {
    const project = (state.projects || []).find((p) => p.id === id);
    return project ? project.name : null;
  }

  async function loadMissions() {
    const res = await api('/api/missions');
    missions = res.missions || [];
  }

  async function loadMeta() {
    if (meta) return;
    meta = await api('/api/missions/meta');
  }

  async function loadNodes() {
    try {
      const res = await api('/api/nodes');
      nodes = res.nodes || [];
    } catch {
      nodes = [];
    }
  }

  async function loadDetail() {
    if (!selectedId) {
      detail = null;
      return;
    }
    detail = await api(`/api/missions/${encodeURIComponent(selectedId)}`);
  }

  async function fetchDoc(path) {
    try {
      const res = await api(`/api/missions/${encodeURIComponent(selectedId)}/file?path=${encodeURIComponent(path)}`);
      wikiDoc = res.file;
    } catch (err) {
      wikiDoc = { path, name: path, content: `Could not load this page: ${err.message}`, missing: true };
    }
  }

  function liveNodes() {
    const cutoff = Date.now() - 120000;
    return nodes.filter((n) => {
      const seen = n.lastSeen ? new Date(n.lastSeen).getTime() : 0;
      return seen >= cutoff;
    });
  }

  // --- Rendering -----------------------------------------------------------

  async function renderMissionsView() {
    const content = document.getElementById('main-content');
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="ms-refresh-btn">Refresh</button>
      <button class="btn btn-primary btn-sm" id="ms-new-btn">+ New mission</button>`;
    document.getElementById('ms-refresh-btn').onclick = () => refreshAll();
    document.getElementById('ms-new-btn').onclick = () => openCreateMission();

    content.innerHTML = '<div class="ms-loading">Loading missions…</div>';
    try {
      await Promise.all([loadMissions(), loadMeta(), loadNodes()]);
      if (!selectedId || !missions.some((m) => m.id === selectedId)) {
        selectedId = missions.length ? missions[0].id : null;
      }
      await loadDetail();
      if (tab === 'wiki') await fetchDoc(wikiPath);
    } catch (err) {
      content.innerHTML = `<div class="ms-empty"><h3>Could not load missions</h3><p>${escapeHtml(err.message)}</p></div>`;
      return;
    }
    paint();
    startPolling();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setTimeout(poll, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function poll() {
    pollTimer = null;
    if (!['missions', 'work'].includes(state.currentView)) return;
    if (document.getElementById('active-modal-overlay')) {
      pollTimer = setTimeout(poll, POLL_MS);
      return;
    }
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.tagName === 'SELECT')) {
      pollTimer = setTimeout(poll, POLL_MS);
      return;
    }
    try {
      await loadMissions();
      if (selectedId) await loadDetail();
      const key = JSON.stringify({ m: missions, d: detail });
      if (key !== lastKey) paint();
    } catch {
      // Transient network errors are ignored; the next tick retries.
    }
    pollTimer = setTimeout(poll, POLL_MS);
  }

  async function refreshAll() {
    const btn = document.getElementById('ms-refresh-btn');
    if (btn) btn.disabled = true;
    try {
      await Promise.all([loadMissions(), loadNodes()]);
      if (selectedId) await loadDetail();
      if (tab === 'wiki') await fetchDoc(wikiPath);
      paint();
      showToast('Missions refreshed.', 'info');
    } catch (err) {
      showToast(`Refresh failed: ${err.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function paint() {
    const content = document.getElementById('main-content');
    if (!content) return;
    lastKey = JSON.stringify({ m: missions, d: detail });
    if (!missions.length) {
      content.innerHTML = `
        <div class="ms-empty">
          <div class="ms-empty-mark">M</div>
          <h3>No missions yet</h3>
          <p>Give a team of CLI agents one goal. Missio&shy;ns keep the plan, dependencies, handoffs and notes in one place.</p>
          <button class="btn btn-primary" id="ms-empty-new">Create the first mission</button>
        </div>`;
      const btn = document.getElementById('ms-empty-new');
      if (btn) btn.onclick = () => openCreateMission();
      return;
    }
    content.innerHTML = `
      <div class="ms-shell">
        <aside class="ms-sidebar">
          <div class="ms-side-header"><span>Backlog</span><span class="ms-side-count">${filteredMissions().length}</span></div>
          <div class="ms-filters">
            <select data-filter="project"><option value="">All projects</option>${(state.projects || []).map((p) => `<option value="${escapeHtml(p.id)}" ${projectFilter === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
            <select data-filter="status"><option value="">All states</option>${['planning','running','quota','review','done','cancelled','cancelling'].map((st) => `<option value="${st}" ${statusFilter === st ? 'selected' : ''}>${escapeHtml(STATUS_LABELS[st] || st)}</option>`).join('')}</select>
          </div>
          <div class="ms-list">${filteredMissions().map(missonListItem).join('')}</div>
        </aside>
        <section class="ms-detail">${detail ? renderDetail() : '<div class="ms-loading">Select a mission…</div>'}</section>
      </div>`;
    bindShell();
  }

  function filteredMissions() {
    return missions.filter((mission) => {
      if (projectFilter && mission.projectId !== projectFilter) return false;
      if (statusFilter && mission.status !== statusFilter) return false;
      return true;
    });
  }

  function missonListItem(mission) {
    const project = projectName(mission.projectId);
    return `<button class="ms-mission ${mission.id === selectedId ? 'active' : ''}" data-action="select-mission" data-id="${escapeHtml(mission.id)}">
      <div class="ms-mission-top">
        <span class="ms-mission-title">${escapeHtml(mission.title)}</span>
        ${statusBadge(mission.status)}
      </div>
      <div class="ms-mission-meta">${escapeHtml(project || 'No project')} · ${mission.done}/${mission.total || 0} done</div>
      <div class="ms-mini-progress"><span style="width:${mission.progress || 0}%"></span></div>
    </button>`;
  }

  function renderDetail() {
    const m = detail.mission;
    const project = projectName(m.projectId);
    const canCancel = !['done', 'cancelled'].includes(m.status);
    const canImport = m.status === 'review' && !m.hasPlan;
    const live = liveNodes();
    return `
      <header class="ms-head">
        <div class="ms-head-row">
          <div class="ms-head-main">
            <div class="ms-eyebrow">${project ? escapeHtml(project) : 'Local mission'} · ${escapeHtml(m.id.slice(0, 8))}</div>
            <h1 class="ms-title">${escapeHtml(m.title)}</h1>
            <div class="ms-head-meta">
              ${statusBadge(m.status)}
              <span>${m.done}/${m.total || 0} done</span>
              <span>Created ${fmtDate(m.createdAt)}</span>
              ${m.plannerAgent ? `<span class="ms-agent-pill">${escapeHtml(m.plannerAgent)}</span>` : ''}
              ${m.planVersion > 1 ? `<span class="ms-agent-pill">plan v${m.planVersion}</span>` : ''}
              ${m.usedLessons && m.usedLessons.length ? `<span class="ms-agent-pill">${m.usedLessons.length} lesson${m.usedLessons.length === 1 ? '' : 's'} applied</span>` : ''}
            </div>
          </div>
          <div class="ms-head-actions">
            ${canImport ? '<button class="btn btn-secondary btn-sm" data-action="import-plan">Import plan</button>' : ''}
            ${m.hasPlan && !['done', 'cancelled', 'cancelling'].includes(m.status) ? '<button class="btn btn-secondary btn-sm" data-action="revise-plan">Revise plan</button>' : ''}
            ${canCancel ? '<button class="btn btn-danger btn-sm" data-action="cancel-mission">Cancel mission</button>' : ''}
          </div>
        </div>
        <div class="ms-progress"><span style="width:${m.progress || 0}%"></span></div>
        ${m.error ? `<div class="ms-callout">${escapeHtml(m.error)}</div>` : ''}
        ${m.usedLessons && m.usedLessons.length ? `<div class="ms-callout ms-callout-lessons">Lessons applied: ${escapeHtml((detail.lessons || []).map((l) => l.title).join(' · ') || `${m.usedLessons.length} recorded lesson(s)`)}</div>` : ''}
        ${m.status === 'quota' ? '<div class="ms-callout ms-callout-warn">Autonomous work is paused by a provider quota signal. It resumes only after the recorded cooldown, and only if an attempt remains.</div>' : ''}
        ${m.status === 'review' ? '<div class="ms-callout ms-callout-warn">A finished task is waiting for acceptance. Dependencies stay blocked until you accept or reject it.</div>' : ''}
        ${meta && meta.budget && meta.budget.exhausted ? `<div class="ms-callout ms-callout-warn">Autonomous budget reached for today (${meta.budget.used}/${meta.budget.limit}). Manual queue tasks still run; it resets at local midnight.</div>` : ''}
        ${live.length === 0 ? '<div class="ms-callout ms-callout-warn">No sentinel heartbeat in the last 2 minutes. Tasks stay queued until a node runs <code>scripts/sentinel.js</code>.</div>' : ''}
        <div class="ms-tabs">
          <button class="ms-tab ${tab === 'board' ? 'active' : ''}" data-action="tab" data-tab="board">Board</button>
          <button class="ms-tab ${tab === 'wiki' ? 'active' : ''}" data-action="tab" data-tab="wiki">Wiki</button>
          <span class="ms-tab-spacer"></span>
          <span class="ms-stage-summary">${stageSummary()}</span>
        </div>
      </header>
      <div class="ms-tab-body">${tab === 'wiki' ? renderWiki() : renderBoard()}</div>`;
  }

  function stageSummary() {
    if (!detail || !detail.tasks.length) return '';
    const max = detail.tasks.reduce((value, task) => Math.max(value, task.stage || 0), 0);
    return `${max + 1} stage${max ? 's' : ''}`;
  }

  function renderBoard() {
    const byId = new Map(detail.tasks.map((t) => [t.id, t]));
    return `<div class="ms-board">${COLUMNS.map((column) => {
      const list = detail.tasks.filter((t) => t.status === column.id);
      return `<div class="ms-col" data-state="${column.id}">
        <div class="ms-col-head"><span class="ms-col-dot"></span><span>${column.label}</span><span class="ms-col-count">${list.length}</span></div>
        <div class="ms-cards">${list.length ? list.map((t) => renderCard(t, byId)).join('') : '<div class="ms-col-empty">Empty</div>'}</div>
      </div>`;
    }).join('')}</div>`;
  }

  function renderCard(task, byId) {
    const role = roleOf(task.role);
    const deps = (task.deps || []).map((id) => (byId.get(id) || {}).title || id.slice(0, 8));
    const canMove = ['queued', 'blocked'].includes(task.status);
    return `<article class="ms-card" data-status="${task.status}" data-action="task-detail" data-id="${escapeHtml(task.id)}" title="Open task detail">
      <div class="ms-card-top">
        <span class="ms-role" style="--role-color:${escapeHtml(role.color)}">${escapeHtml(role.short)} ${escapeHtml(role.label)}</span>
        ${task.exclusive ? '<span class="ms-lock" title="Exclusive writer: only one runs per project">exclusive</span>' : ''}
      </div>
      <div class="ms-card-title">${escapeHtml(task.title || 'Untitled task')}</div>
      ${task.description ? `<div class="ms-card-desc">${escapeHtml(truncate(task.description, 180))}</div>` : ''}
      ${deps.length ? `<div class="ms-deps" title="${escapeHtml(deps.join(', '))}">after ${escapeHtml(truncate(deps.join(', '), 60))}</div>` : ''}
      ${task.acceptance && task.acceptance.length ? `<div class="ms-deps">${task.acceptance.length} acceptance check${task.acceptance.length === 1 ? '' : 's'}</div>` : ''}
      ${task.status === 'failed' && task.error ? `<div class="ms-card-error">${escapeHtml(truncate(task.error, 180))}</div>` : ''}
      ${task.status === 'quota' ? `<div class="ms-card-error">next check ${escapeHtml(fmtDate(task.retryAt))}</div>` : ''}
      ${task.reviewNote ? '<div class="ms-deps">user correction recorded</div>' : ''}
      <div class="ms-card-foot">
        <span class="ms-card-meta">${escapeHtml(task.agent || 'agent')}${task.attempt ? ` · try ${task.attempt}` : ''}</span>
        <span class="ms-card-actions">
          ${canMove ? `<button class="ms-icon-btn" title="Move up" data-action="move" data-dir="-1" data-id="${escapeHtml(task.id)}">↑</button>
          <button class="ms-icon-btn" title="Move down" data-action="move" data-dir="1" data-id="${escapeHtml(task.id)}">↓</button>` : ''}
          ${task.handoffRef ? `<button class="ms-icon-btn" title="Open handoff" data-action="open-file" data-path="${escapeHtml(task.handoffRef)}">doc</button>` : ''}
          ${task.result ? `<button class="ms-icon-btn" title="Show result" data-action="result" data-id="${escapeHtml(task.id)}">out</button>` : ''}
          ${!FINAL.has(task.status) && task.status !== 'cancelling' ? `<button class="ms-icon-btn danger" title="Cancel task" data-action="cancel-task" data-id="${escapeHtml(task.id)}">×</button>` : ''}
        </span>
      </div>
    </article>`;
  }

  function fileLabel(file) {
    if (file.path === 'goal.md') return 'Goal';
    if (file.path === 'plan.json') return 'Plan';
    if (file.path === 'decisions.md') return 'Decisions';
    if (file.path.startsWith('handoff/')) return `Handoff · ${file.name.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' ')}`;
    return file.name;
  }

  function renderWiki() {
    const files = detail.files || [];
    const current = wikiDoc && wikiDoc.path === wikiPath ? wikiDoc : null;
    if (!current) return '<div class="ms-loading">Loading page…</div>';
    return `<div class="ms-wiki">
      <aside class="ms-wiki-nav">
        <div class="ms-side-header"><span>Pages</span></div>
        ${files.map((file) => `<button class="ms-wiki-link ${file.path === wikiPath ? 'active' : ''}" data-action="open-file" data-path="${escapeHtml(file.path)}">${escapeHtml(fileLabel(file))}</button>`).join('')}
      </aside>
      <div class="ms-wiki-body">
        <div class="ms-doc-title">${escapeHtml(fileLabel({ path: wikiPath, name: wikiPath }))}</div>
        <div class="ms-doc">${renderDoc(current.content, wikiPath)}</div>
        <div class="ms-note">
          <label for="ms-note-text">Add a decision or note</label>
          <textarea id="ms-note-text" rows="3" placeholder="Why this approach? What should the next agent know?"></textarea>
          <div class="ms-note-actions"><button class="btn btn-secondary btn-sm" data-action="add-note">Append to decisions</button></div>
        </div>
      </div>
    </div>`;
  }

  // Tiny, safe Markdown: escape first, then add only our own tags. Raw HTML is
  // never interpreted, which matters because plans and handoffs are model output.
  function inlineDoc(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function renderDoc(text, path) {
    if (/\.json$/i.test(path)) return `<pre class="ms-code">${escapeHtml(text || '')}</pre>`;
    const lines = escapeHtml(text || '').split('\n');
    const out = [];
    let inCode = false;
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inCode) { out.push('</code></pre>'); inCode = false; } else { closeList(); out.push('<pre class="ms-code"><code>'); inCode = true; }
        continue;
      }
      if (inCode) { out.push(line); continue; }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        out.push(`<h${level}>${inlineDoc(heading[2])}</h${level}>`);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${inlineDoc(bullet[1])}</li>`);
        continue;
      }
      if (!line.trim()) { closeList(); continue; }
      closeList();
      out.push(`<p>${inlineDoc(line)}</p>`);
    }
    closeList();
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
  }

  // --- Events --------------------------------------------------------------

  function bindShell() {
    const content = document.getElementById('main-content');
    content.onchange = (event) => {
      const filter = event.target.getAttribute('data-filter');
      if (!filter) return;
      if (filter === 'project') projectFilter = event.target.value;
      if (filter === 'status') statusFilter = event.target.value;
      paint();
    };
    content.onclick = async (event) => {
      const el = event.target.closest('[data-action]');
      if (!el) return;
      const action = el.getAttribute('data-action');
      try {
        if (action === 'task-detail') {
          openTaskDetail(el.getAttribute('data-id'));
        } else if (action === 'select-mission') {
          const id = el.getAttribute('data-id');
          if (!id || id === selectedId) return;
          selectedId = id;
          wikiPath = 'goal.md';
          wikiDoc = null;
          await loadDetail();
          if (tab === 'wiki') await fetchDoc(wikiPath);
          paint();
        } else if (action === 'tab') {
          tab = el.getAttribute('data-tab');
          if (tab === 'wiki' && (!wikiDoc || wikiDoc.path !== wikiPath)) await fetchDoc(wikiPath);
          paint();
        } else if (action === 'open-file') {
          tab = 'wiki';
          wikiPath = el.getAttribute('data-path');
          await fetchDoc(wikiPath);
          paint();
        } else if (action === 'move') {
          await moveTask(el.getAttribute('data-id'), Number(el.getAttribute('data-dir')));
        } else if (action === 'cancel-task') {
          cancelTask(el.getAttribute('data-id'));
        } else if (action === 'cancel-mission') {
          confirmCancelMission();
        } else if (action === 'import-plan') {
          openImportPlan();
        } else if (action === 'revise-plan') {
          openRevisePlan();
        } else if (action === 'result') {
          showResult(el.getAttribute('data-id'));
        } else if (action === 'add-note') {
          await addNote();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  }

  function openTaskDetail(taskId) {
    const task = detail && detail.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const role = roleOf(task.role);
    const deps = (task.deps || []).map((id) => {
      const dep = detail.tasks.find((t) => t.id === id);
      return dep ? dep.title : id.slice(0, 8);
    });
    const acceptance = task.acceptance && task.acceptance.length
      ? `<ul>${task.acceptance.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
      : '<p class="ms-hint">No explicit acceptance criteria.</p>';
    const refs = task.refs && task.refs.length
      ? `<ul>${task.refs.map((r) => `<li><code>${escapeHtml(r)}</code></li>`).join('')}</ul>`
      : '<p class="ms-hint">No file references.</p>';
    openModal({
      title: `Task · ${task.title || role.label}`,
      bodyHtml: `<div class="ms-task-detail">
        <div class="ms-head-meta">${statusBadge(task.status)}
          <span class="ms-role" style="--role-color:${escapeHtml(role.color)}">${escapeHtml(role.short)} ${escapeHtml(role.label)}</span>
          <span>${escapeHtml(task.agent || 'agent')}</span>
          <span>try ${task.attempt || 0}/${task.maxAttempts || 0}</span>
          ${task.autonomous ? '<span>autonomous</span>' : ''}
        </div>
        <p>${escapeHtml(task.description || 'No description.')}</p>
        <h4>Acceptance criteria</h4>${acceptance}
        <h4>Dependencies</h4>${deps.length ? `<p>${escapeHtml(deps.join(', '))}</p>` : '<p class="ms-hint">None.</p>'}
        <h4>References</h4>${refs}
        <h4>Last result</h4>
        ${task.error ? `<pre class="ms-doc ms-result">${escapeHtml(task.error)}</pre>` : ''}
        ${task.result ? `<pre class="ms-doc ms-result">${escapeHtml(truncate(task.result, 6000))}</pre>` : '<p class="ms-hint">No result captured yet.</p>'}
        ${task.retryAt ? `<p class="ms-hint">Next quota check: ${escapeHtml(fmtDate(task.retryAt))} (not a provider reset guarantee).</p>` : ''}
        ${task.failureKind ? `<p class="ms-hint">Failure class: <code>${escapeHtml(task.failureKind)}</code></p>` : ''}
        ${task.reviewNote ? `<h4>Review / correction note</h4><p>${escapeHtml(task.reviewNote)}</p>` : ''}
        <h4>Correct this result</h4>
        <textarea id="ms-correction-text" rows="4" placeholder="What should the agent do differently next time? This becomes confirmed project memory."></textarea>
        <div class="ms-note-actions">
          <button class="btn btn-secondary btn-sm" id="ms-correction-save">Save correction</button>
          ${['review', 'done', 'failed'].includes(task.status) ? '<button class="btn btn-secondary btn-sm" id="ms-review-accept">Accept result</button><button class="btn btn-danger btn-sm" id="ms-review-reject">Reject result</button>' : ''}
          ${task.status === 'failed' ? '<button class="btn btn-secondary btn-sm" id="ms-retry-task">Retry task</button>' : ''}
        </div>
      </div>`,
      confirmText: 'Close',
      onConfirm: () => {},
    });
    const review = async (accepted) => {
      const note = document.getElementById('ms-correction-text').value.trim();
      try {
        detail = await api(`/api/missions/${encodeURIComponent(selectedId)}/tasks/${encodeURIComponent(task.id)}/review`, {
          method: 'POST',
          body: { accepted, note: note || undefined },
        });
        await loadMissions();
        document.getElementById('modal-cancel-btn').click();
        paint();
        showToast(accepted ? 'Result accepted.' : 'Result rejected; it will not count as done.', accepted ? 'success' : 'warning');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
    const accept = document.getElementById('ms-review-accept');
    if (accept) accept.onclick = () => review(true);
    const reject = document.getElementById('ms-review-reject');
    if (reject) reject.onclick = () => review(false);
    const retry = document.getElementById('ms-retry-task');
    if (retry) {
      retry.onclick = async () => {
        try {
          await api(`/api/tasks/${encodeURIComponent(task.id)}/retry`, { method: 'POST' });
          await Promise.all([loadMissions(), loadDetail()]);
          document.getElementById('modal-cancel-btn').click();
          paint();
          showToast('Task requeued for another attempt.', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }
    const save = document.getElementById('ms-correction-save');
    if (save) {
      save.onclick = async () => {
        const text = document.getElementById('ms-correction-text').value.trim();
        if (!text) { showToast('Write the correction first.', 'error'); return; }
        try {
          const res = await api(`/api/missions/${encodeURIComponent(selectedId)}/tasks/${encodeURIComponent(task.id)}/correction`, {
            method: 'POST',
            body: { text },
          });
          detail = res.mission;
          await loadMissions();
          document.getElementById('modal-cancel-btn').click();
          paint();
          showToast('Correction saved as confirmed project memory.', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      };
    }
  }

  function openRevisePlan() {
    const plan = detail && detail.plan;
    if (!plan) { showToast('No plan to revise.', 'error'); return; }
    openModal({
      title: 'Revise the plan',
      bodyHtml: `<div class="ms-form">
        <p class="ms-hint">Pending tasks are detached and cancelled; finished work and evidence are kept. The previous plan stays in the version history.</p>
        <label for="ms-revise-reason">Why is the plan changing?</label>
        <input id="ms-revise-reason" type="text" maxlength="500" placeholder="A failure changed the approach">
        <label for="ms-revise-plan">Plan JSON</label>
        <textarea id="ms-revise-plan" rows="14" spellcheck="false">${escapeHtml(JSON.stringify(plan, null, 2))}</textarea>
      </div>`,
      confirmText: 'Revise plan',
      onConfirm: async () => {
        let value;
        try { value = JSON.parse(document.getElementById('ms-revise-plan').value); } catch { throw new Error('The plan is not valid JSON.'); }
        const reason = document.getElementById('ms-revise-reason').value.trim() || undefined;
        detail = await api(`/api/missions/${encodeURIComponent(selectedId)}/plan/revision`, { method: 'POST', body: { plan: value, reason } });
        await loadMissions();
        paint();
        showToast('Plan revised; previous version kept.', 'success');
      },
    });
  }

  async function moveTask(taskId, direction) {
    if (!detail) return;
    const movable = detail.tasks.filter((t) => ['queued', 'blocked'].includes(t.status));
    const index = movable.findIndex((t) => t.id === taskId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= movable.length) return;
    const tmp = movable[index];
    movable[index] = movable[target];
    movable[target] = tmp;
    detail = await api(`/api/missions/${encodeURIComponent(selectedId)}/prioritize`, {
      method: 'POST',
      body: { order: movable.map((t) => t.id) },
    });
    await loadMissions();
    paint();
  }

  function cancelTask(taskId) {
    openModal({
      title: 'Cancel task',
      bodyHtml: '<p>Cancel this task? A running agent is asked to terminate; a queued or blocked task is removed immediately.</p>',
      confirmText: 'Cancel task',
      onConfirm: async () => {
        await api(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: {} });
        await loadDetail();
        await loadMissions();
        paint();
        showToast('Task cancelled.', 'warning');
      },
    });
  }

  function confirmCancelMission() {
    openModal({
      title: 'Cancel mission',
      bodyHtml: '<p>Cancel every queued, blocked and running task in this mission? Finished work is kept and handoffs stay readable.</p>',
      confirmText: 'Cancel mission',
      onConfirm: async () => {
        detail = await api(`/api/missions/${encodeURIComponent(selectedId)}/cancel`, { method: 'POST', body: {} });
        await loadMissions();
        paint();
        showToast('Mission cancellation requested.', 'warning');
      },
    });
  }

  function showResult(taskId) {
    const task = detail.tasks.find((t) => t.id === taskId);
    if (!task || !task.result) return;
    openModal({
      title: `Result · ${task.title}`,
      bodyHtml: `<pre class="ms-doc ms-result">${escapeHtml(task.result)}</pre>`,
      confirmText: 'Close',
      onConfirm: () => {},
    });
  }

  async function addNote() {
    const textarea = document.getElementById('ms-note-text');
    const text = textarea ? textarea.value.trim() : '';
    if (!text) throw new Error('Write a note first.');
    detail = await api(`/api/missions/${encodeURIComponent(selectedId)}/notes`, {
      method: 'POST',
      body: { text },
    });
    wikiPath = 'decisions.md';
    await fetchDoc(wikiPath);
    paint();
    showToast('Note added.', 'success');
  }

  function planFormHtml({ showMode }) {
    const projects = state.projects || [];
    const agents = (meta && meta.agents ? meta.agents : []).filter((a) => a.installed);
    return `<div class="ms-form">
      <label for="ms-goal">Goal</label>
      <textarea id="ms-goal" rows="5" placeholder="What should the team deliver? Include constraints and how to verify it."></textarea>
      <div class="ms-form-grid">
        <div>
          <label for="ms-project">Project</label>
          <select id="ms-project">
            <option value="">No project (analysis only)</option>
            ${projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label for="ms-title">Title (optional)</label>
          <input id="ms-title" type="text" maxlength="120" placeholder="Short mission title">
        </div>
      </div>
      ${showMode ? `<div class="ms-form-grid">
        <div>
          <label for="ms-mode">Planning</label>
          <select id="ms-mode">
            <option value="agent">Let an agent plan</option>
            <option value="manual">Paste a plan</option>
          </select>
        </div>
        <div id="ms-agent-wrap">
          <label for="ms-agent">Planner agent</label>
          <select id="ms-agent">
            ${agents.length
              ? agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')
              : '<option value="">No headless agent installed</option>'}
          </select>
        </div>
      </div>
      <div id="ms-plan-wrap" hidden>
        <label for="ms-plan">Plan JSON</label>
        <textarea id="ms-plan" rows="12" spellcheck="false" placeholder='{"tasks":[{"title":"...","role":"analyst"},{"title":"...","role":"backend","deps":[0]}]}'></textarea>
        <button type="button" class="btn btn-secondary btn-sm" id="ms-example-btn">Load example</button>
      </div>` : ''}
      <p class="ms-hint">Roles: analyst, backend, frontend, qa, reviewer, docs, devops. Dependencies are earlier task indices. The server validates the plan before enqueuing anything.</p>
    </div>`;
  }

  function openCreateMission() {
    const agents = (meta && meta.agents ? meta.agents : []).filter((a) => a.installed);
    openModal({
      title: 'New mission',
      bodyHtml: planFormHtml({ showMode: true }),
      confirmText: 'Create mission',
      onConfirm: async () => {
        const goal = document.getElementById('ms-goal').value.trim();
        if (!goal) throw new Error('A goal is required.');
        const projectId = document.getElementById('ms-project').value || null;
        const title = document.getElementById('ms-title').value.trim() || null;
        const mode = document.getElementById('ms-mode').value;
        const body = { goal, title, projectId };
        if (mode === 'manual') {
          const raw = document.getElementById('ms-plan').value.trim();
          if (!raw) throw new Error('Paste a plan or switch to "Let an agent plan".');
          try {
            body.plan = JSON.parse(raw);
          } catch {
            throw new Error('The plan is not valid JSON.');
          }
        } else {
          if (!agents.length) throw new Error('No headless agent is installed (claude, opencode or codex).');
          body.plannerAgent = document.getElementById('ms-agent').value || agents[0].id;
        }
        const res = await api('/api/missions', { method: 'POST', body });
        selectedId = res.mission.id;
        detail = res;
        tab = 'board';
        wikiDoc = null;
        await loadMissions();
        paint();
        showToast(body.plan ? 'Mission created and tasks enqueued.' : 'Mission created; the planner is queued.', 'success');
      },
    });
    const mode = document.getElementById('ms-mode');
    const wrap = document.getElementById('ms-plan-wrap');
    const agentWrap = document.getElementById('ms-agent-wrap');
    const example = document.getElementById('ms-example-btn');
    mode.onchange = () => {
      const manual = mode.value === 'manual';
      wrap.hidden = !manual;
      agentWrap.hidden = manual;
    };
    example.onclick = () => {
      document.getElementById('ms-plan').value = JSON.stringify(EXAMPLE_PLAN, null, 2);
    };
  }

  function openImportPlan() {
    openModal({
      title: 'Import a plan',
      bodyHtml: `<div class="ms-form">
        <p class="ms-hint">Use this when the planner failed or produced an invalid plan. Every rule is re-validated server-side.</p>
        <label for="ms-import-plan">Plan JSON</label>
        <textarea id="ms-import-plan" rows="14" spellcheck="false" placeholder='{"tasks":[{"title":"...","role":"analyst"},{"title":"...","role":"backend","deps":[0]}]}'></textarea>
        <button type="button" class="btn btn-secondary btn-sm" id="ms-example-btn">Load example</button>
      </div>`,
      confirmText: 'Import plan',
      onConfirm: async () => {
        const raw = document.getElementById('ms-import-plan').value.trim();
        if (!raw) throw new Error('Paste a plan first.');
        let plan;
        try {
          plan = JSON.parse(raw);
        } catch {
          throw new Error('The plan is not valid JSON.');
        }
        detail = await api(`/api/missions/${encodeURIComponent(selectedId)}/plan`, { method: 'POST', body: { plan } });
        await loadMissions();
        paint();
        showToast('Plan imported.', 'success');
      },
    });
    const example = document.getElementById('ms-example-btn');
    if (example) example.onclick = () => {
      const area = document.getElementById('ms-import-plan');
      if (area) area.value = JSON.stringify(EXAMPLE_PLAN, null, 2);
    };
  }

  window.CitadelMissions = {
    init,
    renderMissionsView,
    stopPolling,
  };
})();
