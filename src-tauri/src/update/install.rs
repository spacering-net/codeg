//! Download → verify → extract → atomic swap of the server bundle
//! (`codeg-server` + `codeg-mcp` + `web/`).
//!
//! The running worker performs the swap, keeping a `.bak` of each artifact,
//! then exits so the supervisor (or a re-exec) brings up the new version.
//! Every step that touches live files happens *after* the signature is
//! verified.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use futures_util::StreamExt;
use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::update::{verify, version};

/// Reject absurdly large archives outright. Server bundles are tens of MB;
/// this is a guard against a hostile/corrupt `Content-Length` driving an
/// unbounded allocation, not a real limit.
const MAX_ARCHIVE_BYTES: u64 = 600 * 1024 * 1024;

/// Cap on cumulative *decompressed* bytes during extraction. The compressed
/// download is bounded separately by [`MAX_ARCHIVE_BYTES`]; this stops a
/// signed-but-mispackaged (or, under key compromise, hostile) archive from
/// expanding without bound and filling the disk while it holds the update
/// lock. Real server bundles are well under this.
const MAX_EXTRACTED_BYTES: u64 = 1536 * 1024 * 1024;

/// Progress milestones surfaced to the frontend over the WS bridge.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Downloading,
    Verifying,
    Extracting,
    Swapping,
}

pub type ProgressFn<'a> = dyn Fn(UpdatePhase, u64, Option<u64>) + Send + Sync + 'a;

pub struct InstallOutcome {
    pub version: String,
}

/// Release asset basename for the current platform, matching the
/// `artifact` names produced by `.github/workflows/release.yml`.
pub fn asset_basename() -> Option<&'static str> {
    use std::env::consts::{ARCH, OS};
    Some(match (OS, ARCH) {
        ("linux", "x86_64") => "codeg-server-linux-x64",
        ("linux", "aarch64") => "codeg-server-linux-arm64",
        ("macos", "x86_64") => "codeg-server-darwin-x64",
        ("macos", "aarch64") => "codeg-server-darwin-arm64",
        ("windows", "x86_64") => "codeg-server-windows-x64",
        _ => return None,
    })
}

fn archive_ext() -> &'static str {
    if cfg!(windows) {
        ".zip"
    } else {
        ".tar.gz"
    }
}

fn server_bin_filename() -> &'static str {
    if cfg!(windows) {
        "codeg-server.exe"
    } else {
        "codeg-server"
    }
}

fn mcp_bin_filename() -> &'static str {
    if cfg!(windows) {
        "codeg-mcp.exe"
    } else {
        "codeg-mcp"
    }
}

struct Targets {
    server_bin: PathBuf,
    mcp_bin: PathBuf,
    web_dir: PathBuf,
}

fn resolve_targets() -> Result<Targets, AppCommandError> {
    let server_bin = crate::update::runtime::self_exe();
    let bindir = server_bin
        .parent()
        .ok_or_else(|| AppCommandError::io_error("Cannot resolve server binary directory"))?
        .to_path_buf();
    let mcp_bin = bindir.join(mcp_bin_filename());

    // Resolve the `web/` *update target* deterministically — this is distinct
    // from "where to serve static files from right now". When CODEG_STATIC_DIR
    // is set (the Docker image sets it to /app/web), the bundle lives there by
    // definition, so target it even if it is momentarily absent (e.g. a prior
    // web swap was interrupted mid-rename). Routing this through the serving
    // fallback would silently retarget a *different* directory when index.html
    // is missing, so a retry could update the wrong path and never repair the
    // real one.
    let web_dir = match std::env::var("CODEG_STATIC_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(dir) => PathBuf::from(dir),
        None => crate::web::find_static_dir_standalone(None),
    };
    // Absolutize so the rename-based swap is filesystem-stable regardless of
    // the process CWD (which the supervisor/respawn may not preserve).
    let web_dir = std::fs::canonicalize(&web_dir).unwrap_or(web_dir);

    Ok(Targets {
        server_bin,
        mcp_bin,
        web_dir,
    })
}

// ─── staged-upgrade marker ────────────────────────────────────────────────
//
// A completed swap drops this marker next to the server binary. It does two
// jobs:
//   1. Tells the supervisor that the *next* worker launch is the trial of a
//      newly-swapped version (so it is put on probation and auto-rolled-back
//      if it cannot boot) — and, crucially, that a plain `restart_app` with
//      no pending upgrade is NOT a trial.
//   2. Makes a second `perform_update` refuse before the first has been
//      applied by a restart; re-swapping would overwrite the `.bak` with the
//      already-new files and destroy rollback to the original version.

fn upgrade_marker_path() -> Option<PathBuf> {
    crate::update::runtime::self_exe()
        .parent()
        .map(|d| d.join(".codeg-upgrade-staged"))
}

/// True if a swapped-but-not-yet-applied upgrade is staged.
pub fn upgrade_staged() -> bool {
    upgrade_marker_path().map(|p| p.exists()).unwrap_or(false)
}

/// Record that an upgrade has been staged, durably. The marker is the only
/// thing that puts the next launch on probation (auto-rollback) and refuses a
/// second perform from clobbering `.bak`; if we cannot fsync it to disk the
/// swap is not safely committed, so the caller must undo the swap rather than
/// report success.
fn mark_upgrade_staged() -> Result<(), AppCommandError> {
    use std::io::Write;
    let p = upgrade_marker_path()
        .ok_or_else(|| AppCommandError::io_error("Cannot resolve upgrade marker path"))?;
    // Write to a temp file, fsync it, then atomically rename it into place.
    // A failed/partial write must never leave the *real* marker visible — a
    // stray marker would refuse every future update as "already staged" until
    // a restart consumed it.
    let mut tmp = p.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let _ = std::fs::remove_file(&tmp);
    let write = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(b"staged\n")?;
        f.sync_all()?;
        std::fs::rename(&tmp, &p)?;
        // fsync the directory so the marker's rename survives power loss — the
        // marker is what makes a return of success mean "durably staged".
        if let Some(parent) = p.parent() {
            sync_dir(parent)?;
        }
        Ok(())
    })();
    if let Err(e) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppCommandError::io(e));
    }
    Ok(())
}

