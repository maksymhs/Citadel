/**
 * Files: the file explorer (tree and grid views, editor, create, rename, delete)
 * Loaded before app.js; app.js passes the shared helpers in through init(), so
 * this file does not reach into app.js internals.
 */
(function () {
  'use strict';

  let api, escapeHtml, formatBytes, hostApiPath, openContextMenu, openModal, showToast, state;

  const REQUIRED = ['api', 'escapeHtml', 'formatBytes', 'hostApiPath', 'openContextMenu', 'openModal', 'showToast', 'state'];

  function init(ctx) {
    const missing = REQUIRED.filter((k) => ctx[k] === undefined);
    if (missing.length) throw new Error(`files.js: app.js did not provide ${missing.join(', ')}`);
    ({ api, escapeHtml, formatBytes, hostApiPath, openContextMenu, openModal, showToast, state } = ctx);
  }

  // --- File Explorer View ---
  // Two complementary modes over the host filesystem:
  //   • "list" — a lazy, hierarchical tree (Wunderbaum) for deep navigation.
  //   • "grid" — a folder view with large tiles, ideal for touch screens.
  // Both work with mouse, keyboard and touch and share the same create / edit /
  // delete actions (right-click, long-press or the context-menu key opens them).
  let filesTree = null;
  let filesGridItems = [];
  let filesGridIndex = -1;

  // Wunderbaum's default expander icons come from Bootstrap Icons, which this
  // panel does not ship, so we map them to our own CSS chevrons (see app.css).
  // File/folder glyphs are inlined as SVG so they inherit the row colour.
  const FILES_ICON_MAP = {
    loading: 'wb-exp wb-exp-closed',
    expanderExpanded: 'wb-exp wb-exp-open',
    expanderCollapsed: 'wb-exp wb-exp-closed',
    expanderLazy: 'wb-exp wb-exp-closed',
  };
  const FILES_FOLDER_ICON = '<svg class="wb-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const FILES_FILE_ICON = '<svg class="wb-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/></svg>';
  const FILES_ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';
  const FILES_ICON_GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  const FILES_ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';

  function filesIsDir(item) {
    return item.type === 'dir' || item.type === 'symlink-dir';
  }

  function filesIsLink(item) {
    return item.type === 'symlink' || item.type === 'symlink-file' || item.type === 'symlink-dir';
  }

  function filesListing(dir) {
    return api(`/api/files?path=${encodeURIComponent(dir)}`).then((res) => res.listing);
  }

  function filesTouchMode() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  function filesRowHeight() {
    return window.matchMedia('(max-width: 768px), (hover: none) and (pointer: coarse)').matches ? 40 : 28;
  }

  function setFilesStatus(html) {
    const el = document.getElementById('files-status');
    if (el) el.innerHTML = html || '';
  }

  function filesNodeData(item) {
    const isDir = filesIsDir(item);
    return {
      key: item.path,
      title: item.name,
      // Custom fields must sit at the top level: Wunderbaum stores every
      // unknown property on `node.data` (it does not unwrap a nested `data`).
      path: item.path,
      kind: isDir ? 'dir' : 'file',
      lazy: isDir,
      icon: isDir ? FILES_FOLDER_ICON : FILES_FILE_ICON,
    };
  }

  function filesNodeFromRow(rowEl) {
    if (!rowEl) return null;
    return mar10.Wunderbaum.getNode(rowEl);
  }

  function filesMenuItems(nodePath, kind) {
    const items = [];
    if (kind === 'dir') {
      items.push({ label: 'New file', onSelect: () => promptNewEntry('file', nodePath) });
      items.push({ label: 'New folder', onSelect: () => promptNewEntry('dir', nodePath) });
    } else {
      items.push({ label: 'Edit', onSelect: () => openFileEditor(nodePath) });
      items.push({
        label: 'Download',
        onSelect: () => { window.location.href = hostApiPath(`/api/files/download?path=${encodeURIComponent(nodePath)}`); },
      });
    }
    items.push({ sep: true });
    items.push({ label: 'Delete', danger: true, onSelect: () => removeEntry(nodePath) });
    return items;
  }

  function filesItemMeta(item) {
    if (filesIsDir(item)) return 'folder';
    const size = formatBytes(item.size);
    return filesIsLink(item) ? `${size} · link` : size;
  }

  function filesTileHtml(item, index) {
    const isDir = filesIsDir(item);
    const glyph = isDir ? FILES_FOLDER_ICON : FILES_FILE_ICON;
    return `<button type="button" class="files-tile${isDir ? ' is-dir' : ''}" data-idx="${index}" role="option" aria-selected="false" title="${escapeHtml(item.name)}">
      <span class="files-tile-icon">${glyph}</span>
      <span class="files-tile-name">${escapeHtml(item.name)}</span>
      <span class="files-tile-meta">${escapeHtml(filesItemMeta(item))}</span>
    </button>`;
  }

  function filesCrumbHtml(dir) {
    const parts = String(dir || '/').split('/').filter(Boolean);
    let acc = '';
    let html = `<button type="button" class="files-crumb${parts.length ? '' : ' is-current'}" data-path="/" title="/">/</button>`;
    parts.forEach((part, i) => {
      acc += `/${part}`;
      const current = i === parts.length - 1;
      html += `<span class="files-crumb-sep" aria-hidden="true">›</span><button type="button" class="files-crumb${current ? ' is-current' : ''}" data-path="${escapeHtml(acc)}">${escapeHtml(part)}</button>`;
    });
    return html;
  }

  function filesToolbarHtml() {
    const isList = state.filesMode !== 'grid';
    return `
      <div class="files-toolbar">
        <div class="files-crumbs" id="files-crumbs"${isList ? ' hidden' : ''}>${filesCrumbHtml(state.filesPath)}</div>
        <div class="files-toolbar-spacer"></div>
        <div class="files-view-toggle" role="group" aria-label="View mode">
          <button type="button" class="files-toggle-btn${isList ? ' is-active' : ''}" data-mode="list" title="List view" aria-label="List view" aria-pressed="${isList}">${FILES_ICON_LIST}</button>
          <button type="button" class="files-toggle-btn${isList ? '' : ' is-active'}" data-mode="grid" title="Grid (folder) view" aria-label="Grid view" aria-pressed="${!isList}">${FILES_ICON_GRID}</button>
        </div>
        <button class="btn btn-secondary btn-sm" id="files-disk" title="Analyze disk usage and free up space">Disk</button>
        <button class="btn btn-secondary btn-sm" id="files-new-file">+ File</button>
        <button class="btn btn-secondary btn-sm" id="files-new-folder">+ Folder</button>
        <button class="btn btn-secondary btn-sm" id="files-refresh" title="Refresh" aria-label="Refresh">${FILES_ICON_REFRESH}</button>
      </div>`;
  }

  async function renderFilesView() {
    const content = document.getElementById('main-content');
    if (!state.filesPath) {
      const hostId = state.activeHostId;
      const capabilities = await api('/api/files/capabilities').catch(() => ({}));
      if (state.currentView !== 'files' || state.activeHostId !== hostId) return;
      state.filesPath = capabilities.defaultPath || '/';
    }
    document.getElementById('top-bar-actions').innerHTML = '';
    content.style.padding = '0'; // The explorer manages its own full-height layout.

    if (filesTree) {
      filesTree.destroy();
      filesTree = null;
    }

    content.innerHTML = `
      <div class="files-view">
        ${filesToolbarHtml()}
        <div class="files-body" id="files-body"></div>
        <div class="files-statusbar" id="files-status"></div>
      </div>`;

    document.querySelectorAll('.files-toggle-btn').forEach((btn) => {
      btn.onclick = () => {
        const mode = btn.getAttribute('data-mode');
        if (mode === state.filesMode) return;
        state.filesMode = mode;
        renderFilesView();
      };
    });
    document.getElementById('files-disk').onclick = () => window.CitadelDisk.render({
      api, escapeHtml, formatBytes, openModal, showToast,
      getPath: () => state.filesPath,
      backToFiles: () => renderFilesView(),
    });
    document.getElementById('files-new-file').onclick = () => promptNewEntry('file', state.filesPath);
    document.getElementById('files-new-folder').onclick = () => promptNewEntry('dir', state.filesPath);
    document.getElementById('files-refresh').onclick = () => renderFilesView();

    const crumbs = document.getElementById('files-crumbs');
    crumbs.onclick = (ev) => {
      const btn = ev.target.closest('.files-crumb');
      if (!btn) return;
      state.filesPath = btn.getAttribute('data-path');
      renderFilesView();
    };

    if (state.filesMode === 'grid') await renderFilesGrid();
    else await renderFilesList();
  }

  async function renderFilesList() {
    const body = document.getElementById('files-body');
    body.innerHTML = '<div id="files-tree" class="files-tree"></div>';
    setFilesStatus('Loading…');

    let rootListing;
    try {
      rootListing = await filesListing('/');
    } catch (err) {
      body.innerHTML = `<div class="files-empty" style="color:var(--danger-color);">${escapeHtml(err.message)}</div>`;
      setFilesStatus('');
      return;
    }

    const treeEl = document.getElementById('files-tree');
    filesTree = new mar10.Wunderbaum({
      id: 'files-tree',
      element: treeEl,
      iconMap: FILES_ICON_MAP,
      autoCollapse: false,
      rowHeightPx: filesRowHeight(),
      source: rootListing.items.map(filesNodeData),
      // In Wunderbaum 0.14 the `lazyLoad` handler must *return* the child list
      // (calling addChildren here would leave the node in a broken state).
      lazyLoad: async (e) => {
        try {
          return (await filesListing(e.node.data.path)).items.map(filesNodeData);
        } catch (err) {
          showToast(err.message, 'error');
          return false;
        }
      },
      activate: (e) => {
        const { path: nodePath, kind } = e.node.data;
        if (kind === 'dir') {
          state.filesPath = nodePath;
          e.node.setExpanded(!e.node.isExpanded());
        } else {
          openFileEditor(nodePath);
        }
      },
    });

    treeEl.addEventListener('contextmenu', (ev) => {
      const row = ev.target.closest('.wb-row');
      if (!row) return;
      const node = filesNodeFromRow(row);
      if (!node) return;
      ev.preventDefault();
      state.filesPath = node.data.path;
      openContextMenu(row, filesMenuItems(node.data.path, node.data.kind));
    });

    setFilesStatus(`${rootListing.items.length} items at / · click a folder to expand it`);
  }

  async function renderFilesGrid() {
    const body = document.getElementById('files-body');
    body.innerHTML = '<div class="files-empty">Loading…</div>';
    setFilesStatus('Loading…');

    let listing;
    try {
      listing = await filesListing(state.filesPath);
    } catch (err) {
      body.innerHTML = `<div class="files-empty" style="color:var(--danger-color);">${escapeHtml(err.message)}</div>`;
      setFilesStatus('');
      return;
    }

    filesGridItems = listing.items;
    filesGridIndex = -1;
    const touch = filesTouchMode();

    if (!filesGridItems.length) {
      body.innerHTML = '<div class="files-empty">This folder is empty.</div>';
      setFilesStatus('0 items');
      return;
    }

    body.innerHTML = `<div class="files-grid" id="files-grid" tabindex="0" role="listbox" aria-label="Folder contents">${filesGridItems.map(filesTileHtml).join('')}</div>`;
    const grid = body.querySelector('.files-grid');
    if (!grid) return;

    grid.addEventListener('click', (ev) => {
      const tile = ev.target.closest('.files-tile');
      if (!tile) return;
      const idx = Number(tile.getAttribute('data-idx'));
      filesGridSelect(idx, { focus: false });
      if (touch) filesGridOpen(idx); // A single tap opens on touch devices.
    });
    grid.addEventListener('dblclick', (ev) => {
      const tile = ev.target.closest('.files-tile');
      if (!tile || touch) return;
      filesGridOpen(Number(tile.getAttribute('data-idx')));
    });
    grid.addEventListener('contextmenu', (ev) => {
      const tile = ev.target.closest('.files-tile');
      if (!tile) return;
      ev.preventDefault();
      filesGridSelect(Number(tile.getAttribute('data-idx')), { focus: false });
      const item = filesGridItems[filesGridIndex];
      openContextMenu(tile, filesMenuItems(item.path, filesIsDir(item) ? 'dir' : 'file'));
    });
    grid.addEventListener('keydown', onFilesGridKeydown);

    setFilesStatus(`${filesGridItems.length} items · double-click (or press Enter) to open`);
  }

  function filesGridSelect(idx, { focus = true } = {}) {
    const grid = document.getElementById('files-grid');
    if (!grid || idx < 0 || idx >= filesGridItems.length) return;
    filesGridIndex = idx;
    grid.querySelectorAll('.files-tile.is-selected').forEach((el) => {
      el.classList.remove('is-selected');
      el.setAttribute('aria-selected', 'false');
    });
    const tile = grid.querySelector(`.files-tile[data-idx="${idx}"]`);
    if (!tile) return;
    tile.classList.add('is-selected');
    tile.setAttribute('aria-selected', 'true');
    if (focus) {
      if (tile.focus) tile.focus({ preventScroll: true });
      if (tile.scrollIntoView) tile.scrollIntoView({ block: 'nearest' });
    }
    const item = filesGridItems[idx];
    setFilesStatus(`${filesGridItems.length} items · <b>${escapeHtml(item.name)}</b> · ${escapeHtml(filesItemMeta(item))}${filesIsDir(item) ? ' — Enter to open' : ''}`);
  }

  function filesGridOpen(idx) {
    const item = filesGridItems[idx];
    if (!item) return;
    if (filesIsDir(item)) {
      state.filesPath = item.path;
      renderFilesView();
    } else {
      openFileEditor(item.path);
    }
  }

  function filesGridMove(delta) {
    if (!filesGridItems.length) return;
    let idx = filesGridIndex;
    if (idx < 0) idx = delta >= 0 ? 0 : filesGridItems.length - 1;
    else idx = Math.min(filesGridItems.length - 1, Math.max(0, idx + delta));
    filesGridSelect(idx);
  }

  function filesGridColumns() {
    const grid = document.getElementById('files-grid');
    if (!grid) return 1;
    const tiles = grid.querySelectorAll('.files-tile');
    if (!tiles.length) return 1;
    const firstTop = tiles[0].offsetTop;
    let cols = 0;
    for (const t of tiles) {
      if (t.offsetTop === firstTop) cols += 1;
      else break;
    }
    return Math.max(1, cols);
  }

  function filesGridGoUp() {
    if (state.filesPath === '/') return;
    state.filesPath = state.filesPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
    renderFilesView();
  }

  function onFilesGridKeydown(ev) {
    const cols = filesGridColumns();
    let handled = true;
    switch (ev.key) {
      case 'ArrowRight': filesGridMove(1); break;
      case 'ArrowLeft': filesGridMove(-1); break;
      case 'ArrowDown': filesGridMove(cols); break;
      case 'ArrowUp': filesGridMove(-cols); break;
      case 'Home': filesGridSelect(0); break;
      case 'End': filesGridSelect(filesGridItems.length - 1); break;
      case 'Enter': if (filesGridIndex >= 0) filesGridOpen(filesGridIndex); break;
      case 'Backspace': filesGridGoUp(); break;
      case 'Delete': if (filesGridIndex >= 0) removeEntry(filesGridItems[filesGridIndex].path); break;
      case 'F10': {
        if (ev.shiftKey && filesGridIndex >= 0) {
          const grid = document.getElementById('files-grid');
          const tile = grid.querySelector(`.files-tile[data-idx="${filesGridIndex}"]`);
          const item = filesGridItems[filesGridIndex];
          if (tile) openContextMenu(tile, filesMenuItems(item.path, filesIsDir(item) ? 'dir' : 'file'));
        } else handled = false;
        break;
      }
      default: handled = false;
    }
    if (handled) ev.preventDefault();
  }

  async function openFileEditor(filePath) {
    let file;
    try {
      file = (await api(`/api/files/read?path=${encodeURIComponent(filePath)}`)).file;
    } catch (err) {
      showToast(err.message, 'error');
      return;
    }

    const editable = !file.binary && !file.truncated;
    const meta = `${formatBytes(file.size)} · mode ${file.mode}${file.truncated ? ' · showing first 1 MB' : ''}${file.binary ? ' · binary (read-only)' : ''}`;
    const bodyHtml = editable
      ? `<div class="file-editor-meta">${escapeHtml(meta)}</div><textarea id="files-editor" class="file-editor" spellcheck="false">${escapeHtml(file.content)}</textarea>`
      : `<div class="file-editor-meta">${escapeHtml(meta)}</div><pre class="file-editor preview">${escapeHtml(file.binary ? '[binary content]' : file.content)}</pre>`;

    openModal({
      title: filePath,
      confirmText: editable ? 'Save' : 'Close',
      bodyHtml,
      onConfirm: editable ? async () => {
        const value = document.getElementById('files-editor').value;
        await api('/api/files/write', { method: 'PUT', body: { path: filePath, content: value } });
        showToast('File saved.', 'success');
        renderFilesView();
      } : null,
    });
  }

  function promptNewEntry(kind, basePath) {
    const base = basePath || state.filesPath || '/';
    openModal({
      title: kind === 'dir' ? 'New Folder' : 'New File',
      confirmText: 'Create',
      bodyHtml: `
        <div class="form-group">
          <label class="form-label">Name</label>
          <input type="text" class="form-input" id="files-new-name" placeholder="${kind === 'dir' ? 'folder' : 'file.txt'}">
        </div>
        <p style="font-size:12px;color:var(--text-muted);">Created in <code>${escapeHtml(base)}</code></p>
      `,
      onConfirm: async () => {
        const name = (document.getElementById('files-new-name').value || '').trim();
        if (!name || name.includes('/')) throw new Error('Enter a simple file name (no slashes).');
        const target = base === '/' ? `/${name}` : `${base}/${name}`;
        if (kind === 'dir') {
          await api('/api/files/mkdir', { method: 'POST', body: { path: target } });
        } else {
          await api('/api/files/write', { method: 'PUT', body: { path: target, content: '' } });
        }
        showToast(kind === 'dir' ? 'Folder created.' : 'File created.', 'success');
        renderFilesView();
      },
    });
  }

  function removeEntry(targetPath) {
    openModal({
      title: 'Delete',
      confirmText: 'Delete',
      bodyHtml: `<p>Delete <strong>${escapeHtml(targetPath)}</strong>? This cannot be undone.</p>`,
      onConfirm: async () => {
        await api(`/api/files?path=${encodeURIComponent(targetPath)}`, { method: 'DELETE' });
        showToast('Deleted.', 'success');
        renderFilesView();
      },
    });
  }

  window.CitadelFiles = { init, renderFilesView };
})();
