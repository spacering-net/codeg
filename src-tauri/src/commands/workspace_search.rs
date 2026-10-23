//! Content search for the file tree tab: grep-style matching inside the files
//! of one workspace folder.
//!
//! Name search needs no endpoint of its own. The tab ranks the
//! `list_workspace_files` listing on the client, like the search dialog and
//! the `@`-mention picker do. Content search runs here, over the same walk as
//! that listing ([`workspace_walk_builder`]), so the two modes agree on which
//! files exist: in-tree `.gitignore`/`.ignore` rules apply, `.git` is pruned,
//! and the folders the user linked into the workspace are searched too.
//!
//! Limits, so one query cannot pin a core or flood the panel:
//! - files larger than [`MAX_FILE_BYTES`] and binary files (a NUL byte) are
//!   skipped and counted in `files_skipped`;
//! - at most `max_results` matching lines are returned (default
//!   [`DEFAULT_MAX_RESULTS`], never above [`MAX_RESULTS_CEILING`]); `truncated`
//!   says more exist;
//! - the walk stops after [`MAX_FILES_SEARCHED`] files (`file_limit_reached`);
//! - a search started with a `search_key` cancels the previous search that
//!   used the same key, so each new keystroke stops the one before it.
//!
//! Confinement: the root must be an absolute path without `..` components.
//! Symlinks are never followed. The walk does not descend into a linked
//! directory and only regular files are opened, so a symlink to a file outside
//! the root is never read. The one exception is the user's own authorized
//! links (see [`crate::folder_links`]), which the tree shows as part of the
//! workspace; they are walked rooted at their target and reported under the
//! link's name.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use serde::{Deserialize, Serialize};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::folders::{authorized_links_in, workspace_walk_builder};

/// Matching lines returned when the caller does not ask for a number.
pub const DEFAULT_MAX_RESULTS: usize = 500;
/// Upper bound on `max_results`, whatever the caller asks for.
pub const MAX_RESULTS_CEILING: usize = 2_000;
/// Files larger than this are skipped rather than searched.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// The walk stops after this many searched files.
pub const MAX_FILES_SEARCHED: usize = 50_000;
/// Longest accepted query, in characters.
pub const MAX_QUERY_CHARS: usize = 512;
const MAX_SEARCH_KEY_CHARS: usize = 128;
/// Highlight ranges kept per line; the rest of a pathological line still
/// counts as one result.
const MAX_RANGES_PER_LINE: usize = 64;
/// Characters of a line shown in a preview.
const PREVIEW_MAX_CHARS: usize = 200;
/// Characters kept before the first match when a long line is cut.
const PREVIEW_LEAD_CHARS: usize = 40;
/// Bytes of a very long (e.g. minified) line decoded for its preview,
/// centred on the first match.
const PREVIEW_SCAN_BYTES: usize = 4 * 1024;

/// Why a content search was refused. Each variant maps to an
/// [`AppErrorCode`] and an i18n key under `Folder.fileTreeTab`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceSearchError {
    #[error("Search query is empty")]
    EmptyQuery,
    #[error("Search query is too long")]
    QueryTooLong,
    #[error("Invalid regular expression")]
    InvalidPattern(String),
    #[error("Search root must be an absolute path without '..' components")]
    InvalidRoot,
    #[error("Search root is not a directory")]
    RootNotFound,
    #[error("Search key is empty or too long")]
    InvalidSearchKey,
    #[error("Search task failed")]
    TaskFailed(String),
}

impl WorkspaceSearchError {
    fn code(&self) -> AppErrorCode {
        match self {
            Self::RootNotFound => AppErrorCode::NotFound,
            Self::TaskFailed(_) => AppErrorCode::TaskExecutionFailed,
            _ => AppErrorCode::InvalidInput,
        }
    }

    fn i18n_key(&self) -> &'static str {
        match self {
            Self::EmptyQuery => "search.errors.emptyQuery",
            Self::QueryTooLong => "search.errors.queryTooLong",
            Self::InvalidPattern(_) => "search.errors.invalidPattern",
            Self::InvalidRoot => "search.errors.invalidRoot",
            Self::RootNotFound => "search.errors.rootNotFound",
            Self::InvalidSearchKey => "search.errors.invalidSearchKey",
            Self::TaskFailed(_) => "search.errors.failed",
        }
    }
}

