//! A skill's package: the limits it is held to, the rules its paths follow,
//! fetching it and checking every byte of it.
//!
//! - **Limits** are `/config`'s (the numbers the catalog's own checks
//!   enforce), each capped by a ceiling of Codeg's so that a strange answer
//!   cannot make Codeg hold an unbounded package in memory.
//! - **Paths** follow the catalog's format rules (`api/harness/package.ts`):
//!   relative, `/`-separated, no `.` or `..` segment, no control character,
//!   no two the same ignoring case — and Codeg's own: every segment one plain
//!   entry name (no backslash, no drive or stream colon), not ending in a dot
//!   or a space (Windows would drop it and two paths would be one file), not
//!   a Windows device name (`CON`, `nul.txt`, `COM1`), and no file where
//!   another needs a folder.
//! - **Fetching**: the archive by its relative address on the catalog's
//!   origin (`Origin::join`, nothing else), its size and SHA-256 checked;
//!   without one, each file from `raw.githubusercontent.com` at the source
//!   commit. Both through the Harness client's rules (HTTPS, one host, the
//!   user's proxy, bounded reads).
//! - **Extracting** takes exactly the listed files — one more, one fewer, a
//!   link, a size or hash that is not the listed one, a file that unpacks
//!   far past its packed size: the whole package is refused. Everything
//!   stays in memory (the limits bound it) until the install stages it.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};
use std::time::Duration;

use futures::stream::{self, StreamExt, TryStreamExt};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::harness::client::{self, Expect, Incoming, Outgoing};
use crate::harness::error::HarnessError;
use crate::harness::mcp::model::Reason;
use crate::harness::types::{Archive, FileEntry, InstallInfo, Source};
use crate::harness::{Harness, Origin};

use super::model::{codes, PackageLimits};

/// Where the files of a package without an archive come from.
pub(crate) const RAW_ORIGIN: &str = "https://raw.githubusercontent.com";

/// How long one download may take: an archive is up to `zipBytes`, which a
/// slow connection does not move in the 30 s a JSON answer gets.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(180);
const FILE_TIMEOUT: Duration = Duration::from_secs(60);
/// Files fetched from the source at once.
const PARALLEL_FILES: usize = 6;
/// The most problems one package reports.
const MAX_ISSUES: usize = 50;

/// One file, as it will be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PackageFile {
    pub path: String,
    pub bytes: Vec<u8>,
    pub executable: bool,
}

// ─── Limits ─────────────────────────────────────────────────────────────

/// The catalog's own numbers (`api/harness/limits.ts`), for a `/config`
/// that leaves one out.
pub(crate) fn default_limits() -> PackageLimits {
    PackageLimits {
        zip_bytes: 10 * 1024 * 1024,
        total_bytes: 30 * 1024 * 1024,
        files: 500,
        file_bytes: 5 * 1024 * 1024,
        depth: 10,
        path_bytes: 512,
        compression_min_bytes: 1024 * 1024,
        compression_ratio: 100.0,
    }
}

/// Codeg's ceilings over whatever `/config` says.
fn ceilings() -> PackageLimits {
    PackageLimits {
        zip_bytes: 64 * 1024 * 1024,
        total_bytes: 256 * 1024 * 1024,
        files: 5_000,
        file_bytes: 64 * 1024 * 1024,
        depth: 32,
        path_bytes: 4_096,
        compression_min_bytes: 64 * 1024 * 1024,
        compression_ratio: 1_000.0,
    }
}

/// `/config`'s `limits`, each capped by Codeg's ceiling; a number it leaves
/// out (or that is not a positive number) is the catalog's default.
pub(crate) fn limits_from_config(config: &Value) -> PackageLimits {
    let limits = config.get("limits");
    let default = default_limits();
    let ceiling = ceilings();
    let int = |value: Option<&Value>, fallback: u64, cap: u64| -> u64 {
        value
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
            .unwrap_or(fallback)
            .min(cap)
    };
    let field = |name: &str| limits.and_then(|limits| limits.get(name));
    let compression = field("compression");
    PackageLimits {
        zip_bytes: int(field("zipBytes"), default.zip_bytes, ceiling.zip_bytes),
        total_bytes: int(
            field("totalBytes"),
            default.total_bytes,
            ceiling.total_bytes,
        ),
        files: int(field("files"), default.files, ceiling.files),
        file_bytes: int(field("fileBytes"), default.file_bytes, ceiling.file_bytes),
        depth: int(field("depth"), default.depth, ceiling.depth),
        path_bytes: int(field("pathBytes"), default.path_bytes, ceiling.path_bytes),
        compression_min_bytes: int(
            compression.and_then(|c| c.get("minBytes")),
            default.compression_min_bytes,
            ceiling.compression_min_bytes,
        ),
        compression_ratio: compression
            .and_then(|c| c.get("ratio"))
            .and_then(Value::as_f64)
            .filter(|ratio| ratio.is_finite() && *ratio >= 1.0)
            .unwrap_or(default.compression_ratio)
            .min(ceiling.compression_ratio),
    }
}

