#!/usr/bin/env node
/**
 * Builds the code knowledge graph agents can query instead of reading whole
 * files (https://github.com/safishamsi/graphify). Output goes to graphify-out/
 * (graph.json, GRAPH_REPORT.md, graph.html), which is git-ignored.
 *
 * Code-only and offline: no LLM backend is ever used (GRAPHIFY_BACKEND=none).
 * Graphify is a Python tool and a development aid, so it is NOT part of
 * `npm install` or the installer: a production host never needs it. When it is
 * missing this exits 0 with install instructions; pass --require to fail
 * instead (for release checks).
 *
 *   npm run graph            # build (first time) or update (graphify-out exists)
 *   npm run graph -- --full  # force a full rebuild
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = 'graphify-out';
const INSTALL_HINT = 'Install it once with `uv tool install graphifyy` (or `pipx install graphifyy`), then re-run `npm run graph`.';

function hasGraphify(env) {
  const res = spawnSync('graphify', ['--version'], { env, encoding: 'utf8' });
  return !res.error && res.status === 0;
}

/** Returns the process exit code. `io` is injectable for tests. */
function main(argv = process.argv.slice(2), { env = process.env, cwd = ROOT, log = console } = {}) {
  const require_ = argv.includes('--require');
  const full = argv.includes('--full');

  if (!hasGraphify(env)) {
    log.error(`graphify not found. ${INSTALL_HINT}`);
    return require_ ? 1 : 0;
  }

  const update = !full && fs.existsSync(path.join(cwd, OUT_DIR, 'graph.json'));
  const args = update ? ['update', '.'] : ['extract', '--code-only'];
  log.log(`graphify ${args.join(' ')}`);
  const res = spawnSync('graphify', args, {
    cwd,
    env: { ...env, GRAPHIFY_BACKEND: 'none' },
    stdio: 'inherit',
  });
  if (res.error || res.status !== 0) {
    log.error('graphify failed; the graph was not updated.');
    return res.status || 1;
  }
  if (!fs.existsSync(path.join(cwd, OUT_DIR, 'graph.json'))) {
    log.error(`graphify finished but ${OUT_DIR}/graph.json is missing.`);
    return 1;
  }
  log.log(`Graph ready in ${OUT_DIR}/ (read GRAPH_REPORT.md first).`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
