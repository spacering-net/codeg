#!/usr/bin/env bash
# Extract and launch an AppImage inside a Fedora 44 container.
set -u

: "${APPIMAGE:?APPIMAGE must point to an AppImage}"

dnf -y -q install \
  mesa-dri-drivers mesa-libEGL mesa-libGL \
  libglvnd-egl libglvnd-glx libglvnd-gles \
  gtk3 xorg-x11-server-Xvfb dbus-daemon procps-ng \
  >/tmp/dnf.log 2>&1 || {
  echo "Fedora smoke dependencies failed to install" >&2
  tail -n 40 /tmp/dnf.log >&2 || true
  exit 1
}

cp "$APPIMAGE" /tmp/codeg.AppImage || exit 1
chmod +x /tmp/codeg.AppImage
cd /tmp || exit 1
./codeg.AppImage --appimage-extract >/tmp/extract.log 2>&1 || {
  echo "AppImage extraction failed" >&2
  tail -n 40 /tmp/extract.log >&2 || true
  exit 1
}

export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export HOME=/tmp/home
mkdir -p "$HOME"

fail() {
  echo "Fedora AppImage smoke failed: $1" >&2
  tail -n 40 /tmp/codeg.log >&2 || true
  exit 1
}

timeout -k 5 30 xvfb-run -a ./squashfs-root/AppRun >/tmp/codeg.log 2>&1 &
run_pid=$!

sleep 20
pgrep -f '[W]ebKitWebProcess' >/dev/null || fail "WebKitWebProcess is absent at 20 seconds"

wait "$run_pid"
code=$?
if [[ "$code" -ne 124 && "$code" -ne 137 ]]; then
  fail "CodeG exited before the 30 second timeout (status $code)"
fi
if grep -Eqi 'Could not create default EGL display|EGL_BAD_PARAMETER|Failed to create EGL display' /tmp/codeg.log; then
  fail "EGL initialization error in application log"
fi

echo "Fedora 44 smoke passed: CodeG and WebKit remained alive, no EGL error"
