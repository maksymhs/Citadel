/**
 * Citadel Docs Service — a small Markdown wiki per project.
 *
 * The Markdown body is the source of truth and lives in the project checkout,
 * so it is versioned by the project's own Git history. SQLite stores only
 * metadata and links (task, mission, title). Nothing is created until the first
 * page is written, and an existing file is never overwritten by initialisation.
 *
 * Every path is resolved against the canonical project directory and the
 * canonical documentation root; symlinks may not escape either. Only Markdown
 * files are readable or writable through this service.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDatabase } = require('../database/db');
const { DOCS_SUBDIR } = require('../config');
const projectService = require('./projectService');
const gitService = require('./gitService');
const logService = require('./logService');

const MAX_BYTES = 512 * 1024;
const MAX_FILES = 500;
const MAX_DEPTH = 5;
const EXTENSIONS = new Set(['.md', '.markdown']);
const SECRET_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+|(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/;

function nowIso() {
  return new Date().toISOString();
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function cleanSubdir(value) {
  const raw = String(value || DOCS_SUBDIR || 'docs').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw || raw.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid documentation directory.');
  }
  return raw;
}

function requireProject(projectId) {
  const project = projectId ? projectService.getProject(String(projectId)) : null;
  if (!project) throw new Error('Project not found.');
  if (!fs.existsSync(project.path)) throw new Error('The project directory does not exist on this host.');
  return project;
}

/**
 * Resolve the documentation root. `create` is only true for a write, so merely
 * opening the Docs view never adds a directory to a checkout.
 */
function docsRoot(project, { create = false } = {}) {
  const projectReal = fs.realpathSync(project.path);
  const root = path.resolve(projectReal, cleanSubdir(project.docsDir || DOCS_SUBDIR));
  if (!isInside(projectReal, root)) throw new Error('Invalid documentation directory.');
  if (create && !fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(root)) return { root, projectReal, exists: false };
  const real = fs.realpathSync(root);
  if (!isInside(projectReal, real)) throw new Error('Documentation directory escapes the project.');
  return { root: real, projectReal, exists: true };
}

function normaliseRel(relPath) {
  const clean = String(relPath || '').replace(/\\/g, '/').trim();
  if (!clean || clean.includes('\0') || clean.startsWith('/') || clean.split('/').some((p) => p === '..' || p === '')) {
    throw new Error('Invalid document path.');
  }
  const ext = path.extname(clean).toLowerCase();
  if (!EXTENSIONS.has(ext)) throw new Error('Only Markdown documents are supported.');
  return clean;
}

function resolveDoc(project, relPath, { create = false } = {}) {
  const clean = normaliseRel(relPath);
  const { root, projectReal } = docsRoot(project, { create });
  const abs = path.resolve(root, clean);
  if (!isInside(root, abs) || !isInside(projectReal, abs)) throw new Error('Invalid document path.');
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    if (!isInside(root, real)) throw new Error('Invalid document path.');
    return { abs: real, clean };
  }
  const parent = path.dirname(abs);
  if (create) {
    fs.mkdirSync(parent, { recursive: true });
    const realParent = fs.realpathSync(parent);
    if (!isInside(root, realParent)) throw new Error('Invalid document path.');
  }
  return { abs, clean };
}

/**
 * Resolve a candidate path only if it names an existing Markdown document
 * inside the project's docs root. Used by task-result linking, where a stale or
 * hostile path must be ignored rather than thrown. Returns null when absent.
 */
function existingDoc({ projectId, relPath } = {}) {
  try {
    const project = requireProject(projectId);
    const { abs, clean } = resolveDoc(project, relPath);
    if (!fs.existsSync(abs)) return null;
    if (!fs.statSync(abs).isFile() || fs.statSync(abs).size > MAX_BYTES) return null;
    return clean;
  } catch {
    return null;
  }
}

