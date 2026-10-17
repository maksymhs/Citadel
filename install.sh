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
ADMIN_TERMINAL_USER=""
ENABLE_UPDATER=false
for arg in "$@"; do
  case "$arg" in
    --check-only|--dry-run)
      CHECK_ONLY=true
      ;;
    --admin-terminal)
      ADMIN_TERMINAL_USER="${ADMIN_TERMINAL_USER:-ubuntu}"
      ;;
    --admin-terminal=*)
      ADMIN_TERMINAL_USER="${arg#*=}"
      ;;
    --enable-updater)
      ENABLE_UPDATER=true
      ;;
  esac
done

if [ "$CHECK_ONLY" = true ]; then
  echo -e "${YELLOW}[CHECK MODE] No changes will be applied to the system.${NC}\n"
fi

if [ -n "$ADMIN_TERMINAL_USER" ]; then
  echo -e "${YELLOW}[ADMIN TERMINAL] The in-panel System Terminal will run as '$ADMIN_TERMINAL_USER'."
  echo -e "                 This grants the panel root-equivalent access to the host.${NC}\n"
fi

if [ "$ENABLE_UPDATER" = true ]; then
  echo -e "${YELLOW}[UPDATER] Installing the privileged in-panel updater (root-owned helper).${NC}\n"
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

# Helper: run a shell command as the Citadel service user (RUN_USER), used once
# that user exists. Falls back gracefully depending on how we obtained privileges.
run_as_service_user() {
  local cmd="$1"
  if [ "$(id -u)" -eq 0 ]; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$RUN_USER" -- bash -c "$cmd"
    else
      su -s /bin/bash "$RUN_USER" -c "$cmd"
    fi
  elif [ "$HAS_SUDO" = true ]; then
    $SUDO -u "$RUN_USER" bash -c "$cmd"
  else
    bash -c "$cmd"
  fi
}

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
  elif $SUDO test -d "$APP_DIR/.git"; then
    echo "      Updating existing Citadel clone in $APP_DIR (branch $REPO_BRANCH)..."
    $SUDO git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    $SUDO git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH"
  elif ! $SUDO test -f "$APP_DIR/package.json"; then
    echo "      Cloning Citadel ($REPO_BRANCH) from $REPO_URL..."
    if [ "$(id -u)" -eq 0 ]; then
      git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    else
      $SUDO git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    fi
  else
    echo "      Code already present in $APP_DIR (skipping download)."
  fi

  # Ensure an editable .env exists for optional configuration (e.g. ALLOWED_ORIGINS
  # when served behind a domain/proxy). Never overwrite an existing .env.
  if ! $SUDO test -f "$APP_DIR/.env" && $SUDO test -f "$APP_DIR/.env.example"; then
    $SUDO cp "$APP_DIR/.env.example" "$APP_DIR/.env" 2>/dev/null || true
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
  # Run as the service user so node_modules/vendor files are owned by the same
  # account that systemd runs the server as, and so the working directory is
  # accessible even when its parent is not world-traversable.
  # npm install runs the postinstall (copy-vendor) itself, so it is not repeated here.
  run_as_service_user "cd '$APP_DIR' && npm install --omit=dev && DATA_DIR='$DATA_DIR' node scripts/doctor.js"
  # Re-assert ownership in case anything above was created with different perms.
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
    $SUDO chown -R "$RUN_USER:$RUN_USER" "$TARGET_DIR"
  fi
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

  # Optional: privileged "System Terminal" (opt-in via --admin-terminal).
  # Grants the service user a sudoers rule to open a shell as the admin user and
  # relaxes the sandbox drop-in. This makes the panel root-capable by design.
  if [ -n "$ADMIN_TERMINAL_USER" ]; then
    if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && command -v systemctl >/dev/null 2>&1; then
      echo "      Enabling privileged System Terminal as '$ADMIN_TERMINAL_USER'..."

      SUDOERS_FILE="/etc/sudoers.d/citadel-terminal"
      echo "$RUN_USER ALL=($ADMIN_TERMINAL_USER) NOPASSWD: /bin/bash, /usr/bin/bash" | $SUDO tee "$SUDOERS_FILE" >/dev/null
      $SUDO chmod 0440 "$SUDOERS_FILE"
      $SUDO visudo -cf "$SUDOERS_FILE" >/dev/null

      DROPIN_DIR="/etc/systemd/system/citadel.service.d"
      $SUDO mkdir -p "$DROPIN_DIR"
      $SUDO tee "$DROPIN_DIR/admin-terminal.conf" >/dev/null <<'EOF'
[Service]
NoNewPrivileges=false
ProtectSystem=false
ProtectHome=false
EOF

      if $SUDO test -f "$APP_DIR/.env"; then
        if $SUDO grep -q '^TERMINAL_ADMIN_USER=' "$APP_DIR/.env"; then
          $SUDO sed -i "s|^TERMINAL_ADMIN_USER=.*|TERMINAL_ADMIN_USER=$ADMIN_TERMINAL_USER|" "$APP_DIR/.env"
        else
          echo "TERMINAL_ADMIN_USER=$ADMIN_TERMINAL_USER" | $SUDO tee -a "$APP_DIR/.env" >/dev/null
        fi
      fi

      $SUDO systemctl daemon-reload
      $SUDO systemctl restart citadel.service
      echo "      System Terminal will run as '$ADMIN_TERMINAL_USER'."
    else
      echo -e "${YELLOW}      Skipping --admin-terminal (requires Linux + systemd + sudo).${NC}"
    fi
  fi

  # Optional: privileged in-panel updater (opt-in via --enable-updater).
  # Installs a root-owned helper and a scoped sudoers rule so the panel can run
  # exactly that updater (and nothing else) as root.
  if [ "$ENABLE_UPDATER" = true ]; then
    if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
      echo "      Installing privileged updater helper..."
      $SUDO install -o root -g root -m 0755 "$APP_DIR/scripts/update.sh" /usr/local/sbin/citadel-update
      UPDATER_SUDOERS="/etc/sudoers.d/citadel-updater"
      echo "$RUN_USER ALL=(root) NOPASSWD: /usr/local/sbin/citadel-update" | $SUDO tee "$UPDATER_SUDOERS" >/dev/null
      $SUDO chmod 0440 "$UPDATER_SUDOERS"
      $SUDO visudo -cf "$UPDATER_SUDOERS" >/dev/null
      echo "      In-panel updater enabled (System → Update)."
    else
      echo -e "${YELLOW}      Skipping --enable-updater (requires Linux + sudo).${NC}"
    fi
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
  if [ -n "$ADMIN_TERMINAL_USER" ]; then
    echo "  System Terminal User:  $ADMIN_TERMINAL_USER (privileged / root-capable)"
  fi
  if [ "$ENABLE_UPDATER" = true ]; then
    echo "  In-panel Updater:      enabled (System view → Update)"
  fi
  echo ""
  echo "  Mandatory First Step:"
  echo "  Open http://127.0.0.1:3000 in your browser to set up your"
  echo "  initial administrator account and start working."
  echo "=================================================================="
fi
