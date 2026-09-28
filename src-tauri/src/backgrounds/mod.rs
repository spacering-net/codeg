//! Filesystem-backed workspace background-image repository.
//!
//! A single user-selected image is stored at
//! `paths::codeg_backgrounds_root()/background.img`. The repository is
//! **decoupled from Tauri** so the same routines back the desktop and
//! standalone-server runtimes, mirroring `crate::pets` — simplified to one
//! image with no id/manifest, and with relaxed validation: any dimensions are
//! allowed and no alpha channel is required (backgrounds are opaque photos).
//!
//! The stored bytes are the user's file verbatim — never re-encoded, resized or
//! flattened — which is what lets an animated background (GIF, APNG, animated
//! WebP) still animate once the webview paints it.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{ImageFormat, ImageReader};

use crate::app_error::AppCommandError;
use crate::models::background::BackgroundAsset;
use crate::paths::codeg_backgrounds_root;

pub mod marketplace;

/// Smallest plausible image payload; rejecting tiny inputs early avoids
/// decoding random files.
const MIN_BG_BYTES: usize = 64;
/// Cap raw uploads at 16 MiB. A reasonable background is well under this; the
/// cap is purely a guardrail (matches the pet spritesheet ceiling).
const MAX_BG_BYTES: usize = 16 * 1024 * 1024;
/// Upper bound on decoded pixel count, checked from the header *before* any
/// full decode, so a decompression bomb cannot force a huge allocation.
/// 40M px ≈ an 8K image (7680×4320 ≈ 33M), generous for a wallpaper.
const MAX_BG_PIXELS: u64 = 40_000_000;
/// Canonical on-disk filename. Extension-agnostic — the mime type is sniffed
/// from the magic bytes on read, so a single path round-trips PNG/JPEG/WebP/GIF.
const BACKGROUND_FILENAME: &str = "background.img";
/// How long a staging file must sit untouched before a later write treats it as
/// crash debris and deletes it. Comfortably longer than any real write, so a
/// concurrent writer's in-flight staging file is never swept out from under it.
const STALE_TMP_AGE: Duration = Duration::from_secs(600);

/// Disambiguates staging files between concurrent writers. Paired with the pid
/// it also separates two processes (desktop app + standalone server) pointed at
/// one `CODEG_DATA_DIR`.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn background_path() -> PathBuf {
    codeg_backgrounds_root().join(BACKGROUND_FILENAME)
}

/// Verify the payload is a real, bounded image before it touches disk. Accepts
/// PNG / JPEG / WebP / GIF. Unlike the sprite validator, it imposes no fixed
/// dimensions and requires no alpha channel. Dimensions are read from the
/// header (not a full decode) so a hostile file's declared pixel count is
/// bounded before allocation.
///
/// Animation is deliberately **not** a rejection reason, and never a decode
/// concern on this side. What the dimension read returns is the container's
/// *canvas* — a GIF's logical screen descriptor, a PNG/APNG `IHDR`, a WebP
/// `VP8X` — not any individual frame and not the timeline. The payload is then
/// stored byte-for-byte, so the webview receives the original file and plays
/// every frame.
///
/// So the two guards bound different things, and neither bounds animation:
/// `MAX_BG_PIXELS` caps the canvas (which every frame is confined to), and
/// `MAX_BG_BYTES` caps the *input*, not the work a webview spends decoding a
/// long one. Frame count and per-frame LZW payloads go unchecked. Treat this as
/// a sanity bound, not a DoS boundary.
///
/// That framing was originally justified by every caller handing over a file the
/// user had picked from their own disk. `marketplace::download` widened it: the
/// bytes now come from a third-party upload site. The caps above are what still
/// applies to that path — the *decode* cost of a pathological animation inside
/// them does not, and the residual exposure is the user's own webview. It is
/// accepted knowingly, not overlooked: APNG and animated WebP already reached
/// the webview by this same route before GIF was allowed, and bounding frame
/// counts would mean re-encoding, which would break animated backgrounds
/// outright.
pub fn validate_background(bytes: &[u8]) -> Result<(), AppCommandError> {
    if bytes.len() < MIN_BG_BYTES {
        return Err(AppCommandError::invalid_input(
            "Background image payload is too small to be valid.",
        ));
    }
    if bytes.len() > MAX_BG_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "Background image exceeds {} MiB cap.",
            MAX_BG_BYTES / (1024 * 1024)
        )));
    }

    let cursor = std::io::Cursor::new(bytes);
    let reader = ImageReader::new(cursor)
        .with_guessed_format()
        .map_err(|e| AppCommandError::invalid_input(format!("Cannot read image header: {e}")))?;
    let format = reader.format().ok_or_else(|| {
        AppCommandError::invalid_input("Background must be a PNG, JPEG, WebP or GIF image.")
    })?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif
    ) {
        return Err(AppCommandError::invalid_input(
            "Background must be a PNG, JPEG, WebP or GIF image.",
        ));
    }

    let (w, h) = reader.into_dimensions().map_err(|e| {
        AppCommandError::invalid_input(format!("Cannot read image dimensions: {e}"))
    })?;
    if (w as u64) * (h as u64) > MAX_BG_PIXELS {
        return Err(AppCommandError::invalid_input(format!(
            "Background image is too large ({w}×{h}); the maximum is {MAX_BG_PIXELS} pixels."
        )));
    }
    Ok(())
}

