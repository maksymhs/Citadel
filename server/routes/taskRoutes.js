/**
 * Task mesh HTTP routes — the minimal control plane for distributed work.
 *
 * An orchestrator agent enqueues tasks; per-node sentinels pull them.
 * Orchestrator routes require an authenticated session (cookie or Bearer session
 * id). Worker routes (claim/result/heartbeat) additionally accept the scoped
 * `X-Citadel-Node-Token` header when CITADEL_NODE_TOKEN is configured, so a
 * sentinel does not need — and should not hold — a full admin session.
 */
const crypto = require('node:crypto');
const { requireAuth } = require('../security/auth');
const { NODE_TOKEN } = require('../config');
const taskService = require('../services/taskService');
const auditService = require('../services/auditService');

function nodeTokenMatches(provided) {
  if (!NODE_TOKEN || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(NODE_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function requireWorkerAuth(request, reply) {
  if (nodeTokenMatches(request.headers['x-citadel-node-token'])) {
    request.nodeAuth = true;
    return;
  }
  return requireAuth(request, reply);
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
      const task = taskService.claimTask(node);
      if (!task) return reply.status(204).send();
      audit(request, 'task_claimed', task.id, { node: task.node });
      return { task };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/tasks/:id', { preHandler: requireAuth }, async (request, reply) => {
    const task = taskService.getTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found.' });
    return { task };
  });

  fastify.post('/api/tasks/:id/result', { preHandler: requireWorkerAuth }, async (request, reply) => {
    try {
      const task = taskService.completeTask(request.params.id, request.body || {});
      audit(request, task.status === 'done' ? 'task_completed' : 'task_failed', task.id, {
        exitCode: task.exitCode,
        resultRef: task.resultRef,
      });
      return { task };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
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
      const node = taskService.heartbeat(request.body || {});
      return { node };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/nodes', { preHandler: requireAuth }, async () => ({ nodes: taskService.listNodes() }));
}

module.exports = taskRoutes;
