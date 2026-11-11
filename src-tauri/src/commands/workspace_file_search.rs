//! Keep workspace discovery and ranking out of the renderer. A workspace can
//! contain millions of non-ignored files: sending a flat list to each composer
//! multiplies path strings, lowercase copies and JS objects across webviews.

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap};
use std::mem::size_of;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
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

mod index_cache;
use index_cache::{IndexService, Overlay, RootKey};

static INDEXES: LazyLock<Arc<IndexService>> = LazyLock::new(IndexService::production);
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
    control: Arc<SearchControl>,
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

    #[cfg(test)]
    fn search(
        &self,
        query: &str,
        limit: usize,
        files_only: bool,
        control: &SearchControl,
    ) -> Vec<WorkspaceFileEntry> {
        let mut matches = Matches::new(query, limit, files_only);
        if self.scan(&mut matches, control) {
            matches.finish()
        } else {
            Vec::new()
        }
    }

    /// Offer every indexed entry to `matches`; false when stopped early.
    fn scan(&self, matches: &mut Matches, control: &SearchControl) -> bool {
        // Repeated basenames share normalization and name-tier scoring too.
        // A full set of name matches outranks every path/subsequence match.
        // A cache sized by all unique names would multiply scratch memory by
        // each concurrent query. Cache only a fixed number of basename scores.
        let mut name_scores = HashMap::new();
        let query_mask = matches.query.is_ascii().then(|| byte_mask(&matches.query));
        let mut ancestors: Vec<(u32, usize, usize, u64)> = Vec::new();
        let mut path = String::new();
        let mut lower_path = String::new();
        for (id, node) in self.nodes.iter().enumerate() {
            if control.stopped() {
                return false;
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
            let name_score = *name_scores
                .entry(node.name)
                .or_insert_with(|| score_name(&matches.query, &name.lower, name.utf16_len));
            if name_scores.len() >= 4096 {
                name_scores.clear();
            }
            let may_match = (!matches.files_only || !node.is_dir)
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
        true
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
        let depth = entry.path.bytes().filter(|c| *c == b'/').count();
        let parents_capacity = self.parents.capacity().max(depth + 1);
        if self.index.bytes()
            + extra_nodes
            + extra_names
            + table_bytes
            + string_bytes
            + parents_capacity * size_of::<u32>()
            > budget
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
            if self.parents.len() == self.parents.capacity() {
                self.parents.reserve_exact(1);
            }
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
    // Snapshot entries removed since it was built (by file-change events).
    hidden: Option<Arc<Overlay>>,
}

impl Matches {
    fn new(query: &str, limit: usize, files_only: bool) -> Self {
        Self {
            query: query.trim().to_lowercase(),
            limit,
            files_only,
            best: BinaryHeap::new(),
            hidden: None,
        }
    }

    /// Hide snapshot entries the overlay removed. Entries it added are offered
    /// separately through [`Matches::offer_added`] and are never hidden.
    fn hiding(mut self, overlay: &Arc<Overlay>) -> Self {
        if overlay.removes_any() {
            self.hidden = Some(Arc::clone(overlay));
        }
        self
    }

    fn offer(&mut self, name: &str, path: &str, is_dir: bool, order: usize) {
        self.offer_from(name, path, is_dir, order, true);
    }

    fn offer_added(&mut self, name: &str, path: &str, is_dir: bool, order: usize) {
        self.offer_from(name, path, is_dir, order, false);
    }

    fn offer_from(&mut self, name: &str, path: &str, is_dir: bool, order: usize, base: bool) {
        if self.limit == 0 || (self.files_only && is_dir) {
            return;
        }
        let lower_name = name.to_lowercase();
        let name_len = lower_name.encode_utf16().count();
        let score = if let Some(score) = score_name(&self.query, &lower_name, name_len) {
            score
        } else {
            // Once top-k contains only basename hits, path and subsequence
            // tiers cannot enter it. In disk snapshots this avoids allocating
            // and lowercasing millions of irrelevant long ancestor paths.
            if !self.needs_path_matches() {
                return;
            }
            let Some(score) = score_path(&self.query, &lower_name, name_len, &path.to_lowercase())
            else {
                return;
            };
            score
        };
        self.insert(name, path, is_dir, order, score, base);
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
        self.insert(name, path, is_dir, order, score, true);
    }

    fn insert(
        &mut self,
        name: &str,
        path: &str,
        is_dir: bool,
        order: usize,
        score: i64,
        base: bool,
    ) {
        // Checked only for entries that would enter top-k, so removals cost
        // nothing for the millions of entries a query rejects anyway.
        if !self.accepts(score, order)
            || (base && self.hidden.as_ref().is_some_and(|o| o.hides(path)))
        {
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
#[cfg(test)]
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

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn search_workspace_files(
    path: String,
    query: String,
    limit: Option<usize>,
    files_only: Option<bool>,
    refresh: Option<bool>,
    request: Option<SearchRequest>,
    max_age_ms: Option<u64>,
) -> Result<Vec<WorkspaceFileEntry>, AppCommandError> {
    let requested_at = Instant::now();
    // `refresh` wants a snapshot built after this request; `max_age_ms` one
    // built within that window (e.g. since a picker opened), so a later
    // keystroke reuses the snapshot its first query built instead of asking
    // for yet another walk. Both reuse a discovery already in flight.
    let fresh_since = if refresh.unwrap_or(false) {
        Some(requested_at)
    } else {
        max_age_ms.and_then(|age| requested_at.checked_sub(Duration::from_millis(age)))
    };
    if path.trim().is_empty() || query.len() > 2048 {
        return Err(AppCommandError::invalid_input(
            "Invalid workspace file search",
        ));
    }
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
        control: Arc::new(SearchControl {
            cancel,
            deadline: requested_at + SEARCH_TIMEOUT,
        }),
    };
    // Canonicalization and linked-root authorization can touch the filesystem.
    // They run off the async executor, before looking up the short-held registry.
    let key = tokio::task::spawn_blocking(move || RootKey::resolve(&path))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
        .map_err(AppCommandError::task_execution_failed)?;
    let results = INDEXES
        .search(
            key,
            SearchOptions {
                query: &query,
                limit: limit.unwrap_or(100).clamp(1, MAX_RESULTS),
                files_only: files_only.unwrap_or(false),
                refresh: fresh_since.is_some(),
            },
            fresh_since.unwrap_or(requested_at),
            Arc::clone(&search.control),
        )
        .await
        .map_err(AppCommandError::task_execution_failed)?;
    if Instant::now() >= search.control.deadline {
        Err(AppCommandError::task_execution_failed(
            "Workspace file search timed out",
        ))
    } else if search.control.cancel.is_cancelled() {
        Ok(Vec::new())
    } else {
        Ok(results)
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn cancel_workspace_file_search(request: SearchRequest) -> Result<(), AppCommandError> {
    SEARCHES.lock().unwrap().register(&request, true)?;
    Ok(())
}

/// A workspace watch on `root` (canonical) became live; see
/// [`IndexService::watch_started`]. Returns the token for [`watch_stopped`].
pub(crate) fn watch_started(root: &std::path::Path) -> u64 {
    INDEXES.watch_started(root)
}

pub(crate) fn watch_stopped(root: &std::path::Path, token: u64) {
    INDEXES.watch_stopped(root, token);
}

/// One debounced batch of root-relative paths from the watch on `root`.
pub(crate) fn watch_changed<'a>(
    root: &std::path::Path,
    changed: impl IntoIterator<Item = &'a String>,
    structural: impl IntoIterator<Item = &'a String>,
    overflowed: bool,
) {
    INDEXES.watch_changed(
        root,
        changed.into_iter().map(String::as_str),
        structural.into_iter().map(String::as_str),
        overflowed,
    );
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

    #[tokio::test]
    async fn legacy_prepare_does_no_background_work() {
        tokio::time::timeout(
            Duration::from_secs(1),
            prepare_workspace_file_search("/not-a-workspace-and-must-not-be-touched".into()),
        )
        .await
        .unwrap();
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
            None,
        )
        .await
        .unwrap();
        assert_eq!(results.len(), MAX_RESULTS);
        assert!(results.iter().all(|e| e.kind == WorkspaceEntryKind::File));
    }

    #[tokio::test]
    async fn max_age_rebuilds_a_snapshot_older_than_the_window_and_reuses_a_newer_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let find = |max_age_ms: Option<u64>| {
            let path = path.clone();
            async move {
                search_workspace_files(path, "needle".into(), None, None, None, None, max_age_ms)
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|e| e.path)
                    .collect::<Vec<_>>()
            }
        };
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        assert!(find(None).await.is_empty());
        std::fs::write(dir.path().join("needle.txt"), "x").unwrap();
        // The warm snapshot predates the new file: plain queries reuse it.
        assert!(find(None).await.is_empty());
        std::thread::sleep(Duration::from_millis(20));
        // A picker that opened after that snapshot asks for a newer one.
        assert_eq!(find(Some(5)).await, ["needle.txt"]);
        std::fs::write(dir.path().join("needle-2.txt"), "x").unwrap();
        // Its later keystrokes accept the snapshot built since it opened.
        assert_eq!(find(Some(60_000)).await, ["needle.txt"]);
    }
}
