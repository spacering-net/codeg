//! Short-lived registry locks, coalesced query-owned discovery, and a global
//! LRU budget. Oversized roots use an unnamed temporary file: subsequent
//! searches read this complete snapshot, never walk the filesystem again.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::{watch, Semaphore};

use super::super::folders::authorized_links_in;
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
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            memory: INDEX_BYTES,
            build: BUILD_BYTES,
            disk: DISK_BYTES,
            disk_per_root: SNAPSHOT_DISK_BYTES,
            roots: ROOT_LIMIT,
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
}

impl Snapshot {
    fn search(
        &self,
        query: &str,
        limit: usize,
        files_only: bool,
        control: &SearchControl,
    ) -> Result<Vec<WorkspaceFileEntry>, String> {
        match &self.storage {
            Storage::Memory { index, .. } => Ok(index.search(query, limit, files_only, control)),
            Storage::Disk { file, bytes, .. } => {
                let mut reader = BufReader::with_capacity(
                    64 * 1024,
                    PositionedReader {
                        file: Arc::clone(file),
                        offset: 0,
                    },
                );
                let mut matches = Matches::new(query, limit, files_only);
                let mut read = 0;
                let mut order = 0;
                // Positional reads give every query an independent cursor;
                // File::try_clone + seek would share offsets on Unix.
                while read < *bytes {
                    if control.stopped() {
                        return Ok(Vec::new());
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
                Ok(matches.finish())
            }
        }
    }
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
    users: AtomicUsize,
    result: watch::Sender<Option<BuildResult>>,
}

struct BuildLease(Arc<BuildJob>);

impl Drop for BuildLease {
    fn drop(&mut self) {
        if self.0.users.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.control.cancel.cancel();
        }
    }
}

#[derive(Default)]
struct Registry {
    // Front is least recently used. Only complete snapshots are published.
    snapshots: VecDeque<(RootKey, Arc<Snapshot>)>,
    jobs: HashMap<RootKey, Arc<BuildJob>>,
    failures: HashMap<RootKey, (Instant, Arc<str>)>,
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
        })
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
            // about the process-wide total to admit a new allocation.
            registry.snapshots.pop_front()?;
        }
    }

    async fn snapshot(
        self: &Arc<Self>,
        key: RootKey,
        refresh: bool,
        requested_at: Instant,
        control: &SearchControl,
    ) -> Result<Option<Arc<Snapshot>>, String> {
        loop {
            if control.stopped() {
                return Ok(None);
            }
            let lease =
                {
                    let mut registry = self.registry.lock().unwrap();
                    registry
                        .snapshots
                        .retain(|(_, s)| s.built_at.elapsed() < CACHE_TTL);
                    registry
                        .failures
                        .retain(|_, (at, _)| at.elapsed() < ERROR_BACKOFF);
                    if let Some(index) = registry.snapshots.iter().position(|(root, s)| {
                        root == &key && (!refresh || s.built_at >= requested_at)
                    }) {
                        let item = registry.snapshots.remove(index).unwrap();
                        let snapshot = Arc::clone(&item.1);
                        registry.snapshots.push_back(item);
                        return Ok(Some(snapshot));
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
                        let job = Arc::new(BuildJob {
                            control: SearchControl::default(),
                            users: AtomicUsize::new(0),
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
                Ok(snapshot) => return Ok(Some(snapshot)),
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
                                registry.snapshots.retain(|(root, _)| root != &key);
                                registry
                                    .snapshots
                                    .push_back((key.clone(), Arc::clone(snapshot)));
                                while registry.snapshots.len() > service.limits.roots {
                                    registry.snapshots.pop_front();
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
            if let Some(snapshot) = snapshot {
                snapshot.search(&query, limit, files_only, &control)
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
