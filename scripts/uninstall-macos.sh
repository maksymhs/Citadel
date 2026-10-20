#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: uninstall-macos.sh must run on macOS." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: run this uninstaller as the macOS user that installed Citadel, not with sudo." >&2
  exit 1
fi

TARGET_DIR="${CITADEL_TARGET_DIR:-$HOME/Library/Application Support/Citadel}"
APP_DIR="$TARGET_DIR/app"
LABEL="com.citadel.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CLI="$HOME/.local/bin/citadel"
KEEP_DATA=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=true ;;
    --purge) KEEP_DATA=false ;;
    --dry-run|--check-only) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: install.sh --uninstall [--keep-data] [--dry-run]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

case "$TARGET_DIR" in
  /*) ;;
  *)
    echo "ERROR: CITADEL_TARGET_DIR must be an absolute path." >&2
    exit 2
    ;;
esac
case "/$TARGET_DIR/" in
  *"/../"*)
    echo "ERROR: CITADEL_TARGET_DIR must not contain '..'." >&2
    exit 2
    ;;
esac
for protected in / "$HOME" "$HOME/Library" "$HOME/Library/Application Support"; do
  if [ "$TARGET_DIR" = "$protected" ]; then
    echo "ERROR: refusing to remove protected path $TARGET_DIR." >&2
    exit 2
  fi
done

if [ ! -f "$APP_DIR/package.json" ] || ! grep -q '"name"[[:space:]]*:[[:space:]]*"citadel"' "$APP_DIR/package.json"; then
  echo "ERROR: refusing to remove $TARGET_DIR: no Citadel installation found." >&2
  exit 2
fi

if [ "$DRY_RUN" = true ]; then
  echo "Would unload $LABEL and com.citadel.tunnel and remove $PLIST and $CLI."
  if [ "$KEEP_DATA" = true ]; then
    echo "Would preserve $TARGET_DIR/data and remove only the application files."
  else
    echo "Would remove $TARGET_DIR."
  fi
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/com.citadel.tunnel" >/dev/null 2>&1 || true
rm -f "$PLIST" "$HOME/Library/LaunchAgents/com.citadel.tunnel.plist"
rm -f "$CLI"
if [ "$KEEP_DATA" = true ]; then
  rm -rf "$APP_DIR" "$TARGET_DIR/agents"
  echo "Citadel removed; data remains in $TARGET_DIR/data."
else
  rm -rf "$TARGET_DIR"
  echo "Citadel and its data have been removed."
fi
