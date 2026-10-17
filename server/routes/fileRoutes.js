/**
 * Filesystem browsing and editing routes.
 *
 * Powerful by design: when the panel is configured with an admin user
 * (`install.sh --admin-terminal`), these endpoints can read and write anywhere
 * on the host. Access is limited to authenticated panel sessions and write
 * operations are audited.
 */
const path = require('node:path');
const { requireAuth } = require('../security/auth');
const fileService = require('../services/fileService');
const auditService = require('../services/auditService');

function requirePath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    const err = new Error('A path is required.');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

async function fileRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // Whether the explorer can reach the whole host (admin user configured).
  fastify.get('/api/files/capabilities', async () => ({
    privileged: fileService.isPrivileged(),
    root: '/',
  }));

  // List a directory.
  fastify.get('/api/files', async (request, reply) => {
    try {
      const target = request.query?.path || '/';
      return { listing: await fileService.list(target) };
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // Download a file (streamed).
  fastify.get('/api/files/download', async (request, reply) => {
    try {
      const target = requirePath(request.query?.path);
      const info = await fileService.stat(target);
      if (info.type === 'dir' || info.type === 'symlink-dir') {
        return reply.status(400).send({ error: 'Cannot download a directory.' });
      }
      const name = path.basename(target);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      if (info.size != null) reply.header('Content-Length', String(info.size));
      return reply.send(fileService.openReadStream(target));
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // Read a file's contents for display/editing.
  fastify.get('/api/files/read', async (request, reply) => {
    try {
      const target = requirePath(request.query?.path);
      return { file: await fileService.read(target) };
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // Create or overwrite a file.
  fastify.put('/api/files/write', async (request, reply) => {
    try {
      const { path: target, content, encoding } = request.body || {};
      requirePath(target);
      const result = await fileService.write(target, content, encoding);
      auditService.logAction({
        userId: request.user.id,
        action: 'file_write',
        targetType: 'file',
        targetId: target,
        ip: request.ip,
      });
      return { file: result };
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // Create a directory (recursively).
  fastify.post('/api/files/mkdir', async (request, reply) => {
    try {
      const { path: target } = request.body || {};
      requirePath(target);
      const result = await fileService.mkdir(target);
      auditService.logAction({
        userId: request.user.id,
        action: 'file_mkdir',
        targetType: 'dir',
        targetId: target,
        ip: request.ip,
      });
      return { dir: result };
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // Rename or move a file/directory.
  fastify.post('/api/files/rename', async (request, reply) => {
    try {
      const { from, to } = request.body || {};
      requirePath(from);
      requirePath(to);
      const result = await fileService.rename(from, to);
      auditService.logAction({
        userId: request.user.id,
        action: 'file_rename',
        targetType: 'file',
        targetId: from,
        details: { to },
        ip: request.ip,
      });
      return { moved: result };
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });

  // Delete a file or directory (recursively).
  fastify.delete('/api/files', async (request, reply) => {
    try {
      const target = requirePath(request.query?.path);
      const result = await fileService.remove(target);
      auditService.logAction({
        userId: request.user.id,
        action: 'file_delete',
        targetType: 'file',
        targetId: target,
        ip: request.ip,
      });
      return { removed: result };
    } catch (err) {
      return reply.status(err.statusCode || 400).send({ error: err.message });
    }
  });
}

module.exports = fileRoutes;
