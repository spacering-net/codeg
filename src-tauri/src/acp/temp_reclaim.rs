//! One-time reclamation of temp artifacts leaked BEFORE per-launch isolation.
//!
//! [`crate::acp::scratch_dir`] stops the bleeding; this hands back what already
//! leaked. One reporter had 113 orphaned `%TEMP%\_MEI*` directories totalling
//! 107.70 GB, which nothing in codeg would otherwise ever come back for —
//! those directories are in the SYSTEM temp dir, not in codeg's own subtree.
//!
//! # Why this is user-triggered and not a startup sweep
//!
//! `%TEMP%\_MEI*` is the namespace of every PyInstaller application on the
//! machine, not codeg's. codeg cannot tell its own leaked directory from one
//! belonging to some other app, so it does not get to delete them unasked. The
//! flow is scan → show what was found → the user confirms.
//!
//! # Why the obvious idleness test is wrong
//!
//! The natural predicate — "rename it; if the rename succeeds nothing has it
//! open" — is FALSE on Windows, and this repository is where to learn that:
//! `binary_cache::clear_agent_cache` deliberately relies on the opposite,
//! because "NTFS allows renaming a directory whose children are locked …  the
//! locked file's FILE_OBJECT keeps working under the new path". A rename-based
//! probe therefore succeeds against a LIVE directory, and the recursive delete
//! that follows would partially dismantle a running third-party application.
//!
//! What is used instead is non-mutating: open the mapped payload files with
//! `dwShareMode = 0` and see whether the OS refuses. A loaded DLL cannot be
//! opened that way, and the probe changes nothing when it fails.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

/// Skip anything touched this recently. A directory being written right now is
/// a launch in progress, whatever the handle probe says, and this is also the
/// backstop for the probe→delete window (a process that starts in between).
const MIN_AGE: Duration = Duration::from_secs(15 * 60);

/// Cap on how many entries a scan reports. Purely to bound the payload and the
/// dialog; a machine with more than this has bigger problems and can run the
/// reclaim twice.
const MAX_ENTRIES: usize = 500;

/// One reclaimable artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeakedTempEntry {
    pub path: String,
    /// Bytes on disk. Directories are summed recursively.
    pub bytes: u64,
    /// Whole hours since last modification, for the "is this really stale?"
    /// question the user is about to answer.
    pub age_hours: u64,
    /// A directory (a PyInstaller unpack root) rather than a single file.
    pub is_dir: bool,
}

/// What a scan found.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeakedTempScan {
    /// The system temp directory that was scanned, so the UI can name it.
    pub root: String,
    pub entries: Vec<LeakedTempEntry>,
    pub total_bytes: u64,
    /// Matched the leak shape but is still in use, or too recent. Reported as
    /// a count so the user is not told "0 found" when the real answer is
    /// "found some, left them alone".
    pub skipped: usize,
}

/// What a reclaim actually did.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeakedTempReclaim {
    pub removed: usize,
    pub freed_bytes: u64,
    pub failed: Vec<String>,
}

/// PyInstaller's onefile unpack root. Windows only — see [`is_reclaimable`].
fn is_pyinstaller_unpack_dir(name: &str) -> bool {
    name.starts_with("_MEI") && name.len() > 4
}

/// The read-only resource files the non-PyInstaller (macOS/Linux) Antigravity
/// build drops per launch: `cacert__py_binary_resource_agy_acp_server__*.pem`
/// and its `cacerts__…txt` sibling. ~172 KB a launch — small, but it never
/// stops growing either.
fn is_py_binary_resource(name: &str) -> bool {
    name.contains("__py_binary_resource_")
}

/// Whether an entry is one codeg is willing to delete.
///
/// The platform split is deliberate rather than incidental. On Windows the
/// handle probe below is a real answer, so a whole unpack directory can be
/// reclaimed safely. On Unix there is no mandatory locking and therefore no
/// cheap way to prove a directory is idle — and deleting a live PyInstaller
/// tree there could strip a shared object the process has not dlopen'd yet. So
/// Unix reclaims only the per-launch resource FILES, which are read once during
/// startup and never reopened.
fn is_reclaimable(name: &str, is_dir: bool) -> bool {
    if is_dir {
        cfg!(windows) && is_pyinstaller_unpack_dir(name)
    } else {
        is_py_binary_resource(name)
    }
}

