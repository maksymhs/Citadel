#!/usr/bin/env node
/**
 * Regenerates the README screenshots in docs/img/ from a throwaway demo instance.
 *
 * Everything shown is simulated: an isolated Citadel (temp data directory, never
 * the real install) with four fake machines, 24 h of fake history and one disk
 * alert. Run it after the dashboard UI changes:
 *
 *   npm install --no-save puppeteer-core
 *   CHROME_PATH=/path/to/chrome node scripts/screenshots.js
 *
 * Needs Chrome or Chromium (CHROME_PATH, or google-chrome / chromium on PATH).
 */
/* global document, NodeFilter, localStorage */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'img');
const PORT = Number(process.env.SCREENSHOT_PORT || 3777);
const GB = 1024 ** 3;

// The demo must never touch a real install: every data path is overridden before
// the server code is loaded, and the script refuses to run otherwise.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-demo-'));
if (!data.startsWith(os.tmpdir())) throw new Error('refusing to run outside a temp directory');
Object.assign(process.env, {
  DATA_DIR: data,
  DATABASE_PATH: path.join(data, 'citadel.db'),
  PROJECTS_DIR: path.join(data, 'projects'),
  LOGS_DIR: path.join(data, 'logs'),
  HOME: data,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  NODE_ENV: 'test',
  CITADEL_SELF_UPDATE: '0',
  CITADEL_REQUIRE_SETUP_CODE: '0',
  CITADEL_ALLOW_RESTART: '0',
});
delete process.env.TERMINAL_ADMIN_USER;
// The demo's terminals run on their own tmux server, never the real one.
process.env.TMUX_TMPDIR = data;
delete process.env.TMUX;
delete process.env.TMUX_PANE;

const PROFILES = {
  local: { hostname: 'frankfurt-vps', platform: 'linux', arch: 'x64', cores: 4, load: 0.31, mem: 41, disk: 38, diskTotal: 80 * GB, memTotal: 8 * GB, up: 23 * 86400 + 5 * 3600, terminals: 3, temp: null },
  mac: { hostname: 'macbook-pro', platform: 'darwin', arch: 'arm64', cores: 10, load: 0.18, mem: 63, disk: 57, diskTotal: 500 * GB, memTotal: 32 * GB, up: 4 * 86400 + 2 * 3600, terminals: 2, temp: { celsius: 46.5, source: 'battery' } },
  nas: { hostname: 'home-server', platform: 'linux', arch: 'x64', cores: 8, load: 0.42, mem: 54, disk: 91, diskTotal: 4000 * GB, memTotal: 16 * GB, up: 61 * 86400, terminals: 1, temp: { celsius: 58, source: 'cpu' } },
  pi: { hostname: 'raspberry-pi', platform: 'linux', arch: 'arm64', cores: 4, load: 0.09, mem: 29, disk: 33, diskTotal: 64 * GB, memTotal: 4 * GB, up: 12 * 86400, terminals: 0, temp: { celsius: 51, source: 'cpu' } },
};
const NAMES = { mac: 'MacBook Pro', nas: 'Home server', pi: 'Raspberry Pi' };
// The fake machines answer on localhost; show believable addresses instead.
const ADDRESSES = { mac: 'macbook.tail1a2b.ts.net', nas: 'home-server.local', pi: 'pi.tail1a2b.ts.net' };

const healthOf = (p) => ({
  timestamp: Date.now(),
  hostname: p.hostname,
  platform: p.platform,
  arch: p.arch,
  uptimeSeconds: p.up,
  cores: p.cores,
  load1: +(p.load * p.cores).toFixed(2),
  loadPerCore: p.load,
  memory: { totalBytes: p.memTotal, usedPercent: p.mem },
  disk: { totalBytes: p.diskTotal, freeBytes: Math.round(p.diskTotal * (1 - p.disk / 100)), usedPercent: p.disk },
  temperature: p.temp,
  activeTerminals: p.terminals,
});

