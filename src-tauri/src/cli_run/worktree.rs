//! `codeg-cli run --worktree[=NAME]`: a fresh git worktree for one run.
//!
//! The same shape as an automation's per-run worktree: a sibling of the
//! repository, on a new branch from its HEAD (`cli/<NAME>`, or the start of
//! the run's id), left in place once the run is over for the user to review,
//! merge or delete. A workspace below the repository's top works in the same
//! directory of the new checkout. A launch that fails before its conversation
//! exists takes its worktree and branch away again: nothing ran in them.

use std::path::{Path, PathBuf};

use super::service::CliError;
use super::wire::WorktreeInfo;

/// The longest NAME `--worktree=NAME` takes.
pub const MAX_NAME: usize = 64;

/// A worktree made for a run.
#[derive(Debug, Clone)]
pub struct RunWorktree {
    /// The repository it was made from (where `git worktree` runs).
    pub repository: PathBuf,
    /// The worktree's own top directory.
    pub root: PathBuf,
    /// Where the run works: `root`, or the same subdirectory as the workspace.
    pub workspace: String,
    pub branch: String,
}

impl RunWorktree {
    pub fn info(&self) -> WorktreeInfo {
        WorktreeInfo {
            path: self.root.to_string_lossy().into_owned(),
            branch: self.branch.clone(),
        }
    }
}

/// Whether `name` can follow `cli/` in a branch name and a directory name
/// alike: letters, digits, `.`, `_` and `-`, not starting with `.` or `-`.
pub fn check_name(name: &str) -> Result<(), String> {
    let well_formed = !name.is_empty()
        && name.len() <= MAX_NAME
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.starts_with(['.', '-'])
        && !name.ends_with('.')
        && !name.ends_with(".lock")
        && !name.contains("..");
    if well_formed {
        Ok(())
    } else {
        Err(format!(
            "--worktree={name:?}: a name is up to {MAX_NAME} letters, digits, `.`, `_` and `-`, \
             not starting with `.` or `-`"
        ))
    }
}

