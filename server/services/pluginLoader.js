/**
 * NexusVPS Plugin Loader & Manifest Engine
 * Loads and isolates official/local plugins safely
 */
const fs = require('node:fs');
const path = require('node:path');
const { PLUGINS_DIR } = require('../config');
const { getDatabase } = require('../database/db');
const auditService = require('./auditService');

const CURRENT_CORE_VERSION = '0.1.0';

class PluginLoader {
  constructor() {
    this.loadedPlugins = new Map(); // id -> { manifest, instance, enabled }
  }

  /**
   * Scan PLUGINS_DIR for valid plugin directories containing plugin.json
   */
  scanPlugins() {
    if (!fs.existsSync(PLUGINS_DIR)) {
      return [];
    }

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    const discovered = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = path.join(PLUGINS_DIR, entry.name, 'plugin.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const raw = fs.readFileSync(manifestPath, 'utf8');
            const manifest = JSON.parse(raw);
            this._validateManifest(manifest);
            discovered.push({
              ...manifest,
              dir: path.join(PLUGINS_DIR, entry.name),
            });
          } catch (err) {
            console.error(`[PluginLoader] Invalid plugin in "${entry.name}":`, err.message);
          }
        }
      }
    }

    return discovered;
  }

  /**
   * Validate required manifest fields
   */
  _validateManifest(m) {
    if (!m.id || typeof m.id !== 'string') throw new Error('Plugin manifest missing string "id".');
    if (!m.name || typeof m.name !== 'string') throw new Error('Plugin manifest missing string "name".');
    if (!m.version || typeof m.version !== 'string') throw new Error('Plugin manifest missing string "version".');
    if (!m.entryPoint || typeof m.entryPoint !== 'string') throw new Error('Plugin manifest missing string "entryPoint".');
    return true;
  }

  /**
   * Initialize and register enabled plugins with Fastify server
   */
  async loadAll(fastify) {
    const discovered = this.scanPlugins();
    const db = getDatabase();

    for (const manifest of discovered) {
      // Check database state
      let dbRow = db.prepare('SELECT * FROM plugins WHERE id = ?').get(manifest.id);
      if (!dbRow) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO plugins (id, name, version, enabled, config, created_at)
          VALUES (?, ?, ?, 1, ?, ?)
        `).run(manifest.id, manifest.name, manifest.version, JSON.stringify(manifest.config || {}), now);
        dbRow = { id: manifest.id, enabled: 1 };
      }

      const isEnabled = Boolean(dbRow.enabled);

      if (isEnabled) {
        await this._loadPlugin(manifest, fastify);
      } else {
        this.loadedPlugins.set(manifest.id, {
          manifest,
          instance: null,
          enabled: false,
          status: 'disabled',
        });
      }
    }
  }

  /**
   * Safely load a single plugin
   */
  async _loadPlugin(manifest, fastify) {
    try {
      const entryFile = path.resolve(manifest.dir, manifest.entryPoint);
      if (!fs.existsSync(entryFile)) {
        throw new Error(`Entry point file not found: ${manifest.entryPoint}`);
      }

      // Safe plugin context contract
      const pluginContext = {
        coreVersion: CURRENT_CORE_VERSION,
        config: manifest.config || {},
        logger: {
          info: (msg) => console.log(`[Plugin:${manifest.id}] ${msg}`),
          warn: (msg) => console.warn(`[Plugin:${manifest.id}] ${msg}`),
          error: (msg) => console.error(`[Plugin:${manifest.id}] ${msg}`),
        },
        audit: (action, details) => auditService.logAction({
          userId: `plugin:${manifest.id}`,
          action,
          details,
        }),
        server: fastify,
      };

      const pluginModule = require(entryFile);
      const initFn = typeof pluginModule === 'function' ? pluginModule : pluginModule.init;

      if (typeof initFn === 'function') {
        await initFn(pluginContext);
      }

      this.loadedPlugins.set(manifest.id, {
        manifest,
        instance: pluginModule,
        enabled: true,
        status: 'active',
      });

      console.log(`[PluginLoader] Plugin "${manifest.name}" (${manifest.id} v${manifest.version}) loaded successfully.`);
    } catch (err) {
      console.error(`[PluginLoader] Error loading plugin "${manifest.id}":`, err.message);
      this.loadedPlugins.set(manifest.id, {
        manifest,
        instance: null,
        enabled: true,
        status: 'error',
        error: err.message,
      });
    }
  }

  /**
   * List all plugins and their statuses
   */
  listPlugins() {
    const discovered = this.scanPlugins();
    const db = getDatabase();

    return discovered.map((m) => {
      const dbRow = db.prepare('SELECT * FROM plugins WHERE id = ?').get(m.id);
      const loaded = this.loadedPlugins.get(m.id);

      return {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description || '',
        author: m.author || '',
        minCoreVersion: m.minCoreVersion || '0.1.0',
        capabilities: m.capabilities || [],
        enabled: dbRow ? Boolean(dbRow.enabled) : true,
        status: loaded ? loaded.status : 'inactive',
        error: loaded?.error || null,
      };
    });
  }

  /**
   * Toggle plugin enabled/disabled in database
   */
  togglePlugin(pluginId, enabled) {
    const db = getDatabase();
    const cleanEnabled = enabled ? 1 : 0;
    db.prepare('UPDATE plugins SET enabled = ? WHERE id = ?').run(cleanEnabled, pluginId);
    return { id: pluginId, enabled: Boolean(cleanEnabled) };
  }
}

module.exports = new PluginLoader();
