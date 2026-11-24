#!/usr/bin/env bash
# Regression tests for the standalone layout used by Codeg's bundled
# Superpowers skills. executing-plans used to assume that
# subagent-driven-development was always a sibling in the agent's skills
# directory; that is false for Windows copy fallback and for partial installs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXECUTING="$REPO_ROOT/src-tauri/experts/skills/executing-plans"
SDD="$REPO_ROOT/src-tauri/experts/skills/subagent-driven-development"
TEST_ROOT="$(mktemp -d)"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

make_repo() {
  local root="$1"
  mkdir -p "$root"
  git init -q -b main "$root"
  cat >"$root/plan.md" <<'PLAN'
# Plan

## Task 1: Fixture task

Run the fixture.
PLAN
  git -C "$root" -c user.name=Fixture -c user.email=fixture@example.com \
    -c commit.gpgsign=false add plan.md
  git -C "$root" -c user.name=Fixture -c user.email=fixture@example.com \
    -c commit.gpgsign=false commit -qm fixture
}

run_layout() {
  local name="$1"
  local layout="$2"
  local root="$TEST_ROOT/$name/repo"
  local skills="$TEST_ROOT/$name/agent/skills"
  mkdir -p "$skills"
  make_repo "$root"
  root="$(cd "$root" && pwd -P)"

  case "$layout" in
    normal)
      ln -s "$EXECUTING" "$skills/executing-plans"
      ln -s "$SDD" "$skills/subagent-driven-development"
      ;;
    foreign-sibling)
      ln -s "$EXECUTING" "$skills/executing-plans"
      mkdir -p "$TEST_ROOT/$name/foreign/subagent-driven-development/scripts"
      cat >"$TEST_ROOT/$name/foreign/subagent-driven-development/scripts/task-brief" <<'EOF'
#!/usr/bin/env bash
echo "foreign sibling selected" >&2
exit 73
EOF
      chmod +x "$TEST_ROOT/$name/foreign/subagent-driven-development/scripts/task-brief"
      ln -s "$TEST_ROOT/$name/foreign/subagent-driven-development" \
        "$skills/subagent-driven-development"
      ;;
    single-copy)
      cp -R "$EXECUTING" "$skills/executing-plans"
      ;;
    *)
      echo "unknown layout: $layout" >&2
      return 2
      ;;
  esac

  local skill="$skills/executing-plans/scripts"
  local start base
  start="$(cd "$root" && "$skill/task-start" plan.md 1)"
  grep -Fq "brief: $root/.superpowers/sdd/plan/task-1-brief.md" <<<"$start"
  base="$(sed -n 's/^base: //p' <<<"$start")"
  [ -n "$base" ]

  git -C "$root" -c user.name=Fixture -c user.email=fixture@example.com \
    -c commit.gpgsign=false commit --allow-empty -qm change
  local head review
  head="$(git -C "$root" rev-parse HEAD)"
  review="$(cd "$root" && "$skill/review-package" plan.md "$base" "$head")"
  grep -Fq "wrote " <<<"$review"

  local done
  done="$(cd "$root" && "$skill/task-done" plan.md 1 "$base" -- sh -c 'printf fixture-pass')"
  grep -Fq "fixture-pass" <<<"$done"
  grep -Fq "Task 1: complete" "$root/.superpowers/sdd/plan/progress.md"
  echo "PASS: $layout"
}

run_layout normal normal
run_layout foreign-sibling foreign-sibling
run_layout single-copy single-copy
