#!/usr/bin/env node
/** Verify that a published tunnel actually serves this Citadel before printing its QR. */
async function waitPublicPanel(publicUrl, localUrl = 'http://127.0.0.1:3000', options = {}) {
  const fetchImpl = options.fetchImpl || fetch, clock = options.clock || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = clock() + (options.timeoutMs || 60000);
  const remote = new URL(publicUrl), local = new URL(localUrl);
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.pathname !== '/' || remote.search || remote.hash) throw new Error('Expected a plain HTTPS tunnel URL.');
  let reason = 'No response yet';
  async function read(url, json) {
    const response = await fetchImpl(url, { redirect: 'error', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - clock()))) });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('Unexpected response size');
    return { instance: response.headers.get('x-citadel-instance'), data: json ? JSON.parse(text) : text };
  }
  while (clock() < deadline) {
    try {
      const [origin, api, page] = await Promise.all([
        read(new URL('/api/auth/status', local), true), read(new URL('/api/auth/status', remote), true), read(new URL('/', remote), false),
      ]);
      if (!origin.instance || origin.instance !== api.instance) throw new Error('Public URL does not identify this Citadel');
      if (typeof api.data.setupComplete !== 'boolean' || !page.data.includes('id="app-root"') || !/<title>Citadel\b/.test(page.data)) throw new Error('Public URL is not serving the Citadel panel');
      return { ready: true, reason: null };
    } catch (err) { reason = /HTTP \d+/.test(err.message) ? err.message : 'Panel response unavailable or does not match this Citadel'; }
    const remaining = deadline - clock();
    if (remaining > 0) await sleep(Math.min(1500, remaining));
  }
  return { ready: false, reason };
}
if (require.main === module) {
  console.log('Verifying the public Citadel URL (up to 60 seconds)…');
  waitPublicPanel(process.argv[2], process.argv[3]).then(result => {
    if (!result.ready) { console.error(`Public tunnel is not ready (${result.reason}). No working public QR can be advertised yet. Check: sudo journalctl -u citadel-tunnel -n 50 --no-pager`); process.exitCode = 1; }
  }).catch(() => { console.error('Public panel verification failed.'); process.exitCode = 1; });
}
module.exports = { waitPublicPanel };
