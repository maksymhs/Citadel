/**
 * Agent mission HTTP routes — the "mini-Jira" control plane for a team of CLI
 * agents. Every route is administrator-only: a mission can run arbitrary
 * installed agents against a project checkout, which is a privileged action.
 *
 * The routes stay thin: validate, authorize, delegate to missionService, audit.
 */
const { requireAuth } = require('../security/auth');
const { requireModule } = require('../modules/registry');
const missionService = require('../services/missionService');
const taskService = require('../services/taskService');
const agentRegistry = require('../services/agentRegistry');
const auditService = require('../services/auditService');

function requireAdmin(request, reply, done) {
  if (!request.user || request.user.role !== 'admin') {
    reply.status(403).send({ error: 'Administrator privileges are required.' });
    return;
  }
  done();
}

function audit(request, action, missionId, details) {
  auditService.logAction({
    userId: request.user ? request.user.id : null,
    action,
    targetType: 'mission',
    targetId: missionId,
    details: details || null,
    ip: request.ip,
  });
}

function sendError(reply, err, notFound = false) {
  return reply.status(notFound ? 404 : 400).send({ error: err.message });
}

async function missionRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', requireModule('missions'));
  fastify.addHook('preHandler', requireAdmin);

  fastify.get('/api/missions/meta', async () => {
    // One detection pass, no version probes: this endpoint is on the screen's
    // critical path and the planner only needs to know what can run.
    const installed = new Map(agentRegistry.listAgents({ versions: false }).map((a) => [a.id, a]));
    const agents = Object.keys(taskService.AGENT_HEADLESS).map((id) => {
      const info = installed.get(id);
      return {
        id,
        name: info ? info.name : id,
        installed: Boolean(info && info.installed),
        version: null,
      };
    });
    return { roles: missionService.roleList(), agents };
  });

  fastify.get('/api/missions', async (request) => ({
    missions: missionService.listMissions(request.query || {}),
  }));

  fastify.post('/api/missions', async (request, reply) => {
    try {
      const mission = missionService.createMission({
        ...(request.body || {}),
        createdBy: request.user ? request.user.id : null,
      });
      audit(request, 'mission_created', mission.mission.id, {
        projectId: mission.mission.projectId,
        planned: Boolean(mission.mission.total),
      });
      return reply.status(201).send(mission);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/api/missions/:id', async (request, reply) => {
    const mission = missionService.getMission(request.params.id);
    if (!mission) return reply.status(404).send({ error: 'Mission not found.' });
    return mission;
  });

  fastify.post('/api/missions/:id/plan', async (request, reply) => {
    try {
      const mission = missionService.importPlan(request.params.id, (request.body || {}).plan || request.body);
      audit(request, 'mission_plan_imported', request.params.id, { tasks: mission.mission.total });
      return mission;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post('/api/missions/:id/prioritize', async (request, reply) => {
    try {
      const mission = missionService.prioritize(request.params.id, request.body || {});
      audit(request, 'mission_prioritized', request.params.id, null);
      return mission;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post('/api/missions/:id/cancel', async (request, reply) => {
    try {
      const mission = missionService.cancelMission(request.params.id);
      audit(request, 'mission_cancelled', request.params.id, {
        tasks: mission.mission.counts,
      });
      return mission;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post('/api/missions/:id/notes', async (request, reply) => {
    try {
      const mission = missionService.addNote(request.params.id, (request.body || {}).text);
      audit(request, 'mission_note_added', request.params.id, null);
      return mission;
    } catch (err) {
      return sendError(reply, err);
    }
  });


  fastify.post('/api/missions/:id/tasks/:taskId/correction', async (request, reply) => {
    try {
      const result = missionService.addCorrection(
        request.params.id,
        request.params.taskId,
        (request.body || {}).text,
        { createdBy: request.user ? request.user.id : null },
      );
      audit(request, 'mission_correction_recorded', request.params.id, {
        taskId: request.params.taskId,
        lessonId: result.lesson.id,
      });
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });


  fastify.post('/api/missions/:id/tasks/:taskId/review', async (request, reply) => {
    try {
      const body = request.body || {};
      const mission = missionService.reviewTask(request.params.id, request.params.taskId, {
        accepted: body.accepted !== false,
        note: body.note,
        reviewedBy: request.user ? request.user.id : null,
      });
      audit(request, body.accepted === false ? 'mission_task_rejected' : 'mission_task_accepted', request.params.id, {
        taskId: request.params.taskId,
      });
      return mission;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post('/api/missions/:id/plan/revision', async (request, reply) => {
    try {
      const body = request.body || {};
      const mission = missionService.revisePlan(request.params.id, body.plan || body, {
        reason: body.reason,
        createdBy: request.user ? request.user.id : null,
      });
      audit(request, 'mission_plan_revised', request.params.id, { reason: body.reason || null });
      return mission;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/api/missions/:id/plan/versions', async (request, reply) => {
    try {
      return { versions: missionService.listPlanVersions(request.params.id) };
    } catch (err) {
      return sendError(reply, err, /not found/i.test(err.message));
    }
  });

  fastify.get('/api/missions/:id/files', async (request) => ({
    files: missionService.listFiles(request.params.id),
  }));

  fastify.get('/api/missions/:id/file', async (request, reply) => {
    try {
      const file = missionService.readMissionFile(request.params.id, (request.query || {}).path);
      return { file };
    } catch (err) {
      const notFound = /not found/i.test(err.message);
      return sendError(reply, err, notFound);
    }
  });
}

module.exports = missionRoutes;