function fakeMachine(profile) {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer demo-token') { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200);
    res.end(req.url.startsWith('/api/system/health')
      ? JSON.stringify({ health: healthOf(profile), version: '0.42.0', commit: 'demo' })
      : JSON.stringify({ version: { version: '0.42.0' } }));
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const res = spawnSync('which', [name], { encoding: 'utf8' });
    if (res.status === 0) return res.stdout.trim();
  }
  throw new Error('Chrome not found: set CHROME_PATH.');
}

// Demo projects with believable files and two persistent terminals showing a test run.
async function seedWorkspace(app, cookie) {
  const create = async (name, description) => (await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: { name, description } })).json().project;
  const api = await create('acme-api', 'REST API for the Acme storefront');
  await create('web-dashboard', 'Customer dashboard (React)');
  await create('infra', 'Terraform and deployment scripts');

  const files = {
    'package.json': '{\n  "name": "acme-api",\n  "version": "2.4.0",\n  "scripts": { "test": "node --test", "start": "node src/index.js" }\n}\n',
    'README.md': '# acme-api\n\nREST API for the Acme storefront.\n',
    'Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "src/index.js"]\n',
    'docker-compose.yml': 'services:\n  api:\n    build: .\n    ports: ["8080:8080"]\n',
    '.gitignore': 'node_modules\n.env\n',
    'src/index.js': "console.log('listening on :8080');\n",
    'src/routes/orders.js': 'module.exports = [];\n',
    'src/routes/products.js': 'module.exports = [];\n',
    'src/db.js': 'module.exports = {};\n',
    'tests/orders.test.js': "require('node:test');\n",
    'tests/products.test.js': "require('node:test');\n",
    'docs/openapi.yaml': 'openapi: 3.1.0\n',
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(api.path, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  // The fake test run the terminal replays (colours as a real runner would print them).
  fs.writeFileSync(path.join(data, 'demo-run.sh'), [
    "printf '\\033[2m> acme-api@2.4.0 test\\033[0m\\n'",
    "printf '\\033[2m> node --test\\033[0m\\n\\n'",
    "printf '  \\033[32m✔\\033[0m orders: creates an order \\033[2m(12ms)\\033[0m\\n'",
    "printf '  \\033[32m✔\\033[0m orders: rejects an empty cart \\033[2m(4ms)\\033[0m\\n'",
    "printf '  \\033[32m✔\\033[0m orders: applies a discount code \\033[2m(9ms)\\033[0m\\n'",
    "printf '  \\033[32m✔\\033[0m products: lists active products \\033[2m(7ms)\\033[0m\\n'",
    "printf '  \\033[32m✔\\033[0m products: filters by category \\033[2m(5ms)\\033[0m\\n'",
    "printf '  \\033[32m✔\\033[0m db: reconnects after a dropped connection \\033[2m(31ms)\\033[0m\\n'",
    "printf '\\n\\033[32mℹ tests 6\\033[0m\\n\\033[32mℹ pass 6\\033[0m\\nℹ fail 0\\nℹ duration_ms 412\\n'",
  ].join('\n'));

  fs.writeFileSync(path.join(data, 'demo-ps.sh'), [
    "cat <<'EOF'",
    'NAME                IMAGE          COMMAND                  SERVICE   CREATED       STATUS         PORTS',
    'acme-api-api-1      acme-api-api   "node src/index.js"      api       2 hours ago   Up 2 hours     0.0.0.0:8080->8080/tcp',
    'acme-api-cache-1    redis:7        "docker-entrypoint.s…"   cache     2 hours ago   Up 2 hours     6379/tcp',
    'acme-api-db-1       postgres:16    "docker-entrypoint.s…"   db        2 hours ago   Up 2 hours     5432/tcp',
    'EOF',
  ].join('\n'));

  const terminalManager = require('../server/services/terminalManager');
  const session = (name) => terminalManager.createSession({ projectId: api.id, name, cols: 120, rows: 30 });
  const first = session('tests');
  const second = session('dev server');
  await sleep(1200);
  // Typed once the browser is attached, otherwise its terminal replies end up on the prompt.
  const type = (text) => {
    for (const id of [first.sessionId, second.sessionId]) {
      const active = terminalManager.activePtySessions.get(id);
      if (active && active.ptyProcess) active.ptyProcess.write(text);
    }
  };
  return { projectId: api.id, terminalManager, type };
}

async function startDemo() {
  const fakes = {};
  for (const key of ['mac', 'nas', 'pi']) {
    fakes[key] = fakeMachine(PROFILES[key]);
    fakes[key].url = await listen(fakes[key]);
  }

  const nodeService = require('../server/services/nodeService');
  nodeService.getHealth = async () => healthOf(PROFILES.local);
  const { buildServer } = require('../server/index');
  const app = await buildServer({ customDbPath: process.env.DATABASE_PATH, logger: false });
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'demo-password-1A' } });
  const cookie = `session_id=${setup.cookies[0].value}`;

  const hostService = require('../server/services/hostService');
  hostService.setInstanceName('Frankfurt VPS');
  const ids = { local: 'local' };
  for (const key of ['mac', 'nas', 'pi']) {
    ids[key] = hostService.upsertPairedHost({
      instanceId: `demo-${key}`, name: NAMES[key], url: fakes[key].url, urls: [fakes[key].url], outboundToken: 'demo-token', inboundToken: `in-${key}`,
    }).id;
  }
  await app.inject({ method: 'PUT', url: '/api/settings/connect', headers: { cookie }, payload: { publicUrl: 'https://vps.example.com' } });

  fs.writeFileSync(path.join(data, '.tmux.conf'), [
    "set -g status-left ' acme-api '",
    'set -g status-left-length 30',
    "set -g status-right ' frankfurt-vps  %H:%M '",
    '',
  ].join('\n'));
  const workspace = await seedWorkspace(app, cookie);

  // 24 h of history, one sample every 5 minutes, with a short outage and a sleeping laptop.
  const db = require('../server/database/db').getDatabase();
  const insert = db.prepare('INSERT INTO host_checks (host_id, ts, online, latency_ms, load_per_core, mem_percent, disk_percent) VALUES (?,?,?,?,?,?,?)');
  const now = Date.now();
  const wave = (i, amp, base, period) => Math.max(0, Math.min(100, Math.round(base + amp * Math.sin(i / period) + ((i * 7919) % 5) - 2)));
  db.transaction(() => {
    for (let i = 288; i >= 1; i -= 1) {
      for (const key of Object.keys(ids)) {
        const p = PROFILES[key];
        const online = !((key === 'nas' && i > 84 && i < 90) || (key === 'mac' && i > 190 && i < 230));
        insert.run(ids[key], now - i * 300000, online ? 1 : 0, online ? (key === 'local' ? 0 : 40 + ((i * 31) % 90)) : null,
          online ? +(p.load * (0.6 + 0.8 * Math.abs(Math.sin(i / 11)))).toFixed(2) : null,
          online ? wave(i, 6, p.mem, 17) : null, online ? Math.min(99, p.disk - Math.floor(i / 70)) : null);
      }
    }
  })();

  const monitor = require('../server/services/monitorService');
  for (let i = 0; i < 4; i += 1) await monitor.pollOnce(); // a disk alert needs consecutive breaches
  await app.listen({ port: PORT, host: '127.0.0.1' });

  const byAddress = Object.fromEntries(Object.entries(fakes).map(([key, f]) => [f.url.replace('http://', ''), ADDRESSES[key]]));
  byAddress[path.basename(data)] = 'ada'; // the temp directory shows up in file paths
  const close = async () => {
    try {
      for (const id of [...workspace.terminalManager.activePtySessions.keys()]) workspace.terminalManager.killSession(id);
    } catch { /* best effort: the tmux server lives in the temp directory anyway */ }
    await app.close();
    for (const f of Object.values(fakes)) f.close();
    fs.rmSync(data, { recursive: true, force: true });
  };
  return { cookie: cookie.split('=')[1], byAddress, close, workspace };
}

