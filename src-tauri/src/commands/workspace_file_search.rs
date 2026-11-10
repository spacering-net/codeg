//! Keep workspace discovery and ranking out of the renderer. A workspace can
//! contain millions of non-ignored files: sending a flat list to each composer
//! multiplies path strings, lowercase copies and JS objects across webviews.

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap};
use std::mem::size_of;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::folders::{visit_workspace_files, WorkspaceEntryKind, WorkspaceFileEntry};
use crate::app_error::AppCommandError;

const MAX_RESULTS: usize = 200;
const INDEX_BYTES: usize = 128 * 1024 * 1024;
const BUILD_BYTES: usize = 192 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(300);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_CONSUMERS: usize = 128;
const NO_PARENT: u32 = u32::MAX;

#[derive(Clone, Copy)]
struct IndexBudget {
    build: usize,
    retained: usize,
}

const INDEX_BUDGET: IndexBudget = IndexBudget {
    build: BUILD_BYTES,
    retained: INDEX_BYTES,
};

// One workspace cache and one builder/search worker for the whole process,
// shared by every composer, dialog, desktop window and web client. Switching
// roots drops the previous index before building the next one.
static CACHE: LazyLock<Mutex<Option<CachedIndex>>> = LazyLock::new(|| Mutex::new(None));
static SEARCHES: LazyLock<StdMutex<Searches>> =
    LazyLock::new(|| StdMutex::new(Searches::default()));

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub consumer_id: String,
    pub generation: u64,
}

struct Consumer {
    generation: u64,
    cancel: CancellationToken,
    touched: Instant,
    active: bool,
}

#[derive(Default)]
struct Searches(HashMap<String, Consumer>);

impl Searches {
    fn register(
        &mut self,
        request: &SearchRequest,
        cancel: bool,
    ) -> Result<Option<CancellationToken>, AppCommandError> {
        if request.consumer_id.is_empty() || request.consumer_id.len() > 128 {
            return Err(AppCommandError::invalid_input("Invalid search consumer"));
        }
        self.0
            .retain(|_, c| c.active || c.touched.elapsed() < SEARCH_TIMEOUT);
        if let Some(previous) = self.0.get(&request.consumer_id) {
            if request.generation <= previous.generation {
                if cancel && request.generation == previous.generation {
                    previous.cancel.cancel();
                }
                return Ok(None);
            }
            previous.cancel.cancel();
        } else if self.0.len() >= MAX_CONSUMERS {
            // Retain active consumers; bound completed generation tombstones
            // too. Tombstones handle cancellation arriving before its request.
            let oldest = self
                .0
                .iter()
                .filter(|(_, c)| !c.active)
                .min_by_key(|(_, c)| c.touched)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.0.remove(&oldest);
            } else {
                return Err(AppCommandError::task_execution_failed(
                    "Too many workspace file searches",
                ));
            }
        }
        let token = CancellationToken::new();
        if cancel {
            token.cancel();
        }
        self.0.insert(
            request.consumer_id.clone(),
            Consumer {
                generation: request.generation,
                cancel: token.clone(),
                touched: Instant::now(),
                active: !cancel,
            },
        );
        Ok(Some(token))
    }
}

struct SearchControl {
    cancel: CancellationToken,
    deadline: Instant,
}

impl Default for SearchControl {
    fn default() -> Self {
        Self {
            cancel: CancellationToken::new(),
            deadline: Instant::now() + SEARCH_TIMEOUT,
        }
    }
}

impl SearchControl {
    fn stopped(&self) -> bool {
        self.cancel.is_cancelled() || Instant::now() >= self.deadline
    }
}

struct ActiveSearch {
    request: SearchRequest,
    control: SearchControl,
}

impl Drop for ActiveSearch {
    fn drop(&mut self) {
        self.control.cancel.cancel();
        if let Some(consumer) = SEARCHES
            .lock()
            .unwrap()
            .0
            .get_mut(&self.request.consumer_id)
        {
            if consumer.generation == self.request.generation {
                consumer.active = false;
                consumer.touched = Instant::now();
            }
        }
    }
}

struct CachedIndex {
    root: String,
    built_at: Instant,
    index: Option<CompactIndex>,
}

