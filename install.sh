#!/usr/bin/env bash
#
# Codeg Server installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/spacering-net/codeg/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/spacering-net/codeg/main/install.sh | bash -s -- --version v0.5.0
#

set -euo pipefail

REPO="spacering-net/codeg"
INSTALL_DIR="${CODEG_INSTALL_DIR:-/usr/local/bin}"
WEB_DIR="${CODEG_WEB_DIR:-/usr/local/share/codeg/web}"
VERSION=""
# Stale codeg-server / codeg-mcp binaries elsewhere in PATH are removed by
# default so the user's `codeg-server` command always runs the freshly
# installed binary AND the runtime locates the matching companion via the
# exe-sibling lookup. Set CODEG_NO_CLEANUP=1 (or pass --no-cleanup) to
# disable.
CLEANUP_CONFLICTS=1
if [ "${CODEG_NO_CLEANUP:-0}" = "1" ]; then
  CLEANUP_CONFLICTS=0
fi

# Names of binaries this installer manages. `codeg-server` is the user-facing
# entry point; `codeg-mcp` is the stdio MCP companion that the server's ACP
# layer spawns per session for delegation. Both must live in the same
# directory — `locate_codeg_mcp_binary()` in src-tauri/src/acp/connection.rs
# resolves the companion as a sibling of the running server executable.
MANAGED_BINS=(codeg-server codeg-mcp)
# Looked for on PATH as well: the two above, and `codeg-cli`, the command-line
# client the release ships beside them (older releases do not).
SCANNED_BINS=(codeg-server codeg-mcp codeg-cli)

# ── Parse arguments ──

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)    VERSION="$2"; shift 2 ;;
    --dir)        INSTALL_DIR="$2"; shift 2 ;;
    --no-cleanup) CLEANUP_CONFLICTS=0; shift ;;
    --help)
      echo "Usage: install.sh [--version VERSION] [--dir INSTALL_DIR] [--no-cleanup]"
      echo ""
      echo "Options:"
      echo "  --version     Version to install (e.g. v0.5.0). Default: latest"
      echo "  --dir         Installation directory. Default: /usr/local/bin"
      echo "  --no-cleanup  Keep stale codeg-server binaries found elsewhere in PATH"
      echo "                (default: remove them so the new install is what runs)"
      echo ""
      echo "Environment:"
      echo "  CODEG_INSTALL_DIR  Same as --dir"
      echo "  CODEG_NO_CLEANUP   Set to 1 to behave like --no-cleanup"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Detect platform ──

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)      echo "Error: unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_SUFFIX="x64" ;;
  aarch64|arm64)  ARCH_SUFFIX="arm64" ;;
  *)              echo "Error: unsupported architecture: $ARCH"; exit 1 ;;
esac

ARTIFACT="codeg-server-${PLATFORM}-${ARCH_SUFFIX}"

# ── Resolve version ──

if [ -z "$VERSION" ]; then
  echo "Fetching latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  if [ -z "$VERSION" ]; then
    echo "Error: could not determine latest version"
    exit 1
  fi
fi

# ── Helpers ──

# Canonicalize a path (resolve symlinks). Falls back to the input if no tool available.
canon_path() {
  local p="$1"
  [ -z "$p" ] && return 0
  if command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1; then
    readlink -f "$p" 2>/dev/null || echo "$p"
  elif command -v realpath >/dev/null 2>&1; then
    realpath "$p" 2>/dev/null || echo "$p"
  else
    echo "$p"
  fi
}

# Read the version of a codeg-server binary (with a 3s timeout for old binaries
# that lack --version support and would otherwise start the full server).
read_bin_version() {
  local bin="$1"
  [ -x "$bin" ] || return 0
  local tmp pid guard
  tmp=$(mktemp)
  "$bin" --version > "$tmp" 2>/dev/null &
  pid=$!
  ( sleep 3 && kill "$pid" 2>/dev/null ) &
  guard=$!
  wait "$pid" 2>/dev/null || true
  kill "$guard" 2>/dev/null || true
  wait "$guard" 2>/dev/null || true
  head -1 "$tmp" 2>/dev/null | tr -d '[:space:]'
  rm -f "$tmp"
}

