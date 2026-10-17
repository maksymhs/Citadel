#!/usr/bin/env bash
# ==============================================================================
# Citadel — Self-Updater
# Pulls the latest code, snapshots the database, installs dependencies and
# restarts the service. Rolls back automatically if anything fails.
# Intended to run with root privileges (e.g. via sudo) or as the service user.
#
#   sudo citadel-update            # perform the update
#   sudo citadel-update --check    # verify it can update, change nothing
# ==============================================================================
set -euo pipefail

APP_DIR="${CITADEL_DIR:-/srv/citadel/app}"
SERVICE="${CITADEL_SERVICE:-citadel}"
RUN_USER="${CITADEL_RUN_USER:-citadel}"
BRANCH="${CITADEL_REPO_BRANCH:-main}"
PORT="${PORT:-3000}"

CHECK_ONLY=false
for arg in "$@"; do
  [ "$arg" = "--check" ] && CHECK_ONLY=true
done

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

if [ ! -d "$APP_DIR" ]; then
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[citadel-update] ERROR: $APP_DIR is not a git checkout; cannot self-update." >&2
  exit 1
fi

cd "$APP_DIR"

# safe.directory avoids git's "dubious ownership" refusal when this runs as root
# on a working tree owned by the (non-root) service user.
git_safe() { git -c safe.directory='*' "$@"; }

DATA_DIR_RESOLVED="${DATA_DIR:-$(dirname "$APP_DIR")/data}"
DB_PATH="${DATABASE_PATH:-$DATA_DIR_RESOLVED/citadel.db}"
BACKUP_DIR="${CITADEL_BACKUP_DIR:-$DATA_DIR_RESOLVED/backups}"
BACKUP_KEEP="${CITADEL_BACKUP_KEEP:-5}"

# Install dependencies as the service user when running as root, so files are
# not left root-owned.
npm_install() {
  echo "[citadel-update] Installing dependencies..."
  if [ "$(id -u)" -eq 0 ] && id "$RUN_USER" >/dev/null 2>&1; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$RUN_USER" -- bash -c "cd '$APP_DIR' && npm install --omit=dev"
    else
      su -s /bin/bash "$RUN_USER" -c "cd '$APP_DIR' && npm install --omit=dev"
    fi
  else
    npm install --omit=dev
  fi
}

chown_tree() {
  if [ "$(id -u)" -eq 0 ] && id "$RUN_USER" >/dev/null 2>&1; then
    chown -R "$RUN_USER:$RUN_USER" "$(dirname "$APP_DIR")" 2>/dev/null || true
  fi
}

# Consistent SQLite snapshot (WAL included) with rotation. Best-effort: a missing
# database is not an error, but an unwritable backup aborts the update.
backup_database() {
  if [ ! -f "$DB_PATH" ]; then
    echo "[citadel-update] No database at $DB_PATH; skipping backup."
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  local stamp target
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  target="$BACKUP_DIR/citadel-${stamp}-${CURRENT}.db"
  local done=false
  if command -v sqlite3 >/dev/null 2>&1; then
    if sqlite3 "$DB_PATH" ".timeout 5000" "VACUUM INTO '$target'"; then
      done=true
    else
      echo "[citadel-update] WARNING: sqlite3 snapshot failed; trying node." >&2
    fi
  fi
  # Online backup via the app's own better-sqlite3 (WAL-consistent, no CLI needed).
  if [ "$done" = false ] && [ -d "$APP_DIR/node_modules/better-sqlite3" ]; then
    if (cd "$APP_DIR" && node -e "
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], { readonly: true });
      db.backup(process.argv[2]).then(() => { db.close(); }).catch((e) => { console.error(e.message); process.exit(1); });
    " "$DB_PATH" "$target"); then
      done=true
    else
      echo "[citadel-update] WARNING: node backup failed; copying files." >&2
    fi
  fi
  # Last resort: plain copy (may be torn if writes happen mid-copy).
  if [ "$done" = false ]; then
    cp -f "$DB_PATH" "$target"
    [ -f "$DB_PATH-wal" ] && cp -f "$DB_PATH-wal" "$target-wal" || true
    [ -f "$DB_PATH-shm" ] && cp -f "$DB_PATH-shm" "$target-shm" || true
  fi
  echo "[citadel-update] Database snapshot: $target"
  # Rotate: keep the most recent $BACKUP_KEEP snapshots.
  ls -1t "$BACKUP_DIR"/citadel-*.db 2>/dev/null \
    | tail -n +"$((BACKUP_KEEP + 1))" \
    | while read -r old; do
        rm -f "$old" "$old-wal" "$old-shm" 2>/dev/null || true
      done
}

# Restore the previous commit + deps and restart. Used by the ERR trap and after
# a failed health check.
perform_rollback() {
  echo "[citadel-update] Rolling back to $CURRENT..." >&2
  git_safe reset --hard "$CURRENT" || true
  chown_tree
  npm_install || true
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart "$SERVICE" 2>/dev/null || true
  fi
  echo "[citadel-update] Rolled back to $CURRENT." >&2
}

on_error() {
  local rc=$?
  trap - ERR
  perform_rollback
  exit "$rc"
}

# Poll the service until it is active and answering on the local port.
wait_for_health() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local i
  for i in $(seq 1 30); do
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      if ! command -v curl >/dev/null 2>&1; then
        return 0
      fi
      if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/auth/status" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

