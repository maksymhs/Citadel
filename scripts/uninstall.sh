#!/usr/bin/env bash
# Citadel — Controlled uninstaller
# Removes the systemd service, drop-ins, sudoers rules and helper scripts.
# Database and projects are preserved unless --purge is passed.
#
#   sudo ./scripts/uninstall.sh            # keep data and the service user
#   sudo ./scripts/uninstall.sh --purge    # also delete /srv/citadel and the user
set -euo pipefail

SERVICE="${CITADEL_SERVICE:-citadel}"
RUN_USER="${CITADEL_RUN_USER:-citadel}"
PURGE=false
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
    --help|-h)
      echo "Usage: $0 [--purge]"
      echo "  --purge   Also delete the data directory and the service user."
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
  echo "[WARNING] Deleting all data in /srv/citadel..."
  $SUDO rm -rf /srv/citadel
  if id "$RUN_USER" >/dev/null 2>&1; then
    echo "Removing service user '$RUN_USER'..."
    $SUDO userdel -r "$RUN_USER" 2>/dev/null || $SUDO userdel "$RUN_USER" 2>/dev/null || true
  fi
  echo "Citadel and all its data have been removed from the system."
else
  echo "Citadel has been uninstalled from the system."
  echo "[INFO] Your projects and databases have been preserved in:"
  echo "       - /srv/citadel/data"
  echo "       - /srv/citadel/projects"
  echo "       - database snapshots in /srv/citadel/data/backups"
  echo "To remove everything (including the '$RUN_USER' user): $0 --purge"
fi