fn ensure_backgrounds_root() -> Result<PathBuf, AppCommandError> {
    let root = codeg_backgrounds_root();
    if !root.exists() {
        fs::create_dir_all(&root).map_err(AppCommandError::io)?;
    }
    Ok(root)
}

pub(crate) fn write_background_atomic(bytes: &[u8]) -> Result<(), AppCommandError> {
    let root = ensure_backgrounds_root()?;
    write_background_atomic_in(&root, bytes)
}

/// Stage into a sibling file, then rename over the background.
///
/// The staging name is **per-writer** (`background.img.<pid>.<seq>.tmp`) rather
/// than one shared `background.img.tmp`. Two writers do overlap in practice —
/// the wallpaper market's grid lets a second wallpaper be picked while the first
/// is still downloading — and a shared staging path made them fight over one
/// inode: the second `File::create` truncates what the first is still writing,
/// and whichever `rename` lands second fails with `ENOENT` because the other
/// already moved the file away. That surfaced as "download failed" on a download
/// that had in fact succeeded. With a private staging file each writer is a
/// clean last-writer-wins: `rename` is atomic, so a reader sees one whole image
/// either way, and neither writer can truncate the other's bytes.
///
/// Takes `root` explicitly so tests can exercise it against a temp dir instead
/// of the process-global `CODEG_HOME`.
fn write_background_atomic_in(root: &Path, bytes: &[u8]) -> Result<(), AppCommandError> {
    sweep_stale_staging_files(root);
    let final_path = root.join(BACKGROUND_FILENAME);
    let tmp_path = root.join(format!(
        "{BACKGROUND_FILENAME}.{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let staged = (|| -> Result<(), AppCommandError> {
        let mut f = fs::File::create(&tmp_path).map_err(AppCommandError::io)?;
        f.write_all(bytes).map_err(AppCommandError::io)?;
        f.sync_all().map_err(AppCommandError::io)?;
        drop(f);
        fs::rename(&tmp_path, &final_path).map_err(AppCommandError::io)
    })();
    if staged.is_err() {
        // A private staging file is ours alone to remove, so a failed write
        // never leaves debris behind for the sweep to find later.
        let _ = fs::remove_file(&tmp_path);
    }
    staged
}

/// Delete staging files left by a crash (or by a pre-`<pid>.<seq>` build, whose
/// name was the fixed `background.img.tmp`). Only long-untouched entries are
/// removed, so a staging file another writer is filling right now is safe.
/// Best-effort: a failure here must never fail the write that follows.
fn sweep_stale_staging_files(root: &Path) {
    let prefix = format!("{BACKGROUND_FILENAME}.");
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(&prefix) || !name.ends_with(".tmp") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|modified| {
                SystemTime::now()
                    .duration_since(modified)
                    .is_ok_and(|age| age >= STALE_TMP_AGE)
            })
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn decode_base64_payload(b64: &str) -> Result<Vec<u8>, AppCommandError> {
    BASE64
        .decode(b64.as_bytes())
        .map_err(|e| AppCommandError::invalid_input(format!("Invalid base64 payload: {e}")))
}

