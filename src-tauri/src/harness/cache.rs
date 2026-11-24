//! What SpaceRing answered, kept on disk so that an unchanged answer is not
//! sent again.
//!
//! Under `<data dir>/cache/harness/http/`, one file per address: `/config`,
//! each list page, each item, its versions, description and prompt text,
//! each picture, and each file of a package read by its hash. An entry is
//! kept with the answer's ETag and is used to revalidate: the next request
//! for the address carries `If-None-Match`, and a 304 serves the stored
//! copy. What the catalog says is never served without asking — with the
//! network down a command fails (the page offers "retry"), it does not show
//! a copy of unknown age.
//!
//! Two kinds of answer are the exception, because their addresses say they
//! cannot change:
//!
//! - **Pictures**, where the site says so. A picture's address is never
//!   reused for another picture (media is named by its hash, an avatar gets a
//!   new name when it changes), and the site sends it with `Cache-Control:
//!   immutable`. Such a picture is served from its copy without a request for
//!   [`PICTURE_FRESH_SECS`], then revalidated like the rest. Pictures are most
//!   of the requests a page of results makes, and the catalog's rate limit is
//!   per address — which, for a Codeg server, is every one of its users
//!   together.
//! - **A package's files** (`/blobs/{sha256}`): the address is the file's
//!   hash, so a copy is served without a request for as long as it is kept.
//!   It is checked against the hash before it is kept and again whenever it
//!   is served (`Harness::fetch_by_hash`), so nothing but that file can sit
//!   at its address.
//!
//! # What a cached answer may be used for
//!
//! **Display, and nothing else.** An item's or a version's `status` (`ok`,
//! `yanked`, `blocked`), its `risk`, its `permissions` and its packages'
//! `verified` are updated in place by SpaceRing after the version is
//! published (an import, a rescan, a takedown), and both this cache and the
//! site's own edge cache can be behind. An install must never be let through,
//! and never be refused, on what is stored here: before installing, the
//! install steps read those fields fresh from `POST /resolve`
//! ([`super::Harness::resolve`]), which is never cached anywhere. Only what
//! cannot change about a revision — its file list and hashes — may be taken
//! from an install info that came through this cache.
//!
//! # Bounds
//!
//! At most [`MAX_ENTRIES`] entries and [`MAX_BYTES`] bytes. After each write
//! the least recently used entries (by modification time, which each use
//! renews) are removed until both hold. An entry larger than the whole budget is not
//! kept at all.
//!
//! # Writes
//!
//! An entry is written to a temporary file in the same directory and renamed
//! into place, so a reader sees the old entry or the new one, never a part.
//! The file records its own body length: one cut short by a crash is told
//! from its header and dropped. The cache is refetchable by definition, so no
//! failure here ever fails a command — an entry that cannot be written is
//! simply not kept.
//!
//! # Backups
//!
//! `cache/` is not part of Codeg's backup: `commands::backup::sections` is an
//! allowlist, and nothing under `cache/` is on it (see the test below).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The most entries kept. A day of browsing is a few hundred list pages,
/// items and pictures.
pub(crate) const MAX_ENTRIES: usize = 1024;

/// The most bytes kept, files' sizes added up. Pictures are most of it: a
/// prompt's cover runs to a few hundred kilobytes.
pub(crate) const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// How long a picture the site marked immutable is served from its copy
/// without asking. A week: long enough that browsing does not refetch
/// pictures, short enough that a copy of something since removed does not
/// outlive it by much (it is no longer shown anyway: nothing links to it).
pub(crate) const PICTURE_FRESH_SECS: u64 = 7 * 24 * 60 * 60;

/// A temporary file older than this was left by a write that never finished.
const STALE_TEMP: Duration = Duration::from_secs(10 * 60);

const FORMAT: u32 = 1;
const ENTRY_SUFFIX: &str = ".entry";
const TEMP_SUFFIX: &str = ".tmp";

