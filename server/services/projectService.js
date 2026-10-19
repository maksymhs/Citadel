/**
 * Citadel Project Management Service
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDatabase } = require('../database/db');
const { PROJECTS_DIR } = require('../config');
const { sanitizeSlug, validateSafePath } = require('../security/guard');

class ProjectService {
  /**
   * List all projects with active session counts and disk existence
   */
  listProjects() {
    const db = getDatabase();
    const projects = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM term_sessions s WHERE s.project_id = p.id AND s.status = 'active') AS active_sessions_count,
        (SELECT COUNT(*) FROM deployments d WHERE d.project_id = p.id) AS deployments_count,
        (SELECT COUNT(*) FROM project_repos r WHERE r.project_id = p.id) AS repos_count
      FROM projects p
      ORDER BY p.updated_at DESC
    `).all();

    return projects.map((p) => ({
      ...p,
      existsOnDisk: fs.existsSync(p.path),
    }));
  }

  /**
   * Get a single project by ID or slug
   */
  getProject(idOrSlug) {
    const db = getDatabase();
    const project = db.prepare(`
      SELECT * FROM projects WHERE id = ? OR slug = ?
    `).get(idOrSlug, idOrSlug);

    if (!project) return null;

    return {
      ...project,
      existsOnDisk: fs.existsSync(project.path),
    };
  }

  /**
   * Create a new local project in the default projects directory
   */
  createProject({ name, slug = null, description = '' }) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Project name is required.');
    }

    const cleanName = name.trim();
    const cleanSlug = sanitizeSlug(slug || cleanName);
    const projectPath = path.join(PROJECTS_DIR, cleanSlug);

    // Verify it doesn't already exist in database
    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM projects WHERE slug = ? OR path = ?').get(cleanSlug, projectPath);
    if (existing) {
      throw new Error(`Project with slug "${cleanSlug}" already exists.`);
    }

    // Create directory on disk
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true });
    }

    const projectId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO projects (id, name, slug, description, path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, cleanName, cleanSlug, description || '', projectPath, now, now);

    // Every project owns at least one repository (its working directory).
    this._insertRepo({ projectId, name: cleanName, path: projectPath, isPrimary: true });

    return this.getProject(projectId);
  }

  /**
   * Import an existing directory on the host as a project
   */
  importProject({ name, targetPath, slug = null, description = '' }) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Project name is required.');
    }

    if (!targetPath || typeof targetPath !== 'string') {
      throw new Error('Valid target directory path is required.');
    }

    const absolutePath = path.resolve(targetPath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Directory does not exist: ${absolutePath}`);
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error(`Specified path is not a directory: ${absolutePath}`);
    }

    // Canonical resolution
    const canonicalPath = fs.realpathSync(absolutePath);

    const cleanName = name.trim();
    const cleanSlug = sanitizeSlug(slug || cleanName);

    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM projects WHERE slug = ? OR path = ?').get(cleanSlug, canonicalPath);
    if (existing) {
      throw new Error(`Project with slug "${cleanSlug}" or path "${canonicalPath}" is already registered.`);
    }

    const projectId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO projects (id, name, slug, description, path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, cleanName, cleanSlug, description || '', canonicalPath, now, now);

    this._insertRepo({ projectId, name: cleanName, path: canonicalPath, isPrimary: true });

    return this.getProject(projectId);
  }

  // --- Repositories ---------------------------------------------------------

  _insertRepo({ projectId, name, path: repoPath, gitRemote = null, gitBranch = null, isPrimary = false }) {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO project_repos
        (id, project_id, name, path, git_remote, git_branch, is_primary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, name, repoPath, gitRemote, gitBranch, isPrimary ? 1 : 0, now, now);
    return id;
  }

  /**
   * List the repositories owned by a project, with their on-disk status.
   */
  listRepos(projectId) {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT * FROM project_repos WHERE project_id = ?
      ORDER BY is_primary DESC, name COLLATE NOCASE ASC
    `).all(projectId);

    return rows.map((r) => ({
      ...r,
      is_primary: Boolean(r.is_primary),
      existsOnDisk: fs.existsSync(r.path),
    }));
  }

  getRepo(projectId, repoId) {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM project_repos WHERE id = ? AND project_id = ?').get(repoId, projectId);
    if (!row) return null;
    return { ...row, is_primary: Boolean(row.is_primary), existsOnDisk: fs.existsSync(row.path) };
  }

  /**
   * Associate an existing directory on disk as a repository of a project,
   * without moving it. The directory must exist, be unique and (to avoid
   * confusing state) must not already belong to another project.
   */
  addRepo({ projectId, targetPath, name = null, gitRemote = null, gitBranch = null }) {
    const project = this.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    if (!targetPath || typeof targetPath !== 'string') {
      throw new Error('A repository directory path is required.');
    }

    const absolutePath = path.resolve(targetPath);
    if (!fs.existsSync(absolutePath)) throw new Error(`Directory does not exist: ${absolutePath}`);
    if (!fs.statSync(absolutePath).isDirectory()) throw new Error(`Not a directory: ${absolutePath}`);
    const canonicalPath = fs.realpathSync(absolutePath);

    const db = getDatabase();
    const owned = db.prepare('SELECT project_id FROM project_repos WHERE path = ?').get(canonicalPath);
    if (owned && owned.project_id !== projectId) {
      throw new Error('This directory is already a repository of another project.');
    }
    if (owned) throw new Error('This directory is already part of this project.');

    const cleanName = (name && String(name).trim()) || path.basename(canonicalPath);
    const hasRepos = db.prepare('SELECT COUNT(*) AS c FROM project_repos WHERE project_id = ?').get(projectId).c > 0;
    const id = this._insertRepo({
      projectId, name: cleanName, path: canonicalPath, gitRemote, gitBranch, isPrimary: !hasRepos,
    });
    return this.getRepo(projectId, id);
  }

  /**
   * Register a repository that was just cloned into a project directory.
   */
  registerClonedRepo({ projectId, targetPath, name, gitRemote = null, gitBranch = null }) {
    return this.addRepo({ projectId, targetPath, name, gitRemote, gitBranch });
  }

  updateRepoGitMeta(projectId, repoId, { gitRemote, gitBranch }) {
    const repo = this.getRepo(projectId, repoId);
    if (!repo) throw new Error('Repository not found.');
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE project_repos SET git_remote = ?, git_branch = ?, updated_at = ? WHERE id = ?
    `).run(
      gitRemote !== undefined ? gitRemote : repo.git_remote,
      gitBranch !== undefined ? gitBranch : repo.git_branch,
      now,
      repoId,
    );
    return this.getRepo(projectId, repoId);
  }

  /**
   * Unlink a repository from a project. Files are preserved by default; when
   * deletion is explicitly requested it is restricted to the managed projects
   * tree.
   */
  removeRepo(projectId, repoId, { deleteFiles = false } = {}) {
    const repo = this.getRepo(projectId, repoId);
    if (!repo) throw new Error('Repository not found.');

    const db = getDatabase();
    db.prepare('DELETE FROM project_repos WHERE id = ?').run(repoId);

    // Keep exactly one primary repository so listings stay predictable.
    const remaining = db.prepare('SELECT id FROM project_repos WHERE project_id = ? ORDER BY is_primary DESC, name ASC').all(projectId);
    if (remaining.length > 0) {
      db.prepare('UPDATE project_repos SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE project_id = ?')
        .run(remaining[0].id, projectId);
    }

    if (deleteFiles === true && repo.path !== (this.getProject(projectId) || {}).path) {
      try {
        const validated = validateSafePath(repo.path, PROJECTS_DIR);
        if (fs.existsSync(validated)) fs.rmSync(validated, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[ProjectService] Refused to delete repo path ${repo.path}: ${err.message}`);
      }
    }

    return { success: true, id: repoId, filesDeleted: deleteFiles };
  }

  /**
   * Update project metadata
   */
  updateProject(id, { name, description, gitRemote, gitBranch }) {
    const project = this.getProject(id);
    if (!project) throw new Error('Project not found.');

    const cleanName = name ? name.trim() : project.name;
    const cleanDesc = description !== undefined ? description : project.description;
    const cleanRemote = gitRemote !== undefined ? gitRemote : project.git_remote;
    const cleanBranch = gitBranch !== undefined ? gitBranch : project.git_branch;
    const now = new Date().toISOString();

    const db = getDatabase();
    db.prepare(`
      UPDATE projects
      SET name = ?, description = ?, git_remote = ?, git_branch = ?, updated_at = ?
      WHERE id = ?
    `).run(cleanName, cleanDesc, cleanRemote, cleanBranch, now, project.id);

    return this.getProject(project.id);
  }

  /**
   * Delete a project from database.
   * By default, DOES NOT delete repository files on disk to prevent accidental data loss.
   */
  deleteProject(id, { deleteFiles = false } = {}) {
    const project = this.getProject(id);
    if (!project) throw new Error('Project not found.');

    const db = getDatabase();
    // Delete project from database (cascades or set null to sessions & deployments)
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    // Optionally delete from disk ONLY if explicitly requested AND path is inside PROJECTS_DIR
    if (deleteFiles === true) {
      try {
        const validatedPath = validateSafePath(project.path, PROJECTS_DIR);
        if (fs.existsSync(validatedPath)) {
          fs.rmSync(validatedPath, { recursive: true, force: true });
        }
      } catch (err) {
        console.warn(`[ProjectService] Could not remove files on disk for project ${project.id}:`, err.message);
      }
    }

    return { success: true, id: project.id, filesDeleted: deleteFiles };
  }
}

module.exports = new ProjectService();
