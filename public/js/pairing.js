/**
 * Pairing: the Pair a machine modal and pairing-link handling
 * Loaded before app.js; app.js passes the shared helpers in through init(), so
 * this file does not reach into app.js internals.
 */
(function () {
  'use strict';

  let api, escapeHtml, loadHosts, openModal, refreshHostStatus, renderSidebarNav, showToast, state, switchHost;

  const REQUIRED = ['api', 'escapeHtml', 'loadHosts', 'openModal', 'refreshHostStatus', 'renderSidebarNav', 'showToast', 'state', 'switchHost'];

  function init(ctx) {
    const missing = REQUIRED.filter((k) => ctx[k] === undefined);
    if (missing.length) throw new Error(`pairing.js: app.js did not provide ${missing.join(', ')}`);
    ({ api, escapeHtml, loadHosts, openModal, refreshHostStatus, renderSidebarNav, showToast, state, switchHost } = ctx);
  }

  // --- Pairing UI -----------------------------------------------------------
  // The other machine's QR lives in Settings → Connection. This modal only
  // reads it: the payload travels in the URL fragment so it is never sent in a
  // request line or logged by a reverse proxy.
  function showPairModal(initialCode = null) {
    const identity = state.hostIdentity || {};
    openModal({
      title: 'Pair a machine',
      bodyHtml: `
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;">
          Scan the QR shown in <strong>Settings → Connection</strong> on the other Citadel,
          or paste its pairing link. Both machines end up paired, so either one can switch
          to the other. Codes created in Settings also merge the credential vault in both
          directions, so tokens and env vars do not need to be entered twice (HTTPS only).
        </p>
        <div class="form-group">
          <label class="form-label">Pairing link or code</label>
          <input class="form-input" id="pair-code" autocomplete="off" placeholder="https://host/#pair=…" value="${escapeHtml(initialCode || '')}" />
        </div>
        <button class="btn btn-primary btn-sm" id="pair-redeem-btn">Pair this machine</button>
        <div id="pair-scan-area" style="margin-top:14px;display:none;">
          <video id="pair-scan-video" playsinline autoplay muted style="width:100%;border-radius:8px;background:#000;"></video>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">Point the camera at the other machine's QR code.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
          <button class="btn btn-secondary btn-sm" id="pair-scan-btn">Use live camera</button>
          <button class="btn btn-secondary btn-sm" id="pair-scan-photo-btn">Take a photo of the QR</button>
          <input type="file" id="pair-scan-file" accept="image/*" capture="environment" style="display:none;" />
        </div>
        <div id="pair-error" style="color:var(--danger-color);font-size:12px;margin-top:8px;"></div>

        <div style="margin-top:16px;font-size:12px;color:var(--text-muted);">
          This machine: <strong>${escapeHtml(identity.name || '')}</strong>
          <span style="font-family:var(--font-mono);word-break:break-all;">${escapeHtml(identity.url || '')}</span>
        </div>
      `,
      confirmText: 'Done',
      onConfirm: async () => {},
      onClose: () => stopScan(),
    });

    const errorEl = () => document.getElementById('pair-error');
    const redeemBtn = document.getElementById('pair-redeem-btn');
    const redeem = async () => {
      const code = document.getElementById('pair-code').value.trim();
      if (!code) return;
      redeemBtn.disabled = true;
      redeemBtn.textContent = 'Pairing…';
      try {
        const res = await api('/api/pair/redeem', { method: 'POST', body: { code } });
        await loadHosts();
        await refreshHostStatus(true);
        renderSidebarNav();
        const sync = res.secrets;
        const syncNote = sync && sync.ok
          ? ` Credentials synced: ${sync.imported || 0} received, ${sync.remoteImported || 0} sent.`
          : (sync && sync.error ? ` Credential sync skipped: ${sync.error}` : '');
        showToast(`Paired with ${res.host.name}.${syncNote}`, sync && sync.error ? 'info' : 'success');
        document.getElementById('modal-close-btn')?.click();
        if (res.host && res.host.id) switchHost(res.host.id);
      } catch (err) {
        if (errorEl()) {
          errorEl().textContent = /same host/i.test(err.message)
            ? 'This code was created by this machine. Open the other Citadel, choose “Pair a machine” and paste this code there.'
            : err.message;
        }
        redeemBtn.disabled = false;
        redeemBtn.textContent = 'Pair this machine';
      }
    };
    redeemBtn.onclick = redeem;
    document.getElementById('pair-code').onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); redeem(); }
    };

    let scanStream = null;
    let scanFrame = null;
    let scanCanvas = null;
    const stopScan = () => {
      if (scanFrame) {
        cancelAnimationFrame(scanFrame);
        scanFrame = null;
      }
      if (scanStream) {
        scanStream.getTracks().forEach((track) => track.stop());
        scanStream = null;
      }
      const area = document.getElementById('pair-scan-area');
      if (area) area.style.display = 'none';
      const video = document.getElementById('pair-scan-video');
      if (video) video.srcObject = null;
    };

    // jsQR works in Safari (which has no BarcodeDetector) and is also used as a
    // fallback when the native detector is missing or fails on a frame.
    const decodeQrImage = (source, width, height, maxSize = 1200) => {
      if (typeof window.jsQR !== 'function' || !width || !height) return null;
      const scale = Math.min(1, maxSize / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = scanCanvas || (scanCanvas = document.createElement('canvas'));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, w, h);
      const image = ctx.getImageData(0, 0, w, h);
      const result = window.jsQR(image.data, w, h, { inversionAttempts: 'attemptBoth' });
      return result && result.data ? result.data : null;
    };

    const acceptCode = async (value) => {
      if (!value) return;
      stopScan();
      const input = document.getElementById('pair-code');
      if (input) input.value = value;
      await redeem();
    };

    // Native capture: opens the phone's camera app without getUserMedia, so it
    // works in Safari and even when the panel is served over plain HTTP (where
    // browsers block the live camera for security).
    const fileInput = document.getElementById('pair-scan-file');
    document.getElementById('pair-scan-photo-btn').onclick = () => {
      if (errorEl()) errorEl().textContent = '';
      fileInput.click();
    };
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const objectUrl = URL.createObjectURL(file);
      try {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Could not read that image.'));
          img.src = objectUrl;
        });
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        const value = decodeQrImage(img, width, height, 1600);
        if (!value) throw new Error('No QR code found in that photo. Try again with the code centered and in focus.');
        await acceptCode(value);
      } catch (err) {
        if (errorEl()) errorEl().textContent = err.message;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };

    document.getElementById('pair-scan-btn').onclick = async () => {
      const area = document.getElementById('pair-scan-area');
      const video = document.getElementById('pair-scan-video');
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        if (errorEl()) {
          errorEl().textContent = window.isSecureContext
            ? 'This browser cannot access a live camera. Use “Take a photo of the QR” instead.'
            : 'The live camera needs HTTPS (or localhost). Use “Take a photo of the QR” instead, or paste the link.';
        }
        return;
      }
      if (typeof window.jsQR !== 'function' && !('BarcodeDetector' in window)) {
        if (errorEl()) errorEl().textContent = 'This browser cannot decode QR codes. Use “Take a photo of the QR” or paste the link.';
        return;
      }
      try {
        if (errorEl()) errorEl().textContent = '';
        scanStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        area.style.display = '';
        video.srcObject = scanStream;
        video.muted = true;
        video.setAttribute('playsinline', '');
        await video.play();

        let detector = null;
        if ('BarcodeDetector' in window) {
          try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
        }

        const tick = async () => {
          if (!scanStream) return;
          let value = null;
          try {
            if (detector) {
              const codes = await detector.detect(video);
              if (codes && codes.length) value = codes[0].rawValue;
            }
            if (!value && video.readyState >= 2) {
              value = decodeQrImage(video, video.videoWidth, video.videoHeight, 900);
            }
          } catch {
            // Transient detector errors are normal while the frame settles.
          }
          if (value) { await acceptCode(value); return; }
          scanFrame = requestAnimationFrame(tick);
        };
        scanFrame = requestAnimationFrame(tick);
      } catch (err) {
        stopScan();
        const name = err && err.name;
        const message = name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow it in the browser settings, or use “Take a photo of the QR”.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device. Use “Take a photo of the QR” or paste the link.'
            : `Camera unavailable: ${err.message}`;
        if (errorEl()) errorEl().textContent = message;
      }
    };

    // A #pair=... fragment means the user opened a pairing link.
    if (initialCode) {
      document.getElementById('pair-code').focus();
    }
  }

  // Decode the #pair=... payload without a round-trip to the server.
  function decodePairPayload(code) {
    const raw = String(code || '').trim();
    const marker = raw.indexOf('#pair=');
    const encoded = marker !== -1 ? raw.slice(marker + 6) : raw;
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    try {
      return JSON.parse(atob(padded));
    } catch {
      return null;
    }
  }

  // Handle a pairing link opened directly (e.g. scanned with the phone camera).
  function maybeOpenPairingLink() {
    const hash = location.hash || '';
    if (!hash.startsWith('#pair=')) return false;
    const code = hash.slice(1);
    // Keep the hash until we are authenticated, so logging in does not lose a
    // scanned pairing link. startApp calls this again after login.
    if (!state.user) return false;

    // The same QR doubles as a plain "open the panel" code: any camera opens
    // the inviting host, whose own invitation must not be redeemed locally.
    // Only a payload from a different instance is a pairing action.
    const payload = decodePairPayload(code);
    const ownId = state.hostIdentity && state.hostIdentity.instanceId;
    const isPairing = Boolean(payload && ownId && payload.instanceId !== ownId);
    history.replaceState(null, '', location.pathname + location.search);
    if (!isPairing) return false;
    showPairModal(code);
    return true;
  }

  window.CitadelPairing = { init, showPairModal, maybeOpenPairingLink };
})();
