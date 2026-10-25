/** Optional code-server install and one authenticated, loopback-only browser editor process. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DATA_DIR } = require('../config');
const { validateSafePath } = require('../security/guard');
const projectService = require('./projectService');
const { downloadRelease } = require('./releaseDownload');
const { isInternalSecret } = require('../../scripts/sentinelEnv');
const VERSION = '4.143.1';
// Pinned GitHub release asset SHA-256 digests, not hashes supplied by the client.
const HASHES = {
  'linux-amd64': '614877cf71005f14ea252bd2d9b1c12237cf7d73681ef150f0dff7f13849fdb5',
  'linux-arm64': '51481a891754dc2585b86d007aec24ac675453fc5ef6cfa346c4462449277384',
  'macos-amd64': '0c77b28570d67c729bf75e57dc92bb51af0b4c683f89e1e756c168d30dcc0d63',
  'macos-arm64': '940bb5ecd567187336ed3608c2404e21e37528465aaddb4d6f5b514d930bd7db',
};
function createEditorService({ dataDir = DATA_DIR, spawnImpl = spawn, execFileImpl = promisify(execFile), download = downloadRelease, platform = process.platform, arch = process.arch, getProject = projectService.getProject } = {}) {
  const root = path.join(dataDir, 'editor');
  const installDir = path.join(root, 'runtime');
  const binary = path.join(installDir, 'bin', 'code-server');
  const assetPlatform = `${platform === 'darwin' ? 'macos' : platform}-${arch === 'x64' ? 'amd64' : arch}`;
  let child = null, runtime = null, port = null, cookie = null, starting = null, installing = null, lastError = null, idle = null, sockets = 0, processGroup = null;
  const installed = () => { try { return fs.lstatSync(binary).isFile() && !fs.lstatSync(root).isSymbolicLink(); } catch { return false; } };
  function prepareRoot() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(root) !== path.join(fs.realpathSync(dataDir), 'editor')) throw new Error('Editor directory must not be a symlink.');
    fs.chmodSync(root, 0o700);
  }
  function status() { return { version: VERSION, supported: Boolean(HASHES[assetPlatform]), installed: installed(), installing: Boolean(installing), running: Boolean(child && cookie), error: lastError }; }
  async function install() {
    if (installing) return installing;
    if (!HASHES[assetPlatform]) throw new Error('Browser editor supports Linux/macOS on x64/arm64.');
    if (installed()) return status();
    installing = (async () => {
      prepareRoot();
      const temp = fs.mkdtempSync(path.join(root, 'install-'));
      const name = `code-server-${VERSION}-${assetPlatform}`;
      try {
        const archive = path.join(temp, 'editor.tar.gz');
        await download(`https://github.com/coder/code-server/releases/download/v${VERSION}/${name}.tar.gz`, archive, HASHES[assetPlatform]);
        await execFileImpl('tar', ['-xzf', archive, '-C', temp, name], { timeout: 120000, maxBuffer: 1024 * 1024 });
        const extracted = path.join(temp, name);
        const entry = path.join(extracted, 'bin', 'code-server');
        if (!fs.lstatSync(entry).isFile() || fs.lstatSync(entry).isSymbolicLink()) throw new Error('Invalid browser editor archive.');
        if (fs.existsSync(installDir)) throw new Error('Editor installation already exists.');
        fs.renameSync(extracted, installDir);
        fs.chmodSync(binary, 0o700);
      } catch { throw new Error('Browser editor installation failed. Check disk space, network access and tar availability.'); }
      finally { fs.rmSync(temp, { recursive: true, force: true }); }
      return status();
    })();
    try { return await installing; } finally { installing = null; }
  }
  function project(id) {
    const found = getProject(id);
    if (!found) throw new Error('Project not found.');
    return { ...found, path: validateSafePath(found.path) };
  }
  function touch() {
    clearTimeout(idle);
    idle = setTimeout(() => { if (!sockets) close().catch(() => {}); else touch(); }, 15 * 60000);
    idle.unref();
  }
  function socketOpened() { sockets++; touch(); return () => { sockets = Math.max(0, sockets - 1); touch(); }; }
  async function start() {
    if (child && cookie) { touch(); return; }
    if (starting) return starting;
    if (!installed()) throw new Error('Install the browser editor first.');
    starting = (async () => {
      prepareRoot();
      if (runtime || processGroup) await close();
      const reservation = net.createServer();
      await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
      port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      const tempBase = process.platform === 'linux' && fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
      runtime = fs.mkdtempSync(path.join(tempBase, 'citadel-editor-'));
      fs.chmodSync(runtime, 0o700);
      const configFile = path.join(runtime, 'config.yaml');
      fs.writeFileSync(configFile, '{}', { mode: 0o600 });
      const password = crypto.randomBytes(32).toString('hex');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isInternalSecret(key) && !['PASSWORD', 'HASHED_PASSWORD', 'CS_CONFIG', 'PORT'].includes(key)));
      child = spawnImpl(binary, ['--config', configFile, '--bind-addr', `127.0.0.1:${port}`, '--auth', 'password', '--user-data-dir', path.join(root, 'user-data'), '--extensions-dir', path.join(root, 'extensions'), '--disable-telemetry', '--disable-update-check', '--disable-proxy'], {
        cwd: root, env: { ...env, PASSWORD: password }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const current = child;
      processGroup = current.pid;
      child.stdout?.resume(); child.stderr?.resume();
      child.on('error', () => { lastError = 'Browser editor failed to start.'; });
      child.on('close', () => { if (child === current) {
        if (processGroup) { try { process.kill(-processGroup, 'SIGKILL'); } catch { /* already exited */ } }
        processGroup = null; child = null; cookie = null; lastError = 'Browser editor stopped. Open it again to restart.'; } });
      for (let i = 0; i < 100; i++) {
        if (!child) break;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }), redirect: 'manual', signal: AbortSignal.timeout(1000) });
          const cookies = response.headers.getSetCookie();
          await response.body?.cancel();
          if (response.status === 302 && cookies.length) {
            cookie = cookies.map(value => value.split(';')[0]).join('; ');
            lastError = null; touch(); return;
          }
        } catch { /* editor is still starting */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await close();
      throw new Error('Browser editor did not become ready. Check platform requirements.');
    })();
    try { await starting; } finally { starting = null; }
  }
  async function open(id) { const found = project(id); await start(); return { url: `/editor/${encodeURIComponent(id)}/?folder=${encodeURIComponent(found.path)}`, project: { id: found.id, name: found.name } }; }
  function target(id) { project(id); if (!child || !cookie) throw new Error('Browser editor is stopped. Open it again from Projects.'); touch(); return { port, cookie }; }
  async function close() {
    clearTimeout(idle); cookie = null;
    const current = child, group = processGroup; child = null; processGroup = null;
    const signalGroup = signal => {
      if (group) { try { process.kill(-group, signal); } catch { /* group exited */ } }
      else if (current) { try { current.kill(signal); } catch { /* not spawned */ } }
    };
    if (current && current.exitCode === null && !current.signalCode) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => { signalGroup('SIGKILL'); resolve(); }, 3000);
        current.once('close', () => { clearTimeout(timeout); resolve(); });
        signalGroup('SIGTERM');
      });
    }
    // Extension hosts and integrated terminals must not outlive a stopped IDE.
    signalGroup('SIGKILL');
    if (runtime) { fs.rmSync(runtime, { recursive: true, force: true }); runtime = null; }
  }
  return { status, install, open, target, close, socketOpened };
}
module.exports = { ...createEditorService(), createEditorService, VERSION };
