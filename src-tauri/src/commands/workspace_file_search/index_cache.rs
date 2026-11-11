//! Short-lived registry locks, coalesced query-owned discovery, and a global
//! LRU budget. Oversized roots use an unnamed temporary file: subsequent
//! searches read this complete snapshot, never walk the filesystem again.
//!
//! While the workspace's file watcher runs, file-change events keep each
//! snapshot current through an overlay of added and removed entries, so a
//! watched snapshot is not rebuilt on the usual TTL (only, as a backstop for
//! events a backend lost silently, after a much longer one). Once the watch
//! ends (the workspace is no longer open), the usual TTL starts from then.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::{watch, Semaphore};

use super::super::folders::{authorized_links_in, visit_workspace_focused, WalkFocus};
use super::{
    visit_workspace_files, Builder, CompactIndex, Matches, SearchControl, SearchOptions,
    WorkspaceEntryKind, WorkspaceFileEntry, BUILD_BYTES, CACHE_TTL, INDEX_BYTES, MAX_CONSUMERS,
};

const ROOT_LIMIT: usize = 8;
const WORKERS: usize = 2;
const QUERY_WORKERS: usize = 4;
const DISK_BYTES: usize = 2 * 1024 * 1024 * 1024;
const SNAPSHOT_DISK_BYTES: usize = 1024 * 1024 * 1024;
const RECORD_BYTES: usize = 1024 * 1024;
const ERROR_BACKOFF: Duration = Duration::from_secs(5);
// A picker aborts its previous query on each keystroke before sending the next
// one (after a short debounce). Without a grace period the last lease would
// drop in between and every keystroke would restart a cold discovery from zero.
const DISCOVERY_LINGER: Duration = Duration::from_secs(3);
// Overlays and in-build change logs stay small; past these a full rebuild is
// cheaper and simpler than carrying the changes.
const OVERLAY_LIMIT: usize = 20_000;
const PENDING_LIMIT: usize = 4_096;
// Entries added by change events rank after every snapshot entry of the same
// score, in the order they were applied.
const ADDED_ORDER: usize = usize::MAX / 2;
// Upper bound on events a stopping workspace watch had not yet flushed
// (its debounce batch window is 1.5 s).
const UNFLUSHED_EVENTS: Duration = Duration::from_secs(2);
// Even a watched snapshot is rebuilt this long after its walk began. Watch
// backends can lose events without saying so (a Windows change buffer that
// overflows reports nothing; inotify silently skips a new directory past the
// watch limit; network filesystems report only local changes), so event
// maintenance bounds staleness rather than ruling it out.
const COVERED_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub(super) struct RootKey {
    path: PathBuf,
    // Linked-root authorization changes must take effect before the TTL.
    links: Vec<(String, PathBuf)>,
    ignore_files: Vec<Option<(SystemTime, u64)>>,
}

impl RootKey {
    pub(super) fn resolve(path: &str) -> Result<Self, String> {
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if path.to_str().is_none() {
            return Err("Workspace search path is not UTF-8".into());
        }
        if !path.is_dir() {
            return Err("Workspace search root is not a directory".into());
        }
        let links = authorized_links_in(&path);
        let mut ignore_files = Vec::new();
        for root in std::iter::once(&path).chain(links.iter().map(|(_, path)| path)) {
            for file in [".gitignore", ".ignore", ".git/info/exclude"] {
                ignore_files.push(
                    std::fs::metadata(root.join(file))
                        .ok()
                        .and_then(|m| Some((m.modified().ok()?, m.len()))),
                );
            }
        }
        Ok(Self {
            path,
            links,
            ignore_files,
        })
    }

    fn path(&self) -> &str {
        // Input paths already cross the String-based desktop/HTTP boundary.
        self.path.to_str().expect("canonical UTF-8 workspace path")
    }
}

#[derive(Clone, Copy)]
struct Limits {
    memory: usize,
    build: usize,
    disk: usize,
    disk_per_root: usize,
    roots: usize,
    linger: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            memory: INDEX_BYTES,
            build: BUILD_BYTES,
            disk: DISK_BYTES,
            disk_per_root: SNAPSHOT_DISK_BYTES,
            roots: ROOT_LIMIT,
            linger: DISCOVERY_LINGER,
        }
    }
}

struct Quota {
    limit: usize,
    used: AtomicUsize,
}

impl Quota {
    fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            limit,
            used: AtomicUsize::new(0),
        })
    }

    fn reserve(self: &Arc<Self>, bytes: usize) -> Option<Reservation> {
        let mut used = self.used.load(Ordering::Acquire);
        loop {
            let next = used.checked_add(bytes).filter(|next| *next <= self.limit)?;
            match self
                .used
                .compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => break,
                Err(current) => used = current,
            }
        }
        Some(Reservation {
            quota: Arc::clone(self),
            bytes,
        })
    }
}

