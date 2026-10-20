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
set -eEuo pipefail

APP_DIR="${CITADEL_DIR:-/srv/citadel/app}"
SERVICE="${CITADEL_SERVICE:-citadel}"
RUN_USER="${CITADEL_RUN_USER:-citadel}"
BRANCH="${CITADEL_REPO_BRANCH:-main}"
PORT="${PORT:-3000}"
HEALTH_RETRIES="${CITADEL_UPDATE_HEALTH_RETRIES:-30}"
HEALTH_INTERVAL="${CITADEL_UPDATE_HEALTH_INTERVAL:-1}"

CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    "" ) : ;;
    *) echo "[citadel-update] ERROR: unknown option: $arg" >&2; exit 2 ;;
  esac
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

service_manager_available() { command -v systemctl >/dev/null 2>&1; }
sys() { $SUDO systemctl "$@"; }

# Can we stop the service and replace its database if we have to roll back?
DB_RESTORE_CAPABLE=true
if [ -e "$DB_PATH" ] && { ! service_manager_available || { [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ]; }; }; then
  DB_RESTORE_CAPABLE=false
fi

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

# $DB_BACKUP holds the EXACT snapshot pathname created for this attempt so the
# rollback restores the matching file instead of reconstructing a name from a
# timestamp. A reliable SQLite-aware snapshot is required when a DB exists: a
# bare copy of a live database can be torn, so we abort before touching the
# checkout rather than pretend it is safe.
DB_BACKUP=""
backup_database() {
  if [ ! -f "$DB_PATH" ]; then
    echo "[citadel-update] No database at $DB_PATH; skipping backup."
    DB_BACKUP=""
    return 0
  fi
  if [ -L "$DB_PATH" ]; then
    echo "[citadel-update] ERROR: refusing a symlinked database path: $DB_PATH" >&2
    return 1
  fi
  mkdir -p "$BACKUP_DIR"
  local stamp target
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  target="$BACKUP_DIR/citadel-${stamp}-${CURRENT_SHORT}.db"
  local done=false
  if command -v sqlite3 >/dev/null 2>&1; then
    if sqlite3 "$DB_PATH" ".timeout 5000" "VACUUM INTO '$target'" >/dev/null 2>&1; then
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
      echo "[citadel-update] WARNING: node backup failed." >&2
    fi
  fi
  if [ "$done" != true ] || [ ! -s "$target" ]; then
    echo "[citadel-update] ERROR: could not create a reliable SQLite snapshot of $DB_PATH; aborting before any change." >&2
    return 1
  fi
  DB_BACKUP="$target"
  echo "[citadel-update] Database snapshot: $DB_BACKUP"
  # Rotate: keep the most recent $BACKUP_KEEP snapshots.
  { ls -1t "$BACKUP_DIR"/citadel-*.db 2>/dev/null || true; } \
    | tail -n +"$((BACKUP_KEEP + 1))" \
    | while read -r old; do
        rm -f "$old" "$old-wal" "$old-shm" 2>/dev/null || true
      done || true
  return 0
}

