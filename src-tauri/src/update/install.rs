//! Download → verify → extract → atomic swap of the server bundle
//! (`codeg-server` + `codeg-mcp` + `web/`, and `codeg-computer-helper` and
//! `codeg-cli` where the release ships them).
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

fn cli_bin_filename() -> &'static str {
    if cfg!(windows) {
        "codeg-cli.exe"
    } else {
        "codeg-cli"
    }
}

struct Targets {
    server_bin: PathBuf,
    mcp_bin: PathBuf,
    /// The computer-use helper: swapped when the new bundle has one, so it
    /// is always built from the same sources as the server (which refuses a
    /// helper that is not).
    helper_bin: PathBuf,
    /// The command-line client: swapped when the new bundle has one and the
    /// file in place is not a symlink (see [`cli_is_ours_to_replace`]), so
    /// `codeg-cli` stays the server's version.
    cli_bin: PathBuf,
    web_dir: PathBuf,
}

fn resolve_targets() -> Result<Targets, AppCommandError> {
    let server_bin = crate::update::runtime::self_exe();
    let bindir = server_bin
        .parent()
        .ok_or_else(|| AppCommandError::io_error("Cannot resolve server binary directory"))?
        .to_path_buf();
    let mcp_bin = bindir.join(mcp_bin_filename());
    let helper_bin = bindir.join(crate::computer::local::helper_file_name());
    let cli_bin = bindir.join(cli_bin_filename());

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
        helper_bin,
        cli_bin,
        web_dir,
    })
}