impl From<WorkspaceSearchError> for AppCommandError {
    fn from(err: WorkspaceSearchError) -> Self {
        let mut params = BTreeMap::new();
        if matches!(err, WorkspaceSearchError::QueryTooLong) {
            params.insert("max".to_string(), MAX_QUERY_CHARS.to_string());
        }
        let out =
            AppCommandError::new(err.code(), err.to_string()).with_i18n(err.i18n_key(), params);
        match err {
            WorkspaceSearchError::InvalidPattern(detail)
            | WorkspaceSearchError::TaskFailed(detail) => out.with_detail(detail),
            _ => out,
        }
    }
}

/// One content search. Also the web-mode JSON body (camelCase, like the flat
/// Tauri command arguments).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchRequest {
    /// Absolute path of the workspace folder the tab shows.
    pub root_path: String,
    pub query: String,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    /// Treat `query` as a regular expression instead of literal text.
    #[serde(default)]
    pub regex: Option<bool>,
    #[serde(default)]
    pub max_results: Option<usize>,
    /// Caller-chosen id; a new search with the same key cancels the old one.
    #[serde(default)]
    pub search_key: Option<String>,
}

/// Web-mode JSON body for `cancel_workspace_search`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelWorkspaceSearchParams {
    pub search_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ContentSearchResult {
    /// Files with at least one match, in walk order (by path).
    pub files: Vec<ContentSearchFile>,
    /// Matching lines returned across all files.
    pub result_count: usize,
    /// More lines matched than `result_count`.
    pub truncated: bool,
    /// The walk stopped at [`MAX_FILES_SEARCHED`] files.
    pub file_limit_reached: bool,
    /// A newer search with the same key (or an explicit cancel) stopped this one.
    pub cancelled: bool,
    pub files_searched: usize,
    /// Binary files and files over [`MAX_FILE_BYTES`].
    pub files_skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContentSearchFile {
    /// Path relative to the workspace root, forward-slashed. Files inside a
    /// linked folder are reported under the link's name.
    pub path: String,
    pub name: String,
    pub matches: Vec<ContentSearchLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContentSearchLine {
    /// 1-based line number.
    pub line: u64,
    /// The line, trimmed of indentation and cut to a window around the first
    /// match (`…` marks a cut).
    pub preview: String,
    /// Highlighted `[start, end)` ranges in `preview`, in UTF-16 code units so
    /// the frontend can slice the string directly.
    pub ranges: Vec<[u32; 2]>,
}

// ─── validation ─────────────────────────────────────────────────────────

/// The root as an absolute, `..`-free directory path.
pub(crate) fn resolve_search_root(raw: &str) -> Result<PathBuf, WorkspaceSearchError> {
    if raw.trim().is_empty() {
        return Err(WorkspaceSearchError::InvalidRoot);
    }
    let root = PathBuf::from(raw);
    if !root.is_absolute() || root.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(WorkspaceSearchError::InvalidRoot);
    }
    if !root.is_dir() {
        return Err(WorkspaceSearchError::RootNotFound);
    }
    Ok(root)
}

/// Literal text by default (every character matches itself), a regular
/// expression when `regex` is set. Case-insensitive unless `case_sensitive`.
pub(crate) fn build_matcher(
    query: &str,
    case_sensitive: bool,
    regex: bool,
) -> Result<RegexMatcher, WorkspaceSearchError> {
    if query.is_empty() {
        return Err(WorkspaceSearchError::EmptyQuery);
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(WorkspaceSearchError::QueryTooLong);
    }
    RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .fixed_strings(!regex)
        // Line-oriented search: a match never spans a line break, and a NUL
        // can never match because binary detection quits on it.
        .line_terminator(Some(b'\n'))
        .ban_byte(Some(b'\0'))
        .build(query)
        .map_err(|err| WorkspaceSearchError::InvalidPattern(err.to_string()))
}

fn validate_search_key(key: Option<String>) -> Result<Option<String>, WorkspaceSearchError> {
    match key {
        None => Ok(None),
        Some(key) if key.is_empty() || key.chars().count() > MAX_SEARCH_KEY_CHARS => {
            Err(WorkspaceSearchError::InvalidSearchKey)
        }
        Some(key) => Ok(Some(key)),
    }
}

// ─── cancellation ───────────────────────────────────────────────────────

struct ActiveSearch {
    id: u64,
    cancel: Arc<AtomicBool>,
}

static ACTIVE_SEARCHES: LazyLock<Mutex<HashMap<String, ActiveSearch>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_SEARCH_ID: AtomicU64 = AtomicU64::new(1);

fn active_searches() -> std::sync::MutexGuard<'static, HashMap<String, ActiveSearch>> {
    ACTIVE_SEARCHES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A running search's cancel flag, registered under its key for as long as
/// the search runs. Dropping it (the search finished, or the request future
/// was dropped because the client went away) raises the flag and forgets the
/// key, so an abandoned walk stops at its next file.
struct SearchRegistration {
    key: Option<String>,
    id: u64,
    cancel: Arc<AtomicBool>,
}

impl SearchRegistration {
    fn begin(key: Option<String>) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        let id = NEXT_SEARCH_ID.fetch_add(1, Ordering::Relaxed);
        if let Some(key) = &key {
            let previous = active_searches().insert(
                key.clone(),
                ActiveSearch {
                    id,
                    cancel: Arc::clone(&cancel),
                },
            );
            if let Some(previous) = previous {
                previous.cancel.store(true, Ordering::Relaxed);
            }
        }
        Self { key, id, cancel }
    }
}

