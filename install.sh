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

# Minimal output by default: sub-steps print only with CITADEL_VERBOSE=1, and
# noisy tools (apt, npm, doctor, tunnel) log to a file shown only on failure.
VERBOSE="${CITADEL_VERBOSE:-0}"
INSTALL_LOG="$(mktemp -t citadel-install.XXXXXX 2>/dev/null || echo /tmp/citadel-install.log)"
detail() { [ "$VERBOSE" = "1" ] && echo "$@" || true; }
# quiet_run <command...>: hide output unless verbose; on failure show the tail.
quiet_run() {
  if [ "$VERBOSE" = "1" ]; then "$@"; return $?; fi
  if "$@" >>"$INSTALL_LOG" 2>&1; then return 0; fi
  echo -e "${YELLOW}      Command failed: $*${NC}" >&2
  tail -n 15 "$INSTALL_LOG" >&2
  return 1
}

CHECK_ONLY=false
UNINSTALL=false
# A bare `curl | sudo bash` installs a panel that is publicly reachable through a
# Cloudflare Quick Tunnel (a random https://*.trycloudflare.com URL, no account or
# domain) so the QR code works from any network on first boot. The privileged
# capabilities still must be requested explicitly:
#   --admin-terminal[=user]  privileged System Terminal (root-capable)
#   --no-updater             skip the root-owned in-panel updater (on by default)
#   --lan / --host=ADDR      also bind on the local network (QR from phone)
#   --no-tunnel              keep the panel off the public internet
#   --no-24-7                allow the host to suspend normally
# The legacy flags (--no-admin-terminal, --no-updater, --local, --no-tunnel) keep
# working; --local implies --no-tunnel.
DEFAULT_ADMIN_USER="${SUDO_USER:-}"
if [ -z "$DEFAULT_ADMIN_USER" ]; then
  DEFAULT_ADMIN_USER="$(id -un)"
fi
ADMIN_TERMINAL_USER=""
ENABLE_UPDATER=true
LAN_ACCESS=false
LOCAL_ONLY=false
LAN_EXPOSED=false
HOST_ADDR=""
PANEL_PORT=3000
UPDATE_MODE=false
TUNNEL=true
KEEP_AWAKE=true
for arg in "$@"; do
  case "$arg" in
    --check-only|--dry-run)
      CHECK_ONLY=true
      ;;
    --update|--upgrade)
      UPDATE_MODE=true
      ;;
    --uninstall)
      UNINSTALL=true
      ;;
    --no-admin-terminal)
      ADMIN_TERMINAL_USER=""
      ;;
    --admin-terminal)
      ADMIN_TERMINAL_USER="$DEFAULT_ADMIN_USER"
      ;;
    --admin-terminal=*)
      ADMIN_TERMINAL_USER="${arg#*=}"
      ;;
    --enable-updater)
      ENABLE_UPDATER=true
      ;;
    --no-updater)
      ENABLE_UPDATER=false
      ;;
    --local|--localhost-only)
      LOCAL_ONLY=true
      LAN_ACCESS=false
      TUNNEL=false
      ;;
    --lan|--no-local)
      LAN_ACCESS=true
      ;;
    --no-lan)
      LAN_ACCESS=false
      ;;
    --host=*)
      HOST_ADDR="${arg#*=}"
      LAN_ACCESS=true
      ;;
    --tunnel)
      TUNNEL=true
      ;;
    --no-tunnel)
      TUNNEL=false
      ;;
    --24-7|--keep-awake)
      KEEP_AWAKE=true
      ;;
    --no-24-7|--no-keep-awake)
      KEEP_AWAKE=false
      ;;
  esac
done

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

delegate_platform_script() {
  local script_name="$1"
  shift
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/scripts/$script_name" ]; then
    exec bash "$SCRIPT_DIR/scripts/$script_name" "$@"
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: curl is required to fetch the platform installer." >&2
    exit 1
  fi
  local branch="${CITADEL_REPO_BRANCH:-main}"
  local raw_base="${CITADEL_RAW_BASE_URL:-https://raw.githubusercontent.com/maksymhs/Citadel/$branch}"
  curl -fsSL "$raw_base/scripts/$script_name" | bash -s -- "$@"
  exit $?
}

