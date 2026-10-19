/**
 * Domain Publishing & Proxy Routes
 */
const { requireAuth } = require('../security/auth');
const { requireModule } = require('../modules/registry');
const proxyProvider = require('../services/proxyProvider');
const auditService = require('../services/auditService');

async function proxyRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireModule('proxy'));

  // Get proxy provider status and availability
  fastify.get('/api/proxy/status', async () => {
    return proxyProvider.getStatus();
  });

  // List published domains
  fastify.get('/api/proxy/deployments', async (request) => {
    const projectId = request.query?.projectId || null;
    return {
      deployments: proxyProvider.listDeployments(projectId),
    };
  });

  // Publish domain
  fastify.post('/api/proxy/publish', async (request, reply) => {
    const { projectId, domain, targetPort } = request.body || {};
    if (!projectId || !domain || !targetPort) {
      return reply.status(400).send({ error: 'projectId, domain, and targetPort are required.' });
    }

    try {
      const deployment = await proxyProvider.publishDomain(projectId, domain, targetPort);
      auditService.logAction({
        userId: request.user.id,
        action: 'domain_published',
        targetType: 'project',
        targetId: projectId,
        details: { domain, targetPort },
        ip: request.ip,
      });
      return { deployment };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Unpublish domain
  fastify.delete('/api/proxy/unpublish', async (request, reply) => {
    const { domain } = request.body || {};
    if (!domain) {
      return reply.status(400).send({ error: 'Domain is required.' });
    }

    try {
      const res = await proxyProvider.unpublishDomain(domain);
      auditService.logAction({
        userId: request.user.id,
        action: 'domain_unpublished',
        details: { domain },
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = proxyRoutes;