struct Reservation {
    quota: Arc<Quota>,
    bytes: usize,
}

impl Reservation {
    fn shrink(&mut self, bytes: usize) {
        assert!(bytes <= self.bytes);
        self.quota
            .used
            .fetch_sub(self.bytes - bytes, Ordering::AcqRel);
        self.bytes = bytes;
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.quota.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

enum Storage {
    Memory {
        index: CompactIndex,
        _charge: Reservation,
    },
    Disk {
        file: Arc<File>,
        bytes: usize,
        _charge: Reservation,
    },
}

pub(super) struct Snapshot {
    built_at: Instant,
    storage: Storage,
    // No ignore rule it applied lives outside what the workspace watch sees.
    watchable: bool,
}

impl Snapshot {
    fn charge(&self) -> &Arc<Quota> {
        match &self.storage {
            Storage::Memory { _charge, .. } | Storage::Disk { _charge, .. } => &_charge.quota,
        }
    }

    fn search(
        &self,
        query: &str,
        limit: usize,
        files_only: bool,
        control: &SearchControl,
        overlay: &Arc<Overlay>,
    ) -> Result<Vec<WorkspaceFileEntry>, String> {
        let mut matches = Matches::new(query, limit, files_only).hiding(overlay);
        if !self.scan(&mut matches, control)? {
            return Ok(Vec::new());
        }
        for (path, (is_dir, order)) in &overlay.added {
            if control.stopped() {
                return Ok(Vec::new());
            }
            let name = path.rsplit('/').next().unwrap_or(path);
            matches.offer_added(name, path, *is_dir, *order);
        }
        Ok(matches.finish())
    }

    /// Offer every snapshot entry; Ok(false) when stopped early.
    fn scan(&self, matches: &mut Matches, control: &SearchControl) -> Result<bool, String> {
        match &self.storage {
            Storage::Memory { index, .. } => Ok(index.scan(matches, control)),
            Storage::Disk { file, bytes, .. } => {
                let mut reader = BufReader::with_capacity(
                    64 * 1024,
                    PositionedReader {
                        file: Arc::clone(file),
                        offset: 0,
                    },
                );
                let mut read = 0;
                let mut order = 0;
                // Positional reads give every query an independent cursor;
                // File::try_clone + seek would share offsets on Unix.
                while read < *bytes {
                    if control.stopped() {
                        return Ok(false);
                    }
                    let mut header = [0u8; 9];
                    reader.read_exact(&mut header).map_err(|e| e.to_string())?;
                    let name_len = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
                    let path_len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
                    let len = name_len
                        .checked_add(path_len)
                        .filter(|len| *len <= RECORD_BYTES)
                        .ok_or("Invalid workspace snapshot record")?;
                    if len + 9 > bytes - read {
                        return Err("Truncated workspace snapshot".into());
                    }
                    let mut text = vec![0; len];
                    reader.read_exact(&mut text).map_err(|e| e.to_string())?;
                    let name = std::str::from_utf8(&text[..name_len]).map_err(|e| e.to_string())?;
                    let path = std::str::from_utf8(&text[name_len..]).map_err(|e| e.to_string())?;
                    matches.offer(name, path, header[8] != 0, order);
                    read += 9 + len;
                    order += 1;
                }
                Ok(true)
            }
        }
    }
}

/// Changes to a published snapshot made by file-change events since it was
/// built. Removing a path hides it and its descendants in the snapshot; added
/// entries are searched after it. Re-applying a change is idempotent.
#[derive(Clone, Default)]
pub(super) struct Overlay {
    removed: HashSet<String>,
    added: BTreeMap<String, (bool, usize)>,
    next: usize,
}

impl Overlay {
    pub(super) fn removes_any(&self) -> bool {
        !self.removed.is_empty()
    }

    /// Whether a snapshot entry at `path` was removed (or sits below a path
    /// that was).
    pub(super) fn hides(&self, path: &str) -> bool {
        self.removed.contains(path)
            || path
                .match_indices('/')
                .any(|(i, _)| self.removed.contains(&path[..i]))
    }

    fn len(&self) -> usize {
        self.removed.len() + self.added.len()
    }

    fn apply(&mut self, change: &Change) {
        let path = match change {
            Change::Removed(path) | Change::Replaced(path, _) => path,
        };
        self.added.remove(path.as_str());
        let prefix = format!("{path}/");
        let below: Vec<String> = self
            .added
            .range(prefix.clone()..)
            .take_while(|(added, _)| added.starts_with(&prefix))
            .map(|(added, _)| added.clone())
            .collect();
        for added in below {
            self.added.remove(&added);
        }
        self.removed.insert(path.clone());
        if let Change::Replaced(_, entries) = change {
            for entry in entries {
                self.added.insert(
                    entry.path.clone(),
                    (
                        entry.kind == WorkspaceEntryKind::Dir,
                        ADDED_ORDER.saturating_add(self.next),
                    ),
                );
                self.next += 1;
            }
        }
    }
}

/// The current on-disk state of one changed path, as a full walk would see
/// it: gone (or now ignored), or present with every visible entry below it.
#[derive(Debug, PartialEq)]
enum Change {
    Removed(String),
    Replaced(String, Vec<WorkspaceFileEntry>),
}

/// Re-read `paths` under `root` with full-walk ignore semantics. Paths below
/// a directory the walk does not enter (ignored, or hard-skipped like `.git`)
/// produce no change: they were never in the snapshot either. That keeps build
/// output churn inside ignored trees from growing the overlay. None when a
/// rebuild is due instead: the changed subtrees hold more entries than an
/// overlay may, or bring in ignore rules the watch cannot follow.
fn read_changes(root: &Path, paths: Vec<String>, limit: usize) -> Option<Vec<Change>> {
    let Some(root_str) = root.to_str() else {
        return Some(Vec::new());
    };
    let mut paths: Vec<String> = paths
        .into_iter()
        .filter(|path| !path.is_empty() && !path.split('/').any(|part| part.is_empty()))
        .collect();
    paths.sort_by(|a, b| {
        a.matches('/')
            .count()
            .cmp(&b.matches('/').count())
            .then_with(|| a.cmp(b))
    });
    paths.dedup();
    let mut targets = Vec::new();
    let mut dirs: HashSet<String> = HashSet::new();
    for path in paths {
        // An existing directory target is re-read with its whole subtree.
        if ancestors(&path).any(|ancestor| dirs.contains(ancestor)) {
            continue;
        }
        let full = root.join(&path);
        if std::fs::symlink_metadata(&full).is_ok_and(|meta| {
            if meta.file_type().is_symlink() {
                full.is_dir()
            } else {
                meta.is_dir()
            }
        }) {
            dirs.insert(path.clone());
        }
        targets.push(path);
    }
    if targets.is_empty() {
        return Some(Vec::new());
    }
    let mut on_path: HashSet<String> = HashSet::new();
    for target in &targets {
        on_path.extend(ancestors(target).map(str::to_owned));
        on_path.insert(target.clone());
    }
    let dirs = Arc::new(dirs);
    let on_path = Arc::new(on_path);
    let focus: WalkFocus = {
        let dirs = Arc::clone(&dirs);
        let on_path = Arc::clone(&on_path);
        Arc::new(move |rel: &str| {
            on_path.contains(rel) || ancestors(rel).any(|ancestor| dirs.contains(ancestor))
        })
    };
    let mut seen: BTreeMap<String, WorkspaceFileEntry> = BTreeMap::new();
    let mut oversized = false;
    visit_workspace_focused(root_str, focus, |entry| {
        seen.insert(entry.path.clone(), entry);
        // Ancestors are yielded too; they are few next to the limit.
        oversized = seen.len() > limit;
        !oversized
    });
    if oversized {
        return None;
    }
    // A directory moved in reports only itself, not the rule files inside.
    let read_dirs = targets.iter().flat_map(|target| {
        let prefix = format!("{target}/");
        std::iter::once(seen.get_key_value(target)).flatten().chain(
            seen.range(prefix.clone()..)
                .take_while(move |(path, _)| path.starts_with(&prefix)),
        )
    });
    if read_dirs
        .filter(|(_, entry)| entry.kind == WorkspaceEntryKind::Dir)
        .any(|(path, _)| unwatchable_rules(&root.join(path)))
    {
        return None;
    }
    let mut changes = Vec::new();
    for target in targets {
        let parent = target.rsplit_once('/').map(|(parent, _)| parent);
        if parent.is_some_and(|parent| !seen.contains_key(parent)) {
            continue;
        }
        let Some(entry) = seen.get(&target) else {
            changes.push(Change::Removed(target));
            continue;
        };
        let mut entries = vec![entry.clone()];
        let prefix = format!("{target}/");
        entries.extend(
            seen.range(prefix.clone()..)
                .take_while(|(path, _)| path.starts_with(&prefix))
                .map(|(_, entry)| entry.clone()),
        );
        changes.push(Change::Replaced(target, entries));
    }
    Some(changes)
}

/// Proper ancestors of a relative path, nearest last: "a/b/c" -> "a", "a/b".
fn ancestors(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/').map(move |(i, _)| &path[..i])
}

/// Whether the walk into `dir` applies an ignore file that is a symlink: its
/// target's rules count, but edits to the target produce no event for this
/// path (the target may not even be in the watched tree). Checked per entered
/// directory, since a rule file the walk applies may itself be ignored and so
/// never yielded. The root's own ignore files are fingerprinted through their
/// targets in [`RootKey`] instead.
fn unwatchable_rules(dir: &Path) -> bool {
    [".gitignore", ".ignore"].iter().any(|name| {
        std::fs::symlink_metadata(dir.join(name)).is_ok_and(|meta| meta.file_type().is_symlink())
    })
}

/// A file whose edit changes what a walk ignores. The workspace root's own
/// `.git/info/exclude` is part of the cache key instead (its watcher reports
/// only selected `.git` paths); nested repositories' excludes arrive here.
fn is_ignore_file(path: &str) -> bool {
    let in_git_dir = path.starts_with(".git/") || path.contains("/.git/");
    (!in_git_dir && matches!(path.rsplit('/').next(), Some(".gitignore" | ".ignore")))
        || path == ".git/info/exclude"
        || path.ends_with("/.git/info/exclude")
}

enum WatchMessage {
    Changes(PathBuf, Vec<String>),
    #[cfg(test)]
    Barrier(mpsc::Sender<()>),
}

struct PositionedReader {
    file: Arc<File>,
    offset: u64,
}

impl Read for PositionedReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        #[cfg(unix)]
        let bytes = std::os::unix::fs::FileExt::read_at(&*self.file, buf, self.offset)?;
        #[cfg(windows)]
        let bytes = std::os::windows::fs::FileExt::seek_read(&*self.file, buf, self.offset)?;
        self.offset += bytes as u64;
        Ok(bytes)
    }
}

