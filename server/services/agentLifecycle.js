/**
 * Isolated CLI installations: validate before activation, retain running releases.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function validName(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid binary name.');
}

function managedTarget(name, root) {
  validName(name);
  try {
    const canonical = fs.realpathSync(root);
    const bin = path.join(canonical, 'bin');
    const packages = path.join(canonical, 'packages', name);
    if (fs.realpathSync(bin) !== bin || fs.realpathSync(packages) !== packages) return null;
    const link = path.join(bin, name);
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    const target = fs.realpathSync(link);
    return target.startsWith(packages + path.sep) ? link : null;
  } catch { return null; }
}

function isManaged(name, root) {
  try { return Boolean(managedTarget(name, root)); } catch { return false; }
}

function directory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Refusing redirected installation directory: ${dir}`);
  }
}

function check(command, args, options = {}) {
  const res = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, ...options });
  if (res.error || res.status !== 0) throw new Error(`Validation failed for ${path.basename(command)}: ${res.error?.message || `exit ${res.status}`}`);
  return res;
}

function run(agent, action, root) {
  validName(agent.binaryName);
  if (!['install', 'reinstall', 'remove'].includes(action)) throw new Error('Unknown action.');
  directory(root);
  root = fs.realpathSync(root);
  const bin = path.join(root, 'bin');
  const packages = path.join(root, 'packages');
  directory(bin);
  directory(packages);
  const agentDir = path.join(packages, agent.binaryName);
  directory(agentDir);
  const lock = path.join(agentDir, '.lock');
  try { fs.mkdirSync(lock); } catch { throw new Error('Another operation is in progress for this agent.'); }
  let tempLink;
  try {
    const link = path.join(bin, agent.binaryName);
    if (action === 'remove') {
      if (!managedTarget(agent.binaryName, root)) throw new Error('Only installations managed by Citadel can be removed.');
      fs.unlinkSync(link);
      console.log(`[Citadel] ${agent.name} removed from the managed PATH. Releases retained in ${agentDir} for running sessions and recovery; user credentials and daemon files were not changed.`);
      return;
    }
    // Each attempt has its own HOME. Never chmod or delete a previous install,
    // a user's ~/.codex, or the package tree of a running daemon.
    const release = fs.mkdtempSync(path.join(agentDir, 'release-'));
    fs.chmodSync(release, 0o755);
    const env = { ...process.env, HOME: release, PATH: `${release}/.local/bin:${release}/.opencode/bin:${process.env.PATH || ''}` };
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_BIN_HOME']) delete env[key];
    if (agent.id === 'codex') env.npm_config_include = 'optional';
    const result = spawnSync('/bin/bash', ['-o', 'pipefail', '-c', agent.installCommand], { cwd: release, env, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Installer failed (${result.error?.message || result.status}); previous installation remains active.`);
    const binary = ['.local/bin', '.opencode/bin', '.npm-global/bin'].map((sub) => path.join(release, sub, agent.binaryName))
      .find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
    if (!binary) throw new Error('Installer produced no executable; previous installation remains active.');
    if (!fs.realpathSync(binary).startsWith(release + path.sep)) throw new Error('Installer executable escapes its isolated release.');
    const version = check(binary, [agent.versionArg || '--version'], { env });
    if (!version.stdout.trim()) throw new Error('Agent returned no version; previous installation remains active.');
    if (agent.id === 'codex') {
      const nativeRoot = path.join(release, '.local/lib/node_modules/@openai/codex/node_modules/@openai');
      const hosts = [];
      function scan(dir, depth) {
        if (depth > 7) return;
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, item.name);
          if (item.isDirectory()) scan(file, depth + 1);
          else if (item.name === 'codex-code-mode-host') hosts.push(file);
        }
      }
      scan(nativeRoot, 0);
      if (!hosts.length) throw new Error('Codex is missing codex-code-mode-host; previous installation remains active.');
      check(hosts[0], ['--help'], { env });
    }
    // Sharing applies only to the newly downloaded payload, never existing data.
    check('chmod', ['-R', 'a+rX', release]);
    if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) throw new Error('Refusing to replace an unmanaged file.');
    tempLink = `${link}.new-${process.pid}`;
    fs.symlinkSync(binary, tempLink);
    fs.renameSync(tempLink, link);
    console.log(`[Citadel] ${agent.name} installed and validated: ${link}. Previous releases retained. Restart agent sessions to use it.`);
    if (agent.id === 'codex') console.log('[Citadel] The separately managed app-server daemon was not modified. A missing daemon package needs separate repair.');
  } finally {
    if (tempLink) { try { fs.unlinkSync(tempLink); } catch { /* already activated */ } }
    fs.rmdirSync(lock);
  }
}

function codexDaemonWarning(home) {
  const state = path.join(home, '.codex/app-server-daemon');
  if (!fs.existsSync(state)) return null;
  const bin = path.join(home, '.codex/packages/app-server-daemon/current/bin');
  for (const name of ['codex', 'codex-code-mode-host']) {
    try { fs.accessSync(path.join(bin, name), fs.constants.X_OK); }
    catch { return 'Codex daemon package is missing or inaccessible. Reinstalling the CLI does not repair this separate installation.'; }
  }
  return null;
}

module.exports = { run, isManaged, codexDaemonWarning };
