/**
 * Citadel Optional Docker Service
 * Secure, read-controlled bridge to Docker Engine API via unix socket
 */
const http = require('node:http');
const fs = require('node:fs');
const { DOCKER_SOCKET } = require('../config');

class DockerService {
  constructor(socketPath = DOCKER_SOCKET) {
    this.socketPath = socketPath;
  }

  /**
   * Helper to make requests to the Docker Engine socket
   */
  _request(method, path) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.socketPath)) {
        return reject(new Error(`Docker socket not found at ${this.socketPath}`));
      }

      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          timeout: 2000,
          headers: {
            Host: 'localhost',
            Accept: 'application/json',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(data ? JSON.parse(data) : null);
              } catch {
                resolve(data);
              }
            } else {
              reject(new Error(`Docker API error ${res.statusCode}: ${data}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('Docker socket request timed out.'));
      });

      req.on('error', (err) => {
        reject(new Error(`Failed to communicate with Docker socket: ${err.message}`));
      });

      req.end();
    });
  }

  /**
   * Check whether Docker socket is present and responsive
   */
  async isAvailable() {
    try {
      if (!fs.existsSync(this.socketPath)) return false;
      const res = await this._request('GET', '/v1.41/_ping');
      return res === 'OK' || res?.status === 'OK' || true;
    } catch {
      return false;
    }
  }

  /**
   * Get Docker engine status and version
   */
  async getStatus() {
    const available = await this.isAvailable();
    if (!available) {
      return {
        available: false,
        socketPath: this.socketPath,
        message: 'Docker is not installed, socket is unavailable, or process has insufficient permissions. Citadel runs completely without Docker.',
      };
    }

    try {
      const version = await this._request('GET', '/v1.41/version');
      return {
        available: true,
        version: version.Version || 'unknown',
        apiVersion: version.ApiVersion,
        os: version.Os,
        arch: version.Arch,
      };
    } catch (err) {
      return {
        available: false,
        error: err.message,
      };
    }
  }

  /**
   * List containers with safe sanitization
   */
  async listContainers({ all = true } = {}) {
    if (!await this.isAvailable()) {
      return [];
    }

    try {
      const containers = await this._request('GET', `/v1.41/containers/json?all=${all ? 1 : 0}`);
      return (containers || []).map((c) => ({
        id: c.Id.slice(0, 12),
        fullId: c.Id,
        names: (c.Names || []).map((n) => n.replace(/^\//, '')),
        image: c.Image,
        state: c.State,
        status: c.Status,
        created: c.Created,
        ports: (c.Ports || []).map((p) => ({
          ip: p.IP,
          privatePort: p.PrivatePort,
          publicPort: p.PublicPort,
          type: p.Type,
        })),
      }));
    } catch (err) {
      console.warn(`[DockerService] Error listing containers: ${err.message}`);
      return [];
    }
  }
}

module.exports = new DockerService();
