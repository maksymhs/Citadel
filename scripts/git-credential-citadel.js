#!/usr/bin/env node
/**
 * Citadel Git Credential Helper
 *
 * Lets plain `git push` / `git pull` inside project terminals reuse the provider
 * tokens already stored (encrypted) by the panel, without ever writing them to
 * disk in clear text.
 *
 * Install (see install.sh) with:
 *   git config --system credential.helper /usr/local/bin/citadel-git-credential
 *
 * where that wrapper execs this script with DATA_DIR/DATABASE_PATH set.
 *
 * Implements the git-credential protocol: `get` returns credentials for the
 * requested host; `store`/`erase` are intentional no-ops because tokens are
 * managed from the panel UI.
 */
const path = require('node:path');

function parseCredentialInput(input) {
  const fields = {};
  for (const line of String(input).split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      fields[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return fields;
}

function resolveDataEnv(env = process.env) {
  const out = { ...env };
  if (!out.DATA_DIR && out.DATABASE_PATH) {
    out.DATA_DIR = path.dirname(out.DATABASE_PATH);
  }
  if (!out.DATABASE_PATH && out.DATA_DIR) {
    out.DATABASE_PATH = path.join(out.DATA_DIR, 'citadel.db');
  }
  // `.env` may carry repo-relative paths (e.g. ./data/projects) that only make
  // sense for local development. Outside systemd, derive absolute paths from
  // DATA_DIR so config does not try to create directories relative to cwd.
  if (out.DATA_DIR) {
    const parent = path.dirname(out.DATA_DIR);
    if (!out.PROJECTS_DIR || !path.isAbsolute(out.PROJECTS_DIR)) {
      out.PROJECTS_DIR = path.join(parent, 'projects');
    }
    if (!out.LOGS_DIR || !path.isAbsolute(out.LOGS_DIR)) {
      out.LOGS_DIR = path.join(parent, 'logs');
    }
  }
  return out;
}

function getCredentialsForHost(host, env = process.env) {
  const normalizedHost = String(host || '').toLowerCase();
  if (!normalizedHost) return null;

  // Apply derived data paths before loading config-dependent modules.
  const resolved = resolveDataEnv(env);
  for (const key of ['DATA_DIR', 'DATABASE_PATH', 'PROJECTS_DIR', 'LOGS_DIR']) {
    if (resolved[key]) process.env[key] = resolved[key];
  }

  const { initDatabase } = require('../server/database/db');
  const gitCredentialsService = require('../server/services/gitCredentialsService');

  try {
    initDatabase();
  } catch {
    return null;
  }

  const auth = gitCredentialsService.resolveAuthForUrl(`https://${normalizedHost}/`);
  if (!auth) return null;

  return { username: auth.cloneUser, password: auth.token, protocol: 'https', host: normalizedHost };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const action = process.argv[2] || 'get';
  const input = await readStdin();

  if (action !== 'get') {
    // store/erase: tokens live in the panel database, so nothing to persist.
    return;
  }

  const fields = parseCredentialInput(input);
  const cred = getCredentialsForHost(fields.host);
  if (!cred) return;

  process.stdout.write(`username=${cred.username}\npassword=${cred.password}\n`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

module.exports = { parseCredentialInput, resolveDataEnv, getCredentialsForHost };
