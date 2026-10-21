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
const WALK_CONCURRENCY = 16;
const BIG_FILE_FLOOR = '1M';
const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Never offered for cleanup: live sockets/state of running services.
const TMP_PROTECTED = /^(tmux-|systemd-private-|snap-private-tmp|\.X11-unix|\.ICE-unix|ssh-|dbus-|citadel)/;

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
  const res = await streamCommand('find', [root, '-xdev', '-type', 'f', '-size', `+${BIG_FILE_FLOOR}`, '-printf', '%b\\t%p\\0'], deadline, (c) => {
    rest += c;
    const recs = rest.split('\0');
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
 * trusted projects dir), so the client only ever sends ids, never paths.
 */
async function cleanupCandidates(projectsDir) {
  const home = os.homedir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const list = [];

  const add = async (def, dir, entriesFn) => {
    const st = await safeDirRoot(dir);
    if (!st) return;
    const entries = await entriesFn(dir);
    if (!entries.length) return;
    list.push({ ...def, root: dir, entries, writable: await canWrite(dir), dev: st.dev });
  };

  await add({ id: 'user-cache', label: 'User cache', risk: 'safe', description: `Application caches in ${home}/.cache (pip, build tools, thumbnails). Rebuilt on demand.` },
    path.join(home, '.cache'), (d) => childrenOf(d));
  await add({ id: 'npm-cache', label: 'npm download cache', risk: 'safe', description: `${home}/.npm/_cacache. Packages are downloaded again when needed.` },
    path.join(home, '.npm', '_cacache'), (d) => childrenOf(d));
  await add({ id: 'trash', label: 'Trash', risk: 'safe', description: `Files already deleted from a desktop session (${home}/.local/share/Trash).` },
    path.join(home, '.local', 'share', 'Trash'), (d) => childrenOf(d));
  await add({ id: 'apt-cache', label: 'Downloaded package files (apt)', risk: 'safe', description: 'Installer packages in /var/cache/apt/archives that are already installed.' },
    '/var/cache/apt/archives', (d) => childrenOf(d, (n) => n.endsWith('.deb')));

  const oldLogs = async (d) => {
    const found = [];
    for (const full of await childrenOf(d)) {
      let st;
      try { st = await fsp.lstat(full); } catch { continue; }
      if (st.isFile() && /(\.gz|\.xz|\.bz2|\.old|\.\d+|-\d{8})$/.test(full)) found.push(full);
      else if (st.isDirectory()) {
        for (const inner of await childrenOf(full, (n) => /(\.gz|\.xz|\.bz2|\.old|\.\d+|-\d{8})$/.test(n))) found.push(inner);
      }
    }
    return found;
  };
  await add({ id: 'old-logs', label: 'Rotated system logs', risk: 'safe', description: 'Compressed or numbered old logs in /var/log. Current logs are kept.' },
    '/var/log', oldLogs);

  const tmpBudget = Date.now() + 15000;
  const staleTmp = (dir) => async () => {
    const found = [];
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
  await add({ id: 'tmp-old', label: 'Old temporary files', risk: 'review', description: 'Your files in /tmp and /var/tmp untouched for 7+ days. Check nothing running still needs them.' },
    '/tmp', staleTmp('/tmp'));
  const varTmp = list.find((c) => c.id === 'tmp-old');
  const extra = await safeDirRoot('/var/tmp') ? await staleTmp('/var/tmp')() : [];
  if (extra.length) {
    if (varTmp) varTmp.entries.push(...extra);
    else list.push({ id: 'tmp-old', label: 'Old temporary files', risk: 'review', description: 'Your files in /tmp and /var/tmp untouched for 7+ days. Check nothing running still needs them.', root: '/var/tmp', entries: extra, writable: await canWrite('/var/tmp'), dev: null });
  }

  if (projectsDir) {
    const base = path.resolve(projectsDir);
    const found = [];
    const walk = async (dir, depth) => {
      if (depth > 4 || found.length >= 100) return;
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (!ent.isDirectory()) continue; // symlinks are not directories here, so never followed
        const full = path.join(dir, ent.name);
        if (ent.name === 'node_modules') found.push(full);
        else if (ent.name !== '.git') await walk(full, depth + 1);
      }
    };
    await walk(base, 0);
    // The running panel's own dependencies must never be offered.
    const appDir = path.resolve(__dirname, '..');
    for (const full of found.filter((f) => f !== path.join(appDir, 'node_modules'))) {
      list.push({
        id: `nm:${full}`, label: `node_modules — ${path.relative(base, path.dirname(full)) || path.basename(base)}`, risk: 'review',
        description: 'Installed dependencies. Restore with npm install; stop any running app that uses it first.',
        root: full, entries: [full], writable: await canWrite(path.dirname(full)), dev: null, keepRoot: true,
      });
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

async function cleanupScan(projectsDir) {
  const ctx = { deadline: Date.now() + SCAN_BUDGET_MS, partial: false, unreadable: 0, seen: new Set() };
  const candidates = await cleanupCandidates(projectsDir);
  const fastSizes = await duSizes(candidates.flatMap((c) => c.entries), ctx.deadline).catch(() => null);
  const out = [];
  for (const c of candidates) {
    let size = 0;
    for (const entry of c.entries) {
      if (fastSizes && fastSizes.has(entry)) { size += fastSizes.get(entry); continue; }
      if (Date.now() > ctx.deadline) { ctx.partial = true; break; }
      let st;
      try { st = await fsp.lstat(entry); } catch { continue; }
      ctx.dev = st.dev;
      size += (await measureTree(entry, ctx, null)).size;
    }
    out.push({ id: c.id, label: c.label, description: c.description, risk: c.risk, size, count: c.entries.length, writable: c.writable, path: c.root, samples: c.entries.slice(0, 3).map((e) => path.basename(e)) });
  }
  out.sort((a, b) => b.size - a.size);
  return { candidates: out, partial: ctx.partial, disk: await diskInfo('/') };
}

async function cleanupRun(ids, projectsDir) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('Nothing selected.');
  const wanted = new Set(ids.map(String));
  const candidates = (await cleanupCandidates(projectsDir)).filter((c) => wanted.has(c.id));
  const results = [];
  let freed = 0;
  for (const c of candidates) {
    if (!c.writable) {
      results.push({ id: c.id, freed: 0, removed: 0, errors: ['Not writable by the Citadel user (needs the admin terminal).'] });
      continue;
    }
    const ctx = { deadline: Date.now() + SCAN_BUDGET_MS, partial: false, unreadable: 0, seen: new Set() };
    const errors = [];
    let bytes = 0;
    let removed = 0;
    for (const entry of c.entries) {
      try {
        const st = await fsp.lstat(entry);
        ctx.dev = st.dev;
        const size = (await measureTree(entry, ctx, null)).size;
        await fsp.rm(entry, { recursive: true, force: true });
        bytes += size;
        removed += 1;
      } catch (err) {
        errors.push(`${path.basename(entry)}: ${err.message}`);
      }
    }
    freed += bytes;
    results.push({ id: c.id, freed: bytes, removed, errors: errors.slice(0, 5) });
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
    case 'cleanup-scan': return cleanupScan(req.projectsDir);
    case 'cleanup-run': return cleanupRun(req.ids, req.projectsDir);
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
