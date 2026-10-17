#!/usr/bin/env bash
# Citadel — Controlled uninstaller
set -euo pipefail

echo "=================================================="
echo "          Citadel — Uninstall                     "
echo "=================================================="

PRESERVE_DATA="${PRESERVE_DATA:-true}"

if command -v systemctl >/dev/null 2>&1; then
  echo "Stopping and disabling citadel.service..."
  sudo systemctl stop citadel 2>/dev/null || true
  sudo systemctl disable citadel 2>/dev/null || true
  sudo rm -f /etc/systemd/system/citadel.service
  sudo systemctl daemon-reload || true
fi

if [ "$PRESERVE_DATA" = "true" ]; then
  echo "[INFO] Your projects and databases have been preserved in:"
  echo "       - /srv/citadel/data"
  echo "       - /srv/citadel/projects"
  echo "To remove them manually: rm -rf /srv/citadel"
else
  echo "[WARNING] Deleting all data..."
  sudo rm -rf /srv/citadel
fi

echo "Citadel has been uninstalled from the system."
