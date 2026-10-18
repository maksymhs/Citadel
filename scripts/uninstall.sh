#!/usr/bin/env bash
# Citadel — full uninstaller
# Removes the systemd service, drop-ins, sudoers rules, helper scripts, the
# data directory (/srv/citadel) and the service user. Nothing is left behind.
#
#   sudo ./scripts/uninstall.sh              # remove EVERYTHING
#   sudo ./scripts/uninstall.sh --keep-data  # keep /srv/citadel (data + user)
set -euo pipefail

SERVICE="${CITADEL_SERVICE:-citadel}"
RUN_USER="${CITADEL_RUN_USER:-citadel}"
PURGE=true
for arg in "$@"; do
  case "$arg" in
    --keep-data) PURGE=false ;;
    --purge) PURGE=true ;;
    --help|-h)
      echo "Usage: $0 [--keep-data]"
      echo "  (default)     Remove everything, including /srv/citadel and the user."
      echo "  --keep-data   Keep /srv/citadel (data, projects) and the service user."
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

  echo "Stopping and removing the Cloudflare tunnel (if any)..."
  $SUDO systemctl stop citadel-tunnel 2>/dev/null || true
  $SUDO systemctl disable citadel-tunnel 2>/dev/null || true
  $SUDO rm -f /etc/systemd/system/citadel-tunnel.service
  $SUDO rm -f /srv/citadel/data/tunnel-url 2>/dev/null || true
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
  echo "Deleting all data in /srv/citadel..."
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
  echo "To remove everything (including the '$RUN_USER' user): $0"
fi
