use axum::extract::Multipart;
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::app_error::{
    AppCommandError, UPLOAD_I18N_KEY_QUOTA_EXCEEDED, UPLOAD_I18N_KEY_TOO_LARGE,
};
use crate::commands::folders as folder_commands;
use crate::paths::{codeg_uploads_root, simplify_verbatim_path};

use super::upload_jail;

const UPLOAD_FILENAME_MAX_CHARS: usize = 120;
const UPLOAD_COLLISION_SUFFIX_ATTEMPTS: usize = 999;
const UPLOAD_UUID_FALLBACK_ATTEMPTS: usize = 16;

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFilePreviewParams {
    pub root_path: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileBase64Params {
    pub path: String,
    pub max_bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileBase64Params {
    pub root_path: String,
    pub path: String,
    pub max_bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileForEditParams {
    pub root_path: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileContentParams {
    pub root_path: String,
    pub path: String,
    pub content: String,
    pub expected_etag: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileCopyParams {
    pub root_path: String,
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFileTreeEntryParams {
    pub root_path: String,
    pub path: String,
    pub new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveFileTreeEntryParams {
    pub root_path: String,
    pub source_path: String,
    pub dest_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFileTreeEntryParams {
    pub root_path: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileTreeEntryParams {
    pub root_path: String,
    pub path: String,
    pub name: String,
    pub kind: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn read_file_preview(
    Json(params): Json<ReadFilePreviewParams>,
) -> Result<Json<folder_commands::FilePreviewContent>, AppCommandError> {
    let result = folder_commands::read_file_preview(params.root_path, params.path).await?;
    Ok(Json(result))
}

pub async fn read_file_base64(
    Json(params): Json<ReadFileBase64Params>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::read_file_base64(params.path, params.max_bytes).await?;
    Ok(Json(result))
}

pub async fn read_workspace_file_base64(
    Json(params): Json<ReadWorkspaceFileBase64Params>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::read_workspace_file_base64(
        params.root_path,
        params.path,
        params.max_bytes,
    )
    .await?;
    Ok(Json(result))
}

pub async fn read_file_for_edit(
    Json(params): Json<ReadFileForEditParams>,
) -> Result<Json<folder_commands::FileEditContent>, AppCommandError> {
    let result = folder_commands::read_file_for_edit(params.root_path, params.path).await?;
    Ok(Json(result))
}

pub async fn save_file_content(
    Json(params): Json<SaveFileContentParams>,
) -> Result<Json<folder_commands::FileSaveResult>, AppCommandError> {
    let result = folder_commands::save_file_content(
        params.root_path,
        params.path,
        params.content,
        params.expected_etag,
    )
    .await?;
    Ok(Json(result))
}

pub async fn save_file_copy(
    Json(params): Json<SaveFileCopyParams>,
) -> Result<Json<folder_commands::FileSaveResult>, AppCommandError> {
    let result =
        folder_commands::save_file_copy(params.root_path, params.path, params.content).await?;
    Ok(Json(result))
}

pub async fn rename_file_tree_entry(
    Json(params): Json<RenameFileTreeEntryParams>,
) -> Result<Json<String>, AppCommandError> {
    let result =
        folder_commands::rename_file_tree_entry(params.root_path, params.path, params.new_name)
            .await?;
    Ok(Json(result))
}

pub async fn move_file_tree_entry(
    Json(params): Json<MoveFileTreeEntryParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::move_file_tree_entry(
        params.root_path,
        params.source_path,
        params.dest_dir,
    )
    .await?;
    Ok(Json(result))
}

pub async fn delete_file_tree_entry(
    Json(params): Json<DeleteFileTreeEntryParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::delete_file_tree_entry(params.root_path, params.path).await?;
    Ok(Json(()))
}

pub async fn create_file_tree_entry(
    Json(params): Json<CreateFileTreeEntryParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::create_file_tree_entry(
        params.root_path,
        params.path,
        params.name,
        params.kind,
    )
    .await?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Attachment upload
// ---------------------------------------------------------------------------

/// Hard cap on a single uploaded attachment.
///
/// This is the user-facing attachment ceiling for web / remote-workspace mode,
/// and for a desktop paste with no file behind it (`store_attachment_bytes`);
/// oversize is rejected with a visible toast. It is sized to match the desktop
/// drag-drop image limit (`DRAG_DROP_IMAGE_MAX_BYTES`, 20 MB) so the same
/// screenshot attaches in every mode. Uploaded images are re-inlined into the
/// prompt server-side (`acp::prompt_hydration`), so this also bounds that
/// read-back. The handler streams to disk chunk-by-chunk, so raising the cap
/// does not change peak memory. The chunk-summing check inside the streaming
/// loop is the authoritative boundary; the route's `DefaultBodyLimit` (this
/// value + 64 KiB of multipart overhead, see `router.rs`) rejects grossly
/// oversized bodies before they stream.
///
/// Mirrored by `UPLOAD_MAX_BYTES` in `commands/remote_proxy.rs` and
/// `src/lib/api.ts` — keep the three in lockstep. The docs site also states
/// this cap (Storage limits,
/// <https://docs.codeg.app/getting-started/configuration#storage-limits>, in
/// English and Chinese); update it there whenever the value changes.
pub const UPLOAD_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Env-controlled cap on the *total* bytes resident under
/// `uploads_root/`. Per-file `UPLOAD_MAX_BYTES` bounds one payload; this
/// bounds long-term accumulation so a compromised or shared token can't
/// repeatedly upload small files until the host runs out of disk. Unset
/// or `0` disables the cap — preserves the original "no GC" behavior
/// for operators who want it.
///
/// The check is intentionally conservative: it fires before any bytes
/// are streamed to disk, assuming the worst-case `UPLOAD_MAX_BYTES`.
/// That over-rejects in the last `UPLOAD_MAX_BYTES` of headroom (e.g. a
/// 100 KB upload may get rejected when only 1 MB remains under the
/// cap), but it keeps the code free of mid-stream cleanup races. With
/// the in-flight reservation (see `UPLOAD_IN_FLIGHT_BYTES` below) this
/// is effectively a hard ceiling: concurrent admits cannot accumulate
/// past `cap` because each one decrements the in-flight headroom seen
/// by the next.
const UPLOAD_TOTAL_BYTES_ENV: &str = "CODEG_UPLOAD_MAX_TOTAL_BYTES";

/// Opt-in fail-closed mode for the quota config. When truthy and
/// `CODEG_UPLOAD_MAX_TOTAL_BYTES` parses as `Invalid`, startup aborts
/// with a `FATAL` line instead of falling through to fail-open. Default
/// (unset / "0" / "false") preserves the prior fail-open posture so a
/// typo doesn't take down a production process unless the operator
/// explicitly asks for that behavior.
const UPLOAD_STRICT_ENV: &str = "CODEG_UPLOAD_QUOTA_STRICT";

/// Outcome of parsing `CODEG_UPLOAD_MAX_TOTAL_BYTES`. Carries enough
/// context that the startup banner can distinguish "operator turned it
/// off" from "operator typo silently disabled the cap".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadQuotaConfig {
    /// Env var unset; cap disabled by default.
    Unset,
    /// Env var present but `0` (or only whitespace); cap explicitly off.
    Disabled,
    /// Cap active at this many bytes.
    Enabled(u64),
    /// Env var was set to a value we could not parse as a positive
    /// `u64`. Carries the offending raw value so the operator gets a
    /// loud error mentioning the exact string they typed. Cap is *off*
    /// in this branch — we choose availability over safety here so a
    /// typo doesn't 5xx the upload endpoint, but the startup WARN line
    /// makes the failure mode discoverable.
    Invalid(String),
}

impl UploadQuotaConfig {
    /// Active cap, if any. Returns `None` for `Unset`, `Disabled`, and
    /// `Invalid` — all three mean "no quota enforcement this run".
    pub fn cap_bytes(&self) -> Option<u64> {
        match self {
            UploadQuotaConfig::Enabled(c) => Some(*c),
            _ => None,
        }
    }
}

/// Pure-function form of the env parser so unit tests don't need to
/// mutate process-global state (which would race the test harness's
/// concurrent runner).
fn parse_upload_quota_config(raw: Option<&str>) -> UploadQuotaConfig {
    let Some(s) = raw else {
        return UploadQuotaConfig::Unset;
    };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        // Empty / whitespace-only is treated the same as unset rather
        // than as a typo — common in `docker run -e VAR= ...` and not
        // worth shouting about.
        return UploadQuotaConfig::Unset;
    }
    match trimmed.parse::<u64>() {
        Ok(0) => UploadQuotaConfig::Disabled,
        Ok(n) => UploadQuotaConfig::Enabled(n),
        Err(_) => UploadQuotaConfig::Invalid(trimmed.to_string()),
    }
}

fn upload_quota_config_from_env() -> UploadQuotaConfig {
    parse_upload_quota_config(std::env::var(UPLOAD_TOTAL_BYTES_ENV).ok().as_deref())
}

/// Truthy boolean parse for env-var flags. Accepts `1 / true / yes /
/// on` (case-insensitive, trim-tolerant). Everything else — including
/// `0`, `false`, empty, unset — returns `false`. Lives next to the
/// quota parser so the two share the same testability story.
fn parse_strict_mode(raw: Option<&str>) -> bool {
    let Some(s) = raw else { return false };
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn upload_quota_strict_from_env() -> bool {
    parse_strict_mode(std::env::var(UPLOAD_STRICT_ENV).ok().as_deref())
}

/// Reason a strict-mode validation rejected the current quota
/// configuration. Lets callers (server `main`, desktop web start)
/// decide how to react — kill the process or surface a UI error.
#[derive(Debug, Clone)]
pub struct UploadQuotaStrictError {
    /// The raw env value that failed to parse, for inclusion in the
    /// operator-facing message.
    pub raw_value: String,
}

impl std::fmt::Display for UploadQuotaStrictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{UPLOAD_TOTAL_BYTES_ENV}={:?} is not a positive integer and {UPLOAD_STRICT_ENV} is on",
            self.raw_value
        )
    }
}

impl std::error::Error for UploadQuotaStrictError {}

/// Emit a startup banner describing the current upload-quota
/// configuration. Pure logging — no process abort, no return value —
/// so it is safe to call from any startup path (server, desktop web
/// service toggle, future test harness) without surprising side
/// effects.
///
/// The strict-mode abort lives in `validate_upload_quota_config`. The
/// split exists because the server binary should die on strict+invalid
/// while the desktop must keep running and surface a UI error instead.
///
/// Called once from each binary entry point right after the data
/// directory and listener are resolved. Cheap: two env reads + one
/// `eprintln!`.
pub fn log_upload_quota_config_at_startup() {
    let config = upload_quota_config_from_env();
    let strict = upload_quota_strict_from_env();
    match &config {
        UploadQuotaConfig::Unset => {
            tracing::info!(
                "[uploads] {UPLOAD_TOTAL_BYTES_ENV} unset → total-size cap disabled (set to a byte count to enable)"
            );
        }
        UploadQuotaConfig::Disabled => {
            tracing::info!("[uploads] {UPLOAD_TOTAL_BYTES_ENV}=0 → total-size cap disabled");
        }
        UploadQuotaConfig::Enabled(cap) => {
            tracing::info!("[uploads] total-size cap: {cap} bytes ({UPLOAD_TOTAL_BYTES_ENV})");
        }
        UploadQuotaConfig::Invalid(raw) => {
            if strict {
                // Caller will abort via `validate_upload_quota_config`;
                // here we only narrate so the FATAL line lands in
                // operator logs alongside the rest of the banner.
                tracing::error!(
                    "[uploads][FATAL] {UPLOAD_TOTAL_BYTES_ENV}={raw:?} is not a positive integer \
                     and {UPLOAD_STRICT_ENV} is on. Caller will abort startup. \
                     Use a plain decimal byte count (e.g. 10737418240 for 10 GiB)."
                );
            } else {
                tracing::warn!(
                    "[uploads][WARN] {UPLOAD_TOTAL_BYTES_ENV}={raw:?} is not a positive integer; \
                     total-size cap is DISABLED. Use a plain decimal byte count (e.g. 10737418240 for 10 GiB), \
                     or set {UPLOAD_STRICT_ENV}=1 to abort startup on this condition."
                );
            }
        }
    }
}

/// Strict-mode validation: returns `Err` when `CODEG_UPLOAD_QUOTA_STRICT`
/// is truthy and the quota value is `Invalid`. Every other combination
/// (unset, disabled, enabled, or invalid-but-strict-off) returns `Ok`.
///
/// Callers choose the failure mode:
///   * `codeg-server` (single-purpose process) — call early in `main`
///     and `process::exit(2)` on `Err`.
///   * Desktop web-service start — call before `persist_web_service_config`
///     and surface `Err` as an `AppCommandError` so the toggle fails
///     cleanly without taking down the host process.
pub fn validate_upload_quota_config() -> Result<(), UploadQuotaStrictError> {
    let config = upload_quota_config_from_env();
    let strict = upload_quota_strict_from_env();
    match config {
        UploadQuotaConfig::Invalid(raw) if strict => Err(UploadQuotaStrictError { raw_value: raw }),
        _ => Ok(()),
    }
}

/// Running tally of bytes reserved by `upload_attachment` calls that
/// have passed the quota check but haven't yet finished writing or
/// failed. Combined with `current_uploads_total_bytes` on disk, this
/// closes the TOCTOU race where two concurrent uploads both saw the
/// same disk-level free space and admitted past the cap.
///
/// Reservation strategy: each upload reserves the worst case
/// (`UPLOAD_MAX_BYTES`) up front and releases it on guard drop.
/// Over-reservation is acceptable — the operator-facing budget is the
/// disk, not the counter — and a uniform reservation size keeps the
/// CAS loop and the cleanup path symmetric.
///
/// **Scope:** this counter is process-local. Multiple `codeg-server`
/// processes sharing the same `uploads_root` (horizontally-scaled
/// deployments mounted on the same volume) will each maintain their
/// own counter and can collectively exceed the cap. codeg is designed
/// for single-process deployments; multi-process coordination would
/// require an external mechanism (file lock, Redis, reverse-proxy
/// quota) that this codebase does not provide. See the doc on
/// `paths::codeg_uploads_root` for the operator-facing version of
/// this contract.
static UPLOAD_IN_FLIGHT_BYTES: AtomicU64 = AtomicU64::new(0);

/// RAII guard returned by `try_reserve_in_flight`. Releases the
/// reservation on drop, including the error and panic paths in
/// `upload_attachment`.
struct InFlightGuard<'a> {
    counter: &'a AtomicU64,
    bytes: u64,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        // `AcqRel` here pairs with the `Acquire` load and `AcqRel` CAS
        // in `try_reserve_in_flight` so the next reservation sees the
        // post-decrement value.
        self.counter.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

/// Lock-free CAS reserve against `counter`. Returns `Ok(guard)` if the
/// reservation fits inside `cap` given the current on-disk `used`, or
/// `Err(())` if the cap is full.
///
/// Takes the counter by reference (rather than reading the module-level
/// static) so the unit tests can drive it with a local atomic and run
/// concurrently without poisoning each other.
fn try_reserve_in_flight<'a>(
    counter: &'a AtomicU64,
    bytes: u64,
    used: u64,
    cap: u64,
) -> Result<InFlightGuard<'a>, ()> {
    let mut current = counter.load(Ordering::Acquire);
    loop {
        let projected = used.saturating_add(current).saturating_add(bytes);
        if projected > cap {
            return Err(());
        }
        match counter.compare_exchange_weak(
            current,
            current + bytes,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return Ok(InFlightGuard { counter, bytes }),
            Err(observed) => current = observed,
        }
    }
}

/// Sum the size of every regular file under `uploads_root/` except the
/// `.tmp/` staging directory. Walks at most one level of buckets — that
/// is the structure produced by `stream_and_finalize` — but the inner
/// walk follows whatever entries exist, so a hand-edited deeper tree
/// is still counted faithfully.
///
/// Failures during the walk are logged and skipped: a permission error
/// on one file shouldn't block the upload pipeline. The returned total
/// is a lower bound in that case, which means the cap may admit one
/// extra upload before tripping. That's strictly better than refusing
/// to serve.
async fn current_uploads_total_bytes(uploads_root: &std::path::Path) -> u64 {
    let mut total: u64 = 0;
    let mut bucket_iter = match tokio::fs::read_dir(uploads_root).await {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(e) => {
            tracing::error!(
                "[uploads] failed to enumerate uploads root {}: {}",
                uploads_root.display(),
                e
            );
            return 0;
        }
    };
    while let Some(entry) = bucket_iter.next_entry().await.transpose() {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::error!("[uploads] read_dir entry error: {e}");
                continue;
            }
        };
        let name = entry.file_name();
        if name == ".tmp" {
            // Staging files are unreferenced and purged at startup —
            // exclude them so a partial upload doesn't inflate the
            // counter and reject the very next request.
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_file() {
            // A loose file at the top level (legacy layout or admin
            // copy-in) still counts.
            if let Ok(meta) = entry.metadata().await {
                total = total.saturating_add(meta.len());
            }
            continue;
        }
        if !file_type.is_dir() {
            continue;
        }
        let mut file_iter = match tokio::fs::read_dir(entry.path()).await {
            Ok(it) => it,
            Err(_) => continue,
        };
        while let Some(f) = file_iter.next_entry().await.transpose() {
            let f = match f {
                Ok(f) => f,
                Err(_) => continue,
            };
            if let Ok(meta) = f.metadata().await {
                if meta.is_file() {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    total
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAttachmentResult {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime_type: Option<String>,
}

/// Sanitize a client-supplied filename so it lands inside the target
/// directory and contains no shell-hostile bytes.
///
/// Strategy: keep only the final path component, strip shell-hostile and
/// cross-platform-hostile characters, and bound the length. Leading dots are
/// preserved for real dotfiles, but all-dot names fall back to `file`.
fn sanitize_upload_filename(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| c.is_whitespace());
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned
        .trim_matches(|c: char| c.is_whitespace())
        .trim_end_matches('.');
    let limited = truncate_chars(trimmed, UPLOAD_FILENAME_MAX_CHARS);
    if limited.is_empty() || limited.chars().all(|c| c == '.') {
        "file".to_string()
    } else {
        limited
    }
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    input.chars().take(max_chars).collect()
}

fn split_upload_filename(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(dot_idx) if dot_idx > 0 => (&name[..dot_idx], &name[dot_idx..]),
        _ => (name, ""),
    }
}

fn upload_filename_with_stem_suffix(safe_name: &str, stem_suffix: &str) -> String {
    let (stem, ext) = split_upload_filename(safe_name);
    let suffix_chars = stem_suffix.chars().count();
    let ext_budget = UPLOAD_FILENAME_MAX_CHARS.saturating_sub(suffix_chars + 1);
    let ext_part = truncate_chars(ext, ext_budget);
    let stem_budget = UPLOAD_FILENAME_MAX_CHARS
        .saturating_sub(suffix_chars + ext_part.chars().count())
        .max(1);
    let stem_part = truncate_chars(stem, stem_budget);
    let stem_part = if stem_part.is_empty() || stem_part.chars().all(|c| c == '.') {
        "file".to_string()
    } else {
        stem_part
    };
    format!("{stem_part}{stem_suffix}{ext_part}")
}

fn upload_filename_candidate(safe_name: &str, collision_index: usize) -> String {
    if collision_index == 0 {
        safe_name.to_string()
    } else {
        upload_filename_with_stem_suffix(safe_name, &format!(" ({collision_index})"))
    }
}

fn upload_uuid_fallback_candidate(safe_name: &str) -> String {
    let unique = uuid::Uuid::new_v4().simple().to_string();
    upload_filename_with_stem_suffix(safe_name, &format!("-{unique}"))
}

async fn finalize_with_available_upload_name(
    tmp_dir: &std::path::Path,
    staging_name: &str,
    bucket_dir: &std::path::Path,
    safe_name: &str,
) -> Result<String, AppCommandError> {
    for collision_index in 0..=UPLOAD_COLLISION_SUFFIX_ATTEMPTS {
        let candidate = upload_filename_candidate(safe_name, collision_index);
        match upload_jail::finalize_into_bucket(tmp_dir, staging_name, bucket_dir, &candidate).await
        {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(
                    AppCommandError::io_error("Failed to move staged upload into place")
                        .with_detail(e.to_string()),
                );
            }
        }
    }

    for _ in 0..UPLOAD_UUID_FALLBACK_ATTEMPTS {
        let candidate = upload_uuid_fallback_candidate(safe_name);
        match upload_jail::finalize_into_bucket(tmp_dir, staging_name, bucket_dir, &candidate).await
        {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(
                    AppCommandError::io_error("Failed to move staged upload into place")
                        .with_detail(e.to_string()),
                );
            }
        }
    }

    Err(
        AppCommandError::io_error("Failed to choose an available upload filename")
            .with_detail(safe_name.to_string()),
    )
}

/// Sanitize a session identifier used as the upload bucket directory name.
///
/// Different semantics from filenames: a session id should never contain `.`
/// or whitespace, so reuse of `sanitize_upload_filename` would silently merge
/// distinct sessions whose ids degenerate to an empty string. Only allow
/// `[A-Za-z0-9_-]`; everything else collapses to `_`. Empty input falls back
/// to `"anon"`.
fn sanitize_session_bucket(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            c if c.is_ascii_alphanumeric() => c,
            '-' | '_' => c,
            _ => '_',
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    let limited: String = trimmed.chars().take(80).collect();
    if limited.is_empty() {
        "anon".to_string()
    } else {
        limited
    }
}

/// Confirm `candidate` resolves (after symlink expansion) inside `root`.
/// Returns the canonical path on success. Both paths must exist on disk.
async fn ensure_path_inside(
    candidate: &std::path::Path,
    root: &std::path::Path,
) -> Result<std::path::PathBuf, AppCommandError> {
    let candidate_canon = tokio::fs::canonicalize(candidate).await.map_err(|e| {
        AppCommandError::io_error("Failed to canonicalize upload path").with_detail(e.to_string())
    })?;
    let root_canon = tokio::fs::canonicalize(root).await.map_err(|e| {
        AppCommandError::io_error("Failed to canonicalize uploads root").with_detail(e.to_string())
    })?;
    if !candidate_canon.starts_with(&root_canon) {
        return Err(
            AppCommandError::io_error("Resolved upload path escapes uploads root")
                .with_detail(candidate_canon.to_string_lossy().to_string()),
        );
    }
    Ok(candidate_canon)
}

/// Remove any leftover staging files in `<uploads_root>/.tmp/`.
///
/// Called once at server startup. Staging files represent in-flight uploads
/// that were interrupted by a crash/restart — they are unreferenced by
/// definition and safe to drop. Distinct from the per-bucket history under
/// `<uploads_root>/<bucket>/`, which the user explicitly opted to retain.
///
/// Failures are logged and swallowed: a missing `.tmp/` directory is the
/// expected case on a fresh install, and permission issues should not block
/// the server from starting.
pub async fn purge_upload_staging() {
    let tmp_dir = codeg_uploads_root().join(".tmp");
    match tokio::fs::remove_dir_all(&tmp_dir).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::error!(
                "[uploads] failed to purge staging dir {}: {}",
                tmp_dir.display(),
                e
            );
        }
    }
}

/// Bytes to reserve against the total-quota in-flight counter for one upload.
///
/// The file's exact size isn't known until the multipart body is drained, but
/// the request's `Content-Length` is a hard upper bound on it (the multipart
/// framing only ever ADDS overhead, and hyper enforces the header as a body
/// framing limit). Reserving `min(Content-Length, UPLOAD_MAX_BYTES)` is
/// therefore always ≥ the bytes actually written — the streaming loop
/// independently caps the file at `UPLOAD_MAX_BYTES` — so the quota stays a
/// hard ceiling while a small upload only reserves its own size. This matters
/// for operators with `CODEG_UPLOAD_MAX_TOTAL_BYTES` below `UPLOAD_MAX_BYTES`:
/// a blanket worst-case reservation would reject every upload outright.
///
/// A missing/unparseable header (chunked transfer) falls back to the
/// worst-case reservation, which over-rejects near the cap but never
/// under-reserves.
fn upload_reservation_bytes(content_length: Option<u64>) -> u64 {
    content_length
        .map(|cl| cl.min(UPLOAD_MAX_BYTES))
        .unwrap_or(UPLOAD_MAX_BYTES)
}

pub async fn upload_attachment(
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<UploadAttachmentResult>, AppCommandError> {
    let uploads_root = prepare_uploads_root().await?;

    // Quota check, before staging any bytes. The reservation is bounded by
    // the request's Content-Length (see `upload_reservation_bytes`) so a
    // small upload fits a small quota; admitting a request we'd reject
    // mid-stream would waste disk and require cleanup races.
    //
    // The reservation guard (`_quota_guard`) is bound to a name so its
    // RAII drop runs at function exit, not immediately. Releasing it
    // on every exit path (success, multipart error, panic) closes the
    // TOCTOU window where two concurrent uploads both saw the same
    // disk-level `used` and admitted past the cap.
    let content_length = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    let _quota_guard =
        reserve_upload_quota(&uploads_root, upload_reservation_bytes(content_length)).await?;

    // Pre-stage the file under <uploads_root>/.tmp/<uuid>.part so we can
    // stream bytes to disk without knowing the final bucket up front (the
    // session_id form field may arrive after the file). On success we rename
    // into place; on any error we delete it.
    let (tmp_dir, staging_name) = prepare_upload_staging(&uploads_root).await?;

    // Wrap the streaming work so any early return cleans up the staged file.
    // Cleanup goes through `upload_jail::remove_staging_best_effort` so the
    // unlink itself can't be redirected by a swap of `.tmp` between
    // streaming and cleanup.
    let result = stream_and_finalize(&mut multipart, &uploads_root, &tmp_dir, &staging_name).await;
    if result.is_err() {
        upload_jail::remove_staging_best_effort(&tmp_dir, &staging_name).await;
    }
    // `_quota_guard` drops here regardless of `result`, releasing the
    // reservation for the next admission.
    result.map(Json)
}

/// Store an attachment whose bytes are already in memory: something pasted
/// into the desktop composer with no file behind it. It lands exactly where
/// and how [`upload_attachment`] puts a streamed one (same size cap, quota,
/// staging jail, session bucket and free-name choice), so the composer links
/// it like any other upload.
pub async fn store_attachment_bytes(
    file_name: &str,
    mime_type: Option<String>,
    session_id: Option<&str>,
    bytes: &[u8],
) -> Result<UploadAttachmentResult, AppCommandError> {
    let uploads_root = prepare_uploads_root().await?;
    store_attachment_bytes_in(&uploads_root, file_name, mime_type, session_id, bytes).await
}

/// [`store_attachment_bytes`] under an explicit, existing uploads root.
async fn store_attachment_bytes_in(
    uploads_root: &std::path::Path,
    file_name: &str,
    mime_type: Option<String>,
    session_id: Option<&str>,
    bytes: &[u8],
) -> Result<UploadAttachmentResult, AppCommandError> {
    let size = bytes.len() as u64;
    if size > UPLOAD_MAX_BYTES {
        return Err(upload_too_large(size));
    }
    // Held to the end, like `upload_attachment`'s.
    let _quota_guard = reserve_upload_quota(uploads_root, size).await?;
    let (tmp_dir, staging_name) = prepare_upload_staging(uploads_root).await?;
    let session_bucket = session_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(sanitize_session_bucket);
    let result = write_and_finalize(
        bytes,
        uploads_root,
        &tmp_dir,
        &staging_name,
        file_name,
        session_bucket,
        mime_type,
    )
    .await;
    if result.is_err() {
        upload_jail::remove_staging_best_effort(&tmp_dir, &staging_name).await;
    }
    result
}

/// The uploads root, created when missing: the jail checks canonicalize it,
/// which needs it on disk.
async fn prepare_uploads_root() -> Result<std::path::PathBuf, AppCommandError> {
    let uploads_root = codeg_uploads_root();
    tokio::fs::create_dir_all(&uploads_root)
        .await
        .map_err(|e| {
            AppCommandError::io_error("Failed to create uploads root").with_detail(e.to_string())
        })?;
    Ok(uploads_root)
}

/// Reserve `reserve` bytes of the `CODEG_UPLOAD_MAX_TOTAL_BYTES` quota, when
/// one is set. The caller holds the guard until the upload has settled.
async fn reserve_upload_quota(
    uploads_root: &std::path::Path,
    reserve: u64,
) -> Result<Option<InFlightGuard<'static>>, AppCommandError> {
    let Some(cap) = upload_quota_config_from_env().cap_bytes() else {
        return Ok(None);
    };
    let used = current_uploads_total_bytes(uploads_root).await;
    match try_reserve_in_flight(&UPLOAD_IN_FLIGHT_BYTES, reserve, used, cap) {
        Ok(guard) => Ok(Some(guard)),
        Err(()) => {
            let mut params = BTreeMap::new();
            params.insert("used".to_string(), used.to_string());
            params.insert("limit".to_string(), cap.to_string());
            Err(
                AppCommandError::io_error("Upload quota exceeded for this server")
                    .with_detail(format!("used={used} limit={cap}"))
                    .with_i18n(UPLOAD_I18N_KEY_QUOTA_EXCEEDED, params),
            )
        }
    }
}

/// The error for an attachment over [`UPLOAD_MAX_BYTES`], whichever layer
/// notices first; they all carry the same i18n key, so the toast reads alike.
pub(crate) fn upload_too_large(size: u64) -> AppCommandError {
    let mut params = BTreeMap::new();
    params.insert("size".to_string(), size.to_string());
    params.insert("limit".to_string(), UPLOAD_MAX_BYTES.to_string());
    AppCommandError::io_error("Upload exceeds the maximum allowed size")
        .with_detail(format!("size={size} limit={UPLOAD_MAX_BYTES}"))
        .with_i18n(UPLOAD_I18N_KEY_TOO_LARGE, params)
}

/// `<uploads_root>/.tmp`, created and checked to be a real directory inside
/// the root, and a fresh staging file name in it.
async fn prepare_upload_staging(
    uploads_root: &std::path::Path,
) -> Result<(std::path::PathBuf, String), AppCommandError> {
    let tmp_dir = uploads_root.join(".tmp");
    tokio::fs::create_dir_all(&tmp_dir).await.map_err(|e| {
        AppCommandError::io_error("Failed to create tmp directory").with_detail(e.to_string())
    })?;
    // Reject a symlinked `.tmp` for the same reason the bucket check
    // below rejects a symlinked bucket: `create_dir_all` is a no-op when
    // the target of a symlink already exists, so a pre-placed symlink
    // would let staged bytes land outside the uploads root before the
    // rename even runs (and a failed-stream cleanup would `remove_file`
    // outside the jail too).
    match tokio::fs::symlink_metadata(&tmp_dir).await {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(AppCommandError::io_error(
                "Refusing to use a symlinked uploads tmp directory",
            )
            .with_detail(tmp_dir.to_string_lossy().to_string()));
        }
        Ok(_) => {}
        Err(e) => {
            return Err(
                AppCommandError::io_error("Failed to inspect uploads tmp directory")
                    .with_detail(e.to_string()),
            );
        }
    }
    ensure_path_inside(&tmp_dir, uploads_root).await?;
    let staging_id = uuid::Uuid::new_v4().simple().to_string();
    Ok((tmp_dir, format!("{staging_id}.part")))
}

/// Write in-memory bytes to the staging file, then finalize them like a
/// streamed upload. The handle is closed before the move into the bucket.
async fn write_and_finalize(
    bytes: &[u8],
    uploads_root: &std::path::Path,
    tmp_dir: &std::path::Path,
    staging_name: &str,
    file_name: &str,
    session_bucket: Option<String>,
    mime_type: Option<String>,
) -> Result<UploadAttachmentResult, AppCommandError> {
    {
        let mut out = upload_jail::create_staging_file(tmp_dir, staging_name)
            .await
            .map_err(|e| {
                AppCommandError::io_error("Failed to create staging file")
                    .with_detail(e.to_string())
            })?;
        out.write_all(bytes).await.map_err(|e| {
            AppCommandError::io_error("Failed to write staging file").with_detail(e.to_string())
        })?;
        out.flush().await.map_err(|e| {
            AppCommandError::io_error("Failed to flush staging file").with_detail(e.to_string())
        })?;
    }
    finalize_staged_upload(
        uploads_root,
        tmp_dir,
        staging_name,
        Some(file_name),
        session_bucket,
        mime_type,
        bytes.len() as u64,
    )
    .await
}

/// Drain the multipart body and produce the final upload result. Splits out
/// of `upload_attachment` so a single staging-file cleanup wraps every early
/// return.
///
/// The staging file is created via `upload_jail::create_staging_file` so a
/// pre-placed symlink at `<tmp_dir>/<staging_name>` cannot redirect the
/// write outside the jail (Unix `O_NOFOLLOW`); the final move into the
/// bucket likewise goes through `upload_jail::finalize_into_bucket` which
/// uses `renameat` with NOFOLLOW dirfds so a concurrent swap of either
/// `tmp_dir` or `bucket` cannot land the file outside the root.
async fn stream_and_finalize(
    multipart: &mut Multipart,
    uploads_root: &std::path::Path,
    tmp_dir: &std::path::Path,
    staging_name: &str,
) -> Result<UploadAttachmentResult, AppCommandError> {
    let mut session_id: Option<String> = None;
    let mut raw_name: Option<String> = None;
    let mut mime_type: Option<String> = None;
    let mut written: u64 = 0;
    let mut file_seen = false;

    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        AppCommandError::io_error("Invalid multipart upload").with_detail(e.to_string())
    })? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "session_id" | "sessionId" => {
                let value = field.text().await.map_err(|e| {
                    AppCommandError::io_error("Failed to read session_id field")
                        .with_detail(e.to_string())
                })?;
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    session_id = Some(sanitize_session_bucket(trimmed));
                }
            }
            "file" => {
                if file_seen {
                    return Err(AppCommandError::io_error(
                        "Multiple `file` fields are not supported per request",
                    ));
                }
                file_seen = true;
                raw_name = Some(field.file_name().unwrap_or("file").to_string());
                mime_type = field.content_type().map(|s| s.to_string());

                let mut out = upload_jail::create_staging_file(tmp_dir, staging_name)
                    .await
                    .map_err(|e| {
                        AppCommandError::io_error("Failed to create staging file")
                            .with_detail(e.to_string())
                    })?;
                while let Some(chunk) = field.chunk().await.map_err(|e| {
                    AppCommandError::io_error("Failed to read upload chunk")
                        .with_detail(e.to_string())
                })? {
                    let new_total = written.saturating_add(chunk.len() as u64);
                    if new_total > UPLOAD_MAX_BYTES {
                        // Symmetric with the proxy's pre/post-decode caps
                        // in `commands/remote_proxy.rs`: any of the three
                        // layers can fire first depending on how the
                        // request reached us (web direct, Tauri-proxied,
                        // or local path read), and they all surface as
                        // the same i18n key so the toast text in the UI
                        // is uniform.
                        return Err(upload_too_large(new_total));
                    }
                    out.write_all(&chunk).await.map_err(|e| {
                        AppCommandError::io_error("Failed to write chunk")
                            .with_detail(e.to_string())
                    })?;
                    written = new_total;
                }
                out.flush().await.map_err(|e| {
                    AppCommandError::io_error("Failed to flush staging file")
                        .with_detail(e.to_string())
                })?;
            }
            _ => {
                // Drain unknown fields to avoid stalling the multipart parser.
                let _ = field.bytes().await;
            }
        }
    }

    if !file_seen {
        return Err(AppCommandError::io_error(
            "Missing `file` field in multipart upload",
        ));
    }
    finalize_staged_upload(
        uploads_root,
        tmp_dir,
        staging_name,
        raw_name.as_deref(),
        session_id,
        mime_type,
        written,
    )
    .await
}

