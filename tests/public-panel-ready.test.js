/** Public reachability requires the real panel, auth endpoint and matching host identity. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { waitPublicPanel } = require('../scripts/wait-public-panel');
const html = '<title>Citadel — Panel</title><div id="app-root"></div>';
function scenario(mode) {
  let time = 0, attempts = 0;
  return { timeoutMs: 3000, clock: () => time, sleep: async ms => { time += ms; attempts++; },
    fetchImpl: async url => {
      const remote = new URL(url).protocol === 'https:';
      const page = new URL(url).pathname === '/';
      let status = 200, body = page ? html : JSON.stringify({ setupComplete: false });
      if (remote && (mode === '404' || mode === 'warming' && !attempts)) status = 404;
      if (remote && page && mode === 'root404') status = 404;
      if (remote && mode === 'other') body = page ? '<title>Other</title>' : '{}';
      return new globalThis.Response(body, { status, headers: { 'x-citadel-instance': remote && mode === 'wrong-host' ? 'foreign' : 'this-host' } });
    } };
}
test('public URL is ready only when root and API serve this panel', async () => {
  assert.equal((await waitPublicPanel('https://t.example.com', undefined, scenario('ready'))).ready, true);
});
test('startup 404 is retried before a public QR can be shown', async () => {
  assert.equal((await waitPublicPanel('https://t.example.com', undefined, scenario('warming'))).ready, true);
});
for (const mode of ['404', 'root404', 'other', 'wrong-host']) test(`does not advertise a public QR for ${mode}`, async () => {
  assert.equal((await waitPublicPanel('https://t.example.com', undefined, scenario(mode))).ready, false);
});
test('verification does not accept a local HTTP URL as public', async () => {
  await assert.rejects(waitPublicPanel('http://127.0.0.1:3000', undefined, scenario('ready')), /HTTPS/);
});

test('quick tunnel runner explicitly isolates ingress configuration without modifying existing files', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-quick-config-'));
  const existing = path.join(dir, 'config.yml');
  fs.writeFileSync(existing, 'ingress:\n  - service: http_status:404\n');
  const fake = path.join(dir, 'cloudflared');
  fs.writeFileSync(fake, `#!/bin/bash\nprintf '%s\\n' "$*" > '${dir}/arguments'\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --config ]; then cp "$2" '${dir}/selected-config'; break; fi; shift; done\necho 'https://isolated.trycloudflare.com'\n`, { mode: 0o755 });
  try {
    const result = spawnSync('bash', [path.join(__dirname, '../scripts/tunnel-run.sh'), 'http://127.0.0.1:3000'], {
      encoding: 'utf8', env: { ...process.env, CITADEL_DATA_DIR: dir, CLOUDFLARED_PATH: fake },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'selected-config'), 'utf8'), '{}\n');
    assert.match(fs.readFileSync(path.join(dir, 'arguments'), 'utf8'), /--config .* --no-autoupdate --url http:\/\/127.0.0.1:3000/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'ingress:\n  - service: http_status:404\n');
    assert.ok(!fs.readdirSync(dir).some(n => n.startsWith('quick-config.')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