// Store each basename once and each parent as a small integer. In a workspace
// containing many checkouts/archives this avoids retaining the same long path
// prefix (and basename) millions of times.
#[derive(Clone, Copy)]
struct Node {
    parent: u32,
    name: u32,
    is_dir: bool,
}

struct IndexedName {
    text: Arc<str>,
    lower: String,
    utf16_len: usize,
    byte_mask: u64,
}

fn byte_mask(text: &str) -> u64 {
    text.bytes().fold(0, |mask, byte| mask | (1 << (byte % 64)))
}

#[derive(Default)]
struct CompactIndex {
    nodes: Vec<Node>,
    names: Vec<IndexedName>,
    string_bytes: usize,
}

impl CompactIndex {
    fn bytes(&self) -> usize {
        self.nodes.capacity() * size_of::<Node>()
            + self.names.capacity() * size_of::<IndexedName>()
            + self.string_bytes
    }

    fn search(
        &self,
        query: &str,
        limit: usize,
        files_only: bool,
        control: &SearchControl,
    ) -> Vec<WorkspaceFileEntry> {
        let mut matches = Matches::new(query, limit, files_only);
        // Repeated basenames share normalization and name-tier scoring too.
        // A full set of name matches outranks every path/subsequence match.
        let name_scores: Vec<_> = self
            .names
            .iter()
            .map(|name| score_name(&matches.query, &name.lower, name.utf16_len))
            .collect();
        let query_mask = matches.query.is_ascii().then(|| byte_mask(&matches.query));
        let mut ancestors: Vec<(u32, usize, usize, u64)> = Vec::new();
        let mut path = String::new();
        let mut lower_path = String::new();
        for (id, node) in self.nodes.iter().enumerate() {
            if control.stopped() {
                return Vec::new();
            }
            while ancestors.last().map(|(id, ..)| *id).unwrap_or(NO_PARENT) != node.parent {
                ancestors.pop();
                path.truncate(ancestors.last().map(|(_, len, ..)| *len).unwrap_or(0));
                lower_path.truncate(ancestors.last().map(|(_, _, len, _)| *len).unwrap_or(0));
            }
            let parent_len = path.len();
            let lower_parent_len = lower_path.len();
            let name = &self.names[node.name as usize];
            let mask = ancestors.last().map(|(_, _, _, mask)| *mask).unwrap_or(0)
                | name.byte_mask
                | if parent_len > 0 { byte_mask("/") } else { 0 };
            let name_score = name_scores[node.name as usize];
            let may_match = (!files_only || !node.is_dir)
                && match name_score {
                    Some(score) => matches.accepts(score, id),
                    None => {
                        matches.needs_path_matches()
                            && query_mask.is_none_or(|query| mask & query == query)
                    }
                };
            // Directories still maintain the prefix for descendants; rejected
            // files need no full path, lowercase allocation or UTF-16 scan.
            if !node.is_dir && !may_match {
                continue;
            }
            if !path.is_empty() {
                path.push('/');
                lower_path.push('/');
            }
            path.push_str(&name.text);
            lower_path.push_str(&name.lower);
            if may_match {
                let score = name_score.or_else(|| {
                    score_path(&matches.query, &name.lower, name.utf16_len, &lower_path)
                });
                if let Some(score) = score {
                    matches.offer_ranked(&name.text, &path, node.is_dir, id, score);
                }
            }
            if node.is_dir {
                ancestors.push((id as u32, path.len(), lower_path.len(), mask));
            } else {
                path.truncate(parent_len);
                lower_path.truncate(lower_parent_len);
            }
        }
        matches.finish()
    }
}

#[derive(Default)]
struct Builder {
    index: CompactIndex,
    names: HashMap<Arc<str>, u32>,
    parents: Vec<u32>,
}

