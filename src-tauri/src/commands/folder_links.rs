//! Multi-folder workspaces: symlink other directories into a workspace folder
//! so one root can host several projects.
//!
//! A plain UI-level merge would be invisible to the agent CLIs, which run with
//! `cwd` set to the workspace root — real symlinks are what let them `ls` and
//! edit the linked projects. Every link is recorded in `folder_link`, which
//! doubles as the authorization record the workspace path guard consults (see
//! [`crate::folder_links`]).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::db::service::{folder_link_service, folder_service};
use crate::db::AppDatabase;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Emitted whenever a folder's link set changes, so every open window (desktop
/// windows, web clients, remote sessions) refreshes its list and file tree.
pub const FOLDER_LINKS_CHANGED_EVENT: &str = "folder://links-changed";

#[derive(Debug, Clone, Serialize)]
pub struct FolderLinksChanged {
    pub folder_id: i32,
}

/// Longest link name we will derive. Long enough for any real project
/// directory, short enough to stay clear of per-component limits (255 bytes on
/// most filesystems) once a `-NN` disambiguator is appended.
const MAX_LINK_NAME_LEN: usize = 96;

/// How many `-2`, `-3`, … variants to probe before giving up on a name.
const MAX_NAME_PROBES: u32 = 99;

const FALLBACK_LINK_NAME: &str = "linked-folder";

/// Names Windows refuses on any filesystem, with or without an extension.
const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Live state of a link, recomputed from disk on every list so the UI can offer
/// a repair instead of silently showing a link that no longer works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderLinkStatus {
    /// The symlink exists and resolves to the recorded target.
    Ok,
    /// Nothing at `<root>/<name>` — the user (or a tool) deleted the link.
    Missing,
    /// Something is at `<root>/<name>`, but it is not a link to the target
    /// (a real directory, or a link pointing somewhere else).
    Conflicted,
    /// The link is there but its target no longer resolves.
    Broken,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderLinkDetail {
    pub id: i32,
    pub folder_id: i32,
    pub name: String,
    pub target_path: String,
    pub status: FolderLinkStatus,
}

/// Why a picked directory cannot be linked. Rendered by the frontend, so these
/// are stable identifiers rather than prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderLinkRejection {
    /// The path does not exist or cannot be resolved.
    NotFound,
    /// The path exists but is not a directory.
    NotADirectory,
    /// The picked directory *is* the workspace root.
    SameAsRoot,
    /// The picked directory contains the workspace root — linking it would nest
    /// the workspace inside itself.
    AncestorOfRoot,
    /// The picked directory is already inside the workspace root; it is
    /// reachable without a link.
    InsideRoot,
    /// This directory is already linked into this workspace.
    AlreadyLinked,
    /// Every candidate name (`api`, `api-2`, … `api-99`) is already taken.
    NameUnavailable,
}

/// What [`preview_folder_links_core`] would do with one picked directory: the
/// name it would get, whether that name had to be disambiguated, and why it
/// would be skipped.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderLinkPlan {
    pub target_path: String,
    /// Name derived straight from the directory, before disambiguation.
    pub base_name: String,
    /// Name that would actually be created; empty when `rejection` is set.
    pub name: String,
    /// True when `name` had to differ from `base_name` because something else
    /// already occupies it.
    pub renamed: bool,
    /// Set when the collision was with a real file/directory already in the
    /// root, rather than with another link or another entry in this batch —
    /// worth surfacing louder in the UI.
    pub collides_with_existing_entry: bool,
    pub rejection: Option<FolderLinkRejection>,
    /// Name of the existing link, when `rejection` is `AlreadyLinked`.
    pub existing_link_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderLinkRequest {
    pub path: String,
    /// Explicit name chosen by the user. When absent (or blank) the name is
    /// derived from the directory. A name that is already taken is still
    /// disambiguated — the create call never clobbers an existing entry.
    #[serde(default)]
    pub name: Option<String>,
}

// ---------------------------------------------------------------------------
// Name derivation (pure — unit-tested on every platform)
// ---------------------------------------------------------------------------

/// Strip everything that would make a path component invalid or ambiguous on
/// any supported platform. Never returns a name that needs further escaping.
pub(crate) fn sanitize_link_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        // Path separators and the characters Windows rejects in a file name.
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '-',
            other => other,
        })
        .collect();

    // Windows silently strips trailing dots and spaces, which would make the
    // name we recorded differ from the one on disk.
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return FALLBACK_LINK_NAME.to_string();
    }

    // Truncate on a char boundary, then re-trim in case the cut exposed a dot.
    let limited: String = trimmed.chars().take(MAX_LINK_NAME_LEN).collect();
    let limited = limited.trim_end_matches(['.', ' ']).trim().to_string();
    if limited.is_empty() {
        return FALLBACK_LINK_NAME.to_string();
    }

    // `CON`, `con.txt`, … are reserved device names on Windows regardless of
    // extension. Suffix rather than replace so the name stays recognizable.
    let stem = limited
        .split('.')
        .next()
        .unwrap_or(&limited)
        .to_ascii_lowercase();
    if WINDOWS_RESERVED.contains(&stem.as_str()) {
        return format!("{limited}-dir");
    }

    limited
}

