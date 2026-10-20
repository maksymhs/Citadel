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
  DATA_DIR,
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
const secretRoutes = require('./routes/secretRoutes');
const hostRoutes = require('./routes/hostRoutes');
const remoteProxyRoutes = require('./routes/remoteProxyRoutes');
const wsTerminalRoutes = require('./routes/wsTerminal');
const hostService = require('./services/hostService');
const meshService = require('./services/meshService');
const updateRolloutService = require('./services/updateRolloutService');

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

  // Every API response advertises this host's identity and current addresses so
  // peers can heal stored URLs after a tunnel rotates.
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      for (const [name, value] of Object.entries(hostService.identityHeaders())) {
        reply.header(name, value);
      }
    }
    return payload;
  });

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
  await fastify.register(secretRoutes);
  await fastify.register(hostRoutes);
  await fastify.register(remoteProxyRoutes);

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

  // Peer address announcements. A Cloudflare Quick Tunnel URL changes on every
  // restart, so paired hosts re-learn this host's current address shortly after
  // boot and then periodically. Best-effort: no peer being online is normal.
  const announce = () => {
    hostService.announceToPeers().catch((err) => {
      fastify.log.debug(`[Citadel] Peer announce failed: ${err.message}`);
    });
  };
  // When this host's own address changes (tunnel started, rotated, or switched
  // to a domain) tell the peers right away instead of waiting for the 5-minute
  // cycle, and retry a few times because the peer may be mid-restart too.
  const announceSoon = () => {
    for (const delay of [1500, 20000, 60000]) {
      const t = setTimeout(announce, delay);
      if (typeof t.unref === 'function') t.unref();
    }
  };
  // Opt-in: after this machine moved to a newer version, update its paired
  // machines one at a time (waits for the peers to be reachable first).
  const rolloutStartup = setTimeout(() => {
    updateRolloutService.maybePropagateAfterUpdate().catch((err) => {
      fastify.log.debug(`[Citadel] Update rollout failed: ${err.message}`);
    });
  }, 45000);
  if (typeof rolloutStartup.unref === 'function') rolloutStartup.unref();

  // Opt-in mesh: periodically introduce paired machines to each other.
  const meshStartup = setTimeout(() => meshService.scheduleSync(0), 30000);
  const meshTimer = setInterval(() => meshService.scheduleSync(0), 10 * 60 * 1000);
  if (typeof meshStartup.unref === 'function') meshStartup.unref();
  if (typeof meshTimer.unref === 'function') meshTimer.unref();
  const announceStartup = setTimeout(announce, 5000);
  const announceTimer = setInterval(announce, 5 * 60 * 1000);
  if (typeof announceStartup.unref === 'function') announceStartup.unref();
  if (typeof announceTimer.unref === 'function') announceTimer.unref();

  // Graceful shutdown
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\n[Citadel] Received ${signal}. Shutting down gracefully...`);
      try {
        clearInterval(announceTimer);
        clearTimeout(announceStartup);
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

    // Print a pairing QR code on every start. Any camera can still open the
    // panel URL, while another Citadel's Pair screen redeems the invitation.
    let connect = { url: `http://${HOST}:${PORT}`, source: 'localhost' };
    try {
      connect = connectService.getConnectInfo();
    } catch {
      // QR/URL detection is best-effort; fall back to the local address.
    }

    let qrText = null;
    try {
      const invite = hostService.createInvite({ userId: null });
      qrText = invite.compactLink;
      // The installer banner runs right after the service starts. Handing it
      // the same text keeps the post-install QR legible and, when it fits,
      // dual-purpose too.
      fs.writeFileSync(path.join(DATA_DIR, 'connect-qr'), `${qrText}\n`, { mode: 0o600 });
    } catch {
      // No invitation is not fatal, but do not leave a stale code behind.
      try { fs.rmSync(path.join(DATA_DIR, 'connect-qr'), { force: true }); } catch { /* ignore */ }
    }

    // Keep connect-qr synchronized when the Cloudflare tunnel starts or rotates its URL.
    const tunnelUrlFile = path.join(DATA_DIR, 'tunnel-url');
    let lastTunnelUrl = '';
    try {
      if (fs.existsSync(tunnelUrlFile)) {
        lastTunnelUrl = fs.readFileSync(tunnelUrlFile, 'utf8').trim();
      }
    } catch { /* ignore */ }

    const tunnelWatcher = setInterval(() => {
      try {
        if (!fs.existsSync(tunnelUrlFile)) return;
        const current = fs.readFileSync(tunnelUrlFile, 'utf8').trim();
        if (current && current !== lastTunnelUrl) {
          lastTunnelUrl = current;
          connectService._reset();
          announceSoon();
          try {
            const invite = hostService.createInvite({ userId: null });
            fs.writeFileSync(path.join(DATA_DIR, 'connect-qr'), `${invite.compactLink}\n`, { mode: 0o600 });
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }, 2500);
    tunnelWatcher.unref();

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
      if (qrText) {
        console.log(connectService.qrAnsi(qrText));
        console.log('  Scan with any camera to open the panel, or from another Citadel\'s Pair screen to pair.');
      }
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