impl Drop for SearchRegistration {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        let Some(key) = &self.key else { return };
        let mut active = active_searches();
        if active.get(key).is_some_and(|search| search.id == self.id) {
            active.remove(key);
        }
    }
}

/// Stop the search running under `key`, if any. Returns whether one was.
pub(crate) fn cancel_search(key: &str) -> bool {
    match active_searches().remove(key) {
        Some(search) => {
            search.cancel.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

// ─── search ─────────────────────────────────────────────────────────────

/// Search every file under `root` (and its authorized links) for `matcher`,
/// returning at most `max_results` matching lines. Blocking; stops early when
/// `cancel` is raised.
pub(crate) fn search_content(
    root: &Path,
    matcher: &RegexMatcher,
    max_results: usize,
    cancel: &AtomicBool,
) -> ContentSearchResult {
    let max_results = max_results.clamp(1, MAX_RESULTS_CEILING);
    let mut result = ContentSearchResult::default();
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\0'))
        .line_number(true)
        .build();

    let linked = authorized_links_in(root);
    let linked_names: HashSet<String> = linked.iter().map(|(name, _)| name.clone()).collect();
    let mut walks: Vec<(PathBuf, Option<String>, HashSet<String>)> =
        vec![(root.to_path_buf(), None, linked_names)];
    walks.extend(
        linked
            .into_iter()
            .map(|(name, target)| (target, Some(name), HashSet::new())),
    );

    // One line past the limit is collected so `truncated` is exact: it is only
    // set when a further match really exists.
    let budget = max_results + 1;
    let mut collected = 0usize;

    'walks: for (walk_root, prefix, skip) in walks {
        for entry in workspace_walk_builder(&walk_root, skip).build() {
            if cancel.load(Ordering::Relaxed) {
                result.cancelled = true;
                break 'walks;
            }
            let Ok(entry) = entry else { continue };
            // Regular files only. The walker does not follow symlinks, so a
            // link reports its own type here and is never opened.
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > MAX_FILE_BYTES {
                result.files_skipped += 1;
                continue;
            }
            if result.files_searched >= MAX_FILES_SEARCHED {
                result.file_limit_reached = true;
                break 'walks;
            }
            let Ok(rel) = entry.path().strip_prefix(&walk_root) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            result.files_searched += 1;

            let mut sink = LineSink {
                matcher,
                cancel,
                budget: budget - collected,
                lines: Vec::new(),
                binary: false,
            };
            if searcher
                .search_path(matcher, entry.path(), &mut sink)
                .is_err()
            {
                // Unreadable (permissions, vanished mid-walk): not a result.
                continue;
            }
            if sink.binary {
                result.files_skipped += 1;
                continue;
            }
            if sink.lines.is_empty() {
                continue;
            }

            collected += sink.lines.len();
            let mut lines = sink.lines;
            if collected > max_results {
                lines.truncate(lines.len() - (collected - max_results));
                result.truncated = true;
            }
            if !lines.is_empty() {
                result.result_count += lines.len();
                result.files.push(ContentSearchFile {
                    path: match &prefix {
                        Some(prefix) => format!("{prefix}/{rel}"),
                        None => rel,
                    },
                    name: entry.file_name().to_string_lossy().into_owned(),
                    matches: lines,
                });
            }
            if result.truncated {
                break 'walks;
            }
        }
    }
    result
}

/// Collects the matching lines of one file, up to `budget`. Matches seen
/// before binary data turns up are discarded by the caller (`binary`).
struct LineSink<'a> {
    matcher: &'a RegexMatcher,
    cancel: &'a AtomicBool,
    budget: usize,
    lines: Vec<ContentSearchLine>,
    binary: bool,
}

impl Sink for LineSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if self.cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let line = trim_line_terminator(mat.bytes());
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        // `RegexMatcher`'s error type is `NoError`: this cannot fail.
        let _ = self.matcher.find_iter(line, |m| {
            if !m.is_empty() {
                ranges.push((m.start(), m.end()));
            }
            ranges.len() < MAX_RANGES_PER_LINE
        });
        let (preview, ranges) = build_preview(line, &ranges);
        self.lines.push(ContentSearchLine {
            line: mat.line_number().unwrap_or(0),
            preview,
            ranges,
        });
        Ok(self.lines.len() < self.budget)
    }

    fn binary_data(&mut self, _searcher: &Searcher, _offset: u64) -> Result<bool, io::Error> {
        self.binary = true;
        Ok(false)
    }
}