/// Header sniff to recover the mime on read. `validate_background` already ran
/// on write, so the on-disk bytes are guaranteed PNG/JPEG/WebP/GIF; the PNG
/// fallback only matters for a truncated/edited file.
///
/// The frontend stamps this string onto the `Blob` it builds the background's
/// object URL from, so a GIF misreported as `image/png` would hand the webview
/// a mislabelled blob — hence GIF gets its own arm rather than riding the
/// fallback.
fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        return "image/png";
    }
    if bytes.len() >= 3 && &bytes[..3] == b"\xFF\xD8\xFF" {
        return "image/jpeg";
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    // Both revisions of the GIF signature; `GIF89a` is the one that carries
    // animation, `GIF87a` is the static original.
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF89a" || &bytes[..6] == b"GIF87a") {
        return "image/gif";
    }
    "image/png"
}

/// Decode → validate → atomically overwrite the single background file.
pub fn set_background(image_base64: &str) -> Result<(), AppCommandError> {
    let bytes = decode_base64_payload(image_base64)?;
    validate_background(&bytes)?;
    write_background_atomic(&bytes)
}

/// Read the stored background, or `Ok(None)` when none is set. A missing file
/// is the normal "no background" state, not an error.
pub fn read_background() -> Result<Option<BackgroundAsset>, AppCommandError> {
    let path = background_path();
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(BackgroundAsset {
            mime: sniff_mime(&bytes).to_string(),
            data_base64: BASE64.encode(&bytes),
        })),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AppCommandError::io(err)),
    }
}

