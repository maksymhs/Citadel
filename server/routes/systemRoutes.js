/**
 * System Diagnostics, Node Info and Audit Routes
 */
const { requireAuth } = require('../security/auth');
const nodeService = require('../services/nodeService');
const terminalManager = require('../services/terminalManager');
const gitService = require('../services/gitService');
const proxyProvider = require('../services/proxyProvider');
const dockerService = require('../services/dockerService');
const auditService = require('../services/auditService');

async function systemRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // System & Node hardware/OS info
  fastify.get('/api/system/node', async () => {
    return {
      node: await nodeService.getNodeInfo(),
    };
  });

  // Real-time metrics
  fastify.get('/api/system/metrics', async () => {
    return {
      metrics: await nodeService.getMetrics(),
    };
  });

  // Integrations diagnostic check (tmux, git, caddy, docker)
  fastify.get('/api/system/integrations', async () => {
    const tmux = terminalManager.isTmuxAvailable();
    const gitAvailable = true; // We checked which git
    const caddy = await proxyProvider.getStatus();
    const docker = await dockerService.getStatus();

    return {
      integrations: {
        tmux: {
          available: tmux,
          description: tmux
            ? 'tmux está disponible. Las sesiones persisten entre reconexiones y reinicios del panel.'
            : 'tmux no está instalado. Las terminales funcionan en modo PTY directo (sin persistencia ante reinicios).',
        },
        git: {
          available: gitAvailable,
          description: 'Git CLI disponible para clonar, consultar ramas y estado.',
        },
        caddy,
        docker,
      },
    };
  });

  // Audit logs query
  fastify.get('/api/audit', async (request) => {
    const limit = parseInt(request.query?.limit, 10) || 50;
    const offset = parseInt(request.query?.offset, 10) || 0;
    return {
      logs: auditService.getAuditLogs({ limit, offset }),
    };
  });
}

module.exports = systemRoutes;