/// Whether the update may put the bundle's `codeg-cli` at `target`: when
/// nothing is there, or a file — what `install.sh` and the Docker image put
/// there. A symlink stays: it is the desktop app's command (a `codeg-cli`
/// linked into `codeg.app`, which `install.sh` leaves alone too) or one the
/// user made, and replacing it would take away the program they chose.
fn cli_is_ours_to_replace(target: &Path) -> bool {
    !std::fs::symlink_metadata(target).is_ok_and(|meta| meta.file_type().is_symlink())
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
    verify::verify_release_signature(&archive, &sig_b64, &manifest.version).map_err(|e| {
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
    let new_helper = bundle_root.join(crate::computer::local::helper_file_name());
    let new_cli = bundle_root.join(cli_bin_filename());
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

    // 4. Swap, web → mcp → helper → cli → server (server last: it is the one
    //    the restart relaunches). Roll back already-swapped artifacts on any
    //    failure. The helper and the CLI only where the bundle has them: older
    //    releases did not ship them.
    on_progress(UpdatePhase::Swapping, 0, None);
    swap_bundle(
        &targets,
        &Bundle {
            server: &new_server,
            mcp: &new_mcp,
            helper: &new_helper,
            cli: &new_cli,
            web: &new_web,
        },
    )?;

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
        if let Err(undo) = undo_bundle(&targets) {
            tracing::warn!(
                "[update] undoing the swap stopped, left for the next update or rollback: {} {}",
                undo.message,
                undo.detail.as_deref().unwrap_or("")
            );
        }
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
    let helper_backed_up = has_bak(&targets.helper_bin)?;
    let cli_backed_up = has_bak(&targets.cli_bin)? || {
        let absent = absent_path(&targets.cli_bin);
        absent
            .try_exists()
            .map_err(|e| unwritable_target_error(absent.parent().unwrap_or(&absent), &e))?
    };
    let web_backed_up = has_bak(&targets.web_dir)?;
    // What an interrupted swap left, which settling it below writes to.
    let mut swap_left = false;
    for left in [
        swap_record_path(&targets.server_bin),
        rollback_record_path(&targets.server_bin),
        next_path(&bak_path(&targets.server_bin)),
        next_path(&bak_path(&targets.cli_bin)),
        next_path(&absent_path(&targets.cli_bin)),
    ] {
        swap_left |= left
            .try_exists()
            .map_err(|e| unwritable_target_error(left.parent().unwrap_or(&left), &e))?;
    }
    if server_backed_up || mcp_backed_up || helper_backed_up || cli_backed_up || swap_left {
        refuses_writes(targets.server_bin.parent())?;
    }
    if web_backed_up {
        refuses_writes(targets.web_dir.parent())?;
    }

    // An attempt that died mid-swap first, finished or undone (or a rollback
    // cut short, completed): the restores below then work from the records
    // of the release really live, and no pending record is left for the
    // next update to replay over the rolled-back one.
    let mut restored = settle_interrupted_swap(targets)?;
    restored |= restore_backups(targets)?;
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
    // Or a rollback cut short, which another completes.
    bak_path(&targets.server_bin).exists() || rollback_record_path(&targets.server_bin).exists()
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
    let staged = stage_file(target, new_src)?;
    commit_file(target, &staged, &bak_path(target))
}

/// The first half of [`replace_file`]: `new_src` copied next to `target`,
/// flushed, ready to be renamed into place. Nothing live is touched.
fn stage_file(target: &Path, new_src: &Path) -> Result<PathBuf, AppCommandError> {
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
    Ok(staged)
}

/// The second half of [`replace_file`]: the live `target` backed up to `bak`
/// and the staged file renamed over it.
fn commit_file(target: &Path, staged: &Path, bak: &Path) -> Result<(), AppCommandError> {
    let _ = std::fs::remove_file(bak);

    // On unix, back the live file up *without* moving it aside, then replace it
    // with a single atomic rename. `rename(2)` guarantees `target` always
    // resolves to either the old or the new inode — never missing — so a crash
    // (SIGKILL, OOM, host down) mid-swap can't leave the server binary absent
    // and the container unbootable. The backup is a hard link to the old inode
    // (O(1), no copy); fall back to a byte copy on filesystems without links.
    #[cfg(unix)]
    {
        if target.exists() && std::fs::hard_link(target, bak).is_err() {
            copy_synced(target, bak)?;
        }
        if let Err(e) = std::fs::rename(staged, target) {
            let _ = std::fs::remove_file(staged);
            return Err(AppCommandError::io(e));
        }
        // Durably record both the `.bak` creation and the swap rename (same
        // dir) so a power loss can't resurrect the pre-swap directory entry.
        if let Some(dir) = target.parent() {
            let _ = sync_dir(dir);
        }
    }
    // Windows cannot rename over an existing file, so move the live file aside
    // first. (Server self-update is gated off on Windows; this keeps the helper
    // correct regardless.)
    #[cfg(not(unix))]
    {
        if target.exists() {
            std::fs::rename(target, bak).map_err(AppCommandError::io)?;
        }
        if let Err(e) = std::fs::rename(staged, target) {
            let _ = std::fs::rename(bak, target);
            return Err(AppCommandError::io(e));
        }
    }
    Ok(())
}

/// `target` copied to `bak` where hard links are not supported, staged
/// through a temp path so a partial or interrupted copy can never leave a
/// truncated backup that a later rollback would restore over a good binary:
/// `bak` only ever appears complete or absent. Its bytes are flushed before
/// its name is committed, mirroring the staged new file: a power loss must
/// not leave a backup whose name is durable but whose contents are not.
#[cfg(unix)]
fn copy_synced(target: &Path, bak: &Path) -> Result<(), AppCommandError> {
    let mut bak_tmp = bak.as_os_str().to_os_string();
    bak_tmp.push(".tmp");
    let bak_tmp = PathBuf::from(bak_tmp);
    let _ = std::fs::remove_file(&bak_tmp);
    let copied = std::fs::copy(target, &bak_tmp)
        .and_then(|_| sync_file(&bak_tmp))
        .and_then(|()| std::fs::rename(&bak_tmp, bak));
    copied.map_err(|e| {
        let _ = std::fs::remove_file(&bak_tmp);
        AppCommandError::io(e)
    })
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

/// `target` back from its `.bak`. On unix in one rename over the live file,
/// so `target` is never missing, and a backup that is not a file fails
/// without touching it; Windows, which cannot rename over a file in use,
/// removes it first. The backup goes for sure after: were the two names one
/// file (hard links), the rename would succeed and leave both.
fn restore_from_bak(target: &Path) -> Result<bool, AppCommandError> {
    let bak = bak_path(target);
    if !bak.exists() {
        return Ok(false);
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::remove_file(target);
    }
    std::fs::rename(&bak, target).map_err(AppCommandError::io)?;
    remove_if_there(&bak)?;
    Ok(true)
}

/// The new bundle's files, as extracted.
struct Bundle<'a> {
    server: &'a Path,
    mcp: &'a Path,
    helper: &'a Path,
    cli: &'a Path,
    web: &'a Path,
}

/// Swap the bundle in — web → mcp → helper → cli → server, the server last
/// (it is the one the restart relaunches) — undoing what was swapped on any
/// failure. The helper and the CLI only where the bundle has them.
///
/// The server's rename is the commit point, for the rollback records too:
/// the server's `.bak` and the CLI's (its `.bak`, or `.absent` for a CLI the
/// update added) change release only with it, so they always belong to one
/// release. Until the rename, this update's records wait apart as pending
/// ones — the CLI's `.bak.next` or `.absent.next`, written durably before
/// the CLI is touched, and the server's `.bak.next` — and the previous
/// release's stay whole. Right before the rename, the swap record names the
/// new server by its contents and says what was done to the CLI; after it,
/// the pending records replace the previous release's, and the swap record
/// goes. An attempt that died anywhere in between is settled by the next
/// update or rollback before it starts: finished if its server went live,
/// undone if not (see [`settle_interrupted_swap`]).
fn swap_bundle(targets: &Targets, new: &Bundle) -> Result<(), AppCommandError> {
    settle_interrupted_swap(targets)?;
    let cli = &targets.cli_bin;
    let next_bak = next_path(&bak_path(cli));
    let next_absent = next_path(&absent_path(cli));
    let swap_cli = new.cli.is_file() && cli_is_ours_to_replace(cli);
    let had_cli = std::fs::symlink_metadata(cli).is_ok();
    // Before the commit: the CLI goes back by its pending record, and the
    // previous release's records stay as they are.
    let undo_cli = || {
        if swap_cli {
            if had_cli {
                if next_bak.exists() {
                    let _ = std::fs::rename(&next_bak, cli);
                }
            } else if next_absent.exists() {
                let _ = std::fs::remove_file(cli);
            }
        }
        let _ = std::fs::remove_file(&next_bak);
        let _ = std::fs::remove_file(&next_absent);
        if let Some(dir) = cli.parent() {
            let _ = sync_dir(dir);
        }
    };
    let undo_before_cli = || {
        let _ = restore_from_bak(&targets.helper_bin);
        let _ = restore_from_bak(&targets.mcp_bin);
        let _ = restore_dir_from_bak(&targets.web_dir);
    };

    if new.web.is_dir() {
        replace_dir(&targets.web_dir, new.web)?;
    }
    if new.mcp.exists() {
        if let Err(e) = replace_file(&targets.mcp_bin, new.mcp) {
            let _ = restore_dir_from_bak(&targets.web_dir);
            return Err(e);
        }
    }
    if new.helper.is_file() {
        if let Err(e) = replace_file(&targets.helper_bin, new.helper) {
            let _ = restore_from_bak(&targets.mcp_bin);
            let _ = restore_dir_from_bak(&targets.web_dir);
            return Err(e);
        }
    }
    if swap_cli {
        // An addition's pending record first, durably: from here on an
        // attempt that dies is undone by the next one. (A replacement's is
        // the backup `commit_file` makes, synced with its rename.)
        if !had_cli {
            if let Err(e) = create_synced(&next_absent) {
                undo_before_cli();
                return Err(AppCommandError::io(e));
            }
        }
        let swapped =
            stage_file(cli, new.cli).and_then(|staged| commit_file(cli, &staged, &next_bak));
        if let Err(e) = swapped {
            undo_cli();
            undo_before_cli();
            return Err(e);
        }
    }
    let staged_server = match stage_file(&targets.server_bin, new.server) {
        Ok(staged) => staged,
        Err(e) => {
            undo_cli();
            undo_before_cli();
            return Err(e);
        }
    };
    let change = match (swap_cli, had_cli) {
        (false, _) => CliChange::Untouched,
        (true, true) => CliChange::Replaced,
        (true, false) => CliChange::Added,
    };
    let record = match commit_server(&targets.server_bin, &staged_server, change) {
        Ok(record) => record,
        Err(e) => {
            undo_cli();
            undo_before_cli();
            return Err(e);
        }
    };
    // Committed. What is left only moves records, and the swap record stays
    // until that is done: a failure is finished by the next update or
    // rollback, and does not make the update a failed one.
    if let Err(e) = finish_swap(targets, &record) {
        tracing::warn!(
            "[update] the rollback records are left for the next update or rollback to finish: {} {}",
            e.message,
            e.detail.as_deref().unwrap_or("")
        );
    }
    Ok(())
}

/// What a swap did to the CLI, as its swap record keeps it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliChange {
    Replaced,
    Added,
    Untouched,
}

impl CliChange {
    fn as_str(self) -> &'static str {
        match self {
            CliChange::Replaced => "replaced",
            CliChange::Added => "added",
            CliChange::Untouched => "untouched",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [CliChange::Replaced, CliChange::Added, CliChange::Untouched]
            .into_iter()
            .find(|change| change.as_str() == text)
    }
}

/// The swap record (`<server>.swap`), there from right before the server's
/// rename until the swap's rollback records are final. It names the new
/// server by the SHA-256 of its contents, so whether the rename happened is
/// read off the live server.
#[derive(Debug, PartialEq, Eq)]
struct SwapRecord {
    server_sha256: String,
    cli: CliChange,
}

impl SwapRecord {
    fn to_text(&self) -> String {
        format!(
            "server-sha256 {}\ncli {}\n",
            self.server_sha256,
            self.cli.as_str()
        )
    }

    fn parse(text: &str) -> Option<Self> {
        let (mut sha, mut cli) = (None, None);
        for line in text.lines() {
            match line.split_once(' ')? {
                ("server-sha256", hex)
                    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) =>
                {
                    sha = Some(hex.to_ascii_lowercase());
                }
                ("cli", change) => cli = Some(CliChange::parse(change)?),
                _ => return None,
            }
        }
        Some(Self {
            server_sha256: sha?,
            cli: cli?,
        })
    }
}

fn swap_record_path(server: &Path) -> PathBuf {
    let mut s = server.as_os_str().to_os_string();
    s.push(".swap");
    PathBuf::from(s)
}

/// The record written whole or not at all: through a flushed temp file
/// renamed into place. The caller makes the rename durable.
fn write_swap_record(path: &Path, record: &SwapRecord) -> Result<(), AppCommandError> {
    use std::io::Write;
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let _ = std::fs::remove_file(&tmp);
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(record.to_text().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    written.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppCommandError::io(e)
    })
}

