//! `<data dir>/cache/harness/updates.json`: the last answers the update check
//! got, and how its last try went.
//!
//! A cache like the rest of `cache/harness/` — not in Codeg's backup (see
//! `cache.rs`), refetchable, never a reason for a command to fail: a file
//! that is missing, damaged or of another format reads as "never checked".
//! Written whole, through a temp file renamed over it.
//!
//! The desktop app and a `codeg-server` may share a data directory (both
//! hold it shared, `runtime_lock`), so two checks can overlap. What a check
//! came to is therefore [`record`]ed, not written: under a file lock beside
//! the cache, the file is read again and the outcome merged into it — the
//! answers of the latest check that got any, the attempt details of the
//! latest try — so a check that finished later never loses to one that
//! finished earlier, and a failure never takes back another's answers.
//!
//! ```json
//! { "format": 1,
//!   "checked_at": "2026-11-17T09:30:00.000Z",
//!   "attempted_at": "2026-11-17T09:30:00.000Z",
//!   "failures": 0,
//!   "error": null,
//!   "answers": [
//!     { "id": "0199…", "revision": 3, "status": "public", "version_status": "ok",
//!       "latest": { "revision": 5, "version": "1.2.0" }, "ref": "acme/notes" } ] }
//! ```

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::model::{Answer, CheckError};

/// The file's name in the Harness cache directory.
pub(crate) const FILE_NAME: &str = "updates.json";
/// The lock beside it: held while the file is read and written back.
pub(crate) const LOCK_NAME: &str = "updates.lock";

const FORMAT: u32 = 1;

/// How long a write waits for another Codeg's. Its read-merge-write takes
/// milliseconds.
#[cfg(not(test))]
const LOCK_WAIT: Duration = Duration::from_secs(2);
#[cfg(test)]
const LOCK_WAIT: Duration = Duration::from_millis(200);
const LOCK_RETRY: Duration = Duration::from_millis(20);

/// A date this far ahead of the clock was not written by this clock.
const CLOCK_SLACK: chrono::Duration = chrono::Duration::minutes(1);

pub(crate) fn path_in(data_dir: &Path) -> PathBuf {
    crate::harness::cache_dir(data_dir).join(FILE_NAME)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Kept {
    #[serde(default)]
    pub format: u32,
    /// When `answers` were asked.
    #[serde(default)]
    pub checked_at: Option<DateTime<Utc>>,
    /// When a check was last tried.
    #[serde(default)]
    pub attempted_at: Option<DateTime<Utc>>,
    /// Tries in a row that got no answer.
    #[serde(default)]
    pub failures: u32,
    /// Why the last try got no answer.
    #[serde(default)]
    pub error: Option<CheckError>,
    #[serde(default)]
    pub answers: Vec<Answer>,
}

/// What one check, asked at some moment, came to.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Outcome {
    /// `/resolve` answered: one answer per installed pair asked.
    Answered(Vec<Answer>),
    /// It did not.
    Failed(CheckError),
}

/// What is kept; nothing (never checked) when there is no file, or one this
/// Codeg cannot read.
pub(crate) fn load(path: &Path) -> Kept {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Kept::default(),
        Err(error) => {
            tracing::debug!("[harness] {} not read: {error}", path.display());
            return Kept::default();
        }
    };
    match serde_json::from_slice::<Kept>(&bytes) {
        Ok(kept) if kept.format == FORMAT => kept,
        Ok(kept) => {
            tracing::debug!(
                "[harness] {} is of format {}: read as never checked",
                path.display(),
                kept.format
            );
            Kept::default()
        }
        Err(error) => {
            tracing::debug!("[harness] {} not read: {error}", path.display());
            Kept::default()
        }
    }
}

fn save(path: &Path, kept: &Kept) {
    let mut kept = kept.clone();
    kept.format = FORMAT;
    match serde_json::to_vec_pretty(&kept) {
        Ok(mut bytes) => {
            bytes.push(b'\n');
            if let Err(error) = crate::commands::mcp_engine::fsio::write_atomic(path, &bytes) {
                tracing::warn!("[harness] update check result not kept: {error}");
            }
        }
        Err(error) => tracing::warn!("[harness] update check result not kept: {error}"),
    }
}

/// Whether `theirs` is a later moment than `ours` — and not one ahead of the
/// clock (a clock set back, a file from elsewhere), which is no later moment.
fn later(theirs: Option<DateTime<Utc>>, ours: DateTime<Utc>) -> bool {
    theirs.is_some_and(|theirs| theirs > ours && theirs <= Utc::now() + CLOCK_SLACK)
}

/// `there` (the file as it is now) with the outcome of a check asked `at`
/// merged in: its answers if none later were kept, its attempt details if
/// no later try was. A failure keeps the answers there are.
pub(crate) fn merge(there: Kept, at: DateTime<Utc>, outcome: Outcome) -> Kept {
    let their_try_is_later = later(there.attempted_at, at);
    let their_answers_are_later = later(there.checked_at, at);
    let mut merged = there;
    merged.format = FORMAT;
    match outcome {
        Outcome::Answered(answers) => {
            if !their_answers_are_later {
                merged.checked_at = Some(at);
                merged.answers = answers;
            }
            if !their_try_is_later {
                merged.attempted_at = Some(at);
                merged.failures = 0;
                merged.error = None;
            }
        }
        Outcome::Failed(error) => {
            if !their_try_is_later {
                merged.attempted_at = Some(at);
                merged.failures = merged.failures.saturating_add(1);
                merged.error = Some(error);
            }
        }
    }
    merged
}

/// The lock beside the file, held until the handle is dropped. `Ok(None)`
/// where the filesystem cannot lock files: the write goes ahead unlocked,
/// as Codeg's other locks do there. `Err` when another Codeg holds it past
/// [`LOCK_WAIT`], or it cannot be opened.
fn lock(path: &Path) -> std::io::Result<Option<File>> {
    let lock_path = path.with_file_name(LOCK_NAME);
    if let Some(dir) = lock_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)?;
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(Some(file)),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(LOCK_RETRY)
            }
            Err(TryLockError::WouldBlock) => {
                return Err(std::io::Error::other("held by another Codeg"))
            }
            Err(TryLockError::Error(error)) if crate::runtime_lock::locking_unsupported(&error) => {
                return Ok(None)
            }
            Err(TryLockError::Error(error)) => return Err(error),
        }
    }
}

/// Keeps what a check asked `at` came to, merged into what the file holds
/// by then (see the module docs), and returns what the file holds after.
/// When the lock cannot be had, nothing is written — a write unlocked could
/// take back a newer answer — and the merge is returned for this call.
pub(crate) fn record(path: &Path, at: DateTime<Utc>, outcome: Outcome) -> Kept {
    match lock(path) {
        Ok(_held) => {
            let there = load(path);
            let merged = merge(there.clone(), at, outcome);
            if merged != there {
                save(path, &merged);
            }
            merged
        }
        Err(error) => {
            tracing::warn!("[harness] update check result not kept: the lock: {error}");
            merge(load(path), at, outcome)
        }
    }
}

/// Writes `kept` as it is, under the lock: for tests that set the scene.
#[cfg(test)]
pub(crate) fn put(path: &Path, kept: &Kept) {
    let _held = lock(path).expect("the lock");
    save(path, kept);
}
