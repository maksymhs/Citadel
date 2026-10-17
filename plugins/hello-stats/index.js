/**
 * Official Hello Stats Plugin
 */
module.exports = async function init(context) {
  context.logger.info('Initializing Hello Stats plugin...');
  context.audit('plugin_initialized', { pluginId: 'hello-stats' });

  // Register a custom plugin route on Fastify server
  context.server.get('/api/plugins/hello-stats/ping', async () => {
    return {
      status: 'ok',
      plugin: 'hello-stats',
      timestamp: Date.now(),
      config: context.config,
    };
  });
};
