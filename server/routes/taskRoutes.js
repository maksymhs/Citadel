/**
 * Task mesh HTTP routes — the minimal control plane for distributed work.
 *
 * An orchestrator agent enqueues tasks; per-node sentinels pull them. Every
 * route requires an authenticated session (cookie or Bearer session id).
 */
const { requireAuth } = require('../security/auth');
const taskService = require('../services/taskService');
const auditService = require('../services/auditService');

function audit(request, action, taskId, details) {
  auditService.logAction({
    userId: request.user.id,
    action,
    targetType: 'task',
    targetId: taskId,
    details,
    ip: request.ip,
  });
}

async function taskRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.post('/api/tasks', async (request, reply) => {
    try {
      const task = taskService.enqueue(request.body || {});
      audit(request, 'task_enqueued', task.id, { cmd: task.cmd, node: task.node });
      return { task };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/tasks', async (request) => ({
    tasks: taskService.listTasks(request.query || {}),
  }));

  // Static route declared before the :id param route for clarity.
  fastify.post('/api/tasks/claim', async (request, reply) => {
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

  fastify.get('/api/tasks/:id', async (request, reply) => {
    const task = taskService.getTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found.' });
    return { task };
  });

  fastify.post('/api/tasks/:id/result', async (request, reply) => {
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

  fastify.post('/api/tasks/:id/cancel', async (request, reply) => {
    try {
      const task = taskService.cancelTask(request.params.id);
      audit(request, 'task_cancelled', task.id, { node: task.node });
      return { task };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.post('/api/nodes/heartbeat', async (request, reply) => {
    try {
      const node = taskService.heartbeat(request.body || {});
      return { node };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/nodes', async () => ({ nodes: taskService.listNodes() }));
}

module.exports = taskRoutes;
