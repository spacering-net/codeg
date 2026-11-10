//! Publishing several files of `CODEX_HOME` as one change.
//!
//! codex reads config.toml, auth.json and the catalog file without any lock,
//! so a crash halfway through a save must not leave a new endpoint with an old
//! key, or a reference to a catalog that was never written. The shape follows
//! codeg's own self-update (`update/install.rs`): stage everything, back up
//! what will be replaced, record a journal, rename into place in order, and
//! decide on recovery by the **content hash** of the commit point — the last
//! file published, normally config.toml. One difference: config files are
//! renamed over directly (`MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on
//! Windows); nothing is moved aside first, since nothing here is a running
//! executable.
//!
//! Every function here takes the lock guard: a journal can only have been
//! left by a transaction that has exited or released the lock, because it
//! held both layers from start to end.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::lock::CodexHomeGuard;
use crate::acp::codex_endpoint_catalog::sha256_hex;

pub const JOURNAL_FILE: &str = "codeg-codex-commit.journal";
/// Every temporary, backup and journal draft codeg writes starts with this.
const TXN_PREFIX: &str = ".codeg-txn-";
/// Leftovers younger than this may belong to a transaction in progress
/// elsewhere; an in-flight one never leaves anything for more than seconds.
const ORPHAN_AGE: Duration = Duration::from_secs(10 * 60);

/// One file to publish: new bytes, or `None` to delete it.
#[derive(Debug, Clone)]
pub struct Target {
    pub name: String,
    pub content: Option<Vec<u8>>,
}

impl Target {
    pub fn write(name: &str, content: Vec<u8>) -> Self {
        Self {
            name: name.to_string(),
            content: Some(content),
        }
    }

    pub fn delete(name: &str) -> Self {
        Self {
            name: name.to_string(),
            content: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalTarget {
    name: String,
    backup: Option<String>,
    tmp: Option<String>,
    old_hash: Option<String>,
    new_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Staged,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    txn: String,
    phase: Phase,
    commit_point: String,
    targets: Vec<JournalTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxnError {
    /// Writing failed; nothing was published, or what was has been restored.
    Io(String),
    /// A file changed under an unfinished transaction, or could not be put
    /// back. The journal and backups are kept; no commit runs until it is
    /// resolved.
    NeedsRepair {
        path: PathBuf,
        repair: Repair,
        reason: String,
    },
}

/// What lets recovery go on after a [`TxnError::NeedsRepair`] at `path`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Repair {
    /// Copy the file's version from before the save, kept here, back over
    /// it: recovery then undoes or completes the save from a state it knows.
    CopyBack(PathBuf),
    /// Remove the file: the save was creating it, so its absence is the
    /// state recovery knows.
    Remove,
    /// Neither will do — the journal (kept here) is damaged, or a backup or
    /// a staged file is gone — so codeg cannot finish or undo the save. Only
    /// deleting the journal, after a look at the files, lets commits run;
    /// the next save writes the files afresh.
    Reset(PathBuf),
}

impl std::fmt::Display for TxnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TxnError::Io(msg) => write!(f, "{msg}"),
            TxnError::NeedsRepair {
                path,
                repair,
                reason,
            } => {
                write!(
                    f,
                    "the Codex configuration needs repair: {} ({reason})",
                    path.display()
                )?;
                match repair {
                    Repair::CopyBack(b) => {
                        write!(f, "; the previous version is kept at {}", b.display())
                    }
                    Repair::Remove => write!(f, "; it did not exist before that save"),
                    Repair::Reset(journal) => write!(
                        f,
                        "; codeg cannot finish or undo that save: check the files, delete {}, then save again",
                        journal.display()
                    ),
                }
            }
        }
    }
}

/// How a user lets an undo past `jt`: its backup copied back, or — when the
/// save was creating it — its removal; neither when the backup is gone.
fn repair_for(home: &Path, jt: &JournalTarget) -> Repair {
    match (&jt.old_hash, &jt.backup) {
        (None, _) => Repair::Remove,
        (Some(_), Some(b)) if home.join(b).is_file() => Repair::CopyBack(home.join(b)),
        _ => Repair::Reset(home.join(JOURNAL_FILE)),
    }
}

/// [`repair_for`] when recovery is completing the save instead: a target
/// the save was removing is removed; any other needs its state from before
/// the save back so its staged file can go in, which takes that file.
fn completion_repair_for(home: &Path, jt: &JournalTarget) -> Repair {
    if jt.new_hash.is_none() {
        return Repair::Remove;
    }
    if !jt.tmp.as_ref().is_some_and(|tmp| home.join(tmp).is_file()) {
        return Repair::Reset(home.join(JOURNAL_FILE));
    }
    repair_for(home, jt)
}

fn io(context: &str, e: std::io::Error) -> TxnError {
    TxnError::Io(format!("{context}: {e}"))
}

