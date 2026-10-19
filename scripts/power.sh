#!/usr/bin/env bash
# ==============================================================================
# Citadel — 24/7 mode for laptop hosts
#
# Closing a laptop lid normally suspends the machine, which stops Citadel and
# every terminal/agent with it. This helper makes the host ignore the lid
# switch and blocks system sleep targets so the service keeps running.
#
#   scripts/power.sh status   Show the current lid/sleep state
#   scripts/power.sh on       Ignore lid close and block suspend/hibernate
#   scripts/power.sh off      Restore the system defaults
#
# `on`/`off` need root and only touch systemd/logind configuration. They are
# safe to run repeatedly.
# ==============================================================================
set -euo pipefail

DROPIN_DIR="${CITADEL_LOGIND_DROPIN_DIR:-/etc/systemd/logind.conf.d}"
DROPIN="$DROPIN_DIR/90-citadel-24-7.conf"
STATE_FILE="$DROPIN.state"
SLEEP_TARGETS=(sleep.target suspend.target hibernate.target hybrid-sleep.target)

usage() {
  cat <<EOF
Citadel 24/7 mode

  citadel power status   Show lid-close and sleep-target state
  citadel power on       Ignore lid close and block suspend/hibernate
  citadel power off      Restore system sleep defaults

This is intended for laptops used as always-on Citadel servers. It changes
systemd-logind and masks the system sleep targets. Use "off" to undo it.
EOF
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: '$1' needs root. Run: sudo citadel power $1" >&2
    exit 1
  fi
}

have_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

reload_logind() {
  # SIGHUP makes logind re-read logind.conf.d without killing the user's
  # session. Fall back to a restart only when the signal is unsupported.
  if ! systemctl kill -s HUP systemd-logind >/dev/null 2>&1; then
    systemctl restart systemd-logind >/dev/null 2>&1 || true
  fi
}

lid_property() {
  if ! command -v busctl >/dev/null 2>&1; then
    return 1
  fi
  busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
    org.freedesktop.login1.Manager HandleLidSwitch 2>/dev/null \
    | awk '{print $2}' | tr -d '"'
}

show_status() {
  echo "Citadel 24/7 mode"

  if [ -f "$DROPIN" ]; then
    echo "  Lid close:     ignored (managed by Citadel)"
  else
    echo "  Lid close:     system default"
  fi

  local live
  live="$(lid_property || true)"
  if [ -n "$live" ]; then
    echo "  logind now:    HandleLidSwitch=$live"
  fi

  local target state
  for target in "${SLEEP_TARGETS[@]}"; do
    state="$(systemctl is-enabled "$target" 2>/dev/null || true)"
    if [ "$state" = "masked" ]; then
      echo "  $target: masked"
    elif [ -n "$state" ]; then
      echo "  $target: $state"
    else
      echo "  $target: unknown"
    fi
  done

  local sleep_state
  sleep_state="$(systemctl is-enabled sleep.target 2>/dev/null || true)"
  if [ ! -f "$DROPIN" ] && [ "$sleep_state" != "masked" ]; then
    echo ""
    echo "Sleep is still allowed. Enable always-on mode with: sudo citadel power on"
  fi
}

enable_mode() {
  need_root on
  if ! have_systemd; then
    echo "ERROR: systemd is required for 24/7 mode." >&2
    exit 1
  fi

  mkdir -p "$DROPIN_DIR"

  # Remember which targets were already masked before this tool touched them,
  # so "off" does not override an operator's own power policy.
  if [ ! -f "$STATE_FILE" ]; then
    : > "$STATE_FILE"
    local target
    for target in "${SLEEP_TARGETS[@]}"; do
      if [ "$(systemctl is-enabled "$target" 2>/dev/null || true)" != "masked" ]; then
        echo "$target" >> "$STATE_FILE"
      fi
    done
  fi

  cat > "$DROPIN" <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
EOF
  chmod 0644 "$DROPIN"

  systemctl mask "${SLEEP_TARGETS[@]}" >/dev/null
  systemctl daemon-reload >/dev/null 2>&1 || true
  reload_logind

  echo "Citadel 24/7 mode enabled."
  echo "  - Closing the lid no longer suspends the host."
  echo "  - sleep/suspend/hibernate targets are masked."
  echo "  - Check with: citadel power status"
  echo "  - Undo with:  sudo citadel power off"
}

disable_mode() {
  need_root off
  if ! have_systemd; then
    echo "ERROR: systemd is required for 24/7 mode." >&2
    exit 1
  fi

  rm -f "$DROPIN"

  local -a unmask=()
  if [ -f "$STATE_FILE" ]; then
    while IFS= read -r target; do
      [ -n "$target" ] && unmask+=("$target")
    done < "$STATE_FILE"
    rm -f "$STATE_FILE"
  else
    unmask=("${SLEEP_TARGETS[@]}")
  fi

  if [ "${#unmask[@]}" -gt 0 ]; then
    systemctl unmask "${unmask[@]}" >/dev/null 2>&1 || true
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  reload_logind

  echo "Citadel 24/7 mode disabled. System sleep defaults restored."
}

case "${1:-status}" in
  status)
    show_status
    ;;
  on|enable)
    enable_mode
    ;;
  off|disable)
    disable_mode
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown power action: $1" >&2
    echo "" >&2
    usage >&2
    exit 2
    ;;
esac