async function takeScenes(demo) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    throw new Error('puppeteer-core is not installed: run `npm install --no-save puppeteer-core`.');
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const base = `http://127.0.0.1:${PORT}`;

  const scene = async (name, { theme = 'dark', width = 1440, height = 900, dsf = 1.5, clip, steps } = {}) => {
    // A fresh browser context each time, so the selected machine and theme never carry over.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: dsf });
    await page.setCookie({ name: 'session_id', value: demo.cookie, url: base });
    await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('citadel.theme', t); } catch { /* ignore */ } }, theme);
    await page.goto(`${base}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.nav-item');
    await sleep(1800);
    if (steps) await steps(page);
    await page.evaluate((map) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        for (const [from, to] of Object.entries(map)) if (n.nodeValue.includes(from)) n.nodeValue = n.nodeValue.replace(from, to);
      }
      for (const crumb of document.querySelectorAll('.files-crumbs button, .files-crumbs span')) if (crumb.textContent.trim() === 'tmp') crumb.textContent = 'home';
      const toasts = document.getElementById('toast-root');
      if (toasts) toasts.innerHTML = '';
    }, demo.byAddress);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
    console.log(`saved docs/img/${name}.png`);
    await context.close();
  };

  const retry = async (name, opts) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { await scene(name, opts); return; } catch (err) { console.log(`retrying ${name}: ${err.message.split('\n')[0]}`); }
    }
    throw new Error(`could not capture ${name}`);
  };

  await retry('dashboard-dark');
  await retry('dashboard-light', { theme: 'light' });
  await retry('machine-selector-dark', { dsf: 2, clip: { x: 0, y: 0, width: 520, height: 420 }, steps: async (page) => { await page.click('#host-selector-btn'); await sleep(700); } });
  await retry('machine-alert-dark', { steps: async (page) => { await page.click('#host-selector-btn'); await sleep(500); await page.click('[data-ctx-idx="2"]'); await sleep(3500); } });
  await retry('terminal-dark', {
    height: 700,
    steps: async (page) => {
      await page.evaluate(() => document.querySelector('.nav-item[data-view="workspace"]').click());
      await sleep(1200);
      await page.evaluate(() => [...document.querySelectorAll('#sidebar-nav a.nav-item')].find((a) => a.textContent.trim().startsWith('acme-api')).click());
      await sleep(3500);
      const { type } = demo.workspace;
      type(`\x15export PS1='\\[\\e[1;32m\\]ada@frankfurt-vps\\[\\e[0m\\]:\\[\\e[1;34m\\]~/acme-api\\[\\e[0m\\]$ '; npm() { sh '${data}/demo-run.sh'; }; docker() { sh '${data}/demo-ps.sh'; }; clear\r`);
      await sleep(900);
      type('npm test\r');
      await sleep(1500);
      type('docker compose ps\r');
      await sleep(900);
    },
  });
  await retry('files-dark', {
    height: 700,
    steps: async (page) => {
      await page.evaluate(() => document.querySelector('.nav-item[data-view="files"]').click());
      await sleep(2000);
      // Walk into the demo project without ever showing the real host's folders.
      for (const folder of [...path.relative('/', data).split(path.sep), 'projects', 'acme-api']) {
        let box = null;
        for (let attempt = 0; attempt < 20 && !box; attempt += 1) {
          box = await page.evaluate((name) => {
            const tile = [...document.querySelectorAll('.files-tile')].find((t) => t.querySelector('.files-tile-name').textContent === name);
            if (!tile) return null;
            tile.scrollIntoView({ block: 'center' });
            const r = tile.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }, folder);
          if (!box) await sleep(500);
        }
        if (!box) throw new Error(`folder ${folder} not found in the file explorer`);
        await page.mouse.click(box.x, box.y); // select the tile, then open it with the keyboard
        await page.keyboard.press('Enter');
        await sleep(1500);
      }
    },
  });
  await retry('mobile-dark', { width: 390, height: 844, dsf: 2 });
  await browser.close();
}

(async () => {
  const demo = await startDemo();
  if (process.env.SCREENSHOT_SERVE) {
    // Keep the demo running to look at it in a browser or probe it; Ctrl+C stops it.
    console.log(`Demo at http://127.0.0.1:${PORT} (session cookie: session_id=${demo.cookie})`);
    process.on('SIGINT', () => demo.close().then(() => process.exit(0)));
    return;
  }
  try {
    await takeScenes(demo);
  } finally {
    await demo.close();
  }
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