impl Builder {
    fn push(&mut self, entry: &WorkspaceFileEntry, budget: usize) -> bool {
        // Account for capacity growth before reserving it. The interning table
        // exists only during the build; it is dropped before caching the index.
        let new_name = !self.names.contains_key(entry.name.as_str());
        let extra_nodes = if self.index.nodes.len() == self.index.nodes.capacity() {
            4096 * size_of::<Node>()
        } else {
            0
        };
        let extra_names = if new_name && self.index.names.len() == self.index.names.capacity() {
            1024 * size_of::<IndexedName>()
        } else {
            0
        };
        let table_capacity = if new_name && self.names.len() == self.names.capacity() {
            (self.names.capacity().max(4) * 2).max(self.names.len() + 1)
        } else {
            self.names.capacity()
        };
        // HashMap capacity excludes empty buckets/control bytes. Round up and
        // include Arc's allocation header/alignment for each interned string.
        let table_bytes = table_capacity * (size_of::<(Arc<str>, u32)>() + 1) * 8 / 7 + 32;
        let lower = new_name.then(|| entry.name.to_lowercase());
        let string_bytes = lower
            .as_ref()
            .map(|lower| entry.name.len() + 32 + lower.capacity() + 16)
            .unwrap_or(0);
        if self.index.bytes() + extra_nodes + extra_names + table_bytes + string_bytes > budget
            || self.index.nodes.len() >= u32::MAX as usize
        {
            return false;
        }
        if extra_nodes != 0 {
            self.index.nodes.reserve_exact(4096);
        }
        if extra_names != 0 {
            self.index.names.reserve_exact(1024);
        }
        let name = match self.names.get(entry.name.as_str()) {
            Some(id) => *id,
            None => {
                let id = self.index.names.len() as u32;
                let name: Arc<str> = Arc::from(entry.name.as_str());
                self.names.insert(Arc::clone(&name), id);
                let lower = lower.unwrap();
                self.index.names.push(IndexedName {
                    utf16_len: lower.encode_utf16().count(),
                    byte_mask: byte_mask(&lower),
                    text: name,
                    lower,
                });
                self.index.string_bytes += string_bytes;
                id
            }
        };
        let depth = entry.path.bytes().filter(|c| *c == b'/').count();
        self.parents.truncate(depth);
        if self.parents.len() != depth {
            return false;
        }
        let id = self.index.nodes.len() as u32;
        self.index.nodes.push(Node {
            parent: self.parents.last().copied().unwrap_or(NO_PARENT),
            name,
            is_dir: entry.kind == WorkspaceEntryKind::Dir,
        });
        if entry.kind == WorkspaceEntryKind::Dir {
            self.parents.push(id);
        }
        true
    }
}

struct Ranked {
    score: i64,
    order: usize,
    entry: WorkspaceFileEntry,
}

impl PartialEq for Ranked {
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score && self.order == other.order
    }
}
impl Eq for Ranked {}
impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Ranked {
    fn cmp(&self, other: &Self) -> Ordering {
        self.score
            .cmp(&other.score)
            .then_with(|| other.order.cmp(&self.order))
    }
}

struct Matches {
    query: String,
    limit: usize,
    files_only: bool,
    best: BinaryHeap<Reverse<Ranked>>,
}

impl Matches {
    fn new(query: &str, limit: usize, files_only: bool) -> Self {
        Self {
            query: query.trim().to_lowercase(),
            limit,
            files_only,
            best: BinaryHeap::new(),
        }
    }

    fn offer(&mut self, name: &str, path: &str, is_dir: bool, order: usize) {
        if self.limit == 0 || (self.files_only && is_dir) {
            return;
        }
        let Some(score) = score_file(&self.query, name, path) else {
            return;
        };
        self.offer_ranked(name, path, is_dir, order, score);
    }

    fn accepts(&self, score: i64, order: usize) -> bool {
        self.limit != 0
            && (self.best.len() < self.limit
                || self.best.peek().is_some_and(|worst| {
                    score > worst.0.score || (score == worst.0.score && order < worst.0.order)
                }))
    }

    fn needs_path_matches(&self) -> bool {
        self.limit != 0
            && (self.best.len() < self.limit
                || self
                    .best
                    .peek()
                    .is_some_and(|worst| worst.0.score < 300_000_000))
    }

    fn offer_ranked(&mut self, name: &str, path: &str, is_dir: bool, order: usize, score: i64) {
        if !self.accepts(score, order) {
            return;
        }
        self.best.push(Reverse(Ranked {
            score,
            order,
            entry: WorkspaceFileEntry {
                name: name.to_owned(),
                path: path.to_owned(),
                kind: if is_dir {
                    WorkspaceEntryKind::Dir
                } else {
                    WorkspaceEntryKind::File
                },
            },
        }));
        if self.best.len() > self.limit {
            self.best.pop();
        }
    }