#[derive(Clone)]
enum BuildError {
    Cancelled,
    Failed(Arc<str>),
}

impl From<String> for BuildError {
    fn from(error: String) -> Self {
        Self::Failed(error.into())
    }
}

type BuildResult = Result<Arc<Snapshot>, BuildError>;
type Walker = dyn Fn(&str, &mut dyn FnMut(WorkspaceFileEntry) -> bool) + Send + Sync;

struct BuildJob {
    control: SearchControl,
    // The workspace watch live when the job was created. Only then can the
    // events after its walk began be replayed to keep the result current.
    watch: Option<u64>,
    started_at: Instant,
    // Changes seen while the walk runs, replayed onto the published snapshot.
    pending: Mutex<Pending>,
    users: AtomicUsize,
    // Bumped each time the last lease drops, so a lingering cancellation can
    // tell whether a consumer re-attached (and maybe left again) meanwhile.
    released: AtomicUsize,
    linger: Duration,
    result: watch::Sender<Option<BuildResult>>,
}

struct BuildLease(Arc<BuildJob>);

impl Drop for BuildLease {
    fn drop(&mut self) {
        if self.0.users.fetch_sub(1, Ordering::AcqRel) != 1 {
            return;
        }
        let epoch = self.0.released.fetch_add(1, Ordering::AcqRel) + 1;
        let runtime = tokio::runtime::Handle::try_current();
        let (false, Ok(runtime)) = (self.0.linger.is_zero(), runtime) else {
            self.0.control.cancel.cancel();
            return;
        };
        // Keep the walk alive briefly for a superseding query from the same
        // picker. A consumer that attaches in this window keeps the job; if
        // nobody does, cancellation proceeds as before. Completion ends the
        // wait early so a finished job is not retained for the full linger.
        let job = Arc::clone(&self.0);
        runtime.spawn(async move {
            let mut done = job.result.subscribe();
            tokio::select! {
                _ = tokio::time::sleep(job.linger) => {}
                _ = done.wait_for(Option::is_some) => return,
            }
            if job.users.load(Ordering::Acquire) == 0
                && job.released.load(Ordering::Acquire) == epoch
            {
                job.control.cancel.cancel();
            }
        });
    }
}

