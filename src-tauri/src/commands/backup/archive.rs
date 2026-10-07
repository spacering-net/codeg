//! ZIP construction / extraction + per-entry integrity, all synchronous.
//!
//! Callers run these under `tokio::task::spawn_blocking`. The archive is built
//! to a temp file and delivered afterwards (desktop writes to the chosen path,
//! the web server streams it via a download ticket), so the sync `zip` crate —
//! already a dependency, with random-access reads for manifest-first
//! validation — is a better fit than streaming `async_zip`.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path};

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::app_error::AppCommandError;

use super::manifest::{BackupManifest, ManifestEntry, BACKUP_KIND, MANIFEST_ENTRY_NAME};
use super::{cancelled_error, corrupted_error, map_disk_full, unknown_format_error};

const COPY_BUF: usize = 64 * 1024;
/// Hard cap on the decompressed `manifest.json` we'll read from an untrusted
/// archive (manifests are small; this defeats a manifest decompression bomb).
///
/// The entry count grew by an order of magnitude when `skills/` and `pets/`
/// joined the managed sections — tens of entries became thousands. At roughly
/// 120 bytes per entry, 10k entries is ~1.2 MB, so there is still a decade of
/// headroom here; revisit if a section ever contributes six-figure file counts.
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

/// Progress sink: invoked with the current entry name and the cumulative
/// plaintext bytes processed so far.
pub type ProgressFn<'a> = dyn FnMut(&str, u64) + 'a;

fn noop_progress(_: &str, _: u64) {}

/// Incrementally builds a backup ZIP, recording a [`ManifestEntry`] (size +
/// sha256) for every file added, then writes the manifest as the final entry.
pub struct ArchiveBuilder {
    writer: ZipWriter<BufWriter<File>>,
    entries: Vec<ManifestEntry>,
    processed: u64,
}

impl ArchiveBuilder {
    pub fn create(dest_zip: &Path) -> Result<Self, AppCommandError> {
        let file = File::create(dest_zip).map_err(AppCommandError::io)?;
        Ok(Self {
            writer: ZipWriter::new(BufWriter::new(file)),
            entries: Vec::new(),
            processed: 0,
        })
    }

    /// Stream `src` into the archive under `entry_name`, hashing as we go.
    pub fn add_file(
        &mut self,
        entry_name: &str,
        src: &Path,
        cancel: &CancellationToken,
        progress: &mut ProgressFn<'_>,
    ) -> Result<(), AppCommandError> {
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(true);
        self.writer
            .start_file(entry_name.to_string(), opts)
            .map_err(zip_err)?;

        let f = File::open(src).map_err(AppCommandError::io)?;
        let mut reader = BufReader::new(f);
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; COPY_BUF];
        let mut size = 0u64;
        loop {
            if cancel.is_cancelled() {
                return Err(cancelled_error());
            }
            let n = reader.read(&mut buf).map_err(AppCommandError::io)?;
            if n == 0 {
                break;
            }
            self.writer.write_all(&buf[..n]).map_err(map_disk_full)?;
            hasher.update(&buf[..n]);
            size += n as u64;
            self.processed += n as u64;
            progress(entry_name, self.processed);
        }
        self.entries.push(ManifestEntry {
            path: entry_name.to_string(),
            size,
            sha256: to_hex(&hasher.finalize()),
        });
        Ok(())
    }

    /// Recursively add every regular file under `root` as `<prefix>/<rel>`.
    /// Symlinks are skipped (never followed) and `exclude(rel)` short-circuits
    /// a file. A missing `root` is a no-op.
    pub fn add_dir(
        &mut self,
        prefix: &str,
        root: &Path,
        exclude: &dyn Fn(&Path) -> bool,
        cancel: &CancellationToken,
        progress: &mut ProgressFn<'_>,
    ) -> Result<(), AppCommandError> {
        if !root.exists() {
            return Ok(());
        }
        for entry in WalkDir::new(root).follow_links(false) {
            if cancel.is_cancelled() {
                return Err(cancelled_error());
            }
            let entry = entry
                .map_err(|e| AppCommandError::io_error("Failed to walk directory").with_detail(e.to_string()))?;
            let ft = entry.file_type();
            if !ft.is_file() {
                // Skip directories, symlinks, and special files.
                continue;
            }
            let path = entry.path();
            let rel = match path.strip_prefix(root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if exclude(rel) {
                continue;
            }
            let entry_name = format!("{prefix}/{}", rel_to_slash(rel));
            self.add_file(&entry_name, path, cancel, progress)?;
        }
        Ok(())
    }

    /// Total plaintext bytes added so far (drives `total`-less progress).
    pub fn processed_bytes(&self) -> u64 {
        self.processed
    }

    /// Write `manifest.json` (uncompressed) as the last entry and close the
    /// archive. Returns the manifest with its `entries` populated.
    pub fn finish(mut self, mut manifest: BackupManifest) -> Result<BackupManifest, AppCommandError> {
        manifest.entries = std::mem::take(&mut self.entries);
        let json = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| AppCommandError::task_execution_failed("Serialize manifest").with_detail(e.to_string()))?;
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        self.writer
            .start_file(MANIFEST_ENTRY_NAME, opts)
            .map_err(zip_err)?;
        self.writer.write_all(&json).map_err(AppCommandError::io)?;
        self.writer.finish().map_err(zip_err)?;
        Ok(manifest)
    }
}