/// Make the worktree for run `run_id` from the repository `workspace` is in.
/// `name` empty: the start of the run's id.
///
/// What is made is claimed first, each piece in a step that fails rather
/// than share it: the directory by creating it (which keeps out another run
/// trying the same name), the branch by creating it (git creates a ref under
/// a lock). Only then does `git worktree add` check the branch out into the
/// directory, under a lock of the attempt's own (`check_out`). An attempt
/// that fails there — a hook that refuses, say — takes away only what is
/// provably its own (`undo`), never what another run or another program made
/// under the same names.
pub async fn create(workspace: &str, name: &str, run_id: &str) -> Result<RunWorktree, CliError> {
    if !name.is_empty() {
        check_name(name).map_err(|m| CliError::usage("bad_worktree_name", m))?;
    }
    let (top, prefix) = locate(workspace).await?;
    check_git_version().await?;
    let repository = native(&top);
    let base = if name.is_empty() {
        run_id.chars().take(8).collect::<String>()
    } else {
        name.to_string()
    };
    let repo_name = repository
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".into());
    let Some(parent) = repository.parent() else {
        return Err(CliError::usage(
            "worktree_unavailable",
            format!(
                "--worktree: {} has no directory above it to put a worktree in",
                repository.display()
            ),
        ));
    };
    // Once as asked; then, the name or the directory being taken, with more
    // of the run's id to tell it apart.
    let retry = format!(
        "{base}-{}",
        run_id
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .skip(if name.is_empty() { 8 } else { 0 })
            .take(6)
            .collect::<String>()
    );
    let mut first_error = None;
    for label in [base, retry] {
        let branch = format!("cli/{label}");
        let root = parent.join(format!("{repo_name}-cli-{label}"));
        match attempt(&repository, &root, &branch, run_id).await {
            Ok(()) => {
                let workspace = in_worktree(&root, &prefix);
                let made = RunWorktree {
                    repository: repository.clone(),
                    root,
                    workspace: workspace.to_string_lossy().into_owned(),
                    branch,
                };
                if !workspace.is_dir() {
                    remove(&made).await;
                    return Err(CliError::usage(
                        "workspace_not_in_worktree",
                        format!(
                            "--worktree: {prefix:?} is not in the repository's HEAD, so the new \
                             worktree has no such directory; commit it, or run from the top of \
                             the repository"
                        ),
                    ));
                }
                return Ok(made);
            }
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    Err(CliError::execution(
        "worktree_failed",
        format!(
            "--worktree: could not add a worktree to {}: {}",
            repository.display(),
            first_error.unwrap_or_default()
        ),
    ))
}

/// One try at a worktree at `root` on a new `branch`; on failure, nothing
/// this try claimed is left.
async fn attempt(repository: &Path, root: &Path, branch: &str, run_id: &str) -> Result<(), String> {
    // The directory: created empty, which fails if anything is there.
    std::fs::create_dir(root).map_err(|e| format!("{}: {e}", root.display()))?;
    // The branch, from what is checked out: creating a ref that exists fails.
    if let Err(e) = git(repository, &["branch", "--no-track", branch, "HEAD"]).await {
        let _ = std::fs::remove_dir(root);
        return Err(e);
    }
    check_out(repository, root, branch, run_id).await
}

/// Check the claimed `branch` out into the claimed, empty `root`.
///
/// The empty directory keeps another run out, but not another program's
/// `git worktree add`, which takes an empty directory — and which could even
/// check this try's branch out. So the proof that a checkout at `root` is
/// this try's is a lock git puts on it the moment it registers it, with a
/// reason no other program knows; lifted once the checkout is done. A try
/// that fails from here on takes away a checkout only with that proof.
async fn check_out(
    repository: &Path,
    root: &Path,
    branch: &str,
    run_id: &str,
) -> Result<(), String> {
    let nonce = super::hello::random_hex(16);
    let reason = format!("codeg-cli is setting up run {run_id} ({nonce})");
    let root_arg = root.to_string_lossy().into_owned();
    let added = git(
        repository,
        &[
            "worktree",
            "add",
            "--lock",
            "--reason",
            reason.as_str(),
            root_arg.as_str(),
            branch,
        ],
    )
    .await;
    let done = match added {
        Ok(()) => git(repository, &["worktree", "unlock", root_arg.as_str()]).await,
        Err(e) => Err(e),
    };
    if done.is_err() {
        undo(repository, root, branch, &nonce).await;
    }
    done
}

/// After a try failed at its checkout: take away what is provably the try's
/// own, and nothing else. A checkout at `root` goes only when it carries the
/// try's lock (one a refusing post-checkout hook left, say: git keeps the
/// worktree then); `root` itself only while it is still the empty directory
/// the try made; then the branch, which git refuses while it is checked out
/// anywhere. Anyone else's checkout stays, with everything in it.
async fn undo(repository: &Path, root: &Path, branch: &str, nonce: &str) {
    let ours = listed_at(repository, root)
        .await
        .and_then(|listed| listed.locked)
        .is_some_and(|reason| reason.contains(nonce));
    if ours {
        // Twice: a locked worktree is only removed so.
        let root_arg = root.to_string_lossy().into_owned();
        let _ = git(
            repository,
            &[
                "worktree",
                "remove",
                "--force",
                "--force",
                root_arg.as_str(),
            ],
        )
        .await;
    }
    let _ = std::fs::remove_dir(root);
    let _ = git(repository, &["branch", "-D", branch]).await;
}

/// A worktree as `git worktree list --porcelain` lists it.
#[derive(Debug, Default, PartialEq)]
struct Listed {
    /// Its directory, as git prints it (`C:/x/y` on Windows).
    path: String,
    /// `refs/heads/<name>`, when a branch is checked out there.
    branch: Option<String>,
    /// The lock's reason when it is locked (empty for a lock without one).
    locked: Option<String>,
}

/// One block per worktree: `worktree <path>` first, then `HEAD <oid>`,
/// `branch <ref>` or `detached` (or `bare`), maybe `locked [<reason>]` or
/// `prunable [<reason>]`, and a blank line.
fn parse_listed(text: &str) -> Vec<Listed> {
    let mut all = Vec::new();
    let mut current: Option<Listed> = None;
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            all.extend(current.take());
            current = Some(Listed {
                path: path.to_string(),
                ..Listed::default()
            });
        } else if line.is_empty() {
            all.extend(current.take());
        } else if let Some(entry) = current.as_mut() {
            if let Some(branch) = line.strip_prefix("branch ") {
                entry.branch = Some(branch.to_string());
            } else if line == "locked" {
                entry.locked = Some(String::new());
            } else if let Some(reason) = line.strip_prefix("locked ") {
                entry.locked = Some(reason.to_string());
            }
        }
    }
    all.extend(current);
    all
}

/// The worktree `repository` has at `root`, if any.
async fn listed_at(repository: &Path, root: &Path) -> Option<Listed> {
    let root = std::fs::canonicalize(root).ok()?;
    let out = crate::process::tokio_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repository)
        .output()
        .await
        .ok()
        .filter(|out| out.status.success())?;
    parse_listed(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .find(|listed| std::fs::canonicalize(native(&listed.path)).is_ok_and(|path| path == root))
}

