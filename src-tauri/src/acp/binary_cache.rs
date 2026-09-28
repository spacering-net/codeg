use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::acp::cursor_acp_retry_compat;
use crate::acp::error::AcpError;
use crate::acp::registry;
use crate::models::agent::AgentType;

/// Process-local counter appended to rename-aside trash directory names. Guards
/// against the rare case where two `clear_agent_cache` calls land in the same
/// `SystemTime::now()` tick (Windows `GetSystemTimePreciseAsFileTime` has ~100ns
/// resolution) and would otherwise collide on the rename target.
static TRASH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Root for codeg-managed agent binaries.
///
/// Resolution order mirrors `paths.rs`:
/// 1. `$CODEG_HOME/acp-binaries`
/// 2. `$CODEG_DATA_DIR/acp-binaries` (server mode)
/// 3. `<data-local>/app.codeg/acp-binaries`
///
/// **Not** `dirs::cache_dir()`, which is where this used to live. On Windows
/// the two are the same directory (`%LOCALAPPDATA%`), so nothing moves there.
/// On macOS `cache_dir()` is `~/Library/Caches`, which the platform documents
/// as reclaimable and which storage optimization, APFS purging and third-party
/// cleaners all treat as fair game; on Linux `~/.cache` is XDG-defined as safe
/// to delete. Neither is a defensible home for several hundred megabytes of
/// agent runtime that cannot be regenerated without a network round trip —
/// losing it presents to the user as "the agent I installed is gone".
pub(crate) fn cache_dir() -> Result<PathBuf, AcpError> {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(custom).join("acp-binaries"));
    }
    if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(data).join("acp-binaries"));
    }
    let base = dirs::data_local_dir()
        .ok_or_else(|| AcpError::DownloadFailed("cannot determine data directory".into()))?;
    Ok(base.join("app.codeg").join("acp-binaries"))
}

/// The pre-relocation root, when it is a DIFFERENT directory that still exists.
///
/// `None` once migration has finished — and permanently `None` on Windows and
/// under either env override, where old and new resolve to the same path. Every
/// read-through below is therefore a transient state that ends when
/// [`migrate_legacy_root`] succeeds, never a steady-state dual root.
pub(crate) fn legacy_cache_dir() -> Option<PathBuf> {
    let legacy = dirs::cache_dir()?.join("app.codeg").join("acp-binaries");
    let current = cache_dir().ok()?;
    (legacy != current && legacy.is_dir()).then_some(legacy)
}

/// Directory where codeg caches a managed `uv` toolchain (`uv` + `uvx`),
/// downloaded on demand when the user has no system `uv` (used to launch
/// custom Python ACP agents). Layout:
/// `<cache_dir>/uv-tool/<platform>/{uv,uvx}`.
pub(crate) fn uv_tool_dir() -> Result<PathBuf, AcpError> {
    Ok(cache_dir()?
        .join("uv-tool")
        .join(registry::current_platform()))
}

/// Locate a codeg-managed uv tool binary (`uv` or `uvx`) if it has already
/// been downloaded into the cache. Returns `None` when not present, so
/// callers fall back to PATH / common install locations.
pub fn find_cached_uv_tool(tool: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    };
    let path = uv_tool_dir().ok()?.join(exe);
    path.is_file().then_some(path)
}

/// Pinned `uv` toolchain version codeg downloads on demand when the user has no
/// system `uv` (used to launch custom Python ACP agents).
const UV_TOOL_VERSION: &str = "0.8.10";

/// Build the astral-sh/uv release archive URL for the current platform.
fn uv_archive_url() -> Option<String> {
    let (target, ext) = match registry::current_platform() {
        "darwin-aarch64" => ("aarch64-apple-darwin", "tar.gz"),
        "darwin-x86_64" => ("x86_64-apple-darwin", "tar.gz"),
        "linux-aarch64" => ("aarch64-unknown-linux-gnu", "tar.gz"),
        "linux-x86_64" => ("x86_64-unknown-linux-gnu", "tar.gz"),
        "windows-aarch64" => ("aarch64-pc-windows-msvc", "zip"),
        "windows-x86_64" => ("x86_64-pc-windows-msvc", "zip"),
        _ => return None,
    };
    Some(format!(
        "https://github.com/astral-sh/uv/releases/download/{UV_TOOL_VERSION}/uv-{target}.{ext}"
    ))
}

/// Download + cache the `uv` toolchain (`uv` + `uvx`) into codeg's cache when no
/// system `uv` is available, so Python ACP agents work with zero prerequisites.
/// Idempotent: returns the cached `uvx` path immediately if already present.
pub async fn ensure_uv_tool(on_progress: impl Fn(&str)) -> Result<PathBuf, AcpError> {
    if let Some(uvx) = find_cached_uv_tool("uvx") {
        on_progress("uv already cached, skipping download");
        return Ok(uvx);
    }

    let url = uv_archive_url().ok_or_else(|| {
        AcpError::PlatformNotSupported(format!(
            "uv is not available for platform {}",
            registry::current_platform()
        ))
    })?;

    let dir = uv_tool_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to create uv cache dir: {e}")))?;
    let tmp_dir = dir.join(".tmp");
    if tmp_dir.exists() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to create tmp dir: {e}")))?;

    let (uv_name, uvx_name) = if cfg!(windows) {
        ("uv.exe", "uvx.exe")
    } else {
        ("uv", "uvx")
    };

    let result: Result<PathBuf, AcpError> = async {
        let archive_path = tmp_dir.join("archive");
        on_progress(&format!("Downloading uv {UV_TOOL_VERSION}..."));
        download_file_with_progress(&url, &archive_path, &on_progress).await?;

        let extract_dir = tmp_dir.join("extracted");
        std::fs::create_dir_all(&extract_dir)
            .map_err(|e| AcpError::DownloadFailed(format!("failed to create extract dir: {e}")))?;

        on_progress("Extracting uv...");
        if url.ends_with(".tar.gz") {
            extract_tar_gz(&archive_path, &extract_dir)?;
        } else if url.ends_with(".zip") {
            extract_zip(&archive_path, &extract_dir)?;
        } else {
            return Err(AcpError::DownloadFailed(format!(
                "unsupported uv archive format: {url}"
            )));
        }

        // The uv archive ships both `uv` and `uvx`; cache both so the resolver
        // and any direct `uv` invocation find them.
        let mut uvx_path: Option<PathBuf> = None;
        for name in [uv_name, uvx_name] {
            let extracted = find_binary_recursive(&extract_dir, name).ok_or_else(|| {
                AcpError::DownloadFailed(format!("'{name}' not found in uv archive"))
            })?;
            let final_path = dir.join(name);
            std::fs::copy(&extracted, &final_path)
                .map_err(|e| AcpError::DownloadFailed(format!("failed to copy {name}: {e}")))?;
            set_executable_permissions(&final_path)?;
            if name == uvx_name {
                uvx_path = Some(final_path);
            }
        }
        on_progress("uv installed successfully");
        uvx_path.ok_or_else(|| AcpError::DownloadFailed("uvx missing after install".into()))
    }
    .await;

    // Only clean the temp extraction dir. Unlike per-agent binary caches,
    // `uv_tool_dir` is shared across all Uvx agents, so removing it on failure
    // could delete a `uv`/`uvx` that a concurrent install (or a live connect)
    // just wrote. A half-written binary is harmless — the next attempt
    // overwrites it, and `find_cached_uv_tool` only reports ready when `uvx` is
    // actually present.
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Marker recording that a `Uvx` agent's package has been pre-fetched into
/// uvx's cache (written by the prepare step). The file content is the prepared
/// version string. Lets the connect/status paths report readiness without
/// introspecting uvx's internal cache or triggering a download.
fn uvx_prepared_marker(registry_id: &str) -> Result<PathBuf, AcpError> {
    Ok(cache_dir()?.join("uvx-prepared").join(registry_id))
}

/// Return the prepared version for a Uvx agent, or `None` if it has not been
/// prepared yet.
pub fn uvx_prepared_version(agent_type: AgentType) -> Option<String> {
    let path = uvx_prepared_marker(registry::registry_id_for(agent_type)).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let v = raw.trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// Record that a Uvx agent's package (at `version`) has been pre-fetched.
pub fn mark_uvx_agent_prepared(agent_type: AgentType, version: &str) -> Result<(), AcpError> {
    let path = uvx_prepared_marker(registry::registry_id_for(agent_type))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AcpError::DownloadFailed(format!("create uvx marker dir failed: {e}")))?;
    }
    std::fs::write(&path, version.as_bytes())
        .map_err(|e| AcpError::DownloadFailed(format!("write uvx marker failed: {e}")))
}

