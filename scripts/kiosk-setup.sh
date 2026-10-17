#!/usr/bin/env bash
# ==============================================================================
# Citadel — Kiosk Display Setup (idempotent)
# Turns a headless Linux box into a dedicated full-screen Citadel panel using a
# minimal Wayland compositor (cage) and a browser. Safe to run repeatedly: it
# only installs missing packages and rewrites files when their content changes.
#
#   sudo ./scripts/kiosk-setup.sh                 # default URL + user
#   sudo ./scripts/kiosk-setup.sh --user ubuntu --url http://127.0.0.1:3000
#   sudo ./scripts/kiosk-setup.sh --browser firefox
#   sudo ./scripts/kiosk-setup.sh --check         # report only, change nothing
#   sudo ./scripts/kiosk-setup.sh --remove        # undo the kiosk configuration
# ==============================================================================
set -euo pipefail

URL="http://127.0.0.1:3000"
BROWSER="epiphany-browser"
KIOSK_USER="${SUDO_USER:-$(id -un)}"
TTY_DEV="tty1"
CHECK_ONLY=false
REMOVE=false

for arg in "$@"; do
  case "$arg" in
    --url=*) URL="${arg#*=}" ;;
    --user=*) KIOSK_USER="${arg#*=}" ;;
    --browser=*) BROWSER="${arg#*=}" ;;
    --tty=*) TTY_DEV="${arg#*=}" ;;
    --check|--dry-run) CHECK_ONLY=true ;;
    --remove) REMOVE=true ;;
    --help|-h)
      echo "Usage: $0 [--user NAME] [--url URL] [--browser epiphany-browser|firefox|chromium] [--tty tty1] [--check] [--remove]"
      exit 0
      ;;
  esac
done

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "ERROR: administrator privileges are required." >&2
    exit 1
  fi
fi

LAUNCHER="/usr/local/bin/citadel-kiosk"
AUTOLOGIN_DIR="/etc/systemd/system/getty@${TTY_DEV}.service.d"
AUTOLOGIN_FILE="$AUTOLOGIN_DIR/autologin.conf"
LOGIND_DROPIN="/etc/systemd/logind.conf.d/10-citadel-kiosk.conf"

# Resolve the browser command and its kiosk flag.
case "$BROWSER" in
  epiphany|epiphany-browser) BROWSER_BIN="epiphany"; APT_BROWSER="epiphany-browser"; KIOSK_FLAG="" ;;
  firefox) BROWSER_BIN="firefox"; APT_BROWSER="firefox"; KIOSK_FLAG="--kiosk" ;;
  chromium|chromium-browser) BROWSER_BIN="chromium-browser"; APT_BROWSER="chromium-browser"; KIOSK_FLAG="--kiosk --noerrdialogs --disable-infobars" ;;
  *) echo "ERROR: unsupported browser '$BROWSER'." >&2; exit 1 ;;
esac

if ! id "$KIOSK_USER" >/dev/null 2>&1; then
  echo "ERROR: user '$KIOSK_USER' does not exist." >&2
  exit 1
fi
KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
PROFILE="$KIOSK_HOME/.bash_profile"

if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: kiosk setup requires Linux with systemd." >&2
  exit 1
fi

# Write a file only when its content differs (idempotent).
write_if_changed() {
  local path="$1" content="$2" mode="${3:-0644}" owner="${4:-root:root}"
  local tmp
  tmp="$(mktemp)"
  printf '%s\n' "$content" > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  if [ "$CHECK_ONLY" = true ]; then
    echo "      [check] would write $path"
    rm -f "$tmp"
    return 0
  fi
  $SUDO install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"
  rm -f "$tmp"
  return 0
}