/// One answer, as kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    pub etag: String,
    /// The media type, lowercase and without parameters.
    pub content_type: String,
    /// Until when (seconds since the epoch) the copy may be served without
    /// asking. `None` for everything but a picture marked immutable.
    pub fresh_until: Option<u64>,
    pub body: Vec<u8>,
}

impl Entry {
    /// Whether the copy may be served without asking at `now` (seconds since
    /// the epoch). A date further ahead than any this Codeg writes — a clock
    /// that was set back, a file from elsewhere — is not trusted.
    pub(crate) fn is_fresh_at(&self, now: u64) -> bool {
        self.fresh_until
            .is_some_and(|until| now < until && until - now <= PICTURE_FRESH_SECS)
    }
}

/// Seconds since the epoch, now.
pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// The first line of an entry's file; the body follows the line break.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    v: u32,
    /// The address the entry answers, to tell a hash collision or a stray
    /// file from the entry asked for.
    key: String,
    etag: String,
    content_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fresh_until: Option<u64>,
    /// The body's length, to tell a file cut short.
    len: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct Cache {
    dir: PathBuf,
    max_entries: usize,
    max_bytes: u64,
}

/// Where the Harness cache lives in a data directory. Later steps keep their
/// own files beside `http/` (the update check's result); only `http/` is
/// pruned here.
pub fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("cache").join("harness")
}

impl Cache {
    pub(crate) fn in_data_dir(data_dir: &Path) -> Self {
        Self::with_bounds(cache_dir(data_dir).join("http"), MAX_ENTRIES, MAX_BYTES)
    }

    pub(crate) fn with_bounds(dir: PathBuf, max_entries: usize, max_bytes: u64) -> Self {
        Self {
            dir,
            max_entries,
            max_bytes,
        }
    }

    fn path_of(&self, key: &str) -> PathBuf {
        self.dir.join(format!(
            "{:x}{ENTRY_SUFFIX}",
            Sha256::digest(key.as_bytes())
        ))
    }