PLATFORM_ARGS=()
for arg in "$@"; do
  [ "$arg" = "--uninstall" ] || PLATFORM_ARGS+=("$arg")
done

INSTALL_OS="$(uname -s)"
if [ "$INSTALL_OS" = "Darwin" ]; then
  if [ "$UNINSTALL" = true ]; then
    delegate_platform_script uninstall-macos.sh "${PLATFORM_ARGS[@]}"
  fi
  delegate_platform_script install-macos.sh "${PLATFORM_ARGS[@]}"
fi

if [ "$UNINSTALL" = true ]; then
  delegate_platform_script uninstall.sh "${PLATFORM_ARGS[@]}"
fi

# Validate the requested privileged-terminal user BEFORE touching the system: an
# invalid value must never silently produce a sudoers rule or a parseable .env.
if [ -n "$ADMIN_TERMINAL_USER" ]; then
  case "$ADMIN_TERMINAL_USER" in
    *[!A-Za-z0-9_.-]*|[-.]*)
      echo -e "${RED}[ERROR] Invalid --admin-terminal user: '$ADMIN_TERMINAL_USER'${NC}"
      exit 1
      ;;
  esac
  if [ "$CHECK_ONLY" = false ] && ! id "$ADMIN_TERMINAL_USER" >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] --admin-terminal user '$ADMIN_TERMINAL_USER' does not exist on this host.${NC}"
    exit 1
  fi
fi

if [ "$CHECK_ONLY" = true ]; then
  echo -e "${YELLOW}[CHECK MODE] No changes will be applied to the system.${NC}\n"
fi

NOTES=""
[ -n "$ADMIN_TERMINAL_USER" ] && NOTES="$NOTES admin-terminal($ADMIN_TERMINAL_USER)"
[ "$ENABLE_UPDATER" = true ] && NOTES="$NOTES updater"
[ "$LAN_ACCESS" = true ] && NOTES="$NOTES lan"
[ "$TUNNEL" = true ] && NOTES="$NOTES tunnel"
[ "$KEEP_AWAKE" = true ] && NOTES="$NOTES 24/7"
[ -n "$NOTES" ] && echo -e "${YELLOW}  Options:${NOTES}${NC}  (details: CITADEL_VERBOSE=1)\n"

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
detail "      OS: $OS, Architecture: $ARCH"

if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
  echo -e "${RED}[ERROR] Unsupported operating system: $OS${NC}"
  exit 1
fi

if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  echo -e "${RED}[ERROR] Unsupported architecture: $ARCH (x86_64 or arm64/aarch64 required)${NC}"
  exit 1
fi

