#!/usr/bin/env bash
# ==============================================================================
# Citadel — Instalador Oficial Autónomo e Idempotente
# Soporte oficial inicial: Debian / Ubuntu (x86_64, aarch64)
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "=================================================================="
echo "          Citadel — Instalador del Sistema                        "
echo "=================================================================="
echo -e "${NC}"

CHECK_ONLY=false
if [ "${1:-}" = "--check-only" ] || [ "${1:-}" = "--dry-run" ]; then
  CHECK_ONLY=true
  echo -e "${YELLOW}[MODO COMPROBACIÓN] No se aplicarán cambios al sistema.${NC}\n"
fi

# Repositorio oficial de Citadel (permite instalación en una línea vía curl | bash)
REPO_URL="${CITADEL_REPO_URL:-https://github.com/maksymhs/Citadel.git}"
REPO_BRANCH="${CITADEL_REPO_BRANCH:-main}"

# Detectar si el instalador se ejecuta desde un checkout local del repositorio
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# 1. Comprobación de Privilegios
HAS_SUDO=false
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  HAS_SUDO=true
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
  HAS_SUDO=true
else
  SUDO=""
fi

# 2. Comprobación de Sistema Operativo y Arquitectura
ARCH=$(uname -m)
OS=$(uname -s)

echo "[1/8] Verificando Sistema Operativo y Arquitectura..."
echo "      OS: $OS, Arquitectura: $ARCH"

if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
  echo -e "${RED}[ERROR] Sistema operativo no soportado: $OS${NC}"
  exit 1
fi

if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  echo -e "${RED}[ERROR] Arquitectura no soportada: $ARCH (se requiere x86_64 o arm64/aarch64)${NC}"
  exit 1
fi

# 3. Comprobación de Recursos (Memoria y Espacio en Disco)
echo "[2/8] Verificando recursos del VPS..."
if [ "$OS" = "Linux" ]; then
  MEM_TOTAL_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  MEM_TOTAL_MB=$((MEM_TOTAL_KB / 1024))
  if [ "$MEM_TOTAL_MB" -lt 450 ]; then
    echo -e "${YELLOW}[AVISO] Memoria RAM baja: ${MEM_TOTAL_MB} MB. Se recomienda añadir un archivo swap.${NC}"
  else
    echo "      RAM disponible: ${MEM_TOTAL_MB} MB (Apto)"
  fi
fi

