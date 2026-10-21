#!/usr/bin/env node
/**
 * Citadel filesystem agent.
 *
 * A tiny, dependency-free worker that performs one filesystem operation per
 * invocation. The server spawns it (optionally via `sudo -u <admin>` to reach
 * the whole host) and exchanges a single JSON request/response over stdin and
 * stdout. Keeping it separate means privileged access reuses the existing
 * "bash as admin" sudoers rule instead of granting the service user new rights,
 * and paths are passed as data (never interpolated into a shell).
 *
 * Request:  { "op": "list"|"read"|"write"|"mkdir"|"rename"|"remove"|"stat"
 *                  |"usage"|"cleanup-scan"|"cleanup-run", ... }
 * Response: { "ok": true, "data": ... } | { "ok": false, "error": "..." }
 */
'use strict';

// Directory walks issue many parallel stat calls; the default pool of 4 threads
// is the bottleneck. Must be set before the first filesystem call.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const MAX_INLINE_READ = 1024 * 1024; // 1 MiB returned to the editor by default

function resolvePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('A path is required.');
  }
  if (p.includes('\0')) {
    throw new Error('Invalid path.');
  }
  return path.resolve(p);
}

function entryType(lstat, stat) {
  if (!lstat) return 'unknown';
  if (lstat.isSymbolicLink()) {
    if (!stat) return 'symlink';
    return stat.isDirectory() ? 'symlink-dir' : 'symlink-file';
  }
  if (lstat.isDirectory()) return 'dir';
  if (lstat.isFile()) return 'file';
  return 'other';
}

async function listDir(p) {
  const dir = resolvePath(p);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let lstat = null;
    let stat = null;
    try { lstat = await fsp.lstat(full); } catch { /* raced/removed */ }
    try { stat = await fsp.stat(full); } catch { /* broken symlink */ }
    items.push({
      name: entry.name,
      path: full,
      type: entryType(lstat, stat),
      size: stat ? stat.size : null,
      mtime: stat ? stat.mtimeMs : null,
      mode: stat ? (stat.mode & 0o777).toString(8).padStart(3, '0') : null,
      target: lstat && lstat.isSymbolicLink() ? await fsp.readlink(full).catch(() => null) : null,
    });
  }
  items.sort((a, b) => {
    const ad = a.type.includes('dir');
    const bd = b.type.includes('dir');
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: dir, parent: path.dirname(dir), items };
}

async function readFile(p) {
  const target = resolvePath(p);
  const st = await fsp.stat(target);
  if (st.isDirectory()) throw new Error('Path is a directory.');
  const length = Math.min(st.size, MAX_INLINE_READ);
  const handle = await fsp.open(target, 'r');
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    const binary = buf.includes(0);
    return {
      path: target,
      size: st.size,
      truncated: st.size > length,
      binary,
      encoding: binary ? 'base64' : 'utf8',
      content: binary ? buf.toString('base64') : buf.toString('utf8'),
      mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
    };
  } finally {
    await handle.close();
  }
}

async function writeFile(p, content, encoding) {
  const target = resolvePath(p);
  const data = encoding === 'base64'
    ? Buffer.from(String(content || ''), 'base64')
    : String(content === undefined || content === null ? '' : content);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data);
  const st = await fsp.stat(target);
  return { path: target, size: st.size };
}

async function mkdir(p) {
  const target = resolvePath(p);
  await fsp.mkdir(target, { recursive: true });
  return { path: target };
}

async function rename(from, to) {
  const src = resolvePath(from);
  const dst = resolvePath(to);
  await fsp.rename(src, dst);
  return { from: src, to: dst };
}

async function remove(p) {
  const target = resolvePath(p);
  const st = await fsp.lstat(target);
  await fsp.rm(target, { recursive: true, force: false });
  return { path: target, type: st.isDirectory() ? 'dir' : 'file' };
}

async function statPath(p) {
  const target = resolvePath(p);
  let lstat = null;
  let stat = null;
  try { lstat = await fsp.lstat(target); } catch { /* ignore */ }
  try { stat = await fsp.stat(target); } catch { /* ignore */ }
  if (!lstat) throw new Error(`Path not found: ${target}`);
  return {
    path: target,
    type: entryType(lstat, stat),
    size: stat ? stat.size : null,
    mtime: stat ? stat.mtimeMs : null,
    mode: stat ? (stat.mode & 0o777).toString(8).padStart(3, '0') : null,
  };
}

// --- Disk usage and cleanup -------------------------------------------------

