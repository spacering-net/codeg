#!/usr/bin/env bash
# managed-by: dev-rules/templates/upstream-merge-notify
# scripts/upstream/check-drift.sh — Report whether upstream/main has commits
# not yet merged into the fork's origin/main.
#
# Usage:
#   bash scripts/upstream/check-drift.sh           # human-readable
#   bash scripts/upstream/check-drift.sh --json    # JSON for CI consumption
#   bash scripts/upstream/check-drift.sh --quiet   # exit code only (no output)
#   bash scripts/upstream/check-drift.sh --head HEAD --target <reviewed-sha>
#
# Exit codes:
#   0 — fork is in sync (origin/main contains all of upstream/main)
#   1 — upstream is ahead (one or more upstream commits not yet merged)
#   2 — git/network failure (cannot fetch upstream or origin)
#
# Dependencies: git, with the `upstream` remote pointing at the source repo.
# CI environments without an `upstream` remote will get one auto-added from
# UPSTREAM_URL / the value baked in by install-upstream-merge-notify.sh.

set -euo pipefail

MODE="human"
HEAD_REF="origin/main"
TARGET_REF="upstream/main"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json)  MODE="json" ;;
    --quiet) MODE="quiet" ;;
    --head|--target)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "$1 requires a commit reference" >&2
        exit 2
      fi
      if [ "$1" = "--head" ]; then HEAD_REF="$2"; else TARGET_REF="$2"; fi
      shift
      ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { [ "$MODE" = "quiet" ] && return; [ "$MODE" = "json" ] && return; echo "$@"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/upstream-drift.sh
source "$SCRIPT_DIR/../lib/upstream-drift.sh"

if ! fetch_and_load_upstream_drift_snapshot "$HEAD_REF" "$TARGET_REF"; then
  exit 2
fi

BEHIND="$FORK_BEHIND"
AHEAD="$FORK_AHEAD"

if [ "$MODE" = "json" ]; then
  printf '{"behind":%d,"ahead":%d,"upstream_head":"%s","origin_head":"%s","in_sync":%s}\n' \
    "$BEHIND" "$AHEAD" "$UPSTREAM_HEAD" "$ORIGIN_HEAD" \
    "$([ "$BEHIND" -eq 0 ] && echo true || echo false)"
elif [ "$MODE" = "human" ]; then
  log "Upstream:  $TARGET_REF@$UPSTREAM_HEAD"
  log "Fork:      $HEAD_REF@$ORIGIN_HEAD"
  log "Fork ahead:  $AHEAD commits"
  log "Fork behind: $BEHIND commits"
fi

if [ "$BEHIND" -eq 0 ]; then
  log ""
  log "Fork is in sync with $TARGET_REF."
  exit 0
fi

if [ "$MODE" = "human" ]; then
  log ""
  log "Upstream has $BEHIND new commits not yet merged into the fork:"
  log ""
  git log --oneline -20 "$HEAD_REF..$TARGET_REF" | sed 's/^/  /'
  if [ "$BEHIND" -gt 20 ]; then
    log "  ... ($((BEHIND - 20)) more)"
  fi
  log ""
  log "Next steps (upstream-merge skill):"
  log ""
  log "  git fetch upstream && git fetch origin"
  log "  # create merge/upstream-YYYY-MM-DD via git-worktree-submodule"
  log "  git merge --no-ff upstream/main            # MUST be --no-ff, never --squash"
  log "  # run host preflight / project gates"
  log "  git push -u origin merge/upstream-\$(date -u +%Y-%m-%d)"
  log "  gh pr create --base main --title 'chore: merge upstream/main (...)'"
  log ""
  log "  # Reviewer MUST pick GitHub 'Create a merge commit' (not Squash)."
fi

exit 1
