process.env.CITADEL_PUBLIC_URL = 'https://panel.example.com/';

const assert = require('node:assert');
const { test } = require('node:test');

const connectService = require('../server/services/connectService');

test('normalizeUrl adds a scheme and trims trailing slashes', () => {
  assert.equal(connectService.normalizeUrl('vps.example.com/'), 'http://vps.example.com');
  assert.equal(connectService.normalizeUrl('https://vps.example.com'), 'https://vps.example.com');
  assert.equal(connectService.normalizeUrl(''), null);
  assert.equal(connectService.normalizeUrl(null), null);
});

test('uses the configured public URL and renders a QR SVG', () => {
  const info = connectService.getConnectInfo();
  assert.equal(info.url, 'https://panel.example.com');
  assert.equal(info.source, 'configured');
  assert.match(info.qrSvg, /<svg/);
});

test('terminal QR helpers report the printed width and detect overflow', () => {
  const short = 'https://example.com';
  const long = `https://example.com/#pair=${'x'.repeat(2000)}`;
  assert.ok(connectService.qrFits(short, 80));
  assert.equal(connectService.qrFits(long, 80), false);
  assert.ok(connectService.qrColumns(short) < connectService.qrColumns(long));
});
