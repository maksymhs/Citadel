const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const PRINT_QR = path.join(ROOT, 'scripts', 'print-qr.js');

test('print-qr renders a scannable grid', () => {
  const out = execFileSync(process.execPath, [PRINT_QR, 'https://example.com'], {
    encoding: 'utf8',
    env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: '', LC_CTYPE: '' },
  });
  assert.match(out, /\x1b\[30;47m/);
  assert.match(out, /[█▀▄]/);
  assert.ok(out.split('\n').length > 10);
});

test('print-qr draws ASCII-only cells on the Linux console', () => {
  const out = execFileSync(process.execPath, [PRINT_QR, 'https://example.com'], {
    encoding: 'utf8',
    env: { ...process.env, TERM: 'linux', LANG: 'en_US.UTF-8' },
  });
  assert.doesNotMatch(out, /[█▀▄]/);
  assert.match(out, /\x1b\[40m {2}/);
  assert.match(out, /\x1b\[47m {2}/);
  assert.ok(/^[\x00-\x7f]*$/.test(out), 'output must be pure ASCII');
});

test('print-qr uses ASCII cells when the locale is not UTF-8', () => {
  const out = execFileSync(process.execPath, [PRINT_QR, 'https://example.com'], {
    encoding: 'utf8',
    env: { ...process.env, TERM: 'xterm', LANG: 'C', LC_ALL: '', LC_CTYPE: '' },
  });
  assert.doesNotMatch(out, /[█▀▄]/);
});

test('print-qr falls back to the shorter text when the full code does not fit', () => {
  const long = `https://example.trycloudflare.com/#pair=v1.${'a'.repeat(32)}.${'b'.repeat(48)}`;
  const out = execFileSync(process.execPath, [PRINT_QR, long, 'https://example.com'], {
    encoding: 'utf8',
    env: { ...process.env, CITADEL_QR_MODE: 'ascii', COLUMNS: '80', LINES: '40' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rows = out.split('\n').filter((line) => line.includes('\x1b[4'));
  assert.ok(rows.length > 0 && rows.length < 40, `expected the short code, got ${rows.length} rows`);
});

test('print-qr refuses to wrap a QR on a narrow terminal', () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'print-qr.js'), 'https://example.com'], {
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: '20' },
  }));
});

test('citadel help lists the available commands', () => {
  const out = execFileSync('bash', [path.join(ROOT, 'scripts', 'citadel'), 'help'], { encoding: 'utf8' });
  assert.match(out, /citadel status/);
  assert.match(out, /citadel qr/);
  assert.match(out, /citadel update/);
});

test('citadel help lists 24/7 power controls', () => {
  const out = execFileSync('bash', [path.join(ROOT, 'scripts', 'citadel'), 'help'], { encoding: 'utf8' });
  assert.match(out, /citadel power status/);
  assert.match(out, /citadel power on/);
  assert.match(out, /citadel power off/);
});

test('power helper documents how to enable and restore', () => {
  const out = execFileSync('bash', [path.join(ROOT, 'scripts', 'power.sh'), 'help'], { encoding: 'utf8' });
  assert.match(out, /citadel power on/);
  assert.match(out, /citadel power off/);
  assert.match(out, /suspend\/hibernate/);
});