    /// The entry kept for `key`, if there is a whole one.
    pub(crate) fn load(&self, key: &str) -> Option<Entry> {
        let path = self.path_of(key);
        let size = fs::metadata(&path).ok()?.len();
        if size > self.max_bytes {
            let _ = fs::remove_file(&path);
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        let entry = parse(&bytes, key);
        if entry.is_none() {
            let _ = fs::remove_file(&path);
        }
        entry
    }

    /// Keeps `entry` for `key`, in place of any before it, then brings the
    /// cache back within its bounds.
    pub(crate) fn store(&self, key: &str, entry: &Entry) {
        if let Err(error) = self.write(key, entry) {
            tracing::debug!("[harness] cache entry not kept: {error}");
            return;
        }
        self.prune();
    }

    fn write(&self, key: &str, entry: &Entry) -> std::io::Result<()> {
        let mut header = serde_json::to_vec(&Header {
            v: FORMAT,
            key: key.to_string(),
            etag: entry.etag.clone(),
            content_type: entry.content_type.clone(),
            fresh_until: entry.fresh_until,
            len: entry.body.len() as u64,
        })?;
        header.push(b'\n');
        if (header.len() + entry.body.len()) as u64 > self.max_bytes {
            // would be the first thing pruned
            let _ = fs::remove_file(self.path_of(key));
            return Ok(());
        }

        fs::create_dir_all(&self.dir)?;
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let target = self.path_of(key);
        let temp = self.dir.join(format!(
            ".{}-{}{TEMP_SUFFIX}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let written = (|| {
            let mut file = fs::File::create(&temp)?;
            file.write_all(&header)?;
            file.write_all(&entry.body)?;
            file.flush()?;
            drop(file);
            fs::rename(&temp, &target)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&temp);
        }
        written
    }

    /// Marks the entry as just used, so pruning takes others first.
    pub(crate) fn touch(&self, key: &str) {
        if let Ok(file) = fs::File::options().write(true).open(self.path_of(key)) {
            let _ = file.set_modified(SystemTime::now());
        }
    }

    pub(crate) fn remove(&self, key: &str) {
        let _ = fs::remove_file(self.path_of(key));
    }

    /// Removes the least recently used entries until the cache is within its
    /// bounds, and temporary files no write will come back for.
    fn prune(&self) {
        // One pass at a time in this process. Another process sharing the
        // directory can prune at the same moment: both then remove files the
        // other already removed, which is all the same to a cache.
        static PRUNING: Mutex<()> = Mutex::new(());
        let _one_at_a_time = PRUNING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let Ok(listing) = fs::read_dir(&self.dir) else {
            return;
        };
        let now = SystemTime::now();
        let mut entries: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        for file in listing.flatten() {
            let name = file.file_name();
            let name = name.to_string_lossy();
            let Ok(metadata) = file.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if name.ends_with(TEMP_SUFFIX) {
                if now
                    .duration_since(modified)
                    .is_ok_and(|age| age > STALE_TEMP)
                {
                    let _ = fs::remove_file(file.path());
                }
            } else if name.ends_with(ENTRY_SUFFIX) {
                entries.push((modified, metadata.len(), file.path()));
            }
        }

        let mut count = entries.len();
        let mut bytes: u64 = entries.iter().map(|(_, size, _)| size).sum();
        if count <= self.max_entries && bytes <= self.max_bytes {
            return;
        }
        entries.sort();
        for (_, size, path) in entries {
            if count <= self.max_entries && bytes <= self.max_bytes {
                break;
            }
            let _ = fs::remove_file(path);
            count -= 1;
            bytes = bytes.saturating_sub(size);
        }
    }
}

/// An entry's file, read back: its header line, then exactly the body the
/// header promises, for exactly the address asked about.
fn parse(bytes: &[u8], key: &str) -> Option<Entry> {
    let line_end = bytes.iter().position(|byte| *byte == b'\n')?;
    let header: Header = serde_json::from_slice(&bytes[..line_end]).ok()?;
    let body = &bytes[line_end + 1..];
    if header.v != FORMAT || header.key != key || header.len != body.len() as u64 {
        return None;
    }
    Some(Entry {
        etag: header.etag,
        content_type: header.content_type,
        fresh_until: header.fresh_until,
        body: body.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(etag: &str, body: &[u8]) -> Entry {
        Entry {
            etag: etag.to_string(),
            content_type: "application/json".to_string(),
            fresh_until: None,
            body: body.to_vec(),
        }
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|listing| {
                listing
                    .flatten()
                    .map(|file| file.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Dates an entry, so that "least recently used" does not hang on the
    /// file system's clock resolution.
    fn date(cache: &Cache, key: &str, seconds_ago: u64) {
        fs::File::options()
            .write(true)
            .open(cache.path_of(key))
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(seconds_ago))
            .unwrap();
    }

    #[test]
    fn an_entry_comes_back_as_it_was_kept() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::with_bounds(dir.path().join("http"), 8, 1 << 20);
        assert_eq!(cache.load("k"), None);

        // a body with line breaks and bytes that are not text
        let kept = Entry {
            etag: "W/\"abc\"".to_string(),
            content_type: "image/png".to_string(),
            fresh_until: Some(1_800_000_000),
            body: vec![0x89, b'P', b'N', b'G', b'\n', 0, 0xff, b'\n'],
        };
        cache.store("k", &kept);
        assert_eq!(cache.load("k"), Some(kept));
        assert_eq!(cache.load("another key"), None);

        cache.store("k", &entry("W/\"def\"", b"{}"));
        assert_eq!(cache.load("k"), Some(entry("W/\"def\"", b"{}")));
        assert_eq!(
            files(&dir.path().join("http")).len(),
            1,
            "replaced in place"
        );

        cache.remove("k");
        assert_eq!(cache.load("k"), None);
    }

    #[test]
    fn a_copy_is_fresh_only_within_the_time_this_codeg_gives_one() {
        let now = 1_800_000_000;
        let until = |fresh_until| Entry {
            fresh_until,
            ..entry("1", b"x")
        };
        assert!(!until(None).is_fresh_at(now));
        assert!(until(Some(now + 1)).is_fresh_at(now));
        assert!(until(Some(now + PICTURE_FRESH_SECS)).is_fresh_at(now));
        assert!(!until(Some(now)).is_fresh_at(now), "over at its date");
        assert!(!until(Some(now - 1)).is_fresh_at(now));
        assert!(
            !until(Some(now + PICTURE_FRESH_SECS + 1)).is_fresh_at(now),
            "a date further ahead than any that is written"
        );
        assert!(!until(Some(u64::MAX)).is_fresh_at(now));
    }

    #[test]
    fn a_write_leaves_the_entry_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::with_bounds(dir.path().to_path_buf(), 8, 1 << 20);
        cache.store("a", &entry("1", b"one"));
        cache.store("b", &entry("2", b"two"));
        let names = files(dir.path());
        assert_eq!(names.len(), 2);
        assert!(
            names.iter().all(|name| name.ends_with(ENTRY_SUFFIX)),
            "a temporary file was left behind: {names:?}"
        );
    }

    #[test]
    fn a_damaged_entry_is_dropped_not_served() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::with_bounds(dir.path().to_path_buf(), 8, 1 << 20);
        let path = cache.path_of("k");

        // cut short: the header promises more than is there
        cache.store("k", &entry("1", b"0123456789"));
        let whole = fs::read(&path).unwrap();
        fs::write(&path, &whole[..whole.len() - 4]).unwrap();
        assert_eq!(cache.load("k"), None);
        assert!(!path.exists(), "the damaged file stays on disk");

        // longer than promised
        cache.store("k", &entry("1", b"0123456789"));
        let mut longer = fs::read(&path).unwrap();
        longer.extend_from_slice(b"more");
        fs::write(&path, longer).unwrap();
        assert_eq!(cache.load("k"), None);

        // not an entry at all
        fs::write(&path, b"not an entry").unwrap();
        assert_eq!(cache.load("k"), None);
        fs::write(&path, b"").unwrap();
        assert_eq!(cache.load("k"), None);

        // another address's entry under this one's name
        cache.store("other", &entry("1", b"x"));
        fs::copy(cache.path_of("other"), &path).unwrap();
        assert_eq!(cache.load("k"), None);
        assert_eq!(cache.load("other"), Some(entry("1", b"x")));

        // a format this Codeg does not write
        fs::write(
            &path,
            b"{\"v\":2,\"key\":\"k\",\"etag\":\"1\",\"contentType\":\"application/json\",\"len\":1}\nx",
        )
        .unwrap();
        assert_eq!(cache.load("k"), None);
    }

    #[test]
    fn the_number_of_entries_is_bounded_and_the_oldest_go_first() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::with_bounds(dir.path().to_path_buf(), 3, 1 << 20);
        for (index, key) in ["a", "b", "c"].into_iter().enumerate() {
            cache.store(key, &entry("1", key.as_bytes()));
            date(&cache, key, 300 - index as u64 * 60);
        }
        // "a" is the oldest, until it is used again
        cache.touch("a");

        cache.store("d", &entry("1", b"d"));
        assert_eq!(files(dir.path()).len(), 3);
        assert!(cache.load("a").is_some(), "the entry just used was removed");
        assert!(cache.load("b").is_none(), "the least recently used stayed");
        assert!(cache.load("c").is_some());
        assert!(cache.load("d").is_some());
    }

    #[test]
    fn the_bytes_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::with_bounds(dir.path().to_path_buf(), 100, 2_000);
        let body = vec![b'x'; 700];
        for (index, key) in ["a", "b", "c", "d", "e"].into_iter().enumerate() {
            cache.store(key, &entry("1", &body));
            date(&cache, key, 300 - index as u64 * 60);
            let total: u64 = fs::read_dir(dir.path())
                .unwrap()
                .flatten()
                .map(|file| file.metadata().unwrap().len())
                .sum();
            assert!(total <= 2_000, "{total} bytes kept after {key}");
        }
        // each is some 800 bytes with its header: two fit, the newest two
        assert_eq!(files(dir.path()).len(), 2);
        assert!(cache.load("d").is_some());
        assert!(cache.load("e").is_some());
    }

