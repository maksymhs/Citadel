#!/usr/bin/env bash
# ==============================================================================
# Citadel — Cloudflare tunnel for macOS (launchd), one command, no account
#
#   bash scripts/tunnel-macos.sh                # install cloudflared, start a Quick Tunnel
#   bash scripts/tunnel-macos.sh --domain=HOST --token=TOKEN
#                                               # stable URL on your own domain
#   bash scripts/tunnel-macos.sh --quick        # back to a random trycloudflare.com URL
#   bash scripts/tunnel-macos.sh setup          # only install cloudflared (used by Settings → Tunnel)
#   bash scripts/tunnel-macos.sh stop | remove
#
# Runs as the logged-in user (no sudo). The runner (tunnel-run.sh) records the
# public URL in $DATA_DIR/tunnel-url, which the panel and the QR code read.
# Compatible with the bash 3.2 that ships with macOS.
# ==============================================================================
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: tunnel-macos.sh must run on macOS (use scripts/tunnel.sh on Linux)." >&2
  exit 1
fi

TARGET_DIR="${CITADEL_TARGET_DIR:-$HOME/Library/Application Support/Citadel}"
APP_DIR="${CITADEL_APP_DIR:-$TARGET_DIR/app}"
DATA_DIR="${CITADEL_DATA_DIR:-$TARGET_DIR/data}"
BIN_DIR="$TARGET_DIR/bin"
CLOUDFLARED="${CLOUDFLARED_PATH:-$BIN_DIR/cloudflared}"
PORT="${PORT:-3000}"
LABEL="com.citadel.tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LAUNCH_DOMAIN="gui/$(id -u)"
URL_FILE="$DATA_DIR/tunnel-url"
TOKEN_FILE="$DATA_DIR/tunnel-token"
DOMAIN_FILE="$DATA_DIR/tunnel-domain"
LOG_FILE="$DATA_DIR/logs/tunnel.log"
QUIET="${CITADEL_QUIET:-}"

ACTION="up"
DOMAIN=""
TOKEN=""
QUICK=false
RESTART=false
for arg in "$@"; do
  case "$arg" in
    up|stop|remove|setup) ACTION="$arg" ;;
    --domain=*) DOMAIN="${arg#--domain=}" ;;
    --token=*) TOKEN="${arg#--token=}" ;;
    --quick) QUICK=true ;;
    --restart) RESTART=true ;;
    *) echo "Usage: $0 [up|stop|remove|setup|--domain=HOST --token=TOKEN|--quick]" >&2; exit 1 ;;
  esac
done

say() { [ -n "$QUIET" ] || echo "$@"; }

stop_agent() {
  launchctl bootout "$LAUNCH_DOMAIN/$LABEL" >/dev/null 2>&1 || true
  : > "$URL_FILE" 2>/dev/null || true
}

case "$ACTION" in
  stop)
    stop_agent
    say "Tunnel stopped."
    exit 0
    ;;
  remove)
    stop_agent
    rm -f "$PLIST"
    say "Tunnel removed."
    exit 0
    ;;
esac

mkdir -p "$DATA_DIR/logs" "$BIN_DIR" "$HOME/Library/LaunchAgents"

# Named tunnel settings (same files tunnel-run.sh reads on Linux).
if [ "$QUICK" = true ]; then
  rm -f "$TOKEN_FILE" "$DOMAIN_FILE"
  RESTART=true
elif [ -n "$DOMAIN" ] || [ -n "$TOKEN" ]; then
  if [ -z "$DOMAIN" ] || [ -z "$TOKEN" ]; then
    echo "ERROR: --domain and --token must be given together." >&2
    exit 1
  fi
  DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
  if ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$'; then
    echo "ERROR: '$DOMAIN' is not a valid hostname." >&2
    exit 1
  fi
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  printf '%s\n' "$DOMAIN" > "$DOMAIN_FILE"
  RESTART=true
fi

# 1. cloudflared ---------------------------------------------------------------
if [ ! -x "$CLOUDFLARED" ]; then
  case "$(uname -m)" in
    arm64) CF_ARCH=arm64 ;;
    x86_64) CF_ARCH=amd64 ;;
    *) echo "ERROR: unsupported architecture '$(uname -m)'." >&2; exit 1 ;;
  esac
  CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${CF_ARCH}.tgz"
  say "Downloading cloudflared (${CF_ARCH})..."
  TMP_DIR="$(mktemp -d)"
  if ! curl -fsSL "$CF_URL" -o "$TMP_DIR/cloudflared.tgz"; then
    rm -rf "$TMP_DIR"
    echo "ERROR: could not download cloudflared from $CF_URL" >&2
    exit 1
  fi
  tar -xzf "$TMP_DIR/cloudflared.tgz" -C "$TMP_DIR"
  mv "$TMP_DIR/cloudflared" "$CLOUDFLARED"
  chmod 755 "$CLOUDFLARED"
  xattr -d com.apple.quarantine "$CLOUDFLARED" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
fi

if [ "$ACTION" = setup ]; then
  say "cloudflared ready: $CLOUDFLARED"
  exit 0
fi

# 2. launchd agent -------------------------------------------------------------
plist_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>$(plist_escape "$APP_DIR")/scripts/tunnel-run.sh</string>
    <string>http://127.0.0.1:$PORT</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>CITADEL_DATA_DIR</key><string>$(plist_escape "$DATA_DIR")</string>
    <key>CLOUDFLARED_PATH</key><string>$(plist_escape "$CLOUDFLARED")</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(plist_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key><string>$(plist_escape "$LOG_FILE")</string>
</dict></plist>
EOF

# Keep a running tunnel (and its URL) untouched unless something changed.
if [ "$RESTART" = false ] && launchctl print "$LAUNCH_DOMAIN/$LABEL" >/dev/null 2>&1 && [ -s "$URL_FILE" ]; then
  say "Tunnel already running: $(head -n1 "$URL_FILE")"
  exit 0
fi

launchctl bootout "$LAUNCH_DOMAIN/$LABEL" >/dev/null 2>&1 || true
: > "$URL_FILE"
launchctl bootstrap "$LAUNCH_DOMAIN" "$PLIST"
launchctl enable "$LAUNCH_DOMAIN/$LABEL"
launchctl kickstart -k "$LAUNCH_DOMAIN/$LABEL"

# 3. Wait for the public URL ---------------------------------------------------
say "Waiting for the public URL..."
PUBLIC_URL=""
for _ in $(seq 1 45); do
  PUBLIC_URL="$(head -n1 "$URL_FILE" 2>/dev/null || true)"
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "The tunnel is starting but no URL appeared yet. See: $LOG_FILE" >&2
  exit 1
fi
say "Global URL: $PUBLIC_URL"
