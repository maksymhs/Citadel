#!/usr/bin/env bash
# Citadel — Safe, idempotent updater
set -euo pipefail

echo "=================================================="
echo "          Citadel — Update Process                "
echo "=================================================="

INSTALL_DIR="${CITADEL_DIR:-/srv/citadel/app}"

if [ ! -d "$INSTALL_DIR" ]; then
  # If running in local repository directly
  INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

echo "[1/4] Entering application directory: $INSTALL_DIR"
cd "$INSTALL_DIR"

echo "[2/4] Updating Node.js dependencies..."
npm install --omit=dev
npm run postinstall

echo "[3/4] Checking system health..."
node scripts/doctor.js

echo "[4/4] Restarting service if active..."
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet citadel 2>/dev/null; then
  echo "Restarting citadel.service..."
  sudo systemctl restart citadel
  sleep 2
  echo "Checking server response..."
  if curl -s -f http://127.0.0.1:3000/api/auth/status >/dev/null; then
    echo "Service updated and responding correctly."
  else
    echo "Warning: The service took too long to respond. Check: journalctl -u citadel -n 50"
  fi
else
  echo "Citadel updated locally. Start it with: npm start"
fi

echo "=================================================="
echo "          Update completed successfully           "
echo "=================================================="
