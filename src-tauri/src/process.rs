use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long to keep retrying a spawn the kernel refuses with `ETXTBSY`.
/// Generous on purpose: the window it covers is another thread's fork→exec gap,
/// which is microseconds wide when idle but can stretch on a loaded machine.
const EXEC_BUSY_RETRY_BUDGET: Duration = Duration::from_secs(1);
/// Upper bound on the wait between `ETXTBSY` retries.
const EXEC_BUSY_MAX_BACKOFF: Duration = Duration::from_millis(25);

pub fn configure_std_command(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    set_utf8_env(command);
    command
}

pub fn std_command<S>(program: S) -> Command
where
    S: AsRef<OsStr>,
{
    let mut command = Command::new(normalized_program(program));
    configure_std_command(&mut command);
    command
}

pub fn configure_tokio_command(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    set_utf8_env(command);
    command
}

/// Force child processes to emit English, UTF-8 output.
///
/// Why: downstream code classifies errors by substring-matching English
/// git/coreutils stderr (e.g. "unknown revision or path not in the working
/// tree"). Without pinning the locale, those matches silently fail under
/// non-English system locales and legitimate empty-repo cases bubble up as
/// red error banners.
fn set_utf8_env<C: SetEnv>(command: &mut C) {
    // Python
    command.env("PYTHONUTF8", "1");
    command.env("PYTHONIOENCODING", "utf-8");
    // POSIX locale — honored by git, coreutils, MSYS2/Git-for-Windows.
    command.env("LANG", "C.UTF-8");
    command.env("LC_ALL", "C.UTF-8");
}

/// Abstraction over the `.env()` method shared by std and tokio Command types.
trait SetEnv {
    fn env(&mut self, key: &str, val: &str) -> &mut Self;
}

impl SetEnv for Command {
    fn env(&mut self, key: &str, val: &str) -> &mut Self {
        Command::env(self, key, val)
    }
}

impl SetEnv for tokio::process::Command {
    fn env(&mut self, key: &str, val: &str) -> &mut Self {
        tokio::process::Command::env(self, key, val)
    }
}

/// On Windows, resolve a bare program name to its concrete file on PATH
/// by trying `.exe → .cmd → .bat` in order.
///
/// Rust's `Command::new("foo")` on Windows relies on `CreateProcessW`'s
/// implicit extension lookup, which does not locate `.cmd` / `.bat` shims
/// reliably for many npm-installed tools (`tsc`, `vite`, `eslint`, ...).
/// Without this helper those agents hang or ENOENT when ACP agents send
/// bare names. Extension fallback is **purely additive**: if the caller
/// already supplied a path, extension, or the `.exe` is found, the result
/// is identical to the previous behavior.
#[cfg(windows)]
fn resolve_windows_program(program: &OsStr) -> Option<OsString> {
    let path = Path::new(program);
    // Only apply fallback for bare names (no path components, no extension).
    if path.components().count() != 1 || path.extension().is_some() {
        return None;
    }

    let raw = program.to_string_lossy();
    for ext in ["exe", "cmd", "bat"] {
        let candidate = format!("{raw}.{ext}");
        if which::which(&candidate).is_ok() {
            return Some(OsString::from(candidate));
        }
    }
    None
}

pub fn normalized_program<S>(program: S) -> OsString
where
    S: AsRef<OsStr>,
{
    #[cfg(windows)]
    {
        if let Some(resolved) = resolve_windows_program(program.as_ref()) {
            return resolved;
        }
    }

    program.as_ref().to_os_string()
}

pub fn tokio_command<S>(program: S) -> tokio::process::Command
where
    S: AsRef<OsStr>,
{
    let mut command = tokio::process::Command::new(normalized_program(program));
    configure_tokio_command(&mut command);
    command
}