# ── Privilege model ──
#
# Root can write anywhere and must NEVER call `sudo`: minimal root environments
# (containers, slim images) frequently don't ship sudo, and a blind `sudo mkdir`
# there aborts the whole script under `set -e` AFTER the binaries already landed
# — leaving a half-installed tree the version short-circuit then refuses to
# repair. A non-root user needs sudo only when the destination's nearest
# existing ancestor isn't writable.

PRIV=""
IS_ROOT=0
# Conservative default: if `id -u` somehow fails, assume NON-root (echo 1) so we
# fall back to writability-probing + sudo rather than wrongly skipping elevation.
# This is still correct for a real root whose `id` broke: `[ -w ]` on existing
# system dirs is true for root, so resolve_priv runs directly anyway.
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  IS_ROOT=1
fi

HAVE_SUDO=0
if command -v sudo >/dev/null 2>&1; then
  HAVE_SUDO=1
fi

# Walk up from $1 to the first ancestor that already exists, so writability can
# be tested for a not-yet-created path (e.g. /usr/local/share/codeg/web, whose
# parent /usr/local/share/codeg also doesn't exist on a fresh install).
nearest_existing_ancestor() {
  local p="$1"
  while [ -n "$p" ] && [ "$p" != "/" ] && [ ! -e "$p" ]; do
    p="$(dirname "$p")"
  done
  echo "$p"
}

# Decide how to create/write into directory $1. Sets global PRIV to "" (run
# directly) or "sudo". Returns non-zero — without aborting under `set -e`, since
# callers invoke it via `if` — when elevation is required but sudo is absent.
resolve_priv() {
  PRIV=""
  [ "$IS_ROOT" -eq 1 ] && return 0
  local anchor
  anchor="$(nearest_existing_ancestor "$1")"
  [ -w "$anchor" ] && return 0
  if [ "$HAVE_SUDO" -eq 1 ]; then
    PRIV="sudo"
    return 0
  fi
  return 1
}

