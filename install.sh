#!/usr/bin/env bash
# ==============================================================================
# Citadel — Official Standalone, Idempotent Installer
# Initial official support: Debian / Ubuntu (x86_64, aarch64)
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "=================================================================="
echo "          Citadel — System Installer                             "
echo "=================================================================="
echo -e "${NC}"

CHECK_ONLY=false
if [ "${1:-}" = "--check-only" ] || [ "${1:-}" = "--dry-run" ]; then
  CHECK_ONLY=true
  echo -e "${YELLOW}[CHECK MODE] No changes will be applied to the system.${NC}\n"
fi

# Official Citadel repository (enables one-line install via curl | bash)
REPO_URL="${CITADEL_REPO_URL:-https://github.com/maksymhs/Citadel.git}"
REPO_BRANCH="${CITADEL_REPO_BRANCH:-main}"

# Detect whether the installer is running from a local checkout of the repository
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# 1. Privilege Check
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

# 2. Operating System and Architecture Check
ARCH=$(uname -m)
OS=$(uname -s)

echo "[1/8] Checking Operating System and Architecture..."
echo "      OS: $OS, Architecture: $ARCH"

if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
  echo -e "${RED}[ERROR] Unsupported operating system: $OS${NC}"
  exit 1
fi

if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  echo -e "${RED}[ERROR] Unsupported architecture: $ARCH (x86_64 or arm64/aarch64 required)${NC}"
  exit 1
fi

# 3. Resource Check (Memory and Disk Space)
echo "[2/8] Checking VPS resources..."
if [ "$OS" = "Linux" ]; then
  MEM_TOTAL_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  MEM_TOTAL_MB=$((MEM_TOTAL_KB / 1024))
  if [ "$MEM_TOTAL_MB" -lt 450 ]; then
    echo -e "${YELLOW}[WARNING] Low RAM: ${MEM_TOTAL_MB} MB. Adding a swap file is recommended.${NC}"
  else
    echo "      Available RAM: ${MEM_TOTAL_MB} MB (OK)"
  fi
fi