    fn finish(self) -> Vec<WorkspaceFileEntry> {
        let mut best = self.best.into_iter().map(|r| r.0).collect::<Vec<_>>();
        best.sort_by(|a, b| b.cmp(a));
        best.into_iter().map(|r| r.entry).collect()
    }
}

fn tier_score(tier: i64, position: usize, length: usize) -> i64 {
    tier * 100_000_000 - position.min(9999) as i64 * 1000 - length.min(999) as i64
}

fn subsequence(query: &str, text: &str) -> Option<usize> {
    let mut query = query.encode_utf16().peekable();
    let mut first = None;
    for (i, ch) in text.encode_utf16().enumerate() {
        if query.peek() == Some(&ch) {
            first.get_or_insert(i);
            query.next();
            if query.peek().is_none() {
                return first;
            }
        }
    }
    None
}

// Same tiers and UTF-16 positions/lengths as lib/file-search-match.ts.
fn score_file(query: &str, name: &str, path: &str) -> Option<i64> {
    let name = name.to_lowercase();
    let name_len = name.encode_utf16().count();
    score_name(query, &name, name_len)
        .or_else(|| score_path(query, &name, name_len, &path.to_lowercase()))
}

fn score_name(query: &str, name: &str, name_len: usize) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    if name == query {
        return Some(tier_score(6, 0, name_len));
    }
    if name.starts_with(query) {
        return Some(tier_score(5, 0, name_len));
    }
    if let Some(i) = name.find(query) {
        return Some(tier_score(4, name[..i].encode_utf16().count(), name_len));
    }
    None
}

fn score_path(query: &str, name: &str, name_len: usize, path: &str) -> Option<i64> {
    let path_len = path.encode_utf16().count();
    if let Some(i) = path.find(query) {
        return Some(tier_score(3, path[..i].encode_utf16().count(), path_len));
    }
    if let Some(i) = subsequence(query, name) {
        return Some(tier_score(2, i, name_len));
    }
    subsequence(query, path).map(|i| tier_score(1, i, path_len))
}

#[derive(Clone, Copy)]
struct SearchOptions<'a> {
    query: &'a str,
    limit: usize,
    files_only: bool,
    refresh: bool,
}

