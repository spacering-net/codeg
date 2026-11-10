//! Who may use a data directory's database: one lock that says only "a
//! runtime is alive here".
//!
//! Every runtime — the desktop app, `codeg-server` — holds a SHARED lock on
//! `<data dir>/<database file>.runtime.lock` from before it opens the
//! database until it exits. The private server `codeg-cli --standalone`
//! starts (with [`EXCLUSIVE_ENV`]) takes it EXCLUSIVE instead, and only when
//! no runtime holds it at all: otherwise it leaves at once with
//! [`BUSY_EXIT_CODE`], having touched nothing. A runtime that finds the lock
//! held exclusively waits (a server) or says so and leaves (the desktop),
//! so it never opens a database a private server is using either.
//!
//! The lock is apart from the engines' election locks (`<db>.lock`,
//! `<db>.tasks.lock`), and must stay apart: the first runtime to take one of
//! those is that engine's for good, so any try-and-release there could cost
//! a runtime starting at the same moment its engine. The OS lets go of a
//! lock when its holder dies, however it dies, so a crash never leaves a
//! data directory refused. A runtime from before this lock existed holds
//! nothing, and is not seen.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Set to `1` by `codeg-cli --standalone` for the server it starts: take the
/// data directory exclusively, or not at all.
pub const EXCLUSIVE_ENV: &str = "CODEG_REQUIRE_EXCLUSIVE_DATA_DIR";

/// How a private server ends when another runtime is alive on its data
/// directory: before any migration, any write. `EX_TEMPFAIL` of sysexits.
pub const BUSY_EXIT_CODE: u8 = 75;

/// Set to `1` by `codeg-cli --standalone` too: the server ends when its stdin
/// does — when the `codeg-cli` that started it is gone, however it went, a
/// `kill -9` included. No pid to watch, so none to mistake for another.
pub const EXIT_ON_STDIN_EOF_ENV: &str = "CODEG_EXIT_ON_STDIN_EOF";

/// How often a waiting server says that it waits.
const WAIT_NOTICE: Duration = Duration::from_secs(30);
const RETRY: Duration = Duration::from_millis(250);

/// A held lock; let go of when dropped (and by the OS at exit).
#[derive(Debug)]
pub struct RuntimeLock {
    _file: File,
}

/// Whether `error` says the filesystem cannot lock files at all (an NFS mount
/// without a lock manager, say). A runtime goes on without the lock there,
/// as it always did; any other error stops it rather than run unlocked.
pub fn locking_unsupported(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ENOLCK) {
        return true;
    }
    false
}

/// The lock file of the database `data_dir` holds.
pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("{}.runtime.lock", crate::db::database_file_name()))
}

fn open(data_dir: &Path) -> io::Result<File> {
    std::fs::create_dir_all(data_dir)?;
    let path = path(data_dir);
    match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
    {
        // A lock file this user may only read still takes a lock: nothing is
        // ever written to it.
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied && path.is_file() => {
            OpenOptions::new().read(true).open(&path)
        }
        opened => opened,
    }
}