#[derive(Default)]
struct Pending {
    paths: BTreeSet<String>,
    // Overflowed, or ignore rules changed: the walk's result is not current.
    dirty: bool,
}

struct Cached {
    // Unique per publication: a change read before a rebuild must not land on
    // the snapshot that replaced its target.
    id: u64,
    key: RootKey,
    snapshot: Arc<Snapshot>,
    overlay: Arc<Overlay>,
    // Kept current by the workspace watch: as fresh as any query asks for,
    // until COVERED_TTL after its walk began.
    covered: bool,
    // When the content was last known to be current; for a covered snapshot,
    // when its walk began.
    fresh_base: Instant,
}

impl Cached {
    fn expired(&self) -> bool {
        // A covered snapshot's base is when its walk began.
        let ttl = if self.covered { COVERED_TTL } else { CACHE_TTL };
        self.fresh_base.elapsed() >= ttl
    }

    fn fresh_as_of(&self, now: Instant) -> Instant {
        if self.covered {
            now
        } else {
            self.fresh_base
        }
    }
}

#[derive(Default)]
struct Registry {
    // Front is least recently used. Only complete snapshots are published.
    snapshots: VecDeque<Cached>,
    jobs: HashMap<RootKey, Arc<BuildJob>>,
    failures: HashMap<RootKey, (Instant, Arc<str>)>,
    // Live workspace watches by canonical root, each with a unique token.
    watches: HashMap<PathBuf, u64>,
    next_watch: u64,
    next_cached: u64,
}

