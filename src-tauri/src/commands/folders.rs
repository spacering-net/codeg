use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use ignore::WalkBuilder;
use serde::Serialize;

use tokio::sync::Semaphore;
use walkdir::WalkDir;

#[cfg(feature = "tauri-runtime")]
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::db::error::DbError;
use crate::db::service::{folder_group_service, folder_service};
use crate::db::AppDatabase;
use crate::models::GitCredentials;
use crate::models::{FolderDetail, FolderGroupDetail, FolderHistoryEntry, SidebarLayoutEntry};
use crate::web::event_bridge::EventEmitter;

/// Configure a git command for remote operations:
/// - Always disable interactive prompts (prevent hanging in a GUI app)
/// - If explicit credentials are provided, use them directly
/// - Otherwise, try to inject stored account credentials
async fn prepare_remote_git_cmd(
    cmd: &mut tokio::process::Command,
    repo_path: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) {
    prepare_remote_git_cmd_with_remote(cmd, repo_path, None, credentials, db, data_dir).await;
}

/// Same as `prepare_remote_git_cmd` but allows specifying a remote name
/// to match credentials against the correct remote URL.
async fn prepare_remote_git_cmd_with_remote(
    cmd: &mut tokio::process::Command,
    repo_path: &str,
    remote_name: Option<&str>,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) {
    cmd.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());

    if let Some(creds) = credentials {
        // Explicit credentials provided (e.g. from credential dialog)
        if let Ok(askpass) = crate::git_credential::ensure_askpass_script(data_dir) {
            crate::git_credential::inject_credentials(
                cmd,
                &creds.username,
                &creds.password,
                &askpass,
            );
        }
    } else {
        // Fall back to stored accounts, matching against the specified remote
        crate::git_credential::try_inject_for_repo_remote(
            cmd,
            repo_path,
            remote_name,
            &db.conn,
            data_dir,
        )
        .await;
    }
}

/// Same as `prepare_remote_git_cmd` but for clone (URL only, no repo yet).
async fn prepare_remote_git_cmd_for_url(
    cmd: &mut tokio::process::Command,
    clone_url: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) {
    cmd.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());

    if let Some(creds) = credentials {
        if let Ok(askpass) = crate::git_credential::ensure_askpass_script(data_dir) {
            crate::git_credential::inject_credentials(
                cmd,
                &creds.username,
                &creds.password,
                &askpass,
            );
        }
    } else {
        crate::git_credential::try_inject_for_url(cmd, clone_url, &db.conn, data_dir).await;
    }
}

/// Classify a git remote command error, detecting authentication failures.
pub(crate) fn classify_remote_git_error(operation: &str, stderr: &[u8]) -> AppCommandError {
    let msg = String::from_utf8_lossy(stderr).trim().to_string();
    tracing::error!("[GIT_CMD] {} failed, stderr: {}", operation, msg);
    let lower = msg.to_lowercase();

    if lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("logon failed")
        || lower.contains("terminal prompts disabled")
        || lower.contains("the requested url returned error: 401")
        || lower.contains("the requested url returned error: 403")
        || lower.contains("http basic: access denied")
    {
        return AppCommandError::authentication_failed(format!(
            "git {operation}: authentication failed. Configure a GitHub account in Settings → Version Control."
        ))
        .with_detail(msg);
    }

    if lower.contains("could not resolve host")
        || lower.contains("unable to access")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
    {
        return AppCommandError::network(format!("git {operation}: network error"))
            .with_detail(msg);
    }

    AppCommandError::external_command(format!("git {operation} failed"), msg)
}

#[derive(Debug, Serialize)]
pub struct GitStatusEntry {
    pub status: String,
    pub file: String,
}

#[derive(Debug, Serialize)]
pub struct GitBranchList {
    pub local: Vec<String>,
    pub remote: Vec<String>,
    /// Branches checked out in some *other* worktree than the queried path.
    pub worktree_branches: Vec<String>,
    /// The branch checked out in the repo's main working tree, when that is not
    /// the queried path itself. It appears in `worktree_branches` like any other
    /// — but its checkout is the repo, so it can neither be deleted nor removed.
    pub main_worktree_branch: Option<String>,
}

/// Where a given branch is checked out, resolved against the registered folders.
/// `path` is the canonical filesystem path of the worktree (or main working
/// tree) hosting the branch — `None` when the branch is not checked out in any
/// worktree. `folder_id` is the registered folder whose canonicalized path
/// matches `path` — `None` for an external/unregistered worktree. Drives the
/// branch selector's "navigate vs checkout" decision.
#[derive(Debug, Serialize)]
pub struct WorktreeResolution {
    pub path: Option<String>,
    pub folder_id: Option<i32>,
}

/// What [`git_remove_worktree_core`] actually did, so the caller can report it
/// without re-probing git.
#[derive(Debug, Serialize)]
pub struct GitWorktreeRemoval {
    /// The worktree directory that was removed — `None` when the branch had no
    /// registered worktree left (a retry after a partially applied removal).
    pub worktree_path: Option<String>,
    /// Whether the branch was deleted too (always `false` when not requested).
    pub branch_deleted: bool,
    /// The registered folder dropped along with the directory, if there was one.
    pub folder_id: Option<i32>,
    /// Conversations re-parented onto the project folder by that drop.
    pub reparented: u32,
}

#[derive(Debug, Serialize)]
pub struct GitConflictInfo {
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
    pub operation: String,
    pub upstream_commit: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitPullResult {
    pub updated_files: usize,
    pub conflict: Option<GitConflictInfo>,
}

#[derive(Debug, Serialize)]
pub struct GitPushResult {
    pub pushed_commits: usize,
    pub upstream_set: bool,
}

#[derive(Debug, Serialize)]
pub struct GitPushInfo {
    pub branch: String,
    pub remotes: Vec<GitRemote>,
    pub tracking_remote: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GitMergeResult {
    pub merged_commits: usize,
    pub conflict: Option<GitConflictInfo>,
}

#[derive(Debug, Serialize)]
pub struct GitRebaseResult {
    pub message: String,
    pub conflict: Option<GitConflictInfo>,
}

#[derive(Debug, Serialize)]
pub struct GitConflictFileVersions {
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub merged: String,
}

#[derive(Debug, Serialize)]
pub struct GitCommitResult {
    pub committed_files: usize,
}

#[derive(Debug, Serialize)]
pub struct GitStashEntry {
    pub index: usize,
    pub message: String,
    pub branch: String,
    pub date: String,
    pub ref_name: String,
}

#[derive(Debug, Serialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
struct GitCommitSucceededEvent {
    folder_id: i32,
    committed_files: usize,
}

#[derive(Debug, Clone, Serialize)]
struct GitPushSucceededEvent {
    folder_id: i32,
    pushed_commits: usize,
    upstream_set: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileTreeNode {
    File {
        name: String,
        path: String,
    },
    Dir {
        name: String,
        path: String,
        children: Vec<FileTreeNode>,
        /// The entry is a symlink on disk. The panel badges it as a link; its
        /// children are left empty here and lazily fetched when the row is
        /// expanded, because the walk deliberately does not descend through
        /// links (a `x -> ..` loop or a pnpm symlink farm would blow up).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        symlink: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceEntryKind {
    File,
    Dir,
}

/// A flat workspace entry produced by `list_workspace_files`. Unlike the nested
/// `FileTreeNode`, this is a single flat record suited to fuzzy file search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceFileEntry {
    pub name: String,
    /// Path relative to the workspace root, always forward-slashed.
    pub path: String,
    pub kind: WorkspaceEntryKind,
}

#[derive(Debug, Serialize)]
pub struct FilePreviewContent {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct FileEditContent {
    pub path: String,
    pub content: String,
    pub etag: String,
    pub mtime_ms: Option<i64>,
    pub readonly: bool,
    pub line_ending: String,
}

#[derive(Debug, Serialize)]
pub struct FileSaveResult {
    pub path: String,
    pub etag: String,
    pub mtime_ms: Option<i64>,
    pub readonly: bool,
    pub line_ending: String,
}

#[derive(Debug, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub full_hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
    pub files: Vec<GitLogFileChange>,
    pub pushed: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct GitLogFileChange {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize)]
pub struct GitLogResult {
    pub entries: Vec<GitLogEntry>,
    pub has_upstream: bool,
}

fn count_non_empty_lines(content: &str) -> usize {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .count()
}

fn parse_count_from_output(stdout: &[u8]) -> Option<usize> {
    String::from_utf8_lossy(stdout).trim().parse::<usize>().ok()
}

pub(crate) fn git_command_error(operation: &str, stderr: &[u8]) -> AppCommandError {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    AppCommandError::external_command(format!("git {operation} failed"), stderr)
}

use crate::git_repo::ensure_git_repo;

pub(crate) async fn detect_conflicts(path: &str) -> Result<Vec<String>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["-c", "core.quotePath=false"])
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(unquote_git_path)
        .filter(|l| !l.is_empty())
        .collect())
}

async fn get_head_hash(path: &str) -> Result<Option<String>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Ok(None);
    }

    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if head.is_empty() {
        return Ok(None);
    }
    Ok(Some(head))
}

async fn count_files_in_commit(path: &str, commit: &str) -> Result<usize, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["show", "--name-only", "--pretty=format:", commit])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("show", &output.stderr));
    }

    Ok(count_non_empty_lines(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

async fn count_changed_files_between(
    path: &str,
    base: &str,
    head: &str,
) -> Result<usize, AppCommandError> {
    let range = format!("{}..{}", base, head);
    let output = crate::process::tokio_command("git")
        .args(["diff", "--name-only", &range])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("diff", &output.stderr));
    }

    Ok(count_non_empty_lines(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Reject a caller-supplied push target that isn't a plain branch name.
///
/// The value reaches `git` as its own argv element (no shell), so quoting isn't
/// the concern — it's that `git push <remote> <value>` reads the value as a
/// REFSPEC, and this path is reachable from the push window's `?branch=` query
/// and from the server-mode HTTP API. Left unchecked, `:main` deletes the remote
/// branch, `+main:main` force-pushes over it, and `--mirror` parses as a flag.
/// So: no leading `-`/`+`, no `:`, no whitespace or control characters. What
/// survives can only be a single ref name — `ensure_local_branch_exists` then
/// confirms it actually is one.
pub(crate) fn ensure_pushable_branch_name(branch: &str) -> Result<(), AppCommandError> {
    let rejected = branch.is_empty()
        || branch.starts_with('-')
        || branch.starts_with('+')
        || branch.contains(':')
        || branch.chars().any(|c| c.is_whitespace() || c.is_control());
    if rejected {
        return Err(AppCommandError::invalid_input("Invalid branch name")
            .with_detail(format!("branch={branch}")));
    }
    Ok(())
}

/// Confirm `branch` names an existing local branch, so a push can only ever
/// publish a ref that already exists here. Belt to
/// `ensure_pushable_branch_name`'s braces: that one rules out refspec syntax,
/// this one rules out everything else a caller could invent.
///
/// `show-ref --verify` deliberately, NOT `rev-parse --verify`: the latter takes
/// a revision EXPRESSION, so `main^` and `main@{1}` would both resolve and slip
/// through. `show-ref --verify` only accepts an exact ref path.
async fn ensure_local_branch_exists(
    path: &str,
    branch: &str,
) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !output.status.success() {
        return Err(AppCommandError::not_found("Branch not found")
            .with_detail(format!("branch={branch}")));
    }
    Ok(())
}

/// How many commits a push would publish. `branch` names the ref to measure;
/// `None` means the checked-out one (`HEAD`), which is what every caller but the
/// per-branch push uses.
async fn estimate_push_commit_count(path: &str, branch: Option<&str>) -> usize {
    // Full ref for an explicit branch — see `git_push_core` for why short names
    // can't be trusted as revs.
    let rev = match branch {
        Some(name) => format!("refs/heads/{name}"),
        None => "HEAD".to_string(),
    };
    // ...but the `@{push}` SUFFIX is the one place that must stay short: git
    // resolves it through `branch.<name>.*` config and rejects a qualified ref
    // outright ("fatal: no such branch: 'refs/heads/x'"), which would silently
    // drop every explicit-branch call into the fallback below. Only the range's
    // left side needs it; the right side keeps the unambiguous full ref.
    let push_range = match branch {
        Some(name) => format!("{name}@{{push}}..refs/heads/{name}"),
        None => "@{push}..HEAD".to_string(),
    };
    let upstream_ahead = crate::process::tokio_command("git")
        .args(["rev-list", "--count", &push_range])
        .current_dir(path)
        .output()
        .await;
    if let Ok(output) = upstream_ahead {
        if output.status.success() {
            if let Some(count) = parse_count_from_output(&output.stdout) {
                return count;
            }
        }
    }

    // Fallback for a branch with no `@{push}`: count what it holds that no ref
    // of its remote has. The SHORT name is what keys `branch.<name>.remote`;
    // the rev-list below still walks the full ref.
    let branch = match branch {
        Some(name) => name.to_string(),
        None => {
            let branch_output = crate::process::tokio_command("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(path)
                .output()
                .await;
            let Ok(branch_output) = branch_output else {
                return 0;
            };
            if !branch_output.status.success() {
                return 0;
            }
            String::from_utf8_lossy(&branch_output.stdout)
                .trim()
                .to_string()
        }
    };
    if branch.is_empty() || branch == "HEAD" {
        return 0;
    }

    let remote_key = format!("branch.{}.remote", branch);
    let remote_output = crate::process::tokio_command("git")
        .args(["config", "--get", &remote_key])
        .current_dir(path)
        .output()
        .await;
    let remote = remote_output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "origin".to_string());

    let remote_arg = format!("--remotes={}", remote);
    let output = crate::process::tokio_command("git")
        .args(["rev-list", "--count", &rev, "--not", &remote_arg])
        .current_dir(path)
        .output()
        .await;
    let Ok(output) = output else {
        return 0;
    };
    if !output.status.success() {
        return 0;
    }

    parse_count_from_output(&output.stdout).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Shared core functions (used by both Tauri commands and web handlers)
// ---------------------------------------------------------------------------

pub async fn get_folder_core(db: &AppDatabase, folder_id: i32) -> Result<FolderDetail, DbError> {
    folder_service::get_folder_by_id(&db.conn, folder_id)
        .await?
        .ok_or_else(|| DbError::Migration(format!("Folder {} not found", folder_id)))
}

/// Emit a `folder://changed` Upsert so every client inserts-or-replaces the
/// folder in its workspace list in real time. Used by headless producers — the
/// automation engine minting a per-run worktree — whose folders no client would
/// otherwise learn about until the next full `fetchFolders` (leaving any
/// conversation produced inside them unplaceable in the sidebar). Best-effort:
/// the folder is already persisted, so a dropped event reconciles on the next
/// refresh / WS reconnect.
///
/// Unlike [`open_folder_in_workspace_core`], this ONLY syncs the folder list — it
/// never opens or focuses a tab — so a background emitter can't steal focus.
pub(crate) fn emit_folder_upsert(emitter: &EventEmitter, detail: FolderDetail) {
    crate::web::event_bridge::emit_event(
        emitter,
        crate::web::event_bridge::FOLDER_CHANGED_EVENT,
        crate::web::event_bridge::FolderChange::Upsert {
            folder: Box::new(detail),
        },
    );
}

/// Emit a `folder://changed` Deleted so every client drops the folder from its
/// workspace list in real time. The counterpart of [`emit_folder_upsert`], for
/// rows that are soft-deleted for good — a work task's worktree folder once the
/// worktree is gone from disk. Without it the removed worktree keeps rendering
/// in every sidebar until the next full `fetchFolders` (i.e. a reload).
///
/// Only for permanent removal: closing a folder
/// ([`remove_folder_from_workspace_core`]) leaves the row alive and must not
/// broadcast this.
pub(crate) fn emit_folder_deleted(emitter: &EventEmitter, folder_id: i32) {
    crate::web::event_bridge::emit_event(
        emitter,
        crate::web::event_bridge::FOLDER_CHANGED_EVENT,
        crate::web::event_bridge::FolderChange::Deleted { id: folder_id },
    );
}

pub async fn load_folder_history_core(
    db: &AppDatabase,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    folder_service::list_folders(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn add_folder_to_history_core(
    db: &AppDatabase,
    path: String,
) -> Result<FolderHistoryEntry, DbError> {
    folder_service::add_folder(&db.conn, &path).await
}

pub async fn remove_folder_from_history_core(
    db: &AppDatabase,
    path: String,
) -> Result<(), AppCommandError> {
    folder_service::remove_folder(&db.conn, &path)
        .await
        .map_err(AppCommandError::from)
}

pub async fn list_open_folders_core(
    db: &AppDatabase,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    folder_service::list_open_folders(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn list_open_folder_details_core(
    db: &AppDatabase,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    folder_service::list_open_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn list_all_folder_details_core(
    db: &AppDatabase,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    folder_service::list_all_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn open_folder_core(
    db: &AppDatabase,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let entry = folder_service::add_folder(&db.conn, &path)
        .await
        .map_err(AppCommandError::from)?;
    folder_service::get_folder_by_id(&db.conn, entry.id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found after add"))
}

/// Open a freshly created git worktree directory as a folder, recording the
/// *root* folder it descends from. Parents are flattened: a worktree created
/// from another worktree still records the original root, so every worktree of a
/// repo groups under that one repo folder. An unknown / non-positive
/// `source_folder_id` degrades to a top-level folder (`parent_id = None`) rather
/// than erroring.
///
/// Also defaults the folder's display alias to the checked-out branch (see
/// [`seed_worktree_alias`]) — a worktree's directory name (`codeg-task-49`,
/// `codeg-automation-3-run-8`) says far less about it than the branch does, and
/// this is the one place every worktree registration passes through: the branch
/// dropdown's "new worktree", switch-to-branch landing on an unregistered
/// checkout, the automation engine's per-run worktree, and the work-task
/// engine's per-task worktree (fresh mint and re-create-from-branch alike).
pub async fn open_worktree_folder_core(
    db: &AppDatabase,
    path: String,
    source_folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    let parent_id = if source_folder_id > 0 {
        folder_service::get_folder_by_id(&db.conn, source_folder_id)
            .await
            .map_err(AppCommandError::from)?
            .map(|src| src.parent_id.unwrap_or(src.id))
    } else {
        None
    };
    let entry = folder_service::add_folder_with_parent(&db.conn, &path, parent_id)
        .await
        .map_err(AppCommandError::from)?;
    seed_worktree_alias(db, entry.id, &path).await;
    folder_service::get_folder_by_id(&db.conn, entry.id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found after add"))
}

/// Default a worktree folder's alias to the branch checked out at `path`.
///
/// Best-effort in both directions, and deliberately silent:
/// - The branch is read from the directory itself rather than threaded from the
///   caller, so registrations that never knew a branch name (a pre-existing
///   checkout the branch switcher just adopted) get labeled too, and the label
///   can never disagree with what is actually checked out there.
/// - A detached HEAD, a path that is gone, or git missing entirely all resolve to
///   "no branch" and leave the folder unlabeled — the sidebar then falls back to
///   the directory name exactly as before.
/// - The write only lands when no alias is set yet (see
///   [`folder_service::seed_folder_alias`]), so re-registering a worktree — a
///   task retry, a re-created checkout — never overwrites a name the user chose.
async fn seed_worktree_alias(db: &AppDatabase, folder_id: i32, path: &str) {
    let Some(branch) = resolve_git_head(path).await.ok().and_then(|h| h.branch) else {
        return;
    };
    if let Err(e) = folder_service::seed_folder_alias(&db.conn, folder_id, &branch).await {
        tracing::warn!("[folders] could not seed folder {folder_id}'s alias from git: {e}");
    }
}

/// Label every already-registered worktree folder that has no alias with the
/// branch it currently has checked out — the one-shot startup counterpart of the
/// seeding [`open_worktree_folder_core`] now does at registration time.
///
/// Without it the feature would only ever reach worktrees created from here on,
/// leaving every worktree already in the sidebar showing its directory name.
/// Each row is seeded through the same never-clobber path, so a worktree the
/// user has already named is skipped, and one whose directory is gone (or is
/// detached) simply stays unlabeled and is retried next launch — a handful of
/// fast git failures, not a growing cost, since a successful seed removes the
/// row from the work list for good.
///
/// Folders that are in the workspace when they get labeled are broadcast, so a
/// client that fetched its folder list before this finished still updates in
/// place. A closed folder is labeled just the same but deliberately NOT
/// broadcast: `folder://changed` Upsert means "insert-or-replace in the open
/// folder list", so announcing one would put a folder the user closed back in
/// their sidebar. Whether it is open is read fresh at that moment rather than
/// taken from the work list — walking every folder takes long enough (a git call
/// each) for the user to close one in the middle — and reopening it later
/// re-reads the row anyway, so the label still lands. Returns how many were
/// labeled.
pub async fn backfill_worktree_folder_aliases(emitter: &EventEmitter, db: &AppDatabase) -> usize {
    let pending = match folder_service::list_worktree_folders_missing_alias(&db.conn).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[folders] worktree alias backfill could not list folders: {e}");
            return 0;
        }
    };

    let mut labeled = 0;
    for (folder_id, path) in pending {
        let Some(branch) = resolve_git_head(&path).await.ok().and_then(|h| h.branch) else {
            continue;
        };
        match folder_service::seed_folder_alias(&db.conn, folder_id, &branch).await {
            Ok(true) => {
                labeled += 1;
                if let Ok(Some(detail)) =
                    folder_service::get_open_folder_by_id(&db.conn, folder_id).await
                {
                    emit_folder_upsert(emitter, detail);
                }
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!("[folders] worktree alias backfill failed for {folder_id}: {e}");
            }
        }
    }
    labeled
}

/// Open a folder into the workspace and announce it so the workspace window
/// can surface it. Used by the project launcher, which lives in its own
/// window/tab and can't reach the workspace's React state directly. Emitting
/// through the shared `EventEmitter` routes the signal correctly in every
/// runtime — Tauri events (desktop), the WebSocket broadcaster (server), and
/// the remote server's broadcaster (remote desktop) — so only windows talking
/// to this same backend react.
pub async fn open_folder_in_workspace_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let detail = open_folder_core(db, path).await?;
    crate::web::event_bridge::emit_event(emitter, "folder://open-in-workspace", &detail);
    Ok(detail)
}

pub async fn open_folder_by_id_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    folder_service::set_folder_open(&db.conn, folder_id, true)
        .await
        .map_err(AppCommandError::from)?;
    folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("Folder {folder_id} not found")))
}

pub async fn remove_folder_from_workspace_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
) -> Result<(), AppCommandError> {
    use crate::db::service::tab_service;

    // Capture the folder path before flipping it closed, so we can stop any
    // office watch preview servers rooted under it — belt-and-suspenders over
    // the frontend's per-tab unmount teardown.
    let folder_path = folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .ok()
        .flatten()
        .map(|f| f.path);

    folder_service::set_folder_open(&db.conn, folder_id, false)
        .await
        .map_err(AppCommandError::from)?;

    // Atomically drop this folder's open tabs + bump the version (always, as a
    // barrier so a concurrent stale save can't resurrect them) + snapshot, in one
    // transaction. Broadcast the new set only when a persisted tab actually
    // changed (sentinel origin "server" so every client applies it); a zero-row
    // removal just advances the barrier — an in-flight saver reconciles via its
    // rejected CAS.
    let inv = tab_service::delete_folder_tabs_and_bump(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?;
    if let Some(tabs) = inv.emit {
        crate::web::event_bridge::emit_event(
            emitter,
            crate::web::event_bridge::TABS_CHANGED_EVENT,
            crate::web::event_bridge::TabsChanged {
                version: inv.version,
                origin: "server".to_string(),
                tabs,
            },
        );
    }

    if let Some(path) = folder_path {
        crate::office_watch::stop_office_watches_under_root(&path);
    }
    Ok(())
}

/// Broadcast a folder-group change so every window / WebSocket client converges.
fn emit_folder_group_change(
    emitter: &EventEmitter,
    change: crate::web::event_bridge::FolderGroupChange,
) {
    crate::web::event_bridge::emit_event(
        emitter,
        crate::web::event_bridge::FOLDER_GROUP_CHANGED_EVENT,
        change,
    );
}

pub async fn list_folder_groups_core(
    db: &AppDatabase,
) -> Result<Vec<FolderGroupDetail>, AppCommandError> {
    folder_group_service::list_folder_groups(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

/// Trim and length-cap a group name. An all-whitespace name would render as an
/// invisible band the user can't grab or tell apart, so it is rejected here
/// rather than stored.
fn normalize_group_name(name: &str) -> Result<String, AppCommandError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("Group name cannot be empty"));
    }
    Ok(trimmed.chars().take(MAX_FOLDER_GROUP_NAME_CHARS).collect())
}

/// Longest group name kept. The sidebar truncates far sooner; this only stops a
/// pasted novel from becoming a permanent row.
const MAX_FOLDER_GROUP_NAME_CHARS: usize = 120;

pub async fn create_folder_group_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    name: String,
    color: Option<String>,
) -> Result<FolderGroupDetail, AppCommandError> {
    let name = normalize_group_name(&name)?;
    let group = folder_group_service::create_folder_group(&db.conn, name, color)
        .await
        .map_err(AppCommandError::from)?;
    emit_folder_group_change(
        emitter,
        crate::web::event_bridge::FolderGroupChange::Upsert {
            group: group.clone(),
        },
    );
    Ok(group)
}

pub async fn update_folder_group_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    group_id: i32,
    name: Option<String>,
    color: Option<String>,
) -> Result<FolderGroupDetail, AppCommandError> {
    let name = name.map(|n| normalize_group_name(&n)).transpose()?;
    let group = folder_group_service::update_folder_group(&db.conn, group_id, name, color)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder group not found"))?;
    emit_folder_group_change(
        emitter,
        crate::web::event_bridge::FolderGroupChange::Upsert {
            group: group.clone(),
        },
    );
    Ok(group)
}

pub async fn delete_folder_group_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    group_id: i32,
) -> Result<(), AppCommandError> {
    let removed = folder_group_service::delete_folder_group(&db.conn, group_id)
        .await
        .map_err(AppCommandError::from)?;
    if !removed {
        return Err(AppCommandError::not_found("Folder group not found"));
    }
    emit_folder_group_change(emitter, crate::web::event_bridge::FolderGroupChange::Deleted { id: group_id });
    // Members moved back to the top level, so their rows changed too.
    emit_folder_group_change(emitter, crate::web::event_bridge::FolderGroupChange::Layout);
    Ok(())
}

/// Persist the sidebar's folder/group layout after a drag. See
/// [`folder_group_service::apply_sidebar_layout`] for the wire contract.
pub async fn apply_sidebar_layout_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    entries: Vec<SidebarLayoutEntry>,
) -> Result<(), AppCommandError> {
    folder_group_service::apply_sidebar_layout(&db.conn, entries)
        .await
        .map_err(AppCommandError::from)?;
    emit_folder_group_change(emitter, crate::web::event_bridge::FolderGroupChange::Layout);
    Ok(())
}

/// Move one folder into (or out of) a group — the context-menu path, which has
/// no drop position to derive an index from, so the folder is appended.
pub async fn set_folder_group_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
    group_id: Option<i32>,
) -> Result<(), AppCommandError> {
    folder_group_service::set_folder_group(&db.conn, folder_id, group_id)
        .await
        .map_err(AppCommandError::from)?;
    emit_folder_group_change(emitter, crate::web::event_bridge::FolderGroupChange::Layout);
    Ok(())
}

pub async fn update_folder_color_core(
    db: &AppDatabase,
    folder_id: i32,
    color: String,
) -> Result<FolderDetail, AppCommandError> {
    folder_service::update_folder_color(&db.conn, folder_id, &color)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found"))
}

pub async fn update_folder_alias_core(
    db: &AppDatabase,
    folder_id: i32,
    alias: Option<String>,
) -> Result<FolderDetail, AppCommandError> {
    // Empty / whitespace-only input clears the alias (stored as NULL).
    let normalized = alias
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    folder_service::update_folder_alias(&db.conn, folder_id, normalized)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found"))
}

/// The folder's default agent is the last layer a work task inherits from, and
/// the task views resolve it live rather than freezing it on the row — so a
/// change here changes what every inheriting task reports, and the boards have
/// to be told. Nothing else emits for this column, so without the nudge they
/// would keep drawing the previous agent's mark until an unrelated task event
/// happened by. `Settings` is the same signal the folder's task settings send
/// for the layer directly above this one.
pub async fn update_folder_default_agent_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
    default_agent_type: Option<crate::models::agent::AgentType>,
) -> Result<FolderDetail, AppCommandError> {
    let detail =
        folder_service::update_folder_default_agent(&db.conn, folder_id, default_agent_type)
            .await
            .map_err(AppCommandError::from)?
            .ok_or_else(|| AppCommandError::not_found("Folder not found"))?;
    crate::web::event_bridge::emit_event(
        emitter,
        crate::web::event_bridge::WORK_TASK_CHANGED_EVENT,
        crate::web::event_bridge::WorkTaskChange::Settings { folder_id },
    );
    Ok(detail)
}