/// Consume the staged-upgrade marker, returning whether it was present.
///
/// The marker is a *proof token*: it stays on disk for the whole trial window
/// so a second `perform_update` is refused while a freshly-swapped version is
/// still unproven — re-swapping would move the new files into `.bak` and a
/// trial-failure rollback would then restore the unproven version instead of
/// the last-known-good one. It is consumed only once the upgrade is proven or
/// undone:
///   - the supervised worker clears it after surviving the trial window;
///   - the standalone (non-supervised, re-exec) worker clears it on startup —
///     there is no supervisor and thus no trial, so the marker must not outlive
///     the upgrade it guards and block every future update;
///   - [`rollback`] clears it after reverting.
///
/// The supervisor itself only *peeks* via [`upgrade_staged`] to decide
/// probation; it must not consume the marker, or the trial window would lose
/// its second-perform guard and the rollback target could be clobbered.
pub fn take_upgrade_staged() -> bool {
    match upgrade_marker_path() {
        Some(p) if p.exists() => {
            let _ = std::fs::remove_file(&p);
            true
        }
        _ => false,
    }
}

/// Why an in-place update cannot run here, found without starting one: the
/// same preflight [`perform_update`] runs first. Lets the UI explain an
/// install this process cannot write (root-owned files run by an unprivileged
/// service, a read-only filesystem) before the operator clicks, instead of
/// offering an upgrade certain to fail — or, when the write was refused
/// outright, a [`rollback`] that would be refused too. Local and cheap:
/// creates and removes one empty file per target directory.
pub fn self_update_blocker() -> Option<AppCommandError> {
    resolve_targets()
        .and_then(|targets| preflight_writable(&targets))
        .err()
}

/// Fail fast if we cannot write where the swap needs to land — much better
/// to abort before downloading 50 MB than to discover a read-only
/// `/usr/local/bin` halfway through.
fn preflight_writable(targets: &Targets) -> Result<(), AppCommandError> {
    let bindir = targets
        .server_bin
        .parent()
        .ok_or_else(|| AppCommandError::io_error("Cannot resolve server binary directory"))?;
    check_writable(bindir)?;
    if let Some(web_parent) = targets.web_dir.parent() {
        check_writable(web_parent)?;
    }
    Ok(())
}

