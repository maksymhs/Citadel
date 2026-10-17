#!/usr/bin/env node
// Renders a QR code as ANSI black/white cells on the terminal. Used by the
// `citadel qr` command so the panel URL can be scanned straight from a console.
const qrcode = require('qrcode-generator');

const text = process.argv[2];
if (!text) {
  console.error('usage: print-qr.js <text>');
  process.exit(1);
}

const qr = qrcode(0, 'M');
qr.addData(text);
qr.make();

const count = qr.getModuleCount();
const quiet = 2;
const size = count + quiet * 2;
const BLACK = '\x1b[40m  \x1b[0m';
const WHITE = '\x1b[47m  \x1b[0m';

let out = '\n';
for (let row = 0; row < size; row++) {
  for (let col = 0; col < size; col++) {
    const insideRow = row >= quiet && row < quiet + count;
    const insideCol = col >= quiet && col < quiet + count;
    const dark = insideRow && insideCol && qr.isDark(row - quiet, col - quiet);
    out += dark ? BLACK : WHITE;
  }
  out += '\n';
}
process.stdout.write(out);
