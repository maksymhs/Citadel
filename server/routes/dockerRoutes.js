/**
 * Docker Inspection Routes (Optional)
 */
const { requireAuth } = require('../security/auth');
const { requireModule } = require('../modules/registry');
const dockerService = require('../services/dockerService');

async function dockerRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireModule('docker'));

  // Status of Docker engine
  fastify.get('/api/docker/status', async () => {
    return dockerService.getStatus();
  });

  // List containers
  fastify.get('/api/docker/containers', async () => {
    const containers = await dockerService.listContainers({ all: true });
    return { containers };
  });
}

module.exports = dockerRoutes;
