/**
 * Project hub: admin/module-gated snapshots, scoped execution traces and code graphs.
 */
const { requireAuth } = require('../security/auth');
const { requireModule } = require('../modules/registry');
const hub = require('../services/projectHubService');
const graphs = require('../services/codeGraphService');

async function projectHubRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireModule('missions'));
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Administrator privileges are required.' });
  });
  const sendError = (reply, err) => reply.status(err.statusCode || 400).send({ error: err.message });
  fastify.get('/api/projects/:id/hub', async (request, reply) => {
    try { return hub.snapshot(request.params.id); } catch (err) { return sendError(reply, err); }
  });
  fastify.get('/api/projects/:id/trace', async (request, reply) => {
    try { return hub.trace(request.params.id, request.query); } catch (err) { return sendError(reply, err); }
  });
  fastify.get('/api/projects/:id/code-graph', async (request, reply) => {
    try { return await graphs.graph(request.params.id, { refresh: request.query.refresh === '1' }); } catch (err) { return sendError(reply, err); }
  });
}
module.exports = projectHubRoutes;