    #[test]
    fn an_entry_over_the_whole_budget_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::with_bounds(dir.path().to_path_buf(), 100, 1_000);
        cache.store("small", &entry("1", b"small"));
        cache.store("huge", &entry("1", &vec![b'x'; 5_000]));
        assert_eq!(cache.load("huge"), None);
        assert!(
            cache.load("small").is_some(),
            "it pushed out what was there"
        );

        // and it does not leave an older, smaller answer for the address
        cache.store("k", &entry("1", b"old"));
        cache.store("k", &entry("2", &vec![b'x'; 5_000]));
        assert_eq!(cache.load("k"), None);
    }

    #[test]
    fn pruning_clears_abandoned_temporary_files_and_leaves_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::with_bounds(dir.path().to_path_buf(), 1, 1 << 20);
        let abandoned = dir.path().join(".999-0.tmp");
        let in_flight = dir.path().join(".999-1.tmp");
        let unrelated = dir.path().join("updates.json");
        for path in [&abandoned, &in_flight, &unrelated] {
            fs::write(path, b"x").unwrap();
        }
        let long_ago = SystemTime::now() - Duration::from_secs(3600);
        for path in [&abandoned, &unrelated] {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(long_ago)
                .unwrap();
        }

        cache.store("a", &entry("1", b"a"));
        cache.store("b", &entry("1", b"b"));
        assert!(!abandoned.exists());
        assert!(in_flight.exists(), "a write in progress lost its file");
        assert!(unrelated.exists(), "a file that is not an entry was pruned");
    }

    #[test]
    fn a_cache_that_cannot_be_written_is_no_error() {
        let dir = tempfile::tempdir().unwrap();
        // a file where the directory should be
        let blocked = dir.path().join("http");
        fs::write(&blocked, b"").unwrap();
        let cache = Cache::with_bounds(blocked, 8, 1 << 20);
        cache.store("k", &entry("1", b"x"));
        cache.touch("k");
        cache.remove("k");
        assert_eq!(cache.load("k"), None);
    }

    /// The cache is refetchable and must stay out of backups. Backup is an
    /// allowlist of sections; under one data root, none of them is, holds, or
    /// lies inside the Harness cache.
    #[test]
    fn the_cache_is_outside_the_backup() {
        use crate::commands::backup::sections::MANAGED_SECTIONS;

        // the root the sections themselves resolve against in this process
        let data_dir = crate::paths::codeg_uploads_root()
            .parent()
            .expect("uploads has a parent")
            .to_path_buf();
        let cache = cache_dir(&data_dir);
        assert_eq!(cache, data_dir.join("cache").join("harness"));
        for section in MANAGED_SECTIONS {
            let live = (section.live_path)(&data_dir);
            assert!(
                !cache.starts_with(&live) && !live.starts_with(&cache),
                "backup section {:?} ({}) overlaps the Harness cache ({})",
                section.id,
                live.display(),
                cache.display()
            );
            assert!(
                !live.starts_with(data_dir.join("cache")),
                "backup section {:?} is under cache/",
                section.id
            );
        }
        assert!(
            Cache::in_data_dir(&data_dir).dir.starts_with(&cache),
            "entries are kept outside the Harness cache directory"
        );
    }
}