fn check_writable(dir: &Path) -> Result<(), AppCommandError> {
    let probe = dir.join(format!(".codeg-write-probe-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(unwritable_target_error(dir, &e)),
    }
}

/// i18n keys (root-qualified message paths) for an unwritable update target,
/// which the frontend renders in preference to the English message. Mirrored
/// by `SERVER_UPDATE_ERROR_MESSAGES` in `src/lib/updater.ts`. Params: `path`,
/// plus `reason` (the OS error) for [`UPDATE_I18N_KEY_TARGET_WRITE_FAILED`].
pub const UPDATE_I18N_KEY_TARGET_NOT_WRITABLE: &str =
    "SystemSettings.updateErrors.permissionDenied";
pub const UPDATE_I18N_KEY_TARGET_WRITE_FAILED: &str =
    "SystemSettings.updateErrors.targetWriteFailed";

/// Explain a failed write probe in `dir`. Refused permission (including a
/// read-only filesystem) gets the "update manually or fix the permissions"
/// advice; anything else — a full disk, a missing directory — only names the
/// OS reason, since sending the operator to fix permissions would mislead.
fn unwritable_target_error(dir: &Path, err: &std::io::Error) -> AppCommandError {
    let path = dir.display().to_string();
    // Clients older than the i18n key only see this message, and recognize the
    // failure by its prefix (`normalizeAppUpdateError`) — keep it stable.
    let message = format!("Update target is not writable: {path}");
    let mut params = BTreeMap::from([("path".to_string(), path)]);
    match err.kind() {
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem => {
            AppCommandError::permission_denied(message)
                .with_detail(err.to_string())
                .with_i18n(UPDATE_I18N_KEY_TARGET_NOT_WRITABLE, params)
        }
        _ => {
            params.insert("reason".to_string(), err.to_string());
            AppCommandError::io_error(message)
                .with_detail(err.to_string())
                .with_i18n(UPDATE_I18N_KEY_TARGET_WRITE_FAILED, params)
        }
    }
}

/// Full update: resolve targets, preflight, fetch manifest, download +
/// verify + extract the platform bundle, then atomically swap the three
/// artifacts (keeping `.bak`). On success the new files are in place and
/// the caller should trigger a restart.
pub async fn perform_update(
    data_dir: &Path,
    on_progress: &ProgressFn<'_>,
) -> Result<InstallOutcome, AppCommandError> {
    let asset = asset_basename().ok_or_else(|| {
        AppCommandError::new(
            crate::app_error::AppErrorCode::DependencyMissing,
            format!(
                "Self-update is not available for this platform ({}/{})",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        )
    })?;

    // Refuse to stage a second upgrade on top of one that was swapped but not
    // yet applied by a restart: re-swapping would move the already-new files
    // into `.bak` and lose the ability to roll back to the original version.
    if upgrade_staged() {
        return Err(AppCommandError::already_exists(
            "An update is already staged; restart the server to apply it before updating again",
        ));
    }

    let targets = resolve_targets()?;
    preflight_writable(&targets)?;

    let manifest = version::fetch_latest_manifest().await?;
    let new_version = version::trim_v_prefix(&manifest.version).to_string();

    // Refuse a non-newer target before touching the network or disk. A stale
    // client (whose cached "update available" predates another client already
    // upgrading this server) or a direct API call could otherwise re-install
    // the running version over itself — which moves the *current* binary into
    // `.bak`, destroying the genuine previous version that rollback depends on,
    // for no benefit. The check mirrors `check_app_update`'s availability test.
    if !version::is_newer(&manifest.version, env!("CARGO_PKG_VERSION")) {
        return Err(AppCommandError::already_exists(
            "The server is already running the latest version",
        ));
    }

    let ext = archive_ext();
    let archive_url = format!("{}/{}{}", version::RELEASE_DOWNLOAD_BASE, asset, ext);
    let sig_url = format!("{archive_url}.sig");

    // 1. Download archive (with progress) and its detached signature.
    let archive = download_to_vec(&archive_url, on_progress).await?;
    let sig_b64 = download_text(&sig_url).await?;

    // 2. Verify before touching anything executable.
    on_progress(UpdatePhase::Verifying, 0, None);
    verify::verify_release_signature(&archive, &sig_b64).map_err(|e| {
        AppCommandError::new(
            crate::app_error::AppErrorCode::TaskExecutionFailed,
            "Update signature verification failed",
        )
        .with_detail(e)
    })?;

    // 3. Extract into a scratch dir on the data volume.
    on_progress(UpdatePhase::Extracting, 0, None);
    let staging = data_dir.join(format!(".codeg-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(AppCommandError::io)?;
    let _cleanup = ScopedDir(staging.clone());

    extract_archive(&archive, &staging, ext)?;
    let bundle_root = find_bundle_root(&staging, asset)?;
    let new_server = bundle_root.join(server_bin_filename());
    let new_mcp = bundle_root.join(mcp_bin_filename());
    let new_web = bundle_root.join("web");
    // Require the full bundle before touching any live file. A signed but
    // mis-packaged release that dropped, say, `web/` must not be allowed to
    // install a half-new mixture (new server, stale frontend).
    if !new_server.is_file() || !new_mcp.is_file() || !new_web.is_dir() {
        return Err(AppCommandError::new(
            crate::app_error::AppErrorCode::TaskExecutionFailed,
            "Downloaded update is incomplete (expected codeg-server, codeg-mcp and a web/ directory)",
        ));
    }

    // 4. Swap, web → mcp → server (server last: it is the one the restart
    //    relaunches). Roll back already-swapped artifacts on any failure.
    on_progress(UpdatePhase::Swapping, 0, None);
    if new_web.is_dir() {
        replace_dir(&targets.web_dir, &new_web)?;
    }
    if new_mcp.exists() {
        if let Err(e) = replace_file(&targets.mcp_bin, &new_mcp) {
            let _ = restore_dir_from_bak(&targets.web_dir);
            return Err(e);
        }
    }
    if let Err(e) = replace_file(&targets.server_bin, &new_server) {
        let _ = restore_from_bak(&targets.mcp_bin);
        let _ = restore_dir_from_bak(&targets.web_dir);
        return Err(e);
    }

    // The swap is complete. Mark it staged so (a) the supervisor puts the
    // next launch on probation and (b) a second perform is refused until a
    // restart applies this one. If the marker can't be recorded durably, the
    // upgrade is not safely committed (no probation, no double-perform guard),
    // so undo the swap and surface the error instead of reporting success.
    if let Err(e) = mark_upgrade_staged() {
        // Undo the swap and make sure no marker survives: a marker without a
        // committed upgrade would refuse every future update as "already
        // staged" until the next restart consumed it.
        let _ = take_upgrade_staged();
        let _ = restore_from_bak(&targets.server_bin);
        let _ = restore_from_bak(&targets.mcp_bin);
        let _ = restore_dir_from_bak(&targets.web_dir);
        return Err(e);
    }

    Ok(InstallOutcome {
        version: new_version,
    })
}

/// Restore the previous bundle from the `.bak` artifacts kept by
/// [`perform_update`]. Best-effort per artifact.
pub fn rollback() -> Result<(), AppCommandError> {
    rollback_targets(&resolve_targets()?, check_writable)?;
    // The staged upgrade has been undone; clear its marker so the next
    // `perform_update` is not refused as "already staged".
    let _ = take_upgrade_staged();
    Ok(())
}

/// Restore `targets` from their `.bak`s. `probe` is [`check_writable`] — a
/// parameter so a test can make a directory refuse writes regardless of the
/// user the tests run as.
fn rollback_targets(
    targets: &Targets,
    probe: fn(&Path) -> Result<(), AppCommandError>,
) -> Result<(), AppCommandError> {
    // Refuse before restoring anything if a directory a restore is about to
    // write to refuses writes. Otherwise an install whose binary directory is
    // writable but whose `web/` parent is not would get its binaries rolled
    // back and then fail on the web bundle — possibly after
    // `restore_dir_from_bak` has already emptied the live `web/`. Only a
    // refused write counts: a full disk or a spent inode quota fails the
    // probe's create, but not the remove-then-rename a restore does.
    let refuses_writes = |dir: Option<&Path>| match dir.map(probe) {
        Some(Err(e)) if matches!(e.code, crate::app_error::AppErrorCode::PermissionDenied) => {
            Err(e)
        }
        _ => Ok(()),
    };
    // Whether an artifact has a backup to restore. A lookup that fails (a
    // directory this process can't traverse) is not "no backup" — the restore
    // below would skip it just the same and report success over a mix of
    // versions — so every lookup runs, and any failure stops the rollback,
    // before anything is touched.
    let has_bak = |target: &Path| {
        let bak = bak_path(target);
        bak.try_exists()
            .map_err(|e| unwritable_target_error(bak.parent().unwrap_or(&bak), &e))
    };
    let server_backed_up = has_bak(&targets.server_bin)?;
    let mcp_backed_up = has_bak(&targets.mcp_bin)?;
    let web_backed_up = has_bak(&targets.web_dir)?;
    if server_backed_up || mcp_backed_up {
        refuses_writes(targets.server_bin.parent())?;
    }
    if web_backed_up {
        refuses_writes(targets.web_dir.parent())?;
    }

    let mut restored = false;
    restored |= restore_from_bak(&targets.server_bin)?;
    restored |= restore_from_bak(&targets.mcp_bin)?;
    restored |= restore_dir_from_bak(&targets.web_dir)?;
    if !restored {
        return Err(AppCommandError::not_found(
            "No previous version is available to roll back to",
        ));
    }
    Ok(())
}

/// True when a `.bak` exists for at least one artifact (i.e. a rollback is
/// possible). Cheap enough to call from the status endpoint.
pub fn rollback_available() -> bool {
    let Ok(targets) = resolve_targets() else {
        return false;
    };
    bak_path(&targets.server_bin).exists()
}

// ─── download ────────────────────────────────────────────────────────────

async fn download_to_vec(
    url: &str,
    on_progress: &ProgressFn<'_>,
) -> Result<Vec<u8>, AppCommandError> {
    let client = version::download_client()?;
    let response = client.get(url).send().await.map_err(|e| {
        AppCommandError::network("Failed to download update package").with_detail(e.to_string())
    })?;
    if !response.status().is_success() {
        return Err(AppCommandError::network(format!(
            "Update package download returned status {}",
            response.status()
        )));
    }

    let total = response.content_length();
    if let Some(t) = total {
        if t > MAX_ARCHIVE_BYTES {
            return Err(AppCommandError::invalid_input(format!(
                "Update package is unexpectedly large ({t} bytes)"
            )));
        }
    }

    let mut downloaded: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(total.unwrap_or(0).min(MAX_ARCHIVE_BYTES) as usize);
    let mut stream = response.bytes_stream();
    on_progress(UpdatePhase::Downloading, 0, total);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            AppCommandError::network("Update download interrupted").with_detail(e.to_string())
        })?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_ARCHIVE_BYTES {
            return Err(AppCommandError::invalid_input(
                "Update package exceeded the maximum allowed size",
            ));
        }
        buf.extend_from_slice(&chunk);
        on_progress(UpdatePhase::Downloading, downloaded, total);
    }
    Ok(buf)
}

async fn download_text(url: &str) -> Result<String, AppCommandError> {
    let client = version::download_client()?;
    let response = client.get(url).send().await.map_err(|e| {
        AppCommandError::network("Failed to download update signature").with_detail(e.to_string())
    })?;
    if !response.status().is_success() {
        return Err(AppCommandError::network(format!(
            "Update signature download returned status {}",
            response.status()
        )));
    }
    response.text().await.map_err(|e| {
        AppCommandError::network("Failed to read update signature").with_detail(e.to_string())
    })
}

// ─── extraction ──────────────────────────────────────────────────────────

fn extract_archive(bytes: &[u8], dest: &Path, ext: &str) -> Result<(), AppCommandError> {
    if ext == ".zip" {
        extract_zip(bytes, dest, MAX_EXTRACTED_BYTES)
    } else {
        extract_tar_gz(bytes, dest, MAX_EXTRACTED_BYTES)
    }
}

fn extract_tar_gz(bytes: &[u8], dest: &Path, max: u64) -> Result<(), AppCommandError> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    let mut archive = Archive::new(GzDecoder::new(Cursor::new(bytes)));
    let entries = archive
        .entries()
        .map_err(|e| extract_err("read tar entries", e))?;
    let mut extracted: u64 = 0;
    for entry in entries {
        let mut entry = entry.map_err(|e| extract_err("read tar entry", e))?;
        let rel = entry
            .path()
            .map_err(|e| extract_err("read tar entry path", e))?
            .into_owned();
        let safe = sanitize_entry_path(&rel)?;
        let out = dest.join(&safe);
        let etype = entry.header().entry_type();
        if etype.is_dir() {
            std::fs::create_dir_all(&out).map_err(AppCommandError::io)?;
        } else if etype.is_file() {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(AppCommandError::io)?;
            }
            // Bound the *actual* bytes written, not the declared header size
            // (PAX/GNU size fields can understate the real stream). Copy through
            // a hard ceiling and abort if the entry overflows the budget.
            let remaining = max - extracted;
            #[cfg(unix)]
            let mode = entry.header().mode().ok();
            let mut out_file = std::fs::File::create(&out).map_err(AppCommandError::io)?;
            let written = std::io::copy(&mut entry.by_ref().take(remaining + 1), &mut out_file)
                .map_err(|e| extract_err("unpack tar entry", e))?;
            if written > remaining {
                return Err(AppCommandError::invalid_input(
                    "Update archive decompresses to more than the allowed size",
                ));
            }
            extracted += written;
            // Preserve unix mode so +x on codeg-server / codeg-mcp survives.
            #[cfg(unix)]
            if let Some(mode) = mode {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
            }
        } else {
            // Reject symlinks, hardlinks, devices, fifos. `unpack` would
            // materialize a symlink, letting a later entry write through it to
            // escape the staging dir before any `.bak` exists. We only ever
            // ship regular files and directories.
            return Err(AppCommandError::invalid_input(format!(
                "Update archive contains an unsupported entry type ({etype:?}): {}",
                safe.display()
            )));
        }
    }
    Ok(())
}