/// Non-mutating "is anything using this?" probe.
///
/// Opens the files that would be MAPPED by a running process — DLLs, Python
/// extension modules, the frozen stdlib archive — with sharing denied. A loaded
/// image refuses that open, and nothing about the directory is modified either
/// way. Deliberately not exhaustive: a handful of mapped images is enough to
/// distinguish "live" from "orphan", and walking a 1.17 GB tree file by file
/// would make the scan itself the problem.
#[cfg(windows)]
fn is_idle(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;

    fn probe_dir(dir: &Path, depth: usize) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            // Cannot even enumerate it: not something to start deleting.
            return false;
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => return false,
            };
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if file_type.is_dir() {
                // One level down covers PyInstaller's `_internal/`, which is
                // where a contents-directory build puts every DLL.
                if depth == 0 && !probe_dir(&entry.path(), depth + 1) {
                    return false;
                }
                continue;
            }
            let mapped = name.ends_with(".dll")
                || name.ends_with(".pyd")
                || name.ends_with(".exe")
                || name == "base_library.zip";
            if !mapped {
                continue;
            }
            // dwShareMode = 0: fails outright if anyone holds the image open.
            if std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(entry.path())
                .is_err()
            {
                return false;
            }
        }
        true
    }

    if path.is_dir() {
        probe_dir(path, 0)
    } else {
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .is_ok()
    }
}

/// On Unix only single files are ever reclaimed (see [`is_reclaimable`]), and
/// unlinking one is safe even while a process reads it: the inode survives
/// until the last descriptor closes. The age guard carries the rest.
#[cfg(not(windows))]
fn is_idle(_path: &Path) -> bool {
    true
}

fn age(meta: &std::fs::Metadata) -> Option<Duration> {
    SystemTime::now().duration_since(meta.modified().ok()?).ok()
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Find reclaimable leftovers directly under the system temp directory.
///
/// Read-only: nothing is renamed, moved or deleted.
pub fn scan() -> LeakedTempScan {
    let root = std::env::temp_dir();
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    let mut skipped = 0usize;

    let Ok(dir) = std::fs::read_dir(&root) else {
        return LeakedTempScan {
            root: root.to_string_lossy().into_owned(),
            entries,
            total_bytes,
            skipped,
        };
    };

    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // Never follow a symlink out of the temp dir.
        if file_type.is_symlink() {
            continue;
        }
        let is_dir = file_type.is_dir();
        if !is_reclaimable(&name, is_dir) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Some(age) = age(&meta) else {
            skipped += 1;
            continue;
        };
        if age < MIN_AGE || !is_idle(&path) {
            skipped += 1;
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            skipped += 1;
            continue;
        }
        let bytes = if is_dir { dir_size(&path) } else { meta.len() };
        total_bytes += bytes;
        entries.push(LeakedTempEntry {
            path: path.to_string_lossy().into_owned(),
            bytes,
            age_hours: age.as_secs() / 3600,
            is_dir,
        });
    }

    entries.sort_by_key(|e| std::cmp::Reverse(e.bytes));
    LeakedTempScan {
        root: root.to_string_lossy().into_owned(),
        entries,
        total_bytes,
        skipped,
    }
}

