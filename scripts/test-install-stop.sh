#!/usr/bin/env bash
#
# What install.sh stops before it replaces its files: the processes that run
# them, told by file and not by name, and nothing else. This runs the
# script's own stop section against fake programs in a temporary directory —
# never the installer itself, which downloads a release and writes to
# /usr/local/bin — and refuses, as a failure, any signal it sends to a
# process this test did not start.
#
# Usage: scripts/test-install-stop.sh [path/to/install.sh]
#
# Needs a C compiler (`cc`, or $CC). On Linux it also starts processes in
# mount namespaces of their own (as root, or through an unprivileged user
# namespace); with passwordless sudo, when not root, one of root's. Those are
# skipped where they cannot be had, unless CODEG_INSTALL_TEST_STRICT=1: then
# a root run must have the namespaces, and a run that is not root must have
# root's process.

set -euo pipefail

INSTALL_SH="${1:-$(dirname "$0")/../install.sh}"
STRICT="${CODEG_INSTALL_TEST_STRICT:-0}"
case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
IS_ROOT=0
if [ "$(id -u)" = "0" ]; then IS_ROOT=1; fi

_tmp="${TMPDIR:-/tmp}"
T="$(mktemp -d "${_tmp%/}/codeg-install-stop.XXXXXX")"
# The pids of the processes this test started, one per line: of this user,
# and of root.
STARTED="$T/started"
ROOT_STARTED="$T/root-started"
# The pids the section tried to signal that this test did not start.
GUARD="$T/refused"
: > "$STARTED"
: > "$ROOT_STARTED"
: > "$GUARD"
cleanup() {
  local pid
  while read -r pid; do kill -9 "$pid" 2>/dev/null || true; done < "$STARTED"
  while read -r pid; do sudo -n kill -9 "$pid" 2>/dev/null || true; done < "$ROOT_STARTED"
  rm -rf "$T"
}
trap cleanup EXIT

FAILED=0
CHECKS=0
fail() {
  echo "FAIL: $*" >&2
  FAILED=1
}
skip() {
  if [ "$STRICT" = "1" ]; then
    fail "$* (CODEG_INSTALL_TEST_STRICT=1)"
  else
    echo "SKIP: $*"
  fi
}

# ── From install.sh: MANAGED_BINS, canon_path, and the stop section ──

CANON_AT="$(grep -n -m1 '^canon_path() {' "$INSTALL_SH" | cut -d: -f1)"
STOP_AT="$(grep -n -m1 -F '# ── Stop ' "$INSTALL_SH" | cut -d: -f1)"
NEXT_AT="$(grep -n -m1 -F '# ── Download and extract ──' "$INSTALL_SH" | cut -d: -f1)"
if [ -z "$CANON_AT" ] || [ -z "$STOP_AT" ] || [ -z "$NEXT_AT" ] || [ "$STOP_AT" -ge "$NEXT_AT" ]; then
  echo "$INSTALL_SH: canon_path, or the stop section before the download, not found" >&2
  exit 1
fi
grep '^MANAGED_BINS=' "$INSTALL_SH" > "$T/managed.sh"
awk -v s="$CANON_AT" 'NR >= s { print; if ($0 == "}") exit }' "$INSTALL_SH" > "$T/canon.sh"
sed -n "${STOP_AT},$((NEXT_AT - 1))p" "$INSTALL_SH" > "$T/section.sh"

# The section runs in a bash of its own, as install.sh runs it: under
# `set -euo pipefail`, which a caller's `if` or `||` would otherwise switch
# off inside it. Every signal it sends comes through its `kill`, which a
# function by that name stands in for.
cat > "$T/driver.sh" <<'EOF'
# $1: INSTALL_DIR; $2: cleanup, 1 or 0; the rest: the stale copies on PATH.
set -euo pipefail
INSTALL_DIR="$1"
CLEANUP_CONFLICTS="$2"
shift 2
PATH_CONFLICTS=("$@")
kill() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -*) ;;
      *)
        if ! grep -qxF "$arg" "$STARTED"; then
          echo "$arg" >> "$GUARD"
          return 1
        fi
        ;;
    esac
  done
  builtin kill "$@"
}
. "$T/managed.sh"
. "$T/canon.sh"
. "$T/section.sh"
echo "SERVER_STOPPED=$SERVER_STOPPED"
EOF

# Run the stop section with these arguments (see the driver); what it prints
# goes to $T/out.
run_section() {
  env T="$T" STARTED="$STARTED" GUARD="$GUARD" PLATFORM="$PLATFORM" \
    "$BASH" "$T/driver.sh" "$@" > "$T/out" 2>&1
}