/// Read and validate just the manifest from an (already-plaintext) ZIP.
pub fn read_manifest(zip_path: &Path) -> Result<BackupManifest, AppCommandError> {
    let f = File::open(zip_path).map_err(AppCommandError::io)?;
    let mut ar = ZipArchive::new(BufReader::new(f)).map_err(|_| unknown_format_error())?;
    let entry = ar
        .by_name(MANIFEST_ENTRY_NAME)
        .map_err(|_| unknown_format_error())?;
    // Bound the decompressed manifest read so a tiny compressed `manifest.json`
    // can't inflate to exhaust memory before we parse it.
    let mut s = String::new();
    entry
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_string(&mut s)
        .map_err(AppCommandError::io)?;
    if s.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(unknown_format_error());
    }
    let manifest: BackupManifest = serde_json::from_str(&s).map_err(|_| unknown_format_error())?;
    if manifest.kind != BACKUP_KIND {
        return Err(unknown_format_error());
    }
    Ok(manifest)
}

/// Validate a manifest before trusting it to drive extraction: every entry
/// path must be a safe relative path (no traversal, not absolute, not the
/// manifest itself), paths must be unique, and a codeg backup must carry the
/// database. Rejects crafted manifests up front.
pub fn validate_manifest(manifest: &BackupManifest) -> Result<(), AppCommandError> {
    let mut seen = HashSet::new();
    for e in &manifest.entries {
        let p = Path::new(&e.path);
        let safe = !e.path.is_empty()
            && e.path != MANIFEST_ENTRY_NAME
            && !p.is_absolute()
            && p.components().all(|c| matches!(c, Component::Normal(_)));
        if !safe {
            return Err(corrupted_error());
        }
        if !seen.insert(e.path.as_str()) {
            return Err(corrupted_error());
        }
    }
    if !seen.contains("db/codeg.db") {
        return Err(corrupted_error());
    }
    // When the archive declares which sections it manages, its declaration and
    // its contents must agree: every entry has to sit under `db/`, `external/`,
    // or a declared section. Otherwise an archive could stage files into a
    // section it never claimed. Matched against the RAW declaration, not this
    // binary's table, so an archive from a newer build with an extra section
    // still validates — its unknown entries are simply never swapped in.
    if let Some(declared) = manifest.managed_sections.as_deref() {
        for e in &manifest.entries {
            let top = e.path.split('/').next().unwrap_or_default();
            let known = top == super::sections::DB_SECTION_PREFIX
                || top == super::sections::EXTERNAL_SECTION_PREFIX
                || declared.iter().any(|d| d == top);
            if !known {
                return Err(corrupted_error());
            }
        }
    }
    Ok(())
}

