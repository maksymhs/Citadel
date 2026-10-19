#!/usr/bin/env node
// Renders a QR code as ANSI black/white cells on the terminal. Used by the
// `citadel qr` command so the panel URL can be scanned straight from a console.
//
//   print-qr.js <text> [fallback-text]
//
// The fallback (for example the plain panel URL) is rendered instead when the
// primary text produces a code that does not fit the terminal.
const qrcode = require('qrcode-generator');

const [text, fallback] = process.argv.slice(2);
if (!text) {
  console.error('usage: print-qr.js <text> [fallback-text]');
  process.exit(1);
}

// The Linux virtual console (TERM=linux, e.g. the Ubuntu Server login screen)
// ships fonts without the half-block glyphs and shows them as diamonds, and a
// non-UTF-8 locale garbles them anywhere. In those cases draw each module with
// two coloured spaces instead: plain ASCII, so every terminal can render it.
function detectMode(env) {
  const forced = String(env.CITADEL_QR_MODE || '').toLowerCase();
  if (forced === 'ascii' || forced === 'unicode') return forced;
  if (env.TERM === 'linux') return 'ascii';
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /utf-?8/i.test(locale) ? 'unicode' : 'ascii';
}

const columns = Number(process.stdout.columns || process.env.COLUMNS);
const rows = Number(process.stdout.rows || process.env.LINES);
const isForcedMode = Boolean(process.env.CITADEL_QR_MODE);
const preferredMode = detectMode(process.env);

function build(data, targetMode, quiet = 2) {
  const qr = qrcode(0, 'L');
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + quiet * 2;
  return {
    data,
    mode: targetMode,
    quiet,
    size,
    width: targetMode === 'ascii' ? size * 2 : size,
    height: targetMode === 'ascii' ? size : Math.ceil(size / 2),
    isDark: (row, col) => row >= quiet && row < quiet + count
      && col >= quiet && col < quiet + count
      && qr.isDark(row - quiet, col - quiet),
  };
}

// Leave room for the prompt, header text, and margins so the QR code does
// not scroll off the top of the screen on terminals with limited rows (e.g. 24).
const RESERVED_ROWS = 2;
function fits(code) {
  if (Number.isFinite(columns) && columns > 0 && code.width >= columns) return false;
  if (Number.isFinite(rows) && rows > 0 && code.height + RESERVED_ROWS > rows) return false;
  return true;
}

function renderUnicode(code) {
  // Force black-on-white so the code keeps its polarity on dark terminals.
  let out = '\x1b[30;47m';
  for (let row = 0; row < code.size; row += 2) {
    for (let col = 0; col < code.size; col++) {
      const top = code.isDark(row, col);
      const bottom = code.isDark(row + 1, col);
      if (top && bottom) out += '█';
      else if (top) out += '▀';
      else if (bottom) out += '▄';
      else out += ' ';
    }
    if (row + 2 < code.size) {
      out += '\x1b[0m\n\x1b[30;47m';
    }
  }
  return `${out}\x1b[0m\n`;
}

function renderAscii(code) {
  let out = '\n';
  for (let row = 0; row < code.size; row++) {
    let current = null;
    for (let col = 0; col < code.size; col++) {
      const dark = code.isDark(row, col);
      if (dark !== current) {
        out += dark ? '\x1b[40m' : '\x1b[47m';
        current = dark;
      }
      out += '  ';
    }
    out += '\x1b[0m\n';
  }
  return out;
}

function findBestFit(data) {
  // Try preferred mode with quiet=2, then quiet=1.
  for (const quiet of [2, 1]) {
    const candidate = build(data, preferredMode, quiet);
    if (fits(candidate)) return candidate;
  }
  // If ASCII was preferred but did not fit (common on 80x24 Linux consoles),
  // try unicode before giving up, unless the user explicitly forced ASCII.
  if (preferredMode === 'ascii' && !isForcedMode) {
    for (const quiet of [2, 1]) {
      const candidate = build(data, 'unicode', quiet);
      if (fits(candidate)) return candidate;
    }
  }
  return null;
}

let code = findBestFit(text);
if (!code && fallback && fallback !== text) {
  const alt = findBestFit(fallback);
  if (alt) {
    console.error('The full code does not fit this terminal; showing the panel URL instead.');
    code = alt;
  }
}

if (!code) {
  // Build default representation for error reporting
  code = build(text, preferredMode, 2);
  console.error(`QR needs ${code.width + 1}x${code.height + 1} cells, but this terminal is ${columns || '?'}x${rows || '?'}. Resize it (or connect over SSH) and try again.`);
  process.exit(2);
}

process.stdout.write(code.mode === 'ascii' ? renderAscii(code) : renderUnicode(code));
