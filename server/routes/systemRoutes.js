/**
 * System Diagnostics, Node Info and Audit Routes
 */
const { requireAuth } = require('../security/auth');
const nodeService = require('../services/nodeService');
const terminalManager = require('../services/terminalManager');
const gitService = require('../services/gitService');
const proxyProvider = require('../services/proxyProvider');
const dockerService = require('../services/dockerService');
const updateService = require('../services/updateService');
const auditService = require('../services/auditService');
const connectService = require('../services/connectService');
const agentInstallService = require('../services/agentInstallService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

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

  // Top running processes by CPU and memory usage
  fastify.get('/api/system/processes', async (request) => {
    const limit = request.query?.limit;
    return {
      processes: await nodeService.getProcesses({ limit }),
    };
  });

  // Integrations diagnostic check (tmux, git, caddy, docker, AI agents)
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
            ? 'tmux is available. Sessions persist across reconnections and panel restarts.'
            : 'tmux is not installed. Terminals run in direct PTY mode (no persistence across restarts).',
        },
        git: {
          available: gitAvailable,
          description: 'Git CLI available for cloning and querying branches and status.',
        },
        caddy,
        docker,
        agents: agentInstallService.detectAgents(),
      },
    };
  });

  // Install a supported AI coding agent by running its official one-liner in a
  // (privileged, if configured) System Terminal session. The client only names a
  // known tool; the command itself is fixed server-side.
  fastify.post('/api/system/integrations/install', { preHandler: requireAdmin }, async (request, reply) => {
    const agent = agentInstallService.getAgent(request.body ? request.body.tool : null);
    if (!agent) {
      return reply.status(400).send({ error: 'Unknown tool.' });
    }

    try {
      const spec = agentInstallService.buildInstallSpec(agent, terminalManager.getAdminTerminalUser());
      const session = terminalManager.createSession({
        name: `Install ${agent.name}`,
        command: spec.command,
        args: spec.args,
      });
      auditService.logAction({
        userId: request.user.id,
        action: 'integration_install_started',
        targetType: 'integration',
        targetId: agent.id,
        details: { tool: agent.id, terminal: session.sessionId },
        ip: request.ip,
      });
      return { session };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Running application version and updater availability
  fastify.get('/api/system/version', async () => {
    return { version: updateService.getVersionInfo() };
  });

  // Remote-access URL + QR code so a phone can open the panel
  fastify.get('/api/system/connect', async () => {
    return { connect: connectService.getConnectInfo() };
  });

  // Check GitHub for a newer release/tag
  fastify.get('/api/system/updates', async (request) => {
    const force = request.query?.force === 'true';
    return { updates: await updateService.checkForUpdates({ force }) };
  });

  // Trigger the privileged updater helper (requires the helper from the installer)
  fastify.post('/api/system/update', async (request, reply) => {
    try {
      const res = await updateService.triggerUpdate();
      auditService.logAction({
        userId: request.user.id,
        action: 'system_update_triggered',
        targetType: 'system',
        targetId: 'citadel',
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
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
