#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: install-macos.sh must run on macOS." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: run this installer as your normal macOS user, not with sudo." >&2
  exit 1
fi

TARGET_DIR="${CITADEL_TARGET_DIR:-$HOME/Library/Application Support/Citadel}"
APP_DIR="$TARGET_DIR/app"
DATA_DIR="$TARGET_DIR/data"
PROJECTS_DIR="$DATA_DIR/projects"
LOGS_DIR="$DATA_DIR/logs"
AGENTS_DIR="${CITADEL_AGENTS_DIR:-$TARGET_DIR/agents}"
LABEL="com.citadel.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CLI_DIR="$HOME/.local/bin"
CLI="$CLI_DIR/citadel"
REPO_URL="${CITADEL_REPO_URL:-https://github.com/maksymhs/Citadel.git}"
REPO_BRANCH="${CITADEL_REPO_BRANCH:-main}"
UPDATE_MODE=false
# Same as the Linux installer: a public Cloudflare Quick Tunnel by default, so
# the install ends with a public address and a QR. Creating the administrator
# needs the setup code printed next to that QR, so nobody else can claim it.
TUNNEL=true
# Menu bar icon: on unless --no-menubar or CITADEL_NO_MENUBAR=1.
MENUBAR=true
[ -z "${CITADEL_NO_MENUBAR:-}" ] || MENUBAR=false

for arg in "$@"; do
  case "$arg" in
    --update|--upgrade) UPDATE_MODE=true ;;
    --no-tunnel|--local) TUNNEL=false ;;
    --tunnel) TUNNEL=true ;;
    --no-menubar) MENUBAR=false ;;
    --help|-h)
      echo "Usage: bash scripts/install-macos.sh [--update] [--no-tunnel] [--no-menubar]"
      echo "  --no-tunnel   keep the panel on this Mac only (no public Cloudflare Quick Tunnel)"
      echo "  --no-menubar  skip the menu bar icon (it is added when the Mac allows it)"
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

# Minimal output by default: one self-updating line with a spinner, then a status
# and a single QR. CITADEL_VERBOSE=1 shows everything. Noisy tools log to a file
# that is printed only on failure. (Written for the bash 3.2 that ships with macOS.)
VERBOSE="${CITADEL_VERBOSE:-0}"
INSTALL_LOG="$(mktemp "${TMPDIR:-/tmp}/citadel-install.XXXXXX")"
PROGRESS=false
CLR=""
if [ "$VERBOSE" != "1" ] && [ -t 1 ]; then
  PROGRESS=true
  CLR=$'\r\033[K'
fi
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) FRAMES='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' ;;
  *) FRAMES='|/-\' ;;
