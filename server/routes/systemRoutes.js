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
const updateRolloutService = require('../services/updateRolloutService');
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
  // System Terminal session, as the service user, into the shared agents
  // directory so every OS user can run it. The client only names a known tool;
  // the command itself is fixed server-side.
  fastify.post('/api/system/integrations/install', { preHandler: requireAdmin }, async (request, reply) => {
    const agent = agentInstallService.getAgent(request.body ? request.body.tool : null);
    if (!agent) {
      return reply.status(400).send({ error: 'Unknown tool.' });
    }

    try {
      const { session } = agentInstallService.installAgent(agent.id);
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

  // Trigger an update: prefers the privileged helper, falls back to the
  // built-in unprivileged updater. Administrators only.
  fastify.post('/api/system/update', { preHandler: requireAdmin }, async (request, reply) => {
    // A peer that is rolling an update out asks us to update without passing it
    // on again (no cascading rollouts, and no legacy CITADEL_PEERS fan-out).
    const propagated = Boolean(request.body && request.body.propagated);
    try {
      if (propagated) updateRolloutService.markPropagatedUpdate();
      const res = await updateService.triggerUpdate({ fanout: !propagated });
      auditService.logAction({
        userId: request.user.id,
        action: 'system_update_triggered',
        targetType: 'system',
        targetId: 'citadel',
        ip: request.ip,
      });
      return res;
    } catch (err) {
      if (propagated) updateRolloutService.clearPropagatedUpdate();
      return reply.status(400).send({ error: err.message });
    }
  });

  // Staged update propagation to the machines paired with this one (opt-in).
  fastify.get('/api/system/update/propagate', { preHandler: requireAdmin }, async () => ({
    enabled: updateRolloutService.isPropagationEnabled(),
    lastRollout: updateRolloutService.getLastRollout(),
  }));

  fastify.put('/api/system/update/propagate', { preHandler: requireAdmin }, async (request) => ({
    enabled: updateRolloutService.setPropagationEnabled(Boolean(request.body && request.body.enabled)),
  }));

  // Update the paired machines that are behind this one, now. Runs in the
  // background; progress is read from the propagate endpoint.
  fastify.post('/api/system/update/rollout', { preHandler: requireAdmin }, async (request) => {
    updateRolloutService.rollout().catch(() => {});
    auditService.logAction({
      userId: request.user.id,
      action: 'system_update_rollout_started',
      targetType: 'system',
      targetId: 'citadel',
      ip: request.ip,
    });
    return { started: true };
  });

  // Progress of the most recent (built-in) update. Administrators only.
  fastify.get('/api/system/update/status', { preHandler: requireAdmin }, async () => {
    return { update: updateService.getUpdateStatus() };
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
