/** Exercise the installer's elevation boundary with fakes; never installs on the host. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
const boundary = source.slice(source.indexOf('# Run the whole Linux installation'), source.indexOf('# Standard layout'));
function exercise({ auth = true, check = false, piped = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-elevation-'));
  const log = path.join(root, 'calls');
  fs.writeFileSync(path.join(root, 'id'), '#!/bin/bash\necho 1000\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'sudo'), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in -n) exit 1;; -v) exit ${auth ? 0 : 1};; esac\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'curl'), `#!/bin/bash\nprintf '%s\\n' "curl $*" >> '${log}'\nprintf '#!/bin/bash\\nexit 0\\n' > "\${@: -1}"\n`, { mode: 0o755 });
  const script = path.join(root, 'installer');
  fs.writeFileSync(script, `set -euo pipefail\nOS=Linux\nCHECK_ONLY=${check}\nCLR=''\nREPO_BRANCH=main\n${boundary}\necho MUTATION\n`);
  const result = spawnSync('bash', piped ? ['-s', '--', '--no-tunnel'] : [script, '--no-tunnel'], { input: piped ? fs.readFileSync(script, 'utf8') : undefined, encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH, CITADEL_VERBOSE: '0', SSH_CONNECTION: 'test' } });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  fs.rmSync(root, { recursive: true, force: true });
  return { ...result, calls };
}
test('failed sudo authentication stops before installation or package commands', () => {
  const result = exercise({ auth: false });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /MUTATION/);
  assert.match(result.stderr, /authentication failed/); assert.doesNotMatch(result.calls, /env /);
});
test('authentication precedes a single whole-installer elevation and preserves options and SSH rendering context', () => {
  const result = exercise();
  assert.equal(result.status, 0); assert.doesNotMatch(result.stdout, /MUTATION/);
  assert.match(result.calls, /-v\nenv /); assert.match(result.calls, /CITADEL_VERBOSE=0/);
  assert.match(result.calls, /SSH_CONNECTION=test/); assert.match(result.calls, /--no-tunnel/);
});
test('check-only never requests sudo or crosses the elevation boundary', () => {
  const result = exercise({ check: true });
  assert.equal(result.status, 0); assert.equal(result.calls, ''); assert.match(result.stdout, /MUTATION/);
});

test('piped installation downloads a complete script rather than reusing partially consumed stdin', () => {
  const result = exercise({ piped: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /curl -fsSL https:\/\/raw.githubusercontent.com\/maksymhs\/Citadel\/main\/install.sh -o /);
  assert.match(result.calls, /env .*bash .*citadel-bootstrap.*--no-tunnel/);
  assert.doesNotMatch(result.stdout, /MUTATION/);
});
