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
 * Request:  { "op": "list"|"read"|"write"|"mkdir"|"rename"|"remove"|"stat", ... }
 * Response: { "ok": true, "data": ... } | { "ok": false, "error": "..." }
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
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

async function handle(req) {
  switch (req.op) {
    case 'list': return listDir(req.path);
    case 'read': return readFile(req.path);
    case 'write': return writeFile(req.path, req.content, req.encoding);
    case 'mkdir': return mkdir(req.path);
    case 'rename': return rename(req.from, req.to);
    case 'remove': return remove(req.path);
    case 'stat': return statPath(req.path);
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
