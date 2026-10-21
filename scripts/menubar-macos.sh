#!/usr/bin/env bash
# Citadel menu bar icon for macOS: builds scripts/macos/CitadelMenu.swift into a
# small background app and registers it as a login item (LaunchAgent), so the
# icon is there after every login. The icon shows whether Citadel is running,
# opens the dashboard and starts/stops/restarts the service.
#
#   menubar-macos.sh install   build, register and start the icon
#   menubar-macos.sh remove    stop and unregister it
#   menubar-macos.sh status    installed / running
#
# Needs the Xcode Command Line Tools (swiftc). Without them `install` exits 3
# and changes nothing, so the installer can treat it as optional.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: the menu bar icon is only available on macOS." >&2
  exit 1
fi

TARGET_DIR="${CITADEL_TARGET_DIR:-$HOME/Library/Application Support/Citadel}"
APP_DIR="${CITADEL_APP_DIR:-$TARGET_DIR/app}"
DATA_DIR="${CITADEL_DATA_DIR:-$TARGET_DIR/data}"
PORT="${PORT:-3000}"
CLI="${CITADEL_CLI:-$HOME/.local/bin/citadel}"
SRC="$APP_DIR/scripts/macos/CitadelMenu.swift"
BUNDLE="$TARGET_DIR/CitadelMenu.app"
BIN="$BUNDLE/Contents/MacOS/CitadelMenu"
STAMP="$BUNDLE/Contents/.source-hash"
LABEL="com.citadel.menubar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

plist_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

source_hash() {
  shasum -a 256 "$SRC" | cut -d' ' -f1
}

build() {
  mkdir -p "$BUNDLE/Contents/MacOS"
  cat > "$BUNDLE/Contents/Info.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleName</key><string>Citadel</string>
  <key>CFBundleExecutable</key><string>CitadelMenu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLISTEOF
  swiftc -O -o "$BIN" "$SRC" -framework Cocoa
  # Ad-hoc signature: keeps Gatekeeper quiet for a binary built on this Mac.
  codesign --force --sign - "$BUNDLE" >/dev/null 2>&1 || true
  source_hash > "$STAMP"
}

write_agent() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(plist_escape "$BIN")</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>CITADEL_PORT</key><string>$(plist_escape "$PORT")</string>
    <key>CITADEL_CLI</key><string>$(plist_escape "$CLI")</string>
    <key>CITADEL_LOG</key><string>$(plist_escape "$DATA_DIR/logs/citadel.log")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLISTEOF
}

case "${1:-status}" in
  install)
    if ! command -v swiftc >/dev/null 2>&1; then
      echo "The menu bar icon needs the Xcode Command Line Tools: xcode-select --install" >&2
      exit 3
    fi
    if [ ! -f "$SRC" ]; then
      echo "ERROR: $SRC not found (set CITADEL_APP_DIR)." >&2
      exit 1
    fi
    # Rebuild only when the source changed (or the binary is missing).
    if [ ! -x "$BIN" ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$(source_hash)" ]; then
      build
    fi
    write_agent
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl enable "$DOMAIN/$LABEL"
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    echo "Menu bar icon installed."
    ;;
  remove)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    rm -rf "$BUNDLE"
    echo "Menu bar icon removed."
    ;;
  status)
    if [ -f "$PLIST" ] && [ -x "$BIN" ]; then
      if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then echo "installed, running"; else echo "installed, not running"; fi
    else
      echo "not installed"
    fi
    ;;
  *)
    echo "Usage: menubar-macos.sh install|remove|status" >&2
    exit 2
    ;;
esac