// ─── Paths and the file list ────────────────────────────────────────────

/// Whether `text` is a SHA-256 as the catalog writes it.
pub(crate) fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A Windows device name (`CON`, `nul.txt`, `COM1`, …): writing to one
/// writes to the device, not a file.
fn device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

fn safe_segment(segment: &str) -> bool {
    crate::skills::fsio::plain_name(segment)
        && !segment.ends_with(['.', ' '])
        && !segment.chars().any(char::is_control)
        && !device_name(segment)
}

/// Whether `path` is one the package may hold (see the module docs).
pub(crate) fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path.split('/').all(safe_segment)
}

fn with_path(code: &str, path: &str) -> Reason {
    Reason::new(code).param("path", path)
}

/// Everything wrong with a package that its install info alone shows: the
/// file list against the limits and the path rules, the archive's address,
/// size and hash, or — without an archive — the source.
pub(crate) fn check_listing(
    info: &InstallInfo,
    origin: &Origin,
    limits: &PackageLimits,
) -> Vec<Reason> {
    check_listing_of(info, origin, limits, true)
}

/// [`check_listing`] for a package that need not be one skill (a plugin's
/// folder: no `SKILL.md` at its root).
pub(crate) fn check_folder_listing(
    info: &InstallInfo,
    origin: &Origin,
    limits: &PackageLimits,
) -> Vec<Reason> {
    check_listing_of(info, origin, limits, false)
}

fn check_listing_of(
    info: &InstallInfo,
    origin: &Origin,
    limits: &PackageLimits,
    skill_md: bool,
) -> Vec<Reason> {
    let mut out = Vec::new();
    match (&info.archive, &info.source) {
        (Some(archive), _) => check_archive(archive, origin, limits, &mut out),
        (None, Some(source)) => check_source(source, &mut out),
        (None, None) => out.push(Reason::new(
            crate::harness::mcp::model::codes::NOTHING_TO_INSTALL,
        )),
    }
    check_files(&info.files, limits, skill_md, &mut out);
    out.truncate(MAX_ISSUES);
    out
}

fn check_archive(
    archive: &Archive,
    origin: &Origin,
    limits: &PackageLimits,
    out: &mut Vec<Reason>,
) {
    if origin.join(&archive.url).is_err() {
        out.push(Reason::new(codes::ARCHIVE_ADDRESS_INVALID));
    }
    if !is_sha256(&archive.sha256) {
        out.push(Reason::new(codes::HASH_INVALID).param("path", ""));
    }
    if archive.size > limits.zip_bytes {
        out.push(
            Reason::new(codes::ARCHIVE_TOO_LARGE)
                .param("size", archive.size.to_string())
                .param("limit", limits.zip_bytes.to_string()),
        );
    }
}

/// A GitHub `owner/repo`.
fn is_repository(text: &str) -> bool {
    let Some((owner, repo)) = text.split_once('/') else {
        return false;
    };
    let owner_ok = !owner.is_empty()
        && owner.len() <= 39
        && !owner.starts_with('-')
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let repo_ok = !repo.is_empty()
        && repo.len() <= 100
        && repo != "."
        && repo != ".."
        && repo
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    owner_ok && repo_ok
}

/// A full commit id (SHA-1 or SHA-256 repositories), lowercase.
fn is_commit(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64)
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn source_folder(path: &str) -> Option<Vec<&str>> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return Some(Vec::new());
    }
    safe_path(trimmed).then(|| trimmed.split('/').collect())
}