# ── Fake programs ──

cat > "$T/fake.c" <<'EOF'
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
/* Waits for a signal to end it; with --ignore-term, SIGTERM does not; with
   --map FILE, it first maps FILE, as a program that reads one might. Then
   makes the file $FAKE_READY names, if any: until then a signal may still
   find it as it starts. */
int main(int argc, char **argv) {
  const char *ready = getenv("FAKE_READY");
  if (argc > 1 && strcmp(argv[1], "--ignore-term") == 0) signal(SIGTERM, SIG_IGN);
  if (argc > 2 && strcmp(argv[1], "--map") == 0) {
    struct stat st;
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0 || fstat(fd, &st) != 0
        || mmap(0, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0) == MAP_FAILED)
      return 1;
  }
  if (ready) close(open(ready, O_WRONLY | O_CREAT, 0644));
  for (;;) pause();
}
EOF
"${CC:-cc}" -o "$T/fake" "$T/fake.c"

mkdir -p "$T/install" "$T/other" "$T/stale" "$T/elsewhere" "$T/stale-link" \
  "$T/releases" "$T/install2" "$T/alias"
# INSTALL_DIR is given through a symlink, as /usr/local/bin may be.
ln -s "$T/install" "$T/linked"
for _f in install/codeg-server install/codeg-mcp other/codeg-server other/codeg-mcp \
  stale/codeg-server stale/codeg-mcp stale/codeg-cli elsewhere/codeg-server \
  releases/codeg-server-v1 mapper; do
  cp "$T/fake" "$T/$_f"
done
# A stale PATH entry that is only a link to another install: cleanup removes
# the link, which changes nothing that runs.
ln -s "$T/elsewhere/codeg-server" "$T/stale-link/codeg-server"
# An install whose codeg-server is a link to a versioned file, and another
# name for that file.
ln -s "$T/releases/codeg-server-v1" "$T/install2/codeg-server"
ln "$T/releases/codeg-server-v1" "$T/alias/cs"

# A path for a fake to make once it is ready: none there yet.
ready_file() {
  local file
  file="$(mktemp "$T/ready.XXXXXX")"
  rm -f "$file"
  echo "$file"
}

# Wait (10 s at most) for the fake that makes $2 to be ready; it is pid $1.
wait_ready() {
  for _ in $(seq 1 50); do
    if [ -e "$2" ]; then return 0; fi
    sleep 0.2
  done
  echo "pid $1 never got ready" >&2
  return 1
}

# Start "$@" — a fake, or something that ends by exec-ing one — apart from
# this shell, so that it is reaped once it ends; record its pid and print
# it. One that never gets ready ends the test: it would pass every check
# that it stopped.
spawn() {
  local pid ready
  ready="$(ready_file)"
  ( FAKE_READY="$ready" "$@" </dev/null >/dev/null 2>&1 & echo $! > "$T/spawned" )
  pid="$(cat "$T/spawned")"
  echo "$pid" >> "$STARTED"
  wait_ready "$pid" "$ready" || exit 1
  echo "$pid"
}

alive() {
  local stat
  stat="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ' || true)"
  case "$stat" in
    "" | Z*) return 1 ;;
  esac
  return 0
}
expect_stopped() {
  CHECKS=$((CHECKS + 1))
  if alive "$2"; then fail "$1 (pid $2) is still running"; fi
}
expect_running() {
  CHECKS=$((CHECKS + 1))
  if ! alive "$2"; then fail "$1 (pid $2) was stopped"; fi
}
expect_out() {
  CHECKS=$((CHECKS + 1))
  if ! grep -qF -- "$2" "$T/out"; then fail "$1: no '$2' in what the section printed"; fi
}
expect_no_out() {
  CHECKS=$((CHECKS + 1))
  if grep -qF -- "$2" "$T/out"; then fail "$1: '$2' in what the section printed"; fi
}
# Whether the section named pid $2 among the codeg-servers it left running.
left_running() {
  grep -qE "^Left running: codeg-server \(pid( [0-9]+)* $1( [0-9]+)*\)" "$T/out"
}
expect_left_running() {
  CHECKS=$((CHECKS + 1))
  if ! left_running "$2"; then fail "$1: pid $2 not among those left running"; fi
}
expect_not_left_running() {
  CHECKS=$((CHECKS + 1))
  if left_running "$2"; then fail "$1: pid $2 among those left running"; fi
}
# Run the section with "$@" (named $1 in failures); it must end well, and
# signal no process this test did not start.
section() {
  local label="$1" rc=0
  shift
  run_section "$@" || rc=$?
  echo "${label}:"
  sed 's/^/  | /' "$T/out"
  CHECKS=$((CHECKS + 2))
  if [ "$rc" -ne 0 ]; then fail "${label}: the stop section exited with ${rc}"; fi
  if [ -s "$GUARD" ]; then
    fail "${label}: it signalled pid $(tr '\n' ' ' < "$GUARD")which this test did not start"
    : > "$GUARD"
  fi
}