esac
STEP_LINE=""
step() {
  if [ "$PROGRESS" = true ]; then
    STEP_LINE="Installing Citadel · $*"
    printf '\r\033[K  %s %s' "${FRAMES:0:1}" "$STEP_LINE"
  elif [ "$VERBOSE" = "1" ]; then
    echo "==> $*"
  fi
}
# quiet_run <command...>: spinner while it runs, log to a file, tail on failure.
quiet_run() {
  if [ "$VERBOSE" = "1" ]; then "$@"; return $?; fi
  local rc=0
  if [ "$PROGRESS" = true ]; then
    ( "$@" ) >>"$INSTALL_LOG" 2>&1 &
    local pid=$! i=0 n=${#FRAMES}
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r\033[K  %s %s' "${FRAMES:i++%n:1}" "$STEP_LINE"
      sleep 0.1
    done
    wait "$pid" || rc=$?
    printf '\r\033[K  %s %s' "${FRAMES:0:1}" "$STEP_LINE"
  else
    "$@" >>"$INSTALL_LOG" 2>&1 || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    printf '%s' "$CLR"
    echo "Command failed: $*" >&2
    tail -n 20 "$INSTALL_LOG" >&2
  fi
  return "$rc"
}

step "Checking requirements"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "ERROR: Node.js 18 or newer is required. Install it with: brew install node" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: Git is required. Install Xcode Command Line Tools with: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR" "$DATA_DIR" "$PROJECTS_DIR" "$LOGS_DIR" "$AGENTS_DIR" "$CLI_DIR" "$HOME/Library/LaunchAgents"

SOURCE_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

step "Fetching Citadel"
if [ -d "$APP_DIR/.git" ]; then
  quiet_run git -C "$APP_DIR" fetch -q --depth 1 origin "$REPO_BRANCH"
  quiet_run git -C "$APP_DIR" reset -q --hard "origin/$REPO_BRANCH"
elif [ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/package.json" ] && [ "$SOURCE_DIR" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  cp -R "$SOURCE_DIR"/. "$APP_DIR"/
elif [ ! -f "$APP_DIR/package.json" ]; then
  quiet_run git clone -q --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
elif [ "$UPDATE_MODE" = true ]; then
  echo "ERROR: $APP_DIR is not a Git checkout; update it from its original source." >&2
  exit 1
fi

if [ ! -f "$APP_DIR/.env" ] && [ -f "$APP_DIR/.env.example" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi

cd "$APP_DIR"
step "Installing dependencies"
quiet_run npm install --omit=dev --no-fund --no-audit --loglevel=error

NODE_BIN="$(command -v node)"
plist_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

PLIST_NODE_BIN="$(plist_escape "$NODE_BIN")"
PLIST_APP_DIR="$(plist_escape "$APP_DIR")"
PLIST_DATA_DIR="$(plist_escape "$DATA_DIR")"
PLIST_LOG_FILE="$(plist_escape "$LOGS_DIR/citadel.log")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PLIST_NODE_BIN</string><string>$PLIST_APP_DIR/server/index.js</string></array>
  <key>WorkingDirectory</key><string>$PLIST_APP_DIR</string>
  <key>EnvironmentVariables</key><dict><key>DATA_DIR</key><string>$PLIST_DATA_DIR</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PLIST_LOG_FILE</string>
  <key>StandardErrorPath</key><string>$PLIST_LOG_FILE</string>
</dict></plist>
EOF

cat > "$CLI" <<EOF
#!/bin/sh
export CITADEL_APP_DIR="$APP_DIR"
export CITADEL_DATA_DIR="$DATA_DIR"
exec bash "$APP_DIR/scripts/citadel" "\$@"
EOF
chmod 0755 "$CLI"

step "Starting the service"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

# Menu bar icon (shows that Citadel is running; open the dashboard, start/stop).
# Optional: needs the Xcode Command Line Tools, and never blocks the install.
# It is a convenience: whatever goes wrong here (no Xcode tools, an SSH session
# without a graphical login, a build error) leaves a note and the install
# carries on from the command line.
MENUBAR_NOTE=""
if [ "$MENUBAR" = true ] && [ -f "$APP_DIR/scripts/menubar-macos.sh" ]; then
  step "Adding the menu bar icon"
  menubar_rc=0
  env CITADEL_TARGET_DIR="$TARGET_DIR" CITADEL_APP_DIR="$APP_DIR" CITADEL_DATA_DIR="$DATA_DIR" CITADEL_CLI="$CLI" \
    bash "$APP_DIR/scripts/menubar-macos.sh" install >>"$INSTALL_LOG" 2>&1 || menubar_rc=$?
  case "$menubar_rc" in
    0) MENUBAR_NOTE="  Menu bar icon added: open the dashboard or stop Citadel from there." ;;
    3) MENUBAR_NOTE="  Menu bar icon skipped: it needs the Xcode tools (xcode-select --install), then: citadel menubar on" ;;
    4) MENUBAR_NOTE="  Menu bar icon skipped: no graphical login session (installed over SSH?). Add it later from the Mac with: citadel menubar on" ;;
    *) MENUBAR_NOTE="  Menu bar icon could not be built (log: $INSTALL_LOG). Everything else is installed; retry with: citadel menubar on" ;;
  esac
fi

PORT_NUM=3000
HEALTH_OK=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT_NUM/api/auth/status" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 1
done

# Always leave cloudflared installed (even with --no-tunnel) so Settings → Tunnel
# can attach your own domain without any extra step.
if [ -f "$APP_DIR/scripts/tunnel-macos.sh" ]; then
  quiet_run env CITADEL_QUIET=1 CITADEL_TARGET_DIR="$TARGET_DIR" CITADEL_APP_DIR="$APP_DIR" CITADEL_DATA_DIR="$DATA_DIR" \
    bash "$APP_DIR/scripts/tunnel-macos.sh" setup || true
