/**
 * Task mesh HTTP routes — the minimal control plane for distributed work.
 *
 * An orchestrator agent enqueues tasks; per-node sentinels pull them.
 * Orchestrator routes require an authenticated session (cookie or Bearer session
 * id). Worker routes (claim/result/heartbeat) additionally accept the scoped
 * `X-Citadel-Node-Token` header, so a sentinel does not need — and should not
 * hold — a full admin session.
 *
 * Two credential models:
 *   - CITADEL_NODE_TOKENS (preferred): one token per node, bound to that node
 *     id. The declared node must match the authenticated identity, so a node
 *     cannot claim, heartbeat or report as another node.
 *   - CITADEL_NODE_TOKEN (legacy shared secret): any holder may declare any
 *     node id; acceptable only when every node is inside the same trust
 *     perimeter (single operator). Disabled as soon as per-node tokens exist.
 */
const crypto = require('node:crypto');
const { requireAuth } = require('../security/auth');
const { NODE_TOKEN, NODE_TOKENS } = require('../config');
const taskService = require('../services/taskService');
const auditService = require('../services/auditService');

function constantTimeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Resolve a worker credential to the node identity it may act as:
 * `{ nodeId }` for a per-node token, `{ nodeId: null }` for the legacy shared
 * token (any node id), or null when no configured credential matches.
 */
function resolveNodeIdentity(provided) {
  if (typeof provided !== 'string' || provided === '') return null;
  for (const [nodeId, token] of NODE_TOKENS) {
    if (constantTimeEqual(provided, token)) return { nodeId };
  }
  if (NODE_TOKENS.size === 0 && constantTimeEqual(provided, NODE_TOKEN)) {
    return { nodeId: null };
  }
  return null;
}

async function requireWorkerAuth(request, reply) {
  const identity = resolveNodeIdentity(request.headers['x-citadel-node-token']);
  if (identity) {
    request.nodeAuth = true;
    request.nodeIdentity = identity.nodeId;
    return;
  }
  return requireAuth(request, reply);
}

/**
 * Credential/identity binding for routes whose body declares a node. Only
 * per-node credentials are constrained; sessions (orchestrator) and the legacy
 * shared token keep their current reach.
 */
function assertNodeIdentity(request, declaredNode) {
  if (request.nodeIdentity === null || request.nodeIdentity === undefined) return;
  if (String(declaredNode || '').trim() !== request.nodeIdentity) {
    const err = new Error('Node credential is not authorized for this node id.');
    err.statusCode = 403;
    throw err;
  }
}

function sendError(reply, err) {
  return reply.status(err.statusCode || 400).send({ error: err.message });
}

function audit(request, action, taskId, details) {
  auditService.logAction({
    userId: request.user ? request.user.id : null,
    action,
    targetType: 'task',
    targetId: taskId,
    details: request.nodeAuth ? { ...details, via: 'node-token' } : details,
    ip: request.ip,
  });
}

async function taskRoutes(fastify) {
  fastify.post('/api/tasks', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const task = taskService.enqueue(request.body || {});
      audit(request, 'task_enqueued', task.id, { cmd: task.cmd, node: task.node });
      return { task };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/tasks', { preHandler: requireAuth }, async (request) => ({
    tasks: taskService.listTasks(request.query || {}),
  }));

  // Static route declared before the :id param route for clarity.
  fastify.post('/api/tasks/claim', { preHandler: requireWorkerAuth }, async (request, reply) => {
    const { node } = request.body || {};
    try {
      assertNodeIdentity(request, node);
      const task = taskService.claimTask(node);
      if (!task) return reply.status(204).send();
      audit(request, 'task_claimed', task.id, { node: task.node });
      return { task };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/api/tasks/:id', { preHandler: requireAuth }, async (request, reply) => {
    const task = taskService.getTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found.' });
    return { task };
  });

  fastify.post('/api/tasks/:id/result', { preHandler: requireWorkerAuth }, async (request, reply) => {
    try {
      // A per-node credential may only report for tasks assigned to that node;
      // sessions and the legacy shared token are not constrained.
      const expectedNode = request.nodeAuth ? request.nodeIdentity : null;
      const task = taskService.completeTask(request.params.id, { ...(request.body || {}), expectedNode });
      audit(request, task.status === 'done' ? 'task_completed' : 'task_failed', task.id, {
        exitCode: task.exitCode,
        resultRef: task.resultRef,
      });
      return { task };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post('/api/tasks/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const task = taskService.cancelTask(request.params.id);
      audit(request, 'task_cancelled', task.id, { node: task.node });
      return { task };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.post('/api/nodes/heartbeat', { preHandler: requireWorkerAuth }, async (request, reply) => {
    try {
      assertNodeIdentity(request, (request.body || {}).node);
      const node = taskService.heartbeat(request.body || {});
      return { node };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/api/nodes', { preHandler: requireAuth }, async () => ({ nodes: taskService.listNodes() }));
}

module.exports = taskRoutes;