fn search_or_build(
    cache: &mut Option<CachedIndex>,
    root: String,
    options: SearchOptions<'_>,
    budget: IndexBudget,
    control: &SearchControl,
) -> Vec<WorkspaceFileEntry> {
    let SearchOptions {
        query,
        limit,
        files_only,
        refresh,
    } = options;
    if control.stopped() {
        return Vec::new();
    }
    let fresh = cache
        .as_ref()
        .is_some_and(|c| c.root == root && c.built_at.elapsed() < CACHE_TTL);
    if fresh && !refresh {
        if limit == 0 {
            return Vec::new();
        }
        if let Some(index) = cache.as_ref().and_then(|c| c.index.as_ref()) {
            return index.search(query, limit, files_only, control);
        }
    }
    let should_build = !fresh || refresh;
    if should_build {
        *cache = None;
    }
    let mut builder = should_build.then(Builder::default);
    let mut matches = Matches::new(query, limit, files_only);
    let mut order = 0;
    visit_workspace_files(&root, |entry| {
        if control.stopped() {
            return false;
        }
        matches.offer(
            &entry.name,
            &entry.path,
            entry.kind == WorkspaceEntryKind::Dir,
            order,
        );
        order += 1;
        if builder
            .as_mut()
            .is_some_and(|b| !b.push(&entry, budget.build))
        {
            builder = None;
        }
        // A warmup can stop once the budget is exhausted. A real search keeps
        // walking and ranking so a late/deep exact match is never omitted.
        builder.is_some() || limit != 0
    });
    if control.stopped() {
        // A partial traversal must never become a fresh, incomplete index.
        return Vec::new();
    }
    if should_build {
        let index = builder
            .map(|b| b.index)
            .filter(|i| i.bytes() <= budget.retained);
        *cache = Some(CachedIndex {
            root,
            built_at: Instant::now(),
            index,
        });
    }
    matches.finish()
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn search_workspace_files(
    path: String,
    query: String,
    limit: Option<usize>,
    files_only: Option<bool>,
    refresh: Option<bool>,
    request: Option<SearchRequest>,
) -> Result<Vec<WorkspaceFileEntry>, AppCommandError> {
    let requested_at = Instant::now();
    if path.trim().is_empty() || query.len() > 2048 {
        return Err(AppCommandError::invalid_input(
            "Invalid workspace file search",
        ));
    }
    let limit = limit.unwrap_or(100).clamp(1, MAX_RESULTS);
    let files_only = files_only.unwrap_or(false);
    // Register before admission: a newer generation cancels both queued and
    // running work for this consumer, without affecting another picker/client.
    let request = request.unwrap_or_else(|| SearchRequest {
        consumer_id: uuid::Uuid::new_v4().to_string(),
        generation: 0,
    });
    let cancel = match SEARCHES.lock().unwrap().register(&request, false)? {
        Some(token) => token,
        None => return Ok(Vec::new()),
    };
    let search = ActiveSearch {
        request,
        control: SearchControl {
            cancel,
            deadline: requested_at + SEARCH_TIMEOUT,
        },
    };
    let mut cache = tokio::select! {
        biased;
        _ = search.control.cancel.cancelled() => return Ok(Vec::new()),
        _ = tokio::time::sleep_until(search.control.deadline.into()) => {
            return Err(AppCommandError::task_execution_failed("Workspace file search timed out"));
        }
        cache = CACHE.lock() => cache,
    };
    // A warmup or another refresh may have rebuilt the index while this
    // request waited. Reuse that newer snapshot instead of scanning twice.
    let refresh =
        refresh.unwrap_or(false) && cache.as_ref().is_none_or(|c| c.built_at < requested_at);
    tokio::task::spawn_blocking(move || {
        let control = &search.control;
        let results = if query.trim().is_empty() {
            // Even files-only listings can walk an entire tree of directories.
            // They share the worker, cancellation and deadline with searches.
            let mut entries = Vec::new();
            visit_workspace_files(&path, |entry| {
                if control.stopped() {
                    return false;
                }
                if !files_only || entry.kind == WorkspaceEntryKind::File {
                    entries.push(entry);
                }
                entries.len() < limit
            });
            entries
        } else {
            search_or_build(
                &mut cache,
                path,
                SearchOptions {
                    query: &query,
                    limit,
                    files_only,
                    refresh,
                },
                INDEX_BUDGET,
                control,
            )
        };
        if Instant::now() >= control.deadline {
            Err(AppCommandError::task_execution_failed(
                "Workspace file search timed out",
            ))
        } else if control.cancel.is_cancelled() {
            Ok(Vec::new())
        } else {
            Ok(results)
        }
    })
    .await
    .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn cancel_workspace_file_search(request: SearchRequest) -> Result<(), AppCommandError> {
    SEARCHES.lock().unwrap().register(&request, true)?;
    Ok(())
}

/// Compatibility endpoint for older clients. Discovery is now owned by an
/// actual foreground query and its cancellation token; mounting a composer
/// must never start an uncancellable full-workspace traversal.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn prepare_workspace_file_search(path: String) {
    drop(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_search(
        cache: &mut Option<CachedIndex>,
        root: String,
        query: &str,
        limit: usize,
        files_only: bool,
        refresh: bool,
        budget: IndexBudget,
    ) -> Vec<WorkspaceFileEntry> {
        search_or_build(
            cache,
            root,
            SearchOptions {
                query,
                limit,
                files_only,
                refresh,
            },
            budget,
            &SearchControl::default(),
        )
    }

    fn file(path: &str, is_dir: bool) -> WorkspaceFileEntry {
        WorkspaceFileEntry {
            name: path.rsplit('/').next().unwrap().into(),
            path: path.into(),
            kind: if is_dir {
                WorkspaceEntryKind::Dir
            } else {
                WorkspaceEntryKind::File
            },
        }
    }

    #[test]
    fn compact_index_preserves_paths_and_rank_order() {
        let entries = [
            file("a", true),
            file("a/deep", true),
            file("a/deep/target.ts", false),
            file("a/target-extra.ts", false),
            file("b", true),
            file("b/target.ts", false),
        ];
        let mut builder = Builder::default();
        let mut matches = Matches::new("target", 3, false);
        for (i, e) in entries.iter().enumerate() {
            assert!(builder.push(e, BUILD_BYTES));
            matches.offer(&e.name, &e.path, e.kind == WorkspaceEntryKind::Dir, i);
        }
        assert_eq!(
            builder
                .index
                .search("target", 3, false, &SearchControl::default()),
            matches.finish()
        );
        assert_eq!(
            builder
                .index
                .search("", 100, false, &SearchControl::default()),
            entries
        );
    }

    #[test]
    fn scores_match_frontend_tiers_and_utf16_offsets() {
        assert_eq!(score_file("foo", "FOO", "a/FOO"), Some(599_999_997));
        assert_eq!(score_file("foo", "foo-long", "foo-long"), Some(499_999_992));
        assert_eq!(score_file("foo", "😀foo", "😀foo"), Some(399_997_995));
        assert!(score_file("fbr", "FooBar.rs", "src/FooBar.rs").is_some());
        assert_eq!(score_file("xyz", "abc", "src/abc"), None);
    }

    #[test]
    fn compact_search_pruning_preserves_path_unicode_and_subsequence_matches() {
        let entries = [
            file("foo", true),
            file("foo/deep", true),
            file("foo/deep/😀FooBar.rs", false),
            file("foo/deep/README.md", false),
            file("foo/README.md", false),
            file("src", true),
            file("src/ab", true),
            file("src/ab/README.md", false),
            file("src/ab/İstanbul.ts", false),
            file("src/FooBar.rs", false),
            file("src/éclair.ts", false),
        ];
        let mut builder = Builder::default();
        for entry in &entries {
            assert!(builder.push(entry, BUILD_BYTES));
        }
        for query in ["", "README.md", "src/ab", "/", "fbr", "😀", "é", "İ"] {
            for limit in [1, 3, 100] {
                for files_only in [false, true] {
                    let mut expected = Matches::new(query, limit, files_only);
                    for (i, entry) in entries.iter().enumerate() {
                        expected.offer(
                            &entry.name,
                            &entry.path,
                            entry.kind == WorkspaceEntryKind::Dir,
                            i,
                        );
                    }
                    assert_eq!(
                        builder
                            .index
                            .search(query, limit, files_only, &SearchControl::default()),
                        expected.finish(),
                        "query={query:?}, limit={limit}, files_only={files_only}"
                    );
                }
            }
        }
    }

    #[test]
    fn result_budget_keeps_late_exact_match_and_stable_ties() {
        let mut matches = Matches::new("needle", 2, false);
        for i in 0..1000 {
            matches.offer("needle-extra", &format!("{i}/needle-extra"), false, i);
        }
        matches.offer("needle", "very/deep/needle", false, 1000);
        assert_eq!(matches.best.len(), 2);
        let best = matches.finish();
        assert_eq!(best[0].path, "very/deep/needle");
        assert_eq!(best[1].path, "0/needle-extra");
    }

    #[test]
    fn budget_fallback_still_searches_the_entire_workspace() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..100 {
            std::fs::write(dir.path().join(format!("a{i:03}.txt")), "x").unwrap();
        }
        std::fs::create_dir_all(dir.path().join("z/deep")).unwrap();
        std::fs::write(dir.path().join("z/deep/needle.txt"), "x").unwrap();
        let mut cache = None;
        let root = dir.path().to_string_lossy().into_owned();
        let budget = IndexBudget {
            build: 1024,
            retained: 1024,
        };
        let best = run_search(&mut cache, root.clone(), "needle", 1, true, false, budget);
        assert_eq!(best[0].path, "z/deep/needle.txt");
        assert!(cache.as_ref().unwrap().index.is_none());
        assert_eq!(
            run_search(&mut cache, root, "needle", 1, true, false, budget),
            best
        );
    }

    #[test]
    fn budget_fallback_preserves_failed_build_ttl_and_eventually_retries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("needle.txt"), "x").unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut cache = None;
        run_search(
            &mut cache,
            root.clone(),
            "needle",
            1,
            true,
            false,
            IndexBudget {
                build: 1024,
                retained: 1024,
            },
        );
        let marker = Instant::now() - Duration::from_secs(290);
        cache.as_mut().unwrap().built_at = marker;
        for _ in 0..3 {
            let result = run_search(
                &mut cache,
                root.clone(),
                "needle",
                1,
                true,
                false,
                INDEX_BUDGET,
            );
            assert_eq!(result[0].path, "needle.txt");
            assert_eq!(cache.as_ref().unwrap().built_at, marker);
            assert!(cache.as_ref().unwrap().index.is_none());
        }
        cache.as_mut().unwrap().built_at = Instant::now() - CACHE_TTL;
        run_search(&mut cache, root, "needle", 1, true, false, INDEX_BUDGET);
        assert!(cache.as_ref().unwrap().index.is_some());
    }

    fn request(consumer: &str, generation: u64) -> SearchRequest {
        SearchRequest {
            consumer_id: consumer.into(),
            generation,
        }
    }

    #[test]
    fn superseding_requests_cancel_only_their_own_consumer_and_reject_old_generations() {
        let mut searches = Searches::default();
        let first = searches
            .register(&request("picker", 1), false)
            .unwrap()
            .unwrap();
        let other = searches
            .register(&request("other-client", 1), false)
            .unwrap()
            .unwrap();
        let latest = searches
            .register(&request("picker", 3), false)
            .unwrap()
            .unwrap();
        assert!(first.is_cancelled());
        assert!(!other.is_cancelled());
        assert!(searches
            .register(&request("picker", 2), false)
            .unwrap()
            .is_none());
        searches.register(&request("picker", 1), true).unwrap();
        assert!(!latest.is_cancelled());
        searches.register(&request("picker", 3), true).unwrap();
        assert!(latest.is_cancelled());
        searches
            .register(&request("before-arrival", 2), true)
            .unwrap();
        assert!(searches
            .register(&request("before-arrival", 2), false)
            .unwrap()
            .is_none());
    }

    #[test]
    fn search_admission_and_completed_consumer_markers_are_bounded() {
        let mut searches = Searches::default();
        for i in 0..MAX_CONSUMERS {
            searches
                .register(&request(&i.to_string(), 1), false)
                .unwrap();
        }
        assert!(searches.register(&request("overflow", 1), false).is_err());
        searches.0.get_mut("0").unwrap().active = false;
        searches.register(&request("overflow", 1), false).unwrap();
        assert_eq!(searches.0.len(), MAX_CONSUMERS);
    }

    #[test]
    fn canceled_or_expired_searches_do_not_replace_a_cached_index() {
        let mut cache = Some(CachedIndex {
            root: "existing".into(),
            built_at: Instant::now(),
            index: None,
        });
        let canceled = SearchControl::default();
        canceled.cancel.cancel();
        let expired = SearchControl {
            deadline: Instant::now() - Duration::from_secs(1),
            ..SearchControl::default()
        };
        for control in [canceled, expired] {
            assert!(search_or_build(
                &mut cache,
                "replacement".into(),
                SearchOptions {
                    query: "needle",
                    limit: 1,
                    files_only: true,
                    refresh: true
                },
                INDEX_BUDGET,
                &control,
            )
            .is_empty());
            assert_eq!(cache.as_ref().unwrap().root, "existing");
        }
    }

    #[tokio::test]
    async fn empty_query_shares_admission_and_can_cancel_while_waiting() {
        let cache = CACHE.lock().await;
        let request = request(&uuid::Uuid::new_v4().to_string(), 1);
        let search_request = request.clone();
        let task = tokio::spawn(search_workspace_files(
            "/unused-because-canceled".into(),
            "".into(),
            Some(200),
            Some(true),
            None,
            Some(search_request),
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if SEARCHES
                    .lock()
                    .unwrap()
                    .0
                    .contains_key(&request.consumer_id)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            !task.is_finished(),
            "empty queries must wait for the shared worker"
        );
        cancel_workspace_file_search(request).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(result.is_empty());
        drop(cache);
    }

    #[tokio::test]
    async fn newer_generation_coalesces_a_queued_search_before_it_can_traverse() {
        let cache = CACHE.lock().await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("latest.txt"), "x").unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let first = request(&uuid::Uuid::new_v4().to_string(), 1);
        let latest = request(&first.consumer_id, 2);
        let old_task = tokio::spawn(search_workspace_files(
            root.clone(),
            "obsolete".into(),
            None,
            None,
            None,
            Some(first.clone()),
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            while !SEARCHES.lock().unwrap().0.contains_key(&first.consumer_id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let latest_task = tokio::spawn(search_workspace_files(
            root,
            "latest".into(),
            None,
            None,
            None,
            Some(latest),
        ));
        // The old request completes while the worker is still held: it never
        // starts a superseded traversal or waits for the newer one's scan.
        assert!(tokio::time::timeout(Duration::from_secs(1), old_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .is_empty());
        assert!(!latest_task.is_finished());
        drop(cache);
        let results = latest_task.await.unwrap().unwrap();
        assert_eq!(results[0].path, "latest.txt");
    }

    #[test]
    fn refresh_and_root_changes_replace_cached_entries() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        std::fs::write(first.path().join("old.ts"), "x").unwrap();
        std::fs::write(second.path().join("other.ts"), "x").unwrap();
        let mut cache = None;
        let root = first.path().to_string_lossy().into_owned();
        run_search(&mut cache, root.clone(), "", 0, false, false, INDEX_BUDGET);
        std::fs::write(first.path().join("new.ts"), "x").unwrap();
        assert!(run_search(
            &mut cache,
            root.clone(),
            "new",
            10,
            true,
            false,
            INDEX_BUDGET
        )
        .is_empty());
        assert_eq!(
            run_search(&mut cache, root, "new", 10, true, true, INDEX_BUDGET)[0].path,
            "new.ts"
        );
        let result = run_search(
            &mut cache,
            second.path().to_string_lossy().into_owned(),
            "ts",
            10,
            true,
            false,
            INDEX_BUDGET,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "other.ts");
        assert!(cache.as_ref().unwrap().index.as_ref().unwrap().bytes() <= INDEX_BYTES);
    }

    #[tokio::test]
    async fn api_caps_empty_query_and_keeps_files_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("a-directory")).unwrap();
        for i in 0..300 {
            std::fs::write(dir.path().join(format!("f{i:03}.txt")), "x").unwrap();
        }
        let results = search_workspace_files(
            dir.path().to_string_lossy().into_owned(),
            "".into(),
            Some(usize::MAX),
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(results.len(), MAX_RESULTS);
        assert!(results.iter().all(|e| e.kind == WorkspaceEntryKind::File));
    }

    /// Manual end-to-end probe for unusually large workspaces. The path stays
    /// local; output contains counts/budgets/timings rather than filenames.
    #[test]
    #[ignore = "set CODEG_MEMORY_WORKSPACE to profile a real workspace"]
    fn large_workspace_memory_probe() {
        let root = std::env::var("CODEG_MEMORY_WORKSPACE").expect("CODEG_MEMORY_WORKSPACE");
        let started = Instant::now();
        let mut cache = None;
        println!("probe_pid={}", std::process::id());
        run_search(&mut cache, root.clone(), "", 0, false, false, INDEX_BUDGET);
        let warm_seconds = started.elapsed().as_secs_f64();
        let stats = cache.as_ref().and_then(|c| c.index.as_ref()).map(|i| {
            serde_json::json!({"entries":i.nodes.len(),"uniqueNames":i.names.len(),"retainedBytes":i.bytes()})
        });
        println!(
            "{}",
            serde_json::json!({"warmSeconds":warm_seconds,"index":stats})
        );
        for query in ["README.md", "index.ts", "workspace_file_search"] {
            let started = Instant::now();
            let results = run_search(
                &mut cache,
                root.clone(),
                query,
                100,
                true,
                false,
                INDEX_BUDGET,
            );
            assert!(results.len() <= 100);
            println!(
                "{}",
                serde_json::json!({"query":query,"results":results.len(),"responseBytes":serde_json::to_vec(&results).unwrap().len(),"seconds":started.elapsed().as_secs_f64()})
            );
        }
    }
}
