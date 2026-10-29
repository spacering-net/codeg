//! Lossless Claude session copies for an explicit account switch. Authentication
//! and account settings never travel. A destination with divergent history is
//! refused; previous copies are retained in a private recovery directory.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// A custom task-list id can be shared with other sessions. Moving just this
/// session cannot safely claim or replace that shared list in another home.
pub(crate) fn ensure_session_task_lists(
    source: &Path,
    target: &Path,
    cwd: &Path,
    sid: &str,
    environments: &[&std::collections::BTreeMap<String, String>],
) -> io::Result<()> {
    const KEY: &str = "CLAUDE_CODE_TASK_LIST_ID";
    let allowed = |id: &str| id.trim().is_empty() || id == sid;
    let refuse = || {
        invalid("This session uses a custom task list. Keep its current account or start a new chat with the selected account.")
    };
    for env in environments {
        if let Some(id) = env.get(KEY).cloned().or_else(|| std::env::var(KEY).ok()) {
            if !allowed(&id) {
                return Err(refuse());
            }
        }
    }
    for path in [
        source.join("settings.json"),
        target.join("settings.json"),
        cwd.join(".claude/settings.json"),
        cwd.join(".claude/settings.local.json"),
    ] {
        match fs::read(&path) {
            Ok(bytes) => {
                let value: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|_| invalid("Claude settings could not be read. Fix the settings before switching accounts."))?;
                if value
                    .get("env")
                    .and_then(|e| e.get(KEY))
                    .and_then(|v| v.as_str())
                    .is_some_and(|id| !allowed(id))
                {
                    return Err(refuse());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn plain(path: &Path) -> io::Result<fs::Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(invalid("Session transfer cannot follow symbolic links."));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(invalid(
                "Session transfer cannot follow directory junctions.",
            ));
        }
    }
    Ok(meta)
}

fn ensure_dir(path: &Path) -> io::Result<()> {
    if path.symlink_metadata().is_ok() {
        if !plain(path)?.is_dir() {
            return Err(invalid("A session directory is not a directory."));
        }
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| invalid("Invalid account folder."))?;
        ensure_dir(parent)?;
        fs::create_dir(path)?;
    }
    Ok(())
}

