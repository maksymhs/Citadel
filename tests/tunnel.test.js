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

test('normalizeTunnelUrl only accepts plain https hostnames', () => {
  assert.equal(
    tunnelService.normalizeTunnelUrl('https://abc-def.trycloudflare.com'),
    'https://abc-def.trycloudflare.com'
  );
  assert.equal(tunnelService.normalizeTunnelUrl('https://abc.trycloudflare.com/'), 'https://abc.trycloudflare.com');
  assert.equal(tunnelService.normalizeTunnelUrl('https://citadel.maksym.site'), 'https://citadel.maksym.site');
  assert.equal(tunnelService.normalizeTunnelUrl('https://evil.com/path'), null);
  assert.equal(tunnelService.normalizeTunnelUrl('https://user@evil.com'), null);
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

test('cloudflare tunnel setup only accepts plain hostnames and reports status', () => {
  const cf = require('../server/services/cloudflareTunnelService');
  assert.equal(cf.normalizeDomain('https://Citadel.Maksym.site/'), 'citadel.maksym.site');
  assert.equal(cf.normalizeDomain('citadel'), null);
  assert.equal(cf.normalizeDomain('a.com; rm -rf /'), null);
  assert.equal(cf.normalizeDomain('evil.com/path'), null);
  const status = cf.getStatus();
  assert.equal(status.helperInstalled, false);
  assert.throws(() => cf.start('citadel.maksym.site'), /citadel tunnel setup|Linux/);
});
