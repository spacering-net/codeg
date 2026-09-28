//! Centralized resolution of codeg-owned filesystem paths.
//!
//! Mirrors the conventions already used by `preferences.rs` (`~/.codeg/`)
//! and `experts.rs` (`~/.codeg/skills/`). New features that need a
//! user-scoped persistent directory should call into this module instead of
//! re-deriving `dirs::home_dir().join(".codeg")` themselves.

use std::path::{Path, PathBuf};

const CODEG_DIR_NAME: &str = ".codeg";
const PETS_DIR_NAME: &str = "pets";
const BROWSER_PROFILES_DIR_NAME: &str = "browser-profiles";
const UPLOADS_DIR_NAME: &str = "uploads";
const LOGS_DIR_NAME: &str = "logs";
const TURN_TIMINGS_DIR_NAME: &str = "turn-timings";
const ACP_TRANSCRIPTS_DIR_NAME: &str = "acp-transcripts";
const BACKGROUNDS_DIR_NAME: &str = "backgrounds";

/// `$CODEG_HOME` if set (and non-empty), else `~/.codeg/`.
///
/// Returns the relative `.codeg` path when no home directory is available;
/// callers must still handle creation failures gracefully.
pub fn codeg_home_dir() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom);
    }
    dirs::home_dir()
        .map(|h| h.join(CODEG_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(CODEG_DIR_NAME))
}

