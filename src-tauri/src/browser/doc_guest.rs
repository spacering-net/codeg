//! The `codeg-doc:` document guest: a local HTML file shown through a webview
//! of its own, whose every request the host answers from the file's folder.
//! This is what the desktop shows for an `.html` file instead of an inline
//! `srcdoc` preview: a real document with a real URL, so routing, `fetch` of
//! sibling files and relative links work — inside a fence.
//!
//! The fence, in order of importance:
//!
//! - **Only guests have the scheme.** The handler is registered on the guest
//!   webview's own builder, so the app's webview and ordinary browser tabs
//!   cannot address `codeg-doc:` at all; and the handler is bound to one
//!   grant (root + entry) and checks the webview id it is called for.
//! - **Only files under the root.** Same rule as the inline preview: the root
//!   is the workspace folder the file sits in (else its own directory), the
//!   path is canonicalized and confined, and the file is then opened
//!   component by component without following any symlink (a directory
//!   swapped for a symlink after the check is refused, not followed). No
//!   directory listings.
//! - **Safe mode by default.** The document is served with a CSP that runs
//!   no script and opens no connection; images, styles and fonts come from
//!   the root only. **Dynamic mode** is a per-file, per-session decision by
//!   the user: scripts run, but still only from the root, and the only
//!   endpoint they can reach is the root (`connect-src 'self'`).
//! - **What was approved is what runs.** Dynamic mode records when it was
//!   granted; a file whose timestamps (its own, or the symlink's it was
//!   requested through) are newer than that, or whose content differs from
//!   what was served under the same path since, drops the guest back to safe
//!   mode and is not served — and every guest showing the document reloads
//!   under the safe policy. The document the user approved cannot be swapped
//!   underneath the approval.
//! - **A guest goes nowhere else.** Top-level navigation to a web address is
//!   refused and reported so the user can open it in a browser tab;
//!   `window.open` and downloads are refused; nothing a guest stores
//!   outlives the run.
//! - **One document, one origin.** Every grant mints a host of its own, so
//!   two documents are two origins and the engine keeps what they store
//!   apart. The data store alone does not do this: macOS hands each guest a
//!   non-persistent `WKWebsiteDataStore`, but on Windows every in-private
//!   webview of the process shares one partition, and a shared partition
//!   under a shared origin is one `localStorage` for every document the user
//!   opens.
//!
//! A grant lives for the session: switching files and coming back keeps the
//! mode the user chose (and the approval time it was chosen at).

use std::collections::HashMap;
use std::fs::{File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(any(unix, test))]
use std::time::Duration;

use http::{header, Request, Response, StatusCode, Uri};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Url;

/// Label prefix of every document guest webview. Like `browser-`, it must
/// never appear in a capability (`mod.rs` has the test).
pub const DOC_LABEL_PREFIX: &str = "codeg-doc-";
pub const DOC_SCHEME: &str = "codeg-doc";

/// The host part of one grant's document URLs, minted when the grant is.
///
/// This was a constant, and a constant host is one origin for every document
/// the user opens. macOS hid that: each guest gets its own non-persistent
/// data store, so there was nothing behind the origin to share. Windows does
/// not — WebView2 gives an environment a single in-private partition, and
/// every guest of the process lands in it, so one report could read what a
/// report from another folder had written. The roots are fenced apart; the
/// storage has to be too, and separating the origins is what makes the engine
/// do it.
///
/// Per **grant**, not per guest, because the grant is the principal here: it
/// is keyed by (root, entry), it holds the approval, and two guests of one
/// grant already reload together when it resets. Two tabs on one document are
/// one document.
///
/// Minted rather than derived from the path. A hash would have to encode two
/// `OsString`s injectively — `to_string_lossy` is not — and buys only
/// stability across runs, which storage that dies with the run cannot use.
fn mint_host() -> String {
    format!("doc-{}", uuid::Uuid::new_v4().simple())
}

/// The host wry serves a custom scheme from where the engine has no custom
/// schemes (Windows): `<scheme>.<host>`.
fn mapped_host(host: &str) -> String {
    format!("{DOC_SCHEME}.{host}")
}

/// Largest file the guest serves. A document preview that needs more than
/// this in one response is not a document; the body is held in memory.
const MAX_BODY_BYTES: u64 = 512 * 1024 * 1024;
/// A range request is answered at most this large per response; the engine
/// asks for the rest as it needs it.
const MAX_RANGE_BYTES: u64 = 16 * 1024 * 1024;

pub fn doc_label(tab_id: &str) -> String {
    format!("{DOC_LABEL_PREFIX}{tab_id}")
}

/// Whether this build can host document guests: the embedded surface with a
/// per-webview scheme handler. Linux has no embedded surface, and the inline
/// preview stays in place there.
pub fn supported() -> bool {
    cfg!(all(
        feature = "browser-child",
        any(target_os = "macos", target_os = "windows")
    ))
}

/// The address to hand the engine for a document URL. WebView2 has no custom
/// schemes, so wry serves ours from `http://<scheme>.<host>/…` and reverts
/// the spelling before the handler sees the request — but it only rewrites a
/// webview's INITIAL url, and a guest is built empty and navigated once its
/// grant is bound. Without this the engine is handed a scheme it does not
/// know and the guest sits on `about:blank`.
///
/// Only the address given to the engine changes: the guest's own state, the
/// CSP's `'self'` and `is_document_url` all read both spellings already.
pub fn engine_url(url: &Url) -> Url {
    #[cfg(target_os = "windows")]
    if url.scheme() == DOC_SCHEME {
        let rewritten = url.as_str().replacen(
            &format!("{DOC_SCHEME}://"),
            &format!("http://{DOC_SCHEME}."),
            1,
        );
        if let Ok(parsed) = Url::parse(&rewritten) {
            return parsed;
        }
    }
    url.clone()
}

