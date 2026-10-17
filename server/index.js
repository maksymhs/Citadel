/**
 * Citadel Server Main Entrypoint
 */
const Fastify = require('fastify');
const path = require('node:path');
const fs = require('node:fs');

const {
  PORT,
  HOST,
  SESSION_SECRET,
  NODE_ENV,
} = require('./config');

const { initDatabase, closeDatabase } = require('./database/db');
const pluginLoader = require('./services/pluginLoader');

// Routes
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const agentRoutes = require('./routes/agentRoutes');
const terminalRoutes = require('./routes/terminalRoutes');
const systemRoutes = require('./routes/systemRoutes');
const proxyRoutes = require('./routes/proxyRoutes');
const dockerRoutes = require('./routes/dockerRoutes');
const pluginRoutes = require('./routes/pluginRoutes');
const wsTerminalRoutes = require('./routes/wsTerminal');

async function buildServer(options = {}) {
  const fastify = Fastify({
    logger: options.logger !== undefined ? options.logger : (NODE_ENV !== 'test'),
    trustProxy: true,
  });

  // 1. Initialize SQLite Database
  initDatabase(options.customDbPath);

  // 2. Cookie Support
  await fastify.register(require('@fastify/cookie'), {
    secret: SESSION_SECRET || require('node:crypto').randomBytes(32).toString('hex'),
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
  });

  // 7. Register API routes
  await fastify.register(authRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(terminalRoutes);
  await fastify.register(systemRoutes);
  await fastify.register(proxyRoutes);
  await fastify.register(dockerRoutes);
  await fastify.register(pluginRoutes);

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

  // Graceful shutdown
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\n[Citadel] Received ${signal}. Shutting down gracefully...`);
      try {
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
    console.log(`
==================================================================
  Citadel — Development Platform & AI Agents
==================================================================
  Panel URL:     http://${HOST}:${PORT}
  Environment:   ${NODE_ENV}
  Host:          ${require('node:os').hostname()}
  Node.js:       ${process.version}
==================================================================
`);
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