# Standard layout (created in a later step). Defined early so the CLI launcher
# below can reference it.
TARGET_DIR="/srv/citadel"
APP_DIR="$TARGET_DIR/app"
DATA_DIR="$TARGET_DIR/data"
PROJECTS_DIR="$TARGET_DIR/projects"
LOGS_DIR="$TARGET_DIR/logs"
# Shared, world-readable install root for CLI agents (opencode, claude, codex…).
# Installing an agent once here makes it available to every OS user and session.
AGENTS_DIR="${CITADEL_AGENTS_DIR:-/opt/citadel/agents}"
# It is chown'ed recursively to the service user below, so refuse anything that
# is not a dedicated absolute directory.
case "$AGENTS_DIR" in
  *..*|/|/bin|/bin/*|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/home|/lib*|/opt|/proc|/proc/*|/root|/run|/sbin|/sbin/*|/srv|/sys|/sys/*|/tmp|/usr|/usr/*|/var)
    echo -e "${RED}[ERROR] Refusing unsafe CITADEL_AGENTS_DIR: $AGENTS_DIR${NC}"
    exit 1
    ;;
  /*) : ;;
  *)
    echo -e "${RED}[ERROR] CITADEL_AGENTS_DIR must be an absolute path: $AGENTS_DIR${NC}"
    exit 1
    ;;
esac

# Best LAN address: the source IP of the default route (the real network the
# phone shares), falling back to the first hostname -I entry.
detect_lan_ip() {
  local ip_addr=""
  if command -v ip >/dev/null 2>&1; then
    ip_addr="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  fi
  [ -z "$ip_addr" ] && ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "$ip_addr"
}

# Install the friendly `citadel` launcher as early as possible so that
# `citadel status|url|qr|...` works right after this run. It is a thin
# shim pointing at the repository script (so code updates take effect at once).
if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && [ "$CHECK_ONLY" = false ] \
   && [ -f "$APP_DIR/scripts/citadel" ]; then
  LAUNCHER_TMP="$(mktemp)"
  printf '#!/bin/sh\n# Citadel CLI launcher (managed by the installer/updater)\nexec bash "%s/scripts/citadel" "$@"\n' "$APP_DIR" > "$LAUNCHER_TMP"
  if ! $SUDO cmp -s "$LAUNCHER_TMP" /usr/local/bin/citadel 2>/dev/null; then
    $SUDO install -m 0755 "$LAUNCHER_TMP" /usr/local/bin/citadel
    detail "      Installed the 'citadel' CLI launcher."
  fi
  rm -f "$LAUNCHER_TMP"
fi

# 3. Resource Check (Memory and Disk Space)
echo "[2/8] Checking VPS resources..."
if [ "$OS" = "Linux" ]; then
  MEM_TOTAL_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  MEM_TOTAL_MB=$((MEM_TOTAL_KB / 1024))
  if [ "$MEM_TOTAL_MB" -lt 450 ]; then
    echo -e "${YELLOW}[WARNING] Low RAM: ${MEM_TOTAL_MB} MB. Adding a swap file is recommended.${NC}"
  else
    detail "      Available RAM: ${MEM_TOTAL_MB} MB (OK)"
  fi
fi

# 4. Base package and build dependency installation
echo "[3/8] Checking system packages..."
if [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
  if [ "$CHECK_ONLY" = false ] && [ "$HAS_SUDO" = true ]; then
    detail "      Installing/updating base packages (curl, git, tmux, build-essential, python3)..."
    quiet_run $SUDO apt-get update -y -qq
    quiet_run $SUDO apt-get install -y -qq curl git tmux build-essential python3 ca-certificates
  fi
fi

# 5. Node.js Check
echo "[4/8] Checking Node.js runtime..."
NODE_INSTALLED=false
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    detail "      Node.js v$NODE_VER detected (compatible)."
    NODE_INSTALLED=true
  else
    echo -e "${YELLOW}[WARNING] Node.js version (v$NODE_VER) is lower than v18.${NC}"
  fi
fi

if [ "$NODE_INSTALLED" = false ]; then
  if [ "$CHECK_ONLY" = true ]; then
    echo -e "${YELLOW}[WARNING] Installing Node.js LTS (>= 18.x) is required.${NC}"
  elif [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1 && [ "$HAS_SUDO" = true ]; then
    detail "      Installing Node.js 22 LTS via NodeSource..."
    # `$SUDO` is empty when the installer already runs as root; passing `-E`
    # unconditionally would execute `-E` as a command (and curl would die with
    # "Failed writing body").
    if [ -n "$SUDO" ]; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    else
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    fi
    $SUDO apt-get install -y -qq nodejs
  else
    echo -e "${RED}[ERROR] Node.js is not installed. Please install Node.js >= 18 LTS manually.${NC}"
    exit 1
  fi
fi

# 6. Directory and User Setup
echo "[5/8] Preparing directory structure and permissions..."
if [ "$CHECK_ONLY" = true ]; then
  detail "      Directories to check: $TARGET_DIR (app, data, projects, logs)"
else
  # Determine the run user
  RUN_USER="${SUDO_USER:-$(whoami)}"
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
    if ! id "citadel" >/dev/null 2>&1; then
      detail "      Creating 'citadel' system service user..."
      $SUDO useradd -r -s /bin/bash -m -d /srv/citadel citadel 2>/dev/null || true
    fi
    RUN_USER="citadel"
  fi

  $SUDO mkdir -p "$APP_DIR" "$DATA_DIR" "$PROJECTS_DIR" "$LOGS_DIR"
  # Shared agents root: 0755 so any OS user can traverse and execute the agents
  # installed here (the panel install button populates it).
  $SUDO mkdir -p "$AGENTS_DIR" && $SUDO chmod 0755 "$AGENTS_DIR" 2>/dev/null || true

  # Re-running the installer upgrades an existing installation in place: it pulls
  # the latest code, reinstalls dependencies and restarts the service.
  if $SUDO test -d "$APP_DIR/.git" || $SUDO test -f "$APP_DIR/package.json"; then
    echo -e "${BLUE}      Existing installation detected — updating in place.${NC}"
  elif [ "$UPDATE_MODE" = true ]; then
    echo -e "${YELLOW}      Nothing to update yet; performing a fresh installation.${NC}"
  fi

  # Obtain the source code: from a local checkout or by cloning the official repository.
  # This supports both `./install.sh` and `curl -fsSL .../install.sh | bash`.
  if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/package.json" ] && [ -f "$SRC_DIR/server/index.js" ] && [ "$SRC_DIR" != "$APP_DIR" ]; then
    detail "      Syncing local Citadel files to $APP_DIR..."
    $SUDO cp -r "$SRC_DIR"/* "$APP_DIR"/ 2>/dev/null || true
    $SUDO cp -r "$SRC_DIR"/.env.example "$APP_DIR"/.env.example 2>/dev/null || true
  elif $SUDO test -d "$APP_DIR/.git"; then
    detail "      Updating existing Citadel clone in $APP_DIR (branch $REPO_BRANCH)..."
    # safe.directory avoids git's "dubious ownership" refusal when root operates
    # on a working tree owned by the (non-root) service user.
    $SUDO git -c safe.directory='*' -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    $SUDO git -c safe.directory='*' -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH"
  elif ! $SUDO test -f "$APP_DIR/package.json"; then
    detail "      Cloning Citadel ($REPO_BRANCH) from $REPO_URL..."
    if [ "$(id -u)" -eq 0 ]; then
      git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    else
      $SUDO git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    fi
  else
    detail "      Code already present in $APP_DIR (skipping download)."
  fi

  # Remember the local checkout (if any) so `uninstall` can delete it too, giving
  # a truly clean slate. Skipped when the source is the installed tree itself.
  if [ -n "$SRC_DIR" ] && [ -d "$SRC_DIR/.git" ] && [ "$SRC_DIR" != "$APP_DIR" ]; then
    case "$SRC_DIR" in
      "$TARGET_DIR"|"$TARGET_DIR"/*) : ;;
      *)
        detail "      Recording local source checkout: $SRC_DIR"
        printf '%s\n' "$SRC_DIR" | $SUDO tee "$DATA_DIR/source-dir" >/dev/null 2>&1 || true
        ;;
    esac
  fi

  # Ensure an editable .env exists for optional configuration (e.g. ALLOWED_ORIGINS
  # when served behind a domain/proxy). Never overwrite an existing .env.
  if ! $SUDO test -f "$APP_DIR/.env" && $SUDO test -f "$APP_DIR/.env.example"; then
    $SUDO cp "$APP_DIR/.env.example" "$APP_DIR/.env" 2>/dev/null || true
  fi

  # Expose the panel on the local network (default; keep local with --local).
  # Binds all interfaces and whitelists the LAN origin so the terminal WebSocket
  # accepts connections from other devices (phones) on the same network.
  if [ "$LAN_ACCESS" = true ] && $SUDO test -f "$APP_DIR/.env"; then
    BIND_ADDR="${HOST_ADDR:-0.0.0.0}"
    if $SUDO grep -q '^HOST=' "$APP_DIR/.env"; then
      $SUDO sed -i "s|^HOST=.*|HOST=$BIND_ADDR|" "$APP_DIR/.env"
    else
      echo "HOST=$BIND_ADDR" | $SUDO tee -a "$APP_DIR/.env" >/dev/null
    fi
    # The systemd unit pins HOST=127.0.0.1 and .env cannot override an existing
    # environment variable, so the bind address is set with a unit drop-in.
    if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && [ "$HAS_SUDO" = true ]; then
      BIND_DROPIN_DIR="/etc/systemd/system/citadel.service.d"
      $SUDO mkdir -p "$BIND_DROPIN_DIR"
      $SUDO tee "$BIND_DROPIN_DIR/bind.conf" >/dev/null <<EOF
[Service]
Environment=HOST=$BIND_ADDR
EOF
    fi
    LAN_IP_ADDR="$(detect_lan_ip)"
    if [ -n "$LAN_IP_ADDR" ]; then
      LAN_EXPOSED=true
      LAN_ORIGIN="http://$LAN_IP_ADDR:$PANEL_PORT"
      CURRENT_ORIGINS="$($SUDO grep '^ALLOWED_ORIGINS=' "$APP_DIR/.env" | head -n1 | cut -d= -f2- || true)"
      case ",$CURRENT_ORIGINS," in
        *",$LAN_ORIGIN,"*) : ;;
        *)
          if [ -n "$CURRENT_ORIGINS" ]; then
            $SUDO sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=$CURRENT_ORIGINS,$LAN_ORIGIN|" "$APP_DIR/.env"
          else
            echo "ALLOWED_ORIGINS=http://localhost:$PANEL_PORT,http://127.0.0.1:$PANEL_PORT,$LAN_ORIGIN" | $SUDO tee -a "$APP_DIR/.env" >/dev/null
          fi
          ;;
      esac
    fi
    if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -qi 'Status: active'; then
      $SUDO ufw allow "$PANEL_PORT/tcp" >/dev/null 2>&1 || true
      detail "      Opened firewall port $PANEL_PORT/tcp (ufw)."
    fi
    detail "      Local network access enabled (http://${LAN_IP_ADDR:-<lan-ip>}:$PANEL_PORT)."
  else
    # LAN not requested: drop any stale bind override so the panel stays local.
    if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && [ "$HAS_SUDO" = true ] \
       && [ -f /etc/systemd/system/citadel.service.d/bind.conf ]; then
      $SUDO rm -f /etc/systemd/system/citadel.service.d/bind.conf
    fi
  fi

  # Permissions
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
    $SUDO chown -R "$RUN_USER:$RUN_USER" "$TARGET_DIR"
    # The panel installs agents as the service user (no sudo: the unit sets
    # NoNewPrivileges), so that user must own the shared agents root; 0755
    # keeps every OS user able to run what is installed there.
    $SUDO chown -R "$RUN_USER:$RUN_USER" "$AGENTS_DIR"
    $SUDO chmod 0755 "$AGENTS_DIR"
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
  if [ "$VERBOSE" = "1" ]; then
    run_as_service_user "cd '$APP_DIR' && npm install --omit=dev"
  else
    run_as_service_user "cd '$APP_DIR' && npm install --omit=dev --no-fund --no-audit --loglevel=error" >>"$INSTALL_LOG" 2>&1 \
      || { echo -e "${RED}[ERROR] npm install failed:${NC}" >&2; tail -n 20 "$INSTALL_LOG" >&2; exit 1; }
  fi
  # Diagnostics are informational during installation: a failed check (for
  # example, memory pressure or a failed system unit) must not abort a valid
  # install. The operator can inspect the report and run "citadel repair".
  if [ "$VERBOSE" = "1" ]; then
    run_as_service_user "cd '$APP_DIR' && DATA_DIR='$DATA_DIR' node scripts/doctor.js" \
      || echo "      Diagnostics reported issues; installation continues. Review the output above."
  else
    run_as_service_user "cd '$APP_DIR' && DATA_DIR='$DATA_DIR' node scripts/doctor.js" >>"$INSTALL_LOG" 2>&1 \
      || echo -e "${YELLOW}      Diagnostics reported warnings; run: citadel doctor${NC}"
  fi
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

    # Persistent drop-in: guarantee detached tmux terminals (and the opencode
    # sessions running inside them) survive every service restart/update, even
    # if the main unit above is later replaced by an older copy.
    DROPIN_DIR="/etc/systemd/system/citadel.service.d"
    $SUDO mkdir -p "$DROPIN_DIR"
    $SUDO tee "$DROPIN_DIR/terminal-persistence.conf" >/dev/null <<'EOF'
[Service]
KillMode=process
EOF

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable citadel.service
    $SUDO systemctl restart citadel.service
    detail "      citadel service started and enabled at boot."
  fi

  # Privileged "System Terminal" (enabled by default; disable with
  # --no-admin-terminal). Grants the service user a sudoers rule to open a shell
  # as the admin user and relaxes the sandbox drop-in (root-capable by design).
  if [ -n "$ADMIN_TERMINAL_USER" ]; then
    if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && command -v systemctl >/dev/null 2>&1; then
      detail "      Enabling privileged System Terminal as '$ADMIN_TERMINAL_USER'..."

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
      detail "      System Terminal will run as '$ADMIN_TERMINAL_USER'."
    else
      echo -e "${YELLOW}      Skipping privileged System Terminal (requires Linux + systemd + sudo).${NC}"
    fi
  fi

  # Privileged in-panel updater (enabled by default; disable with --no-updater).
  # Installs a root-owned helper and a scoped sudoers rule so the panel can run
  # exactly that updater (and nothing else) as root.
  if [ "$ENABLE_UPDATER" = true ]; then
    if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ]; then
      detail "      Installing privileged updater helper..."
      $SUDO install -o root -g root -m 0755 "$APP_DIR/scripts/update.sh" /usr/local/sbin/citadel-update
      UPDATER_SUDOERS="/etc/sudoers.d/citadel-updater"
      echo "$RUN_USER ALL=(root) NOPASSWD: /usr/local/sbin/citadel-update" | $SUDO tee "$UPDATER_SUDOERS" >/dev/null
      $SUDO chmod 0440 "$UPDATER_SUDOERS"
      $SUDO visudo -cf "$UPDATER_SUDOERS" >/dev/null
      detail "      In-panel updater enabled (System → Update)."
    else
      echo -e "${YELLOW}      Skipping privileged updater (requires Linux + sudo).${NC}"
    fi
  fi

  # Tunnel helper: lets Settings → Tunnel link a domain of your own from the
  # panel (root-owned copy of tunnel.sh + a sudoers rule scoped to it).
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && command -v systemctl >/dev/null 2>&1 && [ -f "$APP_DIR/scripts/tunnel.sh" ]; then
    $SUDO env CITADEL_APP_DIR="$APP_DIR" CITADEL_DATA_DIR="$DATA_DIR" CITADEL_RUN_USER="$RUN_USER" PORT="$PANEL_PORT" \
      bash "$APP_DIR/scripts/tunnel.sh" setup >>"$INSTALL_LOG" 2>&1 || echo -e "${YELLOW}      Tunnel helper skipped.${NC}"
  fi

  # Git credential helper: lets project terminals reuse the provider tokens
  # already stored (encrypted) by the panel for git fetch/pull/push, without
  # ever writing them in clear text. Tokens are only decryptable by the service
  # user that owns the data directory.
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && command -v git >/dev/null 2>&1; then
    detail "      Configuring git credential helper (panel provider tokens)..."
    $SUDO tee /usr/local/bin/citadel-git-credential >/dev/null <<EOF
#!/bin/sh
DATA_DIR="$DATA_DIR" DATABASE_PATH="$DATA_DIR/citadel.db" exec node "$APP_DIR/scripts/git-credential-citadel.js" "\$@"
EOF
    $SUDO chmod 0755 /usr/local/bin/citadel-git-credential
    $SUDO git config --system credential.helper /usr/local/bin/citadel-git-credential
  fi

  # Agent credentials CLI: read the same encrypted vault from any terminal so
  # agents can use stored credentials for their tasks (list/get/env/exec).
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && [ -f "$APP_DIR/scripts/citadel-creds.js" ]; then
    $SUDO tee /usr/local/bin/citadel-creds >/dev/null <<EOF
#!/bin/sh
DATA_DIR="$DATA_DIR" DATABASE_PATH="$DATA_DIR/citadel.db" exec node "$APP_DIR/scripts/citadel-creds.js" "\$@"
EOF
    $SUDO chmod 0755 /usr/local/bin/citadel-creds
    detail "      Credentials CLI installed: citadel-creds list | get | env | exec"
  fi

  # Shared CLI agents (installed from the panel into $AGENTS_DIR/bin) on every
  # login shell's PATH: SSH sessions, the privileged System Terminal (whose
  # PATH sudo resets) and distributions whose /etc/profile rewrites PATH.
  # Appended so a user's own installs win; root is left untouched.
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && [ -d /etc/profile.d ]; then
    $SUDO tee /etc/profile.d/citadel-agents.sh >/dev/null <<EOF
# Citadel: CLI agents installed from the panel, shared by every user (managed by install.sh)
if [ "\$(id -u)" -ne 0 ] && [ -d "$AGENTS_DIR/bin" ]; then
  case ":\$PATH:" in
    *":$AGENTS_DIR/bin:"*) ;;
    *) PATH="\$PATH:$AGENTS_DIR/bin"; export PATH ;;
  esac
fi
EOF
    $SUDO chmod 0644 /etc/profile.d/citadel-agents.sh
  fi

  # Friendly management CLI: `citadel status|url|qr|logs|restart|update|tunnel`.
  # A thin launcher so repository updates to scripts/citadel take effect at once.
  if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && [ -f "$APP_DIR/scripts/citadel" ]; then
    $SUDO tee /usr/local/bin/citadel >/dev/null <<EOF
#!/bin/sh
# Citadel CLI launcher (managed by install.sh)
exec bash "$APP_DIR/scripts/citadel" "\$@"
EOF
    $SUDO chmod 0755 /usr/local/bin/citadel
    detail "      Management CLI installed: citadel status | url | qr | update | tunnel"
  fi

  # Global access via a Cloudflare Quick Tunnel (on by default; disable with
  # --no-tunnel; also available anytime as `citadel tunnel`). No account or domain.
  if [ "$TUNNEL" = true ] && [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && [ -f "$APP_DIR/scripts/tunnel.sh" ]; then
    detail "      Setting up a global Cloudflare Quick Tunnel..."
    # CITADEL_QUIET: tunnel.sh must not print its own URL/QR; the single QR is
    # shown at the very end of this installer.
    if [ "$VERBOSE" = "1" ]; then
      $SUDO env CITADEL_QUIET=1 bash "$APP_DIR/scripts/tunnel.sh" up || echo -e "${YELLOW}      Tunnel setup skipped (see errors above).${NC}"
    else
      $SUDO env CITADEL_QUIET=1 bash "$APP_DIR/scripts/tunnel.sh" up >>"$INSTALL_LOG" 2>&1 \
        || { echo -e "${YELLOW}      Tunnel setup skipped:${NC}"; tail -n 8 "$INSTALL_LOG"; }
    fi
    # Re-generate connect-qr with the public tunnel URL so the QR code uses the public URL
    if $SUDO test -f "$DATA_DIR/tunnel-url"; then
      $SUDO -u "$RUN_USER" bash -c "cd '$APP_DIR' && DATA_DIR='$DATA_DIR' PORT='$PANEL_PORT' node scripts/pair-qr.js" 2>/dev/null | $SUDO tee "$DATA_DIR/connect-qr" >/dev/null || true
    fi
  fi

  # Always-on mode for laptop hosts (opt-in): closing the lid must not suspend
  # the machine and take Citadel/terminals/agents offline.
  if [ "$KEEP_AWAKE" = true ]; then
    if [ "$OS" = "Linux" ] && [ "$HAS_SUDO" = true ] && [ -f "$APP_DIR/scripts/power.sh" ]; then
      detail "      Enabling 24/7 mode (ignore lid close, block sleep)..."
      $SUDO bash "$APP_DIR/scripts/power.sh" on || echo -e "${YELLOW}      24/7 mode could not be enabled (see errors above).${NC}"
    else
      echo -e "${YELLOW}      24/7 mode skipped (requires Linux + systemd + sudo).${NC}"
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

  # Best URL for a phone: explicit public URL > Cloudflare tunnel > Tailscale
  # (*.ts.net) > LAN IP. Each branch also sets a human label.
  ACCESS_URL="${CITADEL_PUBLIC_URL:-}"
  ACCESS_LABEL="Panel (public URL)"
  TUNNEL_URL_FILE="$DATA_DIR/tunnel-url"
  # The data directory belongs to the service user, so read it with $SUDO.
  if [ -z "$ACCESS_URL" ] && $SUDO test -f "$TUNNEL_URL_FILE" 2>/dev/null; then
    ACCESS_URL="$($SUDO head -n1 "$TUNNEL_URL_FILE" 2>/dev/null || true)"
    ACCESS_LABEL="Panel (global)"
  fi
  if [ -z "$ACCESS_URL" ] && command -v tailscale >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    TS_DNS=$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.Self&&j.Self.DNSName)||"")}catch(e){}})' 2>/dev/null)
    if [ -n "$TS_DNS" ]; then
      ACCESS_URL="https://${TS_DNS%.}"
      ACCESS_LABEL="Panel (Tailscale)"
    fi
  fi
  if [ -z "$ACCESS_URL" ] && [ "$LAN_EXPOSED" = true ] && command -v hostname >/dev/null 2>&1; then
    LAN_IP=$(detect_lan_ip)
    if [ -n "$LAN_IP" ]; then
      ACCESS_URL="http://${LAN_IP}:$PANEL_PORT"
      ACCESS_LABEL="Panel (your network)"
    fi
  fi
  if [ -z "$ACCESS_URL" ]; then
    ACCESS_URL="http://127.0.0.1:$PANEL_PORT"
    ACCESS_LABEL="Panel (this machine)"
  fi

  echo "  $ACCESS_LABEL:  $ACCESS_URL"
  [ -n "$ADMIN_TERMINAL_USER" ] && echo "  System Terminal:  $ADMIN_TERMINAL_USER (root-capable)"
  echo "  Manage: citadel status | qr | update | doctor"
  # Scan-to-start: one QR for both jobs. A normal camera opens the panel; the
  # same code scanned from another Citadel's Pair screen pairs the two hosts.
  # The server writes the current single-use invitation at startup; fall back to
  # the plain URL when it is unavailable (for example in check-only mode).
  QR_TEXT="$ACCESS_URL"
  PAIR_QR=false
  if [ -n "$DATA_DIR" ]; then
    # The service writes the invitation just after it starts; give it a moment
    # so the post-install banner can show the dual-purpose code.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      $SUDO test -f "$DATA_DIR/connect-qr" 2>/dev/null && break
      sleep 0.3
    done
    if $SUDO test -f "$DATA_DIR/connect-qr" 2>/dev/null; then
      INVITE_LINK="$($SUDO head -n1 "$DATA_DIR/connect-qr" 2>/dev/null || true)"
      if [ -n "$INVITE_LINK" ] && [ -n "$ACCESS_URL" ] && [[ "$INVITE_LINK" == "$ACCESS_URL"* ]]; then
        QR_TEXT="$INVITE_LINK"
        case "$INVITE_LINK" in *'#pair='*) PAIR_QR=true ;; esac
      elif [ -z "$ACCESS_URL" ] && [ -n "$INVITE_LINK" ]; then
        QR_TEXT="$INVITE_LINK"
        case "$INVITE_LINK" in *'#pair='*) PAIR_QR=true ;; esac
      fi
    fi
  fi
  echo ""
  if [ "$TUNNEL" = true ] || [ "$LAN_EXPOSED" = true ]; then
    echo -e "${YELLOW}  Create your admin account NOW: until then the first visitor can claim it.${NC}"
  else
    echo "  Open the panel and create your admin account."
  fi
  echo "=================================================================="
  # The QR goes last so it stays on screen on a console without scrollback.
  if [ "$PAIR_QR" = true ]; then
    echo -e "${BLUE}  One QR: scan with a phone to open the panel, or from another Citadel's Pair screen:${NC}"
  else
    echo -e "${BLUE}  Scan with your phone to open the panel:${NC}"
  fi
  if command -v node >/dev/null 2>&1 && [ -f "$APP_DIR/scripts/print-qr.js" ]; then
    (cd "$APP_DIR" && node scripts/print-qr.js "$QR_TEXT" "$ACCESS_URL") || true
  elif command -v qrencode >/dev/null 2>&1; then
    # The Linux console font lacks the half-block glyphs used by ANSIUTF8.
    if [ "${TERM:-}" = "linux" ]; then
      qrencode -t ANSI -m 2 "$QR_TEXT" || true
    else
      qrencode -t ANSIUTF8 -m 2 "$QR_TEXT" || true
    fi
  fi
  echo "  $ACCESS_URL"
fi