# Whether $1 belongs to the codeg desktop app: installed by its deb/rpm package,
# or inside a codeg.app bundle (a symlink the user made into one counts, by the
# file it resolves to). Such a file is never removed or overwritten here, only
# reported: the desktop's `codeg-mcp` and `codeg-cli` are its own, and
# deleting them would break the desktop app — `/usr/bin/codeg-mcp` from the deb
# included, which an install dir later on PATH than /usr/bin used to remove.
is_desktop_file() {
  local real
  real="$(canon_path "$1")"
  case "$real" in
    */codeg.app/Contents/MacOS/*) return 0 ;;
  esac
  if command -v dpkg >/dev/null 2>&1 && dpkg -S "$real" >/dev/null 2>&1; then
    return 0
  fi
  if command -v rpm >/dev/null 2>&1 && rpm -qf "$real" >/dev/null 2>&1; then
    return 0
  fi
  # What the desktop app writes for its own terminals and agents, in
  # `<data dir>/cli/bin/` — first on PATH in a codeg terminal: a shim with its
  # marker as the second line, or an AppImage's copy, told by the SHA-256 the
  # app recorded beside it.
  if [ "$(sed -n '2{p;q;}' "$real" 2>/dev/null)" = "$DESKTOP_SHIM_MARKER" ]; then
    return 0
  fi
  local record
  record="$(dirname "$real")/.codeg-cli.sha256"
  if [ -f "$record" ] && [ -n "$(file_sha256 "$real")" ] \
    && [ "$(file_sha256 "$real")" = "$(cat "$record" 2>/dev/null)" ]; then
    return 0
  fi
  return 1
}

# The second line of the shims the desktop app writes (`cli_run::shim`).
DESKTOP_SHIM_MARKER="# codeg-cli shim, written by Codeg at every start: changes are lost"

# The SHA-256 of a file, in hex; empty when there is no tool for it.
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  fi
}

# Run "$@", elevating with sudo only when the last resolve_priv call decided so.
priv_run() {
  if [ -n "$PRIV" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

# ── Scan PATH for codeg-server binaries that shadow the target install ──
#
# A binary "shadows" the install only if it appears in PATH BEFORE the
# destination directory: that's the binary `command -v codeg-server` would
# return after install. Walk PATH and stop at the destination directory —
# anything past it cannot affect resolution today, so we leave it alone.

DEST_BIN="${INSTALL_DIR}/codeg-server"
DEST_BIN_REAL="$(canon_path "$DEST_BIN")"
INSTALL_DIR_REAL="$(canon_path "$INSTALL_DIR")"

# Scan PATH for both managed binaries — a stale `codeg-mcp` in an earlier
# PATH entry would be picked by the runtime's `which` fallback once
# `codeg-server` was upgraded out from under it, breaking delegation in
# subtle ways. Track conflicts uniformly for cleanup.
PATH_CONFLICTS=()
# Shadowing files that belong to the desktop app: reported, never removed.
DESKTOP_SHADOWS=()
DEST_IN_PATH=0
_SEEN_REAL=":"
IFS=':' read -ra _PATH_DIRS <<< "${PATH:-}"
for _dir in "${_PATH_DIRS[@]}"; do
  [ -z "$_dir" ] && continue
  # Match by canonical path string so the destination is recognized even when
  # the directory doesn't exist yet (e.g. first install into a fresh prefix).
  if [ "$(canon_path "$_dir")" = "$INSTALL_DIR_REAL" ]; then
    DEST_IN_PATH=1
    break
  fi
  for _name in "${SCANNED_BINS[@]}"; do
    _bin="$_dir/$_name"
    if [ -f "$_bin" ] && [ -x "$_bin" ]; then
      _real="$(canon_path "$_bin")"
      case "$_SEEN_REAL" in
        *":$_real:"*) continue ;;
      esac
      _SEEN_REAL="${_SEEN_REAL}${_real}:"
      if is_desktop_file "$_bin"; then
        DESKTOP_SHADOWS+=("$_bin")
      else
        PATH_CONFLICTS+=("$_bin")
      fi
    fi
  done
done

# If the destination directory isn't on PATH, nothing "shadows" the install —
# the new binary just won't be reachable as `codeg-server`. Drop any collected
# entries; the post-install check will tell the user to fix PATH instead.
if [ "$DEST_IN_PATH" -eq 0 ]; then
  PATH_CONFLICTS=()
  DESKTOP_SHADOWS=()
fi

# What does `codeg-server` actually resolve to right now in PATH?
ACTIVE_BIN=""
if command -v codeg-server >/dev/null 2>&1; then
  ACTIVE_BIN="$(command -v codeg-server)"
fi

# ── Version detection — prefer the binary the user actually invokes ──

VERSION_CHECK_BIN=""
if [ -n "$ACTIVE_BIN" ] && [ -x "$ACTIVE_BIN" ]; then
  VERSION_CHECK_BIN="$ACTIVE_BIN"
elif [ -x "$DEST_BIN" ]; then
  VERSION_CHECK_BIN="$DEST_BIN"
fi

CURRENT_VERSION=""
if [ -n "$VERSION_CHECK_BIN" ]; then
  CURRENT_VERSION="$(read_bin_version "$VERSION_CHECK_BIN")"
fi

# Normalize: strip leading "v" for comparison
TARGET_VER="${VERSION#v}"

# Only short-circuit when the active binary is up to date AND the destination
# has it AND no other PATH entries shadow it AND the web assets are present.
# The web-asset check makes the installer self-healing: a prior run that placed
# the binary but failed before copying web/ (the classic root-without-sudo
# case) is repaired on re-run instead of exiting "nothing to do" forever.
if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$TARGET_VER" ] \
   && [ "${#PATH_CONFLICTS[@]}" -eq 0 ] \
   && [ -x "$DEST_BIN" ] \
   && [ -f "${WEB_DIR}/index.html" ]; then
  echo "codeg-server is already at version ${TARGET_VER} with web assets in place, nothing to do."
  exit 0
fi

if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$TARGET_VER" ]; then
  echo "codeg-server is already at ${TARGET_VER}; reinstalling to repair the existing install..."
elif [ -n "$CURRENT_VERSION" ]; then
  echo "Upgrading codeg-server: ${CURRENT_VERSION} -> ${TARGET_VER}..."
else
  echo "Installing codeg-server ${VERSION} (${PLATFORM}/${ARCH_SUFFIX})..."
fi

# ── Warn about codeg-server binaries shadowing the target install ──

if [ "${#PATH_CONFLICTS[@]}" -gt 0 ]; then
  echo ""
  echo "Found other codeg-server binaries in PATH that may shadow ${DEST_BIN}:"
  for _c in "${PATH_CONFLICTS[@]}"; do
    if [ "$(basename "$_c")" = "codeg-cli" ]; then
      # Only removed if this release ships a codeg-cli (known once extracted).
      echo "  - $_c  (removed if this release includes codeg-cli)"
      continue
    fi
    _cv="$(read_bin_version "$_c" 2>/dev/null || true)"
    if [ -n "$_cv" ]; then
      echo "  - $_c  (version ${_cv})"
    else
      echo "  - $_c"
    fi
  done
  if [ "$CLEANUP_CONFLICTS" = "1" ]; then
    echo "These will be removed after installation. Pass --no-cleanup to keep them."
  else
    echo "Keeping them (--no-cleanup). You may need to remove them manually so that"
    echo "typing 'codeg-server' runs the new install at ${DEST_BIN}."
  fi
  echo ""
fi

# ── Stop what runs from the files this install replaces ──
#
# On Linux `cp` onto a running executable fails (text file busy); on macOS
# it goes through, under a process that goes on running the old program. So
# what runs ${INSTALL_DIR}'s codeg-server or codeg-mcp stops first, and with
# cleanup on, what runs a stale copy removed below. Only that: the desktop
# app runs a codeg-mcp of its own, and other users, other directories and
# containers have theirs. A process is told by the file it runs — on Linux
# whatever it is called — and one named like such a file that this user
# cannot look into (another user's, unless this is root) is left alone, and
# named. A codeg-cli is never stopped: a run in progress is the user's.

SELF_MNT_NS=""
if [ "$PLATFORM" = "linux" ]; then
  SELF_MNT_NS="$(readlink /proc/self/ns/mnt 2>/dev/null || true)"
fi

# The files to look for, for the program named $1: the install's own and,
# with cleanup on, the stale copies removed below — but not a symlink, whose
# removal changes no running program. STOP_PATHS has them as a process
# started from one reports it: absolute, every symlink resolved (`cp` writes
# through one). STOP_FILES: those that exist. STOP_NAMES: what a process
# started from one is called.
stop_targets() {
  local f c
  local -a found
  found=("${INSTALL_DIR}/$1")
  if [ "$CLEANUP_CONFLICTS" = "1" ]; then
    for c in ${PATH_CONFLICTS[@]+"${PATH_CONFLICTS[@]}"}; do
      if [ "$(basename "$c")" = "$1" ] && [ ! -L "$c" ]; then
        found+=("$c")
      fi
    done
  fi
  STOP_PATHS=()
  STOP_FILES=()
  STOP_NAMES=("$1")
  for f in "${found[@]}"; do
    case "$f" in
      /*) ;;
      *) f="$PWD/$f" ;;
    esac
    if [ -e "$f" ]; then
      f="$(canon_path "$f")"
      STOP_FILES+=("$f")
    else
      f="$(canon_path "$(dirname "$f")")/$(basename "$f")"
    fi
    STOP_PATHS+=("$f")
    STOP_NAMES+=("$(basename "$f")")
  done
}

# Whether $1, a process's name as Linux keeps it (its first 15 bytes), is
# one of STOP_NAMES.
is_stop_name() {
  local n
  for n in "${STOP_NAMES[@]}"; do
    if [ "$1" = "${n:0:15}" ]; then return 0; fi
  done
  return 1
}

# Sort processes into MATCHED, those that run one of STOP_PATHS, and UNSEEN,
# those named like one that this user cannot look into. A zombie runs
# nothing, and is neither.
sort_processes() {
  local dir pid comm exe f line state names
  MATCHED=""
  UNSEEN=""
  if [ "$PLATFORM" = "linux" ]; then
    for dir in /proc/[0-9]*; do
      pid="${dir#/proc/}"
      # The very file, wherever the process sees it (`-ef`: the same device
      # and inode) — from another mount namespace too.
      for f in ${STOP_FILES[@]+"${STOP_FILES[@]}"}; do
        if [ "$dir/exe" -ef "$f" ]; then
          MATCHED="${MATCHED} ${pid}"
          continue 2
        fi
      done
      # Or started from one of the paths, maybe deleted since — of this
      # filesystem: a container's process reports a path of its own.
      { read -r comm < "$dir/comm"; } 2>/dev/null || continue
      is_stop_name "$comm" || continue
      if ! exe="$(readlink "$dir/exe" 2>/dev/null)"; then
        { read -r line < "$dir/stat"; } 2>/dev/null || continue
        state="${line##*) }"
        [ "${state%% *}" = "Z" ] || UNSEEN="${UNSEEN} ${pid}"
        continue
      fi
      [ "$(readlink "$dir/ns/mnt" 2>/dev/null || true)" = "$SELF_MNT_NS" ] || continue
      exe="${exe% (deleted)}"
      for f in "${STOP_PATHS[@]}"; do
        if [ "$exe" = "$f" ]; then
          MATCHED="${MATCHED} ${pid}"
          continue 2
        fi
      done
    done
    return 0
  fi
  # macOS: lsof names the files a process maps — the one it runs, by the
  # path it was started from (even once that is deleted), but also any it
  # merely reads that way — and none for a process it cannot look into.
  # No stock tool tells the one it runs apart (`ps` shows its argv[0]), so
  # a process is picked by its name first, which macOS keeps to 16 bytes:
  # one named like a target that only maps one is taken for it.
  for f in "${STOP_NAMES[@]}"; do
    for pid in $(pgrep -x "${f:0:16}" 2>/dev/null || true); do
      case "${MATCHED} ${UNSEEN} " in
        *" ${pid} "*) continue ;;
      esac
      names="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null || true)"
      if [ -z "$names" ]; then
        state="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
        case "$state" in
          "" | *Z*) ;;
          *) UNSEEN="${UNSEEN} ${pid}" ;;
        esac
        continue
      fi
      while IFS= read -r line; do
        case "$line" in
          n*)
            for exe in "${STOP_PATHS[@]}"; do
              if [ "${line#n}" = "$exe" ]; then
                MATCHED="${MATCHED} ${pid}"
                break 2
              fi
            done
            ;;
        esac
      done <<< "$names"
    done
  done
}

# Stop what runs the files found for the program named $1: asked to end,
# then made to after $2 seconds. Picked again before every signal, never
# carried over: a pid is free for another process once its own has ended.
# STOPPED_ANY says whether one ended. Returns 1 when there was none, 2 when
# one is still running.
stop_processes() {
  local name="$1" grace="$2" pid first
  STOPPED_ANY=0
  stop_targets "$name"
  sort_processes
  if [ -n "$UNSEEN" ]; then
    echo "Left running: ${name} (pid${UNSEEN}), which this user cannot look into."
    echo "  If one of them runs from ${INSTALL_DIR}, stop it and run this again."
  fi
  [ -n "$MATCHED" ] || return 1
  first="$MATCHED"
  echo "Stopping ${name} (pid${MATCHED})..."
  # shellcheck disable=SC2086 # one word per pid
  kill $MATCHED 2>/dev/null || true
  for _ in $(seq 1 "$grace"); do
    sleep 1
    sort_processes
    [ -n "$MATCHED" ] || break
  done
  if [ -n "$MATCHED" ]; then
    echo "Force stopping ${name} (pid${MATCHED})..."
    # shellcheck disable=SC2086 # one word per pid
    kill -9 $MATCHED 2>/dev/null || true
    sleep 1
    sort_processes
  fi
  for pid in $first; do
    case "$MATCHED " in
      *" ${pid} "*) ;;
      *) STOPPED_ANY=1 ;;
    esac
  done
  if [ -n "$MATCHED" ]; then
    echo "Warning: ${name} is still running (pid${MATCHED})."
    return 2
  fi
  echo "${name} stopped."
}

stop_processes codeg-server 10 || true
# Whether a codeg-server stopped, for the note at the end.
SERVER_STOPPED="$STOPPED_ANY"
# Companions are short-lived: a brief moment to end on SIGTERM.
stop_processes codeg-mcp 3 || true

# ── Download and extract ──

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}.tar.gz"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${DOWNLOAD_URL}..."
if ! curl -fSL --progress-bar -o "${TMP_DIR}/${ARTIFACT}.tar.gz" "$DOWNLOAD_URL"; then
  echo "Error: download failed. Check that version ${VERSION} exists and has a ${ARTIFACT} asset."
  exit 1
fi

echo "Extracting..."
tar xzf "${TMP_DIR}/${ARTIFACT}.tar.gz" -C "$TMP_DIR"

# ── Install binaries ──
#
# Verify both binaries are present in the archive BEFORE writing anything
# to INSTALL_DIR. Without the companion, delegation degrades silently on
# every new ACP session — fail fast instead.

for _name in "${MANAGED_BINS[@]}"; do
  if [ ! -f "${TMP_DIR}/${ARTIFACT}/${_name}" ]; then
    echo "Error: ${_name} not found in archive ${ARTIFACT}.tar.gz"
    echo "       This release tarball is incomplete; please report it."
    exit 1
  fi
done

# Resolve how to write into INSTALL_DIR, then create it and drop the binaries.
# Root writes directly; a non-root user uses sudo only when the prefix isn't
# already writable. Bail out clearly if elevation is needed but sudo is absent,
# instead of crashing mid-install under `set -e`.
if ! resolve_priv "$INSTALL_DIR"; then
  echo "Error: need elevated privileges to install to ${INSTALL_DIR}, but 'sudo' is not installed."
  echo "       Re-run as root, install sudo, or set CODEG_INSTALL_DIR/CODEG_WEB_DIR to writable"
  echo "       paths (e.g. \$HOME/.local/bin and \$HOME/.local/share/codeg/web)."
  exit 1
fi
if [ -n "$PRIV" ]; then
  echo "Need sudo to install to ${INSTALL_DIR}"
fi

priv_run mkdir -p "$INSTALL_DIR"
_install_one() {
  local name="$1"
  local src="${TMP_DIR}/${ARTIFACT}/${name}"
  local dst="${INSTALL_DIR}/${name}"
  priv_run cp "$src" "$dst"
  priv_run chmod +x "$dst"
}
for _name in "${MANAGED_BINS[@]}"; do
  _install_one "$_name"
done
# codeg-computer-helper: computer use, which codeg-server offers only when
# started with CODEG_COMPUTER_USE=1 in a desktop session. Installed when the
# release ships it (older ones do not). It exits with the codeg-server that
# started it, but may still be on its way out — and `cp` onto a running
# executable fails (text file busy) — so a copy is renamed over it instead:
# the one still running keeps its old file to the end.
if [ -f "${TMP_DIR}/${ARTIFACT}/codeg-computer-helper" ]; then
  _helper_staged="${INSTALL_DIR}/.codeg-computer-helper.new"
  priv_run cp "${TMP_DIR}/${ARTIFACT}/codeg-computer-helper" "$_helper_staged"
  priv_run chmod +x "$_helper_staged"
  priv_run mv -f "$_helper_staged" "${INSTALL_DIR}/codeg-computer-helper"
fi
# codeg-cli: the command-line client (`codeg-cli run …`), installed when the
# release ships it. Renamed over the target like the helper: a CLI still
# running keeps its file (no `text file busy`), and a symlink at the target is
# replaced rather than written through — `cp` onto the link a desktop user
# made into `codeg.app` would overwrite the app's own binary. A target that IS
# the desktop app's (that link, or the deb's) is left alone: it is the same
# program, and the user chose it.
CLI_DST="${INSTALL_DIR}/codeg-cli"
CLI_STATUS="absent"
if [ -f "${TMP_DIR}/${ARTIFACT}/codeg-cli" ]; then
  if [ -e "$CLI_DST" ] && is_desktop_file "$CLI_DST"; then
    CLI_STATUS="desktop"
  else
    _cli_staged="${INSTALL_DIR}/.codeg-cli.new"
    priv_run cp "${TMP_DIR}/${ARTIFACT}/codeg-cli" "$_cli_staged"
    priv_run chmod +x "$_cli_staged"
    priv_run mv -f "$_cli_staged" "$CLI_DST"
    CLI_STATUS="installed"
  fi
elif [ -e "$CLI_DST" ] && ! is_desktop_file "$CLI_DST"; then
  # A release without it (a downgrade): the CLI a newer install left would
  # talk to an older server.
  priv_run rm -f "$CLI_DST"
  CLI_STATUS="removed"
fi

# Re-canonicalize destination now that the file exists. Pre-install canon may
# leave the final non-existent component unresolved (notably macOS readlink -f),
# which would mis-compare against the post-install `command -v` result.
DEST_BIN_REAL="$(canon_path "$DEST_BIN")"

# ── Install web assets ──

WEB_SRC="${TMP_DIR}/${ARTIFACT}/web"

if [ -d "$WEB_SRC" ]; then
  echo "Installing web assets to ${WEB_DIR}..."
  if ! resolve_priv "$WEB_DIR"; then
    echo "Error: need elevated privileges to write ${WEB_DIR}, but 'sudo' is not installed."
    echo "       Re-run as root, install sudo, or set CODEG_WEB_DIR to a writable path."
    exit 1
  fi
  priv_run mkdir -p "$WEB_DIR"
  priv_run cp -r "$WEB_SRC"/* "$WEB_DIR"/
fi

# ── Remove shadowing binaries from earlier PATH entries ──

EXIT_STATUS=0

# Without a codeg-cli in this release there is nothing a stale one shadows.
if [ "$CLI_STATUS" != "installed" ]; then
  _kept=()
  for _c in ${PATH_CONFLICTS[@]+"${PATH_CONFLICTS[@]}"}; do
    [ "$(basename "$_c")" = "codeg-cli" ] || _kept+=("$_c")
  done
  PATH_CONFLICTS=(${_kept[@]+"${_kept[@]}"})
fi

if [ "${#PATH_CONFLICTS[@]}" -gt 0 ] && [ "$CLEANUP_CONFLICTS" = "1" ]; then
  echo ""
  echo "Removing stale codeg-server binaries..."
  for _c in "${PATH_CONFLICTS[@]}"; do
    _parent="$(dirname "$_c")"
    _rm_ok=0
    if [ -w "$_parent" ] && { [ ! -e "$_c" ] || [ -w "$_c" ]; }; then
      if rm -f "$_c" 2>/dev/null; then _rm_ok=1; fi
    else
      if sudo rm -f "$_c" 2>/dev/null; then _rm_ok=1; fi
    fi
    if [ "$_rm_ok" -eq 1 ]; then
      echo "  removed $_c"
    else
      echo "  failed to remove $_c (remove it manually so 'codeg-server' resolves to the new install)"
      EXIT_STATUS=1
    fi
  done
fi

if [ "${#DESKTOP_SHADOWS[@]}" -gt 0 ]; then
  echo ""
  echo "Kept (they belong to the codeg desktop app, and come before ${INSTALL_DIR} on PATH):"
  for _c in "${DESKTOP_SHADOWS[@]}"; do
    echo "  $_c  — typing '$(basename "$_c")' runs this one"
  done
fi

# ── Restart service if it was running ──

if [ "$SERVER_STOPPED" -eq 1 ]; then
  echo ""
  echo "Note: codeg-server was stopped for the upgrade."
  echo "Please restart it manually to ensure your environment variables (CODEG_PORT, CODEG_TOKEN, etc.) are preserved:"
  echo "  CODEG_STATIC_DIR=${WEB_DIR} codeg-server"
fi

# ── Done ──

echo ""
echo "codeg-server installed to ${INSTALL_DIR}/codeg-server"
echo "codeg-mcp    installed to ${INSTALL_DIR}/codeg-mcp"
case "$CLI_STATUS" in
  installed) echo "codeg-cli    installed to ${CLI_DST}" ;;
  desktop) echo "codeg-cli    kept: ${CLI_DST} is the codeg desktop app's (the same program; remove it first to use this release's)" ;;
  removed) echo "codeg-cli    removed: this release has none" ;;
esac
INSTALLED_VER=$("${INSTALL_DIR}/codeg-server" --version 2>/dev/null || echo "${TARGET_VER}")
echo "Version: ${INSTALLED_VER}"

# Final smoke: codeg-mcp must exist next to codeg-server so the runtime's
# `locate_codeg_mcp_binary()` exe-sibling lookup hits. A failure here means
# the tarball was malformed or a previous `_install_one` was silently
# blocked — surface it loudly rather than ship a half-broken install.
if [ ! -x "${INSTALL_DIR}/codeg-mcp" ]; then
  echo ""
  echo "Error: ${INSTALL_DIR}/codeg-mcp missing or not executable after install."
  echo "       Delegation (sub-agent tooling) will not work. Re-run the installer."
  EXIT_STATUS=1
fi

# Verify the user's `codeg-server` command actually resolves to the new binary.
ACTIVE_BIN_AFTER=""
if command -v codeg-server >/dev/null 2>&1; then
  ACTIVE_BIN_AFTER="$(command -v codeg-server)"
fi
ACTIVE_BIN_AFTER_REAL="$(canon_path "$ACTIVE_BIN_AFTER")"

if [ -z "$ACTIVE_BIN_AFTER" ]; then
  echo ""
  echo "Note: ${INSTALL_DIR} is not on your PATH. Add it so 'codeg-server' resolves directly:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  EXIT_STATUS=1
elif [ "$ACTIVE_BIN_AFTER_REAL" != "$DEST_BIN_REAL" ]; then
  echo ""
  echo "Warning: typing 'codeg-server' still runs ${ACTIVE_BIN_AFTER}, not ${DEST_BIN}."
  echo "Another binary earlier in PATH is shadowing the new install. To fix, either:"
  echo "  - re-run without --no-cleanup (the default removes shadowing binaries), or"
  echo "  - remove the stale binary manually: rm '${ACTIVE_BIN_AFTER}', or"
  echo "  - put ${INSTALL_DIR} before its directory in PATH."
  EXIT_STATUS=1
else
  # Same path: a previous shell session may have cached the old inode.
  echo ""
  echo "Tip: if you ran codeg-server earlier in this shell, run 'hash -r' (bash/zsh) to clear the path cache."
fi

echo ""
echo "Quick start:"
echo "  CODEG_STATIC_DIR=${WEB_DIR} codeg-server"
echo ""
echo "Or with custom settings:"
echo "  CODEG_PORT=3080 CODEG_TOKEN=your-secret CODEG_STATIC_DIR=${WEB_DIR} codeg-server"
echo ""
echo "The auth token is printed to stderr on startup if not set via CODEG_TOKEN."

exit "$EXIT_STATUS"
