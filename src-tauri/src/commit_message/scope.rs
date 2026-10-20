//! What a commit is going to contain, read the way the commit will read it.
//!
//! `git_commit_core` stages the chosen files and then commits WITHOUT a
//! pathspec, so a commit carries the chosen files and everything that was
//! already staged. The message has to describe exactly that, so it is measured
//! on a throwaway copy of the real index ([`ScratchIndex::copy_of`]) staged by
//! the same rules: the user's own index is never touched.

use crate::app_error::AppCommandError;
use crate::commands::folders::{git_command_error, to_git_literal_pathspec};
use crate::work_task::git::{run_git_with_index, ScratchIndex};

/// Most characters of patch text a prompt carries, across all files. The
/// share left after the small files goes in equal parts to the large ones,
/// each cut at a hunk boundary.
pub(crate) const PATCH_BUDGET: usize = 48_000;

/// A file changing more lines than this is listed with its counts only: its
/// patch would take its whole share to say little a summary line doesn't.
const MAX_PATCH_LINES: u64 = 4_000;

/// How many recent subjects show the repository's conventions.
const RECENT_SUBJECTS: usize = 20;

/// Lockfiles and other generated files: listed, never quoted.
const GENERATED_FILE_NAMES: &[&str] = &[
    "Cargo.lock",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "composer.lock",
    "Gemfile.lock",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "go.sum",
    "flake.lock",
    "Podfile.lock",
    "pubspec.lock",
    "mix.lock",
    "packages.lock.json",
];
const GENERATED_FILE_SUFFIXES: &[&str] = &[".min.js", ".min.css", ".map", ".snap"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChangedFile {
    /// Git's status letter: `A`, `M`, `D`, `R`, `C`, `T`.
    pub status: char,
    pub path: String,
    /// The path before a rename or copy.
    pub from: Option<String>,
    /// `None` for a binary file.
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    /// Why the file's patch is not in the prompt, when it is not.
    pub omitted: Option<Omitted>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Omitted {
    Binary,
    Generated,
    TooLarge,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct CommitScope {
    pub files: Vec<ChangedFile>,
    /// The patch of every file not [`ChangedFile::omitted`], within
    /// [`PATCH_BUDGET`].
    pub patch: String,
    /// The branch HEAD is on; `None` when detached.
    pub branch: Option<String>,
    /// Subjects of the last non-merge commits, newest first. Empty on an
    /// unborn branch.
    pub recent_subjects: Vec<String>,
}

/// Read what committing `files` in the repository at `path` would record.
pub(crate) async fn read(path: &str, files: &[String]) -> Result<CommitScope, AppCommandError> {
    let scratch = ScratchIndex::copy_of(path, None).await?;
    let index = scratch.path.as_path();

    // The same staging `git_commit_core` does: a file already staged for
    // deletion is skipped (`git add` fails on it), everything else is added
    // by literal pathspec.
    let deleted = git(
        path,
        index,
        &["diff", "--cached", "--name-only", "--diff-filter=D", "-z"],
    )
    .await?;
    let staged_deletions: std::collections::HashSet<&str> =
        deleted.split('\0').filter(|s| !s.is_empty()).collect();
    let to_add: Vec<String> = files
        .iter()
        .filter(|f| !staged_deletions.contains(f.as_str()))
        .map(|f| to_git_literal_pathspec(f))
        .collect();
    if !to_add.is_empty() {
        let mut args = vec!["add".to_string(), "--".to_string()];
        args.extend(to_add);
        let out = run_git_with_index(
            path,
            index,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
        )
        .await?;
        if !out.status.success() {
            return Err(git_command_error("add", &out.stderr));
        }
    }

    let name_status = git(
        path,
        index,
        &["diff", "--cached", "--find-renames", "--name-status", "-z"],
    )
    .await?;
    let numstat = git(
        path,
        index,
        &["diff", "--cached", "--find-renames", "--numstat", "-z"],
    )
    .await?;
    let mut files = parse_name_status(&name_status);
    apply_numstat(&mut files, &parse_numstat(&numstat));
    for file in &mut files {
        file.omitted = omission(file);
    }

    let patch = if files.iter().any(|f| f.omitted.is_none()) {
        // Fixed prefixes and unquoted paths, whatever the user's diff config
        // says, so a section's header can be matched to its file below.
        let mut args: Vec<String> = [
            "-c",
            "core.quotePath=false",
            "diff",
            "--cached",
            "--find-renames",
            "--no-color",
            "--no-ext-diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--",
            ":/",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        args.extend(exclusions(&files));
        let full = git(
            path,
            index,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
        )
        .await?;
        fit_to_budget(&drop_omitted(&full, &files), PATCH_BUDGET)
    } else {
        String::new()
    };

    Ok(CommitScope {
        files,
        patch,
        branch: branch(path).await,
        recent_subjects: recent_subjects(path).await,
    })
}

/// Run git against the scratch index and return stdout, failing on a non-zero
/// exit.
async fn git(
    path: &str,
    index: &std::path::Path,
    args: &[&str],
) -> Result<String, AppCommandError> {
    let out = run_git_with_index(path, index, args).await?;
    if !out.status.success() {
        // The subcommand, past any leading `-c key=value`.
        let operation = args
            .iter()
            .find(|a| !a.starts_with('-') && !a.contains('='))
            .copied()
            .unwrap_or("git");
        return Err(git_command_error(operation, &out.stderr));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Most omitted files excluded from the patch command by name.
const MAX_EXCLUDED: usize = 48;

/// Pathspecs that keep the biggest omitted files out of the patch git
/// writes, so neither it nor this process ever holds a lockfile or a bundle.
/// Both sides of a rename: git applies pathspecs before it pairs renames, so
/// excluding the new name alone leaves the old one in as a whole-file
/// deletion. Capped, because a pathspec per file would outgrow a command line
/// (32K characters on Windows) for a commit that stages many generated files;
/// [`drop_omitted`] takes out whatever is left. Binaries are never excluded:
/// git shows them as one line. `top` because the paths are relative to the
/// repository root while git runs in the folder, which can be below it.
fn exclusions(files: &[ChangedFile]) -> Vec<String> {
    let mut heavy: Vec<&ChangedFile> = files
        .iter()
        .filter(|f| matches!(f.omitted, Some(Omitted::Generated | Omitted::TooLarge)))
        .collect();
    heavy.sort_by_key(|f| std::cmp::Reverse(f.additions.unwrap_or(0) + f.deletions.unwrap_or(0)));
    heavy
        .into_iter()
        .take(MAX_EXCLUDED)
        .flat_map(|f| std::iter::once(&f.path).chain(f.from.as_ref()))
        .map(|p| format!(":(top,exclude,literal){p}"))
        .collect()
}

/// The patch without the sections of omitted files, matched by their exact
/// `diff --git` header. A header git had to quote (a path with a tab, a
/// quote, …) does not match and stays: a little extra text, never a lost file.
fn drop_omitted(patch: &str, files: &[ChangedFile]) -> String {
    let headers: std::collections::HashSet<String> = files
        .iter()
        .filter(|f| f.omitted.is_some())
        .map(|f| {
            format!(
                "diff --git a/{} b/{}",
                f.from.as_deref().unwrap_or(&f.path),
                f.path
            )
        })
        .collect();
    if headers.is_empty() {
        return patch.to_string();
    }
    split_files(patch)
        .into_iter()
        .filter(|section| !headers.contains(section.lines().next().unwrap_or("")))
        .collect()
}

/// The branch HEAD points at, unborn included; `None` when detached or on any
/// error — it is context for the prompt, not something to fail over.
async fn branch(path: &str) -> Option<String> {
    let out = crate::process::tokio_command("git")
        .args(["symbolic-ref", "--short", "-q", "HEAD"])
        .current_dir(path)
        .output()
        .await
        .ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !name.is_empty()).then_some(name)
}

/// Subjects of the latest non-merge commits. Empty for a repository without
/// history (or on any error), where the prompt falls back to its own
/// convention.
async fn recent_subjects(path: &str) -> Vec<String> {
    let count = format!("-n{RECENT_SUBJECTS}");
    let Ok(out) = crate::process::tokio_command("git")
        .args(["log", &count, "--no-merges", "--format=%s"])
        .current_dir(path)
        .output()
        .await
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// `--name-status -z`: `X\0path\0`, or `R<score>\0from\0to\0` for a rename or
/// copy.
fn parse_name_status(raw: &str) -> Vec<ChangedFile> {
    let mut parts = raw.split('\0');
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let Some(status) = code.chars().next() else {
            continue;
        };
        let (from, path) = if matches!(status, 'R' | 'C') {
            let (Some(from), Some(to)) = (parts.next(), parts.next()) else {
                break;
            };
            (Some(from.to_string()), to.to_string())
        } else {
            let Some(path) = parts.next() else {
                break;
            };
            (None, path.to_string())
        };
        files.push(ChangedFile {
            status,
            path,
            from,
            additions: None,
            deletions: None,
            omitted: None,
        });
    }
    files
}

/// `--numstat -z`: `adds\tdels\tpath\0`, or `adds\tdels\t\0from\0to\0` for a
/// rename or copy; `-` counts mark a binary file. Keyed by the new path.
fn parse_numstat(raw: &str) -> Vec<(String, Option<u64>, Option<u64>)> {
    let mut parts = raw.split('\0');
    let mut out = Vec::new();
    while let Some(record) = parts.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(path)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            let (Some(_from), Some(to)) = (parts.next(), parts.next()) else {
                break;
            };
            to.to_string()
        } else {
            path.to_string()
        };
        out.push((path, adds.parse().ok(), dels.parse().ok()));
    }
    out
}

fn apply_numstat(files: &mut [ChangedFile], counts: &[(String, Option<u64>, Option<u64>)]) {
    for (path, additions, deletions) in counts {
        if let Some(file) = files.iter_mut().find(|f| f.path == *path) {
            file.additions = *additions;
            file.deletions = *deletions;
        }
    }
}

fn omission(file: &ChangedFile) -> Option<Omitted> {
    let (Some(additions), Some(deletions)) = (file.additions, file.deletions) else {
        return Some(Omitted::Binary);
    };
    let name = file.path.rsplit('/').next().unwrap_or(&file.path);
    if GENERATED_FILE_NAMES.contains(&name)
        || GENERATED_FILE_SUFFIXES.iter().any(|s| name.ends_with(s))
    {
        return Some(Omitted::Generated);
    }
    (additions + deletions > MAX_PATCH_LINES).then_some(Omitted::TooLarge)
}

/// Cut a multi-file patch down to `budget` characters, fairly: files that fit
/// their share are kept whole and what they leave over is shared out again
/// among the rest; a file over its share keeps its leading hunks, cut at a
/// hunk boundary, and says how much was left out.
pub(crate) fn fit_to_budget(patch: &str, budget: usize) -> String {
    let files = split_files(patch);
    if files.iter().map(|f| f.len()).sum::<usize>() <= budget {
        return patch.to_string();
    }
    // Water-filling: smallest first, each taking at most an equal part of
    // what is left.
    let mut order: Vec<usize> = (0..files.len()).collect();
    order.sort_by_key(|&i| files[i].len());
    let mut shares = vec![0usize; files.len()];
    let mut left = budget;
    for (n, &i) in order.iter().enumerate() {
        let share = left / (files.len() - n);
        shares[i] = files[i].len().min(share);
        left -= shares[i];
    }
    files
        .iter()
        .zip(shares)
        .map(|(file, share)| truncate_file(file, share))
        .collect()
}

/// One `diff --git` section per file, in order. Text before the first header
/// (there is none in git's output) would ride with the first file.
fn split_files(patch: &str) -> Vec<&str> {
    let mut starts: Vec<usize> = patch
        .match_indices("diff --git ")
        .filter(|(i, _)| *i == 0 || patch.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)
        .collect();
    if starts.first() != Some(&0) {
        starts.insert(0, 0);
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let end = starts.get(n + 1).copied().unwrap_or(patch.len());
            &patch[start..end]
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn truncate_file(file: &str, share: usize) -> String {
    if file.len() <= share {
        return file.to_string();
    }
    let cut = floor_char_boundary(file, share);
    // Where the first hunk starts: everything before it is the header, which
    // says what the file is and is always kept, even past the share.
    let header_end = file.find("\n@@").map(|i| i + 1).unwrap_or(file.len());
    let at = if cut <= header_end {
        header_end
    } else if let Some(i) = file[..cut].rfind("\n@@").filter(|&i| i + 1 > header_end) {
        // Whole hunks, up to the last one that starts inside the share.
        i + 1
    } else {
        // Not even the first hunk fits: as much of it as does, by lines.
        file[..cut]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(header_end)
            .max(header_end)
    };
    if at >= file.len() {
        return file.to_string();
    }
    let kept = &file[..at];
    let dropped_lines = file[at..].lines().count();
    format!("{kept}[… {dropped_lines} more lines of this file's diff left out]\n")
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Git with a fixed identity and no user config, like the work-task git
    /// tests: the fixture must mean the same to this helper and to the code
    /// under test.
    fn git_run(dir: &std::path::Path, args: &[&str]) -> String {
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
        if args.first() == Some(&"init") {
            git_run(dir, &["config", "core.autocrlf", "false"]);
        }
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// The scope is what `git_commit_core` would commit: the chosen files plus
    /// whatever was already staged — not an unchosen edit, not an untracked
    /// file — and the user's own index is left exactly as it was.
    #[tokio::test]
    async fn the_scope_is_the_commit_and_the_real_index_is_untouched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let path = root.to_str().expect("utf-8 path");
        git_run(root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("chosen.txt"), "one\n").unwrap();
        std::fs::write(root.join("staged.txt"), "one\n").unwrap();
        std::fs::write(root.join("left.txt"), "one\n").unwrap();
        std::fs::write(root.join("Cargo.lock"), "a\n").unwrap();
        git_run(root, &["add", "-A"]);
        git_run(root, &["commit", "-q", "-m", "feat: start"]);

        std::fs::write(root.join("chosen.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("staged.txt"), "one\nstaged\n").unwrap();
        git_run(root, &["add", "staged.txt"]);
        std::fs::write(root.join("left.txt"), "one\nnot chosen\n").unwrap();
        std::fs::write(root.join("Cargo.lock"), "b\n").unwrap();
        std::fs::write(root.join("new.txt"), "untracked\n").unwrap();
        let index_before = git_run(root, &["diff", "--cached", "--name-only"]);

        let scope = read(path, &["chosen.txt".to_string(), "Cargo.lock".to_string()])
            .await
            .expect("scope");
        let paths: Vec<&str> = scope.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["Cargo.lock", "chosen.txt", "staged.txt"]);
        assert!(scope.patch.contains("+two"));
        assert!(scope.patch.contains("+staged"));
        assert!(!scope.patch.contains("not chosen"));
        // The lockfile is listed with its counts, never quoted.
        let lock = scope.files.iter().find(|f| f.path == "Cargo.lock").unwrap();
        assert_eq!(lock.omitted, Some(Omitted::Generated));
        assert!(!scope.patch.contains("Cargo.lock"));
        assert_eq!(scope.branch.as_deref(), Some("main"));
        assert_eq!(scope.recent_subjects, vec!["feat: start".to_string()]);

        assert_eq!(
            git_run(root, &["diff", "--cached", "--name-only"]),
            index_before,
            "the user's index is never written"
        );
        let git_dir = root.join(".git");
        let leftovers: Vec<_> = std::fs::read_dir(&git_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("codeg-diff-index")
            })
            .collect();
        assert!(leftovers.is_empty(), "the scratch index is removed");
    }

    /// A lockfile that moved is still left out whole: excluding only its new
    /// name would let git report the old one as a deletion of every line.
    #[tokio::test]
    async fn a_renamed_lockfile_is_left_out_on_both_sides() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let path = root.to_str().expect("utf-8 path");
        git_run(root, &["init", "-q", "-b", "main"]);
        let lock: String = (0..50)
            .map(|i| format!("dep-{i} = \"1.0.{i}\"\n"))
            .collect();
        std::fs::write(root.join("yarn.lock"), &lock).unwrap();
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git_run(root, &["add", "-A"]);
        git_run(root, &["commit", "-q", "-m", "base"]);
        std::fs::create_dir(root.join("web")).unwrap();
        git_run(root, &["mv", "yarn.lock", "web/yarn.lock"]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();

        let scope = read(path, &["a.txt".to_string()]).await.expect("scope");
        let moved = scope
            .files
            .iter()
            .find(|f| f.path == "web/yarn.lock")
            .unwrap();
        assert_eq!(moved.status, 'R');
        assert_eq!(moved.from.as_deref(), Some("yarn.lock"));
        assert_eq!(moved.omitted, Some(Omitted::Generated));
        assert!(scope.patch.contains("+two"));
        assert!(!scope.patch.contains("dep-"), "{}", scope.patch);
        assert!(!scope.patch.contains("yarn.lock"), "{}", scope.patch);
    }

    #[test]
    fn omitted_sections_are_dropped_by_their_exact_header() {
        let patch = "diff --git a/keep.rs b/keep.rs\n@@ -1 +1 @@\n+k\n\
                     diff --git a/old.lock b/new.lock\n@@ -1 +1 @@\n+l\n\
                     diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
        let mut lock = file("new.lock", Some(1), Some(1));
        lock.from = Some("old.lock".into());
        lock.omitted = Some(Omitted::Generated);
        let mut image = file("img.png", None, None);
        image.omitted = Some(Omitted::Binary);
        let kept = drop_omitted(patch, &[file("keep.rs", Some(1), Some(1)), lock, image]);
        assert_eq!(kept, "diff --git a/keep.rs b/keep.rs\n@@ -1 +1 @@\n+k\n");
    }

    #[test]
    fn only_the_biggest_generated_files_are_excluded_both_sides_and_never_binaries() {
        let mut files: Vec<ChangedFile> = (0..(MAX_EXCLUDED + 5))
            .map(|i| {
                let mut f = file(&format!("gen{i}.min.js"), Some(i as u64), Some(0));
                f.omitted = Some(Omitted::Generated);
                f
            })
            .collect();
        let mut moved = file("big/new.lock", Some(10_000), Some(0));
        moved.from = Some("big/old.lock".into());
        moved.omitted = Some(Omitted::TooLarge);
        files.push(moved);
        let mut image = file("img.png", None, None);
        image.omitted = Some(Omitted::Binary);
        files.push(image);

        let specs = exclusions(&files);
        assert_eq!(specs.len(), MAX_EXCLUDED + 1, "the rename takes two");
        assert_eq!(specs[0], ":(top,exclude,literal)big/new.lock");
        assert_eq!(specs[1], ":(top,exclude,literal)big/old.lock");
        assert!(!specs.iter().any(|s| s.ends_with("img.png")));
        // The smallest ones are the ones left to `drop_omitted`.
        assert!(!specs.iter().any(|s| s.ends_with(")gen0.min.js")));
    }

    /// A repository nothing was ever committed or staged in has no index file
    /// and no HEAD: the scope is the chosen files as new files.
    #[tokio::test]
    async fn an_unborn_repository_scopes_its_first_commit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let path = root.to_str().expect("utf-8 path");
        git_run(root, &["init", "-q", "-b", "trunk"]);
        std::fs::write(root.join("first.txt"), "hello\n").unwrap();
        std::fs::write(root.join("other.txt"), "not chosen\n").unwrap();

        let scope = read(path, &["first.txt".to_string()]).await.expect("scope");
        assert_eq!(scope.files.len(), 1);
        assert_eq!(scope.files[0].status, 'A');
        assert_eq!(scope.files[0].path, "first.txt");
        assert!(scope.patch.contains("+hello"));
        assert_eq!(scope.branch.as_deref(), Some("trunk"));
        assert!(scope.recent_subjects.is_empty());
        assert!(
            !root.join(".git").join("index").exists(),
            "still nothing staged"
        );
    }

    /// A deletion already staged rides along without being re-added (which
    /// `git add` would refuse), exactly as `git_commit_core` handles it.
    #[tokio::test]
    async fn a_staged_deletion_is_kept_not_re_added() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let path = root.to_str().expect("utf-8 path");
        git_run(root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("gone.txt"), "bye\n").unwrap();
        git_run(root, &["add", "-A"]);
        git_run(root, &["commit", "-q", "-m", "base"]);
        git_run(root, &["rm", "-q", "gone.txt"]);

        let scope = read(path, &["gone.txt".to_string()]).await.expect("scope");
        assert_eq!(scope.files.len(), 1);
        assert_eq!(scope.files[0].status, 'D');
    }

    #[test]
    fn name_status_reads_plain_and_renamed_entries() {
        let raw = "M\0src/a.rs\0R087\0old/b.rs\0new/b.rs\0A\0c d.txt\0";
        let files = parse_name_status(raw);
        assert_eq!(files.len(), 3);
        assert_eq!((files[0].status, files[0].path.as_str()), ('M', "src/a.rs"));
        assert_eq!(files[1].status, 'R');
        assert_eq!(files[1].from.as_deref(), Some("old/b.rs"));
        assert_eq!(files[1].path, "new/b.rs");
        assert_eq!(files[2].path, "c d.txt");
    }

    #[test]
    fn numstat_reads_counts_renames_and_binaries() {
        let raw = concat!(
            "3\t1\tsrc/a.rs\0",
            "-\t-\timg.png\0",
            "2\t2\t\0old/b.rs\0new/b.rs\0",
        );
        let counts = parse_numstat(raw);
        assert_eq!(counts[0], ("src/a.rs".to_string(), Some(3), Some(1)));
        assert_eq!(counts[1], ("img.png".to_string(), None, None));
        assert_eq!(counts[2], ("new/b.rs".to_string(), Some(2), Some(2)));
    }

    fn file(path: &str, additions: Option<u64>, deletions: Option<u64>) -> ChangedFile {
        ChangedFile {
            status: 'M',
            path: path.to_string(),
            from: None,
            additions,
            deletions,
            omitted: None,
        }
    }

    #[test]
    fn binaries_lockfiles_and_huge_changes_are_listed_not_quoted() {
        assert_eq!(
            omission(&file("logo.png", None, None)),
            Some(Omitted::Binary)
        );
        assert_eq!(
            omission(&file("web/pnpm-lock.yaml", Some(9), Some(2))),
            Some(Omitted::Generated)
        );
        assert_eq!(
            omission(&file("dist/app.min.js", Some(1), Some(1))),
            Some(Omitted::Generated)
        );
        assert_eq!(
            omission(&file("data.json", Some(5_000), Some(0))),
            Some(Omitted::TooLarge)
        );
        assert_eq!(omission(&file("src/lib.rs", Some(40), Some(3))), None);
    }

    fn file_patch(name: &str, hunks: usize, hunk_lines: usize) -> String {
        let mut out = format!(
            "diff --git a/{name} b/{name}\nindex 1..2 100644\n--- a/{name}\n+++ b/{name}\n"
        );
        for h in 0..hunks {
            out.push_str(&format!("@@ -{h},1 +{h},1 @@\n"));
            for l in 0..hunk_lines {
                out.push_str(&format!("+line {h}.{l}\n"));
            }
        }
        out
    }

    #[test]
    fn a_patch_within_budget_is_untouched() {
        let patch = file_patch("a", 2, 3) + &file_patch("b", 1, 2);
        assert_eq!(fit_to_budget(&patch, 10_000), patch);
    }

    #[test]
    fn small_files_stay_whole_and_large_ones_share_the_rest_at_hunk_boundaries() {
        let small = file_patch("small", 1, 2);
        let big_a = file_patch("big_a", 40, 20);
        let big_b = file_patch("big_b", 40, 20);
        let patch = format!("{small}{big_a}{big_b}");
        let budget = small.len() + 4_000;
        let fitted = fit_to_budget(&patch, budget);

        assert!(fitted.contains(&small), "the small file is kept whole");
        assert!(fitted.contains("diff --git a/big_a b/big_a"));
        assert!(fitted.contains("diff --git a/big_b b/big_b"));
        assert_eq!(
            fitted
                .matches("more lines of this file's diff left out")
                .count(),
            2
        );
        // Generous slack for the two markers.
        assert!(
            fitted.len() <= budget + 200,
            "{} > {}",
            fitted.len(),
            budget
        );
        // Every kept hunk is whole: a cut lands right before a hunk header.
        for section in split_files(&fitted).iter().skip(1) {
            let before_marker = section.split("[…").next().unwrap();
            assert!(before_marker.ends_with('\n'));
            let last_hunk = before_marker.rsplit("@@ -").next().unwrap();
            assert_eq!(last_hunk.lines().count(), 21, "{last_hunk}");
        }
    }

    #[test]
    fn a_single_oversized_hunk_is_cut_at_a_line_but_keeps_its_header() {
        let patch = file_patch("one", 1, 2_000);
        let fitted = fit_to_budget(&patch, 500);
        assert!(fitted.starts_with("diff --git a/one b/one\n"));
        assert!(fitted.contains("+++ b/one\n"));
        assert!(fitted.ends_with("left out]\n"));
        assert!(fitted.len() < 700);
    }

    #[test]
    fn cutting_respects_multibyte_characters() {
        let mut patch = String::from("diff --git a/zh b/zh\n--- a/zh\n+++ b/zh\n@@ -1 +1 @@\n");
        for _ in 0..400 {
            patch.push_str("+提交信息生成\n");
        }
        let fitted = fit_to_budget(&patch, 301);
        assert!(fitted.is_char_boundary(fitted.len()));
        assert!(fitted.contains("left out"));
    }
}
