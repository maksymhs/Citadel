#!/usr/bin/env bash
# Citadel — full uninstaller
# Removes the systemd service, drop-ins, sudoers rules, helper scripts, the
# data directory (/srv/citadel), the service user and the local source checkout
# the installer ran from. Nothing is left behind.
#
#   sudo ./scripts/uninstall.sh               # remove EVERYTHING
#   sudo ./scripts/uninstall.sh --keep-data    # keep /srv/citadel (data + user)
#   sudo ./scripts/uninstall.sh --keep-source  # keep the local git checkout
set -euo pipefail

SERVICE="${CITADEL_SERVICE:-citadel}"
RUN_USER="${CITADEL_RUN_USER:-citadel}"
TARGET_DIR="${CITADEL_TARGET_DIR:-/srv/citadel}"
PURGE=true
REMOVE_SOURCE=true
for arg in "$@"; do
  case "$arg" in
    --keep-data) PURGE=false ;;
    --purge) PURGE=true ;;
    --keep-source) REMOVE_SOURCE=false ;;
    --help|-h)
      echo "Usage: $0 [--keep-data] [--keep-source]"
      echo "  (default)      Remove everything: /srv/citadel, the user and the local clone."
      echo "  --keep-data    Keep /srv/citadel (data, projects) and the service user."
      echo "  --keep-source  Keep the local source checkout the installer used."
      exit 0
      ;;
  esac
done

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "ERROR: administrator privileges are required (run as root or with sudo)." >&2
    exit 1
  fi
fi

# Collect the local checkout paths to delete (if any). Read the one recorded by
# the installer BEFORE /srv/citadel is wiped, and also detect the checkout this
# very script runs from (its parent directory).
RECORDED_SOURCE=""
if [ -f "$TARGET_DIR/data/source-dir" ]; then
  RECORDED_SOURCE="$(cat "$TARGET_DIR/data/source-dir" 2>/dev/null || true)"
fi
SCRIPT_SOURCE=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  [ -n "$SCRIPT_DIR" ] && SCRIPT_SOURCE="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || true)"
fi

is_removable_checkout() {
  local dir="$1"
  [ -n "$dir" ] || return 1
  [ -d "$dir/.git" ] || return 1
  case "$dir" in
    "/"|/usr|/usr/*|/etc|/etc/*|/home|/root|/var|/var/*|/srv|/srv/citadel|/srv/citadel/*) return 1 ;;
  esac
  [ "$dir" != "$TARGET_DIR" ] || return 1
  return 0
}

echo "=================================================="
echo "          Citadel — Uninstall                     "
echo "=================================================="

if command -v systemctl >/dev/null 2>&1; then
  echo "Stopping and disabling ${SERVICE}.service..."
  $SUDO systemctl stop "$SERVICE" 2>/dev/null || true
  $SUDO systemctl disable "$SERVICE" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/${SERVICE}.service"
  $SUDO rm -rf "/etc/systemd/system/${SERVICE}.service.d"
  $SUDO systemctl daemon-reload 2>/dev/null || true
  $SUDO systemctl reset-failed "$SERVICE" 2>/dev/null || true

  echo "Stopping and removing the Cloudflare tunnel (if any)..."
  $SUDO systemctl stop citadel-tunnel 2>/dev/null || true
  $SUDO systemctl disable citadel-tunnel 2>/dev/null || true
  $SUDO rm -f /etc/systemd/system/citadel-tunnel.service
  $SUDO rm -f "$TARGET_DIR/data/tunnel-url" 2>/dev/null || true
  $SUDO systemctl daemon-reload 2>/dev/null || true
fi

echo "Removing sudoers rules..."
$SUDO rm -f /etc/sudoers.d/citadel-terminal /etc/sudoers.d/citadel-updater

echo "Removing helper scripts..."
$SUDO rm -f /usr/local/sbin/citadel-update /usr/local/sbin/.citadel-update.new
$SUDO rm -f /usr/local/bin/citadel-git-credential
$SUDO rm -f /usr/local/bin/citadel

if command -v git >/dev/null 2>&1; then
  HELPER="$($SUDO git config --system --get credential.helper 2>/dev/null || true)"
  if [ "$HELPER" = "/usr/local/bin/citadel-git-credential" ]; then
    echo "Removing system git credential helper..."
    $SUDO git config --system --unset-all credential.helper 2>/dev/null || true
  fi
fi

if [ "$PURGE" = true ]; then
  echo "Deleting all data in $TARGET_DIR..."
  $SUDO rm -rf "$TARGET_DIR"
  if id "$RUN_USER" >/dev/null 2>&1; then
    echo "Removing service user '$RUN_USER'..."
    $SUDO userdel -r "$RUN_USER" 2>/dev/null || $SUDO userdel "$RUN_USER" 2>/dev/null || true
  fi
  echo "Citadel and all its data have been removed from the system."
else
  echo "Citadel has been uninstalled from the system."
  echo "[INFO] Your projects and databases have been preserved in:"
  echo "       - $TARGET_DIR/data"
  echo "       - $TARGET_DIR/projects"
  echo "       - database snapshots in $TARGET_DIR/data/backups"
  echo "To remove everything (including the '$RUN_USER' user): $0"
fi

# Remove the local source checkout(s) for a clean slate.
if [ "$REMOVE_SOURCE" = true ]; then
  cd / 2>/dev/null || true
  for dir in "$RECORDED_SOURCE" "$SCRIPT_SOURCE"; do
    if is_removable_checkout "$dir"; then
      echo "Removing local source checkout: $dir"
      $SUDO rm -rf "$dir" 2>/dev/null || true
    fi
  done
fi