fn hash_of(path: &Path) -> std::io::Result<Option<String>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(sha256_hex(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// `rename`, retried briefly: on Windows another program holding the target
/// open (a sharing violation) clears within moments.
fn rename_over(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                if !cfg!(windows) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(40 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn write_journal(home: &Path, journal: &Journal) -> std::io::Result<()> {
    let tmp = home.join(format!("{TXN_PREFIX}{}-journal.tmp", journal.txn));
    let bytes = serde_json::to_vec_pretty(journal).map_err(std::io::Error::other)?;
    write_synced(&tmp, &bytes)?;
    rename_over(&tmp, &home.join(JOURNAL_FILE))?;
    sync_dir(home);
    Ok(())
}

/// What a commit did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CommitReport {
    /// The targets whose content actually changed, in publish order.
    pub changed: Vec<String>,
}

/// Publish `targets` (in this order) as one change. Targets whose content is
/// already on disk are left out; when none is left this is a successful
/// no-op.
pub fn commit_files(
    guard: &CodexHomeGuard,
    targets: Vec<Target>,
) -> Result<CommitReport, TxnError> {
    let home = guard.home();
    let txn = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();

    // 1. Only what changes takes part.
    let mut staged: Vec<(JournalTarget, Option<Vec<u8>>)> = Vec::new();
    for t in targets {
        let path = home.join(&t.name);
        let old_hash = hash_of(&path).map_err(|e| io(&format!("read {}", path.display()), e))?;
        let new_hash = t.content.as_deref().map(sha256_hex);
        if old_hash == new_hash {
            continue;
        }
        staged.push((
            JournalTarget {
                name: t.name.clone(),
                backup: None,
                tmp: None,
                old_hash,
                new_hash,
            },
            t.content,
        ));
    }
    if staged.is_empty() {
        return Ok(CommitReport::default());
    }
    std::fs::create_dir_all(home).map_err(|e| io("create CODEX_HOME", e))?;

    let cleanup_partial = |entries: &[(JournalTarget, Option<Vec<u8>>)]| {
        for (jt, _) in entries {
            for f in [&jt.tmp, &jt.backup].into_iter().flatten() {
                let _ = std::fs::remove_file(home.join(f));
            }
        }
    };

    // 2. New contents next to their targets, synced. Nothing live moved yet.
    for i in 0..staged.len() {
        let Some(bytes) = &staged[i].1 else { continue };
        let name = staged[i].0.name.clone();
        let tmp = format!("{TXN_PREFIX}{txn}-{name}.tmp");
        if let Err(e) = write_synced(&home.join(&tmp), bytes) {
            cleanup_partial(&staged);
            let _ = std::fs::remove_file(home.join(&tmp));
            return Err(io(&format!("stage {name}"), e));
        }
        staged[i].0.tmp = Some(tmp);
    }
    // 3. Backups are COPIES: the live file stays where it is throughout.
    for i in 0..staged.len() {
        if staged[i].0.old_hash.is_none() {
            continue;
        }
        let name = staged[i].0.name.clone();
        let backup = format!("{TXN_PREFIX}{txn}-{name}.bak");
        let copied = std::fs::copy(home.join(&name), home.join(&backup)).and_then(|_| {
            std::fs::OpenOptions::new()
                .write(true)
                .open(home.join(&backup))?
                .sync_all()
        });
        if let Err(e) = copied {
            cleanup_partial(&staged);
            let _ = std::fs::remove_file(home.join(&backup));
            return Err(io(&format!("back up {name}"), e));
        }
        staged[i].0.backup = Some(backup);
    }
    // 4. The journal, once every backup is down.
    let journal = Journal {
        txn: txn.clone(),
        phase: Phase::Staged,
        commit_point: staged
            .last()
            .map(|(jt, _)| jt.name.clone())
            .unwrap_or_default(),
        targets: staged.iter().map(|(jt, _)| jt.clone()).collect(),
    };
    if let Err(e) = write_journal(home, &journal) {
        cleanup_partial(&staged);
        let _ = std::fs::remove_file(home.join(format!("{TXN_PREFIX}{txn}-journal.tmp")));
        return Err(io("write the commit journal", e));
    }

    // 5. Publish in order; the commit point's rename is the commit.
    for jt in &journal.targets {
        let path = home.join(&jt.name);
        #[cfg(test)]
        if tests::crashes_before(&jt.name) {
            // The process dies here: nothing after this point runs.
            return Err(TxnError::Io(format!(
                "crashed before publishing {}",
                jt.name
            )));
        }
        #[cfg(test)]
        let injected = tests::failpoint(&jt.name);
        #[cfg(not(test))]
        let injected = Ok::<(), std::io::Error>(());
        let result = injected.and_then(|()| match &jt.tmp {
            Some(tmp) => rename_over(&home.join(tmp), &path),
            None => remove_if_exists(&path),
        });
        if let Err(e) = result {
            let reason = format!("publish {}: {e}", jt.name);
            // Put everything back, then report the original failure.
            return match recover_journal(home, &journal) {
                Ok(()) => Err(TxnError::Io(reason)),
                Err(repair) => Err(repair),
            };
        }
        // Each rename is on disk before the next one, the commit point last:
        // a crash can never keep a later target and lose an earlier one.
        sync_dir(home);
    }
    let committed = Journal {
        phase: Phase::Committed,
        ..journal.clone()
    };
    if let Err(e) = write_journal(home, &committed) {
        // Committed regardless (the commit point is in place); the next lock
        // holder reads that from its hash and finishes the cleanup.
        tracing::warn!("[codex-catalog] could not mark the commit journal committed: {e}");
        return Ok(CommitReport {
            changed: journal.targets.iter().map(|t| t.name.clone()).collect(),
        });
    }
    finish(home, &committed);
    Ok(CommitReport {
        changed: committed.targets.iter().map(|t| t.name.clone()).collect(),
    })
}

/// Remove a finished transaction's leftovers, the journal last.
fn finish(home: &Path, journal: &Journal) {
    for jt in &journal.targets {
        for f in [&jt.backup, &jt.tmp].into_iter().flatten() {
            let _ = std::fs::remove_file(home.join(f));
        }
    }
    let _ = std::fs::remove_file(home.join(format!("{TXN_PREFIX}{}-journal.tmp", journal.txn)));
    let _ = std::fs::remove_file(home.join(JOURNAL_FILE));
    sync_dir(home);
}

/// Undo a staged, uncommitted transaction target by target, in publish
/// order. A target someone else changed stops it there: the ones before it
/// are back as they were, which the old commit point still references, and
/// the ones from it on wait, with the journal and every backup, for the file
/// to be put back.
fn restore(home: &Path, journal: &Journal) -> Result<(), TxnError> {
    for jt in &journal.targets {
        #[cfg(test)]
        tests::recovery_failpoint(&jt.name)?;
        let path = home.join(&jt.name);
        let current = hash_of(&path).map_err(|e| io(&format!("read {}", path.display()), e))?;
        if current == jt.old_hash {
            continue;
        }
        let backup = jt.backup.as_ref().map(|b| home.join(b));
        let replaced_or_lost =
            current == jt.new_hash || (jt.old_hash.is_some() && current.is_none());
        if !replaced_or_lost {
            return Err(TxnError::NeedsRepair {
                path,
                repair: repair_for(home, jt),
                reason: "changed by another program before the interrupted save could be undone"
                    .into(),
            });
        }
        match (&jt.old_hash, backup) {
            (None, _) => {
                remove_if_exists(&path).map_err(|e| TxnError::NeedsRepair {
                    path: path.clone(),
                    repair: Repair::Remove,
                    reason: format!("could not remove it: {e}"),
                })?;
            }
            (Some(_), Some(backup)) => {
                // Copy, then rename over: the backup itself stays until the
                // transaction is finished, so this step can be repeated.
                let tmp = home.join(format!("{TXN_PREFIX}{}-{}.restore", journal.txn, jt.name));
                let put_back = std::fs::copy(&backup, &tmp).and_then(|_| rename_over(&tmp, &path));
                if let Err(e) = put_back {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(TxnError::NeedsRepair {
                        path,
                        repair: repair_for(home, jt),
                        reason: format!("could not restore it: {e}"),
                    });
                }
            }
            (Some(_), None) => {
                return Err(TxnError::NeedsRepair {
                    path,
                    repair: Repair::Reset(home.join(JOURNAL_FILE)),
                    reason: "its backup is missing".into(),
                });
            }
        }
    }
    Ok(())
}

/// Complete a transaction whose commit point landed: every other target in
/// its new state, from its staged file when its own rename did not land.
/// A target someone else changed meanwhile stops it.
fn roll_forward(home: &Path, journal: &Journal) -> Result<(), TxnError> {
    for jt in &journal.targets {
        if jt.name == journal.commit_point {
            continue;
        }
        #[cfg(test)]
        tests::recovery_failpoint(&jt.name)?;
        let path = home.join(&jt.name);
        let current = hash_of(&path).map_err(|e| io(&format!("read {}", path.display()), e))?;
        if current == jt.new_hash {
            continue;
        }
        let stop = |reason: String| TxnError::NeedsRepair {
            path: path.clone(),
            repair: completion_repair_for(home, jt),
            reason,
        };
        if current != jt.old_hash {
            return Err(stop(
                "changed by another program before an interrupted save was completed".into(),
            ));
        }
        let done = match (&jt.new_hash, &jt.tmp) {
            (None, _) => remove_if_exists(&path),
            (Some(_), Some(tmp)) if home.join(tmp).exists() => rename_over(&home.join(tmp), &path),
            _ => Err(std::io::Error::other("its new contents are gone")),
        };
        if let Err(e) = done {
            return Err(stop(format!("could not complete an interrupted save: {e}")));
        }
        sync_dir(home);
    }
    Ok(())
}

fn recover_journal(home: &Path, journal: &Journal) -> Result<(), TxnError> {
    if journal.phase == Phase::Committed {
        finish(home, journal);
        return Ok(());
    }
    let Some(point) = journal
        .targets
        .iter()
        .find(|t| t.name == journal.commit_point)
    else {
        return Err(TxnError::NeedsRepair {
            path: home.join(JOURNAL_FILE),
            repair: Repair::Reset(home.join(JOURNAL_FILE)),
            reason: "the commit journal names no commit point".into(),
        });
    };
    let path = home.join(&point.name);
    let current = hash_of(&path).map_err(|e| io(&format!("read {}", path.display()), e))?;
    if current == point.new_hash {
        // Crashed after the commit point landed, before the journal said so.
        // Make sure every other target landed too.
        roll_forward(home, journal)?;
        finish(home, journal);
        return Ok(());
    }
    if current != point.old_hash {
        return Err(TxnError::NeedsRepair {
            path,
            repair: repair_for(home, point),
            reason: "changed by another program before an interrupted save was resolved".into(),
        });
    }
    restore(home, journal)?;
    finish(home, journal);
    Ok(())
}

/// Bring `CODEX_HOME` back to a consistent state after an interrupted
/// transaction, and sweep old leftovers. Run with both locks held, before
/// anything else is read or written.
pub fn recover(guard: &CodexHomeGuard) -> Result<(), TxnError> {
    let home = guard.home();
    let journal_path = home.join(JOURNAL_FILE);
    let journal =
        match std::fs::read(&journal_path) {
            Ok(bytes) => Some(serde_json::from_slice::<Journal>(&bytes).map_err(|e| {
                TxnError::NeedsRepair {
                    path: journal_path.clone(),
                    repair: Repair::Reset(journal_path.clone()),
                    reason: format!("unreadable commit journal: {e}"),
                }
            })?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io("read the commit journal", e)),
        };
    sweep_orphans(home, journal.as_ref().map(|j| j.txn.as_str()));
    match journal {
        Some(j) => recover_journal(home, &j),
        None => Ok(()),
    }
}

/// Delete codeg temporaries of transactions with no journal, once they are
/// old enough that no live transaction can own them. Before a journal exists
/// no live file has been touched, so these are always safe to drop.
fn sweep_orphans(home: &Path, live_txn: Option<&str>) {
    let Ok(entries) = std::fs::read_dir(home) else {
        return;
    };
    let cutoff = SystemTime::now() - ORPHAN_AGE;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(TXN_PREFIX) else {
            continue;
        };
        let txn = rest.split('-').next().unwrap_or_default();
        if live_txn == Some(txn) {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .is_some_and(|m| m < cutoff);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::lock::{acquire, LOCK_WAIT};
    use super::*;

    fn read(home: &Path, name: &str) -> Option<String> {
        std::fs::read_to_string(home.join(name)).ok()
    }

    fn leftovers(home: &Path) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(home)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(TXN_PREFIX) || n == JOURNAL_FILE)
            .collect();
        out.sort();
        out
    }

    #[tokio::test]
    async fn publishes_in_order_and_skips_what_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        std::fs::write(home.join("auth.json"), "old-auth").unwrap();
        std::fs::write(home.join("config.toml"), "same").unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        let report = commit_files(
            &guard,
            vec![
                Target::write("catalog.json", b"cat".to_vec()),
                Target::write("auth.json", b"new-auth".to_vec()),
                Target::write("config.toml", b"same".to_vec()),
                Target::delete("gone.json"),
            ],
        )
        .unwrap();
        assert_eq!(report.changed, ["catalog.json", "auth.json"]);
        assert_eq!(read(home, "catalog.json").as_deref(), Some("cat"));
        assert_eq!(read(home, "auth.json").as_deref(), Some("new-auth"));
        assert!(leftovers(home).is_empty(), "{:?}", leftovers(home));
        // Nothing changed at all: a no-op.
        let again = commit_files(
            &guard,
            vec![Target::write("auth.json", b"new-auth".to_vec())],
        )
        .unwrap();
        assert!(again.changed.is_empty());
    }

    /// Simulate a crash after the journal is written: build the on-disk state
    /// a crashed commit leaves after `published` renames, then recover.
    fn crash_after(home: &Path, published: usize) -> Journal {
        std::fs::write(home.join("auth.json"), "old-auth").unwrap();
        std::fs::write(home.join("config.toml"), "old-config").unwrap();
        let txn = "abc123".to_string();
        let mut targets = Vec::new();
        for (name, old, new) in [
            ("catalog.json", None, "new-cat"),
            ("auth.json", Some("old-auth"), "new-auth"),
            ("config.toml", Some("old-config"), "new-config"),
        ] {
            let tmp = format!("{TXN_PREFIX}{txn}-{name}.tmp");
            std::fs::write(home.join(&tmp), new).unwrap();
            let backup = old.map(|o| {
                let b = format!("{TXN_PREFIX}{txn}-{name}.bak");
                std::fs::write(home.join(&b), o).unwrap();
                b
            });
            targets.push(JournalTarget {
                name: name.into(),
                backup,
                tmp: Some(tmp),
                old_hash: old.map(|o| sha256_hex(o.as_bytes())),
                new_hash: Some(sha256_hex(new.as_bytes())),
            });
        }
        let journal = Journal {
            txn,
            phase: Phase::Staged,
            commit_point: "config.toml".into(),
            targets,
        };
        write_journal(home, &journal).unwrap();
        for jt in journal.targets.iter().take(published) {
            std::fs::rename(home.join(jt.tmp.as_ref().unwrap()), home.join(&jt.name)).unwrap();
        }
        journal
    }

    #[tokio::test]
    async fn a_crash_before_the_commit_point_restores_everything() {
        for published in 0..3 {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path();
            crash_after(home, published);
            let guard = acquire(home, LOCK_WAIT).await.unwrap();
            recover(&guard).unwrap();
            // The already-renamed auth.json is back too: endpoint and key
            // never end up one new, one old.
            assert_eq!(
                read(home, "auth.json").as_deref(),
                Some("old-auth"),
                "{published}"
            );
            assert_eq!(read(home, "config.toml").as_deref(), Some("old-config"));
            assert!(read(home, "catalog.json").is_none());
            assert!(leftovers(home).is_empty(), "{:?}", leftovers(home));
            // And running recovery again is harmless.
            recover(&guard).unwrap();
        }
    }

    #[tokio::test]
    async fn a_crash_after_the_commit_point_finishes_instead() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        crash_after(home, 3);
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        recover(&guard).unwrap();
        assert_eq!(read(home, "config.toml").as_deref(), Some("new-config"));
        assert_eq!(read(home, "auth.json").as_deref(), Some("new-auth"));
        assert_eq!(read(home, "catalog.json").as_deref(), Some("new-cat"));
        assert!(leftovers(home).is_empty());
    }

    #[tokio::test]
    async fn a_file_changed_by_someone_else_stops_recovery_and_keeps_the_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        crash_after(home, 2);
        // Another program rewrites auth.json before we recover.
        std::fs::write(home.join("auth.json"), "edited-by-hand").unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        let err = recover(&guard).unwrap_err();
        assert!(
            matches!(err, TxnError::NeedsRepair { ref path, .. } if path.ends_with("auth.json"))
        );
        // Nothing guessed: the edit, the journal and the backups all stay.
        assert_eq!(read(home, "auth.json").as_deref(), Some("edited-by-hand"));
        assert!(home.join(JOURNAL_FILE).exists());
        // A commit point changed by someone else is the same refusal.
        let dir2 = tempfile::tempdir().unwrap();
        crash_after(dir2.path(), 0);
        std::fs::write(dir2.path().join("config.toml"), "hand").unwrap();
        let guard2 = acquire(dir2.path(), LOCK_WAIT).await.unwrap();
        assert!(matches!(
            recover(&guard2),
            Err(TxnError::NeedsRepair { .. })
        ));
    }

    /// Without the directory synced between renames, a crash could keep the
    /// commit point and lose an earlier rename. Recovery completes it.
    #[tokio::test]
    async fn a_commit_point_that_landed_alone_is_completed() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let journal = crash_after(home, 0);
        let catalog = &journal.targets[0];
        let config = &journal.targets[2];
        for jt in [catalog, config] {
            std::fs::rename(home.join(jt.tmp.as_ref().unwrap()), home.join(&jt.name)).unwrap();
        }
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        recover(&guard).unwrap();
        assert_eq!(read(home, "catalog.json").as_deref(), Some("new-cat"));
        assert_eq!(read(home, "auth.json").as_deref(), Some("new-auth"));
        assert_eq!(read(home, "config.toml").as_deref(), Some("new-config"));
        assert!(leftovers(home).is_empty(), "{:?}", leftovers(home));
    }

    #[tokio::test]
    async fn completing_stops_at_a_target_someone_else_changed() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let journal = crash_after(home, 0);
        let config = &journal.targets[2];
        std::fs::rename(
            home.join(config.tmp.as_ref().unwrap()),
            home.join("config.toml"),
        )
        .unwrap();
        std::fs::write(home.join("auth.json"), "edited by hand").unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        match recover(&guard) {
            Err(TxnError::NeedsRepair { path, .. }) => assert_eq!(path, home.join("auth.json")),
            other => panic!("{other:?}"),
        }
        assert_eq!(read(home, "auth.json").as_deref(), Some("edited by hand"));
        assert!(home.join(JOURNAL_FILE).exists(), "the evidence stays");
    }

    #[tokio::test]
    async fn a_committed_journal_only_needs_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut journal = crash_after(home, 3);
        journal.phase = Phase::Committed;
        write_journal(home, &journal).unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        recover(&guard).unwrap();
        assert_eq!(read(home, "config.toml").as_deref(), Some("new-config"));
        assert!(leftovers(home).is_empty());
    }

    #[tokio::test]
    async fn orphans_go_only_once_they_are_old() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let fresh = home.join(format!("{TXN_PREFIX}fresh1-config.toml.tmp"));
        let old = home.join(format!("{TXN_PREFIX}old111-config.toml.bak"));
        std::fs::write(&fresh, "x").unwrap();
        std::fs::write(&old, "x").unwrap();
        let past = SystemTime::now() - Duration::from_secs(11 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(past)
            .unwrap();
        std::fs::write(home.join("config.toml"), "live").unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        recover(&guard).unwrap();
        assert!(fresh.exists());
        assert!(!old.exists());
        assert_eq!(read(home, "config.toml").as_deref(), Some("live"));
    }

    thread_local! {
        static FAIL_PUBLISH_OF: std::cell::RefCell<Option<String>> =
            const { std::cell::RefCell::new(None) };
        static CRASH_BEFORE: std::cell::RefCell<Option<String>> =
            const { std::cell::RefCell::new(None) };
        static FAIL_RECOVERY_AT: std::cell::RefCell<Option<String>> =
            const { std::cell::RefCell::new(None) };
    }

    /// Make every commit on this thread die just before it publishes `name`
    /// (`None`: never again), leaving its journal, backups and staged files
    /// as a crash would.
    pub(crate) fn crash_before(name: Option<&str>) {
        CRASH_BEFORE.with(|c| *c.borrow_mut() = name.map(str::to_string));
    }

    pub(super) fn crashes_before(name: &str) -> bool {
        CRASH_BEFORE.with(|c| c.borrow().as_deref() == Some(name))
    }

    /// Cut recovery short just before it reaches `name`, as a crash would.
    fn fail_recovery_at(name: Option<&str>) {
        FAIL_RECOVERY_AT.with(|f| *f.borrow_mut() = name.map(str::to_string));
    }

    pub(super) fn recovery_failpoint(name: &str) -> Result<(), TxnError> {
        FAIL_RECOVERY_AT.with(|f| {
            if f.borrow().as_deref() == Some(name) {
                Err(TxnError::Io(format!("recovery cut short before {name}")))
            } else {
                Ok(())
            }
        })
    }

    /// Fail the publish step of the named target, as a rename that did not
    /// happen.
    pub(super) fn failpoint(name: &str) -> std::io::Result<()> {
        FAIL_PUBLISH_OF.with(|f| {
            if f.borrow().as_deref() == Some(name) {
                Err(std::io::Error::other("injected failure"))
            } else {
                Ok(())
            }
        })
    }

    #[tokio::test]
    async fn a_failed_publish_rolls_back_what_was_already_published() {
        for failing in ["catalog.json", "auth.json", "config.toml"] {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path();
            std::fs::write(home.join("auth.json"), "old-auth").unwrap();
            std::fs::write(home.join("config.toml"), "old-config").unwrap();
            let guard = acquire(home, LOCK_WAIT).await.unwrap();
            FAIL_PUBLISH_OF.with(|f| *f.borrow_mut() = Some(failing.to_string()));
            let err = commit_files(
                &guard,
                vec![
                    Target::write("catalog.json", b"cat".to_vec()),
                    Target::write("auth.json", b"new-auth".to_vec()),
                    Target::write("config.toml", b"new-config".to_vec()),
                ],
            );
            FAIL_PUBLISH_OF.with(|f| *f.borrow_mut() = None);
            assert!(matches!(err, Err(TxnError::Io(_))), "{failing}: {err:?}");
            // Including the commit point itself, and the auth.json already
            // renamed before it: everything is as it was.
            assert_eq!(
                read(home, "auth.json").as_deref(),
                Some("old-auth"),
                "{failing}"
            );
            assert_eq!(
                read(home, "config.toml").as_deref(),
                Some("old-config"),
                "{failing}"
            );
            assert!(read(home, "catalog.json").is_none(), "{failing}");
            assert!(
                leftovers(home).is_empty(),
                "{failing}: {:?}",
                leftovers(home)
            );
        }
    }

    /// Recovery stopped before any target — a second crash, in either
    /// direction — leaves what a later lock holder finishes: backups stay
    /// until the end, so every step can run again.
    #[tokio::test]
    async fn recovery_cut_short_anywhere_finishes_on_the_next_try() {
        // Undo: crashed with two of three renames done.
        for stop in ["catalog.json", "auth.json", "config.toml"] {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path();
            crash_after(home, 2);
            let guard = acquire(home, LOCK_WAIT).await.unwrap();
            fail_recovery_at(Some(stop));
            assert!(recover(&guard).is_err(), "{stop}");
            fail_recovery_at(None);
            recover(&guard).unwrap();
            assert_eq!(
                read(home, "auth.json").as_deref(),
                Some("old-auth"),
                "{stop}"
            );
            assert_eq!(read(home, "config.toml").as_deref(), Some("old-config"));
            assert!(read(home, "catalog.json").is_none(), "{stop}");
            assert!(leftovers(home).is_empty(), "{stop}: {:?}", leftovers(home));
        }
        // Complete: the commit point landed alone.
        for stop in ["catalog.json", "auth.json"] {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path();
            let journal = crash_after(home, 0);
            let config = &journal.targets[2];
            std::fs::rename(
                home.join(config.tmp.as_ref().unwrap()),
                home.join("config.toml"),
            )
            .unwrap();
            let guard = acquire(home, LOCK_WAIT).await.unwrap();
            fail_recovery_at(Some(stop));
            assert!(recover(&guard).is_err(), "{stop}");
            fail_recovery_at(None);
            recover(&guard).unwrap();
            assert_eq!(
                read(home, "catalog.json").as_deref(),
                Some("new-cat"),
                "{stop}"
            );
            assert_eq!(
                read(home, "auth.json").as_deref(),
                Some("new-auth"),
                "{stop}"
            );
            assert_eq!(read(home, "config.toml").as_deref(), Some("new-config"));
            assert!(leftovers(home).is_empty(), "{stop}: {:?}", leftovers(home));
        }
    }

    /// A crash halfway through putting one file back leaves its restore
    /// copy behind; the next recovery copies the backup again and goes on.
    #[tokio::test]
    async fn a_crash_inside_one_restore_is_redone() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let journal = crash_after(home, 2);
        let half = home.join(format!("{TXN_PREFIX}{}-auth.json.restore", journal.txn));
        std::fs::write(&half, "old-a").unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        recover(&guard).unwrap();
        assert_eq!(read(home, "auth.json").as_deref(), Some("old-auth"));
        assert!(read(home, "catalog.json").is_none());
        assert!(leftovers(home).is_empty(), "{:?}", leftovers(home));
    }

    /// Died while cleaning up after an undo: the files are already back,
    /// some backups gone. The next lock holder only finishes the cleanup.
    #[tokio::test]
    async fn a_crash_while_cleaning_up_is_finished_by_the_next_holder() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let journal = crash_after(home, 2);
        std::fs::remove_file(home.join("catalog.json")).unwrap();
        std::fs::copy(
            home.join(journal.targets[1].backup.as_ref().unwrap()),
            home.join("auth.json"),
        )
        .unwrap();
        std::fs::remove_file(home.join(journal.targets[1].backup.as_ref().unwrap())).unwrap();
        std::fs::remove_file(home.join(journal.targets[2].tmp.as_ref().unwrap())).unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        recover(&guard).unwrap();
        assert_eq!(read(home, "auth.json").as_deref(), Some("old-auth"));
        assert_eq!(read(home, "config.toml").as_deref(), Some("old-config"));
        assert!(leftovers(home).is_empty(), "{:?}", leftovers(home));
    }

    /// The undo goes in publish order and stops at the file someone else
    /// changed: what came before it is put back (the old commit point
    /// references it), the changed file and everything after it wait. Once
    /// the file is put back from its backup, recovery runs to the end.
    #[tokio::test]
    async fn an_undo_stops_at_a_changed_file_and_resumes_once_it_is_put_back() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let journal = crash_after(home, 2);
        std::fs::write(home.join("auth.json"), "edited-by-hand").unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        let backup = match recover(&guard) {
            Err(TxnError::NeedsRepair {
                path,
                repair: Repair::CopyBack(backup),
                ..
            }) => {
                assert_eq!(path, home.join("auth.json"));
                backup
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(
            backup,
            home.join(journal.targets[1].backup.as_ref().unwrap())
        );
        // Before it: back as it was (the catalog did not exist).
        assert!(read(home, "catalog.json").is_none());
        // It and after it: untouched, the evidence kept.
        assert_eq!(read(home, "auth.json").as_deref(), Some("edited-by-hand"));
        assert_eq!(read(home, "config.toml").as_deref(), Some("old-config"));
        assert!(home.join(JOURNAL_FILE).exists());
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "old-auth");
        // Still refused while nothing changed.
        assert!(matches!(recover(&guard), Err(TxnError::NeedsRepair { .. })));

        std::fs::copy(&backup, home.join("auth.json")).unwrap();
        recover(&guard).unwrap();
        assert_eq!(read(home, "auth.json").as_deref(), Some("old-auth"));
        assert_eq!(read(home, "config.toml").as_deref(), Some("old-config"));
        assert!(leftovers(home).is_empty(), "{:?}", leftovers(home));
    }

    /// An interrupted save is resolved only under the lock: while another
    /// process holds it, nothing here touches the half-done save; once it
    /// lets go, the next lock holder undoes it.
    #[tokio::test]
    async fn an_interrupted_save_waits_while_another_process_holds_the_lock() {
        use super::super::lock::tests::{
            as_other_process, hold_the_lock_until_released, passed, spawn_other_process,
            wait_for_mark,
        };
        if let Some(other) = as_other_process() {
            hold_the_lock_until_released(&other).await;
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (home, marks) = (dir.path().join("home"), dir.path().join("marks"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&marks).unwrap();
        crash_after(&home, 2);
        let mut other = spawn_other_process(
            module_path!(),
            "an_interrupted_save_waits_while_another_process_holds_the_lock",
            "hold",
            &home,
            &marks,
        );
        wait_for_mark(&marks, "held", Some(&mut other));
        let busy = acquire(&home, Duration::from_millis(300)).await;
        assert!(busy.is_err());
        assert_eq!(read(&home, "catalog.json").as_deref(), Some("new-cat"));
        assert_eq!(read(&home, "auth.json").as_deref(), Some("new-auth"));
        assert!(home.join(JOURNAL_FILE).exists());

        std::fs::write(marks.join("release"), "").unwrap();
        passed(other);
        drop(super::super::lock_home(&home).await.unwrap());
        assert_eq!(read(&home, "auth.json").as_deref(), Some("old-auth"));
        assert_eq!(read(&home, "config.toml").as_deref(), Some("old-config"));
        assert!(read(&home, "catalog.json").is_none());
        assert!(leftovers(&home).is_empty(), "{:?}", leftovers(&home));
    }

    /// A file the save was creating that someone else then changed: removing
    /// it is the way on, and the error says so.
    #[tokio::test]
    async fn a_changed_file_the_save_was_creating_is_removed_to_go_on() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        crash_after(home, 1);
        std::fs::write(home.join("catalog.json"), "someone else's").unwrap();
        let guard = acquire(home, LOCK_WAIT).await.unwrap();
        match recover(&guard) {
            Err(TxnError::NeedsRepair {
                path,
                repair: Repair::Remove,
                ..
            }) => assert_eq!(path, home.join("catalog.json")),
            other => panic!("{other:?}"),
        }
        std::fs::remove_file(home.join("catalog.json")).unwrap();
        recover(&guard).unwrap();
        assert_eq!(read(home, "auth.json").as_deref(), Some("old-auth"));
        assert_eq!(read(home, "config.toml").as_deref(), Some("old-config"));
        assert!(leftovers(home).is_empty(), "{:?}", leftovers(home));
    }

    /// When neither a backup nor a removal can get recovery going — the
    /// journal unreadable, a backup or a staged file gone — the error asks
    /// for the journal to go; once it has, commits run again.
    #[tokio::test]
    async fn a_damaged_journal_or_lost_files_ask_for_the_journal_to_go() {
        let reset = |r: Result<(), TxnError>, home: &Path| match r {
            Err(TxnError::NeedsRepair {
                repair: Repair::Reset(journal),
                ..
            }) => assert_eq!(journal, home.join(JOURNAL_FILE)),
            other => panic!("{other:?}"),
        };
        // An unreadable journal.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(JOURNAL_FILE), "{not json").unwrap();
        let guard = acquire(dir.path(), LOCK_WAIT).await.unwrap();
        reset(recover(&guard), dir.path());
        std::fs::remove_file(dir.path().join(JOURNAL_FILE)).unwrap();
        recover(&guard).unwrap();
        drop(guard);

        // An undo whose backup is gone.
        let dir = tempfile::tempdir().unwrap();
        let journal = crash_after(dir.path(), 2);
        std::fs::remove_file(dir.path().join(journal.targets[1].backup.as_ref().unwrap())).unwrap();
        let guard = acquire(dir.path(), LOCK_WAIT).await.unwrap();
        reset(recover(&guard), dir.path());
        drop(guard);

        // A completion whose staged file is gone.
        let dir = tempfile::tempdir().unwrap();
        let journal = crash_after(dir.path(), 0);
        let (catalog, config) = (&journal.targets[0], &journal.targets[2]);
        std::fs::rename(
            dir.path().join(config.tmp.as_ref().unwrap()),
            dir.path().join("config.toml"),
        )
        .unwrap();
        std::fs::remove_file(dir.path().join(catalog.tmp.as_ref().unwrap())).unwrap();
        let guard = acquire(dir.path(), LOCK_WAIT).await.unwrap();
        reset(recover(&guard), dir.path());
    }
}