impl Registry {
    /// Snapshots that change events maintain. Roots with authorized linked
    /// directories are left to the TTL: the watch does not reach link targets,
    /// and the focused walk skips the links themselves.
    fn maintained<'a>(&'a mut self, root: &'a Path) -> impl Iterator<Item = &'a mut Cached> {
        self.snapshots
            .iter_mut()
            .filter(move |c| c.key.path == root && c.key.links.is_empty())
    }

    /// The watch on `root` ended or was replaced: covered snapshots were
    /// current until now, less the batch the stopped stream never flushed.
    fn uncover(&mut self, root: &Path) {
        let now = Instant::now();
        let now = now.checked_sub(UNFLUSHED_EVENTS).unwrap_or(now);
        for cached in self.maintained(root) {
            if cached.covered {
                cached.covered = false;
                cached.fresh_base = now;
            }
        }
    }
}

pub(super) struct IndexService {
    limits: Limits,
    registry: Mutex<Registry>,
    memory: Arc<Quota>,
    disk: Arc<Quota>,
    discovery: Arc<Semaphore>,
    scoring: Arc<Semaphore>,
    listing: Arc<Semaphore>,
    walk: Arc<Walker>,
    // File-change processing runs on one thread, in arrival order, so each
    // change is read from disk after every earlier one.
    changes: OnceLock<Mutex<mpsc::Sender<WatchMessage>>>,
    // Runs between reading changes from disk and applying them.
    #[cfg(test)]
    after_read: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl IndexService {
    pub(super) fn production() -> Arc<Self> {
        Self::new(
            Limits::default(),
            Arc::new(|root, visit| visit_workspace_files(root, visit)),
        )
    }

    fn new(limits: Limits, walk: Arc<Walker>) -> Arc<Self> {
        Arc::new(Self {
            limits,
            registry: Mutex::new(Registry::default()),
            memory: Quota::new(limits.memory),
            disk: Quota::new(limits.disk),
            discovery: Arc::new(Semaphore::new(WORKERS)),
            scoring: Arc::new(Semaphore::new(QUERY_WORKERS)),
            listing: Arc::new(Semaphore::new(WORKERS)),
            walk,
            changes: OnceLock::new(),
            #[cfg(test)]
            after_read: Mutex::new(None),
        })
    }

    fn send(self: &Arc<Self>, message: WatchMessage) {
        let sender = self.changes.get_or_init(|| {
            let (sender, receiver) = mpsc::channel();
            let service = Arc::downgrade(self);
            std::thread::Builder::new()
                .name("codeg-search-changes".into())
                .spawn(move || Self::process_changes(service, receiver))
                .expect("spawn workspace search change thread");
            Mutex::new(sender)
        });
        let _ = sender.lock().unwrap().send(message);
    }

    fn process_changes(service: Weak<Self>, receiver: mpsc::Receiver<WatchMessage>) {
        while let Ok(message) = receiver.recv() {
            match message {
                WatchMessage::Changes(root, paths) => {
                    let Some(service) = service.upgrade() else {
                        return;
                    };
                    service.apply_changes(&root, paths);
                }
                #[cfg(test)]
                WatchMessage::Barrier(done) => {
                    let _ = done.send(());
                }
            }
        }
    }

    fn apply_changes(&self, root: &Path, paths: Vec<String>) {
        // Only snapshots cached before the read: one published later began
        // its walk after these changes were routed (or replays them itself).
        let targets: HashSet<u64> = {
            let mut registry = self.registry.lock().unwrap();
            registry.maintained(root).map(|c| c.id).collect()
        };
        if targets.is_empty() {
            return;
        }
        let changes = read_changes(root, paths, OVERLAY_LIMIT);
        #[cfg(test)]
        if let Some(hook) = self.after_read.lock().unwrap().as_ref() {
            hook();
        }
        let mut registry = self.registry.lock().unwrap();
        let Some(changes) = changes else {
            // Too large to carry: rebuilt by the next query.
            registry.snapshots.retain(|c| !targets.contains(&c.id));
            return;
        };
        for cached in registry
            .maintained(root)
            .filter(|c| targets.contains(&c.id))
        {
            let overlay = Arc::make_mut(&mut cached.overlay);
            for change in &changes {
                overlay.apply(change);
            }
        }
        // A large overlay is replaced by a rebuild on the next query.
        registry
            .snapshots
            .retain(|c| !targets.contains(&c.id) || c.overlay.len() <= OVERLAY_LIMIT);
    }

    /// A workspace watch for `root` (canonical) became live. Snapshots whose
    /// walk starts after this are kept current by [`Self::watch_changed`].
    pub(super) fn watch_started(&self, root: &Path) -> u64 {
        let mut registry = self.registry.lock().unwrap();
        registry.next_watch += 1;
        let token = registry.next_watch;
        // A replaced watch may have dropped its last batch, with no stop yet.
        if registry.watches.insert(root.to_path_buf(), token).is_some() {
            registry.uncover(root);
        }
        token
    }

    /// The watch ended: its snapshots were current until now and age from here.
    pub(super) fn watch_stopped(&self, root: &Path, token: u64) {
        let mut registry = self.registry.lock().unwrap();
        if registry.watches.get(root) != Some(&token) {
            return;
        }
        registry.watches.remove(root);
        registry.uncover(root);
    }

    /// One debounced batch from the watch on `root`. `structural` holds the
    /// paths created, removed or renamed; `changed` every path touched.
    /// `overflowed` means events were lost.
    pub(super) fn watch_changed<'a>(
        self: &Arc<Self>,
        root: &Path,
        mut changed: impl Iterator<Item = &'a str>,
        structural: impl Iterator<Item = &'a str>,
        overflowed: bool,
    ) {
        let stale = overflowed || changed.any(is_ignore_file);
        let structural: Vec<String> = structural.map(str::to_owned).collect();
        let mut registry = self.registry.lock().unwrap();
        for job in registry.jobs.iter().filter(|(key, _)| key.path == root) {
            let mut pending = job.1.pending.lock().unwrap();
            if stale || pending.paths.len() + structural.len() > PENDING_LIMIT {
                pending.dirty = true;
                pending.paths.clear();
            } else if !pending.dirty {
                pending.paths.extend(structural.iter().cloned());
            }
        }
        if stale {
            // Ignore rules changed or events were lost: what any snapshot of
            // this root shows is unknown. The next query rebuilds it.
            registry.snapshots.retain(|c| c.key.path != root);
            return;
        }
        if !structural.is_empty() && registry.maintained(root).next().is_some() {
            drop(registry);
            self.send(WatchMessage::Changes(root.to_path_buf(), structural));
        }
    }

