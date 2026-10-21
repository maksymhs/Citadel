const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A fake `tailscale` CLI whose behaviour is driven by files in TS_DIR, so every
// state the wizard has to handle can be reproduced without a real tailnet.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-ts-'));
const bin = path.join(base, 'bin');
const dir = path.join(base, 'state');

const FAKE = `#!/usr/bin/env bash
d="$TS_DIR"
write_serve() { printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"box.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$1" > "$d/serve.json"; }
case "$1" in
  status) cat "$d/status.json"; exit 0 ;;
  serve)
    shift
    if [ "$1" = "status" ]; then
      [ "$2" = "--json" ] && [ -f "$d/old" ] && { echo "flag provided but not defined: -json" >&2; exit 2; }
      if [ -f "$d/serve.json" ]; then cat "$d/serve.json"; else echo '{}'; fi
      exit 0
    fi
    [ -f "$d/deny" ] && { echo "Access denied: serve config denied. Use 'sudo tailscale set --operator=\\$USER'" >&2; exit 1; }
    [ -f "$d/noserve" ] && { printf 'Serve is not enabled on your tailnet.\\nTo enable, visit:\\n\\n\\t https://login.tailscale.com/f/serve?node=abc\\n' >&2; exit 1; }
    if [ "$1" = "--bg" ]; then
      [ -f "$d/old" ] && { echo "flag provided but not defined: -bg" >&2; exit 2; }
      write_serve "$3"; exit 0
    fi
    if [ "$1" = "--https=443" ] && [ "$2" = "off" ]; then
      [ -f "$d/old" ] && { echo "unknown flag: --https" >&2; exit 2; }
      rm -f "$d/serve.json"; exit 0
    fi
    if [ "$1" = "https" ]; then
      if [ "$3" = "off" ]; then rm -f "$d/serve.json"; else write_serve "$3"; fi
      exit 0
    fi
    echo "usage: tailscale serve" >&2; exit 2 ;;
esac
exit 1
`;

const running = {
  BackendState: 'Running',
  Self: { DNSName: 'box.tailnet.ts.net.', HostName: 'box', TailscaleIPs: ['100.64.0.1'] },
  CurrentTailnet: { Name: 'me@example.com' },
  Peer: { a: {}, b: {} },
};

const setStatus = (obj) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(obj));
const flag = (name, on = true) => {
  const f = path.join(dir, name);
  if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true });
};

const saved = {};
let ts;
let connect;

before(() => {
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tailscale'), FAKE, { mode: 0o755 });
  for (const key of ['PATH', 'TS_DIR']) saved[key] = process.env[key];
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.TS_DIR = dir;
  ts = require('../server/services/tailscaleService');
  connect = require('../server/services/connectService');
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  setStatus(running);
  connect._reset();
});

describe('Tailscale status', () => {
  test('reports a missing CLI with install instructions', async () => {
    const original = process.env.PATH;
    process.env.PATH = path.join(base, 'empty');
    try {
      const status = await ts.getStatus();
      assert.equal(status.installed, false);
      assert.ok(status.install.platform);
    } finally {
      process.env.PATH = original;
    }
  });

  test('NeedsLogin exposes the sign-in link', async () => {
    setStatus({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc123' });
    const status = await ts.getStatus();
    assert.equal(status.backendState, 'NeedsLogin');
    assert.equal(status.loginUrl, 'https://login.tailscale.com/a/abc123');
    assert.equal(status.serving, false);
  });

  test('a running node that does not serve the panel has no private address yet', async () => {
    const status = await ts.getStatus();
    assert.equal(status.backendState, 'Running');
    assert.equal(status.dnsName, 'box.tailnet.ts.net');
    assert.equal(status.peers, 2);
    assert.equal(status.serving, false);
    assert.equal(status.url, null);
  });
});

describe('Tailscale serve', () => {
  test('enabling publishes the panel and the address is then advertised', async () => {
    assert.ok(!connect.getCandidateUrls().includes('https://box.tailnet.ts.net'), 'not advertised while nothing serves it');
    const result = await ts.enableServe();
    assert.equal(result.ok, true);
    const status = await ts.getStatus();
    assert.equal(status.serving, true);
    assert.equal(status.url, 'https://box.tailnet.ts.net');
    connect._reset();
    assert.ok(connect.getCandidateUrls().includes('https://box.tailnet.ts.net'));
  });

  test('falls back to the pre-1.52 syntax', async () => {
    flag('old');
    assert.equal((await ts.enableServe()).ok, true);
    assert.equal((await ts.getStatus()).serving, true, 'plain-text status is understood too');
    assert.equal((await ts.disableServe()).ok, true);
    assert.equal((await ts.getStatus()).serving, false);
  });

  test('disabling removes the address', async () => {
    await ts.enableServe();
    assert.equal((await ts.disableServe()).ok, true);
    const status = await ts.getStatus();
    assert.equal(status.serving, false);
    assert.equal(status.url, null);
  });

  test('a permission error asks for the one-time operator command', async () => {
    flag('deny');
    const result = await ts.enableServe();
    assert.equal(result.ok, false);
    assert.equal(result.needsOperator, true);
    assert.match(result.command, /^sudo tailscale set --operator=\S+$/);
  });

  test('"serve is not enabled on your tailnet" returns the link to turn it on', async () => {
    flag('noserve');
    const result = await ts.enableServe();
    assert.equal(result.ok, false);
    assert.equal(result.actionUrl, 'https://login.tailscale.com/f/serve?node=abc');
  });

  test('only a handler for this panel counts as serving it', () => {
    assert.equal(ts.servesPort('{"Web":{"x":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9999"}}}}}', 3000), false);
    assert.equal(ts.servesPort('https://box.ts.net\n|-- / proxy http://localhost:3000', 3000), true);
    assert.equal(ts.hasServeConfig('{}'), false);
    assert.equal(ts.hasServeConfig('No serve config'), false);
  });
});

describe('Tailscale routes', () => {
  const { buildServer } = require('../server/index');
  const { closeDatabase } = require('../server/database/db');
  let app;
  let cookie;
  const testDb = path.resolve(__dirname, '../data/test-tailscale.db');

  before(async () => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(testDb + suffix, { force: true });
    app = await buildServer({ customDbPath: testDb, logger: false });
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'tsadmin', password: 'SuperPassword123!' } });
    cookie = res.cookies.find((c) => c.name === 'session_id').value;
  });

  after(async () => {
    await app.close();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(testDb + suffix, { force: true });
  });

  test('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/network/tailscale' });
    assert.equal(res.statusCode, 401);
  });

  test('status, enable and disable round-trip', async () => {
    const opts = { cookies: { session_id: cookie } };
    let res = await app.inject({ method: 'GET', url: '/api/network/tailscale', ...opts });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).tailscale.serving, false);

    res = await app.inject({ method: 'POST', url: '/api/network/tailscale/serve', ...opts });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).tailscale.url, 'https://box.tailnet.ts.net');

    res = await app.inject({ method: 'DELETE', url: '/api/network/tailscale/serve', ...opts });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).tailscale.serving, false);
  });

  test('a failure is a 409 with the hint the wizard shows', async () => {
    flag('deny');
    const res = await app.inject({ method: 'POST', url: '/api/network/tailscale/serve', cookies: { session_id: cookie } });
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.payload).needsOperator, true);
  });
});