/// True when the OS refused to exec a file because something holds it open for
/// writing (`ETXTBSY`). Checked by `ErrorKind` *and* raw errno: the kind is the
/// portable form, the errno covers a target whose std leaves it unmapped.
fn is_exec_busy(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::ExecutableFileBusy {
        return true;
    }
    #[cfg(unix)]
    {
        if err.raw_os_error() == Some(libc::ETXTBSY) {
            return true;
        }
    }
    false
}

/// Run a process spawn, riding out a transient `ETXTBSY` ("Text file busy").
///
/// exec fails with `ETXTBSY` while *any* process holds the target file open for
/// writing, so a multi-threaded process that writes an executable and then runs
/// it races itself. Rust opens files `O_CLOEXEC`, but `CLOEXEC` only takes
/// effect at exec: a `fork()` on another thread — codeg forks constantly, for
/// git, agents, and other terminals — copies the fd table while the write
/// descriptor is still open, and that inherited copy keeps the file busy until
/// the forked child reaches its own exec. An agent that writes `build.sh` and
/// immediately asks for `terminal/create ./build.sh` can therefore be refused
/// for a reason that has nothing to do with its command.
///
/// That window is self-closing (bounded by the forked child's exec), so
/// retrying with backoff turns the race into a delay nobody notices. A file
/// held open by a genuine long-lived writer still fails once the budget is
/// spent, carrying the original `ETXTBSY` — callers that classify spawn errors
/// (e.g. the terminal runtime's shell fallback) never see a substitute.
pub async fn spawn_retrying_exec_busy<T, F>(attempt: F) -> std::io::Result<T>
where
    F: FnMut() -> std::io::Result<T>,
{
    spawn_retrying_exec_busy_within(EXEC_BUSY_RETRY_BUDGET, attempt).await
}

/// [`spawn_retrying_exec_busy`] with an explicit budget so tests can exercise
/// give-up behavior without waiting out the production one.
async fn spawn_retrying_exec_busy_within<T, F>(
    budget: Duration,
    mut attempt: F,
) -> std::io::Result<T>
where
    F: FnMut() -> std::io::Result<T>,
{
    // `tokio::time::Instant`, not `std::time::Instant`, so paused-time tests
    // advance the deadline along with the sleeps instead of waiting for real.
    let deadline = tokio::time::Instant::now() + budget;
    let mut backoff = Duration::from_millis(1);
    loop {
        match attempt() {
            Err(err) if is_exec_busy(&err) => {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    return Err(err);
                }
                tokio::time::sleep(backoff.min(deadline - now)).await;
                backoff = (backoff * 2).min(EXEC_BUSY_MAX_BACKOFF);
            }
            outcome => return outcome,
        }
    }
}

/// Test fixture: write `content` to `path` as an executable script that can be
/// exec'd the moment this returns, however many test threads are spawning.
///
/// A script written with `std::fs::write` is exposed to the race described on
/// [`spawn_retrying_exec_busy`]: a sibling test that forks while the write
/// descriptor is open leaves a copy of it in its child, and Linux refuses to
/// exec the script with `ETXTBSY` until that child execs. A code path that does
/// not retry then fails for a reason unrelated to the test. Writing through a
/// child shell means this process never holds a write descriptor on the file,
/// so no fork here can inherit one. The mode is set by path, which opens
/// nothing either.
#[cfg(all(test, unix))]
pub(crate) fn write_test_script(path: &std::path::Path, content: &str) {
    use std::os::unix::fs::PermissionsExt;

    let status = Command::new("/bin/sh")
        .args(["-c", "printf '%s' \"$2\" > \"$1\"", "sh"])
        .arg(path)
        .arg(content)
        .stdin(std::process::Stdio::null())
        .status()
        .expect("spawn /bin/sh to write a test script");
    assert!(
        status.success(),
        "writing test script {} failed: {status}",
        path.display()
    );
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .expect("make test script executable");
}

