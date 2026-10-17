#!/usr/bin/env bash
# ==============================================================================
# Citadel — Self-Updater
# Pulls the latest code, installs dependencies and restarts the service.
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
  echo "[citadel-update] Updating $CURRENT -> $TARGET"
  git_safe reset --hard "origin/$BRANCH"
fi

# When running as root, git checkout and file writes above are owned by root.
# Re-assert ownership on the service user BEFORE running npm as that user,
# otherwise npm cannot rewrite package-lock.json (EACCES).
if [ "$(id -u)" -eq 0 ] && id "$RUN_USER" >/dev/null 2>&1; then
  chown -R "$RUN_USER:$RUN_USER" "$(dirname "$APP_DIR")" 2>/dev/null || true
fi

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

echo "[citadel-update] Running diagnostics..."
DIAG_DATA_DIR="${DATA_DIR:-$(dirname "$APP_DIR")/data}"
if [ "$(id -u)" -eq 0 ] && id "$RUN_USER" >/dev/null 2>&1; then
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- bash -c "cd '$APP_DIR' && DATA_DIR='$DIAG_DATA_DIR' node scripts/doctor.js" || true
  else
    su -s /bin/bash "$RUN_USER" -c "cd '$APP_DIR' && DATA_DIR='$DIAG_DATA_DIR' node scripts/doctor.js" || true
  fi
else
  DATA_DIR="$DIAG_DATA_DIR" node scripts/doctor.js || true
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
  systemctl restart --no-block "$SERVICE"
fi

echo "[citadel-update] Update completed: $TARGET"

# Keep the installed helper in sync with the repository. Only when running as
# root and invoked as the installed helper. Replaced via rename (new inode) so
# the currently executing script is not truncated mid-read.
if [ "$(id -u)" -eq 0 ] && [ -f "$APP_DIR/scripts/update.sh" ] && [ "$0" = "/usr/local/sbin/citadel-update" ]; then
  install -m 0755 "$APP_DIR/scripts/update.sh" /usr/local/sbin/.citadel-update.new \
    && mv -f /usr/local/sbin/.citadel-update.new /usr/local/sbin/citadel-update \
    && echo "[citadel-update] Updater helper refreshed."
fi
