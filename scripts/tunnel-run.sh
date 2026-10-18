#!/usr/bin/env bash
# ==============================================================================
# Citadel — Cloudflare Quick Tunnel runner (used by citadel-tunnel.service)
# Starts `cloudflared` and records the current public URL so the panel can show
# it in the QR code. The URL file is cleared when the tunnel stops, so a stale
# address is never advertised.
# ==============================================================================
set -uo pipefail

TARGET="${1:-http://127.0.0.1:3000}"
DATA_DIR="${CITADEL_DATA_DIR:-/srv/citadel/data}"
URL_FILE="$DATA_DIR/tunnel-url"
CLOUDFLARED="${CLOUDFLARED_PATH:-/usr/local/bin/cloudflared}"

mkdir -p "$DATA_DIR" 2>/dev/null || true
: > "$URL_FILE" 2>/dev/null || true

if [ ! -x "$CLOUDFLARED" ]; then
  echo "cloudflared not found at $CLOUDFLARED" >&2
  exit 1
fi

# Stream cloudflared output, scraping the public URL from the startup banner.
"$CLOUDFLARED" tunnel --no-autoupdate --url "$TARGET" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in
    *trycloudflare.com*)
      url="$(printf '%s' "$line" | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | head -n1 || true)"
      if [ -n "$url" ]; then
        printf '%s\n' "$url" > "$URL_FILE"
      fi
      ;;
  esac
done

# Tunnel ended: drop the (now stale) URL.
: > "$URL_FILE" 2>/dev/null || true