/// Remove a Uvx agent's prepared marker (used on uninstall). Absent marker is OK.
pub fn clear_uvx_agent_prepared(agent_type: AgentType) -> Result<(), AcpError> {
    let path = uvx_prepared_marker(registry::registry_id_for(agent_type))?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AcpError::DownloadFailed(format!(
            "remove uvx marker failed: {e}"
        ))),
    }
}

fn normalize_version_label(version: &str) -> String {
    let trimmed = version.trim();
    if let Some(stripped) = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
    {
        stripped.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn agent_cache_key(agent_type: AgentType) -> String {
    registry::registry_id_for(agent_type).to_string()
}

pub(crate) fn binary_dir(agent_id: &str, version: &str) -> Result<PathBuf, AcpError> {
    let version = normalize_version_label(version);
    if version.is_empty() {
        return Err(AcpError::DownloadFailed(
            "binary version is empty".to_string(),
        ));
    }

    Ok(cache_dir()?
        .join(agent_id)
        .join(version)
        .join(registry::current_platform()))
}

/// Move a pre-relocation binary root into the persistent one.
///
/// Called at startup from a detached thread. Best effort and idempotent: a
/// failure leaves the legacy root in place, where the read-through paths keep
/// finding it, and the next startup tries again.
///
/// Whole-root, not per agent: it also holds the managed `uv` toolchain
/// (`uv-tool/`), the Uvx prepared-version markers (`uvx-prepared/`) and the
/// `.trash/` aside directory, and leaving any of those behind would strand a
/// working install just as thoroughly as leaving a binary behind.
pub fn migrate_legacy_root() {
    let Some(legacy) = legacy_cache_dir() else {
        return;
    };
    let Ok(current) = cache_dir() else {
        return;
    };
    migrate_root(&legacy, &current);
}

/// [`migrate_legacy_root`] with both roots handed in, so the behaviour that
/// matters — cross-filesystem fallback, merge into an existing destination,
/// and never dropping a source whose copy did not land — is testable without
/// touching process-wide env.
fn migrate_root(legacy: &Path, current: &Path) {
    // Fast path: nothing at the destination yet, so the whole tree can be
    // renamed. Same volume in the normal case, which makes this instant.
    if !current.exists() {
        if let Some(parent) = current.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(legacy, current).is_ok() {
            tracing::info!(
                "[ACP] moved agent binaries {} -> {}",
                legacy.display(),
                current.display()
            );
            return;
        }
    }

    // Either the destination already has content, or the rename failed —
    // typically `EXDEV`, because `~/.cache` and `~/.local/share` need not be on
    // one filesystem. Copy entry by entry, and only drop a source once its copy
    // is verified present. NOT a permanent read-through fallback: leaving the
    // legacy root as a live second root would make `ensure_binary_*` short
    // circuit on the old copy and never populate the new one, while
    // `clear_agent_cache` deleted only the new one — so an uninstall would undo
    // itself on the next read.
    if std::fs::create_dir_all(current).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(legacy) else {
        return;
    };
    let staging_root = current.join(MIGRATION_STAGING);
    let _ = std::fs::create_dir_all(&staging_root);
    sweep_dead_staging(&staging_root);
    let mut all_moved = true;
    for entry in entries {
        // A per-entry error means this child was NOT migrated, so the legacy
        // root has to survive. `.flatten()` here would swallow that and let the
        // final `remove_dir_all` delete something nothing ever copied.
        let Ok(entry) = entry else {
            all_moved = false;
            continue;
        };
        let from = entry.path();
        let to = current.join(entry.file_name());
        if to.exists() {
            // The destination already has this agent/tool. The newer root wins;
            // the stale copy is redundant.
            all_moved &= std::fs::remove_dir_all(&from).is_ok();
            continue;
        }
        if std::fs::rename(&from, &to).is_ok() {
            continue;
        }
        // Cross-filesystem (`EXDEV`): `~/.cache` and `~/.local/share` need not
        // be one volume. Copy into a PRIVATE staging directory and rename that
        // into place, so `to` only ever exists complete. Two failures depend on
        // it. A crash mid-copy would otherwise leave a half-tree that the next
        // startup reads as a finished migration — `to.exists()` — and then
        // deletes the intact source over. And a second codeg running the same
        // migration would otherwise be able to delete the copy this one just
        // landed, because its cleanup would name `to`; now its cleanup can only
        // ever reach its own staging directory.
        let staging = staging_root.join(format!(
            "{}-{}",
            std::process::id(),
            TRASH_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&staging);
        match copy_tree(&from, &staging).and_then(|()| std::fs::rename(&staging, &to)) {
            Ok(()) => {
                all_moved &= std::fs::remove_dir_all(&from).is_ok();
            }
            Err(e) => {
                tracing::warn!(
                    "[ACP] could not migrate {} -> {}: {e}; retrying next startup",
                    from.display(),
                    to.display()
                );
                let _ = std::fs::remove_dir_all(&staging);
                all_moved = false;
            }
        }
    }
    if all_moved {
        let _ = std::fs::remove_dir_all(legacy);
        tracing::info!(
            "[ACP] migrated agent binaries to {} (legacy root removed)",
            current.display()
        );
    }
}

/// Where a cross-volume migration assembles a copy before publishing it, as a
/// child of the destination root.
///
/// Deliberately NOT `.trash/`, which was the first thing to hand and is wrong:
/// [`sweep_trash`] deletes every child of that directory unconditionally, and a
/// peer codeg sweeping while this one is mid-copy would delete the staging tree
/// out from under it. On Unix that is worse than it sounds — `remove_dir_all`
/// walks by descriptor, so a sweep that opened the directory can keep deleting
/// through the rename and gut the copy AFTER it was published, while the legacy
/// source is being removed on the strength of that same rename.
///
/// Nothing enumerates this name: agent and version lookups join a specific
/// agent id, and the trash sweep reads `.trash/`.
const MIGRATION_STAGING: &str = ".migrating";

/// Drop staging directories left behind by a codeg that is no longer running.
///
/// Owner-pid gated for the same reason `acp::scratch_dir`'s foreign sweep is:
/// a peer instance may be using one right now, and only a POSITIVELY confirmed
/// dead owner authorizes a delete. "The probe failed" is not "the owner is
/// gone" — hence the tri-state probe rather than a bool.
fn sweep_dead_staging(staging_root: &Path) {
    let Ok(entries) = std::fs::read_dir(staging_root) else {
        return;
    };
    let ours = std::process::id();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = name
            .split('-')
            .next()
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        // Our own pid can only appear here because some EARLIER process held
        // that number: this runs before this process stages anything, and
        // migration runs once per process.
        if pid != ours
            && crate::acp::scratch_dir::probe_pid(pid) != crate::acp::scratch_dir::PidState::Dead
        {
            continue;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

/// Recursive copy used by [`migrate_legacy_root`] when a rename cannot cross
/// the filesystem boundary. Returns the first error, leaving the caller to
/// clean up the partial destination.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        // Recreated, never followed and never skipped. Skipping used to be
        // reported as success, after which the SOURCE was deleted — so a `uv`
        // tool venv, whose `bin/` entries are links, would migrate into an
        // install that is missing exactly the files it launches through.
        let target = std::fs::read_link(from)?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, to)?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            // Creating a symlink on Windows needs Developer Mode or
            // `SeCreateSymbolicLinkPrivilege`, so this can legitimately fail —
            // and an error is the right answer: the caller keeps the source
            // whenever a copy does not land. (Barely reachable: on Windows the
            // two roots are the same path unless `CODEG_HOME`/`CODEG_DATA_DIR`
            // moves one of them, so there is normally nothing to migrate.)
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                format!(
                    "cannot recreate symlink {} -> {}",
                    from.display(),
                    target.display()
                ),
            ));
        }
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(from, to)?;
    // The executable bit is the whole point of a binary cache; `fs::copy`
    // preserves it on Unix, but re-assert it for anything that was marked
    // executable so a copied agent stays launchable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        if mode & 0o111 != 0 {
            let _ = std::fs::set_permissions(to, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

pub fn clear_agent_cache(agent_type: AgentType) -> Result<(), AcpError> {
    let agent_id = agent_cache_key(agent_type);
    // BOTH roots, and both have to succeed. While a migration is pending the
    // legacy root is still readable, so a legacy copy that survives an
    // "uninstall" is not a harmless leftover: `installed_binary_path` falls
    // back to it and launches the agent the user just removed. Reporting
    // success there would be a lie the next launch tells on — hence a real
    // rename-aside fallback on the legacy root too, and a propagated error
    // rather than `let _ =`.
    let legacy = match legacy_cache_dir() {
        Some(legacy) => clear_agent_dir_in(&legacy, &agent_id),
        None => Ok(()),
    };
    // Attempted regardless of the legacy outcome — a failure on one root is no
    // reason to leave the other populated — then the first error wins.
    let current = clear_agent_dir_in(&cache_dir()?, &agent_id);
    legacy.and(current)
}

/// Remove one agent's directory from ONE cache root.
fn clear_agent_dir_in(root: &Path, agent_id: &str) -> Result<(), AcpError> {
    let dir = root.join(agent_id);
    if !dir.exists() {
        return Ok(());
    }

    if std::fs::remove_dir_all(&dir).is_ok() {
        return Ok(());
    }

    // Windows: a running `<cmd>.exe` (ours or anti-virus scanning it) keeps the
    // file locked, so `remove_dir_all` returns ERROR_ACCESS_DENIED. NTFS allows
    // renaming a directory whose children are locked because rename only
    // updates the parent directory entry; the locked file's FILE_OBJECT keeps
    // working under the new path. The aside is swept on next startup.
    //
    // `.trash/` under THIS root, not the current one: a rename cannot cross a
    // filesystem, and the two roots need not be on one.
    let trash_root = root.join(".trash");
    let _ = std::fs::create_dir_all(&trash_root);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TRASH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let aside = trash_root.join(format!("{agent_id}-{stamp}-{counter}"));
    std::fs::rename(&dir, &aside)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to clear cache: {e}")))?;

    let _ = std::fs::remove_dir_all(&aside);
    Ok(())
}

/// Best-effort cleanup of trash directories left behind by
/// `clear_agent_cache`'s rename-aside fallback. Designed to be run from a
/// detached OS thread at startup: every error path is silently swallowed,
/// no logs, no panics escape, no subprocesses spawned. Whatever cannot be
/// removed (e.g. a binary still locked by an external process) is left for
/// the next startup.
///
/// Iterates children rather than nuking the parent so that a concurrent
/// `clear_agent_cache` racing to rename a fresh entry into `.trash/` cannot
/// have its target directory yanked out from under it.
pub fn sweep_trash() {
    // Both roots: a migration that has not completed still has a `.trash/`
    // under the old one, and nothing else would ever come back for it.
    let roots = [cache_dir().ok(), legacy_cache_dir()];
    for base in roots.into_iter().flatten() {
        let Ok(entries) = std::fs::read_dir(base.join(".trash")) else {
            continue;
        };
        for entry in entries.flatten() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Dir-tree entry for a cache key, when the agent's archive is extracted as a
/// whole directory instead of a single copied-out binary (see
/// `AgentDistribution::Binary::dir_entry`).
fn dir_entry_for_agent_id(agent_id: &str) -> Option<registry::BinaryDirEntry> {
    let agent_type = registry::from_registry_id(agent_id)?;
    match registry::get_agent_meta(agent_type).distribution {
        registry::AgentDistribution::Binary { dir_entry, .. } => dir_entry,
        _ => None,
    }
}

/// The launchable entry inside an extracted version directory, or `None` when
/// the tree is INCOMPLETE.
///
/// The entry is probed by existence only — the magic-byte check the single-file
/// path uses would reject a `#!` shell shim. The entry alone is not enough,
/// though: every declared `required_siblings` must be there too. Without that,
/// a version dir holding just the entry file reads as a working install, and
/// the flat-archive case makes that a REAL state rather than a hypothetical —
/// the same ACP-registry entry added as a CUSTOM agent before the built-in
/// existed installs through the single-file copy-out path, under the same
/// `<registry id>/<version>/<platform>` key, leaving exactly the entry behind.
fn complete_dir_tree_install(
    platform_dir: &Path,
    entry: registry::BinaryDirEntry,
) -> Option<PathBuf> {
    let path = platform_dir.join(entry.for_current_platform());
    if !path.is_file() {
        return None;
    }
    let entry_dir = path.parent()?;
    entry
        .required_siblings
        .for_current_platform()
        .iter()
        .all(|name| entry_dir.join(name).is_file())
        .then_some(path)
}

/// Read-through across the two roots: current first, then a legacy root that
/// has not finished migrating.
///
/// TRANSIENT by construction — [`legacy_cache_dir`] answers `None` the moment
/// the old directory is gone, so this stops costing anything after the first
/// successful [`migrate_legacy_root`]. It exists so a migration that cannot
/// complete (a cross-filesystem copy that runs out of space, say) degrades to
/// "still works, from the old place" instead of "every agent vanished".
fn installed_binary_path(agent_id: &str, version: &str, cmd_name: &str) -> Option<PathBuf> {
    if let Some(path) = installed_binary_path_in(&cache_dir().ok()?, agent_id, version, cmd_name) {
        return Some(path);
    }
    installed_binary_path_in(&legacy_cache_dir()?, agent_id, version, cmd_name)
}

fn installed_binary_path_in(
    root: &Path,
    agent_id: &str,
    version: &str,
    cmd_name: &str,
) -> Option<PathBuf> {
    let normalized = normalize_version_label(version);
    if normalized.is_empty() {
        return None;
    }

    let platform_dir = root
        .join(agent_id)
        .join(normalized)
        .join(registry::current_platform());

    if let Some(entry) = dir_entry_for_agent_id(agent_id) {
        return complete_dir_tree_install(&platform_dir, entry);
    }

    let bin_name = if cfg!(target_os = "windows") {
        format!("{cmd_name}.exe")
    } else {
        cmd_name.to_string()
    };
    let path = platform_dir.join(bin_name);

    if !path.exists() {
        return None;
    }
    if is_binary_file_compatible(path.as_path()) {
        return Some(path);
    }
    let _ = std::fs::remove_file(path);
    None
}

fn installed_version_labels(agent_id: &str, cmd_name: &str) -> Result<Vec<String>, AcpError> {
    let mut versions = Vec::new();
    let mut seen = HashSet::new();
    // Same two-root read-through as `installed_binary_path`, and `seen`
    // already de-duplicates a version present in both.
    let roots = [Some(cache_dir()?), legacy_cache_dir()];
    for base in roots.into_iter().flatten() {
        collect_version_labels(&base.join(agent_id), agent_id, cmd_name, &mut versions, &mut seen)?;
    }
    Ok(versions)
}

fn collect_version_labels(
    root: &Path,
    agent_id: &str,
    cmd_name: &str,
    versions: &mut Vec<String>,
    seen: &mut HashSet<String>,
) -> Result<(), AcpError> {
    if !root.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(root)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to read cache dir: {e}")))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let raw_version = entry.file_name().to_string_lossy().to_string();
        let normalized = normalize_version_label(&raw_version);
        if normalized.is_empty() {
            continue;
        }

        if installed_binary_path(agent_id, &normalized, cmd_name).is_some()
            && seen.insert(normalized.clone())
        {
            versions.push(normalized);
        }
    }

    Ok(())
}

fn installed_version_for_agent(
    agent_type: AgentType,
    cmd_name: &str,
) -> Result<Option<String>, AcpError> {
    let agent_id = agent_cache_key(agent_type);
    let mut versions = installed_version_labels(&agent_id, cmd_name)?;
    if versions.is_empty() {
        return Ok(None);
    }
    versions.sort_by(|a, b| version_cmp(a, b));
    Ok(versions.pop())
}

pub fn detect_installed_version(
    agent_type: AgentType,
    cmd_name: &str,
) -> Result<Option<String>, AcpError> {
    installed_version_for_agent(agent_type, cmd_name)
}

/// Return the best cached binary across all installed versions.
///
/// This returns the path + version label of the highest semver-ish
/// version cached on disk, regardless of what the registry considers
/// the "recommended" version. The session-page connect path uses this
/// to tolerate older-but-still-usable cached binaries (e.g. the user
/// hasn't upgraded yet) — the Settings page will continue to surface
/// an "upgrade available" hint via the separate version-badge path.
///
/// Returns Ok(None) when no usable binary is cached.
pub fn find_best_cached_binary_for_agent(
    agent_type: AgentType,
    cmd_name: &str,
) -> Result<Option<(PathBuf, String)>, AcpError> {
    let agent_id = agent_cache_key(agent_type);
    let mut versions = installed_version_labels(&agent_id, cmd_name)?;
    if versions.is_empty() {
        return Ok(None);
    }
    versions.sort_by(|a, b| version_cmp(a, b));
    while let Some(version) = versions.pop() {
        if let Some(path) = installed_binary_path(&agent_id, &version, cmd_name) {
            apply_cursor_acp_retry_compat(&agent_id, &version);
            return Ok(Some((path, version)));
        }
    }
    Ok(None)
}

fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a_parts = parse_version_parts(a);
    let mut b_parts = parse_version_parts(b);
    let len = a_parts.len().max(b_parts.len());
    a_parts.resize(len, 0);
    b_parts.resize(len, 0);

    for i in 0..len {
        match a_parts[i].cmp(&b_parts[i]) {
            std::cmp::Ordering::Equal => continue,
            order => return order,
        }
    }
    a.cmp(b)
}

fn parse_version_parts(input: &str) -> Vec<u32> {
    input
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .split('.')
        .map(|part| {
            let numeric: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            numeric.parse::<u32>().unwrap_or(0)
        })
        .collect()
}

/// Same as `ensure_binary_for_agent` but calls `on_progress` with human-readable
/// status messages during download / extraction.
/// Download (or reuse) an agent's binary.
///
/// `expected_sha256`, when present, is the hex digest the archive must hash to.
/// Built-in agents pass `None`: their URLs are repository constants reviewed
/// alongside the code. Custom agents pass the ACP registry's published digest,
/// because their URL comes from user input or a remote document — see
/// [`crate::acp::registry::PlatformBinary::sha256`].
pub async fn ensure_binary_for_agent_with_progress(
    agent_type: AgentType,
    version: &str,
    archive_url: &str,
    cmd_name: &str,
    expected_sha256: Option<&str>,
    on_progress: impl Fn(&str),
) -> Result<PathBuf, AcpError> {
    if let Some(path) = find_cached_binary_for_agent(agent_type, version, cmd_name)? {
        on_progress("Binary already cached, skipping download");
        let agent_id = agent_cache_key(agent_type);
        apply_cursor_acp_retry_compat(&agent_id, version);
        return Ok(path);
    }

    let agent_id = agent_cache_key(agent_type);
    ensure_binary_with_progress(
        &agent_id,
        version,
        archive_url,
        cmd_name,
        expected_sha256,
        on_progress,
    )
    .await
}

/// Hex SHA-256 of a file, streamed so a large archive never lands in memory.
fn file_sha256(path: &std::path::Path) -> Result<String, AcpError> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to open archive for hashing: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut file, &mut buf)
            .map_err(|e| AcpError::DownloadFailed(format!("failed to read archive: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Fail unless the downloaded archive matches `expected`. Comparison is
/// case-insensitive hex; a blank expectation is treated as "not published".
fn verify_archive_sha256(path: &std::path::Path, expected: Option<&str>) -> Result<(), AcpError> {
    let Some(expected) = expected.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let actual = file_sha256(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        return Ok(());
    }
    Err(AcpError::DownloadFailed(format!(
        "archive checksum mismatch: expected sha256 {expected}, got {actual}"
    )))
}

async fn ensure_binary_with_progress(
    agent_id: &str,
    version: &str,
    archive_url: &str,
    cmd_name: &str,
    expected_sha256: Option<&str>,
    on_progress: impl Fn(&str),
) -> Result<PathBuf, AcpError> {
    if let Some(path) = find_cached_binary(agent_id, version, cmd_name)? {
        apply_cursor_acp_retry_compat(agent_id, version);
        return Ok(path);
    }

    let dir = binary_dir(agent_id, version)?;
    let bin_name = if cfg!(target_os = "windows") {
        format!("{cmd_name}.exe")
    } else {
        cmd_name.to_string()
    };

    // Download and extract
    std::fs::create_dir_all(&dir)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to create cache dir: {e}")))?;

    let tmp_dir = dir.join(".tmp");
    if tmp_dir.exists() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to create tmp dir: {e}")))?;

    let result: Result<PathBuf, AcpError> = async {
        let archive_path = tmp_dir.join("archive");
        on_progress(&format!("Downloading {archive_url}"));
        download_file_with_progress(archive_url, &archive_path, &on_progress).await?;

        // Verify BEFORE extracting: a tampered archive must never have its
        // contents written anywhere but the temp dir this closure cleans up.
        if expected_sha256.is_some() {
            on_progress("Verifying checksum...");
        }
        verify_archive_sha256(&archive_path, expected_sha256)?;

        let extract_dir = tmp_dir.join("extracted");
        std::fs::create_dir_all(&extract_dir)
            .map_err(|e| AcpError::DownloadFailed(format!("failed to create extract dir: {e}")))?;

        on_progress("Extracting archive...");
        if archive_url.ends_with(".tar.gz") || archive_url.ends_with(".tgz") {
            extract_tar_gz(&archive_path, &extract_dir)?;
        } else if archive_url.ends_with(".tar.bz2") || archive_url.ends_with(".tbz2") {
            extract_tar_bz2(&archive_path, &extract_dir)?;
        } else if archive_url.ends_with(".zip") {
            extract_zip(&archive_path, &extract_dir)?;
        } else {
            return Err(AcpError::DownloadFailed(format!(
                "unsupported archive format: {archive_url}"
            )));
        }

        if let Some(entry) = dir_entry_for_agent_id(agent_id) {
            return install_extracted_tree(&extract_dir, &dir, entry, &on_progress);
        }

        // Find the binary in extracted files and move to final location.
        on_progress("Locating binary...");
        let extracted_bin = find_binary_recursive(&extract_dir, &bin_name).ok_or_else(|| {
            AcpError::DownloadFailed(format!("binary '{bin_name}' not found in archive"))
        })?;

        let final_path = dir.join(&bin_name);
        std::fs::copy(&extracted_bin, &final_path)
            .map_err(|e| AcpError::DownloadFailed(format!("failed to copy binary: {e}")))?;

        if !is_binary_file_compatible(&final_path) {
            let _ = std::fs::remove_file(&final_path);
            return Err(AcpError::DownloadFailed(
                "downloaded binary format is invalid for current platform".into(),
            ));
        }
        set_executable_permissions(&final_path)?;
        on_progress("Binary installed successfully");
        Ok(final_path)
    }
    .await;

    // Always clean up temp extraction artifacts.
    let _ = std::fs::remove_dir_all(&tmp_dir);
    if result.is_err() {
        // Avoid leaving empty version/platform directories on failed downloads.
        let _ = std::fs::remove_dir_all(&dir);
    } else {
        apply_cursor_acp_retry_compat_after_install(agent_id, version);
    }

    result
}

/// Hook for a cache HIT: the install was already on disk, so the compat layer
/// may answer from its per-process memo instead of re-reading the bundle.
fn apply_cursor_acp_retry_compat(agent_id: &str, version: &str) {
    let Ok(platform_dir) = binary_dir(agent_id, version) else {
        return;
    };
    cursor_acp_retry_compat::maybe_apply_for_agent(agent_id, &platform_dir, version);
}

/// Hook for a fresh install: the extraction just replaced the bytes any
/// earlier outcome described, so the memo must not short-circuit this one.
fn apply_cursor_acp_retry_compat_after_install(agent_id: &str, version: &str) {
    let Ok(platform_dir) = binary_dir(agent_id, version) else {
        return;
    };
    cursor_acp_retry_compat::apply_after_install_for_agent(agent_id, &platform_dir, version);
}

/// Move a dir-tree archive's extracted content into the final per-version
/// cache dir and return the launch entry path inside it. The extracted root
/// children are renamed (same filesystem) rather than copied; the entry's
/// existence is validated afterwards so a layout change in the upstream
/// archive fails loudly instead of caching a dead tree.
/// OPTIONAL helper binaries that may live next to a dir-tree agent's entry and
/// be exec'd by it, so they need the executable bit as much as the entry does.
/// Names absent from an archive are skipped, which is why one list can be
/// shared by every dir-tree agent.
///
/// * `node` — Cursor's bundled runtime; its `cursor-agent` shim execs the
///   sibling interpreter.
/// * `localharness` — Antigravity's fallback harness name. Its PRIMARY name
///   (`localharness_external`) is a hard requirement declared by the registry
///   entry instead (`BinaryDirEntry::required_siblings`), because a missing
///   harness is not a cosmetic problem: `agy_acp_server` starts anyway and only
///   logs "Localharness not found.".
const ENTRY_SIBLING_EXECUTABLES: &[&str] = &[
    "node",
    "localharness",
    // Windows counterpart, harmless to probe elsewhere.
    "localharness.exe",
];

fn install_extracted_tree(
    extract_dir: &Path,
    final_dir: &Path,
    entry: registry::BinaryDirEntry,
    on_progress: &impl Fn(&str),
) -> Result<PathBuf, AcpError> {
    on_progress("Installing extracted files...");
    let children = std::fs::read_dir(extract_dir)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to read extracted dir: {e}")))?;
    for child in children.flatten() {
        let target = final_dir.join(child.file_name());
        std::fs::rename(child.path(), &target).map_err(|e| {
            AcpError::DownloadFailed(format!(
                "failed to move {} into cache: {e}",
                child.file_name().to_string_lossy()
            ))
        })?;
    }

    let entry_rel = entry.for_current_platform();
    let entry_path = final_dir.join(entry_rel);
    if !entry_path.is_file() {
        return Err(AcpError::DownloadFailed(format!(
            "entry '{entry_rel}' not found in archive"
        )));
    }
    // tar/zip preserve the executable bit, but be defensive: the entry and
    // every helper it execs must be executable for the spawn to work.
    set_executable_permissions(&entry_path)?;
    if let Some(parent) = entry_path.parent() {
        // Declared helpers are REQUIRED: an archive that did not carry one
        // must fail here rather than install a tree that starts and then
        // misbehaves (Antigravity logs "Localharness not found." and keeps
        // going). This is also what keeps `installed_binary_path`'s matching
        // check from ever rejecting a tree codeg itself installed.
        for sibling in entry.required_siblings.for_current_platform() {
            let path = parent.join(sibling);
            if !path.is_file() {
                return Err(AcpError::DownloadFailed(format!(
                    "required file '{sibling}' not found beside '{entry_rel}' in archive"
                )));
            }
            set_executable_permissions(&path)?;
        }
        // Opportunistic: helpers some trees ship and others do not.
        for sibling in ENTRY_SIBLING_EXECUTABLES {
            let path = parent.join(sibling);
            if path.is_file() {
                set_executable_permissions(&path)?;
            }
        }
    }
    on_progress("Binary installed successfully");
    Ok(entry_path)
}

pub(crate) fn find_cached_binary(
    agent_id: &str,
    version: &str,
    cmd_name: &str,
) -> Result<Option<PathBuf>, AcpError> {
    Ok(installed_binary_path(agent_id, version, cmd_name))
}

pub(crate) fn find_cached_binary_for_agent(
    agent_type: AgentType,
    version: &str,
    cmd_name: &str,
) -> Result<Option<PathBuf>, AcpError> {
    let agent_id = agent_cache_key(agent_type);
    find_cached_binary(&agent_id, version, cmd_name)
}

pub(crate) fn find_binary_recursive(dir: &PathBuf, name: &str) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }
    for entry in walkdir::WalkDir::new(dir).into_iter().flatten() {
        if entry.file_type().is_file() && entry.file_name().to_string_lossy() == name {
            return Some(entry.into_path());
        }
    }
    None
}

async fn download_file_with_progress(
    url: &str,
    dest: &PathBuf,
    on_progress: &impl Fn(&str),
) -> Result<(), AcpError> {
    use futures_util::StreamExt;

    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| AcpError::DownloadFailed(format!("HTTP request failed: {e}")))?;

    if !response.status().is_success() {
        return Err(AcpError::DownloadFailed(format!(
            "HTTP {} for {url}",
            response.status()
        )));
    }

    let total_size = response.content_length();
    let mut downloaded: u64 = 0;
    let mut last_reported_mb: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut file = std::fs::File::create(dest)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to create archive file: {e}")))?;

    use std::io::Write;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| AcpError::DownloadFailed(format!("failed to read chunk: {e}")))?;
        file.write_all(&chunk)
            .map_err(|e| AcpError::DownloadFailed(format!("failed to write archive: {e}")))?;
        downloaded += chunk.len() as u64;

        // Report progress every 1MB
        let current_mb = downloaded / (1024 * 1024);
        if current_mb > last_reported_mb {
            last_reported_mb = current_mb;
            if let Some(total) = total_size {
                let total_mb = total as f64 / (1024.0 * 1024.0);
                on_progress(&format!(
                    "Downloading... {current_mb:.0} MB / {total_mb:.1} MB"
                ));
            } else {
                on_progress(&format!("Downloading... {current_mb:.0} MB"));
            }
        }
    }

    if let Some(total) = total_size {
        let total_mb = total as f64 / (1024.0 * 1024.0);
        on_progress(&format!("Download complete ({total_mb:.1} MB)"));
    } else {
        let final_mb = downloaded as f64 / (1024.0 * 1024.0);
        on_progress(&format!("Download complete ({final_mb:.1} MB)"));
    }

    Ok(())
}

