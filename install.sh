#!/usr/bin/env bash
#
# Install opencode-image-context into OpenCode.
#
# One self-contained bundle serves both runtimes. OpenCode 1 and OpenCode 2
# both discover local plugins from <config>/plugin/ and <config>/plugins/, and
# neither location nor config contents reliably reveal which version is
# installed. The bundle's default export carries both `server` (read by the V1
# loader) and `setup` (read by the V2 loader), so a single file works on either
# host and does not need version detection.
#
# Default target: <config>/plugins/opencode-image-context.js
#
# Detected binaries are still reported for information, and `--version` is only
# executed as a fallback (`--no-exec` disables it).
#
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SOURCE_DIR="${OPENCODE_IMAGE_CONTEXT_SOURCE:-$SCRIPT_DIR}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"

DO_BUILD=0
DO_UNINSTALL=0
DO_CHECK=0
DRY_RUN=0
NO_EXEC=0

PLUGIN_FILE="opencode-image-context.js"

# Legacy locations written by older versions of this installer.
LEGACY_FILES="\
$CONFIG_DIR/plugins/opencode-image-context.ts \
$CONFIG_DIR/plugin/opencode-image-context.js \
$CONFIG_DIR/plugin/opencode-image-context.ts"

log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --config DIR    OpenCode config dir (default: $XDG_CONFIG_HOME/opencode or ~/.config/opencode)
  --source DIR    project dir containing dist/ (default: this script's dir)
  --build         force a rebuild before installing
  --check         report detected OpenCode binaries and the install target, change nothing
  --uninstall     remove installed plugin files (current and legacy locations)
  --no-exec       never run the opencode binary; use install metadata only
  --dry-run       print what would happen, change nothing
  -h, --help      show this help

  --v1, --v2, --all   accepted for backwards compatibility; the same single
                      file is installed regardless (one file serves both hosts)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --v1|--v2|--all) : ;;   # dual-compatible: single file, nothing to branch on
    --uninstall) DO_UNINSTALL=1 ;;
    --check) DO_CHECK=1 ;;
    --config) shift; [ $# -gt 0 ] || die "--config needs a value"; CONFIG_DIR="$1" ;;
    --source) shift; [ $# -gt 0 ] || die "--source needs a value"; SOURCE_DIR="$1" ;;
    --build) DO_BUILD=1 ;;
    --no-exec) NO_EXEC=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# --- version parsing (informational only) ----------------------------------

# Version from install metadata only (no execution). Echoes "" if unknown.
version_from_meta() {
  _real=$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")
  case "$_real" in
    */Cellar/*)
      _rest=${_real#*/Cellar/}          # <formula>/<version>/...
      _rest=${_rest#*/}                 # <version>/...
      _ver=${_rest%%/*}
      case "$_ver" in [0-9]*) printf '%s' "$_ver"; return 0 ;; esac
      ;;
  esac
  _dir=$(dirname "$_real")
  for _d in "$_dir" "$_dir/.."; do
    if [ -f "$_d/package.json" ]; then
      _ver=$(grep -m1 '"version"' "$_d/package.json" 2>/dev/null \
             | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
      case "$_ver" in [0-9]*) printf '%s' "$_ver"; return 0 ;; esac
    fi
  done
  return 1
}

version_of() {
  _v=$(version_from_meta "$1" || true)
  if [ -z "$_v" ] && [ "$NO_EXEC" != 1 ]; then
    _out=$("$1" --version 2>/dev/null | head -n1 | tr -d '\r')
    _last=${_out##* }
    _last=${_last#v}
    case "$_last" in [0-9]*.[0-9]*) _v=$_last ;; esac
  fi
  printf '%s' "$_v"
}

resolve_bins() {
  for _c in opencode opencode2; do
    _p=$(command -v "$_c" 2>/dev/null || true)
    [ -n "$_p" ] && printf '%s\n' "$_p"
  done
  for _p in /usr/local/bin/opencode2 /usr/local/bin/opencode \
            /opt/homebrew/bin/opencode "$HOME/.local/bin/opencode" \
            "$HOME/.local/bin/opencode2"; do
    [ -x "$_p" ] && printf '%s\n' "$_p"
  done
}

report_bins() {
  _seen=""
  for _b in $(resolve_bins); do
    case " $_seen " in *" $_b "*) continue ;; esac
    _seen="$_seen $_b"
    _ver=$(version_of "$_b" || true)
    log "detected: $_b (${_ver:-unknown})"
  done
}

# --- actions ---------------------------------------------------------------

build() {
  [ -f "$SOURCE_DIR/package.json" ] || die "no package.json in $SOURCE_DIR"
  command -v bun >/dev/null 2>&1 || die "bun not found; install bun or build dist/ elsewhere"
  log "building in $SOURCE_DIR"
  [ "$DRY_RUN" = 1 ] || (cd "$SOURCE_DIR" && bun run build)
}

install_plugin() {
  _dist="$SOURCE_DIR/dist/index.js"
  [ -f "$_dist" ] || die "missing $_dist (run with --build or build the project first)"
  _dir="$CONFIG_DIR/plugins"
  _target="$_dir/$PLUGIN_FILE"
  log "install: $_target"
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$_dir"
  cp "$_dist" "$_target"
  for _legacy in $LEGACY_FILES; do
    [ "$_legacy" = "$_target" ] && continue
    [ -e "$_legacy" ] && { log "removing legacy $_legacy"; rm -f "$_legacy"; }
  done
}

uninstall() {
  for f in "$CONFIG_DIR/plugins/$PLUGIN_FILE" $LEGACY_FILES; do
    if [ -e "$f" ]; then
      log "removing $f"
      [ "$DRY_RUN" = 1 ] || rm -f "$f"
    fi
  done
}

# --- main ------------------------------------------------------------------

log "config dir: $CONFIG_DIR"
report_bins
[ -n "$(resolve_bins)" ] || warn "no OpenCode binary detected; installing anyway (single file works on either host)"

if [ "$DO_CHECK" = 1 ]; then
  log "target: $CONFIG_DIR/plugins/$PLUGIN_FILE"
  exit 0
fi

if [ "$DO_UNINSTALL" = 1 ]; then
  uninstall
  log "done."
  exit 0
fi

[ -d "$SOURCE_DIR" ] || die "source dir not found: $SOURCE_DIR"

if [ "$DO_BUILD" = 1 ] || [ ! -f "$SOURCE_DIR/dist/index.js" ]; then
  build
fi

install_plugin

log "done. Restart OpenCode for the plugin to load."