/// If `node` is not already in PATH, detect common Node.js version manager
/// installations and prepend the best matching bin directory to the process
/// PATH so that **all** downstream code (`which`, `Command`, child processes)
/// can find node/npm/npx without any special handling.
///
/// Only ONE directory is ever added (the first candidate that contains a
/// real `node` binary), so PATH pollution is minimal.
///
/// # Call site requirements
///
/// * Call **once** at startup, **before** any multi-threaded work begins.
///   `std::env::set_var` is not thread-safe (`unsafe` in Rust edition 2024);
///   calling it while other threads may read `PATH` is a data race.
/// * In the Tauri desktop binary: call from `run()` before `tauri::Builder`.
/// * In the standalone server binary: call from `main()` before building the
///   tokio runtime (do **not** use `#[tokio::main]` which spawns threads first).
/// * In Docker / systemd services: typically a no-op — `which("node")`
///   succeeds because `node` is installed to a standard PATH directory.
pub fn ensure_node_in_path() {
    // Already reachable — nothing to do.
    if which::which("node").is_ok() {
        return;
    }

    let home = dirs::home_dir();
    if home.is_none() {
        tracing::info!("[PATH] HOME not set; env-var-only Node.js search (no home-relative paths)");
    }

    if let Some(bin_dir) = find_node_bin_dir(home.as_deref()) {
        prepend_to_path(&bin_dir);
        tracing::info!("[PATH] node not in PATH, prepended {}", bin_dir.display());
    }
}

