/**
 * WebSocket Route for Interactive Terminal Streaming
 */
const { isAllowedOrigin } = require('../security/guard');
const { getSessionUser } = require('../security/auth');
const { getDatabase } = require('../database/db');
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

    // 2. Authentication validation. Only the session cookie or an Authorization
    //    header are accepted: a ?token= query parameter would leak the long-lived
    //    session id into access logs and Referer headers.
    const sessionIdCookie = req.cookies?.session_id;
    const authHeader = req.headers.authorization;
    const bearerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;

    const user = getSessionUser(sessionIdCookie || bearerToken);
    if (!user) {
      socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized: valid session required.' }));
      socket.close();
      return;
    }

    // 3. Authorize the requested terminal session: it must exist and belong to a
    //    project the caller may reach. (Single-admin installs currently allow all
    //    authenticated users; keep the lookup so ownership can be enforced later.)
    const terminalSessionId = req.params.sessionId;
    const sessionRow = getDatabase()
      .prepare('SELECT id, project_id FROM term_sessions WHERE id = ?')
      .get(terminalSessionId);

    if (!sessionRow) {
      socket.send(JSON.stringify({ type: 'error', message: 'Terminal session not found.' }));
      socket.close();
      return;
    }

    // 4. Attach client to the terminal manager
    startHeartbeat(socket);
    terminalManager.attachClient(terminalSessionId, socket);
  });
}

function startHeartbeat(socket, intervalMs = 30000) {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  const timer = setInterval(() => {
    if (socket.isAlive === false) {
      clearInterval(timer);
      try {
        socket.terminate();
      } catch {
        // Ignore
      }
      return;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      // Ignore
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  socket.on('close', () => clearInterval(timer));
}

module.exports = wsTerminalRoutes;
