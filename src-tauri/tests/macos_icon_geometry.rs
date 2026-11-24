//! Guards the macOS safe-area inset baked into `icons/icon.icns`.
//!
//! macOS draws `CFBundleIconFile` into a fixed tile, so the *artwork* — not the
//! canvas — decides how big the app reads in the Dock. Apple's grid puts an
//! 824x824 body in a 1024x1024 canvas, a 100px transparent margin on every
//! side; Keynote, Pages, Maps, Chrome, Edge, OBS all measure exactly that. codeg
//! shipped a full-bleed squircle through 0.29.0, which rendered ~1.24x wider
//! than its neighbours — visibly "a size bigger" (issue #610).
//!
//! The inset lives only in the `.icns`. `icon.svg`, the Windows `.ico` and the
//! Linux PNGs stay full-bleed on purpose: those platforms want the canvas
//! filled, and the PNGs are what `default_window_icon()` hands the Windows and
//! Linux tray (`commands/windows.rs`). So this test deliberately checks one
//! file and not the rest.
//!
//! Why a test and not a comment: `pnpm tauri icon` regenerates the `.icns`
//! full-bleed, and it gets run for unrelated reasons — `1d3dd0dc` rewrote all 17
//! icon assets while fixing the *Windows* ICO. A note in the file would not have
//! stopped that; a red CI cell does.
//!
//! Regenerate after editing `icon.svg`:
//!
//!     python3 src-tauri/icons/macos-icon.gen.py

use std::collections::BTreeSet;
use std::path::PathBuf;

/// Apple's grid: 824 of 1024. Measured across 113 installed apps, every slot at
/// 32px and above sits in 0.802..=0.807, so the window is tight enough to catch
/// a full-bleed regression (1.000) and loose enough to absorb the rounding that
/// small slots pick up when 0.8046875 lands on whole pixels.
const MIN_RATIO: f64 = 0.79;
const MAX_RATIO: f64 = 0.82;

/// The 1024 master is the slot the Dock actually scales from, so it is pinned to
/// the exact grid rather than the tolerance band. 2px covers antialiasing on the
/// squircle's flat edge, nothing more.
const MASTER_CANVAS: u32 = 1024;
const MASTER_BODY: f64 = 824.0;
const MASTER_INSET: u32 = 100;
const MASTER_SLACK: f64 = 2.0;

/// PNG-payload slots and the canvas each one carries. `iconutil` and
/// `tauri icon` disagree about which types they emit, so the mapping is asserted
/// rather than inferred — a change here means the container was rebuilt by a
/// different tool.
const PNG_SLOTS: &[(&str, u32)] = &[
    ("ic07", 128),
    ("ic08", 256),
    ("ic09", 512),
    ("ic10", 1024),
    ("ic11", 32),
    ("ic12", 64),
    ("ic13", 256),
    ("ic14", 512),
];

/// The 16px and 32px slots ride in these legacy RGB+mask pairs. We declare
/// `LSMinimumSystemVersion` 10.13, which predates the modern ARGB replacements,
/// so dropping them would strand the small icons on old systems.
const LEGACY_SLOTS: &[&str] = &["is32", "s8mk", "il32", "l8mk"];

/// `iconutil` writes these two as raw ARGB *and* drops `LEGACY_SLOTS` in the
/// same pass. Their presence is the fingerprint of someone swapping the
/// generator's build step, so it fails loudly instead of silently regressing
/// old-macOS compatibility.
const ICONUTIL_ONLY_SLOTS: &[&str] = &["ic04", "ic05"];

fn icns_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.icns")
}

/// Walk the ICNS container: an 8-byte header, then `type` + `length` records
/// where `length` counts its own 8-byte header.
fn parse_chunks(data: &[u8]) -> Vec<(String, &[u8])> {
    assert!(data.len() >= 8, "icon.icns is truncated ({} bytes)", data.len());
    assert_eq!(&data[0..4], b"icns", "icon.icns is missing its magic");

    let declared = u32::from_be_bytes(data[4..8].try_into().expect("4 bytes")) as usize;
    assert_eq!(
        declared,
        data.len(),
        "icon.icns declares {declared} bytes but is {}",
        data.len()
    );

    let mut chunks = Vec::new();
    let mut offset = 8usize;
    while offset + 8 <= data.len() {
        let kind = String::from_utf8_lossy(&data[offset..offset + 4]).into_owned();
        let len =
            u32::from_be_bytes(data[offset + 4..offset + 8].try_into().expect("4 bytes")) as usize;
        assert!(
            len >= 8 && offset + len <= data.len(),
            "chunk {kind} at {offset} has bogus length {len}"
        );
        chunks.push((kind, &data[offset + 8..offset + len]));
        offset += len;
    }
    assert_eq!(offset, data.len(), "trailing bytes after the last chunk");
    chunks
}

/// Sub-pixel body extent: the alpha coverage integral across the centre row and
/// column. A nonzero-alpha bounding box would do instead, except antialiasing
/// and resampling ringing make it read ~15% small at 16px — the coverage sum is
/// stable at every size.
struct Body {
    width: f64,
    height: f64,
    left: u32,
    right: u32,
    top: u32,
    bottom: u32,
}

