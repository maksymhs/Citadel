/**
 * Upload clipboard images to the host running a terminal and paste their path.
 */
(function () {
  'use strict';

  let apiForHost, showToast;
  const REQUIRED = ['apiForHost', 'showToast'];
  const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const uploading = new WeakSet();

  function init(ctx) {
    const missing = REQUIRED.filter((key) => ctx[key] === undefined);
    if (missing.length) throw new Error(`terminal-images.js: app.js did not provide ${missing.join(', ')}`);
    ({ apiForHost, showToast } = ctx);
  }

  function imageFromClipboard(data) {
    if (!data) return null;
    for (const item of Array.from(data.items || [])) {
      if (item.kind !== 'file' || !SUPPORTED.has(item.type)) continue;
      const file = item.getAsFile();
      if (file) return file;
    }
    return null;
  }

  async function imageFromClipboardApi() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return null;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = Array.from(item.types || []).find((entry) => SUPPORTED.has(entry));
      if (type) return await item.getType(type);
    }
    return null;
  }

  function fileToBase64(file) {
    return file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    });
  }

  async function upload(item, file, { hostId, isCurrent }) {
    if (!item || item.disposed || uploading.has(item) || !file || !SUPPORTED.has(file.type)) return false;
    if (file.size > 5 * 1024 * 1024) {
      showToast('Images must be 5 MiB or smaller.', 'error');
      return false;
    }
    uploading.add(item);
    try {
      showToast('Uploading image to the terminal host…', 'info');
      const content = await fileToBase64(file);
      if (!isCurrent()) return false;
      const result = await apiForHost(hostId, `/api/terminals/${encodeURIComponent(item.sessionId)}/clipboard-image`, {
        method: 'POST', body: { mimeType: file.type, content },
      });
      if (!isCurrent()) return false;
      item.term.paste(result.path);
      item.term.focus();
      showToast('Image path pasted. Press Enter when ready.', 'success');
      return true;
    } catch (err) {
      if (isCurrent()) showToast(err.message || 'Could not upload the image.', 'error');
      return false;
    } finally {
      uploading.delete(item);
    }
  }

  function handlePaste(event, item, context) {
    const file = imageFromClipboard(event.clipboardData);
    if (!file) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    upload(item, file, context);
    return true;
  }

  window.CitadelTerminalImages = { init, imageFromClipboard, imageFromClipboardApi, upload, handlePaste };
})();
