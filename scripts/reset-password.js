#!/usr/bin/env node
/**
 * Offline admin recovery (`citadel reset-password`).
 *
 *   citadel reset-password --list              # show usernames
 *   citadel reset-password [username]          # prompt for a new password
 *   printf '%s' "$PW" | citadel reset-password [username]   # non-interactive
 *
 * Needs shell access to the host and read/write access to the database, so it
 * grants nothing a local administrator did not already have. The password is
 * never taken from argv (it would leak into `ps` and shell history). All of the
 * user's sessions are revoked. Peer tokens and the credential vault are untouched.
 */
const readline = require('node:readline');
const { resolveDataEnv } = require('./git-credential-citadel');

function applyDataEnv() {
  const resolved = resolveDataEnv(process.env);
  for (const key of ['DATA_DIR', 'DATABASE_PATH', 'PROJECTS_DIR', 'LOGS_DIR']) {
    if (resolved[key]) process.env[key] = resolved[key];
  }
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (text) => {
      if (text === prompt) process.stderr.write(text);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function readNewPassword() {
  if (!process.stdin.isTTY) return readStdin();
  const first = await readHidden('New password (min 8 characters): ');
  const second = await readHidden('Repeat new password: ');
  if (first !== second) throw new Error('Passwords do not match.');
  return first;
}

async function main() {
  const args = process.argv.slice(2);
  applyDataEnv();
  const { initDatabase, getDatabase } = require('../server/database/db');
  const { setUserPassword } = require('../server/security/auth');
  const auditService = require('../server/services/auditService');
  initDatabase();
  const db = getDatabase();
  const users = db.prepare('SELECT username, role FROM users ORDER BY created_at').all();

  if (args.includes('--list')) {
    if (users.length === 0) console.log('No users yet: open the panel to run the first-time setup.');
    for (const u of users) console.log(`${u.username}\t${u.role}`);
    return;
  }
  if (users.length === 0) {
    throw new Error('No users exist yet: open the panel to run the first-time setup.');
  }

  let username = args.find((a) => !a.startsWith('-'));
  if (!username) {
    if (users.length > 1) {
      throw new Error(`Several users exist (${users.map((u) => u.username).join(', ')}); pass the username.`);
    }
    username = users[0].username;
  }

  const password = await readNewPassword();
  const user = setUserPassword(username, password);
  if (!user) {
    throw new Error(`No such user "${username}". Known users: ${users.map((u) => u.username).join(', ')}.`);
  }
  auditService.logAction({
    userId: user.id,
    action: 'password_reset_cli',
    targetType: 'user',
    targetId: user.id,
  });
  console.log(`Password updated for "${user.username}". All of its sessions were signed out.`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
