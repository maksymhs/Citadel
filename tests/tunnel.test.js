const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-tunnel-'));
process.env.DATA_DIR = TMP;
process.env.PROJECTS_DIR = path.join(TMP, 'projects');
process.env.LOGS_DIR = path.join(TMP, 'logs');
process.env.PLUGINS_DIR = path.join(TMP, 'plugins');
delete process.env.CITADEL_PUBLIC_URL;

const assert = require('node:assert');
const { test } = require('node:test');

const tunnelService = require('../server/services/tunnelService');
const connectService = require('../server/services/connectService');
const { isAllowedOrigin } = require('../server/security/guard');

test('normalizeTunnelUrl only accepts https trycloudflare URLs', () => {
  assert.equal(
    tunnelService.normalizeTunnelUrl('https://abc-def.trycloudflare.com'),
    'https://abc-def.trycloudflare.com'
  );
  assert.equal(tunnelService.normalizeTunnelUrl('https://abc.trycloudflare.com/'), 'https://abc.trycloudflare.com');
  assert.equal(tunnelService.normalizeTunnelUrl('https://evil.example.com'), null);
  assert.equal(tunnelService.normalizeTunnelUrl('http://abc.trycloudflare.com'), null);
  assert.equal(tunnelService.normalizeTunnelUrl(''), null);
});

test('connect info follows the recorded tunnel URL', () => {
  fs.writeFileSync(tunnelService.TUNNEL_URL_FILE, 'https://xyz.trycloudflare.com\n');
  connectService._reset();
  const info = connectService.getConnectInfo();
  assert.equal(info.url, 'https://xyz.trycloudflare.com');
  assert.equal(info.source, 'tunnel');
  assert.match(info.qrSvg, /<svg/);
});

test('the current tunnel origin is accepted for the terminal WebSocket', () => {
  fs.writeFileSync(tunnelService.TUNNEL_URL_FILE, 'https://xyz.trycloudflare.com\n');
  assert.equal(isAllowedOrigin('https://xyz.trycloudflare.com'), true);
  assert.equal(isAllowedOrigin('https://attacker.example.com'), false);
});

test('falls back to localhost when nothing else is configured', () => {
  fs.rmSync(tunnelService.TUNNEL_URL_FILE, { force: true });
  connectService._reset();
  const info = connectService.getConnectInfo();
  assert.equal(info.source, 'localhost');
});