fn trim_line_terminator(mut line: &[u8]) -> &[u8] {
    if let Some(rest) = line.strip_suffix(b"\n") {
        line = rest;
    }
    if let Some(rest) = line.strip_suffix(b"\r") {
        line = rest;
    }
    line
}

/// Turn one matching line into a short preview plus its highlight ranges.
///
/// `ranges` are byte ranges into `line`, sorted and non-overlapping (as the
/// matcher reports them). Invalid UTF-8 is decoded lossily. Indentation and
/// trailing whitespace are dropped; a line longer than [`PREVIEW_MAX_CHARS`]
/// is cut to a window that starts a little before the first match, with `…`
/// marking each cut side. Output ranges are UTF-16 offsets into the preview.
fn build_preview(line: &[u8], ranges: &[(usize, usize)]) -> (String, Vec<[u32; 2]>) {
    // Bound the decoding work on very long lines to a byte window around the
    // first match, moved onto UTF-8 character boundaries.
    let first_byte = ranges.first().map(|r| r.0).unwrap_or(0);
    let (mut scan_start, mut scan_end) = (0, line.len());
    if line.len() > PREVIEW_SCAN_BYTES {
        scan_start = first_byte.saturating_sub(PREVIEW_SCAN_BYTES / 4);
        scan_end = (scan_start + PREVIEW_SCAN_BYTES).min(line.len());
        while scan_start < scan_end && is_utf8_continuation(line[scan_start]) {
            scan_start += 1;
        }
        while scan_end > scan_start && scan_end < line.len() && is_utf8_continuation(line[scan_end])
        {
            scan_end -= 1;
        }
    }

    let mut chars: Vec<(char, bool)> = Vec::new();
    let mut push = |bytes: &[u8], hit: bool| {
        chars.extend(String::from_utf8_lossy(bytes).chars().map(|c| (c, hit)));
    };
    let mut pos = scan_start;
    for &(start, end) in ranges {
        let start = start.clamp(scan_start, scan_end);
        let end = end.clamp(scan_start, scan_end);
        if start < pos || end <= start {
            continue;
        }
        push(&line[pos..start], false);
        push(&line[start..end], true);
        pos = end;
    }
    push(&line[pos..scan_end], false);

    let cut_before = scan_start > 0;
    let cut_after = scan_end < line.len();
    let mut lo = 0;
    if !cut_before {
        while lo < chars.len() && !chars[lo].1 && chars[lo].0.is_whitespace() {
            lo += 1;
        }
    }
    let mut hi = chars.len();
    if !cut_after {
        while hi > lo && !chars[hi - 1].1 && chars[hi - 1].0.is_whitespace() {
            hi -= 1;
        }
    }

    let mut start = lo;
    if hi - lo > PREVIEW_MAX_CHARS {
        let first_hit = chars[lo..hi]
            .iter()
            .position(|(_, hit)| *hit)
            .map_or(lo, |i| i + lo);
        start = first_hit.saturating_sub(PREVIEW_LEAD_CHARS).max(lo);
        // Keep the window full when the match sits near the end of the line.
        start = start.min(hi - PREVIEW_MAX_CHARS);
    }
    let end = (start + PREVIEW_MAX_CHARS).min(hi);

    let mut preview = String::new();
    let mut out: Vec<[u32; 2]> = Vec::new();
    let mut offset: u32 = 0;
    if cut_before || start > lo {
        preview.push('…');
        offset += 1;
    }
    let mut open: Option<u32> = None;
    for &(c, hit) in &chars[start..end] {
        match (hit, open) {
            (true, None) => open = Some(offset),
            (false, Some(from)) => {
                out.push([from, offset]);
                open = None;
            }
            _ => {}
        }
        preview.push(c);
        offset += c.len_utf16() as u32;
    }
    if let Some(from) = open {
        out.push([from, offset]);
    }
    if cut_after || end < hi {
        preview.push('…');
    }
    (preview, out)
}

fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0xC0 == 0x80
}

// ─── core ops (shared by the Tauri command and the Axum handler) ────────

pub async fn search_workspace_content_core(
    request: ContentSearchRequest,
) -> Result<ContentSearchResult, AppCommandError> {
    let root = resolve_search_root(&request.root_path)?;
    let matcher = build_matcher(
        &request.query,
        request.case_sensitive.unwrap_or(false),
        request.regex.unwrap_or(false),
    )?;
    let key = validate_search_key(request.search_key)?;
    let max_results = request
        .max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_RESULTS_CEILING);

    let registration = SearchRegistration::begin(key);
    let cancel = Arc::clone(&registration.cancel);
    let result =
        tokio::task::spawn_blocking(move || search_content(&root, &matcher, max_results, &cancel))
            .await
            .map_err(|err| WorkspaceSearchError::TaskFailed(err.to_string()))?;
    drop(registration);
    Ok(result)
}

pub async fn cancel_workspace_search_core(search_key: String) -> Result<(), AppCommandError> {
    if let Some(key) = validate_search_key(Some(search_key))? {
        cancel_search(&key);
    }
    Ok(())
}

// ─── tauri command wrappers ─────────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn search_workspace_content(
    root_path: String,
    query: String,
    case_sensitive: Option<bool>,
    regex: Option<bool>,
    max_results: Option<usize>,
    search_key: Option<String>,
) -> Result<ContentSearchResult, AppCommandError> {
    search_workspace_content_core(ContentSearchRequest {
        root_path,
        query,
        case_sensitive,
        regex,
        max_results,
        search_key,
    })
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn cancel_workspace_search(search_key: String) -> Result<(), AppCommandError> {
    cancel_workspace_search_core(search_key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, contents: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, contents).expect("write");
    }

    fn search(root: &Path, query: &str) -> ContentSearchResult {
        search_with(root, query, false, false, DEFAULT_MAX_RESULTS)
    }

    fn search_with(
        root: &Path,
        query: &str,
        case_sensitive: bool,
        regex: bool,
        max_results: usize,
    ) -> ContentSearchResult {
        let matcher = build_matcher(query, case_sensitive, regex).expect("matcher");
        search_content(root, &matcher, max_results, &AtomicBool::new(false))
    }

    fn paths(result: &ContentSearchResult) -> Vec<&str> {
        result.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn finds_matching_lines_with_line_numbers_and_ranges() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            "src/main.rs",
            b"fn main() {\n    let needle = 1;\n    println!(\"{needle}\");\n}\n",
        );
        write(dir.path(), "README.md", b"no match here\n");

        let result = search(dir.path(), "needle");
        assert_eq!(paths(&result), vec!["src/main.rs"]);
        let file = &result.files[0];
        assert_eq!(file.name, "main.rs");
        let lines: Vec<u64> = file.matches.iter().map(|m| m.line).collect();
        assert_eq!(lines, vec![2, 3]);
        // Indentation is trimmed from the preview; the range points at the hit.
        assert_eq!(file.matches[0].preview, "let needle = 1;");
        assert_eq!(file.matches[0].ranges, vec![[4, 10]]);
        assert_eq!(result.result_count, 2);
        assert!(!result.truncated && !result.cancelled);
        assert_eq!(result.files_searched, 2);
    }

    #[test]
    fn literal_by_default_and_case_insensitive_unless_asked() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a.txt", b"Foo(bar)\nfoo(bar)\nfooXbar\n");

        // `(` is literal text, not a group.
        let literal = search(dir.path(), "foo(bar)");
        assert_eq!(literal.result_count, 2, "case-insensitive by default");

        let exact = search_with(dir.path(), "foo(bar)", true, false, 10);
        assert_eq!(exact.result_count, 1);
        assert_eq!(exact.files[0].matches[0].line, 2);

        let regex = search_with(dir.path(), "foo.bar", false, true, 10);
        assert_eq!(regex.result_count, 3, "regex mode: `.` matches any char");
    }

    #[test]
    fn every_occurrence_on_a_line_is_highlighted() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a.txt", b"ab ab ab\n");
        let result = search(dir.path(), "ab");
        assert_eq!(
            result.files[0].matches[0].ranges,
            vec![[0, 2], [3, 5], [6, 8]]
        );
    }

    #[test]
    fn respects_gitignore_and_the_tree_s_hardcoded_ignores() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write(root, ".gitignore", b"node_modules/\ntarget/\n*.log\n");
        write(root, "node_modules/pkg/index.js", b"needle");
        write(root, "target/debug/out.txt", b"needle");
        write(root, "build.log", b"needle");
        write(root, ".git/config", b"needle");
        write(root, "nested/.ignore", b"skipped.txt\n");
        write(root, "nested/skipped.txt", b"needle");
        write(root, "nested/kept.txt", b"needle");
        write(root, ".env.example", b"needle");

        let result = search(root, "needle");
        assert_eq!(paths(&result), vec![".env.example", "nested/kept.txt"]);
    }

    #[test]
    fn skips_binary_and_oversized_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        write(root, "image.bin", b"needle\0\x01\x02needle");
        // The NUL sits after the first match: the match must still be dropped.
        let mut late_nul = b"needle\n".repeat(10);
        late_nul.extend_from_slice(b"\0");
        write(root, "late.bin", &late_nul);
        let mut big = b"needle\n".to_vec();
        big.resize(MAX_FILE_BYTES as usize + 1, b'x');
        write(root, "big.txt", &big);
        write(root, "ok.txt", b"needle\n");

        let result = search(root, "needle");
        assert_eq!(paths(&result), vec!["ok.txt"]);
        assert_eq!(result.files_skipped, 3);
    }

    #[test]
    fn caps_results_and_reports_truncation_exactly() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a.txt", b"hit\nhit\nhit\n");
        write(dir.path(), "b.txt", b"hit\nhit\n");

        let capped = search_with(dir.path(), "hit", false, false, 4);
        assert_eq!(capped.result_count, 4);
        assert!(capped.truncated);
        assert_eq!(capped.files.len(), 2);
        assert_eq!(capped.files[1].matches.len(), 1);

        // Exactly as many matches as the cap: nothing was left out.
        let exact = search_with(dir.path(), "hit", false, false, 5);
        assert_eq!(exact.result_count, 5);
        assert!(!exact.truncated);

        // The requested cap is clamped to the ceiling, never zero.
        let floor = search_with(dir.path(), "hit", false, false, 0);
        assert_eq!(floor.result_count, 1);
        assert!(floor.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_symlink_out_of_the_root() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        write(outside.path(), "secret.txt", b"needle\n");
        symlink(outside.path(), root.path().join("stray-dir")).expect("dir link");
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("stray-file.txt"),
        )
        .expect("file link");
        write(root.path(), "inside.txt", b"needle\n");

        let result = search(root.path(), "needle");
        assert_eq!(paths(&result), vec!["inside.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn searches_inside_an_authorized_link_under_its_name() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().expect("root");
        let linked = tempfile::tempdir().expect("linked");
        write(linked.path(), "src/deep.ts", b"export const needle = 1\n");
        write(linked.path(), ".gitignore", b"dist/\n");
        write(linked.path(), "dist/bundle.js", b"needle");
        symlink(linked.path(), root.path().join("api")).expect("symlink");
        let canonical_target = std::fs::canonicalize(linked.path()).expect("canon");
        crate::folder_links::register(root.path(), &canonical_target);

        let result = search(root.path(), "needle");
        crate::folder_links::unregister(root.path(), &canonical_target);

        assert_eq!(paths(&result), vec!["api/src/deep.ts"]);
    }

    #[test]
    fn a_raised_cancel_flag_stops_the_walk() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "a.txt", b"needle\n");
        let matcher = build_matcher("needle", false, false).expect("matcher");
        let result = search_content(dir.path(), &matcher, 10, &AtomicBool::new(true));
        assert!(result.cancelled);
        assert!(result.files.is_empty());
    }

    #[test]
    fn a_new_search_with_the_same_key_cancels_the_previous_one() {
        let first = SearchRegistration::begin(Some("tab-1".to_string()));
        let other = SearchRegistration::begin(Some("tab-2".to_string()));
        let second = SearchRegistration::begin(Some("tab-1".to_string()));
        assert!(first.cancel.load(Ordering::Relaxed), "superseded");
        assert!(!second.cancel.load(Ordering::Relaxed));
        assert!(
            !other.cancel.load(Ordering::Relaxed),
            "other keys untouched"
        );

        // Dropping the superseded registration must not forget the new one.
        drop(first);
        assert!(cancel_search("tab-1"));
        assert!(second.cancel.load(Ordering::Relaxed));
        assert!(!cancel_search("tab-1"), "already gone");

        drop(other);
        assert!(
            !cancel_search("tab-2"),
            "a finished search unregisters itself"
        );
    }

    #[test]
    fn rejects_relative_parent_and_missing_roots() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            resolve_search_root(""),
            Err(WorkspaceSearchError::InvalidRoot)
        );
        assert_eq!(
            resolve_search_root("relative/dir"),
            Err(WorkspaceSearchError::InvalidRoot)
        );
        let escape = format!("{}/sub/../..", dir.path().display());
        assert_eq!(
            resolve_search_root(&escape),
            Err(WorkspaceSearchError::InvalidRoot)
        );
        let missing = dir.path().join("missing");
        assert_eq!(
            resolve_search_root(&missing.to_string_lossy()),
            Err(WorkspaceSearchError::RootNotFound)
        );
        let file = dir.path().join("file.txt");
        std::fs::write(&file, b"x").expect("write");
        assert_eq!(
            resolve_search_root(&file.to_string_lossy()),
            Err(WorkspaceSearchError::RootNotFound)
        );
        assert_eq!(
            resolve_search_root(&dir.path().to_string_lossy()),
            Ok(dir.path().to_path_buf())
        );
    }

    #[test]
    fn rejects_bad_queries_with_typed_errors() {
        assert!(matches!(
            build_matcher("", false, false),
            Err(WorkspaceSearchError::EmptyQuery)
        ));
        let long = "x".repeat(MAX_QUERY_CHARS + 1);
        assert!(matches!(
            build_matcher(&long, false, false),
            Err(WorkspaceSearchError::QueryTooLong)
        ));
        assert!(matches!(
            build_matcher("(unclosed", false, true),
            Err(WorkspaceSearchError::InvalidPattern(_))
        ));
        assert!(
            build_matcher("(unclosed", false, false).is_ok(),
            "literal mode"
        );
        assert_eq!(
            validate_search_key(Some(String::new())),
            Err(WorkspaceSearchError::InvalidSearchKey)
        );
        assert_eq!(
            validate_search_key(Some("k".repeat(MAX_SEARCH_KEY_CHARS + 1))),
            Err(WorkspaceSearchError::InvalidSearchKey)
        );
    }

    #[test]
    fn errors_carry_a_code_and_an_i18n_key() {
        let err: AppCommandError = WorkspaceSearchError::InvalidPattern("bad".into()).into();
        assert!(matches!(err.code, AppErrorCode::InvalidInput));
        assert_eq!(
            err.i18n_key.as_deref(),
            Some("search.errors.invalidPattern")
        );
        assert_eq!(err.detail.as_deref(), Some("bad"));

        let err: AppCommandError = WorkspaceSearchError::RootNotFound.into();
        assert!(matches!(err.code, AppErrorCode::NotFound));

        let err: AppCommandError = WorkspaceSearchError::QueryTooLong.into();
        let params = err.i18n_params.expect("params");
        assert_eq!(params.get("max").map(String::as_str), Some("512"));
    }

    #[test]
    fn preview_cuts_long_lines_around_the_first_match() {
        let mut line = "a".repeat(500);
        line.push_str("needle");
        line.push_str(&"b".repeat(500));
        let start = 500;
        let (preview, ranges) = build_preview(line.as_bytes(), &[(start, start + 6)]);
        assert!(preview.starts_with('…') && preview.ends_with('…'));
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS + 2);
        let [from, to] = ranges[0];
        let units: Vec<u16> = preview.encode_utf16().collect();
        assert_eq!(
            String::from_utf16_lossy(&units[from as usize..to as usize]),
            "needle"
        );
        assert_eq!(from as usize, 1 + PREVIEW_LEAD_CHARS);
    }

    #[test]
    fn preview_ranges_are_utf16_offsets() {
        // Arabic and an astral-plane emoji before the match.
        let line = "مرحبا 🎉 needle".as_bytes();
        let start = line.len() - "needle".len();
        let (preview, ranges) = build_preview(line, &[(start, line.len())]);
        let units: Vec<u16> = preview.encode_utf16().collect();
        let [from, to] = ranges[0];
        assert_eq!(
            String::from_utf16_lossy(&units[from as usize..to as usize]),
            "needle"
        );
        assert_eq!(from, 9, "5 Arabic letters + space + 2-unit emoji + space");
    }

    #[test]
    fn preview_survives_invalid_utf8_and_huge_lines() {
        let mut line = vec![0xFFu8; 10];
        line.extend_from_slice(b" needle");
        let (preview, ranges) = build_preview(&line, &[(11, 17)]);
        assert!(preview.ends_with("needle"));
        assert_eq!(ranges.len(), 1);

        // A multi-megabyte minified line only decodes a window of it.
        let mut huge = "é".repeat(1_000_000).into_bytes();
        let at = huge.len();
        huge.extend_from_slice(b"needle");
        let (preview, ranges) = build_preview(&huge, &[(at, at + 6)]);
        assert!(preview.starts_with('…'));
        assert!(preview.contains("needle"));
        assert_eq!(ranges.len(), 1);
    }

    #[tokio::test]
    async fn core_validates_then_searches() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "x.txt", b"needle\n");
        let ok = search_workspace_content_core(ContentSearchRequest {
            root_path: dir.path().to_string_lossy().into_owned(),
            query: "needle".to_string(),
            search_key: Some("core-test".to_string()),
            ..Default::default()
        })
        .await
        .expect("search");
        assert_eq!(paths(&ok), vec!["x.txt"]);
        assert!(!cancel_search("core-test"), "unregistered once finished");

        let err = search_workspace_content_core(ContentSearchRequest {
            root_path: "relative".to_string(),
            query: "needle".to_string(),
            ..Default::default()
        })
        .await
        .expect_err("relative root");
        assert_eq!(err.i18n_key.as_deref(), Some("search.errors.invalidRoot"));
    }
}