fn extract_zip(bytes: &[u8], dest: &Path, max: u64) -> Result<(), AppCommandError> {
    use zip::ZipArchive;

    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| extract_err("open zip", e))?;
    let mut extracted: u64 = 0;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| extract_err("read zip entry", e))?;
        // `enclosed_name` rejects path-traversal entries by returning None.
        let Some(rel) = file.enclosed_name() else {
            return Err(AppCommandError::invalid_input(
                "Update archive contains an unsafe path entry",
            ));
        };
        let out = dest.join(rel);
        if file.is_dir() {
            std::fs::create_dir_all(&out).map_err(AppCommandError::io)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(AppCommandError::io)?;
        }
        // Bound the *actual* decompressed bytes (a small compressed entry can
        // expand without bound — zip bomb), not the declared uncompressed size.
        let remaining = max - extracted;
        #[cfg(unix)]
        let mode = file.unix_mode();
        let mut writer = std::fs::File::create(&out).map_err(AppCommandError::io)?;
        let written = std::io::copy(&mut file.by_ref().take(remaining + 1), &mut writer)
            .map_err(AppCommandError::io)?;
        if written > remaining {
            return Err(AppCommandError::invalid_input(
                "Update archive decompresses to more than the allowed size",
            ));
        }
        extracted += written;
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

fn sanitize_entry_path(p: &Path) -> Result<PathBuf, AppCommandError> {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => {
                return Err(AppCommandError::invalid_input(format!(
                    "Update archive contains an unsafe path entry: {}",
                    p.display()
                )))
            }
        }
    }
    Ok(out)
}

/// The tarball/zip wraps everything in a single `{asset}/` directory. Prefer
/// that; fall back to scanning so a future layout change doesn't break us.
fn find_bundle_root(extract_dir: &Path, asset: &str) -> Result<PathBuf, AppCommandError> {
    let server = server_bin_filename();
    let candidate = extract_dir.join(asset);
    if candidate.join(server).exists() {
        return Ok(candidate);
    }
    if extract_dir.join(server).exists() {
        return Ok(extract_dir.to_path_buf());
    }
    if let Ok(read) = std::fs::read_dir(extract_dir) {
        for entry in read.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join(server).exists() {
                return Ok(p);
            }
        }
    }
    Err(AppCommandError::new(
        crate::app_error::AppErrorCode::TaskExecutionFailed,
        "Could not locate the server binary inside the update package",
    ))
}