# ── 1. Cleanup on: what runs from the install, or a stale copy, stops ──

# Started from the file a later install replaced: it runs a deleted one.
DELETED="$(spawn "$T/install/codeg-server")"
rm "$T/install/codeg-server"
cp "$T/fake" "$T/install/codeg-server"

ABSOLUTE="$(spawn "$T/install/codeg-server")"
# shellcheck disable=SC2016 # for the shell it starts
RELATIVE="$(spawn sh -c 'cd "$1" && exec ./codeg-server' _ "$T/install")"
LINKED="$(spawn "$T/linked/codeg-server")"
STUBBORN="$(spawn "$T/install/codeg-server" --ignore-term)"
MCP="$(spawn "$T/install/codeg-mcp")"
OTHER="$(spawn "$T/other/codeg-server")"
OTHER_MCP="$(spawn "$T/other/codeg-mcp")"
STALE="$(spawn "$T/stale/codeg-server")"
STALE_MCP="$(spawn "$T/stale/codeg-mcp")"
STALE_CLI="$(spawn "$T/stale/codeg-cli")"
LINK_TARGET="$(spawn "$T/elsewhere/codeg-server")"
# A program that has the install's file mapped, without running it.
MAPPER="$(spawn "$T/mapper" --map "$T/install/codeg-server")"

# Linux: a process of another mount namespace reports a path of its own
# filesystem. One that runs another file under the install's path stays; one
# that runs the install's very file stops.
ELSEWHERE=""
SAME_FILE=""
if [ "$PLATFORM" = "linux" ]; then
  UNSHARE=""
  if command -v unshare >/dev/null 2>&1; then
    if [ "$IS_ROOT" -eq 1 ]; then
      UNSHARE="unshare --mount --propagation private"
    elif unshare --user --map-root-user --mount true 2>/dev/null; then
      UNSHARE="unshare --user --map-root-user --mount --propagation private"
    fi
  fi
  if [ -n "$UNSHARE" ]; then
    # shellcheck disable=SC2086,SC2016 # $UNSHARE is words; the rest is for sh
    ELSEWHERE="$(spawn $UNSHARE sh -c 'mount --bind "$1" "$2" && exec "$2"' _ \
      "$T/other/codeg-server" "$T/install/codeg-server")"
    # shellcheck disable=SC2086 # $UNSHARE is words
    SAME_FILE="$(spawn $UNSHARE "$T/install/codeg-server")"
  elif [ "$IS_ROOT" -eq 1 ]; then
    skip "no unshare: processes of other mount namespaces"
  else
    echo "SKIP: no unprivileged user namespaces: processes of other mount namespaces"
  fi
fi

# Root's process, when this is not root: its file cannot be seen.
ROOTS=""
if [ "$IS_ROOT" -eq 0 ]; then
  if sudo -n true 2>/dev/null; then
    _ready="$(ready_file)"
    ROOTS="$(sudo -n env FAKE_READY="$_ready" \
      sh -c '"$1" </dev/null >/dev/null 2>&1 & echo $!' _ "$T/install/codeg-server")"
    echo "$ROOTS" >> "$ROOT_STARTED"
    wait_ready "$ROOTS" "$_ready" || exit 1
  else
    skip "no passwordless sudo: a process of another user"
  fi
fi

section "1. cleanup on" "$T/linked" 1 \
  "$T/stale/codeg-server" "$T/stale/codeg-mcp" "$T/stale/codeg-cli" "$T/stale-link/codeg-server"
