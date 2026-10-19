#!/usr/bin/env node
// Creates a one-time pairing link for `citadel qr`. Invitations live in SQLite
// so the running server can consume one created by this separate CLI process.
const { initDatabase, closeDatabase } = require('../server/database/db');
const hostService = require('../server/services/hostService');

try {
  initDatabase();
  process.stdout.write(hostService.createInvite({ userId: null }).compactLink);
} finally {
  closeDatabase();
}
