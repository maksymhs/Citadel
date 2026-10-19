/**
 * Citadel Server Main Entrypoint
 */
const Fastify = require('fastify');
const path = require('node:path');
const fs = require('node:fs');
const pkg = require('../package.json');

const {
  PORT,
  HOST,
  SESSION_SECRET,
  NODE_ENV,
  APP_VERSION,
  TRUST_PROXY,
} = require('./config');

const { initDatabase, closeDatabase } = require('./database/db');
const pluginLoader = require('./services/pluginLoader');
const terminalManager = require('./services/terminalManager');
const connectService = require('./services/connectService');
const logService = require('./services/logService');

// Routes
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const gitRoutes = require('./routes/gitRoutes');
const agentRoutes = require('./routes/agentRoutes');
const terminalRoutes = require('./routes/terminalRoutes');
const systemRoutes = require('./routes/systemRoutes');
const peerRoutes = require('./routes/peerRoutes');
const fleetRoutes = require('./routes/fleetRoutes');
const taskRoutes = require('./routes/taskRoutes');
const logRoutes = require('./routes/logRoutes');
const fileRoutes = require('./routes/fileRoutes');
const proxyRoutes = require('./routes/proxyRoutes');
const dockerRoutes = require('./routes/dockerRoutes');
const pluginRoutes = require('./routes/pluginRoutes');
const moduleRoutes = require('./routes/moduleRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const wsTerminalRoutes = require('./routes/wsTerminal');

async function buildServer(options = {}) {
  // Only honour X-Forwarded-* from explicitly trusted peers (default loopback).
  // Trusting every direct connection would let any client spoof its source IP
  // and bypass the per-IP rate limits.
  const trustProxy = options.trustProxy !== undefined ? options.trustProxy : TRUST_PROXY;
  const fastify = Fastify({
    logger: options.logger !== undefined ? options.logger : (NODE_ENV !== 'test'),
    trustProxy,
  });
  if (trustProxy === true) {
    fastify.log.warn('[Citadel] trustProxy is set to true: forwarded headers are accepted from any client.');
  }

  // 1. Initialize SQLite Database
  initDatabase(options.customDbPath);

  // 2. Cookie Support
  await fastify.register(require('@fastify/cookie'), {
    secret: SESSION_SECRET || require('node:crypto').randomBytes(32).toString('hex'),
  });

  // 2b. Tolerate empty JSON bodies (POST/PUT with no payload).
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || body === undefined || body === null) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // 3. Security Headers (Helmet)
  await fastify.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // 4. Rate Limiting
  await fastify.register(require('@fastify/rate-limit'), {
    max: 300,
    timeWindow: '1 minute',
  });

  // 5. WebSockets
  await fastify.register(require('@fastify/websocket'), {
    options: {
      maxPayload: 1048576, // 1MB message limit
    },
  });

  // 6. Serve static files from public/
  const publicDir = path.resolve(__dirname, '../public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  await fastify.register(require('@fastify/static'), {
    root: publicDir,
    prefix: '/',
    index: false,
  });

  // Serve index.html fresh on every load, stamping the asset cache-bust token
  // with the running version so browsers/CDNs never serve a stale app.js.
  const indexPath = path.join(publicDir, 'index.html');
  function serveIndex(request, reply) {
    const html = fs.readFileSync(indexPath, 'utf8').replace(/\?v=[A-Za-z0-9._-]+/g, `?v=${pkg.version}`);
    reply.header('Cache-Control', 'no-store').type('text/html').send(html);
  }
  fastify.get('/', serveIndex);
  fastify.get('/index.html', serveIndex);

  // 7. Register API routes
  await fastify.register(authRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(gitRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(terminalRoutes);
  await fastify.register(systemRoutes);
  await fastify.register(peerRoutes);
  await fastify.register(fleetRoutes);
  await fastify.register(taskRoutes);
  await fastify.register(logRoutes);
  await fastify.register(fileRoutes);
  await fastify.register(proxyRoutes);
  await fastify.register(dockerRoutes);
  await fastify.register(pluginRoutes);
  await fastify.register(moduleRoutes);
  await fastify.register(settingsRoutes);

  // 8. Register WebSocket endpoints
  wsTerminalRoutes(fastify);

  // 9. Load plugins safely
  try {
    await pluginLoader.loadAll(fastify);
  } catch (err) {
    fastify.log.warn(`Plugin loading encountered an error: ${err.message}`);
  }

  return fastify;
}

async function startServer() {
  const fastify = await buildServer();

  // Mark sessions whose tmux/PTY did not survive the restart as closed so the
  // UI reattaches to live terminals instead of resurrecting dead ones.
  try {
    const { reconciled } = terminalManager.reconcileStaleSessions();
    if (reconciled > 0) {
      fastify.log.info(`[Citadel] Reconciled ${reconciled} stale terminal session(s).`);
    }
  } catch {
    // Non-fatal: reconciliation is best-effort.
  }

  // Observability: start sampling resources and recording node health.
  logService.record({ category: 'system', action: 'server_started', message: `Citadel started (v${APP_VERSION}).` });
  logService.startSampler();

  // Graceful shutdown
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\n[Citadel] Received ${signal}. Shutting down gracefully...`);
      try {
        logService.stopSampler();
        await fastify.close();
        closeDatabase();
        console.log('[Citadel] Server and database closed cleanly.');
        process.exit(0);
      } catch (err) {
        console.error('[Citadel] Error during shutdown:', err);
        process.exit(1);
      }
    });
  }

  try {
    await fastify.listen({ port: PORT, host: HOST });

    // Print the panel URL and a scannable QR code on every start so the panel
    // can be opened from a phone right after (re)starting the server.
    let connect = { url: `http://${HOST}:${PORT}`, source: 'localhost' };
    try {
      connect = connectService.getConnectInfo();
    } catch {
      // QR/URL detection is best-effort; fall back to the local address.
    }

    console.log(`
==================================================================
  Citadel — Development Platform & AI Agents
==================================================================
  Panel URL:     ${connect.url}${connect.source && connect.source !== 'localhost' ? `  (${connect.source})` : ''}
  Environment:   ${NODE_ENV}
  Host:          ${require('node:os').hostname()}
  Node.js:       ${process.version}
==================================================================`);

    try {
      console.log(connectService.qrAnsi(connect.url));
      console.log('  Scan to open the panel.');
    } catch {
      // If QR rendering fails, it is not a fatal condition.
    }
  } catch (err) {
    console.error('[Citadel] Failed to start server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildServer,
};
