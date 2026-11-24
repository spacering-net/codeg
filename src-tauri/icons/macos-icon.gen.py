"""Generate src-tauri/icons/icon.icns — the macOS app icon.

macOS reserves a transparent safe area around an app icon: the artwork fills
824x824 centred in a 1024x1024 canvas, leaving 100px on every side. Apple's own
apps and every well-behaved third-party app measure exactly that ratio, so an
icon drawn edge-to-edge renders about 1.24x wider than its Dock neighbours
(issue #610).

`icon.svg` is deliberately full-bleed — that is the right shape for the web
favicon, the Windows .ico and the Linux PNGs, which all want to fill their
canvas — so the inset is applied here, for macOS only. Re-run after editing
icon.svg:

    python3 src-tauri/icons/macos-icon.gen.py

Requires only the project's Tauri CLI (`pnpm tauri`); no Python packages and no
macOS-only tooling, so this runs anywhere.

Why `tauri icon` and not `iconutil`: `tauri icon` reproduces the exact ICNS
chunk set this project has always shipped, including the legacy
il32/is32/l8mk/s8mk masks that carry the 16px and 32px slots for the macOS
10.13 floor we declare. Feeding a 10-file .iconset to `iconutil` instead writes
ic04/ic05 as raw ARGB and drops those masks entirely.

Note on diffs: `tauri icon` emits ICNS chunks in whatever order its parallel
encoders finish, so re-running always produces a different byte order — and so
a non-empty `git diff` — even when every pixel is identical. To tell whether
anything actually changed, compare the payload of each chunk rather than the
whole file. `cargo test --features test-utils macos_icon_geometry` asserts the
properties that actually matter.
"""

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


# Apple's macOS app-icon grid: an 824x824 body centred in a 1024x1024 canvas.
CANVAS = 1024
BODY = 824
INSET = (CANVAS - BODY) // 2

ICONS_DIR = Path(__file__).resolve().parent
REPO_ROOT = ICONS_DIR.parents[1]
SOURCE_SVG = ICONS_DIR / "icon.svg"
OUTPUT_ICNS = ICONS_DIR / "icon.icns"

_SVG_OPEN = re.compile(r"<svg\b[^>]*>", re.IGNORECASE)
_VIEW_BOX = re.compile(r'viewBox\s*=\s*"([^"]+)"', re.IGNORECASE)


def _fail(message):
    raise SystemExit(f"macos-icon.gen.py: {message}")


def _split_source(svg_text):
    """Return (inner_markup, source_side) for a square, origin-anchored SVG.

    The whole document is re-wrapped rather than edited in place, so the
    artwork travels verbatim and only the enclosing transform is ours.
    """
    open_tag = _SVG_OPEN.search(svg_text)
    if open_tag is None:
        _fail(f"{SOURCE_SVG.name} has no <svg> element")

    view_box = _VIEW_BOX.search(open_tag.group(0))
    if view_box is None:
        _fail(f"{SOURCE_SVG.name} has no viewBox; cannot place the 824/1024 inset")

    bounds = view_box.group(1).replace(",", " ").split()
    if len(bounds) != 4:
        _fail(f"unexpected viewBox {view_box.group(1)!r}")
    min_x, min_y, width, height = (float(value) for value in bounds)
    if (min_x, min_y) != (0.0, 0.0) or width != height or width <= 0:
        # A non-square or offset viewBox would silently skew the artwork.
        _fail(
            f"viewBox must be square and anchored at 0 0, got {view_box.group(1)!r}"
        )

    close = svg_text.rfind("</svg>")
    if close == -1:
        _fail(f"{SOURCE_SVG.name} has no closing </svg>")

    return svg_text[open_tag.end() : close], width


def build_padded_svg(svg_text):
    """Wrap the source artwork in a 1024 canvas with the macOS safe-area inset."""
    inner, source_side = _split_source(svg_text)
    scale = BODY / source_side
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{CANVAS}" height="{CANVAS}" viewBox="0 0 {CANVAS} {CANVAS}">\n'
        f'  <g transform="translate({INSET},{INSET}) scale({scale:.10g})">'
        f"{inner}</g>\n"
        f"</svg>\n"
    )


def main():
    if not SOURCE_SVG.is_file():
        _fail(f"missing {SOURCE_SVG}")

    padded = build_padded_svg(SOURCE_SVG.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        padded_svg = tmp_dir / "icon-macos-padded.svg"
        padded_svg.write_text(padded, encoding="utf-8")

        # `tauri icon` also emits .png/.ico/Square*/android/ios variants. Only
        # the .icns is wanted: every other platform keeps its full-bleed art.
        out_dir = tmp_dir / "out"
        out_dir.mkdir()
        result = subprocess.run(
            ["pnpm", "tauri", "icon", str(padded_svg), "-o", str(out_dir)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            sys.stderr.write(result.stdout)
            sys.stderr.write(result.stderr)
            _fail(f"`pnpm tauri icon` failed with exit code {result.returncode}")

        generated = out_dir / "icon.icns"
        if not generated.is_file():
            _fail(f"`pnpm tauri icon` produced no icon.icns in {out_dir}")

        shutil.copyfile(generated, OUTPUT_ICNS)

    print(f"wrote {OUTPUT_ICNS} ({BODY}x{BODY} body in {CANVAS}x{CANVAS} canvas)")


if __name__ == "__main__":
    main()
