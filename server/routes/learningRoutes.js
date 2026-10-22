/**
 * Learning HTTP routes — structured project/global memory. Administrator-only,
 * like missions: lessons are context that influences autonomous work, so a
 * normal user must not be able to inject instructions into future plans.
 */
const { requireAuth } = require('../security/auth');
const { requireModule } = require('../modules/registry');
const learningService = require('../services/learningService');
const auditService = require('../services/auditService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

function audit(request, action, targetId, details) {
  auditService.logAction({
    userId: request.user ? request.user.id : null,
    action,
    targetType: 'lesson',
    targetId,
    details: details || null,
    ip: request.ip,
  });
}

async function learningRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireModule('missions'));
  fastify.addHook('preHandler', requireAdmin);

  fastify.get('/api/learning', async (request) => ({
    lessons: learningService.listLessons(request.query || {}),
  }));

  fastify.get('/api/learning/relevant', async (request) => ({
    lessons: learningService.relevantLessons({
      projectId: (request.query || {}).projectId || null,
      text: (request.query || {}).q || '',
    }),
  }));

  fastify.post('/api/learning', async (request, reply) => {
    try {
      const body = request.body || {};
      // A manual row can never be created directly as global; promotion is the
      // only path to global knowledge.
      const lesson = learningService.recordLesson({
        ...body,
        scope: 'project',
        source: 'manual',
        createdBy: request.user ? request.user.id : null,
      });
      audit(request, 'lesson_recorded', lesson.id, { projectId: lesson.projectId });
      return reply.status(201).send({ lesson });
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  fastify.get('/api/learning/:id', async (request, reply) => {
    const lesson = learningService.getLesson(request.params.id);
    if (!lesson) return reply.status(404).send({ error: 'Lesson not found.' });
    return { lesson };
  });

  const actions = {
    confirm: (id) => learningService.confirmLesson(id),
    discard: (id) => learningService.discardLesson(id),
    supersede: (id, body) => learningService.supersedeLesson(id, body.replacementId),
    promote: (id, body, request) => learningService.promoteLesson(id, { createdBy: request.user ? request.user.id : null }),
  };

  for (const [action, run] of Object.entries(actions)) {
    fastify.post(`/api/learning/:id/${action}`, async (request, reply) => {
      try {
        const lesson = run(request.params.id, request.body || {}, request);
        audit(request, `lesson_${action}`, lesson.id, { scope: lesson.scope });
        return { lesson };
      } catch (err) {
        const status = /not found/i.test(err.message) ? 404 : 400;
        return reply.status(status).send({ error: err.message });
      }
    });
  }
}

module.exports = learningRoutes;
