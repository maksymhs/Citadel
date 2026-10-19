#!/usr/bin/env node
// Renders a QR code as ANSI black/white cells on the terminal. Used by the
// `citadel qr` command so the panel URL can be scanned straight from a console.
const qrcode = require('qrcode-generator');

const text = process.argv[2];
if (!text) {
  console.error('usage: print-qr.js <text>');
  process.exit(1);
}

const qr = qrcode(0, 'L');
qr.addData(text);
qr.make();

const count = qr.getModuleCount();
const quiet = 2;
const size = count + quiet * 2;
const isDark = (row, col) => row >= quiet && row < quiet + count
  && col >= quiet && col < quiet + count
  && qr.isDark(row - quiet, col - quiet);

// Force black-on-white so the code keeps its polarity on dark terminals.
let out = '\n\x1b[30;47m';
for (let row = 0; row < size; row += 2) {
  for (let col = 0; col < size; col++) {
    const top = isDark(row, col);
    const bottom = isDark(row + 1, col);
    if (top && bottom) out += '█';
    else if (top) out += '▀';
    else if (bottom) out += '▄';
    else out += ' ';
  }
  out += '\x1b[0m\n\x1b[30;47m';
}
process.stdout.write(`${out}\x1b[0m`);