const SCAN_BUDGET_MS = 40000;
const LARGEST_FILES = 25;
// Tests can pretend to be another OS to exercise that branch; harmless otherwise.
const PLATFORM = process.env.CITADEL_FSAGENT_PLATFORM || process.platform;
const IS_MAC = PLATFORM === 'darwin';
const WALK_CONCURRENCY = 16;
const BIG_FILE_FLOOR = '1M';
const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Never offered for cleanup: live sockets/state of running services.
const TMP_PROTECTED = /^(tmux-|systemd-private-|snap-private-tmp|\.X11-unix|\.ICE-unix|ssh-|dbus-|citadel|com\.apple\.|launchd)/;

function diskBytes(st) {
  // Allocated blocks reflect real disk use (sparse files, small-file slack).
  return typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
}

/**
 * du-like walk: allocated bytes under `root`, staying on one filesystem, never
 * following symlinks, counting hard links once. Stops at `deadline` and reports
 * `partial` so a huge tree returns what was measured instead of hanging.
 */
async function measureTree(root, ctx, topFiles) {
  const out = { size: 0, files: 0, maxMtime: 0, special: false };
  const stack = [root];
  let active = 0;

  // One worker per slot pulls paths until the stack is empty and nobody is
  // still producing more; keeps the thread pool busy instead of walking serially.
  const visit = async (cur) => {
    let st;
    try { st = await fsp.lstat(cur); } catch { return; }
    if (st.dev !== ctx.dev) return;
    if (st.mtimeMs > out.maxMtime) out.maxMtime = st.mtimeMs;
    if (st.isDirectory()) {
      out.size += diskBytes(st);
      let names;
      try { names = await fsp.readdir(cur); } catch { ctx.unreadable += 1; return; }
      for (const name of names) stack.push(path.join(cur, name));
      return;
    }
    if (!st.isFile() && !st.isSymbolicLink()) out.special = true;
    if (st.nlink > 1) {
      const id = `${st.dev}:${st.ino}`;
      if (ctx.seen.has(id)) return;
      ctx.seen.add(id);
    }
    const bytes = diskBytes(st);
    out.size += bytes;
    out.files += 1;
    if (topFiles && st.isFile()) topFiles.push({ path: cur, size: bytes, mtime: st.mtimeMs });
  };

  const worker = async () => {
    for (;;) {
      if (Date.now() > ctx.deadline) { ctx.partial = true; return; }
      const next = stack.pop();
      if (next === undefined) {
        if (active === 0) return;
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      active += 1;
      try { await visit(next); } finally { active -= 1; }
    }
  };
  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, worker));
  return out;
}

function trimTop(list, limit) {
  list.sort((a, b) => b.size - a.size);
  list.length = Math.min(list.length, limit);
}

// --- Fast path: system du/find ---------------------------------------------
// They walk the tree in C in one pass, which is several times faster than
// stat-ing every entry from Node. Both run at idle CPU/IO priority so a scan of
// "/" does not starve the panel on a small VPS. Anything unexpected falls back
// to the portable walker above.

function onPath(bin) {
  for (const dir of (process.env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

function lowPriority(bin, args) {
  let cmd = [bin, ...args];
  if (onPath('ionice')) cmd = ['ionice', '-c3', ...cmd];
  if (onPath('nice')) cmd = ['nice', '-n', '19', ...cmd];
  return cmd;
}

// Streams a command's stdout as chunks to `onChunk`; resolves when it exits or
// the deadline passes (then `timedOut` is set and the child is killed).
function streamCommand(bin, args, deadline, onChunk) {
  return new Promise((resolve) => {
    const [cmd, ...rest] = lowPriority(bin, args);
    const child = spawn(cmd, rest, { stdio: ['ignore', 'pipe', 'ignore'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(1000, deadline - Date.now()));
    child.stdout.on('data', onChunk);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code !== null, code, timedOut }); });
  });
}

async function duChildren(root, deadline) {
  let buf = '';
  const sizes = new Map();
  const eat = (final) => {
    const lines = buf.split('\n');
    buf = final ? '' : lines.pop();
    for (const line of lines) {
      const tab = line.indexOf('\t');
      if (tab > 0) sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)) * 1024);
    }
  };
  const res = await streamCommand('du', ['-x', '-a', '-k', '-d', '1', '--', root], deadline, (c) => { buf += c; eat(false); });
  eat(true);
  if (!res.ok || sizes.size === 0) return null;
  return { sizes, partial: res.timedOut };
}