/// Extract entries into `dest_root`, with zip-slip protection (`enclosed_name`)
/// AND manifest-bounding: only files listed in `manifest` are extracted, and an
/// archive carrying any *unlisted* file entry is rejected. Combined with
/// [`verify_checksums`], this guarantees the extracted set is exactly the
/// checksum-covered manifest set — a tampered payload cannot smuggle an
/// unverified `tokens.json`, `uploads/*`, or `external/*` file into staging.
pub fn extract_all(
    zip_path: &Path,
    dest_root: &Path,
    manifest: &BackupManifest,
    cancel: &CancellationToken,
    progress: &mut ProgressFn<'_>,
) -> Result<(), AppCommandError> {
    // path -> manifest-declared size, used to bound each entry's decompressed
    // output (a decompression bomb stops at the declared size + 1 and is
    // rejected, rather than filling the disk before checksum verification).
    let sizes: HashMap<&str, u64> = manifest.entries.iter().map(|e| (e.path.as_str(), e.size)).collect();
    let f = File::open(zip_path).map_err(AppCommandError::io)?;
    let mut ar = ZipArchive::new(BufReader::new(f)).map_err(|_| unknown_format_error())?;
    let mut processed = 0u64;
    let mut seen: HashSet<String> = HashSet::new();
    for i in 0..ar.len() {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let mut entry = ar.by_index(i).map_err(zip_err)?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(AppCommandError::invalid_input(
                "Backup archive contains an unsafe path entry",
            ));
        };
        let rel_str = rel_to_slash(&rel);
        if rel_str == MANIFEST_ENTRY_NAME {
            continue;
        }
        if entry.is_dir() {
            continue;
        }
        // Reject any file not covered by the manifest (and thus not checksummed).
        let Some(&expected) = sizes.get(rel_str.as_str()) else {
            return Err(corrupted_error());
        };
        // Reject duplicate ZIP entries for the same logical path.
        if !seen.insert(rel_str.clone()) {
            return Err(corrupted_error());
        }
        let out = dest_root.join(&rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(AppCommandError::io)?;
        }
        let mut w = BufWriter::new(File::create(&out).map_err(AppCommandError::io)?);
        // Bound the decompressed output to the declared size (+1 to detect
        // overflow); `verify_checksums` then confirms the exact size + digest.
        let mut limited = entry.by_ref().take(expected + 1);
        let n = std::io::copy(&mut limited, &mut w).map_err(map_disk_full)?;
        w.flush().map_err(map_disk_full)?;
        if n > expected {
            return Err(corrupted_error());
        }
        processed += n;
        progress(&rel_str, processed);
    }
    Ok(())
}

/// Re-hash extracted files against the manifest. Any size or digest mismatch
/// (or missing file) is a corrupted-backup error.
pub fn verify_checksums(
    dest_root: &Path,
    manifest: &BackupManifest,
    cancel: &CancellationToken,
) -> Result<(), AppCommandError> {
    for e in &manifest.entries {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let p = dest_root.join(&e.path);
        let f = File::open(&p).map_err(|_| corrupted_error())?;
        let mut reader = BufReader::new(f);
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; COPY_BUF];
        let mut size = 0u64;
        loop {
            let n = reader.read(&mut buf).map_err(AppCommandError::io)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as u64;
        }
        if size != e.size || to_hex(&hasher.finalize()) != e.sha256 {
            return Err(corrupted_error());
        }
    }
    Ok(())
}

/// Convenience for callers that don't track progress.
pub fn null_progress() -> impl FnMut(&str, u64) {
    noop_progress
}