/// The shared lock, if no private server holds the directory.
pub fn try_shared(data_dir: &Path) -> io::Result<Option<RuntimeLock>> {
    let file = open(data_dir)?;
    match file.try_lock_shared() {
        Ok(()) => Ok(Some(RuntimeLock { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

/// The exclusive lock, if no runtime at all holds the directory.
pub fn try_exclusive(data_dir: &Path) -> io::Result<Option<RuntimeLock>> {
    let file = open(data_dir)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(RuntimeLock { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

/// The shared lock, waited for as long as a private server holds the
/// directory; `waiting` hears how long it has been, every 30 s.
pub fn shared_waiting(
    data_dir: &Path,
    mut waiting: impl FnMut(Duration),
) -> io::Result<RuntimeLock> {
    let started = Instant::now();
    let mut next_notice = WAIT_NOTICE;
    loop {
        if let Some(lock) = try_shared(data_dir)? {
            return Ok(lock);
        }
        if started.elapsed() >= next_notice {
            waiting(started.elapsed());
            next_notice += WAIT_NOTICE;
        }
        std::thread::sleep(RETRY);
    }
}

/// What a server does before it touches its data directory: take the lock
/// as its environment asks. `Ok(None)`: a private server that found the
/// directory in use, and leaves.
pub fn hold_for_server(data_dir: &Path) -> io::Result<Option<RuntimeLock>> {
    let exclusive = std::env::var(EXCLUSIVE_ENV).is_ok_and(|v| v == "1");
    if exclusive {
        return try_exclusive(data_dir);
    }
    shared_waiting(data_dir, |waited| {
        tracing::warn!(
            "[SERVER] {} is in use by a `codeg-cli --standalone` server; waiting for it to end \
             ({}s so far)",
            data_dir.display(),
            waited.as_secs()
        );
    })
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtimes_share_the_directory_and_a_private_server_wants_it_alone() {
        let dir = tempfile::tempdir().unwrap();
        let first = try_shared(dir.path()).unwrap().expect("shared");
        let second = try_shared(dir.path()).unwrap().expect("shared again");
        assert!(
            try_exclusive(dir.path()).unwrap().is_none(),
            "a runtime is alive here"
        );
        drop(first);
        assert!(try_exclusive(dir.path()).unwrap().is_none());
        drop(second);

        let alone = try_exclusive(dir.path()).unwrap().expect("nobody left");
        assert!(
            try_shared(dir.path()).unwrap().is_none(),
            "no runtime opens a database a private server uses"
        );
        drop(alone);
        assert!(try_shared(dir.path()).unwrap().is_some());
    }

    #[test]
    fn the_lock_is_named_after_the_database_and_made_with_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("not-yet");
        let _lock = try_shared(&data).unwrap().expect("shared");
        assert!(path(&data).is_file());
        assert!(path(&data)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".db.runtime.lock"));
    }

    #[test]
    fn a_waiting_runtime_takes_the_lock_once_it_is_free() {
        let dir = tempfile::tempdir().unwrap();
        let alone = try_exclusive(dir.path()).unwrap().expect("alone");
        let data = dir.path().to_path_buf();
        let waiter = std::thread::spawn(move || shared_waiting(&data, |_| {}).map(|_| ()));
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            !waiter.is_finished(),
            "it waits while the directory is held"
        );
        drop(alone);
        waiter.join().unwrap().expect("then takes it");
    }

    /// Nothing is written to the lock file, so one this user may only read
    /// (its mode changed, say) locks all the same.
    #[cfg(unix)]
    #[test]
    fn a_lock_file_that_can_only_be_read_still_locks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        drop(try_shared(dir.path()).unwrap());
        std::fs::set_permissions(path(dir.path()), std::fs::Permissions::from_mode(0o444)).unwrap();
        let shared = try_shared(dir.path()).unwrap().expect("shared, read-only");
        assert!(try_exclusive(dir.path()).unwrap().is_none());
        drop(shared);
        assert!(try_exclusive(dir.path()).unwrap().is_some());
    }

    #[test]
    fn only_a_filesystem_that_cannot_lock_lets_a_runtime_go_on_unlocked() {
        assert!(locking_unsupported(&io::Error::from(
            io::ErrorKind::Unsupported
        )));
        #[cfg(unix)]
        assert!(locking_unsupported(&io::Error::from_raw_os_error(
            libc::ENOLCK
        )));
        assert!(!locking_unsupported(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
        assert!(!locking_unsupported(&io::Error::from(
            io::ErrorKind::NotFound
        )));
    }

    #[test]
    fn a_private_server_never_waits() {
        let dir = tempfile::tempdir().unwrap();
        let _alive = try_shared(dir.path()).unwrap().expect("a runtime");
        temp_env::with_var(EXCLUSIVE_ENV, Some("1"), || {
            assert!(hold_for_server(dir.path()).unwrap().is_none());
        });
    }
}
