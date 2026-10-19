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

const QUIET = 2;
const mode = detectMode(process.env);
const columns = Number(process.stdout.columns || process.env.COLUMNS);
const rows = Number(process.stdout.rows || process.env.LINES);

function build(data) {
  const qr = qrcode(0, 'L');
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + QUIET * 2;
  return {
    size,
    width: mode === 'ascii' ? size * 2 : size,
    height: mode === 'ascii' ? size : Math.ceil(size / 2),
    isDark: (row, col) => row >= QUIET && row < QUIET + count
      && col >= QUIET && col < QUIET + count
      && qr.isDark(row - QUIET, col - QUIET),
  };
}

// Leave one spare column: terminals with auto-wrap enabled wrap when the last
// cell is written, which shifts every following QR row. Height only matters for
// the console (no scrollback), where the top of a taller code scrolls away:
// keep room for the leading blank line, one line of text and the prompt.
const RESERVED_ROWS = 3;
function fits(code) {
  if (Number.isFinite(columns) && columns > 0 && code.width >= columns) return false;
  if (mode === 'ascii' && Number.isFinite(rows) && rows > 0 && code.height + RESERVED_ROWS > rows) return false;
  return true;
}

function renderUnicode(code) {
  // Force black-on-white so the code keeps its polarity on dark terminals.
  let out = '\n\x1b[30;47m';
  for (let row = 0; row < code.size; row += 2) {
    for (let col = 0; col < code.size; col++) {
      const top = code.isDark(row, col);
      const bottom = code.isDark(row + 1, col);
      if (top && bottom) out += '█';
      else if (top) out += '▀';
      else if (bottom) out += '▄';
      else out += ' ';
    }
    out += '\x1b[0m\n\x1b[30;47m';
  }
  return `${out}\x1b[0m`;
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

let code = build(text);
if (!fits(code) && fallback && fallback !== text) {
  const alt = build(fallback);
  if (fits(alt)) {
    console.error('The full code does not fit this terminal; showing the panel URL instead.');
    code = alt;
  }
}
if (!fits(code)) {
  console.error(`QR needs ${code.width + 1}x${code.height + 1} cells, but this terminal is ${columns || '?'}x${rows || '?'}. Resize it (or connect over SSH) and try again.`);
  process.exit(2);
}
process.stdout.write(mode === 'ascii' ? renderAscii(code) : renderUnicode(code));