fn measure(image: &image::RgbaImage) -> Body {
    let (w, h) = image.dimensions();
    let (mid_x, mid_y) = (w / 2, h / 2);

    let alpha_row = |x: u32| f64::from(image.get_pixel(x, mid_y)[3]) / 255.0;
    let alpha_col = |y: u32| f64::from(image.get_pixel(mid_x, y)[3]) / 255.0;

    let opaque_x: Vec<u32> = (0..w).filter(|&x| image.get_pixel(x, mid_y)[3] > 127).collect();
    let opaque_y: Vec<u32> = (0..h).filter(|&y| image.get_pixel(mid_x, y)[3] > 127).collect();
    assert!(
        !opaque_x.is_empty() && !opaque_y.is_empty(),
        "no opaque pixels through the centre — the artwork is missing"
    );

    Body {
        width: (0..w).map(alpha_row).sum(),
        height: (0..h).map(alpha_col).sum(),
        left: opaque_x[0],
        right: w - 1 - opaque_x[opaque_x.len() - 1],
        top: opaque_y[0],
        bottom: h - 1 - opaque_y[opaque_y.len() - 1],
    }
}

fn decode(kind: &str, payload: &[u8]) -> image::RgbaImage {
    image::load_from_memory_with_format(payload, image::ImageFormat::Png)
        .unwrap_or_else(|err| panic!("chunk {kind} is not decodable PNG: {err}"))
        .to_rgba8()
}

#[test]
fn every_png_slot_keeps_the_macos_safe_area_inset() {
    let data = std::fs::read(icns_path()).expect("read icons/icon.icns");
    let chunks = parse_chunks(&data);

    for (kind, expected_canvas) in PNG_SLOTS {
        let payload = chunks
            .iter()
            .find(|(name, _)| name == kind)
            .map(|(_, payload)| *payload)
            .unwrap_or_else(|| panic!("icon.icns is missing the {kind} slot"));

        let image = decode(kind, payload);
        let (w, h) = image.dimensions();
        assert_eq!(
            (w, h),
            (*expected_canvas, *expected_canvas),
            "{kind} should carry a {expected_canvas}px canvas"
        );

        let body = measure(&image);
        let ratio = body.width / f64::from(w);
        assert!(
            (MIN_RATIO..=MAX_RATIO).contains(&ratio),
            "{kind}: body is {:.1}px of a {w}px canvas (ratio {ratio:.3}), outside \
             {MIN_RATIO}..={MAX_RATIO}. A ratio near 1.0 means the icon was \
             regenerated full-bleed — re-run src-tauri/icons/macos-icon.gen.py.",
            body.width
        );
    }
}

#[test]
fn master_slot_matches_apples_824_of_1024_grid() {
    let data = std::fs::read(icns_path()).expect("read icons/icon.icns");
    let chunks = parse_chunks(&data);
    let payload = chunks
        .iter()
        .find(|(name, _)| name == "ic10")
        .map(|(_, payload)| *payload)
        .expect("icon.icns is missing the 1024px ic10 slot");

    let image = decode("ic10", payload);
    assert_eq!(image.dimensions(), (MASTER_CANVAS, MASTER_CANVAS));

    let body = measure(&image);
    for (axis, measured) in [("width", body.width), ("height", body.height)] {
        assert!(
            (measured - MASTER_BODY).abs() <= MASTER_SLACK,
            "1024 master {axis} is {measured:.1}px, expected {MASTER_BODY} \
             (+/-{MASTER_SLACK})"
        );
    }
    for (edge, measured) in [
        ("left", body.left),
        ("right", body.right),
        ("top", body.top),
        ("bottom", body.bottom),
    ] {
        let delta = f64::from(measured.abs_diff(MASTER_INSET));
        assert!(
            delta <= MASTER_SLACK,
            "1024 master {edge} inset is {measured}px, expected {MASTER_INSET} \
             (+/-{MASTER_SLACK})"
        );
    }
}

#[test]
fn icns_keeps_the_legacy_masks_the_declared_macos_floor_needs() {
    let data = std::fs::read(icns_path()).expect("read icons/icon.icns");
    let present: BTreeSet<String> = parse_chunks(&data)
        .into_iter()
        .map(|(kind, _)| kind)
        .collect();

    for kind in LEGACY_SLOTS {
        assert!(
            present.contains(*kind),
            "icon.icns lost the {kind} chunk. `iconutil` drops these; \
             src-tauri/icons/macos-icon.gen.py uses `tauri icon`, which keeps them."
        );
    }
    for kind in ICONUTIL_ONLY_SLOTS {
        assert!(
            !present.contains(*kind),
            "icon.icns gained {kind}, which only `iconutil` emits — and it writes \
             raw ARGB while dropping the legacy masks that macOS 10.13 needs. \
             Rebuild with src-tauri/icons/macos-icon.gen.py."
        );
    }
}
