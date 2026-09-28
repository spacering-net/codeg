//! Single source of truth for "is this path a git repository?" detection.
//!
//! The check is deliberately strict: the exact path must contain a `.git`
//! entry (directory for regular repos, file for linked worktrees and
//! submodules). We do **not** walk up to ancestors.
//!
//! Rationale: codeg scopes every workspace-facing feature (file tree
//! watcher, git changes panel, log panel) to the directory the user opens.
//! If one code path walks up and another doesn't, the UI falls into a
//! "schizophrenic" state where some panels see a repo and others don't.
//! Keeping the primitive strict forces every consumer onto the same
//! interpretation.
//!
//! Bare repositories are intentionally not supported — they have no working
//! tree, which makes them an unusual target for a workspace-oriented editor.

use std::{
    ffi::OsStr,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use crate::app_error::AppCommandError;

/// Returns true when `path` is the root of a git working tree.
///
/// `.git` may be a directory (normal repo) or a file (worktree/submodule
/// pointer). `Path::exists` treats both as present.
pub fn is_git_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

/// The main working tree `path` belongs to, when `path` is a **linked git
/// worktree** (`git worktree add`). `None` for a normal repo, a submodule or
/// other plain gitlink, a worktree of a bare repo, and anything unreadable.
///
/// This reads git's own on-disk pointers rather than spawning `git`, the same
/// way the workspace watcher resolves a worktree's metadata dirs: `<path>/.git`
/// is a FILE holding `gitdir: <private>`, and the private dir carries a
/// `commondir` file pointing at the repository's shared git dir. `commondir` is
/// the linked-worktree signature (a submodule's git dir has none), and for a
/// non-bare repo that shared dir is `<main working tree>/.git`, so its parent is
/// the answer.
///
/// The result is de-verbatimed ([`crate::paths::simplify_verbatim_path`]): it is
/// compared against, and stored as, ordinary user-facing paths, never fed back
/// into a jail check.
pub fn main_worktree_root(path: &Path) -> Option<PathBuf> {
    let dot_git = path.join(".git");
    // A normal repo keeps a `.git` DIRECTORY; only a link has a file.
    if !fs::symlink_metadata(&dot_git).ok()?.file_type().is_file() {
        return None;
    }
    let pointer = fs::read_to_string(&dot_git).ok()?;
    let gitdir = pointer
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    let private = PathBuf::from(gitdir);
    let private = if private.is_absolute() {
        private
    } else {
        path.join(private)
    };
    let private = fs::canonicalize(&private).ok()?;

    let commondir = fs::read_to_string(private.join("commondir")).ok()?;
    let commondir = commondir.trim();
    if commondir.is_empty() {
        return None;
    }
    let common = PathBuf::from(commondir);
    let common = if common.is_absolute() {
        common
    } else {
        private.join(common)
    };
    let common = fs::canonicalize(&common).ok()?;

    // Only a non-bare repo keeps its shared git dir at `<root>/.git`. A bare
    // repo's is the repository directory itself, and it has no working tree to
    // group under.
    if common.file_name()? != OsStr::new(".git") {
        return None;
    }
    Some(crate::paths::simplify_verbatim_path(common.parent()?))
}

/// Preflight guard for git commands. Short-circuits with a typed error code
/// when the target path is not a git working tree, so callers avoid locale-
/// dependent stderr parsing for the most common "wrong folder" failure.
pub fn ensure_git_repo(path: &str) -> Result<(), AppCommandError> {
    let root = Path::new(path);

    let root_meta = fs::metadata(root).map_err(|err| match err.kind() {
        ErrorKind::NotFound => {
            AppCommandError::not_found(format!("Workspace path does not exist: {path}"))
        }
        ErrorKind::PermissionDenied => {
            AppCommandError::permission_denied(format!("Cannot access workspace path: {path}"))
                .with_detail(err.to_string())
        }
        _ => AppCommandError::io(err)
            .with_detail(format!("Failed to inspect workspace path: {path}")),
    })?;

    if !root_meta.is_dir() {
        return Err(AppCommandError::invalid_input(format!(
            "Workspace path is not a directory: {path}"
        )));
    }

    let git_path = root.join(".git");
    match fs::metadata(&git_path) {
        Ok(_) => Ok(()),
        Err(err) => match err.kind() {
            ErrorKind::NotFound => Err(AppCommandError::not_a_git_repository(format!(
                "Not a Git repository: {path}"
            ))),
            ErrorKind::PermissionDenied => Err(AppCommandError::permission_denied(format!(
                "Cannot access Git metadata: {}",
                git_path.display()
            ))
            .with_detail(err.to_string())),
            _ => Err(AppCommandError::io(err).with_detail(format!(
                "Failed to inspect Git metadata: {}",
                git_path.display()
            ))),
        },
    }
}

/// Build a fake linked-worktree layout under `root`, returning
/// `(main_working_tree, linked_worktree)`. Mirrors what real git writes:
/// `<wt>/.git` is a FILE pointing at a private dir under
/// `<main>/.git/worktrees/`, which carries a `commondir` file pointing back at
/// the shared `.git`. Shared with the import tests, which need the same layout
/// on disk to exercise the folder-parent decision.
#[cfg(test)]
pub(crate) fn fixture_linked_worktree(root: &Path) -> (PathBuf, PathBuf) {
    let main = root.join("main");
    let common = main.join(".git");
    fs::create_dir_all(common.join("refs/heads")).expect("common refs");
    let private = common.join("worktrees/wt");
    fs::create_dir_all(&private).expect("private dir");
    // `../..` from `<common>/worktrees/wt` resolves back to `<common>`.
    fs::write(private.join("commondir"), "../..\n").expect("commondir");

    let worktree = root.join("wt");
    fs::create_dir_all(&worktree).expect("worktree dir");
    let private_canon = fs::canonicalize(&private).expect("canon private");
    fs::write(
        worktree.join(".git"),
        format!("gitdir: {}\n", private_canon.display()),
    )
    .expect("gitdir pointer");

    (
        crate::paths::simplify_verbatim_path(&fs::canonicalize(&main).expect("canon main")),
        crate::paths::simplify_verbatim_path(&fs::canonicalize(&worktree).expect("canon worktree")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_worktree_root_resolves_a_linked_worktree() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize root");
        let (main, worktree) = fixture_linked_worktree(&root);

        assert_eq!(main_worktree_root(&worktree), Some(main));
    }

    #[test]
    fn main_worktree_root_is_none_for_a_normal_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize root");
        std::fs::create_dir_all(root.join(".git")).expect("create .git dir");

        assert_eq!(main_worktree_root(&root), None);
    }

    #[test]
    fn main_worktree_root_is_none_without_a_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize root");

        assert_eq!(main_worktree_root(&root), None);
    }

    /// A submodule's `.git` file points at a FULL repository (its own
    /// `objects/`) with no `commondir` marker. It is not a worktree of the
    /// superproject and must not be grouped under it.
    #[test]
    fn main_worktree_root_is_none_for_a_submodule() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize root");

        let module_git = root.join("super/.git/modules/sub");
        std::fs::create_dir_all(module_git.join("objects")).expect("module objects");
        let module_git = std::fs::canonicalize(&module_git).expect("canon module git");

        let submodule = root.join("sub");
        std::fs::create_dir_all(&submodule).expect("submodule dir");
        std::fs::write(
            submodule.join(".git"),
            format!("gitdir: {}\n", module_git.display()),
        )
        .expect("gitdir pointer");

        assert_eq!(main_worktree_root(&submodule), None);
    }

    /// A worktree of a BARE repo: `commondir` names the repository directory
    /// itself, so there is no main working tree to group under.
    #[test]
    fn main_worktree_root_is_none_for_a_bare_repo_worktree() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize root");

        let common = root.join("repo.git");
        std::fs::create_dir_all(common.join("refs/heads")).expect("common refs");
        let private = common.join("worktrees/wt");
        std::fs::create_dir_all(&private).expect("private dir");
        std::fs::write(private.join("commondir"), "../..\n").expect("commondir");

        let worktree = root.join("wt");
        std::fs::create_dir_all(&worktree).expect("worktree dir");
        let private_canon = std::fs::canonicalize(&private).expect("canon private");
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", private_canon.display()),
        )
        .expect("gitdir pointer");

        assert_eq!(main_worktree_root(&worktree), None);
    }

    /// git writes an absolute `gitdir:`, but a hand-written relative one is
    /// legal and resolves against the worktree directory.
    #[test]
    fn main_worktree_root_accepts_a_relative_gitdir_pointer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize root");
        let (main, worktree) = fixture_linked_worktree(&root);
        std::fs::write(worktree.join(".git"), "gitdir: ../main/.git/worktrees/wt\n")
            .expect("relative gitdir pointer");

        assert_eq!(main_worktree_root(&worktree), Some(main));
    }
}
