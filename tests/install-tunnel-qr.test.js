/** Installer address selection never substitutes a local QR for a requested tunnel. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
const selection = source.slice(source.indexOf('  # A requested tunnel owns'), source.indexOf('  # Scan-to-start:'));
function select(url, tunnel = true, override = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-tunnel-qr-'));
  if (url !== null) fs.writeFileSync(path.join(dir, 'tunnel-url'), url);
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nSUDO=''\nDATA_DIR="$1"\nTUNNEL="$2"\nCITADEL_PUBLIC_URL="$3"\nLAN_EXPOSED=false\nPANEL_PORT=3000\n${selection}\nprintf '%s|%s' "$PUBLIC_QR_READY" "$ACCESS_URL"`, 'test', dir, String(tunnel), override], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
test('requested tunnel wins over a stale local public URL override', () => {
  assert.equal(select('https://example.trycloudflare.com', true, 'http://192.168.1.1:3000'), 'true|https://example.trycloudflare.com');
});
test('missing tunnel disables QR rather than advertising the local panel', () => {
  assert.equal(select(null), 'false|http://127.0.0.1:3000');
});
test('local address in tunnel metadata cannot become a public QR', () => {
  assert.equal(select('http://192.168.18.31:3000'), 'false|http://127.0.0.1:3000');
  assert.equal(select('https://192.168.18.31'), 'false|http://127.0.0.1:3000');
});
test('a named HTTPS tunnel remains supported', () => {
  assert.equal(select('https://citadel.example.com'), 'true|https://citadel.example.com');
});
test('explicit local install still permits a local QR', () => {
  assert.equal(select(null, false, 'http://192.168.18.31:3000'), 'true|http://192.168.18.31:3000');
});

test('actual CLI --tunnel prints the recorded public URL and refuses local/missing metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-tunnel-cli-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'id'), '#!/bin/bash\necho 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nprintf "render:%s\\n" "$2"\n', { mode: 0o755 });
  const cli = path.join(__dirname, '../scripts/citadel');
  const run = () => spawnSync('bash', [cli, 'qr', '--tunnel'], { encoding: 'utf8', env: {
    ...process.env, PATH: bin + ':' + process.env.PATH, CITADEL_DATA_DIR: root, CITADEL_APP_DIR: root,
    CITADEL_PUBLIC_URL: 'http://127.0.0.1:3000',
  } });
  try {
    fs.writeFileSync(path.join(root, 'tunnel-url'), 'https://live.trycloudflare.com\n');
    let result = run(); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /render:https:\/\/live.trycloudflare.com/); assert.doesNotMatch(result.stdout, /127\.0\.0\.1/);
    fs.writeFileSync(path.join(root, 'tunnel-url'), 'https://192.168.18.31\n');
    result = run(); assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /render:/);
    fs.unlinkSync(path.join(root, 'tunnel-url'));
    result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /No public tunnel URL/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
