/**
 * NexusVPS ProxyProvider Interface & Caddy Implementation
 * Safe, non-blocking reverse proxy management via local admin API
 */
const http = require('node:http');
const { CADDY_ADMIN_API } = require('../config');
const { getDatabase } = require('../database/db');
const { validateDomain } = require('../security/guard');

class ProxyProvider {
  async isAvailable() {
    throw new Error('isAvailable() must be implemented.');
  }
  async publishDomain(projectId, domain, targetPort) {
    throw new Error('publishDomain() must be implemented.');
  }
  async unpublishDomain(domain) {
    throw new Error('unpublishDomain() must be implemented.');
  }
  async listDeployments(projectId = null) {
    throw new Error('listDeployments() must be implemented.');
  }
}

class CaddyProxyProvider extends ProxyProvider {
  constructor(adminUrl = CADDY_ADMIN_API) {
    super();
    this.adminUrl = adminUrl;
  }

  /**
   * Helper to perform HTTP request to Caddy Admin API
   */
  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(path, this.adminUrl);
        const req = http.request(
          url,
          {
            method,
            timeout: 2500,
            headers: {
              'Content-Type': 'application/json',
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  resolve(data ? JSON.parse(data) : { success: true });
                } catch {
                  resolve({ success: true, raw: data });
                }
              } else {
                reject(new Error(`Caddy API error ${res.statusCode}: ${data}`));
              }
            });
          }
        );

        req.on('timeout', () => {
          req.destroy(new Error('Caddy API connection timed out.'));
        });

        req.on('error', (err) => {
          reject(new Error(`Cannot connect to Caddy Admin API: ${err.message}`));
        });

        if (body) {
          req.write(JSON.stringify(body));
        }
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Check if Caddy Admin API is responding locally
   */
  async isAvailable() {
    try {
      await this._request('GET', '/config/');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get provider status and diagnostics
   */
  async getStatus() {
    const available = await this.isAvailable();
    return {
      provider: 'caddy',
      available,
      adminUrl: this.adminUrl,
      helpMessage: available
        ? 'Caddy reverse proxy is active and reachable via local admin API.'
        : 'Caddy is optional. If you wish to use automated SSL & domain publishing, install Caddy and ensure its admin API listens on 127.0.0.1:2019.',
    };
  }

  /**
   * Publish a domain to a project's local port
   */
  async publishDomain(projectId, rawDomain, targetPort) {
    const domain = validateDomain(rawDomain);
    const port = parseInt(targetPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error('Valid port number (1-65535) is required.');
    }

    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM deployments WHERE domain = ?').get(domain);
    if (existing && existing.project_id !== projectId) {
      throw new Error(`Domain "${domain}" is already assigned to another project.`);
    }

    const available = await this.isAvailable();
    let caddyConfigured = false;

    if (available) {
      // Build route definition for Caddy
      const route = {
        '@id': `nvps_${domain.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        match: [{ host: [domain] }],
        handle: [
          {
            handler: 'reverse_proxy',
            upstreams: [{ dial: `127.0.0.1:${port}` }],
          },
        ],
        terminal: true,
      };

      try {
        // Post route to Caddy http server routes
        await this._request('POST', '/config/apps/http/servers/srv0/routes', route);
        caddyConfigured = true;
      } catch (err) {
        console.warn(`[ProxyProvider] Failed to push route to Caddy: ${err.message}`);
      }
    }

    const deploymentId = existing ? existing.id : require('node:crypto').randomUUID();
    const now = new Date().toISOString();

    if (existing) {
      db.prepare(`
        UPDATE deployments
        SET target_port = ?, status = ?, ssl_active = ?
        WHERE id = ?
      `).run(port, caddyConfigured ? 'active' : 'pending', caddyConfigured ? 1 : 0, existing.id);
    } else {
      db.prepare(`
        INSERT INTO deployments (id, project_id, domain, target_port, status, ssl_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(deploymentId, projectId, domain, port, caddyConfigured ? 'active' : 'pending', caddyConfigured ? 1 : 0, now);
    }

    return {
      id: deploymentId,
      projectId,
      domain,
      targetPort: port,
      status: caddyConfigured ? 'active' : 'saved_offline',
      caddyConfigured,
    };
  }

  /**
   * Unpublish a domain
   */
  async unpublishDomain(domain) {
    const cleanDomain = validateDomain(domain);
    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM deployments WHERE domain = ?').get(cleanDomain);

    if (existing) {
      db.prepare('DELETE FROM deployments WHERE id = ?').run(existing.id);
    }

    if (await this.isAvailable()) {
      try {
        const routeId = `nvps_${cleanDomain.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        await this._request('DELETE', `/id/${routeId}`);
      } catch {
        // Ignore route delete error if already removed
      }
    }

    return { success: true, domain: cleanDomain };
  }

  /**
   * List deployments
   */
  listDeployments(projectId = null) {
    const db = getDatabase();
    const query = projectId
      ? `SELECT d.*, p.name AS project_name FROM deployments d JOIN projects p ON d.project_id = p.id WHERE d.project_id = ?`
      : `SELECT d.*, p.name AS project_name FROM deployments d JOIN projects p ON d.project_id = p.id ORDER BY d.created_at DESC`;

    return projectId ? db.prepare(query).all(projectId) : db.prepare(query).all();
  }
}

module.exports = new CaddyProxyProvider();
