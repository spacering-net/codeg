//! Task-specific git building blocks: base-pinned revs, commit-all, the
//! two-stage merge steps, and worktree removal. Thin wrappers over the git CLI
//! (mirroring `commands::folders`), composed by the task engine which owns the
//! per-folder git mutex.

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::folders::{detect_conflicts, git_command_error};
use crate::models::WorkTaskChangedFile;

async fn run_git(path: &str, args: &[&str]) -> Result<std::process::Output, AppCommandError> {
    crate::process::tokio_command("git")
        .args(args)
        .current_dir(path)
        .output()
        .await
        .map_err(AppCommandError::io)
}

/// As [`run_git`], against a git index of our choosing instead of the
/// worktree's own — see [`ScratchIndex`].
///
/// `core.splitIndex=false` because a throwaway index must stay in ONE file:
/// with splitting on, writing it deposits a fresh `sharedindex.*` beside it in
/// the git directory, which outlives the scratch (git only prunes those on a
/// later `gc`).
async fn run_git_with_index(
    path: &str,
    index: &std::path::Path,
    args: &[&str],
) -> Result<std::process::Output, AppCommandError> {
    crate::process::tokio_command("git")
        .args(["-c", "core.splitIndex=false"])
        .args(args)
        .current_dir(path)
        .env("GIT_INDEX_FILE", index)
        .output()
        .await
        .map_err(AppCommandError::io)
}

/// A worktree's own git directory (`<repo>/.git/worktrees/<name>` for a linked
/// worktree, `<repo>/.git` for the main one). Engine-private markers live here:
/// nothing under it can show up in `git status` or be committed by the agent.
pub async fn git_dir(path: &str) -> Result<std::path::PathBuf, AppCommandError> {
    let out = run_git(path, &["rev-parse", "--absolute-git-dir"]).await?;
    if !out.status.success() {
        return Err(git_command_error("rev-parse --absolute-git-dir", &out.stderr));
    }
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dir.is_empty() {
        return Err(AppCommandError::external_command(
            "git rev-parse --absolute-git-dir returned nothing",
            path.to_string(),
        ));
    }
    Ok(std::path::PathBuf::from(dir))
}

/// Resolve a revision to a full sha.
pub async fn rev_parse(path: &str, rev: &str) -> Result<String, AppCommandError> {
    let out = run_git(path, &["rev-parse", "--verify", &format!("{rev}^{{commit}}")]).await?;
    if !out.status.success() {
        return Err(git_command_error("rev-parse", &out.stderr));
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        return Err(AppCommandError::external_command(
            "git rev-parse returned nothing",
            rev.to_string(),
        ));
    }
    Ok(sha)
}

/// Whether the index has staged changes (stage-B preflight requires a clean
/// index in the project folder).
pub async fn staged_clean(path: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["diff", "--cached", "--quiet"]).await?;
    Ok(out.status.success())
}

/// Whether the working tree has anything to commit (tracked or untracked).
pub async fn has_changes(path: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["status", "--porcelain=v1", "-unormal"]).await?;
    if !out.status.success() {
        return Err(git_command_error("status", &out.stderr));
    }
    Ok(!out.stdout.iter().all(|b| b.is_ascii_whitespace()))
}

/// Stage everything and commit with the user's resolved author. Returns
/// `false` when there was nothing to commit.
pub async fn commit_all(
    conn: &sea_orm::DatabaseConnection,
    path: &str,
    message: &str,
) -> Result<bool, AppCommandError> {
    if !has_changes(path).await? {
        return Ok(false);
    }
    let add = run_git(path, &["add", "-A"]).await?;
    if !add.status.success() {
        return Err(git_command_error("add -A", &add.stderr));
    }
    commit_staged(conn, path, message).await?;
    Ok(true)
}

/// Commit whatever is staged (used by commit-all and the squash landing).
/// Resolves the commit author from the matching configured account, like
/// `git_commit_core`.
pub async fn commit_staged(
    conn: &sea_orm::DatabaseConnection,
    path: &str,
    message: &str,
) -> Result<(), AppCommandError> {
    let author_override = crate::git_credential::resolve_commit_author(path, conn).await;
    let mut cmd = crate::process::tokio_command("git");
    if let Some((ref name, ref email)) = author_override {
        cmd.args([
            "-c",
            &format!("user.name={name}"),
            "-c",
            &format!("user.email={email}"),
        ]);
    }
    cmd.args(["commit", "-m", message]).current_dir(path);
    let out = cmd.output().await.map_err(AppCommandError::io)?;
    if !out.status.success() {
        return Err(git_command_error("commit", &out.stderr));
    }
    Ok(())
}

/// Outcome of a merge attempt that treats conflicts as data, not errors.
pub enum MergeAttempt {
    Ok,
    /// Conflicted; the merge has ALREADY been aborted (worktree left clean).
    Conflict(Vec<String>),
}

/// Stage A: merge the base branch INTO the task worktree, so conflicts always
/// land in the worktree. On conflict the merge is aborted and the conflicted
/// paths are returned.
pub async fn merge_base_into_worktree(
    worktree_path: &str,
    base_branch: &str,
) -> Result<MergeAttempt, AppCommandError> {
    let out = run_git(worktree_path, &["merge", "--no-edit", base_branch]).await?;
    if out.status.success() {
        return Ok(MergeAttempt::Ok);
    }
    let conflicts = detect_conflicts(worktree_path).await?;
    if conflicts.is_empty() {
        return Err(git_command_error("merge", &out.stderr));
    }
    let abort = run_git(worktree_path, &["merge", "--abort"]).await?;
    if !abort.status.success() {
        tracing::warn!(
            "[work_task] merge --abort failed in {worktree_path}: {}",
            String::from_utf8_lossy(&abort.stderr)
        );
    }
    Ok(MergeAttempt::Conflict(conflicts))
}

/// Stage B (squash): stage the work branch's tree onto the base branch. The
/// caller commits via [`commit_staged`]. On failure the caller cleans up with
/// [`reset_merge`].
pub async fn merge_squash(path: &str, work_branch: &str) -> Result<(), AppCommandError> {
    let out = run_git(path, &["merge", "--squash", work_branch]).await?;
    if !out.status.success() {
        return Err(git_command_error("merge --squash", &out.stderr));
    }
    Ok(())
}

/// Stage B (merge commit): `git merge --no-ff -m <message> <branch>`.
pub async fn merge_no_ff(
    path: &str,
    work_branch: &str,
    message: &str,
) -> Result<(), AppCommandError> {
    let out = run_git(path, &["merge", "--no-ff", "-m", message, work_branch]).await?;
    if !out.status.success() {
        return Err(git_command_error("merge --no-ff", &out.stderr));
    }
    Ok(())
}

/// Clean a failed/interrupted stage B out of the project folder. Safe because
/// the preflight guaranteed the index was clean before we touched it.
pub async fn reset_merge(path: &str) -> Result<(), AppCommandError> {
    let out = run_git(path, &["reset", "--merge"]).await?;
    if !out.status.success() {
        return Err(git_command_error("reset --merge", &out.stderr));
    }
    Ok(())
}

/// Whether a merge is in progress (MERGE_HEAD exists) — crash-recovery probe.
pub async fn has_merge_head(path: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["rev-parse", "--verify", "MERGE_HEAD"]).await?;
    Ok(out.status.success())
}

