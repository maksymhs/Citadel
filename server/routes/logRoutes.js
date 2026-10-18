/**
 * Observability HTTP routes — read and export the event trace and resource
 * samples. All routes require an authenticated session.
 */
const { requireAuth } = require('../security/auth');
const logService = require('../services/logService');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function logRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/logs/events', async (request) => ({
    events: logService.listEvents(request.query || {}),
  }));

  fastify.get('/api/logs/metrics', async (request) => ({
    metrics: logService.listMetrics(request.query || {}),
  }));

  fastify.get('/api/logs/summary', async (request) => ({
    summary: logService.summary(request.query || {}),
  }));

  fastify.get('/api/logs/export', async (request, reply) => {
    const { type = 'events', format = 'json' } = request.query || {};
    const rows = type === 'metrics'
      ? logService.listMetrics({ ...request.query, limit: 5000 })
      : logService.listEvents({ ...request.query, limit: 2000 });

    const filename = `citadel-${type}-${stamp()}`;
    if (format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}.csv"`)
        .send(logService.toCsv(rows));
    }
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}.json"`)
      .send(JSON.stringify({ type, exportedAt: new Date().toISOString(), count: rows.length, rows }, null, 2));
  });
}

module.exports = logRoutes;
