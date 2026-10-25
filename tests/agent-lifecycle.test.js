const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, isManaged, codexDaemonWarning } = require('../server/services/agentLifecycle');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const install = 'mkdir -p "$HOME/.local/bin"; printf \'#!/bin/sh\\necho fake-1.0\\n\' > "$HOME/.local/bin/fake"; chmod 700 "$HOME/.local/bin/fake"';
const agent = { id: 'fake', binaryName: 'fake', name: 'Fake', installCommand: install };

test('isolates installs, activates a working executable, retains old releases on reinstall and remove', (t) => {
  const root = fixture(t);
  const secret = path.join(root, 'existing-secret');
  fs.writeFileSync(secret, 'private', { mode: 0o600 });
  const home = process.env.HOME;
  run(agent, 'install', root);
  assert.equal(process.env.HOME, home);
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  assert.equal(isManaged('fake', root), true);
  const link = path.join(root, 'bin/fake');
  const original = fs.realpathSync(link);
  assert.ok(fs.statSync(original).mode & 0o005);
  run(agent, 'reinstall', root);
  assert.notEqual(fs.realpathSync(link), original);
  assert.ok(fs.existsSync(original), 'running releases must survive updates');
  run(agent, 'remove', root);
  assert.equal(isManaged('fake', root), false);
  assert.equal(fs.existsSync(link), false);
  assert.ok(fs.existsSync(original));
  assert.equal(fs.readFileSync(secret, 'utf8'), 'private');
});

test('download, missing binary and failed version probe leave previous activation untouched', (t) => {
  const root = fixture(t);
  run(agent, 'install', root);
  const target = fs.realpathSync(path.join(root, 'bin/fake'));
  for (const command of ['false | cat', 'true', install.replace('echo fake-1.0', 'exit 1')]) {
    assert.throws(() => run({ ...agent, installCommand: command }, 'reinstall', root));
    assert.equal(fs.realpathSync(path.join(root, 'bin/fake')), target);
  }
});

test('refuses unmanaged removal, redirected directories, unsafe names and concurrent operations', (t) => {
  const root = fixture(t);
  assert.throws(() => run(agent, 'remove', root), /managed/);
  assert.throws(() => run({ ...agent, binaryName: '..' }, 'install', root), /Invalid/);
  fs.mkdirSync(path.join(root, 'packages/fake/.lock'));
  assert.throws(() => run(agent, 'install', root), /in progress/);
  const other = fixture(t);
  const redirected = fixture(t);
  fs.symlinkSync(other, path.join(redirected, 'packages'));
  assert.throws(() => run(agent, 'install', redirected), /redirected/);
});

test('Codex activation requires a working companion host, not only codex --version', (t) => {
  const root = fixture(t);
  const codex = { ...agent, id: 'codex', binaryName: 'codex', installCommand: install.replaceAll('/fake', '/codex') };
  assert.throws(() => run(codex, 'install', root));
  assert.equal(fs.existsSync(path.join(root, 'bin/codex')), false);
  const hostDir = '$HOME/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/test/bin';
  codex.installCommand += `; mkdir -p "${hostDir}"; printf '#!/bin/sh\\nexit 0\\n' > "${hostDir}/codex-code-mode-host"; chmod 700 "${hostDir}/codex-code-mode-host"`;
  run(codex, 'install', root);
  assert.equal(isManaged('codex', root), true);
});

test('reports a missing separate Codex daemon without changing its files', (t) => {
  const home = fixture(t);
  assert.equal(codexDaemonWarning(home), null);
  const state = path.join(home, '.codex/app-server-daemon');
  fs.mkdirSync(state, { recursive: true });
  assert.match(codexDaemonWarning(home), /separate installation/);
  assert.deepEqual(fs.readdirSync(state), []);
  const bin = path.join(home, '.codex/packages/app-server-daemon/current/bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['codex', 'codex-code-mode-host']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(codexDaemonWarning(home), null);
});