/// Whether `ancestor` is reachable from `descendant`. Exit 0 = yes, 1 = no,
/// anything else is a real error.
pub async fn is_ancestor(
    path: &str,
    ancestor: &str,
    descendant: &str,
) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["merge-base", "--is-ancestor", ancestor, descendant]).await?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_command_error("merge-base --is-ancestor", &out.stderr)),
    }
}

/// Best common ancestor of two revisions — the point a pull request's diff is
/// taken from. Using the base branch's TIP instead would hide every change the
/// base gained since the pull request was opened behind a false conflict, and
/// using the head would hide the pull request's own changes entirely.
pub async fn merge_base(path: &str, a: &str, b: &str) -> Result<String, AppCommandError> {
    let out = run_git(path, &["merge-base", a, b]).await?;
    if !out.status.success() {
        return Err(git_command_error("merge-base", &out.stderr));
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        return Err(AppCommandError::external_command(
            "git merge-base returned nothing",
            format!("{a}..{b}"),
        ));
    }
    Ok(sha)
}

/// Whether an object is present in this repository AND is a commit. The probe
/// a pinned sha needs after a fetch: a force-pushed pull request leaves the
/// recorded head unreachable, and `worktree add` on it would fail with git's
/// own wording instead of an explanation.
pub async fn commit_present(path: &str, rev: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["cat-file", "-e", &format!("{rev}^{{commit}}")]).await?;
    Ok(out.status.success())
}

/// `git fetch <remote> +<remote_ref>:<local_ref>` → the fetched tip.
///
/// Two deliberate choices:
///
/// - The folder's OWN remote, not an explicit URL with an injected token: this
///   reads with whatever credentials the user's git already has for that
///   repository (ssh key, helper, whatever they cloned with). Pushing is the
///   opposite case and has its own path — that one must run as the account the
///   task was triggered with.
/// - A NAMED destination ref instead of `FETCH_HEAD`. `FETCH_HEAD` is
///   per-worktree, and these fetches run in the shared project folder, where
///   two task setups in the same folder would overwrite each other's — and
///   read back the other one's commit.
pub async fn fetch_into_ref(
    path: &str,
    remote: &str,
    remote_ref: &str,
    local_ref: &str,
) -> Result<String, AppCommandError> {
    let refspec = format!("+{remote_ref}:{local_ref}");
    let out = run_git(path, &["fetch", "--quiet", remote, &refspec]).await?;
    if !out.status.success() {
        return Err(git_command_error("fetch", &out.stderr));
    }
    rev_parse(path, local_ref).await
}

/// Drop a ref this module created. Best-effort by design: the commits that
/// matter are held by the task's own branch, so a leftover here is untidy
/// rather than dangerous.
pub async fn delete_ref(path: &str, local_ref: &str) {
    let _ = run_git(path, &["update-ref", "-d", local_ref]).await;
}

/// Whether two revisions point at identical trees (`git diff --quiet a b`) —
/// how a squash landing is recognized without knowing the commit message.
pub async fn trees_equal(path: &str, a: &str, b: &str) -> Result<bool, AppCommandError> {
    let out = run_git(path, &["diff", "--quiet", a, b]).await?;
    match out.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_command_error("diff --quiet", &out.stderr)),
    }
}

/// `git diff --numstat <base>` — the task's change set vs its recorded base.
/// Binary files report `-` counts; they are counted as a changed file with 0/0.
///
/// Blind to UNTRACKED files by construction (git enumerates the diff from the
/// index) — [`diff_numstat_with_untracked`] is the one to reach for when the
/// answer decides something; this one stays the plain primitive.
pub async fn diff_numstat(
    path: &str,
    base: &str,
) -> Result<Vec<WorkTaskChangedFile>, AppCommandError> {
    let out = run_git(path, &["diff", "--numstat", base]).await?;
    if !out.status.success() {
        return Err(git_command_error("diff --numstat", &out.stderr));
    }
    Ok(parse_numstat(&out.stdout))
}

fn parse_numstat(stdout: &[u8]) -> Vec<WorkTaskChangedFile> {
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(file)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        files.push(WorkTaskChangedFile {
            file: file.to_string(),
            additions: adds.parse().unwrap_or(0),
            deletions: dels.parse().unwrap_or(0),
        });
    }
    files
}