# --- Removal path -------------------------------------------------------------
if [ "$REMOVE" = true ]; then
  echo "Removing Citadel kiosk configuration..."
  if [ "$CHECK_ONLY" = true ]; then
    echo "      [check] would remove the kiosk autologin, launcher and hooks."
  else
    $SUDO rm -f "$LAUNCHER" "$AUTOLOGIN_FILE" "$LOGIND_DROPIN" || true
    $SUDO rmdir "$AUTOLOGIN_DIR" 2>/dev/null || true
    if [ -f "$PROFILE" ] && $SUDO grep -q 'citadel-kiosk' "$PROFILE"; then
      $SUDO sed -i '/# >>> citadel-kiosk >>>/,/# <<< citadel-kiosk <<</d' "$PROFILE"
    fi
    $SUDO systemctl daemon-reload || true
    echo "      Kiosk configuration removed."
  fi
  exit 0
fi

echo "Configuring Citadel kiosk on $TTY_DEV for user '$KIOSK_USER' -> $URL ($BROWSER)"

# 1. Packages ------------------------------------------------------------------
MISSING=""
command -v cage >/dev/null 2>&1 || MISSING="$MISSING cage"
command -v "$BROWSER_BIN" >/dev/null 2>&1 || MISSING="$MISSING ${APT_BROWSER}"
if [ -n "$MISSING" ] && ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: missing packages:$MISSING (automatic install requires apt)." >&2
  exit 1
fi
if [ -n "$MISSING" ]; then
  echo "      Installing:$MISSING"
  if [ "$CHECK_ONLY" = true ]; then
    echo "      [check] would run: apt-get install -y$MISSING"
  else
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get update -qq || true
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq $MISSING
  fi
else
  echo "      Required packages already present."
fi

# 2. Kiosk launcher ------------------------------------------------------------
LAUNCHER_CONTENT="#!/bin/sh
# Managed by Citadel kiosk-setup.sh — do not edit by hand.
export MOZ_ENABLE_WAYLAND=1
exec cage -- $BROWSER_BIN $KIOSK_FLAG \"$URL\""
if write_if_changed "$LAUNCHER" "$LAUNCHER_CONTENT" 0755 root:root; then
  [ "$CHECK_ONLY" = true ] || echo "      Launcher written: $LAUNCHER"
fi

# 3. Autologin on the target TTY ----------------------------------------------
AUTOLOGIN_CONTENT="[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM"
if write_if_changed "$AUTOLOGIN_FILE" "$AUTOLOGIN_CONTENT" 0644 root:root; then
  [ "$CHECK_ONLY" = true ] || echo "      Autologin configured for '$KIOSK_USER' on $TTY_DEV"
fi

# 4. Start the kiosk on login (marked block, replaces any previous one) ---------
BLOCK_BEGIN="# >>> citadel-kiosk >>>"
BLOCK_END="# <<< citadel-kiosk <<<"
BLOCK="$BLOCK_BEGIN
if [ \"\$(tty)\" = \"/dev/$TTY_DEV\" ]; then
  exec $LAUNCHER
fi
$BLOCK_END"
if [ "$CHECK_ONLY" = true ]; then
  echo "      [check] would add the kiosk hook to $PROFILE"
else
  $SUDO touch "$PROFILE"
  if $SUDO grep -q 'citadel-kiosk' "$PROFILE"; then
    $SUDO sed -i '/# >>> citadel-kiosk >>>/,/# <<< citadel-kiosk <<</d' "$PROFILE"
  fi
  printf '%s\n' "$BLOCK" | $SUDO tee -a "$PROFILE" >/dev/null
  $SUDO chown "$KIOSK_USER":"$KIOSK_USER" "$PROFILE"
  echo "      Kiosk hook added to $PROFILE"
fi

# 5. Never suspend / hibernate / blank on idle --------------------------------
LOGIND_CONTENT="[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore"
if write_if_changed "$LOGIND_DROPIN" "$LOGIND_CONTENT" 0644 root:root; then
  [ "$CHECK_ONLY" = true ] || echo "      Idle/suspend disabled via $LOGIND_DROPIN"
fi

if [ "$CHECK_ONLY" = false ]; then
  $SUDO systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
  $SUDO systemctl daemon-reload || true
  $SUDO systemctl enable "getty@${TTY_DEV}.service" >/dev/null 2>&1 || true
fi

echo "Kiosk setup complete. Reboot (or switch to $TTY_DEV) to show the panel."
echo "Note: the panel asks for login once; the browser profile keeps the session."
