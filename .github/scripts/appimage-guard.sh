#!/usr/bin/env bash
# Inspect the built AppImage before its draft release can be published.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
appimage_dir="${APPIMAGE_DIR:-$repo_root/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage}"

if [[ ! -d "$appimage_dir" ]]; then
  echo "AppImage directory not found: $appimage_dir" >&2
  exit 1
fi

mapfile -d '' appimages < <(
  find "$appimage_dir" -maxdepth 1 -type f -name '*.AppImage' -print0
)
if [[ "${#appimages[@]}" -ne 1 ]]; then
  echo "Expected one AppImage in $appimage_dir, found ${#appimages[@]}" >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf -- "$workdir"' EXIT
cp -- "${appimages[0]}" "$workdir/inspect.AppImage"
chmod +x "$workdir/inspect.AppImage"
(cd "$workdir" && ./inspect.AppImage --appimage-extract >/dev/null)

if [[ ! -d "$workdir/squashfs-root" ]]; then
  echo "AppImage extraction did not create squashfs-root" >&2
  exit 1
fi

bundled="$(
  find "$workdir/squashfs-root" -name 'libwayland-client.so*' -print -quit
)"
if [[ -n "$bundled" ]]; then
  echo "AppImage bundles libwayland-client: $bundled" >&2
  exit 1
fi

echo "AppImage excludes libwayland-client: ${appimages[0]}"