/// Every candidate Node.js version-manager bin directory, newest-version-first
/// within each manager, WITHOUT checking which actually contains a `node`
/// binary — the caller decides. Read-only: never mutates PATH. Used by
/// [`find_node_bin_dir`] (which takes the first candidate that has `node`) and
/// by env diagnostics (which reports every candidate + whether it has `node`).
///
/// `home` may be `None` in minimal environments (Docker, systemd without HOME).
/// When `None`, only version managers whose location is determined by an
/// explicit environment variable are searched; home-relative default paths
/// (e.g. `~/.nvm`) are skipped.
///
/// Supported version managers / installation methods:
/// - **nvm** (Unix) — `$NVM_DIR` or `~/.nvm`
/// - **nvm-windows** — `%NVM_SYMLINK%`, `%NVM_HOME%` or `%APPDATA%\nvm`
/// - **fnm** (cross-platform) — `$FNM_MULTISHELL_PATH`, `$FNM_DIR` or platform default
/// - **volta** (cross-platform) — `$VOLTA_HOME` or `~/.volta`
/// - **asdf** (Unix) — `$ASDF_DATA_DIR` or `~/.asdf`
/// - **mise / rtx** (cross-platform) — `$MISE_DATA_DIR` or platform default
/// - **n** (Unix) — `$N_PREFIX` or `/usr/local`
/// - **Homebrew** (macOS) — `/opt/homebrew/opt/node` or `/usr/local/opt/node`
/// - **Scoop** (Windows) — `%SCOOP%\apps\nodejs*\current`
pub(crate) fn node_bin_dir_candidates(home: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    /// Extract a (major, minor, patch) tuple from a version directory name
    /// like `v20.11.1` or `20.11.1` for correct numeric sorting.
    /// Falls back to (0,0,0) for unparseable names so they sort last.
    fn semver_key(path: &std::path::Path) -> (u32, u32, u32) {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .trim_start_matches('v')
            .to_string();
        let mut parts = name.split('.').filter_map(|s| s.parse::<u32>().ok());
        (
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
        )
    }

    /// Try each `(env_var, suffix_segments)` in order; return as soon as one
    /// env var is set.  If none match, fall back to `home / home_relative`.
    /// Returns `None` when no env var is set **and** `home` is `None` —
    /// the caller should skip that version manager entirely.
    fn resolve_dir(
        env_chain: &[(&str, &[&str])],
        home: Option<&std::path::Path>,
        home_relative: &[&str],
    ) -> Option<PathBuf> {
        for (key, suffixes) in env_chain {
            if let Ok(val) = std::env::var(key) {
                return Some(suffixes.iter().fold(PathBuf::from(val), |p, s| p.join(s)));
            }
        }
        home.map(|h| home_relative.iter().fold(h.to_path_buf(), |p, s| p.join(s)))
    }

    // ── nvm (Unix) ───────────────────────────────────────────────────────
    // Standard nvm for macOS/Linux. nvm-windows is a separate tool (below).
    if cfg!(not(windows)) {
        if let Some(nvm_dir) = resolve_dir(&[("NVM_DIR", &[])], home, &[".nvm"]) {
            if nvm_dir.is_dir() {
                let versions_dir = nvm_dir.join("versions").join("node");
                let mut alias_matched = false;

                // Try to match the "default" alias to a concrete version.
                // The alias may be a partial version (e.g. "18", "20.11"),
                // a full version, or a symbolic name ("lts/*", "node").
                // We only attempt matching for numeric prefixes — symbolic
                // aliases require full nvm resolution we cannot replicate.
                let default_alias = nvm_dir.join("alias").join("default");
                if let Ok(raw_alias) = std::fs::read_to_string(&default_alias) {
                    let alias = raw_alias.trim();
                    let is_numeric = alias
                        .trim_start_matches('v')
                        .starts_with(|c: char| c.is_ascii_digit());
                    if is_numeric {
                        let alias_stripped = alias.trim_start_matches('v');
                        if let Ok(entries) = std::fs::read_dir(&versions_dir) {
                            let mut matched: Vec<PathBuf> = entries
                                .flatten()
                                .filter(|e| {
                                    let name = e.file_name().to_string_lossy().to_string();
                                    let stripped = name.trim_start_matches('v');
                                    stripped.starts_with(alias_stripped)
                                })
                                .map(|e| e.path())
                                .collect();
                            if !matched.is_empty() {
                                matched.sort_by_key(|p| semver_key(p));
                                matched.reverse();
                                alias_matched = true;
                                candidates.extend(matched.into_iter().map(|p| p.join("bin")));
                            }
                        }
                    }
                }

                // Fall back: all installed versions, newest first.
                // Skipped when alias resolution already produced candidates.
                if !alias_matched {
                    if let Ok(mut entries) = std::fs::read_dir(&versions_dir)
                        .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
                    {
                        entries.sort_by_key(|p| semver_key(p));
                        entries.reverse();
                        for entry in entries {
                            candidates.push(entry.join("bin"));
                        }
                    }
                }
            }
        }
    }

    // ── nvm-windows ──────────────────────────────────────────────────────
    // nvm-windows is a completely separate tool from Unix nvm with a
    // different directory layout: %NVM_HOME%\v<version>\node.exe (no bin/).
    // The active version is symlinked at %NVM_SYMLINK%.
    if cfg!(windows) {
        // The active symlinked version directory (e.g. C:\Program Files\nodejs)
        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            let symlink_path = PathBuf::from(&nvm_symlink);
            if symlink_path.is_dir() {
                candidates.push(symlink_path);
            }
        }

        // All installed versions, newest first.
        if let Some(nvm_home) = resolve_dir(&[("NVM_HOME", &[]), ("APPDATA", &["nvm"])], None, &[])
        {
            if nvm_home.is_dir() {
                if let Ok(mut entries) = std::fs::read_dir(&nvm_home).map(|rd| {
                    rd.flatten()
                        .filter(|e| e.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
                        .filter(|e| e.file_name().to_string_lossy().starts_with('v'))
                        .map(|e| e.path())
                        .collect::<Vec<_>>()
                }) {
                    entries.sort_by_key(|p| semver_key(p));
                    entries.reverse();
                    // nvm-windows places node.exe directly in the version dir
                    candidates.extend(entries);
                }
            }
        }
    }

    // ── fnm ──────────────────────────────────────────────────────────────
    // FNM_MULTISHELL_PATH is set by `eval "$(fnm env)"` in the user's
    // shell RC. It points to a temporary directory that only exists during
    // an active shell session. In a GUI app (Tauri) this is typically
    // NOT set because the process inherits from the window manager, not a
    // shell. It mainly helps the *server binary* launched from a terminal.
    if let Ok(fnm_multishell_path) = std::env::var("FNM_MULTISHELL_PATH") {
        let path = PathBuf::from(fnm_multishell_path);
        if path.is_dir() {
            candidates.push(path);
        }
    }

    // Platform-specific default for FNM_DIR:
    //   Unix:    $FNM_DIR → $XDG_DATA_HOME/fnm → ~/.local/share/fnm
    //   Windows: $FNM_DIR → %APPDATA%/fnm      → ~/.fnm
    let fnm_dir = if cfg!(windows) {
        resolve_dir(&[("FNM_DIR", &[]), ("APPDATA", &["fnm"])], home, &[".fnm"])
    } else {
        resolve_dir(
            &[("FNM_DIR", &[]), ("XDG_DATA_HOME", &["fnm"])],
            home,
            &[".local", "share", "fnm"],
        )
    };
    if let Some(fnm_dir) = fnm_dir {
        let fnm_versions = fnm_dir.join("node-versions");
        if fnm_versions.is_dir() {
            if let Ok(mut entries) = std::fs::read_dir(&fnm_versions)
                .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
            {
                entries.sort_by_key(|p| semver_key(p));
                entries.reverse();
                for entry in entries {
                    let installation = entry.join("installation");
                    // On Unix fnm places binaries under installation/bin;
                    // on Windows they sit directly in the installation dir.
                    let bin = installation.join("bin");
                    candidates.push(if bin.is_dir() { bin } else { installation });
                }
            }
        }
    }

    // ── volta ────────────────────────────────────────────────────────────
    // Volta's bin/ directory contains *shims* — they exist even if no Node
    // version has been installed (`volta install node`).  Only add the
    // shim directory when at least one concrete Node image is present,
    // otherwise downstream `node` invocations would get a cryptic Volta
    // error instead of a clean "node not found".
    if let Some(volta_home) = resolve_dir(&[("VOLTA_HOME", &[])], home, &[".volta"]) {
        let volta_node_images = volta_home.join("tools").join("image").join("node");
        let has_volta_node = volta_node_images
            .is_dir()
            .then(|| std::fs::read_dir(&volta_node_images).ok())
            .flatten()
            .is_some_and(|mut rd| rd.next().is_some());
        if has_volta_node {
            let volta_bin = volta_home.join("bin");
            if volta_bin.is_dir() {
                candidates.push(volta_bin);
            }
        }
    }

    // ── asdf (Unix) ──────────────────────────────────────────────────────
    // asdf does not officially support Windows.
    if cfg!(not(windows)) {
        if let Some(asdf_dir) = resolve_dir(&[("ASDF_DATA_DIR", &[])], home, &[".asdf"]) {
            let asdf_nodejs = asdf_dir.join("installs").join("nodejs");
            if asdf_nodejs.is_dir() {
                if let Ok(mut entries) = std::fs::read_dir(&asdf_nodejs)
                    .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
                {
                    entries.sort_by_key(|p| semver_key(p));
                    entries.reverse();
                    for entry in entries {
                        candidates.push(entry.join("bin"));
                    }
                }
            }
        }
    }

    // ── mise / rtx (cross-platform) ─────────────────────────────────────
    // mise respects MISE_DATA_DIR > XDG_DATA_HOME > dirs::data_dir() > home.
    let mise_dir = resolve_dir(
        &[("MISE_DATA_DIR", &[]), ("XDG_DATA_HOME", &["mise"])],
        None,
        &[],
    )
    .or_else(|| {
        dirs::data_dir()
            .or_else(|| home.map(|h| h.join(".local").join("share")))
            .map(|d| d.join("mise"))
    });
    if let Some(mise_dir) = mise_dir {
        let mise_node = mise_dir.join("installs").join("node");
        if mise_node.is_dir() {
            if let Ok(mut entries) = std::fs::read_dir(&mise_node)
                .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
            {
                entries.sort_by_key(|p| semver_key(p));
                entries.reverse();
                for entry in entries {
                    // mise on Unix places binaries under <version>/bin/;
                    // on Windows they may sit directly in the version dir.
                    let bin = entry.join("bin");
                    candidates.push(if bin.is_dir() { bin } else { entry });
                }
            }
        }
    }

    // ── n (Unix) ─────────────────────────────────────────────────────────
    // `n` stores versions under $N_PREFIX/n/versions/node/<version>/bin/.
    // N_PREFIX defaults to /usr/local (no home dependency).
    if cfg!(not(windows)) {
        let n_prefix = std::env::var("N_PREFIX")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/usr/local"));
        let n_versions = n_prefix.join("n").join("versions").join("node");
        if n_versions.is_dir() {
            if let Ok(mut entries) = std::fs::read_dir(&n_versions)
                .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
            {
                entries.sort_by_key(|p| semver_key(p));
                entries.reverse();
                for entry in entries {
                    candidates.push(entry.join("bin"));
                }
            }
        }
    }

    // ── Homebrew (macOS) ─────────────────────────────────────────────────
    if cfg!(target_os = "macos") {
        // Apple Silicon (/opt/homebrew) and Intel (/usr/local)
        for prefix in &["/opt/homebrew", "/usr/local"] {
            let brew_node = PathBuf::from(prefix).join("opt").join("node").join("bin");
            if brew_node.is_dir() {
                candidates.push(brew_node);
            }
        }
    }

    // ── Scoop (Windows) ─────────────────────────────────────────────────
    if cfg!(windows) {
        if let Some(scoop_dir) = resolve_dir(&[("SCOOP", &[])], home, &["scoop"]) {
            // Scoop may install as "nodejs-lts" or "nodejs".
            for app_name in &["nodejs-lts", "nodejs"] {
                let scoop_node = scoop_dir.join("apps").join(app_name).join("current");
                if scoop_node.is_dir() {
                    candidates.push(scoop_node);
                }
            }
        }
    }

    candidates
}