// ─── atomic swap + rollback ──────────────────────────────────────────────

fn bak_path(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_os_string();
    s.push(".bak");
    PathBuf::from(s)
}

/// fsync a directory so a `rename`/`create` inside it is durable across host
/// power loss — fsyncing a file flushes its data but not the parent's updated
/// directory entry. No-op on platforms without directory fsync (Windows, where
/// server self-update is disabled anyway).
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// fsync a file's contents so a following `rename` commits durable *bytes*, not
/// just a durable name. Opens read-only on unix, where `fsync(2)` accepts a
/// read-only descriptor. No-op on Windows: `FlushFileBuffers` rejects a
/// read-only handle with `ERROR_ACCESS_DENIED`, and server self-update is
/// disabled there anyway (matching `sync_dir`).
fn sync_file(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Replace `target` with `new_src`, keeping the previous file at
/// `target.bak`. Staging happens in `target`'s own directory so the final
/// rename is same-filesystem (atomic). Renaming over a running executable is
/// fine on Linux (the inode stays open) and permitted on Windows (rename to
/// `.bak` first, then move the new file in).
fn replace_file(target: &Path, new_src: &Path) -> Result<(), AppCommandError> {
    let dir = target
        .parent()
        .ok_or_else(|| AppCommandError::io_error("Cannot resolve target directory"))?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppCommandError::io_error("Invalid target filename"))?;

    let staged = dir.join(format!(".{name}.new"));
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(new_src, &staged).map_err(AppCommandError::io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755));
    }
    // Flush the staged file's contents before it is committed by the rename.
    // The rename + directory fsync below make the *name* durable; without this
    // a power loss could leave that name pointing at unflushed (empty/garbage)
    // bytes — a committed-looking but corrupt binary the trial can't catch.
    sync_file(&staged).map_err(AppCommandError::io)?;

    let bak = bak_path(target);
    let _ = std::fs::remove_file(&bak);

    // On unix, back the live file up *without* moving it aside, then replace it
    // with a single atomic rename. `rename(2)` guarantees `target` always
    // resolves to either the old or the new inode — never missing — so a crash
    // (SIGKILL, OOM, host down) mid-swap can't leave the server binary absent
    // and the container unbootable. The backup is a hard link to the old inode
    // (O(1), no copy); fall back to a byte copy on filesystems without links.
    #[cfg(unix)]
    {
        if target.exists() && std::fs::hard_link(target, &bak).is_err() {
            // hard_link unsupported on this filesystem: copy instead, but stage
            // through a temp path so a partial/interrupted copy can never leave
            // a truncated `.bak` that a later rollback would restore over a
            // good binary. `.bak` only ever appears complete or absent.
            let mut bak_tmp = bak.clone().into_os_string();
            bak_tmp.push(".tmp");
            let bak_tmp = PathBuf::from(bak_tmp);
            let _ = std::fs::remove_file(&bak_tmp);
            std::fs::copy(target, &bak_tmp).map_err(AppCommandError::io)?;
            // Flush the backup's bytes before committing its name, mirroring the
            // staged-new-file path: a power loss must not leave a `.bak` whose
            // name is durable but whose contents are not — a later rollback
            // would then restore that corrupt backup over a working binary.
            sync_file(&bak_tmp).map_err(AppCommandError::io)?;
            std::fs::rename(&bak_tmp, &bak).map_err(AppCommandError::io)?;
        }
        if let Err(e) = std::fs::rename(&staged, target) {
            let _ = std::fs::remove_file(&staged);
            return Err(AppCommandError::io(e));
        }
        // Durably record both the `.bak` creation and the swap rename (same
        // dir) so a power loss can't resurrect the pre-swap directory entry.
        let _ = sync_dir(dir);
    }
    // Windows cannot rename over an existing file, so move the live file aside
    // first. (Server self-update is gated off on Windows; this keeps the helper
    // correct regardless.)
    #[cfg(not(unix))]
    {
        if target.exists() {
            std::fs::rename(target, &bak).map_err(AppCommandError::io)?;
        }
        if let Err(e) = std::fs::rename(&staged, target) {
            let _ = std::fs::rename(&bak, target);
            return Err(AppCommandError::io(e));
        }
    }
    Ok(())
}

fn replace_dir(target: &Path, new_src: &Path) -> Result<(), AppCommandError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppCommandError::io_error("Cannot resolve target directory"))?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppCommandError::io_error("Invalid target directory name"))?;

    let staged = parent.join(format!(".{name}.new"));
    let _ = std::fs::remove_dir_all(&staged);
    copy_dir_recursive(new_src, &staged)?;

    let bak = bak_path(target);
    let _ = std::fs::remove_dir_all(&bak);
    if target.exists() {
        // Prefer a single atomic swap so `target` is *never* absent mid-operation
        // — `rename(2)` of a populated directory can't overwrite another, so the
        // portable fallback below has to move the live dir aside first, leaving a
        // sub-millisecond window where a crash/power-loss strands `web/` missing
        // (the API stays up, so the supervisor won't self-heal it). The exchange
        // swaps the two inodes in one step: afterwards `target` holds the new
        // tree and `staged` holds the previous one, which becomes `.bak`.
        if exchange_dirs(target, &staged).is_ok() {
            // The live swap is done and crash-safe; keeping the previous tree as
            // `.bak` is best-effort (a same-dir rename that has every reason to
            // succeed). Don't fail an already-committed upgrade if it doesn't —
            // rollback is best-effort per artifact anyway.
            let _ = std::fs::rename(&staged, &bak);
        } else {
            // No atomic exchange here (syscall unsupported, older kernel, or a
            // cross-filesystem layout): fall back to backup-then-rename. The
            // missing-`web/` window reopens, but it is recoverable — re-running
            // the update restores the directory.
            match std::fs::rename(target, &bak) {
                Ok(()) => {
                    if let Err(e) = std::fs::rename(&staged, target) {
                        let _ = std::fs::rename(&bak, target);
                        return Err(AppCommandError::io(e));
                    }
                }
                // overlayfs (the Docker default) refuses to rename a directory
                // that originates in a lower image layer — rename(2) returns
                // EXDEV even within the same mount — so in a container the
                // live `web/` shipped by the image can never be moved aside.
                // Swap by copying instead.
                Err(e) if is_exdev(&e) => swap_dir_via_copy(target, &staged, &bak)?,
                Err(e) => return Err(AppCommandError::io(e)),
            }
        }
    } else {
        // No live directory (first install, or recovering an interrupted swap
        // that left `web/` absent): nothing to back up — move the staged tree in.
        std::fs::rename(&staged, target).map_err(AppCommandError::io)?;
    }
    // Durably record the directory swap so a power loss can't leave `web/`
    // absent with the rename only in the page cache.
    let _ = sync_dir(parent);
    Ok(())
}

