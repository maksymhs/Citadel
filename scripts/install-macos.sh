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

for arg in "$@"; do
  case "$arg" in
    --update|--upgrade) UPDATE_MODE=true ;;
    --help|-h)
      echo "Usage: bash scripts/install-macos.sh [--update]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

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

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH"
elif [ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/package.json" ] && [ "$SOURCE_DIR" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  cp -R "$SOURCE_DIR"/. "$APP_DIR"/
elif [ ! -f "$APP_DIR/package.json" ]; then
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
elif [ "$UPDATE_MODE" = true ]; then
  echo "ERROR: $APP_DIR is not a Git checkout; update it from its original source." >&2
  exit 1
fi

if [ ! -f "$APP_DIR/.env" ] && [ -f "$APP_DIR/.env.example" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi

cd "$APP_DIR"
npm install --omit=dev

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

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Citadel is running as $LABEL."
echo "Panel: http://127.0.0.1:3000"
echo "CLI:   $CLI (add $CLI_DIR to PATH if needed)"
if ! command -v tmux >/dev/null 2>&1; then
  echo "Note: install tmux (brew install tmux) for persistent terminal sessions."
fi