/// The first version-manager candidate bin directory that actually contains a
/// `node` binary. Thin wrapper over [`node_bin_dir_candidates`].
fn find_node_bin_dir(home: Option<&std::path::Path>) -> Option<PathBuf> {
    let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
    node_bin_dir_candidates(home)
        .into_iter()
        .find(|dir| dir.join(node_bin).is_file())
}

/// Prepend a directory to the process `PATH` environment variable.
pub(crate) fn prepend_to_path(dir: &std::path::Path) {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = OsString::from(dir);
    new_path.push(sep);
    new_path.push(current);
    std::env::set_var("PATH", new_path);
}

/// Return the user-local npm prefix directory (`~/.codeg/npm-global/`).
///
/// Used as a fallback when `npm install -g` fails with EACCES because the
/// system global prefix (e.g. `/usr/local/lib/node_modules/`) is not writable.
pub(crate) fn user_npm_prefix() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codeg").join("npm-global"))
}

/// Ensure the user-local npm prefix `bin/` directory is in `PATH` so that
/// binaries installed via the EACCES fallback can be found by `which` and
/// child processes.  Safe to call even if the directory does not exist yet.
///
/// On Unix, `npm install -g --prefix=<p>` places binaries in `<p>/bin/`.
/// On Windows, binaries are placed directly in `<p>/`.
pub fn ensure_user_npm_prefix_in_path() {
    if let Some(prefix) = user_npm_prefix() {
        let bin_dir = if cfg!(windows) {
            prefix
        } else {
            prefix.join("bin")
        };
        // Avoid adding duplicates.
        let current = std::env::var_os("PATH").unwrap_or_default();
        let bin_str = bin_dir.to_string_lossy();
        let sep = if cfg!(windows) { ";" } else { ":" };
        if !current
            .to_string_lossy()
            .split(sep)
            .any(|p| p == bin_str.as_ref())
        {
            prepend_to_path(&bin_dir);
        }
    }
}

