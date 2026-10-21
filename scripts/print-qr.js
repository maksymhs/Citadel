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
//
// macOS Terminal.app is the same story for a different reason: its font draws
// block elements slightly short, which leaves thin seams through the code that
// make it unscannable. Coloured spaces fill the whole cell background, so they
// have no glyph to get wrong. That mode needs more rows, so on Terminal.app the
// window is enlarged when needed (see growWindow) and the glyph mode is never
// used as a fallback.
const APPLE_TERMINAL = process.env.TERM_PROGRAM === 'Apple_Terminal';

function detectMode(env) {
  const forced = String(env.CITADEL_QR_MODE || '').toLowerCase();
  if (forced === 'ascii' || forced === 'unicode') return forced;
  if (env.TERM === 'linux' || env.TERM_PROGRAM === 'Apple_Terminal') return 'ascii';
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /utf-?8/i.test(locale) ? 'unicode' : 'ascii';
}

let columns = Number(process.stdout.columns || process.env.COLUMNS);
let rows = Number(process.stdout.rows || process.env.LINES);
// A forced mode, or Terminal.app (glyphs are known bad there), never falls back
// to the half-block glyphs when the cells do not fit.
const isForcedMode = Boolean(process.env.CITADEL_QR_MODE) || APPLE_TERMINAL;
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
function fits(code, reserved = RESERVED_ROWS) {
  if (Number.isFinite(columns) && columns > 0 && code.width >= columns) return false;
  if (Number.isFinite(rows) && rows > 0 && code.height + reserved > rows) return false;
  return true;
}

// Progressively tighter layouts: the quiet zone shrinks to 1 module and, as a
// last resort, only a single row is kept free for the prompt. Scanners cope
// with a 1-module margin, and this keeps the full pairing code usable on short
// consoles (80x24/25) instead of dropping to the plain panel URL.
const LAYOUTS = [
  { quiet: 2, reserved: RESERVED_ROWS },
  { quiet: 1, reserved: RESERVED_ROWS },
  { quiet: 1, reserved: 1 },
];

// Every cell is the same "upper half block" glyph; the module above is its
// foreground and the module below its background, both fixed 256-colour values
// (16 = black, 231 = white) that do not depend on the terminal theme. Solid
// areas therefore never show seams, which the mix of █ ▀ ▄ glyphs used to leave
// on terminals whose font draws block elements slightly short (macOS Terminal).
const DARK = 16;
const LIGHT = 231;

function renderUnicode(code) {
  let out = '';
  for (let row = 0; row < code.size; row += 2) {
    let current = '';
    for (let col = 0; col < code.size; col++) {
      const fg = code.isDark(row, col) ? DARK : LIGHT;
      const bg = code.isDark(row + 1, col) ? DARK : LIGHT;
      const sgr = `\x1b[38;5;${fg};48;5;${bg}m`;
      if (sgr !== current) {
        out += sgr;
        current = sgr;
      }
      out += '▀';
    }
    out += '\x1b[0m\n';
  }
  return out;
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

// Terminal.app honours the xterm "resize window" request (CSI 8;rows;cols t).
// Ask for just enough room for the tightest layout plus a few lines for the
// text printed around the code, then re-read the size. Best effort: if the
// request is ignored the normal fallbacks still apply.
const MAX_ROWS = 80;
const MAX_COLUMNS = 200;
const CAN_RESIZE = APPLE_TERMINAL && process.stdout.isTTY && !process.env.CITADEL_QR_NO_RESIZE;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Node refreshes process.stdout.columns/rows from SIGWINCH, which is only
// handled while the event loop runs, so wait asynchronously for the new size.
async function growWindow(data) {
  if (!CAN_RESIZE) return;
  const tight = build(data, preferredMode, 1);
  const wantRows = Math.min(MAX_ROWS, Math.max(rows || 0, tight.height + 4));
  const wantColumns = Math.min(MAX_COLUMNS, Math.max(columns || 0, tight.width + 2));
  process.stdout.write(`\x1b[8;${wantRows};${wantColumns}t`);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(100);
    if (process.stdout.rows >= wantRows && process.stdout.columns >= wantColumns) break;
  }
  columns = Number(process.stdout.columns);
  rows = Number(process.stdout.rows);
}

function findBestFit(data) {
  for (const { quiet, reserved } of LAYOUTS) {
    const candidate = build(data, preferredMode, quiet);
    if (fits(candidate, reserved)) return candidate;
  }
  // If ASCII was preferred but did not fit (common on 80x24 Linux consoles),
  // try unicode before giving up, unless the user explicitly forced ASCII.
  if (preferredMode === 'ascii' && !isForcedMode) {
    for (const { quiet, reserved } of LAYOUTS) {
      const candidate = build(data, 'unicode', quiet);
      if (fits(candidate, reserved)) return candidate;
    }
  }
  return null;
}

(async () => {
  let code = findBestFit(text);
  if (!code && CAN_RESIZE) {
    await growWindow(text);
    code = findBestFit(text);
  }
  if (!code && fallback && fallback !== text) {
    let alt = findBestFit(fallback);
    if (!alt && CAN_RESIZE) {
      await growWindow(fallback);
      alt = findBestFit(fallback);
    }
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
})();
