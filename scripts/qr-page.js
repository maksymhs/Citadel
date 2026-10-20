#!/usr/bin/env node
// Writes a self-contained HTML page with a large QR code (proper quiet zone,
// crisp square modules). Terminal QR codes depend on the font and line spacing
// of the terminal; this page scans reliably from any phone camera.
//
//   qr-page.js <text> <output.html> [address-to-show]
const fs = require('node:fs');
const qrcode = require('qrcode-generator');

const [text, output, address] = process.argv.slice(2);
if (!text || !output) {
  console.error('usage: qr-page.js <text> <output.html> [address]');
  process.exit(1);
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const qr = qrcode(0, 'M');
qr.addData(text);
qr.make();
const svg = qr.createSvgTag({ cellSize: 10, margin: 4 })
  .replace('<svg ', '<svg shape-rendering="crispEdges" style="width:100%;height:auto;display:block" ');

const page = `<!doctype html>
<meta charset="utf-8">
<title>Citadel — scan to connect</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f5;color:#18181b;font:15px/1.5 -apple-system,system-ui,sans-serif}
  main{max-width:min(92vw,520px);text-align:center;padding:24px}
  .qr{background:#fff;padding:12px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.12)}
  code{display:block;margin-top:14px;word-break:break-all;color:#52525b;font-size:13px}
  p{margin:14px 0 0}
</style>
<main>
  <h1 style="font-size:20px;margin:0 0 14px">Scan with your phone</h1>
  <div class="qr">${svg}</div>
  <p>Opens Citadel, or pairs this machine from another Citadel's <b>Pair a machine</b> screen. The code works once and expires in 10 minutes.</p>
  ${address ? `<code>${escapeHtml(address)}</code>` : ''}
</main>
`;
fs.writeFileSync(output, page, { mode: 0o600 });
