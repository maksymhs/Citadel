const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function load(env, cwd) {
  const out = execFileSync(process.execPath, ['-e',
    "const c=require(process.argv[1]);console.log(JSON.stringify([c.PROJECTS_DIR,c.DATABASE_PATH,c.LOGS_DIR,c.PLUGINS_DIR]))",
    path.join(ROOT, 'server', 'config.js')], { cwd, env: { ...process.env, ...env } });
  return JSON.parse(out.toString());
}

test('relative paths in env resolve against the app root, not the cwd', () => {
  const [projects, db, logs, plugins] = load({
    PROJECTS_DIR: './data/projects', DATABASE_PATH: './data/citadel.db',
    LOGS_DIR: './data/logs', PLUGINS_DIR: './plugins',
  }, require('node:os').tmpdir());
  assert.strictEqual(projects, path.join(ROOT, 'data', 'projects'));
  assert.strictEqual(db, path.join(ROOT, 'data', 'citadel.db'));
  assert.strictEqual(logs, path.join(ROOT, 'data', 'logs'));
  assert.strictEqual(plugins, path.join(ROOT, 'plugins'));
});
