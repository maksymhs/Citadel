#!/usr/bin/env node
/**
 * Citadel built-in self-updater.
 *
 * Runs as the (unprivileged) service user. It updates the checkout in place
 * (git fetch + reset) and reinstalls production dependencies, then restarts the
 * service. Because the application directory is owned by the service user, no
 * root helper is required.
 *
 * Restart strategy: ask systemd to restart the unit; when that is not permitted
 * (no polkit rule / no sudo), signal the running server process instead and let
 * systemd's Restart=always bring it back. This worker is spawned detached, so it
 * survives the change of the service's main process.
 *
 * State is written to a JSON status file and a human-readable log so the panel
 * can report progress after the restart.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = process.env.CITADEL_APP_DIR || path.resolve(__dirname, '..');
const BRANCH = process.env.CITADEL_REPO_BRANCH || 'main';
const REPO = process.env.CITADEL_REPO || 'maksymhs/Citadel';
const SERVICE = process.env.CITADEL_SERVICE || 'citadel';
const SERVER_PID = parseInt(process.env.CITADEL_SERVER_PID || '0', 10) || null;
const LOG_PATH = process.env.CITADEL_UPDATE_LOG || path.join(APP_DIR, 'data', 'update.log');
const STATUS_PATH = process.env.CITADEL_UPDATE_STATUS || path.join(APP_DIR, 'data', 'update-status.json');
const LOCK_PATH = process.env.CITADEL_UPDATE_LOCK || path.join(APP_DIR, 'data', 'update.lock');

const CURRENT_LOCK_MS = 60 * 60 * 1000;

// Hard safety gate: never rewrite the checkout when self-update is disabled
// (the test suite sets CITADEL_SELF_UPDATE=0). This must be checked before any
// filesystem or git work.
if (['0', 'false', 'off', 'no'].includes(String(process.env.CITADEL_SELF_UPDATE || '1').toLowerCase())) {
  process.stdout.write('[self-update] disabled by configuration (CITADEL_SELF_UPDATE=0); exiting.\n');
  process.exit(0);
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(LOG_PATH, msg);
  } catch {
    // Logging must never break the update.
  }
  process.stdout.write(msg);
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeStatus(patch) {
  const next = { ...readStatus(), ...patch, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2));
  } catch {
    // Ignore status write failures.
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy fallback */
    }
  }
}

function run(cmd, args, options = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, [...args], { cwd: APP_DIR, encoding: 'utf8', env: process.env, ...options });
  if (res.stdout) log(res.stdout.trim());
  if (res.stderr) log(res.stderr.trim());
  if (res.error) log(`spawn error: ${res.error.message}`);
  return res;
}

function git(...args) {
  return run('git', ['-C', APP_DIR, ...args]);
}

function npmInstall() {
  return run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
}

function acquireLock() {
  try {
    const st = fs.statSync(LOCK_PATH);
    if (Date.now() - st.mtimeMs < CURRENT_LOCK_MS) return false;
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // No lock file (or it could not be stat'd): proceed to create one.
  }
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // Ignore.
  }
}

function restart() {
  log(`Restarting service "${SERVICE}"...`);
  const res = run('systemctl', ['restart', SERVICE]);
  if (!res.error && res.status === 0) {
    writeStatus({ restart: 'systemctl' });
    log('Service restarted via systemctl.');
    return;
  }
  log('systemctl restart not permitted; signalling the running server process instead.');
  if (SERVER_PID) {
    try {
      process.kill(SERVER_PID, 'SIGTERM');
      writeStatus({ restart: 'signal' });
      log(`Sent SIGTERM to server process ${SERVER_PID}; systemd will relaunch it.`);
    } catch (err) {
      writeStatus({ restart: 'none' });
      log(`Could not signal server process ${SERVER_PID}: ${err.message}`);
    }
  } else {
    writeStatus({ restart: 'none' });
    log('No server PID provided; restart the service manually.');
  }
}

function main() {
  if (!acquireLock()) {
    log('Another update is already running; exiting.');
    return;
  }

  let restartNeeded = false;
  const startedAt = new Date().toISOString();
  writeStatus({
    state: 'running',
    startedAt,
    finishedAt: null,
    branch: BRANCH,
    repo: REPO,
    message: 'Starting update...',
    error: null,
  });

  try {
    sleepSync(3000);

    const inside = git('rev-parse', '--is-inside-work-tree');
    if (inside.status !== 0) {
      writeStatus({
        state: 'failed',
        finishedAt: new Date().toISOString(),
        error: `${APP_DIR} is not a git checkout.`,
      });
      return;
    }

    // Never discard uncommitted work: refuse to update a dirty checkout.
    const dirty = git('status', '--porcelain', '--untracked-files=no');
    if (dirty.status === 0 && dirty.stdout.trim()) {
      log('Local modifications detected; refusing to overwrite them.');
      writeStatus({
        state: 'failed',
        finishedAt: new Date().toISOString(),
        error: 'Local modifications detected in the checkout; commit or stash them before updating.',
      });
      return;
    }

    const oldRes = git('rev-parse', 'HEAD');
    const fromCommit = oldRes.status === 0 ? oldRes.stdout.trim() : null;
    writeStatus({ fromCommit });

    restartNeeded = true;

    writeStatus({ message: `Fetching origin/${BRANCH}...` });
    if (git('fetch', '--tags', '--prune', 'origin').status !== 0) {
      writeStatus({ state: 'failed', finishedAt: new Date().toISOString(), error: 'git fetch failed.' });
      return;
    }

    writeStatus({ message: `Updating to origin/${BRANCH}...` });
    if (git('reset', '--hard', `origin/${BRANCH}`).status !== 0) {
      writeStatus({ state: 'failed', finishedAt: new Date().toISOString(), error: 'git reset failed.' });
      return;
    }
    const newRes = git('rev-parse', 'HEAD');
    const toCommit = newRes.status === 0 ? newRes.stdout.trim() : null;
    writeStatus({ toCommit });

    log('Installing production dependencies...');
    writeStatus({ message: 'Installing dependencies...' });
    const npm = npmInstall();
    if (npm.error || npm.status !== 0) {
      log('Dependency install failed; rolling back to the previous commit.');
      writeStatus({ message: 'Install failed; rolling back...' });
      if (fromCommit) {
        git('reset', '--hard', fromCommit);
        npmInstall();
        writeStatus({ toCommit: fromCommit });
      }
      writeStatus({
        state: 'failed',
        finishedAt: new Date().toISOString(),
        error: npm.error ? npm.error.message : 'npm install failed.',
      });
      return;
    }

    writeStatus({
      state: 'success',
      finishedAt: new Date().toISOString(),
      message: `Updated to ${toCommit ? toCommit.slice(0, 7) : BRANCH}.`,
      error: null,
    });
    log('Update completed successfully.');
  } catch (err) {
    log(`Unexpected error: ${err.stack || err.message}`);
    writeStatus({ state: 'failed', finishedAt: new Date().toISOString(), error: err.message });
  } finally {
    if (restartNeeded) {
      sleepSync(1500);
      restart();
    }
    releaseLock();
  }
}

main();
