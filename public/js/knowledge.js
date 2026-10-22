/**
 * Docs and Learning: the project Markdown wiki and the structured memory view.
 * Both are thin clients over /api/docs and /api/learning; nothing is simulated.
 * They share the mission module gate and the existing shell/modal helpers.
 */
(function () {
  'use strict';

  let api, escapeHtml, openModal, showToast, state;
  const REQUIRED = ['api', 'escapeHtml', 'openModal', 'showToast', 'state'];

  let docsProjectId = null;
  let docs = [];
  let docsGit = null;
  let docsRoot = null;
  let docsQuery = '';
  let selectedDoc = null;
  let docEditing = false;

  let learningProjectId = null;
  let learningScope = 'project';
  let learningStatus = '';
  let lessons = [];
  let selectedLesson = null;

  function init(ctx) {
    const missing = REQUIRED.filter((k) => ctx[k] === undefined);
    if (missing.length) throw new Error(`knowledge.js: app.js did not provide ${missing.join(', ')}`);
    ({ api, escapeHtml, openModal, showToast, state } = ctx);
  }

  function projects() {
    return state.projects || [];
  }

  function defaultProjectId() {
    const list = projects();
    return list.length ? list[0].id : null;
  }

  function projectName(id) {
    const project = projects().find((p) => p.id === id);
    return project ? project.name : 'Project';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function statusBadge(status) {
    const cls = {
      confirmed: 'badge-success',
      pending: 'badge-warning',
      discarded: 'badge-muted',
      superseded: 'badge-danger',
    }[status] || 'badge-muted';
    return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
  }

  function sourceLabel(source) {
    return {
      failure: 'Failure',
      user_correction: 'User correction',
      success: 'Resolution',
      manual: 'Operator note',
    }[source] || (source || 'Unknown');
  }

  // --- Docs ---------------------------------------------------------------

  async function loadDocs() {
    if (!docsProjectId) {
      docs = [];
      docsGit = null;
      return;
    }
    const query = docsQuery ? `&q=${encodeURIComponent(docsQuery)}` : '';
    const res = await api(`/api/docs?projectId=${encodeURIComponent(docsProjectId)}${query}`);
    docs = res.docs || [];
    docsGit = res.git || null;
    docsRoot = res.root || null;
    if (!selectedDoc || !docs.some((d) => d.path === selectedDoc.path)) {
      selectedDoc = null;
      docEditing = false;
    }
  }

  async function openDoc(path) {
    const res = await api(`/api/docs/file?projectId=${encodeURIComponent(docsProjectId)}&path=${encodeURIComponent(path)}`);
    selectedDoc = res.doc;
    docEditing = false;
  }

  function renderMarkdown(text) {
    const escaped = escapeHtml(text || '');
    const out = [];
    let inCode = false;
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    const inline = (value) => value
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[\[([^\]]+)\]\]/g, '<button class="kn-doc-link" data-doc-path="$1">$1</button>')
      .replace(/\btask:([a-zA-Z0-9-]{6,})/g, '<code class="kn-task-ref">task:$1</code>');
    for (const line of escaped.split('\n')) {
      if (/^\s*```/.test(line)) {
        if (inCode) { out.push('</code></pre>'); inCode = false; } else { closeList(); out.push('<pre class="ms-code"><code>'); inCode = true; }
        continue;
      }
      if (inCode) { out.push(line); continue; }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      if (!line.trim()) { closeList(); continue; }
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
  }

  async function renderDocsView() {
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="kn-docs-refresh">Refresh</button>
      <button class="btn btn-primary btn-sm" id="kn-docs-new">+ New page</button>`;
    document.getElementById('kn-docs-refresh').onclick = () => refreshDocs();
    document.getElementById('kn-docs-new').onclick = () => openCreateDoc();

    const content = document.getElementById('main-content');
    if (!docsProjectId) docsProjectId = defaultProjectId();
    content.innerHTML = '<div class="ms-loading">Loading documents…</div>';
    try {
      await loadDocs();
      paintDocs();
    } catch (err) {
      content.innerHTML = `<div class="ms-empty"><h3>Could not load docs</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function refreshDocs() {
    try {
      await loadDocs();
      paintDocs();
      showToast('Docs refreshed.', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function paintDocs() {
    const content = document.getElementById('main-content');
    if (!content) return;
    if (!projects().length) {
      content.innerHTML = '<div class="ms-empty"><h3>No projects</h3><p>Create or import a project first; Docs live inside its checkout.</p></div>';
      return;
    }
    const pending = docsGit && docsGit.pending ? docsGit.pending.length : 0;
    content.innerHTML = `
      <div class="kn-shell">
        <div class="kn-toolbar">
          <label class="kn-field"><span>Project</span>
            <select id="kn-docs-project">${projects().map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === docsProjectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
          </label>
          <label class="kn-field kn-grow"><span>Search</span>
            <input id="kn-docs-search" type="search" value="${escapeHtml(docsQuery)}" placeholder="Search titles and Markdown…"></label>
          <div class="kn-git ${pending ? 'dirty' : ''}" title="${escapeHtml((docsGit && docsGit.branch) || '')}">
            ${pending ? `${pending} pending in Git` : 'Git clean'}${docsRoot ? ` · ${escapeHtml(docsRoot)}/` : ''}
          </div>
        </div>
        <div class="kn-split">
          <aside class="kn-list">
            <div class="ms-side-header"><span>Pages</span><span class="ms-side-count">${docs.length}</span></div>
            ${docs.length ? docs.map((doc) => `<button class="kn-list-item ${selectedDoc && selectedDoc.path === doc.path ? 'active' : ''}" data-doc-path="${escapeHtml(doc.path)}">
              <span class="kn-list-title">${escapeHtml(doc.title)}</span>
              <span class="kn-list-meta">${escapeHtml(doc.path)}${doc.pending ? ' · uncommitted' : ''}</span>
            </button>`).join('') : '<div class="ms-col-empty">No Markdown pages yet.</div>'}
          </aside>
          <section class="kn-reader">${renderDocReader()}</section>
        </div>
      </div>`;
    bindDocs();
  }

  function renderDocReader() {
    if (!selectedDoc) {
      return `<div class="ms-empty"><div class="ms-empty-mark">D</div><h3>Open a page</h3><p>Pages are Markdown files in <code>${escapeHtml(docsRoot || 'docs')}/</code>. Editing writes to the project checkout, so Git shows the change.</p></div>`;
    }
    const doc = selectedDoc;
    if (docEditing) {
      return `<div class="kn-doc-head">
          <div><div class="kn-eyebrow">${escapeHtml(doc.path)}</div><h2>${escapeHtml(doc.title)}</h2></div>
          <div class="kn-actions">
            <button class="btn btn-secondary btn-sm" data-doc-action="cancel-edit">Cancel</button>
            <button class="btn btn-primary btn-sm" data-doc-action="save">Save</button>
          </div>
        </div>
        <textarea id="kn-doc-editor" class="kn-editor" spellcheck="false">${escapeHtml(doc.content)}</textarea>`;
    }
    return `<div class="kn-doc-head">
        <div><div class="kn-eyebrow">${escapeHtml(doc.path)} · ${fmtDate(doc.modifiedAt)}</div><h2>${escapeHtml(doc.title)}</h2></div>
        <div class="kn-actions">
          <button class="btn btn-secondary btn-sm" data-doc-action="link">Link to task</button>
          <button class="btn btn-primary btn-sm" data-doc-action="edit">Edit</button>
        </div>
      </div>
      ${doc.taskId || doc.missionId ? `<div class="kn-links">${doc.taskId ? `<span>Task <code>${escapeHtml(doc.taskId.slice(0, 8))}</code></span>` : ''}${doc.missionId ? `<span>Mission <code>${escapeHtml(doc.missionId.slice(0, 8))}</code></span>` : ''}</div>` : ''}
      <article class="ms-doc kn-markdown">${renderMarkdown(doc.content)}</article>`;
  }

  function bindDocs() {
    const content = document.getElementById('main-content');
    content.onchange = async (event) => {
      if (event.target.id === 'kn-docs-project') {
        docsProjectId = event.target.value;
        selectedDoc = null;
        docsQuery = '';
        await loadDocs();
        paintDocs();
      }
    };
    content.oninput = (event) => {
      if (event.target.id === 'kn-docs-search') {
        docsQuery = event.target.value;
      }
    };
    content.onkeydown = (event) => {
      if (event.target.id === 'kn-docs-search' && event.key === 'Enter') {
        loadDocs().then(paintDocs).catch((err) => showToast(err.message, 'error'));
      }
    };
    content.onclick = async (event) => {
      const link = event.target.closest('[data-doc-path]');
      const action = event.target.closest('[data-doc-action]');
      try {
        if (link) {
          await openDoc(link.getAttribute('data-doc-path'));
          paintDocs();
          return;
        }
        if (!action) return;
        const kind = action.getAttribute('data-doc-action');
        if (kind === 'edit') {
          docEditing = true;
          paintDocs();
        } else if (kind === 'cancel-edit') {
          docEditing = false;
          paintDocs();
        } else if (kind === 'save') {
          const editor = document.getElementById('kn-doc-editor');
          const res = await api('/api/docs', {
            method: 'PUT',
            body: {
              projectId: docsProjectId,
              path: selectedDoc.path,
              content: editor.value,
              expectedUpdatedAt: selectedDoc.modifiedAt,
            },
          });
          selectedDoc = res.doc;
          docEditing = false;
          await loadDocs();
          paintDocs();
          showToast('Document saved. Commit it with your normal Git flow.', 'success');
        } else if (kind === 'link') {
          openLinkDoc();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  }

  function openCreateDoc() {
    if (!docsProjectId) {
      showToast('Select a project first.', 'error');
      return;
    }
    openModal({
      title: 'New Markdown page',
      bodyHtml: `<div class="ms-form">
        <label for="kn-new-path">Path</label>
        <input id="kn-new-path" type="text" placeholder="architecture.md" value="">
        <label for="kn-new-title">Title (optional)</label>
        <input id="kn-new-title" type="text" placeholder="Architecture notes">
        <label for="kn-new-content">Markdown</label>
        <textarea id="kn-new-content" rows="12" spellcheck="false" placeholder="# Architecture&#10;&#10;..."></textarea>
        <p class="ms-hint">Existing files are never overwritten. Use [[other-page.md]] for internal links and task:&lt;id&gt; to reference a task.</p>
      </div>`,
      confirmText: 'Create page',
      onConfirm: async () => {
        const relPath = document.getElementById('kn-new-path').value.trim();
        const title = document.getElementById('kn-new-title').value.trim();
        const body = document.getElementById('kn-new-content').value;
        if (!relPath) throw new Error('A path is required.');
        const res = await api('/api/docs', {
          method: 'POST',
          body: { projectId: docsProjectId, path: relPath, title: title || undefined, content: body || undefined },
        });
        selectedDoc = res.doc;
        docEditing = false;
        await loadDocs();
        if (state.currentView === 'docs') paintDocs();
        showToast('Page created.', 'success');
      },
    });
  }

  function openLinkDoc() {
    if (!selectedDoc) return;
    openModal({
      title: `Link ${selectedDoc.title}`,
      bodyHtml: `<div class="ms-form">
        <label for="kn-link-task">Task id (optional)</label>
        <input id="kn-link-task" type="text" value="${escapeHtml(selectedDoc.taskId || '')}" placeholder="task uuid">
        <label for="kn-link-mission">Mission id (optional)</label>
        <input id="kn-link-mission" type="text" value="${escapeHtml(selectedDoc.missionId || '')}" placeholder="mission uuid">
        <p class="ms-hint">Links are metadata only; the Markdown stays in Git.</p>
      </div>`,
      confirmText: 'Save links',
      onConfirm: async () => {
        const taskId = document.getElementById('kn-link-task').value.trim() || undefined;
        const missionId = document.getElementById('kn-link-mission').value.trim() || undefined;
        const res = await api('/api/docs/link', {
          method: 'POST',
          body: { projectId: docsProjectId, path: selectedDoc.path, taskId, missionId },
        });
        selectedDoc = { ...selectedDoc, ...res.doc };
        paintDocs();
        showToast('Links saved.', 'success');
      },
    });
  }

  // --- Learning -----------------------------------------------------------

  async function loadLessons() {
    const where = [];
    if (learningScope === 'global') where.push('scope=global');
    else if (learningProjectId) where.push(`projectId=${encodeURIComponent(learningProjectId)}`);
    if (learningStatus && learningStatus !== 'corrections') where.push(`status=${encodeURIComponent(learningStatus)}`);
    const res = await api(`/api/learning?${where.join('&')}`);
    lessons = res.lessons || [];
    if (!selectedLesson || !lessons.some((l) => l.id === selectedLesson.id)) selectedLesson = lessons[0] || null;
  }

  async function renderLearningView() {
    const actions = document.getElementById('top-bar-actions');
    actions.innerHTML = '<button class="btn btn-secondary btn-sm" id="kn-learn-refresh">Refresh</button>';
    document.getElementById('kn-learn-refresh').onclick = async () => {
      try { await loadLessons(); paintLearning(); } catch (err) { showToast(err.message, 'error'); }
    };
    if (!learningProjectId) learningProjectId = defaultProjectId();
    const content = document.getElementById('main-content');
    content.innerHTML = '<div class="ms-loading">Loading lessons…</div>';
    try {
      await loadLessons();
      paintLearning();
    } catch (err) {
      content.innerHTML = `<div class="ms-empty"><h3>Could not load learning</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  function lessonMatches(lesson, status) {
    return status === 'corrections' ? lesson.source === 'user_correction' : true;
  }

  function paintLearning() {
    const content = document.getElementById('main-content');
    if (!content) return;
    const corrections = lessons.filter((l) => l.source === 'user_correction');
    const visible = lessons.filter((l) => lessonMatches(l, learningStatus === 'corrections' ? 'corrections' : ''));
    content.innerHTML = `
      <div class="kn-shell">
        <div class="kn-toolbar">
          <label class="kn-field"><span>Project memory</span>
            <select id="kn-learn-project">
              ${projects().map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === learningProjectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
            </select></label>
          <div class="kn-segment">
            <button class="${learningScope === 'project' ? 'active' : ''}" data-learn-scope="project">Project</button>
            <button class="${learningScope === 'global' ? 'active' : ''}" data-learn-scope="global">Global</button>
          </div>
          <label class="kn-field"><span>Status</span>
            <select id="kn-learn-status">
              <option value="" ${!learningStatus ? 'selected' : ''}>All</option>
              <option value="pending" ${learningStatus === 'pending' ? 'selected' : ''}>Pending</option>
              <option value="confirmed" ${learningStatus === 'confirmed' ? 'selected' : ''}>Confirmed</option>
              <option value="discarded" ${learningStatus === 'discarded' ? 'selected' : ''}>Discarded</option>
              <option value="superseded" ${learningStatus === 'superseded' ? 'selected' : ''}>Superseded</option>
              <option value="corrections" ${learningStatus === 'corrections' ? 'selected' : ''}>User corrections</option>
            </select></label>
          <div class="kn-stat">${visible.length} lesson${visible.length === 1 ? '' : 's'}${corrections.length ? ` · ${corrections.length} correction${corrections.length === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div class="kn-split">
          <aside class="kn-list">
            ${visible.length ? visible.map((lesson) => `<button class="kn-list-item ${selectedLesson && selectedLesson.id === lesson.id ? 'active' : ''}" data-lesson-id="${escapeHtml(lesson.id)}">
              <span class="kn-list-title">${escapeHtml(lesson.title)}</span>
              <span class="kn-list-meta">${statusBadge(lesson.status)} <span>${escapeHtml(lesson.scope)} · ${escapeHtml(sourceLabel(lesson.source))} · ×${lesson.occurrences}</span></span>
            </button>`).join('') : '<div class="ms-col-empty">No lessons match this filter.</div>'}
          </aside>
          <section class="kn-reader">${renderLesson()}</section>
        </div>
      </div>`;
    bindLearning();
  }

  function renderLesson() {
    const lesson = selectedLesson;
    if (!lesson) {
      return `<div class="ms-empty"><div class="ms-empty-mark">L</div><h3>No lesson selected</h3><p>Failures, successful resolutions and explicit corrections appear here. A failure becomes project memory; only an operator can promote it to global.</p></div>`;
    }
    const evidence = lesson.evidence && lesson.evidence.length
      ? `<ul class="kn-evidence">${lesson.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
      : '<p class="ms-hint">No evidence was retained.</p>';
    return `<div class="kn-doc-head">
        <div><div class="kn-eyebrow">${escapeHtml(lesson.scope)} · ${escapeHtml(sourceLabel(lesson.source))} · ${fmtDate(lesson.updatedAt)}</div>
          <h2>${escapeHtml(lesson.title)}</h2></div>
        <div>${statusBadge(lesson.status)}</div>
      </div>
      <div class="kn-links">
        <span>${lesson.occurrences} observation${lesson.occurrences === 1 ? '' : 's'}</span>
        ${lesson.projectId ? `<span>Project <code>${escapeHtml(lesson.projectId.slice(0, 8))}</code></span>` : '<span>Global knowledge</span>'}
        ${lesson.taskId ? `<span>Task <code>${escapeHtml(lesson.taskId.slice(0, 8))}</code></span>` : ''}
        ${lesson.missionId ? `<span>Mission <code>${escapeHtml(lesson.missionId.slice(0, 8))}</code></span>` : ''}
      </div>
      <dl class="kn-defs">
        <dt>Problem</dt><dd>${escapeHtml(lesson.problem || '—')}</dd>
        <dt>Context</dt><dd>${escapeHtml(lesson.context || '—')}</dd>
        <dt>Root cause</dt><dd>${escapeHtml(lesson.rootCause || '—')} <span class="kn-tag">${lesson.rootCauseConfirmed ? 'confirmed' : 'hypothesis, not proven'}</span></dd>
        <dt>What worked / correction</dt><dd>${escapeHtml(lesson.solution || '—')}</dd>
        <dt>Preventive rule</dt><dd>${escapeHtml(lesson.rule || '—')}</dd>
        <dt>Components</dt><dd>${(lesson.components || []).map((c) => `<span class="kn-tag">${escapeHtml(c)}</span>`).join(' ') || '—'}</dd>
        <dt>Evidence</dt><dd>${evidence}</dd>
      </dl>
      <div class="kn-actions">
        ${lesson.status !== 'confirmed' ? '<button class="btn btn-secondary btn-sm" data-learn-action="confirm">Confirm</button>' : ''}
        ${lesson.status !== 'discarded' ? '<button class="btn btn-secondary btn-sm" data-learn-action="discard">Discard</button>' : ''}
        ${lesson.status !== 'superseded' ? '<button class="btn btn-secondary btn-sm" data-learn-action="supersede">Supersede…</button>' : ''}
        ${lesson.scope === 'project' && lesson.status !== 'discarded' && lesson.status !== 'superseded' ? '<button class="btn btn-primary btn-sm" data-learn-action="promote">Promote to global</button>' : ''}
      </div>`;
  }

  function bindLearning() {
    const content = document.getElementById('main-content');
    content.onchange = async (event) => {
      try {
        if (event.target.id === 'kn-learn-project') {
          learningProjectId = event.target.value;
          learningScope = 'project';
          selectedLesson = null;
          await loadLessons();
          paintLearning();
        } else if (event.target.id === 'kn-learn-status') {
          learningStatus = event.target.value;
          await loadLessons();
          paintLearning();
        }
      } catch (err) { showToast(err.message, 'error'); }
    };
    content.onclick = async (event) => {
      const item = event.target.closest('[data-lesson-id]');
      const scopeBtn = event.target.closest('[data-learn-scope]');
      const actionBtn = event.target.closest('[data-learn-action]');
      try {
        if (item) {
          selectedLesson = lessons.find((l) => l.id === item.getAttribute('data-lesson-id')) || null;
          paintLearning();
        } else if (scopeBtn) {
          learningScope = scopeBtn.getAttribute('data-learn-scope');
          selectedLesson = null;
          await loadLessons();
          paintLearning();
        } else if (actionBtn) {
          const action = actionBtn.getAttribute('data-learn-action');
          if (action === 'supersede') { openSupersede(); return; }
          const res = await api(`/api/learning/${encodeURIComponent(selectedLesson.id)}/${action}`, { method: 'POST', body: {} });
          selectedLesson = res.lesson;
          await loadLessons();
          paintLearning();
          showToast(`Lesson ${action === 'promote' ? 'promoted to global' : action}.`, 'success');
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  }

  function openSupersede() {
    openModal({
      title: 'Supersede lesson',
      bodyHtml: `<div class="ms-form">
        <p class="ms-hint">The old lesson stays readable for history but is no longer applied.</p>
        <label for="kn-replacement">Replacement lesson id</label>
        <input id="kn-replacement" type="text" placeholder="lesson uuid">
      </div>`,
      confirmText: 'Supersede',
      onConfirm: async () => {
        const replacementId = document.getElementById('kn-replacement').value.trim();
        if (!replacementId) throw new Error('A replacement lesson id is required.');
        const res = await api(`/api/learning/${encodeURIComponent(selectedLesson.id)}/supersede`, {
          method: 'POST',
          body: { replacementId },
        });
        selectedLesson = res.lesson;
        await loadLessons();
        paintLearning();
        showToast('Lesson superseded.', 'success');
      },
    });
  }

  window.CitadelKnowledge = {
    init,
    renderDocsView,
    renderLearningView,
    projectName,
  };
})();