/// A URL that addresses the guest whose host is `own`. wry maps a custom
/// scheme to `http(s)://<scheme>.<host>` on Windows, so both spellings count
/// — but only that one host, in either spelling:
///
/// - `codeg-doc.` as a PREFIX would make every registrable domain someone
///   owns a guest address (`https://codeg-doc.example.com/`), and a guest is
///   allowed to navigate to its own addresses, which is how a document with
///   scripts would send what it read to its author.
/// - any host under the scheme would let one guest address ANOTHER guest's
///   origin. Its own handler would answer — from its own root, which is no
///   leak of files — under the other document's origin, which hands it the
///   other document's storage. Hosts are per grant now, so the host is the
///   thing being checked, not a formality around the scheme.
///
/// Exact, and so case-sensitive for the custom spelling: the `url` crate
/// lowercases a host only for the special schemes. Every URL a guest is given
/// is minted here in lowercase, so the only thing an exact match can refuse
/// is a document that went looking for a different casing — and refusing is
/// the safe side of every one of these comparisons. A URL we turn away cannot
/// leak anything; the only cost of being strict is breaking a guest loudly,
/// and the only URLs a guest legitimately has are the ones minted here.
pub fn is_document_url(url: &Url, own: &str) -> bool {
    // A port is part of an origin and `host_str` does not carry one, so it
    // has to be looked at separately or `<own>:8080` would pass for `<own>`
    // — a second origin, with a second `localStorage`, for the asking. The
    // `url` crate normalises a scheme's default port away, so this refuses
    // exactly the ports that mean a different origin.
    if url.port().is_some() {
        return false;
    }
    match url.scheme() {
        DOC_SCHEME => url.host_str() == Some(own),
        "http" | "https" => url.host_str() == Some(mapped_host(own).as_str()),
        _ => false,
    }
}

/// What a guest may navigate to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestNavigation {
    Allow,
    /// A web address: not for the guest, but the user may want it in a tab.
    External,
    /// Anything else (`mailto:`, `file:`, app schemes, `data:` documents).
    Scheme,
}

/// The guest's navigation policy: its own documents, the blank page, and —
/// inside its own frames only — the opaque-origin content a page composes
/// itself. Everything with a scheme of its own stays out; web addresses are
/// reported as such so the user can follow them elsewhere.
///
/// `own` is the host of the grant this guest is showing: another guest's
/// document is not this guest's own, and is refused like any other scheme.
pub fn guest_navigation(url: &Url, own: &str, main_frame: bool) -> GuestNavigation {
    if is_document_url(url, own) {
        return GuestNavigation::Allow;
    }
    match url.scheme() {
        "about" if url.as_str() == "about:blank" => GuestNavigation::Allow,
        "about" if !main_frame && url.as_str() == "about:srcdoc" => GuestNavigation::Allow,
        "data" | "blob" if !main_frame => GuestNavigation::Allow,
        "http" | "https" => GuestNavigation::External,
        _ => GuestNavigation::Scheme,
    }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocMode {
    /// No script, no connection; the document as a picture of itself.
    Safe,
    /// Scripts from the root run and may fetch from the root.
    Dynamic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocResetReason {
    /// The file's timestamps are newer than the approval.
    Newer,
    /// The file's content differs from what was served since the approval.
    Changed,
}

/// Why a guest fell back to safe mode on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocReset {
    /// The offending file, relative to the root.
    pub path: String,
    pub reason: DocResetReason,
}

/// Mode and status of one guest, emitted on `browser://doc-state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocGuestState {
    pub tab_id: String,
    pub mode: DocMode,
    /// Absolute directory every request is confined to.
    pub root: String,
    /// Absolute path of the document.
    pub entry: String,
    /// The document's URL inside the guest.
    pub url: String,
    /// Set after the guest dropped back to safe mode by itself; cleared by
    /// the next explicit mode change.
    pub reset: Option<DocReset>,
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/// The state of dynamic mode: when it was granted and what has been served
/// since (path → SHA-256 of the bytes served).
struct Approval {
    approved_at: SystemTime,
    pins: HashMap<PathBuf, [u8; 32]>,
}

struct GrantInner {
    /// `None` = safe mode.
    approval: Option<Approval>,
    reset: Option<DocReset>,
}

/// One document: its root, its entry file, the origin it is served under and
/// the mode the user chose.
pub struct DocGrant {
    /// This document's own host — see [`mint_host`]. Fixed for the grant's
    /// life: it is in every URL the guests showing it are navigated to.
    host: String,
    root: PathBuf,
    entry: PathBuf,
    entry_rel: PathBuf,
    inner: Mutex<GrantInner>,
}

/// Where a document lives, from what the frontend knows: the file, and the
/// root it should be confined to (the owning workspace folder). Both must
/// exist; the root falls back to the file's own directory when it is not
/// given or does not contain the file. Canonical paths come back.
pub fn resolve_document(path: &str, root: Option<&str>) -> Result<(PathBuf, PathBuf), String> {
    let entry = PathBuf::from(path);
    if !entry.is_absolute() {
        return Err(format!("document path must be absolute: {path:?}"));
    }
    let entry = std::fs::canonicalize(&entry).map_err(|e| format!("cannot open {path:?}: {e}"))?;
    if !entry.is_file() {
        return Err(format!("not a file: {path:?}"));
    }
    let parent = entry
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("document has no directory: {path:?}"))?;
    let root = match root {
        Some(root) => match std::fs::canonicalize(root) {
            Ok(root) if root.is_dir() && entry.starts_with(&root) => root,
            _ => parent,
        },
        None => parent,
    };
    Ok((root, entry))
}

