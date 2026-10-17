#!/usr/bin/env bash
# NexusVPS — Actualizador seguro e idempotente
set -euo pipefail

echo "=================================================="
echo "          NexusVPS — Proceso de Actualización     "
echo "=================================================="

INSTALL_DIR="${NEXUSVPS_DIR:-/srv/nexusvps/app}"

if [ ! -d "$INSTALL_DIR" ]; then
  # If running in local repository directly
  INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

echo "[1/4] Accediendo al directorio de aplicación: $INSTALL_DIR"
cd "$INSTALL_DIR"

echo "[2/4] Actualizando dependencias de Node.js..."
npm install --omit=dev
npm run postinstall

echo "[3/4] Verificando salud del sistema..."
node scripts/doctor.js

echo "[4/4] Reiniciando servicio si está activo..."
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nexusvps 2>/dev/null; then
  echo "Reiniciando nexusvps.service..."
  sudo systemctl restart nexusvps
  sleep 2
  echo "Verificando respuesta del servidor..."
  if curl -s -f http://127.0.0.1:3000/api/auth/status >/dev/null; then
    echo "Servicio actualizado y respondiendo correctamente."
  else
    echo "Advertencia: El servicio tardó en responder. Revisa: journalctl -u nexusvps -n 50"
  fi
else
  echo "NexusVPS actualizado localmente. Inicia con: npm start"
fi

echo "=================================================="
echo "          Actualización completada con éxito      "
echo "=================================================="
