/**
 * WebSocket Route for Interactive Terminal Streaming
 */
const { isAllowedOrigin } = require('../security/guard');
const { getSessionUser } = require('../security/auth');
const terminalManager = require('../services/terminalManager');

function wsTerminalRoutes(fastify) {
  fastify.get('/ws/terminal/:sessionId', { websocket: true }, (socket, req) => {
    // 1. Origin validation
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized origin.' }));
      socket.close();
      return;
    }

    // 2. Authentication validation (cookie or query param)
    const sessionIdCookie = req.cookies?.session_id;
    const sessionTokenQuery = req.query?.token;
    const authToken = sessionIdCookie || sessionTokenQuery;

    const user = getSessionUser(authToken);
    if (!user) {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized: valid session required.' }));
      socket.close();
      return;
    }

    // 3. Attach client to the terminal manager
    const terminalSessionId = req.params.sessionId;
    terminalManager.attachClient(terminalSessionId, socket);
  });
}

module.exports = wsTerminalRoutes;