/// Atomically swap two existing paths (here, the live `web/` and its staged
/// replacement) so neither is ever momentarily absent. Uses `RENAME_EXCHANGE`
/// (Linux) / `RENAME_SWAP` (macOS); both paths must exist and share a
/// filesystem. Returns `Err` when the syscall is unavailable (old kernel,
/// unsupported FS, or any non-unix/other-unix target) so the caller can fall
/// back to a non-atomic move.
fn exchange_dirs(a: &Path, b: &Path) -> std::io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let ca = CString::new(a.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let cb = CString::new(b.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        // SAFETY: both pointers are valid NUL-terminated C strings that outlive
        // the call; the kernel only reads them.
        let ret = unsafe {
            #[cfg(target_os = "linux")]
            {
                libc::renameat2(
                    libc::AT_FDCWD,
                    ca.as_ptr(),
                    libc::AT_FDCWD,
                    cb.as_ptr(),
                    libc::RENAME_EXCHANGE,
                )
            }
            #[cfg(target_os = "macos")]
            {
                libc::renamex_np(ca.as_ptr(), cb.as_ptr(), libc::RENAME_SWAP)
            }
        };
        if ret == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (a, b);
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
    }
}

/// True for `EXDEV` ("Invalid cross-device link"). Besides genuine
/// cross-filesystem renames, overlayfs returns it for renaming any directory
/// that was not created on the upper layer — the permanent state of
/// image-shipped directories (like `web/`) in a Docker container.
fn is_exdev(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::CrossesDevices
}

/// Replace `target` with `staged` on filesystems where the live directory
/// cannot be renamed (see [`is_exdev`]): back it up by *copying* into `bak`,
/// then delete it and rename the staged tree into place — deleting and
/// renaming a runtime-created (pure upper) directory are both permitted on
/// overlayfs. The backup stages through `<bak>.tmp` so `bak` only ever
/// appears complete or absent (mirroring `replace_file`'s copy fallback) and
/// rollback consumes it exactly like a rename-made backup. Non-atomic:
/// `target` is briefly absent, the same recoverable window the rename
/// fallback above already accepts.
fn swap_dir_via_copy(target: &Path, staged: &Path, bak: &Path) -> Result<(), AppCommandError> {
    let mut bak_tmp = bak.as_os_str().to_os_string();
    bak_tmp.push(".tmp");
    let bak_tmp = PathBuf::from(bak_tmp);
    let _ = std::fs::remove_dir_all(&bak_tmp);
    if let Err(e) = copy_dir_recursive(target, &bak_tmp) {
        let _ = std::fs::remove_dir_all(&bak_tmp);
        return Err(e);
    }
    std::fs::rename(&bak_tmp, bak).map_err(AppCommandError::io)?;

    let swap =
        std::fs::remove_dir_all(target).and_then(|_| std::fs::rename(staged, target));
    if let Err(e) = swap {
        // Best-effort restore from the backup made above (pure upper, so its
        // rename is permitted even on overlayfs). Consumes `.bak`, matching
        // the rename fallback's recovery semantics.
        let _ = std::fs::remove_dir_all(target);
        let _ = std::fs::rename(bak, target);
        return Err(AppCommandError::io(e));
    }
    Ok(())
}

fn restore_from_bak(target: &Path) -> Result<bool, AppCommandError> {
    let bak = bak_path(target);
    if !bak.exists() {
        return Ok(false);
    }
    let _ = std::fs::remove_file(target);
    std::fs::rename(&bak, target).map_err(AppCommandError::io)?;
    Ok(true)
}

fn restore_dir_from_bak(target: &Path) -> Result<bool, AppCommandError> {
    let bak = bak_path(target);
    if !bak.exists() {
        return Ok(false);
    }
    let _ = std::fs::remove_dir_all(target);
    std::fs::rename(&bak, target).map_err(AppCommandError::io)?;
    Ok(true)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppCommandError> {
    std::fs::create_dir_all(dst).map_err(AppCommandError::io)?;
    for entry in std::fs::read_dir(src).map_err(AppCommandError::io)? {
        let entry = entry.map_err(AppCommandError::io)?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type().map_err(AppCommandError::io)?;
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(AppCommandError::io)?;
            // Flush each file's contents before the staged tree is committed,
            // so a power loss after the swap rename can't leave a
            // committed-but-empty/garbage asset (e.g. a broken UI bundle).
            sync_file(&to).map_err(AppCommandError::io)?;
        }
    }
    // Flush this directory's entries so its children survive a crash too.
    let _ = sync_dir(dst);
    Ok(())
}

fn extract_err(what: &str, e: impl std::fmt::Display) -> AppCommandError {
    AppCommandError::new(
        crate::app_error::AppErrorCode::TaskExecutionFailed,
        format!("Failed to {what} from update package"),
    )
    .with_detail(e.to_string())
}

