#!/usr/bin/env bash
# ==============================================================================
# Citadel — Cloudflare Quick Tunnel (one command, no account, no domain)
#
#   sudo ./scripts/tunnel.sh          # install cloudflared and start the tunnel
#   sudo ./scripts/tunnel.sh stop     # stop it (URL goes away)
#   sudo ./scripts/tunnel.sh remove   # stop and delete the service
#
# Gives the panel a GLOBAL https URL (https://<random>.trycloudflare.com) that
# works from any network. The URL changes every time the tunnel restarts, so the
# panel reads it dynamically and the QR always shows the current one.
# ==============================================================================
set -euo pipefail

ACTION="${1:-up}"
SERVICE="citadel-tunnel"
APP_DIR="${CITADEL_APP_DIR:-/srv/citadel/app}"
DATA_DIR="${CITADEL_DATA_DIR:-/srv/citadel/data}"
RUN_USER="${CITADEL_RUN_USER:-citadel}"
PORT="${PORT:-3000}"
TARGET="http://127.0.0.1:${PORT}"
CLOUDFLARED="/usr/local/bin/cloudflared"
UNIT="/etc/systemd/system/${SERVICE}.service"
URL_FILE="$DATA_DIR/tunnel-url"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "ERROR: administrator privileges are required (run as root or with sudo)." >&2
    exit 1
  fi
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: the tunnel requires systemd." >&2
  exit 1
fi

stop_tunnel() {
  $SUDO systemctl stop "$SERVICE" 2>/dev/null || true
  $SUDO systemctl disable "$SERVICE" 2>/dev/null || true
  $SUDO rm -f "$URL_FILE" 2>/dev/null || true
}

case "$ACTION" in
  stop)
    echo "Stopping the Cloudflare tunnel..."
    stop_tunnel
    echo "Tunnel stopped."
    exit 0
    ;;
  remove)
    echo "Removing the Cloudflare tunnel..."
    stop_tunnel
    $SUDO rm -f "$UNIT"
    $SUDO systemctl daemon-reload 2>/dev/null || true
    echo "Tunnel removed."
    exit 0
    ;;
  up) ;;
  *)
    echo "Usage: $0 [up|stop|remove]" >&2
    exit 1
    ;;
esac

# 1. cloudflared ---------------------------------------------------------------
if [ ! -x "$CLOUDFLARED" ]; then
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "ERROR: curl or wget is required to download cloudflared." >&2
    exit 1
  fi
  case "$(uname -m)" in
    x86_64|amd64) CF_ARCH=amd64 ;;
    aarch64|arm64) CF_ARCH=arm64 ;;
    armv7l|armv6l) CF_ARCH=arm ;;
    *) echo "ERROR: unsupported architecture '$(uname -m)'." >&2; exit 1 ;;
  esac
  CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
  echo "Downloading cloudflared (${CF_ARCH})..."
  TMP="$(mktemp)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$CF_URL" -o "$TMP"
  else
    wget -qO "$TMP" "$CF_URL"
  fi
  $SUDO install -m 0755 "$TMP" "$CLOUDFLARED"
  rm -f "$TMP"
  echo "Installed $CLOUDFLARED"
else
  echo "cloudflared already installed."
fi

# 2. Service unit --------------------------------------------------------------
echo "Writing ${SERVICE}.service ..."
$SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Citadel Cloudflare Quick Tunnel
After=network-online.target citadel.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
Environment=CITADEL_DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/env bash $APP_DIR/scripts/tunnel-run.sh $TARGET
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE" >/dev/null 2>&1 || true
$SUDO systemctl restart "$SERVICE"

# 3. Wait for the public URL ---------------------------------------------------
echo "Waiting for the public URL..."
PUBLIC_URL=""
for _ in $(seq 1 30); do
  if [ -f "$URL_FILE" ]; then
    PUBLIC_URL="$(head -n1 "$URL_FILE" 2>/dev/null || true)"
  fi
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "The tunnel is starting but no URL appeared yet. Check: citadel logs (or journalctl -u $SERVICE)." >&2
  exit 1
fi

echo ""
echo "Global URL: $PUBLIC_URL"
echo "(This URL changes when the tunnel restarts.)"
echo ""

PAIR_LINK=""
if command -v node >/dev/null 2>&1 && [ -f "$APP_DIR/scripts/pair-qr.js" ]; then
  PAIR_LINK="$(cd "$APP_DIR" && DATA_DIR="$DATA_DIR" PORT="$PORT" node scripts/pair-qr.js 2>/dev/null || true)"
  if [ -n "$PAIR_LINK" ]; then
    printf '%s\n' "$PAIR_LINK" > "$DATA_DIR/connect-qr" 2>/dev/null || true
  fi
fi

if command -v node >/dev/null 2>&1 && [ -f "$APP_DIR/scripts/print-qr.js" ]; then
  (cd "$APP_DIR" && node scripts/print-qr.js "${PAIR_LINK:-$PUBLIC_URL}" "$PUBLIC_URL") || true
fi
echo "  $PUBLIC_URL"
