const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main } = require('../scripts/graph');

function quietLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(m), error: (m) => lines.push(m) };
}

// A stand-in `graphify` that records its arguments and creates the output file.
function fakeGraphify(dir, { fail = false } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, 'graphify');
  fs.writeFileSync(script, `#!/bin/sh
[ "$1" = "--version" ] && { echo fake 0.0.0; exit 0; }
echo "$@|$GRAPHIFY_BACKEND" >> "$PWD/calls.log"
${fail ? 'exit 3' : 'mkdir -p graphify-out && echo {} > graphify-out/graph.json'}
`, { mode: 0o755 });
  return bin;
}

describe('npm run graph wrapper', () => {
  test('skips quietly when graphify is not installed, fails with --require', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-graph-'));
    const env = { PATH: empty };
    const out = quietLog();
    assert.equal(main([], { env, cwd: empty, log: out }), 0);
    assert.match(out.lines.join('\n'), /graphify not found/);
    assert.equal(main(['--require'], { env, cwd: empty, log: quietLog() }), 1);
  });

  test('builds code-only with no LLM backend, then updates incrementally', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-graph-'));
    const env = { PATH: `${fakeGraphify(dir)}:/usr/bin:/bin` };
    assert.equal(main([], { env, cwd: dir, log: quietLog() }), 0);
    assert.equal(main([], { env, cwd: dir, log: quietLog() }), 0);
    assert.equal(main(['--full'], { env, cwd: dir, log: quietLog() }), 0);
    const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['extract --code-only|none', 'update .|none', 'extract --code-only|none']);
  });

  test('reports a failing graphify instead of pretending it worked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-graph-'));
    const env = { PATH: `${fakeGraphify(dir, { fail: true })}:/usr/bin:/bin` };
    const out = quietLog();
    assert.equal(main([], { env, cwd: dir, log: out }), 3);
    assert.match(out.lines.join('\n'), /not updated/);
  });
});
