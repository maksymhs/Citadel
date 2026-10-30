/**
 * Project Management HTTP Routes
 */
const path = require('node:path');
const fs = require('node:fs');
const { requireAuth } = require('../security/auth');
const projectService = require('../services/projectService');
const gitService = require('../services/gitService');
const gitCredentialsService = require('../services/gitCredentialsService');
const auditService = require('../services/auditService');
const chatService = require('../services/chatService');
const editorService = require('../services/editorService');
const { PROJECTS_DIR } = require('../config');
const { sanitizeSlug, isInsideBase } = require('../security/guard');

/**
 * Reject anything that is not an http(s) or scp-style git URL before it reaches
 * `git clone`. This is a validation aid, not the security boundary: git runs
 * with structured arguments and no shell, and credentials stay host-scoped.
 */
function validateGitUrl(value) {
  if (!value || typeof value !== 'string' || value.trim() === '') {
    throw new Error('Repository URL is required.');
  }
  const url = value.trim();
  if (/^(https?:\/\/|git@)[^\s]+$/.test(url)) return url;
  throw new Error('Invalid repository URL. Use an https:// URL or an scp-style git@host:path.');
}

async function projectRoutes(fastify) {
  // All project operations require authentication
  fastify.addHook('preHandler', requireAuth);

  // List all projects
  fastify.get('/api/projects', async () => {
    return {
      projects: projectService.listProjects(),
    };
  });

  // Read-only suggestions; importing still uses the explicit audited endpoint.
  fastify.get('/api/projects/discover', async () => projectService.discoverProjects());

  // Unlike suggestion dismissal, this permanently removes an unregistered folder.
  fastify.delete('/api/projects/discover', async (request, reply) => {
    if (request.user.role !== 'admin') {
      return reply.status(403).send({ error: 'Administrator privileges are required.' });
    }
    const { targetPath, confirmPath } = request.body || {};
    try {
      const result = projectService.deleteDiscoveredFolder({ targetPath, confirmPath });
      auditService.logAction({
        userId: request.user.id,
        action: 'detected_folder_deleted',
        targetType: 'directory',
        targetId: result.path,
        details: { path: result.path, filesDeleted: true },
        ip: request.ip,
      });
      return result;
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // Get project by ID or slug
  fastify.get('/api/projects/:id', async (request, reply) => {
    const project = projectService.getProject(request.params.id);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found.' });
    }
    return { project };
  });

  // Create local project
  fastify.post('/api/projects', async (request, reply) => {
    const { name, slug, description } = request.body || {};
    try {
      const project = projectService.createProject({ name, slug, description });
      auditService.logAction({
        userId: request.user.id,
        action: 'project_created',
        targetType: 'project',
        targetId: project.id,
        details: { name: project.name, path: project.path },
        ip: request.ip,
      });
      return { project };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Import existing host directory
  fastify.post('/api/projects/import', async (request, reply) => {
    const { name, targetPath, slug, description } = request.body || {};
    try {
      const project = projectService.importProject({ name, targetPath, slug, description });
      auditService.logAction({
        userId: request.user.id,
        action: 'project_imported',
        targetType: 'project',
        targetId: project.id,
        details: { name: project.name, path: project.path },
        ip: request.ip,
      });
      return { project };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Clone Git repository into projects directory as a new project
  fastify.post('/api/projects/clone', async (request, reply) => {
    const { repoUrl, name, slug, branch, description } = request.body || {};

    try {
      const cleanUrl = validateGitUrl(repoUrl);
      const derivedName = name || cleanUrl.split('/').pop().replace(/\.git$/, '');
      const cleanSlug = sanitizeSlug(slug || derivedName);
      const targetDir = path.join(PROJECTS_DIR, cleanSlug);

      // Never overwrite an existing directory.
      if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
        return reply.status(409).send({ error: `Destination directory already exists and is not empty: ${targetDir}` });
      }

      // Perform clone (using stored provider credentials when available)
      const auth = gitCredentialsService.resolveAuthForUrl(cleanUrl);
      await gitService.clone(cleanUrl, targetDir, branch, auth);

      // Register as project
      const project = projectService.importProject({
        name: derivedName,
        targetPath: targetDir,
        slug: cleanSlug,
        description: description || `Cloned from ${cleanUrl}`,
      });

      // Update git remote info (project row and primary repository row).
      projectService.updateProject(project.id, {
        gitRemote: cleanUrl,
        gitBranch: branch || 'main',
      });
      const [primary] = projectService.listRepos(project.id);
      if (primary) projectService.updateRepoGitMeta(project.id, primary.id, { gitRemote: cleanUrl, gitBranch: branch || 'main' });

      auditService.logAction({
        userId: request.user.id,
        action: 'project_cloned',
        targetType: 'project',
        targetId: project.id,
        details: { repoUrl: cleanUrl, path: targetDir },
        ip: request.ip,
      });

      return { project: projectService.getProject(project.id) };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // --- Repositories within a project ---------------------------------------

  fastify.get('/api/projects/:id/repos', async (request, reply) => {
    const project = projectService.getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found.' });
    return { repos: projectService.listRepos(project.id) };
  });

  // Associate an existing directory on disk (no move, no overwrite).
  fastify.post('/api/projects/:id/repos', async (request, reply) => {
    const { targetPath, name, gitRemote, gitBranch } = request.body || {};
    try {
      const repo = projectService.addRepo({
        projectId: request.params.id,
        targetPath,
        name,
        gitRemote: gitRemote || null,
        gitBranch: gitBranch || null,
      });
      auditService.logAction({
        userId: request.user.id,
        action: 'repo_associated',
        targetType: 'repository',
        targetId: repo.id,
        details: { projectId: request.params.id, path: repo.path },
        ip: request.ip,
      });
      return { repo };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Clone a repository into an existing project (as a subdirectory) or into the
  // project root when it has no repository of its own yet.
  fastify.post('/api/projects/:id/repos/clone', async (request, reply) => {
    const { repoUrl, name, branch } = request.body || {};
    const project = projectService.getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found.' });

    try {
      const cleanUrl = validateGitUrl(repoUrl);
      const derivedName = (name && String(name).trim()) || cleanUrl.split('/').pop().replace(/\.git$/, '');
      const cleanSlug = sanitizeSlug(derivedName);
      const existing = projectService.listRepos(project.id);
      const targetDir = existing.length === 0
        ? project.path
        : path.join(project.path, cleanSlug);

      // Never clone over an existing, non-empty directory.
      if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
        return reply.status(409).send({ error: `Destination directory already exists and is not empty: ${targetDir}` });
      }
      // Defence in depth: a crafted name must still resolve inside the project.
      if (!isInsideBase(path.resolve(project.path), path.resolve(targetDir))) {
        return reply.status(400).send({ error: 'Refusing to clone outside the project directory.' });
      }

      const auth = gitCredentialsService.resolveAuthForUrl(cleanUrl);
      await gitService.clone(cleanUrl, targetDir, branch, auth);

      const repo = projectService.registerClonedRepo({
        projectId: project.id,
        targetPath: targetDir,
        name: derivedName,
        gitRemote: cleanUrl,
        gitBranch: branch || 'main',
      });

      auditService.logAction({
        userId: request.user.id,
        action: 'repo_cloned',
        targetType: 'repository',
        targetId: repo.id,
        details: { projectId: project.id, repoUrl: cleanUrl, path: targetDir },
        ip: request.ip,
      });

      return { repo };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Unlink a repository. Files are preserved unless explicitly requested.
  fastify.delete('/api/projects/:id/repos/:repoId', async (request, reply) => {
    const deleteFiles = request.query?.deleteFiles === 'true';
    try {
      const res = projectService.removeRepo(request.params.id, request.params.repoId, { deleteFiles });
      auditService.logAction({
        userId: request.user.id,
        action: 'repo_removed',
        targetType: 'repository',
        targetId: request.params.repoId,
        details: { projectId: request.params.id, deleteFiles },
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Git status/history/pull scoped to a single repository.
  fastify.get('/api/projects/:id/repos/:repoId/git/status', async (request, reply) => {
    const repo = projectService.getRepo(request.params.id, request.params.repoId);
    if (!repo) return reply.status(404).send({ error: 'Repository not found.' });
    return { status: await gitService.getStatus(repo.path) };
  });

  fastify.get('/api/projects/:id/repos/:repoId/git/commits', async (request, reply) => {
    const repo = projectService.getRepo(request.params.id, request.params.repoId);
    if (!repo) return reply.status(404).send({ error: 'Repository not found.' });
    const limit = parseInt(request.query?.limit, 10) || 10;
    return { commits: await gitService.getRecentCommits(repo.path, limit) };
  });

  fastify.post('/api/projects/:id/repos/:repoId/git/pull', async (request, reply) => {
    const repo = projectService.getRepo(request.params.id, request.params.repoId);
    if (!repo) return reply.status(404).send({ error: 'Repository not found.' });
    try {
      const auth = repo.git_remote ? gitCredentialsService.resolveAuthForUrl(repo.git_remote) : null;
      const res = await gitService.pull(repo.path, auth);
      auditService.logAction({
        userId: request.user.id,
        action: 'git_pull',
        targetType: 'repository',
        targetId: repo.id,
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Update project
  fastify.put('/api/projects/:id', async (request, reply) => {
    try {
      const updated = projectService.updateProject(request.params.id, request.body || {});
      return { project: updated };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Delete project
  fastify.delete('/api/projects/:id', async (request, reply) => {
    const deleteFiles = request.query?.deleteFiles === 'true';
    try {
      const project = projectService.getProject(request.params.id);
      if (!project) return reply.status(404).send({ error: 'Project not found.' });
      const res = await chatService.withProjectRemoval(project.id, () => {
        if (editorService.status().running) throw Object.assign(new Error('Stop the shared editor before project removal.'), { statusCode: 409 });
        return projectService.deleteProject(project.id, { deleteFiles });
      });
      auditService.logAction({
        userId: request.user.id,
        action: 'project_deleted',
        targetType: 'project',
        targetId: request.params.id,
        details: { deleteFiles },
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // Git operations for a project
  fastify.get('/api/projects/:id/git/status', async (request, reply) => {
    const project = projectService.getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found.' });

    const status = await gitService.getStatus(project.path);
    return { status };
  });

  fastify.get('/api/projects/:id/git/commits', async (request, reply) => {
    const project = projectService.getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found.' });

    const limit = parseInt(request.query?.limit, 10) || 10;
    const commits = await gitService.getRecentCommits(project.path, limit);
    return { commits };
  });

  fastify.post('/api/projects/:id/git/pull', async (request, reply) => {
    const project = projectService.getProject(request.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found.' });

    try {
      const auth = project.git_remote ? gitCredentialsService.resolveAuthForUrl(project.git_remote) : null;
      const res = await gitService.pull(project.path, auth);
      auditService.logAction({
        userId: request.user.id,
        action: 'git_pull',
        targetType: 'project',
        targetId: project.id,
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = projectRoutes;
