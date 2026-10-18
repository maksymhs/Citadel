/**
 * Fleet (multi-host) HTTP Routes
 *
 * Manage remote Citadel instances and forward actions to them. Every route
 * requires an authenticated panel session; the stored per-host token never
 * leaves the server.
 */
const { requireAuth } = require('../security/auth');
const fleetService = require('../services/fleetService');
const auditService = require('../services/auditService');

function audit(request, action, hostId, details) {
  auditService.logAction({
    userId: request.user.id,
    action,
    targetType: 'fleet_host',
    targetId: hostId,
    details,
    ip: request.ip,
  });
}

async function forward(reply, hostId, apiPath, options, request, action, details) {
  try {
    const res = await fleetService.remoteRequest(hostId, apiPath, options);
    audit(request, action, hostId, details);
    if (!res.ok) {
      return reply.status(res.status).send(res.data || { error: 'Remote request failed.' });
    }
    return res.data;
  } catch (err) {
    return reply.status(400).send({ error: err.message });
  }
}

async function fleetRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/fleet/hosts', async () => ({ hosts: fleetService.listHosts() }));

  // Aggregated status for every host, for the single-pane-of-glass dashboard.
  fastify.get('/api/fleet/overview', async (request, reply) => {
    try {
      const hosts = await fleetService.overview();
      audit(request, 'fleet_overview', null, { count: hosts.length });
      return { hosts };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Trigger the self-updater on every host at once (best-effort per host).
  fastify.post('/api/fleet/update-all', async (request, reply) => {
    try {
      const results = await fleetService.updateAll();
      audit(request, 'fleet_update_all', null, { count: results.length });
      return { results };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.post('/api/fleet/hosts', async (request, reply) => {
    const { name, baseUrl, token } = request.body || {};
    try {
      const host = fleetService.createHost({ name, baseUrl, token });
      audit(request, 'fleet_host_created', host.id, { name: host.name, baseUrl: host.baseUrl });
      return { host };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.put('/api/fleet/hosts/:id', async (request, reply) => {
    const { name, baseUrl, token } = request.body || {};
    try {
      const host = fleetService.updateHost(request.params.id, { name, baseUrl, token });
      audit(request, 'fleet_host_updated', host.id, { name: host.name, baseUrl: host.baseUrl });
      return { host };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.delete('/api/fleet/hosts/:id', async (request, reply) => {
    const { id } = request.params;
    const result = fleetService.deleteHost(id);
    if (result.success) audit(request, 'fleet_host_deleted', id, null);
    return result;
  });

  // Connectivity + version check against the remote host.
  fastify.get('/api/fleet/hosts/:id/status', async (request, reply) => {
    return forward(
      reply, request.params.id, '/api/system/version', { method: 'GET' },
      request, 'fleet_host_status', {}
    );
  });

  fastify.get('/api/fleet/hosts/:id/agents', async (request, reply) => {
    return forward(
      reply, request.params.id, '/api/agents', { method: 'GET' },
      request, 'fleet_agents_list', {}
    );
  });

  fastify.post('/api/fleet/hosts/:id/agents/install', async (request, reply) => {
    const { agentId } = request.body || {};
    return forward(
      reply, request.params.id, '/api/agents/install', { method: 'POST', body: { agentId } },
      request, 'fleet_agent_install', { agentId }
    );
  });

  fastify.post('/api/fleet/hosts/:id/agents/launch', async (request, reply) => {
    const { projectId, agentId, extraArgs } = request.body || {};
    return forward(
      reply, request.params.id, '/api/agents/launch',
      { method: 'POST', body: { projectId, agentId, extraArgs } },
      request, 'fleet_agent_launch', { agentId, projectId }
    );
  });

  fastify.get('/api/fleet/hosts/:id/projects', async (request, reply) => {
    return forward(
      reply, request.params.id, '/api/projects', { method: 'GET' },
      request, 'fleet_projects_list', {}
    );
  });

  fastify.get('/api/fleet/hosts/:id/updates', async (request, reply) => {
    return forward(
      reply, request.params.id, '/api/system/updates', { method: 'GET' },
      request, 'fleet_updates_check', {}
    );
  });

  fastify.post('/api/fleet/hosts/:id/update', async (request, reply) => {
    return forward(
      reply, request.params.id, '/api/system/update', { method: 'POST', body: {} },
      request, 'fleet_update_triggered', {}
    );
  });
}

module.exports = fleetRoutes;
