/**
 * Files → Disk: analyze what takes space and clean up what is safe to remove.
 * Loaded before app.js; app.js passes the shared helpers in, so this file does
 * not depend on app.js internals.
 *   • Analyze: size of every child of a folder (drill down), the largest files,
 *     and a delete action per row.
 *   • Quick clean: known caches, old logs, stale temp files and node_modules,
 *     chosen by category. The server decides which paths a category covers.
 */
(function () {
  'use strict';

  const RISK_LABEL = { safe: 'Safe', review: 'Review first' };

  function pct(part, whole) {
    return whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0;
  }

  function diskMeterHtml(ctx, disk) {
    if (!disk) return '';
    const used = pct(disk.used, disk.total);
    const level = used >= 90 ? 'crit' : used >= 75 ? 'warn' : 'ok';
    return `<div class="disk-meter">
      <div class="disk-meter-text"><strong>${ctx.formatBytes(disk.used)}</strong> used of ${ctx.formatBytes(disk.total)}
        <span class="mon-muted">· ${ctx.formatBytes(disk.free)} free (${Math.round(used)}%)</span></div>
      <div class="disk-bar disk-${level}"><span style="width:${used.toFixed(1)}%"></span></div>
    </div>`;
  }

  function crumbsHtml(ctx, dir) {
    const esc = ctx.escapeHtml;
    const parts = String(dir || '/').split('/').filter(Boolean);
    let acc = '';
    let html = `<button type="button" class="files-crumb${parts.length ? '' : ' is-current'}" data-path="/">/</button>`;
    parts.forEach((part, i) => {
      acc += `/${part}`;
      html += `<span class="files-crumb-sep" aria-hidden="true">›</span><button type="button" class="files-crumb${i === parts.length - 1 ? ' is-current' : ''}" data-path="${esc(acc)}">${esc(part)}</button>`;
    });
    return html;
  }

  async function render(ctx) {
    const content = document.getElementById('main-content');
    document.getElementById('top-bar-actions').innerHTML = '';
    content.style.padding = '0';
    const esc = ctx.escapeHtml;
    let tab = 'analyze';
    let dir = ctx.getPath() || '/';
    let token = 0; // ignores answers from a scan the user already left

    content.innerHTML = `
      <div class="files-view disk-view">
        <div class="files-toolbar">
          <button class="btn btn-secondary btn-sm" id="disk-back">← Files</button>
          <div class="files-toolbar-spacer"></div>
          <div class="files-view-toggle" role="tablist">
            <button type="button" class="files-toggle-btn is-active disk-tab" data-tab="analyze" role="tab">Analyze</button>
            <button type="button" class="files-toggle-btn disk-tab" data-tab="clean" role="tab">Quick clean</button>
          </div>
          <button class="btn btn-secondary btn-sm" id="disk-refresh">Rescan</button>
        </div>
        <div class="disk-body" id="disk-body"></div>
      </div>`;

    const body = document.getElementById('disk-body');

    const loading = (text) => { body.innerHTML = `<div class="files-empty">${esc(text)}</div>`; };
    const failure = (err) => { body.innerHTML = `<div class="files-empty" style="color:var(--danger-color);">${esc(err.message)}</div>`; };

    async function analyze() {
      const mine = ++token;
      loading(`Scanning ${dir}… large folders can take a while.`);
      let usage;
      try {
        usage = (await ctx.api(`/api/files/usage?path=${encodeURIComponent(dir)}`)).usage;
      } catch (err) {
        if (mine === token) failure(err);
        return;
      }
      if (mine !== token) return;
      const max = usage.children.reduce((m, c) => Math.max(m, c.size), 0);
      const rows = usage.children.length ? usage.children.map((c) => {
        const isDir = c.type === 'dir';
        return `<div class="disk-row" data-path="${esc(c.path)}">
          <button type="button" class="disk-name${isDir ? ' is-dir' : ''}" ${isDir ? `data-open="${esc(c.path)}"` : 'disabled'} title="${esc(c.path)}">${esc(c.name)}${isDir ? '/' : ''}</button>
          <div class="disk-share"><span style="width:${pct(c.size, max).toFixed(1)}%"></span></div>
          <span class="disk-size">${c.skipped ? 'other disk' : ctx.formatBytes(c.size)}</span>
          ${c.skipped ? '<span></span>' : `<button type="button" class="btn btn-secondary btn-sm disk-del" data-del="${esc(c.path)}" aria-label="Delete ${esc(c.name)}">Delete</button>`}
        </div>`;
      }).join('') : '<div class="files-empty">This folder is empty.</div>';
      const largest = usage.largest.length ? usage.largest.map((f) => `<div class="disk-row" data-path="${esc(f.path)}">
          <span class="disk-name" title="${esc(f.path)}">${esc(f.path)}</span>
          <span class="disk-share"></span>
          <span class="disk-size">${ctx.formatBytes(f.size)}</span>
          <button type="button" class="btn btn-secondary btn-sm disk-del" data-del="${esc(f.path)}" aria-label="Delete ${esc(f.path)}">Delete</button>
        </div>`).join('') : '<div class="mon-muted">No files.</div>';
      body.innerHTML = `
        ${diskMeterHtml(ctx, usage.disk)}
        <div class="files-crumbs disk-crumbs" id="disk-crumbs">${crumbsHtml(ctx, usage.path)}</div>
        <div class="disk-summary"><strong>${ctx.formatBytes(usage.total)}</strong> in ${esc(usage.path)}
          ${usage.partial ? '<span class="badge badge-warning">partial — scan time limit reached</span>' : ''}
          ${usage.unreadable ? `<span class="mon-muted">· ${usage.unreadable} folders not readable</span>` : ''}</div>
        <div class="disk-list" id="disk-list">${rows}</div>
        <h4 class="disk-heading">Largest files here</h4>
        <div class="disk-list" id="disk-largest">${largest}</div>`;
    }

    async function clean() {
      const mine = ++token;
      loading('Looking for reclaimable space…');
      let scan;
      try {
        scan = await ctx.api('/api/files/cleanup');
      } catch (err) {
        if (mine === token) failure(err);
        return;
      }
      if (mine !== token) return;
      const total = scan.candidates.reduce((s, c) => s + (c.writable ? c.size : 0), 0);
      const rows = scan.candidates.length ? scan.candidates.map((c) => `<label class="disk-cand${c.writable ? '' : ' is-disabled'}">
          <input type="checkbox" data-id="${esc(c.id)}" data-size="${c.size}" ${c.risk === 'safe' && c.writable ? 'checked' : ''} ${c.writable ? '' : 'disabled'} />
          <span class="disk-cand-main">
            <strong>${esc(c.label)}</strong>
            <span class="badge ${c.risk === 'safe' ? 'badge-success' : 'badge-warning'}">${esc(RISK_LABEL[c.risk] || c.risk)}</span>
            <span class="mon-muted">${esc(c.description)}</span>
            ${c.writable ? '' : '<span class="mon-muted">Needs the admin terminal to delete these.</span>'}
          </span>
          <span class="disk-size">${ctx.formatBytes(c.size)}</span>
        </label>`).join('') : '<div class="files-empty">Nothing obvious to clean. Use Analyze to find large files.</div>';
      body.innerHTML = `
        ${diskMeterHtml(ctx, scan.disk)}
        <p class="mon-muted">Up to <strong>${ctx.formatBytes(total)}</strong> can be reclaimed. Nothing is deleted until you confirm.${scan.partial ? ' (scan time limit reached; sizes may be incomplete)' : ''}</p>
        <div class="disk-list" id="disk-cands">${rows}</div>
        <div class="disk-actions">
          <span id="disk-selected" class="mon-muted"></span>
          <button class="btn btn-primary" id="disk-clean-btn">Clean selected</button>
        </div>`;
      updateSelected();
    }

    function selectedBoxes() {
      return Array.from(body.querySelectorAll('#disk-cands input[type=checkbox]:checked'));
    }

    function updateSelected() {
      const label = document.getElementById('disk-selected');
      const btn = document.getElementById('disk-clean-btn');
      if (!label || !btn) return;
      const boxes = selectedBoxes();
      const bytes = boxes.reduce((s, b) => s + Number(b.dataset.size || 0), 0);
      label.textContent = boxes.length ? `${boxes.length} selected · ${ctx.formatBytes(bytes)}` : 'Nothing selected';
      btn.disabled = boxes.length === 0;
    }

    function confirmClean() {
      const boxes = selectedBoxes();
      if (!boxes.length) return;
      const names = boxes.map((b) => b.closest('.disk-cand').querySelector('strong').textContent);
      const bytes = boxes.reduce((s, b) => s + Number(b.dataset.size || 0), 0);
      ctx.openModal({
        title: 'Clean selected',
        confirmText: 'Delete permanently',
        bodyHtml: `<p>Permanently delete about <strong>${ctx.formatBytes(bytes)}</strong>? This cannot be undone.</p>
          <ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`,
        onConfirm: async () => {
          const res = await ctx.api('/api/files/cleanup', { method: 'POST', body: { ids: boxes.map((b) => b.dataset.id) } });
          const errors = res.results.flatMap((r) => r.errors);
          ctx.showToast(`Freed ${ctx.formatBytes(res.freed)}.${errors.length ? ` ${errors.length} item(s) could not be removed.` : ''}`, errors.length ? 'warning' : 'success');
          clean();
        },
      });
    }

    function confirmDelete(target) {
      ctx.openModal({
        title: 'Delete',
        confirmText: 'Delete',
        bodyHtml: `<p>Delete <strong>${esc(target)}</strong>? This cannot be undone.</p>`,
        onConfirm: async () => {
          await ctx.api(`/api/files?path=${encodeURIComponent(target)}`, { method: 'DELETE' });
          ctx.showToast('Deleted.', 'success');
          analyze();
        },
      });
    }

    const show = () => (tab === 'analyze' ? analyze() : clean());

    content.querySelectorAll('.disk-tab').forEach((btn) => {
      btn.onclick = () => {
        tab = btn.dataset.tab;
        content.querySelectorAll('.disk-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
        show();
      };
    });
    document.getElementById('disk-back').onclick = () => ctx.backToFiles();
    document.getElementById('disk-refresh').onclick = show;
    body.addEventListener('click', (ev) => {
      const crumb = ev.target.closest('.files-crumb');
      const open = ev.target.closest('[data-open]');
      const del = ev.target.closest('[data-del]');
      if (crumb) { dir = crumb.dataset.path; analyze(); }
      else if (open) { dir = open.dataset.open; analyze(); }
      else if (del) confirmDelete(del.dataset.del);
      else if (ev.target.id === 'disk-clean-btn') confirmClean();
    });
    body.addEventListener('change', (ev) => {
      if (ev.target.matches('#disk-cands input[type=checkbox]')) updateSelected();
    });

    await show();
  }

  window.CitadelDisk = { render };
})();