fn read_swap_record(path: &Path) -> Result<Option<SwapRecord>, AppCommandError> {
    match std::fs::read_to_string(path) {
        Ok(text) => SwapRecord::parse(&text).map(Some).ok_or_else(|| {
            AppCommandError::io_error(format!("Unreadable update record: {}", path.display()))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppCommandError::io(e)),
    }
}

/// The SHA-256 of a file's contents, in lowercase hex.
fn file_sha256(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    std::io::copy(&mut std::fs::File::open(path)?, &mut hasher)?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Whether the file at `path` has these contents. A missing file has not.
fn file_has_sha256(path: &Path, sha256: &str) -> Result<bool, AppCommandError> {
    match file_sha256(path) {
        Ok(actual) => Ok(actual == sha256),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(AppCommandError::io(e)),
    }
}

/// The server's commit: the swap record, the reserved slot of its rollback's
/// record, the live server's pending backup, all durable, then the rename of
/// the staged server over it — the commit point. A failure before the rename
/// leaves neither the record nor the backup behind, nor the staged file (the
/// slot stays: an empty file, perhaps the previous update's).
fn commit_server(
    server: &Path,
    staged: &Path,
    cli: CliChange,
) -> Result<SwapRecord, AppCommandError> {
    let dir = server
        .parent()
        .ok_or_else(|| AppCommandError::io_error("Cannot resolve target directory"))?;
    let record_path = swap_record_path(server);
    let pending = next_path(&bak_path(server));
    let undo = || {
        // Moved aside (Windows) and not replaced: back it comes.
        if std::fs::symlink_metadata(server).is_err() {
            let _ = std::fs::rename(&pending, server);
        }
        let _ = std::fs::remove_file(&pending);
        let _ = std::fs::remove_file(&record_path);
        let _ = std::fs::remove_file(staged);
        let _ = sync_dir(dir);
    };
    let prepared = (|| -> Result<SwapRecord, AppCommandError> {
        let record = SwapRecord {
            server_sha256: file_sha256(staged).map_err(AppCommandError::io)?,
            cli,
        };
        write_swap_record(&record_path, &record)?;
        // This update's rollback will need its record: reserved now, while
        // there is room for it.
        create_synced(&rollback_slot_path(server)).map_err(AppCommandError::io)?;
        back_up_live(server, &pending)?;
        sync_dir(dir).map_err(AppCommandError::io)?;
        Ok(record)
    })();
    let record = match prepared {
        Ok(record) => record,
        Err(e) => {
            undo();
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(staged, server) {
        undo();
        return Err(AppCommandError::io(e));
    }
    let _ = sync_dir(dir);
    Ok(record)
}

/// The live `target` kept at `bak` (cleared first). On unix a hard link,
/// `target` staying in place so it is never missing — or, on a filesystem
/// without links, a flushed copy. Windows moves the live file aside instead:
/// it cannot rename over a running executable.
fn back_up_live(target: &Path, bak: &Path) -> Result<(), AppCommandError> {
    let _ = std::fs::remove_file(bak);
    #[cfg(unix)]
    {
        if std::fs::hard_link(target, bak).is_err() {
            copy_synced(target, bak)?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::rename(target, bak).map_err(AppCommandError::io)
    }
}

/// The swap's pending records replace the previous release's, by rename: the
/// server's backup, then the CLI's as the record says the swap changed it;
/// the swap record goes last. Each step is a no-op once done, so a swap that
/// stopped part-way is finished by running this again.
fn finish_swap(targets: &Targets, record: &SwapRecord) -> Result<(), AppCommandError> {
    let server_bak = bak_path(&targets.server_bin);
    promote(&next_path(&server_bak), &server_bak)?;
    let cli = &targets.cli_bin;
    let (bak, absent) = (bak_path(cli), absent_path(cli));
    match record.cli {
        CliChange::Replaced => {
            promote(&next_path(&bak), &bak)?;
            remove_if_there(&absent)?;
        }
        CliChange::Added => {
            promote(&next_path(&absent), &absent)?;
            remove_if_there(&bak)?;
        }
        CliChange::Untouched => {
            remove_if_there(&bak)?;
            remove_if_there(&absent)?;
        }
    }
    // The records final, durably, before the record that would redo them goes.
    let dirs = [targets.server_bin.parent(), cli.parent()];
    for dir in dirs.into_iter().flatten() {
        sync_dir(dir).map_err(AppCommandError::io)?;
    }
    remove_if_there(&swap_record_path(&targets.server_bin))?;
    if let Some(dir) = targets.server_bin.parent() {
        let _ = sync_dir(dir);
    }
    Ok(())
}

/// `pending` renamed over `record` when it is there — and gone for sure
/// after: were the two names one file (hard links), the rename would succeed
/// and leave both.
fn promote(pending: &Path, record: &Path) -> Result<(), AppCommandError> {
    match std::fs::rename(pending, record) {
        Ok(()) => remove_if_there(pending),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppCommandError::io(e)),
    }
}

/// What an attempt that died mid-swap left, settled before an update or a
/// rollback starts (or, before that, a rollback cut short: completed). A
/// swap record naming the live server means its rename
/// happened: the swap is finished. Otherwise — no record, or one naming a
/// server that never went live — it is undone: the server's pending backup
/// goes (or, moved aside on Windows and never replaced, comes back), and the
/// CLI goes back by its pending record. A failure stops whatever was about
/// to run. `true` when there was anything to settle.
fn settle_interrupted_swap(targets: &Targets) -> Result<bool, AppCommandError> {
    let server = &targets.server_bin;
    let mut settled = false;
    // A rollback cut short first: completed, it leaves one release whole.
    // Its record must go with it: nothing may start over one still there,
    // which would take what comes next for its own to redo.
    let rollback_record = rollback_record_path(server);
    if std::fs::symlink_metadata(&rollback_record).is_ok() {
        restore_backups(targets)?;
        if std::fs::symlink_metadata(&rollback_record).is_ok() {
            return Err(AppCommandError::io_error(format!(
                "The record of a rollback could not be removed: {}",
                rollback_record.display()
            )));
        }
        settled = true;
    }
    let record_path = swap_record_path(server);
    let record = read_swap_record(&record_path)?;
    if let Some(record) = &record {
        if file_has_sha256(server, &record.server_sha256)? {
            finish_swap(targets, record)?;
            return Ok(true);
        }
    }
    settled |= record.is_some();
    let pending = next_path(&bak_path(server));
    if std::fs::symlink_metadata(&pending).is_ok() {
        if std::fs::symlink_metadata(server).is_err() {
            std::fs::rename(&pending, server).map_err(AppCommandError::io)?;
        } else {
            remove_if_there(&pending)?;
        }
        settled = true;
    }
    let cli = &targets.cli_bin;
    settled |= recover_pending_cli(
        cli,
        &next_path(&bak_path(cli)),
        &next_path(&absent_path(cli)),
    )?;
    remove_if_there(&record_path)?;
    if let Some(dir) = server.parent() {
        let _ = sync_dir(dir);
    }
    Ok(settled)
}

/// Undo a complete swap (its staged marker could not be written): the swap
/// finished first, were its own finishing to have failed, then every
/// artifact back from its backup as a rollback does. A failure stops it —
/// restoring from records that are not final would mix releases, or worse —
/// and leaves the rest for the next update or rollback to settle.
fn undo_bundle(targets: &Targets) -> Result<(), AppCommandError> {
    settle_interrupted_swap(targets)?;
    restore_backups(targets)?;
    Ok(())
}

/// The rollback record (`<server>.rollback`), there while backups are being
/// restored: a rollback cut short is completed by the next update or
/// rollback before anything else, rather than leaving the server of one
/// release with the CLI of another.
fn rollback_record_path(server: &Path) -> PathBuf {
    let mut s = server.as_os_str().to_os_string();
    s.push(".rollback");
    PathBuf::from(s)
}

/// The rollback's reserved record (`<server>.rollback.slot`): an empty file
/// each update's commit leaves, for its rollback to rename into place — no
/// new inode needed, on a disk the failed release may have filled.
fn rollback_slot_path(server: &Path) -> PathBuf {
    let mut s = server.as_os_str().to_os_string();
    s.push(".rollback.slot");
    PathBuf::from(s)
}

/// The rollback record in place, durably: there already (a rollback cut
/// short), renamed from the slot an update reserved, or else created (an
/// update by an older release reserved none). Where even that finds no room
/// — the new name may need a directory block the slot did not reserve — the
/// restores go ahead without a record, as they did before there was one: a
/// rollback must not be lost to the full disk it may be rolling back from.
fn open_rollback_record(server: &Path) -> Result<(), AppCommandError> {
    let record = rollback_record_path(server);
    if std::fs::symlink_metadata(&record).is_ok() {
        return Ok(());
    }
    let without_record = |e: &std::io::Error| {
        tracing::warn!("[update] rolling back without a record: {e}");
    };
    let slot = rollback_slot_path(server);
    match std::fs::rename(&slot, &record) {
        Ok(()) => {
            return match server.parent().map_or(Ok(()), sync_dir) {
                Ok(()) => Ok(()),
                // In place, if perhaps not durably: the restores go ahead.
                Err(e) if lacks_room(&e) => {
                    tracing::warn!("[update] rolling back with a record not made durable: {e}");
                    Ok(())
                }
                // Nothing is restored yet: the record goes back to its slot.
                Err(e) => {
                    let _ = std::fs::rename(&record, &slot);
                    Err(AppCommandError::io(e))
                }
            };
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) if lacks_room(&e) => {
            without_record(&e);
            return Ok(());
        }
        Err(e) => return Err(AppCommandError::io(e)),
    }
    match create_synced(&record) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Nothing is restored yet: no record may claim otherwise.
            let _ = std::fs::remove_file(&record);
            if lacks_room(&e) {
                without_record(&e);
                Ok(())
            } else {
                Err(AppCommandError::io(e))
            }
        }
    }
}

/// A write refused for lack of space or of inodes (a quota included).
fn lacks_room(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded
    )
}

/// Every artifact back from its backup, the CLI by its records, under the
/// rollback record (see [`open_rollback_record`]). Each restore is a no-op
/// once done, so running this again completes one cut short. `true` when
/// anything was restored.
fn restore_backups(targets: &Targets) -> Result<bool, AppCommandError> {
    let cli = &targets.cli_bin;
    let backups = [
        bak_path(&targets.server_bin),
        bak_path(&targets.mcp_bin),
        bak_path(&targets.helper_bin),
        bak_path(cli),
        absent_path(cli),
        bak_path(&targets.web_dir),
    ];
    let any = backups
        .iter()
        .any(|bak| std::fs::symlink_metadata(bak).is_ok());
    if !any {
        retire_rollback_record(targets);
        return Ok(false);
    }
    open_rollback_record(&targets.server_bin)?;
    let mut restored = restore_from_bak(&targets.server_bin)?;
    restored |= restore_from_bak(&targets.mcp_bin)?;
    restored |= restore_from_bak(&targets.helper_bin)?;
    restored |= restore_cli_from_bak(cli)?;
    restored |= restore_dir_from_bak(&targets.web_dir)?;
    retire_rollback_record(targets);
    Ok(restored)
}

/// The rollback's record goes once its restores are durable. When that
/// cannot be done now it stays, for the next update or rollback to retire
/// (its restores no-ops by then): not a reason to call a rollback failed.
fn retire_rollback_record(targets: &Targets) {
    let record = rollback_record_path(&targets.server_bin);
    let dirs = [targets.server_bin.parent(), targets.web_dir.parent()];
    let retired = dirs
        .into_iter()
        .flatten()
        .try_for_each(sync_dir)
        .and_then(|()| std::fs::remove_file(&record));
    match retired {
        Ok(()) => {
            if let Some(dir) = targets.server_bin.parent() {
                let _ = sync_dir(dir);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("[update] the rollback's record stays for now: {e}"),
    }
}

/// The CLI of an attempt that died before its commit, undone by its pending
/// record: a CLI it added goes, one it replaced comes back — unless a link
/// is there by now, which stays. A pending record goes only once it was
/// acted on: a failure keeps it, and stops whatever was about to run (an
/// update, a rollback). `true` when there was one.
fn recover_pending_cli(
    cli: &Path,
    next_bak: &Path,
    next_absent: &Path,
) -> Result<bool, AppCommandError> {
    let ours = cli_is_ours_to_replace(cli);
    if next_absent.exists() {
        if ours {
            match std::fs::remove_file(cli) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(AppCommandError::io(e)),
            }
        }
        std::fs::remove_file(next_absent).map_err(AppCommandError::io)?;
    } else if next_bak.exists() {
        if ours {
            std::fs::rename(next_bak, cli).map_err(AppCommandError::io)?;
        }
        // Also after the rename: an attempt that died right after making the
        // pending backup left it a hard link to the live CLI, and a rename
        // between two links to one file succeeds without removing either.
        remove_if_there(next_bak)?;
    } else {
        return Ok(false);
    }
    if let Some(dir) = cli.parent() {
        let _ = sync_dir(dir);
    }
    Ok(true)
}

fn remove_if_there(path: &Path) -> Result<(), AppCommandError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppCommandError::io(e)),
    }
}