fn check_source(source: &Source, out: &mut Vec<Reason>) {
    if !is_repository(&source.repository) {
        out.push(Reason::new(codes::SOURCE_INVALID).param("field", "repository"));
    }
    if !is_commit(&source.commit) {
        out.push(Reason::new(codes::SOURCE_INVALID).param("field", "commit"));
    }
    if source_folder(&source.path).is_none() {
        out.push(Reason::new(codes::SOURCE_INVALID).param("field", "path"));
    }
}

fn check_files(files: &[FileEntry], limits: &PackageLimits, skill_md: bool, out: &mut Vec<Reason>) {
    if files.len() as u64 > limits.files {
        out.push(
            Reason::new(codes::TOO_MANY_FILES)
                .param("count", files.len().to_string())
                .param("limit", limits.files.to_string()),
        );
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut total: u64 = 0;
    for file in files {
        let path = file.path.as_str();
        if !safe_path(path) {
            out.push(with_path(codes::UNSAFE_PATH, path));
            continue;
        }
        if !seen.insert(path.to_lowercase()) {
            out.push(with_path(codes::DUPLICATE_PATH, path));
            continue;
        }
        if !is_sha256(&file.sha256) {
            out.push(with_path(codes::HASH_INVALID, path));
        }
        let depth = path.split('/').count() as u64 - 1;
        if depth > limits.depth {
            out.push(with_path(codes::TOO_DEEP, path).param("limit", limits.depth.to_string()));
        }
        if path.len() as u64 > limits.path_bytes {
            out.push(
                with_path(codes::PATH_TOO_LONG, path).param("limit", limits.path_bytes.to_string()),
            );
        }
        if file.size > limits.file_bytes {
            out.push(
                with_path(codes::FILE_TOO_LARGE, path)
                    .param("size", file.size.to_string())
                    .param("limit", limits.file_bytes.to_string()),
            );
        }
        total = total.saturating_add(file.size);
    }
    // A file where another one needs a folder of that name.
    for file in files {
        let folded = file.path.to_lowercase();
        let mut prefix = String::new();
        let segments: Vec<&str> = folded.split('/').collect();
        for segment in &segments[..segments.len().saturating_sub(1)] {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            if files
                .iter()
                .any(|other| other.path.to_lowercase() == prefix)
            {
                out.push(with_path(codes::DUPLICATE_PATH, &file.path));
                break;
            }
        }
    }
    if total > limits.total_bytes {
        out.push(
            Reason::new(codes::PACKAGE_TOO_LARGE)
                .param("size", total.to_string())
                .param("limit", limits.total_bytes.to_string()),
        );
    }
    if skill_md && !files.iter().any(|file| file.path == "SKILL.md") {
        out.push(Reason::new(codes::SKILL_MD_MISSING));
    }
}

// ─── Fetching ───────────────────────────────────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Fetch and check the package. `Ok(Err(issues))`: it is not what its
/// install info says (nothing is kept); `Err`: the catalog or the source
/// host could not be asked. The listing is checked first
/// ([`check_listing`]); call this only when that found nothing.
pub(crate) async fn fetch(
    harness: &Harness,
    raw_origin: &Origin,
    info: &InstallInfo,
    limits: &PackageLimits,
) -> Result<Result<Vec<PackageFile>, Vec<Reason>>, HarnessError> {
    match (&info.archive, &info.source) {
        (Some(archive), _) => {
            let bytes = match fetch_archive(harness, archive).await? {
                Ok(bytes) => bytes,
                Err(issue) => return Ok(Err(vec![issue])),
            };
            let files = info.files.clone();
            let limits = limits.clone();
            let extracted = tokio::task::spawn_blocking(move || extract(&bytes, &files, &limits))
                .await
                .map_err(|e| HarnessError::invalid_response(format!("extraction: {e}")))?;
            Ok(extracted)
        }
        (None, Some(source)) => fetch_from_source(harness, raw_origin, source, &info.files).await,
        (None, None) => Ok(Err(vec![Reason::new(
            crate::harness::mcp::model::codes::NOTHING_TO_INSTALL,
        )])),
    }
}

async fn fetch_archive(
    harness: &Harness,
    archive: &Archive,
) -> Result<Result<Vec<u8>, Reason>, HarnessError> {
    let url = harness.origin.join(&archive.url)?;
    let answer = client::send(
        &harness.origin,
        harness.backoff,
        ARCHIVE_TIMEOUT,
        Outgoing {
            url: &url,
            expect: Expect::File,
            cap: archive.size,
            if_none_match: None,
            json_body: None,
            idempotent: true,
        },
    )
    .await;
    let body = match answer {
        Ok(Incoming::Body { body, .. }) => body,
        Ok(Incoming::NotModified { .. }) => {
            return Err(HarnessError::invalid_response(
                "a 304 to a request that offered no ETag",
            ))
        }
        Err(HarnessError::TooLarge) => {
            return Ok(Err(Reason::new(codes::ARCHIVE_SIZE_MISMATCH)
                .param("expected", archive.size.to_string())
                .param("actual", format!("> {}", archive.size))))
        }
        Err(error) => return Err(error),
    };
    if body.len() as u64 != archive.size {
        return Ok(Err(Reason::new(codes::ARCHIVE_SIZE_MISMATCH)
            .param("expected", archive.size.to_string())
            .param("actual", body.len().to_string())));
    }
    if sha256_hex(&body) != archive.sha256 {
        return Ok(Err(Reason::new(codes::ARCHIVE_HASH_MISMATCH)));
    }
    Ok(Ok(body))
}

/// Take the listed files out of the archive `bytes`, each checked.
pub(crate) fn extract(
    bytes: &[u8],
    files: &[FileEntry],
    limits: &PackageLimits,
) -> Result<Vec<PackageFile>, Vec<Reason>> {
    let listed: BTreeMap<&str, &FileEntry> = files.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| vec![Reason::new(codes::ARCHIVE_UNREADABLE).detail(e.to_string())])?;
    // Folders may have entries of their own; anything past this is not a
    // package of `files.len()` files.
    let most_entries = (files.len() as u64)
        .saturating_mul(2)
        .saturating_add(64)
        .min(limits.files.saturating_mul(2).saturating_add(64));
    if archive.len() as u64 > most_entries {
        return Err(vec![Reason::new(codes::TOO_MANY_FILES)
            .param("count", archive.len().to_string())
            .param("limit", limits.files.to_string())]);
    }
    let mut issues: Vec<Reason> = Vec::new();
    let mut out: BTreeMap<String, PackageFile> = BTreeMap::new();
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        if issues.len() >= MAX_ISSUES {
            break;
        }
        let mut entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(error) => {
                issues.push(Reason::new(codes::ARCHIVE_UNREADABLE).detail(error.to_string()));
                break;
            }
        };
        let name = entry.name().to_string();
        let special = entry.is_symlink()
            || entry
                .unix_mode()
                .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000));
        if special {
            issues.push(with_path(codes::LINK_IN_ARCHIVE, &name));
            continue;
        }
        if entry.is_dir() {
            continue;
        }
        let Some(file) = listed.get(name.as_str()) else {
            issues.push(with_path(codes::FILE_UNEXPECTED, &name));
            continue;
        };
        if out.contains_key(&name) {
            issues.push(with_path(codes::FILE_UNEXPECTED, &name));
            continue;
        }
        if entry.size() != file.size {
            issues.push(
                with_path(codes::FILE_SIZE_MISMATCH, &name)
                    .param("expected", file.size.to_string()),
            );
            continue;
        }
        let packed = entry.compressed_size();
        if file.size > limits.compression_min_bytes
            && file.size as f64 > limits.compression_ratio * packed as f64
        {
            issues.push(
                with_path(codes::COMPRESSION_RATIO, &name)
                    .param("limit", limits.compression_ratio.to_string()),
            );
            continue;
        }
        let mut data = Vec::with_capacity(file.size.min(limits.file_bytes) as usize);
        if let Err(error) = entry.by_ref().take(file.size + 1).read_to_end(&mut data) {
            issues.push(with_path(codes::ARCHIVE_UNREADABLE, &name).detail(error.to_string()));
            continue;
        }
        if data.len() as u64 != file.size {
            issues.push(
                with_path(codes::FILE_SIZE_MISMATCH, &name)
                    .param("expected", file.size.to_string()),
            );
            continue;
        }
        if sha256_hex(&data) != file.sha256 {
            issues.push(with_path(codes::FILE_HASH_MISMATCH, &name));
            continue;
        }
        total = total.saturating_add(data.len() as u64);
        if total > limits.total_bytes {
            issues.push(
                Reason::new(codes::PACKAGE_TOO_LARGE)
                    .param("size", total.to_string())
                    .param("limit", limits.total_bytes.to_string()),
            );
            break;
        }
        out.insert(
            name.clone(),
            PackageFile {
                path: name,
                bytes: data,
                executable: file.executable,
            },
        );
    }
    for file in files {
        if issues.len() >= MAX_ISSUES {
            break;
        }
        if !out.contains_key(&file.path)
            && !issues
                .iter()
                .any(|issue| issue.params.get("path") == Some(&file.path))
        {
            issues.push(with_path(codes::FILE_MISSING, &file.path));
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(files
        .iter()
        .filter_map(|file| out.remove(&file.path))
        .collect())
}

/// The address of `file` in `source` on the raw host.
fn raw_url(raw_origin: &Origin, source: &Source, file: &str) -> Option<reqwest::Url> {
    let (owner, repo) = source.repository.split_once('/')?;
    let folder = source_folder(&source.path)?;
    let mut url = reqwest::Url::parse(raw_origin.as_str()).ok()?;
    {
        let mut segments = url.path_segments_mut().ok()?;
        segments.clear();
        segments.push(owner).push(repo).push(&source.commit);
        for segment in folder {
            segments.push(segment);
        }
        for segment in file.split('/') {
            segments.push(segment);
        }
    }
    raw_origin.holds(&url).then_some(url)
}

pub(crate) async fn fetch_from_source(
    harness: &Harness,
    raw_origin: &Origin,
    source: &Source,
    files: &[FileEntry],
) -> Result<Result<Vec<PackageFile>, Vec<Reason>>, HarnessError> {
    let fetched: Vec<Result<PackageFile, Reason>> = stream::iter(files.iter().cloned())
        .map(|file| async move {
            let Some(url) = raw_url(raw_origin, source, &file.path) else {
                return Ok(Err(with_path(codes::UNSAFE_PATH, &file.path)));
            };
            let answer = client::send(
                raw_origin,
                harness.backoff,
                FILE_TIMEOUT,
                Outgoing {
                    url: &url,
                    expect: Expect::File,
                    cap: file.size,
                    if_none_match: None,
                    json_body: None,
                    idempotent: true,
                },
            )
            .await;
            let body = match answer {
                Ok(Incoming::Body { body, .. }) => body,
                Ok(Incoming::NotModified { .. }) => {
                    return Err(HarnessError::invalid_response(
                        "a 304 to a request that offered no ETag",
                    ))
                }
                Err(HarnessError::NotFound) => {
                    return Ok(Err(with_path(codes::SOURCE_FILE_UNAVAILABLE, &file.path)))
                }
                Err(HarnessError::TooLarge) => {
                    return Ok(Err(with_path(codes::FILE_SIZE_MISMATCH, &file.path)
                        .param("expected", file.size.to_string())))
                }
                Err(error) => return Err(error),
            };
            if body.len() as u64 != file.size {
                return Ok(Err(with_path(codes::FILE_SIZE_MISMATCH, &file.path)
                    .param("expected", file.size.to_string())));
            }
            if sha256_hex(&body) != file.sha256 {
                return Ok(Err(with_path(codes::FILE_HASH_MISMATCH, &file.path)));
            }
            Ok(Ok(PackageFile {
                path: file.path.clone(),
                bytes: body,
                executable: file.executable,
            }))
        })
        .buffered(PARALLEL_FILES)
        .try_collect()
        .await?;
    let mut issues = Vec::new();
    let mut out = Vec::new();
    for result in fetched {
        match result {
            Ok(file) => out.push(file),
            Err(issue) => issues.push(issue),
        }
    }
    issues.truncate(MAX_ISSUES);
    if issues.is_empty() {
        Ok(Ok(out))
    } else {
        Ok(Err(issues))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_relative_plain_and_writable_everywhere() {
        for good in [
            "SKILL.md",
            "scripts/run.sh",
            "a/b/c.txt",
            "con-fig.md",
            "COM10.txt",
            ".hidden",
        ] {
            assert!(safe_path(good), "{good}");
        }
        for bad in [
            "",
            "/abs",
            "../up",
            "a/../b",
            "a/./b",
            "a//b",
            "a\\b",
            "C:x",
            "a/b:stream",
            "trailing.",
            "space ",
            "CON",
            "nul.txt",
            "Com1",
            "lpt9.log",
            "a/\u{7}bell",
        ] {
            assert!(!safe_path(bad), "{bad:?}");
        }
    }
}
