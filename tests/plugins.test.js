const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const pluginLoader = require('../server/services/pluginLoader');
const { buildServer } = require('../server/index');
const { closeDatabase } = require('../server/database/db');

describe('Plugin System & Manifest Tests', () => {
  let app;
  const testDb = path.resolve(__dirname, '../data/test-plugins.db');
  const brokenPluginDir = path.resolve(__dirname, '../plugins/broken-test-plugin');

  before(async () => {
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);

    // Create a mock failing plugin to test error boundary
    if (!fs.existsSync(brokenPluginDir)) {
      fs.mkdirSync(brokenPluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(brokenPluginDir, 'plugin.json'),
        JSON.stringify({
          id: 'broken-test-plugin',
          name: 'Broken Plugin',
          version: '0.0.1',
          entryPoint: 'bad-file.js',
          capabilities: [],
        })
      );
    }

    app = await buildServer({ customDbPath: testDb, logger: false });
  });

  after(async () => {
    await app.close();
    closeDatabase();
    if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
    if (fs.existsSync(brokenPluginDir)) {
      fs.rmSync(brokenPluginDir, { recursive: true, force: true });
    }
  });

  test('scanPlugins discovers plugins with valid manifests', () => {
    const list = pluginLoader.scanPlugins();
    assert.ok(Array.isArray(list));
    const helloPlugin = list.find((p) => p.id === 'hello-stats');
    assert.ok(helloPlugin);
    assert.equal(helloPlugin.name, 'System Stats Widget');
  });

  test('Error boundary: Failing plugin does not crash the server and records error status', () => {
    const list = pluginLoader.listPlugins();
    const broken = list.find((p) => p.id === 'broken-test-plugin');
    assert.ok(broken);
    assert.equal(broken.status, 'error');
    assert.ok(broken.error);
  });

  test('Active plugin custom route is reachable on Fastify server', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/plugins/hello-stats/ping',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.plugin, 'hello-stats');
    assert.equal(body.status, 'ok');
  });

  test('togglePlugin enables and disables plugin state', () => {
    const disabled = pluginLoader.togglePlugin('hello-stats', false);
    assert.equal(disabled.enabled, false);

    const enabled = pluginLoader.togglePlugin('hello-stats', true);
    assert.equal(enabled.enabled, true);
  });
});
