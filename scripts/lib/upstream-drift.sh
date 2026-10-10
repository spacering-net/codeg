#!/usr/bin/env bash
# managed-by: dev-rules/templates/upstream-merge-notify

_upstream_url_conf() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "$here/upstream-url.conf"
}

resolve_upstream_url() {
  if [ -n "${UPSTREAM_URL:-}" ]; then
    printf '%s\n' "$UPSTREAM_URL"
    return 0
  fi
  local conf
  conf="$(_upstream_url_conf)"
  if [ -f "$conf" ]; then
    # Ignore comment / blank lines; first remaining token is the URL.
    awk 'NF && $1 !~ /^#/ { print $1; exit }' "$conf"
    return 0
  fi
  return 1
}

is_upstream_drift_gate_required() {
  # Pull-request checkouts are detached, so prefer the PR head branch. Pushes
  # expose the target branch through GITHUB_REF_NAME; local runs fall back to
  # the checked-out branch. Freshness is enforced only while preparing an
  # upstream-sync branch; existing upstream drift must not block main or an
  # unrelated feature/bugfix PR.
  local branch="${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-}}"
  if [ -z "$branch" ]; then
    branch="$(git branch --show-current 2>/dev/null || true)"
  fi

  case "$branch" in
    merge/upstream-*) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_upstream_remote() {
  if git remote get-url upstream >/dev/null 2>&1; then
    return 0
  fi
  local url
  if ! url="$(resolve_upstream_url)" || [ -z "$url" ]; then
    echo "ERROR: upstream remote missing and UPSTREAM_URL/upstream-url.conf unset" >&2
    return 2
  fi
  if declare -F log >/dev/null 2>&1; then
    log "Adding upstream remote: $url"
  fi
  git remote add upstream "$url"
}

fetch_upstream_drift_refs() {
  ensure_upstream_remote || return $?
  if ! git fetch upstream main --quiet 2>/dev/null; then
    echo "ERROR: failed to fetch upstream/main" >&2
    return 2
  fi
  if ! git fetch origin main --quiet 2>/dev/null; then
    echo "ERROR: failed to fetch origin/main" >&2
    return 2
  fi
}

load_upstream_drift_snapshot() {
  local head_ref="${1:-origin/main}" target_ref="${2:-upstream/main}"
  local head_sha target_sha
  head_sha=$(git rev-parse --verify "$head_ref^{commit}") || return 2
  target_sha=$(git rev-parse --verify "$target_ref^{commit}") || return 2
  local merge_head merge_heads_file
  local -a reviewed_heads=("$head_sha")
  merge_heads_file=$(git rev-parse --git-path MERGE_HEAD) || return 2
  if [ "$head_ref" = "HEAD" ] && [ -f "$merge_heads_file" ]; then
    # Before the merge commit, HEAD is still the fork parent. Validate the
    # resolved index and count the actual pending parents; never waive drift
    # against a target that is not part of this merge.
    git write-tree >/dev/null || return 2
    while IFS= read -r merge_head; do
      merge_head=$(git rev-parse --verify "$merge_head^{commit}") || return 2
      reviewed_heads+=("$merge_head")
    done < "$merge_heads_file"
  fi
  FORK_BEHIND=$(git rev-list --count "$target_sha" --not "${reviewed_heads[@]}") || return 2
  FORK_AHEAD=$(git rev-list --count "${reviewed_heads[@]}" --not "$target_sha") || return 2
  UPSTREAM_HEAD=$(git rev-parse --short "$target_sha")
  ORIGIN_HEAD=$(git rev-parse --short "$head_sha")
  export FORK_BEHIND FORK_AHEAD UPSTREAM_HEAD ORIGIN_HEAD
}

fetch_and_load_upstream_drift_snapshot() {
  fetch_upstream_drift_refs || return $?
  load_upstream_drift_snapshot "$@"
}
