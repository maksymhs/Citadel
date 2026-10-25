/**
 * Bounded, on-demand JS/TS file dependency graph. Parses relative static imports
 * without executing project code, following symlinks or requiring Graphify.
 */
const fs = require('node:fs');
const path = require('node:path');
const projectHub = require('./projectHubService');
const logService = require('./logService');
const EXTENSIONS = ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx'];
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'data', 'graphify-out']);
const MAX_FILES = 250;
const MAX_ENTRIES = 3000;
const MAX_BYTES = 128 * 1024;
const CACHE_MS = 30000;
const cache = new Map();

async function graph(id, { refresh = false } = {}) {
  const project = projectHub.projectFor(id);
  const root = await fs.promises.realpath(project.path);
  const cached = cache.get(root);
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const files = new Map();
  let entries = 0, truncated = false, skippedLargeFiles = 0;
  const started = Date.now();
  const pending = [root];
  while (pending.length) {
    const folder = pending.shift();
    let dir;
    try {
      const real = await fs.promises.realpath(folder);
      const relative = path.relative(root, real);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      dir = await fs.promises.opendir(real);
    } catch { continue; }
    for await (const entry of dir) {
      if (++entries > MAX_ENTRIES || files.size >= MAX_FILES || Date.now() - started > 3000) { truncated = true; break; }
      if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const target = path.join(folder, entry.name);
      try {
        const real = await fs.promises.realpath(target);
        const relative = path.relative(root, real);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
        const stat = await fs.promises.lstat(target);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (relative.split(path.sep).length <= 8) pending.push(real);
        } else if (stat.isFile() && EXTENSIONS.includes(path.extname(real))) {
          if (stat.size > MAX_BYTES) { skippedLargeFiles++; continue; }
          const handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          try {
            // Read at most MAX_BYTES even if an agent grows the file mid-scan.
            const buffer = Buffer.alloc(MAX_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0);
            files.set(relative.split(path.sep).join('/'), { content: buffer.toString('utf8', 0, bytesRead), size: bytesRead });
          } finally { await handle.close(); }
        }
      } catch { /* Files can disappear while an agent edits them. */ }
    }
    if (truncated) break;
  }
  const edges = [], seen = new Set();
  for (const [from, file] of files) {
    const imports = file.content.matchAll(/(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|\b(?:require|import)\s*\(\s*)['"]([^'"\n]+)['"]/g);
    for (const match of imports) {
      if (!match[1].startsWith('.')) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), match[1]));
      const candidates = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => base + '/index' + ext)];
      // TS commonly imports a .js path whose source is .ts/.tsx.
      if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
      const to = candidates.find((candidate) => files.has(candidate));
      const key = `${from}\0${to}`;
      if (!to || to === from || seen.has(key)) continue;
      if (edges.length >= 1000) { truncated = true; break; }
      seen.add(key); edges.push({ from, to });
    }
  }
  const value = {
    nodes: [...files].map(([id, file]) => ({ id, size: file.size })), edges,
    generatedAt: new Date().toISOString(), truncated, skippedLargeFiles,
    scope: 'JS/TS relative imports; static approximation, not a call graph',
  };
  if (cache.size >= 10) cache.delete(cache.keys().next().value);
  cache.set(root, { at: Date.now(), value });
  logService.record({ category: 'project', projectId: project.id, action: 'code_graph_built',
    message: `Code graph scanned: ${files.size} files, ${edges.length} dependencies.`,
    details: { nodes: files.size, edges: edges.length, truncated } });
  return value;
}

module.exports = { graph };
