#!/usr/bin/env bash
# Citadel — full uninstaller
#
# Removes the systemd service, drop-ins, sudoers rules and helper scripts, and
# (unless --keep-data) the data directory and service user.
#
# Safety model: every path this script may delete is canonicalised (symlinks
# resolved) and checked against a protected-path policy BEFORE any system change
# — stopping services, deleting units/sudoers/helpers or removing data. A
# directory is only treated as a Citadel installation when it actually looks
# like one (application manifest/layout); an environment variable alone is never
# proof that a directory is safe to delete. Removing an independent source
# checkout is opt-in and additionally requires interactive confirmation.
#
#   sudo ./scripts/uninstall.sh                    # remove everything but the source checkout
#   sudo ./scripts/uninstall.sh --keep-data        # keep the install dir (data + user)
#   sudo ./scripts/uninstall.sh --dry-run          # validate and print the plan only
#   sudo ./scripts/uninstall.sh --remove-source    # also delete the local checkout (asks first)
set -euo pipefail

SERVICE="${CITADEL_SERVICE:-citadel}"
RUN_USER="${CITADEL_RUN_USER:-citadel}"
TARGET_RAW="${CITADEL_TARGET_DIR:-/srv/citadel}"
AGENTS_RAW="${CITADEL_AGENTS_DIR:-/opt/citadel/agents}"

PURGE=true
REMOVE_SOURCE=false
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: uninstall.sh [options]

  (default)         Remove the service, systemd units, helpers and data.
                    The local source checkout is KEPT.
  --keep-data       Keep the install directory (data, projects) and service user.
  --purge           Remove data too (the default).
  --remove-source   Also delete the local source checkout. Requires an
                    interactive confirmation; in a non-interactive shell the
                    checkout is preserved.
  --keep-source     Deprecated no-op: the source checkout is kept by default.
  --dry-run, --check-only
                    Validate paths and print the plan; make no changes.
  -h, --help        Show this help.
EOF
}

die() { echo "ERROR: $*" >&2; exit 2; }

# --- argument parsing (no side effects) -------------------------------------
for arg in "$@"; do
  case "$arg" in
    --keep-data) PURGE=false ;;
    --purge) PURGE=true ;;
    --keep-source) REMOVE_SOURCE=false ;;
    --remove-source) REMOVE_SOURCE=true ;;
    --dry-run|--check-only) DRY_RUN=true ;;
    --help|-h) usage; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) die "unexpected argument: $arg" ;;
  esac
done

# --- canonical path helpers -------------------------------------------------
# Reject any raw path with a '..' component so it cannot escape the string-level
# policy checks below before canonicalisation.
reject_dotdot() {
  case "/$1/" in
    *"/../"*) die "refusing a path containing '..': $1" ;;
  esac
}

