#!/usr/bin/env node
/**
 * `citadel setup-code`: show the one-time code the first-run screen asks for.
 *
 * Until the first administrator exists, creating that account needs this code,
 * which only someone with shell access to the host can read, so a stranger who
 * finds the panel first cannot claim it. Once an administrator exists there is
 * no code and this says so.
 *
 *   citadel setup-code           # human-friendly
 *   citadel setup-code --quiet   # only the code (nothing once setup is done)
 */
const { resolveDataEnv } = require('./git-credential-citadel');

function applyDataEnv() {
  const resolved = resolveDataEnv(process.env);
  for (const key of ['DATA_DIR', 'DATABASE_PATH', 'PROJECTS_DIR', 'LOGS_DIR']) {
    if (resolved[key]) process.env[key] = resolved[key];
  }
}

function main() {
  const quiet = process.argv.includes('--quiet');
  applyDataEnv();
  const { initDatabase } = require('../server/database/db');
  const { isSetupComplete } = require('../server/security/auth');
  const setupCode = require('../server/security/setupCode');
  initDatabase();

  if (isSetupComplete()) {
    if (!quiet) console.log('Setup is already complete: no setup code is needed.');
    return;
  }
  const code = setupCode.ensure();
  if (quiet) {
    console.log(code);
    return;
  }
  console.log(`Setup code: ${code}`);
  console.log('Enter it on the first-run screen when you create the administrator account.');
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