# 4. Base package and build dependency installation
echo "[3/8] Checking system packages..."
if [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
  if [ "$CHECK_ONLY" = false ] && [ "$HAS_SUDO" = true ]; then
    echo "      Installing/updating base packages (curl, git, tmux, build-essential, python3)..."
    $SUDO apt-get update -y -qq
    $SUDO apt-get install -y -qq curl git tmux build-essential python3 ca-certificates
  fi
fi

# 5. Node.js Check
echo "[4/8] Checking Node.js runtime..."
NODE_INSTALLED=false
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    echo "      Node.js v$NODE_VER detected (compatible)."
    NODE_INSTALLED=true
  else
    echo -e "${YELLOW}[WARNING] Node.js version (v$NODE_VER) is lower than v18.${NC}"
  fi
fi

if [ "$NODE_INSTALLED" = false ]; then
  if [ "$CHECK_ONLY" = true ]; then
    echo -e "${YELLOW}[WARNING] Installing Node.js LTS (>= 18.x) is required.${NC}"
  elif [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1 && [ "$HAS_SUDO" = true ]; then
    echo "      Installing Node.js 22 LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y -qq nodejs
  else
    echo -e "${RED}[ERROR] Node.js is not installed. Please install Node.js >= 18 LTS manually.${NC}"
    exit 1
  fi
fi

# 6. Directory and User Setup
TARGET_DIR="/srv/citadel"
APP_DIR="$TARGET_DIR/app"
DATA_DIR="$TARGET_DIR/data"
PROJECTS_DIR="$TARGET_DIR/projects"
LOGS_DIR="$TARGET_DIR/logs"

echo "[5/8] Preparing directory structure and permissions..."
if [ "$CHECK_ONLY" = true ]; then
  echo "      Directories to check: $TARGET_DIR (app, data, projects, logs)"
else
  # Determine the run user
  RUN_USER="${SUDO_USER:-$(whoami)}"
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
    if ! id "citadel" >/dev/null 2>&1; then
      echo "      Creating 'citadel' system service user..."
      $SUDO useradd -r -s /bin/bash -m -d /srv/citadel citadel 2>/dev/null || true
    fi
    RUN_USER="citadel"
  fi

  $SUDO mkdir -p "$APP_DIR" "$DATA_DIR" "$PROJECTS_DIR" "$LOGS_DIR"

  # Obtain the source code: from a local checkout or by cloning the official repository.
  # This supports both `./install.sh` and `curl -fsSL .../install.sh | bash`.
  if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/package.json" ] && [ -f "$SRC_DIR/server/index.js" ] && [ "$SRC_DIR" != "$APP_DIR" ]; then
    echo "      Syncing local Citadel files to $APP_DIR..."
    $SUDO cp -r "$SRC_DIR"/* "$APP_DIR"/ 2>/dev/null || true
    $SUDO cp -r "$SRC_DIR"/.env.example "$APP_DIR"/.env.example 2>/dev/null || true
  elif [ ! -f "$APP_DIR/package.json" ]; then
    echo "      Cloning Citadel ($REPO_BRANCH) from $REPO_URL..."
    if [ "$(id -u)" -eq 0 ]; then
      git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    else
      $SUDO git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    fi
  else
    echo "      Code already present in $APP_DIR (skipping download)."
  fi

  # Permissions
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
    $SUDO chown -R "$RUN_USER:$RUN_USER" "$TARGET_DIR"
  fi
fi

# 7. Dependency installation and local asset build
if [ "$CHECK_ONLY" = true ]; then
  echo "[6/8] Native dependencies and local assets: skipped (check mode)."
else
  echo "[6/8] Installing native dependencies and local assets (0 CDNs)..."
  cd "$APP_DIR"
  npm install --omit=dev
  node scripts/copy-vendor.js
  node scripts/doctor.js
fi

# 8. systemd service configuration and startup
if [ "$CHECK_ONLY" = true ]; then
  echo "[7/8] systemd service configuration: skipped (check mode)."
else
  echo "[7/8] Configuring systemd service..."
  if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && [ "$HAS_SUDO" = true ]; then
    SERVICE_FILE="/etc/systemd/system/citadel.service"
    $SUDO cp "$APP_DIR/scripts/citadel.service" "$SERVICE_FILE"
    $SUDO sed -i "s|User=citadel|User=$RUN_USER|g" "$SERVICE_FILE"
    $SUDO sed -i "s|Group=citadel|Group=$RUN_USER|g" "$SERVICE_FILE"

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable citadel.service
    $SUDO systemctl restart citadel.service
    echo "      citadel service started and enabled at boot."
  fi
fi

# 9. Health check
if [ "$CHECK_ONLY" = true ]; then
  echo "[8/8] API health check: skipped (check mode)."
else
  echo "[8/8] Checking API health..."
  if command -v curl >/dev/null 2>&1; then
    sleep 2
    if curl -s -f http://127.0.0.1:3000/api/auth/status >/dev/null 2>&1; then
      echo -e "${GREEN}      API responding correctly (HTTP 200).${NC}"
    else
      echo -e "${YELLOW}      Warning: The service is still starting. Check with: curl http://127.0.0.1:3000/api/auth/status${NC}"
    fi
  fi
fi

if [ "$CHECK_ONLY" = true ]; then
  echo -e "\n${BLUE}=================================================================="
  echo "          Citadel Check Complete — No Changes Applied            "
  echo "=================================================================="
  echo -e "${NC}"
  echo "  This system is compatible with Citadel. A real install will:"
  echo "    1. Install missing base packages and Node.js LTS."
  echo "    2. Create /srv/citadel (app, data, projects, logs) and user 'citadel'."
  echo "    3. Copy/clone the app and run npm install."
  echo "    4. Register and start the systemd service."
  echo ""
  if [ "$NODE_INSTALLED" = false ]; then
    echo -e "${YELLOW}  Prerequisite missing: Node.js >= 18 LTS (it will be installed automatically).${NC}"
  fi
  echo "  Run the installer without --check-only to perform the installation."
  echo "=================================================================="
else
  echo -e "\n${GREEN}=================================================================="
  echo "          Citadel Installation Completed Successfully             "
  echo "=================================================================="
  echo -e "${NC}"
  echo "  Local Access Panel:    http://127.0.0.1:3000"
  echo "  Data Directory:        $DATA_DIR"
  echo "  Projects Directory:    $PROJECTS_DIR"
  echo "  Diagnostics:           node $APP_DIR/scripts/doctor.js"
  echo ""
  echo "  Mandatory First Step:"
  echo "  Open http://127.0.0.1:3000 in your browser to set up your"
  echo "  initial administrator account and start working."
  echo "=================================================================="
fi
