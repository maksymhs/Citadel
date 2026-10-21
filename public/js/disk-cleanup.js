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

  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON_ANALYZE = svg('<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>');
  const ICON_CLEAN = svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v5M14 11v5"/>');
  const ICON_RESCAN = svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>');

  const SCAN_TIPS = [
    'Measuring real disk usage, folder by folder…',
    'Hard links are counted once and other disks are skipped.',
    'Big folders can take up to 40 seconds; you get partial results after that.',
    'Nothing is changed while scanning.',
  ];

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
    // Nothing is scanned until the user asks. Finished scans are kept for this
    // visit so going back up a folder or switching tabs is instant; Rescan and
    // any delete/clean drop them.
    const cache = { usage: new Map(), clean: null };

    content.innerHTML = `
      <div class="files-view disk-view">
        <div class="files-toolbar">
          <button class="btn btn-secondary btn-sm" id="disk-back">← Files</button>
          <div class="files-toolbar-spacer"></div>
          <div class="disk-tabs" role="tablist" aria-label="Disk tools">
            <button type="button" class="disk-tab is-active" data-tab="analyze" role="tab" aria-selected="true">${ICON_ANALYZE}<span>Analyze</span></button>
            <button type="button" class="disk-tab" data-tab="clean" role="tab" aria-selected="false">${ICON_CLEAN}<span>Quick clean</span></button>
          </div>
          <button class="btn btn-secondary btn-sm disk-rescan" id="disk-refresh">${ICON_RESCAN}<span>Rescan</span></button>
        </div>
        <div class="disk-body" id="disk-body"></div>
      </div>`;

    const body = document.getElementById('disk-body');

    let clock = null;
    const stopClock = () => { clearInterval(clock); clock = null; };

    // Interactive wait: spinner, elapsed time, indeterminate bar, rotating hint
    // and a Cancel that hands control back at once (the server finishes the scan
    // on its own; the next one simply waits for it).
    const loading = (title, onCancel) => {
      stopClock();
      body.innerHTML = `<div class="disk-loading" role="status" aria-live="polite">
        <div class="disk-spinner" aria-hidden="true"></div>
        <strong>${esc(title)}</strong>
        <div class="disk-progress" aria-hidden="true"><span></span></div>
        <div class="mon-muted"><span id="disk-elapsed">0s</span> · <span id="disk-tip">${esc(SCAN_TIPS[0])}</span></div>
        <button type="button" class="btn btn-secondary btn-sm" id="disk-cancel">Cancel</button>
      </div>`;
      const started = Date.now();
      clock = setInterval(() => {
        const elapsed = document.getElementById('disk-elapsed');
        const tip = document.getElementById('disk-tip');
        if (!elapsed) { stopClock(); return; }
        const sec = Math.floor((Date.now() - started) / 1000);
        elapsed.textContent = `${sec}s`;
        tip.textContent = SCAN_TIPS[Math.floor(sec / 4) % SCAN_TIPS.length];
      }, 500);
      document.getElementById('disk-cancel').onclick = () => {
        token += 1;
        stopClock();
        onCancel();
      };
    };
    const failure = (err, retry) => {
      stopClock();
      body.innerHTML = `<div class="disk-loading">
        <strong style="color:var(--danger-color);">${esc(err.message)}</strong>
        <button type="button" class="btn btn-secondary btn-sm" id="disk-retry">Try again</button>
      </div>`;
      document.getElementById('disk-retry').onclick = retry;
    };
    const cancelled = (retry) => {
      body.innerHTML = `<div class="disk-loading">
        <strong>Scan cancelled</strong>
        <button type="button" class="btn btn-secondary btn-sm" id="disk-retry">Scan again</button>
      </div>`;
      document.getElementById('disk-retry').onclick = retry;
    };

    // A cancelled scan may still be running on the server; wait for it to end.
    async function scanApi(url, mine) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await ctx.api(url);
        } catch (err) {
          if (!/already running/i.test(err.message) || attempt >= 40 || mine !== token) throw err;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }

    async function analyze() {
      const mine = ++token;
      loading(`Scanning ${dir}`, () => cancelled(analyze));
      let usage;
      try {
        usage = (await scanApi(`/api/files/usage?path=${encodeURIComponent(dir)}`, mine)).usage;
      } catch (err) {
        if (mine === token) failure(err, analyze);
        return;
      }
      if (mine !== token) return;
      cache.usage.set(dir, usage);
      renderUsage(usage);
    }

    function renderUsage(usage) {
      stopClock();
      dir = usage.path;
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
        </div>`).join('') : '<div class="mon-muted">No files of 1 MB or more.</div>';
      body.innerHTML = `
        ${diskMeterHtml(ctx, usage.disk)}
        <div class="files-crumbs disk-crumbs" id="disk-crumbs">${crumbsHtml(ctx, usage.path)}</div>
        <div class="disk-summary"><strong>${ctx.formatBytes(usage.total)}</strong> in ${esc(usage.path)}
          ${usage.partial ? '<span class="badge badge-warning">partial — scan time limit reached</span>' : ''}
          ${usage.unreadable ? `<span class="mon-muted">· ${usage.unreadable} folders not readable</span>` : ''}</div>
        <div class="disk-list" id="disk-list">${rows}</div>
        <h4 class="disk-heading">Largest files here <span class="mon-muted">(1 MB or more)</span></h4>
        <div class="disk-list" id="disk-largest">${largest}</div>`;
    }

    async function clean() {
      const mine = ++token;
      loading('Looking for reclaimable space', () => cancelled(clean));
      let scan;
      try {
        scan = await scanApi('/api/files/cleanup', mine);
      } catch (err) {
        if (mine === token) failure(err, clean);
        return;
      }
      if (mine !== token) return;
      cache.clean = scan;
      renderClean(scan);
    }

    function renderClean(scan) {
      stopClock();
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
          cache.usage.clear();
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
          cache.usage.clear();
          cache.clean = null;
          analyze();
        },
      });
    }

    // Idle screen: say what will be scanned and wait for the button.
    function idle() {
      stopClock();
      token += 1;
      if (tab === 'analyze') {
        body.innerHTML = `<div class="disk-idle">
          <strong>Find what is taking space</strong>
          <p class="mon-muted">Measures every folder under the path below and lists the largest files. Nothing runs until you press the button.</p>
          <div class="files-crumbs disk-crumbs" id="disk-crumbs">${crumbsHtml(ctx, dir)}</div>
          <button class="btn btn-primary" id="disk-scan-btn">Scan ${esc(dir)}</button>
        </div>`;
      } else {
        body.innerHTML = `<div class="disk-idle">
          <strong>Free up space safely</strong>
          <p class="mon-muted">Looks for caches, old logs, stale temp files and project dependencies you can remove. Nothing is deleted without confirmation.</p>
          <button class="btn btn-primary" id="disk-scan-btn">Look for reclaimable space</button>
        </div>`;
      }
    }

    // Tab switch / Rescan: reuse what was already scanned, otherwise wait.
    function show({ fresh = false } = {}) {
      if (fresh) { cache.usage.clear(); cache.clean = null; }
      if (tab === 'analyze') {
        if (cache.usage.has(dir)) renderUsage(cache.usage.get(dir));
        else if (fresh) analyze();
        else idle();
      } else if (cache.clean) {
        renderClean(cache.clean);
      } else if (fresh) {
        clean();
      } else {
        idle();
      }
    }

    content.querySelectorAll('.disk-tab').forEach((btn) => {
      btn.onclick = () => {
        tab = btn.dataset.tab;
        content.querySelectorAll('.disk-tab').forEach((b) => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        show();
      };
    });
    document.getElementById('disk-back').onclick = () => { token += 1; stopClock(); ctx.backToFiles(); };
    document.getElementById('disk-refresh').onclick = () => show({ fresh: true });
    body.addEventListener('click', (ev) => {
      const crumb = ev.target.closest('.files-crumb');
      const open = ev.target.closest('[data-open]');
      const del = ev.target.closest('[data-del]');
      // Picking a folder is an explicit request to look inside it.
      if (crumb) { dir = crumb.dataset.path; if (cache.usage.has(dir)) renderUsage(cache.usage.get(dir)); else if (body.querySelector('.disk-idle')) idle(); else analyze(); }
      else if (open) { dir = open.dataset.open; if (cache.usage.has(dir)) renderUsage(cache.usage.get(dir)); else analyze(); }
      else if (ev.target.id === 'disk-scan-btn') { if (tab === 'analyze') analyze(); else clean(); }
      else if (del) confirmDelete(del.dataset.del);
      else if (ev.target.id === 'disk-clean-btn') confirmClean();
    });
    body.addEventListener('change', (ev) => {
      if (ev.target.matches('#disk-cands input[type=checkbox]')) updateSelected();
    });

    idle();
  }

  window.CitadelDisk = { render };
})();