/// Read `reader` line-by-line as UTF-8-*lossy* text, invoking `on_line` for each
/// line (trailing newline trimmed) and returning the accumulated text.
///
/// Unlike a `Lines`/`next_line()` loop — which returns `Err(InvalidData)` and so
/// aborts the whole stream on the first non-UTF-8 byte — this preserves a
/// non-UTF-8 line lossily. PowerShell/npm emit OEM-codepage bytes (e.g. GBK on a
/// zh-CN Windows) for non-ASCII installer/error text, so without this a single
/// localized line would truncate both the live log and the failure-diagnostic
/// tail. A genuine read error records a short note and stops — `break`, never
/// `continue`, so a persistent error can't spin.
pub(crate) async fn collect_lines_lossy<R, F>(mut reader: R, mut on_line: F) -> String
where
    R: tokio::io::AsyncBufRead + Unpin,
    F: FnMut(&str),
{
    use tokio::io::AsyncBufReadExt;

    let mut buf = Vec::new();
    let mut collected = String::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                // Match `Lines` semantics: strip a trailing '\n' then one '\r'.
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                    if buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                }
                let line = String::from_utf8_lossy(&buf);
                on_line(line.as_ref());
                if !collected.is_empty() {
                    collected.push('\n');
                }
                collected.push_str(line.as_ref());
            }
            Err(e) => {
                let note = format!("<install reader error: {e}>");
                on_line(&note);
                if !collected.is_empty() {
                    collected.push('\n');
                }
                collected.push_str(&note);
                break;
            }
        }
    }
    collected
}

