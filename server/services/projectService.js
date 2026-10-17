/**
 * NexusVPS Project Management Service
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
        (SELECT COUNT(*) FROM deployments d WHERE d.project_id = p.id) AS deployments_count
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

    return this.getProject(projectId);
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