# Stop the service in a controlled, checked way before touching its database.
stop_service_checked() {
  service_manager_available || return 1
  if ! sys is-active --quiet "$SERVICE" 2>/dev/null; then
    return 0
  fi
  sys stop "$SERVICE" || return 1
  local i
  for i in 1 2 3 4 5; do
    if ! sys is-active --quiet "$SERVICE" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Replace the database with the attempt's snapshot. Only called once the service
# is confirmed stopped. Uses a temp file in the same directory + rename, and
# removes stale SQLite sidecars (they no longer match the restored main file).
restore_database() {
  [ -n "$DB_BACKUP" ] && [ -f "$DB_BACKUP" ] || return 0
  local meta owner mode tmp
  meta="$(stat -c '%u:%g %a' "$DB_PATH" 2>/dev/null || true)"
  owner="${meta%% *}"
  mode="${meta##* }"
  tmp="${DB_PATH}.rollback.$$"
  if ! $SUDO cp -f "$DB_BACKUP" "$tmp"; then
    return 1
  fi
  $SUDO rm -f "$DB_PATH-wal" "$DB_PATH-shm" 2>/dev/null || true
  if ! $SUDO mv -f "$tmp" "$DB_PATH"; then
    $SUDO rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if [ -n "$owner" ] && [ "$owner" != "$mode" ]; then
    $SUDO chown "$owner" "$DB_PATH" 2>/dev/null || true
  fi
  if [ -n "$mode" ]; then
    $SUDO chmod "$mode" "$DB_PATH" 2>/dev/null || true
  fi
  return 0
}

# Poll the service until it is active and answering on the local port.
wait_for_health() {
  service_manager_available || return 0
  local i
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    if sys is-active --quiet "$SERVICE" 2>/dev/null; then
      if ! command -v curl >/dev/null 2>&1; then
        return 0
      fi
      if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/auth/status" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

# Roll back to the previous commit and, when the new code may have migrated the
# database, to the matching snapshot. Reports honestly when any step failed and
# never deletes the snapshot.
perform_rollback() {
  echo "[citadel-update] Rolling back to $CURRENT_SHORT..." >&2
  ROLLBACK_OK=true
  if ! git_safe reset --hard "$CURRENT_SHA"; then ROLLBACK_OK=false; fi
  chown_tree
  if ! npm_install; then ROLLBACK_OK=false; fi

  if [ "$SERVICE_RESTARTED_NEW" = true ] && [ -n "$DB_BACKUP" ]; then
    if [ "$DB_RESTORE_CAPABLE" != true ]; then
      echo "[citadel-update] WARNING: cannot restore the database safely (no systemd/privilege); snapshot kept at $DB_BACKUP" >&2
      ROLLBACK_OK=false
    elif stop_service_checked; then
      if restore_database; then
        echo "[citadel-update] Restored database from $DB_BACKUP" >&2
      else
        echo "[citadel-update] WARNING: database restore failed; snapshot kept at $DB_BACKUP" >&2
        ROLLBACK_OK=false
      fi
    else
      echo "[citadel-update] WARNING: could not confirm $SERVICE stopped; database NOT restored; snapshot kept at $DB_BACKUP" >&2
      ROLLBACK_OK=false
    fi
  fi

  if service_manager_available; then
    sys daemon-reload 2>/dev/null || true
    if ! sys restart "$SERVICE" 2>/dev/null; then ROLLBACK_OK=false; fi
    if ! wait_for_health; then ROLLBACK_OK=false; fi
  fi

  if [ "$ROLLBACK_OK" = true ]; then
    echo "[citadel-update] Rolled back to $CURRENT_SHORT." >&2
  else
    echo "[citadel-update] WARNING: rollback was INCOMPLETE. Snapshot preserved at ${DB_BACKUP:-<none>}; inspect the service manually." >&2
  fi
}

CODE_MODIFIED=false
SERVICE_RESTARTED_NEW=false
ROLLBACK_OK=true

on_error() {
  local rc=$?
  trap - ERR
  perform_rollback
  exit "$rc"
}

CURRENT_SHA="$(git_safe rev-parse HEAD 2>/dev/null || echo unknown)"
CURRENT_SHORT="$(git_safe rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "[citadel-update] Current commit: $CURRENT_SHORT"

echo "[citadel-update] Fetching origin/$BRANCH..."
git_safe fetch --depth 1 origin "$BRANCH"
TARGET_SHA="$(git_safe rev-parse "origin/$BRANCH")"
TARGET_SHORT="$(git_safe rev-parse --short "origin/$BRANCH")"
echo "[citadel-update] Available commit: $TARGET_SHORT"

if [ "$CHECK_ONLY" = true ]; then
  echo "[citadel-update] Check OK ($CURRENT_SHORT -> $TARGET_SHORT). No changes applied."
  exit 0
fi

if [ "$CURRENT_SHA" = "$TARGET_SHA" ]; then
  echo "[citadel-update] Already up to date ($CURRENT_SHORT)."
else
  # Never start changing the checkout unless we could undo it: a DB that cannot
  # be restored safely means the update is refused before any modification.
  if [ -e "$DB_PATH" ] && [ "$DB_RESTORE_CAPABLE" != true ]; then
    echo "[citadel-update] ERROR: cannot safely update: a database exists but this run cannot stop the service/restore it (no systemd or privilege). Refusing before any change." >&2
    exit 1
  fi

  # Snapshot the database before touching the working tree. Aborts (set -e) if a
  # reliable snapshot cannot be produced.
  backup_database

  echo "[citadel-update] Updating $CURRENT_SHORT -> $TARGET_SHORT"
  trap on_error ERR
  git_safe reset --hard "origin/$BRANCH"
  CODE_MODIFIED=true
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
if [ "$(id -u)" -eq 0 ] && service_manager_available \
   && [ -f "$UNIT_SRC" ] && [ -f "$UNIT_DST" ] \
   && ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  echo "[citadel-update] Refreshing ${SERVICE}.service unit..."
  install -m 0644 "$UNIT_SRC" "$UNIT_DST"
  sys daemon-reload
fi

# Keep the Settings → Tunnel helper (root-owned copy of tunnel.sh + sudoers
# rule) in sync so panels installed before it existed gain it on update.
if [ "$(id -u)" -eq 0 ] && service_manager_available && [ -f "$APP_DIR/scripts/tunnel.sh" ]; then
  CITADEL_APP_DIR="$APP_DIR" CITADEL_DATA_DIR="$DATA_DIR_RESOLVED" CITADEL_RUN_USER="$RUN_USER" PORT="$PORT" \
    bash "$APP_DIR/scripts/tunnel.sh" setup >/dev/null 2>&1 \
    || echo "[citadel-update] WARNING: could not refresh the tunnel helper." >&2
fi

# Persistent drop-in: guarantee detached tmux terminals (and the opencode
# sessions running inside them) survive every service restart/update, even if
# the main unit is later replaced by an older copy. Idempotent: never clobbers
# unrelated overrides, only ensures KillMode=process is present.
DROPIN_DIR="/etc/systemd/system/${SERVICE}.service.d"
DROPIN_FILE="$DROPIN_DIR/terminal-persistence.conf"
if [ "$(id -u)" -eq 0 ] && service_manager_available; then
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
    sys daemon-reload
  fi
fi

# The in-panel updater and the Settings -> Tunnel helper run through a scoped
# `sudo` rule. The unit ships with NoNewPrivileges=true, which makes sudo fail
# ("no new privileges" flag is set) even though the rule exists, and
# ProtectSystem=full would make the helpers' targets read-only. Grant exactly
# those capabilities: sudo may elevate, and only the paths the helpers manage
# are writable. Idempotent; applied on the restart at the end of this update.
PRIV_DROPIN="$DROPIN_DIR/updater-privileges.conf"
if [ "$(id -u)" -eq 0 ] && service_manager_available \
   && { [ -f /etc/sudoers.d/citadel-updater ] || [ -f /etc/sudoers.d/citadel-tunnel ]; }; then
  PRIV_WANT='[Service]
NoNewPrivileges=false
ReadWritePaths=-/etc/systemd -/etc/sudoers.d -/etc/profile.d -/usr/local/sbin -/usr/local/bin'
  if [ "$(cat "$PRIV_DROPIN" 2>/dev/null)" != "$PRIV_WANT" ]; then
    echo "[citadel-update] Allowing the service to run its scoped sudo helpers..."
    mkdir -p "$DROPIN_DIR"
    printf '%s\n' "$PRIV_WANT" > "$PRIV_DROPIN"
    sys daemon-reload
  fi
fi

if service_manager_available && sys is-active --quiet "$SERVICE" 2>/dev/null; then
  echo "[citadel-update] Restarting $SERVICE..."
  if ! sys restart "$SERVICE"; then
    echo "[citadel-update] ERROR: could not restart $SERVICE." >&2
    if [ "$CODE_MODIFIED" = true ]; then
      perform_rollback
    fi
    exit 1
  fi
  # The new code is now running, so migrations may have run against the DB.
  SERVICE_RESTARTED_NEW=true
  if wait_for_health; then
    echo "[citadel-update] Service is healthy."
  else
    echo "[citadel-update] ERROR: $SERVICE did not become healthy after the update." >&2
    if [ "$CODE_MODIFIED" = true ]; then
      perform_rollback
      exit 1
    fi
  fi
fi

echo "[citadel-update] Update completed: $TARGET_SHORT"

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
