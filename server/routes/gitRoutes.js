/**
 * Git Provider Credentials & Repository Discovery Routes
 */
const { requireAuth } = require('../security/auth');
const gitCredentialsService = require('../services/gitCredentialsService');
const gitOAuthService = require('../services/gitOAuthService');
const auditService = require('../services/auditService');

async function gitRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // Provider connection state merged with OAuth availability. Never exposes tokens.
  fastify.get('/api/git/oauth/providers', async () => {
    const oauth = new Map(gitOAuthService.providerStatus().map((p) => [p.id, p]));
    const providers = gitCredentialsService.listProviderStatus().map((p) => ({
      ...p,
      oauth: oauth.get(p.id) || null,
    }));
    return { providers };
  });

  // Store the public client/application id used to start the OAuth device flow.
  fastify.post('/api/git/oauth/:provider/client-id', async (request, reply) => {
    const provider = request.params.provider;
    const { clientId } = request.body || {};
    try {
      const res = gitOAuthService.setClientId(provider, clientId);
      auditService.logAction({
        userId: request.user.id,
        action: 'git_oauth_client_id_saved',
        targetType: 'git_provider',
        targetId: provider,
        ip: request.ip,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Begin a device authorization flow and return the code the user must approve.
  fastify.post('/api/git/oauth/:provider/start', async (request, reply) => {
    try {
      return await gitOAuthService.startDeviceFlow(request.params.provider);
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Poll a pending flow; when the user approves, the token is stored backend-side.
  fastify.post('/api/git/oauth/:provider/poll', async (request, reply) => {
    const provider = request.params.provider;
    const { sessionId } = request.body || {};
    if (!sessionId) return reply.status(400).send({ error: 'A sessionId is required.' });
    try {
      const result = await gitOAuthService.pollDeviceFlow(provider, sessionId);
      if (result.status === 'connected') {
        auditService.logAction({
          userId: request.user.id,
          action: 'git_credential_saved',
          targetType: 'git_provider',
          targetId: provider,
          details: { provider, authMethod: 'oauth', username: result.username || null },
          ip: request.ip,
        });
      }
      return result;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Abandon a pending flow (user closed the dialog).
  fastify.post('/api/git/oauth/:provider/cancel', async (request) => {
    const { sessionId } = request.body || {};
    if (sessionId) gitOAuthService.cancelDeviceFlow(sessionId);
    return { success: true };
  });

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