/// Name a linked directory should get, derived from its own final component.
/// Falls back to the whole path (e.g. a drive or filesystem root, which has no
/// final component) and finally to a fixed placeholder.
pub(crate) fn derive_link_name(target: &Path) -> String {
    if let Some(name) = target.file_name().and_then(|s| s.to_str()) {
        let sanitized = sanitize_link_name(name);
        if sanitized != FALLBACK_LINK_NAME {
            return sanitized;
        }
    }
    // No usable final component: `/`, `C:\`, `\\server\share`.
    let whole = target.to_string_lossy();
    let collapsed = whole
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .collect::<Vec<_>>()
        .join("-");
    let sanitized = sanitize_link_name(&collapsed);
    if sanitized.is_empty() {
        FALLBACK_LINK_NAME.to_string()
    } else {
        sanitized
    }
}

/// Case-insensitive key for collision checks. macOS and Windows filesystems are
/// case-insensitive by default, so `API` and `api` are the *same* entry there —
/// comparing case-sensitively would let us "successfully" plan two links that
/// then clobber each other on disk.
pub(crate) fn name_key(name: &str) -> String {
    name.to_lowercase()
}

/// First free variant of `base`: `base`, then `base-2` … `base-99`.
/// `taken` holds [`name_key`]s. Returns `None` when every probe is occupied.
pub(crate) fn unique_link_name(base: &str, taken: &HashSet<String>) -> Option<String> {
    if !taken.contains(&name_key(base)) {
        return Some(base.to_string());
    }
    for n in 2..=MAX_NAME_PROBES {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&name_key(&candidate)) {
            return Some(candidate);
        }
    }
    None
}

/// Every name already spoken for directly inside `root`.
///
/// `read_dir` is used rather than `Path::exists`, which follows symlinks and
/// reports a *dangling* link as absent — creating over one of those fails with
/// `AlreadyExists` and would surface as a confusing error instead of a rename.
fn occupied_names(root: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return names;
    };
    for entry in entries.flatten() {
        names.insert(name_key(&entry.file_name().to_string_lossy()));
    }
    names
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

struct ValidatedTarget {
    canonical: PathBuf,
}

fn validate_target(
    canonical_root: &Path,
    raw_target: &str,
) -> Result<ValidatedTarget, FolderLinkRejection> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return Err(FolderLinkRejection::NotFound);
    }
    let canonical =
        std::fs::canonicalize(trimmed).map_err(|_| FolderLinkRejection::NotFound)?;
    if !canonical.is_dir() {
        return Err(FolderLinkRejection::NotADirectory);
    }
    if canonical == canonical_root {
        return Err(FolderLinkRejection::SameAsRoot);
    }
    // The root lives inside the pick: linking it would make the workspace
    // contain itself, and the tree walker would recurse forever.
    if canonical_root.starts_with(&canonical) {
        return Err(FolderLinkRejection::AncestorOfRoot);
    }
    // Already reachable by walking the workspace — a link would just duplicate
    // it (and create a cycle).
    if canonical.starts_with(canonical_root) {
        return Err(FolderLinkRejection::InsideRoot);
    }
    Ok(ValidatedTarget { canonical })
}

// ---------------------------------------------------------------------------
// Symlink creation / removal
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn create_dir_symlink(target: &Path, link: &Path) -> Result<(), AppCommandError> {
    std::os::unix::fs::symlink(target, link).map_err(|e| {
        AppCommandError::io_error("Failed to create the folder link")
            .with_detail(format!("{} -> {}: {e}", link.display(), target.display()))
    })
}

