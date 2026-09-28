//! Downloads started by a browser tab.
//!
//! P1 refused every download outright (no destination policy, no UI). Here the
//! host takes the decision the engine offers it: where the file lands, and
//! that nothing is ever overwritten or opened afterwards. The engine does the
//! transfer; we only choose the path, remember the record and tell the
//! frontend, which shows a bar with "show in folder".
//!
//! Two platform facts shape this module:
//! - The name in the engine's suggested destination comes from the SERVER
//!   (`Content-Disposition`) — untrusted. Only its last component is used, and
//!   only after `safe_file_name` has stripped anything that could climb out of
//!   the downloads directory.
//! - On macOS the finished callback carries no path at all (wry / WebKit API
//!   limitation), so the destination chosen at request time is remembered here
//!   and matched back by URL when the transfer ends.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::events;

pub const DOWNLOAD_EVENT: &str = "browser://download";

/// How many finished records are kept for the UI; the bar shows the last few
/// and a download is a file on disk afterwards, not a thing to scroll back to.
const HISTORY_LIMIT: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadState {
    Started,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownload {
    pub id: String,
    /// Tab the download started in; the bar shows it there.
    pub tab_id: String,
    pub url: String,
    pub file_name: String,
    /// Absolute path the engine was told to write to.
    pub path: String,
    pub state: DownloadState,
}

#[derive(Default)]
pub struct BrowserDownloads {
    entries: Mutex<Vec<BrowserDownload>>,
    /// Destinations handed to the engine that no transfer has finished with
    /// yet. `unique_path` cannot reserve a path on disk — the engines require
    /// a destination that does NOT exist — so two downloads started in the
    /// same instant would otherwise be handed the same free name and write
    /// over each other.
    reserved: Mutex<HashSet<PathBuf>>,
}

static DOWNLOAD_SEQ: AtomicU64 = AtomicU64::new(0);

impl BrowserDownloads {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<BrowserDownload>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reserved(&self) -> std::sync::MutexGuard<'_, HashSet<PathBuf>> {
        self.reserved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn push(&self, download: BrowserDownload) {
        let mut entries = self.lock();
        entries.push(download);
        // Only FINISHED records are evictable: dropping a running one would
        // leave its completion with nothing to update, and the frontend would
        // show it as downloading for ever.
        while entries.len() > HISTORY_LIMIT {
            let Some(oldest_done) = entries
                .iter()
                .position(|d| d.state != DownloadState::Started)
            else {
                break;
            };
            entries.remove(oldest_done);
        }
    }

    /// Finish the oldest in-flight download of `url` (the only identity the
    /// completion callback carries) and return the updated record.
    fn finish(&self, url: &str, success: bool, path: Option<PathBuf>) -> Option<BrowserDownload> {
        let mut entries = self.lock();
        let entry = entries
            .iter_mut()
            .find(|d| d.url == url && d.state == DownloadState::Started)?;
        entry.state = if success {
            DownloadState::Completed
        } else {
            DownloadState::Failed
        };
        // Windows / Linux report where the file actually landed; macOS does
        // not, and keeps the path chosen when the download was requested.
        if let Some(path) = path {
            if success && !path.as_os_str().is_empty() {
                entry.file_name = file_name_of(&path);
                entry.path = path.to_string_lossy().to_string();
            }
        }
        let done = entry.clone();
        drop(entries);
        self.reserved().remove(Path::new(&done.path));
        Some(done)
    }

    pub fn list(&self) -> Vec<BrowserDownload> {
        self.lock().clone()
    }

    /// The file one record points at, if it finished and still names a path.
    fn path_of(&self, id: &str) -> Option<PathBuf> {
        let entries = self.lock();
        let entry = entries
            .iter()
            .find(|d| d.id == id && d.state == DownloadState::Completed)?;
        (!entry.path.is_empty()).then(|| PathBuf::from(&entry.path))
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    /// A free destination for `file_name`, remembered so a second download
    /// started before this one finishes cannot be handed the same path.
    fn reserve(&self, dir: &Path, file_name: &str) -> PathBuf {
        let mut reserved = self.reserved();
        let path = unique_path_excluding(dir, file_name, &reserved);
        reserved.insert(path.clone());
        path
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Where downloads land: the OS download folder, else `~/Downloads`. Not
/// configurable in this pass, and deliberately NOT inside the app's data
/// directory — a downloaded file belongs to the user, not to codeg.
pub fn downloads_dir() -> PathBuf {
    if let Some(dir) = dirs::download_dir() {
        return dir;
    }
    dirs::home_dir()
        .map(|home| home.join("Downloads"))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The server-suggested name, reduced to something that can only ever name a
/// file directly inside the downloads directory. Separators, parent hops,
/// NUL / control characters and leading dots are all removed; an empty or
/// hopeless name becomes `download`.
pub fn safe_file_name(suggested: &str) -> String {
    // Both separators on every platform: a Windows-style name arriving on
    // macOS must not become one file called `..\\..\\x`.
    let last = suggested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(suggested)
        .trim();
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '\0'))
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() || cleaned == ".." {
        return "download".to_string();
    }
    // `CON`, `NUL.txt`, `LPT1`… still name DEVICES on Windows, whatever the
    // extension: writing there either fails or talks to hardware. Neutralised
    // on every platform so a profile is portable and the tests are not
    // per-OS.
    let cleaned = &prefix_reserved_device_name(cleaned);
    // Long names are a filesystem error, not a security problem; keep the
    // extension by trimming the stem.
    const MAX: usize = 120;
    if cleaned.chars().count() <= MAX {
        return cleaned.to_string();
    }
    let path = Path::new(cleaned);
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let stem: String = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .take(MAX.saturating_sub(ext.chars().count()))
        .collect();
    format!("{stem}{ext}")
}

const WINDOWS_DEVICE_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn prefix_reserved_device_name(name: &str) -> String {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    if WINDOWS_DEVICE_NAMES.contains(&stem.as_str()) {
        format!("_{name}")
    } else {
        name.to_string()
    }
}

/// Taken = anything at this path, INCLUDING a symlink (`symlink_metadata`
/// does not follow it). A dangling link reports "nothing here" to `exists()`,
/// and handing that path to the engine would write through the link to
/// wherever it points — outside the downloads directory.
fn path_is_taken(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// `dir/name`, with ` (1)`, ` (2)`… appended before the extension until the
/// path is free. A download NEVER replaces a file that is already there.
pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    unique_path_excluding(dir, file_name, &HashSet::new())
}

fn unique_path_excluding(dir: &Path, file_name: &str, taken: &HashSet<PathBuf>) -> PathBuf {
    let free = |path: &Path| !taken.contains(path) && !path_is_taken(path);
    let candidate = dir.join(file_name);
    if free(&candidate) {
        return candidate;
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for counter in 1..10_000 {
        let candidate = dir.join(format!("{stem} ({counter}){ext}"));
        if free(&candidate) {
            return candidate;
        }
    }
    // Pathological directory; a timestamp is still unique enough to write to.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    dir.join(format!("{stem} ({stamp}){ext}"))
}

/// A download was requested in `tab_id`. Rewrites `destination` to a free path
/// under the downloads directory and records the download. Returns false when
/// the directory cannot be created — the engine then cancels, which is the
/// honest outcome (there is nowhere to write).
pub fn requested(app: &AppHandle, tab_id: &str, url: &str, destination: &mut PathBuf) -> bool {
    let dir = downloads_dir();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        tracing::warn!(
            "[browser] refusing the download of {url}: {} is not writable ({err})",
            dir.display()
        );
        return false;
    }
    let Some(downloads) = app.try_state::<BrowserDownloads>() else {
        return false;
    };
    // The engine already suggested a name (and on macOS a whole path); only
    // its last component is used, and only after sanitising.
    let file_name = safe_file_name(&file_name_of(destination));
    let path = downloads.reserve(&dir, &file_name);
    *destination = path.clone();

    let seq = DOWNLOAD_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let download = BrowserDownload {
        id: format!("dl-{seq}"),
        tab_id: tab_id.to_string(),
        url: url.to_string(),
        file_name: file_name_of(&path),
        path: path.to_string_lossy().to_string(),
        state: DownloadState::Started,
    };
    downloads.push(download.clone());
    // The navigation that produced this download will never commit; mark the
    // generation so its load watcher settles quietly instead of reporting a
    // page that failed to arrive.
    super::hooks::navigation_became_download(app, tab_id);
    events::emit_download(app, &download);
    true
}

/// The engine finished (or gave up on) a download.
pub fn finished(app: &AppHandle, url: &str, path: Option<PathBuf>, success: bool) {
    let Some(downloads) = app.try_state::<BrowserDownloads>() else {
        return;
    };
    if let Some(download) = downloads.finish(url, success, path) {
        events::emit_download(app, &download);
    }
}

/// Where a tab's downloads go, for the settings section.
pub fn downloads_dir_display() -> String {
    downloads_dir().to_string_lossy().to_string()
}

/// Show a finished download in the file manager, selected where the platform
/// can select. The path comes from the record and never from the caller, so
/// the only thing this can point the file manager at is a file the browser
/// itself wrote.
///
/// The opener plugin normally does this, and normally should: this exists
/// because it resolves the path first, which on Windows turns a network
/// location into the extended `\\?\UNC\…` form that the shell's
/// `ILCreateFromPath` refuses — leaving "show in folder" dead for anyone
/// whose downloads land on a share or a redirected folder.
pub fn reveal(downloads: &BrowserDownloads, id: &str) -> Result<(), String> {
    let path = downloads
        .path_of(id)
        .ok_or_else(|| format!("no finished download {id}"))?;
    if !path.exists() {
        return Err(format!("{} is no longer there", path.display()));
    }
    // Windows only: that arm builds a command line by hand (`/select,` needs
    // the path quoted inside one argument), so a quote in the path would end
    // it. A downloaded name cannot contain one there — `safe_file_name` and
    // Windows itself both refuse — which is what makes the check cheap to
    // keep. Elsewhere a quote is an ordinary character in a file name and the
    // argument is passed structurally, so refusing it would only break the
    // button for a file that is perfectly fine.
    #[cfg(target_os = "windows")]
    if path.to_string_lossy().contains('"') {
        return Err("the path contains a quote".to_string());
    }
    let mut command = reveal_command(&path);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot show {}: {e}", path.display()))
}

/// The file manager invocation that selects `path` (or, where selecting is
/// not a thing, opens the folder it is in). Not waited on: Explorer answers
/// with a non-zero exit code even when it did open the window.
fn reveal_command(path: &Path) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("explorer.exe");
        let text = path.display().to_string();
        // `/select,` is one argument, comma and all, with the path quoted
        // INSIDE it — a shape `arg` cannot produce, hence the raw command
        // line. And Explorer does not follow it into a UNC path: it drops the
        // argument and lands on a default folder, so a network location gets
        // the folder it is in, opened rather than selected in.
        if text.starts_with(r"\\") {
            let dir = path.parent().unwrap_or(path);
            command.raw_arg(format!("\"{}\"", dir.display()));
        } else {
            command.raw_arg(format!("/select,\"{text}\""));
        }
        command
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(path);
        command
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path.parent().unwrap_or(path));
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suggested_name_can_only_name_a_file_in_the_directory() {
        assert_eq!(safe_file_name("report.pdf"), "report.pdf");
        // Path traversal in every shape the server can send.
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("..\\..\\Windows\\system.ini"), "system.ini");
        assert_eq!(safe_file_name("/absolute/evil.sh"), "evil.sh");
        assert_eq!(safe_file_name(".."), "download");
        assert_eq!(safe_file_name("."), "download");
        assert_eq!(safe_file_name(""), "download");
        assert_eq!(safe_file_name("   "), "download");
        // A leading dot would make the file invisible; drive letters and NUL
        // cannot survive either.
        assert_eq!(safe_file_name(".bashrc"), "bashrc");
        assert_eq!(safe_file_name("C:\\x\\y.txt"), "y.txt");
        assert_eq!(safe_file_name("a\u{0}b.txt"), "ab.txt");
        assert_eq!(safe_file_name("line\nbreak.txt"), "linebreak.txt");
    }

    #[test]
    fn a_long_name_keeps_its_extension() {
        let name = safe_file_name(&format!("{}.tar.gz", "x".repeat(400)));
        assert!(name.chars().count() <= 120, "{name}");
        assert!(name.ends_with(".gz"), "{name}");
    }

    #[test]
    fn a_download_never_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = unique_path(dir.path(), "report.pdf");
        assert_eq!(first, dir.path().join("report.pdf"));
        std::fs::write(&first, b"one").unwrap();

        let second = unique_path(dir.path(), "report.pdf");
        assert_eq!(second, dir.path().join("report (1).pdf"));
        std::fs::write(&second, b"two").unwrap();

        assert_eq!(
            unique_path(dir.path(), "report.pdf"),
            dir.path().join("report (2).pdf")
        );
        // The first file is untouched.
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
    }

    #[test]
    fn an_extensionless_name_is_numbered_too() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("LICENSE"), b"x").unwrap();
        assert_eq!(
            unique_path(dir.path(), "LICENSE"),
            dir.path().join("LICENSE (1)")
        );
    }

    #[test]
    fn the_registry_finishes_the_matching_download_and_caps_its_history() {
        let downloads = BrowserDownloads::default();
        let record = |id: &str, url: &str| BrowserDownload {
            id: id.into(),
            tab_id: "t1".into(),
            url: url.into(),
            file_name: "a.bin".into(),
            path: format!("/tmp/{id}.bin"),
            state: DownloadState::Started,
        };
        downloads.push(record("dl-1", "https://example.com/a"));
        downloads.push(record("dl-2", "https://example.com/b"));
        // Same URL twice: the oldest still running finishes first.
        downloads.push(record("dl-3", "https://example.com/a"));

        let done = downloads
            .finish("https://example.com/a", true, Some(PathBuf::from("/tmp/z.bin")))
            .unwrap();
        assert_eq!(done.id, "dl-1");
        assert_eq!(done.state, DownloadState::Completed);
        assert_eq!(done.file_name, "z.bin");
        let again = downloads.finish("https://example.com/a", false, None).unwrap();
        assert_eq!(again.id, "dl-3");
        assert_eq!(again.state, DownloadState::Failed);
        assert!(downloads.finish("https://example.com/a", true, None).is_none());
        // A failed download keeps the path it was going to be written to.
        assert_eq!(again.path, "/tmp/dl-3.bin");

        // Finished records are the evictable ones (see the cap test below).
        for i in 0..HISTORY_LIMIT + 5 {
            let url = format!("https://example.com/c{i}");
            downloads.push(record(&format!("x-{i}"), &url));
            downloads.finish(&url, true, None);
        }
        assert_eq!(downloads.list().len(), HISTORY_LIMIT);
        downloads.clear();
        assert!(downloads.list().is_empty());
    }

    #[test]
    fn windows_device_names_cannot_survive() {
        assert_eq!(safe_file_name("CON"), "_CON");
        assert_eq!(safe_file_name("nul.txt"), "_nul.txt");
        assert_eq!(safe_file_name("LPT1.tar.gz"), "_LPT1.tar.gz");
        // Only the exact stems; a name that merely starts with one is fine.
        assert_eq!(safe_file_name("console.log"), "console.log");
        assert_eq!(safe_file_name("com10.txt"), "com10.txt");
    }

    /// A dangling symlink is "nothing here" to `exists()`, and the engine
    /// would write through it to wherever it points.
    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_way_counts_as_taken() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("report.pdf"))
            .unwrap();
        assert!(!dir.path().join("report.pdf").exists());
        assert_eq!(
            unique_path(dir.path(), "report.pdf"),
            dir.path().join("report (1).pdf")
        );
    }

    #[test]
    fn two_downloads_started_at_once_get_different_paths() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = BrowserDownloads::default();
        // Neither file exists yet: without a reservation both would be told
        // to write to `report.pdf`.
        let first = downloads.reserve(dir.path(), "report.pdf");
        let second = downloads.reserve(dir.path(), "report.pdf");
        assert_eq!(first, dir.path().join("report.pdf"));
        assert_eq!(second, dir.path().join("report (1).pdf"));

        // The reservation is released when the transfer ends, so the name is
        // reusable once the file is gone again.
        downloads.push(BrowserDownload {
            id: "dl-1".into(),
            tab_id: "t1".into(),
            url: "https://example.com/report.pdf".into(),
            file_name: "report.pdf".into(),
            path: first.to_string_lossy().to_string(),
            state: DownloadState::Started,
        });
        downloads.finish("https://example.com/report.pdf", true, None);
        assert_eq!(downloads.reserve(dir.path(), "report.pdf"), first);
    }

    /// The cap must never drop a transfer that is still running: its
    /// completion would find nothing and the UI would say "downloading" for
    /// ever.
    #[test]
    fn the_history_cap_never_evicts_a_running_download() {
        let downloads = BrowserDownloads::default();
        let record = |id: &str, state: DownloadState| BrowserDownload {
            id: id.into(),
            tab_id: "t1".into(),
            url: format!("https://example.com/{id}"),
            file_name: "a.bin".into(),
            path: format!("/tmp/{id}.bin"),
            state,
        };
        for i in 0..HISTORY_LIMIT + 4 {
            downloads.push(record(&format!("run-{i}"), DownloadState::Started));
        }
        // Nothing finished, so nothing may be evicted, cap or no cap.
        assert_eq!(downloads.list().len(), HISTORY_LIMIT + 4);

        downloads.finish("https://example.com/run-0", true, None);
        downloads.finish("https://example.com/run-1", true, None);
        downloads.push(record("newest", DownloadState::Started));
        let ids: Vec<String> = downloads.list().into_iter().map(|d| d.id).collect();
        // The two finished ones went first; every running record survived.
        assert!(!ids.contains(&"run-0".to_string()));
        assert!(ids.contains(&"run-2".to_string()));
        assert!(ids.contains(&"newest".to_string()));
    }

    #[test]
    fn wire_names_are_camel_and_kebab() {
        let json = serde_json::to_value(BrowserDownload {
            id: "dl-1".into(),
            tab_id: "t1".into(),
            url: "https://example.com/a.bin".into(),
            file_name: "a.bin".into(),
            path: "/tmp/a.bin".into(),
            state: DownloadState::Started,
        })
        .unwrap();
        assert_eq!(json["tabId"], "t1");
        assert_eq!(json["fileName"], "a.bin");
        assert_eq!(json["state"], "started");
    }
}