CURRENT="$(git_safe rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "[citadel-update] Current commit: $CURRENT"

echo "[citadel-update] Fetching origin/$BRANCH..."
git_safe fetch --depth 1 origin "$BRANCH"
TARGET="$(git_safe rev-parse --short "origin/$BRANCH")"
echo "[citadel-update] Available commit: $TARGET"

if [ "$CHECK_ONLY" = true ]; then
  echo "[citadel-update] Check OK ($CURRENT -> $TARGET). No changes applied."
  exit 0
fi

if [ "$CURRENT" = "$TARGET" ]; then
  echo "[citadel-update] Already up to date ($CURRENT)."
else
  # Snapshot the database before touching the working tree.
  backup_database

  echo "[citadel-update] Updating $CURRENT -> $TARGET"
  trap on_error ERR
  git_safe reset --hard "origin/$BRANCH"
  chown_tree
  npm_install
  trap - ERR
fi

echo "[citadel-update] Running diagnostics..."
if [ "$(id -u)" -eq 0 ] && id "$RUN_USER" >/dev/null 2>&1; then
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- bash -c "cd '$APP_DIR' && DATA_DIR='$DATA_DIR_RESOLVED' node scripts/doctor.js" || true
  else
    su -s /bin/bash "$RUN_USER" -c "cd '$APP_DIR' && DATA_DIR='$DATA_DIR_RESOLVED' node scripts/doctor.js" || true
  fi
else
  DATA_DIR="$DATA_DIR_RESOLVED" node scripts/doctor.js || true
fi

# Refresh the installed systemd unit from the repo so unit changes (e.g.
# KillMode=process, which keeps tmux terminals alive across restarts) take
# effect on update. Local overrides belong in a *.service.d drop-in, which this
# does not touch.
UNIT_SRC="$APP_DIR/scripts/citadel.service"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
if [ "$(id -u)" -eq 0 ] && command -v systemctl >/dev/null 2>&1 \
   && [ -f "$UNIT_SRC" ] && [ -f "$UNIT_DST" ] \
   && ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  echo "[citadel-update] Refreshing ${SERVICE}.service unit..."
  install -m 0644 "$UNIT_SRC" "$UNIT_DST"
  systemctl daemon-reload
fi

# Persistent drop-in: guarantee detached tmux terminals (and the opencode
# sessions running inside them) survive every service restart/update, even if
# the main unit is later replaced by an older copy. Idempotent: never clobbers
# unrelated overrides, only ensures KillMode=process is present.
DROPIN_DIR="/etc/systemd/system/${SERVICE}.service.d"
DROPIN_FILE="$DROPIN_DIR/terminal-persistence.conf"
if [ "$(id -u)" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  dropin_changed=false
  if [ ! -f "$DROPIN_FILE" ]; then
    mkdir -p "$DROPIN_DIR"
    printf '[Service]\nKillMode=process\n' > "$DROPIN_FILE"
    dropin_changed=true
  elif ! grep -qE '^[[:space:]]*KillMode=process' "$DROPIN_FILE"; then
    printf '\n[Service]\nKillMode=process\n' >> "$DROPIN_FILE"
    dropin_changed=true
  fi
  if [ "$dropin_changed" = true ]; then
    echo "[citadel-update] Ensuring tmux terminal persistence (KillMode=process)..."
    systemctl daemon-reload
  fi
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo "[citadel-update] Restarting $SERVICE..."
  systemctl restart "$SERVICE"
  if wait_for_health; then
    echo "[citadel-update] Service is healthy."
  else
    echo "[citadel-update] ERROR: $SERVICE did not become healthy after the update." >&2
    if [ "$CURRENT" != "$TARGET" ]; then
      perform_rollback
      exit 1
    fi
  fi
fi

echo "[citadel-update] Update completed: $TARGET"

# Ensure the friendly `citadel` CLI launcher exists (and points at this app dir).
CLI_DST="/usr/local/bin/citadel"
if [ "$(id -u)" -eq 0 ] && [ -f "$APP_DIR/scripts/citadel" ]; then
  CLI_TMP="$(mktemp)"
  printf '#!/bin/sh\n# Citadel CLI launcher (managed by the installer/updater)\nexec bash "%s/scripts/citadel" "$@"\n' "$APP_DIR" > "$CLI_TMP"
  if ! cmp -s "$CLI_TMP" "$CLI_DST"; then
    install -m 0755 "$CLI_TMP" "$CLI_DST"
    echo "[citadel-update] Installed the 'citadel' CLI launcher."
  fi
  rm -f "$CLI_TMP"
fi

# Keep the installed helper in sync with the repository. Only when running as
# root and invoked as the installed helper. Replaced via rename (new inode) so
# the currently executing script is not truncated mid-read.
if [ "$(id -u)" -eq 0 ] && [ -f "$APP_DIR/scripts/update.sh" ] && [ "$0" = "/usr/local/sbin/citadel-update" ]; then
  install -m 0755 "$APP_DIR/scripts/update.sh" /usr/local/sbin/.citadel-update.new \
    && mv -f /usr/local/sbin/.citadel-update.new /usr/local/sbin/citadel-update \
    && echo "[citadel-update] Updater helper refreshed."
fi