#[cfg(windows)]
fn create_dir_symlink(target: &Path, link: &Path) -> Result<(), AppCommandError> {
    // A real symlink needs SeCreateSymbolicLinkPrivilege, which an unelevated
    // process only has with Developer Mode on. Fall back to a directory
    // junction, which needs no privilege and behaves the same for local
    // absolute paths (which is all we ever link).
    match std::os::windows::fs::symlink_dir(target, link) {
        Ok(()) => Ok(()),
        Err(symlink_err) => {
            let output = crate::process::std_command("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output();
            match output {
                Ok(out) if out.status.success() => Ok(()),
                Ok(out) => Err(AppCommandError::io_error(
                    "Failed to create the folder link. Enable Developer Mode in Windows settings, \
                     or run the app as administrator.",
                )
                .with_detail(format!(
                    "symlink_dir: {symlink_err}; mklink /J: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ))),
                Err(spawn_err) => Err(AppCommandError::io_error(
                    "Failed to create the folder link. Enable Developer Mode in Windows settings, \
                     or run the app as administrator.",
                )
                .with_detail(format!(
                    "symlink_dir: {symlink_err}; mklink /J: {spawn_err}"
                ))),
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn create_dir_symlink(_target: &Path, _link: &Path) -> Result<(), AppCommandError> {
    Err(AppCommandError::io_error(
        "Folder links are not supported on this platform",
    ))
}

/// Delete the link entry itself — never its contents.
///
/// `remove_dir_all` is deliberately not used anywhere in this module: on
/// Windows it would recurse *through* a junction and delete the user's real
/// project. `remove_file` handles unix symlinks; `remove_dir` handles Windows
/// directory symlinks and junctions (both are empty reparse points to the OS).
/// What [`remove_link_entry`] found at the path. Distinguishes "there was
/// nothing of ours to remove" — which still lets the caller drop the record —
/// from a genuine removal failure, which must not be reported as success.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkRemoval {
    /// The symlink was removed.
    Removed,
    /// Nothing was there: already the desired end state.
    Absent,
    /// A real file/directory holds the name. Removing it would destroy user
    /// data, so it is left alone.
    NotALink,
}

fn remove_link_entry(link: &Path) -> std::io::Result<LinkRemoval> {
    let metadata = match std::fs::symlink_metadata(link) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LinkRemoval::Absent),
        Err(e) => return Err(e),
    };
    if !metadata.file_type().is_symlink() {
        return Ok(LinkRemoval::NotALink);
    }
    match std::fs::remove_file(link) {
        Ok(()) => Ok(LinkRemoval::Removed),
        // Windows directory symlinks / junctions must go through remove_dir.
        Err(first) => match std::fs::remove_dir(link) {
            Ok(()) => Ok(LinkRemoval::Removed),
            // Report the original error: on unix `remove_dir` on a symlink
            // fails with a misleading ENOTDIR that hides the real cause.
            Err(_) => Err(first),
        },
    }
}

/// Read where a link points, or `None` when the path is not a link.
fn read_link_target(link: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(link).ok()?;
    if !metadata.file_type().is_symlink() {
        return None;
    }
    std::fs::canonicalize(link).ok()
}

// ---------------------------------------------------------------------------
// git exclude
// ---------------------------------------------------------------------------

/// Ignore rule that hides the link from `git status`, anchored at the
/// repository root.
///
/// `info/exclude` patterns are relative to the *work tree top level*, not to
/// the workspace folder — so when the folder is a subdirectory of the repo the
/// rule has to carry that prefix, or it would exclude an unrelated
/// `<repo>/<name>` instead. A leading `/` anchors it so only that one entry is
/// matched.
fn git_exclude_line(toplevel: &Path, root: &Path, name: &str) -> String {
    let rel = std::fs::canonicalize(root)
        .ok()
        .and_then(|canonical_root| {
            std::fs::canonicalize(toplevel)
                .ok()
                .and_then(|top| canonical_root.strip_prefix(&top).map(Path::to_path_buf).ok())
        })
        .unwrap_or_default();
    let prefix = rel.to_string_lossy().replace('\\', "/");
    if prefix.is_empty() {
        format!("/{name}")
    } else {
        format!("/{}/{}", prefix.trim_matches('/'), name)
    }
}

/// Append an ignore rule for the link to the repository's `info/exclude` so it
/// doesn't show up as an untracked file in the user's own project.
///
/// `info/exclude`, not `.gitignore`: it is local-only and never committed, so
/// we never modify a file the user would have to review or push. Best-effort —
/// a failure only means a noisier `git status`.
async fn add_to_git_exclude(root: &Path, name: &str) {
    let Some(git_dir) = resolve_git_common_dir(root).await else {
        return;
    };
    let Some(toplevel) = resolve_git_toplevel(root).await else {
        return;
    };
    let info_dir = git_dir.join("info");
    if std::fs::create_dir_all(&info_dir).is_err() {
        return;
    }
    let exclude_path = info_dir.join("exclude");
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let line = git_exclude_line(&toplevel, root, name);
    if existing.lines().any(|l| l.trim() == line) {
        return;
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !next.contains("# codeg workspace links") {
        next.push_str("# codeg workspace links\n");
    }
    next.push_str(&line);
    next.push('\n');
    if let Err(e) = std::fs::write(&exclude_path, next) {
        tracing::debug!("[folder-link] could not update {}: {e}", exclude_path.display());
    }
}

async fn git_rev_parse_path(root: &Path, arg: &str) -> Option<PathBuf> {
    let output = crate::process::tokio_command("git")
        .args(["rev-parse", arg])
        .current_dir(root)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(&raw);
    Some(if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}

/// Absolute path of the repository's common git dir (shared by every worktree,
/// which is where `info/exclude` lives). `None` when `root` is not a repo.
async fn resolve_git_common_dir(root: &Path) -> Option<PathBuf> {
    git_rev_parse_path(root, "--git-common-dir").await
}

/// Absolute path of the work tree's top level — the directory `info/exclude`
/// patterns are resolved against.
async fn resolve_git_toplevel(root: &Path) -> Option<PathBuf> {
    git_rev_parse_path(root, "--show-toplevel").await
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

async fn load_root(db: &AppDatabase, folder_id: i32) -> Result<PathBuf, AppCommandError> {
    let folder = folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("Folder {folder_id} not found")))?;
    Ok(PathBuf::from(folder.path))
}

fn link_status(root: &Path, name: &str, target: &str) -> FolderLinkStatus {
    let link_path = root.join(name);
    let Ok(metadata) = std::fs::symlink_metadata(&link_path) else {
        return FolderLinkStatus::Missing;
    };
    if !metadata.file_type().is_symlink() {
        return FolderLinkStatus::Conflicted;
    }
    let Ok(resolved) = std::fs::canonicalize(&link_path) else {
        return FolderLinkStatus::Broken;
    };
    match std::fs::canonicalize(target) {
        Ok(expected) if expected == resolved => FolderLinkStatus::Ok,
        Ok(_) => FolderLinkStatus::Conflicted,
        Err(_) => FolderLinkStatus::Broken,
    }
}

pub async fn list_folder_links_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<Vec<FolderLinkDetail>, AppCommandError> {
    let root = load_root(db, folder_id).await?;
    let rows = folder_link_service::list_by_folder(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(rows
        .into_iter()
        .map(|row| FolderLinkDetail {
            status: link_status(&root, &row.name, &row.target_path),
            id: row.id,
            folder_id: row.folder_id,
            name: row.name,
            target_path: row.target_path,
        })
        .collect())
}

/// Dry run: resolve names and conflicts for a batch of picked directories
/// without touching the filesystem. The dialog calls this on every change so
/// the user sees the final names (and any rejections) before committing.
pub async fn preview_folder_links_core(
    db: &AppDatabase,
    folder_id: i32,
    paths: Vec<String>,
) -> Result<Vec<FolderLinkPlan>, AppCommandError> {
    let root = load_root(db, folder_id).await?;
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|_| AppCommandError::not_found("Workspace folder does not exist"))?;
    let existing = folder_link_service::list_by_folder(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?;

    let on_disk = occupied_names(&root);
    let mut taken: HashSet<String> = on_disk.clone();
    for link in &existing {
        taken.insert(name_key(&link.name));
    }

    let mut plans = Vec::with_capacity(paths.len());
    for raw in paths {
        let validated = match validate_target(&canonical_root, &raw) {
            Ok(v) => v,
            Err(rejection) => {
                plans.push(FolderLinkPlan {
                    base_name: derive_link_name(Path::new(raw.trim())),
                    target_path: raw,
                    name: String::new(),
                    renamed: false,
                    collides_with_existing_entry: false,
                    rejection: Some(rejection),
                    existing_link_name: None,
                });
                continue;
            }
        };

        // Same directory already linked here (compared canonically, so `~/a`
        // and a symlinked route to it count as one).
        let duplicate = existing.iter().find(|link| {
            std::fs::canonicalize(&link.target_path)
                .map(|p| p == validated.canonical)
                .unwrap_or(false)
        });
        if let Some(dup) = duplicate {
            plans.push(FolderLinkPlan {
                base_name: derive_link_name(&validated.canonical),
                target_path: raw,
                name: String::new(),
                renamed: false,
                collides_with_existing_entry: false,
                rejection: Some(FolderLinkRejection::AlreadyLinked),
                existing_link_name: Some(dup.name.clone()),
            });
            continue;
        }

        let base = derive_link_name(&validated.canonical);
        let Some(name) = unique_link_name(&base, &taken) else {
            plans.push(FolderLinkPlan {
                base_name: base,
                target_path: raw,
                name: String::new(),
                renamed: false,
                collides_with_existing_entry: true,
                rejection: Some(FolderLinkRejection::NameUnavailable),
                existing_link_name: None,
            });
            continue;
        };
        let renamed = name != base;
        taken.insert(name_key(&name));
        plans.push(FolderLinkPlan {
            target_path: raw,
            collides_with_existing_entry: renamed && on_disk.contains(&name_key(&base)),
            base_name: base,
            name,
            renamed,
            rejection: None,
            existing_link_name: None,
        });
    }

    Ok(plans)
}

/// Create the links. Rejected entries are skipped rather than failing the whole
/// batch — the returned list is what actually landed, and the caller compares
/// it against what it asked for.
pub async fn create_folder_links_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
    items: Vec<FolderLinkRequest>,
    git_exclude: bool,
) -> Result<Vec<FolderLinkDetail>, AppCommandError> {
    let root = load_root(db, folder_id).await?;
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|_| AppCommandError::not_found("Workspace folder does not exist"))?;
    let existing = folder_link_service::list_by_folder(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?;

    let mut taken: HashSet<String> = occupied_names(&root);
    for link in &existing {
        taken.insert(name_key(&link.name));
    }

    // Targets already linked here, canonicalized so `~/a` and a symlinked route
    // to it count as one. Grows as the batch lands, so the same directory
    // submitted twice in one call links once instead of becoming `api` + `api-2`.
    let mut linked_targets: Vec<PathBuf> = existing
        .iter()
        .filter_map(|link| std::fs::canonicalize(&link.target_path).ok())
        .collect();

    let mut created = Vec::new();
    for item in items {
        let Ok(validated) = validate_target(&canonical_root, &item.path) else {
            continue;
        };
        if linked_targets.contains(&validated.canonical) {
            continue;
        }

        // An explicit name still goes through sanitization and disambiguation:
        // the client's view of the directory can be stale, and we must never
        // overwrite something that is already there.
        let base = match item.name.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => sanitize_link_name(name),
            _ => derive_link_name(&validated.canonical),
        };
        let Some(name) = unique_link_name(&base, &taken) else {
            return Err(AppCommandError::already_exists(
                "Could not find a free name for the linked folder",
            )
            .with_detail(base));
        };

        let link_path = root.join(&name);
        create_dir_symlink(&validated.canonical, &link_path)?;

        // Persist only after the link exists, so a failed create never leaves a
        // row granting access to a path with nothing behind it.
        let row = match folder_link_service::insert(
            &db.conn,
            folder_id,
            &name,
            &validated.canonical.to_string_lossy(),
        )
        .await
        {
            Ok(row) => row,
            Err(e) => {
                let _ = remove_link_entry(&link_path);
                return Err(AppCommandError::from(e));
            }
        };

        crate::folder_links::register(&root, &validated.canonical);
        taken.insert(name_key(&name));
        linked_targets.push(validated.canonical.clone());
        if git_exclude {
            add_to_git_exclude(&root, &name).await;
        }

        created.push(FolderLinkDetail {
            status: link_status(&root, &row.name, &row.target_path),
            id: row.id,
            folder_id: row.folder_id,
            name: row.name,
            target_path: row.target_path,
        });
    }

    if !created.is_empty() {
        emit_event(
            emitter,
            FOLDER_LINKS_CHANGED_EVENT,
            FolderLinksChanged { folder_id },
        );
    }
    Ok(created)
}

/// Rename a link: move the symlink on disk, then update the row. The target is
/// untouched.
pub async fn rename_folder_link_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    link_id: i32,
    new_name: String,
) -> Result<FolderLinkDetail, AppCommandError> {
    let row = folder_link_service::get_by_id(&db.conn, link_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder link not found"))?;
    let root = load_root(db, row.folder_id).await?;

    let sanitized = sanitize_link_name(&new_name);
    // Compared byte-for-byte, NOT case-folded: on a case-sensitive filesystem
    // `api` -> `API` is a real move, and skipping it would leave the row naming
    // an entry that isn't there (reported `missing`, "repaired" into a second
    // link, with the original left behind and unmanageable).
    if sanitized == row.name {
        return Ok(FolderLinkDetail {
            status: link_status(&root, &row.name, &row.target_path),
            id: row.id,
            folder_id: row.folder_id,
            name: row.name,
            target_path: row.target_path,
        });
    }

    let mut taken = occupied_names(&root);
    // The link's own current name is about to be freed.
    taken.remove(&name_key(&row.name));
    for other in folder_link_service::list_by_folder(&db.conn, row.folder_id)
        .await
        .map_err(AppCommandError::from)?
    {
        if other.id != link_id {
            taken.insert(name_key(&other.name));
        }
    }
    if taken.contains(&name_key(&sanitized)) {
        return Err(
            AppCommandError::already_exists("That name is already used in this folder")
                .with_detail(sanitized),
        );
    }

    let from = root.join(&row.name);
    let to = root.join(&sanitized);
    // Only move something that is actually a link — if a real directory took
    // over the name, renaming it would move the user's data.
    if read_link_target(&from).is_some() {
        std::fs::rename(&from, &to).map_err(|e| {
            AppCommandError::io_error("Failed to rename the folder link").with_detail(e.to_string())
        })?;
    } else if std::fs::symlink_metadata(&from).is_ok() {
        return Err(AppCommandError::invalid_input(
            "That entry is no longer a folder link",
        ));
    } else {
        // The link is missing on disk; recreate it under the new name so the
        // rename doubles as a repair.
        create_dir_symlink(Path::new(&row.target_path), &to)?;
    }

    let updated = folder_link_service::rename(&db.conn, link_id, &sanitized)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder link not found"))?;

    emit_event(
        emitter,
        FOLDER_LINKS_CHANGED_EVENT,
        FolderLinksChanged {
            folder_id: row.folder_id,
        },
    );
    Ok(FolderLinkDetail {
        status: link_status(&root, &updated.name, &updated.target_path),
        id: updated.id,
        folder_id: updated.folder_id,
        name: updated.name,
        target_path: updated.target_path,
    })
}

/// Recreate the symlink for a link whose on-disk entry went missing.
pub async fn repair_folder_link_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    link_id: i32,
) -> Result<FolderLinkDetail, AppCommandError> {
    let row = folder_link_service::get_by_id(&db.conn, link_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder link not found"))?;
    let root = load_root(db, row.folder_id).await?;
    let link_path = root.join(&row.name);

    let target = std::fs::canonicalize(&row.target_path).map_err(|_| {
        AppCommandError::not_found("The linked folder no longer exists")
            .with_detail(row.target_path.clone())
    })?;

    match std::fs::symlink_metadata(&link_path) {
        Ok(md) if md.file_type().is_symlink() => {
            // Dangling or pointing elsewhere — replace it.
            remove_link_entry(&link_path).map_err(|e| {
                AppCommandError::io_error("Failed to replace the folder link")
                    .with_detail(e.to_string())
            })?;
        }
        Ok(_) => {
            return Err(AppCommandError::already_exists(
                "Something else already occupies that name",
            )
            .with_detail(row.name.clone()));
        }
        Err(_) => {}
    }

    create_dir_symlink(&target, &link_path)?;
    crate::folder_links::register(&root, &target);

    emit_event(
        emitter,
        FOLDER_LINKS_CHANGED_EVENT,
        FolderLinksChanged {
            folder_id: row.folder_id,
        },
    );
    Ok(FolderLinkDetail {
        status: link_status(&root, &row.name, &row.target_path),
        id: row.id,
        folder_id: row.folder_id,
        name: row.name,
        target_path: row.target_path,
    })
}

/// Drop a link. With `delete_link` the symlink itself is removed from the root;
/// the directory it pointed at is never touched.
///
/// The filesystem goes first and its failure is fatal. Dropping the row first
/// would report success while leaving a symlink the UI no longer lists — still
/// fully traversable by an agent CLI whose cwd is the workspace root, and no
/// longer removable from the app.
pub async fn remove_folder_link_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    link_id: i32,
    delete_link: bool,
) -> Result<(), AppCommandError> {
    let Some(row) = folder_link_service::get_by_id(&db.conn, link_id)
        .await
        .map_err(AppCommandError::from)?
    else {
        return Ok(());
    };

    let root = load_root(db, row.folder_id).await.ok();

    if delete_link {
        if let Some(root) = root.as_ref() {
            let link_path = root.join(&row.name);
            remove_link_entry(&link_path).map_err(|e| {
                AppCommandError::io_error("Failed to remove the folder link")
                    .with_detail(format!("{}: {e}", link_path.display()))
            })?;
        }
    }

    folder_link_service::delete(&db.conn, link_id)
        .await
        .map_err(AppCommandError::from)?;

    if let Some(root) = root.as_ref() {
        crate::folder_links::unregister(root, Path::new(&row.target_path));
    }

    emit_event(
        emitter,
        FOLDER_LINKS_CHANGED_EVENT,
        FolderLinksChanged {
            folder_id: row.folder_id,
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_folder_links(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<Vec<FolderLinkDetail>, AppCommandError> {
    list_folder_links_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn preview_folder_links(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    paths: Vec<String>,
) -> Result<Vec<FolderLinkPlan>, AppCommandError> {
    preview_folder_links_core(&db, folder_id, paths).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_folder_links(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    items: Vec<FolderLinkRequest>,
    git_exclude: Option<bool>,
) -> Result<Vec<FolderLinkDetail>, AppCommandError> {
    create_folder_links_core(
        &EventEmitter::from_app(&app),
        &db,
        folder_id,
        items,
        git_exclude.unwrap_or(true),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn rename_folder_link(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    link_id: i32,
    new_name: String,
) -> Result<FolderLinkDetail, AppCommandError> {
    rename_folder_link_core(&EventEmitter::from_app(&app), &db, link_id, new_name).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn repair_folder_link(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    link_id: i32,
) -> Result<FolderLinkDetail, AppCommandError> {
    repair_folder_link_core(&EventEmitter::from_app(&app), &db, link_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remove_folder_link(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    link_id: i32,
    delete_link: Option<bool>,
) -> Result<(), AppCommandError> {
    remove_folder_link_core(
        &EventEmitter::from_app(&app),
        &db,
        link_id,
        delete_link.unwrap_or(true),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_separators_and_illegal_characters() {
        assert_eq!(sanitize_link_name("a/b"), "a-b");
        assert_eq!(sanitize_link_name("a\\b"), "a-b");
        assert_eq!(sanitize_link_name("a:b*c?d\"e<f>g|h"), "a-b-c-d-e-f-g-h");
    }

    #[test]
    fn sanitize_trims_trailing_dots_and_spaces() {
        // Windows silently strips these, which would desync the stored name
        // from what actually lands on disk.
        assert_eq!(sanitize_link_name("api. "), "api");
        assert_eq!(sanitize_link_name("  api  "), "api");
    }

    #[test]
    fn sanitize_falls_back_for_degenerate_input() {
        assert_eq!(sanitize_link_name(""), FALLBACK_LINK_NAME);
        assert_eq!(sanitize_link_name("   "), FALLBACK_LINK_NAME);
        assert_eq!(sanitize_link_name("."), FALLBACK_LINK_NAME);
        assert_eq!(sanitize_link_name(".."), FALLBACK_LINK_NAME);
    }

    #[test]
    fn sanitize_defuses_windows_reserved_names() {
        assert_eq!(sanitize_link_name("con"), "con-dir");
        assert_eq!(sanitize_link_name("CON"), "CON-dir");
        // Reserved with or without an extension.
        assert_eq!(sanitize_link_name("nul.txt"), "nul.txt-dir");
        // Not reserved — only the exact device names are.
        assert_eq!(sanitize_link_name("console"), "console");
    }

    #[test]
    fn sanitize_truncates_long_names_on_a_char_boundary() {
        let long = "é".repeat(200);
        let out = sanitize_link_name(&long);
        assert_eq!(out.chars().count(), MAX_LINK_NAME_LEN);
    }

    #[test]
    fn derive_uses_the_final_component() {
        assert_eq!(derive_link_name(Path::new("/Users/me/work/api")), "api");
    }

    #[test]
    fn derive_falls_back_when_there_is_no_final_component() {
        // A filesystem root has no final component; the name must still be
        // usable rather than empty.
        let name = derive_link_name(Path::new("/"));
        assert!(!name.is_empty());
        assert!(!name.contains('/'));
    }

    #[test]
    fn unique_name_disambiguates_case_insensitively() {
        // macOS and Windows filesystems are case-insensitive by default, so
        // `API` already occupies `api`.
        let taken: HashSet<String> = ["api".to_string()].into_iter().collect();
        assert_eq!(unique_link_name("API", &taken).as_deref(), Some("API-2"));
    }

    #[test]
    fn unique_name_walks_up_the_suffixes() {
        let taken: HashSet<String> = ["api", "api-2", "api-3"]
            .into_iter()
            .map(str::to_string)
            .collect();
        assert_eq!(unique_link_name("api", &taken).as_deref(), Some("api-4"));
    }

    #[test]
    fn unique_name_gives_up_when_every_probe_is_taken() {
        let mut taken: HashSet<String> = HashSet::new();
        taken.insert("api".to_string());
        for n in 2..=MAX_NAME_PROBES {
            taken.insert(format!("api-{n}"));
        }
        assert!(unique_link_name("api", &taken).is_none());
    }

    #[test]
    fn git_exclude_line_anchors_at_the_repository_root() {
        // `info/exclude` patterns resolve against the work tree top level, so a
        // workspace folder nested inside the repo must carry its prefix —
        // otherwise the rule would hide an unrelated `<repo>/api`.
        let top = std::env::temp_dir().join("codeg-exclude-test-repo");
        let nested = top.join("packages/app");
        std::fs::create_dir_all(&nested).expect("mkdir");

        assert_eq!(git_exclude_line(&top, &top, "api"), "/api");
        assert_eq!(
            git_exclude_line(&top, &nested, "api"),
            "/packages/app/api"
        );

        let _ = std::fs::remove_dir_all(&top);
    }

    #[test]
    fn git_exclude_line_degrades_to_the_bare_name_off_tree() {
        // Unresolvable paths must not produce a `..`-style pattern; anchoring at
        // the root is the safe fallback.
        let line = git_exclude_line(
            Path::new("/definitely/not/here"),
            Path::new("/also/not/here"),
            "api",
        );
        assert_eq!(line, "/api");
    }

    #[test]
    fn unique_name_passes_a_free_name_through() {
        assert_eq!(
            unique_link_name("api", &HashSet::new()).as_deref(),
            Some("api")
        );
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn occupied_names_counts_a_dangling_symlink() {
        let root = tempfile::tempdir().expect("root");
        // `Path::exists()` follows the link and reports false for a dangling
        // one — creating over it would then fail with AlreadyExists instead of
        // being disambiguated.
        symlink(root.path().join("gone"), root.path().join("api")).expect("symlink");
        let names = occupied_names(root.path());
        assert!(names.contains("api"), "dangling link occupies its name");
    }

    #[test]
    fn validate_rejects_self_ancestor_and_inside() {
        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("root");
        std::fs::create_dir(&root).expect("mkdir root");
        let inner = root.join("inner");
        std::fs::create_dir(&inner).expect("mkdir inner");
        let canonical_root = std::fs::canonicalize(&root).expect("canon");

        assert_eq!(
            validate_target(&canonical_root, &root.to_string_lossy()).err(),
            Some(FolderLinkRejection::SameAsRoot)
        );
        assert_eq!(
            validate_target(&canonical_root, &parent.path().to_string_lossy()).err(),
            Some(FolderLinkRejection::AncestorOfRoot)
        );
        assert_eq!(
            validate_target(&canonical_root, &inner.to_string_lossy()).err(),
            Some(FolderLinkRejection::InsideRoot)
        );
    }

    #[test]
    fn validate_rejects_missing_and_non_directories() {
        let root = tempfile::tempdir().expect("root");
        let canonical_root = std::fs::canonicalize(root.path()).expect("canon");
        let file = root.path().join("../a-file.txt");
        std::fs::write(&file, b"x").expect("write");

        assert_eq!(
            validate_target(&canonical_root, "/definitely/not/here").err(),
            Some(FolderLinkRejection::NotFound)
        );
        assert_eq!(
            validate_target(&canonical_root, "").err(),
            Some(FolderLinkRejection::NotFound)
        );
        assert_eq!(
            validate_target(&canonical_root, &file.to_string_lossy()).err(),
            Some(FolderLinkRejection::NotADirectory)
        );
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn remove_link_entry_never_touches_the_target_contents() {
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        let payload = linked.path().join("important.txt");
        std::fs::write(&payload, b"do not delete").expect("write");
        let link = root.path().join("api");
        symlink(linked.path(), &link).expect("symlink");

        remove_link_entry(&link).expect("remove link");

        assert!(
            std::fs::symlink_metadata(&link).is_err(),
            "the link itself is gone"
        );
        assert!(
            payload.exists(),
            "the linked project's files must survive unlinking"
        );
    }

    #[test]
    fn remove_link_entry_reports_a_real_directory_without_touching_it() {
        let root = tempfile::tempdir().expect("root");
        let real = root.path().join("api");
        std::fs::create_dir(&real).expect("mkdir");
        std::fs::write(real.join("file.txt"), b"x").expect("write");

        assert_eq!(
            remove_link_entry(&real).expect("classified, not failed"),
            LinkRemoval::NotALink,
            "a real directory in the link's place must be reported, not removed"
        );
        assert!(real.join("file.txt").exists(), "contents untouched");
    }

    #[test]
    fn remove_link_entry_is_idempotent() {
        let root = tempfile::tempdir().expect("root");
        assert_eq!(
            remove_link_entry(&root.path().join("nope")).expect("absent is fine"),
            LinkRemoval::Absent
        );
    }

    #[test]
    fn remove_link_entry_surfaces_a_real_failure() {
        // A read-only parent makes unlink fail with EACCES. That must be an
        // error, not a silent success — the caller drops the DB row on success
        // and would otherwise strand a symlink the UI can no longer manage.
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        let link = root.path().join("api");
        symlink(linked.path(), &link).expect("symlink");

        let original = std::fs::metadata(root.path()).expect("meta").permissions();
        let mut readonly = original.clone();
        readonly.set_mode(0o500);
        std::fs::set_permissions(root.path(), readonly).expect("chmod");

        let result = remove_link_entry(&link);

        // Restore before asserting so the tempdir can always clean itself up.
        std::fs::set_permissions(root.path(), original).expect("restore");
        assert!(
            result.is_err(),
            "an unlink that could not happen must not report success"
        );
        assert!(
            std::fs::symlink_metadata(&link).is_ok(),
            "the link is still there, which is exactly why this must error"
        );
    }
}

/// End-to-end coverage of the create/rename/remove lifecycle against a real
/// filesystem and a real (in-memory) database.
#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::web::event_bridge::EventEmitter;

    /// These tests assert on filesystem and database state, not on broadcasts.
    fn emitter() -> EventEmitter {
        EventEmitter::Noop
    }

    /// Symlink children of `root`, by name.
    fn link_names(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root)
            .expect("read_dir")
            .flatten()
            .filter(|e| {
                e.file_type()
                    .map(|ft| ft.is_symlink())
                    .unwrap_or(false)
            })
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    async fn setup(
        root: &Path,
        targets: &[&Path],
    ) -> (crate::db::AppDatabase, i32, Vec<FolderLinkDetail>) {
        let db = fresh_in_memory_db().await;
        let folder = crate::commands::folders::open_folder_core(
            &db,
            root.to_string_lossy().into_owned(),
        )
        .await
        .expect("open folder");
        let items = targets
            .iter()
            .map(|t| FolderLinkRequest {
                path: t.to_string_lossy().into_owned(),
                name: None,
            })
            .collect();
        // `git_exclude: false` keeps the test off `git` entirely.
        let created = create_folder_links_core(&emitter(), &db, folder.id, items, false)
            .await
            .expect("create links");
        (db, folder.id, created)
    }

    #[tokio::test]
    async fn rename_moves_the_link_even_when_only_the_case_changes() {
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        let (db, folder_id, created) = setup(root.path(), &[linked.path()]).await;
        let link_id = created[0].id;
        let original = created[0].name.clone();

        let renamed = rename_folder_link_core(
            &emitter(),
            &db,
            link_id,
            original.to_uppercase(),
        )
        .await
        .expect("case-only rename");

        assert_eq!(renamed.name, original.to_uppercase());
        // The row must describe something that is actually there. Skipping the
        // filesystem move (because the names fold to the same key) would leave
        // the old entry behind and report the link as `missing`.
        assert_eq!(
            renamed.status,
            FolderLinkStatus::Ok,
            "the renamed link must resolve on disk"
        );
        // Exactly one link, whatever the filesystem's case sensitivity.
        assert_eq!(link_names(root.path()).len(), 1);

        let listed = list_folder_links_core(&db, folder_id)
            .await
            .expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, FolderLinkStatus::Ok);
    }

    #[tokio::test]
    async fn removing_a_link_keeps_the_target_and_drops_the_record() {
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        std::fs::write(linked.path().join("keep.txt"), b"x").expect("write");
        let (db, folder_id, created) = setup(root.path(), &[linked.path()]).await;

        remove_folder_link_core(&emitter(), &db, created[0].id, true)
            .await
            .expect("remove");

        assert!(link_names(root.path()).is_empty(), "symlink is gone");
        assert!(
            linked.path().join("keep.txt").exists(),
            "the linked project's files survive"
        );
        assert!(list_folder_links_core(&db, folder_id)
            .await
            .expect("list")
            .is_empty());
    }

    #[tokio::test]
    async fn a_failed_unlink_keeps_the_record_instead_of_reporting_success() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        let (db, folder_id, created) = setup(root.path(), &[linked.path()]).await;

        let original = std::fs::metadata(root.path()).expect("meta").permissions();
        let mut readonly = original.clone();
        readonly.set_mode(0o500);
        std::fs::set_permissions(root.path(), readonly).expect("chmod");

        let result = remove_folder_link_core(&emitter(), &db, created[0].id, true).await;

        std::fs::set_permissions(root.path(), original).expect("restore");

        assert!(result.is_err(), "the unlink could not happen");
        // The row must survive so the link stays listed and retryable — an
        // agent CLI rooted at the workspace can still traverse the symlink.
        assert_eq!(
            list_folder_links_core(&db, folder_id)
                .await
                .expect("list")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn the_same_directory_submitted_twice_links_once() {
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        let (_db, _folder_id, created) =
            setup(root.path(), &[linked.path(), linked.path()]).await;

        assert_eq!(created.len(), 1, "no `api` + `api-2` pair for one directory");
        assert_eq!(link_names(root.path()).len(), 1);
    }

    #[tokio::test]
    async fn a_second_workspace_folder_cannot_reach_another_ones_link() {
        let root_a = tempfile::tempdir().expect("root a");
        let root_b = tempfile::tempdir().expect("root b");
        let linked = tempfile::tempdir().expect("linked");
        std::fs::write(linked.path().join("secret.txt"), b"x").expect("write");
        let (_db, _folder_id, created) = setup(root_a.path(), &[linked.path()]).await;
        let name = created[0].name.clone();

        // B has an identically-named symlink to the same directory, but never
        // authorized it — authorization is per (root, target), not per target.
        std::os::unix::fs::symlink(linked.path(), root_b.path().join(&name)).expect("symlink");

        let canonical_b = std::fs::canonicalize(root_b.path()).expect("canon b");
        let canonical_target = std::fs::canonicalize(linked.path()).expect("canon target");
        assert!(
            !crate::folder_links::is_allowed(&canonical_b, &canonical_target.join("secret.txt")),
            "another workspace's link must not grant access here"
        );
    }
}