/// Delete the given paths, re-validating every one.
///
/// The incoming list is NOT trusted: it arrives from the frontend, and the
/// whole point of the checks is that they run immediately before the delete.
/// Every path is re-confirmed to sit directly under the system temp directory,
/// to match a known leak shape, to be old enough, and to be idle. A path that
/// fails any of them is skipped, not reported as an error — between the scan
/// and the confirm, an app may legitimately have started using it again.
pub fn reclaim(paths: Vec<String>) -> LeakedTempReclaim {
    let root = std::env::temp_dir();
    let mut removed = 0usize;
    let mut freed_bytes = 0u64;
    let mut failed = Vec::new();

    for raw in paths {
        let path = PathBuf::from(&raw);
        // Directly under the temp root, and nowhere else. `parent()` rather
        // than `starts_with` so `%TEMP%\_MEI1\..\..\Windows` cannot qualify.
        if path.parent() != Some(root.as_path()) {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let is_dir = meta.is_dir();
        if !is_reclaimable(&name, is_dir) {
            continue;
        }
        match age(&meta) {
            Some(age) if age >= MIN_AGE => {}
            _ => continue,
        }
        if !is_idle(&path) {
            continue;
        }

        let bytes = if is_dir { dir_size(&path) } else { meta.len() };
        let result = if is_dir {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match result {
            Ok(()) => {
                removed += 1;
                freed_bytes += bytes;
            }
            Err(e) => failed.push(format!("{}: {e}", path.display())),
        }
    }

    LeakedTempReclaim {
        removed,
        freed_bytes,
        failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_pyinstaller_unpack_shape() {
        assert!(is_pyinstaller_unpack_dir("_MEI123456"));
        assert!(!is_pyinstaller_unpack_dir("_MEI"));
        assert!(!is_pyinstaller_unpack_dir("MEI123456"));
        assert!(!is_pyinstaller_unpack_dir("something-else"));
    }

    #[test]
    fn recognizes_the_par_resource_shape() {
        assert!(is_py_binary_resource(
            "cacert__py_binary_resource_agy_acp_server__2s9t93zo.pem"
        ));
        assert!(is_py_binary_resource(
            "cacerts__py_binary_resource_agy_acp_server__61adb6fn.txt"
        ));
        assert!(!is_py_binary_resource("cacert.pem"));
    }

    /// Unpack DIRECTORIES are Windows-only, because that is the only platform
    /// where `is_idle` can actually prove a directory is not in use.
    #[test]
    fn directory_reclaim_is_windows_only() {
        assert_eq!(is_reclaimable("_MEI123456", true), cfg!(windows));
        // Files are fair game everywhere.
        assert!(is_reclaimable(
            "cacert__py_binary_resource_agy_acp_server__x.pem",
            false
        ));
    }

    #[test]
    fn unrelated_temp_entries_are_never_reclaimable() {
        for (name, is_dir) in [
            ("com.apple.launchd.abc", true),
            ("tmp1234", true),
            ("important.txt", false),
            ("_MEI", true),
            ("", false),
        ] {
            assert!(
                !is_reclaimable(name, is_dir),
                "{name} (dir={is_dir}) must not be reclaimable"
            );
        }
    }

    /// A path outside the system temp root is refused even when its NAME
    /// matches — the traversal guard, which matters because the path list
    /// arrives from the frontend.
    #[test]
    fn reclaim_refuses_paths_outside_the_temp_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let victim = dir.path().join("cacert__py_binary_resource_x.pem");
        std::fs::write(&victim, b"precious").expect("write");

        let report = reclaim(vec![victim.to_string_lossy().into_owned()]);
        assert_eq!(report.removed, 0);
        assert!(report.failed.is_empty());
        assert!(victim.exists(), "a file outside the temp root must survive");
    }

    /// A freshly created artifact is inside the age guard, so even a
    /// correctly-shaped name in the right place is left alone.
    ///
    /// The in-root assertion matters: without it this test would still pass if
    /// the path check rejected the file, and would prove nothing about the age
    /// guard it is named after.
    #[test]
    fn reclaim_respects_the_age_guard() {
        let root = std::env::temp_dir();
        let victim = root.join(format!(
            "cacert__py_binary_resource_test__{}.pem",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&victim, b"x").expect("write");
        assert_eq!(
            victim.parent(),
            Some(root.as_path()),
            "the fixture must be inside the temp root, or this tests the wrong guard"
        );
        assert!(is_reclaimable(
            &victim.file_name().unwrap().to_string_lossy(),
            false
        ));

        let report = reclaim(vec![victim.to_string_lossy().into_owned()]);
        assert_eq!(report.removed, 0);
        assert!(victim.exists(), "a just-written file must survive the scan");
        let _ = std::fs::remove_file(&victim);
    }

    /// The accept path: right shape, right place, old enough. Backdating the
    /// mtime is what makes this testable without a 15-minute wait.
    #[test]
    fn reclaim_deletes_an_aged_resource_file() {
        let root = std::env::temp_dir();
        let victim = root.join(format!(
            "cacerts__py_binary_resource_test__{}.txt",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&victim, b"payload").expect("write");
        let file = std::fs::File::options()
            .write(true)
            .open(&victim)
            .expect("open");
        let past = SystemTime::now() - Duration::from_secs(60 * 60);
        file.set_times(std::fs::FileTimes::new().set_accessed(past).set_modified(past))
            .expect("backdate");
        drop(file);

        let report = reclaim(vec![victim.to_string_lossy().into_owned()]);
        assert_eq!(report.removed, 1, "failed: {:?}", report.failed);
        assert_eq!(report.freed_bytes, b"payload".len() as u64);
        assert!(!victim.exists());
    }

    /// Being old enough is not sufficient — the NAME still has to match a known
    /// leak shape, or an unrelated stale temp file would be fair game.
    #[test]
    fn reclaim_ignores_an_aged_file_with_an_unrelated_name() {
        let root = std::env::temp_dir();
        let bystander = root.join(format!("unrelated-{}.txt", uuid::Uuid::new_v4().simple()));
        std::fs::write(&bystander, b"someone else's").expect("write");
        let file = std::fs::File::options()
            .write(true)
            .open(&bystander)
            .expect("open");
        let past = SystemTime::now() - Duration::from_secs(60 * 60);
        file.set_times(std::fs::FileTimes::new().set_accessed(past).set_modified(past))
            .expect("backdate");
        drop(file);

        let report = reclaim(vec![bystander.to_string_lossy().into_owned()]);
        assert_eq!(report.removed, 0);
        assert!(bystander.exists(), "an unrelated temp file must survive");
        let _ = std::fs::remove_file(&bystander);
    }

    #[test]
    fn scan_never_reports_a_negative_total() {
        let result = scan();
        assert_eq!(
            result.total_bytes,
            result.entries.iter().map(|e| e.bytes).sum::<u64>()
        );
    }
}