/// `--worktree` locks the checkout while it is set up (`git worktree add
/// --lock --reason`, git 2.33); an older git is told so before anything is
/// made. A version that does not read as one is let through: git itself then
/// says what it does not know.
async fn check_git_version() -> Result<(), CliError> {
    let out = crate::process::tokio_command("git")
        .arg("version")
        .output()
        .await
        .map_err(|e| CliError::execution("worktree_failed", format!("--worktree: git: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    match git_version(&text) {
        Some(version) if version < MIN_GIT => Err(CliError::usage(
            "worktree_unavailable",
            format!(
                "--worktree needs git {}.{} or later, and this is {}",
                MIN_GIT.0,
                MIN_GIT.1,
                text.trim()
            ),
        )),
        _ => Ok(()),
    }
}

/// The oldest git whose `worktree add` takes `--lock --reason`.
const MIN_GIT: (u32, u32) = (2, 33);

/// `(major, minor)` of `git version`'s `git version 2.50.1 (Apple Git-155)`,
/// `git version 2.45.2.windows.1`, ….
fn git_version(text: &str) -> Option<(u32, u32)> {
    let rest = text.trim().strip_prefix("git version ")?;
    let mut parts = rest.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// `git <args>` in `dir`; git's own words on failure.
async fn git(dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = crate::process::tokio_command("git")
        .args(args)
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Take away a worktree no run used: its checkout, then its branch. Best
/// effort; what is left is logged.
pub async fn remove(worktree: &RunWorktree) {
    let root = worktree.root.to_string_lossy().into_owned();
    for args in [
        vec!["worktree", "remove", "--force", root.as_str()],
        vec!["branch", "-D", worktree.branch.as_str()],
    ] {
        let done = crate::process::tokio_command("git")
            .args(&args)
            .current_dir(&worktree.repository)
            .output()
            .await;
        match done {
            Ok(out) if out.status.success() => {}
            Ok(out) => tracing::warn!(
                "[cli] could not undo the unused worktree {root} (git {}): {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => tracing::warn!("[cli] could not undo the unused worktree {root}: {e}"),
        }
    }
}

/// The top of the repository `workspace` is in, and the workspace's path
/// below it (`git rev-parse --show-prefix`: empty, or `sub/dir/`).
async fn locate(workspace: &str) -> Result<(String, String), CliError> {
    let out = crate::process::tokio_command("git")
        .args(["rev-parse", "--show-toplevel", "--show-prefix"])
        .current_dir(workspace)
        .output()
        .await
        .map_err(|e| CliError::execution("worktree_failed", format!("--worktree: git: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    match (out.status.success(), lines.next()) {
        (true, Some(top)) if !top.is_empty() => {
            Ok((top.to_string(), lines.next().unwrap_or("").to_string()))
        }
        _ => Err(CliError::usage(
            "not_a_git_repository",
            format!("--worktree needs a git repository; {workspace} is not in one"),
        )),
    }
}

/// `prefix` (`sub/dir/`, as git writes it) below `root`.
fn in_worktree(root: &Path, prefix: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in prefix.split('/').filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

/// A path as git prints it, in this platform's own form: `C:/x` on Windows
/// becomes `C:\x`.
fn native(path: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.replace('/', "\\"))
    } else {
        PathBuf::from(path)
    }
}

/// Repositories for the tests of runs with a worktree.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};

    pub fn git(dir: &Path, args: &[&str]) {
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
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repository with one commit holding `sub/file`, in a directory of its
    /// own (the worktrees go next to it).
    pub fn repository() -> (tempfile::TempDir, PathBuf) {
        let outer = tempfile::tempdir().unwrap();
        let repo = outer.path().join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        std::fs::write(repo.join("sub").join("file"), "x").unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "one"]);
        (outer, repo)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::repository;
    use super::*;

    #[test]
    fn a_name_must_suit_a_branch_and_a_directory() {
        for good in ["review", "fix-1", "v2.0_rc", "a"] {
            assert!(check_name(good).is_ok(), "{good}");
        }
        for bad in [
            "", "-x", ".x", "x.", "a..b", "x.lock", "a/b", "a b", "ü", "a\\b", "a:b",
        ] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        assert!(check_name(&"a".repeat(MAX_NAME)).is_ok());
        assert!(check_name(&"a".repeat(MAX_NAME + 1)).is_err());
    }

    #[tokio::test]
    async fn a_worktree_is_made_next_to_the_repository_on_its_own_branch() {
        let (outer, repo) = repository();
        let run_id = "8d0c7c2e-3f0b-4a5e-9c1b-6f2d1e0a7b44";
        let made = create(&repo.to_string_lossy(), "", run_id).await.unwrap();
        assert_eq!(made.branch, "cli/8d0c7c2e");
        let root = std::fs::canonicalize(&made.root).unwrap();
        let expected = std::fs::canonicalize(outer.path())
            .unwrap()
            .join("repo-cli-8d0c7c2e");
        assert_eq!(root, expected);
        assert_eq!(made.workspace, made.root.to_string_lossy());
        assert!(made.root.join("sub").join("file").is_file());
        let listed = listed_at(&repo, &made.root).await.expect("a worktree");
        assert_eq!(listed.branch.as_deref(), Some("refs/heads/cli/8d0c7c2e"));
        assert_eq!(listed.locked, None, "its setting-up lock is lifted");

        // The same name again: taken, so the next one has more of the id.
        let again = create(&repo.to_string_lossy(), "", run_id).await.unwrap();
        assert_eq!(again.branch, "cli/8d0c7c2e-3f0b4a");
        assert_ne!(again.root, made.root);

        // A name of one's own, from a subdirectory: the same subdirectory.
        let named = create(&repo.join("sub").to_string_lossy(), "review", run_id)
            .await
            .unwrap();
        assert_eq!(named.branch, "cli/review");
        assert!(named.workspace.ends_with("sub"), "{}", named.workspace);
        assert!(Path::new(&named.workspace).join("file").is_file());
        let named_again = create(&repo.to_string_lossy(), "review", run_id)
            .await
            .unwrap();
        assert_eq!(named_again.branch, "cli/review-8d0c7c");

        // Undone: neither the checkout nor the branch is left.
        remove(&named).await;
        assert!(!named.root.exists());
        let branches = std::process::Command::new("git")
            .args(["branch", "--list", "cli/review"])
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());
    }

    #[tokio::test]
    async fn outside_a_repository_there_is_no_worktree_to_make() {
        let plain = tempfile::tempdir().unwrap();
        let err = create(&plain.path().to_string_lossy(), "", "8d0c7c2e")
            .await
            .unwrap_err();
        assert_eq!(err.body.error.code, "not_a_git_repository");
        assert_eq!(err.status, 400);
        let err = create(&plain.path().to_string_lossy(), "../x", "8d0c7c2e")
            .await
            .unwrap_err();
        assert_eq!(err.body.error.code, "bad_worktree_name");
    }

    /// A post-checkout hook that fails makes `git worktree add` fail after it
    /// made the branch and the directory: neither stays, for either attempt.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_refusing_hook_leaves_no_worktree_or_branch() {
        use std::os::unix::fs::PermissionsExt;
        let (outer, repo) = repository();
        let hook = repo.join(".git").join("hooks").join("post-checkout");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = create(&repo.to_string_lossy(), "hooked", "8d0c7c2e-3f0b")
            .await
            .unwrap_err();
        assert_eq!(err.body.error.code, "worktree_failed");
        let left: Vec<_> = std::fs::read_dir(outer.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["repo"], "no worktree directory left beside it");
        let branches = std::process::Command::new("git")
            .args(["branch", "--list", "cli/*"])
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
            "{}",
            String::from_utf8_lossy(&branches.stdout)
        );
    }

    /// A branch another program made under the name is not this run's to take
    /// away: the run steps aside to the next name, and the branch stays.
    #[tokio::test]
    async fn a_branch_made_elsewhere_under_the_name_is_left_alone() {
        let (outer, repo) = repository();
        super::test_support::git(&repo, &["branch", "cli/taken"]);
        let made = create(&repo.to_string_lossy(), "taken", "8d0c7c2e-3f0b")
            .await
            .unwrap();
        assert_eq!(made.branch, "cli/taken-8d0c7c");
        let branches = std::process::Command::new("git")
            .args(["branch", "--list", "cli/taken"])
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).contains("cli/taken"));
        assert!(
            !outer.path().join("repo-cli-taken").exists(),
            "the directory it claimed for that name went with the try"
        );
    }

    /// The try's claims — its directory, empty, and its branch — and then
    /// someone else's `git worktree add` into that directory, on a branch of
    /// its own (`theirs`) or on the try's own one (`None`), with uncommitted
    /// work in it.
    fn claimed_then_taken(theirs: Option<&str>) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let (outer, repo) = repository();
        let root = outer.path().join("repo-cli-raced");
        let root_arg = root.to_string_lossy().into_owned();
        std::fs::create_dir(&root).unwrap();
        super::test_support::git(&repo, &["branch", "--no-track", "cli/raced", "HEAD"]);
        match theirs {
            Some(branch) => {
                super::test_support::git(&repo, &["worktree", "add", "-b", branch, &root_arg])
            }
            None => super::test_support::git(&repo, &["worktree", "add", &root_arg, "cli/raced"]),
        }
        std::fs::write(root.join("their-work"), "uncommitted").unwrap();
        (outer, repo, root)
    }

    fn branches(repo: &Path) -> String {
        let out = std::process::Command::new("git")
            .args(["branch", "--list"])
            .current_dir(repo)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Another program's `git worktree add` takes the empty directory a try
    /// made, so the try's own checkout fails: its undoing leaves that
    /// checkout and everything in it, and takes only the try's branch.
    #[tokio::test]
    async fn a_checkout_someone_else_put_in_the_claimed_directory_stays() {
        let (_outer, repo, root) = claimed_then_taken(Some("theirs"));
        assert!(check_out(&repo, &root, "cli/raced", "8d0c7c2e")
            .await
            .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("their-work")).unwrap(),
            "uncommitted"
        );
        assert!(root.join("sub").join("file").is_file());
        let listed = listed_at(&repo, &root).await.expect("still a worktree");
        assert_eq!(listed.branch.as_deref(), Some("refs/heads/theirs"));
        let branches = branches(&repo);
        assert!(!branches.contains("cli/raced"), "{branches}");
        assert!(branches.contains("theirs"), "{branches}");
    }

    /// The same with the try's own branch checked out there: that checkout
    /// is on the right branch at the right place, but without the try's
    /// lock, so it stays, and the branch with it.
    #[tokio::test]
    async fn a_checkout_of_the_tries_own_branch_someone_else_made_stays() {
        let (_outer, repo, root) = claimed_then_taken(None);
        assert!(check_out(&repo, &root, "cli/raced", "8d0c7c2e")
            .await
            .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("their-work")).unwrap(),
            "uncommitted"
        );
        let listed = listed_at(&repo, &root).await.expect("still a worktree");
        assert_eq!(listed.branch.as_deref(), Some("refs/heads/cli/raced"));
        assert_eq!(listed.locked, None);
        assert!(branches(&repo).contains("cli/raced"));
    }

    #[test]
    fn the_porcelain_list_reads_as_one_entry_per_worktree() {
        let text = "worktree C:/src/repo\r\nHEAD 1111\r\nbranch refs/heads/main\r\n\r\n\
                    worktree C:/src/repo-cli-x\r\nHEAD 2222\r\nbranch refs/heads/cli/x\r\n\
                    locked codeg-cli is setting up run r (abc)\r\n\r\n\
                    worktree /w/detached\nHEAD 3333\ndetached\nlocked\n\n\
                    worktree /w/with space\nHEAD 4444\nbranch refs/heads/b\n\
                    prunable gitdir file points to non-existent location\n";
        let entry = |path: &str, branch: Option<&str>, locked: Option<&str>| Listed {
            path: path.into(),
            branch: branch.map(str::to_string),
            locked: locked.map(str::to_string),
        };
        assert_eq!(
            parse_listed(text),
            vec![
                entry("C:/src/repo", Some("refs/heads/main"), None),
                entry(
                    "C:/src/repo-cli-x",
                    Some("refs/heads/cli/x"),
                    Some("codeg-cli is setting up run r (abc)")
                ),
                entry("/w/detached", None, Some("")),
                entry("/w/with space", Some("refs/heads/b"), None),
            ]
        );
        assert_eq!(parse_listed(""), vec![]);
    }

    #[test]
    fn a_git_version_reads_as_major_and_minor() {
        assert_eq!(
            git_version("git version 2.50.1 (Apple Git-155)\n"),
            Some((2, 50))
        );
        assert_eq!(git_version("git version 2.45.2.windows.1"), Some((2, 45)));
        assert!(git_version("git version 2.32.7").unwrap() < MIN_GIT);
        assert!(git_version("git version 2.33.0").unwrap() >= MIN_GIT);
        assert!(git_version("git version 3.0").unwrap() >= MIN_GIT);
        assert_eq!(git_version("hub version 2.14"), None);
        assert_eq!(git_version(""), None);
    }

    #[tokio::test]
    async fn a_directory_the_head_lacks_is_refused_and_leaves_nothing() {
        let (outer, repo) = repository();
        let untracked = repo.join("new");
        std::fs::create_dir_all(&untracked).unwrap();
        let err = create(&untracked.to_string_lossy(), "x", "8d0c7c2e")
            .await
            .unwrap_err();
        assert_eq!(err.body.error.code, "workspace_not_in_worktree");
        assert!(!outer.path().join("repo-cli-x").exists());
    }
}