// ---------------------------------------------------------------------------
// Tauri command wrappers (thin shims over _core)
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_folder(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<FolderDetail, DbError> {
    get_folder_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn load_folder_history(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    load_folder_history_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn add_folder_to_history(
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderHistoryEntry, DbError> {
    add_folder_to_history_core(&db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remove_folder_from_history(
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<(), AppCommandError> {
    remove_folder_from_history_core(&db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_open_folder_details(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    list_open_folder_details_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_all_folder_details(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderDetail>, AppCommandError> {
    list_all_folder_details_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder(
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    open_folder_core(&db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_worktree_folder(
    db: tauri::State<'_, AppDatabase>,
    path: String,
    source_folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    open_worktree_folder_core(&db, path, source_folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder_in_workspace(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<FolderDetail, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    open_folder_in_workspace_core(&emitter, &db, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_folder_by_id(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<FolderDetail, AppCommandError> {
    open_folder_by_id_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn remove_folder_from_workspace(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<(), AppCommandError> {
    remove_folder_from_workspace_core(&EventEmitter::Tauri(app), &db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_folder_groups(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderGroupDetail>, AppCommandError> {
    list_folder_groups_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_folder_group(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    name: String,
    color: Option<String>,
) -> Result<FolderGroupDetail, AppCommandError> {
    create_folder_group_core(&EventEmitter::Tauri(app), &db, name, color).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_group(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    group_id: i32,
    name: Option<String>,
    color: Option<String>,
) -> Result<FolderGroupDetail, AppCommandError> {
    update_folder_group_core(&EventEmitter::Tauri(app), &db, group_id, name, color).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_folder_group(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    group_id: i32,
) -> Result<(), AppCommandError> {
    delete_folder_group_core(&EventEmitter::Tauri(app), &db, group_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn apply_sidebar_layout(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    entries: Vec<SidebarLayoutEntry>,
) -> Result<(), AppCommandError> {
    apply_sidebar_layout_core(&EventEmitter::Tauri(app), &db, entries).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_folder_group(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    group_id: Option<i32>,
) -> Result<(), AppCommandError> {
    set_folder_group_core(&EventEmitter::Tauri(app), &db, folder_id, group_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_color(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    color: String,
) -> Result<FolderDetail, AppCommandError> {
    update_folder_color_core(&db, folder_id, color).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_alias(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    alias: Option<String>,
) -> Result<FolderDetail, AppCommandError> {
    update_folder_alias_core(&db, folder_id, alias).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_folder_default_agent(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    default_agent_type: Option<crate::models::agent::AgentType>,
) -> Result<FolderDetail, AppCommandError> {
    update_folder_default_agent_core(
        &EventEmitter::Tauri(app),
        &db,
        folder_id,
        default_agent_type,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_folder_directory(path: String) -> Result<(), AppCommandError> {
    std::fs::create_dir_all(&path).map_err(AppCommandError::io)
}

pub(crate) async fn clone_repository_core(
    url: &str,
    target_dir: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<(), AppCommandError> {
    if url.trim().is_empty() || target_dir.trim().is_empty() {
        return Err(AppCommandError::invalid_input(
            "Repository URL and target directory are required",
        ));
    }

    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["clone", url, target_dir]);
    prepare_remote_git_cmd_for_url(&mut cmd, url, credentials, db, data_dir).await;

    let output = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppCommandError::dependency_missing("Git is not installed. Please install Git first.")
                .with_detail("https://git-scm.com")
        } else {
            AppCommandError::external_command("Failed to run git clone", e.to_string())
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(classify_git_clone_error(stderr.trim()));
    }
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn clone_repository(
    url: String,
    target_dir: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    clone_repository_core(&url, &target_dir, credentials.as_ref(), &db, &data_dir).await
}

fn classify_git_clone_error(stderr: &str) -> AppCommandError {
    let normalized = stderr.to_lowercase();

    if normalized.contains("already exists and is not an empty directory") {
        return AppCommandError::already_exists("Target directory already exists and is not empty")
            .with_detail(stderr.to_string());
    }

    if normalized.contains("repository not found") {
        return AppCommandError::not_found(
            "Repository not found. Check URL and access permissions.",
        )
        .with_detail(stderr.to_string());
    }

    if normalized.contains("could not resolve host")
        || normalized.contains("network is unreachable")
        || normalized.contains("connection timed out")
        || normalized.contains("failed to connect")
    {
        return AppCommandError::network("Network is unavailable while cloning repository")
            .with_detail(stderr.to_string());
    }

    if normalized.contains("authentication failed")
        || normalized.contains("could not read username")
        || normalized.contains("could not read password")
        || normalized.contains("logon failed")
        || normalized.contains("terminal prompts disabled")
        || normalized.contains("the requested url returned error: 401")
        || normalized.contains("the requested url returned error: 403")
        || normalized.contains("http basic: access denied")
        || normalized.contains("permission denied (publickey)")
    {
        return AppCommandError::authentication_failed(
            "Authentication failed while cloning repository",
        )
        .with_detail(stderr.to_string());
    }

    if normalized.contains("permission denied") {
        return AppCommandError::permission_denied("Permission denied while cloning repository")
            .with_detail(stderr.to_string());
    }

    AppCommandError::external_command("Git clone failed", stderr.to_string())
}

/// The state of a working tree's `HEAD`. The legacy `get_git_branch` contract
/// collapsed every non-branch state into `None`, so a detached HEAD looked
/// identical to a non-git folder and the UI hid all git operations (issue
/// #279). This distinguishes the four states the UI actually needs.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitHeadInfo {
    /// Whether git recognizes this path as a work tree.
    pub is_repo: bool,
    /// Branch name when `HEAD` points at a branch — including an unborn branch
    /// right after `git init`. `None` when detached or not a repo.
    pub branch: Option<String>,
    /// Whether `HEAD` is detached (points directly at a commit, not a branch).
    pub detached: bool,
    /// Short commit hash; present when detached and at least one commit exists.
    pub short_sha: Option<String>,
}

async fn git_output(
    path: &str,
    args: &[&str],
) -> Result<std::process::Output, AppCommandError> {
    crate::process::tokio_command("git")
        .args(args)
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)
}

/// Resolve the current `HEAD` state. The common cases (on a branch / detached)
/// cost a single git invocation; the rarer unborn-branch and non-repository
/// cases fall through to `symbolic-ref` and `--is-inside-work-tree`.
pub(crate) async fn resolve_git_head(path: &str) -> Result<GitHeadInfo, AppCommandError> {
    // `rev-parse --abbrev-ref HEAD` prints the branch name, the literal "HEAD"
    // when detached, and fails on an unborn branch or a non-repository.
    let head = git_output(path, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if head.status.success() {
        let name = String::from_utf8_lossy(&head.stdout).trim().to_string();
        if !name.is_empty() && name != "HEAD" {
            return Ok(GitHeadInfo {
                is_repo: true,
                branch: Some(name),
                detached: false,
                short_sha: None,
            });
        }
        // Detached HEAD — surface the short commit so the UI can label it.
        let short_sha = git_output(path, &["rev-parse", "--short", "HEAD"])
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        return Ok(GitHeadInfo {
            is_repo: true,
            branch: None,
            detached: true,
            short_sha,
        });
    }

    // Unborn branch (after `git init`, before the first commit): `symbolic-ref`
    // still resolves the branch name where `rev-parse` cannot.
    let sym = git_output(path, &["symbolic-ref", "--short", "HEAD"]).await?;
    if sym.status.success() {
        let name = String::from_utf8_lossy(&sym.stdout).trim().to_string();
        if !name.is_empty() {
            return Ok(GitHeadInfo {
                is_repo: true,
                branch: Some(name),
                detached: false,
                short_sha: None,
            });
        }
    }

    // Neither resolved a branch — authoritatively decide repo-ness. An unusual
    // work tree with no resolvable branch still counts as a repo so the UI
    // offers git operations rather than "initialize".
    let inside = git_output(path, &["rev-parse", "--is-inside-work-tree"]).await?;
    let is_repo =
        inside.status.success() && String::from_utf8_lossy(&inside.stdout).trim() == "true";
    Ok(GitHeadInfo {
        is_repo,
        branch: None,
        detached: false,
        short_sha: None,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_git_head(path: String) -> Result<GitHeadInfo, AppCommandError> {
    resolve_git_head(&path).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_git_branch(path: String) -> Result<Option<String>, AppCommandError> {
    Ok(resolve_git_head(&path).await?.branch)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_init(path: String) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["init"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("init", &output.stderr));
    }
    Ok(())
}

pub(crate) async fn git_pull_core(
    path: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<GitPullResult, AppCommandError> {
    let head_before = get_head_hash(path).await?;

    // Step 1: fetch from remote
    let mut fetch_cmd = crate::process::tokio_command("git");
    fetch_cmd.args(["fetch"]).current_dir(path);
    prepare_remote_git_cmd(&mut fetch_cmd, path, credentials, db, data_dir).await;

    let fetch_output = fetch_cmd.output().await.map_err(AppCommandError::io)?;

    if !fetch_output.status.success() {
        return Err(classify_remote_git_error("fetch", &fetch_output.stderr));
    }

    // Step 2: check if upstream exists
    let upstream_check = crate::process::tokio_command("git")
        .args(["rev-parse", "@{u}"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !upstream_check.status.success() {
        return Ok(GitPullResult {
            updated_files: 0,
            conflict: None,
        });
    }
    let upstream_commit = String::from_utf8_lossy(&upstream_check.stdout)
        .trim()
        .to_string();

    // Step 3: check if we can fast-forward
    let merge_base = crate::process::tokio_command("git")
        .args(["merge-base", "HEAD", "@{u}"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    let head_hash = crate::process::tokio_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let base_hash = String::from_utf8_lossy(&merge_base.stdout)
        .trim()
        .to_string();
    let current_head = String::from_utf8_lossy(&head_hash.stdout)
        .trim()
        .to_string();

    if base_hash == current_head {
        let ff_output = crate::process::tokio_command("git")
            .args(["merge", "--ff-only", "@{u}"])
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !ff_output.status.success() {
            return Err(git_command_error("merge --ff-only", &ff_output.stderr));
        }
    } else {
        let merge_output = crate::process::tokio_command("git")
            .args(["merge", "--no-commit", "@{u}"])
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !merge_output.status.success() {
            let conflicted_files = detect_conflicts(path).await?;
            if !conflicted_files.is_empty() {
                let _ = crate::process::tokio_command("git")
                    .args(["merge", "--abort"])
                    .current_dir(path)
                    .output()
                    .await;

                return Ok(GitPullResult {
                    updated_files: 0,
                    conflict: Some(GitConflictInfo {
                        has_conflicts: true,
                        conflicted_files,
                        operation: "pull".to_string(),
                        upstream_commit: Some(upstream_commit),
                    }),
                });
            }
            return Err(git_command_error("merge", &merge_output.stderr));
        }

        let commit_output = crate::process::tokio_command("git")
            .args(["commit", "--no-edit"])
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !commit_output.status.success() {
            let stderr = String::from_utf8_lossy(&commit_output.stderr);
            let stdout = String::from_utf8_lossy(&commit_output.stdout);
            if !stderr.contains("nothing to commit") && !stdout.contains("nothing to commit") {
                return Err(git_command_error("commit", &commit_output.stderr));
            }
        }
    }

    let head_after = get_head_hash(path).await?;
    let updated_files = match (head_before.as_deref(), head_after.as_deref()) {
        (Some(before), Some(after)) if before != after => {
            count_changed_files_between(path, before, after).await?
        }
        (None, Some(after)) => count_files_in_commit(path, after).await?,
        _ => 0,
    };

    Ok(GitPullResult {
        updated_files,
        conflict: None,
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_pull(
    path: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<GitPullResult, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_pull_core(&path, credentials.as_ref(), &db, &data_dir).await
}

/// Start a merge with the upstream branch (used by merge workspace after pull conflict detection).
/// This recreates the conflict state so that :1:, :2:, :3: stage entries are available.
/// If `upstream_commit` is provided, merge against that specific commit instead of `@{u}`.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_start_pull_merge(
    path: String,
    upstream_commit: Option<String>,
) -> Result<(), AppCommandError> {
    let target = upstream_commit.as_deref().unwrap_or("@{u}");
    let output = crate::process::tokio_command("git")
        .args(["merge", "--no-commit", target])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    // It's expected to fail with conflicts — that's the point.
    // We just need the merge state to be active so stage entries exist.
    if !output.status.success() {
        let conflicted_files = detect_conflicts(&path).await?;
        if !conflicted_files.is_empty() {
            return Ok(()); // Conflict state is now active — merge workspace can proceed
        }
        return Err(git_command_error("merge", &output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_has_merge_head(path: String) -> Result<bool, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["rev-parse", "--verify", "MERGE_HEAD"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    Ok(output.status.success())
}

pub(crate) async fn git_fetch_core(
    path: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<String, AppCommandError> {
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["fetch", "--all"]).current_dir(path);
    prepare_remote_git_cmd(&mut cmd, path, credentials, db, data_dir).await;

    let output = cmd.output().await.map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(classify_remote_git_error("fetch --all", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_fetch(
    path: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_fetch_core(&path, credentials.as_ref(), &db, &data_dir).await
}

/// Read a single git config value, or `None` when unset/empty.
async fn git_config_value(path: &str, key: &str) -> Option<String> {
    let output = crate::process::tokio_command("git")
        .args(["config", "--get", key])
        .current_dir(path)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Resolve a ref to its commit hash, or `None` when the ref doesn't exist.
async fn rev_parse_ref(path: &str, reference: &str) -> Option<String> {
    let output = crate::process::tokio_command("git")
        .args(["rev-parse", "--verify", "--quiet", reference])
        .current_dir(path)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if hash.is_empty() {
        None
    } else {
        Some(hash)
    }
}

/// How many files a ref moved across, mirroring `git_pull_core`'s accounting.
async fn count_ref_advance(
    path: &str,
    before: Option<&str>,
    after: Option<&str>,
) -> Result<usize, AppCommandError> {
    match (before, after) {
        (Some(before), Some(after)) if before != after => {
            count_changed_files_between(path, before, after).await
        }
        (None, Some(after)) => count_files_in_commit(path, after).await,
        _ => Ok(0),
    }
}

/// Update a branch **without checking it out** — the "update code" action on a
/// branch row in the branch selector.
///
/// - The checked-out branch delegates to [`git_pull_core`], so it behaves
///   exactly like the dropdown's "pull" operation (merge + conflict reporting).
/// - Any other local branch resolves its upstream from `branch.<b>.remote` /
///   `branch.<b>.merge` and fast-forwards the local ref with
///   `git fetch <remote> <upstream>:refs/heads/<branch>`. The working tree is
///   never touched. We deliberately omit the `+` force prefix, so git itself
///   rejects a non-fast-forward — and it also rejects a branch that is checked
///   out in another worktree. Both surface as a plain command error rather than
///   silently rewriting history under a worktree the user has open.
/// - A remote branch row (`origin/foo`) fetches that remote ref only, advancing
///   the remote-tracking ref without creating or moving any local branch.
pub(crate) async fn git_update_branch_core(
    path: &str,
    branch: &str,
    is_remote: bool,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<GitPullResult, AppCommandError> {
    ensure_git_repo(path)?;

    if is_remote {
        // "origin/feature/x" → remote "origin", branch "feature/x".
        let (remote, remote_branch) = branch
            .split_once('/')
            .filter(|(remote, rest)| !remote.is_empty() && !rest.is_empty())
            .ok_or_else(|| {
                AppCommandError::invalid_input(format!("Malformed remote branch ref: {branch}"))
            })?;

        let tracking_ref = format!("refs/remotes/{branch}");
        let before = rev_parse_ref(path, &tracking_ref).await;

        // Spell the refspec out rather than relying on `git fetch <remote>
        // <branch>` opportunistically updating the tracking ref. `+` is correct
        // here: a remote-tracking ref is a mirror of the remote and is meant to
        // follow a force-push, exactly like the default fetch refspec does.
        let refspec = format!("+refs/heads/{remote_branch}:{tracking_ref}");
        let mut cmd = crate::process::tokio_command("git");
        cmd.args(["fetch", remote, &refspec]).current_dir(path);
        prepare_remote_git_cmd_with_remote(&mut cmd, path, Some(remote), credentials, db, data_dir)
            .await;

        let output = cmd.output().await.map_err(AppCommandError::io)?;
        if !output.status.success() {
            return Err(classify_remote_git_error("fetch", &output.stderr));
        }

        let after = rev_parse_ref(path, &tracking_ref).await;
        return Ok(GitPullResult {
            updated_files: count_ref_advance(path, before.as_deref(), after.as_deref()).await?,
            conflict: None,
        });
    }

    // The checked-out branch has a working tree to reconcile — only a real pull
    // can do that safely.
    if resolve_git_head(path).await?.branch.as_deref() == Some(branch) {
        return git_pull_core(path, credentials, db, data_dir).await;
    }

    let Some(remote) = git_config_value(path, &format!("branch.{branch}.remote")).await else {
        return Err(AppCommandError::invalid_input(format!(
            "Branch '{branch}' has no upstream remote configured"
        )));
    };
    // `branch.<b>.merge` is the upstream's FULL ref (`refs/heads/x`). Both sides
    // of the refspec stay fully qualified so git can't reinterpret the
    // destination as a remote-tracking ref.
    let Some(upstream_ref) = git_config_value(path, &format!("branch.{branch}.merge")).await else {
        return Err(AppCommandError::invalid_input(format!(
            "Branch '{branch}' has no upstream branch configured"
        )));
    };

    let local_ref = format!("refs/heads/{branch}");
    let before = rev_parse_ref(path, &local_ref).await;

    let mut refspecs = vec![format!("{upstream_ref}:{local_ref}")];
    // Keep the remote-tracking ref in step with the branch we just advanced, so
    // "ahead/behind" readouts don't claim the branch is unpushed. Skipped for
    // the `.` pseudo-remote (a branch tracking another LOCAL branch), which has
    // no `refs/remotes/.` namespace.
    if remote != "." {
        if let Some(upstream_branch) = upstream_ref.strip_prefix("refs/heads/") {
            refspecs.push(format!(
                "+{upstream_ref}:refs/remotes/{remote}/{upstream_branch}"
            ));
        }
    }

    let mut cmd = crate::process::tokio_command("git");
    cmd.arg("fetch")
        .arg(&remote)
        .args(&refspecs)
        .current_dir(path);
    prepare_remote_git_cmd_with_remote(&mut cmd, path, Some(&remote), credentials, db, data_dir)
        .await;

    let output = cmd.output().await.map_err(AppCommandError::io)?;
    if !output.status.success() {
        return Err(classify_remote_git_error("fetch", &output.stderr));
    }

    let after = rev_parse_ref(path, &local_ref).await;
    Ok(GitPullResult {
        updated_files: count_ref_advance(path, before.as_deref(), after.as_deref()).await?,
        conflict: None,
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_update_branch(
    path: String,
    branch: String,
    is_remote: bool,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<GitPullResult, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_update_branch_core(
        &path,
        &branch,
        is_remote,
        credentials.as_ref(),
        &db,
        &data_dir,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_push_info(
    path: String,
    branch: Option<String>,
) -> Result<GitPushInfo, AppCommandError> {
    ensure_git_repo(&path)?;

    // The branch this push targets: an explicit one (the push window opened for
    // a specific branch from the branch selector) or, as before, the checked-out
    // one.
    let branch = match branch.filter(|value| !value.trim().is_empty()) {
        Some(explicit) => {
            let explicit = explicit.trim().to_string();
            ensure_pushable_branch_name(&explicit)?;
            explicit
        }
        None => {
            let branch_output = crate::process::tokio_command("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(&path)
                .output()
                .await
                .map_err(AppCommandError::io)?;
            String::from_utf8_lossy(&branch_output.stdout)
                .trim()
                .to_string()
        }
    };

    // Get tracking remote for the target branch
    let remote_key = format!("branch.{}.remote", branch);
    let remote_output = crate::process::tokio_command("git")
        .args(["config", "--get", &remote_key])
        .current_dir(&path)
        .output()
        .await;
    let tracking_remote = remote_output
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|v| !v.is_empty());

    // Get all remotes
    let remotes = git_list_remotes(path).await?;

    Ok(GitPushInfo {
        branch,
        remotes,
        tracking_remote,
    })
}

/// Push a branch to a remote, setting upstream when it doesn't already track the
/// target remote.
///
/// `branch` names the ref to push; `None` keeps the historical behaviour of
/// pushing whatever is checked out. An explicit branch does NOT have to be
/// checked out — `git push <remote> <branch>` publishes it either way, which is
/// what the branch selector's per-branch push relies on.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_push_core(
    data_dir: &std::path::Path,
    emitter: &EventEmitter,
    folder_id: Option<i32>,
    path: &str,
    remote: Option<&str>,
    branch: Option<&str>,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
) -> Result<GitPushResult, AppCommandError> {
    let branch = branch.map(str::trim).filter(|value| !value.is_empty());
    // Validate BEFORE anything runs: `branch` is interpolated into the rev
    // arguments below as well as into the push refspec.
    if let Some(branch) = branch {
        ensure_pushable_branch_name(branch)?;
        ensure_local_branch_exists(path, branch).await?;
    }
    let pushed_commits = estimate_push_commit_count(path, branch).await;

    let target_remote = remote.filter(|s| !s.is_empty()).unwrap_or("origin");

    // The PUSH REFSPEC is fully qualified for an explicit branch: a short name
    // goes through git's revision resolution, where `@` means HEAD and a
    // same-named tag makes the name ambiguous, so `refs/heads/x:refs/heads/x` is
    // the only form that reliably publishes the branch
    // `ensure_local_branch_exists` just verified.
    //
    // The `@{u}` probe must NOT be qualified the same way — git resolves that
    // suffix through `branch.<name>.*` config and rejects `refs/heads/x@{u}`
    // ("fatal: no such branch"), which would make every explicit-branch push
    // look upstream-less and re-run `--set-upstream` each time. Short name there,
    // full ref for the refspec. (Residual: a branch literally named `@` reads
    // HEAD's upstream here, which can only cost an unnecessary `-u` — the push
    // itself still goes to the qualified ref.)
    //
    // The no-branch path keeps its original short-name / `@{u}` form verbatim.
    let (push_ref, upstream_ref) = match branch {
        Some(explicit) => (
            format!("refs/heads/{explicit}:refs/heads/{explicit}"),
            format!("{explicit}@{{u}}"),
        ),
        None => {
            let branch_output = crate::process::tokio_command("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(path)
                .output()
                .await
                .map_err(AppCommandError::io)?;
            let head = String::from_utf8_lossy(&branch_output.stdout)
                .trim()
                .to_string();
            (head, "@{u}".to_string())
        }
    };

    let upstream_check = crate::process::tokio_command("git")
        .args([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            &upstream_ref,
        ])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let current_upstream = if upstream_check.status.success() {
        Some(
            String::from_utf8_lossy(&upstream_check.stdout)
                .trim()
                .to_string(),
        )
    } else {
        None
    };

    let needs_set_upstream = match &current_upstream {
        None => true,
        Some(upstream) => !upstream.starts_with(&format!("{}/", target_remote)),
    };

    let output = if needs_set_upstream {
        let mut cmd = crate::process::tokio_command("git");
        cmd.args(["push", "--set-upstream", target_remote, &push_ref])
            .current_dir(path);
        prepare_remote_git_cmd_with_remote(
            &mut cmd,
            path,
            Some(target_remote),
            credentials,
            db,
            data_dir,
        )
        .await;
        cmd.output().await.map_err(AppCommandError::io)?
    } else {
        let mut cmd = crate::process::tokio_command("git");
        cmd.args(["push", target_remote, &push_ref])
            .current_dir(path);
        prepare_remote_git_cmd_with_remote(
            &mut cmd,
            path,
            Some(target_remote),
            credentials,
            db,
            data_dir,
        )
        .await;
        cmd.output().await.map_err(AppCommandError::io)?
    };

    if !output.status.success() {
        return Err(classify_remote_git_error("push", &output.stderr));
    }

    let upstream_set = needs_set_upstream;

    if let Some(folder_id) = folder_id {
        crate::web::event_bridge::emit_event(
            emitter,
            "folder://git-push-succeeded",
            GitPushSucceededEvent {
                folder_id,
                pushed_commits,
                upstream_set,
            },
        );
    }

    Ok(GitPushResult {
        pushed_commits,
        upstream_set,
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn git_push(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    remote: Option<String>,
    branch: Option<String>,
    credentials: Option<GitCredentials>,
    folder_id: Option<i32>,
    db: tauri::State<'_, AppDatabase>,
) -> Result<GitPushResult, AppCommandError> {
    let folder_id = folder_id.or_else(|| {
        window
            .label()
            .strip_prefix("push-")
            .and_then(|value| value.parse::<i32>().ok())
    });
    let data_dir = app.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    let emitter = EventEmitter::Tauri(app.clone());
    git_push_core(
        &data_dir,
        &emitter,
        folder_id,
        &path,
        remote.as_deref(),
        branch.as_deref(),
        credentials.as_ref(),
        &db,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_new_branch(
    path: String,
    branch_name: String,
    start_point: Option<String>,
) -> Result<(), AppCommandError> {
    let mut args = vec!["checkout".to_string(), "-b".to_string(), branch_name];
    if let Some(start_point) = start_point {
        let trimmed = start_point.trim();
        if !trimmed.is_empty() {
            args.push(trimmed.to_string());
        }
    }

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("checkout -b", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_worktree_add(
    path: String,
    branch_name: String,
    worktree_path: String,
    base: Option<String>,
) -> Result<(), AppCommandError> {
    // 校验分支是否已存在
    let check = crate::process::tokio_command("git")
        .args([
            "rev-parse",
            "--verify",
            &format!("refs/heads/{}", branch_name),
        ])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if check.status.success() {
        return Err(
            AppCommandError::already_exists("Branch already exists").with_detail(branch_name)
        );
    }

    // 校验目录是否已存在
    if std::path::Path::new(&worktree_path).exists() {
        return Err(
            AppCommandError::already_exists("Worktree directory already exists")
                .with_detail(worktree_path),
        );
    }

    // 执行 git worktree add -b <branch> <path> [<base>]
    // 显式 base（提交/引用）消除「读分支 → 建 worktree」间用户切分支的漂移窗口；
    // 省略时沿用 HEAD（既有调用方行为不变）。
    let mut args = vec![
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        branch_name,
        worktree_path,
    ];
    if let Some(base) = base {
        args.push(base);
    }
    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("worktree add", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_checkout(path: String, branch_name: String) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["checkout", &branch_name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("checkout", &output.stderr));
    }
    Ok(())
}

/// Whether the working tree at `path` has no uncommitted changes to *tracked*
/// files (untracked files are ignored — they survive a branch switch). Used to
/// refuse a `shared_in_root` automation before it `git checkout`s the user's
/// root tree, which would otherwise carry their in-progress edits onto the
/// target branch (or fail outright).
pub async fn git_is_clean(path: String) -> Result<bool, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("status", &output.stderr));
    }
    // Porcelain prints one line per changed tracked path; clean ⇒ no output.
    Ok(output.stdout.iter().all(|b| b.is_ascii_whitespace()))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_reset(path: String, commit: String, mode: String) -> Result<(), AppCommandError> {
    let mode = mode.trim().to_lowercase();
    let mode_flag = match mode.as_str() {
        "soft" | "mixed" | "hard" | "keep" => format!("--{mode}"),
        _ => {
            return Err(AppCommandError::invalid_input(
                "Reset mode must be one of: soft, mixed, hard, keep",
            ))
        }
    };

    let output = crate::process::tokio_command("git")
        .args(["reset", mode_flag.as_str(), commit.as_str()])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("reset", &output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_list_branches(path: String) -> Result<Vec<String>, AppCommandError> {
    ensure_git_repo(&path)?;

    let output = crate::process::tokio_command("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("branch", &output.stderr));
    }

    let branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(branches)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_push(
    path: String,
    message: Option<String>,
    keep_index: bool,
) -> Result<String, AppCommandError> {
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if let Some(msg) = message {
        if !msg.is_empty() {
            args.push("-m".to_string());
            args.push(msg);
        }
    }
    if keep_index {
        args.push("--keep-index".to_string());
    }
    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash push", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_pop(
    path: String,
    stash_ref: Option<String>,
) -> Result<String, AppCommandError> {
    let mut args = vec!["stash", "pop"];
    let stash_ref_val;
    if let Some(ref r) = stash_ref {
        stash_ref_val = r.clone();
        args.push(&stash_ref_val);
    }
    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash pop", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_list(path: String) -> Result<Vec<GitStashEntry>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["stash", "list", "--format=%gd||%gs||%ci"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash list", &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .enumerate()
        .filter_map(|(i, line)| {
            let parts: Vec<&str> = line.splitn(3, "||").collect();
            if parts.len() < 3 {
                return None;
            }
            let ref_name = parts[0].to_string();
            let subject = parts[1];
            let date = parts[2].to_string();

            // Parse branch and message from subject like "On branch: message" or "WIP on branch: hash"
            let (branch, message) = if let Some(rest) = subject.strip_prefix("On ") {
                if let Some(colon_pos) = rest.find(": ") {
                    let branch = rest[..colon_pos].to_string();
                    let msg = rest[colon_pos + 2..].to_string();
                    (branch, msg)
                } else {
                    (String::new(), subject.to_string())
                }
            } else if let Some(rest) = subject.strip_prefix("WIP on ") {
                if let Some(colon_pos) = rest.find(": ") {
                    let branch = rest[..colon_pos].to_string();
                    let msg = rest[colon_pos + 2..].to_string();
                    (branch, msg)
                } else {
                    (String::new(), subject.to_string())
                }
            } else {
                (String::new(), subject.to_string())
            };

            Some(GitStashEntry {
                index: i,
                message,
                branch,
                date,
                ref_name,
            })
        })
        .collect();

    Ok(entries)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_apply(path: String, stash_ref: String) -> Result<String, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["stash", "apply", &stash_ref])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash apply", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_drop(path: String, stash_ref: String) -> Result<String, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["stash", "drop", &stash_ref])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash drop", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_clear(path: String) -> Result<String, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["stash", "clear"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash clear", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_stash_show(
    path: String,
    stash_ref: String,
) -> Result<Vec<GitStatusEntry>, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["-c", "core.quotePath=false"])
        .args(["stash", "show", "--name-status", &stash_ref])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("stash show", &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let status = parts.next()?.trim().to_string();
            let file = unquote_git_path(parts.next()?);
            Some(GitStatusEntry { status, file })
        })
        .collect();

    Ok(entries)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_status(
    path: String,
    show_all_untracked: Option<bool>,
) -> Result<Vec<GitStatusEntry>, AppCommandError> {
    ensure_git_repo(&path)?;

    let untracked_mode = if show_all_untracked.unwrap_or(false) {
        "-uall"
    } else {
        "-unormal"
    };
    // `--no-optional-locks` keeps this read-only query from contending with
    // concurrent agent writes on `.git/index.lock`. See PR #215 follow-up.
    let output = crate::process::tokio_command("git")
        .arg("--no-optional-locks")
        .args(["-c", "core.quotePath=false"])
        .args(["status", "--porcelain=v1", untracked_mode])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("status", &output.stderr));
    }

    let entries = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let status = line[..2].trim().to_string();
            let file = unquote_git_path(&line[3..]);
            GitStatusEntry { status, file }
        })
        .collect();
    Ok(entries)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_is_tracked(path: String, file: String) -> Result<bool, AppCommandError> {
    let literal_file = to_git_literal_pathspec(&file);
    let output = crate::process::tokio_command("git")
        .args(["ls-files", "--error-unmatch", "--"])
        .arg(&literal_file)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    Ok(output.status.success())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_diff(path: String, file: Option<String>) -> Result<String, AppCommandError> {
    ensure_git_repo(&path)?;

    let literal_file = file.as_deref().map(to_git_literal_pathspec);
    let mut args = vec!["diff".to_string(), "HEAD".to_string()];
    if let Some(ref f) = literal_file {
        args.push("--".to_string());
        args.push(f.clone());
    }

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        // For new repos with no HEAD, fall back to diff --cached
        let mut fallback_args = vec!["diff".to_string(), "--cached".to_string()];
        if let Some(ref f) = literal_file {
            fallback_args.push("--".to_string());
            fallback_args.push(f.clone());
        }
        let fallback = crate::process::tokio_command("git")
            .args(&fallback_args)
            .current_dir(&path)
            .output()
            .await
            .map_err(AppCommandError::io)?;
        return Ok(String::from_utf8_lossy(&fallback.stdout).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_diff_with_branch(
    path: String,
    branch: String,
    file: Option<String>,
) -> Result<String, AppCommandError> {
    ensure_git_repo(&path)?;

    let target_branch = branch.trim();
    if target_branch.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Branch name cannot be empty",
        ));
    }

    let literal_file = file.as_deref().map(to_git_literal_pathspec);
    let mut args = vec![
        "diff".to_string(),
        "--no-color".to_string(),
        target_branch.to_string(),
    ];
    if let Some(ref f) = literal_file {
        args.push("--".to_string());
        args.push(f.clone());
    }

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppCommandError::external_command(
            "git diff failed",
            format!("branch={target_branch}; {stderr}"),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_show_diff(
    path: String,
    commit: String,
    file: Option<String>,
) -> Result<String, AppCommandError> {
    ensure_git_repo(&path)?;

    let literal_file = file.as_deref().map(to_git_literal_pathspec);
    let mut args = vec![
        "show".to_string(),
        "--no-color".to_string(),
        "--format=".to_string(),
        commit,
    ];
    if let Some(ref f) = literal_file {
        args.push("--".to_string());
        args.push(f.clone());
    }

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("show", &output.stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_show_file(
    path: String,
    file: String,
    ref_name: Option<String>,
) -> Result<String, AppCommandError> {
    ensure_git_repo(&path)?;

    let git_ref = ref_name.unwrap_or_else(|| "HEAD".to_string());
    let file_spec = format!("{}:{}", git_ref, file);

    let output = crate::process::tokio_command("git")
        .args(["show", &file_spec])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        // File doesn't exist at this ref (e.g. new/untracked file) — return empty
        return Ok(String::new());
    }

    let bytes = &output.stdout;
    if bytes.iter().take(2048).any(|b| *b == 0) {
        return Err(
            AppCommandError::invalid_input("Binary files are not supported").with_detail(file_spec),
        );
    }

    Ok(String::from_utf8_lossy(bytes).to_string())
}

/// A file's raw bytes at a git ref, base64-encoded — the binary counterpart of
/// `git_show_file`, which refuses anything with a NUL byte. Image diffs need
/// the "before" bytes of a PNG/JPEG/… that no text-shaped command can carry.
#[derive(Debug, Serialize)]
pub struct GitBlobBase64 {
    /// False when the path does not exist at that ref — the shape of an added
    /// file (no original) or a deleted one (no modified). Not an error: the
    /// caller renders it as a one-sided diff.
    pub exists: bool,
    /// True when the *revision* is what could not be resolved, rather than the
    /// path within it. Only the caller knows which of the two that is: the
    /// parent of a root commit legitimately does not exist ("nothing came
    /// before"), while a branch that stopped resolving mid-session is a failure
    /// to look, not proof the file was added.
    pub ref_missing: bool,
    /// Base64 of the blob. Empty when `exists` is false or `too_large` is true.
    pub data: String,
    /// Blob size in bytes as git records it, reported even when the bytes were
    /// skipped, so a caller can say how big the thing it refused to load is.
    pub byte_size: u64,
    pub too_large: bool,
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_show_file_base64(
    path: String,
    file: String,
    ref_name: Option<String>,
    max_bytes: Option<usize>,
) -> Result<GitBlobBase64, AppCommandError> {
    ensure_git_repo(&path)?;

    let git_ref = ref_name.unwrap_or_else(|| "HEAD".to_string());
    let file_spec = format!("{}:{}", git_ref, file);
    let limit = max_bytes
        .unwrap_or(FILE_BASE64_DEFAULT_MAX_BYTES)
        .clamp(4_096, FILE_BASE64_MAX_BYTES) as u64;

    let missing = |ref_missing: bool| GitBlobBase64 {
        exists: false,
        ref_missing,
        data: String::new(),
        byte_size: 0,
        too_large: false,
    };

    // Pin the object id first. Sizing and reading `<ref>:<path>` directly would
    // resolve the ref twice, and a ref that moves in between turns the size
    // check into a promise about a different blob — the read would then buffer
    // however many bytes the new one has before anything could refuse it. An
    // oid is immutable, so the size below is a fact about the exact bytes the
    // read returns.
    let oid_output = crate::process::tokio_command("git")
        .args(["rev-parse", "--verify", "--quiet", &file_spec])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let oid = if oid_output.status.success() {
        String::from_utf8_lossy(&oid_output.stdout).trim().to_string()
    } else {
        String::new()
    };

    if oid.is_empty() {
        // `<ref>:<path>` fails the same way whether the path is not in that
        // tree or the revision itself is gone, and the two mean opposite
        // things to the reader. Ask which it was.
        let revision = crate::process::tokio_command("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{}^{{commit}}", git_ref),
            ])
            .current_dir(&path)
            .output()
            .await
            .map_err(AppCommandError::io)?;
        return Ok(missing(!revision.status.success()));
    }

    // `cat-file -s` reads the object header only, so an oversized blob is
    // reported without ever being buffered into memory (and then into a base64
    // string 4/3 as large, crossing the IPC boundary).
    let size_output = crate::process::tokio_command("git")
        .args(["cat-file", "-s", &oid])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    // The oid resolved a moment ago, so a failure here is a broken read (a
    // pruned or corrupt object), not evidence about the file's history.
    if !size_output.status.success() {
        return Err(git_command_error("cat-file", &size_output.stderr));
    }

    // A size we cannot read is not a size of zero: assuming the small end would
    // wave an arbitrarily large blob past the cap below.
    let byte_size: u64 = String::from_utf8_lossy(&size_output.stdout)
        .trim()
        .parse()
        .map_err(|_| {
            AppCommandError::external_command(
                "git cat-file returned an unreadable object size",
                String::from_utf8_lossy(&size_output.stdout).trim().to_string(),
            )
        })?;

    if byte_size > limit {
        return Ok(GitBlobBase64 {
            exists: true,
            ref_missing: false,
            data: String::new(),
            byte_size,
            too_large: true,
        });
    }

    // `cat-file blob` (not `show`) so the bytes come out raw, with no filter or
    // eol conversion applied on the way.
    let output = crate::process::tokio_command("git")
        .args(["cat-file", "blob", &oid])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("cat-file", &output.stderr));
    }

    Ok(GitBlobBase64 {
        exists: true,
        ref_missing: false,
        data: base64::engine::general_purpose::STANDARD.encode(&output.stdout),
        byte_size: output.stdout.len() as u64,
        too_large: false,
    })
}

pub(crate) async fn git_commit_core(
    emitter: &EventEmitter,
    folder_id: Option<i32>,
    conn: &sea_orm::DatabaseConnection,
    path: &str,
    message: &str,
    files: &[String],
) -> Result<GitCommitResult, AppCommandError> {
    // Find files already staged for deletion — git add would fail on these
    // because they no longer exist in either the working tree or the index.
    let staged_deletions: std::collections::HashSet<String> = crate::process::tokio_command("git")
        .args(["diff", "--cached", "--name-only", "--diff-filter=D", "-z"])
        .current_dir(path)
        .output()
        .await
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    // Stage only files that aren't already staged deletions
    let files_to_add: Vec<_> = files
        .iter()
        .filter(|f| !staged_deletions.contains(f.as_str()))
        .collect();

    if !files_to_add.is_empty() {
        let mut add_args = vec!["add".to_string(), "--".to_string()];
        add_args.extend(
            files_to_add
                .iter()
                .map(|file| to_git_literal_pathspec(file)),
        );

        let add_output = crate::process::tokio_command("git")
            .args(&add_args)
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !add_output.status.success() {
            return Err(git_command_error("add", &add_output.stderr));
        }
    }

    // Resolve commit author from matching account (e.g. GitHub username)
    let author_override = crate::git_credential::resolve_commit_author(path, conn).await;

    // Commit
    let mut commit_cmd = crate::process::tokio_command("git");
    if let Some((ref name, ref email)) = author_override {
        commit_cmd.args([
            "-c",
            &format!("user.name={name}"),
            "-c",
            &format!("user.email={email}"),
        ]);
    }
    commit_cmd.args(["commit", "-m", message]).current_dir(path);

    let commit_output = commit_cmd.output().await.map_err(AppCommandError::io)?;

    if !commit_output.status.success() {
        return Err(git_command_error("commit", &commit_output.stderr));
    }

    let committed_files = count_files_in_commit(path, "HEAD")
        .await
        .unwrap_or(files.len());

    if let Some(folder_id) = folder_id {
        crate::web::event_bridge::emit_event(
            emitter,
            "folder://git-commit-succeeded",
            GitCommitSucceededEvent {
                folder_id,
                committed_files,
            },
        );
    }

    Ok(GitCommitResult { committed_files })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_commit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    path: String,
    message: String,
    files: Vec<String>,
    folder_id: Option<i32>,
) -> Result<GitCommitResult, AppCommandError> {
    let folder_id = folder_id.or_else(|| {
        window
            .label()
            .strip_prefix("commit-")
            .and_then(|value| value.parse::<i32>().ok())
    });
    let emitter = EventEmitter::Tauri(app.clone());
    git_commit_core(&emitter, folder_id, &db.conn, &path, &message, &files).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_rollback_file(path: String, file: String) -> Result<(), AppCommandError> {
    let target = file.trim();
    if target.is_empty() {
        return Err(AppCommandError::invalid_input("File path cannot be empty"));
    }

    let literal_file = to_git_literal_pathspec(target);
    let restore_output = crate::process::tokio_command("git")
        .args([
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            &literal_file,
        ])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if restore_output.status.success() {
        return Ok(());
    }

    let restore_stderr = String::from_utf8_lossy(&restore_output.stderr)
        .trim()
        .to_string();
    let restore_stderr_lower = restore_stderr.to_lowercase();
    let supports_restore = !restore_stderr_lower.contains("unknown option")
        && !restore_stderr_lower.contains("unknown switch")
        && !restore_stderr_lower.contains("not a git command")
        && !restore_stderr_lower.contains("did you mean");

    if supports_restore {
        return Err(AppCommandError::external_command(
            "git restore failed",
            restore_stderr,
        ));
    }

    let _ = crate::process::tokio_command("git")
        .args(["reset", "HEAD", "--", &literal_file])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let checkout_output = crate::process::tokio_command("git")
        .args(["checkout", "--", &literal_file])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !checkout_output.status.success() {
        return Err(git_command_error("checkout --", &checkout_output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_add_files(path: String, files: Vec<String>) -> Result<(), AppCommandError> {
    if files.is_empty() {
        return Ok(());
    }

    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(files.iter().map(|file| to_git_literal_pathspec(file)));

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("add", &output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_list_all_branches(path: String) -> Result<GitBranchList, AppCommandError> {
    ensure_git_repo(&path)?;

    let local_fut = crate::process::tokio_command("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&path)
        .output();

    let remote_fut = crate::process::tokio_command("git")
        .args(["branch", "-r", "--format=%(refname:short)"])
        .current_dir(&path)
        .output();

    let wt_fut = crate::process::tokio_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&path)
        .output();

    let (local_output, remote_output, wt_output) = tokio::join!(local_fut, remote_fut, wt_fut);

    let local_output = local_output.map_err(AppCommandError::io)?;
    if !local_output.status.success() {
        return Err(git_command_error("branch", &local_output.stderr));
    }

    let local: Vec<String> = String::from_utf8_lossy(&local_output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let remote: Vec<String> = match remote_output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.contains("HEAD") && l.contains('/'))
            .collect(),
        _ => vec![],
    };

    // Worktree entries, excluding the queried path's own checkout. git reports
    // the main working tree first, which is how it is singled out here.
    let (worktree_branches, main_worktree_branch) = match wt_output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let canonical_path =
                std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
            let mut branches = Vec::new();
            let mut main_branch = None;
            for (index, (wt_path, branch)) in parse_worktrees(&stdout).into_iter().enumerate() {
                let Some(branch) = branch else { continue };
                let wt_canonical =
                    std::fs::canonicalize(&wt_path).unwrap_or_else(|_| PathBuf::from(&wt_path));
                if wt_canonical == canonical_path {
                    continue;
                }
                if index == 0 {
                    main_branch = Some(branch.clone());
                }
                branches.push(branch);
            }
            (branches, main_branch)
        }
        _ => (vec![], None),
    };

    Ok(GitBranchList {
        local,
        remote,
        worktree_branches,
        main_worktree_branch,
    })
}

/// Parse `git worktree list --porcelain` into `(worktree_path, branch)` pairs.
/// Each porcelain block starts with a `worktree <path>` line and is terminated
/// by a blank line; a `branch refs/heads/<name>` line carries the checked-out
/// branch (absent for detached/bare worktrees → `None`). Trailing blocks with
/// no terminating blank line are flushed at EOF.
fn parse_worktrees(stdout: &str) -> Vec<(String, Option<String>)> {
    let mut entries: Vec<(String, Option<String>)> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in stdout.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // Defensive flush in case a block wasn't blank-line terminated.
            if let Some(path) = current_path.take() {
                entries.push((path, current_branch.take()));
            }
            current_path = Some(p.trim().to_string());
            current_branch = None;
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(b.trim().to_string());
        } else if line.is_empty() {
            if let Some(path) = current_path.take() {
                entries.push((path, current_branch.take()));
            }
            current_branch = None;
        }
    }
    if let Some(path) = current_path.take() {
        entries.push((path, current_branch.take()));
    }
    entries
}

/// Resolve where `branch` is checked out and which registered folder owns that
/// directory. Canonicalizes both the worktree path (from git) and every folder
/// path (from the DB) so symlinked / non-canonical paths still match — this
/// can only be done on the host that runs git, which is why it lives in the
/// backend rather than the webview.
pub async fn resolve_worktree_folder_core(
    db: &AppDatabase,
    repo_path: String,
    branch: String,
) -> Result<WorktreeResolution, AppCommandError> {
    ensure_git_repo(&repo_path)?;

    let output = crate::process::tokio_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !output.status.success() {
        return Err(git_command_error("worktree list", &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let wt_path = parse_worktrees(&stdout)
        .into_iter()
        .find(|(_, b)| b.as_deref() == Some(branch.as_str()))
        .map(|(p, _)| p);

    let Some(wt_path) = wt_path else {
        // Branch is not checked out in any worktree → caller checks it out in root.
        return Ok(WorktreeResolution {
            path: None,
            folder_id: None,
        });
    };

    let canonical_wt = std::fs::canonicalize(&wt_path).unwrap_or_else(|_| PathBuf::from(&wt_path));
    let folder_id = folder_at_path(db, &canonical_wt).await?.map(|f| f.id);

    Ok(WorktreeResolution {
        path: Some(canonical_wt.to_string_lossy().to_string()),
        folder_id,
    })
}

/// The registered folder whose path points at `path`, if any. Both sides are
/// canonicalized so a symlinked or non-canonical registration still matches the
/// path git reports — but the folder is returned with its own recorded path,
/// which is the one the rest of the app (and every conversation's `origin_cwd`)
/// is written in terms of.
async fn folder_at_path(
    db: &AppDatabase,
    path: &Path,
) -> Result<Option<FolderDetail>, AppCommandError> {
    let folders = folder_service::list_all_folder_details(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    Ok(folders.into_iter().find(|f| {
        let canon = std::fs::canonicalize(&f.path).unwrap_or_else(|_| PathBuf::from(&f.path));
        canon == path
    }))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn resolve_worktree_folder(
    db: tauri::State<'_, AppDatabase>,
    repo_path: String,
    branch: String,
) -> Result<WorktreeResolution, AppCommandError> {
    resolve_worktree_folder_core(&db, repo_path, branch).await
}

/// Remove the git worktree that has `branch_name` checked out, optionally
/// deleting the branch and the worktree's registered folder with it.
///
/// This is the only way a worktree branch can be deleted at all: `git branch -d`
/// refuses point blank while a worktree holds the ref ("cannot delete branch 'x'
/// used by worktree at '…'"), so the checkout has to go first.
///
/// Order is load-bearing and each step is tolerant of already having been done,
/// because a partially applied removal is retried by re-calling this with
/// `force`:
/// 1. `worktree remove` (`--force` also discards uncommitted/untracked files).
///    A branch with no worktree left is not an error — it is what a retry sees.
/// 2. When `delete_branch`, the folder convergence runs *before* the branch is
///    deleted, so a refused `branch -d` doesn't strand a folder pointing at a
///    directory that is already gone.
/// 3. `branch -d` (or `-D` under `force`, which a worktree branch normally needs
///    since its commits are unmerged).
///
/// Refused outright while a to-do task is mid-run or mid-merge inside the
/// worktree — `--force` would otherwise delete a live agent's working tree.
///
/// `source_folder_id` is the folder the caller is acting from; it only supplies
/// the re-parent target when the worktree folder has no recorded root.
pub async fn git_remove_worktree_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    repo_path: String,
    branch_name: String,
    source_folder_id: i32,
    delete_branch: bool,
    force: bool,
) -> Result<GitWorktreeRemoval, AppCommandError> {
    ensure_git_repo(&repo_path)?;

    let listed = crate::process::tokio_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_path)
        .output()
        .await
        .map_err(AppCommandError::io)?;
    if !listed.status.success() {
        return Err(git_command_error("worktree list", &listed.stderr));
    }
    let entries = parse_worktrees(&String::from_utf8_lossy(&listed.stdout));
    // `git worktree list` always reports the main working tree first.
    let main_path = entries.first().map(|(path, _)| path.clone());
    let hosting = entries
        .into_iter()
        .find(|(_, branch)| branch.as_deref() == Some(branch_name.as_str()))
        .map(|(path, _)| path);

    let mut removal = GitWorktreeRemoval {
        worktree_path: None,
        branch_deleted: false,
        folder_id: None,
        reparented: 0,
    };

    if let Some(worktree_path) = hosting {
        let canonical = std::fs::canonicalize(&worktree_path)
            .unwrap_or_else(|_| PathBuf::from(&worktree_path));
        if main_path.as_deref() == Some(worktree_path.as_str()) {
            return Err(
                AppCommandError::invalid_input("The main working tree cannot be removed")
                    .with_detail(worktree_path),
            );
        }
        // Removing the tree the caller is working in would pull the ground out
        // from under the open session; git's own refusal is less legible.
        let canonical_repo =
            std::fs::canonicalize(&repo_path).unwrap_or_else(|_| PathBuf::from(&repo_path));
        if canonical == canonical_repo {
            return Err(AppCommandError::invalid_input(
                "The worktree currently in use cannot be removed",
            )
            .with_detail(worktree_path));
        }

        // Resolve the folder while the directory still exists — canonicalizing
        // its path afterwards would no longer match anything.
        let wt_folder = folder_at_path(db, &canonical).await?;

        // A to-do task mid-run or mid-merge is working inside this directory:
        // removing it (and `--force` would) yanks the tree out from under a live
        // agent. The task card's own removal refuses the same statuses.
        if let Some(folder) = &wt_folder {
            let busy = crate::db::service::work_task_service::tasks_blocking_worktree_removal(
                &db.conn, folder.id,
            )
            .await
            .map_err(AppCommandError::from)?;
            if !busy.is_empty() {
                return Err(AppCommandError::invalid_input(
                    "A to-do task is still working in this worktree — cancel or finish it first",
                )
                .with_detail(busy.join(", ")));
            }
        }

        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&worktree_path);
        let removed = crate::process::tokio_command("git")
            .args(&args)
            .current_dir(&repo_path)
            .output()
            .await
            .map_err(AppCommandError::io)?;
        if !removed.status.success() {
            if Path::new(&worktree_path).exists() {
                return Err(git_command_error("worktree remove", &removed.stderr));
            }
            // The directory was deleted behind git's back — drop the stale
            // registration so it can't block the branch delete below.
            let pruned = crate::process::tokio_command("git")
                .args(["worktree", "prune"])
                .current_dir(&repo_path)
                .output()
                .await
                .map_err(AppCommandError::io)?;
            if !pruned.status.success() {
                return Err(git_command_error("worktree prune", &pruned.stderr));
            }
        }
        removal.worktree_path = Some(worktree_path.clone());

        // Only the "delete everything" variant drops the folder: removing just
        // the checkout is how you free a branch while keeping the workspace
        // entry (and its sessions) for a worktree you intend to recreate. For
        // the same reason that variant leaves a settled task's `worktree_folder_id`
        // pointing here — recreating the directory makes the link whole again,
        // and detaching it now would cost the task its merge path.
        if delete_branch {
            if let Some(wt_folder) = wt_folder {
                if let Some(project_folder_id) =
                    reparent_target(db, wt_folder.id, source_folder_id).await
                {
                    // Stamp `origin_cwd` with the folder's OWN path, not git's
                    // canonicalization of it: the agents that fall back to
                    // matching on `origin_cwd ?? folder.path` were pointed at
                    // the registered spelling, and a `/private/var` vs `/var`
                    // rewrite would silently stop matching.
                    removal.reparented = converge_removed_worktree_folder(
                        db,
                        emitter,
                        wt_folder.id,
                        project_folder_id,
                        &wt_folder.path,
                    )
                    .await;
                    removal.folder_id = Some(wt_folder.id);
                }
            }
        }
    }

    if delete_branch {
        let flag = if force { "-D" } else { "-d" };
        let deleted = crate::process::tokio_command("git")
            .args(["branch", flag, &branch_name])
            .current_dir(&repo_path)
            .output()
            .await
            .map_err(AppCommandError::io)?;
        if !deleted.status.success() {
            // "not found" means an earlier attempt already got it.
            let stderr = String::from_utf8_lossy(&deleted.stderr).to_lowercase();
            if !stderr.contains("not found") {
                return Err(git_command_error(
                    &format!("branch {flag}"),
                    &deleted.stderr,
                ));
            }
        }
        removal.branch_deleted = true;
    }

    Ok(removal)
}

/// Where a removed worktree folder's conversations belong: the root repo folder
/// it was created from, falling back to the caller's own root when the row has
/// no recorded parent. `None` means there is nowhere safe to move them, and the
/// caller must leave the folder alone rather than orphan its sessions.
async fn reparent_target(
    db: &AppDatabase,
    worktree_folder_id: i32,
    source_folder_id: i32,
) -> Option<i32> {
    let recorded = folder_service::get_folder_by_id(&db.conn, worktree_folder_id)
        .await
        .ok()
        .flatten()
        .and_then(|f| f.parent_id);
    let target = match recorded {
        Some(parent_id) => Some(parent_id),
        None if source_folder_id > 0 => folder_service::get_folder_by_id(&db.conn, source_folder_id)
            .await
            .ok()
            .flatten()
            .map(|source| source.parent_id.unwrap_or(source.id)),
        None => None,
    };
    target.filter(|id| *id != worktree_folder_id)
}

/// Converge DB + clients once a worktree directory is off disk: its
/// conversations move to `project_folder_id` (stamped with `origin_cwd` so
/// history still resolves), its tabs close, its folder row is soft-deleted, any
/// to-do task pointing at it is detached, and every client is told. Returns the
/// number of conversations moved.
///
/// Write order matters — conversations first, so they are never left pointing at
/// a folder that has already vanished — and each step ends in a broadcast,
/// because a removal no client hears about is a removal no client shows: the
/// sidebar keeps the dead worktree until the next full `fetchFolders`.
///
/// The work-task engine runs the same sequence for the worktree it minted
/// (`converge_worktree_removal`), wrapped in its own task bookkeeping.
async fn converge_removed_worktree_folder(
    db: &AppDatabase,
    emitter: &EventEmitter,
    worktree_folder_id: i32,
    project_folder_id: i32,
    worktree_path: &str,
) -> u32 {
    use crate::db::service::{conversation_service, tab_service, work_task_service};

    let moved = conversation_service::reparent_folder_conversations(
        &db.conn,
        worktree_folder_id,
        project_folder_id,
        worktree_path,
    )
    .await
    .unwrap_or(0) as u32;

    match tab_service::delete_folder_tabs_and_bump(&db.conn, worktree_folder_id).await {
        Ok(inv) => {
            if let Some(tabs) = inv.emit {
                crate::web::event_bridge::emit_event(
                    emitter,
                    crate::web::event_bridge::TABS_CHANGED_EVENT,
                    crate::web::event_bridge::TabsChanged {
                        version: inv.version,
                        origin: "server".to_string(),
                        tabs,
                    },
                );
            }
        }
        Err(e) => {
            tracing::warn!("[folders] tab cleanup failed for folder {worktree_folder_id}: {e}")
        }
    }

    // Announce the folder drop only when the row really is gone, so a failed
    // write can't leave clients disagreeing with what a refetch would return.
    let folder_gone = match folder_service::soft_delete_folder(&db.conn, worktree_folder_id).await {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("[folders] worktree folder {worktree_folder_id} soft-delete failed: {e}");
            false
        }
    };

    // A settled to-do task may own this worktree (its card offers a cleanup and
    // a diff that would now only fail). The engine detaches the ones it removes
    // itself; this detaches the ones removed out from under it.
    let detached = work_task_service::clear_worktree_by_folder(&db.conn, worktree_folder_id)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("[folders] task detach failed for folder {worktree_folder_id}: {e}");
            Vec::new()
        });

    // Conversations first: this starts every client's refetch, so the moved rows
    // have the shortest possible window with no folder to render under.
    crate::web::event_bridge::emit_event(
        emitter,
        crate::web::event_bridge::CONVERSATIONS_BULK_CHANGED_EVENT,
        crate::web::event_bridge::ConversationsBulkChanged {
            imported: 0,
            updated: moved,
            folder_ids: vec![project_folder_id],
        },
    );
    if folder_gone {
        emit_folder_deleted(emitter, worktree_folder_id);
    }
    for task_id in detached {
        crate::web::event_bridge::emit_event(
            emitter,
            crate::web::event_bridge::WORK_TASK_CHANGED_EVENT,
            crate::web::event_bridge::WorkTaskChange::Upsert { id: task_id },
        );
    }
    crate::office_watch::stop_office_watches_under_root(worktree_path);
    moved
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_remove_worktree(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    path: String,
    branch_name: String,
    source_folder_id: i32,
    delete_branch: bool,
    force: bool,
) -> Result<GitWorktreeRemoval, AppCommandError> {
    git_remove_worktree_core(
        &EventEmitter::Tauri(app),
        &db,
        path,
        branch_name,
        source_folder_id,
        delete_branch,
        force,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_list_remotes(path: String) -> Result<Vec<GitRemote>, AppCommandError> {
    ensure_git_repo(&path)?;

    let output = crate::process::tokio_command("git")
        .args(["remote", "-v"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("remote -v", &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut seen = HashSet::new();
    let mut remotes = Vec::new();
    for line in stdout.lines() {
        // Format: "name\turl (fetch|push)"
        if !line.ends_with("(fetch)") {
            continue;
        }
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let url = rest.trim_end_matches("(fetch)").trim();
        if seen.insert(name.to_string()) {
            remotes.push(GitRemote {
                name: name.to_string(),
                url: url.to_string(),
            });
        }
    }
    Ok(remotes)
}

pub(crate) async fn git_fetch_remote_core(
    path: &str,
    name: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<String, AppCommandError> {
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["fetch", name]).current_dir(path);
    prepare_remote_git_cmd_with_remote(&mut cmd, path, Some(name), credentials, db, data_dir).await;

    let output = cmd.output().await.map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(classify_remote_git_error("fetch", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_fetch_remote(
    path: String,
    name: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_fetch_remote_core(&path, &name, credentials.as_ref(), &db, &data_dir).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_add_remote(
    path: String,
    name: String,
    url: String,
) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["remote", "add", &name, &url])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("remote add", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_remove_remote(path: String, name: String) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["remote", "remove", &name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("remote remove", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_set_remote_url(
    path: String,
    name: String,
    url: String,
) -> Result<(), AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["remote", "set-url", &name, &url])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("remote set-url", &output.stderr));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_merge(
    path: String,
    branch_name: String,
) -> Result<GitMergeResult, AppCommandError> {
    // Count commits to be merged before performing merge
    let count_output = crate::process::tokio_command("git")
        .args(["rev-list", "--count", &format!("HEAD..{}", branch_name)])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let merged_commits = if count_output.status.success() {
        String::from_utf8_lossy(&count_output.stdout)
            .trim()
            .parse::<usize>()
            .unwrap_or(0)
    } else {
        0
    };

    let output = crate::process::tokio_command("git")
        .args(["merge", &branch_name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        let conflicted_files = detect_conflicts(&path).await?;
        if !conflicted_files.is_empty() {
            return Ok(GitMergeResult {
                merged_commits,
                conflict: Some(GitConflictInfo {
                    has_conflicts: true,
                    conflicted_files,
                    operation: "merge".to_string(),
                    upstream_commit: None,
                }),
            });
        }
        return Err(git_command_error("merge", &output.stderr));
    }
    Ok(GitMergeResult {
        merged_commits,
        conflict: None,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_rebase(
    path: String,
    branch_name: String,
) -> Result<GitRebaseResult, AppCommandError> {
    let output = crate::process::tokio_command("git")
        .args(["rebase", &branch_name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        let conflicted_files = detect_conflicts(&path).await?;
        if !conflicted_files.is_empty() {
            return Ok(GitRebaseResult {
                message: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                conflict: Some(GitConflictInfo {
                    has_conflicts: true,
                    conflicted_files,
                    operation: "rebase".to_string(),
                    upstream_commit: None,
                }),
            });
        }
        return Err(git_command_error("rebase", &output.stderr));
    }
    Ok(GitRebaseResult {
        message: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        conflict: None,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_delete_branch(
    path: String,
    branch_name: String,
    force: bool,
) -> Result<String, AppCommandError> {
    let flag = if force { "-D" } else { "-d" };
    let output = crate::process::tokio_command("git")
        .args(["branch", flag, &branch_name])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error(&format!("branch {flag}"), &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) async fn git_delete_remote_branch_core(
    path: &str,
    remote: &str,
    branch: &str,
    credentials: Option<&GitCredentials>,
    db: &AppDatabase,
    data_dir: &std::path::Path,
) -> Result<String, AppCommandError> {
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["push", remote, "--delete", branch])
        .current_dir(path);
    prepare_remote_git_cmd_with_remote(&mut cmd, path, Some(remote), credentials, db, data_dir)
        .await;

    let output = cmd.output().await.map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(classify_remote_git_error("push --delete", &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_delete_remote_branch(
    path: String,
    remote: String,
    branch: String,
    credentials: Option<GitCredentials>,
    db: tauri::State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppCommandError> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| {
        AppCommandError::external_command("Failed to resolve app data dir", e.to_string())
    })?;
    // Resolve through the effective data dir so a custom
    // `CODEG_DATA_DIR` reaches the git credential helper invoked by
    // this subprocess.
    let data_dir = crate::paths::resolve_effective_data_dir(&data_dir);
    git_delete_remote_branch_core(
        &path,
        &remote,
        &branch,
        credentials.as_ref(),
        &db,
        &data_dir,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_list_conflicts(path: String) -> Result<Vec<String>, AppCommandError> {
    detect_conflicts(&path).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_conflict_file_versions(
    path: String,
    file: String,
) -> Result<GitConflictFileVersions, AppCommandError> {
    // :1: = base (common ancestor), :2: = ours (HEAD), :3: = theirs (incoming)
    let mut versions = Vec::with_capacity(3);
    for stage in ["1", "2", "3"] {
        let file_spec = format!(":{}:{}", stage, file);
        let output = crate::process::tokio_command("git")
            .args(["show", &file_spec])
            .current_dir(&path)
            .output()
            .await
            .map_err(AppCommandError::io)?;

        if !output.status.success() {
            // File may not exist at this stage (e.g. newly added on one side)
            versions.push(String::new());
        } else {
            let bytes = &output.stdout;
            if bytes.iter().take(2048).any(|b| *b == 0) {
                return Err(
                    AppCommandError::invalid_input("Binary files are not supported")
                        .with_detail(file_spec),
                );
            }
            versions.push(String::from_utf8_lossy(bytes).to_string());
        }
    }

    // Read the working tree file (contains conflict markers)
    let file_path = Path::new(&path).join(&file);
    let merged = std::fs::read_to_string(&file_path).unwrap_or_default();

    Ok(GitConflictFileVersions {
        base: versions.remove(0),
        ours: versions.remove(0),
        theirs: versions.remove(0),
        merged,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_resolve_conflict(
    path: String,
    file: String,
    content: String,
) -> Result<(), AppCommandError> {
    let file_path = Path::new(&path).join(&file);

    // Write resolved content
    std::fs::write(&file_path, content)
        .map_err(|e| AppCommandError::io_error(format!("Failed to write resolved file: {}", e)))?;

    // Stage the resolved file
    let output = crate::process::tokio_command("git")
        .args(["add", &file])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("add", &output.stderr));
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_abort_operation(path: String, operation: String) -> Result<(), AppCommandError> {
    let args = match operation.as_str() {
        "merge" | "pull" => vec!["merge", "--abort"],
        "rebase" => vec!["rebase", "--abort"],
        _ => {
            return Err(AppCommandError::invalid_input(format!(
                "Unknown operation: {operation}"
            )));
        }
    };

    let output = crate::process::tokio_command("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error(
            &format!("{} --abort", operation),
            &output.stderr,
        ));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_continue_operation(
    path: String,
    operation: String,
) -> Result<(), AppCommandError> {
    let (program, args): (&str, Vec<&str>) = match operation.as_str() {
        "merge" | "pull" => ("git", vec!["commit", "--no-edit"]),
        "rebase" => ("git", vec!["rebase", "--continue"]),
        _ => {
            return Err(AppCommandError::invalid_input(format!(
                "Unknown operation: {operation}"
            )));
        }
    };

    let output = crate::process::tokio_command(program)
        .args(&args)
        .current_dir(&path)
        .env("GIT_EDITOR", "true")
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error(
            &format!("{} --continue", operation),
            &output.stderr,
        ));
    }
    Ok(())
}

const FILE_TREE_IGNORED_DIRS: &[&str] = &[".git", "__pycache__"];

/// Hard limit: refuse to open files larger than 50 MB in the text editor.
const FILE_OPEN_HARD_LIMIT: usize = 50_000_000;
/// Save limit: refuse to save content larger than 50 MB.
const FILE_SAVE_HARD_LIMIT: usize = 50_000_000;
const FILE_BASE64_DEFAULT_MAX_BYTES: usize = 20_000_000;
const FILE_BASE64_MAX_BYTES: usize = 100_000_000;
const FILE_IO_MAX_CONCURRENT_OPS: usize = 8;

static FILE_IO_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(FILE_IO_MAX_CONCURRENT_OPS));

fn to_git_literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

/// Remove surrounding quotes from a git output path.
/// Git quotes paths containing non-ASCII or special characters, e.g.
/// `"path/\344\270\255\346\226\207.txt"`.  With `core.quotePath=false`
/// the octal escapes are gone, but the quotes may still appear for paths
/// with spaces, tabs, etc.
fn unquote_git_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn resolve_tree_path(
    root: &Path,
    rel_path: &str,
) -> Result<PathBuf, AppCommandError> {
    let rel = Path::new(rel_path);
    if rel.is_absolute() {
        return Err(AppCommandError::invalid_input("Path must be relative"));
    }

    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppCommandError::invalid_input("Path cannot contain '..'"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppCommandError::invalid_input("Invalid path component"));
            }
        }
    }

    Ok(root.join(rel))
}

fn validate_new_name(new_name: &str) -> Result<&str, AppCommandError> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("New name cannot be empty"));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(AppCommandError::invalid_input("Invalid file name"));
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppCommandError::invalid_input(
            "New name cannot contain path separators",
        ));
    }
    Ok(trimmed)
}

fn file_mtime_ms(metadata: &std::fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
    let millis = elapsed.as_millis();
    if millis > i64::MAX as u128 {
        return Some(i64::MAX);
    }
    Some(millis as i64)
}

fn detect_line_ending(content: &[u8]) -> String {
    let mut has_lf = false;
    let mut has_crlf = false;

    for index in 0..content.len() {
        if content[index] != b'\n' {
            continue;
        }

        if index > 0 && content[index - 1] == b'\r' {
            has_crlf = true;
        } else {
            has_lf = true;
        }

        if has_lf && has_crlf {
            return "mixed".to_string();
        }
    }

    if has_crlf {
        "crlf".to_string()
    } else if has_lf {
        "lf".to_string()
    } else {
        "none".to_string()
    }
}

fn compute_etag(content: &[u8], metadata: &std::fs::Metadata) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    if let Some(mtime_ms) = file_mtime_ms(metadata) {
        mtime_ms.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

/// Whether `canonical_target` may be touched by a workspace operation rooted at
/// `canonical_root`: either it is inside the root, or it is inside a directory
/// the user explicitly linked into that root (see [`crate::folder_links`]).
///
/// This is the *strict* rule, and it is deliberately reserved for the two
/// surfaces where the path comes from something other than a user clicking a
/// row in the file tree:
///
/// - [`read_workspace_file_base64`], which the HTML preview uses to inline
///   sub-resources named by the previewed markup itself. A cloned repo shipping
///   `secrets -> ~/.ssh` plus an `<img src="secrets/id_rsa">` must not be able
///   to make us read that file — nobody clicked anything.
/// - the web upload chain (`web::handlers::workspace_files`), where following
///   an unvetted link would *create* directories outside the workspace.
///
/// Paths the user navigated to go through [`ensure_user_navigable_path`]
/// instead.
pub(crate) fn is_within_workspace(canonical_root: &Path, canonical_target: &Path) -> bool {
    canonical_target.starts_with(canonical_root)
        || crate::folder_links::is_allowed(canonical_root, canonical_target)
}

/// The workspace boundary for a path the user picked in the file panel.
///
/// `target` must have been composed by [`resolve_tree_path`] (or the web
/// handlers' `resolve_relative_path`), which already rejected absolute paths
/// and every `..`, so it is lexically under the root; this asserts that
/// invariant rather than re-deriving it.
///
/// What it deliberately does *not* do is canonicalize. The only way a
/// `..`-free relative path leaves the root is a symlink living inside the
/// workspace — and such a symlink is part of the workspace as far as the user,
/// the terminal, and the agent CLI (whose cwd is this very root) are concerned.
/// Canonicalizing here is what made a symlinked folder impossible to open: the
/// tree showed it, and every click answered "Path is outside workspace root"
/// (issue #430). `rename`/`move`/`delete` have always drawn the boundary
/// exactly here; this brings the read/write commands in line.
///
/// The strict, registry-only rule stays where the path is *not* user-driven —
/// see [`is_within_workspace`].
pub(crate) fn ensure_user_navigable_path(
    root: &Path,
    target: &Path,
) -> Result<(), AppCommandError> {
    if !target.starts_with(root) {
        return Err(AppCommandError::invalid_input(
            "Path is outside workspace root",
        ));
    }
    Ok(())
}

/// Identity of a filesystem *entry*: the canonical directory holding it plus
/// its own name. Canonicalizing the parent resolves every alias in the path
/// while leaving the final component alone, so a symlink is identified as the
/// link itself and two path strings naming the same link compare equal.
fn entry_identity(path: &Path) -> Option<(PathBuf, std::ffi::OsString)> {
    let parent = path.parent()?;
    let name = path.file_name()?;
    Some((std::fs::canonicalize(parent).ok()?, name.to_os_string()))
}

/// Every symlink the configured root path is resolved through, as
/// [`entry_identity`] pairs — the entries that must survive for the workspace
/// to keep pointing at the right directory.
///
/// This resolves the root the way the kernel does, recording each link it
/// follows, because neither cheaper answer is correct:
///
/// - "does it resolve to the canonical root?" both misses and over-reaches. It
///   misses a root with components *after* the link (`actual/sub/hop -> ..`
///   opened as `actual/sub/hop/sub` resolves `hop` to `actual`, not to the
///   root), and it wrongly claims an unrelated `self -> .` that the root does
///   not depend on at all.
/// - walking only the root's own components and jumping to `canonicalize` at
///   each link skips whatever links sit inside *that link's target*
///   (`actual/hop -> .` reached through a root `workspace -> actual/hop`).
///
/// Identity comparison means an alias reaching the same link is caught too.
/// Names are compared ASCII-case-insensitively by the caller; that leaves one
/// residual, a differently *Unicode-normalised* (NFC/NFD) spelling on macOS.
/// Tree paths come from `read_dir` and therefore carry the filesystem's own
/// spelling, so the UI cannot produce that input.
fn root_resolution_links(root: &Path) -> Vec<(PathBuf, std::ffi::OsString)> {
    let mut protected = Vec::new();
    let mut hops = 0usize;
    // Roots are stored verbatim, so one can be relative. The walk below builds
    // its path up from empty, where a leading `..` would pop nothing and a
    // leading `.` would vanish — the path it then stat'ed would be a *different*
    // one, silently protecting nothing. `std::path::absolute` anchors it to the
    // working directory the way the OS would, and deliberately keeps `..`
    // intact rather than folding it away, which is what the walk needs to
    // resolve it against real directories.
    let Ok(anchored) = std::path::absolute(root) else {
        return protected;
    };
    // A root that cannot be resolved (missing, unreadable, a link cycle) simply
    // protects fewer entries — the outward boundary in
    // `ensure_entry_is_in_workspace` still applies on its own.
    let _ = resolve_recording_links(&anchored, &mut protected, &mut hops);
    protected
}

/// Resolve `path` to a link-free path, pushing the [`entry_identity`] of every
/// symlink traversed into `protected`. `None` if resolution cannot finish.
///
/// `hops` bounds the work across the whole resolution — every link followed
/// spends one, and recursion only happens after spending one, so a cycle
/// (`a -> b`, `b -> a`) terminates and the recursion depth is bounded too.
fn resolve_recording_links(
    path: &Path,
    protected: &mut Vec<(PathBuf, std::ffi::OsString)>,
    hops: &mut usize,
) -> Option<PathBuf> {
    /// Same order of magnitude as the kernel's own `ELOOP` limit.
    const MAX_HOPS: usize = 40;

    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                current.push(component.as_os_str());
                continue;
            }
            Component::CurDir => continue,
            // Everything resolved so far is link-free, so popping is the same
            // thing the kernel would do.
            Component::ParentDir => {
                current.pop();
                continue;
            }
            Component::Normal(name) => current.push(name),
        }

        let metadata = std::fs::symlink_metadata(&current).ok()?;
        if !metadata.file_type().is_symlink() {
            continue;
        }
        *hops += 1;
        if *hops > MAX_HOPS {
            return None;
        }
        if let Some(identity) = entry_identity(&current) {
            protected.push(identity);
        }
        let link_target = std::fs::read_link(&current).ok()?;
        let absolute_target = if link_target.is_absolute() {
            link_target
        } else {
            current.parent()?.join(link_target)
        };
        // Resolve through the target as well, so links *inside* it are recorded
        // rather than skipped over by a bare `canonicalize`.
        current = resolve_recording_links(&absolute_target, protected, hops)?;
    }
    Some(current)
}

/// Confinement for the operations that destroy or relocate an entry —
/// `delete_file_tree_entry`, `rename_file_tree_entry`, `move_file_tree_entry`.
///
/// These are the only commands that can make data disappear, and a lexical
/// check is not enough for them the way it is for reads (see
/// [`ensure_user_navigable_path`]). Each of them used to compare
/// `target == root` and nothing else; any link pointing outside the root turns
/// every path beneath it into an alias, and three separate review rounds found
/// three different shapes that a blocklist missed:
///
/// - `up -> ..` makes `up/<root name>` a second name for the root, so
///   `remove_dir_all` wiped the workspace;
/// - a workspace root that is *itself* a symlink (roots are stored verbatim —
///   `folder_service::add_folder` never canonicalizes) could be unlinked
///   through that same alias, leaving the folder pointing at nothing;
/// - an intermediate link in the root's own resolution chain
///   (`workspace -> ../hop`, `hop -> actual`) could be removed the same way.
///
/// So rather than enumerate aliases, require the entry to actually live inside
/// the workspace. The *parent* is what gets canonicalized, never the entry
/// itself: all three operations act on a symlink rather than on its target
/// (`remove_file` unlinks, `fs::rename` moves the link), so a link sitting in
/// the workspace stays removable however far away it points — what matters is
/// that its parent is inside the root.
///
/// [`is_within_workspace`] keeps the `folder_links` exemption, so a directory
/// linked in through the "link folder" dialog stays fully mutable — that is
/// the point of a multi-folder workspace. A symlink the user created by hand
/// is browsable and its files open and save (issue #430), but destroying
/// content *through* it needs that explicit authorization.
fn ensure_entry_is_in_workspace(
    root: &Path,
    target: &Path,
    action: &str,
) -> Result<(), AppCommandError> {
    if target == root {
        return Err(AppCommandError::invalid_input(format!(
            "Cannot {action} workspace root"
        )));
    }
    let parent = target.parent().ok_or_else(|| {
        AppCommandError::invalid_input(format!("Cannot {action} a path without a parent"))
    })?;
    // Callers have already established that the entry exists, so a failure here
    // is an unreadable ancestor or a race — neither of which proves the path is
    // safe. Refuse rather than fall through to a destructive operation.
    let canonical_root = std::fs::canonicalize(root).map_err(|e| {
        AppCommandError::io_error("Failed to resolve workspace root").with_detail(e.to_string())
    })?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| {
        AppCommandError::io_error("Failed to resolve target directory").with_detail(e.to_string())
    })?;
    if !is_within_workspace(&canonical_root, &canonical_parent) {
        return Err(AppCommandError::invalid_input(format!(
            "Cannot {action} an entry that resolves outside the workspace"
        )));
    }

    // The check above vouches for the entry's *parent*, which is all a normal
    // entry needs. A symlink needs one more: the root path may be built on it.
    // A root is stored verbatim and can be a link that lives inside its own
    // target (`actual/workspace -> .`, opened as `actual/workspace`), so it
    // shows up as an ordinary row whose parent is legitimately inside the
    // workspace — and unlinking it leaves the folder pointing at nothing while
    // every file survives.
    //
    // Identified by walking the root's own resolution and recording what it
    // passes through — see `root_resolution_links` for why the cheaper
    // approximations are wrong. Links outside the root were already refused
    // above, and a dangling link cannot be part of a root's resolution (the
    // root exists), so it stays deletable.
    if std::fs::symlink_metadata(target)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        let breaks_the_root = entry_identity(target).is_some_and(|(dir, name)| {
            root_resolution_links(root)
                .into_iter()
                .any(|(protected_dir, protected_name)| {
                    protected_dir == dir && protected_name.eq_ignore_ascii_case(&name)
                })
        });
        if breaks_the_root {
            return Err(AppCommandError::invalid_input(format!(
                "Cannot {action} a link the workspace root resolves through"
            )));
        }
    }

    Ok(())
}

fn read_text_full(target: &Path, hard_limit: usize) -> Result<String, AppCommandError> {
    let metadata = std::fs::metadata(target).map_err(AppCommandError::io)?;
    if metadata.len() > hard_limit as u64 {
        return Err(
            AppCommandError::invalid_input("File is too large to open in editor")
                .with_detail(format!("size={}, limit={}", metadata.len(), hard_limit)),
        );
    }

    let bytes = std::fs::read(target).map_err(AppCommandError::io)?;

    if bytes.iter().take(2_048).any(|b| *b == 0) {
        return Err(AppCommandError::invalid_input(
            "Binary files are not supported in preview",
        ));
    }

    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn atomic_write_text(path: &Path, bytes: &[u8]) -> Result<(), AppCommandError> {
    let parent = path.parent().ok_or_else(|| {
        AppCommandError::invalid_input("Cannot determine parent directory for target file")
            .with_detail(path.display().to_string())
    })?;
    if !parent.exists() {
        return Err(
            AppCommandError::not_found("Parent directory does not exist")
                .with_detail(parent.display().to_string()),
        );
    }

    let temp_path = parent.join(format!(
        ".codeg-edit-{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let existing_permissions = std::fs::metadata(path).ok().map(|m| m.permissions());

    let write_result = (|| -> Result<(), AppCommandError> {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(AppCommandError::io)?;

        temp.write_all(bytes).map_err(AppCommandError::io)?;
        temp.sync_all().map_err(AppCommandError::io)?;

        if let Some(permissions) = existing_permissions {
            std::fs::set_permissions(&temp_path, permissions).map_err(AppCommandError::io)?;
        }

        replace_file(&temp_path, path)?;
        sync_directory(parent)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }

    write_result
}

#[cfg(unix)]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    std::fs::rename(temp_path, target_path).map_err(AppCommandError::io)
}

#[cfg(target_os = "windows")]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn to_wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let src = to_wide(temp_path);
    let dst = to_wide(target_path);

    // SAFETY: pointers are valid and UTF-16 null-terminated for the duration of the call.
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if ok == 0 {
        return Err(
            AppCommandError::io_error("Failed to atomically replace file")
                .with_detail(std::io::Error::last_os_error().to_string()),
        );
    }

    Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), AppCommandError> {
    std::fs::rename(temp_path, target_path).map_err(AppCommandError::io)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), AppCommandError> {
    let dir = std::fs::File::open(path).map_err(AppCommandError::io)?;
    dir.sync_all().map_err(AppCommandError::io)
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), AppCommandError> {
    Ok(())
}

async fn run_file_io<T, F>(f: F) -> Result<T, AppCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppCommandError> + Send + 'static,
{
    let _permit = FILE_IO_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| AppCommandError::task_execution_failed("File I/O runtime is unavailable"))?;

    tokio::task::spawn_blocking(f).await.map_err(|e| {
        AppCommandError::task_execution_failed("File I/O task failed").with_detail(e.to_string())
    })?
}

// ─── Directory browser helpers (for web/server mode) ───

/// Whether an entry should be presented to the UI as a directory.
///
/// The directory walkers run with `follow_links` off, so a symlink's own
/// `FileType` is `symlink` — never `dir` — and classifying on it alone turns a
/// symlinked *directory* into a leaf file the panel then refuses to open
/// ("Path is not a file"). Resolving costs one extra `stat`, and only for the
/// entries that actually are links.
fn entry_presents_as_dir(file_type: &std::fs::FileType, path: &Path) -> bool {
    if file_type.is_symlink() {
        path.is_dir()
    } else {
        file_type.is_dir()
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_home_directory() -> Result<String, AppCommandError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| AppCommandError::io_error("Could not determine home directory"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub has_children: bool,
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_directory_entries(path: String) -> Result<Vec<DirectoryEntry>, AppCommandError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppCommandError::io_error("Path is not a directory").with_detail(path));
    }

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    let read_dir = std::fs::read_dir(&root).map_err(|e| {
        AppCommandError::io_error("Failed to read directory").with_detail(e.to_string())
    })?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // Follow symlinks: check if the resolved path is a directory
        if !entry_presents_as_dir(&file_type, &entry.path()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden directories (starting with '.')
        if name.starts_with('.') {
            continue;
        }
        let abs_path = entry.path().to_string_lossy().to_string();

        // Peek into subdirectory to check if it has child directories
        let has_children = match std::fs::read_dir(entry.path()) {
            Ok(sub) => sub.filter_map(|e| e.ok()).any(|e| {
                let ft = e.file_type().ok();
                let is_sub_dir = ft.is_some_and(|ft| entry_presents_as_dir(&ft, &e.path()));
                if !is_sub_dir {
                    return false;
                }
                let sub_name = e.file_name().to_string_lossy().to_string();
                !sub_name.starts_with('.')
            }),
            Err(_) => false,
        };

        entries.push(DirectoryEntry {
            name,
            path: abs_path,
            has_children,
        });
    }

    // Sort by name, case-insensitive
    entries.sort_by_key(|a| a.name.to_lowercase());

    Ok(entries)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Only meaningful when `is_dir` is true.
    pub has_children: bool,
    /// File size in bytes; `None` for directories.
    pub size: Option<u64>,
}

/// List immediate children of `path`, returning both directories and files.
/// Mirrors `list_directory_entries` but does not filter out files, used by the
/// "attach server file" picker.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_directory_with_files(
    path: String,
) -> Result<Vec<DirectoryItem>, AppCommandError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppCommandError::io_error("Path is not a directory").with_detail(path));
    }

    let mut items: Vec<DirectoryItem> = Vec::new();
    let read_dir = std::fs::read_dir(&root).map_err(|e| {
        AppCommandError::io_error("Failed to read directory").with_detail(e.to_string())
    })?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // Follow symlinks for the dir/file classification.
        let is_dir = entry_presents_as_dir(&file_type, &entry.path());
        let abs_path = entry.path().to_string_lossy().to_string();

        let (has_children, size) = if is_dir {
            let has = match std::fs::read_dir(entry.path()) {
                Ok(sub) => sub.filter_map(|e| e.ok()).any(|e| {
                    let sub_name = e.file_name().to_string_lossy().to_string();
                    !sub_name.starts_with('.')
                }),
                Err(_) => false,
            };
            (has, None)
        } else {
            let size = entry.metadata().ok().map(|m| m.len());
            (false, size)
        };

        items.push(DirectoryItem {
            name,
            path: abs_path,
            is_dir,
            has_children,
            size,
        });
    }

    // Sort: directories first, then files; each group by name case-insensitive.
    items.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(items)
}

/// Directories the user linked into `root`, as `(link name, canonical target)`
/// pairs, restricted to entries that are actually a symlink on disk right now.
///
/// Only *authorized* links are returned (see [`crate::folder_links`]): a
/// symlink that merely happens to sit in the tree — the `secrets -> ~/.ssh` a
/// cloned repo might ship — is not one of them and stays unfollowed.
fn authorized_links_in(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return Vec::new();
    };
    let targets = crate::folder_links::canonical_targets_for(&canonical_root);
    if targets.is_empty() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut links = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_symlink() {
            continue;
        }
        let Ok(resolved) = std::fs::canonicalize(entry.path()) else {
            continue;
        };
        if !resolved.is_dir() || !targets.contains(&resolved) {
            continue;
        }
        links.push((entry.file_name().to_string_lossy().to_string(), resolved));
    }
    links.sort_by_key(|a| a.0.to_lowercase());
    links
}

/// Rewrite every `path` in `nodes` (recursively) to `<prefix>/<path>`. Used when
/// a subtree built against a different root is grafted into this one.
fn prefix_tree_paths(nodes: &mut [FileTreeNode], prefix: &str) {
    for node in nodes {
        match node {
            FileTreeNode::File { path, .. } => *path = format!("{prefix}/{path}"),
            FileTreeNode::Dir { path, children, .. } => {
                *path = format!("{prefix}/{path}");
                prefix_tree_paths(children, prefix);
            }
        }
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_file_tree(
    path: String,
    max_depth: Option<usize>,
) -> Result<Vec<FileTreeNode>, AppCommandError> {
    let root = PathBuf::from(&path);
    let depth = max_depth.unwrap_or(usize::MAX);
    let mut visited = HashSet::new();
    build_file_tree(&root, depth, &mut visited)
}

/// Build the tree under `root`, grafting in the subtree of every directory the
/// user linked into it.
///
/// `visited` holds the canonical roots already expanded on this path, so a
/// workspace that links a folder which links back can't recurse forever; a link
/// that would revisit one is left as an ordinary (unexpanded) entry.
fn build_file_tree(
    root: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
) -> Result<Vec<FileTreeNode>, AppCommandError> {
    if let Ok(canonical_root) = std::fs::canonicalize(root) {
        visited.insert(canonical_root);
    }

    // Linked directories are handled separately below so their subtree is
    // grafted in *eagerly*: an authorized link is part of the workspace, and
    // workspace search walks it too. Every other symlinked directory is
    // reported as an (empty) `Dir` in the main walk and expanded lazily.
    let linked: Vec<(String, PathBuf)> = authorized_links_in(root)
        .into_iter()
        .filter(|(_, target)| !visited.contains(target))
        .collect();
    let linked_names: HashSet<String> = linked.iter().map(|(name, _)| name.clone()).collect();

    // Collect all entries, skipping ignored directories
    let mut dir_children: HashMap<PathBuf, Vec<FileTreeNode>> = HashMap::new();
    let mut dir_order: Vec<PathBuf> = Vec::new();
    let mut dir_paths_by_rel: HashMap<String, PathBuf> = HashMap::new();

    for entry in WalkDir::new(root)
        .max_depth(depth)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.depth() == 1 && linked_names.contains(name.as_ref()) {
                return false;
            }
            if entry_presents_as_dir(&e.file_type(), e.path()) {
                !FILE_TREE_IGNORED_DIRS.contains(&name.as_ref())
            } else {
                name != ".DS_Store"
            }
        })
    {
        // Skip unreadable entries (permission errors, races, a symlink loop
        // somewhere in the tree) instead of failing the whole tree: one bad
        // directory should not blank out the file panel.
        let Ok(entry) = entry else { continue };
        let entry_path = entry.path().to_path_buf();

        // Skip the root itself
        if entry_path == root {
            dir_children.entry(root.to_path_buf()).or_default();
            dir_order.push(root.to_path_buf());
            continue;
        }

        let parent = entry_path.parent().unwrap_or(root).to_path_buf();
        let name = entry.file_name().to_string_lossy().to_string();
        let rel_path = entry_path
            .strip_prefix(root)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .replace('\\', "/");

        if entry.file_type().is_symlink() {
            // `WalkDir` never descends through a symlink, so this entry is a
            // leaf of the walk either way. What it must NOT be is a leaf
            // *file*: a symlinked directory is a directory, and reporting it
            // as a file gave the panel a file icon and "Path is not a file"
            // on click (issue #430). Emit an empty `Dir` instead — the panel
            // fills it in on expand via `get_file_tree(<abs link path>, 1)`,
            // which resolves the root link (`WalkDir::follow_root_links`).
            // Doing it lazily is what keeps a `x -> ..` loop or a pnpm
            // symlink farm from exploding here.
            if entry_path.is_dir() {
                dir_children
                    .entry(parent)
                    .or_default()
                    .push(FileTreeNode::Dir {
                        name,
                        path: rel_path,
                        children: vec![],
                        symlink: true,
                    });
            } else {
                // A link to a file, or a dangling one: a leaf file is the
                // honest rendering — there is nothing to expand.
                dir_children
                    .entry(parent)
                    .or_default()
                    .push(FileTreeNode::File {
                        name,
                        path: rel_path,
                    });
            }
        } else if entry.file_type().is_dir() {
            dir_paths_by_rel.insert(rel_path.clone(), entry_path.clone());
            dir_children.entry(entry_path.clone()).or_default();
            dir_order.push(entry_path);
            // Add a placeholder Dir node to parent (children filled later)
            dir_children
                .entry(parent)
                .or_default()
                .push(FileTreeNode::Dir {
                    name,
                    path: rel_path,
                    children: vec![],
                    symlink: false,
                });
        } else {
            dir_children
                .entry(parent)
                .or_default()
                .push(FileTreeNode::File {
                    name,
                    path: rel_path,
                });
        }
    }

    // Build tree bottom-up: process dirs in reverse order so children are ready
    for dir_path in dir_order.iter().rev() {
        let children = dir_children.remove(dir_path).unwrap_or_default();

        // Sort: dirs first, then files, alphabetically within each group
        let mut dirs: Vec<FileTreeNode> = Vec::new();
        let mut files: Vec<FileTreeNode> = Vec::new();
        for child in children {
            match &child {
                FileTreeNode::Dir { .. } => dirs.push(child),
                FileTreeNode::File { .. } => files.push(child),
            }
        }
        dirs.sort_by(|a, b| {
            let a_name = match a {
                FileTreeNode::Dir { name, .. } => name,
                _ => unreachable!(),
            };
            let b_name = match b {
                FileTreeNode::Dir { name, .. } => name,
                _ => unreachable!(),
            };
            a_name.to_lowercase().cmp(&b_name.to_lowercase())
        });
        files.sort_by(|a, b| {
            let a_name = match a {
                FileTreeNode::File { name, .. } => name,
                _ => unreachable!(),
            };
            let b_name = match b {
                FileTreeNode::File { name, .. } => name,
                _ => unreachable!(),
            };
            a_name.to_lowercase().cmp(&b_name.to_lowercase())
        });

        let mut sorted: Vec<FileTreeNode> = Vec::with_capacity(dirs.len() + files.len());

        // Fill dir children from the map
        for d in dirs {
            if let FileTreeNode::Dir {
                name,
                path: rel_path,
                symlink,
                ..
            } = d
            {
                // A symlinked directory was never registered in
                // `dir_paths_by_rel` / `dir_children`, so the lookup misses and
                // it keeps the empty child list the panel lazy-loads into.
                let full_path = dir_paths_by_rel
                    .get(&rel_path)
                    .cloned()
                    .unwrap_or_else(|| root.join(Path::new(&rel_path)));
                let sub_children = dir_children.remove(&full_path).unwrap_or_default();
                sorted.push(FileTreeNode::Dir {
                    name,
                    path: rel_path,
                    children: sub_children,
                    symlink,
                });
            }
        }
        sorted.extend(files);

        dir_children.insert(dir_path.clone(), sorted);
    }

    let mut nodes = dir_children.remove(root).unwrap_or_default();

    if linked.is_empty() {
        return Ok(nodes);
    }

    // Graft each linked directory in as a real `Dir`, with its own subtree
    // built through the link. `max_depth == 1` (the panel's lazy load) yields
    // an empty child list, which the frontend already treats as "not loaded
    // yet" and fills in when the row is expanded.
    let child_depth = depth.saturating_sub(1);
    let mut linked_nodes: Vec<FileTreeNode> = Vec::with_capacity(linked.len());
    for (name, _) in linked {
        let link_path = root.join(&name);
        // The recursive call is rooted at the link, so its paths come back
        // relative to the *linked* directory. Re-anchor them to the workspace
        // root, or the panel would resolve `inside.txt` against the root
        // instead of `api/inside.txt`.
        let prefix = name.replace('\\', "/");
        let children = if child_depth == 0 {
            Vec::new()
        } else {
            let mut sub = build_file_tree(&link_path, child_depth, visited).unwrap_or_default();
            prefix_tree_paths(&mut sub, &prefix);
            sub
        };
        linked_nodes.push(FileTreeNode::Dir {
            name,
            path: prefix,
            children,
            symlink: true,
        });
    }

    // Re-establish the "directories first, then files, each alphabetical"
    // ordering the walk produced before the graft.
    let split = nodes
        .iter()
        .position(|n| matches!(n, FileTreeNode::File { .. }))
        .unwrap_or(nodes.len());
    let files = nodes.split_off(split);
    nodes.extend(linked_nodes);
    nodes.sort_by(|a, b| {
        let key = |n: &FileTreeNode| match n {
            FileTreeNode::Dir { name, .. } | FileTreeNode::File { name, .. } => name.to_lowercase(),
        };
        key(a).cmp(&key(b))
    });
    nodes.extend(files);

    Ok(nodes)
}

/// Flat, gitignore-aware listing of every file and directory under `path`, for
/// fuzzy file search. Unlike [`get_file_tree`], ignored directories
/// (`node_modules`, `target`, `dist`, …) are pruned *during* the walk, so no
/// depth cap is needed: deep files stay reachable while the heavy trees are
/// never descended and the payload stays small. Gitignore handling that used to
/// run client-side now happens here at native speed in a single pass.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_workspace_files(
    path: String,
) -> Result<Vec<WorkspaceFileEntry>, AppCommandError> {
    let root = PathBuf::from(&path);
    // Linked directories are walked separately below, rooted at the link so
    // their own `.gitignore` applies. Excluded from the main pass because the
    // walker reports a symlink as a leaf file.
    let linked = authorized_links_in(&root);
    let linked_names: HashSet<String> = linked.iter().map(|(name, _)| name.clone()).collect();

    // Conservative gitignore parity with the previous client-side pass: respect
    // in-tree `.gitignore`/`.ignore`/`.git/info/exclude`, but not the global
    // gitignore or parent-directory ignores (the workspace root is the
    // boundary). `require_git(false)` keeps `.gitignore` effective even outside
    // a git repo. `hidden(false)` keeps dotfiles visible. The `filter_entry`
    // mirrors `get_file_tree`'s hardcoded ignores exactly.
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .parents(false)
        .ignore(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(move |e| {
            let name = e.file_name().to_string_lossy();
            if e.depth() == 1 && linked_names.contains(name.as_ref()) {
                return false;
            }
            if e.file_type()
                .is_some_and(|t| entry_presents_as_dir(&t, e.path()))
            {
                !FILE_TREE_IGNORED_DIRS.contains(&name.as_ref())
            } else {
                name != ".DS_Store"
            }
        })
        .build();

    let mut entries: Vec<WorkspaceFileEntry> = Vec::new();
    for result in walker {
        // Skip unreadable entries (permission errors, transient races) rather
        // than failing the whole search.
        let Ok(entry) = result else { continue };
        let entry_path = entry.path();

        // Skip the root directory itself.
        if entry_path == root {
            continue;
        }

        // A symlinked directory is reported as a directory (the walker is not
        // following it — only its own contents stay out of the index).
        let is_dir = entry
            .file_type()
            .is_some_and(|t| entry_presents_as_dir(&t, entry_path));
        let name = entry.file_name().to_string_lossy().to_string();
        let rel_path = entry_path
            .strip_prefix(&root)
            .unwrap_or(entry_path)
            .to_string_lossy()
            .replace('\\', "/");

        entries.push(WorkspaceFileEntry {
            name,
            path: rel_path,
            kind: if is_dir {
                WorkspaceEntryKind::Dir
            } else {
                WorkspaceEntryKind::File
            },
        });
    }

    for (link_name, target) in linked {
        entries.push(WorkspaceFileEntry {
            name: link_name.clone(),
            path: link_name.clone(),
            kind: WorkspaceEntryKind::Dir,
        });
        // Rooted at the resolved target so the linked project's own ignore
        // files apply, then re-prefixed with the link name so every path stays
        // relative to the workspace root and resolves back through the link.
        entries.extend(list_files_under(&target, &link_name));
    }

    Ok(entries)
}

/// Flat listing of `root`, with every path prefixed by `prefix/`. Shares the
/// ignore configuration of [`list_workspace_files`]; nested symlinks are not
/// followed, so this cannot recurse.
fn list_files_under(root: &Path, prefix: &str) -> Vec<WorkspaceFileEntry> {
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .ignore(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.file_type()
                .is_some_and(|t| entry_presents_as_dir(&t, e.path()))
            {
                !FILE_TREE_IGNORED_DIRS.contains(&name.as_ref())
            } else {
                name != ".DS_Store"
            }
        })
        .build();

    let mut entries = Vec::new();
    for result in walker {
        let Ok(entry) = result else { continue };
        let entry_path = entry.path();
        if entry_path == root {
            continue;
        }
        let Ok(rel) = entry_path.strip_prefix(root) else {
            continue;
        };
        let is_dir = entry
            .file_type()
            .is_some_and(|t| entry_presents_as_dir(&t, entry_path));
        entries.push(WorkspaceFileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: format!("{prefix}/{}", rel.to_string_lossy().replace('\\', "/")),
            kind: if is_dir {
                WorkspaceEntryKind::Dir
            } else {
                WorkspaceEntryKind::File
            },
        });
    }
    entries
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_base64(
    path: String,
    max_bytes: Option<usize>,
) -> Result<String, AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("Path cannot be empty"));
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    let limit = max_bytes
        .unwrap_or(FILE_BASE64_DEFAULT_MAX_BYTES)
        .clamp(4_096, FILE_BASE64_MAX_BYTES);

    run_file_io(move || {
        let metadata = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        if metadata.len() > limit as u64 {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        let bytes = std::fs::read(&target).map_err(AppCommandError::io)?;
        if bytes.len() > limit {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
}

/// Open a file for reading, refusing a final-component symlink (unix) so a
/// path validated by canonicalization cannot be redirected through a symlink
/// swapped in afterward.
#[cfg(unix)]
pub(crate) fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
pub(crate) fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_FLAG_OPEN_REPARSE_POINT opens the reparse point itself instead of
    // following it, so a symlink/junction swapped in after validation is opened
    // (and then rejected by the is_file() check) rather than followed outside
    // the workspace root.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

/// Like `read_file_base64`, but confined to a workspace root: the path is
/// relative to `root_path` and is canonicalized (resolving symlinks) so it can
/// never read outside the workspace. Used by the HTML preview to inline local
/// sub-resources without exposing the unconfined `read_file_base64` to crafted
/// markup (e.g. a symlink pointing at `/etc/passwd`).
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_workspace_file_base64(
    root_path: String,
    path: String,
    max_bytes: Option<usize>,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    let limit = max_bytes
        .unwrap_or(FILE_BASE64_DEFAULT_MAX_BYTES)
        .clamp(4_096, FILE_BASE64_MAX_BYTES);

    run_file_io(move || {
        use std::io::Read;
        // Canonicalize and confine, then open a single handle (O_NOFOLLOW on
        // unix) and do metadata + read on the fd. This closes the check-then-
        // read race: the original `target` symlink can't be re-resolved (we use
        // the canonical path), a final-component symlink swapped in after the
        // check makes the open fail, and metadata/read never re-look-up the path.
        let canonical_root =
            std::fs::canonicalize(&root).map_err(AppCommandError::io)?;
        let canonical_target =
            std::fs::canonicalize(&target).map_err(AppCommandError::io)?;
        if !is_within_workspace(&canonical_root, &canonical_target) {
            return Err(AppCommandError::invalid_input(
                "Path is outside workspace root",
            ));
        }
        let mut file =
            open_no_follow(&canonical_target).map_err(AppCommandError::io)?;
        let metadata = file.metadata().map_err(AppCommandError::io)?;
        if !metadata.is_file() {
            return Err(AppCommandError::invalid_input("Path is not a file"));
        }
        if metadata.len() > limit as u64 {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        // take(limit + 1) bounds the read even if the file grows after fstat.
        let mut bytes = Vec::new();
        Read::take(&mut file, limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(AppCommandError::io)?;
        if bytes.len() > limit {
            return Err(
                AppCommandError::invalid_input("File is too large to attach")
                    .with_detail(format!("max_bytes={limit}")),
            );
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_preview(
    root_path: String,
    path: String,
) -> Result<FilePreviewContent, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_user_navigable_path(&root, &target)?;
        let content = read_text_full(&target, FILE_OPEN_HARD_LIMIT)?;
        Ok(FilePreviewContent {
            path: path_for_response,
            content,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_file_for_edit(
    root_path: String,
    path: String,
) -> Result<FileEditContent, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_user_navigable_path(&root, &target)?;
        let metadata = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        let content = read_text_full(&target, FILE_OPEN_HARD_LIMIT)?;
        let readonly = metadata.permissions().readonly();
        let mtime_ms = file_mtime_ms(&metadata);
        let etag = compute_etag(content.as_bytes(), &metadata);
        let line_ending = detect_line_ending(content.as_bytes());

        Ok(FileEditContent {
            path: path_for_response,
            content,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_file_content(
    root_path: String,
    path: String,
    content: String,
    expected_etag: Option<String>,
) -> Result<FileSaveResult, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }
    if content.len() > FILE_SAVE_HARD_LIMIT {
        return Err(
            AppCommandError::invalid_input("File is too large to save in editor")
                .with_detail(format!("max_bytes={FILE_SAVE_HARD_LIMIT}")),
        );
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    let path_for_response = path.clone();

    run_file_io(move || {
        ensure_user_navigable_path(&root, &target)?;

        let link_meta = std::fs::symlink_metadata(&target).map_err(AppCommandError::io)?;
        if link_meta.file_type().is_symlink() {
            return Err(AppCommandError::invalid_input(
                "Saving symlink targets is not supported",
            ));
        }

        let before_meta = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        if before_meta.permissions().readonly() {
            return Err(AppCommandError::permission_denied("File is read-only"));
        }

        let current_bytes = std::fs::read(&target).map_err(AppCommandError::io)?;
        if current_bytes.iter().take(2_048).any(|b| *b == 0) {
            return Err(AppCommandError::invalid_input(
                "Binary files are not supported in editor",
            ));
        }
        let current_etag = compute_etag(&current_bytes, &before_meta);
        if let Some(expected) = expected_etag {
            if expected != current_etag {
                return Err(AppCommandError::invalid_input(
                    "File has changed on disk. Reload the file before saving.",
                ));
            }
        }

        atomic_write_text(&target, content.as_bytes())?;

        let after_meta = std::fs::metadata(&target).map_err(AppCommandError::io)?;
        let etag = compute_etag(content.as_bytes(), &after_meta);
        let mtime_ms = file_mtime_ms(&after_meta);
        let readonly = after_meta.permissions().readonly();
        let line_ending = detect_line_ending(content.as_bytes());

        Ok(FileSaveResult {
            path: path_for_response,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

fn build_local_copy_file_name(original_name: &str, attempt: usize) -> String {
    let original = Path::new(original_name);
    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(original_name);
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty());

    let suffix = if attempt <= 1 {
        ".local".to_string()
    } else {
        format!(".local.{}", attempt)
    };

    match extension {
        Some(ext) => format!("{stem}{suffix}.{ext}"),
        None => format!("{stem}{suffix}"),
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_file_copy(
    root_path: String,
    path: String,
    content: String,
) -> Result<FileSaveResult, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }
    if content.len() > FILE_SAVE_HARD_LIMIT {
        return Err(
            AppCommandError::invalid_input("File is too large to save in editor")
                .with_detail(format!("max_bytes={FILE_SAVE_HARD_LIMIT}")),
        );
    }

    let source = resolve_tree_path(&root, &path)?;
    if !source.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !source.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }

    run_file_io(move || {
        ensure_user_navigable_path(&root, &source)?;

        let source_meta = std::fs::symlink_metadata(&source).map_err(AppCommandError::io)?;
        if source_meta.file_type().is_symlink() {
            return Err(AppCommandError::invalid_input(
                "Saving symlink targets is not supported",
            ));
        }

        let parent = source
            .parent()
            .ok_or_else(|| {
                AppCommandError::invalid_input("Cannot determine parent directory for source file")
            })?
            .to_path_buf();
        ensure_user_navigable_path(&root, &parent)?;

        let source_name = source
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .ok_or_else(|| AppCommandError::invalid_input("Cannot determine source file name"))?;

        let mut created_path: Option<PathBuf> = None;
        for attempt in 1..=9_999 {
            let candidate_name = build_local_copy_file_name(&source_name, attempt);
            let candidate_path = parent.join(candidate_name);
            if candidate_path.exists() {
                continue;
            }
            created_path = Some(candidate_path);
            break;
        }

        let created_path = created_path.ok_or_else(|| {
            AppCommandError::already_exists(
                "Unable to create copy file: too many existing local copies",
            )
        })?;
        atomic_write_text(&created_path, content.as_bytes())?;

        let metadata = std::fs::metadata(&created_path).map_err(AppCommandError::io)?;
        let etag = compute_etag(content.as_bytes(), &metadata);
        let mtime_ms = file_mtime_ms(&metadata);
        let readonly = metadata.permissions().readonly();
        let line_ending = detect_line_ending(content.as_bytes());
        let rel_path = created_path
            .strip_prefix(&root)
            .map_err(|e| {
                AppCommandError::invalid_input("Failed to compute relative path for copy")
                    .with_detail(e.to_string())
            })?
            .to_string_lossy()
            .replace('\\', "/");

        Ok(FileSaveResult {
            path: rel_path,
            etag,
            mtime_ms,
            readonly,
            line_ending,
        })
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn rename_file_tree_entry(
    root_path: String,
    path: String,
    new_name: String,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("Target file does not exist"));
    }
    ensure_entry_is_in_workspace(&root, &target, "rename")?;

    let parent = target
        .parent()
        .ok_or_else(|| AppCommandError::invalid_input("Cannot rename path without parent"))?;
    let validated_name = validate_new_name(&new_name)?;
    let next_path = parent.join(validated_name);

    if next_path == target {
        return Ok(path);
    }
    if next_path.exists() {
        return Err(AppCommandError::already_exists(
            "A file with this name already exists",
        ));
    }

    std::fs::rename(&target, &next_path).map_err(AppCommandError::io)?;

    let rel = next_path
        .strip_prefix(&root)
        .map_err(|e| {
            AppCommandError::invalid_input("Failed to compute relative path")
                .with_detail(e.to_string())
        })?
        .to_string_lossy()
        .to_string();
    Ok(rel)
}

/// Move a file/directory into a different directory of the same workspace,
/// keeping its name. `source_path` and `dest_dir` are both workspace-relative
/// (forward slashes); `dest_dir` is `""` for the workspace root. Returns the new
/// workspace-relative path of the moved entry.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn move_file_tree_entry(
    root_path: String,
    source_path: String,
    dest_dir: String,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let source = resolve_tree_path(&root, &source_path)?;
    // `symlink_metadata` doesn't follow the final component, so a (possibly
    // dangling) symlink entry the tree still shows counts as existing — and
    // `fs::rename` moves the link itself rather than whatever it points at.
    match std::fs::symlink_metadata(&source) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppCommandError::not_found("Source file does not exist"));
        }
        Err(e) => return Err(AppCommandError::io(e)),
    }
    ensure_entry_is_in_workspace(&root, &source, "move")?;

    let dest = resolve_tree_path(&root, &dest_dir)?;
    if !dest.is_dir() {
        return Err(AppCommandError::invalid_input(
            "Destination is not a directory",
        ));
    }
    // The destination is a directory, so it is confined directly rather than
    // through its parent — otherwise a link could be used to move entries out
    // of the workspace entirely.
    {
        let canonical_root = std::fs::canonicalize(&root).map_err(|e| {
            AppCommandError::io_error("Failed to resolve workspace root").with_detail(e.to_string())
        })?;
        let canonical_dest = std::fs::canonicalize(&dest).map_err(|e| {
            AppCommandError::io_error("Failed to resolve destination directory")
                .with_detail(e.to_string())
        })?;
        if !is_within_workspace(&canonical_root, &canonical_dest) {
            return Err(AppCommandError::invalid_input(
                "Destination resolves outside the workspace",
            ));
        }
    }

    // Reject moving a directory into itself or one of its own descendants —
    // `starts_with` is component-wise, so `src` is not mistaken for `src-utils`.
    if dest == source || dest.starts_with(&source) {
        return Err(AppCommandError::invalid_input(
            "Cannot move a directory into itself",
        ));
    }

    let name = source
        .file_name()
        .ok_or_else(|| AppCommandError::invalid_input("Cannot move path without a name"))?;
    let target = dest.join(name);

    // Dropping onto the current parent is a no-op — report the unchanged path
    // rather than erroring so the UI can simply do nothing.
    if target == source {
        return Ok(source_path);
    }
    // Collision check via `symlink_metadata`: a same-name entry of ANY kind —
    // including a dangling symlink, which `Path::exists()` reports as absent —
    // must block the move so `fs::rename` can't silently clobber it.
    match std::fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(AppCommandError::already_exists(
                "An entry with this name already exists in the destination",
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(AppCommandError::io(e)),
    }

    std::fs::rename(&source, &target).map_err(AppCommandError::io)?;

    let rel = target
        .strip_prefix(&root)
        .map_err(|e| {
            AppCommandError::invalid_input("Failed to compute relative path")
                .with_detail(e.to_string())
        })?
        .to_string_lossy()
        .to_string();
    Ok(rel)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_file_tree_entry(
    root_path: String,
    path: String,
) -> Result<(), AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let target = resolve_tree_path(&root, &path)?;
    // `Path::exists` follows symlinks and silently returns false on a
    // dangling link or any I/O error along the resolve chain, which gave
    // us "Target file does not exist" toasts even for files that were
    // physically present (case-only mismatches against a case-preserving
    // FS, NFD/NFC mismatches on macOS, files under a non-traversable
    // ancestor). `symlink_metadata` only stats the leaf and surfaces the
    // real OS error code in `detail`, which is what we want to diagnose
    // those reports.
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppCommandError::not_found("Target file does not exist")
                .with_detail(format!("resolved={} relative={}", target.display(), path)));
        }
        Err(err) => {
            return Err(
                AppCommandError::io_error("Failed to stat target").with_detail(format!(
                    "resolved={} relative={} error={}",
                    target.display(),
                    path,
                    err
                )),
            );
        }
    };
    ensure_entry_is_in_workspace(&root, &target, "delete")?;
    if meta.file_type().is_symlink() {
        // Unlink the entry itself, never what it points at. `remove_file`
        // covers unix and Windows *file* links; a Windows directory symlink or
        // junction only goes through `remove_dir`, which is why the fallback
        // exists (same shape as `folder_links::remove_link_entry`). The first
        // error is the one reported: on unix `remove_dir` on a symlink fails
        // with a misleading ENOTDIR that hides the real cause.
        std::fs::remove_file(&target).or_else(|first| {
            std::fs::remove_dir(&target).map_err(|_| AppCommandError::io(first))
        })?;
    } else if meta.is_dir() {
        std::fs::remove_dir_all(&target).map_err(AppCommandError::io)?;
    } else {
        std::fs::remove_file(&target).map_err(AppCommandError::io)?;
    }

    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_file_tree_entry(
    root_path: String,
    path: String,
    name: String,
    kind: String,
) -> Result<String, AppCommandError> {
    let root = PathBuf::from(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }

    let validated_name = validate_new_name(&name)?;

    let parent_dir = if path.is_empty() {
        root.clone()
    } else {
        let resolved = resolve_tree_path(&root, &path)?;
        if !resolved.exists() {
            return Err(AppCommandError::not_found("Parent path does not exist"));
        }
        if resolved.is_file() {
            resolved.parent().map(|p| p.to_path_buf()).ok_or_else(|| {
                AppCommandError::invalid_input("Cannot determine parent directory")
            })?
        } else {
            resolved
        }
    };

    let target = parent_dir.join(validated_name);
    if target.exists() {
        return Err(AppCommandError::already_exists(
            "A file or directory with this name already exists",
        ));
    }

    match kind.as_str() {
        "file" => {
            std::fs::File::create(&target).map_err(AppCommandError::io)?;
        }
        "dir" => {
            std::fs::create_dir(&target).map_err(AppCommandError::io)?;
        }
        _ => {
            return Err(AppCommandError::invalid_input(
                "Kind must be 'file' or 'dir'",
            ));
        }
    }

    let rel = target
        .strip_prefix(&root)
        .map_err(|e| {
            AppCommandError::invalid_input("Failed to compute relative path")
                .with_detail(e.to_string())
        })?
        .to_string_lossy()
        .to_string();
    Ok(rel)
}

// A Tauri command deserializes each named arg from JS, so the query knobs stay
// flat positional params rather than a bundled options struct.
#[allow(clippy::too_many_arguments)]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_log(
    path: String,
    limit: Option<u32>,
    branch: Option<String>,
    remote: Option<String>,
    skip: Option<u32>,
    author: Option<String>,
    all_branches: Option<bool>,
    with_files: Option<bool>,
) -> Result<GitLogResult, AppCommandError> {
    ensure_git_repo(&path)?;

    const COMMIT_META_PREFIX: &str = "__COMMIT__\0";
    const MESSAGE_END_MARKER: &str = "__COMMIT_MESSAGE_END__";

    let all_branches = all_branches.unwrap_or(false);
    // Per-commit file changes (`--raw --numstat`) diff every commit against its
    // parent, which dominates the cost of a page. Callers that only need the
    // commit list (the log tab, which lazy-loads a commit's files on expand via
    // git_commit_files) pass with_files=false to skip it. Defaults to true for
    // back-compat (e.g. the push window renders files inline).
    let with_files = with_files.unwrap_or(true);

    // Offset for paginated (infinite-scroll) loading: the frontend requests
    // successive pages by their running commit count.
    let skip = skip.unwrap_or(0);
    let limit_str = format!("-{}", limit.unwrap_or(100));
    let mut args = vec![
        "log".to_string(),
        limit_str,
        format!("--format=__COMMIT__%x00%h%x00%H%x00%an%x00%aI%n%B%n{MESSAGE_END_MARKER}"),
    ];
    if with_files {
        args.push("--raw".to_string());
        args.push("--numstat".to_string());
        args.push("--no-renames".to_string());
    }
    if skip > 0 {
        args.push(format!("--skip={}", skip));
    }
    // Author filter (IDEA-style "User" filter): match the EXACT author name via
    // an anchored, BRE-escaped pattern (see git_author_match_pattern) so e.g.
    // "Alice" does not also match "Alice Smith" or a commit whose email contains
    // "alice". `--basic-regexp` pins the pattern language so a user's
    // grep.patternType config can't reinterpret it. Must precede the
    // revision/pathspec arg below.
    if let Some(ref a) = author {
        if !a.is_empty() {
            args.push("--basic-regexp".to_string());
            args.push(format!("--author={}", git_author_match_pattern(a)));
        }
    }
    // `--all` (all refs) is the default "all branches" view; an explicit branch
    // narrows to that ref. `--all` wins if both are somehow set.
    if all_branches {
        args.push("--all".to_string());
    } else if let Some(ref b) = branch {
        args.push(b.clone());
    }
    let output = crate::process::tokio_command("git")
        .args(["-c", "core.quotePath=false"])
        .args(&args)
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        // Empty repo (no commits yet) — return empty list instead of error
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        if stderr_str.contains("does not have any commits yet")
            || stderr_str.contains("unknown revision or path not in the working tree")
        {
            return Ok(GitLogResult {
                entries: Vec::new(),
                has_upstream: false,
            });
        }
        return Err(git_command_error("log", &output.stderr));
    }

    let mut entries = Vec::<GitLogEntry>::new();
    let mut current: Option<GitLogEntryBuilder> = None;
    let mut reading_message = false;

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(meta) = line.strip_prefix(COMMIT_META_PREFIX) {
            if let Some(entry) = current.take() {
                entries.push(entry.finish());
            }

            let parts: Vec<&str> = meta.splitn(4, '\0').collect();
            if parts.len() == 4 {
                current = Some(GitLogEntryBuilder::new(parts));
                reading_message = true;
            } else {
                reading_message = false;
            }
            continue;
        }

        let Some(entry) = current.as_mut() else {
            continue;
        };

        if reading_message {
            if line == MESSAGE_END_MARKER {
                reading_message = false;
                entry.finalize_message();
            } else {
                entry.push_message_line(line);
            }
            continue;
        }

        if line.is_empty() {
            continue;
        }

        if line.starts_with(':') {
            if let Some((status, file_path)) = parse_raw_file_line(line) {
                let file = entry.get_or_insert_file(file_path);
                file.status = status;
            }
            continue;
        }

        if let Some((additions, deletions, file_path)) = parse_numstat_file_line(line) {
            let file = entry.get_or_insert_file(file_path);
            file.additions = additions;
            file.deletions = deletions;
        }
    }

    if let Some(entry) = current {
        entries.push(entry.finish());
    }

    // Cover the full fetched range (skip + limit) so pushed status stays correct
    // on deeper pages — get_unpushed_hashes caps its rev-list to this count. The
    // all-branches path passes `author` through so the same filter narrows that
    // window (a sparse match still lands inside it); the single-branch upstream
    // paths below are not author-filtered, so a matched commit deep past the
    // window there can still report an inaccurate badge — an accepted limit for
    // that (rarer) branch+author combination.
    let log_limit = skip.saturating_add(limit.unwrap_or(100));
    let (unpushed_hashes, has_upstream) = get_unpushed_hashes(
        &path,
        log_limit,
        remote.as_deref(),
        branch.as_deref(),
        all_branches,
        author.as_deref(),
    )
    .await
    .unwrap_or((None, false));
    for entry in entries.iter_mut() {
        entry.pushed = unpushed_hashes
            .as_ref()
            .map(|hashes| !hashes.contains(&entry.full_hash));
    }

    Ok(GitLogResult {
        entries,
        has_upstream,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_commit_branches(
    path: String,
    commit: String,
) -> Result<Vec<String>, AppCommandError> {
    ensure_git_repo(&path)?;

    let contains_arg = format!("--contains={commit}");
    let output = crate::process::tokio_command("git")
        .args([
            "for-each-ref",
            &contains_arg,
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("for-each-ref", &output.stderr));
    }

    let mut seen = HashSet::new();
    let mut branches = Vec::new();

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let branch = line.trim();
        if branch.is_empty() || branch.ends_with("/HEAD") {
            continue;
        }

        if seen.insert(branch.to_string()) {
            branches.push(branch.to_string());
        }
    }

    branches.sort();
    Ok(branches)
}

/// Build a `git log --author` pattern matching EXACTLY the given author name
/// (`%an`) — not a substring, and not a match inside the email. The name is
/// escaped for basic regular expressions (BRE) and anchored to the start of the
/// "Name <email>" author ident with a trailing " <", so "Alice" matches
/// "Alice <…>" but not "Alice Smith <…>" nor "Bob <alice@…>". Pair with
/// `--basic-regexp` so the escaping is interpreted as BRE regardless of the
/// user's grep.patternType config. Note `|`, `+`, `?`, `(`, `)`, `{`, `}` are
/// literal in BRE, so they are intentionally left unescaped. Pure — unit-tested
/// without a repo.
fn git_author_match_pattern(name: &str) -> String {
    let mut escaped = String::with_capacity(name.len() + 4);
    for ch in name.chars() {
        if matches!(ch, '\\' | '.' | '*' | '[' | ']' | '^' | '$') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    format!("^{escaped} <")
}

/// The configured commit author name (`git config user.name`) so the author
/// filter can offer a pinned "me" quick-select. Best-effort: absent/blank →
/// None. Cheap (no history walk), unlike a full repo author scan.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_current_user(path: String) -> Result<Option<String>, AppCommandError> {
    ensure_git_repo(&path)?;

    let output = crate::process::tokio_command("git")
        .args(["config", "user.name"])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Ok(None);
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if name.is_empty() { None } else { Some(name) })
}

/// Parse `git shortlog -sne` output into a de-duplicated, frequency-ordered list
/// of author names whose name contains `query` (case-insensitive). shortlog lines
/// look like `"   123\tAlice <alice@example.com>"` (a padded count, a tab, then
/// `Name <email>`); we return just the display names. Pure — unit-tested without
/// a repo.
fn filter_shortlog_authors(stdout: &str, query: &str, limit: usize) -> Vec<String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in stdout.lines() {
        // Strip the leading count column ("   123\t").
        let rest = match line.split_once('\t') {
            Some((_count, rest)) => rest.trim(),
            None => continue,
        };
        // Drop the trailing " <email>" so we key on the display name only (the
        // author filter matches names, see git_author_match_pattern).
        let name = match rest.rsplit_once(" <") {
            Some((name, _email)) => name.trim(),
            None => rest,
        };
        if name.is_empty() || !name.to_lowercase().contains(&needle) {
            continue;
        }
        // Same author under two emails collapses to one name (first = most
        // frequent, since shortlog is count-sorted).
        if seen.insert(name.to_string()) {
            out.push(name.to_string());
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

/// On-demand author search for the log filter: real commit authors whose name
/// matches `query` (case-insensitive substring), most-active first. Backed by
/// `git shortlog -s -n -e --all` (dedup + counts across all refs). Unlike a full
/// upfront author scan (removed for perf), this runs only while the user is
/// actively typing in the filter box (debounced client-side), so the history walk
/// is paid on demand.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_search_authors(
    path: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<String>, AppCommandError> {
    ensure_git_repo(&path)?;

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // `--all` summarizes every ref; `-s -n -e` = counts only, sorted by count
    // desc, identities distinguished by email. stdin is nulled so shortlog never
    // blocks trying to read a revision range from a (possibly piped) stdin.
    let output = crate::process::tokio_command("git")
        .args(["shortlog", "-s", "-n", "-e", "--all"])
        .current_dir(&path)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("shortlog", &output.stderr));
    }

    let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
    Ok(filter_shortlog_authors(
        &String::from_utf8_lossy(&output.stdout),
        trimmed,
        limit,
    ))
}

/// File changes for a single commit, loaded on demand when a commit row is
/// expanded (git_log with with_files=false omits these to keep the list fast).
/// Same `--raw`/`--numstat` shape as git_log so the same parsing applies.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn git_commit_files(
    path: String,
    commit: String,
) -> Result<Vec<GitLogFileChange>, AppCommandError> {
    ensure_git_repo(&path)?;

    // `--first-parent` keeps merge commits on a normal (first-parent) diff
    // instead of git show's default combined (`--cc`) output, whose `--raw`
    // section uses a different shape that would mis-parse (files defaulting to
    // "M"). This matches the first-parent diff git_log itself produces.
    let output = crate::process::tokio_command("git")
        .args(["-c", "core.quotePath=false"])
        .args([
            "show",
            "--format=",
            "--first-parent",
            "--raw",
            "--numstat",
            "--no-renames",
            &commit,
        ])
        .current_dir(&path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    if !output.status.success() {
        return Err(git_command_error("show", &output.stderr));
    }

    // `git show` for a single commit emits the same `:`-prefixed raw lines and
    // numstat lines git_log parses; reuse the same builder to merge them.
    let mut builder = GitLogFilesBuilder::default();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.is_empty() {
            continue;
        }
        if line.starts_with(':') {
            if let Some((status, file_path)) = parse_raw_file_line(line) {
                builder.get_or_insert_file(file_path).status = status;
            }
            continue;
        }
        if let Some((additions, deletions, file_path)) = parse_numstat_file_line(line) {
            let file = builder.get_or_insert_file(file_path);
            file.additions = additions;
            file.deletions = deletions;
        }
    }

    Ok(builder.files)
}

/// Accumulates a commit's file changes, merging the `--raw` (status) and
/// `--numstat` (+/-) lines that describe the same path. Shared by git_log's
/// per-commit builder and the standalone git_commit_files command.
#[derive(Default)]
struct GitLogFilesBuilder {
    files: Vec<GitLogFileChange>,
    index_by_path: HashMap<String, usize>,
}

impl GitLogFilesBuilder {
    fn get_or_insert_file(&mut self, path: String) -> &mut GitLogFileChange {
        let index = if let Some(index) = self.index_by_path.get(&path) {
            *index
        } else {
            self.files.push(GitLogFileChange {
                path: path.clone(),
                status: "M".to_string(),
                additions: 0,
                deletions: 0,
            });
            let index = self.files.len() - 1;
            self.index_by_path.insert(path, index);
            index
        };

        &mut self.files[index]
    }
}

struct GitLogEntryBuilder {
    hash: String,
    full_hash: String,
    author: String,
    date: String,
    message: String,
    files: GitLogFilesBuilder,
}

impl GitLogEntryBuilder {
    fn new(parts: Vec<&str>) -> Self {
        Self {
            hash: parts[0].to_string(),
            full_hash: parts[1].to_string(),
            author: parts[2].to_string(),
            date: parts[3].to_string(),
            message: String::new(),
            files: GitLogFilesBuilder::default(),
        }
    }

    fn push_message_line(&mut self, line: &str) {
        if !self.message.is_empty() {
            self.message.push('\n');
        }
        self.message.push_str(line);
    }

    fn finalize_message(&mut self) {
        self.message = self.message.trim_end_matches('\n').to_string();
    }

    fn get_or_insert_file(&mut self, path: String) -> &mut GitLogFileChange {
        self.files.get_or_insert_file(path)
    }

    fn finish(self) -> GitLogEntry {
        GitLogEntry {
            hash: self.hash,
            full_hash: self.full_hash,
            author: self.author,
            date: self.date,
            message: self.message,
            files: self.files.files,
            pushed: None,
        }
    }
}

fn parse_raw_file_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.split('\t');
    let meta = parts.next()?;
    let file_path = unquote_git_path(parts.next()?);
    let status = meta
        .split_whitespace()
        .last()
        .and_then(|v| v.chars().next())
        .unwrap_or('M')
        .to_string();
    Some((status, file_path))
}

fn parse_numstat_file_line(line: &str) -> Option<(u32, u32, String)> {
    let mut parts = line.splitn(3, '\t');
    let additions = parse_numstat_count(parts.next()?);
    let deletions = parse_numstat_count(parts.next()?);
    let file_path = unquote_git_path(parts.next()?);
    Some((additions, deletions, file_path))
}

fn parse_numstat_count(value: &str) -> u32 {
    if value == "-" {
        return 0;
    }

    value.parse::<u32>().unwrap_or(0)
}

/// Returns (unpushed_hashes, has_upstream).
async fn get_unpushed_hashes(
    path: &str,
    limit: u32,
    remote_override: Option<&str>,
    branch: Option<&str>,
    all_branches: bool,
    author: Option<&str>,
) -> Result<(Option<HashSet<String>>, bool), AppCommandError> {
    let limit_arg = format!("-{}", limit);

    // `HEAD` as the log's rev is the git-log tab's dynamic "current branch"
    // filter — a rev, not a branch NAME. Push status needs the name (to find the
    // branch's remote and its `<remote>/<branch>` ref), so normalize it to "no
    // branch specified", which resolves the real checked-out branch below and
    // reports unknown when detached. Taken literally it would instead look up
    // `branch.HEAD.remote` and compare against `refs/remotes/origin/HEAD` — the
    // remote's DEFAULT branch — so on a feature branch with no upstream every
    // commit missing from origin/main would wrongly read "not pushed".
    let branch = branch.filter(|b| *b != "HEAD");

    // All-branches view: a commit counts as "pushed" iff it is reachable from any
    // remote-tracking ref. "unpushed" = commits the log (`git log --all`) shows
    // that sit on no remote. Two things must line up with git_log so every
    // *displayed* commit gets a correct, definite badge:
    //  - Walk the SAME `--all` ref universe (not just `--branches`), so tag-/
    //    stash-only commits that appear in the log are classified too (walking
    //    only `--branches` would leave them absent from the set → wrongly
    //    "pushed").
    //  - Apply the SAME `--author` filter (anchored BRE, see
    //    git_author_match_pattern), so a sparse author-filtered page's commits
    //    fall inside the `-{limit}` window instead of being pushed past it by
    //    unrelated commits and mislabeled "pushed".
    // The status is always definite (never "unknown"): with no remote-tracking
    // refs `--not --remotes` is a no-op, so every listed commit reads "not
    // pushed" — accurate, nothing is on a remote — instead of a question mark.
    if all_branches {
        // Drives only the has_upstream flag; push status is resolved regardless.
        let has_remotes = crate::process::tokio_command("git")
            .args(["for-each-ref", "--count=1", "refs/remotes"])
            .current_dir(path)
            .output()
            .await
            .map(|o| {
                o.status.success()
                    && !String::from_utf8_lossy(&o.stdout).trim().is_empty()
            })
            .unwrap_or(false);
        let mut rev_args = vec!["rev-list".to_string(), limit_arg.clone()];
        if let Some(a) = author.filter(|a| !a.is_empty()) {
            rev_args.push("--basic-regexp".to_string());
            rev_args.push(format!("--author={}", git_author_match_pattern(a)));
        }
        rev_args.push("--all".to_string());
        rev_args.push("--not".to_string());
        rev_args.push("--remotes".to_string());
        let output = crate::process::tokio_command("git")
            .args(&rev_args)
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?;
        if !output.status.success() {
            return Ok((None, has_remotes));
        }
        let hashes = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| line.to_string())
            .collect::<HashSet<_>>();
        return Ok((Some(hashes), has_remotes));
    }

    // If viewing a remote branch (e.g. "origin/main"), all commits are pushed
    if let Some(b) = branch {
        let is_remote = crate::process::tokio_command("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/remotes/{}", b),
            ])
            .current_dir(path)
            .output()
            .await
            .is_ok_and(|o| o.status.success());
        if is_remote {
            return Ok((Some(HashSet::new()), true));
        }
    }

    // The local ref to compare: specified branch or HEAD
    let local_ref = branch.unwrap_or("HEAD");

    // Check upstream for the target branch
    let upstream_arg = if branch.is_some() {
        format!("{}@{{upstream}}", local_ref)
    } else {
        "@{upstream}".to_string()
    };

    let upstream_output = crate::process::tokio_command("git")
        .args([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            &upstream_arg,
        ])
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)?;

    let has_upstream = upstream_output.status.success()
        && !String::from_utf8_lossy(&upstream_output.stdout)
            .trim()
            .is_empty();

    // Determine the comparison target for unpushed commits.
    // We compare against <remote>/<branch> specifically rather than all remote
    // branches, so that commits shared with other remote branches still appear.
    let rev_list_output = if has_upstream && remote_override.is_none() {
        // Fast path: branch has an upstream tracking ref, use it directly
        let upstream = String::from_utf8_lossy(&upstream_output.stdout)
            .trim()
            .to_string();
        let range = format!("{upstream}..{local_ref}");
        crate::process::tokio_command("git")
            .args(["rev-list", &limit_arg, &range])
            .current_dir(path)
            .output()
            .await
            .map_err(AppCommandError::io)?
    } else {
        // Either remote_override is specified or no upstream exists.
        // Resolve the branch name and the target remote.
        let branch_name = if let Some(b) = branch {
            b.to_string()
        } else {
            let branch_output = crate::process::tokio_command("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(path)
                .output()
                .await
                .map_err(AppCommandError::io)?;
            if !branch_output.status.success() {
                return Ok((None, has_upstream));
            }
            let name = String::from_utf8_lossy(&branch_output.stdout)
                .trim()
                .to_string();
            if name.is_empty() || name == "HEAD" {
                return Ok((None, has_upstream));
            }
            name
        };

        let remote = if let Some(r) = remote_override {
            r.to_string()
        } else {
            let remote_key = format!("branch.{}.remote", branch_name);
            let remote_output = crate::process::tokio_command("git")
                .args(["config", "--get", &remote_key])
                .current_dir(path)
                .output()
                .await;
            remote_output
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "origin".to_string())
        };

        // Try comparing against <remote>/<branch> directly
        let remote_branch_ref = format!("refs/remotes/{}/{}", remote, branch_name);
        let verify_output = crate::process::tokio_command("git")
            .args(["rev-parse", "--verify", "--quiet", &remote_branch_ref])
            .current_dir(path)
            .output()
            .await;
        let remote_branch_exists = verify_output.is_ok_and(|o| o.status.success());

        if remote_branch_exists {
            let range = format!("{}/{}..{}", remote, branch_name, local_ref);
            crate::process::tokio_command("git")
                .args(["rev-list", &limit_arg, &range])
                .current_dir(path)
                .output()
                .await
                .map_err(AppCommandError::io)?
        } else {
            // Branch doesn't exist on remote yet (new branch).
            // Try merge-base with the remote's default branch to show
            // the meaningful divergence point.
            let remote_head = format!("{}/HEAD", remote);
            let mb_output = crate::process::tokio_command("git")
                .args(["merge-base", local_ref, &remote_head])
                .current_dir(path)
                .output()
                .await;
            let merge_base = mb_output
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty());

            if let Some(base) = merge_base {
                let range = format!("{}..{}", base, local_ref);
                crate::process::tokio_command("git")
                    .args(["rev-list", &limit_arg, &range])
                    .current_dir(path)
                    .output()
                    .await
                    .map_err(AppCommandError::io)?
            } else {
                // Last resort: compare against all branches on the remote
                let remote_arg = format!("--remotes={}", remote);
                crate::process::tokio_command("git")
                    .args(["rev-list", &limit_arg, local_ref, "--not", &remote_arg])
                    .current_dir(path)
                    .output()
                    .await
                    .map_err(AppCommandError::io)?
            }
        }
    };

    if !rev_list_output.status.success() {
        return Ok((None, has_upstream));
    }

    let hashes = String::from_utf8_lossy(&rev_list_output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect::<HashSet<_>>();

    Ok((Some(hashes), has_upstream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::models::agent::AgentType;

    /// The frontend reads `symlink` as an optional boolean, and the tree
    /// snapshot is rebroadcast over the WebSocket on every filesystem change —
    /// so the flag must be present when true and *absent* (not `false`) on the
    /// overwhelming majority of directories.
    #[test]
    fn file_tree_dir_serializes_the_symlink_flag_only_when_set() {
        let plain = serde_json::to_value(FileTreeNode::Dir {
            name: "src".into(),
            path: "src".into(),
            children: vec![],
            symlink: false,
        })
        .expect("serialize");
        assert_eq!(plain["kind"], "dir");
        assert!(
            plain.get("symlink").is_none(),
            "an ordinary directory must not pay for the flag: {plain}"
        );

        let linked = serde_json::to_value(FileTreeNode::Dir {
            name: "kb".into(),
            path: "kb".into(),
            children: vec![],
            symlink: true,
        })
        .expect("serialize");
        assert_eq!(linked["symlink"], true);
    }

    #[test]
    fn git_author_match_pattern_anchors_and_escapes() {
        // Anchored to the name start + trailing " <" so it can't match a longer
        // name or the email portion.
        assert_eq!(git_author_match_pattern("Alice"), "^Alice <");
        // BRE metacharacters are backslash-escaped...
        assert_eq!(git_author_match_pattern("a.b*c"), "^a\\.b\\*c <");
        assert_eq!(git_author_match_pattern("na[me]"), "^na\\[me\\] <");
        assert_eq!(
            git_author_match_pattern("back\\slash"),
            "^back\\\\slash <"
        );
        // ...but `|` is literal in BRE, so a name like `程相|cx` is left as-is.
        assert_eq!(git_author_match_pattern("程相|cx"), "^程相|cx <");
    }

    #[test]
    fn filter_shortlog_authors_matches_dedupes_and_caps() {
        // Real shortlog rows: a space-padded count, a tab, then `Name <email>`.
        let out = "    10\tAlice <alice@example.com>\n     5\tBob <bob@example.com>\n     3\tAlice <alice@other.com>\n     1\tCarol <carol@example.com>\n";
        // Case-insensitive substring on the name; the same name under two emails
        // collapses to a single entry (first/most-frequent wins).
        assert_eq!(filter_shortlog_authors(out, "ali", 20), vec!["Alice"]);
        assert_eq!(filter_shortlog_authors(out, "B", 20), vec!["Bob"]);
        // Empty / whitespace query → no candidates.
        assert!(filter_shortlog_authors(out, "  ", 20).is_empty());
        // The limit caps the result count.
        let many = "   3\tAaa <a@x>\n   2\tAab <b@x>\n   1\tAac <c@x>\n";
        assert_eq!(filter_shortlog_authors(many, "aa", 2), vec!["Aaa", "Aab"]);
    }

    #[test]
    fn emit_folder_upsert_broadcasts_on_folder_channel() {
        // A headlessly-created folder must reach every client on
        // `folder://changed` carrying its full detail, so the sidebar can place a
        // conversation produced inside it without a re-fetch.
        use crate::db::entities::folder::FolderKind;
        use crate::web::event_bridge::{WebEventBroadcaster, FOLDER_CHANGED_EVENT};
        use std::sync::Arc;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_folder_upsert(
            &emitter,
            FolderDetail {
                id: 7,
                name: "repo-automation-3-run-9".to_string(),
                path: "/home/me/repo-automation-3-run-9".to_string(),
                git_branch: Some("automation/3/run-9".to_string()),
                default_agent_type: None,
                last_opened_at: chrono::Utc::now(),
                sort_order: 0,
                color: "inherit".to_string(),
                parent_id: Some(1),
                kind: FolderKind::Regular,
                alias: None,
                group_id: None,
            },
        );

        let evt = rx.try_recv().expect("folder upsert should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, FOLDER_CHANGED_EVENT);
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["folder"]["id"], 7);
        assert_eq!(p["folder"]["parent_id"], 1);
    }

    /// Create `rel` (relative to `root`) as a file, making parent dirs.
    fn write_file(root: &std::path::Path, rel: &str, contents: &str) {
        let full = root.join(rel);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("create parent dirs");
        }
        std::fs::write(full, contents).expect("write file");
    }

    #[tokio::test]
    async fn list_workspace_files_includes_deep_and_prunes_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        // A file nested 12 levels deep — beyond the old hardcoded depth-10 cap
        // this command replaces. It must still be discovered (the core fix).
        let deep_rel = "a/b/c/d/e/f/g/h/i/j/k/deep.txt";
        write_file(root, deep_rel, "deep");

        // Gitignore rules must be honored even without a real git repo
        // (`require_git(false)`), pruning ignored trees during the walk.
        write_file(root, ".gitignore", "node_modules/\nignored.txt\n");
        write_file(root, "node_modules/pkg/index.js", "junk");
        write_file(root, "ignored.txt", "junk");

        // The hardcoded ignores (mirroring FILE_TREE_IGNORED_DIRS) must be pruned.
        write_file(root, ".git/config", "[core]");
        write_file(root, "src/.DS_Store", "junk");

        // A normal file that must survive.
        write_file(root, "src/main.rs", "fn main() {}");

        let entries = list_workspace_files(root.to_string_lossy().to_string())
            .await
            .expect("list_workspace_files");
        let paths: std::collections::HashSet<&str> =
            entries.iter().map(|e| e.path.as_str()).collect();

        // Deep and normal files are reachable.
        assert!(
            paths.contains(deep_rel),
            "deep file must be listed, got {paths:?}"
        );
        assert!(paths.contains("src/main.rs"), "normal file must be listed");

        // Gitignored entries are pruned during traversal.
        assert!(
            !paths.iter().any(|p| p.starts_with("node_modules")),
            "gitignored node_modules must be pruned, got {paths:?}"
        );
        assert!(
            !paths.contains("ignored.txt"),
            "gitignored file must be pruned"
        );

        // Hardcoded ignores are pruned.
        // Precisely the `.git` dir / its contents — not `.gitignore`, which is
        // intentionally listed.
        assert!(
            !paths.iter().any(|p| *p == ".git" || p.starts_with(".git/")),
            ".git dir must be pruned, got {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.ends_with(".DS_Store")),
            ".DS_Store must be pruned"
        );

        // Intermediate directory entries are emitted alongside files — the
        // `@`-mention picker relies on directories being present.
        assert!(
            entries.iter().any(
                |e| e.path == "a" && matches!(e.kind, WorkspaceEntryKind::Dir)
            ),
            "directory entries must be present"
        );
    }

    /// Run a git command in `dir`, supplying identity via env so the test does
    /// not depend on (or mutate) the developer's global git config.
    fn git_run(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[tokio::test]
    async fn resolve_git_head_reports_branch_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        git_run(dir.path(), &["init", "-q"]);
        git_run(dir.path(), &["commit", "-q", "--allow-empty", "-m", "c1"]);
        git_run(dir.path(), &["checkout", "-q", "-b", "feature"]);

        let info = resolve_git_head(dir.path().to_str().unwrap())
            .await
            .expect("resolve");
        assert_eq!(
            info,
            GitHeadInfo {
                is_repo: true,
                branch: Some("feature".into()),
                detached: false,
                short_sha: None,
            }
        );
    }

    #[tokio::test]
    async fn resolve_git_head_detects_detached_head() {
        let dir = tempfile::tempdir().expect("tempdir");
        git_run(dir.path(), &["init", "-q"]);
        git_run(dir.path(), &["commit", "-q", "--allow-empty", "-m", "c1"]);
        git_run(dir.path(), &["commit", "-q", "--allow-empty", "-m", "c2"]);
        git_run(dir.path(), &["checkout", "-q", "HEAD~1"]);

        let info = resolve_git_head(dir.path().to_str().unwrap())
            .await
            .expect("resolve");
        assert!(info.is_repo, "detached HEAD is still a repo");
        assert!(info.detached, "must be flagged detached");
        assert_eq!(info.branch, None, "no branch when detached");
        assert!(
            info.short_sha.as_deref().is_some_and(|s| !s.is_empty()),
            "detached HEAD should expose a short sha, got {:?}",
            info.short_sha
        );
    }

    #[tokio::test]
    async fn resolve_git_head_handles_non_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let info = resolve_git_head(dir.path().to_str().unwrap())
            .await
            .expect("resolve");
        assert_eq!(
            info,
            GitHeadInfo {
                is_repo: false,
                branch: None,
                detached: false,
                short_sha: None,
            }
        );
    }

    #[tokio::test]
    async fn resolve_git_head_handles_unborn_branch() {
        let dir = tempfile::tempdir().expect("tempdir");
        git_run(dir.path(), &["init", "-q"]);

        let info = resolve_git_head(dir.path().to_str().unwrap())
            .await
            .expect("resolve");
        assert!(info.is_repo, "freshly-initialized repo is a repo");
        assert!(!info.detached, "unborn branch is not detached");
        assert!(
            info.branch.is_some(),
            "unborn branch should resolve a name, got {:?}",
            info.branch
        );
    }

    #[tokio::test]
    async fn get_git_branch_stays_none_on_detached_head() {
        let dir = tempfile::tempdir().expect("tempdir");
        git_run(dir.path(), &["init", "-q"]);
        git_run(dir.path(), &["commit", "-q", "--allow-empty", "-m", "c1"]);
        git_run(dir.path(), &["commit", "-q", "--allow-empty", "-m", "c2"]);
        git_run(dir.path(), &["checkout", "-q", "HEAD~1"]);

        // The legacy `Option<String>` contract intentionally reports no branch
        // for a detached HEAD; git-log default selection and compare rely on it.
        assert_eq!(
            get_git_branch(dir.path().to_str().unwrap().to_string())
                .await
                .expect("branch"),
            None
        );
    }

    /// Like `git_run` but returns the command's trimmed stdout (e.g. a resolved
    /// commit hash), with the same isolated identity/config env.
    fn git_capture(dir: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    // All-branches push status: with no remote-tracking refs every listed commit
    // is a definite "not pushed" (never the old unknown/None), and the classified
    // set walks the same `--all` universe as the log so a tag-only commit shown in
    // the log is covered too (a `--branches`-only walk would miss it → wrongly
    // "pushed").
    #[tokio::test]
    async fn git_log_all_branches_no_remote_marks_every_commit_not_pushed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c1"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c2"]);
        // A tag-only commit: create c3, tag it, then move the branch back so c3 is
        // reachable only via refs/tags — shown by `git log --all` but absent from
        // `--branches`.
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c3"]);
        let c3 = git_capture(p, &["rev-parse", "HEAD"]);
        git_run(p, &["tag", "v1"]);
        git_run(p, &["reset", "-q", "--hard", "HEAD~1"]);

        let result = git_log(
            p.to_string_lossy().to_string(),
            None,        // limit
            None,        // branch
            None,        // remote
            None,        // skip
            None,        // author
            Some(true),  // all_branches
            Some(false), // with_files
        )
        .await
        .expect("git_log");

        assert!(
            result.entries.iter().any(|e| e.full_hash == c3),
            "tag-only commit must be listed (proves the --all universe is walked)"
        );
        for e in &result.entries {
            assert_eq!(
                e.pushed,
                Some(false),
                "commit {} must read not-pushed, got {:?}",
                e.hash,
                e.pushed
            );
        }
        assert!(!result.has_upstream, "no remotes → has_upstream=false");
    }

    // A commit reachable from a remote-tracking ref reads "pushed"; commits ahead
    // of it read "not pushed". The remote-tracking ref is faked with update-ref so
    // the test needs no network.
    #[tokio::test]
    async fn git_log_all_branches_marks_remote_reachable_commits_pushed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c1"]);
        let c1 = git_capture(p, &["rev-parse", "HEAD"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c2"]);
        let c2 = git_capture(p, &["rev-parse", "HEAD"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c3"]);
        let c3 = git_capture(p, &["rev-parse", "HEAD"]);
        // "Pushed up to c2" without a network: point a remote-tracking ref at c2.
        git_run(p, &["update-ref", "refs/remotes/origin/main", &c2]);

        let result = git_log(
            p.to_string_lossy().to_string(),
            None,
            None,
            None,
            None,
            None,
            Some(true),
            Some(false),
        )
        .await
        .expect("git_log");

        let pushed_of = |hash: &str| {
            result
                .entries
                .iter()
                .find(|e| e.full_hash == hash)
                .unwrap_or_else(|| panic!("commit {hash} missing from log"))
                .pushed
        };
        assert_eq!(pushed_of(&c1), Some(true), "c1 is on the remote → pushed");
        assert_eq!(pushed_of(&c2), Some(true), "c2 is the remote tip → pushed");
        assert_eq!(
            pushed_of(&c3),
            Some(false),
            "c3 is ahead of the remote → not pushed"
        );
        assert!(result.has_upstream, "a remote-tracking ref → has_upstream");
    }

    // An author-filtered match that sits past the status rev-list's `-{limit}`
    // window in unfiltered history must still be classified: the status walk
    // applies the same `--author` filter as the log, so the sparse match stays
    // inside the window. An unfiltered walk would drop it and mislabel it
    // "pushed".
    #[tokio::test]
    async fn git_log_all_branches_author_match_past_window_stays_not_pushed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q"]);
        git_run(
            p,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "a1",
                "--author=Alice <alice@example.com>",
            ],
        );
        let alice = git_capture(p, &["rev-parse", "HEAD"]);
        // Six Bob commits push Alice (the root) to rank 7, past a `-5` window.
        for i in 0..6 {
            let msg = format!("b{i}");
            git_run(
                p,
                &[
                    "commit",
                    "-q",
                    "--allow-empty",
                    "-m",
                    &msg,
                    "--author=Bob <bob@example.com>",
                ],
            );
        }

        let result = git_log(
            p.to_string_lossy().to_string(),
            Some(5),                   // limit → status window is `-5`
            None,
            None,
            None,
            Some("Alice".to_string()), // author filter
            Some(true),
            Some(false),
        )
        .await
        .expect("git_log");

        assert_eq!(result.entries.len(), 1, "only the one Alice commit matches");
        let e = &result.entries[0];
        assert_eq!(e.full_hash, alice);
        assert_eq!(
            e.pushed,
            Some(false),
            "author-filtered match past the unfiltered window must read not-pushed"
        );
    }

    // The git-log tab's dynamic "current branch" filter sends the literal `HEAD`
    // rev. Push status must resolve it to the CHECKED-OUT branch, i.e. read the
    // same as selecting that branch by name. Taken literally it would look up
    // `refs/remotes/origin/HEAD` — the remote's default branch — and mislabel a
    // feature branch's already-pushed commits "not pushed" whenever the branch
    // has no upstream configured.
    #[tokio::test]
    async fn git_log_head_rev_scores_push_status_against_the_checked_out_branch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q", "-b", "main"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "base"]);
        let base = git_capture(p, &["rev-parse", "HEAD"]);
        // A cloned repo's remote HEAD (origin/main) plus a feature branch that is
        // fully pushed to origin/feature but has NO upstream configured — the
        // combination that made the literal-HEAD comparison wrong. Remote-tracking
        // refs are faked with update-ref so the test needs no network.
        git_run(p, &["update-ref", "refs/remotes/origin/main", &base]);
        git_run(p, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        git_run(p, &["checkout", "-q", "-b", "feature"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "f1"]);
        let f1 = git_capture(p, &["rev-parse", "HEAD"]);
        git_run(p, &["update-ref", "refs/remotes/origin/feature", &f1]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "f2"]);
        let f2 = git_capture(p, &["rev-parse", "HEAD"]);

        let by_head = git_log(
            p.to_string_lossy().to_string(),
            None,
            Some("HEAD".to_string()), // the dynamic current-branch filter
            None,
            None,
            None,
            Some(false),
            Some(false),
        )
        .await
        .expect("git_log HEAD");

        let pushed_of = |result: &GitLogResult, hash: &str| {
            result
                .entries
                .iter()
                .find(|e| e.full_hash == hash)
                .unwrap_or_else(|| panic!("commit {hash} missing from log"))
                .pushed
        };
        assert_eq!(
            pushed_of(&by_head, &f1),
            Some(true),
            "f1 is on origin/feature → pushed (not scored against origin/HEAD)"
        );
        assert_eq!(
            pushed_of(&by_head, &f2),
            Some(false),
            "f2 is ahead of origin/feature → not pushed"
        );

        // …and it agrees with selecting the same branch by name.
        let by_name = git_log(
            p.to_string_lossy().to_string(),
            None,
            Some("feature".to_string()),
            None,
            None,
            None,
            Some(false),
            Some(false),
        )
        .await
        .expect("git_log feature");
        assert_eq!(
            by_head
                .entries
                .iter()
                .map(|e| (e.full_hash.clone(), e.pushed))
                .collect::<Vec<_>>(),
            by_name
                .entries
                .iter()
                .map(|e| (e.full_hash.clone(), e.pushed))
                .collect::<Vec<_>>(),
            "the HEAD rev must read exactly like the branch it points at"
        );
    }

    // A detached HEAD has no branch, so push status is genuinely unknown — the
    // literal `HEAD` rev must not fall back to comparing against the remote's
    // default branch (which would report a definite, wrong badge).
    #[tokio::test]
    async fn git_log_head_rev_reports_unknown_push_status_when_detached() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q", "-b", "main"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c1"]);
        let c1 = git_capture(p, &["rev-parse", "HEAD"]);
        git_run(p, &["update-ref", "refs/remotes/origin/main", &c1]);
        git_run(p, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c2"]);
        git_run(p, &["checkout", "-q", "--detach"]);

        let result = git_log(
            p.to_string_lossy().to_string(),
            None,
            Some("HEAD".to_string()),
            None,
            None,
            None,
            Some(false),
            Some(false),
        )
        .await
        .expect("git_log HEAD detached");

        assert!(
            !result.entries.is_empty(),
            "a detached HEAD still logs its history"
        );
        for e in &result.entries {
            assert_eq!(
                e.pushed, None,
                "commit {} must read unknown while detached, got {:?}",
                e.hash, e.pushed
            );
        }
    }

    /// A 1x1 transparent PNG: real binary bytes (NUL inside the IHDR length),
    /// so it exercises the path `git_show_file` refuses.
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[tokio::test]
    async fn git_show_file_base64_returns_committed_binary_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("logo.png"), TINY_PNG).expect("write png");
        git_run(p, &["add", "logo.png"]);
        git_run(p, &["commit", "-q", "-m", "add logo"]);
        // Working tree diverges from HEAD; the command must read the ref, not
        // the file on disk.
        std::fs::write(p.join("logo.png"), b"not a png").expect("overwrite png");

        let blob = git_show_file_base64(
            p.to_string_lossy().to_string(),
            "logo.png".to_string(),
            None,
            None,
        )
        .await
        .expect("show blob");

        assert!(blob.exists, "committed file must exist at HEAD");
        assert!(!blob.too_large);
        assert_eq!(blob.byte_size, TINY_PNG.len() as u64);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&blob.data)
                .expect("decode base64"),
            TINY_PNG,
            "bytes must round-trip unmodified"
        );
    }

    #[tokio::test]
    async fn git_show_file_base64_reports_missing_path_without_erroring() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q", "-b", "main"]);
        git_run(p, &["commit", "-q", "--allow-empty", "-m", "c1"]);

        let blob = git_show_file_base64(
            p.to_string_lossy().to_string(),
            "added-later.png".to_string(),
            None,
            None,
        )
        .await
        .expect("missing path is not an error");

        assert!(!blob.exists, "an added file has no original side");
        assert!(
            !blob.ref_missing,
            "HEAD resolved fine — it is the path that is not there"
        );
        assert!(blob.data.is_empty());
        assert_eq!(blob.byte_size, 0);
    }

    #[tokio::test]
    async fn git_show_file_base64_separates_a_missing_ref_from_a_missing_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("logo.png"), TINY_PNG).expect("write png");
        git_run(p, &["add", "logo.png"]);
        git_run(p, &["commit", "-q", "-m", "add logo"]);

        // A revision that does not resolve is not evidence that the file was
        // added — the caller must be able to tell the two apart.
        let gone = git_show_file_base64(
            p.to_string_lossy().to_string(),
            "logo.png".to_string(),
            Some("deleted-branch".to_string()),
            None,
        )
        .await
        .expect("unresolvable ref is reported, not raised");

        assert!(!gone.exists);
        assert!(gone.ref_missing, "the revision is what went missing");

        // The parent of the root commit: also unresolvable, and this is exactly
        // the case where "nothing came before" is the truthful reading.
        let root = git_capture(p, &["rev-parse", "HEAD"]);
        let before_root = git_show_file_base64(
            p.to_string_lossy().to_string(),
            "logo.png".to_string(),
            Some(format!("{}~1", root.trim())),
            None,
        )
        .await
        .expect("root commit has no parent");

        assert!(!before_root.exists);
        assert!(before_root.ref_missing);
    }

    #[tokio::test]
    async fn git_show_file_base64_flags_a_shallow_boundary_parent_as_missing() {
        // A shallow clone's oldest commit keeps its `parent` header, but the
        // graft hides that object: `rev-parse` cannot resolve it and
        // `rev-list --parents` reports none. git's own diff reads such a commit
        // as all-additions, and the commit-diff callers follow it by opting
        // into `missingRefIsAbsent`; the command's job is only to report
        // truthfully that the revision did not resolve.
        let dir = tempfile::tempdir().expect("tempdir");
        let origin = dir.path().join("origin");
        std::fs::create_dir(&origin).expect("mkdir origin");
        git_run(&origin, &["init", "-q", "-b", "main"]);
        std::fs::write(origin.join("logo.png"), TINY_PNG).expect("write png");
        git_run(&origin, &["add", "logo.png"]);
        git_run(&origin, &["commit", "-q", "-m", "c1"]);
        std::fs::write(origin.join("logo.png"), b"changed").expect("rewrite png");
        git_run(&origin, &["add", "logo.png"]);
        git_run(&origin, &["commit", "-q", "-m", "c2"]);

        let shallow = dir.path().join("shallow");
        git_run(
            dir.path(),
            &[
                "clone",
                "-q",
                "--depth",
                "1",
                &format!("file://{}", origin.to_string_lossy()),
                &shallow.to_string_lossy(),
            ],
        );

        let head = git_capture(&shallow, &["rev-parse", "HEAD"]);
        let blob = git_show_file_base64(
            shallow.to_string_lossy().to_string(),
            "logo.png".to_string(),
            Some(format!("{}~1", head.trim())),
            None,
        )
        .await
        .expect("a truncated history is reported, not raised");

        assert!(!blob.exists);
        assert!(
            blob.ref_missing,
            "the parent revision is unreachable in a shallow clone"
        );
    }

    #[tokio::test]
    async fn git_show_file_base64_skips_bytes_over_the_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        git_run(p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("big.png"), vec![0u8; 8_000]).expect("write big");
        git_run(p, &["add", "big.png"]);
        git_run(p, &["commit", "-q", "-m", "add big"]);

        // 4_096 is the floor the clamp allows, and the blob is comfortably over it.
        let blob = git_show_file_base64(
            p.to_string_lossy().to_string(),
            "big.png".to_string(),
            None,
            Some(4_096),
        )
        .await
        .expect("show blob");

        assert!(blob.exists, "the blob is there, we just refused to load it");
        assert!(blob.too_large);
        assert!(blob.data.is_empty(), "no bytes when over the cap");
        assert_eq!(blob.byte_size, 8_000, "size is reported anyway");
    }

    #[tokio::test]
    async fn add_folder_to_history_core_derives_name_from_path() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-test-project".into())
            .await
            .expect("add folder");
        assert_eq!(entry.name, "codeg-test-project");
        assert_eq!(entry.path, "/tmp/codeg-test-project");
    }

    #[tokio::test]
    async fn add_folder_to_history_core_upserts_on_duplicate_path() {
        let db = fresh_in_memory_db().await;
        let path = "/tmp/codeg-dup-test".to_string();
        let first = add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add 1st");
        let second = add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add 2nd");
        assert_eq!(first.id, second.id, "duplicate path must reuse id");

        let history = load_folder_history_core(&db).await.expect("history");
        assert_eq!(
            history.iter().filter(|f| f.path == path).count(),
            1,
            "no duplicate rows for same path"
        );
    }

    #[tokio::test]
    async fn remove_folder_from_history_core_soft_deletes() {
        let db = fresh_in_memory_db().await;
        let path = "/tmp/codeg-remove-test".to_string();
        add_folder_to_history_core(&db, path.clone())
            .await
            .expect("add");
        remove_folder_from_history_core(&db, path.clone())
            .await
            .expect("remove");
        let history = load_folder_history_core(&db).await.expect("history");
        assert!(
            history.iter().all(|f| f.path != path),
            "soft-deleted folder must not appear in list"
        );
    }

    #[tokio::test]
    async fn open_folder_by_id_core_errors_when_missing() {
        let db = fresh_in_memory_db().await;
        let err = open_folder_by_id_core(&db, 99_999)
            .await
            .expect_err("missing id should error");
        // Either the not_found wrapper (when set_folder_open returns Ok(()) on no-op)
        // or the underlying DbError propagates — both are acceptable for "missing".
        let msg = format!("{err:?}");
        assert!(
            msg.to_lowercase().contains("not found") || msg.to_lowercase().contains("99999"),
            "expected not-found-ish error, got: {msg}"
        );
    }

    /// A delegated child's `working_dir` is whatever the agent picked — a PR
    /// checkout under /tmp, a throwaway worktree. It needs a folder row (the
    /// conversation's `folder_id`, and the cwd a resume reads back), but it must
    /// not become a project in the user's sidebar. Both cwd lookups ignore
    /// `is_open`, so a closed row serves the delegation fully.
    #[tokio::test]
    async fn ensure_folder_for_path_creates_a_closed_row() {
        let db = fresh_in_memory_db().await;
        let entry = folder_service::ensure_folder_for_path(&db.conn, "/tmp/codeg-pr666")
            .await
            .expect("ensure folder");

        let open = list_open_folder_details_core(&db).await.expect("open list");
        assert!(
            !open.iter().any(|f| f.id == entry.id),
            "an agent's scratch cwd must not land in the workspace folder list"
        );

        // ...but it is still fully resolvable, which is all the delegation needs.
        assert!(
            folder_service::get_folder_by_id(&db.conn, entry.id)
                .await
                .expect("by id")
                .is_some(),
            "resume resolves the child's cwd through get_folder_by_id"
        );
        let all = list_all_folder_details_core(&db).await.expect("all list");
        assert!(all.iter().any(|f| f.id == entry.id));
    }

    /// The overwhelmingly common case: the child runs in the same folder as its
    /// parent. That folder is already open and must stay exactly as it was —
    /// including `last_opened_at`, which orders the folder history and has no
    /// business being bumped by a background delegation.
    #[tokio::test]
    async fn ensure_folder_for_path_leaves_an_open_folder_untouched() {
        let db = fresh_in_memory_db().await;
        let opened = open_folder_core(&db, "/tmp/codeg-ensure-open".into())
            .await
            .expect("open folder");

        let entry = folder_service::ensure_folder_for_path(&db.conn, "/tmp/codeg-ensure-open")
            .await
            .expect("ensure folder");

        assert_eq!(entry.id, opened.id, "the existing row is reused");
        assert_eq!(
            entry.last_opened_at, opened.last_opened_at,
            "a background delegation must not reorder the folder history"
        );
        let open = list_open_folder_details_core(&db).await.expect("open list");
        assert!(
            open.iter().any(|f| f.id == opened.id),
            "an already-open folder stays open"
        );
    }

    /// The regression this replaced `add_folder` for: that helper flips
    /// `is_open = true` on an existing row, so delegating into a folder the user
    /// had closed put it back in their sidebar behind their back.
    #[tokio::test]
    async fn ensure_folder_for_path_does_not_reopen_a_closed_folder() {
        let db = fresh_in_memory_db().await;
        let opened = open_folder_core(&db, "/tmp/codeg-ensure-closed".into())
            .await
            .expect("open folder");
        folder_service::set_folder_open(&db.conn, opened.id, false)
            .await
            .expect("close folder");

        folder_service::ensure_folder_for_path(&db.conn, "/tmp/codeg-ensure-closed")
            .await
            .expect("ensure folder");

        let open = list_open_folder_details_core(&db).await.expect("open list");
        assert!(
            !open.iter().any(|f| f.id == opened.id),
            "a folder the user closed stays closed"
        );
    }

    /// `deleted_at` is the one field that must be cleared: both cwd lookups
    /// filter on it, so leaving a soft-deleted row deleted would break the very
    /// resume the row is created for. Reviving it must still not open it.
    #[tokio::test]
    async fn ensure_folder_for_path_revives_a_soft_deleted_row_but_leaves_it_closed() {
        let db = fresh_in_memory_db().await;
        let opened = open_folder_core(&db, "/tmp/codeg-ensure-deleted".into())
            .await
            .expect("open folder");
        remove_folder_from_history_core(&db, "/tmp/codeg-ensure-deleted".into())
            .await
            .expect("soft delete");
        assert!(
            folder_service::get_folder_by_id(&db.conn, opened.id)
                .await
                .expect("by id")
                .is_none(),
            "precondition: a soft-deleted row is invisible to cwd resolution"
        );

        let entry = folder_service::ensure_folder_for_path(&db.conn, "/tmp/codeg-ensure-deleted")
            .await
            .expect("ensure folder");

        assert_eq!(entry.id, opened.id, "the same row is revived, not a new one");
        assert!(
            folder_service::get_folder_by_id(&db.conn, opened.id)
                .await
                .expect("by id")
                .is_some(),
            "cwd resolution works again"
        );
        let open = list_open_folder_details_core(&db).await.expect("open list");
        assert!(
            !open.iter().any(|f| f.id == opened.id),
            "reviving the row must not put it back in the sidebar"
        );
    }

    #[tokio::test]
    async fn open_worktree_folder_core_records_parent_as_root() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-root".into())
            .await
            .expect("open root");
        assert_eq!(root.parent_id, None, "root folder has no parent");

        let wt = open_worktree_folder_core(&db, "/tmp/codeg-wt-a".into(), root.id)
            .await
            .expect("open worktree");
        assert_eq!(
            wt.parent_id,
            Some(root.id),
            "worktree records its source root folder"
        );
    }

    #[tokio::test]
    async fn open_worktree_folder_core_flattens_nested_worktrees() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-flat-root".into())
            .await
            .expect("open root");
        let child = open_worktree_folder_core(&db, "/tmp/codeg-wt-flat-1".into(), root.id)
            .await
            .expect("open child worktree");
        // A worktree created *from* the child must still point at the root, not
        // the intermediate child.
        let grandchild = open_worktree_folder_core(&db, "/tmp/codeg-wt-flat-2".into(), child.id)
            .await
            .expect("open grandchild worktree");
        assert_eq!(child.parent_id, Some(root.id));
        assert_eq!(
            grandchild.parent_id,
            Some(root.id),
            "worktree of a worktree flattens to the original root"
        );
    }

    #[tokio::test]
    async fn open_worktree_folder_core_unknown_source_is_root() {
        let db = fresh_in_memory_db().await;
        let wt = open_worktree_folder_core(&db, "/tmp/codeg-wt-orphan".into(), 0)
            .await
            .expect("open worktree with no source");
        assert_eq!(
            wt.parent_id, None,
            "non-positive / unknown source degrades to a top-level folder"
        );
    }

    /// The point of seeding: a worktree's directory name says far less about it
    /// than the branch it holds, so registering one labels it by branch.
    #[tokio::test]
    async fn open_worktree_folder_core_labels_the_folder_with_its_branch() {
        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo).await.expect("root");

        let wt = open_worktree_folder_core(&db, wt_path, root.id)
            .await
            .expect("worktree folder");

        assert_eq!(
            wt.alias.as_deref(),
            Some("wt"),
            "the fresh worktree folder is labeled with its checked-out branch"
        );
    }

    /// Re-registering a worktree is routine — a task retry re-creating its
    /// checkout, an automation re-resolving the same directory — and must never
    /// undo the name the user gave it in the sidebar.
    #[tokio::test]
    async fn open_worktree_folder_core_keeps_a_user_alias_on_re_register() {
        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo).await.expect("root");
        let wt = open_worktree_folder_core(&db, wt_path.clone(), root.id)
            .await
            .expect("worktree folder");
        update_folder_alias_core(&db, wt.id, Some("Payment rewrite".into()))
            .await
            .expect("user renames it");

        let again = open_worktree_folder_core(&db, wt_path, root.id)
            .await
            .expect("re-register the same worktree");

        assert_eq!(again.id, wt.id, "same folder row");
        assert_eq!(
            again.alias.as_deref(),
            Some("Payment rewrite"),
            "the user's name survives re-registration"
        );
    }

    /// The seed is best-effort: a directory git knows nothing about (or that is
    /// gone entirely) still registers, just without a label — the sidebar then
    /// falls back to the directory name as it always did.
    #[tokio::test]
    async fn open_worktree_folder_core_leaves_a_non_repo_unlabeled() {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let plain = dir
            .path()
            .join("not-a-repo")
            .to_str()
            .expect("utf-8 path")
            .to_string();
        std::fs::create_dir_all(&plain).expect("mkdir");

        let wt = open_worktree_folder_core(&db, plain, 0)
            .await
            .expect("registers anyway");

        assert_eq!(wt.alias, None, "no branch to label it with");
    }

    /// Worktrees registered before seeding existed keep showing their directory
    /// name forever without this — the whole reason the backfill exists.
    #[tokio::test]
    async fn backfill_labels_an_already_registered_worktree() {
        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo).await.expect("root");
        let wt = open_worktree_folder_core(&db, wt_path, root.id)
            .await
            .expect("worktree folder");
        // Back to the pre-seeding state: a worktree folder row with no alias.
        update_folder_alias_core(&db, wt.id, None)
            .await
            .expect("clear the alias");

        let labeled = backfill_worktree_folder_aliases(&test_emitter(), &db).await;

        assert_eq!(labeled, 1);
        assert_eq!(
            get_folder_core(&db, wt.id)
                .await
                .expect("folder")
                .alias
                .as_deref(),
            Some("wt")
        );
        assert_eq!(
            get_folder_core(&db, root.id).await.expect("root").alias,
            None,
            "the root repo is not a worktree and is left alone"
        );
    }

    /// A `folder://changed` Upsert means "insert-or-replace in the OPEN folder
    /// list", so announcing a closed folder would put one the user removed from
    /// the workspace back in their sidebar. Label it anyway — reopening it later
    /// should already read as the branch — but stay silent about it.
    #[tokio::test]
    async fn backfill_labels_a_closed_worktree_without_announcing_it() {
        use crate::web::event_bridge::WebEventBroadcaster;

        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo.clone()).await.expect("root");
        let open_wt = open_worktree_folder_core(&db, wt_path, root.id)
            .await
            .expect("open worktree folder");
        let (_dir2, repo2, wt_path2) = repo_with_worktree();
        let root2 = open_folder_core(&db, repo2).await.expect("second root");
        let closed_wt = open_worktree_folder_core(&db, wt_path2, root2.id)
            .await
            .expect("worktree folder to close");
        // Back to the pre-seeding state for both, then close the second one the
        // way the UI does (the row stays alive, just out of the workspace).
        for id in [open_wt.id, closed_wt.id] {
            update_folder_alias_core(&db, id, None)
                .await
                .expect("clear the alias");
        }
        let broadcaster = std::sync::Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        remove_folder_from_workspace_core(&emitter, &db, closed_wt.id)
            .await
            .expect("close the folder");

        // Subscribe only now, so the queue holds just the backfill's events.
        let mut rx = broadcaster.subscribe();
        let labeled = backfill_worktree_folder_aliases(&emitter, &db).await;

        // Both rows get the label…
        assert_eq!(labeled, 2);
        for id in [open_wt.id, closed_wt.id] {
            assert_eq!(
                get_folder_core(&db, id).await.expect("folder").alias,
                Some("wt".to_string()),
                "every worktree row is labeled, open or not"
            );
        }
        // …but only the open one is announced.
        let mut announced = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if evt.channel == crate::web::event_bridge::FOLDER_CHANGED_EVENT {
                let p = &*evt.payload;
                if p["kind"] == "upsert" {
                    announced.push(p["folder"]["id"].as_i64().unwrap_or(-1) as i32);
                }
            }
        }
        assert_eq!(
            announced,
            vec![open_wt.id],
            "a closed folder must not be broadcast back into the sidebar"
        );
    }

    /// The backfill decides whether to announce a folder by re-reading it, not
    /// from the snapshot its work list was built from — otherwise closing a
    /// folder while the backfill walks (one git call per folder, so the window is
    /// real) still announces it and puts it back in the sidebar. This is that
    /// re-read: the same id that was announceable a moment ago no longer is.
    #[tokio::test]
    async fn a_folder_closed_after_enumeration_is_no_longer_announceable() {
        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo).await.expect("root");
        let wt = open_worktree_folder_core(&db, wt_path, root.id)
            .await
            .expect("worktree folder");

        // Enumeration-time reading: open, so this row would be announced.
        assert!(folder_service::get_open_folder_by_id(&db.conn, wt.id)
            .await
            .expect("query")
            .is_some());

        // The user closes it mid-walk.
        remove_folder_from_workspace_core(&test_emitter(), &db, wt.id)
            .await
            .expect("close the folder");

        assert!(
            folder_service::get_open_folder_by_id(&db.conn, wt.id)
                .await
                .expect("query")
                .is_none(),
            "a folder closed since enumeration must not be announced"
        );
        // Still a live row the backfill may label — just silently.
        assert!(get_folder_core(&db, wt.id).await.is_ok());
    }

    /// A second launch must be a no-op — both for folders it already labeled and
    /// for ones the user has since named.
    #[tokio::test]
    async fn backfill_skips_folders_that_already_have_a_label() {
        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo).await.expect("root");
        let wt = open_worktree_folder_core(&db, wt_path, root.id)
            .await
            .expect("worktree folder");
        update_folder_alias_core(&db, wt.id, Some("Payment rewrite".into()))
            .await
            .expect("user renames it");

        assert_eq!(
            backfill_worktree_folder_aliases(&test_emitter(), &db).await,
            0
        );
        assert_eq!(
            get_folder_core(&db, wt.id)
                .await
                .expect("folder")
                .alias
                .as_deref(),
            Some("Payment rewrite")
        );
    }

    /// A repo with one commit on `main` plus a linked worktree at `<dir>/wt`
    /// holding branch `wt`. Returns `(tempdir, repo_path, worktree_path)`.
    fn repo_with_worktree() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        git_run(dir.path(), &["init", "-q", "-b", "main"]);
        git_run(dir.path(), &["commit", "-q", "--allow-empty", "-m", "base"]);
        let wt_path = dir.path().join("wt");
        let wt_str = wt_path.to_str().expect("utf-8 path").to_string();
        git_run(dir.path(), &["worktree", "add", "-q", "-b", "wt", &wt_str]);
        let repo = dir.path().to_str().expect("utf-8 path").to_string();
        (dir, repo, wt_str)
    }

    fn test_emitter() -> EventEmitter {
        EventEmitter::test_web_only(std::sync::Arc::new(
            crate::web::event_bridge::WebEventBroadcaster::new(),
        ))
    }

    /// Spell a path git printed and one we resolved ourselves the same way
    /// before comparing them. git reports the fully resolved location (on
    /// macOS `/var` is a symlink into `/private/var`) with `/` separators,
    /// while `fs::canonicalize` on Windows hands back the verbatim
    /// `\\?\C:\…` form of what git prints as `C:/…`. Resolve, drop the
    /// verbatim prefix, settle on forward slashes.
    fn comparable_path(path: &str) -> String {
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        crate::paths::simplify_verbatim_path(&resolved)
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// The bug this command exists for: git flatly refuses to delete a branch a
    /// worktree has checked out, so the branch selector's "delete branch" could
    /// only ever report an error. Removing the checkout first is the fix.
    #[tokio::test]
    async fn remove_worktree_deletes_a_branch_plain_delete_cannot() {
        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();

        let refused = git_delete_branch(repo.clone(), "wt".into(), false)
            .await
            .expect_err("git refuses a branch held by a worktree");
        assert!(
            format!("{refused:?}").contains("used by worktree"),
            "expected git's worktree refusal, got: {refused:?}"
        );

        // Resolve ours the way git resolves its own — while the directory is
        // still there to resolve.
        let canonical_wt = comparable_path(&wt_path);

        let removal = git_remove_worktree_core(
            &test_emitter(),
            &db,
            repo.clone(),
            "wt".into(),
            0,
            true,
            false,
        )
        .await
        .expect("worktree + branch removal");

        assert_eq!(
            removal.worktree_path.as_deref().map(comparable_path),
            Some(canonical_wt),
            "reports the directory it removed"
        );
        assert!(removal.branch_deleted);
        assert!(!Path::new(&wt_path).exists(), "worktree directory is gone");
        let branches = git_list_all_branches(repo).await.expect("branches");
        assert_eq!(branches.local, vec!["main".to_string()]);
        assert!(branches.worktree_branches.is_empty());
    }

    /// The "worktree only" variant frees the checkout but is not a branch
    /// delete: the commits — and the workspace folder you may want to recreate
    /// the worktree under — survive.
    #[tokio::test]
    async fn remove_worktree_without_branch_keeps_branch_and_folder() {
        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo.clone()).await.expect("root");
        let wt_folder = open_worktree_folder_core(&db, wt_path.clone(), root.id)
            .await
            .expect("worktree folder");

        let removal = git_remove_worktree_core(
            &test_emitter(),
            &db,
            repo.clone(),
            "wt".into(),
            root.id,
            false,
            false,
        )
        .await
        .expect("worktree removal");

        assert!(!removal.branch_deleted);
        assert_eq!(removal.folder_id, None);
        assert!(!Path::new(&wt_path).exists());
        let branches = git_list_all_branches(repo).await.expect("branches");
        assert!(
            branches.local.contains(&"wt".to_string()),
            "the branch outlives its worktree"
        );
        assert!(
            folder_service::get_folder_by_id(&db.conn, wt_folder.id)
                .await
                .expect("lookup")
                .is_some(),
            "the workspace folder outlives its worktree"
        );
    }

    /// Deleting everything also drops the workspace folder — and its sessions
    /// have to land somewhere first, or they are orphaned under a folder no
    /// client can fetch.
    #[tokio::test]
    async fn remove_worktree_with_branch_rehomes_sessions_then_drops_the_folder() {
        use crate::db::service::conversation_service;
        use crate::models::agent::AgentType;

        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo.clone()).await.expect("root");
        let wt_folder = open_worktree_folder_core(&db, wt_path.clone(), root.id)
            .await
            .expect("worktree folder");
        let conv =
            conversation_service::create(&db.conn, wt_folder.id, AgentType::ClaudeCode, None, None)
                .await
                .expect("conversation");

        let removal = git_remove_worktree_core(
            &test_emitter(),
            &db,
            repo,
            "wt".into(),
            root.id,
            true,
            false,
        )
        .await
        .expect("worktree + branch removal");

        assert_eq!(removal.folder_id, Some(wt_folder.id));
        assert_eq!(removal.reparented, 1);
        assert!(
            folder_service::get_folder_by_id(&db.conn, wt_folder.id)
                .await
                .expect("lookup")
                .is_none(),
            "the workspace folder goes with the branch"
        );
        let moved = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .expect("conversation row");
        assert_eq!(moved.folder_id, root.id);
        assert_eq!(
            moved.origin_cwd.as_deref(),
            Some(wt_path.as_str()),
            "the session remembers where it actually ran"
        );
    }

    /// Seed a to-do task that owns `wt_folder_id` as its worktree.
    async fn seed_task_on_worktree(
        db: &AppDatabase,
        project_folder_id: i32,
        wt_folder_id: i32,
    ) -> i32 {
        use crate::db::service::work_task_service;

        let task = work_task_service::create(
            &db.conn,
            crate::models::WorkTaskDraft {
                folder_id: project_folder_id,
                title: "fix login".to_string(),
                config: serde_json::json!({
                    "display_text": "fix login",
                    "prompt_blocks": [{ "type": "text", "text": "fix login" }],
                }),
            },
        )
        .await
        .expect("task");
        work_task_service::attach_worktree(&db.conn, task.id, wt_folder_id, "main", "abc", "wt")
            .await
            .expect("attach worktree");
        task.id
    }

    /// The branch selector cannot tell a to-do task's worktree from any other,
    /// so a task that has settled must not be left advertising a checkout that
    /// is gone — its card would offer a cleanup and a diff that can only fail.
    #[tokio::test]
    async fn remove_worktree_detaches_the_task_that_owned_it() {
        use crate::db::service::work_task_service;

        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo.clone()).await.expect("root");
        let wt_folder = open_worktree_folder_core(&db, wt_path.clone(), root.id)
            .await
            .expect("worktree folder");
        let task_id = seed_task_on_worktree(&db, root.id, wt_folder.id).await;

        git_remove_worktree_core(
            &test_emitter(),
            &db,
            repo,
            "wt".into(),
            root.id,
            true,
            false,
        )
        .await
        .expect("worktree + branch removal");

        let after = work_task_service::get_model(&db.conn, task_id)
            .await
            .expect("task row");
        assert_eq!(after.worktree_folder_id, None);
    }

    /// A task mid-run is working inside that directory right now. `--force`
    /// would happily delete it out from under the live agent, so the refusal
    /// has to come before git is asked — exactly as the task card's own
    /// "remove worktree" refuses these statuses.
    #[tokio::test]
    async fn remove_worktree_refuses_while_a_task_is_running_in_it() {
        use crate::db::entities::work_task::WorkTaskStatus;

        let db = fresh_in_memory_db().await;
        let (_dir, repo, wt_path) = repo_with_worktree();
        let root = open_folder_core(&db, repo.clone()).await.expect("root");
        let wt_folder = open_worktree_folder_core(&db, wt_path.clone(), root.id)
            .await
            .expect("worktree folder");
        let task_id = seed_task_on_worktree(&db, root.id, wt_folder.id).await;
        // Straight to `running` — the real transition chain would need a live
        // engine, and only the status matters here.
        {
            use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
            let row = crate::db::entities::work_task::Entity::find_by_id(task_id)
                .one(&db.conn)
                .await
                .expect("query")
                .expect("task row");
            let mut active = row.into_active_model();
            active.status = Set(WorkTaskStatus::Running);
            active.update(&db.conn).await.expect("mark running");
        }

        // Even the destructive variant, which is the one that would succeed.
        let err = git_remove_worktree_core(
            &test_emitter(),
            &db,
            repo.clone(),
            "wt".into(),
            root.id,
            true,
            true,
        )
        .await
        .expect_err("a running task must block the removal");
        assert!(
            format!("{err:?}").contains("still working in this worktree"),
            "expected a busy-task refusal, got: {err:?}"
        );
        assert!(Path::new(&wt_path).exists(), "the working tree survives");
        let branches = git_list_all_branches(repo).await.expect("branches");
        assert!(branches.local.contains(&"wt".to_string()));
    }

    /// Seen from a linked worktree, the repo's own checkout is just another
    /// entry in `worktree_branches` — and the branch selector would offer to
    /// remove it. Naming it separately is what lets the UI leave it alone.
    #[tokio::test]
    async fn list_all_branches_names_the_main_working_tree_branch() {
        let (_dir, repo, wt_path) = repo_with_worktree();

        let from_main = git_list_all_branches(repo).await.expect("from main tree");
        assert_eq!(from_main.worktree_branches, vec!["wt".to_string()]);
        assert_eq!(
            from_main.main_worktree_branch, None,
            "the queried path IS the main tree — it is not one of the others"
        );

        let from_worktree = git_list_all_branches(wt_path)
            .await
            .expect("from linked worktree");
        assert_eq!(from_worktree.worktree_branches, vec!["main".to_string()]);
        assert_eq!(
            from_worktree.main_worktree_branch.as_deref(),
            Some("main"),
            "and from over here it is the one entry that can't be removed"
        );
    }

    /// The main working tree hosts the repo itself — removing it would take the
    /// project with it, so it is refused before git is asked.
    #[tokio::test]
    async fn remove_worktree_refuses_the_main_working_tree() {
        let db = fresh_in_memory_db().await;
        let (_dir, repo, _wt_path) = repo_with_worktree();

        let err = git_remove_worktree_core(
            &test_emitter(),
            &db,
            repo.clone(),
            "main".into(),
            0,
            true,
            false,
        )
        .await
        .expect_err("main working tree must be refused");
        assert!(
            format!("{err:?}").contains("main working tree"),
            "expected a main-working-tree refusal, got: {err:?}"
        );
        let branches = git_list_all_branches(repo).await.expect("branches");
        assert!(branches.local.contains(&"main".to_string()));
    }

    #[test]
    fn parse_worktrees_extracts_path_branch_pairs() {
        // Main tree + a linked worktree + a detached worktree, trailing blank line.
        let stdout = "\
worktree /repo/main
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /repo/wt-feature
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feature-x

worktree /repo/wt-detached
HEAD cccccccccccccccccccccccccccccccccccccccc
detached

";
        let entries = parse_worktrees(stdout);
        assert_eq!(
            entries,
            vec![
                ("/repo/main".to_string(), Some("main".to_string())),
                (
                    "/repo/wt-feature".to_string(),
                    Some("feature-x".to_string())
                ),
                ("/repo/wt-detached".to_string(), None),
            ]
        );
    }

    #[test]
    fn parse_worktrees_flushes_trailing_block_without_blank_line() {
        // No terminating blank line on the last block (git omits it at EOF here).
        let stdout = "\
worktree /repo/main
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main";
        let entries = parse_worktrees(stdout);
        assert_eq!(
            entries,
            vec![("/repo/main".to_string(), Some("main".to_string()))]
        );
    }

    #[test]
    fn parse_worktrees_handles_empty_and_bare() {
        assert!(parse_worktrees("").is_empty());
        // A bare repo entry carries no branch.
        let entries = parse_worktrees("worktree /repo/bare\nbare\n\n");
        assert_eq!(entries, vec![("/repo/bare".to_string(), None)]);
    }

    #[tokio::test]
    async fn open_folder_core_preserves_existing_worktree_parent() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-preserve-root".into())
            .await
            .expect("open root");
        let wt = open_worktree_folder_core(&db, "/tmp/codeg-wt-preserve".into(), root.id)
            .await
            .expect("open worktree");
        assert_eq!(wt.parent_id, Some(root.id));
        // A plain reopen of the same path must not clear the recorded parent.
        let reopened = open_folder_core(&db, "/tmp/codeg-wt-preserve".into())
            .await
            .expect("reopen plain");
        assert_eq!(
            reopened.parent_id,
            Some(root.id),
            "plain open_folder must preserve an existing worktree parent"
        );
    }

    #[tokio::test]
    async fn open_worktree_folder_core_unknown_source_demotes_existing_to_root() {
        let db = fresh_in_memory_db().await;
        let root = open_folder_core(&db, "/tmp/codeg-wt-demote-root".into())
            .await
            .expect("open root");
        let path = "/tmp/codeg-wt-demote".to_string();
        let wt = open_worktree_folder_core(&db, path.clone(), root.id)
            .await
            .expect("open worktree");
        assert_eq!(wt.parent_id, Some(root.id));
        // Reopening the same path as a worktree with an unknown source writes the
        // authoritative value (top-level) rather than keeping the stale parent.
        let demoted = open_worktree_folder_core(&db, path, 0)
            .await
            .expect("reopen worktree with no source");
        assert_eq!(
            demoted.parent_id, None,
            "explicit worktree open with unknown source demotes to top-level"
        );
    }

    #[tokio::test]
    async fn update_folder_color_core_roundtrips() {
        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-color-test".into())
            .await
            .expect("add");
        let updated = update_folder_color_core(&db, entry.id, "#ff8800".into())
            .await
            .expect("update color");
        assert_eq!(updated.color, "#ff8800");
        let read_back = get_folder_core(&db, entry.id).await.expect("get");
        assert_eq!(read_back.color, "#ff8800");
    }

    #[tokio::test]
    async fn update_folder_default_agent_core_set_then_clear() {
        use crate::web::event_bridge::{WebEventBroadcaster, WORK_TASK_CHANGED_EVENT};
        use std::sync::Arc;

        let db = fresh_in_memory_db().await;
        let entry = add_folder_to_history_core(&db, "/tmp/codeg-agent-test".into())
            .await
            .expect("add");
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        let set =
            update_folder_default_agent_core(&emitter, &db, entry.id, Some(AgentType::ClaudeCode))
                .await
                .expect("set agent");
        assert_eq!(set.default_agent_type, Some(AgentType::ClaudeCode));
        // The default is the last layer a work task inherits, and the boards
        // resolve it live — so the change has to reach them (web clients
        // included) rather than wait for an unrelated task event.
        let evt = rx.try_recv().expect("default agent should nudge the tasks");
        assert_eq!(evt.channel, WORK_TASK_CHANGED_EVENT);
        assert_eq!(evt.payload["kind"], "settings");
        assert_eq!(evt.payload["folder_id"], entry.id);

        let cleared = update_folder_default_agent_core(&emitter, &db, entry.id, None)
            .await
            .expect("clear agent");
        assert_eq!(cleared.default_agent_type, None);
        // Clearing it changes the inherited value just as much as setting it.
        assert_eq!(
            rx.try_recv()
                .expect("clearing should nudge too")
                .payload["kind"],
            "settings"
        );
    }

    #[tokio::test]
    async fn move_file_tree_entry_moves_file_into_subdir() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"x").expect("write");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");

        let new_rel = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            "sub".to_string(),
        )
        .await
        .expect("move");

        assert_eq!(new_rel.replace('\\', "/"), "sub/a.txt");
        assert!(!root.path().join("a.txt").exists());
        assert!(root.path().join("sub/a.txt").exists());
    }

    #[tokio::test]
    async fn move_file_tree_entry_moves_back_to_root() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");
        std::fs::write(root.path().join("sub/a.txt"), b"x").expect("write");

        let new_rel = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "sub/a.txt".to_string(),
            String::new(),
        )
        .await
        .expect("move to root");

        assert_eq!(new_rel, "a.txt");
        assert!(root.path().join("a.txt").exists());
        assert!(!root.path().join("sub/a.txt").exists());
    }

    #[tokio::test]
    async fn move_file_tree_entry_rejects_move_into_own_descendant() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir_all(root.path().join("src/inner")).expect("mkdir");

        let res = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "src".to_string(),
            "src/inner".to_string(),
        )
        .await;
        assert!(res.is_err(), "moving a dir into its own descendant must fail");
        assert!(root.path().join("src/inner").is_dir(), "source untouched");
    }

    #[tokio::test]
    async fn move_file_tree_entry_rejects_existing_target() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"1").expect("write");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");
        std::fs::write(root.path().join("sub/a.txt"), b"2").expect("write");

        let res = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            "sub".to_string(),
        )
        .await;
        assert!(res.is_err(), "name collision in destination must fail");
        assert!(root.path().join("a.txt").exists(), "source untouched");
    }

    #[tokio::test]
    async fn move_file_tree_entry_same_parent_is_noop() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");
        std::fs::write(root.path().join("sub/a.txt"), b"x").expect("write");

        let rel = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "sub/a.txt".to_string(),
            "sub".to_string(),
        )
        .await
        .expect("no-op move");
        assert_eq!(rel, "sub/a.txt");
        assert!(root.path().join("sub/a.txt").exists());
    }

    #[tokio::test]
    async fn move_file_tree_entry_rejects_parent_escape() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"x").expect("write");

        let res = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            "../evil".to_string(),
        )
        .await;
        assert!(res.is_err(), "dest containing '..' must be rejected");
    }
}

// Symlink confinement that `read_workspace_file_base64` relies on. Unix-only
// because it uses real filesystem symlinks.
#[cfg(all(test, unix))]
mod workspace_confinement_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[tokio::test]
    async fn reads_in_root_file() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"hello").expect("write");
        let b64 = read_workspace_file_base64(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            None,
        )
        .await
        .expect("should read in-root file");
        assert_eq!(b64, "aGVsbG8="); // base64("hello")
    }

    #[tokio::test]
    async fn rejects_symlink_escaping_root() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("secret"), b"top").expect("write");
        symlink(outside.path().join("secret"), root.path().join("link"))
            .expect("symlink");
        // The canonical target resolves outside the root, so the read is denied
        // even though `root/link` is lexically inside the workspace.
        let res = read_workspace_file_base64(
            root.path().to_string_lossy().into_owned(),
            "link".to_string(),
            None,
        )
        .await;
        assert!(res.is_err(), "symlink escaping the workspace must be rejected");
    }

    /// The strict predicate, applied the way the guarded call sites apply it:
    /// canonicalize both ends, then ask whether the target is reachable.
    fn strictly_within(root: &Path, target: &Path) -> bool {
        let Ok(canonical_root) = std::fs::canonicalize(root) else {
            return false;
        };
        let Ok(canonical_target) = std::fs::canonicalize(target) else {
            return false;
        };
        is_within_workspace(&canonical_root, &canonical_target)
    }

    #[test]
    fn strict_guard_rejects_symlink() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, b"x").expect("write");
        let link = root.path().join("asset.txt");
        symlink(&secret, &link).expect("symlink");
        assert!(!strictly_within(root.path(), &link));
    }

    #[tokio::test]
    async fn move_file_tree_entry_does_not_clobber_dangling_symlink() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("a.txt"), b"real").expect("write");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");
        // A dangling symlink occupies the destination name. `Path::exists()`
        // follows it and reports `false`, so the collision check must instead
        // use `symlink_metadata` or `fs::rename` would destroy the link.
        symlink(
            root.path().join("nonexistent-target"),
            root.path().join("sub/a.txt"),
        )
        .expect("symlink");

        let res = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "a.txt".to_string(),
            "sub".to_string(),
        )
        .await;
        assert!(res.is_err(), "must not clobber a dangling destination symlink");
        assert!(
            std::fs::symlink_metadata(root.path().join("sub/a.txt")).is_ok(),
            "dangling symlink must remain intact",
        );
        assert!(root.path().join("a.txt").exists(), "source untouched");
    }

    #[tokio::test]
    async fn move_file_tree_entry_moves_a_symlink_entry() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("target.txt"), b"x").expect("write");
        symlink(
            root.path().join("target.txt"),
            root.path().join("link.txt"),
        )
        .expect("symlink");
        std::fs::create_dir(root.path().join("sub")).expect("mkdir");

        let new_rel = move_file_tree_entry(
            root.path().to_string_lossy().into_owned(),
            "link.txt".to_string(),
            "sub".to_string(),
        )
        .await
        .expect("move symlink");
        assert_eq!(new_rel.replace('\\', "/"), "sub/link.txt");
        // The moved entry is still a symlink (the link itself moved, not its target).
        let meta = std::fs::symlink_metadata(root.path().join("sub/link.txt"))
            .expect("moved link exists");
        assert!(meta.file_type().is_symlink(), "entry stays a symlink");
        assert!(!root.path().join("link.txt").exists(), "old link gone");
    }
    #[tokio::test]
    async fn file_tree_walks_into_an_authorized_link_only() {
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        let stray = tempfile::tempdir().expect("stray");
        std::fs::write(root.path().join("own.txt"), b"x").expect("write");
        std::fs::write(linked.path().join("inside.txt"), b"x").expect("write");
        std::fs::create_dir(linked.path().join("src")).expect("mkdir");
        std::fs::write(linked.path().join("src/deep.ts"), b"x").expect("write");
        std::fs::write(stray.path().join("secret.txt"), b"x").expect("write");
        symlink(linked.path(), root.path().join("api")).expect("symlink");
        symlink(stray.path(), root.path().join("evil")).expect("symlink");

        // Only `api` is registered, mimicking a user-created link; `evil` is the
        // kind of symlink a cloned repo could ship.
        let canonical_target = std::fs::canonicalize(linked.path()).expect("canon");
        crate::folder_links::register(root.path(), &canonical_target);

        let nodes = get_file_tree(root.path().to_string_lossy().into_owned(), None)
            .await
            .expect("tree");

        let api = nodes
            .iter()
            .find(|n| matches!(n, FileTreeNode::Dir { name, .. } if name == "api"))
            .expect("authorized link renders as a directory");
        match api {
            FileTreeNode::Dir { children, path, .. } => {
                assert_eq!(path, "api");
                assert!(
                    children.iter().any(
                        |c| matches!(c, FileTreeNode::File { path, .. } if path == "api/inside.txt")
                    ),
                    "the linked directory's contents are grafted in: {children:?}"
                );
                // Nested paths must be re-anchored too, or the panel would
                // resolve them against the workspace root instead of the link.
                let src = children
                    .iter()
                    .find(|c| matches!(c, FileTreeNode::Dir { name, .. } if name == "src"))
                    .expect("nested directory is present");
                match src {
                    FileTreeNode::Dir { path, children, .. } => {
                        assert_eq!(path, "api/src");
                        assert!(
                            children.iter().any(|c| matches!(
                                c,
                                FileTreeNode::File { path, .. } if path == "api/src/deep.ts"
                            )),
                            "deep paths are prefixed once: {children:?}"
                        );
                    }
                    _ => unreachable!(),
                }
            }
            _ => unreachable!(),
        }

        // Both links are flagged so the panel can badge them.
        assert!(
            matches!(api, FileTreeNode::Dir { symlink: true, .. }),
            "an authorized link is still a symlink on disk: {api:?}"
        );

        // The unregistered symlink is a *directory* — rendering it as a file
        // was issue #430 — but it is not walked into: empty children, which the
        // panel lazy-loads on expand.
        let evil = nodes
            .iter()
            .find(|n| matches!(n, FileTreeNode::Dir { name, .. } if name == "evil"))
            .expect("an unauthorized symlinked directory still renders as a directory");
        match evil {
            FileTreeNode::Dir {
                children,
                path,
                symlink,
                ..
            } => {
                assert_eq!(path, "evil");
                assert!(symlink, "flagged so the row gets the link badge");
                assert!(
                    children.is_empty(),
                    "an unauthorized symlink must not be walked into: {children:?}"
                );
            }
            _ => unreachable!(),
        }

        // Same answer at the depth the panel actually renders
        // (`WORKSPACE_TREE_MAX_DEPTH`), which is the snapshot the workspace
        // broadcaster ships.
        let shallow = get_file_tree(root.path().to_string_lossy().into_owned(), Some(2))
            .await
            .expect("depth-2 tree");
        assert!(
            shallow.iter().any(
                |n| matches!(n, FileTreeNode::Dir { name, symlink: true, .. } if name == "evil")
            ),
            "the stray link is a flagged directory in the broadcast snapshot too: {shallow:?}"
        );

        crate::folder_links::unregister(root.path(), &canonical_target);
    }

    /// A link pointing at an ancestor gives the workspace root a second name
    /// (`up/<root name>`), and expanding symlinked directories (issue #430) put
    /// that name one click away. The lexical `target == root` guard these three
    /// commands used did not see it, so deleting the alias ran `remove_dir_all`
    /// over the workspace itself — verified before the fix: the call returned
    /// `Ok(())` and took the workspace's files with it.
    #[tokio::test]
    async fn ancestor_link_cannot_be_used_to_destroy_the_workspace_root() {
        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("workspace");
        std::fs::create_dir(&root).expect("mkdir root");
        std::fs::write(root.join("precious.txt"), b"data").expect("write");
        symlink(parent.path(), root.join("up")).expect("symlink");
        let root_arg = root.to_string_lossy().into_owned();
        let alias = "up/workspace".to_string();

        assert!(
            delete_file_tree_entry(root_arg.clone(), alias.clone())
                .await
                .is_err(),
            "deleting the root under an alias must be refused"
        );
        assert!(
            rename_file_tree_entry(root_arg.clone(), alias.clone(), "renamed".to_string())
                .await
                .is_err(),
            "renaming the root under an alias must be refused"
        );
        std::fs::create_dir(root.join("dest")).expect("mkdir dest");
        assert!(
            move_file_tree_entry(root_arg.clone(), alias, "dest".to_string())
                .await
                .is_err(),
            "moving the root under an alias must be refused"
        );

        assert!(
            root.join("precious.txt").exists(),
            "the workspace survived every attempt"
        );

        // The link entry itself lives directly in the workspace, so it stays
        // removable — these commands act on the link, never on its target.
        delete_file_tree_entry(root_arg, "up".to_string())
            .await
            .expect("unlink the ancestor link");
        assert!(
            std::fs::symlink_metadata(root.join("up")).is_err(),
            "the link is gone"
        );
        assert!(
            parent.path().join("workspace").exists(),
            "and its target is untouched"
        );
    }

    /// Destroying content *through* an unauthorized symlink needs explicit
    /// authorization: the tree makes such a folder browsable and its files
    /// open and save (issue #430), but `delete`/`rename`/`move` resolve outside
    /// the workspace and are refused. Registering the link — what the "link
    /// folder" dialog does — restores full mutability, which is the point of a
    /// multi-folder workspace.
    #[tokio::test]
    async fn destructive_ops_through_a_link_require_authorization() {
        let root = tempfile::tempdir().expect("root");
        let stray = tempfile::tempdir().expect("stray");
        std::fs::create_dir(stray.path().join("sub")).expect("mkdir");
        std::fs::write(stray.path().join("sub/note.md"), b"x").expect("write");
        symlink(stray.path(), root.path().join("kb")).expect("symlink");
        let root_arg = root.path().to_string_lossy().into_owned();

        assert!(
            delete_file_tree_entry(root_arg.clone(), "kb/sub".to_string())
                .await
                .is_err(),
            "an unauthorized link is not a licence to delete outside the workspace"
        );
        assert!(stray.path().join("sub/note.md").exists(), "untouched");

        // Reading and saving through the same link still work — that is the
        // relaxation issue #430 asked for, and it is unaffected.
        read_file_for_edit(root_arg.clone(), "kb/sub/note.md".to_string())
            .await
            .expect("files inside the link still open");

        // The link entry itself lives in the workspace, so it stays removable.
        let canonical_target = std::fs::canonicalize(stray.path()).expect("canon");
        crate::folder_links::register(root.path(), &canonical_target);
        delete_file_tree_entry(root_arg, "kb/sub".to_string())
            .await
            .expect("an authorized link is fully mutable");
        assert!(!stray.path().join("sub").exists(), "it really went away");
        crate::folder_links::unregister(root.path(), &canonical_target);
    }

    /// A workspace root is stored verbatim (`folder_service::add_folder` never
    /// canonicalizes), so the root itself can be a symlink. Reaching that link
    /// under an alias must not let the tree unlink it: the contents would
    /// survive but the configured workspace would point at nothing. Verified
    /// before the fix — the delete returned `Ok(())` and the root link was gone.
    #[tokio::test]
    async fn a_symlinked_workspace_root_cannot_be_unlinked_through_an_alias() {
        let base = tempfile::tempdir().expect("base");
        let parent = base.path().join("parent");
        std::fs::create_dir(&parent).expect("mkdir parent");
        let actual = base.path().join("actual");
        std::fs::create_dir(&actual).expect("mkdir actual");
        std::fs::write(actual.join("precious.txt"), b"data").expect("write");
        // The configured root is a symlink, and inside it a link back up to the
        // directory that holds that symlink.
        let root = parent.join("workspace");
        symlink(&actual, &root).expect("root symlink");
        symlink(&parent, actual.join("up")).expect("up symlink");
        let root_arg = root.to_string_lossy().into_owned();
        let alias = "up/workspace".to_string();

        assert!(
            delete_file_tree_entry(root_arg.clone(), alias.clone())
                .await
                .is_err(),
            "unlinking the root symlink under an alias must be refused"
        );
        assert!(
            rename_file_tree_entry(root_arg.clone(), alias.clone(), "renamed".to_string())
                .await
                .is_err(),
            "renaming the root symlink under an alias must be refused"
        );
        std::fs::create_dir(actual.join("dest")).expect("mkdir dest");
        assert!(
            move_file_tree_entry(root_arg.clone(), alias, "dest".to_string())
                .await
                .is_err(),
            "moving the root symlink under an alias must be refused"
        );
        assert!(
            std::fs::symlink_metadata(&root).is_ok(),
            "the root symlink is still there"
        );
        assert!(actual.join("precious.txt").exists(), "contents intact");

        // The `up` link is not part of the root path, so it stays removable.
        delete_file_tree_entry(root_arg, "up".to_string())
            .await
            .expect("an ordinary link inside the workspace is still unlinkable");
        assert!(std::fs::symlink_metadata(actual.join("up")).is_err());
        assert!(std::fs::symlink_metadata(&root).is_ok(), "root untouched");
    }

    /// The third alias shape review found: an intermediate link in the root's
    /// own resolution chain. `workspace -> ../hop`, `hop -> actual`, and a link
    /// back up inside — removing `hop` would leave the workspace dangling even
    /// though `hop` is nowhere in the root's *lexical* path. Confining the
    /// entry's parent to the canonical root closes this without knowing about
    /// the shape at all.
    #[tokio::test]
    async fn a_link_in_the_roots_resolution_chain_cannot_be_removed() {
        let base = tempfile::tempdir().expect("base");
        let actual = base.path().join("actual");
        std::fs::create_dir(&actual).expect("mkdir actual");
        std::fs::write(actual.join("precious.txt"), b"data").expect("write");
        let hop = base.path().join("hop");
        symlink(&actual, &hop).expect("hop");
        let root = base.path().join("workspace");
        symlink(&hop, &root).expect("root -> hop -> actual");
        symlink(base.path(), actual.join("up")).expect("up");
        let root_arg = root.to_string_lossy().into_owned();

        for path in ["up/hop", "up/workspace"] {
            assert!(
                delete_file_tree_entry(root_arg.clone(), path.to_string())
                    .await
                    .is_err(),
                "{path} resolves outside the workspace and must be refused"
            );
        }
        assert!(std::fs::symlink_metadata(&hop).is_ok(), "hop survives");
        assert!(std::fs::symlink_metadata(&root).is_ok(), "root survives");
        assert!(actual.join("precious.txt").exists(), "contents intact");
    }

    /// A genuinely relative path naming `target`, built by walking out of the
    /// process working directory and back down. Lets a test exercise the
    /// relative-root path without `set_current_dir`, which is process-global
    /// and would race the rest of the suite.
    fn relative_from_cwd(target: &Path) -> PathBuf {
        let cwd = std::env::current_dir().expect("cwd");
        let mut relative = PathBuf::new();
        for _ in cwd
            .components()
            .filter(|c| matches!(c, Component::Normal(_)))
        {
            relative.push("..");
        }
        for component in target.components() {
            if let Component::Normal(name) = component {
                relative.push(name);
            }
        }
        relative
    }

    /// Workspace roots are stored verbatim, so nothing guarantees they are
    /// absolute or canonical. A relative root has to be anchored to the working
    /// directory before its resolution is walked: building the walk's path up
    /// from empty would pop a leading `..` into nothing and stat a different
    /// path entirely, silently protecting no links at all.
    #[tokio::test]
    async fn a_relative_workspace_root_protects_its_links() {
        let base = tempfile::tempdir().expect("base");
        let actual = base.path().join("actual");
        std::fs::create_dir(&actual).expect("mkdir actual");
        std::fs::write(actual.join("precious.txt"), b"data").expect("write");
        let hop = actual.join("hop");
        symlink(Path::new("."), &hop).expect("hop -> .");

        // `<cwd-relative>/…/actual/hop`, i.e. a leading run of `..`.
        let relative_root = relative_from_cwd(&hop);
        assert!(!relative_root.is_absolute(), "the test root is relative");
        assert!(
            relative_root.is_dir(),
            "and it names the same directory: {relative_root:?}"
        );
        let root_arg = relative_root.to_string_lossy().into_owned();

        // It must protect exactly what the absolute spelling protects.
        assert_eq!(
            root_resolution_links(&relative_root),
            root_resolution_links(&hop),
            "a relative root resolves to the same protected links"
        );

        assert!(
            delete_file_tree_entry(root_arg.clone(), "hop".to_string())
                .await
                .is_err(),
            "deleting the root's own link through a relative root must be refused"
        );
        assert!(
            rename_file_tree_entry(root_arg.clone(), "hop".to_string(), "x".to_string())
                .await
                .is_err(),
            "renaming it must be refused"
        );
        std::fs::create_dir(actual.join("dest")).expect("mkdir dest");
        assert!(
            move_file_tree_entry(root_arg.clone(), "hop".to_string(), "dest".to_string())
                .await
                .is_err(),
            "moving it must be refused"
        );
        assert!(std::fs::symlink_metadata(&hop).is_ok(), "the link survives");

        // Ordinary work through the same relative root still succeeds.
        delete_file_tree_entry(root_arg, "precious.txt".to_string())
            .await
            .expect("in-root work is unaffected by a relative root");
    }

    /// The same, for a root carrying a leading `./`. Anchoring runs before any
    /// component is looked at, so this shares a code path with the test above
    /// rather than isolating a literal `./hop` — isolating that would need the
    /// fixture to sit inside the working directory, i.e. inside the source
    /// tree, which is not worth it for a path the anchor already subsumes.
    #[tokio::test]
    async fn a_dot_prefixed_relative_root_protects_its_links() {
        let base = tempfile::tempdir().expect("base");
        let actual = base.path().join("actual");
        std::fs::create_dir(&actual).expect("mkdir actual");
        let hop = actual.join("hop");
        symlink(Path::new("."), &hop).expect("hop -> .");

        let dotted = Path::new(".").join(relative_from_cwd(&hop));
        assert!(!dotted.is_absolute(), "still relative");
        assert_eq!(
            root_resolution_links(&dotted),
            root_resolution_links(&hop),
            "a `./`-prefixed root protects the same links"
        );

        assert!(
            delete_file_tree_entry(dotted.to_string_lossy().into_owned(), "hop".to_string())
                .await
                .is_err(),
            "the root's own link stays protected"
        );
        assert!(std::fs::symlink_metadata(&hop).is_ok(), "the link survives");
    }

    /// The root symlink can live *inside* its own canonical target
    /// (`actual/workspace -> .`, opened as `actual/workspace`). Then it is an
    /// ordinary entry of the workspace — parent inside the root, so the
    /// outward boundary has nothing to say — yet unlinking it leaves the
    /// configured folder pointing at nothing while every file survives.
    #[tokio::test]
    async fn the_roots_own_link_cannot_be_destroyed_from_inside() {
        let base = tempfile::tempdir().expect("base");
        let actual = base.path().join("actual");
        std::fs::create_dir(&actual).expect("mkdir actual");
        std::fs::write(actual.join("precious.txt"), b"data").expect("write");
        let root = actual.join("workspace");
        symlink(Path::new("."), &root).expect("workspace -> .");
        let root_arg = root.to_string_lossy().into_owned();

        assert!(
            delete_file_tree_entry(root_arg.clone(), "workspace".to_string())
                .await
                .is_err(),
            "unlinking the root's own link must be refused"
        );
        assert!(
            rename_file_tree_entry(root_arg.clone(), "workspace".to_string(), "x".to_string())
                .await
                .is_err(),
            "renaming it must be refused"
        );
        std::fs::create_dir(actual.join("dest")).expect("mkdir dest");
        assert!(
            move_file_tree_entry(root_arg, "workspace".to_string(), "dest".to_string())
                .await
                .is_err(),
            "moving it must be refused"
        );
        assert!(
            std::fs::symlink_metadata(&root).is_ok(),
            "root link survives"
        );
        assert!(actual.join("precious.txt").exists(), "contents intact");
    }

    /// The guard identifies root-path links by *position*, never by "resolves
    /// to the root" — that would refuse an unrelated `self -> .` the root does
    /// not depend on, turning a legitimate action into an error. An ordinary
    /// root with links pointing back at it stays fully mutable.
    #[tokio::test]
    async fn links_pointing_at_an_ordinary_root_stay_mutable() {
        let root = tempfile::tempdir().expect("root");
        std::fs::write(root.path().join("keep.txt"), b"data").expect("write");
        std::fs::create_dir(root.path().join("dest")).expect("mkdir");
        for name in ["self", "here", "again"] {
            symlink(Path::new("."), root.path().join(name)).expect("self link");
        }
        let root_arg = root.path().to_string_lossy().into_owned();

        delete_file_tree_entry(root_arg.clone(), "self".to_string())
            .await
            .expect("a link pointing at the root is deletable");
        rename_file_tree_entry(root_arg.clone(), "here".to_string(), "renamed".to_string())
            .await
            .expect("...renamable");
        move_file_tree_entry(root_arg, "again".to_string(), "dest".to_string())
            .await
            .expect("...movable");

        assert!(std::fs::symlink_metadata(root.path().join("self")).is_err());
        assert!(std::fs::symlink_metadata(root.path().join("renamed")).is_ok());
        assert!(std::fs::symlink_metadata(root.path().join("dest/again")).is_ok());
        assert!(root.path().join("keep.txt").exists(), "contents intact");
    }

    /// A root with components *after* a link (`actual/sub/hop -> ..` opened as
    /// `actual/sub/hop/sub`) resolves that link to something other than the
    /// canonical root, so "resolves to the root" does not recognise it.
    /// Following the root's resolution and recording what it passes through
    /// does.
    #[tokio::test]
    async fn a_root_link_with_a_suffix_after_it_cannot_be_destroyed() {
        let base = tempfile::tempdir().expect("base");
        let sub = base.path().join("actual/sub");
        std::fs::create_dir_all(&sub).expect("mkdir");
        std::fs::write(sub.join("precious.txt"), b"data").expect("write");
        let hop = sub.join("hop");
        symlink(Path::new(".."), &hop).expect("hop -> ..");
        // The configured root walks through `hop` and then back down into `sub`.
        let root = hop.join("sub");
        let root_arg = root.to_string_lossy().into_owned();

        assert!(
            delete_file_tree_entry(root_arg.clone(), "hop".to_string())
                .await
                .is_err(),
            "deleting the link the root walks through must be refused"
        );
        assert!(
            rename_file_tree_entry(root_arg.clone(), "hop".to_string(), "x".to_string())
                .await
                .is_err(),
            "renaming it must be refused"
        );
        std::fs::create_dir(sub.join("dest")).expect("mkdir dest");
        assert!(
            move_file_tree_entry(root_arg, "hop".to_string(), "dest".to_string())
                .await
                .is_err(),
            "moving it must be refused"
        );
        assert!(std::fs::symlink_metadata(&hop).is_ok(), "the link survives");
        assert!(sub.join("precious.txt").exists(), "contents intact");
    }

    /// A link that sits inside *another link's target* is still one the root is
    /// resolved through: `actual/hop -> .` reached through a root
    /// `workspace -> actual/hop`. `hop` is nowhere in the root's own component
    /// list, and it resolves to `actual` rather than to the root, so only
    /// following the resolution the way the kernel does recognises it.
    #[tokio::test]
    async fn a_link_inside_the_root_links_target_cannot_be_destroyed() {
        let base = tempfile::tempdir().expect("base");
        let actual = base.path().join("actual");
        std::fs::create_dir(&actual).expect("mkdir actual");
        std::fs::write(actual.join("precious.txt"), b"data").expect("write");
        let hop = actual.join("hop");
        symlink(Path::new("."), &hop).expect("hop -> .");
        let root = base.path().join("workspace");
        symlink(&hop, &root).expect("workspace -> actual/hop");
        let root_arg = root.to_string_lossy().into_owned();

        assert!(
            delete_file_tree_entry(root_arg.clone(), "hop".to_string())
                .await
                .is_err(),
            "a link inside the root link's target must be refused"
        );
        assert!(
            rename_file_tree_entry(root_arg.clone(), "hop".to_string(), "x".to_string())
                .await
                .is_err(),
            "renaming it must be refused"
        );
        std::fs::create_dir(actual.join("dest")).expect("mkdir dest");
        assert!(
            move_file_tree_entry(root_arg, "hop".to_string(), "dest".to_string())
                .await
                .is_err(),
            "moving it must be refused"
        );
        assert!(std::fs::symlink_metadata(&hop).is_ok(), "hop survives");
        assert!(std::fs::symlink_metadata(&root).is_ok(), "root survives");
        assert!(actual.join("precious.txt").exists(), "contents intact");
    }

    /// A link cycle in the root's resolution must not hang or recurse without
    /// bound — the hop budget ends it and the outward boundary still applies.
    #[tokio::test]
    async fn a_link_cycle_in_the_root_terminates() {
        let base = tempfile::tempdir().expect("base");
        let a = base.path().join("a");
        let b = base.path().join("b");
        symlink(&b, &a).expect("a -> b");
        symlink(&a, &b).expect("b -> a");
        // Resolving this root never finishes; the walk must still return.
        assert!(
            root_resolution_links(&a).len() <= 64,
            "bounded, and returned"
        );

        // A real workspace alongside the cycle keeps working.
        let root = base.path().join("workspace");
        std::fs::create_dir(&root).expect("mkdir");
        std::fs::write(root.join("keep.txt"), b"x").expect("write");
        delete_file_tree_entry(root.to_string_lossy().into_owned(), "keep.txt".to_string())
            .await
            .expect("unrelated work is unaffected");
    }

    /// The contract the panel's lazy expand depends on: re-rooting the walk at
    /// the link itself resolves it (`WalkDir::follow_root_links`), so the empty
    /// child list `get_file_tree` returns for a symlinked directory can be
    /// filled in one level at a time — no descent through links needed in the
    /// bulk walk, and no way for a link loop to run away.
    #[tokio::test]
    async fn file_tree_rooted_at_a_stray_symlink_lists_its_contents() {
        let root = tempfile::tempdir().expect("root");
        let stray = tempfile::tempdir().expect("stray");
        std::fs::write(stray.path().join("note.md"), b"x").expect("write");
        std::fs::create_dir(stray.path().join("sub")).expect("mkdir");
        symlink(stray.path(), root.path().join("evil")).expect("symlink");

        let nodes = get_file_tree(
            root.path().join("evil").to_string_lossy().into_owned(),
            Some(1),
        )
        .await
        .expect("tree rooted at the link");

        assert!(
            nodes
                .iter()
                .any(|n| matches!(n, FileTreeNode::File { path, .. } if path == "note.md")),
            "the link's own contents are listed: {nodes:?}"
        );
        assert!(
            nodes
                .iter()
                .any(|n| matches!(n, FileTreeNode::Dir { path, .. } if path == "sub")),
            "nested directories come back expandable: {nodes:?}"
        );
    }

    /// A link to a file, and a link that resolves to nothing, have no contents
    /// to expand — a leaf file is the honest rendering for both.
    #[tokio::test]
    async fn file_tree_keeps_file_and_dangling_symlinks_as_leaves() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::write(outside.path().join("real.txt"), b"x").expect("write");
        symlink(outside.path().join("real.txt"), root.path().join("to-file")).expect("symlink");
        symlink(outside.path().join("gone"), root.path().join("dangling")).expect("symlink");

        let nodes = get_file_tree(root.path().to_string_lossy().into_owned(), None)
            .await
            .expect("tree");

        for name in ["to-file", "dangling"] {
            assert!(
                nodes
                    .iter()
                    .any(|n| matches!(n, FileTreeNode::File { name: n, .. } if n == name)),
                "{name} stays a leaf file: {nodes:?}"
            );
        }
    }

    /// Search reports the link as a directory (so `@`-mention and the search
    /// dialog show the right icon) without pulling its contents into the index
    /// — walking every stray link would mean pnpm symlink farms and loops.
    #[tokio::test]
    async fn workspace_search_reports_a_stray_symlink_as_a_dir_without_descending() {
        let root = tempfile::tempdir().expect("root");
        let stray = tempfile::tempdir().expect("stray");
        std::fs::write(stray.path().join("secret.txt"), b"x").expect("write");
        symlink(stray.path(), root.path().join("evil")).expect("symlink");

        let entries = list_workspace_files(root.path().to_string_lossy().into_owned())
            .await
            .expect("list");

        let evil = entries
            .iter()
            .find(|e| e.path == "evil")
            .expect("the link is listed");
        assert_eq!(evil.kind, WorkspaceEntryKind::Dir);
        assert!(
            !entries.iter().any(|e| e.path.starts_with("evil/")),
            "an unauthorized link's contents stay out of the index: {entries:?}"
        );
    }

    /// Issue #430's second half: once the tree lets you into a symlinked
    /// folder, the files inside it have to actually open. The path is
    /// user-navigated (`..`-free, relative), which is the boundary
    /// `ensure_user_navigable_path` draws — the same one `rename`/`move`/
    /// `delete` have always drawn.
    #[tokio::test]
    async fn user_navigated_reads_reach_into_a_stray_symlinked_directory() {
        let root = tempfile::tempdir().expect("root");
        let stray = tempfile::tempdir().expect("stray");
        std::fs::write(stray.path().join("note.md"), b"hello").expect("write");
        symlink(stray.path(), root.path().join("kb")).expect("symlink");
        let root_arg = root.path().to_string_lossy().into_owned();

        let preview = read_file_preview(root_arg.clone(), "kb/note.md".to_string())
            .await
            .expect("preview a file inside a symlinked folder");
        assert_eq!(preview.content, "hello");

        let edit = read_file_for_edit(root_arg.clone(), "kb/note.md".to_string())
            .await
            .expect("open a file inside a symlinked folder for edit");
        assert_eq!(edit.content, "hello");

        save_file_content(
            root_arg.clone(),
            "kb/note.md".to_string(),
            "bye".to_string(),
            Some(edit.etag),
        )
        .await
        .expect("save through the link");
        assert_eq!(
            std::fs::read_to_string(stray.path().join("note.md")).expect("read back"),
            "bye"
        );

        // The lexical boundary is still enforced: `..` never resolves.
        assert!(
            read_file_for_edit(root_arg, "../escape.md".to_string())
                .await
                .is_err(),
            "'..' must stay rejected"
        );
    }

    /// The HTML preview inlines paths named by the *markup*, not by a click, so
    /// its guard must stay strict even though user navigation was relaxed.
    #[tokio::test]
    async fn html_preview_inlining_still_refuses_a_stray_symlinked_directory() {
        let root = tempfile::tempdir().expect("root");
        let stray = tempfile::tempdir().expect("stray");
        std::fs::write(stray.path().join("id_rsa"), b"key").expect("write");
        symlink(stray.path(), root.path().join("secrets")).expect("symlink");

        let res = read_workspace_file_base64(
            root.path().to_string_lossy().into_owned(),
            "secrets/id_rsa".to_string(),
            None,
        )
        .await;
        assert!(
            res.is_err(),
            "sub-resource inlining must not follow a stray link"
        );
    }

    #[tokio::test]
    async fn workspace_search_lists_files_inside_an_authorized_link() {
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        std::fs::create_dir(linked.path().join("src")).expect("mkdir");
        std::fs::write(linked.path().join("src/deep.ts"), b"x").expect("write");
        symlink(linked.path(), root.path().join("api")).expect("symlink");
        let canonical_target = std::fs::canonicalize(linked.path()).expect("canon");
        crate::folder_links::register(root.path(), &canonical_target);

        let entries = list_workspace_files(root.path().to_string_lossy().into_owned())
            .await
            .expect("list");
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"api"), "link itself is listed: {paths:?}");
        assert!(
            paths.contains(&"api/src/deep.ts"),
            "linked content is reachable by fuzzy search: {paths:?}"
        );

        crate::folder_links::unregister(root.path(), &canonical_target);
    }

    /// The strict rule now guards only the non-user-driven surfaces (HTML
    /// preview sub-resource inlining, the web upload chain) — see
    /// `is_within_workspace`. User-navigated reads go through
    /// `ensure_user_navigable_path` and are covered separately.
    #[test]
    fn strict_guard_allows_a_registered_link_but_not_a_stray_symlink() {
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        let stray = tempfile::tempdir().expect("stray");
        std::fs::write(linked.path().join("ok.txt"), b"x").expect("write");
        std::fs::write(stray.path().join("secret.txt"), b"x").expect("write");
        symlink(linked.path(), root.path().join("api")).expect("symlink");
        symlink(stray.path(), root.path().join("evil")).expect("symlink");

        let canonical_target = std::fs::canonicalize(linked.path()).expect("canon");
        crate::folder_links::register(root.path(), &canonical_target);

        assert!(
            strictly_within(root.path(), &root.path().join("api/ok.txt")),
            "a file inside a user-authorized link is in the workspace"
        );
        assert!(
            !strictly_within(root.path(), &root.path().join("evil/secret.txt")),
            "an unregistered symlink still cannot escape the root"
        );

        crate::folder_links::unregister(root.path(), &canonical_target);
        assert!(
            !strictly_within(root.path(), &root.path().join("api/ok.txt")),
            "revoking the link revokes access"
        );
    }
}