fn extract_tar_gz(archive: &PathBuf, dest: &PathBuf) -> Result<(), AcpError> {
    let file = std::fs::File::open(archive)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to open archive: {e}")))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    tar.unpack(dest)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to extract tar.gz: {e}")))?;
    Ok(())
}

fn extract_tar_bz2(archive: &PathBuf, dest: &PathBuf) -> Result<(), AcpError> {
    let file = std::fs::File::open(archive)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to open archive: {e}")))?;
    let bz = bzip2::read::BzDecoder::new(file);
    let mut tar = tar::Archive::new(bz);
    tar.unpack(dest)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to extract tar.bz2: {e}")))?;
    Ok(())
}

fn extract_zip(archive: &PathBuf, dest: &PathBuf) -> Result<(), AcpError> {
    let file = std::fs::File::open(archive)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to open archive: {e}")))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to read zip: {e}")))?;
    zip.extract(dest)
        .map_err(|e| AcpError::DownloadFailed(format!("failed to extract zip: {e}")))?;
    Ok(())
}

fn set_executable_permissions(path: &Path) -> Result<(), AcpError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| AcpError::DownloadFailed(e.to_string()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).map_err(|e| AcpError::DownloadFailed(e.to_string()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

pub(crate) fn is_binary_file_compatible(path: &Path) -> bool {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut header = [0_u8; 4];
    if file.read_exact(&mut header).is_err() {
        return false;
    }

    #[cfg(target_os = "macos")]
    {
        matches!(
            header,
            [0xFE, 0xED, 0xFA, 0xCE]
                | [0xCE, 0xFA, 0xED, 0xFE]
                | [0xFE, 0xED, 0xFA, 0xCF]
                | [0xCF, 0xFA, 0xED, 0xFE]
                | [0xCA, 0xFE, 0xBA, 0xBE]
                | [0xBE, 0xBA, 0xFE, 0xCA]
                | [0xCA, 0xFE, 0xBA, 0xBF]
                | [0xBF, 0xBA, 0xFE, 0xCA]
        )
    }

    #[cfg(target_os = "linux")]
    {
        header == [0x7F, b'E', b'L', b'F']
    }

    #[cfg(target_os = "windows")]
    {
        header[0] == b'M' && header[1] == b'Z'
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The common case: nothing at the destination, so the whole tree moves in
    /// one rename and the old root is gone afterwards.
    #[test]
    fn migrate_root_renames_when_the_destination_is_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let legacy = tmp.path().join("old");
        let current = tmp.path().join("new");
        std::fs::create_dir_all(legacy.join("opencode").join("1.0.0")).expect("mkdir");
        std::fs::write(legacy.join("opencode").join("1.0.0").join("bin"), b"x").expect("write");

        migrate_root(&legacy, &current);

        assert!(!legacy.exists(), "legacy root must be gone");
        assert!(current.join("opencode").join("1.0.0").join("bin").is_file());
    }

    /// A destination that already has content cannot be renamed onto, so the
    /// merge path runs. Everything must still end up under the new root, and
    /// the legacy root must still disappear — leaving it would make it a second
    /// live root, which is how an uninstall gets undone by a read-through.
    #[test]
    fn migrate_root_merges_into_an_existing_destination() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let legacy = tmp.path().join("old");
        let current = tmp.path().join("new");
        std::fs::create_dir_all(legacy.join("cursor")).expect("mkdir");
        std::fs::write(legacy.join("cursor").join("bin"), b"cursor").expect("write");
        std::fs::create_dir_all(legacy.join("uv-tool")).expect("mkdir");
        std::fs::write(legacy.join("uv-tool").join("uvx"), b"uvx").expect("write");
        // Destination already holds a different agent.
        std::fs::create_dir_all(current.join("opencode")).expect("mkdir");
        std::fs::write(current.join("opencode").join("bin"), b"opencode").expect("write");

        migrate_root(&legacy, &current);

        assert!(!legacy.exists(), "legacy root must be gone after a merge");
        assert!(current.join("cursor").join("bin").is_file());
        // The managed uv toolchain travels too: leaving it behind strands
        // every Uvx agent just as thoroughly as leaving a binary behind.
        assert!(current.join("uv-tool").join("uvx").is_file());
        assert!(current.join("opencode").join("bin").is_file());
    }

    /// A symlink used to be "copied" by skipping it and returning `Ok`, after
    /// which the caller deleted the source. A `uv` tool venv is exactly that
    /// shape — `bin/` is links — so the agent it migrated arrived missing the
    /// file it launches through, and the original was already gone.
    #[cfg(unix)]
    #[test]
    fn copy_tree_recreates_a_symlink_instead_of_dropping_it() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let from = tmp.path().join("from");
        let to = tmp.path().join("to");
        std::fs::create_dir_all(&from).expect("mkdir");
        std::fs::write(from.join("real"), b"payload").expect("write");
        std::os::unix::fs::symlink("real", from.join("link")).expect("symlink");

        copy_tree(&from, &to).expect("copy");

        let meta = std::fs::symlink_metadata(to.join("link")).expect("link must exist");
        assert!(meta.file_type().is_symlink(), "and must still be a symlink");
        assert_eq!(std::fs::read_link(to.join("link")).expect("read_link"), Path::new("real"));
        assert_eq!(std::fs::read(to.join("real")).expect("read"), b"payload");
    }

    /// A successful merge must leave no staging directory behind, or every
    /// startup would accumulate another.
    #[test]
    fn migrate_root_leaves_no_staging_directory_behind() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let legacy = tmp.path().join("old");
        let current = tmp.path().join("new");
        std::fs::create_dir_all(legacy.join("cursor")).expect("mkdir");
        std::fs::write(legacy.join("cursor").join("bin"), b"cursor").expect("write");
        // Force the merge path.
        std::fs::create_dir_all(&current).expect("mkdir");
        std::fs::write(current.join("marker"), b"x").expect("write");

        migrate_root(&legacy, &current);

        let residue: Vec<_> = std::fs::read_dir(current.join(MIGRATION_STAGING))
            .map(|entries| entries.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        assert!(residue.is_empty(), "staging residue: {residue:?}");
    }

    /// Staging must NOT live under `.trash/`, because `sweep_trash` deletes
    /// every child of that directory unconditionally — including, from a peer
    /// codeg, a copy this one is still assembling.
    #[test]
    fn staging_is_out_of_the_trash_sweep() {
        assert_ne!(MIGRATION_STAGING, ".trash");
    }

    /// A staging directory abandoned by a process that is gone is reclaimed;
    /// one whose owner is still alive is left alone, because a peer codeg may
    /// be copying into it right now.
    #[test]
    fn dead_owners_staging_is_reclaimed_and_a_live_owner_is_not() {
        // A pid the probe cannot answer `Dead` for, standing in for "a peer
        // instance that is still working". Unix pid 1 is `init`/`launchd`.
        // Windows has no pid 1 — `OpenProcess` fails it with
        // ERROR_INVALID_PARAMETER, which the probe correctly reads as `Dead`,
        // so pid 1 there is a stand-in for the opposite case. Pid 4 is the
        // Windows System process: `Alive` when we may open it, `Unknown`
        // (access-denied) when we may not, and both are non-`Dead` owners the
        // gate must refuse to delete.
        #[cfg(windows)]
        const LIVE_PID: u32 = 4;
        #[cfg(not(windows))]
        const LIVE_PID: u32 = 1;

        let tmp = tempfile::tempdir().expect("tempdir");
        let staging_root = tmp.path().join(MIGRATION_STAGING);
        let live = staging_root.join(format!("{LIVE_PID}-0"));
        // No process can hold this: it is above every platform's pid ceiling.
        let dead = staging_root.join("4294967294-0");
        let foreign = staging_root.join("not-a-pid");
        for dir in [&live, &dead, &foreign] {
            std::fs::create_dir_all(dir).expect("mkdir");
        }
        // Fail on the premise rather than the conclusion if some platform ever
        // stops holding that pid: "the survivor was deleted" reads as a bug in
        // the sweep, which would be the wrong place to look.
        assert_ne!(
            crate::acp::scratch_dir::probe_pid(LIVE_PID),
            crate::acp::scratch_dir::PidState::Dead,
            "pid {LIVE_PID} must not probe as dead, or this test proves nothing"
        );

        sweep_dead_staging(&staging_root);

        assert!(!dead.exists(), "a dead owner's staging must be reclaimed");
        assert!(live.exists(), "a live owner's staging must survive");
        assert!(foreign.exists(), "an unrecognized name must be left alone");
    }

    /// The uninstall fix in one line: removal is parameterized by ROOT, so the
    /// legacy root gets the same treatment — including the rename-aside — as
    /// the current one. Clearing only the current root would let
    /// `installed_binary_path`'s legacy fallback resurrect the agent the user
    /// just removed, while the call still reported success.
    #[test]
    fn clear_agent_dir_in_clears_whichever_root_it_is_given() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("some-root");
        std::fs::create_dir_all(root.join("opencode").join("1.0.0")).expect("mkdir");
        std::fs::write(root.join("opencode").join("1.0.0").join("bin"), b"x").expect("write");

        clear_agent_dir_in(&root, "opencode").expect("clear");

        assert!(!root.join("opencode").exists());
        // A second pass over an absent directory is a no-op, not an error —
        // `clear_agent_cache` calls this for a legacy root that usually is not
        // there at all.
        clear_agent_dir_in(&root, "opencode").expect("second clear");
    }

    /// When both roots hold the same agent the destination wins and the stale
    /// copy is dropped, rather than the migration silently preferring the old
    /// bytes.
    #[test]
    fn migrate_root_keeps_the_destination_copy_on_a_collision() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let legacy = tmp.path().join("old");
        let current = tmp.path().join("new");
        std::fs::create_dir_all(legacy.join("opencode")).expect("mkdir");
        std::fs::write(legacy.join("opencode").join("bin"), b"stale").expect("write");
        std::fs::create_dir_all(current.join("opencode")).expect("mkdir");
        std::fs::write(current.join("opencode").join("bin"), b"fresh").expect("write");
        // Force the merge path.
        std::fs::write(current.join("marker"), b"x").expect("write");

        migrate_root(&legacy, &current);

        assert_eq!(
            std::fs::read(current.join("opencode").join("bin")).expect("read"),
            b"fresh"
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn migrate_root_is_a_noop_when_the_legacy_root_is_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let legacy = tmp.path().join("missing");
        let current = tmp.path().join("new");
        std::fs::create_dir_all(&current).expect("mkdir");
        std::fs::write(current.join("keep"), b"x").expect("write");

        migrate_root(&legacy, &current);

        assert!(current.join("keep").is_file());
    }

    #[test]
    fn copy_tree_preserves_the_executable_bit() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let from = tmp.path().join("from");
        let to = tmp.path().join("to");
        std::fs::create_dir_all(&from).expect("mkdir");
        let bin = from.join("agent");
        std::fs::write(&bin, b"#!/bin/sh\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }

        copy_tree(&from, &to).expect("copy");

        assert!(to.join("agent").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(to.join("agent"))
                .expect("meta")
                .permissions()
                .mode();
            assert_ne!(mode & 0o111, 0, "a copied agent must stay launchable");
        }
    }

    #[test]
    fn cache_key_uses_registry_id() {
        assert_eq!(agent_cache_key(AgentType::OpenCode), "opencode");
        assert_eq!(agent_cache_key(AgentType::Codex), "codex-acp");
    }

    // Cursor's whole-tree install: the extracted archive root (dist-package/…)
    // is moved intact into the version dir, the entry script is validated and
    // made executable, and a missing entry fails loudly.
    #[test]
    fn install_extracted_tree_moves_root_and_validates_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let extract = tmp.path().join("extracted");
        let package = extract.join("dist-package");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("cursor-agent"), "#!/usr/bin/env bash\n").unwrap();
        std::fs::write(package.join("node"), [0_u8, 1, 2]).unwrap();
        std::fs::write(package.join("index.js"), "// chunk").unwrap();
        let final_dir = tmp.path().join("final");
        std::fs::create_dir_all(&final_dir).unwrap();

        let entry = registry::BinaryDirEntry {
            unix: "dist-package/cursor-agent",
            windows: "dist-package/cursor-agent.cmd",
            required_siblings: registry::PlatformFiles::NONE,
        };
        // On Windows the fixture writes the unix name only; skip there — the
        // path join and rename logic under test is platform-independent.
        if cfg!(windows) {
            return;
        }
        let installed = install_extracted_tree(&extract, &final_dir, entry, &|_| {}).unwrap();
        assert_eq!(installed, final_dir.join("dist-package/cursor-agent"));
        assert!(final_dir.join("dist-package/index.js").is_file());
        assert!(final_dir.join("dist-package/node").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&installed).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "entry must be executable");
        }
        // The extracted staging dir was drained by the rename.
        assert!(std::fs::read_dir(&extract).unwrap().next().is_none());
    }

    // Antigravity's archive is the other dir-tree shape: FLAT (no wrapping
    // directory) with the entry and its `localharness_external` sibling side
    // by side. Both must land in the cache and both must come out executable
    // — a harness without the executable bit is not a spawn failure, it is a
    // server that starts and then logs "Localharness not found.".
    #[cfg(unix)]
    #[test]
    fn install_extracted_tree_marks_localharness_sibling_executable() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let extract = tmp.path().join("extracted");
        std::fs::create_dir_all(&extract).unwrap();
        std::fs::write(extract.join("agy_acp_server.par"), [0_u8, 1, 2]).unwrap();
        std::fs::write(extract.join("localharness_external"), [0_u8, 1, 2]).unwrap();
        // Simulate an archive/extractor that dropped the executable bit.
        for name in ["agy_acp_server.par", "localharness_external"] {
            std::fs::set_permissions(extract.join(name), std::fs::Permissions::from_mode(0o644))
                .unwrap();
        }
        let final_dir = tmp.path().join("final");
        std::fs::create_dir_all(&final_dir).unwrap();

        let entry = registry::BinaryDirEntry {
            unix: "agy_acp_server.par",
            windows: "agy_acp_server.exe",
            required_siblings: registry::PlatformFiles {
                unix: &["localharness_external"],
                windows: &["localharness_external.exe"],
            },
        };
        let installed = install_extracted_tree(&extract, &final_dir, entry, &|_| {}).unwrap();
        assert_eq!(installed, final_dir.join("agy_acp_server.par"));

        let harness = final_dir.join("localharness_external");
        assert!(harness.is_file(), "harness sibling must be installed");
        for path in [&installed, &harness] {
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "{} must be executable", path.display());
        }
    }

    // The reported regression: `antigravity-acp` could be added as a CUSTOM
    // agent before it became a built-in, and because its archive is FLAT
    // (`cmd: "./agy_acp_server.par"`, no `/`) that install went through the
    // single-file copy-out path — writing ONLY the entry file, under the same
    // cache key the built-in now uses. Adopting that cache would skip the
    // download and launch a server whose harness is missing, which does not
    // fail: it starts and logs "Localharness not found.".
    #[test]
    fn stale_single_file_cache_is_not_adopted_as_a_dir_tree_install() {
        let tmp = tempfile::tempdir().unwrap();
        let platform_dir = tmp.path().join("darwin-aarch64");
        std::fs::create_dir_all(&platform_dir).unwrap();
        let entry = registry::BinaryDirEntry {
            unix: "agy_acp_server.par",
            windows: "agy_acp_server.exe",
            required_siblings: registry::PlatformFiles {
                unix: &["localharness_external"],
                windows: &["localharness_external.exe"],
            },
        };
        let entry_name = entry.for_current_platform();
        let sibling = entry.required_siblings.for_current_platform()[0];

        // Entry only — the legacy single-file cache.
        std::fs::write(platform_dir.join(entry_name), [0_u8, 1, 2]).unwrap();
        assert_eq!(
            complete_dir_tree_install(&platform_dir, entry),
            None,
            "a tree missing its required helper must not read as installed"
        );

        // Complete tree.
        std::fs::write(platform_dir.join(sibling), [0_u8, 1, 2]).unwrap();
        assert_eq!(
            complete_dir_tree_install(&platform_dir, entry),
            Some(platform_dir.join(entry_name))
        );

        // An entry declaring no required siblings (Cursor, and every custom
        // agent) keeps the old entry-only behaviour.
        let bare = registry::BinaryDirEntry {
            unix: "agy_acp_server.par",
            windows: "agy_acp_server.exe",
            required_siblings: registry::PlatformFiles::NONE,
        };
        std::fs::remove_file(platform_dir.join(sibling)).unwrap();
        assert_eq!(
            complete_dir_tree_install(&platform_dir, bare),
            Some(platform_dir.join(entry_name))
        );
    }

    // An archive that did not carry a REQUIRED helper must fail the install
    // rather than leave a tree that starts and then misbehaves. This is also
    // the write-side twin of the cache check: what installs successfully is
    // exactly what `installed_binary_path` will later accept.
    #[test]
    fn install_extracted_tree_missing_required_sibling_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let extract = tmp.path().join("extracted");
        std::fs::create_dir_all(&extract).unwrap();
        let entry_name = if cfg!(windows) {
            "agy_acp_server.exe"
        } else {
            "agy_acp_server.par"
        };
        std::fs::write(extract.join(entry_name), [0_u8, 1, 2]).unwrap();
        let final_dir = tmp.path().join("final");
        std::fs::create_dir_all(&final_dir).unwrap();

        let entry = registry::BinaryDirEntry {
            unix: "agy_acp_server.par",
            windows: "agy_acp_server.exe",
            required_siblings: registry::PlatformFiles {
                unix: &["localharness_external"],
                windows: &["localharness_external.exe"],
            },
        };
        let err = install_extracted_tree(&extract, &final_dir, entry, &|_| {}).unwrap_err();
        assert!(
            err.to_string().contains("localharness_external"),
            "the error must name the missing helper: {err}"
        );
    }

    #[test]
    fn install_extracted_tree_missing_entry_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let extract = tmp.path().join("extracted");
        std::fs::create_dir_all(extract.join("wrong-root")).unwrap();
        let final_dir = tmp.path().join("final");
        std::fs::create_dir_all(&final_dir).unwrap();
        let entry = registry::BinaryDirEntry {
            unix: "dist-package/cursor-agent",
            windows: "dist-package/cursor-agent.cmd",
            required_siblings: registry::PlatformFiles::NONE,
        };
        let err = install_extracted_tree(&extract, &final_dir, entry, &|_| {}).unwrap_err();
        assert!(err.to_string().contains("not found in archive"), "{err}");
    }

    #[test]
    fn version_normalization_is_consistent() {
        assert_eq!(normalize_version_label("v1.2.15"), "1.2.15");
        assert_eq!(normalize_version_label("V0.9.4 "), "0.9.4");
        assert_eq!(normalize_version_label("1.25.1"), "1.25.1");
    }

    // Custom agents download from URLs codeg did not vet, so a published
    // digest must be enforced — and a mismatch must fail BEFORE extraction.
    #[test]
    fn archive_checksum_is_enforced_when_published() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("archive");
        std::fs::write(&archive, b"hello").unwrap();
        // sha256("hello")
        let good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

        assert_eq!(file_sha256(&archive).unwrap(), good);
        verify_archive_sha256(&archive, Some(good)).expect("matching digest passes");
        // Registries publish lowercase hex, but accept either case.
        verify_archive_sha256(&archive, Some(&good.to_uppercase())).expect("case-insensitive");
        // No published digest → nothing to enforce (built-in agents).
        verify_archive_sha256(&archive, None).expect("absent digest is not an error");
        verify_archive_sha256(&archive, Some("   ")).expect("blank digest is not an error");

        let err = verify_archive_sha256(&archive, Some("deadbeef")).unwrap_err();
        assert!(err.to_string().contains("checksum mismatch"), "{err}");
    }
}