    /// Wait until every change sent so far has been applied.
    #[cfg(test)]
    fn settle(self: &Arc<Self>) {
        let (done, wait) = mpsc::channel();
        self.send(WatchMessage::Barrier(done));
        let _ = wait.recv();
    }

    fn reserve(&self, quota: &Arc<Quota>, bytes: usize) -> Option<Reservation> {
        if bytes > quota.limit {
            return None;
        }
        let mut registry = self.registry.lock().unwrap();
        loop {
            if let Some(charge) = quota.reserve(bytes) {
                return Some(charge);
            }
            // An in-flight query can still own an evicted snapshot. Its lease
            // keeps counting until it actually drops; eviction never lies
            // about the process-wide total to admit a new allocation. Only
            // snapshots charged to this quota can free it: evicting a memory
            // index for disk space (or vice versa) would discard a warm root
            // without making room.
            let victim = registry
                .snapshots
                .iter()
                .position(|cached| Arc::ptr_eq(cached.snapshot.charge(), quota))?;
            registry.snapshots.remove(victim);
        }
    }

    async fn snapshot(
        self: &Arc<Self>,
        key: RootKey,
        refresh: bool,
        requested_at: Instant,
        control: &SearchControl,
    ) -> Result<Option<(Arc<Snapshot>, Arc<Overlay>)>, String> {
        loop {
            if control.stopped() {
                return Ok(None);
            }
            let lease = {
                let mut registry = self.registry.lock().unwrap();
                registry.snapshots.retain(|cached| !cached.expired());
                registry
                    .failures
                    .retain(|_, (at, _)| at.elapsed() < ERROR_BACKOFF);
                let now = Instant::now();
                if let Some(index) = registry.snapshots.iter().position(|cached| {
                    cached.key == key && (!refresh || cached.fresh_as_of(now) >= requested_at)
                }) {
                    let item = registry.snapshots.remove(index).unwrap();
                    let found = (Arc::clone(&item.snapshot), Arc::clone(&item.overlay));
                    registry.snapshots.push_back(item);
                    return Ok(Some(found));
                }
                if let Some((_, error)) = registry.failures.get(&key) {
                    return Err(error.to_string());
                }
                let job = registry
                    .jobs
                    .get(&key)
                    .filter(|job| !job.control.stopped())
                    .cloned();
                let job = job.unwrap_or_else(|| {
                    let (result, _) = watch::channel(None);
                    // Linked roots live outside the watched tree.
                    let watch = key
                        .links
                        .is_empty()
                        .then(|| registry.watches.get(&key.path).copied())
                        .flatten();
                    let job = Arc::new(BuildJob {
                        control: SearchControl::default(),
                        watch,
                        started_at: Instant::now(),
                        pending: Mutex::new(Pending::default()),
                        users: AtomicUsize::new(0),
                        released: AtomicUsize::new(0),
                        linger: self.limits.linger,
                        result,
                    });
                    registry.jobs.insert(key.clone(), Arc::clone(&job));
                    self.start_build(key.clone(), Arc::clone(&job));
                    job
                });
                job.users.fetch_add(1, Ordering::AcqRel);
                BuildLease(job)
            };
            let mut result = lease.0.result.subscribe();
            let completed = loop {
                if let Some(done) = result.borrow().clone() {
                    break done;
                }
                tokio::select! {
                    biased;
                    _ = control.cancel.cancelled() => return Ok(None),
                    _ = tokio::time::sleep_until(control.deadline.into()) => return Ok(None),
                    changed = result.changed() => {
                        if changed.is_err() { return Err("Workspace discovery worker stopped".into()); }
                    }
                }
            };
            match completed {
                Ok(snapshot) => return Ok(Some((snapshot, Arc::default()))),
                Err(BuildError::Failed(error)) => return Err(error.to_string()),
                // A last-consumer cancellation racing a new query must not
                // strand that new query on the cancelled job's result.
                Err(BuildError::Cancelled) => continue,
            }
        }
    }

