#!/usr/bin/env node
/**
 * Citadel Secret Vault CLI (`citadel-creds`)
 *
 * Gives agents a single, easy way to read the credentials the panel stores:
 *
 *   citadel-creds list                     # names + kinds (never values)
 *   citadel-creds get GITHUB_TOKEN         # print one value
 *   citadel-creds env                      # `export NAME=value` lines (eval-able)
 *   citadel-creds exec -- <cmd> [args...]  # run a command with the env injected
 *   citadel-creds materialize <name> [path]  # write a file/ssh secret as 0600
 *
 * Values are decrypted by the service user that owns the data directory; they
 * are never written to disk unless `materialize` is used.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveDataEnv } = require('./git-credential-citadel');

function applyDataEnv() {
  const resolved = resolveDataEnv(process.env);
  for (const key of ['DATA_DIR', 'DATABASE_PATH', 'PROJECTS_DIR', 'LOGS_DIR']) {
    if (resolved[key]) process.env[key] = resolved[key];
  }
}

function loadStore() {
  applyDataEnv();
  const { initDatabase } = require('../server/database/db');
  initDatabase();
  return require('../server/services/secretStore');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function usage() {
  return [
    'Usage: citadel-creds <command> [args]',
    '',
    'Commands:',
    '  list                        List secret names and kinds (no values)',
    '  get <name>                  Print a single secret value',
    '  env                         Print `export NAME=value` lines',
    '  exec -- <cmd> [args...]     Run a command with vault env vars injected',
    '  materialize <name> [path]   Write a file/ssh secret as a 0600 file',
    '  help                        Show this help',
  ].join('\n');
}

function cmdList(store) {
  const secrets = store.listSecrets();
  if (secrets.length === 0) {
    process.stderr.write('No secrets stored.\n');
    return 0;
  }
  for (const s of secrets) {
    process.stdout.write(`${s.name}\t${s.kind}\t${s.updated_at}\n`);
  }
  return 0;
}

function cmdGet(store, name) {
  if (!name) {
    process.stderr.write('citadel-creds get: a secret name is required.\n');
    return 2;
  }
  const secret = store.getSecret(name);
  if (!secret) {
    process.stderr.write(`citadel-creds get: no secret named "${name}".\n`);
    return 1;
  }
  process.stdout.write(String(secret.value));
  if (process.stdout.isTTY) process.stdout.write('\n');
  return 0;
}

function cmdEnv(store) {
  const vars = store.envVars();
  for (const [name, value] of Object.entries(vars)) {
    process.stdout.write(`export ${name}=${shellQuote(value)}\n`);
  }
  return 0;
}

function cmdExec(store, args) {
  // Accept both `exec -- cmd` and `exec cmd`.
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 0) {
    process.stderr.write('citadel-creds exec: a command is required (exec -- <cmd> [args...]).\n');
    return 2;
  }
  const [file, ...rest] = args;
  const res = spawnSync(file, rest, {
    stdio: 'inherit',
    env: { ...process.env, ...store.envVars() },
  });
  if (res.error) {
    process.stderr.write(`citadel-creds exec: ${res.error.message}\n`);
    return 127;
  }
  return res.status === null ? 1 : res.status;
}

function defaultMaterializePath(secret, name) {
  if (secret.metadata && secret.metadata.path) return secret.metadata.path;
  if (secret.kind === 'ssh') return path.join(os.homedir(), '.ssh', name);
  return path.join(process.cwd(), name);
}

function cmdMaterialize(store, name, target) {
  if (!name) {
    process.stderr.write('citadel-creds materialize: a secret name is required.\n');
    return 2;
  }
  const secret = store.getSecret(name);
  if (!secret) {
    process.stderr.write(`citadel-creds materialize: no secret named "${name}".\n`);
    return 1;
  }
  const dest = target || defaultMaterializePath(secret, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, String(secret.value), { mode: 0o600 });
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  process.stdout.write(`${dest}\n`);
  return 0;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '-h' || command === '--help') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  // `exec` does not need the DB unless there are secrets; still, load lazily so
  // `--help` and arg errors work without a database.
  const store = loadStore();

  switch (command) {
    case 'list':
    case 'ls':
      return cmdList(store);
    case 'get':
      return cmdGet(store, rest[0]);
    case 'env':
      return cmdEnv(store);
    case 'exec':
      return cmdExec(store, rest);
    case 'materialize':
      return cmdMaterialize(store, rest[0], rest[1]);
    default:
      process.stderr.write(`citadel-creds: unknown command "${command}".\n\n${usage()}\n`);
      return 2;
  }
}

if (require.main === module) {
  let code = 1;
  try {
    code = main();
  } catch (err) {
    process.stderr.write(`citadel-creds: ${err.message}\n`);
    code = 1;
  }
  process.exit(code);
}

module.exports = { main };