/// Move a fully written staging file into its session bucket under a free
/// name, and describe where it landed. Shared by every way an attachment
/// arrives, so they are all jailed and named alike.
async fn finalize_staged_upload(
    uploads_root: &std::path::Path,
    tmp_dir: &std::path::Path,
    staging_name: &str,
    raw_name: Option<&str>,
    session_bucket: Option<String>,
    mime_type: Option<String>,
    written: u64,
) -> Result<UploadAttachmentResult, AppCommandError> {
    if written == 0 {
        return Err(AppCommandError::io_error("Uploaded file is empty"));
    }

    let safe_name = sanitize_upload_filename(raw_name.unwrap_or("file"));
    let bucket = session_bucket.unwrap_or_else(|| "anon".to_string());
    let dir = uploads_root.join(&bucket);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        AppCommandError::io_error("Failed to create uploads directory").with_detail(e.to_string())
    })?;

    // Reject the bucket directory itself if it's a symlink — `create_dir_all`
    // is a no-op when the target of a symlink already exists, so a pre-placed
    // symlink at <uploads_root>/<bucket> would silently let the rename below
    // land outside the jail. Filename sanitization can't help here because
    // the bucket path is what's being subverted.
    match tokio::fs::symlink_metadata(&dir).await {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(
                AppCommandError::io_error("Refusing to use a symlinked upload bucket")
                    .with_detail(dir.to_string_lossy().to_string()),
            );
        }
        Ok(_) => {}
        Err(e) => {
            return Err(
                AppCommandError::io_error("Failed to inspect uploads bucket directory")
                    .with_detail(e.to_string()),
            );
        }
    }
    // And confirm the bucket canonicalizes inside the uploads root before
    // the rename commits any bytes outside it. This is the load-bearing
    // jail check; the post-rename `ensure_path_inside` below is kept as
    // defense in depth.
    ensure_path_inside(&dir, uploads_root).await?;

    // TOCTOU-safe finalization: `finalize_into_bucket` opens both `tmp_dir`
    // and `dir` as `O_NOFOLLOW` dirfds and creates the final name without
    // replacing an existing file. If the original name is already present in
    // this session bucket, retry with `name (1).ext`, `name (2).ext`, etc.
    let final_name =
        finalize_with_available_upload_name(tmp_dir, staging_name, &dir, &safe_name).await?;
    let final_path = dir.join(&final_name);

    // Defense in depth: even though every component above was sanitized AND
    // the bucket dir was validated pre-finalization AND the commit itself
    // went through `O_NOFOLLOW` dirfds, run the final canonical path through
    // the jail check too. If somehow this fires, the file is already on disk
    // at `final_path` — clean it up so we don't leak data outside the jail
    // just because we noticed late.
    let canon = match ensure_path_inside(&final_path, uploads_root).await {
        Ok(p) => p,
        Err(err) => {
            let _ = tokio::fs::remove_file(&final_path).await;
            return Err(err);
        }
    };

    // The client turns this path back into a `file://` uri (the composer's
    // `buildFileUri`), which `acp::prompt_hydration` then resolves to read the
    // bytes back. `canon` is the canonicalized form, so on Windows it carries
    // the `\\?\` verbatim prefix — a shape that round-trip mangles into
    // `?/C:/…` and fails to resolve (issue #392). Hand out the plain form; the
    // canonical value above is what the jail check ran against, and it is a
    // no-op on every non-Windows host.
    Ok(UploadAttachmentResult {
        path: simplify_verbatim_path(&canon).to_string_lossy().to_string(),
        name: final_name,
        size: written,
        mime_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_strips_traversal() {
        assert_eq!(sanitize_upload_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_upload_filename("..\\..\\boot.ini"), "boot.ini");
    }

    #[test]
    fn sanitize_filename_handles_empty_and_dots() {
        assert_eq!(sanitize_upload_filename("..."), "file");
        assert_eq!(sanitize_upload_filename(""), "file");
        assert_eq!(sanitize_upload_filename("   "), "file");
        assert_eq!(sanitize_upload_filename(".env"), ".env");
    }

    #[test]
    fn sanitize_filename_replaces_hostile_chars() {
        assert_eq!(sanitize_upload_filename("a:b*c?\"d"), "a_b_c__d");
    }

    #[test]
    fn upload_filename_candidate_preserves_original_first() {
        assert_eq!(upload_filename_candidate("notes.txt", 0), "notes.txt");
    }

    #[test]
    fn upload_filename_candidate_suffixes_before_extension() {
        assert_eq!(upload_filename_candidate("notes.txt", 1), "notes (1).txt");
        assert_eq!(
            upload_filename_candidate("archive.tar.gz", 2),
            "archive.tar (2).gz"
        );
        assert_eq!(upload_filename_candidate(".env", 3), ".env (3)");
    }

    #[test]
    fn upload_filename_candidate_stays_bounded() {
        let long = format!("{}.txt", "a".repeat(140));
        let candidate = upload_filename_candidate(&long, 12);
        assert_eq!(candidate.chars().count(), UPLOAD_FILENAME_MAX_CHARS);
        assert!(candidate.ends_with(" (12).txt"));
    }

    #[tokio::test]
    async fn finalize_with_available_upload_name_suffixes_collision() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path().join(".tmp");
        let bucket = root.path().join("session");
        tokio::fs::create_dir_all(&tmp).await.unwrap();
        tokio::fs::create_dir_all(&bucket).await.unwrap();
        tokio::fs::write(bucket.join("notes.txt"), b"old")
            .await
            .unwrap();
        tokio::fs::write(tmp.join("upload.part"), b"new")
            .await
            .unwrap();

        let final_name =
            finalize_with_available_upload_name(&tmp, "upload.part", &bucket, "notes.txt")
                .await
                .unwrap();

        assert_eq!(final_name, "notes (1).txt");
        assert_eq!(
            tokio::fs::read(bucket.join("notes.txt")).await.unwrap(),
            b"old"
        );
        assert_eq!(
            tokio::fs::read(bucket.join("notes (1).txt")).await.unwrap(),
            b"new"
        );
        assert!(!tmp.join("upload.part").exists());
    }

    #[tokio::test]
    async fn stored_bytes_land_in_the_session_bucket_like_an_upload() {
        let root = tempfile::tempdir().unwrap();
        let first = store_attachment_bytes_in(
            root.path(),
            "bundle.zip",
            Some("application/zip".to_string()),
            Some("tab-1"),
            b"PK\x05\x06",
        )
        .await
        .unwrap();
        assert_eq!(first.name, "bundle.zip");
        assert_eq!(first.size, 4);
        assert_eq!(first.mime_type.as_deref(), Some("application/zip"));
        assert_eq!(std::fs::read(&first.path).unwrap(), b"PK\x05\x06");
        // The stored path drops Windows' verbatim prefix, so the expected
        // parent drops it the same way.
        let bucket = simplify_verbatim_path(&root.path().join("tab-1").canonicalize().unwrap());
        assert_eq!(
            std::path::Path::new(&first.path).parent(),
            Some(bucket.as_path())
        );

        // The same name pasted again takes the next free one; the first stays.
        let second =
            store_attachment_bytes_in(root.path(), "bundle.zip", None, Some("tab-1"), b"other")
                .await
                .unwrap();
        assert_eq!(second.name, "bundle (1).zip");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"PK\x05\x06");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"other");
        // Nothing is left behind in staging.
        let staged = std::fs::read_dir(root.path().join(".tmp")).unwrap().count();
        assert_eq!(staged, 0);
    }

    #[tokio::test]
    async fn stored_bytes_are_named_and_bucketed_as_safely_as_an_upload() {
        let root = tempfile::tempdir().unwrap();
        let stored =
            store_attachment_bytes_in(root.path(), "../../etc/passwd", None, Some("  "), b"x")
                .await
                .unwrap();
        assert_eq!(stored.name, "passwd");
        let anon = simplify_verbatim_path(&root.path().join("anon").canonicalize().unwrap());
        assert_eq!(
            std::path::Path::new(&stored.path).parent(),
            Some(anon.as_path())
        );
    }

    #[tokio::test]
    async fn stored_bytes_are_refused_when_empty_or_over_the_cap() {
        let root = tempfile::tempdir().unwrap();
        let empty = store_attachment_bytes_in(root.path(), "a.txt", None, None, b"")
            .await
            .unwrap_err();
        assert_eq!(empty.message, "Uploaded file is empty");

        let big = vec![0u8; UPLOAD_MAX_BYTES as usize + 1];
        let too_large = store_attachment_bytes_in(root.path(), "big.bin", None, None, &big)
            .await
            .unwrap_err();
        assert_eq!(
            too_large.i18n_key.as_deref(),
            Some(UPLOAD_I18N_KEY_TOO_LARGE)
        );

        // Neither left a file anywhere under the root.
        let staged = std::fs::read_dir(root.path().join(".tmp")).unwrap().count();
        assert_eq!(staged, 0);
        assert!(!root.path().join("anon").exists());
    }

    #[test]
    fn sanitize_session_bucket_allows_safe_chars() {
        assert_eq!(sanitize_session_bucket("abc-123_XY"), "abc-123_XY");
    }

    #[test]
    fn sanitize_session_bucket_collapses_unsafe() {
        assert_eq!(sanitize_session_bucket("../etc"), "etc");
        assert_eq!(sanitize_session_bucket("...."), "anon");
        assert_eq!(sanitize_session_bucket(""), "anon");
    }

    // ─── current_uploads_total_bytes ───────────────────────────────────

    async fn write_bytes(path: &std::path::Path, n: usize) {
        tokio::fs::create_dir_all(path.parent().expect("parent"))
            .await
            .unwrap();
        tokio::fs::write(path, vec![0u8; n]).await.unwrap();
    }

    #[tokio::test]
    async fn current_uploads_total_bytes_is_zero_for_missing_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert_eq!(current_uploads_total_bytes(&missing).await, 0);
    }

    #[tokio::test]
    async fn current_uploads_total_bytes_sums_files_under_buckets() {
        let dir = tempfile::tempdir().unwrap();
        write_bytes(&dir.path().join("session-a/file1"), 100).await;
        write_bytes(&dir.path().join("session-a/file2"), 250).await;
        write_bytes(&dir.path().join("session-b/file3"), 700).await;
        assert_eq!(current_uploads_total_bytes(dir.path()).await, 1050);
    }

    #[tokio::test]
    async fn current_uploads_total_bytes_skips_staging_tmp() {
        // `.tmp/` holds in-flight uploads that get purged at server
        // startup; including them in the running total would let a
        // partially-streamed upload reject the very next request.
        let dir = tempfile::tempdir().unwrap();
        write_bytes(&dir.path().join(".tmp/staging.part"), 9999).await;
        write_bytes(&dir.path().join("session-a/file"), 5).await;
        assert_eq!(current_uploads_total_bytes(dir.path()).await, 5);
    }

    #[tokio::test]
    async fn current_uploads_total_bytes_counts_loose_top_level_files() {
        // Anything copied in by an admin or left by an older layout
        // still counts toward the cap so the quota stays honest.
        let dir = tempfile::tempdir().unwrap();
        write_bytes(&dir.path().join("legacy.bin"), 42).await;
        assert_eq!(current_uploads_total_bytes(dir.path()).await, 42);
    }

    // ─── parse_upload_quota_config ────────────────────────────────────
    //
    // Tests the pure parser, NOT the env reader — mutating
    // `CODEG_UPLOAD_MAX_TOTAL_BYTES` from a test would race the harness's
    // parallel runner.

    #[test]
    fn parse_upload_quota_config_classifies_branches() {
        assert_eq!(parse_upload_quota_config(None), UploadQuotaConfig::Unset);
        assert_eq!(
            parse_upload_quota_config(Some("")),
            UploadQuotaConfig::Unset
        );
        assert_eq!(
            parse_upload_quota_config(Some("   ")),
            UploadQuotaConfig::Unset
        );
        assert_eq!(
            parse_upload_quota_config(Some("0")),
            UploadQuotaConfig::Disabled
        );
        assert_eq!(
            parse_upload_quota_config(Some("  1048576  ")),
            UploadQuotaConfig::Enabled(1_048_576),
            "trim + parse"
        );
        // The whole point of the rewrite: typos and unit-suffixed values
        // surface as `Invalid` instead of silently going to `Unset`. The
        // startup banner reads these and prints a WARN line naming the
        // exact value the operator typed.
        assert_eq!(
            parse_upload_quota_config(Some("10GB")),
            UploadQuotaConfig::Invalid("10GB".to_string())
        );
        assert_eq!(
            parse_upload_quota_config(Some("1g")),
            UploadQuotaConfig::Invalid("1g".to_string())
        );
        assert_eq!(
            parse_upload_quota_config(Some("not-a-number")),
            UploadQuotaConfig::Invalid("not-a-number".to_string())
        );
        assert_eq!(
            parse_upload_quota_config(Some("-1")),
            UploadQuotaConfig::Invalid("-1".to_string())
        );
    }

    #[test]
    fn upload_quota_strict_error_display_includes_env_names_and_value() {
        let err = UploadQuotaStrictError {
            raw_value: "10GB".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("CODEG_UPLOAD_MAX_TOTAL_BYTES"));
        assert!(msg.contains("CODEG_UPLOAD_QUOTA_STRICT"));
        assert!(msg.contains("10GB"));
    }

    #[test]
    fn parse_strict_mode_recognises_truthy_values() {
        assert!(!parse_strict_mode(None), "unset → false");
        assert!(!parse_strict_mode(Some("")), "empty → false");
        assert!(!parse_strict_mode(Some("0")), "zero → false");
        assert!(!parse_strict_mode(Some("false")), "false → false");
        assert!(!parse_strict_mode(Some("no")), "no → false");
        assert!(!parse_strict_mode(Some("off")), "off → false");
        assert!(parse_strict_mode(Some("1")), "1 → true");
        assert!(parse_strict_mode(Some("true")), "true → true");
        assert!(
            parse_strict_mode(Some("TRUE")),
            "TRUE → true (case-insensitive)"
        );
        assert!(parse_strict_mode(Some(" Yes ")), "trim + case → true");
        assert!(parse_strict_mode(Some("on")), "on → true");
        assert!(
            !parse_strict_mode(Some("strict")),
            "unknown values → false; we don't guess intent"
        );
    }

    #[test]
    fn upload_quota_config_cap_bytes_active_only_when_enabled() {
        assert_eq!(UploadQuotaConfig::Unset.cap_bytes(), None);
        assert_eq!(UploadQuotaConfig::Disabled.cap_bytes(), None);
        assert_eq!(UploadQuotaConfig::Enabled(42).cap_bytes(), Some(42));
        assert_eq!(
            UploadQuotaConfig::Invalid("oops".into()).cap_bytes(),
            None,
            "invalid disables the cap — fail-open so a typo doesn't 5xx uploads"
        );
    }

    // ─── upload_reservation_bytes ─────────────────────────────────────

    #[test]
    fn reservation_uses_content_length_when_small() {
        // A 1 MiB upload against a 10 MiB total quota must reserve ~1 MiB,
        // not the 20 MiB worst case (which would reject every upload on
        // servers whose quota is below the per-file maximum).
        let cl = 1024 * 1024 + 300; // file + multipart framing overhead
        assert_eq!(upload_reservation_bytes(Some(cl)), cl);
    }

    #[test]
    fn reservation_clamps_content_length_to_per_file_max() {
        // The streaming loop caps the file at UPLOAD_MAX_BYTES, so the
        // reservation never needs to exceed it even when the body (file +
        // framing) is slightly larger. min(CL, MAX) ≥ bytes written holds:
        // written ≤ MAX (loop check) and written ≤ CL (hyper framing).
        assert_eq!(
            upload_reservation_bytes(Some(UPLOAD_MAX_BYTES + 500)),
            UPLOAD_MAX_BYTES
        );
    }

    #[test]
    fn reservation_falls_back_to_worst_case_without_content_length() {
        assert_eq!(upload_reservation_bytes(None), UPLOAD_MAX_BYTES);
    }

    #[test]
    fn small_upload_fits_a_quota_below_the_per_file_max() {
        // Regression for the 2→20 MiB cap raise: cap = 10 MiB, empty disk,
        // a 1 MiB upload must be admitted via its Content-Length-bounded
        // reservation.
        let counter = AtomicU64::new(0);
        let cap = 10 * 1024 * 1024;
        let reserve = upload_reservation_bytes(Some(1024 * 1024 + 300));
        assert!(try_reserve_in_flight(&counter, reserve, 0, cap).is_ok());
    }

    // ─── try_reserve_in_flight ────────────────────────────────────────

    #[test]
    fn try_reserve_in_flight_admits_when_under_cap() {
        let counter = AtomicU64::new(0);
        let guard = try_reserve_in_flight(&counter, 2, 0, 10).expect("under cap");
        assert_eq!(counter.load(Ordering::Acquire), 2);
        drop(guard);
        assert_eq!(counter.load(Ordering::Acquire), 0, "released on drop");
    }

    #[test]
    fn try_reserve_in_flight_rejects_when_full() {
        let counter = AtomicU64::new(0);
        let _g1 = try_reserve_in_flight(&counter, 2, 6, 10).expect("first fits: 6+0+2=8");
        // Disk has 6 in use, 2 reserved → next 2 would push to 10.
        // Boundary: equal to cap is admitted.
        let _g2 = try_reserve_in_flight(&counter, 2, 6, 10).expect("boundary: 6+2+2=10");
        // Now 6+4+2=12 > 10 — must reject.
        assert!(
            try_reserve_in_flight(&counter, 2, 6, 10).is_err(),
            "12 > 10 must reject"
        );
    }

    #[test]
    fn try_reserve_in_flight_serializes_concurrent_admits() {
        // Two concurrent admits against an empty-disk cap of 4 with 2-byte
        // reservations. Both threads see used=0 initially; the CAS loop
        // ensures the second one observes the first's increment and either
        // succeeds (4 = cap) or rejects (>cap).
        //
        // We need the guards returned by the spawned threads to outlive
        // the assertions on `counter` — otherwise both guards drop on
        // thread-exit and we read 0. `Box::leak` produces a `'static`
        // counter so guards can be sent back across the join boundary.
        // The leak is bounded to one test invocation and the harness
        // tears the test process down at exit; no test-isolation issues.
        let counter: &'static AtomicU64 = Box::leak(Box::new(AtomicU64::new(0)));
        let cap = 4;
        let bytes = 2;
        let used = 0;

        let h1 = std::thread::spawn(move || try_reserve_in_flight(counter, bytes, used, cap));
        let h2 = std::thread::spawn(move || try_reserve_in_flight(counter, bytes, used, cap));
        let r1 = h1.join().unwrap();
        let r2 = h2.join().unwrap();

        let admits = [r1.is_ok(), r2.is_ok()].iter().filter(|ok| **ok).count();
        let counter_val = counter.load(Ordering::Acquire);
        assert_eq!(
            counter_val,
            admits as u64 * bytes,
            "counter must reflect exactly the admits, not stale CAS retries"
        );
        assert!(
            admits >= 1,
            "at least one must admit; CAS shouldn't starve both"
        );
        assert!(
            counter_val <= cap,
            "counter {counter_val} exceeded cap {cap}"
        );

        // Hold the guards until after the assert, then explicitly drop
        // to release reservations on the leaked counter.
        drop(r1);
        drop(r2);
        assert_eq!(counter.load(Ordering::Acquire), 0, "drops returned to zero");
    }

    #[test]
    fn try_reserve_in_flight_handles_saturating_used() {
        // If `used` is reported as near-`u64::MAX` (would never happen in
        // practice but the math should still be safe), the saturating add
        // pushes us over any reasonable cap and we reject.
        let counter = AtomicU64::new(0);
        assert!(try_reserve_in_flight(&counter, 1, u64::MAX, 100).is_err());
        assert_eq!(counter.load(Ordering::Acquire), 0, "no leak on rejection");
    }
}