    fn start_build(self: &Arc<Self>, key: RootKey, job: Arc<BuildJob>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let permit = tokio::select! {
                biased;
                _ = job.control.cancel.cancelled() => None,
                _ = tokio::time::sleep_until(job.control.deadline.into()) => None,
                permit = service.discovery.clone().acquire_owned() => permit.ok(),
            };
            let result = if let Some(permit) = permit {
                let worker = Arc::clone(&service);
                let worker_key = key.clone();
                let worker_job = Arc::clone(&job);
                match tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    worker.build(&worker_key, &worker_job.control)
                })
                .await
                {
                    Ok(result) => result,
                    Err(error) => Err(BuildError::Failed(error.to_string().into())),
                }
            } else {
                Err(BuildError::Cancelled)
            };
            {
                let mut registry = service.registry.lock().unwrap();
                // A cancelled worker may finish after its successor. It owns
                // neither the successor's registry entry nor its generation.
                if registry
                    .jobs
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &job))
                {
                    registry.jobs.remove(&key);
                    if !job.control.stopped() {
                        match &result {
                            Ok(snapshot) => {
                                let pending = std::mem::take(&mut *job.pending.lock().unwrap());
                                // Ignore rules changed or events were lost during the walk:
                                // like a watched snapshot in that state, the result is not
                                // cached. Its waiters still receive it below.
                                if !pending.dirty {
                                    let covered = snapshot.watchable
                                        && job.watch.is_some()
                                        && registry.watches.get(&key.path) == job.watch.as_ref();
                                    // Never watched: the TTL counts from completion as before.
                                    // Watched, but the watch ended or was replaced: the walk
                                    // is only known current as of when it began.
                                    let fresh_base = if job.watch.is_none() {
                                        snapshot.built_at
                                    } else {
                                        job.started_at
                                    };
                                    registry.snapshots.retain(|cached| cached.key != key);
                                    registry.next_cached += 1;
                                    let id = registry.next_cached;
                                    registry.snapshots.push_back(Cached {
                                        id,
                                        key: key.clone(),
                                        snapshot: Arc::clone(snapshot),
                                        overlay: Arc::default(),
                                        covered,
                                        fresh_base,
                                    });
                                    while registry.snapshots.len() > service.limits.roots {
                                        registry.snapshots.pop_front();
                                    }
                                    // Changes made while the walk ran may or may not be in
                                    // it; re-reading them from disk is correct either way.
                                    if !pending.paths.is_empty() {
                                        service.send(WatchMessage::Changes(
                                            key.path.clone(),
                                            pending.paths.into_iter().collect(),
                                        ));
                                    }
                                }
                            }
                            Err(BuildError::Failed(error)) => {
                                registry
                                    .failures
                                    .retain(|_, (at, _)| at.elapsed() < ERROR_BACKOFF);
                                if registry.failures.len() >= MAX_CONSUMERS {
                                    if let Some(oldest) = registry
                                        .failures
                                        .iter()
                                        .min_by_key(|(_, (at, _))| *at)
                                        .map(|(root, _)| root.clone())
                                    {
                                        registry.failures.remove(&oldest);
                                    }
                                }
                                registry
                                    .failures
                                    .insert(key, (Instant::now(), Arc::clone(error)));
                            }
                            Err(BuildError::Cancelled) => {}
                        }
                    }
                }
            }
            job.result.send_replace(Some(result));
        });
    }

    fn build(&self, key: &RootKey, control: &SearchControl) -> BuildResult {
        if control.stopped() {
            return Err(BuildError::Cancelled);
        }
        // Reserve disk before writing, counting active snapshots and builds.
        // If active leases prevent admission, fail with backoff; never silently
        // restart an uncached full traversal for every keystroke.
        let mut disk = self
            .reserve(&self.disk, self.limits.disk_per_root)
            .ok_or_else(|| {
                BuildError::Failed("Workspace snapshot disk budget is in use; retry shortly".into())
            })?;
        // tempfile() is unlinked immediately on Unix and delete-on-close on
        // Windows. Cancellation, errors, eviction, and process exit all close
        // it without leaving named files to accumulate after crashes.
        let file = tempfile::tempfile().map_err(|e| BuildError::from(e.to_string()))?;
        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        let mut bytes = 0usize;
        let mut builder = Some(Builder::default());
        let mut error = None;
        let mut watchable = true;
        let root = Path::new(key.path());
        // Two discovery permits, each at most half the global build budget.
        let build_budget = self.limits.build / WORKERS;
        (self.walk)(key.path(), &mut |entry| {
            if control.stopped() {
                return false;
            }
            let len = entry.name.len().saturating_add(entry.path.len());
            if len > RECORD_BYTES
                || len.saturating_add(9) > self.limits.disk_per_root.saturating_sub(bytes)
            {
                error = Some("Workspace snapshot exceeded its disk budget".to_owned());
                return false;
            }
            let write = (|| -> io::Result<()> {
                writer.write_all(&(entry.name.len() as u32).to_le_bytes())?;
                writer.write_all(&(entry.path.len() as u32).to_le_bytes())?;
                writer.write_all(&[u8::from(entry.kind == WorkspaceEntryKind::Dir)])?;
                writer.write_all(entry.name.as_bytes())?;
                writer.write_all(entry.path.as_bytes())
            })();
            if let Err(e) = write {
                error = Some(e.to_string());
                return false;
            }
            bytes += len + 9;
            if watchable
                && entry.kind == WorkspaceEntryKind::Dir
                && unwatchable_rules(&root.join(&entry.path))
            {
                watchable = false;
            }
            if builder
                .as_mut()
                .is_some_and(|b| !b.push(&entry, build_budget))
            {
                builder = None;
            }
            true
        });
        if control.stopped() {
            return Err(BuildError::Cancelled);
        }
        if let Some(error) = error {
            return Err(error.into());
        }
        // Authorization/root ignore changes during discovery invalidate the
        // whole result instead of publishing a mixture of configurations.
        if RootKey::resolve(key.path()).map_err(BuildError::from)? != *key {
            return Err(BuildError::Failed(
                "Workspace configuration changed during discovery; retry".into(),
            ));
        }
        writer
            .flush()
            .map_err(|e| BuildError::from(e.to_string()))?;
        let storage = if let Some((index, charge)) = builder.and_then(|b| {
            let bytes = b.index.bytes();
            self.reserve(&self.memory, bytes)
                .map(|charge| (b.index, charge))
        }) {
            Storage::Memory {
                index,
                _charge: charge,
            }
        } else {
            disk.shrink(bytes);
            Storage::Disk {
                file: Arc::new(
                    writer
                        .into_inner()
                        .map_err(|e| BuildError::from(e.to_string()))?,
                ),
                bytes,
                _charge: disk,
            }
        };
        Ok(Arc::new(Snapshot {
            built_at: Instant::now(),
            storage,
            watchable,
        }))
    }

    pub(super) async fn search(
        self: &Arc<Self>,
        key: RootKey,
        options: SearchOptions<'_>,
        requested_at: Instant,
        control: Arc<SearchControl>,
    ) -> Result<Vec<WorkspaceFileEntry>, String> {
        let SearchOptions {
            query,
            limit,
            files_only,
            refresh,
        } = options;
        let empty = query.trim().is_empty();
        let query = query.to_owned();
        let snapshot = if empty {
            None
        } else {
            self.snapshot(key.clone(), refresh, requested_at, &control)
                .await?
        };
        if control.stopped() {
            return Ok(Vec::new());
        }
        let pool = if empty { &self.listing } else { &self.scoring };
        let permit = tokio::select! {
            biased;
            _ = control.cancel.cancelled() => return Ok(Vec::new()),
            _ = tokio::time::sleep_until(control.deadline.into()) => return Ok(Vec::new()),
            permit = pool.clone().acquire_owned() => permit.map_err(|e| e.to_string())?,
        };
        let service = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if let Some((snapshot, overlay)) = snapshot {
                snapshot.search(&query, limit, files_only, &control, &overlay)
            } else {
                let mut entries = Vec::new();
                (service.walk)(key.path(), &mut |entry| {
                    if control.stopped() {
                        return false;
                    }
                    if !files_only || entry.kind == WorkspaceEntryKind::File {
                        entries.push(entry);
                    }
                    entries.len() < limit
                });
                Ok(if control.stopped() {
                    Vec::new()
                } else {
                    entries
                })
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests;