#[cfg(test)]
mod tests {
    use super::{collect_lines_lossy, spawn_retrying_exec_busy, spawn_retrying_exec_busy_within};
    use std::io::Cursor;
    use std::time::Duration;

    #[tokio::test]
    async fn collect_lines_lossy_preserves_lines_around_invalid_utf8() {
        // A non-UTF-8 segment (0xFF 0xFE — invalid start bytes, like GBK output
        // on a non-English Windows) sits between two valid lines. The old
        // `next_line()` loop would abort here and drop "third"; this must not.
        let data = b"first\n\xff\xfe garbage\nthird\n".to_vec();
        let mut seen: Vec<String> = Vec::new();
        let collected =
            collect_lines_lossy(Cursor::new(data), |l| seen.push(l.to_string())).await;

        assert_eq!(seen.len(), 3, "all three lines emitted: {seen:?}");
        assert_eq!(seen[0], "first");
        assert_eq!(seen[2], "third");
        assert!(
            seen[1].contains('\u{fffd}'),
            "invalid bytes preserved lossily, not dropped: {:?}",
            seen[1]
        );
        assert!(collected.contains("first") && collected.contains("third"));
        assert!(collected.contains('\u{fffd}'));
    }

    #[tokio::test]
    async fn collect_lines_lossy_handles_crlf_and_partial_last_line() {
        // CRLF endings trimmed like `Lines`; a final line with no trailing
        // newline is still emitted (then EOF stops the loop).
        let data = b"a\r\nb\r\nno-newline".to_vec();
        let mut seen: Vec<String> = Vec::new();
        let collected =
            collect_lines_lossy(Cursor::new(data), |l| seen.push(l.to_string())).await;

        assert_eq!(seen, vec!["a", "b", "no-newline"]);
        assert_eq!(collected, "a\nb\nno-newline");
    }