/// Compare incrementally: a long conversation need not fit in memory twice.
pub(crate) fn is_prefix(older: &Path, newer: &Path) -> io::Result<bool> {
    if !plain(older)?.is_file() || !plain(newer)?.is_file() {
        return Ok(false);
    }
    let mut a = fs::File::open(older)?;
    let mut b = fs::File::open(newer)?;
    let mut left = [0; 65536];
    let mut right = [0; 65536];
    loop {
        let n = a.read(&mut left)?;
        if n == 0 {
            return Ok(true);
        }
        if b.read_exact(&mut right[..n]).is_err() || left[..n] != right[..n] {
            return Ok(false);
        }
    }
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    let meta = plain(src)?;
    if meta.is_dir() {
        fs::create_dir(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else if meta.is_file() {
        fs::copy(src, dst)?;
    } else {
        return Err(invalid("Unsupported session file type."));
    }
    Ok(())
}

pub(crate) fn tree_is_older(older: &Path, newer: &Path) -> io::Result<bool> {
    if plain(older)?.is_dir() {
        if !plain(newer)?.is_dir() {
            return Ok(false);
        }
        for entry in fs::read_dir(older)? {
            let entry = entry?;
            let new = newer.join(entry.file_name());
            if !new.exists() || !tree_is_older(&entry.path(), &new)? {
                return Ok(false);
            }
        }
        Ok(true)
    } else {
        is_prefix(older, newer)
    }
}

fn remove_tree(path: &Path) -> io::Result<()> {
    if plain(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[derive(Debug)]
struct Entry {
    target: PathBuf,
    backup: Option<PathBuf>,
}

#[derive(Debug)]
pub struct ClaudeTransfer {
    entries: Vec<Entry>,
    /// This switch's private staging directory: the destination's previous
    /// copies (`old-*`) and any new copy not yet moved into place. It is only
    /// needed until the switch is committed or fully rolled back.
    stage: PathBuf,
    // Mutable task lists are not append-only. Retain replaced task state for
    // recovery instead of silently deleting a target's earlier task edits.
    retained: Vec<PathBuf>,
}

impl ClaudeTransfer {
    /// Call only after the target process has stopped. Recovery copies are
    /// retained if anything fails, so an interrupted rollback cannot lose data.
    pub fn rollback(&self) -> io::Result<()> {
        for entry in self.entries.iter().rev() {
            if entry.target.symlink_metadata().is_ok() {
                remove_tree(&entry.target)?;
            }
            if let Some(backup) = &entry.backup {
                copy_tree(backup, &entry.target)?;
            }
        }
        Ok(())
    }

    /// Delete the staging copies once nothing can need them: the switch was
    /// committed, or `rollback` completed. Never call it after a failed
    /// rollback, when they are the only recovery copy. Best effort: a leftover
    /// directory costs disk space, never history.
    pub fn discard_staging(&self) {
        if self.retained.is_empty() {
            discard_stage(&self.stage);
        } else if let Ok(entries) = fs::read_dir(&self.stage) {
            for entry in entries.flatten() {
                if !self.retained.contains(&entry.path()) {
                    let _ = remove_tree(&entry.path());
                }
            }
        }
    }
}

fn discard_stage(stage: &Path) {
    if let Err(e) = fs::remove_dir_all(stage) {
        if e.kind() != io::ErrorKind::NotFound {
            tracing::warn!(
                "[account-switch] could not remove staging copies at {}: {e}",
                stage.display()
            );
        }
    }
    // The recovery folder holds nothing but staging directories. Remove it once
    // empty; another switch's retained recovery copy keeps it in place.
    if let Some(recovery) = stage.parent() {
        let _ = fs::remove_dir(recovery);
    }
}

struct CopyPair {
    source: Option<PathBuf>,
    target: PathBuf,
    mutable: bool,
}

fn stage_copies(pairs: &[CopyPair], stage: &Path) -> io::Result<Vec<PathBuf>> {
    let mut retained = Vec::new();
    let mut recovery = Vec::new();
    for (i, pair) in pairs.iter().enumerate() {
        let to = &pair.target;
        if let Some(from) = &pair.source {
            if to.symlink_metadata().is_ok() && !pair.mutable && !tree_is_older(to, from)? {
                return Err(invalid(
                    "The target account has different session files. Both copies were kept.",
                ));
            }
            copy_tree(from, &stage.join(format!("new-{i}")))?;
        }
        if to.symlink_metadata().is_ok() {
            let backup = stage.join(format!("old-{i}"));
            copy_tree(to, &backup)?;
            if pair.mutable {
                recovery.push(serde_json::json!({ "original": to, "backup": format!("old-{i}") }));
                retained.push(backup);
            }
        }
        ensure_dir(to.parent().unwrap())?;
    }
    if !recovery.is_empty() {
        let manifest = stage.join("task-recovery.json");
        fs::write(&manifest, serde_json::to_vec_pretty(&recovery)?)?;
        retained.push(manifest);
    }
    Ok(retained)
}

pub fn copy_claude_session(source: &Path, target: &Path, sid: &str) -> io::Result<ClaudeTransfer> {
    if sid.is_empty()
        || !sid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(invalid("Invalid session id."));
    }
    plain(source)?;
    ensure_dir(target)?;
    if source.canonicalize()? == target.canonicalize()? {
        return Err(invalid("These accounts use the same session folder."));
    }
    let source_projects = source.join("projects");
    plain(&source_projects)?;
    let mut matches = 0;
    for entry in fs::read_dir(&source_projects)? {
        if entry?.path().join(format!("{sid}.jsonl")).exists() {
            matches += 1;
        }
    }
    if matches > 1 {
        return Err(invalid("The source account has multiple copies of this session. Resolve them before switching."));
    }
    let src =
        crate::parsers::claude::find_session_file_in(&source_projects, sid).ok_or_else(|| {
            invalid("The original transcript is missing. Restore it before switching accounts.")
        })?;
    plain(src.parent().unwrap())?;
    if !plain(&src)?.is_file() || fs::metadata(&src)?.len() == 0 {
        return Err(invalid("The original transcript is empty."));
    }
    let project = src.parent().and_then(Path::file_name).unwrap();
    let projects = target.join("projects");
    ensure_dir(&projects)?;
    let dst_dir = projects.join(project);
    ensure_dir(&dst_dir)?;
    let dst = dst_dir.join(format!("{sid}.jsonl"));
    // The resolver scans all project folders. A second same-id transcript in
    // another folder would make load ambiguous, even if this path is absent.
    for entry in fs::read_dir(&projects)? {
        let entry = entry?;
        if entry.path() != dst_dir && entry.path().join(format!("{sid}.jsonl")).exists() {
            return Err(invalid(
                "The target account already has this session in another project.",
            ));
        }
    }
    if dst.symlink_metadata().is_ok() && !is_prefix(&dst, &src)? {
        return Err(invalid("The target account has different or newer history. Switch was cancelled to keep both copies."));
    }
    let mut pairs = vec![CopyPair {
        source: Some(src.clone()),
        target: dst.clone(),
        mutable: false,
    }];
    // Claude stores tool results and sub-agent transcripts beside the JSONL;
    // file-history holds the session's original file versions for rewind.
    for (from, to) in [
        (src.with_file_name(sid), dst_dir.join(sid)),
        (
            source.join("file-history").join(sid),
            target.join("file-history").join(sid),
        ),
    ] {
        if from.symlink_metadata().is_ok() {
            pairs.push(CopyPair {
                source: Some(from),
                target: to,
                mutable: false,
            });
        } else if to.symlink_metadata().is_ok() {
            return Err(invalid(
                "The target account has session files missing from the source.",
            ));
        }
    }
    // TaskCreate/TaskUpdate rewrite these JSON files; TodoWrite uses the
    // legacy per-session files. Move only this session's lists, never shared
    // CLAUDE_CODE_TASK_LIST_ID lists or another session's tasks.
    let mut mutable = vec![(
        source.join("tasks").join(sid),
        target.join("tasks").join(sid),
    )];
    let mut names = std::collections::BTreeSet::new();
    for root in [source, target] {
        for name in ["tasks", "todos", "file-history"] {
            let dir = root.join(name);
            if dir.symlink_metadata().is_ok() {
                plain(&dir)?;
            }
        }
        let todos = root.join("todos");
        if todos.is_dir() {
            for entry in fs::read_dir(&todos)? {
                let name = entry?.file_name();
                let text = name.to_string_lossy();
                if text.starts_with(&format!("{sid}-agent-")) && text.ends_with(".json") {
                    names.insert(name);
                }
            }
        }
    }
    for name in names {
        mutable.push((
            source.join("todos").join(&name),
            target.join("todos").join(name),
        ));
    }
    for (from, to) in mutable {
        let source_exists = from.symlink_metadata().is_ok();
        let target_exists = to.symlink_metadata().is_ok();
        if target_exists && !dst.exists() {
            return Err(invalid("The target has task files without matching conversation history. Both copies were kept."));
        }
        if source_exists || target_exists {
            pairs.push(CopyPair {
                source: source_exists.then_some(from),
                target: to,
                mutable: true,
            });
        }
    }
    let recovery = target.join(".codeg-account-switch");
    ensure_dir(&recovery)?;
    let stage = recovery.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&stage)?;
    // Finish every read/copy (including symlink checks) before replacing any
    // destination. Only session-specific paths enter this staging directory.
    let retained = match stage_copies(&pairs, &stage) {
        Ok(retained) => retained,
        Err(error) => {
            discard_stage(&stage);
            return Err(error);
        }
    };
    let mut transfer = ClaudeTransfer {
        entries: Vec::new(),
        stage: stage.clone(),
        retained,
    };
    for (i, pair) in pairs.iter().enumerate() {
        let to = &pair.target;
        let old = stage.join(format!("old-{i}"));
        transfer.entries.push(Entry {
            target: to.clone(),
            backup: old.exists().then_some(old),
        });
        let install = (|| {
            if to.symlink_metadata().is_ok() {
                remove_tree(to)?;
            }
            if pair.source.is_some() {
                fs::rename(stage.join(format!("new-{i}")), to)?;
            }
            Ok::<_, io::Error>(())
        })();
        if let Err(e) = install {
            // A failed rollback returns here with the staging copies intact.
            transfer.rollback()?;
            transfer.discard_staging();
            return Err(e);
        }
    }
    Ok(transfer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path, text: &str) -> PathBuf {
        fs::create_dir_all(root.join("projects/project/sid")).unwrap();
        let p = root.join("projects/project/sid.jsonl");
        fs::write(&p, text).unwrap();
        fs::write(
            root.join("projects/project/sid/tool.txt"),
            "full tool result",
        )
        .unwrap();
        p
    }

    #[test]
    fn mutable_session_tasks_round_trip_and_keep_recovery_copies() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fixture(a.path(), "first\n");
        fs::create_dir_all(a.path().join("tasks/sid")).unwrap();
        fs::create_dir_all(a.path().join("todos")).unwrap();
        fs::write(a.path().join("tasks/sid/1.json"), r#"{"status":"pending"}"#).unwrap();
        fs::write(a.path().join("todos/sid-agent-main.json"), "old plan").unwrap();
        fs::write(a.path().join("todos/other-agent-main.json"), "unrelated").unwrap();
        copy_claude_session(a.path(), b.path(), "sid")
            .unwrap()
            .discard_staging();
        assert!(!b.path().join("todos/other-agent-main.json").exists());
        fixture(b.path(), "first\nsecond\n");
        fs::write(
            b.path().join("tasks/sid/1.json"),
            r#"{"status":"completed"}"#,
        )
        .unwrap();
        fs::remove_file(b.path().join("todos/sid-agent-main.json")).unwrap();
        let back = copy_claude_session(b.path(), a.path(), "sid").unwrap();
        assert_eq!(
            fs::read_to_string(a.path().join("tasks/sid/1.json")).unwrap(),
            r#"{"status":"completed"}"#
        );
        assert!(!a.path().join("todos/sid-agent-main.json").exists());
        back.rollback().unwrap();
        assert_eq!(
            fs::read_to_string(a.path().join("tasks/sid/1.json")).unwrap(),
            r#"{"status":"pending"}"#
        );
        assert_eq!(
            fs::read_to_string(a.path().join("todos/sid-agent-main.json")).unwrap(),
            "old plan"
        );
        let committed = copy_claude_session(b.path(), a.path(), "sid").unwrap();
        let stage = committed.stage.clone();
        committed.discard_staging();
        assert!(stage.join("task-recovery.json").exists());
        assert!(
            !stage.join("old-0").exists(),
            "do not retain another whole transcript"
        );
        assert_eq!(
            fs::read_to_string(a.path().join("todos/other-agent-main.json")).unwrap(),
            "unrelated"
        );
    }

    #[test]
    fn custom_task_list_is_not_silently_replaced_by_an_empty_session_list() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let env = std::collections::BTreeMap::from([(
            "CLAUDE_CODE_TASK_LIST_ID".into(),
            "shared-project".into(),
        )]);
        assert!(ensure_session_task_lists(a.path(), b.path(), cwd.path(), "sid", &[&env]).is_err());
        fs::write(
            a.path().join("settings.json"),
            r#"{"env":{"CLAUDE_CODE_TASK_LIST_ID":"shared-project"}}"#,
        )
        .unwrap();
        assert!(ensure_session_task_lists(a.path(), b.path(), cwd.path(), "sid", &[]).is_err());
    }

    #[test]
    fn round_trip_keeps_full_history_sidecars_and_credentials() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let original = fixture(a.path(), "first\n");
        fs::write(a.path().join("auth.json"), "source-auth").unwrap();
        fs::write(b.path().join("auth.json"), "target-auth").unwrap();
        copy_claude_session(a.path(), b.path(), "sid").unwrap();
        let newer = fixture(b.path(), "first\nsecond\n");
        let back = copy_claude_session(b.path(), a.path(), "sid").unwrap();
        assert_eq!(fs::read(&original).unwrap(), fs::read(&newer).unwrap());
        assert_eq!(
            fs::read_to_string(a.path().join("auth.json")).unwrap(),
            "source-auth"
        );
        assert_eq!(
            fs::read_to_string(b.path().join("auth.json")).unwrap(),
            "target-auth"
        );
        back.rollback().unwrap();
        assert_eq!(fs::read_to_string(original).unwrap(), "first\n");
        assert_eq!(fs::read_to_string(newer).unwrap(), "first\nsecond\n");
    }

    #[test]
    fn divergent_or_missing_history_never_overwrites_target() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fixture(a.path(), "source\n");
        let target = fixture(b.path(), "independent\n");
        assert!(copy_claude_session(a.path(), b.path(), "sid").is_err());
        assert!(copy_claude_session(a.path(), b.path(), "../sid").is_err());
        assert!(copy_claude_session(a.path(), b.path(), ".").is_err());
        assert!(copy_claude_session(a.path(), b.path(), "missing").is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "independent\n");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_before_changing_any_destination() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fixture(a.path(), "first\n");
        std::os::unix::fs::symlink("/etc", a.path().join("projects/project/sid/link")).unwrap();
        assert!(copy_claude_session(a.path(), b.path(), "sid").is_err());
        assert!(!b.path().join("projects/project/sid.jsonl").exists());
        assert!(!b.path().join(".codeg-account-switch").exists());
    }

    /// Every switch stages full copies of the transcript and of whatever the
    /// destination held before. Once the switch is committed, or a rollback has
    /// put the previous copy back, those copies are dead weight; keeping them
    /// grew the account folders by a whole transcript on every round trip.
    #[test]
    fn finished_switches_leave_no_staging_copies() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fixture(a.path(), "first\n");
        copy_claude_session(a.path(), b.path(), "sid")
            .unwrap()
            .discard_staging();
        assert!(!b.path().join(".codeg-account-switch").exists());

        // Back to A, where an older copy is staged as the rollback source.
        let newer = fixture(b.path(), "first\nsecond\n");
        let back = copy_claude_session(b.path(), a.path(), "sid").unwrap();
        back.rollback().unwrap();
        back.discard_staging();
        assert!(!a.path().join(".codeg-account-switch").exists());
        assert_eq!(
            fs::read_to_string(a.path().join("projects/project/sid.jsonl")).unwrap(),
            "first\n"
        );
        assert_eq!(fs::read_to_string(newer).unwrap(), "first\nsecond\n");
    }

    /// A refusal found while staging (here a sidecar that differs at the
    /// destination) happens before any destination changed, so its partial
    /// copies are discarded with it.
    #[test]
    fn a_refused_switch_leaves_no_staging_copies() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fixture(a.path(), "first\nsecond\n");
        fixture(b.path(), "first\n");
        fs::write(
            b.path().join("projects/project/sid/tool.txt"),
            "changed here",
        )
        .unwrap();
        assert!(copy_claude_session(a.path(), b.path(), "sid").is_err());
        assert!(!b.path().join(".codeg-account-switch").exists());
        assert_eq!(
            fs::read_to_string(b.path().join("projects/project/sid/tool.txt")).unwrap(),
            "changed here"
        );
    }
}