impl DocGrant {
    /// `root` and `entry` canonical, `entry` under `root`.
    pub fn new(root: PathBuf, entry: PathBuf) -> Result<Self, String> {
        let entry_rel = entry
            .strip_prefix(&root)
            .map_err(|_| format!("{} is not under {}", entry.display(), root.display()))?
            .to_path_buf();
        Ok(Self {
            host: mint_host(),
            root,
            entry,
            entry_rel,
            inner: Mutex::new(GrantInner {
                approval: None,
                reset: None,
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, GrantInner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The host this document is served under, and no other document is.
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn entry(&self) -> &Path {
        &self.entry
    }

    pub fn mode(&self) -> DocMode {
        if self.lock().approval.is_some() {
            DocMode::Dynamic
        } else {
            DocMode::Safe
        }
    }

    /// The user's decision. Dynamic mode starts a fresh approval — nothing
    /// served before it counts — and either way a pending reset is done with.
    pub fn set_mode(&self, mode: DocMode) {
        let mut inner = self.lock();
        inner.reset = None;
        inner.approval = match mode {
            DocMode::Safe => None,
            DocMode::Dynamic => Some(Approval {
                approved_at: SystemTime::now(),
                pins: HashMap::new(),
            }),
        };
    }

    /// The entry document's URL inside the guest.
    pub fn document_url(&self) -> String {
        document_url(&self.host, &self.entry_rel)
    }

    /// Whether a request is addressed to THIS document's origin.
    ///
    /// The handler is registered per webview and checks the webview it is
    /// called for, but that only says which guest is asking — not what it
    /// asked for. A guest can address any host under the scheme (wry's
    /// Windows filter is `http://codeg-doc.*`, and the macOS handler takes
    /// the scheme whatever the host), so a request for another guest's
    /// origin arrives right here. Answering it would serve this root's files
    /// — no leak in itself — under the other document's origin, which is the
    /// other document's `localStorage`. Per-grant hosts do nothing without
    /// this check; this check is the half that holds.
    fn owns_request(&self, uri: &Uri) -> bool {
        // Both spellings, as everywhere else: wry reverts the Windows
        // mapping before the handler sees a request, and a guest that is
        // handed the mapped one anyway is still asking for its own origin.
        uri.host()
            .is_some_and(|host| host == self.host || host == mapped_host(&self.host))
    }

    pub fn state(&self, tab_id: &str) -> DocGuestState {
        let inner = self.lock();
        DocGuestState {
            tab_id: tab_id.to_string(),
            mode: if inner.approval.is_some() {
                DocMode::Dynamic
            } else {
                DocMode::Safe
            },
            root: self.root.to_string_lossy().into_owned(),
            entry: self.entry.to_string_lossy().into_owned(),
            url: self.document_url(),
            reset: inner.reset.clone(),
        }
    }

    /// Answer one request from the guest. Never fails: every outcome is a
    /// response, and `reset` says when this request ended dynamic mode.
    pub fn serve(&self, request: &Request<Vec<u8>>) -> Served {
        let mode = self.mode();
        if !self.owns_request(request.uri()) {
            return Served::error(
                StatusCode::FORBIDDEN,
                "not this document's origin",
                DocMode::Safe,
            );
        }
        let Some(rel) = request_rel_path(request.uri()) else {
            return Served::error(StatusCode::BAD_REQUEST, "not a document path", mode);
        };
        let (canonical, rel, links_changed, mut file, metadata) = match self.open_confined(&rel) {
            Ok(opened) => opened,
            Err(status) => {
                return Served::error(status, status.canonical_reason().unwrap_or("error"), mode)
            }
        };
        if metadata.len() > MAX_BODY_BYTES {
            return Served::error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "file too large for a document preview",
                mode,
            );
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        if file.read_to_end(&mut bytes).is_err() {
            return Served::error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read file", mode);
        }
        drop(file);
        let rel_display = rel.to_string_lossy().replace('\\', "/");
        // The mode this response is served under is decided together with
        // the approval check, under one lock: a request that started while
        // scripts were on but finds them off answers as safe mode, and one
        // that finds the file changed ends dynamic mode right there.
        let mode = match self.approve(&rel_display, &rel, links_changed, &metadata, &bytes) {
            Ok(mode) => mode,
            Err(reset) => {
                let mut served = Served::error(
                    StatusCode::FORBIDDEN,
                    "file changed after scripts were enabled; the document is back in safe mode",
                    DocMode::Safe,
                );
                served.reset = Some(reset);
                return served;
            }
        };
        let content_type = content_type(&canonical);
        let total = bytes.len() as u64;
        let mut builder = response_builder(mode).header(header::CONTENT_TYPE, content_type);
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            .map(|v| parse_range(v, total));
        let body = match range {
            Some(Some((start, end))) => {
                let end = end.min(start + MAX_RANGE_BYTES - 1).min(total - 1);
                builder = builder.status(StatusCode::PARTIAL_CONTENT).header(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{total}"),
                );
                bytes[start as usize..=end as usize].to_vec()
            }
            Some(None) => {
                return Served {
                    response: response_builder(mode)
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                        .body(Vec::new())
                        .expect("static response"),
                    reset: None,
                };
            }
            None => bytes,
        };
        Served {
            response: builder
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
                .expect("static response"),
            reset: None,
        }
    }

    /// Resolve `rel` under the root, confined: canonicalized (so a symlink
    /// cannot lead outside — a linked folder of the workspace is inside), a
    /// directory answered by its `index.html`, and then opened along the
    /// canonical path without following any symlink, so a component swapped
    /// for a link after the check is refused rather than followed. Also
    /// returns the newest change time of any symlink the REQUESTED path goes
    /// through (a leaf or a directory link), which the approval check needs:
    /// retargeting a link is a change of what the path names.
    #[allow(clippy::type_complexity)]
    fn open_confined(
        &self,
        rel: &Path,
    ) -> Result<(PathBuf, PathBuf, Option<SystemTime>, File, Metadata), StatusCode> {
        let mut rel = rel.to_path_buf();
        let mut canonical =
            std::fs::canonicalize(self.root.join(&rel)).map_err(|_| StatusCode::NOT_FOUND)?;
        if canonical.is_dir() {
            rel.push("index.html");
            canonical = std::fs::canonicalize(canonical.join("index.html"))
                .map_err(|_| StatusCode::NOT_FOUND)?;
        }
        if !crate::commands::folders::is_within_workspace(&self.root, &canonical) {
            return Err(StatusCode::FORBIDDEN);
        }
        // Every symlink on the way — lexical components and the links their
        // targets go through — and the file the walk ends at. A path that
        // cannot be walked (a component gone, a loop) is refused, never
        // served on the strength of the canonicalization alone.
        let (walked, links_changed) =
            walk_links(&self.root, &rel).map_err(|_| StatusCode::NOT_FOUND)?;
        let file = open_beneath(&canonical).map_err(|_| StatusCode::NOT_FOUND)?;
        let metadata = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?;
        if !metadata.is_file() || !same_file(&walked, &metadata) {
            return Err(StatusCode::NOT_FOUND);
        }
        Ok((canonical, rel, links_changed, file, metadata))
    }

    /// Decide the mode a file is served under, and in dynamic mode check
    /// that it is the file that was approved: its timestamps — and those of
    /// the symlink it was requested through, if any — predate the approval,
    /// and its content is what was served under the same requested path
    /// since (pinned on first serve; keyed by the requested path, so a link
    /// retargeted to another file is a change). A failed check ends dynamic
    /// mode right here, under the same lock that checked, so a newer
    /// approval taken meanwhile is not the one being cancelled.
    fn approve(
        &self,
        rel_display: &str,
        rel: &Path,
        links_changed: Option<SystemTime>,
        metadata: &Metadata,
        bytes: &[u8],
    ) -> Result<DocMode, DocReset> {
        let mut inner = self.lock();
        let Some(approval) = inner.approval.as_mut() else {
            // Safe mode — including a request that started while scripts
            // were on and finds them off: it answers under the safe policy.
            return Ok(DocMode::Safe);
        };
        let mut newest = newest_change(metadata);
        if let Some(links) = links_changed {
            newest = newest.max(links);
        }
        let failed = if newest > approval.approved_at {
            Some(DocResetReason::Newer)
        } else {
            let digest: [u8; 32] = Sha256::digest(bytes).into();
            match approval.pins.get(rel) {
                Some(pinned) if *pinned != digest => Some(DocResetReason::Changed),
                Some(_) => None,
                None => {
                    approval.pins.insert(rel.to_path_buf(), digest);
                    None
                }
            }
        };
        match failed {
            None => Ok(DocMode::Dynamic),
            Some(reason) => {
                let reset = DocReset {
                    path: rel_display.to_string(),
                    reason,
                };
                inner.approval = None;
                inner.reset = Some(reset.clone());
                Err(reset)
            }
        }
    }
}

/// Open a canonical path for reading without following any symlink along
/// the way: each component is opened relative to the previous one with
/// `O_NOFOLLOW` (directories with `O_DIRECTORY` as well), so a directory the
/// confinement check saw as real cannot be swapped for a link to somewhere
/// else between the check and the open. The path is canonical, so under
/// normal conditions no component is a link and the walk succeeds.
#[cfg(unix)]
fn open_beneath(canonical: &Path) -> std::io::Result<File> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{AsRawFd, FromRawFd};
    use std::path::Component;

    let mut components = canonical.components().peekable();
    if components.next() != Some(Component::RootDir) {
        return Err(std::io::Error::other("document path is not absolute"));
    }
    // SAFETY: plain libc calls with checked arguments; every descriptor is
    // owned by a `File` as soon as it is valid, so none leaks on an error.
    let mut dir = unsafe {
        let fd = libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        File::from_raw_fd(fd)
    };
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(std::io::Error::other("document path is not canonical"));
        };
        let name = CString::new(name.as_bytes())
            .map_err(|_| std::io::Error::other("NUL in document path"))?;
        let last = components.peek().is_none();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if last { 0 } else { libc::O_DIRECTORY };
        // The parent stays open across the call and is closed right after,
        // when `dir` is replaced.
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        dir = unsafe { File::from_raw_fd(fd) };
    }
    Ok(dir)
}

#[cfg(not(unix))]
fn open_beneath(canonical: &Path) -> std::io::Result<File> {
    // No `openat` here: the final component is protected (reparse points
    // are not followed), the ancestors are the same residual every confined
    // reader in this code base has on this platform.
    crate::commands::folders::open_no_follow(canonical)
}

/// Most links a resolution may go through before it counts as a loop
/// (what the C library allows for `realpath`).
const MAX_LINK_HOPS: usize = 40;

/// Resolve `rel` under `root` the way the filesystem does — component by
/// component, following every symlink met on the way, including the links a
/// link's target goes through — and report where it ends together with the
/// newest change time of every symlink traversed. A link is recreated when
/// it is retargeted, so its own timestamps say when the path last changed
/// what it names; plain directories are left out on purpose (a directory's
/// mtime moves for every unrelated file created next to the document, which
/// is no reason to distrust the document). Any component that cannot be
/// read is an error: the caller refuses rather than serves.
fn walk_links(root: &Path, rel: &Path) -> std::io::Result<(PathBuf, Option<SystemTime>)> {
    use std::collections::VecDeque;
    use std::ffi::OsString;
    use std::path::Component;

    let mut newest: Option<SystemTime> = None;
    let mut current = root.to_path_buf();
    let mut pending: VecDeque<OsString> = rel
        .components()
        .map(|c| c.as_os_str().to_os_string())
        .collect();
    let mut hops = 0;
    while let Some(component) = pending.pop_front() {
        if component == "." {
            continue;
        }
        if component == ".." {
            current.pop();
            continue;
        }
        let candidate = current.join(&component);
        let metadata = std::fs::symlink_metadata(&candidate)?;
        if !metadata.file_type().is_symlink() {
            current = candidate;
            continue;
        }
        hops += 1;
        if hops > MAX_LINK_HOPS {
            return Err(std::io::Error::other("too many symbolic links"));
        }
        let changed = newest_change(&metadata);
        newest = Some(newest.map_or(changed, |n| n.max(changed)));
        let target = std::fs::read_link(&candidate)?;
        // The target's components go in front of what is left to walk; an
        // absolute target starts the walk over from its root.
        let mut spliced: VecDeque<OsString> = VecDeque::new();
        for part in target.components() {
            match part {
                Component::Prefix(prefix) => current = PathBuf::from(prefix.as_os_str()),
                Component::RootDir => current.push(std::path::MAIN_SEPARATOR.to_string()),
                Component::CurDir => {}
                Component::ParentDir => spliced.push_back(OsString::from("..")),
                Component::Normal(name) => spliced.push_back(name.to_os_string()),
            }
        }
        spliced.extend(pending.drain(..));
        pending = spliced;
    }
    Ok((current, newest))
}

/// Whether the walk and the open landed on the same file (device and inode
/// on unix). A link changed between the two would make them differ, and the
/// request is refused. Where identity cannot be checked the walk's own
/// success is what stands.
#[cfg(unix)]
fn same_file(walked: &Path, opened: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(walked)
        .map(|m| m.dev() == opened.dev() && m.ino() == opened.ino())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn same_file(_walked: &Path, _opened: &Metadata) -> bool {
    true
}

/// The last time the file changed by any account the filesystem keeps: its
/// modification time and, where there is one, its status-change time (a
/// rename into place bumps the latter and not the former).
fn newest_change(metadata: &Metadata) -> SystemTime {
    let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ctime = UNIX_EPOCH
            + Duration::new(
                metadata.ctime().max(0) as u64,
                metadata.ctime_nsec().clamp(0, 999_999_999) as u32,
            );
        modified.max(ctime)
    }
    #[cfg(not(unix))]
    {
        modified
    }
}

/// Response to a request, plus whether answering it ended dynamic mode.
pub struct Served {
    pub response: Response<Vec<u8>>,
    pub reset: Option<DocReset>,
}

impl Served {
    fn error(status: StatusCode, message: &str, mode: DocMode) -> Self {
        let body = message.as_bytes().to_vec();
        Served {
            response: response_builder(mode)
                .status(status)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
                .expect("static response"),
            reset: None,
        }
    }
}

/// The answer to a request from a webview that is not the grant's own. The
/// handler is per webview already; this is the belt to that suspender.
pub fn forbidden() -> Response<Vec<u8>> {
    Served::error(StatusCode::FORBIDDEN, "not this document's webview", DocMode::Safe).response
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/// The document URL for a path relative to the root, under one grant's host;
/// each segment percent-encoded by the URL parser.
fn document_url(host: &str, rel: &Path) -> String {
    let mut url = Url::parse(&format!("{DOC_SCHEME}://{host}/")).expect("minted host");
    {
        let mut segments = url.path_segments_mut().expect("url has a host");
        for component in rel.components() {
            segments.push(&component.as_os_str().to_string_lossy());
        }
    }
    url.to_string()
}

/// The path a request asks for, relative to the root, or `None` for a path
/// no document can have: a `.`/`..` segment, a separator inside a segment,
/// a NUL, or bytes that are not UTF-8. The host is not this function's
/// business — [`DocGrant::owns_request`] has already refused anything that
/// is not this document's own.
fn request_rel_path(uri: &Uri) -> Option<PathBuf> {
    let mut rel = PathBuf::new();
    for segment in uri.path().split('/') {
        if segment.is_empty() {
            continue;
        }
        let decoded = percent_encoding::percent_decode_str(segment)
            .decode_utf8()
            .ok()?;
        if decoded == "."
            || decoded == ".."
            || decoded.contains('\0')
            || decoded.contains('/')
            || decoded.contains('\\')
        {
            return None;
        }
        rel.push(&*decoded);
    }
    Some(rel)
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` (one range). `None` = not a range
/// this understands, answer the whole file; `Some(None)` = unsatisfiable.
fn parse_range(header: &str, total: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || total == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            if n == 0 {
                return None;
            }
            (total.saturating_sub(n), total - 1)
        }
        (start, "") => (start.parse().ok()?, total - 1),
        (start, end) => (start.parse().ok()?, end.parse().ok()?),
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total - 1)))
}

/// Safe mode: no script, no connection, resources from the root only. The
/// inline preview's strict policy with real URLs instead of `data:`.
const CSP_SAFE: &str = "default-src 'none'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; script-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

/// Dynamic mode: the document's own scripts run and may fetch from the root;
/// nothing points outside it. Inline scripts and `eval` are allowed because a
/// generated report is exactly the kind of file that has them, and they add
/// no reach: the only endpoint remains the root.
const CSP_DYNAMIC: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' data:; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob:; frame-src 'self' data: blob:; worker-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

pub fn csp_for(mode: DocMode) -> &'static str {
    match mode {
        DocMode::Safe => CSP_SAFE,
        DocMode::Dynamic => CSP_DYNAMIC,
    }
}

fn response_builder(mode: DocMode) -> http::response::Builder {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_SECURITY_POLICY, csp_for(mode))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header("X-DNS-Prefetch-Control", "off")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCEPT_RANGES, "bytes")
}

/// Content type by extension. Unknown types are `application/octet-stream`,
/// which with `nosniff` the engine neither renders nor runs.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" | "xhtml" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "xml" | "xsl" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "txt" | "md" | "markdown" | "log" | "csv" => "text/plain; charset=utf-8",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// Registry of grants
// ---------------------------------------------------------------------------

/// Every document the session has shown, by (root, entry), and which guest
/// tab currently shows which. A grant outlives its guest webview on purpose:
/// the guest is torn down whenever the file leaves the screen, and the mode
/// the user chose — with the approval time it was chosen at — must not be.
#[derive(Default)]
pub struct DocGuests {
    grants: Mutex<HashMap<(PathBuf, PathBuf), Arc<DocGrant>>>,
    by_tab: Mutex<HashMap<String, Arc<DocGrant>>>,
}

impl DocGuests {
    /// The grant for a document, created on first sight.
    pub fn grant_for(&self, root: PathBuf, entry: PathBuf) -> Result<Arc<DocGrant>, String> {
        let mut grants = self.grants.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(grant) = grants.get(&(root.clone(), entry.clone())) {
            return Ok(grant.clone());
        }
        let grant = Arc::new(DocGrant::new(root.clone(), entry.clone())?);
        grants.insert((root, entry), grant.clone());
        Ok(grant)
    }

    pub fn bind(&self, tab_id: &str, grant: Arc<DocGrant>) {
        self.by_tab
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(tab_id.to_string(), grant);
    }

    pub fn unbind(&self, tab_id: &str) {
        self.by_tab
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(tab_id);
    }

    pub fn for_tab(&self, tab_id: &str) -> Option<Arc<DocGrant>> {
        self.by_tab
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(tab_id)
            .cloned()
    }

    /// Every guest currently showing `grant`'s document. A reset applies to
    /// all of them: one guest's document would otherwise keep its dynamic
    /// policy and could still run what the others just refused.
    pub fn tabs_of(&self, grant: &Arc<DocGrant>) -> Vec<String> {
        self.by_tab
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(_, bound)| Arc::ptr_eq(bound, grant))
            .map(|(tab_id, _)| tab_id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        path
    }

    /// A request the way a guest makes it: to its OWN host, which is the
    /// only one its grant answers.
    fn get(grant: &DocGrant, path: &str) -> Served {
        let request = Request::builder()
            .uri(format!("{DOC_SCHEME}://{}{path}", grant.host()))
            .body(Vec::new())
            .unwrap();
        grant.serve(&request)
    }

    fn grant_in(dir: &Path) -> DocGrant {
        let entry = write(dir, "site/index.html", b"<!doctype html><script src=app.js></script>");
        write(dir, "site/app.js", b"console.log(1)");
        write(dir, "site/img/a.png", &[0x89, b'P', b'N', b'G']);
        write(dir, "secret.txt", b"outside");
        let root = std::fs::canonicalize(dir.join("site")).unwrap();
        let entry = std::fs::canonicalize(entry).unwrap();
        DocGrant::new(root, entry).unwrap()
    }

    fn csp(served: &Served) -> String {
        served.response.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn serves_files_under_the_root_with_types_and_fences() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        let page = get(&grant, "/index.html");
        assert_eq!(page.response.status(), StatusCode::OK);
        assert_eq!(page.response.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert!(csp(&page).contains("script-src 'none'"));
        assert_eq!(page.response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(page.response.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(page.response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(page.response.body(), b"<!doctype html><script src=app.js></script>");
        // A directory answers with its index; the root itself too.
        assert_eq!(get(&grant, "/").response.status(), StatusCode::OK);
        assert_eq!(get(&grant, "/img/a.png").response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(get(&grant, "/img/").response.status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&grant, "/missing.css").response.status(), StatusCode::NOT_FOUND);
        // Percent-encoded segments decode; traversal and separators do not.
        assert_eq!(get(&grant, "/img/%61.png").response.status(), StatusCode::OK);
        assert_eq!(get(&grant, "/../secret.txt").response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(get(&grant, "/%2e%2e/secret.txt").response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(get(&grant, "/img%2F..%2F..%2Fsecret.txt").response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(get(&grant, "/a%00.html").response.status(), StatusCode::BAD_REQUEST);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), dir.path().join("site/leak.txt"))
            .unwrap();
        assert_eq!(get(&grant, "/leak.txt").response.status(), StatusCode::FORBIDDEN);
        // A symlink to a sibling inside the root is fine.
        std::os::unix::fs::symlink(dir.path().join("site/app.js"), dir.path().join("site/alias.js"))
            .unwrap();
        assert_eq!(get(&grant, "/alias.js").response.status(), StatusCode::OK);
    }

    #[test]
    fn dynamic_mode_serves_approved_files_and_resets_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        // Files written just now must count as approved: their timestamps
        // are not newer than an approval taken after them.
        grant.set_mode(DocMode::Dynamic);
        assert_eq!(grant.mode(), DocMode::Dynamic);
        let page = get(&grant, "/index.html");
        assert_eq!(page.response.status(), StatusCode::OK);
        assert!(csp(&page).contains("script-src 'self' 'unsafe-inline'"));
        assert!(csp(&page).contains("connect-src 'self'"));
        assert_eq!(get(&grant, "/app.js").response.status(), StatusCode::OK);
        assert!(page.reset.is_none());

        // The script is rewritten after the approval: refused, and the guest
        // is back in safe mode with the file named.
        std::thread::sleep(Duration::from_millis(20));
        write(dir.path(), "site/app.js", b"exfiltrate()");
        let served = get(&grant, "/app.js");
        assert_eq!(served.response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            served.reset,
            Some(DocReset {
                path: "app.js".into(),
                reason: DocResetReason::Newer
            })
        );
        assert_eq!(grant.mode(), DocMode::Safe);
        assert_eq!(grant.state("t").reset.as_ref().map(|r| r.path.as_str()), Some("app.js"));
        // Safe mode serves it (no script runs under the safe CSP anyway).
        let again = get(&grant, "/app.js");
        assert_eq!(again.response.status(), StatusCode::OK);
        assert!(csp(&again).contains("script-src 'none'"));
        // Re-approving clears the reset and starts afresh.
        grant.set_mode(DocMode::Dynamic);
        assert!(grant.state("t").reset.is_none());
        assert_eq!(get(&grant, "/app.js").response.status(), StatusCode::OK);
    }

    #[test]
    fn dynamic_mode_pins_what_it_served() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        grant.set_mode(DocMode::Dynamic);
        assert_eq!(get(&grant, "/app.js").response.status(), StatusCode::OK);
        // Content swapped with the timestamps put back: the pin catches it.
        let path = dir.path().join("site/app.js");
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, b"other()").unwrap();
        let file = File::options().write(true).open(&path).unwrap();
        file.set_modified(before - Duration::from_secs(5)).unwrap();
        drop(file);
        let served = get(&grant, "/app.js");
        // Either the status-change time (unix) or the pinned hash refuses it.
        assert_eq!(served.response.status(), StatusCode::FORBIDDEN);
        assert!(served.reset.is_some());
        assert_eq!(grant.mode(), DocMode::Safe);
    }

    /// Pins are keyed by the path that was asked for: a link served once
    /// and then pointed at another file is a change under that path, even
    /// when the new target is older than the approval.
    #[cfg(unix)]
    #[test]
    fn a_retargeted_link_is_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        let site = dir.path().join("site");
        write(&site, "old.js", b"old()");
        write(&site, "new.js", b"new()");
        // Both targets predate the approval by a wide margin.
        for name in ["old.js", "new.js"] {
            let file = File::options().write(true).open(site.join(name)).unwrap();
            file.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        }
        std::os::unix::fs::symlink(site.join("old.js"), site.join("alias.js")).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        grant.set_mode(DocMode::Dynamic);
        // The link itself was created just before the approval: fine.
        // (Its own timestamps are those of the symlink, not of the target.)
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(get(&grant, "/alias.js").response.status(), StatusCode::OK);
        std::fs::remove_file(site.join("alias.js")).unwrap();
        std::os::unix::fs::symlink(site.join("new.js"), site.join("alias.js")).unwrap();
        let served = get(&grant, "/alias.js");
        assert_eq!(served.response.status(), StatusCode::FORBIDDEN);
        assert!(served.reset.is_some());
        assert_eq!(grant.mode(), DocMode::Safe);
    }

    /// A directory link retargeted after the approval changes what every
    /// path through it names: a file not yet pinned, older than the
    /// approval, must still be refused.
    #[cfg(unix)]
    #[test]
    fn a_retargeted_directory_link_is_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        let site = dir.path().join("site");
        write(&site, "v1/lazy.js", b"v1()");
        write(&site, "v2/lazy.js", b"v2()");
        for name in ["v1/lazy.js", "v2/lazy.js"] {
            let file = File::options().write(true).open(site.join(name)).unwrap();
            file.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        }
        std::os::unix::fs::symlink(site.join("v1"), site.join("vendor")).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        grant.set_mode(DocMode::Dynamic);
        std::thread::sleep(Duration::from_millis(20));
        // Retarget the DIRECTORY link; `vendor/lazy.js` was never served.
        std::fs::remove_file(site.join("vendor")).unwrap();
        std::os::unix::fs::symlink(site.join("v2"), site.join("vendor")).unwrap();
        let served = get(&grant, "/vendor/lazy.js");
        assert_eq!(served.response.status(), StatusCode::FORBIDDEN);
        assert_eq!(served.reset.as_ref().map(|r| r.reason), Some(DocResetReason::Newer));
        assert_eq!(grant.mode(), DocMode::Safe);
    }

    /// A link reached through another link's target is part of the path as
    /// much as a lexical component: retargeting it is a change too.
    #[cfg(unix)]
    #[test]
    fn a_retargeted_link_behind_a_link_is_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        let site = dir.path().join("site");
        write(&site, "v1/lazy.js", b"v1()");
        write(&site, "v2/lazy.js", b"v2()");
        for name in ["v1/lazy.js", "v2/lazy.js"] {
            let file = File::options().write(true).open(site.join(name)).unwrap();
            file.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        }
        // `assets -> linked` (relative), `linked -> v1` (absolute).
        std::os::unix::fs::symlink("linked", site.join("assets")).unwrap();
        std::os::unix::fs::symlink(site.join("v1"), site.join("linked")).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        grant.set_mode(DocMode::Dynamic);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(get(&grant, "/assets/lazy.js").response.status(), StatusCode::OK);
        assert_eq!(get(&grant, "/assets/lazy.js").response.body(), b"v1()");
        std::fs::remove_file(site.join("linked")).unwrap();
        std::os::unix::fs::symlink(site.join("v2"), site.join("linked")).unwrap();
        let served = get(&grant, "/assets/lazy.js");
        assert_eq!(served.response.status(), StatusCode::FORBIDDEN);
        assert_eq!(grant.mode(), DocMode::Safe);
    }

    /// The link walk resolves like the filesystem (relative targets, `..`,
    /// absolute targets) and refuses what it cannot read.
    #[cfg(unix)]
    #[test]
    fn the_link_walk_resolves_like_realpath_and_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        write(&root, "real/deep/file.txt", b"x");
        std::os::unix::fs::symlink("../real/deep", root.join("other/hop")).unwrap_or_else(|_| {
            std::fs::create_dir_all(root.join("other")).unwrap();
            std::os::unix::fs::symlink("../real/deep", root.join("other/hop")).unwrap();
        });
        std::os::unix::fs::symlink(root.join("other"), root.join("abs")).unwrap();
        let (walked, newest) = walk_links(&root, Path::new("abs/hop/file.txt")).unwrap();
        assert_eq!(walked, root.join("real/deep/file.txt"));
        assert!(newest.is_some());
        let (plain, none) = walk_links(&root, Path::new("real/deep/file.txt")).unwrap();
        assert_eq!(plain, root.join("real/deep/file.txt"));
        assert!(none.is_none());
        assert!(walk_links(&root, Path::new("abs/hop/missing.txt")).is_err());
        assert!(walk_links(&root, Path::new("gone/file.txt")).is_err());
        std::os::unix::fs::symlink("loop-b", root.join("loop-a")).unwrap();
        std::os::unix::fs::symlink("loop-a", root.join("loop-b")).unwrap();
        assert!(walk_links(&root, Path::new("loop-a")).is_err());
    }

    /// The component-wise open refuses a path that goes through a symlink,
    /// which is what a directory swapped for a link after the confinement
    /// check would look like.
    #[cfg(unix)]
    #[test]
    fn open_beneath_refuses_symlinked_components() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        write(&real, "a.txt", b"a");
        std::os::unix::fs::symlink(&real, dir.path().join("link")).unwrap();
        let canonical = std::fs::canonicalize(real.join("a.txt")).unwrap();
        assert!(open_beneath(&canonical).is_ok());
        let through_link = std::fs::canonicalize(dir.path()).unwrap().join("link/a.txt");
        assert!(open_beneath(&through_link).is_err());
        assert!(open_beneath(Path::new("relative/a.txt")).is_err());
    }

    /// A request that finds scripts switched off meanwhile answers as safe
    /// mode: the policy in the response follows the decision, not the mode
    /// the request started under.
    #[test]
    fn a_request_after_a_switch_to_safe_is_served_safe() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        grant.set_mode(DocMode::Dynamic);
        grant.set_mode(DocMode::Safe);
        let page = get(&grant, "/index.html");
        assert_eq!(page.response.status(), StatusCode::OK);
        assert!(csp(&page).contains("script-src 'none'"));
        assert!(page.reset.is_none());
    }

    #[test]
    fn ranges_are_answered_in_bounded_pieces() {
        let dir = tempfile::tempdir().unwrap();
        let grant = grant_in(dir.path());
        write(dir.path(), "site/clip.mp4", &[0u8; 100]);
        let request = Request::builder()
            .uri(format!("{DOC_SCHEME}://{}/clip.mp4", grant.host()))
            .header(header::RANGE, "bytes=10-19")
            .body(Vec::new())
            .unwrap();
        let served = grant.serve(&request);
        assert_eq!(served.response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(served.response.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(served.response.body().len(), 10);
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=0-1000", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-2", 100), None);
        assert_eq!(parse_range("bytes=0-1,3-4", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }

    /// The half of per-document origins that actually holds.
    ///
    /// A guest can ask for any host under the scheme — its own handler is
    /// the one that answers, and the webview check passes because it really
    /// is that guest asking. Serving it would hand out this root's files,
    /// which is no leak, under the OTHER document's origin, which is that
    /// document's storage. Distinct hosts without this are decoration.
    #[test]
    fn a_request_for_another_documents_origin_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mine = grant_in(dir.path());
        let theirs = grant_in(&dir.path().join("other"));
        assert_ne!(mine.host(), theirs.host());
        // The file exists and is served to its own origin.
        let own = get(&mine, "/index.html");
        assert_eq!(own.response.status(), StatusCode::OK);
        assert!(!own.response.body().is_empty());
        for host in [
            theirs.host().to_string(),
            mapped_host(theirs.host()),
            // Having this guest's host as a PREFIX is not being it.
            format!("{}x", mine.host()),
            "doc".to_string(),
        ] {
            let request = Request::builder()
                .uri(format!("{DOC_SCHEME}://{host}/index.html"))
                .body(Vec::new())
                .unwrap();
            let served = mine.serve(&request);
            assert_eq!(served.response.status(), StatusCode::FORBIDDEN, "{host}");
            assert!(csp(&served).contains("script-src 'none'"), "{host}");
        }
        // A URI with no authority at all names no origin, so it names no
        // document either. Neither engine sends one — both hand the handler
        // an absolute URL — and refusing would break a guest loudly rather
        // than serve it under a host nobody checked.
        let rootless = Request::builder()
            .uri("/index.html")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            mine.serve(&rootless).response.status(),
            StatusCode::FORBIDDEN
        );
        // The mapped spelling of its OWN host is its own: wry reverts it
        // before the handler sees it, and a guest handed the mapped one is
        // still asking for itself.
        let mapped = Request::builder()
            .uri(format!("{DOC_SCHEME}://{}/index.html", mapped_host(mine.host())))
            .body(Vec::new())
            .unwrap();
        assert_eq!(mine.serve(&mapped).response.status(), StatusCode::OK);
    }

    #[test]
    fn document_urls_and_navigation_policy() {
        let own = "doc-1111";
        assert_eq!(
            document_url(own, Path::new("a b/c#d.html")),
            "codeg-doc://doc-1111/a%20b/c%23d.html"
        );
        assert_eq!(
            document_url(own, Path::new("index.html")),
            "codeg-doc://doc-1111/index.html"
        );
        let doc = Url::parse("codeg-doc://doc-1111/other.html").unwrap();
        assert!(is_document_url(&doc, own));
        assert!(is_document_url(&Url::parse("https://codeg-doc.doc-1111/x").unwrap(), own));
        assert!(!is_document_url(&Url::parse("https://example.com/").unwrap(), own));
        // Not every host that merely begins with the mapped prefix: that one
        // is registrable by anyone, and a guest may navigate to its own.
        assert!(!is_document_url(
            &Url::parse("https://codeg-doc.example.com/steal").unwrap(),
            own
        ));
        assert_eq!(
            guest_navigation(
                &Url::parse("https://codeg-doc.example.com/steal").unwrap(),
                own,
                true
            ),
            GuestNavigation::External
        );
        // Another guest's document, in either spelling. Its files would be
        // no leak — the handler that answers is this guest's — but the origin
        // would be the other document's, and so would the storage.
        for other in [
            "codeg-doc://doc-2222/other.html",
            "https://codeg-doc.doc-2222/other.html",
        ] {
            let other = Url::parse(other).unwrap();
            assert!(!is_document_url(&other, own), "{other}");
        }
        assert_eq!(
            guest_navigation(&Url::parse("codeg-doc://doc-2222/x").unwrap(), own, true),
            GuestNavigation::Scheme
        );
        // A host that differs only in case is not this one: the `url` crate
        // leaves an opaque host as written, so an exact match is the rule
        // and refusing is the safe side of it.
        assert!(!is_document_url(
            &Url::parse("codeg-doc://DOC-1111/x").unwrap(),
            own
        ));
        // A port is a different origin even with the right host — a guest
        // could otherwise give itself a second `localStorage` by asking for
        // one. The default port of a special scheme is not a port.
        assert!(!is_document_url(
            &Url::parse("codeg-doc://doc-1111:8080/x").unwrap(),
            own
        ));
        assert!(!is_document_url(
            &Url::parse("codeg-doc://doc-1111:80/x").unwrap(),
            own
        ));
        assert!(!is_document_url(
            &Url::parse("http://codeg-doc.doc-1111:8080/x").unwrap(),
            own
        ));
        assert!(is_document_url(
            &Url::parse("http://codeg-doc.doc-1111:80/x").unwrap(),
            own
        ));
        assert_eq!(
            guest_navigation(
                &Url::parse("codeg-doc://doc-1111:8080/x").unwrap(),
                own,
                true
            ),
            GuestNavigation::Scheme
        );
        // The spelling the engine is given: rewritten where the engine has no
        // custom schemes, and still a document URL either way.
        let engine = engine_url(&doc);
        assert!(is_document_url(&engine, own));
        if cfg!(target_os = "windows") {
            assert_eq!(engine.as_str(), "http://codeg-doc.doc-1111/other.html");
        } else {
            assert_eq!(engine, doc);
        }
        let web = Url::parse("https://example.com/x").unwrap();
        assert_eq!(engine_url(&web), web);
        assert_eq!(guest_navigation(&doc, own, true), GuestNavigation::Allow);
        assert_eq!(
            guest_navigation(&Url::parse("https://example.com/").unwrap(), own, true),
            GuestNavigation::External
        );
        assert_eq!(
            guest_navigation(&Url::parse("mailto:a@b.c").unwrap(), own, true),
            GuestNavigation::Scheme
        );
        assert_eq!(
            guest_navigation(&Url::parse("file:///etc/hosts").unwrap(), own, true),
            GuestNavigation::Scheme
        );
        assert_eq!(
            guest_navigation(&Url::parse("about:blank").unwrap(), own, true),
            GuestNavigation::Allow
        );
        // Opaque-origin content in the document's own frames only.
        assert_eq!(
            guest_navigation(&Url::parse("about:srcdoc").unwrap(), own, false),
            GuestNavigation::Allow
        );
        assert_eq!(
            guest_navigation(&Url::parse("about:srcdoc").unwrap(), own, true),
            GuestNavigation::Scheme
        );
        assert_eq!(
            guest_navigation(&Url::parse("data:text/html,hi").unwrap(), own, false),
            GuestNavigation::Allow
        );
        assert_eq!(
            guest_navigation(&Url::parse("data:text/html,hi").unwrap(), own, true),
            GuestNavigation::Scheme
        );
    }

    #[test]
    fn resolve_document_confines_to_the_root_or_the_file_directory() {
        let dir = tempfile::tempdir().unwrap();
        let entry = write(dir.path(), "ws/docs/report.html", b"<p>hi</p>");
        let ws = std::fs::canonicalize(dir.path().join("ws")).unwrap();
        let entry_c = std::fs::canonicalize(&entry).unwrap();
        let (root, resolved) =
            resolve_document(entry.to_str().unwrap(), Some(ws.to_str().unwrap())).unwrap();
        assert_eq!(root, ws);
        assert_eq!(resolved, entry_c);
        // No root, or a root that does not contain the file: its own folder.
        let (root, _) = resolve_document(entry.to_str().unwrap(), None).unwrap();
        assert_eq!(root, entry_c.parent().unwrap());
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let (root, _) =
            resolve_document(entry.to_str().unwrap(), Some(elsewhere.to_str().unwrap())).unwrap();
        assert_eq!(root, entry_c.parent().unwrap());
        assert!(resolve_document("relative/path.html", None).is_err());
        assert!(resolve_document(ws.to_str().unwrap(), None).is_err());
        let grant = DocGrant::new(ws.clone(), entry_c).unwrap();
        assert_eq!(
            grant.document_url(),
            format!("codeg-doc://{}/docs/report.html", grant.host())
        );
        let state = grant.state("t1");
        assert_eq!(state.mode, DocMode::Safe);
        assert_eq!(state.root, ws.to_string_lossy());
        assert_eq!(serde_json::to_value(&state).unwrap()["mode"], "safe");
    }

    #[test]
    fn grants_are_shared_per_document_and_bound_per_tab() {
        let dir = tempfile::tempdir().unwrap();
        let entry = write(dir.path(), "a.html", b"x");
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let entry = std::fs::canonicalize(entry).unwrap();
        let guests = DocGuests::default();
        let first = guests.grant_for(root.clone(), entry.clone()).unwrap();
        first.set_mode(DocMode::Dynamic);
        let second = guests.grant_for(root, entry).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(second.mode(), DocMode::Dynamic);
        guests.bind("t1", first.clone());
        assert!(guests.for_tab("t1").is_some());
        // Every guest of a document, for a reset that must reach them all.
        guests.bind("t2", first.clone());
        let other = write(dir.path(), "b.html", b"y");
        let other = guests
            .grant_for(
                std::fs::canonicalize(dir.path()).unwrap(),
                std::fs::canonicalize(other).unwrap(),
            )
            .unwrap();
        // One document, one origin: the two tabs of `first` share a host
        // because they share the grant — same root, same approval, same
        // document. The second document does not, which is what keeps the
        // engine from handing it the first one's storage.
        assert_eq!(first.host(), second.host());
        assert_ne!(first.host(), other.host());
        assert!(first.host().starts_with("doc-"), "{}", first.host());
        guests.bind("t3", other);
        let mut tabs = guests.tabs_of(&first);
        tabs.sort();
        assert_eq!(tabs, vec!["t1".to_string(), "t2".to_string()]);
        guests.unbind("t1");
        assert!(guests.for_tab("t1").is_none());
        assert_eq!(guests.tabs_of(&first), vec!["t2".to_string()]);
        assert_eq!(doc_label("t1"), "codeg-doc-t1");
    }

    #[test]
    fn content_types_by_extension() {
        assert_eq!(content_type(Path::new("A.HTML")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("x.mjs")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("x.woff2")), "font/woff2");
        assert_eq!(content_type(Path::new("x.bin")), "application/octet-stream");
        assert_eq!(content_type(Path::new("noext")), "application/octet-stream");
    }
}