    #[tokio::test]
    async fn collect_lines_lossy_empty_input_yields_nothing() {
        let mut seen: Vec<String> = Vec::new();
        let collected =
            collect_lines_lossy(Cursor::new(Vec::<u8>::new()), |l| seen.push(l.to_string()))
                .await;

        assert!(seen.is_empty());
        assert!(collected.is_empty());
    }

    /// A spawn refused with `ETXTBSY` is retried until the writer lets go — the
    /// racing fork→exec window is self-closing, so the caller must see the
    /// eventual success, not the transient failure.
    #[tokio::test(start_paused = true)]
    async fn exec_busy_spawn_is_retried_until_the_file_is_free() {
        let mut attempts = 0u32;
        let outcome = spawn_retrying_exec_busy(|| {
            attempts += 1;
            if attempts < 3 {
                Err(std::io::Error::from(std::io::ErrorKind::ExecutableFileBusy))
            } else {
                Ok("spawned")
            }
        })
        .await;

        assert_eq!(outcome.expect("spawn eventually succeeds"), "spawned");
        assert_eq!(attempts, 3, "retried until the file was no longer busy");
    }

    /// Any other spawn failure returns on the first attempt: retrying a missing
    /// program would only delay the caller's own fallback (the terminal
    /// runtime's `NotFound` → shell-wrap path).
    #[tokio::test(start_paused = true)]
    async fn non_busy_spawn_failure_is_not_retried() {
        let mut attempts = 0u32;
        let outcome: std::io::Result<()> = spawn_retrying_exec_busy(|| {
            attempts += 1;
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        })
        .await;

        assert_eq!(attempts, 1, "no retry for a non-busy error");
        assert_eq!(
            outcome.expect_err("error surfaces").kind(),
            std::io::ErrorKind::NotFound,
            "original kind reaches the caller's fallback classifier"
        );
    }

    /// A file held open by a long-lived writer gives up once the budget is
    /// spent and reports the original `ETXTBSY` — never swallowed, never
    /// reclassified.
    #[tokio::test(start_paused = true)]
    async fn persistently_busy_spawn_gives_up_with_the_original_error() {
        let mut attempts = 0u32;
        let outcome: std::io::Result<()> =
            spawn_retrying_exec_busy_within(Duration::from_millis(20), || {
                attempts += 1;
                Err(std::io::Error::from(std::io::ErrorKind::ExecutableFileBusy))
            })
            .await;

        assert!(
            attempts > 1,
            "budget allowed at least one retry: {attempts}"
        );
        assert_eq!(
            outcome.expect_err("error surfaces").kind(),
            std::io::ErrorKind::ExecutableFileBusy
        );
    }

    /// `ETXTBSY` arriving as a bare errno, with no `ErrorKind` mapping, is still
    /// recognized — and a neighboring errno is not.
    #[cfg(unix)]
    #[test]
    fn raw_etxtbsy_errno_is_recognized_as_exec_busy() {
        assert!(super::is_exec_busy(&std::io::Error::from_raw_os_error(
            libc::ETXTBSY
        )));
        assert!(!super::is_exec_busy(&std::io::Error::from_raw_os_error(
            libc::ENOENT
        )));
    }

    /// The fixture writes the script byte for byte, leaves it executable, and
    /// it runs straight away. The path has a space and the content carries
    /// quotes, `%`, `$`, a backslash and a trailing newline, all of which must
    /// arrive verbatim.
    #[cfg(unix)]
    #[test]
    fn test_script_is_written_verbatim_and_runs_at_once() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let script = dir.path().join("fixture with spaces");
        let content = "#!/bin/sh\n# 100% literal: $HOME '\"' \\n\nprintf '%s\\n' fixture-ran\n";
        super::write_test_script(&script, content);

        assert_eq!(
            std::fs::read_to_string(&script).expect("read script"),
            content
        );
        let mode = std::fs::metadata(&script)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        let output = std::process::Command::new(&script)
            .output()
            .expect("run the script");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "fixture-ran\n");
    }
}
