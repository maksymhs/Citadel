/** Domain activation helpers must keep HTTP responsive and recover every failure path. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { runTunnelProcess, activateWithRecovery } = require('../server/services/tunnelProcess');

test('tunnel helper can request the parent HTTP server without blocking it', async () => {
  let requested = false;
  const server = createServer((req, res) => { requested = true; res.end('ready'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/auth/status`;
    const code = `fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))`;
    const result = await runTunnelProcess(process.execPath, ['-e', code, url], { timeoutMs: 5000 });
    assert.equal(result.status, 0); assert.equal(result.stdout, 'ready'); assert.equal(requested, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('helper-start failure restores quick access, not just a later reachability failure', async () => {
  let recovered = false;
  await assert.rejects(activateWithRecovery(async () => { throw new Error('helper failed'); }, async () => { recovered = true; }), /new temporary tunnel was restored/);
  assert.equal(recovered, true);
});
test('a recovery failure is reported honestly with SSH recovery instructions', async () => {
  await assert.rejects(activateWithRecovery(async () => { throw new Error('named failed'); }, async () => { throw new Error('quick failed'); }), /recovery also failed/);
});
test('successful named activation never invokes recovery', async () => {
  const result = await activateWithRecovery(async () => 'ready', async () => { assert.fail('unexpected recovery'); });
  assert.equal(result, 'ready');
});
test('named runner uses a dedicated ingress config for its chosen domain', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-named-ingress-'));
  fs.writeFileSync(path.join(dir, 'tunnel-domain'), 'vps.example.test\n');
  fs.writeFileSync(path.join(dir, 'tunnel-token'), 'fixture-not-a-real-token\n');
  const fake = path.join(dir, 'cloudflared');
  fs.writeFileSync(fake, `#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --config ]; then cp "$2" '${dir}/selected-config'; break; fi; shift; done\n`, { mode: 0o755 });
  try {
    const result = spawnSync('bash', [path.join(__dirname, '../scripts/tunnel-run.sh'), 'http://127.0.0.1:3000'], {
      encoding: 'utf8', env: { ...process.env, CITADEL_DATA_DIR: dir, CLOUDFLARED_PATH: fake },
    });
    assert.equal(result.status, 0, result.stderr);
    const config = fs.readFileSync(path.join(dir, 'selected-config'), 'utf8');
    assert.match(config, /hostname: "vps.example.test"/); assert.match(config, /service: "http:\/\/127.0.0.1:3000"/);
    assert.match(config, /http_status:404/); assert.doesNotMatch(config, /fixture-not-a-real-token/);
    assert.ok(!fs.readdirSync(dir).some(n => n.startsWith('named-config.')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
