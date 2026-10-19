/**
 * Git Provider Credentials & Repository Discovery Routes
 */
const { requireAuth } = require('../security/auth');
const gitCredentialsService = require('../services/gitCredentialsService');
const auditService = require('../services/auditService');

async function gitRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List configured providers (never exposes tokens)
  fastify.get('/api/git/credentials', async () => {
    return { providers: gitCredentialsService.listProviderStatus() };
  });

  // Store or update a provider access token
  fastify.post('/api/git/credentials', async (request, reply) => {
    const { provider, token, username } = request.body || {};
    try {
      const credential = gitCredentialsService.saveCredential({ provider, token, username });
      auditService.logAction({
        userId: request.user.id,
        action: 'git_credential_saved',
        targetType: 'git_provider',
        targetId: provider,
        details: { provider, username },
        ip: request.ip,
      });
      return { credential };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Remove a provider access token
  fastify.delete('/api/git/credentials/:provider', async (request, reply) => {
    try {
      const res = gitCredentialsService.deleteCredential(request.params.provider);
      auditService.logAction({
        userId: request.user.id,
        action: 'git_credential_deleted',
        targetType: 'git_provider',
        targetId: request.params.provider,
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // List repositories available to the authenticated provider token
  fastify.get('/api/git/repos', async (request, reply) => {
    const provider = request.query?.provider;
    if (!provider) {
      return reply.status(400).send({ error: 'A provider query parameter is required.' });
    }
    try {
      const repos = await gitCredentialsService.listRepos(provider);
      return { provider, repos };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });
}

module.exports = gitRoutes;
