#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$script_dir/appimage-guard.sh"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
mkdir -p "$workdir/appimages"

cat > "$workdir/appimages/good.AppImage" <<'APPIMAGE'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "--appimage-extract" ]]
mkdir -p squashfs-root/usr/lib
APPIMAGE
chmod +x "$workdir/appimages/good.AppImage"

APPIMAGE_DIR="$workdir/appimages" bash "$guard"

mv "$workdir/appimages/good.AppImage" "$workdir/appimages/bad.AppImage"
cat >> "$workdir/appimages/bad.AppImage" <<'APPIMAGE'
mkdir -p squashfs-root/usr/lib64
touch squashfs-root/usr/lib64/libwayland-client.so.0
APPIMAGE

if APPIMAGE_DIR="$workdir/appimages" bash "$guard"; then
  echo "Guard accepted a bundled libwayland-client" >&2
  exit 1
fi

rm "$workdir/appimages/bad.AppImage"
if APPIMAGE_DIR="$workdir/appimages" bash "$guard"; then
  echo "Guard accepted a missing AppImage" >&2
  exit 1
fi

echo "AppImage guard tests passed"
