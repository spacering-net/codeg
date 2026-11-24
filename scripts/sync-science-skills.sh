#!/usr/bin/env bash
#
# Re-vendor the curated scientific-research skills from upstream into
# src-tauri/science/skills/, reproducibly and with a hard license gate.
#
# Mirrors the experts vendoring model: the whitelist is the set of skill ids
# declared in src-tauri/science/science.toml (single source of truth), pinned
# to one upstream commit. Only skills/ trees are copied — byte-identical.
#
# Usage:
#   scripts/sync-science-skills.sh            # clone upstream into a temp dir
#   SCIENCE_SRC=/path/to/clone scripts/sync-science-skills.sh   # reuse a clone
#
# The script is intentionally strict: any skill missing its SKILL.md, or whose
# frontmatter license is not exactly MIT, aborts the whole sync. Never pipe its
# output through `| tail` — that swallows the exit code and turns a failed gate
# green.

set -euo pipefail

REPO_URL="https://github.com/K-Dense-AI/scientific-agent-skills.git"
PINNED_SHA="526ebce143bc326f44471554e33d66a19c840360"  # v2.72.0

# Resolve repo-root-relative paths from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCIENCE_DIR="$REPO_ROOT/src-tauri/science"
TOML="$SCIENCE_DIR/science.toml"
DST_SKILLS="$SCIENCE_DIR/skills"
NOTICE="$SCIENCE_DIR/NOTICE.md"

[ -f "$TOML" ] || { echo "FATAL: $TOML not found" >&2; exit 1; }

# ── Whitelist = ids declared in science.toml (single source of truth) ────────
# Parse `id = "..."` lines. science.toml has exactly one such key per skill.
WHITELIST=()
while IFS= read -r id; do WHITELIST+=("$id"); done < <(
  grep -E '^id[[:space:]]*=' "$TOML" | sed -E 's/^id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/'
)
[ "${#WHITELIST[@]}" -gt 0 ] || { echo "FATAL: no skill ids parsed from science.toml" >&2; exit 1; }
echo "Whitelist (${#WHITELIST[@]} skills from science.toml): ${WHITELIST[*]}"

# ── Obtain upstream at the pinned SHA ────────────────────────────────────────
CLEANUP_SRC=""
if [ -n "${SCIENCE_SRC:-}" ]; then
  SRC="$SCIENCE_SRC"
  echo "Using existing clone: $SRC"
else
  SRC="$(mktemp -d)"
  CLEANUP_SRC="$SRC"
  echo "Cloning $REPO_URL → $SRC"
  git clone --quiet "$REPO_URL" "$SRC"
fi
git -C "$SRC" checkout --quiet "$PINNED_SHA"
echo "Upstream at $(git -C "$SRC" rev-parse HEAD)"

# Pristine-source gate: `git checkout` does NOT remove tracked modifications,
# staged changes, untracked files, OR .gitignore-matched files (e.g. a
# `__pycache__/` left by a dev run inside a skill dir). A reused $SCIENCE_SRC
# carrying any of those would leak altered/extra files into the vendored output
# — and the later `diff -rq` compares the destination against this SAME worktree,
# so it would pass blind. `--ignored` is required: plain `--porcelain` hides
# ignored files, which `cp -R` would still copy. Refuse unless the tree is
# byte-for-byte the pinned commit. (A fresh clone is always clean; this only ever
# rejects a dirty reuse.)
if [ -n "$(git -C "$SRC" status --porcelain --ignored)" ]; then
  echo "FATAL: source tree at $SRC is not pristine at $PINNED_SHA." >&2
  echo "       Clean it (git -C \"$SRC\" clean -fdx && git -C \"$SRC\" checkout -- .)" >&2
  echo "       or unset SCIENCE_SRC to clone fresh. Dirty/ignored entries:" >&2
  git -C "$SRC" status --short --ignored >&2
  exit 1
fi

cleanup() { if [ -n "$CLEANUP_SRC" ]; then rm -rf "$CLEANUP_SRC"; fi; }
trap cleanup EXIT

# ── License gate + presence check (hard, before touching the dest tree) ──────
frontmatter_field() {
  # $1 = SKILL.md path, $2 = field name → first value in YAML frontmatter
  awk -v f="$2" '
    /^---[[:space:]]*$/ { c++; next }
    c==1 && $0 ~ "^" f ":" { sub("^" f ":[[:space:]]*", ""); print; exit }
  ' "$1"
}

for id in "${WHITELIST[@]}"; do
  skill_md="$SRC/skills/$id/SKILL.md"
  [ -f "$skill_md" ] || { echo "FATAL: $id has no SKILL.md upstream" >&2; exit 1; }
  lic="$(frontmatter_field "$skill_md" license | tr '[:upper:]' '[:lower:]' | xargs)"
  # Accept "mit" or "mit license" — reject anything else (v1 is exactly MIT).
  case "$lic" in
    mit|"mit license") : ;;
    *) echo "FATAL: $id license is '$lic' — v1 requires exactly MIT" >&2; exit 1 ;;
  esac
done
echo "License gate passed: all ${#WHITELIST[@]} skills are MIT."

# ── Re-vendor: wipe and copy byte-identical skills/ trees ────────────────────
rm -rf "$DST_SKILLS"
mkdir -p "$DST_SKILLS"
for id in "${WHITELIST[@]}"; do
  cp -R "$SRC/skills/$id" "$DST_SKILLS/$id"
done

# ── Byte-identity assertion (never trust the copy blindly) ───────────────────
for id in "${WHITELIST[@]}"; do
  if ! diff -rq "$SRC/skills/$id" "$DST_SKILLS/$id" >/dev/null; then
    echo "FATAL: $id differs from upstream after copy" >&2; exit 1
  fi
done
echo "Byte-identity assertion passed for ${#WHITELIST[@]} skills."

# ── Generate NOTICE.md (attribution + provenance) ────────────────────────────
{
  echo "# Third-Party Notice — Scientific Research Skills"
  echo
  echo "The skills under \`src-tauri/science/skills/\` are vendored, byte-identical,"
  echo "from:"
  echo
  echo "- **Project:** K-Dense-AI/scientific-agent-skills"
  echo "- **Source:** $REPO_URL"
  echo "- **Pinned commit:** \`$PINNED_SHA\`"
  echo "- **License:** MIT (see below), Copyright (c) 2025 K-Dense Inc."
  echo
  echo "Only MIT-licensed, self-contained skills are included. Re-sync with"
  echo "\`scripts/sync-science-skills.sh\`."
  echo
  echo "## Vendored skills (${#WHITELIST[@]})"
  echo
  for id in "${WHITELIST[@]}"; do echo "- \`$id\`"; done
  echo
  echo "## Upstream MIT License"
  echo
  echo '```'
  if [ -f "$SRC/LICENSE.md" ]; then cat "$SRC/LICENSE.md";
  elif [ -f "$SRC/LICENSE" ]; then cat "$SRC/LICENSE";
  else echo "(upstream LICENSE file not found at sync time)"; fi
  echo '```'
} > "$NOTICE"
echo "Wrote $NOTICE"

echo
echo "Done. Vendored $(find "$DST_SKILLS" -type f | wc -l | xargs) files across ${#WHITELIST[@]} skills."
echo "Review 'git status src-tauri/science' and commit."
