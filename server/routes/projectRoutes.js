/**
 * Project Management HTTP Routes
 */
const path = require('node:path');
const { requireAuth } = require('../security/auth');
const projectService = require('../services/projectService');
const gitService = require('../services/gitService');
const auditService = require('../services/auditService');
const { PROJECTS_DIR } = require('../config');
const { sanitizeSlug } = require('../security/guard');

async function projectRoutes(fastify) {
  // All project operations require authentication
  fastify.addHook('preHandler', requireAuth);

  // List all projects
  fastify.get('/api/projects', async () => {
    return {
      projects: projectService.listProjects(),
    };
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

  // Clone Git repository into projects directory
  fastify.post('/api/projects/clone', async (request, reply) => {
    const { repoUrl, name, slug, branch, description } = request.body || {};
    if (!repoUrl) {
      return reply.status(400).send({ error: 'Repository URL is required.' });
    }

    try {
      const derivedName = name || repoUrl.split('/').pop().replace(/\.git$/, '');
      const cleanSlug = sanitizeSlug(slug || derivedName);
      const targetDir = path.join(PROJECTS_DIR, cleanSlug);

      // Perform clone
      await gitService.clone(repoUrl, targetDir, branch);

      // Register as project
      const project = projectService.importProject({
        name: derivedName,
        targetPath: targetDir,
        slug: cleanSlug,
        description: description || `Cloned from ${repoUrl}`,
      });

      // Update git remote info
      projectService.updateProject(project.id, {
        gitRemote: repoUrl,
        gitBranch: branch || 'main',
      });

      auditService.logAction({
        userId: request.user.id,
        action: 'project_cloned',
        targetType: 'project',
        targetId: project.id,
        details: { repoUrl, path: targetDir },
        ip: request.ip,
      });

      return { project: projectService.getProject(project.id) };
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
      const res = projectService.deleteProject(request.params.id, { deleteFiles });
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
      return reply.status(400).send({ error: err.message });
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
      const res = await gitService.pull(project.path);
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