fn rel_to_slash(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn zip_err(e: zip::result::ZipError) -> AppCommandError {
    AppCommandError::io_error("ZIP archive operation failed").with_detail(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::backup::manifest::{BACKUP_FORMAT_VERSION, BACKUP_KIND};

    fn sample_manifest() -> BackupManifest {
        BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            kind: BACKUP_KIND.to_string(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            app_version: "0.15.0".to_string(),
            latest_migration: "m20260522_000001_delegation_columns".to_string(),
            runtime: "server".to_string(),
            includes_external_transcripts: false,
            includes_secrets: true,
            managed_sections: None,
            degraded_sqlite: Vec::new(),
            entries: Vec::new(),
        }
    }

    #[test]
    fn build_read_extract_verify_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("uploads/sub")).unwrap();
        std::fs::write(src.join("db.bin"), vec![1u8; 100_000]).unwrap();
        std::fs::write(src.join("uploads/a.txt"), b"hello").unwrap();
        std::fs::write(src.join("uploads/sub/b.txt"), b"world").unwrap();
        // An excluded file that must NOT make it into the archive.
        std::fs::create_dir_all(src.join("uploads/.tmp")).unwrap();
        std::fs::write(src.join("uploads/.tmp/skip.txt"), b"nope").unwrap();

        let zip_path = dir.path().join("backup.zip");
        let cancel = CancellationToken::new();
        let mut prog = null_progress();
        let mut b = ArchiveBuilder::create(&zip_path).unwrap();
        b.add_file("db/codeg.db", &src.join("db.bin"), &cancel, &mut prog)
            .unwrap();
        b.add_dir(
            "uploads",
            &src.join("uploads"),
            &|rel| rel.starts_with(".tmp"),
            &cancel,
            &mut prog,
        )
        .unwrap();
        let manifest = b.finish(sample_manifest()).unwrap();

        // Manifest captured 3 files, excluded the .tmp one.
        assert_eq!(manifest.entries.len(), 3);
        assert!(manifest
            .entries
            .iter()
            .all(|e| !e.path.contains(".tmp")));

        let reread = read_manifest(&zip_path).unwrap();
        assert_eq!(reread.entries.len(), 3);

        let out = dir.path().join("out");
        extract_all(&zip_path, &out, &reread, &cancel, &mut null_progress()).unwrap();
        assert_eq!(std::fs::read(out.join("uploads/a.txt")).unwrap(), b"hello");
        assert!(!out.join("manifest.json").exists());

        verify_checksums(&out, &reread, &cancel).unwrap();

        // Corrupt a file → verify must fail.
        std::fs::write(out.join("uploads/a.txt"), b"tampered").unwrap();
        assert!(verify_checksums(&out, &reread, &cancel).is_err());
    }

    #[test]
    fn extract_rejects_unmanifested_file() {
        // An archive whose payload carries a file the manifest doesn't list
        // (e.g. an injected tokens.json) must be rejected, not extracted
        // unverified.
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("tampered.zip");
        let cancel = CancellationToken::new();
        let src = dir.path().join("db.bin");
        std::fs::write(&src, b"db").unwrap();

        let mut b = ArchiveBuilder::create(&zip_path).unwrap();
        b.add_file("db/codeg.db", &src, &cancel, &mut null_progress())
            .unwrap();
        // Build a manifest that omits the smuggled entry, but write the entry
        // into the ZIP anyway (simulating a tampered payload).
        let mut manifest = b.finish(sample_manifest()).unwrap();
        // Re-open and append an unlisted entry.
        {
            use std::io::Write as _;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&zip_path)
                .unwrap();
            let mut w = zip::ZipWriter::new_append(file).unwrap();
            w.start_file("tokens.json", SimpleFileOptions::default())
                .unwrap();
            w.write_all(b"{\"stolen\":true}").unwrap();
            w.finish().unwrap();
        }
        // Manifest still lists only db/codeg.db.
        manifest.entries.retain(|e| e.path == "db/codeg.db");
        let out = dir.path().join("out");
        let err = extract_all(&zip_path, &out, &manifest, &cancel, &mut null_progress());
        assert!(err.is_err(), "unmanifested file must be rejected");
        assert!(!out.join("tokens.json").exists());
    }

    #[test]
    fn validate_manifest_rejects_traversal_dup_and_missing_db() {
        let mut m = sample_manifest();
        m.entries = vec![ManifestEntry {
            path: "db/codeg.db".into(),
            size: 1,
            sha256: "x".into(),
        }];
        assert!(validate_manifest(&m).is_ok());

        // Missing db.
        let mut m2 = sample_manifest();
        m2.entries = vec![ManifestEntry {
            path: "uploads/a".into(),
            size: 1,
            sha256: "x".into(),
        }];
        assert!(validate_manifest(&m2).is_err());

        // Traversal.
        let mut m3 = m.clone();
        m3.entries.push(ManifestEntry {
            path: "../escape".into(),
            size: 1,
            sha256: "x".into(),
        });
        assert!(validate_manifest(&m3).is_err());

        // Duplicate.
        let mut m4 = m.clone();
        m4.entries.push(ManifestEntry {
            path: "db/codeg.db".into(),
            size: 1,
            sha256: "y".into(),
        });
        assert!(validate_manifest(&m4).is_err());
    }
}