# Resolve a path to an absolute, symlink-free form even when the final target
# does not exist yet (the deepest existing parent is resolved with `pwd -P`).
canonicalize() {
  local raw="$1" abs dir base parent suffix real
  [ -n "$raw" ] || return 1
  case "$raw" in /*) abs="$raw" ;; *) abs="$(pwd)/$raw" ;; esac
  suffix=""
  dir="$abs"
  while [ ! -d "$dir" ]; do
    base="$(basename "$dir")"
    suffix="/$base$suffix"
    parent="$(dirname "$dir")"
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  real="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
  printf '%s%s\n' "${real%/}" "$suffix"
}

# Exact system roots that must never be a removal target.
PROTECTED_ROOTS=(
  / /bin /sbin /lib /lib64 /lib32 /libx32 /usr /etc /var /home /root /opt /srv
  /boot /proc /sys /dev /run /mnt /media /lost+found /tmp
  /private /private/etc /private/var /private/tmp
)
# Strictly system trees: a Citadel installation is never inside these.
SYSTEM_SUBTREES=(/etc /usr /bin /sbin /lib /lib64 /boot /proc /sys /dev /run /root /private/etc)

# Reject empty paths, the filesystem root, protected system roots, their
# ancestors and any path inside a strict system tree.
validate_safe_path() {
  local label="$1" path="$2" root sub
  [ -n "$path" ] || die "$label is empty or could not be resolved."
  [ "$path" != "/" ] || die "$label must not be the filesystem root."
  for root in "${PROTECTED_ROOTS[@]}"; do
    if [ "$path" = "$root" ]; then
      die "$label resolves to a protected system directory: $path"
    fi
    case "$root" in
      "$path"/*) die "$label ($path) is a parent of the protected path $root." ;;
    esac
  done
  for sub in "${SYSTEM_SUBTREES[@]}"; do
    case "$path" in
      "$sub"|"$sub"/*) die "$label is inside the protected system tree $sub: $path" ;;
    esac
  done
}

# A directory is only a Citadel installation when it actually looks like one.
has_citadel_evidence() {
  local dir="$1"
  [ -n "$dir" ] || return 1
  local pkg
  for pkg in "$dir/app/package.json" "$dir/package.json"; do
    if [ -f "$pkg" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"citadel"' "$pkg" 2>/dev/null; then
      return 0
    fi
  done
  for f in "$dir/app/server/index.js" "$dir/server/index.js" "$dir/data/citadel.db" "$dir/.citadel-install"; do
    [ -e "$f" ] && return 0
  done
  return 1
}

# --- collect and validate every path BEFORE any effect ----------------------
reject_dotdot "$TARGET_RAW"
reject_dotdot "$AGENTS_RAW"
TARGET_DIR="$(canonicalize "$TARGET_RAW")" || die "could not resolve CITADEL_TARGET_DIR: $TARGET_RAW"
AGENTS_DIR="$(canonicalize "$AGENTS_RAW")" || die "could not resolve CITADEL_AGENTS_DIR: $AGENTS_RAW"

validate_safe_path "CITADEL_TARGET_DIR" "$TARGET_DIR"
validate_safe_path "CITADEL_AGENTS_DIR" "$AGENTS_DIR"

if [ "$PURGE" = true ] && ! has_citadel_evidence "$TARGET_DIR"; then
  die "refusing to delete $TARGET_DIR: no Citadel installation found there (set CITADEL_TARGET_DIR only for a real install)."
fi

# Local checkouts the installer may have recorded. `data/source-dir` is
# untrusted, mutable data: it never authorises deletion on its own.
RECORDED_RAW=""
if [ -f "$TARGET_DIR/data/source-dir" ]; then
  RECORDED_RAW="$(cat "$TARGET_DIR/data/source-dir" 2>/dev/null || true)"
fi
SCRIPT_SOURCE=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P || true)"
  [ -n "$SCRIPT_DIR" ] && SCRIPT_SOURCE="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P || true)"
fi

RECORDED_SOURCE=""
if [ -n "$RECORDED_RAW" ]; then
  reject_dotdot "$RECORDED_RAW"
  RECORDED_SOURCE="$(canonicalize "$RECORDED_RAW")" || RECORDED_SOURCE=""
fi

validate_checkout() {
  local label="$1" dir="$2"
  [ -n "$dir" ] || return 1
  validate_safe_path "$label" "$dir" || return 1
  if [ "$dir" = "$TARGET_DIR" ]; then
    echo "[WARN] $label equals the installation target; not removing it." >&2
    return 1
  fi
  case "$TARGET_DIR" in
    "$dir"/*) echo "[WARN] $label ($dir) is a parent of the installation; not removing it." >&2; return 1 ;;
  esac
  if [ ! -d "$dir/.git" ]; then
    echo "[WARN] $label ($dir) is not a git checkout; not removing it." >&2
    return 1
  fi
  return 0
}

if [ "$DRY_RUN" = true ]; then
  echo "=================================================="
  echo "          Citadel — Uninstall (DRY RUN)           "
  echo "=================================================="
  echo "No changes will be made."
  echo "Service:            ${SERVICE}.service"
  echo "Service user:       $RUN_USER"
  echo "CITADEL_TARGET_DIR: $TARGET_DIR"
  echo "CITADEL_AGENTS_DIR: $AGENTS_DIR"
  echo "Purge data:         $PURGE"
  if [ "$REMOVE_SOURCE" = true ]; then
    [ -n "$RECORDED_SOURCE" ] && echo "Recorded source:    $RECORDED_SOURCE"
    [ -n "$SCRIPT_SOURCE" ] && echo "Script source:      $SCRIPT_SOURCE"
    echo "Source removal:     requested (would still require interactive confirmation)"
  else
    echo "Source removal:     no (source checkout is kept)"
  fi
  echo ""
  echo "Path validation passed. Planned actions:"
  echo "  - stop/disable ${SERVICE}.service and remove its systemd unit"
  echo "  - stop/remove the citadel-tunnel unit and ${TARGET_DIR}/data/tunnel-url"
  echo "  - restore system sleep policy if 24/7 mode was enabled"
  echo "  - remove sudoers rules and helper scripts"
  if [ "$PURGE" = true ]; then
    echo "  - delete ${TARGET_DIR} and ${AGENTS_DIR}, then remove user '$RUN_USER'"
  else
    echo "  - keep ${TARGET_DIR} (data/projects) and user '$RUN_USER'"
  fi
  echo "Dry run complete; nothing was changed."
  exit 0
fi

# --- from here on, effects are allowed --------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "ERROR: administrator privileges are required (run as root or with sudo)." >&2
    exit 1
  fi
fi

echo "=================================================="
echo "          Citadel — Uninstall                     "
echo "=================================================="
echo "Install directory: $TARGET_DIR"
echo "Agents directory:  $AGENTS_DIR"

if command -v systemctl >/dev/null 2>&1; then
  echo "Stopping and disabling ${SERVICE}.service..."
  $SUDO systemctl stop "$SERVICE" 2>/dev/null || true
  $SUDO systemctl disable "$SERVICE" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/${SERVICE}.service"
  $SUDO rm -rf "/etc/systemd/system/${SERVICE}.service.d"
  $SUDO systemctl daemon-reload 2>/dev/null || true
  $SUDO systemctl reset-failed "$SERVICE" 2>/dev/null || true

  echo "Stopping and removing the Cloudflare tunnel (if any)..."
  $SUDO systemctl stop citadel-tunnel 2>/dev/null || true
  $SUDO systemctl disable citadel-tunnel 2>/dev/null || true
  $SUDO rm -f /etc/systemd/system/citadel-tunnel.service
  $SUDO rm -f "$TARGET_DIR/data/tunnel-url" 2>/dev/null || true
  $SUDO systemctl daemon-reload 2>/dev/null || true
fi

POWER_DROPIN="${CITADEL_LOGIND_DROPIN_DIR:-/etc/systemd/logind.conf.d}/90-citadel-24-7.conf"
if [ -f "$POWER_DROPIN" ]; then
  echo "Restoring system sleep policy (24/7 mode)..."
  POWER_HELPER="${CITADEL_APP_DIR:-$TARGET_DIR/app}/scripts/power.sh"
  if [ -f "$POWER_HELPER" ] && command -v systemctl >/dev/null 2>&1; then
    $SUDO bash "$POWER_HELPER" off 2>/dev/null || true
  else
    $SUDO rm -f "$POWER_DROPIN" "$POWER_DROPIN.state"
    $SUDO rm -f /etc/systemd/system/{sleep,suspend,hibernate,hybrid-sleep}.target
    $SUDO systemctl daemon-reload 2>/dev/null || true
  fi
fi

echo "Removing sudoers rules..."
$SUDO rm -f /etc/sudoers.d/citadel-terminal /etc/sudoers.d/citadel-updater

echo "Removing helper scripts..."
$SUDO rm -f /usr/local/sbin/citadel-update /usr/local/sbin/.citadel-update.new
$SUDO rm -f /usr/local/bin/citadel-git-credential /usr/local/bin/citadel-creds
$SUDO rm -f /usr/local/bin/citadel
$SUDO rm -f /etc/profile.d/citadel-agents.sh

if command -v git >/dev/null 2>&1; then
  HELPER="$($SUDO git config --system --get credential.helper 2>/dev/null || true)"
  if [ "$HELPER" = "/usr/local/bin/citadel-git-credential" ]; then
    echo "Removing system git credential helper..."
    $SUDO git config --system --unset-all credential.helper 2>/dev/null || true
  fi
fi

if [ "$PURGE" = true ]; then
  echo "Deleting all data in $TARGET_DIR..."
  $SUDO rm -rf "$TARGET_DIR"
  # Shared CLI agents installed from the panel (opencode, claude, codex…).
  if [ -e "$AGENTS_DIR" ]; then
    echo "Removing shared CLI agents in $AGENTS_DIR..."
    $SUDO rm -rf "$AGENTS_DIR"
    # Only tidy the (now empty) parent when it is exactly the standard /opt/citadel.
    if [ "$(dirname "$AGENTS_DIR")" = "/opt/citadel" ]; then
      $SUDO rmdir /opt/citadel 2>/dev/null || true
    fi
  fi
  if id "$RUN_USER" >/dev/null 2>&1; then
    echo "Removing service user '$RUN_USER'..."
    $SUDO userdel -r "$RUN_USER" 2>/dev/null || $SUDO userdel "$RUN_USER" 2>/dev/null || true
  fi
  echo "Citadel and all its data have been removed from the system."
else
  echo "Citadel has been uninstalled from the system."
  echo "[INFO] Your projects and databases have been preserved in:"
  echo "       - $TARGET_DIR/data"
  echo "       - $TARGET_DIR/projects"
  echo "       - database snapshots in $TARGET_DIR/data/backups"
  echo "To remove everything (including the '$RUN_USER' user): $0"
fi

# Remove local source checkout(s) only on explicit opt-in AND interactive consent.
if [ "$REMOVE_SOURCE" = true ]; then
  echo "Source removal requested (--remove-source)."
  seen=""
  for dir in "$RECORDED_SOURCE" "$SCRIPT_SOURCE"; do
    [ -n "$dir" ] || continue
    case " $seen " in *" $dir "*) continue ;; esac
    seen="$seen $dir"
    if ! validate_checkout "source checkout" "$dir"; then
      continue
    fi
    if [ ! -t 0 ] || [ ! -t 1 ]; then
      echo "[WARN] Refusing to delete $dir: interactive confirmation requires a terminal. The source checkout is preserved." >&2
      continue
    fi
    printf 'Type "yes" to permanently delete the source checkout %s: ' "$dir"
    read -r answer
    if [ "$answer" = "yes" ]; then
      cd / 2>/dev/null || true
      echo "Removing local source checkout: $dir"
      $SUDO rm -rf "$dir" 2>/dev/null || true
    else
      echo "Preserved the source checkout: $dir"
    fi
  done
else
  [ -n "$RECORDED_SOURCE" ] && echo "[INFO] Local source checkout kept: $RECORDED_SOURCE"
  [ -n "$SCRIPT_SOURCE" ] && echo "[INFO] Local source checkout kept: $SCRIPT_SOURCE"
fi