async function findLargest(root, deadline) {
  const top = [];
  let rest = '';
  const take = (rec) => {
    const tab = rec.indexOf('\t');
    if (tab < 0) return;
    top.push({ path: rec.slice(tab + 1), size: Number(rec.slice(0, tab)) * 512, mtime: null });
    if (top.length > LARGEST_FILES * 8) trimTop(top, LARGEST_FILES);
  };
  // GNU find prints records itself (NUL separated). BSD/macOS find has no
  // -printf, so only the big files are handed to stat(1); the format carries a
  // literal tab and records end with a newline.
  const args = IS_MAC
    ? [root, '-xdev', '-type', 'f', '-size', `+${BIG_FILE_FLOOR}`, '-exec', 'stat', '-f', '%b\t%N', '{}', '+']
    : [root, '-xdev', '-type', 'f', '-size', `+${BIG_FILE_FLOOR}`, '-printf', '%b\\t%p\\0'];
  const separator = IS_MAC ? '\n' : '\0';
  const res = await streamCommand('find', args, deadline, (c) => {
    rest += c;
    const recs = rest.split(separator);
    rest = recs.pop();
    recs.forEach(take);
  });
  if (!res.ok || (res.code !== 0 && top.length === 0 && !res.timedOut)) return null; // e.g. find without -printf
  trimTop(top, LARGEST_FILES);
  return { largest: top, partial: res.timedOut };
}

async function fastUsage(root, rootStat) {
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const [du, found] = await Promise.all([duChildren(root, deadline), findLargest(root, deadline)]);
  if (!du || !found) return null;
  const children = [];
  let total = 0;
  for (const [full, size] of du.sizes) {
    if (full === root || full === root.replace(/\/+$/, '')) { total = size; continue; }
    let lst;
    try { lst = await fsp.lstat(full); } catch { continue; }
    if (lst.dev !== rootStat.dev) {
      children.push({ name: path.basename(full), path: full, type: 'mount', size: 0, files: 0, mtime: lst.mtimeMs, skipped: true });
      continue;
    }
    const type = lst.isSymbolicLink() ? 'symlink' : lst.isDirectory() ? 'dir' : 'file';
    children.push({ name: path.basename(full), path: full, type, size, files: null, mtime: lst.mtimeMs });
  }
  if (!total) total = children.reduce((sum, c) => sum + c.size, 0);
  children.sort((a, b) => b.size - a.size);
  const largest = [];
  for (const f of found.largest) {
    try { largest.push({ ...f, mtime: (await fsp.lstat(f.path)).mtimeMs }); } catch { /* removed meanwhile */ }
  }
  return { path: root, total, partial: du.partial || found.partial, unreadable: 0, children, largest, disk: await diskInfo(root) };
}

async function diskUsage(p) {
  const root = resolvePath(p);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory()) {
    return { path: root, total: diskBytes(rootStat), partial: false, children: [], largest: [], disk: await diskInfo(root) };
  }
  const fast = await fastUsage(root, rootStat).catch(() => null);
  if (fast) return fast;

  const ctx = { dev: rootStat.dev, deadline: Date.now() + SCAN_BUDGET_MS, partial: false, unreadable: 0, seen: new Set() };
  const children = [];
  const largest = [];
  let total = diskBytes(rootStat);
  const names = await fsp.readdir(root).catch(() => []);
  for (const name of names) {
    const full = path.join(root, name);
    let lst;
    try { lst = await fsp.lstat(full); } catch { continue; }
    if (lst.dev !== ctx.dev) {
      children.push({ name, path: full, type: 'mount', size: 0, files: 0, mtime: lst.mtimeMs, skipped: true });
      continue;
    }
    const files = [];
    const m = await measureTree(full, ctx, files);
    total += m.size;
    largest.push(...files);
    trimTop(largest, LARGEST_FILES);
    const type = lst.isSymbolicLink() ? 'symlink' : lst.isDirectory() ? 'dir' : 'file';
    children.push({ name, path: full, type, size: m.size, files: m.files, mtime: lst.mtimeMs });
  }
  children.sort((a, b) => b.size - a.size);
  return { path: root, total, partial: ctx.partial, unreadable: ctx.unreadable, children, largest, disk: await diskInfo(root) };
}