fn create_synced(path: &Path) -> std::io::Result<()> {
    std::fs::File::create(path)?.sync_all()?;
    if let Some(dir) = path.parent() {
        sync_dir(dir)?;
    }
    Ok(())
}

fn next_path(record: &Path) -> PathBuf {
    let mut s = record.as_os_str().to_os_string();
    s.push(".next");
    PathBuf::from(s)
}

/// The marker of a `codeg-cli` an update added where there was none: what a
/// rollback of that update removes.
fn absent_path(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_os_string();
    s.push(".absent");
    PathBuf::from(s)
}

/// The CLI's rollback. A CLI the update added is removed; one it replaced
/// gets its backup back — unless a symlink is there now (the desktop app's
/// command, or the user's), which no rollback replaces.
fn restore_cli_from_bak(target: &Path) -> Result<bool, AppCommandError> {
    let linked = !cli_is_ours_to_replace(target);
    let absent = absent_path(target);
    if absent.exists() {
        if !linked {
            remove_if_there(target)?;
        }
        remove_if_there(&absent)?;
        return Ok(true);
    }
    if linked {
        remove_if_there(&bak_path(target))?;
        return Ok(false);
    }
    restore_from_bak(target)
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
            helper_bin: bindir.join("codeg-computer-helper"),
            cli_bin: bindir.join("codeg-cli"),
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

    /// The computer-use helper is rolled back with the server, so the two
    /// stay built from the same sources — the server refuses a helper that
    /// is not.
    #[test]
    fn a_rollback_takes_the_helper_back_with_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        std::fs::write(&targets.helper_bin, b"new").unwrap();
        std::fs::write(bak_path(&targets.helper_bin), b"old").unwrap();

        rollback_targets(&targets, |_| Ok(())).unwrap();

        assert_eq!(std::fs::read(&targets.server_bin).unwrap(), b"old");
        assert_eq!(std::fs::read(&targets.helper_bin).unwrap(), b"old");
    }

    /// The CLI goes back with the server too: a newer one would talk to the
    /// older server it was rolled back to.
    #[test]
    fn a_rollback_takes_the_cli_back_with_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        std::fs::write(&targets.cli_bin, b"new").unwrap();
        std::fs::write(bak_path(&targets.cli_bin), b"old").unwrap();

        rollback_targets(&targets, |_| Ok(())).unwrap();

        assert_eq!(std::fs::read(&targets.server_bin).unwrap(), b"old");
        assert_eq!(std::fs::read(&targets.cli_bin).unwrap(), b"old");
    }

    /// A CLI the update added (none was there) goes again with the rollback,
    /// even one after the restart: the marker says it was added.
    #[test]
    fn a_rollback_takes_away_a_cli_the_update_added() {
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        std::fs::write(&targets.cli_bin, b"new").unwrap();
        std::fs::write(absent_path(&targets.cli_bin), b"").unwrap();

        rollback_targets(&targets, |_| Ok(())).unwrap();

        assert!(!targets.cli_bin.exists());
        assert!(!absent_path(&targets.cli_bin).exists());
        assert_eq!(std::fs::read(&targets.server_bin).unwrap(), b"old");
    }

    /// A symlink put in place of the CLI after an update is not rolled back
    /// over by that update's backup.
    #[cfg(unix)]
    #[test]
    fn a_rollback_leaves_a_linked_cli_alone() {
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        let desktop = dir.path().join("desktop-cli");
        std::fs::write(&desktop, b"desktop").unwrap();
        std::os::unix::fs::symlink(&desktop, &targets.cli_bin).unwrap();
        std::fs::write(bak_path(&targets.cli_bin), b"old").unwrap();

        rollback_targets(&targets, |_| Ok(())).unwrap();

        assert!(std::fs::symlink_metadata(&targets.cli_bin)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&targets.cli_bin).unwrap(), b"desktop");
        assert!(!bak_path(&targets.cli_bin).exists());
    }

    /// An install upgraded once (release A → B): live B files with A's
    /// backups, the CLI included; and the bundle of release C to swap in.
    fn second_update(dir: &Path) -> (Targets, PathBuf) {
        let targets = upgraded_install(dir);
        std::fs::write(&targets.mcp_bin, b"B").unwrap();
        std::fs::write(&targets.cli_bin, b"B").unwrap();
        std::fs::write(bak_path(&targets.cli_bin), b"A").unwrap();
        let bundle = dir.join("bundle");
        std::fs::create_dir_all(bundle.join("web")).unwrap();
        std::fs::write(bundle.join("web").join("index.html"), b"C").unwrap();
        for name in ["codeg-server", "codeg-mcp", "codeg-cli"] {
            std::fs::write(bundle.join(name), b"C").unwrap();
        }
        (targets, bundle)
    }

    fn bundle_of(dir: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf) {
        (
            dir.join("codeg-server"),
            dir.join("codeg-mcp"),
            dir.join("codeg-computer-helper"),
            dir.join("codeg-cli"),
            dir.join("web"),
        )
    }

    fn swap(targets: &Targets, bundle: &Path) -> Result<(), AppCommandError> {
        let (server, mcp, helper, cli, web) = bundle_of(bundle);
        swap_bundle(
            targets,
            &Bundle {
                server: &server,
                mcp: &mcp,
                helper: &helper,
                cli: &cli,
                web: &web,
            },
        )
    }

    fn read(path: &Path) -> Vec<u8> {
        std::fs::read(path).unwrap()
    }

    /// The CLI's records change release with the server's backup: after a
    /// swap both are B's; undone (the staged marker failed), neither is left
    /// pointing at A while the server stays B.
    #[test]
    fn the_cli_records_follow_the_servers_backup() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.cli_bin), b"C");
        assert_eq!(read(&bak_path(&targets.cli_bin)), b"B");
        assert_eq!(read(&bak_path(&targets.server_bin)), b"new", "B's server");
        assert!(!next_path(&bak_path(&targets.cli_bin)).exists());

        undo_bundle(&targets).unwrap();
        assert_eq!(read(&targets.cli_bin), b"B");
        assert_eq!(read(&targets.server_bin), b"new");
        assert!(!bak_path(&targets.cli_bin).exists());
        assert!(!bak_path(&targets.server_bin).exists());
    }

    /// A failure before the server's backup changed keeps A's records for
    /// both, and puts the live CLI back.
    #[test]
    fn a_failure_before_the_server_keeps_the_previous_release_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        std::fs::remove_file(bundle.join("codeg-server")).unwrap();
        assert!(swap(&targets, &bundle).is_err());
        assert_eq!(read(&targets.cli_bin), b"B");
        assert_eq!(read(&bak_path(&targets.cli_bin)), b"A");
        assert_eq!(read(&bak_path(&targets.server_bin)), b"old", "A's server");
        assert!(!next_path(&bak_path(&targets.cli_bin)).exists());
    }

    /// Without a CLI in the bundle the update leaves the CLI as it is, and
    /// its records of A go with the server's backup of A.
    #[test]
    fn an_update_without_a_cli_retires_the_previous_records() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        std::fs::remove_file(bundle.join("codeg-cli")).unwrap();
        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.cli_bin), b"B");
        assert!(!bak_path(&targets.cli_bin).exists());
        rollback_targets(&targets, |_| Ok(())).unwrap();
        assert_eq!(read(&targets.cli_bin), b"B", "this update never touched it");
    }

    /// A CLI the update added is marked with the server's backup, and goes
    /// again with a rollback.
    #[test]
    fn a_cli_the_update_added_goes_with_its_rollback() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        std::fs::remove_file(&targets.cli_bin).unwrap();
        std::fs::remove_file(bak_path(&targets.cli_bin)).unwrap();
        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.cli_bin), b"C");
        assert!(absent_path(&targets.cli_bin).exists());
        rollback_targets(&targets, |_| Ok(())).unwrap();
        assert!(!targets.cli_bin.exists());
        assert!(!absent_path(&targets.cli_bin).exists());
    }

    /// An attempt that died after swapping the CLI and before the server
    /// left its pending backup: the next attempt puts that CLI back first, so
    /// the records it makes are those of the release really live.
    #[test]
    fn an_attempt_that_died_mid_swap_is_undone_by_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        // Died with CLI C committed, its backup of B pending, server still B.
        std::fs::write(next_path(&bak_path(&targets.cli_bin)), b"B").unwrap();
        std::fs::write(&targets.cli_bin, b"C").unwrap();

        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.cli_bin), b"C");
        assert_eq!(read(&bak_path(&targets.cli_bin)), b"B", "B's CLI, not C");
        assert_eq!(
            read(&bak_path(&targets.server_bin)),
            b"new",
            "with B's server"
        );
    }

    /// The same for an attempt that died having added the CLI.
    #[test]
    fn an_addition_that_died_mid_swap_is_undone_by_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        std::fs::remove_file(bak_path(&targets.cli_bin)).unwrap();
        std::fs::write(&targets.cli_bin, b"C").unwrap();
        std::fs::write(next_path(&absent_path(&targets.cli_bin)), b"").unwrap();

        swap(&targets, &bundle).unwrap();
        assert!(
            absent_path(&targets.cli_bin).exists(),
            "added by this update"
        );
        assert!(!bak_path(&targets.cli_bin).exists());
        rollback_targets(&targets, |_| Ok(())).unwrap();
        assert!(!targets.cli_bin.exists());
    }

    /// A rollback after an attempt that died mid-swap consumes its pending
    /// records: the CLI goes back to the stable backup's release, and nothing
    /// is left for the next update to replay.
    #[test]
    fn a_rollback_consumes_what_a_dead_attempt_left_pending() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, _) = second_update(dir.path());
        std::fs::write(next_path(&bak_path(&targets.cli_bin)), b"B").unwrap();
        std::fs::write(&targets.cli_bin, b"C").unwrap();

        rollback_targets(&targets, |_| Ok(())).unwrap();
        assert_eq!(read(&targets.cli_bin), b"A");
        assert_eq!(read(&targets.server_bin), b"old");
        assert!(!next_path(&bak_path(&targets.cli_bin)).exists());
    }

    /// An attempt that died right after making the pending backup left it a
    /// hard link to the live CLI: recovery still consumes it (a rename
    /// between two links to one file removes neither).
    #[cfg(unix)]
    #[test]
    fn a_pending_backup_that_is_the_live_cli_is_still_consumed() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, _) = second_update(dir.path());
        let next_bak = next_path(&bak_path(&targets.cli_bin));
        std::fs::hard_link(&targets.cli_bin, &next_bak).unwrap();

        rollback_targets(&targets, |_| Ok(())).unwrap();
        assert!(!next_bak.exists());
        assert_eq!(read(&targets.cli_bin), b"A");
    }

    /// An attempt B → C that died in the server's commit, as `change` says
    /// it changed the CLI: its pending CLI record, the swap record naming C,
    /// B's server kept as the pending backup — and C live when `renamed`.
    fn died_in_the_commit(targets: &Targets, bundle: &Path, change: CliChange, renamed: bool) {
        let cli = &targets.cli_bin;
        match change {
            CliChange::Replaced => {
                std::fs::rename(cli, next_path(&bak_path(cli))).unwrap();
                std::fs::write(cli, b"C").unwrap();
            }
            CliChange::Added => {
                // B had no CLI, and A → B left it so.
                std::fs::remove_file(bak_path(cli)).unwrap();
                std::fs::write(next_path(&absent_path(cli)), b"").unwrap();
                std::fs::write(cli, b"C").unwrap();
            }
            CliChange::Untouched => {}
        }
        let server = &targets.server_bin;
        let record = SwapRecord {
            server_sha256: file_sha256(&bundle.join("codeg-server")).unwrap(),
            cli: change,
        };
        write_swap_record(&swap_record_path(server), &record).unwrap();
        std::fs::copy(server, next_path(&bak_path(server))).unwrap();
        if renamed {
            std::fs::write(server, b"C").unwrap();
        }
    }

    fn with_suffix(path: PathBuf, suffix: &str) -> PathBuf {
        let mut path = path.into_os_string();
        path.push(suffix);
        PathBuf::from(path)
    }

    fn assert_left_nothing(targets: &Targets) {
        for left in [
            swap_record_path(&targets.server_bin),
            next_path(&bak_path(&targets.server_bin)),
            next_path(&bak_path(&targets.cli_bin)),
            next_path(&absent_path(&targets.cli_bin)),
        ] {
            assert!(!left.exists(), "{} left behind", left.display());
        }
    }

    /// An attempt that died in the server's commit is finished when its
    /// server went live and undone when not, whatever it did to the CLI: a
    /// rollback then brings back one release whole — B's server and CLI
    /// when C went live, A's when it did not.
    #[test]
    fn a_dead_attempt_is_finished_or_undone_as_its_server_went_live_or_not() {
        use CliChange::{Added, Replaced, Untouched};
        // What it did to the CLI, whether C went live; the server and the
        // CLI a rollback then brings back.
        type Case = (CliChange, bool, &'static [u8], Option<&'static [u8]>);
        let cases: [Case; 6] = [
            (Replaced, false, b"old", Some(b"A")),
            (Replaced, true, b"new", Some(b"B")),
            (Added, false, b"old", None),
            (Added, true, b"new", None),
            (Untouched, false, b"old", Some(b"A")),
            (Untouched, true, b"new", Some(b"B")),
        ];
        for (change, renamed, server, cli) in cases {
            let dir = tempfile::tempdir().unwrap();
            let (targets, bundle) = second_update(dir.path());
            died_in_the_commit(&targets, &bundle, change, renamed);

            rollback_targets(&targets, |_| Ok(())).unwrap();
            let case = format!("{change:?}, renamed: {renamed}");
            assert_eq!(read(&targets.server_bin), server, "{case}");
            let live_cli = std::fs::read(&targets.cli_bin).ok();
            assert_eq!(live_cli.as_deref(), cli, "{case}");
            assert_left_nothing(&targets);
        }
    }

    /// Retried instead, an attempt that died before the server's rename is
    /// undone first, so the records the retry makes are B's for both: a
    /// rollback after it brings back B's server with B's CLI, not C's.
    #[test]
    fn an_attempt_that_died_before_the_servers_rename_is_undone_by_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        died_in_the_commit(&targets, &bundle, CliChange::Replaced, false);

        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.server_bin), b"C");
        assert_eq!(read(&targets.cli_bin), b"C");
        assert_eq!(read(&bak_path(&targets.server_bin)), b"new", "B's server");
        assert_eq!(read(&bak_path(&targets.cli_bin)), b"B", "B's CLI, not C");
        assert_left_nothing(&targets);
        rollback_targets(&targets, |_| Ok(())).unwrap();
        assert_eq!(read(&targets.server_bin), b"new");
        assert_eq!(read(&targets.cli_bin), b"B");
    }

    /// Finishing redoes nothing twice: a finish that stopped after the
    /// server's backup, or after the CLI's too, is completed as it was.
    #[test]
    fn a_finish_that_stopped_part_way_is_completed() {
        for steps_done in 1..=2 {
            let dir = tempfile::tempdir().unwrap();
            let (targets, bundle) = second_update(dir.path());
            died_in_the_commit(&targets, &bundle, CliChange::Replaced, true);
            let server_bak = bak_path(&targets.server_bin);
            promote(&next_path(&server_bak), &server_bak).unwrap();
            if steps_done == 2 {
                let cli_bak = bak_path(&targets.cli_bin);
                promote(&next_path(&cli_bak), &cli_bak).unwrap();
            }

            rollback_targets(&targets, |_| Ok(())).unwrap();
            assert_eq!(read(&targets.server_bin), b"new", "{steps_done} steps");
            assert_eq!(read(&targets.cli_bin), b"B", "{steps_done} steps");
            assert_left_nothing(&targets);
        }
    }

    /// Where the commit moves the live server aside (Windows), one that died
    /// before the staged server took its place gets it back first.
    #[test]
    fn a_server_moved_aside_and_never_replaced_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        died_in_the_commit(&targets, &bundle, CliChange::Replaced, false);
        std::fs::remove_file(&targets.server_bin).unwrap();

        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.server_bin), b"C");
        assert_eq!(read(&bak_path(&targets.server_bin)), b"new", "B's server");
        assert_eq!(read(&bak_path(&targets.cli_bin)), b"B");
        assert_left_nothing(&targets);
    }

    /// A failure after the rename does not fail the update: the swap record
    /// stays, and the rollback that follows finishes the swap before it
    /// restores from its records.
    #[test]
    fn a_swap_whose_finish_failed_is_finished_by_the_rollback() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        // A directory where the server's backup goes: the rename fails.
        let server_bak = bak_path(&targets.server_bin);
        std::fs::remove_file(&server_bak).unwrap();
        std::fs::create_dir_all(server_bak.join("in-the-way")).unwrap();

        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.server_bin), b"C");
        assert!(swap_record_path(&targets.server_bin).exists());

        std::fs::remove_dir_all(&server_bak).unwrap();
        rollback_targets(&targets, |_| Ok(())).unwrap();
        assert_eq!(read(&targets.server_bin), b"new");
        assert_eq!(read(&targets.cli_bin), b"B");
        assert_left_nothing(&targets);
    }

    /// A failure writing the swap record fails the update with the previous
    /// release whole, and leaves nothing of the commit behind.
    #[test]
    fn a_commit_that_failed_writing_its_record_leaves_the_previous_release_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        let record_tmp = with_suffix(swap_record_path(&targets.server_bin), ".tmp");
        std::fs::create_dir_all(record_tmp.join("in-the-way")).unwrap();

        assert!(swap(&targets, &bundle).is_err());
        assert_eq!(read(&targets.server_bin), b"new");
        assert_eq!(read(&targets.cli_bin), b"B");
        assert_eq!(read(&bak_path(&targets.server_bin)), b"old");
        assert_eq!(read(&bak_path(&targets.cli_bin)), b"A");
        assert_left_nothing(&targets);
        let staged = targets.server_bin.with_file_name(".codeg-server.new");
        assert!(!staged.exists());
    }

    /// A failure backing up the live server, once the record is written,
    /// takes the record back with the staged server: nothing claims a
    /// commit that never happened.
    #[test]
    fn a_commit_that_failed_backing_up_the_server_takes_its_record_back() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        let server = &targets.server_bin;
        let staged = stage_file(server, &bundle.join("codeg-server")).unwrap();
        let pending = next_path(&bak_path(server));
        std::fs::create_dir_all(pending.join("in-the-way")).unwrap();

        assert!(commit_server(server, &staged, CliChange::Replaced).is_err());
        assert_eq!(read(server), b"new");
        assert!(!swap_record_path(server).exists());
        assert!(!staged.exists());
        assert!(!with_suffix(pending, ".tmp").exists());
    }

    /// A backup that is a hard link to the live server — what an older
    /// release's commit leaves when it dies between its link and its rename
    /// — is replaced cleanly: promoting a pending backup that is the same
    /// file renames nothing, and the pending name still goes.
    #[cfg(unix)]
    #[test]
    fn a_backup_linked_to_the_live_server_is_replaced_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        let server_bak = bak_path(&targets.server_bin);
        std::fs::remove_file(&server_bak).unwrap();
        std::fs::hard_link(&targets.server_bin, &server_bak).unwrap();

        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.server_bin), b"C");
        assert_eq!(read(&server_bak), b"new");
        assert_left_nothing(&targets);
    }

    #[test]
    fn a_swap_record_reads_back_and_refuses_anything_else() {
        let record = SwapRecord {
            server_sha256: "ab".repeat(32),
            cli: CliChange::Added,
        };
        assert_eq!(SwapRecord::parse(&record.to_text()), Some(record));
        let (sha, short) = ("ab".repeat(32), "ab".repeat(31));
        for text in [
            String::new(),
            "cli added\n".to_string(),
            format!("server-sha256 {sha}\n"),
            format!("server-sha256 {sha}\ncli moved\n"),
            format!("server-sha256 {short}\ncli added\n"),
            format!("server-sha256 {sha}\ncli added\nmore\n"),
        ] {
            assert_eq!(SwapRecord::parse(&text), None, "{text:?}");
        }
    }

    /// A rollback cut short — here by an mcp it cannot restore, after the
    /// server — is completed by whatever runs next, before anything else: an
    /// update then backs up B's CLI with B's server, not C's, and a rollback
    /// brings back B whole either way.
    #[test]
    fn a_rollback_cut_short_is_completed_by_what_runs_next() {
        for next in ["update", "rollback"] {
            let dir = tempfile::tempdir().unwrap();
            let (targets, bundle) = second_update(dir.path());
            swap(&targets, &bundle).unwrap();
            std::fs::remove_file(&targets.mcp_bin).unwrap();
            std::fs::create_dir_all(targets.mcp_bin.join("in-the-way")).unwrap();
            assert!(rollback_targets(&targets, |_| Ok(())).is_err());
            assert_eq!(read(&targets.server_bin), b"new", "the server went back");
            assert_eq!(read(&targets.cli_bin), b"C", "the CLI did not");
            assert!(rollback_record_path(&targets.server_bin).exists());
            std::fs::remove_dir_all(&targets.mcp_bin).unwrap();

            if next == "update" {
                swap(&targets, &bundle).unwrap();
                assert_eq!(read(&bak_path(&targets.cli_bin)), b"B", "B's CLI, not C");
            }
            rollback_targets(&targets, |_| Ok(())).unwrap();
            assert_eq!(read(&targets.server_bin), b"new", "{next}");
            assert_eq!(read(&targets.cli_bin), b"B", "{next}");
            assert!(!rollback_record_path(&targets.server_bin).exists());
        }
    }

    /// A file's inode, where there are inodes.
    fn file_id(path: &Path) -> Option<u64> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(path).ok().map(|meta| meta.ino())
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            None
        }
    }

    /// A rollback's record is the slot its update reserved, renamed — no new
    /// inode needed — or, with none (an update by an older release), made.
    #[test]
    fn a_rollback_record_is_the_slot_its_update_reserved() {
        for reserved in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let (targets, bundle) = second_update(dir.path());
            swap(&targets, &bundle).unwrap();
            let slot = rollback_slot_path(&targets.server_bin);
            assert!(slot.exists(), "the update reserves it");
            if !reserved {
                std::fs::remove_file(&slot).unwrap();
            }
            let slot_id = file_id(&slot);
            // Cut short by an mcp it cannot restore: the record stays.
            std::fs::remove_file(&targets.mcp_bin).unwrap();
            std::fs::create_dir_all(targets.mcp_bin.join("in-the-way")).unwrap();
            assert!(rollback_targets(&targets, |_| Ok(())).is_err());

            let record = rollback_record_path(&targets.server_bin);
            assert!(record.exists(), "reserved: {reserved}");
            assert!(!slot.exists(), "reserved: {reserved}");
            if reserved {
                assert_eq!(file_id(&record), slot_id, "renamed, not made");
            }
        }
    }

    #[test]
    fn only_a_lack_of_room_lets_a_rollback_go_without_its_record() {
        use std::io::{Error, ErrorKind};
        assert!(lacks_room(&Error::from(ErrorKind::StorageFull)));
        assert!(lacks_room(&Error::from(ErrorKind::QuotaExceeded)));
        assert!(!lacks_room(&Error::from(ErrorKind::PermissionDenied)));
        assert!(!lacks_room(&Error::from(ErrorKind::ReadOnlyFilesystem)));
        #[cfg(unix)]
        for errno in [libc::ENOSPC, libc::EDQUOT] {
            assert!(lacks_room(&Error::from_raw_os_error(errno)), "{errno}");
        }
    }

    /// A record that cannot be retired does not fail the restores it kept:
    /// they are done, and it stays to be retired later.
    #[test]
    fn restores_are_done_even_when_their_record_cannot_be_retired() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        swap(&targets, &bundle).unwrap();
        let record = rollback_record_path(&targets.server_bin);
        std::fs::create_dir_all(record.join("in-the-way")).unwrap();

        assert!(restore_backups(&targets).unwrap());
        assert_eq!(read(&targets.server_bin), b"new");
        assert_eq!(read(&targets.cli_bin), b"B");
        assert!(record.exists());
    }

    /// Nothing starts over a rollback's record still there: an update that
    /// finds one it cannot retire stops before it touches anything, and goes
    /// ahead once it can.
    #[test]
    fn a_rollback_record_still_there_holds_off_the_next_update() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        swap(&targets, &bundle).unwrap();
        rollback_targets(&targets, |_| Ok(())).unwrap();
        let record = rollback_record_path(&targets.server_bin);
        std::fs::create_dir_all(record.join("in-the-way")).unwrap();

        assert!(swap(&targets, &bundle).is_err());
        assert_eq!(read(&targets.server_bin), b"new");
        assert_eq!(read(&targets.cli_bin), b"B");
        std::fs::remove_dir_all(&record).unwrap();
        swap(&targets, &bundle).unwrap();
        assert_eq!(read(&targets.server_bin), b"C");
    }

    /// An undo that cannot settle the swap restores nothing: from records
    /// that are not final it would leave two releases mixed. Here the
    /// finish's last step is in the way, so the CLI's records are B's but
    /// the swap is not settled: C stays, whole.
    #[test]
    fn an_undo_that_cannot_settle_the_swap_restores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (targets, bundle) = second_update(dir.path());
        let absent = absent_path(&targets.cli_bin);
        std::fs::create_dir_all(absent.join("in-the-way")).unwrap();
        swap(&targets, &bundle).unwrap();
        assert!(swap_record_path(&targets.server_bin).exists());

        assert!(undo_bundle(&targets).is_err());
        assert_eq!(read(&targets.server_bin), b"C");
        assert_eq!(read(&targets.cli_bin), b"C");
        assert!(swap_record_path(&targets.server_bin).exists());
    }

    /// A restore never takes the live file away for a backup that is not a
    /// file: the rename over it fails, and the live file stays.
    #[cfg(unix)]
    #[test]
    fn a_restore_keeps_the_live_file_when_the_backup_is_not_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        let server_bak = bak_path(&targets.server_bin);
        std::fs::remove_file(&server_bak).unwrap();
        std::fs::create_dir_all(server_bak.join("in-the-way")).unwrap();

        assert!(restore_from_bak(&targets.server_bin).is_err());
        assert_eq!(read(&targets.server_bin), b"new");
    }

    /// A backup that is the live file itself (hard links) is consumed all
    /// the same: a rename between two names of one file removes neither.
    #[cfg(unix)]
    #[test]
    fn a_restore_from_a_backup_linked_to_the_live_file_consumes_it() {
        let dir = tempfile::tempdir().unwrap();
        let targets = upgraded_install(dir.path());
        let server_bak = bak_path(&targets.server_bin);
        std::fs::remove_file(&server_bak).unwrap();
        std::fs::hard_link(&targets.server_bin, &server_bak).unwrap();

        assert!(restore_from_bak(&targets.server_bin).unwrap());
        assert!(!server_bak.exists());
        assert_eq!(read(&targets.server_bin), b"new");
    }

    #[test]
    fn the_cli_is_replaced_when_absent_or_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("codeg-cli");
        assert!(cli_is_ours_to_replace(&target), "nothing there yet");
        std::fs::write(&target, b"old").unwrap();
        assert!(
            cli_is_ours_to_replace(&target),
            "the one install.sh put there"
        );
    }

    /// The desktop app's command linked next to the server (`install.sh`
    /// keeps it), or the user's own link: never replaced by the update, and
    /// a rollback has nothing to put back over it.
    #[cfg(unix)]
    #[test]
    fn a_linked_cli_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("codeg.app/Contents/MacOS");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("codeg-cli"), b"desktop").unwrap();
        let target = dir.path().join("codeg-cli");
        std::os::unix::fs::symlink(app.join("codeg-cli"), &target).unwrap();
        assert!(!cli_is_ours_to_replace(&target));

        // A dangling link is someone's choice all the same.
        std::fs::remove_file(app.join("codeg-cli")).unwrap();
        assert!(!cli_is_ours_to_replace(&target));
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

    /// macOS holds what a person grants the server — Full Disk Access and the
    /// other privacy permissions — to the designated requirement of the
    /// executable at the path it was granted to, and an update puts another
    /// build at that path. Ad-hoc signed, the requirement is the build's own
    /// cdhash, so every update took the grant back (#1035). The release signs
    /// the server's macOS executables with its Developer ID under fixed
    /// identifiers — before they are archived, as the update installs the
    /// archive — and leaves the computer-use helper out: one carrying a Team
    /// ID without codeg's designated requirement compiled in refuses to
    /// start, and the server build pins none.
    #[test]
    fn the_release_signs_the_macos_server_with_its_developer_id_before_archiving_it() {
        fn run_of(step: &serde_yaml::Value) -> &str {
            step["run"].as_str().unwrap_or_default()
        }
        let workflow: serde_yaml::Value = serde_yaml::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../.github/workflows/release.yml"
            ))
            .unwrap(),
        )
        .unwrap();
        let steps = workflow["jobs"]["build-server"]["steps"]
            .as_sequence()
            .expect("the build-server job's steps");

        let sign = steps
            .iter()
            .position(|step| {
                let run = run_of(step);
                run.contains("codesign") && run.contains("--sign \"$APPLE_SIGNING_IDENTITY\"")
            })
            .expect("build-server signs nothing with the Developer ID");
        let script = run_of(&steps[sign]);
        assert_eq!(
            steps[sign]["if"].as_str(),
            Some("contains(matrix.target, 'apple-darwin')"),
            "the signing step runs for the macOS targets"
        );
        for flag in ["--identifier \"$bin\"", "--options runtime", "--timestamp"] {
            assert!(script.contains(flag), "codesign is not given {flag}");
        }
        let signed: Vec<&str> = script
            .lines()
            .find_map(|line| line.trim().strip_prefix("for bin in "))
            .expect("the loop over the executables to sign")
            .trim_end_matches("; do")
            .split_whitespace()
            .collect();
        assert_eq!(signed, ["codeg-server", "codeg-mcp", "codeg-cli"]);
        assert!(
            !script.contains("codeg-computer-helper"),
            "the helper refuses to start with a Team ID and no peer requirement"
        );

        let archive = steps
            .iter()
            .position(|step| run_of(step).contains("tar czf ${{ matrix.artifact }}.tar.gz"))
            .expect("build-server makes no .tar.gz release archive");
        assert!(
            sign < archive,
            "the executables are signed after they went into the archive"
        );
    }
}
