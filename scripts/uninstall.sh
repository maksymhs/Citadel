#!/usr/bin/env bash
# NexusVPS — Desinstalador controlado
set -euo pipefail

echo "=================================================="
echo "          NexusVPS — Desinstalación               "
echo "=================================================="

PRESERVE_DATA="${PRESERVE_DATA:-true}"

if command -v systemctl >/dev/null 2>&1; then
  echo "Deteniendo y deshabilitando nexusvps.service..."
  sudo systemctl stop nexusvps 2>/dev/null || true
  sudo systemctl disable nexusvps 2>/dev/null || true
  sudo rm -f /etc/systemd/system/nexusvps.service
  sudo systemctl daemon-reload || true
fi

if [ "$PRESERVE_DATA" = "true" ]; then
  echo "[INFO] Tus proyectos y bases de datos se han conservado en:"
  echo "       - /srv/nexusvps/data"
  echo "       - /srv/nexusvps/projects"
  echo "Si deseas eliminarlos manualmente: rm -rf /srv/nexusvps"
else
  echo "[AVISO] Eliminando todos los datos..."
  sudo rm -rf /srv/nexusvps
fi

echo "NexusVPS ha sido desinstalado del sistema."
