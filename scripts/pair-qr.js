#!/usr/bin/env node
// Creates a one-time pairing link for `citadel qr`. Invitations live in SQLite
// so the running server can consume one created by this separate CLI process.
const { initDatabase, closeDatabase } = require('../server/database/db');
const hostService = require('../server/services/hostService');

try {
  initDatabase();
  const url = (process.argv[2] || '').trim() || undefined;
  process.stdout.write(hostService.createInvite({ userId: null, url }).compactLink);
} finally {
  closeDatabase();
}