/// Removes a directory tree on drop — keeps the data volume clean even when
/// the swap errors out midway.
struct ScopedDir(PathBuf);
impl Drop for ScopedDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_parent_escape() {
        assert!(sanitize_entry_path(Path::new("../evil")).is_err());
        assert!(sanitize_entry_path(Path::new("a/../../b")).is_err());
    }

    #[test]
    fn sanitize_keeps_normal_paths() {
        let p = sanitize_entry_path(Path::new("codeg-server-linux-x64/web/index.html")).unwrap();
        assert_eq!(p, PathBuf::from("codeg-server-linux-x64/web/index.html"));
    }

    /// Build a gzip'd tar with the given (path, bytes) regular-file entries.
    fn make_tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut gz);
            for (name, data) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, &data[..]).unwrap();
            }
            builder.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    #[test]
    fn extract_caps_actual_decompressed_bytes() {
        let bytes = make_tar_gz(&[("bundle/big.bin", &[7u8; 2000])]);

        // A cap below the real content is enforced by *actual* bytes written,
        // so a lying/oversized entry can't slip past.
        let small = tempfile::tempdir().unwrap();
        let err = extract_tar_gz(&bytes, small.path(), 500).unwrap_err();
        assert!(
            err.to_string().contains("more than the allowed size"),
            "unexpected error: {err}"
        );

        // A cap above the content extracts the file intact.
        let big = tempfile::tempdir().unwrap();
        extract_tar_gz(&bytes, big.path(), 100_000).unwrap();
        assert_eq!(
            std::fs::read(big.path().join("bundle/big.bin")).unwrap(),
            vec![7u8; 2000]
        );
    }

    #[test]
    fn replace_file_keeps_backup_and_swaps() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("codeg-server");
        std::fs::write(&target, b"old").unwrap();
        let src = dir.path().join("new-bin");
        std::fs::write(&src, b"new").unwrap();

        replace_file(&target, &src).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(std::fs::read(bak_path(&target)).unwrap(), b"old");

        // Rollback restores the previous bytes.
        assert!(restore_from_bak(&target).unwrap());
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
    }

    #[test]
    fn replace_dir_keeps_backup_and_swaps() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("web");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("index.html"), b"old").unwrap();

        let src = dir.path().join("new-web");
        std::fs::create_dir_all(src.join("assets")).unwrap();
        std::fs::write(src.join("index.html"), b"new").unwrap();
        std::fs::write(src.join("assets/app.js"), b"js").unwrap();

        replace_dir(&target, &src).unwrap();

        assert_eq!(std::fs::read(target.join("index.html")).unwrap(), b"new");
        assert_eq!(std::fs::read(target.join("assets/app.js")).unwrap(), b"js");
        assert_eq!(
            std::fs::read(bak_path(&target).join("index.html")).unwrap(),
            b"old"
        );

        assert!(restore_dir_from_bak(&target).unwrap());
        assert_eq!(std::fs::read(target.join("index.html")).unwrap(), b"old");

        // The swap leaves no `.web.new` scratch dir behind (it became `.bak`).
        assert!(!dir.path().join(".web.new").exists());
    }

    #[test]
    fn swap_dir_via_copy_keeps_backup_and_swaps() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("web");
        std::fs::create_dir_all(target.join("assets")).unwrap();
        std::fs::write(target.join("index.html"), b"old").unwrap();
        std::fs::write(target.join("assets/app.js"), b"old-js").unwrap();

        let staged = dir.path().join(".web.new");
        std::fs::create_dir_all(staged.join("assets")).unwrap();
        std::fs::write(staged.join("index.html"), b"new").unwrap();
        std::fs::write(staged.join("assets/app.js"), b"new-js").unwrap();

        let bak = bak_path(&target);
        swap_dir_via_copy(&target, &staged, &bak).unwrap();

        assert_eq!(std::fs::read(target.join("index.html")).unwrap(), b"new");
        assert_eq!(std::fs::read(target.join("assets/app.js")).unwrap(), b"new-js");
        assert_eq!(std::fs::read(bak.join("index.html")).unwrap(), b"old");
        assert!(!staged.exists());
        // The backup staging dir must not survive (it became `.bak`).
        assert!(!dir.path().join("web.bak.tmp").exists());

        // A copy-made backup rolls back exactly like a rename-made one.
        assert!(restore_dir_from_bak(&target).unwrap());
        assert_eq!(std::fs::read(target.join("index.html")).unwrap(), b"old");
        assert_eq!(
            std::fs::read(target.join("assets/app.js")).unwrap(),
            b"old-js"
        );
    }

    #[test]
    fn exdev_is_detected_from_raw_os_error() {
        // The copy fallback keys off the EXDEV that overlayfs returns when
        // renaming an image-layer directory; the raw OS error must map to it.
        #[cfg(unix)]
        assert!(is_exdev(&std::io::Error::from_raw_os_error(libc::EXDEV)));
        assert!(is_exdev(&std::io::Error::from(
            std::io::ErrorKind::CrossesDevices
        )));
        assert!(!is_exdev(&std::io::Error::from(std::io::ErrorKind::NotFound)));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn exchange_dirs_swaps_two_directories_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("mark"), b"A").unwrap();
        std::fs::write(b.join("mark"), b"B").unwrap();

        // On a filesystem that supports the syscall the contents swap atomically;
        // if it is unsupported here, the helper reports the error (and replace_dir
        // would fall back) rather than corrupting either side.
        match exchange_dirs(&a, &b) {
            Ok(()) => {
                assert_eq!(std::fs::read(a.join("mark")).unwrap(), b"B");
                assert_eq!(std::fs::read(b.join("mark")).unwrap(), b"A");
            }
            Err(_) => {
                assert_eq!(std::fs::read(a.join("mark")).unwrap(), b"A");
                assert_eq!(std::fs::read(b.join("mark")).unwrap(), b"B");
            }
        }
    }

    #[test]
    fn unwritable_target_error_keeps_the_prefix_the_ui_classifies() {
        // A client that predates the i18n key tells an installation permission
        // problem apart from a generic install failure only by this prefix, so
        // rewording it would bring back the "close the app and try again"
        // advice there.
        let dir = tempfile::tempdir().unwrap();
        // A missing directory fails the probe even when the tests run as
        // root, which a read-only mode bit would not.
        let missing = dir.path().join("missing");

        let err = check_writable(&missing).unwrap_err();

        // `to_string()` is exactly what the update state publishes as `error`.
        assert_eq!(
            err.to_string(),
            format!("Update target is not writable: {}", missing.display())
        );
    }

    #[test]
    fn a_refused_write_is_explained_as_a_permission_problem() {
        let dir = Path::new("/usr/local/bin");
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::ReadOnlyFilesystem,
        ] {
            let err = unwritable_target_error(dir, &std::io::Error::from(kind));

            assert!(
                matches!(err.code, crate::app_error::AppErrorCode::PermissionDenied),
                "{kind:?}"
            );
            // The literal the frontend's `SERVER_UPDATE_ERROR_MESSAGES` maps.
            assert_eq!(
                err.i18n_key.as_deref(),
                Some("SystemSettings.updateErrors.permissionDenied"),
                "{kind:?}"
            );
            assert_eq!(
                err.i18n_params,
                Some(BTreeMap::from([(
                    "path".to_string(),
                    "/usr/local/bin".to_string()
                )])),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn any_other_write_failure_names_the_os_reason_instead() {
        // A full disk is not fixed by granting permissions; the advice for a
        // refused write would send the operator the wrong way.
        let dir = Path::new("/usr/local/bin");
        let os_err = std::io::Error::from(std::io::ErrorKind::StorageFull);

        let err = unwritable_target_error(dir, &os_err);

        assert!(matches!(err.code, crate::app_error::AppErrorCode::IoError));
        assert_eq!(
            err.i18n_key.as_deref(),
            Some("SystemSettings.updateErrors.targetWriteFailed")
        );
        assert_eq!(
            err.i18n_params,
            Some(BTreeMap::from([
                ("path".to_string(), "/usr/local/bin".to_string()),
                ("reason".to_string(), os_err.to_string()),
            ]))
        );
        // Same English message either way: older clients keep recognizing it.
        assert_eq!(err.message, "Update target is not writable: /usr/local/bin");
    }

    /// An upgraded install with `.bak`s for the server binary and the web
    /// bundle, the bundle under `<dir>/share` (a root-owned
    /// `/usr/local/share/codeg` in the deployments this guards).
    fn upgraded_install(dir: &Path) -> Targets {
        let bindir = dir.join("bin");
        let web_dir = dir.join("share").join("web");
        std::fs::create_dir_all(&bindir).unwrap();
        std::fs::create_dir_all(bak_path(&web_dir)).unwrap();
        std::fs::create_dir_all(&web_dir).unwrap();
        let server_bin = bindir.join("codeg-server");
        std::fs::write(&server_bin, b"new").unwrap();
        std::fs::write(bak_path(&server_bin), b"old").unwrap();
        std::fs::write(web_dir.join("index.html"), b"new").unwrap();
        std::fs::write(bak_path(&web_dir).join("index.html"), b"old").unwrap();
        Targets {
            server_bin,
            mcp_bin: bindir.join("codeg-mcp"),
            web_dir,
        }
    }

    /// Probes as if `share` refused writes, or ran out of space.
    fn share_denied(dir: &Path) -> Result<(), AppCommandError> {
        share_fails(dir, std::io::ErrorKind::PermissionDenied)
    }
    fn share_full(dir: &Path) -> Result<(), AppCommandError> {
        share_fails(dir, std::io::ErrorKind::StorageFull)
    }
    fn share_fails(dir: &Path, kind: std::io::ErrorKind) -> Result<(), AppCommandError> {
        if dir.file_name().is_some_and(|name| name == "share") {
            Err(unwritable_target_error(dir, &std::io::Error::from(kind)))
        } else {
            Ok(())
        }
    }

    #[test]
    fn rollback_refuses_before_touching_what_it_could_not_finish() {
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());

        let err = rollback_targets(&targets, share_denied).unwrap_err();

        assert_eq!(
            err.i18n_key.as_deref(),
            Some(UPDATE_I18N_KEY_TARGET_NOT_WRITABLE)
        );
        // The binary was not rolled back ahead of a web bundle that couldn't be.
        assert_eq!(std::fs::read(&targets.server_bin).unwrap(), b"new");
        assert_eq!(
            std::fs::read(targets.web_dir.join("index.html")).unwrap(),
            b"new"
        );
    }

    #[test]
    fn rollback_goes_ahead_when_the_probe_only_lacks_space() {
        // A full disk or spent inode quota fails the probe's create, but not
        // the remove-then-rename a restore does.
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());

        rollback_targets(&targets, share_full).unwrap();

        assert_eq!(std::fs::read(&targets.server_bin).unwrap(), b"old");
        assert_eq!(
            std::fs::read(targets.web_dir.join("index.html")).unwrap(),
            b"old"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rollback_refuses_a_backup_it_cannot_even_look_up() {
        use std::os::unix::fs::PermissionsExt;
        // Root traverses a mode-000 directory anyway, so there is nothing to
        // observe when the tests run as root.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        let share = dir.path().join("share");
        std::fs::set_permissions(&share, std::fs::Permissions::from_mode(0o000)).unwrap();

        // The probe itself would pass: only the `web.bak` lookup can fail.
        let result = rollback_targets(&targets, |_| Ok(()));
        std::fs::set_permissions(&share, std::fs::Permissions::from_mode(0o755)).unwrap();

        let err = result.unwrap_err();
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(UPDATE_I18N_KEY_TARGET_NOT_WRITABLE)
        );
        // Not "rolled back" over a web bundle it never saw.
        assert_eq!(std::fs::read(&targets.server_bin).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn rollback_looks_up_every_backup_before_restoring_any() {
        // A present server backup must not excuse the mcp one from the lookup:
        // a self-referencing link fails it (ELOOP) even for root.
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        let mcp_bak = bak_path(&targets.mcp_bin);
        std::os::unix::fs::symlink(&mcp_bak, &mcp_bak).unwrap();

        let err = rollback_targets(&targets, |_| Ok(())).unwrap_err();

        assert_eq!(
            err.i18n_key.as_deref(),
            Some(UPDATE_I18N_KEY_TARGET_WRITE_FAILED)
        );
        assert_eq!(std::fs::read(&targets.server_bin).unwrap(), b"new");
    }

    #[test]
    fn rollback_ignores_a_refusing_directory_it_restores_nothing_into() {
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        std::fs::remove_dir_all(bak_path(&targets.web_dir)).unwrap();

        rollback_targets(&targets, share_denied).unwrap();

        assert_eq!(std::fs::read(&targets.server_bin).unwrap(), b"old");
        assert_eq!(
            std::fs::read(targets.web_dir.join("index.html")).unwrap(),
            b"new"
        );
    }

    #[test]
    fn asset_basename_is_known_for_supported_targets() {
        // At least the host target the tests run on must resolve.
        assert!(
            asset_basename().is_some()
                || cfg!(not(any(
                    target_os = "linux",
                    target_os = "macos",
                    target_os = "windows"
                )))
        );
    }
}