/// Remove the stored background. Idempotent — an already-absent file is success.
pub fn clear_background() -> Result<(), AppCommandError> {
    match fs::remove_file(background_path()) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppCommandError::io(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The env-resolved paths (`background_path`, `ensure_backgrounds_root`)
    // depend on the global `CODEG_HOME`/`CODEG_DATA_DIR` (shared, races under
    // parallel tests), so — like `pets::tests` — those are covered by manual
    // smoke tests. `write_background_atomic_in` takes its root explicitly, so
    // the staging/rename behaviour is testable against a temp dir.

    fn encode_png(w: u32, h: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(w, h);
        for (i, p) in img.pixels_mut().enumerate() {
            let v = (i % 251) as u8;
            *p = image::Rgba([v, v, v, 255]);
        }
        let mut bytes: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    /// A real multi-frame GIF89a — the exact shape a user picks when they want
    /// a moving background, so the validator is exercised against animation
    /// rather than a single-frame stand-in.
    fn encode_animated_gif(w: u32, h: u32, frames: u16) -> Vec<u8> {
        let mut bytes: Vec<u8> = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            for f in 0..frames {
                let mut img = image::RgbaImage::new(w, h);
                for (i, p) in img.pixels_mut().enumerate() {
                    let v = ((i + f as usize * 37) % 251) as u8;
                    *p = image::Rgba([v, 255 - v, v / 2, 255]);
                }
                encoder
                    .encode_frame(image::Frame::new(img))
                    .expect("gif frame");
            }
        }
        bytes
    }

    #[test]
    fn validate_accepts_reasonable_png() {
        assert!(validate_background(&encode_png(256, 256)).is_ok());
    }

    #[test]
    fn validate_accepts_animated_gif() {
        let gif = encode_animated_gif(64, 64, 4);
        assert_eq!(&gif[..6], b"GIF89a", "expected an animation-capable GIF");
        validate_background(&gif).expect("an animated GIF is a valid background");
    }

    #[test]
    fn validate_accepts_arbitrary_dimensions() {
        // A wide banner and a tall strip both pass — no fixed-geometry rule.
        assert!(validate_background(&encode_png(1920, 200)).is_ok());
        assert!(validate_background(&encode_png(200, 1920)).is_ok());
    }

    #[test]
    fn validate_rejects_too_small() {
        let err = validate_background(&[0u8; 10]).unwrap_err();
        assert!(err.message.to_lowercase().contains("too small"));
    }

    #[test]
    fn validate_rejects_non_image() {
        // > MIN bytes but not a decodable image. The message doubles as the
        // user-facing format list, so it must name every accepted format —
        // telling someone GIF is unsupported would now be a lie.
        let err = validate_background(&vec![0x42u8; 4096]).unwrap_err();
        for format in ["PNG", "JPEG", "WebP", "GIF"] {
            assert!(err.message.contains(format), "got: {}", err.message);
        }
    }

    #[test]
    fn sniff_mime_detects_png() {
        assert_eq!(sniff_mime(&encode_png(64, 64)), "image/png");
    }

    #[test]
    fn sniff_mime_detects_jpeg_and_webp_magic() {
        assert_eq!(sniff_mime(b"\xFF\xD8\xFF\xE0abcd"), "image/jpeg");
        assert_eq!(sniff_mime(b"RIFF\x00\x00\x00\x00WEBPvp8"), "image/webp");
    }

    #[test]
    fn sniff_mime_detects_gif() {
        // A real encoded animation, then both bare signatures. Riding the PNG
        // fallback here would hand the webview a mislabelled blob.
        assert_eq!(sniff_mime(&encode_animated_gif(32, 32, 3)), "image/gif");
        assert_eq!(sniff_mime(b"GIF89a\x00\x00\x00\x00abcd"), "image/gif");
        assert_eq!(sniff_mime(b"GIF87a\x00\x00\x00\x00abcd"), "image/gif");
    }

    /// Two writers racing on one background — what the market grid produces
    /// when a second wallpaper is clicked mid-download. Both must report
    /// success, and the file left behind must be exactly one of the two inputs,
    /// never a splice of both.
    #[test]
    fn concurrent_writes_both_succeed_and_leave_one_whole_image() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = vec![0xAAu8; 2 * 1024 * 1024];
        let b = vec![0xBBu8; 2 * 1024 * 1024];
        for _ in 0..8 {
            std::thread::scope(|scope| {
                let root = dir.path();
                let h1 = scope.spawn(|| write_background_atomic_in(root, &a));
                let h2 = scope.spawn(|| write_background_atomic_in(root, &b));
                h1.join().unwrap().expect("first writer");
                h2.join().unwrap().expect("second writer");
            });
            let out = fs::read(dir.path().join(BACKGROUND_FILENAME)).expect("background exists");
            assert!(
                out == a || out == b,
                "expected one whole image, got {} bytes mixing both",
                out.len()
            );
        }
    }

    #[test]
    fn a_failed_write_leaves_no_staging_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A directory where the final file goes makes `rename` fail after the
        // staging file is fully written — the one window that used to leak.
        fs::create_dir(dir.path().join(BACKGROUND_FILENAME)).expect("blocker");
        assert!(write_background_atomic_in(dir.path(), &encode_png(32, 32)).is_err());
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leaked staging files: {leftovers:?}");
    }

    #[test]
    fn sweep_removes_crash_debris_but_spares_a_fresh_staging_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Named exactly like the pre-`<pid>.<seq>` builds' shared staging file.
        let stale = dir.path().join(format!("{BACKGROUND_FILENAME}.tmp"));
        let fresh = dir.path().join(format!("{BACKGROUND_FILENAME}.999.0.tmp"));
        let unrelated = dir.path().join("notes.txt");
        for path in [&stale, &fresh, &unrelated] {
            fs::write(path, b"x").expect("seed");
        }
        let old = SystemTime::now() - STALE_TMP_AGE - Duration::from_secs(60);
        // Opened for writing rather than with `File::open`: Windows backs
        // `set_modified` with `SetFileTime`, which needs `FILE_WRITE_ATTRIBUTES`
        // on the handle, and only a write-mode open asks for it. A read-only
        // handle backdates happily on Unix — `futimens` gates an explicit
        // timestamp on the file's ownership, not the descriptor's access mode —
        // and fails with "Access is denied" on Windows.
        fs::File::options()
            .write(true)
            .open(&stale)
            .expect("open for backdating")
            .set_modified(old)
            .expect("backdate");

        sweep_stale_staging_files(dir.path());

        assert!(!stale.exists(), "crash debris should be swept");
        assert!(
            fresh.exists(),
            "a concurrent writer's staging file must survive"
        );
        assert!(unrelated.exists(), "unrelated files must be untouched");
    }
}