/// Root directory for desktop-pet assets.
///
/// Resolution order:
/// 1. `$CODEG_HOME/pets` (explicit override, used in tests and custom installs)
/// 2. `$CODEG_DATA_DIR/pets` (server-mode data directory, populated by
///    `codeg-server` from the corresponding env var)
/// 3. `~/.codeg/pets` (default for the desktop app)
pub fn codeg_pets_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(PETS_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(PETS_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(CODEG_DIR_NAME).join(PETS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(CODEG_DIR_NAME).join(PETS_DIR_NAME))
}

/// Root directory for built-in browser profiles (WebView2 user-data folders
/// on Windows, WebKitGTK data directories on Linux; macOS keeps profiles in
/// WebKit's own store and never reads this).
///
/// Resolution order matches `codeg_pets_root()`.
pub fn codeg_browser_profiles_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(BROWSER_PROFILES_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(BROWSER_PROFILES_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(CODEG_DIR_NAME).join(BROWSER_PROFILES_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(CODEG_DIR_NAME).join(BROWSER_PROFILES_DIR_NAME))
}

/// Root directory for attachments uploaded from the web client.
///
/// Resolution order matches `codeg_pets_root()`:
/// 1. `$CODEG_HOME/uploads`
/// 2. `$CODEG_DATA_DIR/uploads` (server-mode data directory)
/// 3. `~/.codeg/uploads` (desktop default)
///
/// Files in this directory are not garbage-collected by codeg itself —
/// later conversations may still reference them via `file://` URIs
/// embedded in session history. To bound the long-term footprint on
/// shared / multi-tenant servers, operators can set
/// `CODEG_UPLOAD_MAX_TOTAL_BYTES` (see `web::handlers::files`): new
/// uploads beyond the cap are rejected at the API boundary while
/// existing files stay readable.
///
/// **Concurrency contract:** the quota check uses a process-local
/// in-flight reservation counter to make `CODEG_UPLOAD_MAX_TOTAL_BYTES`
/// a hard ceiling within one `codeg-server` process. Multiple
/// `codeg-server` processes sharing the same uploads root (e.g.
/// horizontally-scaled containers mounted on the same volume) will
/// each enforce the cap independently and can collectively exceed it.
/// codeg is designed for single-process deployments; horizontal
/// scaling would require external coordination (file lock, Redis,
/// reverse-proxy quota) that this codebase does not provide.
pub fn codeg_uploads_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(UPLOADS_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(UPLOADS_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(CODEG_DIR_NAME).join(UPLOADS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(CODEG_DIR_NAME).join(UPLOADS_DIR_NAME))
}

/// Root directory for the user-selected workspace background image.
///
/// Resolution mirrors [`codeg_pets_root`] exactly:
/// 1. `$CODEG_HOME/backgrounds` (explicit override)
/// 2. `$CODEG_DATA_DIR/backgrounds` (server-mode data directory)
/// 3. `~/.codeg/backgrounds` (desktop default)
pub fn codeg_backgrounds_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(BACKGROUNDS_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(BACKGROUNDS_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(CODEG_DIR_NAME).join(BACKGROUNDS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(CODEG_DIR_NAME).join(BACKGROUNDS_DIR_NAME))
}

/// Root directory for application diagnostic logs (rotating files written by
/// the `tracing` file appender; see `crate::logging`).
///
/// Resolution mirrors [`codeg_uploads_root`] exactly so logs land on the same
/// filesystem root as uploads/pets/the database:
/// 1. `$CODEG_HOME/logs` (explicit override)
/// 2. `$CODEG_DATA_DIR/logs` (server-mode data directory)
/// 3. `~/.codeg/logs` (default for the desktop app)
///
/// Pure env + `dirs::home_dir()`, so it is callable at the very start of a
/// process — before the database (or, in `codeg-server`, the tokio runtime)
/// exists — which is exactly when the subscriber must be installed.
pub fn codeg_logs_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(LOGS_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(LOGS_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(CODEG_DIR_NAME).join(LOGS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(CODEG_DIR_NAME).join(LOGS_DIR_NAME))
}

/// Root directory for codeg's own per-turn timing observations (see
/// `crate::turn_timings`) — wall-clock turn spans the ACP connection layer
/// records for agents whose native session store carries no per-turn
/// timestamps (Cursor). Written by the live connection, read back by the
/// history parser.
///
/// Resolution mirrors [`codeg_uploads_root`]:
/// 1. `$CODEG_HOME/turn-timings`
/// 2. `$CODEG_DATA_DIR/turn-timings` (server-mode data directory)
/// 3. `~/.codeg/turn-timings` (desktop default)
pub fn codeg_turn_timings_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(TURN_TIMINGS_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(TURN_TIMINGS_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(CODEG_DIR_NAME).join(TURN_TIMINGS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(CODEG_DIR_NAME).join(TURN_TIMINGS_DIR_NAME))
}

/// Root directory for codeg's own ACP transcripts (see
/// `crate::acp_transcript`) — the raw `session/update` stream and outgoing
/// prompts recorded for **custom ACP agents**, which have no codeg-side
/// transcript parser of their own. Written by the live connection, read back
/// by `crate::parsers::acp_native`.
///
/// Resolution mirrors [`codeg_turn_timings_root`]:
/// 1. `$CODEG_HOME/acp-transcripts`
/// 2. `$CODEG_DATA_DIR/acp-transcripts` (server-mode data directory)
/// 3. `~/.codeg/acp-transcripts` (desktop default)
pub fn codeg_acp_transcripts_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        return PathBuf::from(custom).join(ACP_TRANSCRIPTS_DIR_NAME);
    }
    if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(data).join(ACP_TRANSCRIPTS_DIR_NAME);
    }
    dirs::home_dir()
        .map(|h| h.join(CODEG_DIR_NAME).join(ACP_TRANSCRIPTS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(CODEG_DIR_NAME).join(ACP_TRANSCRIPTS_DIR_NAME))
}

/// Single source of truth for "where does the database live, and where
/// do `paths::*` resolve their roots against."
///
/// Resolution:
/// 1. If `CODEG_DATA_DIR` is set and non-empty, return its absolutized
///    form. Honors the operator's choice even on desktop, where a
///    pre-set env var should override Tauri's identifier-derived path.
/// 2. Otherwise return the absolutized form of `tauri_fallback` —
///    typically `app.path().app_data_dir()` on desktop or the
///    server's default data dir.
///
/// Always returns an absolute path (`absolutize` re-bases against the
/// process CWD if needed). Callers should treat the result as
/// authoritative and not re-read `CODEG_DATA_DIR` themselves; the
/// startup code in `lib.rs` / `bin/codeg_server.rs` writes the
/// resolved value back to the env so subprocess inheritance works,
/// but the in-process source of truth is this function.
///
/// This exists because Tauri's `app.path().app_data_dir()` does **not**
/// consult `CODEG_DATA_DIR` — it returns the identifier-derived path
/// unconditionally. Call sites that pass `app_data_dir()` straight
/// into git credential helpers, ACP, terminal sessions, etc. would
/// otherwise generate scripts pointing at an empty DB when the
/// operator pre-set `CODEG_DATA_DIR` to a custom location.
pub fn resolve_effective_data_dir(tauri_fallback: &Path) -> PathBuf {
    if let Some(custom) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return crate::git_credential::absolutize(Path::new(&custom));
    }
    crate::git_credential::absolutize(tauri_fallback)
}

/// Drop the Windows extended-length ("verbatim") prefix from a path, so the
/// plain form is what leaves this process.
///
/// `fs::canonicalize` on Windows resolves through `GetFinalPathNameByHandleW`
/// and **always** returns the verbatim form — `\\?\C:\…`, or `\\?\UNC\server\
/// share\…` for a network share. That is the right thing to keep feeding back
/// into Rust filesystem calls, but it must not escape into a value some other
/// layer parses: the frontend's `buildFileUri` normalizes `\` to `/`, which
/// turns `\\?\C:\…` into `//?/C:/…` and trips its UNC-authority branch,
/// yielding a uri that decodes back to the bogus path `?/C:/…` (issue #392).
/// Callers that hand a canonical path to a client should route it through
/// here first; the canonical value itself stays in use for jail checks.
///
/// Only the two prefixes with a plain equivalent are rewritten. `\\?\Volume{…}`
/// and other device paths have none, so they pass through untouched — as does
/// every path that never had a verbatim prefix, which on Unix is all of them
/// (the prefix is not valid syntax there, and an upload path cannot acquire
/// one: `sanitize_upload_filename` strips backslashes and the bucket name is
/// alphanumeric). Non-UTF-8 paths are returned as-is rather than risk a lossy
/// rewrite.
pub fn simplify_verbatim_path(path: &Path) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = strip_prefix_ignore_ascii_case(text, r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// `str::strip_prefix` with an ASCII-case-insensitive comparison. Windows
/// accepts `\\?\unc\` as readily as `\\?\UNC\`, and the casing a path picked
/// up is not ours to predict.
fn strip_prefix_ignore_ascii_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

// The resolver functions above depend on global env vars (`CODEG_HOME`,
// `CODEG_DATA_DIR`), so unit tests would need cross-test serialization to
// avoid races. The behaviour is covered end-to-end by `pets::*` tests which
// set `CODEG_HOME` inside a serialized test mutex; we deliberately don't
// duplicate that here. `simplify_verbatim_path` reads no env, so it is
// tested directly.
#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `fs::canonicalize` hands back on Windows, and the one that
    /// broke image attachments in issue #392.
    #[test]
    fn simplifies_a_verbatim_drive_path() {
        assert_eq!(
            simplify_verbatim_path(Path::new(r"\\?\C:\Users\song\.codeg\uploads\b\img.png")),
            PathBuf::from(r"C:\Users\song\.codeg\uploads\b\img.png")
        );
    }

    #[test]
    fn simplifies_a_verbatim_unc_path_in_either_casing() {
        assert_eq!(
            simplify_verbatim_path(Path::new(r"\\?\UNC\srv\share\img.png")),
            PathBuf::from(r"\\srv\share\img.png")
        );
        assert_eq!(
            simplify_verbatim_path(Path::new(r"\\?\unc\srv\share\img.png")),
            PathBuf::from(r"\\srv\share\img.png")
        );
    }

    /// Everything without a rewritable prefix must come back byte-identical —
    /// this is what keeps the Linux/macOS/Docker upload response unchanged.
    #[test]
    fn leaves_every_other_shape_untouched() {
        for path in [
            "/home/u/.codeg/uploads/b/img.png",
            "/data/uploads/b/img.png",
            r"C:\Users\song\img.png",
            r"\\srv\share\img.png",
            r"\\?\Volume{7b2f1c40-0000-0000-0000-100000000000}\img.png",
            "relative/path.png",
        ] {
            assert_eq!(
                simplify_verbatim_path(Path::new(path)),
                PathBuf::from(path),
                "rewrote a path that has no verbatim prefix: {path}"
            );
        }
    }
}
