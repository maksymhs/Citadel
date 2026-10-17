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

CURRENT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "[citadel-update] Current commit: $CURRENT"

echo "[citadel-update] Fetching origin/$BRANCH..."
git fetch --depth 1 origin "$BRANCH"
TARGET="$(git rev-parse --short "origin/$BRANCH")"
echo "[citadel-update] Available commit: $TARGET"

if [ "$CHECK_ONLY" = true ]; then
  echo "[citadel-update] Check OK ($CURRENT -> $TARGET). No changes applied."
  exit 0
fi

if [ "$CURRENT" = "$TARGET" ]; then
  echo "[citadel-update] Already up to date ($CURRENT)."
else
  echo "[citadel-update] Updating $CURRENT -> $TARGET"
  git reset --hard "origin/$BRANCH"
fi

echo "[citadel-update] Installing dependencies..."
if [ "$(id -u)" -eq 0 ] && id "$RUN_USER" >/dev/null 2>&1; then
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- bash -c "cd '$APP_DIR' && npm install --omit=dev"
  else
    su -s /bin/bash "$RUN_USER" -c "cd '$APP_DIR' && npm install --omit=dev"
  fi
  chown -R "$RUN_USER:$RUN_USER" "$(dirname "$APP_DIR")" 2>/dev/null || true
else
  npm install --omit=dev
fi

echo "[citadel-update] Running diagnostics..."
node scripts/doctor.js || true

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo "[citadel-update] Restarting $SERVICE..."
  systemctl restart --no-block "$SERVICE"
fi

echo "[citadel-update] Update completed: $TARGET"
