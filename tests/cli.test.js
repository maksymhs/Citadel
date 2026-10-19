const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('print-qr renders a scannable grid', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'print-qr.js'), 'https://example.com'], {
    encoding: 'utf8',
  });
  assert.match(out, /\x1b\[30;47m/);
  assert.match(out, /[█▀▄]/);
  assert.ok(out.split('\n').length > 10);
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
