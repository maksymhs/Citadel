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
  assert.match(out, /\x1b\[38;5;(16|231);48;5;(16|231)m▀/);
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

test('print-qr unicode output decodes back to the original text', () => {
  const jsQR = require('jsqr');
  const text = 'https://evolution-gifts-significant-cas.trycloudflare.com/#pair=v1.lgGchkRcTQ62aLZcGZhzGA.8c2p57Hz_w-6BSNO3GfZAR-Ui2N8Gtqy';
  const out = execFileSync(process.execPath, [PRINT_QR, text], {
    encoding: 'utf8',
    env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: '', LC_CTYPE: '', COLUMNS: '100', LINES: '40' },
  });
  // Rebuild the module grid from the escape sequences: each ▀ is two modules.
  const rows = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const top = [];
    const bottom = [];
    let fg = 231;
    let bg = 231;
    const re = /\x1b\[38;5;(\d+);48;5;(\d+)m|▀/g;
    let m;
    while ((m = re.exec(line))) {
      if (m[1]) { fg = Number(m[1]); bg = Number(m[2]); } else { top.push(fg === 16); bottom.push(bg === 16); }
    }
    rows.push(top, bottom);
  }
  const scale = 4;
  const size = rows[0].length;
  const width = size * scale;
  const height = rows.length * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = rows[Math.floor(y / scale)][Math.floor(x / scale)];
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = dark ? 0 : 255;
      data[o + 3] = 255;
    }
  }
  const decoded = jsQR(data, width, height);
  assert.ok(decoded, 'the rendered grid is a valid QR code');
  assert.equal(decoded.data, text);
});

test('qr-page writes a self-contained page with the QR and the escaped address', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-qr-')), 'qr.html');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'qr-page.js'), 'https://example.com/#pair=v1.a.b', out, 'https://example.com/<x>']);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<svg[^>]*shape-rendering="crispEdges"/);
  assert.ok(html.includes('https://example.com/&lt;x&gt;'), 'the address is HTML-escaped');
  assert.ok(!html.includes('<x>'));
  assert.equal(fs.statSync(out).mode & 0o077, 0, 'the page holds a one-time secret and is private');
});

test('reset-password replaces the password, revokes sessions and is audited', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-reset-'));
  const dbPath = path.join(dir, 'citadel.db');
  const env = { ...process.env, DATA_DIR: dir, DATABASE_PATH: dbPath };
  const script = path.join(ROOT, 'scripts', 'reset-password.js');
  try {
    const seed = `
      const { initDatabase, closeDatabase } = require('./server/database/db');
      const auth = require('./server/security/auth');
      initDatabase();
      auth.createInitialAdmin('Admin', 'old-password-1');
      auth.login('admin', 'old-password-1');
      closeDatabase();
    `;
    execFileSync(process.execPath, ['-e', seed], { cwd: ROOT, env });

    const out = execFileSync(process.execPath, [script], { env, input: 'new-password-2\n', encoding: 'utf8' });
    assert.match(out, /Password updated for "admin"/);

    const check = `
      const { initDatabase, getDatabase } = require('./server/database/db');
      const auth = require('./server/security/auth');
      initDatabase();
      const ok = auth.login('admin', 'new-password-2') !== null;
      const old = auth.login('admin', 'old-password-1') === null;
      const sessions = getDatabase().prepare('SELECT COUNT(*) c FROM sessions').get().c;
      const audit = getDatabase().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='password_reset_cli'").get().c;
      console.log(JSON.stringify({ ok, old, sessions, audit }));
    `;
    const res = JSON.parse(execFileSync(process.execPath, ['-e', check], { cwd: ROOT, env, encoding: 'utf8' }));
    assert.deepEqual(res, { ok: true, old: true, sessions: 1, audit: 1 });

    assert.throws(
      () => execFileSync(process.execPath, [script, 'ghost'], { env, input: 'new-password-3\n', stdio: 'pipe' }),
      /No such user|status 1/,
    );
    assert.throws(
      () => execFileSync(process.execPath, [script], { env, input: 'short\n', stdio: 'pipe' }),
      /status 1|at least 8/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
