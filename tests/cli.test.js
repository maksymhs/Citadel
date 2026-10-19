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

test('print-qr falls back to short URL when height exceeds 24 terminal rows', () => {
  // A code that would take 27 rows in unicode with quiet=2
  const long = `https://very-long-instance-name-for-cloud-testing.trycloudflare.com/#pair=v1.${'a'.repeat(32)}.${'b'.repeat(48)}`;
  const fallback = 'https://very-long-instance-name-for-cloud-testing.trycloudflare.com';
  const out = execFileSync(process.execPath, [PRINT_QR, long, fallback], {
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: '80', LINES: '24' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  assert.ok(lines.length <= 22, `expected height <= 22 to fit 24 rows, got ${lines.length}`);
});

test('print-qr switches to Unicode on Linux console when ASCII width exceeds 80 columns', () => {
  const long = 'https://example.com/#pair=v1.lgGchkRcTQ62aLZcGZhzGA.8c2p57Hz_w-6BSNO3GfZAR-Ui2N8Gtqy';
  const out = execFileSync(process.execPath, [PRINT_QR, long], {
    encoding: 'utf8',
    env: { ...process.env, TERM: 'linux', COLUMNS: '80', LINES: '35' },
  });
  // Since ASCII would need 86+ columns and terminal has 80, it switches to unicode rather than failing
  assert.match(out, /[█▀▄]/);
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