/// A THROWAWAY git index, seeded from a commit and then told about every
/// untracked, non-ignored file (`add -A -N`, intent-to-add: names only, no
/// content). Deleted when dropped.
///
/// This is what lets a diff see work the agent left UNCOMMITTED — new files
/// included. A task is not guaranteed to have committed when it lands in
/// review (the merge generation's own prompt begins by committing whatever is
/// left over), and a plain `git diff <commit>` walks the index to decide which
/// paths exist: uncommitted edits to tracked files show up, a brand-new file
/// nobody ran `git add` on does not. Reporting that task as having changed
/// nothing is the difference between "merge it" and "complete it".
///
/// The worktree's REAL index is never touched — `git add -N` on it would leave
/// the agent's next round, and any `git stash` / `git commit -a` the user runs,
/// looking at an index this feature quietly edited.
struct ScratchIndex {
    path: std::path::PathBuf,
}

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl ScratchIndex {
    /// Build one for `wt_path`: a COPY of the worktree's own index, plus
    /// intent-to-add entries for everything untracked.
    ///
    /// Copied rather than built from `anchor` with `read-tree`, because the
    /// real index carries per-entry flags a tree does not. A SPARSE checkout is
    /// the case that decides it: its skip-worktree entries have no file on
    /// disk, so an index rebuilt from a tree reports every path outside the
    /// cone as DELETED — a task that changed nothing would show hundreds of
    /// deletions, which is the exact class of wrong answer this measure exists
    /// to prevent. `anchor` is only the fallback seed for a checkout that has
    /// no index to copy at all.
    async fn build(wt_path: &str, anchor: &str) -> Result<Self, AppCommandError> {
        // Inside the worktree's own git directory: never visible to
        // `git status`, never committable, and on the same filesystem as the
        // index it copies. The name carries the process id and a counter
        // because two probes of the same worktree can overlap (a board refresh
        // next to a settle).
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let git_dir = git_dir(wt_path).await?;
        let path = git_dir.join(format!("codeg-diff-index-{}-{seq}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let scratch = Self { path };
        // The copy keeps `assume-unchanged` entries as they are, deliberately.
        // Clearing them would surface edits to a file the user promised git not
        // to look at — and nothing in the acceptance path can land such an
        // edit: `git add -A` skips it and `git commit -a` reports a clean tree,
        // so the merge generation would commit nothing and the task would
        // settle as landed with the edit still sitting there. (Landing it would
        // take a `--no-assume-unchanged` before staging, which no acceptance
        // does.) A measure that promises work an acceptance cannot take is the
        // same failure as one that hides work, pointed the other way.
        //
        // Git replaces the index by renaming `index.lock` over it, so a copy
        // racing an agent's own `git add` reads one whole version or the
        // other — never a half-written file.
        if std::fs::copy(git_dir.join("index"), &scratch.path).is_err() {
            let read = run_git_with_index(wt_path, &scratch.path, &["read-tree", anchor]).await?;
            if !read.status.success() {
                return Err(git_command_error("read-tree", &read.stderr));
            }
        }
        // git runs with the worktree root as its cwd, so a bare `-A` covers the
        // whole tree; `-N` records names only — nothing is staged, and the
        // content the diff reports is read from the working tree either way.
        let add = run_git_with_index(wt_path, &scratch.path, &["add", "-A", "-N"]).await?;
        if !add.status.success() {
            return Err(git_command_error("add -A -N", &add.stderr));
        }
        Ok(scratch)
    }
}

/// `git diff --numstat <anchor>` that also sees uncommitted work — the measure
/// every ACCEPTANCE decision uses (see [`ScratchIndex`] for why the plain diff
/// is not enough).
pub async fn diff_numstat_with_untracked(
    path: &str,
    anchor: &str,
) -> Result<Vec<WorkTaskChangedFile>, AppCommandError> {
    let scratch = ScratchIndex::build(path, anchor).await?;
    let out = run_git_with_index(path, &scratch.path, &["diff", "--numstat", anchor]).await?;
    if !out.status.success() {
        return Err(git_command_error("diff --numstat", &out.stderr));
    }
    Ok(parse_numstat(&out.stdout))
}

/// The patch behind [`diff_numstat_with_untracked`] — whole change set, or one
/// file. An uncommitted new file renders as a normal `new file mode` hunk
/// rather than as an empty diff nobody can explain.
pub async fn diff_patch_with_untracked(
    path: &str,
    anchor: &str,
    file: Option<&str>,
) -> Result<String, AppCommandError> {
    let scratch = ScratchIndex::build(path, anchor).await?;
    let literal = file.map(|f| format!(":(literal){f}"));
    let mut args = vec!["diff", "--no-color", anchor];
    if let Some(ref f) = literal {
        args.push("--");
        args.push(f);
    }
    let out = run_git_with_index(path, &scratch.path, &args).await?;
    if !out.status.success() {
        return Err(git_command_error("diff", &out.stderr));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Tip commit of a LOCAL branch (`refs/heads/<name>`), or `None` when no such
/// branch exists. Deliberately not `rev-parse <name>`: an unqualified name is
/// resolved with tags taking precedence over branches, so a same-name tag
/// would silently answer for the branch. `for-each-ref` looks the ref up fully
/// qualified, and a missing branch is a clean empty result instead of an exit
/// code shared with real failures — callers can tell "absent" from "probe
/// broke".
pub async fn local_branch_tip(
    repo_path: &str,
    branch: &str,
) -> Result<Option<String>, AppCommandError> {
    let refname = format!("refs/heads/{branch}");
    let out = run_git(
        repo_path,
        &["for-each-ref", "--format=%(refname)\t%(objectname)", &refname],
    )
    .await?;
    if !out.status.success() {
        return Err(git_command_error("for-each-ref", &out.stderr));
    }
    // The pattern also matches refs UNDER `refs/heads/<name>/` — filter to the
    // exact ref so a branch named `<name>/sub` cannot answer for `<name>`.
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some((name, oid)) = line.split_once('\t') {
            if name == refname && !oid.trim().is_empty() {
                return Ok(Some(oid.trim().to_string()));
            }
        }
    }
    Ok(None)
}

/// Re-create the checkout of an EXISTING branch after its worktree directory
/// disappeared (`git worktree add <path> <branch>`, no `-b`). Prunes stale
/// registrations first: the vanished directory usually still holds the branch
/// checked out in git's bookkeeping, and a checked-out branch cannot be added
/// again.
pub async fn worktree_add_existing_branch(
    repo_path: &str,
    worktree_path: &str,
    branch: &str,
) -> Result<(), AppCommandError> {
    let prune = run_git(repo_path, &["worktree", "prune"]).await?;
    if !prune.status.success() {
        return Err(git_command_error("worktree prune", &prune.stderr));
    }
    let out = run_git(repo_path, &["worktree", "add", worktree_path, branch]).await?;
    if !out.status.success() {
        return Err(git_command_error("worktree add", &out.stderr));
    }
    // `worktree add <path> <name>` falls back to a DETACHED checkout when
    // `<name>` is not a local branch (a same-name tag, say). A detached task
    // worktree would collect commits nothing points to while the merge targets
    // the wrong ref — verify the checkout is attached to the branch, and back
    // the add out when it is not. The FULL ref, not `--short`: when a
    // same-name tag exists alongside the branch, `--short` disambiguates to
    // `heads/<name>` and a plain name comparison would throw away a perfectly
    // valid recovery.
    let head = run_git(worktree_path, &["symbolic-ref", "--quiet", "HEAD"]).await?;
    let attached = head.status.success()
        && String::from_utf8_lossy(&head.stdout).trim() == format!("refs/heads/{branch}");
    if !attached {
        let _ = run_git(repo_path, &["worktree", "remove", "--force", worktree_path]).await;
        return Err(AppCommandError::external_command(
            "worktree add produced a detached checkout instead of the branch",
            branch.to_string(),
        ));
    }
    Ok(())
}

/// Whether the LOCAL branch still holds work the base never received — the
/// guard that keeps the convergence of a MISSING worktree from deleting real
/// commits with `branch -D`. True ⟺ the branch exists and its tip is neither
/// an ancestor of the base ref nor tree-equal to it (the two shapes a landed
/// merge takes). The base ref is the base branch's CURRENT tip when that
/// branch still exists, else the recorded base sha. Every ref is resolved
/// fully qualified and compared as commit ids — an unqualified name would let
/// a same-name tag answer for the branch and clear unlanded work for
/// deletion. A probe that errors reads as "holds work": deletion is the
/// irreversible half, so uncertainty keeps the branch.
pub async fn branch_holds_unlanded_work(
    repo_path: &str,
    branch: &str,
    base_branch: Option<&str>,
    base_sha: Option<&str>,
) -> bool {
    let tip = match local_branch_tip(repo_path, branch).await {
        Ok(Some(tip)) => tip,
        Ok(None) => return false, // no branch, nothing a deletion could destroy
        Err(_) => return true,
    };
    let mut base_ref = None;
    if let Some(base_branch) = base_branch {
        match local_branch_tip(repo_path, base_branch).await {
            Ok(Some(t)) => base_ref = Some(t),
            Ok(None) => {} // base branch deleted — the recorded sha still anchors
            Err(_) => return true,
        }
    }
    if base_ref.is_none() {
        if let Some(sha) = base_sha {
            if rev_parse(repo_path, sha).await.is_ok() {
                base_ref = Some(sha.to_string());
            }
        }
    }
    let Some(base_ref) = base_ref else {
        return true; // nothing to compare against — keep the branch
    };
    match is_ancestor(repo_path, &tip, &base_ref).await {
        Ok(true) => return false, // merged (or never diverged)
        Ok(false) => {}
        Err(_) => return true,
    }
    match trees_equal(repo_path, &base_ref, &tip).await {
        Ok(equal) => !equal, // tree-equal = squash-landed
        Err(_) => true,
    }
}

/// A Windows path that names a drive without rooting on it — `C:trees`, as
/// opposed to `C:\trees`. Windows finishes such a path from the current
/// directory OF THAT DRIVE, which a process keeps per drive and does not pass
/// to a child the way it passes its working directory, so the same string can
/// name two directories on one machine. `Path::join` reads it as a fresh base
/// and drops whatever it was joined onto, which is what makes it dangerous to a
/// caller that thought it had scoped a path to a repository.
///
/// Unix has no such form: it has no prefixes, so this is `false` for every path
/// there, relative ones included.
fn is_drive_relative(path: &std::path::Path) -> bool {
    let mut components = path.components();
    matches!(components.next(), Some(std::path::Component::Prefix(_)))
        && !matches!(components.next(), Some(std::path::Component::RootDir))
}

/// Which of the two refusals to report once git has declined a removal AND the
/// leftover directory could not be consumed either.
///
/// A checkout git still speaks for keeps git's established reporting — stderr
/// in `detail`, exactly as every other git failure in this function does it.
/// A DETACHED shell has no such thing to keep: git's only word about it is a
/// stock sentence naming a `.git` the user never heard of, and the removal that
/// actually failed was OURS. So this path owns its message, and it says the two
/// things a user can act on — which directory, and what is still in it.
///
/// That has to travel in `message`, because the caller stringifies this into
/// the task's `cleanup_failed` timeline event, which the detail sheet renders
/// verbatim, and `AppCommandError`'s `Display` is its `message` alone —
/// `detail` never reaches that line. `AppCommandError::io` would leave "I/O
/// operation failed" there and nothing else, the same dead end this path exists
/// to get users out of. Takes the RESOLVED path, so the sentence names the
/// directory the call actually touched rather than the argument it started
/// from.
fn removal_refused(
    target: &std::path::Path,
    git_stderr: &[u8],
    err: &std::io::Error,
) -> AppCommandError {
    // An unreadable marker counts as detached: this only picks a message, and
    // whatever stopped the read is the more useful of the two either way.
    if std::fs::symlink_metadata(target.join(".git")).is_ok() {
        return git_command_error("worktree remove", git_stderr);
    }
    // The same kinds `AppCommandError::io` distinguishes, so replacing it costs
    // only the message. `AlreadyExists` is in the list because POSIX lets
    // `rmdir` report a non-empty directory as `EEXIST` rather than `ENOTEMPTY`.
    let code = match err.kind() {
        std::io::ErrorKind::NotFound => AppErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => AppErrorCode::PermissionDenied,
        std::io::ErrorKind::AlreadyExists => AppErrorCode::AlreadyExists,
        _ => AppErrorCode::IoError,
    };
    AppCommandError::new(
        code,
        format!(
            "the worktree directory '{}' could not be removed: {err}",
            target.display()
        ),
    )
}

/// Remove a task worktree directory + its branch. Runs from the project repo.
/// Tolerant of a directory already gone (prunes the stale registration), an
/// empty directory shell left by a partially successful removal, and a branch
/// already deleted; `-D` is required because a squash-landed branch is unmerged
/// in git's eyes.
///
/// `expected_tip` turns the branch delete into a COMPARE-AND-DELETE: the ref
/// goes only if it still points at that commit, and a branch that moved is an
/// error rather than a silent loss. Callers that have proved where the work
/// went — a delivery knows the exact OID it published — pass it, because the
/// only thing making `-D` safe for them is that the tip is that OID, and every
/// read-then-delete leaves a window for it to stop being true. `None` keeps the
/// unconditional delete the local-merge paths settle from git truth for.
pub async fn remove_worktree_and_branch(
    repo_path: &str,
    worktree_path: &str,
    work_branch: Option<&str>,
    expected_tip: Option<&str>,
) -> Result<(), AppCommandError> {
    // ONE resolved directory, shared by both halves of this function, and it
    // has to be ABSOLUTE before git sees it. Git resolves a `<worktree>`
    // argument by unique path SUFFIX first and only then as a path, so a
    // relative name reaches a registered worktree anywhere on disk and
    // `--force` deletes it: with a checkout registered at
    // `/tmp/elsewhere/repo-task-7`, `git worktree remove --force repo-task-7`
    // run from an unrelated repo deletes THAT one, uncommitted files included
    // (measured; `a_relative_path_cannot_reach_a_worktree_somewhere_else`
    // pins it). An absolute path suffix-matches nothing but itself.
    //
    // A drive-relative path on EITHER side is refused before anything resolves
    // it. It is the one form whose meaning depends on a per-drive current
    // directory, which this process and the git child do not share, so the two
    // halves would resolve it apart — and the half that runs second deletes a
    // directory. Whichever side carries it, the answer is the same: this does
    // not name one directory, so nothing here may act on it.
    for (label, path) in [("project", repo_path), ("worktree", worktree_path)] {
        if is_drive_relative(std::path::Path::new(path)) {
            return Err(AppCommandError::new(
                AppErrorCode::InvalidInput,
                format!(
                    "the {label} path '{path}' is relative to a drive rather than rooted on \
                     one, so it does not name a single directory"
                ),
            ));
        }
    }
    // Joining from `repo_path` is what git does with a relative path — that is
    // `run_git`'s working directory — and `std::path::absolute` then applies
    // the same process working directory the child would inherit. So the git
    // call and the `std::fs` call below cannot land on different directories,
    // which for the one destructive call here is the whole point. Folder paths
    // are stored exactly as they were given, so none of this is hypothetical.
    let target = std::path::absolute(std::path::Path::new(repo_path).join(worktree_path))
        .map_err(AppCommandError::io)?;
    // Refused rather than made lossy: a `\u{FFFD}` substituted into an absolute
    // path is still an absolute path, and git would go delete THAT one while
    // every removal below still used the bytes in `target`. Handing git a
    // different directory than the one we probed is the single thing this
    // resolution exists to prevent.
    let Some(target_arg) = target.to_str() else {
        return Err(AppCommandError::new(
            AppErrorCode::InvalidInput,
            format!("the worktree path '{worktree_path}' does not resolve to valid UTF-8"),
        ));
    };
    // Git first, always — including for a directory it will refuse. Refusing is
    // ALL it does: `worktree remove` validates the `.git` marker before it
    // deletes anything, so a shell git will not speak for arrives at the
    // recovery below exactly as it was. Asking it first is therefore free of
    // risk, and it leaves ONE removal path here instead of a pre-check that
    // has to re-derive what git is about to say.
    let removed = run_git(repo_path, &["worktree", "remove", "--force", target_arg]).await?;
    let needs_prune = if removed.status.success() {
        false
    } else {
        // Every shape of leftover recovers the same way, so they share a line:
        // a directory already gone, the empty shell that outlives a detached
        // registration (#642), and the one Windows leaves when a process holds
        // the directory open through git's final rmdir.
        //
        // `remove_dir` is what makes that safe to say. It is non-recursive, so
        // it can only ever succeed on an EMPTY directory: an ignored artifact,
        // or a file that appeared after the engine's own check, fails closed
        // and keeps both the file and the branch below.
        match std::fs::remove_dir(&target) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(removal_refused(&target, &removed.stderr, &e)),
        }
        true
    };
    if needs_prune {
        // Directory already gone (or its empty shell removed) — drop any stale
        // registration so the branch delete below isn't blocked by a phantom
        // checkout.
        let prune = run_git(repo_path, &["worktree", "prune"]).await?;
        if !prune.status.success() {
            return Err(git_command_error("worktree prune", &prune.stderr));
        }
    }
    let Some(branch) = work_branch else {
        return Ok(());
    };
    let Some(tip) = expected_tip else {
        let del = run_git(repo_path, &["branch", "-D", branch]).await?;
        if !del.status.success() {
            let msg = String::from_utf8_lossy(&del.stderr).to_lowercase();
            if !msg.contains("not found") {
                return Err(git_command_error("branch -D", &del.stderr));
            }
        }
        return Ok(());
    };
    // Asked for first, because `update-ref -d` cannot tell "already deleted"
    // (fine — the caller's goal is met) from "moved" (must not be deleted)
    // through its exit status alone. A branch that disappears between this
    // read and the delete below still fails closed: the delete refuses, the
    // caller flags a retryable cleanup, and the retry finds nothing to do.
    let full_ref = format!("refs/heads/{branch}");
    let exists = run_git(repo_path, &["rev-parse", "--verify", "--quiet", &full_ref]).await?;
    if !exists.status.success() {
        return Ok(());
    }
    // The compare and the delete in ONE git operation: no window between them
    // for the ref to move, which is the whole reason a caller passes a tip.
    let del = run_git(repo_path, &["update-ref", "-d", &full_ref, tip]).await?;
    if !del.status.success() {
        return Err(git_command_error("update-ref -d", &del.stderr));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // The env above only reaches the commands THIS helper runs; the
        // functions under test spawn their own git through `crate::process`,
        // which inherits the real environment — and Git for Windows ships
        // `core.autocrlf=true` in its system config. A fixture whose bytes mean
        // one thing to the test and another to the code it exercises measures
        // the harness, not the behaviour. Repo-LOCAL config is the one layer
        // both sides read.
        if args.first() == Some(&"init") {
            git_run(dir, &["config", "core.autocrlf", "false"]);
        }
    }

    /// Why removing a task worktree has to consult BOTH probes: each is blind
    /// to exactly what the other sees. `remove_worktree_and_branch` runs
    /// `worktree remove --force` + `branch -D`, so anything either probe would
    /// have found is destroyed silently if only one of them is asked.
    #[tokio::test]
    async fn status_and_base_diff_have_opposite_blind_spots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf-8 path");
        git_run(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        git_run(dir.path(), &["add", "-A"]);
        git_run(dir.path(), &["commit", "-q", "-m", "base"]);
        let base = rev_parse(path, "HEAD").await.expect("base sha");

        // Settled state: nothing on top of the base, by either measure.
        assert!(!has_changes(path).await.expect("status"));
        assert!(diff_numstat(path, &base).await.expect("diff").is_empty());

        // Work committed on the branch afterwards leaves a spotless worktree…
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").expect("write");
        git_run(dir.path(), &["commit", "-qam", "later work"]);
        assert!(
            !has_changes(path).await.expect("status"),
            "a commit leaves no trace in `git status` — status alone would clear a branch for deletion"
        );
        // …but it is exactly what a merge would have taken.
        let files = diff_numstat(path, &base).await.expect("diff");
        assert_eq!(files.len(), 1, "the base diff still holds the commit");
        assert_eq!(files[0].file, "a.txt");

        // The mirror image: an untracked file never reaches a diff against the
        // base, so the base diff alone would clear a worktree for deletion.
        git_run(dir.path(), &["reset", "-q", "--hard", &base]);
        std::fs::write(dir.path().join("scratch.txt"), "junk\n").expect("write");
        assert!(
            diff_numstat(path, &base).await.expect("diff").is_empty(),
            "untracked files are invisible to the base diff"
        );
        assert!(has_changes(path).await.expect("status"));
    }

    /// The measure every acceptance decision runs on has to see work the agent
    /// never committed — a task is not required to commit before it lands in
    /// review, and the merge generation's own prompt starts by committing
    /// whatever is left over. Uncommitted edits to tracked files were always
    /// visible; a brand-new file nobody added is the case a plain diff misses,
    /// and reporting that task as "changed nothing" is what puts the wrong
    /// acceptance on its card.
    #[tokio::test]
    async fn the_acceptance_measure_sees_work_that_was_never_committed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf-8 path");
        git_run(dir.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(dir.path().join(".gitignore"), "*.log\n").expect("write");
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        git_run(dir.path(), &["add", "-A"]);
        git_run(dir.path(), &["commit", "-q", "-m", "base"]);
        let base = rev_parse(path, "HEAD").await.expect("base sha");

        // The agent's round: one tracked file edited, one new file written,
        // neither committed — plus a build artifact the repository ignores.
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").expect("write");
        std::fs::write(dir.path().join("new.txt"), "x\ny\nz\n").expect("write");
        std::fs::write(dir.path().join("build.log"), "noise\n").expect("write");

        let plain = diff_numstat(path, &base).await.expect("plain diff");
        assert_eq!(
            plain.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(),
            ["a.txt"],
            "the plain diff is blind to the new file — this is why the acceptance \
             measure cannot use it"
        );

        let seen = diff_numstat_with_untracked(path, &base)
            .await
            .expect("acceptance diff");
        let names: Vec<&str> = seen.iter().map(|f| f.file.as_str()).collect();
        assert_eq!(names, ["a.txt", "new.txt"], "ignored files stay out: {seen:?}");
        let new_file = seen.iter().find(|f| f.file == "new.txt").expect("new file");
        assert_eq!(
            (new_file.additions, new_file.deletions),
            (3, 0),
            "counted like any other addition"
        );

        // …and the patch behind it renders that file instead of nothing.
        let patch = diff_patch_with_untracked(path, &base, Some("new.txt"))
            .await
            .expect("patch");
        assert!(patch.contains("new file mode"), "{patch}");
        assert!(patch.contains("+x"), "{patch}");

        // The worktree's own index is left exactly as it was: nothing staged,
        // the new file still untracked, and no scratch file left behind.
        let staged = std::process::Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(dir.path())
            .output()
            .expect("spawn git");
        assert!(
            staged.stdout.is_empty(),
            "the real index was written to: {}",
            String::from_utf8_lossy(&staged.stdout)
        );
        assert!(has_changes(path).await.expect("status"));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join(".git"))
            .expect("read .git")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("codeg-diff-index"))
            .collect();
        assert!(leftovers.is_empty(), "scratch index left behind: {leftovers:?}");
    }

    /// A file the ignore rules exclude but that is TRACKED anyway (`git add
    /// -f`, then committed) is the task's work like any other. Only the index
    /// knows it: an index rebuilt from the anchor would not carry it, and
    /// `add -A -N` will not put it back — the ignore rules see to that — so it
    /// would drop out of the measure entirely, and the plain diff that DOES
    /// see it would be the more accurate one. Completing the task would then
    /// `branch -D` committed work.
    #[tokio::test]
    async fn a_tracked_file_the_ignore_rules_exclude_stays_in_the_measure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf-8 path");
        git_run(dir.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(dir.path().join(".gitignore"), "*.log\n").expect("write");
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        git_run(dir.path(), &["add", "-A"]);
        git_run(dir.path(), &["commit", "-q", "-m", "base"]);
        let base = rev_parse(path, "HEAD").await.expect("base sha");

        std::fs::write(dir.path().join("kept.log"), "one\ntwo\n").expect("write");
        git_run(dir.path(), &["add", "-f", "kept.log"]);
        git_run(dir.path(), &["commit", "-q", "-m", "the task's work"]);

        let seen = diff_numstat_with_untracked(path, &base)
            .await
            .expect("acceptance diff");
        assert_eq!(
            seen.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(),
            ["kept.log"],
            "committed work must not vanish because a pattern would have ignored it: {seen:?}"
        );
    }

    /// A SPARSE checkout has tracked files with no file on disk, and they must
    /// not read as deletions: that would report a task that changed nothing as
    /// having removed everything outside the cone. What keeps them out is the
    /// scratch index being a COPY of the worktree's own (skip-worktree flags
    /// and all) rather than a tree read back from the anchor.
    ///
    /// Set up through `core.sparseCheckout` + `info/sparse-checkout` +
    /// `read-tree -mu`, which is how sparse checkouts worked long before the
    /// `git sparse-checkout` command existed — the test should not depend on
    /// the git version the developer happens to run.
    #[tokio::test]
    async fn a_sparse_checkout_reports_no_phantom_deletions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf-8 path");
        git_run(dir.path(), &["init", "-q", "-b", "main"]);
        std::fs::create_dir_all(dir.path().join("kept")).expect("mkdir");
        std::fs::create_dir_all(dir.path().join("sparse")).expect("mkdir");
        std::fs::write(dir.path().join("kept/a.txt"), "one\n").expect("write");
        std::fs::write(dir.path().join("sparse/b.txt"), "two\n").expect("write");
        git_run(dir.path(), &["add", "-A"]);
        git_run(dir.path(), &["commit", "-q", "-m", "base"]);
        let base = rev_parse(path, "HEAD").await.expect("base sha");

        git_run(dir.path(), &["config", "core.sparseCheckout", "true"]);
        std::fs::write(dir.path().join(".git/info/sparse-checkout"), "kept/\n").expect("write");
        git_run(dir.path(), &["read-tree", "-mu", "HEAD"]);
        assert!(
            !dir.path().join("sparse/b.txt").exists(),
            "the fixture must actually be sparse"
        );

        assert!(
            diff_numstat_with_untracked(path, &base)
                .await
                .expect("acceptance diff")
                .is_empty(),
            "a checked-out subset is not a change"
        );

        // …and real work in the cone is still seen.
        std::fs::write(dir.path().join("kept/new.txt"), "x\n").expect("write");
        let seen = diff_numstat_with_untracked(path, &base)
            .await
            .expect("acceptance diff");
        assert_eq!(
            seen.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(),
            ["kept/new.txt"],
            "{seen:?}"
        );
    }

    /// The branch guard behind converging a missing worktree: unlanded commits
    /// keep the branch, and both landed shapes (merge ancestry, squash tree
    /// equality) release it.
    #[tokio::test]
    async fn unlanded_branch_work_is_recognized_in_the_root_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf-8 path");
        git_run(dir.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        git_run(dir.path(), &["add", "-A"]);
        git_run(dir.path(), &["commit", "-q", "-m", "base"]);
        let base_sha = rev_parse(path, "HEAD").await.expect("base sha");

        // A branch that never diverged has nothing a deletion could destroy.
        git_run(dir.path(), &["branch", "task/1"]);
        assert!(!branch_holds_unlanded_work(path, "task/1", Some("main"), Some(&base_sha)).await);
        // Neither does a branch that no longer exists.
        assert!(!branch_holds_unlanded_work(path, "task/9", Some("main"), Some(&base_sha)).await);

        // Commit on the branch → unlanded work, whichever base ref resolves.
        git_run(dir.path(), &["checkout", "-q", "task/1"]);
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").expect("write");
        git_run(dir.path(), &["commit", "-qam", "work"]);
        git_run(dir.path(), &["checkout", "-q", "main"]);
        assert!(branch_holds_unlanded_work(path, "task/1", Some("main"), Some(&base_sha)).await);
        assert!(branch_holds_unlanded_work(path, "task/1", None, Some(&base_sha)).await);
        // No resolvable base at all → conservative: keep.
        assert!(branch_holds_unlanded_work(path, "task/1", Some("gone"), None).await);

        // A squash landing leaves no ancestry, but the trees match.
        git_run(dir.path(), &["merge", "-q", "--squash", "task/1"]);
        git_run(dir.path(), &["commit", "-qm", "landed as squash"]);
        assert!(!branch_holds_unlanded_work(path, "task/1", Some("main"), Some(&base_sha)).await);

        // A merge landing is plain ancestry — even after main moves on.
        git_run(dir.path(), &["checkout", "-q", "task/1"]);
        std::fs::write(dir.path().join("b.txt"), "more\n").expect("write");
        git_run(dir.path(), &["add", "-A"]);
        git_run(dir.path(), &["commit", "-qm", "more work"]);
        git_run(dir.path(), &["checkout", "-q", "main"]);
        assert!(branch_holds_unlanded_work(path, "task/1", Some("main"), Some(&base_sha)).await);
        git_run(dir.path(), &["merge", "-q", "--no-ff", "-m", "land", "task/1"]);
        assert!(!branch_holds_unlanded_work(path, "task/1", Some("main"), Some(&base_sha)).await);
    }

    /// A same-name TAG must never answer for the branch: unqualified
    /// resolution prefers tags, and both halves of the missing-worktree story
    /// would go wrong on it — the deletion guard would read the tag's landed
    /// commit and clear real work for `branch -D`, and the recovery add would
    /// produce a detached checkout of the tag.
    #[tokio::test]
    async fn a_same_name_tag_cannot_shadow_the_branch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir");
        let repo_path = repo.to_str().expect("utf-8 path");
        git_run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-q", "-m", "base"]);
        let base_sha = rev_parse(repo_path, "HEAD").await.expect("base sha");

        // Branch with unlanded work + a tag of the same name pinned at base.
        git_run(&repo, &["branch", "task/1"]);
        git_run(&repo, &["tag", "task/1", &base_sha]);
        git_run(&repo, &["checkout", "-q", "task/1"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").expect("write");
        git_run(&repo, &["commit", "-qam", "work"]);
        git_run(&repo, &["checkout", "-q", "main"]);

        // The qualified probe sees the branch tip, not the tag's base commit.
        let tip = local_branch_tip(repo_path, "task/1")
            .await
            .expect("probe")
            .expect("branch exists");
        assert_ne!(tip, base_sha, "the probe must not resolve the tag");
        assert!(
            branch_holds_unlanded_work(repo_path, "task/1", Some("main"), Some(&base_sha)).await,
            "the tag at base must not clear the branch's unlanded commit for deletion"
        );

        // With BOTH the branch and the tag present, recovery must still work:
        // git attaches the checkout to the branch, and the attachment check
        // must recognize it even though `symbolic-ref --short` would
        // disambiguate the name to `heads/task/1` here.
        let wt_both = dir.path().join("repo-task-1-both");
        let wt_both_path = wt_both.to_str().expect("utf-8 path");
        worktree_add_existing_branch(repo_path, wt_both_path, "task/1")
            .await
            .expect("recovery with a shadowing tag present");
        assert_eq!(
            rev_parse(wt_both_path, "HEAD").await.expect("head"),
            tip,
            "the recovered checkout is the branch tip, not the tag"
        );
        git_run(&repo, &["worktree", "remove", "--force", wt_both_path]);

        // With the branch gone the tag still exists — recovery must refuse
        // rather than hand back a detached checkout of the tag.
        git_run(&repo, &["branch", "-D", "task/1"]);
        assert!(local_branch_tip(repo_path, "task/1")
            .await
            .expect("probe")
            .is_none());
        assert!(
            !branch_holds_unlanded_work(repo_path, "task/1", Some("main"), Some(&base_sha)).await
        );
        let wt = dir.path().join("repo-task-1");
        let wt_path = wt.to_str().expect("utf-8 path");
        assert!(
            worktree_add_existing_branch(repo_path, wt_path, "task/1")
                .await
                .is_err(),
            "a tag-only add must fail instead of leaving a detached worktree"
        );
        assert!(!wt.exists(), "the refused detached checkout is backed out");
    }

    /// Probe failures keep the branch: an unreadable repo must not read as
    /// "nothing to lose" on the path that ends in `branch -D`.
    #[tokio::test]
    async fn a_broken_probe_keeps_the_branch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let not_a_repo = dir.path().to_str().expect("utf-8 path");
        assert!(local_branch_tip(not_a_repo, "task/1").await.is_err());
        assert!(branch_holds_unlanded_work(not_a_repo, "task/1", Some("main"), None).await);
    }

    /// Task worktrees can be pointed at a directory of the user's choosing
    /// (the folder's `worktree_root` setting), and the folder's FIRST task
    /// meets that directory before it exists. Nothing in the engine creates
    /// it: `git worktree add` is expected to make the leading directories
    /// along with the checkout, so this pins that expectation on the exact
    /// call the fresh mint makes.
    #[tokio::test]
    async fn a_worktree_root_that_does_not_exist_yet_is_created_by_the_add() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir");
        let repo_path = repo.to_str().expect("utf-8 path");
        git_run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-q", "-m", "base"]);
        let base = rev_parse(repo_path, "HEAD").await.expect("base sha");

        let wt = dir.path().join("trees").join("nested").join("repo-task-7");
        crate::commands::folders::git_worktree_add(
            repo_path.to_string(),
            "task/7".to_string(),
            wt.to_string_lossy().into_owned(),
            Some(base.clone()),
        )
        .await
        .expect("add into a root that does not exist yet");

        assert_eq!(
            rev_parse(wt.to_str().expect("utf-8 path"), "HEAD")
                .await
                .expect("head"),
            base
        );
    }

    /// Both answers of the compare-and-delete, on one repository.
    ///
    /// A caller that passes `expected_tip` has PROVED where the work went —
    /// a delivery knows the exact OID it pushed — and the branch is expendable
    /// for exactly as long as it still points there. Checking that separately
    /// and then running `branch -D` leaves a window; this is the pair fused
    /// into one git operation, so a branch that moved keeps its commit and
    /// says so instead.
    #[tokio::test]
    async fn a_branch_is_deleted_only_while_it_still_holds_the_expected_tip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("mkdir");
        let repo_path = repo.to_str().expect("utf-8 path");
        git_run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-q", "-m", "base"]);

        // ── the tip moved: the branch (and its commit) must survive ──
        let moved = dir.path().join("wt-moved");
        let moved_path = moved.to_str().expect("utf-8 path");
        git_run(&repo, &["worktree", "add", "-q", "-b", "task/moved", moved_path]);
        std::fs::write(moved.join("a.txt"), "one\ntwo\n").expect("write");
        git_run(&moved, &["commit", "-qam", "published"]);
        let published = rev_parse(moved_path, "HEAD").await.expect("published tip");
        std::fs::write(moved.join("a.txt"), "one\ntwo\nthree\n").expect("write");
        git_run(&moved, &["commit", "-qam", "never pushed"]);
        let outran = rev_parse(moved_path, "HEAD").await.expect("later tip");
        assert_ne!(published, outran);

        remove_worktree_and_branch(repo_path, moved_path, Some("task/moved"), Some(&published))
            .await
            .expect_err("a branch that outran the published tip is not deletable");
        assert_eq!(
            rev_parse(repo_path, "refs/heads/task/moved").await.expect("branch alive"),
            outran,
            "the commit nobody published is still reachable"
        );

        // ── the tip is exactly what was published: the branch goes ──
        let same = dir.path().join("wt-same");
        let same_path = same.to_str().expect("utf-8 path");
        git_run(&repo, &["worktree", "add", "-q", "-b", "task/same", same_path]);
        std::fs::write(same.join("a.txt"), "one\nagain\n").expect("write");
        git_run(&same, &["commit", "-qam", "published"]);
        let tip = rev_parse(same_path, "HEAD").await.expect("tip");

        remove_worktree_and_branch(repo_path, same_path, Some("task/same"), Some(&tip))
            .await
            .expect("removal");
        assert!(!same.exists(), "the checkout is gone");
        assert!(
            rev_parse(repo_path, "refs/heads/task/same").await.is_err(),
            "and so is its branch"
        );

        // ── an expected tip for a branch already gone is not an error ──
        // The caller's goal is met, and a retried cleanup must be able to
        // finish rather than flag the same failure forever.
        let gone = dir.path().join("wt-gone");
        let gone_path = gone.to_str().expect("utf-8 path");
        git_run(&repo, &["worktree", "add", "-q", "-b", "task/gone", gone_path]);
        let gone_tip = rev_parse(gone_path, "HEAD").await.expect("tip");
        remove_worktree_and_branch(repo_path, gone_path, Some("task/gone"), Some(&gone_tip))
            .await
            .expect("first removal");
        remove_worktree_and_branch(repo_path, gone_path, Some("task/gone"), Some(&gone_tip))
            .await
            .expect("a second pass finds nothing to do and says so quietly");
    }

    /// The engine normally catches contents before calling this layer, but a
    /// file can appear after git has removed the checkout marker and before the
    /// task retries. Git is not the risk here — it validates the `.git` marker
    /// and refuses the removal outright, contents untouched. The risk is the
    /// marker-less path this function grew FOR empty shells, which is the only
    /// code that will delete such a directory at all: it must stay
    /// non-recursive, so that a file makes it fail closed and keep the branch.
    #[tokio::test]
    async fn registered_worktree_without_git_marker_never_takes_a_sentinel() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir");
        let repo_path = repo.to_str().expect("utf-8 path");
        git_run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-q", "-m", "base"]);

        let worktree = dir.path().join("wt-sentinel");
        let worktree_path = worktree.to_str().expect("utf-8 worktree");
        git_run(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task/sentinel",
                worktree_path,
            ],
        );
        std::fs::remove_file(worktree.join(".git")).expect("remove worktree marker");
        std::fs::remove_file(worktree.join("a.txt")).expect("remove tracked contents");
        std::fs::write(worktree.join("sentinel.txt"), "keep me\n").expect("sentinel");

        let err = remove_worktree_and_branch(repo_path, worktree_path, Some("task/sentinel"), None)
            .await
            .expect_err("a non-empty detached shell must fail closed");

        assert_eq!(
            std::fs::read_to_string(worktree.join("sentinel.txt")).expect("read sentinel"),
            "keep me\n"
        );
        assert!(
            rev_parse(repo_path, "refs/heads/task/sentinel")
                .await
                .is_ok(),
            "the branch is not deleted after the directory refusal"
        );
        // `Display` is `message` alone, and this is the string the cleanup
        // event shows. Git's own attempt failed first, but with a sentence
        // about a missing `.git` — the reason cleanup actually stopped is that
        // OUR removal found something in the directory, so that is what has to
        // come out the other end.
        let msg = err.to_string();
        assert!(
            msg.contains(worktree_path) && msg.contains("could not be removed"),
            "the refusal names the directory and its reason: {msg}"
        );
    }

    /// The predicate the refusal is built on, asked of whichever platform is
    /// running rather than of the one that happened to write the test.
    ///
    /// `C:repo` is the whole reason it exists, and it is the case that cannot
    /// be stated platform-blind: Windows reads a drive prefix there and has to
    /// refuse it, while a platform without path prefixes reads the same bytes
    /// as an ordinary filename and must not. Everything else names a single
    /// directory on BOTH — a rooted drive, a UNC share, a verbatim path, and
    /// every Unix shape a folder row actually holds — so a refusal there would
    /// break cleanup for real users.
    #[test]
    fn only_a_drive_relative_path_is_refused() {
        for ordinary in [
            "/Users/x/work/repo",
            "/Users/x/work/repo/",
            "repo",
            "rel/proj",
            "./rel/proj",
            "../sibling/repo",
            "/",
            "",
            // Windows forms that ARE rooted, and so are not this.
            r"C:\repo",
            r"\\server\share\repo",
            r"\\?\C:\repo",
            // Rooted on the current drive rather than naming one.
            r"\wt",
        ] {
            assert!(
                !is_drive_relative(std::path::Path::new(ordinary)),
                "{ordinary:?} names one directory, so nothing may refuse it"
            );
        }
        // A drive with a path that is not rooted on it, a drive with nothing
        // after it at all, and the shape that walks back out of the directory
        // it names — each finished by a per-drive current directory on Windows,
        // each an ordinary filename anywhere without prefixes.
        for drive_relative in ["C:repo", "C:", r"C:repo\..\victim"] {
            assert_eq!(
                is_drive_relative(std::path::Path::new(drive_relative)),
                cfg!(windows),
                "{drive_relative:?} is drive-relative on Windows and a plain name off it"
            );
        }
    }

    /// Git looks a `<worktree>` argument up by unique path SUFFIX before it
    /// resolves it as a path, so a RELATIVE name is not scoped to the
    /// repository it is handed to — it reaches a registered checkout anywhere
    /// on disk, and `--force` deletes that one, uncommitted files included.
    /// Folder paths are stored exactly as they were given, so the argument is
    /// only as absolute as whoever created the folder made it. This is the one
    /// call in this file that can destroy a checkout, so it resolves the path
    /// itself rather than trusting git to scope it.
    #[tokio::test]
    async fn a_relative_path_cannot_reach_a_worktree_somewhere_else() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir");
        let repo_path = repo.to_str().expect("utf-8 path");
        git_run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-q", "-m", "base"]);

        // A real, registered checkout that shares only its LAST path component
        // with the directory the caller names.
        let elsewhere = dir.path().join("elsewhere").join("repo-task-7");
        std::fs::create_dir_all(elsewhere.parent().expect("parent")).expect("mkdir");
        let elsewhere_path = elsewhere.to_str().expect("utf-8 path");
        git_run(
            &repo,
            &["worktree", "add", "-q", "-b", "task/7", elsewhere_path],
        );
        std::fs::write(elsewhere.join("precious.txt"), "not yours\n").expect("precious");

        // The caller names `repo-task-7` beside the project — which does not
        // exist. Nothing here may travel to the checkout that does.
        remove_worktree_and_branch(repo_path, "repo-task-7", None, None)
            .await
            .expect("a path that is not a worktree is nothing to do");

        assert_eq!(
            std::fs::read_to_string(elsewhere.join("precious.txt")).expect("read precious"),
            "not yours\n",
            "the unrelated checkout keeps its uncommitted work"
        );
        assert!(
            elsewhere.join("a.txt").exists(),
            "and the rest of its tree"
        );
        // Asked OF git rather than matched against `worktree list`: that
        // listing prints forward slashes on Windows while the fixture path
        // holds backslashes, and a temp directory can come back short-named,
        // so comparing the two strings tests the platform rather than the
        // code. Running git inside the checkout answers the same question
        // without comparing anything — a swept worktree leaves its `.git`
        // file pointing at an administrative directory that is gone, and
        // every git command in it fails.
        assert!(
            rev_parse(elsewhere_path, "HEAD").await.is_ok(),
            "and its registration: the prune must not have swept it either"
        );
    }

    /// The other side of that choice: a worktree git still speaks for is git's
    /// to refuse, and its refusal must not be overwritten by ours. The
    /// `remove_dir` recovery still runs here and still fails — a live checkout
    /// is not empty — so this pins that failing SECOND does not make it the
    /// story. A lock is the cleanest way to make git decline a healthy
    /// checkout, and it is exactly the case where git's own text carries
    /// something no filesystem error could ("use 'remove -f -f' to override").
    #[tokio::test]
    async fn a_locked_worktree_keeps_gits_own_refusal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir");
        let repo_path = repo.to_str().expect("utf-8 path");
        git_run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-q", "-m", "base"]);

        let worktree = dir.path().join("wt-locked");
        let worktree_path = worktree.to_str().expect("utf-8 worktree");
        git_run(
            &repo,
            &["worktree", "add", "-q", "-b", "task/locked", worktree_path],
        );
        git_run(&repo, &["worktree", "lock", worktree_path]);

        let err = remove_worktree_and_branch(repo_path, worktree_path, Some("task/locked"), None)
            .await
            .expect_err("a locked worktree is not removed");

        assert_eq!(
            err.message, "git worktree remove failed",
            "git's refusal is reported as git's, not as a directory we failed to remove"
        );
        assert!(
            err.detail.as_deref().unwrap_or_default().contains("locked"),
            "git's reason is kept where this file always puts it: {:?}",
            err.detail
        );
        assert!(
            worktree.join("a.txt").exists(),
            "the locked checkout is left standing"
        );
        assert!(
            rev_parse(repo_path, "refs/heads/task/locked").await.is_ok(),
            "and so is its branch"
        );
    }

    /// A retry after the checkout was removed must get the SAME branch back,
    /// prior commits included — not a fresh tree on a fresh base.
    #[tokio::test]
    async fn a_vanished_checkout_is_recreated_from_its_branch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir");
        let repo_path = repo.to_str().expect("utf-8 path");
        git_run(&repo, &["init", "-q", "-b", "main"]);
        // `git_run` nulls the global/system config, but the checkout below is
        // made by `worktree_add_existing_branch` — a production git call that
        // inherits the host's. Git for Windows ships `core.autocrlf=true`, so
        // without a repo-local pin the restored file comes back CRLF and the
        // content assertion at the end reads as a data loss it isn't.
        git_run(&repo, &["config", "core.autocrlf", "false"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-q", "-m", "base"]);

        let wt = dir.path().join("repo-task-1");
        let wt_path = wt.to_str().expect("utf-8 path");
        git_run(&repo, &["worktree", "add", "-q", "-b", "task/1", wt_path]);
        std::fs::write(wt.join("a.txt"), "one\ntwo\n").expect("write");
        git_run(&wt, &["commit", "-qam", "work"]);
        let tip = rev_parse(wt_path, "HEAD").await.expect("tip");

        // The directory vanishes behind git's back (the user deleted it).
        std::fs::remove_dir_all(&wt).expect("rm worktree");
        worktree_add_existing_branch(repo_path, wt_path, "task/1")
            .await
            .expect("recreate");
        // Same branch, same history, work restored on disk — and ATTACHED to
        // the branch, not a detached checkout of its tip.
        assert_eq!(rev_parse(wt_path, "HEAD").await.expect("head"), tip);
        let head = std::process::Command::new("git")
            .args(["symbolic-ref", "--short", "HEAD"])
            .current_dir(&wt)
            .output()
            .expect("spawn git");
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "task/1");
        assert_eq!(
            std::fs::read_to_string(wt.join("a.txt")).expect("read"),
            "one\ntwo\n"
        );
    }
}