expect_stopped "1: started from a file since replaced" "$DELETED"
expect_stopped "1: started by its absolute path" "$ABSOLUTE"
expect_stopped "1: started by a relative path" "$RELATIVE"
expect_stopped "1: started through a symlinked directory" "$LINKED"
expect_stopped "1: one that ignores SIGTERM" "$STUBBORN"
expect_stopped "1: the install's codeg-mcp" "$MCP"
expect_stopped "1: a stale codeg-server cleanup removes" "$STALE"
expect_stopped "1: a stale codeg-mcp cleanup removes" "$STALE_MCP"
expect_running "1: a codeg-server of another directory" "$OTHER"
expect_running "1: a codeg-mcp of another directory" "$OTHER_MCP"
expect_running "1: a stale codeg-cli" "$STALE_CLI"
expect_running "1: what a stale link that cleanup removes points to" "$LINK_TARGET"
expect_running "1: a program that only maps the install's file" "$MAPPER"
if [ -n "$ELSEWHERE" ]; then
  expect_running "1: another namespace's file under the install's path" "$ELSEWHERE"
  expect_stopped "1: the install's file, run in another namespace" "$SAME_FILE"
fi
if [ -n "$ROOTS" ]; then
  expect_running "1: root's codeg-server" "$ROOTS"
  expect_left_running "1" "$ROOTS"
fi
expect_out "1" "Force stopping codeg-server"
expect_out "1" "codeg-server stopped."
expect_out "1" "codeg-mcp stopped."
expect_out "1" "SERVER_STOPPED=1"
expect_no_out "1" "Warning:"

# ── 2. Cleanup off: a stale copy's processes stay ──

STALE="$(spawn "$T/stale/codeg-server")"
STALE_MCP="$(spawn "$T/stale/codeg-mcp")"
MCP="$(spawn "$T/install/codeg-mcp")"
section "2. cleanup off" "$T/install" 0 "$T/stale/codeg-server" "$T/stale/codeg-mcp"
expect_running "2: a stale codeg-server, kept" "$STALE"
expect_running "2: a stale codeg-mcp, kept" "$STALE_MCP"
expect_running "2: a codeg-server of another directory" "$OTHER"
expect_stopped "2: the install's codeg-mcp" "$MCP"
expect_no_out "2" "Stopping codeg-server"
# Only a codeg-server stopping asks for a restart.
expect_out "2" "SERVER_STOPPED=0"

# ── 3. A first install: the directory is not there yet ──

# And a zombie named codeg-server: it runs nothing, so it is not named.
# shellcheck disable=SC2016 # for the shell it starts
ZOMBIE_PARENT="$(spawn sh -c '"$1" & echo $! > "$2.new" && mv "$2.new" "$2"; exec sleep 300' _ \
  "$T/install/codeg-server" "$T/zombie")"
wait_ready "$ZOMBIE_PARENT" "$T/zombie" || exit 1
ZOMBIE="$(cat "$T/zombie")"
echo "$ZOMBIE" >> "$STARTED"
# Killed once its parent is `sleep`, which never reaps it: the shell before
# would.
for _i in $(seq 1 50); do
  case "$(ps -o comm= -p "$ZOMBIE_PARENT" 2>/dev/null || true)" in
    *sleep) break ;;
  esac
  sleep 0.1
done
kill -9 "$ZOMBIE"
CHECKS=$((CHECKS + 1))
for _i in $(seq 1 50); do
  case "$(ps -o stat= -p "$ZOMBIE" 2>/dev/null || true)" in
    *Z*) break ;;
  esac
  sleep 0.1
done
case "$(ps -o stat= -p "$ZOMBIE" 2>/dev/null || true)" in
  *Z*) ;;
  *) fail "3: pid $ZOMBIE never became a zombie" ;;
esac
section "3. first install" "$T/fresh/bin" 1
expect_running "3: a codeg-server of another directory" "$OTHER"
expect_not_left_running "3: a zombie" "$ZOMBIE"
expect_out "3" "SERVER_STOPPED=0"
kill -9 "$ZOMBIE_PARENT"

# ── 4. An install whose codeg-server is a link to a versioned file ──

VERSIONED="$(spawn "$T/releases/codeg-server-v1")"
THROUGH_LINK="$(spawn "$T/install2/codeg-server")"
ALIAS=""
if [ "$PLATFORM" = "linux" ]; then
  # Another name for the same file, a hard link: Linux tells it by inode.
  ALIAS="$(spawn "$T/alias/cs")"
fi
section "4. a versioned file" "$T/install2" 1
expect_stopped "4: started by the versioned file's own path" "$VERSIONED"
expect_stopped "4: started through the install's link" "$THROUGH_LINK"
if [ -n "$ALIAS" ]; then
  expect_stopped "4: started by another name for the file" "$ALIAS"
fi
expect_running "4: a codeg-server of another directory" "$OTHER"
expect_out "4" "SERVER_STOPPED=1"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "ok: ${CHECKS} checks"
