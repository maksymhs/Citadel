#!/usr/bin/env bash
# Citadel — Desinstalador controlado
set -euo pipefail

echo "=================================================="
echo "          Citadel — Desinstalación                "
echo "=================================================="

PRESERVE_DATA="${PRESERVE_DATA:-true}"

if command -v systemctl >/dev/null 2>&1; then
  echo "Deteniendo y deshabilitando citadel.service..."
  sudo systemctl stop citadel 2>/dev/null || true
  sudo systemctl disable citadel 2>/dev/null || true
  sudo rm -f /etc/systemd/system/citadel.service
  sudo systemctl daemon-reload || true
fi

if [ "$PRESERVE_DATA" = "true" ]; then
  echo "[INFO] Tus proyectos y bases de datos se han conservado en:"
  echo "       - /srv/citadel/data"
  echo "       - /srv/citadel/projects"
  echo "Si deseas eliminarlos manualmente: rm -rf /srv/citadel"
else
  echo "[AVISO] Eliminando todos los datos..."
  sudo rm -rf /srv/citadel
fi

echo "Citadel ha sido desinstalado del sistema."