async function diskInfo(p) {
  try {
    const fst = await fsp.statfs(p);
    const total = fst.blocks * fst.bsize;
    const free = fst.bavail * fst.bsize;
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

async function canWrite(dir) {
  try { await fsp.access(dir, fs.constants.W_OK); return true; } catch { return false; }
}

async function safeDirRoot(dir) {
  // A symlinked cache root could point anywhere; refuse instead of following it.
  try {
    const st = await fsp.lstat(dir);
    return st.isDirectory() ? st : null;
  } catch {
    return null;
  }
}

async function childrenOf(dir, filter) {
  const names = await fsp.readdir(dir).catch(() => []);
  const out = [];
  for (const name of names) {
    const full = path.join(dir, name);
    if (!filter || await filter(name, full)) out.push(full);
  }
  return out;
}

/**
 * Cleanup candidates. Everything is derived here from fixed locations (plus the
 * trusted projects dir), so the client only ever sends category ids and, to
 * narrow a category, paths that must already be among its entries.
 *
 * kind 'fs'  : `entries` are removed with rm -rf (or `sudo -n rm` when the user
 *              cannot write them and the panel runs in privileged mode).
 * kind 'cmd' : a vendor command does the cleaning (journalctl, docker).
 */
const ARCHIVE_RE = /\.(tar\.(gz|xz|bz2|zst)|tgz|txz|zip|7z|rar|iso|img|deb|rpm|appimage|run|pkg|dmg|msi|exe)$/i;
const ARCHIVE_MIN_BYTES = 20 * 1024 * 1024;
const PY_CACHE_NAMES = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox']);
const BUILD_CACHE_NAMES = new Set(['.next', '.nuxt', '.turbo', '.parcel-cache', '.svelte-kit', '.angular', '.dart_tool', '.gradle']);
const SYSTEM_GROUP = 'System';

// Homebrew reports sizes in binary units ("1.2GB" = 1.2 GiB).
function binaryBytes(text) {
  const m = /([\d.]+)\s*([kMGT]?B)/i.exec(String(text || ''));
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function formatDecimalBytes(text) {
  const m = /([\d.]+)\s*([kMGT]?B)/i.exec(String(text || ''));
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function runCommand(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { resolve({ code: -1, out: '' }); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

let sudoChecked = null;
async function sudoAvailable(privileged) {
  if (!privileged) return false;
  if (sudoChecked === null) sudoChecked = (await runCommand('sudo', ['-n', 'true'], { timeoutMs: 5000 })).code === 0;
  return sudoChecked;
}

// Walk the projects dir once and bucket the regenerable directories and the
// big installers/archives. Matched directories are never descended into.
async function scanProjects(projectsDir, deadline) {
  const found = { nodeModules: [], pyCaches: [], buildCaches: [], rustTargets: [], venvs: [], archives: [] };
  if (!projectsDir) return found;
  const walk = async (dir, depth) => {
    if (depth > 4 || Date.now() > deadline) return;
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(ents.map((e) => e.name));
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isFile()) {
        if (ARCHIVE_RE.test(ent.name) && found.archives.length < 60) {
          try {
            const st = await fsp.lstat(full);
            if (st.size >= ARCHIVE_MIN_BYTES) found.archives.push(full);
          } catch { /* removed meanwhile */ }
        }
        continue;
      }
      if (!ent.isDirectory()) continue; // symlinks are never followed
      if (ent.name === '.git') continue;
      if (ent.name === 'node_modules') { if (found.nodeModules.length < 100) found.nodeModules.push(full); continue; }
      if (PY_CACHE_NAMES.has(ent.name)) { found.pyCaches.push(full); continue; }
      if (BUILD_CACHE_NAMES.has(ent.name)) { found.buildCaches.push(full); continue; }
      if (ent.name === 'target' && names.has('Cargo.toml')) { found.rustTargets.push(full); continue; }
      if ((ent.name === '.venv' || ent.name === 'venv') && fs.existsSync(path.join(full, 'pyvenv.cfg'))) { found.venvs.push(full); continue; }
      await walk(full, depth + 1);
    }
  };
  await walk(path.resolve(projectsDir), 0);
  return found;
}

async function existingDirs(list) {
  const out = [];
  for (const dir of list) { if (await safeDirRoot(dir)) out.push(dir); }
  return out;
}

async function cleanupCandidates(projectsDir, privileged) {
  const home = os.homedir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const sudoOk = await sudoAvailable(privileged);
  const list = [];

  const accessFor = async (entries) => {
    const parents = Array.from(new Set(entries.map((e) => path.dirname(e)))).slice(0, 25);
    for (const dir of parents) { if (!await canWrite(dir)) return sudoOk ? 'sudo' : 'none'; }
    return 'direct';
  };
  const addFs = async (def, entries) => {
    if (!entries.length) return;
    list.push({ kind: 'fs', ...def, entries, access: await accessFor(entries) });
  };
  const addDirChildren = async (def, dir, filter) => {
    if (!await safeDirRoot(dir)) return;
    await addFs({ ...def, root: dir }, await childrenOf(dir, filter));
  };


  // -- macOS -----------------------------------------------------------------
  // Only folders macOS does not gate behind a permission prompt (~/Library/Caches,
  // Logs and Developer are ordinary folders). com.apple.* caches belong to the OS.
  async function addMacCategories() {
    const lib = path.join(home, 'Library');
    const hasBrew = onPath('brew');
    const GD = 'Developer';
    await addDirChildren({ id: 'mac-caches', group: G1, label: 'App caches (~/Library/Caches)', risk: 'safe', description: 'Caches of your apps and tools, rebuilt on demand. Quit the apps first for best results; macOS system caches (com.apple.*) are left alone.' },
      path.join(lib, 'Caches'), (n) => !n.startsWith('com.apple.') && !(hasBrew && n === 'Homebrew'));
    await addDirChildren({ id: 'mac-logs', group: G1, label: 'App logs (~/Library/Logs)', risk: 'safe', description: 'Log files and crash reports written by your apps.' }, path.join(lib, 'Logs'));
    const xcode = path.join(lib, 'Developer', 'Xcode');
    await addDirChildren({ id: 'xcode-derived', group: GD, label: 'Xcode build data (DerivedData)', risk: 'safe', description: 'Intermediate builds and indexes. Rebuilt by the next build.' }, path.join(xcode, 'DerivedData'));
    await addDirChildren({ id: 'xcode-archives', group: GD, label: 'Xcode archives', risk: 'review', description: 'App archives you built. Keep the ones you may need to re-export or symbolicate.' }, path.join(xcode, 'Archives'));
    await addDirChildren({ id: 'xcode-device-support', group: GD, label: 'Xcode device support files', risk: 'review', description: 'Debug symbols copied from connected iPhones/iPads/Watches. Downloaded again when you connect one.' }, path.join(xcode, 'iOS DeviceSupport'));
    await addDirChildren({ id: 'simulator-caches', group: GD, label: 'Simulator caches', risk: 'safe', description: 'CoreSimulator caches. Recreated when needed.' }, path.join(lib, 'Developer', 'CoreSimulator', 'Caches'));
    if (hasBrew) {
      const dry = await runCommand('brew', ['cleanup', '-n', '-s', '--prune=all'], { timeoutMs: 30000 });
      const m = /free approximately\s+([\d.]+\s*[kMGT]?B)/i.exec(dry.out);
      const bytes = dry.code === 0 && m ? binaryBytes(m[1]) : 0;
      if (bytes > 0) {
        list.push({ kind: 'cmd', id: 'brew-cleanup', group: GD, label: 'Homebrew: old versions & downloads', risk: 'safe', root: 'homebrew', entries: [], estimate: bytes, access: 'direct',
          description: 'brew cleanup -s --prune=all: removes old formula versions and cached downloads. Installed versions are kept.', cmd: ['brew', 'cleanup', '-s', '--prune=all'] });
      }
    }
  }

  // -- User caches -----------------------------------------------------------
  const G1 = 'Caches';
  await addDirChildren({ id: 'user-cache', group: G1, label: 'User cache', risk: 'safe', description: `Application caches in ${home}/.cache (pip, Go builds, browsers, thumbnails). Rebuilt on demand.` }, path.join(home, '.cache'));
  await addDirChildren({ id: 'npm-cache', group: G1, label: 'npm download cache', risk: 'safe', description: `${home}/.npm/_cacache. Packages are downloaded again when needed.` }, path.join(home, '.npm', '_cacache'));
  await addDirChildren({ id: 'pm-stores', group: G1, label: 'pnpm / yarn stores', risk: 'safe', description: 'Package manager stores. Re-fetched on the next install.' }, path.join(home, '.local', 'share', 'pnpm'));
  if (!IS_MAC) {
    await addDirChildren({ id: 'trash', group: G1, label: 'Trash', risk: 'safe', description: `Files already deleted from a desktop session (${home}/.local/share/Trash).` }, path.join(home, '.local', 'share', 'Trash'));
  }
  // The macOS Trash and ~/Downloads are privacy-protected folders: reading them
  // makes macOS ask the user for permission, so a scan must not touch them.
  if (IS_MAC) await addMacCategories();
  const langCaches = await existingDirs([
    path.join(home, '.cargo', 'registry', 'cache'), path.join(home, '.cargo', 'registry', 'src'),
    path.join(home, 'go', 'pkg', 'mod', 'cache'), path.join(home, '.gradle', 'caches'),
    path.join(home, '.m2', 'repository'), path.join(home, '.pub-cache'),
    path.join(home, '.nuget', 'packages'), path.join(home, '.composer', 'cache'),
    path.join(home, '.bundle', 'cache'), path.join(home, '.cache', 'pip'),
  ].filter((d) => !d.startsWith(path.join(home, '.cache') + path.sep)));
  await addFs({ id: 'lang-caches', group: G1, label: 'Language package caches', risk: 'review', description: 'Cargo, Go, Gradle, Maven, Dart/Flutter, NuGet, Composer. Everything is downloaded again by the next build, so offline builds stop working until then.', root: home }, langCaches);

  // -- Projects --------------------------------------------------------------
  const G2 = 'Projects';
  const proj = await scanProjects(projectsDir, Date.now() + 10000);
  const base = projectsDir ? path.resolve(projectsDir) : '';
  const appDir = path.resolve(__dirname, '..');
  const rel = (full) => path.relative(base, path.dirname(full)) || path.basename(base);
  for (const full of proj.nodeModules.filter((f) => f !== path.join(appDir, 'node_modules'))) {
    await addFs({ id: `nm:${full}`, group: G2, label: `node_modules — ${rel(full)}`, risk: 'review', description: 'Installed dependencies. Restore with npm install; stop any running app that uses it first.', root: full }, [full]);
  }
  await addFs({ id: 'py-caches', group: G2, label: 'Python bytecode & test caches', risk: 'safe', description: '__pycache__, .pytest_cache, .mypy_cache, .ruff_cache, .tox in your projects. Recreated automatically.', root: base }, proj.pyCaches);
  await addFs({ id: 'build-caches', group: G2, label: 'Framework build caches', risk: 'review', description: '.next, .nuxt, .turbo, .svelte-kit, .parcel-cache, .angular, .dart_tool, .gradle. Rebuilt by the next build or dev run.', root: base }, proj.buildCaches);
  await addFs({ id: 'rust-targets', group: G2, label: 'Rust build output (target/)', risk: 'review', description: 'Compiled artifacts next to a Cargo.toml. cargo build recreates them, which can take minutes.', root: base }, proj.rustTargets);
  await addFs({ id: 'venvs', group: G2, label: 'Python virtualenvs', risk: 'review', description: '.venv / venv folders. Recreate with python -m venv and pip install.', root: base }, proj.venvs);
  await addFs({ id: 'archives', group: G2, label: 'Large installers & archives', risk: 'review', description: `Archives and installers of 20 MB or more (.tar.xz, .zip, .iso, .deb, ...) under your projects. Often leftovers from a download that was already extracted.`, root: base }, proj.archives);
  if (!IS_MAC) {
    const downloads = path.join(home, 'Downloads');
    await addDirChildren({ id: 'downloads', group: G2, label: 'Downloads folder', risk: 'review', description: `Everything in ${downloads}. Check it before deleting.` }, downloads);
  }

  // -- Temporary files -------------------------------------------------------
  const tmpBudget = Date.now() + 15000;
  const staleTmp = async (dir) => {
    const found = [];
    if (!await safeDirRoot(dir)) return found;
    for (const full of await childrenOf(dir, (n) => !TMP_PROTECTED.test(n))) {
      let st;
      try { st = await fsp.lstat(full); } catch { continue; }
      if (uid !== null && st.uid !== uid) continue;
      if (st.mtimeMs > Date.now() - TMP_MAX_AGE_MS) continue;
      if (st.isDirectory()) {
        // Out of time: leave the rest alone rather than guess they are stale.
        if (Date.now() > tmpBudget) continue;
        const ctx = { dev: st.dev, deadline: Math.min(Date.now() + 5000, tmpBudget), partial: false, unreadable: 0, seen: new Set() };
        const m = await measureTree(full, ctx, null);
        if (ctx.partial || m.special || m.maxMtime > Date.now() - TMP_MAX_AGE_MS) continue;
      } else if (!st.isFile()) {
        continue;
      }
      found.push(full);
    }
    return found;
  };
  // On macOS /tmp is a symlink; the real folders are /private/tmp and the
  // per-user temp dir.
  const tmpRoots = IS_MAC ? ['/private/tmp', os.tmpdir()] : ['/tmp', '/var/tmp'];
  const staleFiles = [];
  for (const dir of tmpRoots) staleFiles.push(...await staleTmp(dir));
  await addFs({ id: 'tmp-old', group: G1, label: 'Old temporary files', risk: 'review', description: `Your files in ${tmpRoots.join(' and ')} untouched for 7+ days. Check nothing running still needs them.`, root: tmpRoots[0] }, staleFiles);

  // -- System (root) ---------------------------------------------------------
  if (PLATFORM === 'linux') {
    const oldLogs = async (d) => {
      const found = [];
      const rotated = /(\.gz|\.xz|\.bz2|\.old|\.\d+|-\d{8})$/;
      for (const full of await childrenOf(d)) {
        let st;
        try { st = await fsp.lstat(full); } catch { continue; }
        if (st.isFile() && rotated.test(full)) found.push(full);
        else if (st.isDirectory() && full !== '/var/log/journal') {
          for (const inner of await childrenOf(full, (n) => rotated.test(n))) found.push(inner);
        }
      }
      return found;
    };
    await addFs({ id: 'apt-cache', group: SYSTEM_GROUP, label: 'Downloaded package files (apt)', risk: 'safe', description: 'Installer packages in /var/cache/apt/archives that are already installed.', root: '/var/cache/apt/archives' },
      await childrenOf('/var/cache/apt/archives', (n) => n.endsWith('.deb')));
    await addFs({ id: 'apt-lists', group: SYSTEM_GROUP, label: 'Package index (apt lists)', risk: 'review', description: 'Package lists in /var/lib/apt/lists. Recreated by apt update; installs fail until you run it.', root: '/var/lib/apt/lists' },
      await childrenOf('/var/lib/apt/lists', (n) => n !== 'partial' && n !== 'lock'));
    await addFs({ id: 'old-logs', group: SYSTEM_GROUP, label: 'Rotated system logs', risk: 'safe', description: 'Compressed or numbered old logs in /var/log. Current logs are kept.', root: '/var/log' }, await oldLogs('/var/log'));
    await addFs({ id: 'crash-dumps', group: SYSTEM_GROUP, label: 'Crash reports & core dumps', risk: 'safe', description: '/var/crash and systemd coredumps.', root: '/var/crash' },
      [...await childrenOf('/var/crash'), ...await childrenOf('/var/lib/systemd/coredump')]);
    await addFs({ id: 'snap-cache', group: SYSTEM_GROUP, label: 'Snap download cache', risk: 'safe', description: '/var/lib/snapd/cache. Old snap downloads.', root: '/var/lib/snapd/cache' },
      await childrenOf('/var/lib/snapd/cache'));

    // journald: vacuum with the vendor command, keep the last 100 MB.
    const journalDir = '/var/log/journal';
    if (await safeDirRoot(journalDir)) {
      const sized = await duSizes([journalDir], Date.now() + 10000).catch(() => null);
      const total = sized ? sized.get(journalDir) || 0 : 0;
      if (total > 150 * 1024 * 1024) {
        list.push({ kind: 'cmd', id: 'journal', group: SYSTEM_GROUP, label: 'System journal', risk: 'safe', root: journalDir, entries: [], estimate: total - 100 * 1024 * 1024,
          description: 'journalctl --vacuum-size=100M: keeps the newest 100 MB of the system journal.', access: sudoOk || uid === 0 ? 'sudo' : 'none',
          cmd: ['journalctl', '--vacuum-size=100M'], sizePath: journalDir });
      }
    }
  }

  // Docker: only when the daemon answers; volumes are never touched.
  if (onPath('docker')) {
    const df = await runCommand('docker', ['system', 'df', '--format', '{{.Type}}\t{{.Reclaimable}}'], { timeoutMs: 15000 });
    if (df.code === 0) {
      const rec = {};
      for (const line of df.out.split('\n')) { const [t, r] = line.split('\t'); if (t) rec[t.trim()] = formatDecimalBytes(r); }
      const dock = (id, label, risk, description, key, args) => {
        if (!rec[key]) return;
        list.push({ kind: 'cmd', id, group: 'Docker', label, risk, description, root: 'docker', entries: [], estimate: rec[key], access: 'direct', cmd: ['docker', ...args] });
      };
      dock('docker-containers', 'Docker: stopped containers', 'review', 'docker container prune: removes every stopped container.', 'Containers', ['container', 'prune', '-f']);
      dock('docker-build-cache', 'Docker: build cache', 'safe', 'docker builder prune: cached build layers. Next builds start colder.', 'Build Cache', ['builder', 'prune', '-a', '-f']);
      dock('docker-images', 'Docker: unused images', 'review', 'docker image prune -a: images no container uses. They are pulled again when needed. Volumes are never removed.', 'Images', ['image', 'prune', '-a', '-f']);
    }
  }
  return list;
}

// Sizes of many paths in a few du calls (-s per argument; hard links shared
// between arguments are counted once, which is what "space freed" means).
async function duSizes(entries, deadline) {
  const sizes = new Map();
  for (let i = 0; i < entries.length; i += 200) {
    let buf = '';
    const res = await streamCommand('du', ['-x', '-s', '-k', '--', ...entries.slice(i, i + 200)], deadline, (c) => { buf += c; });
    if (!res.ok && !buf) return null;
    for (const line of buf.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)) * 1024);
    }
  }
  return sizes;
}

const ITEMS_SHOWN = 40;

async function cleanupScan(projectsDir, privileged) {
  const ctx = { deadline: Date.now() + SCAN_BUDGET_MS, partial: false, unreadable: 0, seen: new Set() };
  const candidates = await cleanupCandidates(projectsDir, privileged);
  const fastSizes = await duSizes(candidates.flatMap((c) => c.entries), ctx.deadline).catch(() => null);
  const out = [];
  for (const c of candidates) {
    const items = [];
    let size = 0;
    for (const entry of c.entries) {
      let bytes;
      if (fastSizes && fastSizes.has(entry)) bytes = fastSizes.get(entry);
      else {
        if (Date.now() > ctx.deadline) { ctx.partial = true; break; }
        let st;
        try { st = await fsp.lstat(entry); } catch { continue; }
        ctx.dev = st.dev;
        bytes = (await measureTree(entry, ctx, null)).size;
      }
      size += bytes;
      items.push({ path: entry, size: bytes });
    }
    if (c.kind === 'cmd') size = c.estimate || 0;
    items.sort((x, y) => y.size - x.size);
    if (size === 0 && c.kind === 'fs') continue;
    out.push({
      id: c.id, group: c.group, label: c.label, description: c.description, risk: c.risk,
      size, count: c.entries.length, access: c.access, writable: c.access !== 'none', path: c.root,
      items: items.slice(0, ITEMS_SHOWN), itemsTruncated: items.length > ITEMS_SHOWN,
    });
  }
  out.sort((x, y) => y.size - x.size);
  return { candidates: out, partial: ctx.partial, privileged: Boolean(privileged), disk: await diskInfo('/') };
}

async function removeEntries(entries, access) {
  const errors = [];
  let removed = 0;
  if (access === 'sudo') {
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const res = await runCommand('sudo', ['-n', 'rm', '-rf', '--', ...chunk]);
      if (res.code === 0) removed += chunk.length;
      else errors.push(res.out.trim().slice(0, 200) || 'sudo rm failed');
    }
    return { removed, errors };
  }
  for (const entry of entries) {
    try {
      await fsp.rm(entry, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      errors.push(`${path.basename(entry)}: ${err.message}`);
    }
  }
  return { removed, errors };
}

async function cleanupRun(ids, only, projectsDir, privileged) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('Nothing selected.');
  const wanted = new Set(ids.map(String));
  const candidates = (await cleanupCandidates(projectsDir, privileged)).filter((c) => wanted.has(c.id));
  const results = [];
  let freed = 0;
  for (const c of candidates) {
    if (c.access === 'none') {
      results.push({ id: c.id, freed: 0, removed: 0, errors: ['Needs root: enable the admin terminal (and passwordless sudo) to clean this.'] });
      continue;
    }
    if (c.kind === 'cmd') {
      const before = c.sizePath ? (await duSizes([c.sizePath], Date.now() + 10000).catch(() => null) || new Map()).get(c.sizePath) || 0 : 0;
      const argv = c.access === 'sudo' ? ['sudo', '-n', ...c.cmd] : c.cmd;
      const res = await runCommand(argv[0], argv.slice(1), { timeoutMs: 170000 });
      let bytes = c.estimate || 0;
      if (c.sizePath) {
        const after = (await duSizes([c.sizePath], Date.now() + 10000).catch(() => null) || new Map()).get(c.sizePath) || 0;
        bytes = Math.max(0, before - after);
      }
      if (res.code !== 0) { results.push({ id: c.id, freed: 0, removed: 0, errors: [res.out.trim().slice(0, 200) || 'Command failed.'] }); continue; }
      freed += bytes;
      results.push({ id: c.id, freed: bytes, removed: 1, errors: [] });
      continue;
    }
    // Optional narrowing: only paths that are genuinely entries of this category.
    const picked = Array.isArray(only && only[c.id]) ? new Set(only[c.id].map(String)) : null;
    const entries = picked ? c.entries.filter((e) => picked.has(e)) : c.entries;
    const ctx = { deadline: Date.now() + SCAN_BUDGET_MS, partial: false, unreadable: 0, seen: new Set() };
    const sizes = await duSizes(entries, ctx.deadline).catch(() => null);
    const res = await removeEntries(entries, c.access);
    let bytes = 0;
    if (sizes) for (const e of entries) bytes += sizes.get(e) || 0;
    if (res.errors.length) bytes = Math.round(bytes * (res.removed / Math.max(1, entries.length)));
    freed += bytes;
    results.push({ id: c.id, freed: bytes, removed: res.removed, errors: res.errors.slice(0, 5) });
  }
  const unknown = ids.filter((id) => !candidates.some((c) => c.id === String(id)));
  for (const id of unknown) results.push({ id, freed: 0, removed: 0, errors: ['Nothing to clean (already empty or not available).'] });
  return { freed, results, disk: await diskInfo('/') };
}

async function handle(req) {
  switch (req.op) {
    case 'list': return listDir(req.path);
    case 'read': return readFile(req.path);
    case 'write': return writeFile(req.path, req.content, req.encoding);
    case 'mkdir': return mkdir(req.path);
    case 'rename': return rename(req.from, req.to);
    case 'remove': return remove(req.path);
    case 'stat': return statPath(req.path);
    case 'usage': return diskUsage(req.path);
    case 'cleanup-scan': return cleanupScan(req.projectsDir, req.privileged);
    case 'cleanup-run': return cleanupRun(req.ids, req.items, req.projectsDir, req.privileged);
    default: throw new Error(`Unknown operation: ${req.op}`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

(async () => {
  try {
    const raw = await readStdin();
    const req = JSON.parse(raw || '{}');
    const data = await handle(req);
    process.stdout.write(JSON.stringify({ ok: true, data }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  }
})();
