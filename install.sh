#!/usr/bin/env bash
#
# Install opencode-image-context into OpenCode.
#
# Detects installed OpenCode binaries and their major version, then writes the
# matching adapter into the config directory:
#   V1 (opencode <2)  -> <config>/plugins/opencode-image-context.ts  (delegates to dist/v1.js)
#   V2 (opencode >=2) -> <config>/plugin/opencode-image-context.js   (bundled dist/v2.js)
#
# Version is read from install metadata whenever possible (Homebrew Cellar path,
# npm package.json) so the binary need not be executed. `--version` is only a
# last resort, and `--no-exec` disables it entirely.
#
# V1 auto-discovers <config>/plugins/*.ts; V2 auto-discovers <config>/plugin/*.js.
#
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SOURCE_DIR="${OPENCODE_IMAGE_CONTEXT_SOURCE:-$SCRIPT_DIR}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"

MODE="all"          # all | v1 | v2
DO_BUILD=0
DO_UNINSTALL=0
DRY_RUN=0
NO_EXEC=0

V1_FILE="opencode-image-context.ts"
V2_FILE="opencode-image-context.js"

log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --v1            install the V1 adapter only
  --v2            install the V2 adapter only
  --all           install for every detected runtime (default)
  --uninstall     remove installed plugin files
  --config DIR    OpenCode config dir (default: $XDG_CONFIG_HOME/opencode or ~/.config/opencode)
  --source DIR    project dir containing dist/ (default: this script's dir)
  --build         force a rebuild before installing
  --no-exec       never run the opencode binary; use install metadata only
  --dry-run       print what would happen, change nothing
  -h, --help      show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --v1) MODE="v1" ;;
    --v2) MODE="v2" ;;
    --all) MODE="all" ;;
    --uninstall) DO_UNINSTALL=1 ;;
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

# --- version parsing -------------------------------------------------------

# Major version from a version string, e.g. "1.18.34" -> 1, "v2.0.21" -> 2.
major_from_version() {
  _v=${1#v}
  case "$_v" in
    [0-9]*.[0-9]*) printf '%s' "${_v%%.*}" ;;
    *) printf '' ;;
  esac
}

# Version from install metadata only (no execution). Echoes "" if unknown.
# Reads the Homebrew Cellar path name, or a neighbouring package.json.
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

# Full version of a binary: metadata first, execution only if allowed.
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

# Locate OpenCode binaries: PATH first, then common install locations.
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

detect_v1() { for b in $(resolve_bins); do [ "$(major_from_version "$(version_of "$b")")" = "1" ] && { printf '%s' "$b"; return; }; done; }
detect_v2() { for b in $(resolve_bins); do m=$(major_from_version "$(version_of "$b")"); [ -n "$m" ] && [ "$m" -ge 2 ] 2>/dev/null && { printf '%s' "$b"; return; }; done; }

# --- actions ---------------------------------------------------------------

build() {
  [ -f "$SOURCE_DIR/package.json" ] || die "no package.json in $SOURCE_DIR"
  command -v bun >/dev/null 2>&1 || die "bun not found; install bun or build dist/ elsewhere"
  log "building in $SOURCE_DIR"
  [ "$DRY_RUN" = 1 ] || (cd "$SOURCE_DIR" && bun run build)
}

install_v1() {
  _dist="$SOURCE_DIR/dist/v1.js"
  [ -f "$_dist" ] || die "missing $_dist (run with --build or build the project first)"
  _dir="$CONFIG_DIR/plugins"
  _target="$_dir/$V1_FILE"
  log "v1 ($1): $_target -> $_dist"
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$_dir"
  cat > "$_target" <<EOF
import plugin from "$_dist";

export default plugin;
EOF
}

install_v2() {
  _dist="$SOURCE_DIR/dist/v2.js"
  [ -f "$_dist" ] || die "missing $_dist (run with --build or build the project first)"
  _dir="$CONFIG_DIR/plugin"
  _target="$_dir/$V2_FILE"
  log "v2 ($1): $_target"
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$_dir"
  cp "$_dist" "$_target"
}

uninstall() {
  for f in "$CONFIG_DIR/plugins/$V1_FILE" "$CONFIG_DIR/plugin/$V2_FILE"; do
    if [ -e "$f" ]; then
      log "removing $f"
      [ "$DRY_RUN" = 1 ] || rm -f "$f"
    fi
  done
}

# --- main ------------------------------------------------------------------

if [ "$DO_UNINSTALL" = 1 ]; then
  uninstall
  log "done."
  exit 0
fi

[ -d "$SOURCE_DIR" ] || die "source dir not found: $SOURCE_DIR"

v1_bin=$(detect_v1)
v2_bin=$(detect_v2)

want_v1=0
want_v2=0
case "$MODE" in
  v1) want_v1=1 ;;
  v2) want_v2=1 ;;
  all)
    [ -n "$v1_bin" ] && want_v1=1
    [ -n "$v2_bin" ] && want_v2=1
    if [ "$want_v1" = 0 ] && [ "$want_v2" = 0 ]; then
      warn "no OpenCode binary detected; defaulting to both V1 and V2"
      want_v1=1; want_v2=1
    fi
    ;;
esac

log "config dir: $CONFIG_DIR"
[ -n "$v1_bin" ] && log "detected V1: $v1_bin ($(version_of "$v1_bin"))" || true
[ -n "$v2_bin" ] && log "detected V2: $v2_bin ($(version_of "$v2_bin"))" || true
[ "$MODE" = v1 ] && [ -z "$v1_bin" ] && warn "no V1 binary found; installing V1 anyway"
[ "$MODE" = v2 ] && [ -z "$v2_bin" ] && warn "no V2 binary found; installing V2 anyway"

if [ "$DO_BUILD" = 1 ] || { [ "$want_v1" = 1 ] && [ ! -f "$SOURCE_DIR/dist/v1.js" ]; } || \
   { [ "$want_v2" = 1 ] && [ ! -f "$SOURCE_DIR/dist/v2.js" ]; }; then
  build
fi

[ "$want_v1" = 1 ] && install_v1 "${v1_bin:-not found}"
[ "$want_v2" = 1 ] && install_v2 "${v2_bin:-not found}"

log "done. Restart OpenCode for the plugin to load."
