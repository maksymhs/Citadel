/**
 * Docs HTTP routes — read, create and edit Markdown inside a registered project.
 * Administrator-only and module-gated. The service owns path confinement, so a
 * request can never select a file outside the project's documentation root.
 */
const { requireAuth } = require('../security/auth');
const { requireModule } = require('../modules/registry');
const docService = require('../services/docService');
const auditService = require('../services/auditService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

function audit(request, action, details) {
  auditService.logAction({
    userId: request.user ? request.user.id : null,
    action,
    targetType: 'document',
    targetId: details && details.projectId ? `${details.projectId}:${details.path || ''}` : null,
    details: details || null,
    ip: request.ip,
  });
}

function sendError(reply, err) {
  return reply.status(err.statusCode || (/not found/i.test(err.message) ? 404 : 400)).send({ error: err.message });
}

async function docRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireModule('missions'));
  fastify.addHook('preHandler', requireAdmin);

  fastify.get('/api/docs', async (request, reply) => {
    try {
      return await docService.listDocs(request.query || {});
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/api/docs/file', async (request, reply) => {
    try {
      return { doc: docService.readDoc(request.query || {}) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post('/api/docs', async (request, reply) => {
    try {
      const doc = docService.createDoc({
        ...(request.body || {}),
        createdBy: request.user ? request.user.id : null,
      });
      audit(request, 'document_created', { projectId: doc.projectId, path: doc.path, taskId: doc.taskId });
      return reply.status(201).send({ doc });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.put('/api/docs', async (request, reply) => {
    try {
      const doc = docService.updateDoc(request.body || {});
      audit(request, 'document_updated', { projectId: doc.projectId, path: doc.path, taskId: doc.taskId });
      return { doc };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post('/api/docs/link', async (request, reply) => {
    try {
      const doc = docService.linkDoc(request.body || {});
      audit(request, 'document_linked', { projectId: doc.projectId, path: doc.path, taskId: doc.taskId });
      return { doc };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

module.exports = docRoutes;