function titleFrom(content, fallback) {
  const line = String(content || '').split(/\r?\n/).find((l) => /^#\s+/.test(l));
  if (line) return line.replace(/^#\s+/, '').trim().slice(0, 200);
  return path.basename(fallback, path.extname(fallback)).replace(/[-_]+/g, ' ').slice(0, 200);
}

/** Normalise a `[[wiki link]]` target into a document-relative path. */
function linkTarget(raw) {
  let target = String(raw || '').trim().replace(/\\/g, '/');
  if (!target || target.startsWith('/') || target.includes('\0')) return null;
  if (!path.extname(target)) target += '.md';
  try {
    return normaliseRel(target);
  } catch {
    return null;
  }
}

/** Sync Markdown links incrementally; references accumulate across attempts. */
function syncRelations(projectId, relPath, content, { taskId, missionId } = {}) {
  const db = getDatabase();
  const now = nowIso();
  const pid = String(projectId);
  const targets = new Set();
  for (const match of String(content || '').matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) {
    const target = linkTarget(match[1]);
    if (target && target !== relPath) targets.add(target);
  }
  db.transaction(() => {
    const existing = new Set(db.prepare('SELECT to_path FROM document_links WHERE project_id = ? AND from_path = ?').all(pid, relPath).map((row) => row.to_path));
    const remove = db.prepare('DELETE FROM document_links WHERE project_id = ? AND from_path = ? AND to_path = ?');
    for (const target of existing) if (!targets.has(target)) remove.run(pid, relPath, target);
    const insert = db.prepare(`INSERT INTO document_links (id, project_id, from_path, to_path, created_at)
      VALUES (?, ?, ?, ?, ?)`);
    for (const target of targets) if (!existing.has(target)) insert.run(crypto.randomUUID(), pid, relPath, target, now);
    const hasRef = db.prepare('SELECT 1 FROM document_refs WHERE project_id = ? AND path = ? AND kind = ? AND ref_id = ?');
    const addRef = db.prepare(`INSERT INTO document_refs (id, project_id, path, kind, ref_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [kind, id] of [['task', taskId], ['mission', missionId]]) {
      if (id && !hasRef.get(pid, relPath, kind, String(id))) addRef.run(crypto.randomUUID(), pid, relPath, kind, String(id), now);
    }
  })();
}

function relationsFor(projectId, relPath) {
  const db = getDatabase();
  const links = db.prepare(`
    SELECT to_path FROM document_links
    WHERE project_id = ? AND from_path = ? ORDER BY to_path
  `).all(String(projectId), relPath).map((row) => row.to_path);
  const backlinks = db.prepare(`
    SELECT from_path FROM document_links
    WHERE project_id = ? AND to_path = ? ORDER BY from_path
  `).all(String(projectId), relPath).map((row) => row.from_path);
  const refs = db.prepare(`
    SELECT kind, ref_id FROM document_refs
    WHERE project_id = ? AND path = ? ORDER BY kind, ref_id
  `).all(String(projectId), relPath).map((row) => ({ kind: row.kind, id: row.ref_id }));
  return { links, backlinks, refs };
}

function upsertMeta({ projectId, relPath, title, taskId, missionId, createdBy, updatedAt }) {
  const db = getDatabase();
  const now = nowIso();
  db.prepare(`
    INSERT INTO documents (id, project_id, path, title, task_id, mission_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, path) DO UPDATE SET
      title = excluded.title,
      task_id = COALESCE(excluded.task_id, documents.task_id),
      mission_id = COALESCE(excluded.mission_id, documents.mission_id),
      updated_at = excluded.updated_at
    WHERE documents.title IS NOT excluded.title
      OR documents.updated_at IS NOT excluded.updated_at
      OR documents.task_id IS NOT COALESCE(excluded.task_id, documents.task_id)
      OR documents.mission_id IS NOT COALESCE(excluded.mission_id, documents.mission_id)
  `).run(
    crypto.randomUUID(), String(projectId), relPath, title || null,
    taskId ? String(taskId) : null, missionId ? String(missionId) : null,
    createdBy ? String(createdBy) : null, updatedAt || now, updatedAt || now,
  );
  return db.prepare('SELECT * FROM documents WHERE project_id = ? AND path = ?').get(String(projectId), relPath);
}

function toPublic(row, extra = {}) {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    title: row.title || path.basename(row.path, path.extname(row.path)),
    taskId: row.task_id || null,
    missionId: row.mission_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

function walk(root, projectRoot, prefix = '', depth = 0, out = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries;
  try { entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(root, rel);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(root, projectRoot, rel, depth + 1, out);
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const stat = fs.statSync(abs);
      if (stat.size <= MAX_BYTES && isInside(projectRoot, abs)) out.push({ rel, abs, stat });
    }
  }
  return out;
}

async function gitStatus(project, root) {
  try {
    const status = await gitService.getStatus(project.path);
    if (!status.isGitRepo) return { isGitRepo: false, pending: [] };
    const docsPrefix = path.relative(project.path, root).replace(/\\/g, '/');
    const pending = [
      ...(status.modifiedFiles || []).map((f) => ({ path: f.file, status: f.status })),
      ...(status.untrackedFiles || []).map((f) => ({ path: f, status: '??' })),
    ].filter((f) => f.path === docsPrefix || f.path.startsWith(`${docsPrefix}/`));
    return { isGitRepo: true, branch: status.branch, pending };
  } catch (err) {
    return { isGitRepo: true, pending: [], error: err.message };
  }
}

async function listDocs({ projectId, q, limit = 200 } = {}) {
  const project = requireProject(projectId);
  const { root, exists } = docsRoot(project);
  if (!exists) return { docs: [], git: { isGitRepo: fs.existsSync(path.join(project.path, '.git')), pending: [] }, root: null };
  const files = walk(root, fs.realpathSync(project.path));
  const git = await gitStatus(project, root);
  const pendingSet = new Set(git.pending.map((p) => p.path));
  const isPending = (gitRel) => pendingSet.has(gitRel)
    || git.pending.some((entry) => entry.path.endsWith('/') && gitRel.startsWith(entry.path));
  const term = String(q || '').trim().toLowerCase();
  const docs = [];
  for (const file of files) {
    if (docs.length >= Math.min(Math.max(parseInt(limit, 10) || 200, 1), MAX_FILES)) break;
    let content = '';
    try { content = fs.readFileSync(file.abs, 'utf8'); } catch { continue; }
    if (term && !`${file.rel}\n${content}`.toLowerCase().includes(term)) continue;
    const title = titleFrom(content, file.rel);
    const meta = upsertMeta({ projectId: project.id, relPath: file.rel, title, updatedAt: file.stat.mtime.toISOString() });
    const gitRel = path.relative(project.path, file.abs).replace(/\\/g, '/');
    docs.push(toPublic(meta, {
      size: file.stat.size,
      modifiedAt: file.stat.mtime.toISOString(),
      pending: isPending(gitRel),
      gitPath: gitRel,
      excerpt: content.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(0, 2).join(' ').slice(0, 180),
    }));
  }
  return { docs, git, root: path.relative(project.path, root).replace(/\\/g, '/') };
}

function readDoc({ projectId, relPath, path: pathField }) {
  relPath = relPath || pathField;
  const project = requireProject(projectId);
  const { abs, clean } = resolveDoc(project, relPath);
  if (!fs.existsSync(abs)) throw new Error('Document not found.');
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('Not a file.');
  if (stat.size > MAX_BYTES) throw new Error('Document is too large to display.');
  const content = fs.readFileSync(abs, 'utf8');
  const title = titleFrom(content, clean);
  const meta = upsertMeta({ projectId: project.id, relPath: clean, title, updatedAt: stat.mtime.toISOString() });
  syncRelations(project.id, clean, content);
  const gitRel = path.relative(project.path, abs).replace(/\\/g, '/');
  return toPublic(meta, {
    content,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    gitPath: gitRel,
    ...relationsFor(project.id, clean),
  });
}

function assertSafeContent(content) {
  const text = String(content || '');
  if (text.length > MAX_BYTES) throw new Error('Document is too large.');
  if (SECRET_PATTERN.test(text)) {
    throw new Error('Refusing to write a document that looks like it contains a credential.');
  }
  return text;
}

function createDoc({ projectId, relPath, path: pathField, title, content, taskId, missionId, createdBy } = {}) {
  relPath = relPath || pathField;
  const project = requireProject(projectId);
  const { abs, clean } = resolveDoc(project, relPath, { create: true });
  if (fs.existsSync(abs)) throw new Error('A document already exists at that path; open it to edit instead.');
  const body = assertSafeContent(content || `# ${title || titleFrom('', clean)}\n\n`);
  fs.writeFileSync(abs, body, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  const stat = fs.statSync(abs);
  const meta = upsertMeta({
    projectId: project.id, relPath: clean, title: title || titleFrom(body, clean),
    taskId, missionId, createdBy, updatedAt: stat.mtime.toISOString(),
  });
  syncRelations(project.id, clean, body, { taskId, missionId });
  logService.record({
    category: 'docs', action: 'document_created',
    message: `Created document ${clean} in project ${project.name}.`,
    details: { projectId: project.id, path: clean, taskId: taskId || null },
  });
  return toPublic(meta, { content: body });
}

function updateDoc({ projectId, relPath, path: pathField, content, title, taskId, missionId, expectedUpdatedAt } = {}) {
  relPath = relPath || pathField;
  const project = requireProject(projectId);
  const { abs, clean } = resolveDoc(project, relPath);
  if (!fs.existsSync(abs)) throw new Error('Document not found; create it instead.');
  const stat = fs.statSync(abs);
  const current = stat.mtime.toISOString();
  if (expectedUpdatedAt && String(expectedUpdatedAt) !== current) {
    const err = new Error('The document changed since it was loaded; reload before saving.');
    err.statusCode = 409;
    throw err;
  }
  const body = assertSafeContent(content);
  fs.writeFileSync(abs, body, { encoding: 'utf8', mode: 0o644 });
  const next = fs.statSync(abs);
  const meta = upsertMeta({
    projectId: project.id, relPath: clean, title: title || titleFrom(body, clean),
    taskId, missionId, updatedAt: next.mtime.toISOString(),
  });
  syncRelations(project.id, clean, body, { taskId, missionId });
  logService.record({
    category: 'docs', action: 'document_updated',
    message: `Updated document ${clean} in project ${project.name}.`,
    details: { projectId: project.id, path: clean, taskId: taskId || null },
  });
  return toPublic(meta, { content: body, modifiedAt: next.mtime.toISOString() });
}

function linkDoc({ projectId, relPath, path: pathField, taskId, missionId }) {
  relPath = relPath || pathField;
  const project = requireProject(projectId);
  const { abs, clean } = resolveDoc(project, relPath);
  const db = getDatabase();
  // Agents write Markdown directly, so register it before attaching refs.
  const doc = readDoc({ projectId: project.id, relPath: clean });
  const existing = { id: doc.id };
  db.prepare('UPDATE documents SET task_id = COALESCE(?, task_id), mission_id = COALESCE(?, mission_id), updated_at = ? WHERE id = ?')
    .run(taskId ? String(taskId) : null, missionId ? String(missionId) : null, nowIso(), existing.id);
  const body = fs.readFileSync(abs, 'utf8');
  syncRelations(project.id, clean, body, { taskId, missionId });
  return toPublic(db.prepare('SELECT * FROM documents WHERE id = ?').get(existing.id), relationsFor(project.id, clean));
}

function relevantDocs({ projectId, q, limit = 12 } = {}) {
  // Synchronous, bounded variant used to build a planner prompt. It never
  // creates anything; Git status is intentionally not part of planning.
  const project = requireProject(projectId);
  const { root, exists } = docsRoot(project);
  if (!exists) return [];
  const term = String(q || '').toLowerCase();
  return walk(root, fs.realpathSync(project.path))
    .map((file) => {
      let content = '';
      try { content = fs.readFileSync(file.abs, 'utf8'); } catch { return null; }
      return { path: file.rel, title: titleFrom(content, file.rel), content };
    })
    .filter(Boolean)
    .filter((doc) => !term || `${doc.path} ${doc.title} ${doc.content}`.toLowerCase().includes(term))
    .slice(0, Math.min(Math.max(limit, 1), 40))
    .map((doc) => ({ path: doc.path, title: doc.title }));
}

module.exports = {
  listDocs,
  readDoc,
  createDoc,
  updateDoc,
  linkDoc,
  existingDoc,
  relevantDocs,
  relationsFor,
  docsRoot,
};