# 4. Instalación de paquetes base y dependencias de compilación
echo "[3/8] Verificando paquetes del sistema..."
if [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
  if [ "$CHECK_ONLY" = false ] && [ "$HAS_SUDO" = true ]; then
    echo "      Instalando/actualizando paquetes base (curl, git, tmux, build-essential, python3)..."
    $SUDO apt-get update -y -qq
    $SUDO apt-get install -y -qq curl git tmux build-essential python3 ca-certificates
  fi
fi

# 5. Comprobación de Node.js
echo "[4/8] Verificando entorno de ejecución Node.js..."
NODE_INSTALLED=false
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    echo "      Node.js v$NODE_VER detectado (compatible)."
    NODE_INSTALLED=true
  else
    echo -e "${YELLOW}[AVISO] Versión de Node.js (v$NODE_VER) inferior a v18.${NC}"
  fi
fi

if [ "$NODE_INSTALLED" = false ]; then
  if [ "$CHECK_ONLY" = true ]; then
    echo -e "${YELLOW}[AVISO] Se requiere instalar Node.js LTS (>= 18.x).${NC}"
  elif [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1 && [ "$HAS_SUDO" = true ]; then
    echo "      Instalando Node.js 22 LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y -qq nodejs
  else
    echo -e "${RED}[ERROR] Node.js no está instalado. Por favor instala Node.js >= 18 LTS manualmente.${NC}"
    exit 1
  fi
fi

# 6. Preparación de Directorios y Usuario
TARGET_DIR="/srv/citadel"
APP_DIR="$TARGET_DIR/app"
DATA_DIR="$TARGET_DIR/data"
PROJECTS_DIR="$TARGET_DIR/projects"
LOGS_DIR="$TARGET_DIR/logs"

echo "[5/8] Preparando estructura de directorios y permisos..."
if [ "$CHECK_ONLY" = true ]; then
  echo "      Directorios a verificar: $TARGET_DIR (app, data, projects, logs)"
else
  # Determinar usuario de ejecución
  RUN_USER="${SUDO_USER:-$(whoami)}"
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
    if ! id "citadel" >/dev/null 2>&1; then
      echo "      Creando usuario de servicio del sistema 'citadel'..."
      $SUDO useradd -r -s /bin/bash -m -d /srv/citadel citadel 2>/dev/null || true
    fi
    RUN_USER="citadel"
  fi

  $SUDO mkdir -p "$APP_DIR" "$DATA_DIR" "$PROJECTS_DIR" "$LOGS_DIR"

  # Obtener el código fuente: desde un checkout local o clonando el repositorio oficial.
  # Esto permite tanto `./install.sh` como `curl -fsSL .../install.sh | bash`.
  if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/package.json" ] && [ -f "$SRC_DIR/server/index.js" ] && [ "$SRC_DIR" != "$APP_DIR" ]; then
    echo "      Sincronizando archivos locales de Citadel a $APP_DIR..."
    $SUDO cp -r "$SRC_DIR"/* "$APP_DIR"/ 2>/dev/null || true
    $SUDO cp -r "$SRC_DIR"/.env.example "$APP_DIR"/.env.example 2>/dev/null || true
  elif [ ! -f "$APP_DIR/package.json" ]; then
    echo "      Clonando Citadel ($REPO_BRANCH) desde $REPO_URL..."
    if [ "$(id -u)" -eq 0 ]; then
      git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    else
      $SUDO git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    fi
  else
    echo "      Código ya presente en $APP_DIR (se omite la descarga)."
  fi

  # Permisos
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
    $SUDO chown -R "$RUN_USER:$RUN_USER" "$TARGET_DIR"
  fi
fi

# 7. Instalación de dependencias y construcción de assets locales
echo "[6/8] Instalando dependencias nativas y assets locales (0 CDNs)..."
if [ "$CHECK_ONLY" = false ]; then
  cd "$APP_DIR"
  npm install --omit=dev
  node scripts/copy-vendor.js
  node scripts/doctor.js
fi

# 8. Configuración e inicio de servicio systemd
echo "[7/8] Configurando servicio systemd..."
if [ "$CHECK_ONLY" = false ] && [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && [ "$HAS_SUDO" = true ]; then
  SERVICE_FILE="/etc/systemd/system/citadel.service"
  $SUDO cp "$APP_DIR/scripts/citadel.service" "$SERVICE_FILE"
  $SUDO sed -i "s|User=citadel|User=$RUN_USER|g" "$SERVICE_FILE"
  $SUDO sed -i "s|Group=citadel|Group=$RUN_USER|g" "$SERVICE_FILE"

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable citadel.service
  $SUDO systemctl restart citadel.service
  echo "      Servicio citadel iniciado y habilitado en el arranque."
fi

# 9. Verificación de salud
echo "[8/8] Verificando salud de la API..."
if [ "$CHECK_ONLY" = false ] && command -v curl >/dev/null 2>&1; then
  sleep 2
  if curl -s -f http://127.0.0.1:3000/api/auth/status >/dev/null 2>&1; then
    echo -e "${GREEN}      API respondiendo correctamente (HTTP 200).${NC}"
  else
    echo -e "${YELLOW}      Aviso: El servicio aún está iniciando. Comprueba con: curl http://127.0.0.1:3000/api/auth/status${NC}"
  fi
fi

echo -e "\n${GREEN}=================================================================="
echo "          Instalación de Citadel Completada con Éxito             "
echo "=================================================================="
echo -e "${NC}"
echo "  Panel de Acceso Local:  http://127.0.0.1:3000"
echo "  Directorio de Datos:    $DATA_DIR"
echo "  Directorio Proyectos:   $PROJECTS_DIR"
echo "  Diagnóstico:            node $APP_DIR/scripts/doctor.js"
echo ""
echo "  Primer Paso Obligatorio:"
echo "  Abre http://127.0.0.1:3000 en tu navegador para configurar tu"
echo "  cuenta de administrador inicial y comenzar a trabajar."
echo "=================================================================="