fi

# Public tunnel (Cloudflare Quick Tunnel, no account): gives the QR a global
# address. Skipped with --no-tunnel; an existing tunnel keeps its URL on update.
PUBLIC_URL=""
if [ "$TUNNEL" = true ] && [ "$HEALTH_OK" = true ] && [ -f "$APP_DIR/scripts/tunnel-macos.sh" ]; then
  step "Opening a public tunnel"
  quiet_run env CITADEL_QUIET=1 CITADEL_TARGET_DIR="$TARGET_DIR" CITADEL_APP_DIR="$APP_DIR" CITADEL_DATA_DIR="$DATA_DIR" \
    bash "$APP_DIR/scripts/tunnel-macos.sh" up || true
  PUBLIC_URL="$(head -n1 "$DATA_DIR/tunnel-url" 2>/dev/null || true)"
fi

VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || true)"
ACCESS_URL="${PUBLIC_URL:-http://127.0.0.1:$PORT_NUM}"

printf '%s' "$CLR"
if [ "$HEALTH_OK" = true ]; then
  if [ "$UPDATE_MODE" = true ]; then
    echo "✔ Citadel ${VERSION:+v$VERSION }updated"
  else
    echo "✔ Citadel ${VERSION:+v$VERSION }running"
  fi
else
  echo "… Citadel ${VERSION:+v$VERSION }is still starting (check: citadel status, log: $LOGS_DIR/citadel.log)"
fi
echo "  $ACCESS_URL"

# One QR, last: opens the panel from a phone camera and pairs from another
# Citadel's "Pair a machine" screen (single-use invitation for this address).
# The setup code goes right above it: creating the administrator account asks for
# it, so a stranger who reaches the panel first cannot claim it.
if [ "$UPDATE_MODE" = false ]; then
  # Empty output with a success status means an administrator already exists.
  SETUP_CODE_RC=0
  SETUP_CODE="$(cd "$APP_DIR" && DATA_DIR="$DATA_DIR" node scripts/setup-code.js --quiet 2>/dev/null)" || SETUP_CODE_RC=$?
  SETUP_CODE="${SETUP_CODE##*$'\n'}"
  if [ -n "$SETUP_CODE" ]; then
    echo "  Setup code: $SETUP_CODE  (asked when you create the admin account; show it again with: citadel setup-code)"
  elif [ "$SETUP_CODE_RC" -ne 0 ]; then
    echo "  The panel asks for a setup code to create the admin account: run  citadel setup-code"
  fi
fi
if [ -n "$PUBLIC_URL" ] && [ "$UPDATE_MODE" = false ]; then
  PAIR_LINK="$(cd "$APP_DIR" && DATA_DIR="$DATA_DIR" node scripts/pair-qr.js "$PUBLIC_URL" 2>/dev/null | tail -n1 || true)"
  QR_TEXT="$PUBLIC_URL"
  case "$PAIR_LINK" in "$PUBLIC_URL"*"#pair="*) QR_TEXT="$PAIR_LINK" ;; esac
  echo "  Scan to open on your phone, or to pair from another Citadel."
  (cd "$APP_DIR" && node scripts/print-qr.js "$QR_TEXT" "$PUBLIC_URL") || true
elif [ -z "$PUBLIC_URL" ] && [ "$UPDATE_MODE" = false ]; then
  if [ "$TUNNEL" = true ]; then
    echo "  No public tunnel yet. Try: citadel tunnel"
  else
    echo "  Only reachable from this Mac. For a public address run: citadel tunnel   (Tailscale is a private alternative)."
  fi
fi
[ -z "$MENUBAR_NOTE" ] || echo "$MENUBAR_NOTE"
if ! command -v tmux >/dev/null 2>&1; then
  echo "  Note: install tmux (brew install tmux) for persistent terminal sessions."
fi
echo "  Manage with: citadel status | qr | update | tunnel   (add $CLI_DIR to PATH if needed)"
