use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::app_error::AppCommandError;
use crate::process::tokio_command;

/// Open a file or directory in Visual Studio Code.
///
/// Resolves the `code` CLI (and well-known install locations) and launches it
/// without waiting, so the editor outlives this call. Works in both desktop and
/// server mode: the host that owns the workspace path is the one that spawns
/// Code.
///
/// A successful return only means the process was spawned — Code deciding it
/// cannot show a window (a host with no display, say) surfaces nowhere.
///
/// `async` because [`spawn_vscode`] needs a tokio runtime in scope, not because
/// it awaits anything.
pub async fn open_in_code_core(path: String) -> Result<(), AppCommandError> {
    let target = validate_open_in_code_path(&path)?;
    let launch = resolve_vscode_launch().ok_or_else(|| {
        AppCommandError::dependency_missing(
            "Visual Studio Code was not found. Install it or add the `code` command to PATH.",
        )
    })?;
    spawn_vscode(&launch, &target)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_in_code(path: String) -> Result<(), AppCommandError> {
    open_in_code_core(path).await
}

/// Open an existing local file with whatever the OS has registered for its
/// type — the "open with default app" row of a file reference's menu.
///
/// Desktop-only, and only meaningful for a local workspace: the handler lives
/// on the machine drawing the window, while a remote workspace's paths belong
/// to another host (the frontend never offers the row there). Server mode has
/// no such machine at all, so there is no `_core` and no HTTP route.
///
/// Deliberately its own command rather than a widened `opener` scope: the
/// plugin's `open_path` is scope-checked against `$HOME`, which a workspace on
/// another drive fails, and raising that scope to `**` would hand every other
/// renderer path — agent markdown included — the same reach plus a free choice
/// of `with` program. Here the errand is exactly one path, no program is ever
/// chosen, and the path must be an existing local regular file.
///
/// `async` so the launch runs off the main thread: a synchronous command runs
/// on it, and the metadata lookup (a network drive) or the launcher can stall.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn open_local_file(path: String) -> Result<(), AppCommandError> {
    let target = validate_open_local_file_path(&path)?;
    launch_default_app(&target).await
}

#[cfg(any(feature = "tauri-runtime", all(test, not(windows))))]
const OPEN_LOCAL_FILE_FAILED: &str = "Failed to open the file";

/// Windows: `ShellExecuteExW`, called here rather than through the opener
/// plugin, which passes no flags and initializes no COM. Microsoft's rules for
/// a thread with no message loop — every tokio worker — are COM initialized
/// (shell extensions are COM objects) and `SEE_MASK_NOASYNC` (or a DDE-backed
/// association can be dropped as the call returns). Run on the blocking pool:
/// with `SEE_MASK_NOASYNC` the call waits for the handoff, and for a type with
/// no association it shows the shell's own "Open with" chooser, as Explorer
/// does on a double-click.
#[cfg(all(feature = "tauri-runtime", windows))]
async fn launch_default_app(target: &Path) -> Result<(), AppCommandError> {
    let owned = target.to_path_buf();
    let outcome = tokio::task::spawn_blocking(move || shell_execute_default_verb(&owned))
        .await
        .map_err(|err| err.to_string())
        .and_then(|result| result.map_err(|err| err.to_string()));
    outcome.map_err(|why| {
        AppCommandError::external_command(
            OPEN_LOCAL_FILE_FAILED,
            format!("{}: {why}", target.display()),
        )
    })
}

#[cfg(all(feature = "tauri-runtime", windows))]
fn shell_execute_default_verb(target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // S_OK and S_FALSE (already initialized on this thread) each take one
    // CoUninitialize; a failure (a thread already in the MTA) takes none, and
    // the shell still works from there.
    let com = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    // SAFETY: SHELLEXECUTEINFOW is plain data; all-zero is its documented
    // "nothing set" state (null verb = the file type's default verb).
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOASYNC;
    info.lpFile = file.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    // SAFETY: `info` and the `file` buffer it points into outlive the call.
    let opened = unsafe { ShellExecuteExW(&mut info) } != 0;
    let error = (!opened).then(std::io::Error::last_os_error);
    if com >= 0 {
        unsafe { CoUninitialize() };
    }
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// macOS `open` / Linux `xdg-open`, run by codeg rather than the opener plugin:
/// the plugin spawns them detached and drops their exit status, so a type with
/// no registered application (`open` exits 1, `xdg-open` 3/4) would do nothing
/// at all; and its `xdg-open` inherits an AppImage's bundled environment, which
/// breaks the host's `gio` (see `appimage_env`) — `tokio_command` restores it.
#[cfg(all(feature = "tauri-runtime", not(windows)))]
async fn launch_default_app(target: &Path) -> Result<(), AppCommandError> {
    // `open` hands the file to LaunchServices and never runs the application
    // itself, so its stderr is safe to read: it says why ("No application
    // knows how to open …").
    #[cfg(target_os = "macos")]
    let (mut command, launcher) = (
        tokio_command("/usr/bin/open"),
        DefaultAppLauncher::CapturesStderr,
    );
    // `xdg-open`'s fallbacks can run the application in the foreground, where
    // it inherits the launcher's stderr — a pipe codeg reads would SIGPIPE it
    // once codeg quits. So nothing is captured; the exit code says why. A host
    // without `xdg-open` gets `gio open`, the opener plugin's next try.
    #[cfg(not(target_os = "macos"))]
    let (mut command, launcher) = {
        use crate::commands::acp::resolve_command_on_path;
        if resolve_command_on_path("xdg-open").is_none() && resolve_command_on_path("gio").is_some()
        {
            let mut command = tokio_command("gio");
            command.arg("open");
            (command, DefaultAppLauncher::Silent)
        } else {
            (tokio_command("xdg-open"), DefaultAppLauncher::XdgOpen)
        }
    };
    command.arg(target);
    run_default_app_launcher(command, launcher, target, DEFAULT_APP_LAUNCHER_VERDICT).await
}

/// How long a launcher gets to say it failed. Both normally exit within a
/// second of handing the file over; a few `xdg-open` fallbacks instead run the
/// application in the foreground, which then is the file open — success.
#[cfg(all(feature = "tauri-runtime", not(windows)))]
const DEFAULT_APP_LAUNCHER_VERDICT: std::time::Duration = std::time::Duration::from_secs(5);

/// Most of a launcher's stderr kept for the error: its first lines say why.
#[cfg(all(any(feature = "tauri-runtime", test), not(windows)))]
const LAUNCHER_STDERR_KEPT: usize = 2048;

/// What a launcher's failure is told by.
#[cfg(all(any(feature = "tauri-runtime", test), not(windows)))]
// Each platform builds only its own launcher.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DefaultAppLauncher {
    /// Its stderr (it never runs the application in its own process tree).
    CapturesStderr,
    /// `xdg-open`: its documented exit codes.
    XdgOpen,
    /// Its exit status alone.
    Silent,
}

#[cfg(all(any(feature = "tauri-runtime", test), not(windows)))]
fn describe_launcher_exit(
    launcher: DefaultAppLauncher,
    status: std::process::ExitStatus,
) -> String {
    let reason = match (launcher, status.code()) {
        (DefaultAppLauncher::XdgOpen, Some(2)) => Some("the file does not exist"),
        (DefaultAppLauncher::XdgOpen, Some(3)) => Some("a tool xdg-open needs could not be found"),
        (DefaultAppLauncher::XdgOpen, Some(4)) => {
            Some("no application could open it (none may be registered for this type)")
        }
        _ => None,
    };
    match reason {
        Some(reason) => format!("{reason} ({status})"),
        None => status.to_string(),
    }
}

/// Run `command` and report its failure: a non-zero exit within `verdict`,
/// told by `launcher`. A launcher still running at `verdict` is left to run:
/// tokio's orphan queue reaps it, and a captured stderr goes on being drained
/// by a task that outlives this call, so the pipe is never closed under it.
#[cfg(all(any(feature = "tauri-runtime", test), not(windows)))]
async fn run_default_app_launcher(
    mut command: tokio::process::Command,
    launcher: DefaultAppLauncher,
    target: &Path,
    verdict: std::time::Duration,
) -> Result<(), AppCommandError> {
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncReadExt;

    let capture = launcher == DefaultAppLauncher::CapturesStderr;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if capture {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let failed = |why: String| {
        AppCommandError::external_command(
            OPEN_LOCAL_FILE_FAILED,
            format!("{}: {why}", target.display()),
        )
    };
    let mut child = command.spawn().map_err(|err| failed(err.to_string()))?;
    let kept = Arc::new(Mutex::new(Vec::new()));
    let drain = child.stderr.take().map(|mut stderr| {
        let kept = Arc::clone(&kept);
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut kept = kept.lock().unwrap_or_else(|e| e.into_inner());
                let room = LAUNCHER_STDERR_KEPT.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        })
    });
    let status = match tokio::time::timeout(verdict, child.wait()).await {
        Err(_) => return Ok(()),
        Ok(status) => status.map_err(|err| failed(err.to_string()))?,
    };
    if status.success() {
        return Ok(());
    }
    // The launcher has exited, so what it wrote is in the pipe already.
    if let Some(drain) = drain {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(250), drain).await;
    }
    let said = String::from_utf8_lossy(&kept.lock().unwrap_or_else(|e| e.into_inner()))
        .trim()
        .to_string();
    Err(failed(if said.is_empty() {
        describe_launcher_exit(launcher, status)
    } else {
        said
    }))
}

/// Reject anything that is not one existing regular file at an absolute path.
///
/// The renderer resolves paths itself (line suffixes stripped, `~` expanded,
/// dot segments collapsed), so what arrives is taken as is — not trimmed, since
/// a file name may begin or end with a space. A URL (`https://…`, `file://…`)
/// is not absolute and is refused by that check. A directory, or a macOS `.app`
/// bundle, is the file manager row's errand, not "open this file" — and so is
/// a file whose default "open" runs code (see [`runs_code_when_opened`]).
///
/// `test` is in the cfg so the unit tests can reach it in a server-mode build,
/// where the command itself does not exist.
#[cfg(any(test, feature = "tauri-runtime"))]
fn validate_open_local_file_path(path: &str) -> Result<PathBuf, AppCommandError> {
    if path.trim().is_empty() {
        return Err(AppCommandError::invalid_input(
            "path is required to open a file",
        ));
    }
    if path.contains(['\n', '\r', '\0']) {
        return Err(AppCommandError::invalid_input(
            "path must not contain control characters",
        ));
    }
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err(AppCommandError::invalid_input(format!(
            "path must be an absolute local filesystem path: {path}"
        )));
    }
    match std::fs::metadata(&target) {
        // `absolute` turns the renderer's slash-normalized `F:/repo/a.pdf`
        // back into the native `F:\repo\a.pdf` the Windows shell expects (and
        // leaves a POSIX path as it is), without the `\\?\` form canonicalize
        // would give.
        Ok(meta) if meta.is_file() => {
            let resolved = std::path::absolute(&target).map_err(AppCommandError::io)?;
            if runs_code_when_opened(&resolved, &meta) {
                return Err(AppCommandError::invalid_input(format!(
                    "{path} can run code when opened, so it is not opened from here; \
                     reveal it in the file manager to look at it first"
                )));
            }
            Ok(resolved)
        }
        Ok(_) => Err(AppCommandError::invalid_input(format!(
            "not a file: {path}"
        ))),
        Err(_) => Err(AppCommandError::not_found(format!(
            "path does not exist: {path}"
        ))),
    }
}

/// Whether the OS's default "open" of this file runs code rather than showing
/// a document: a program, a script the shell executes, a shortcut, an
/// installer. A file reference's badge shows whatever text the message gave it
/// (`[report.pdf](./setup.exe)` reads as a PDF), so "Open with default app"
/// must not be a one-click way to run what an agent's reply pointed at.
///
/// Judged by the name the shell will see and, through a symlink, by the file
/// it names: a runnable type ([`RUNNABLE_EXTENSIONS`]), and on Windows also a
/// type the shell itself flags as dangerous or whose registered handler is a
/// script host (`.py` → `py.exe`, …). On Unix, an executable that really is a
/// program or script (`#!`, ELF, Mach-O) — `open` runs an extensionless one in
/// Terminal — but not the execute bit alone, which exFAT/FAT volumes set on
/// every file.
#[cfg(any(test, feature = "tauri-runtime"))]
fn runs_code_when_opened(path: &Path, meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 && starts_like_a_program(path) {
            return true;
        }
    }
    #[cfg(not(unix))]
    let _ = meta;
    let canonical = std::fs::canonicalize(path).ok();
    std::iter::once(path)
        .chain(canonical.as_deref())
        .any(extension_runs_code)
}

/// A shebang or an executable image header (ELF; Mach-O thin, either byte
/// order, or fat). Unreadable counts as not: the launch would fail anyway.
#[cfg(all(any(test, feature = "tauri-runtime"), unix))]
fn starts_like_a_program(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 4];
    let read = std::fs::File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .unwrap_or(0);
    let head = &head[..read];
    head.starts_with(b"#!")
        || head == b"\x7fELF"
        || matches!(
            head,
            [0xfe, 0xed, 0xfa, 0xce | 0xcf]
                | [0xce | 0xcf, 0xfa, 0xed, 0xfe]
                | [0xca, 0xfe, 0xba, 0xbe]
        )
}

#[cfg(any(test, feature = "tauri-runtime"))]
fn extension_runs_code(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    if RUNNABLE_EXTENSIONS.contains(&ext.as_str()) {
        return true;
    }
    #[cfg(windows)]
    {
        // Whatever else this machine runs by name (`PATHEXT` is `.COM;.EXE;…`).
        let in_pathext = std::env::var_os("PATHEXT").is_some_and(|pathext| {
            pathext
                .to_string_lossy()
                .split(';')
                .any(|entry| entry.trim_start_matches('.').eq_ignore_ascii_case(&ext))
        });
        if in_pathext || windows_type_runs_code(&ext) {
            return true;
        }
    }
    false
}

/// What this machine's registrations say about `.ext`: flagged dangerous by
/// the shell (its built-in list plus `FTA_AlwaysUnsafe`), or opened by a
/// script host — a language installer that associates its scripts with its
/// interpreter (Python's `.py`/`.pyw` with `py.exe`, by default) makes "open"
/// mean "run", whatever the extension.
#[cfg(all(any(test, feature = "tauri-runtime"), windows))]
fn windows_type_runs_code(ext: &str) -> bool {
    use windows_sys::Win32::UI::Shell::{
        AssocIsDangerous, AssocQueryStringW, ASSOCF_NOTRUNCATE, ASSOCSTR_EXECUTABLE,
    };
    let assoc: Vec<u16> = format!(".{ext}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `assoc` is NUL-terminated and outlives the call.
    if unsafe { AssocIsDangerous(assoc.as_ptr()) } != 0 {
        return true;
    }
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: `buf` holds `len` u16s; the shell writes at most that many and
    // reports the count written (terminator included) back through `len`.
    let hr = unsafe {
        AssocQueryStringW(
            ASSOCF_NOTRUNCATE,
            ASSOCSTR_EXECUTABLE,
            assoc.as_ptr(),
            std::ptr::null(),
            buf.as_mut_ptr(),
            &mut len,
        )
    };
    if hr < 0 {
        return false;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    is_script_host(&String::from_utf16_lossy(&buf[..end]))
}

/// Whether the program a file type opens with runs its argument as code: an
/// interpreter or script host, by its file name (`C:\…\py.exe`, `wscript.exe`).
#[cfg(any(test, all(feature = "tauri-runtime", windows)))]
fn is_script_host(program: &str) -> bool {
    let name = program
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    const HOSTS: &[&str] = &[
        "py",
        "pyw",
        "wscript",
        "cscript",
        "powershell",
        "pwsh",
        "cmd",
        "java",
        "javaw",
        "perl",
        "wperl",
        "ruby",
        "rubyw",
        "node",
        "deno",
        "bun",
        "php",
        "php-win",
        "bash",
        "sh",
        "wsl",
        "mshta",
        "rundll32",
        "regedit",
        "regsvr32",
        "msiexec",
        "tclsh",
        "wish",
        "autoit3",
        "hh",
    ];
    HOSTS.contains(&stem)
        || stem.starts_with("python")
        || stem.starts_with("autohotkey")
        || stem.starts_with("tclsh")
        || stem.starts_with("wish")
}

/// File types whose default action runs or installs something.
#[cfg(all(any(test, feature = "tauri-runtime"), windows))]
const RUNNABLE_EXTENSIONS: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "pif",
    "scr",
    "cpl",
    "msc",
    "msi",
    "msp",
    "mst",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "appinstaller",
    "application",
    "appref-ms",
    "hta",
    "inf",
    "ins",
    "isp",
    "jar",
    "js",
    "jse",
    "lnk",
    "ps1",
    "psm1",
    "psd1",
    "reg",
    "scf",
    "sct",
    "shb",
    "shs",
    "url",
    "vb",
    "vbe",
    "vbs",
    "ws",
    "wsc",
    "wsf",
    "wsh",
    "xbap",
    "settingcontent-ms",
    "diagcab",
    "chm",
    "library-ms",
    "search-ms",
    "website",
    "gadget",
    "py",
    "pyw",
    "pyz",
    "pyzw",
    "pyc",
    "pyo",
    "pl",
    "rb",
    "rbw",
    "php",
    "tcl",
    "ahk",
    "au3",
];

#[cfg(all(any(test, feature = "tauri-runtime"), target_os = "macos"))]
const RUNNABLE_EXTENSIONS: &[&str] = &[
    "app",
    "command",
    "tool",
    "terminal",
    "pkg",
    "mpkg",
    "workflow",
    "action",
    "jar",
    "webloc",
    "inetloc",
    "fileloc",
    "url",
    "mobileconfig",
    "prefpane",
    "saver",
    "qlgenerator",
    "mdimporter",
    "kext",
    "osax",
];

#[cfg(all(any(test, feature = "tauri-runtime"), unix, not(target_os = "macos")))]
const RUNNABLE_EXTENSIONS: &[&str] = &[
    "desktop",
    "appimage",
    "run",
    "jar",
    "deb",
    "rpm",
    "flatpakref",
    "flatpak",
    "snap",
    "url",
];

fn validate_open_in_code_path(path: &str) -> Result<PathBuf, AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input(
            "path is required to open in Code",
        ));
    }
    if trimmed.contains(['\n', '\r', '\0']) {
        return Err(AppCommandError::invalid_input(
            "path must not contain control characters",
        ));
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(AppCommandError::not_found(format!(
            "path does not exist: {trimmed}"
        )));
    }
    Ok(target)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VsCodeLaunch {
    program: PathBuf,
    /// Extra args inserted before the target path (`open -a "Visual Studio Code"`).
    args_prefix: Vec<OsString>,
}

impl VsCodeLaunch {
    fn from_binary(program: PathBuf) -> Self {
        Self {
            program: prefer_gui_binary(program),
            args_prefix: Vec::new(),
        }
    }

    #[cfg(target_os = "macos")]
    fn macos_open_app(app_name: &str) -> Self {
        Self {
            program: PathBuf::from("open"),
            args_prefix: vec![OsString::from("-a"), OsString::from(app_name)],
        }
    }
}

/// Prefer `Code.exe` next to a `bin/code.cmd` shim so we spawn a GUI binary
/// instead of a console wrapper.
fn prefer_gui_binary(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(parent) = path.parent() {
            let same_dir = parent.join("Code.exe");
            if same_dir.is_file() {
                return same_dir;
            }
            if let Some(install_dir) = parent.parent() {
                let exe = install_dir.join("Code.exe");
                if exe.is_file() {
                    return exe;
                }
            }
        }
    }
    path
}

fn known_vscode_binaries() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            paths.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            );
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            paths.push(
                PathBuf::from(program_files)
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            );
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            paths.push(
                PathBuf::from(program_files_x86)
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from(
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        ));
        paths.push(PathBuf::from("/usr/local/bin/code"));
        paths.push(PathBuf::from("/opt/homebrew/bin/code"));
        if let Some(home) = dirs::home_dir() {
            paths.push(
                home.join("Applications")
                    .join("Visual Studio Code.app")
                    .join("Contents/Resources/app/bin/code"),
            );
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        paths.push(PathBuf::from("/usr/bin/code"));
        paths.push(PathBuf::from("/usr/share/code/bin/code"));
        paths.push(PathBuf::from("/usr/share/code/code"));
        paths.push(PathBuf::from("/snap/bin/code"));
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".local").join("bin").join("code"));
        }
    }

    paths
}

#[cfg(target_os = "macos")]
fn macos_app_candidates() -> Vec<PathBuf> {
    let mut apps = vec![PathBuf::from("/Applications/Visual Studio Code.app")];
    if let Some(home) = dirs::home_dir() {
        apps.push(home.join("Applications").join("Visual Studio Code.app"));
    }
    apps
}

fn resolve_vscode_launch() -> Option<VsCodeLaunch> {
    if let Some(path) = crate::commands::acp::resolve_command_on_path("code") {
        return Some(VsCodeLaunch::from_binary(path));
    }
    for candidate in known_vscode_binaries() {
        if candidate.is_file() {
            return Some(VsCodeLaunch::from_binary(candidate));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if macos_app_candidates().iter().any(|app| app.is_dir()) {
            return Some(VsCodeLaunch::macos_open_app("Visual Studio Code"));
        }
    }
    None
}

/// Spawn Code and walk away.
///
/// `tokio_command` rather than the std one on purpose: dropping the handle of a
/// still-running `std::process::Child` never reaps it, so on unix every launch
/// would leave a `<defunct>` entry behind for the lifetime of the app. Tokio's
/// `Child` hands itself to the runtime's orphan queue on drop, which reaps it
/// on a best-effort basis once Code exits — no promise about how soon, but it
/// does eventually clear, which the std handle never does.
///
/// A `.cmd` / `.bat` shim is passed to `Command` as the program, NOT hand-wrapped
/// in `cmd /C`: std recognizes the extension and builds the `cmd.exe` line itself
/// with batch-specific quoting (`make_bat_command_line`), which neutralizes the
/// `& | ^ < > %` a workspace file name is free to contain. Spelling the wrapper
/// out by hand instead gets the standard `CommandLineToArgvW` quoting, which
/// leaves those characters live for cmd to parse — a file named `a&calc` in a
/// cloned repo would then run `calc`.
fn spawn_vscode(launch: &VsCodeLaunch, target: &Path) -> Result<(), AppCommandError> {
    let mut command = tokio_command(&launch.program);
    for arg in &launch.args_prefix {
        command.arg(arg);
    }
    command
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command.spawn().map(|_| ()).map_err(|err| {
        AppCommandError::external_command(
            "Failed to launch Visual Studio Code",
            format!("{}: {err}", launch.program.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    fn write_stub_recorder(dir: &Path, marker: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            let stub = dir.join("code.cmd");
            fs::write(
                &stub,
                format!("@echo off\r\necho %1>\"{}\"\r\n", marker.display()),
            )
            .expect("write stub");
            stub
        }
        #[cfg(not(windows))]
        {
            let stub = dir.join("code");
            crate::process::write_test_script(
                &stub,
                &format!(
                    "#!/bin/sh\nprintf '%s\\n' \"$1\" > \"{}\"\n",
                    marker.display()
                ),
            );
            stub
        }
    }

    fn wait_for_marker(marker: &Path) -> String {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(contents) = fs::read_to_string(marker) {
                let trimmed = contents.trim().to_string();
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
            if Instant::now() >= deadline {
                panic!("stub did not write marker at {}", marker.display());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn validate_rejects_empty_path() {
        let err = validate_open_in_code_path("  ").expect_err("empty");
        assert!(err.message.contains("required"), "{err:?}");
    }

    #[test]
    fn validate_rejects_control_characters() {
        let err = validate_open_in_code_path("/tmp/foo\nbar").expect_err("newline");
        assert!(err.message.contains("control"), "{err:?}");
    }

    #[test]
    fn validate_rejects_missing_path() {
        let err = validate_open_in_code_path("/definitely/not/a/codeg/path").expect_err("missing");
        assert!(err.message.contains("does not exist"), "{err:?}");
    }

    #[test]
    fn validate_accepts_existing_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let resolved =
            validate_open_in_code_path(dir.path().to_str().expect("utf8")).expect("existing dir");
        assert_eq!(resolved, dir.path());
    }

    /// A `.cmd` shim stays the program. Wrapping it in `cmd /C` by hand would
    /// hand the target path to cmd under `CommandLineToArgvW` quoting, which
    /// leaves `&` live — see [`spawn_vscode`]. `Command` does the wrapping
    /// itself, with batch-safe quoting.
    #[test]
    fn from_binary_keeps_windows_shim_as_the_program() {
        let launch = VsCodeLaunch::from_binary(PathBuf::from("C:/tools/code.cmd"));
        assert_eq!(launch.program, PathBuf::from("C:/tools/code.cmd"));
        assert!(launch.args_prefix.is_empty(), "{launch:?}");
    }

    #[test]
    fn known_binaries_include_platform_install_locations() {
        let paths = known_vscode_binaries();
        #[cfg(windows)]
        {
            assert!(
                paths
                    .iter()
                    .any(|p| p.ends_with("Microsoft VS Code\\Code.exe")
                        || p.ends_with("Microsoft VS Code/Code.exe")),
                "{paths:?}"
            );
        }
        #[cfg(target_os = "macos")]
        {
            assert!(
                paths
                    .iter()
                    .any(|p| p.to_string_lossy().contains("Visual Studio Code.app")),
                "{paths:?}"
            );
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            assert!(
                paths.iter().any(|p| p == Path::new("/usr/bin/code")),
                "{paths:?}"
            );
        }
    }

    /// Run the stub against `dir/<target_name>` and return what it recorded as
    /// its first argument.
    async fn record_launch_arg(target_name: &str) -> (PathBuf, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join(target_name);
        fs::create_dir(&target).expect("mkdir target");
        let marker = dir.path().join("marker.txt");
        let stub = write_stub_recorder(dir.path(), &marker);
        let launch = VsCodeLaunch::from_binary(stub);
        spawn_vscode(&launch, &target).expect("spawn stub");
        let recorded = wait_for_marker(&marker);
        (target, recorded)
    }

    #[tokio::test]
    async fn spawn_runs_stub_with_target_path() {
        let (target, recorded) = record_launch_arg("workspace").await;
        let expected = target.to_string_lossy();
        assert!(
            recorded.contains(expected.as_ref()),
            "stub recorded {recorded:?}, expected to contain {expected:?}"
        );
    }

    /// `&` is a legal file-name character on every platform codeg ships to, and
    /// a cmd command separator on one of them. The teeth are on Windows, where
    /// the stub is a `.cmd`: hand-wrapping it in `cmd /C` truncates the argument
    /// at the `&` and runs the remainder as a command. Elsewhere the stub is
    /// `/bin/sh` reading a quoted `"$1"`, so this only pins the arg down.
    ///
    /// The name is deliberately free of whitespace. `append_arg` — the quoting
    /// the hand-rolled wrapper would have gotten — quotes on space/tab alone, so
    /// a name like `a & b` would come out quoted and survive cmd either way,
    /// leaving nothing to discriminate. (Which does assume the temp root itself
    /// has no space in it; it doesn't on CI.)
    #[tokio::test]
    async fn spawn_passes_shell_metacharacters_through_intact() {
        let (target, recorded) = record_launch_arg("open&canary").await;
        let expected = target.to_string_lossy();
        assert!(
            recorded.contains(expected.as_ref()),
            "stub recorded {recorded:?}, expected to contain {expected:?} whole"
        );
    }

    #[tokio::test]
    async fn open_in_code_core_errors_when_path_missing() {
        let err = open_in_code_core("/no/such/codeg/open-in-code-target".into())
            .await
            .expect_err("missing path");
        assert!(err.message.contains("does not exist"), "{err:?}");
    }

    #[test]
    fn local_file_rejects_empty_and_control_characters() {
        assert!(validate_open_local_file_path("  ").is_err());
        assert!(validate_open_local_file_path("/tmp/a\nb").is_err());
    }

    /// A URL is not a file: `openUrl` is the errand for those, and letting one
    /// through here would aim the OS handler at something else entirely.
    #[test]
    fn local_file_rejects_urls() {
        let err = validate_open_local_file_path("https://example.com/a.md").expect_err("url");
        assert!(err.message.contains("local filesystem path"), "{err:?}");
    }

    #[test]
    fn local_file_rejects_relative_and_missing_paths() {
        assert!(validate_open_local_file_path("src/app.ts").is_err());
        // Built from the temp root: `/no/such` is not absolute on Windows,
        // where the rejection would come from the wrong check.
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist.md");
        let err =
            validate_open_local_file_path(missing.to_str().expect("utf8")).expect_err("missing");
        assert!(err.message.contains("does not exist"), "{err:?}");
    }

    /// The path handed over is the one the renderer resolved, unchanged — a
    /// file that exists passes whether its name holds spaces or not.
    #[test]
    fn local_file_accepts_an_existing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("方案 a.md");
        fs::write(&file, "x").expect("write file");
        let resolved =
            validate_open_local_file_path(file.to_str().expect("utf8")).expect("existing file");
        assert_eq!(resolved, file);
    }

    /// A directory (or a macOS `.app` bundle) is the file manager row's
    /// errand; a name that begins with a space is still that file.
    #[test]
    fn local_file_refuses_a_directory_and_keeps_the_name_as_given() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = validate_open_local_file_path(dir.path().to_str().expect("utf8"))
            .expect_err("directory");
        assert!(err.message.contains("not a file"), "{err:?}");

        let spaced = dir.path().join(" notes.md");
        fs::write(&spaced, "x").expect("write file");
        let resolved = validate_open_local_file_path(spaced.to_str().expect("utf8"))
            .expect("existing file with a leading space");
        assert_eq!(resolved, spaced);
    }

    /// A trailing space is a legal Unix file name; Win32 path normalization
    /// strips it, so the case only exists off Windows.
    #[cfg(not(windows))]
    #[test]
    fn local_file_keeps_a_trailing_space() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spaced = dir.path().join("notes.md ");
        fs::write(&spaced, "x").expect("write file");
        let resolved = validate_open_local_file_path(spaced.to_str().expect("utf8"))
            .expect("existing file with a trailing space");
        assert_eq!(resolved, spaced);
    }

    /// The renderer hands Windows paths over slash-normalized; the shell gets
    /// the native form.
    #[cfg(windows)]
    #[test]
    fn local_file_hands_windows_its_native_separators() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("a.md");
        fs::write(&file, "x").expect("write file");
        let slashed = file.to_str().expect("utf8").replace('\\', "/");
        let resolved = validate_open_local_file_path(&slashed).expect("existing file");
        assert_eq!(resolved, file);
        assert!(!resolved.to_string_lossy().contains('/'), "{resolved:?}");
    }

    /// `[report.pdf](./payload)` must not be a one-click way to run the
    /// payload: a runnable type is refused whatever its case, and so is a
    /// document-named link to one.
    #[test]
    fn local_file_refuses_what_runs_code_when_opened() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ext = RUNNABLE_EXTENSIONS[0];
        for name in [
            format!("payload.{ext}"),
            format!("PAYLOAD.{}", ext.to_uppercase()),
        ] {
            let file = dir.path().join(&name);
            fs::write(&file, "x").expect("write file");
            let err = validate_open_local_file_path(file.to_str().expect("utf8"))
                .expect_err("runnable type");
            assert!(err.message.contains("can run code"), "{name}: {err:?}");
        }

        let doc = dir.path().join("report.pdf");
        fs::write(&doc, "%PDF").expect("write file");
        validate_open_local_file_path(doc.to_str().expect("utf8")).expect("a document");
    }

    #[cfg(unix)]
    #[test]
    fn local_file_refuses_an_executable_and_a_link_to_a_runnable_type() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");

        let tool = dir.path().join("report.pdf");
        fs::write(&tool, "#!/bin/sh\n").expect("write file");
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).expect("chmod");
        let err =
            validate_open_local_file_path(tool.to_str().expect("utf8")).expect_err("executable");
        assert!(err.message.contains("can run code"), "{err:?}");

        let payload = dir
            .path()
            .join(format!("payload.{}", RUNNABLE_EXTENSIONS[0]));
        fs::write(&payload, "x").expect("write file");
        let link = dir.path().join("notes.pdf");
        std::os::unix::fs::symlink(&payload, &link).expect("symlink");
        let err = validate_open_local_file_path(link.to_str().expect("utf8"))
            .expect_err("link to a runnable type");
        assert!(err.message.contains("can run code"), "{err:?}");
    }

    /// exFAT/FAT volumes report every file executable; a document there is
    /// still a document.
    #[cfg(unix)]
    #[test]
    fn local_file_opens_a_document_whose_execute_bit_is_set() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let doc = dir.path().join("report.pdf");
        fs::write(&doc, "%PDF-1.7").expect("write file");
        fs::set_permissions(&doc, fs::Permissions::from_mode(0o777)).expect("chmod");
        validate_open_local_file_path(doc.to_str().expect("utf8")).expect("a document");

        let binary = dir.path().join("LICENSE");
        fs::write(&binary, b"\x7fELF\x02\x01").expect("write file");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).expect("chmod");
        let err = validate_open_local_file_path(binary.to_str().expect("utf8"))
            .expect_err("an executable image");
        assert!(err.message.contains("can run code"), "{err:?}");
    }

    #[test]
    fn script_hosts_are_known_by_their_program_name() {
        for host in [
            r"C:\Windows\py.exe",
            r"C:\Python313\pythonw.exe",
            r"C:\Windows\System32\WScript.exe",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe",
            "/usr/bin/python3",
        ] {
            assert!(is_script_host(host), "{host}");
        }
        for viewer in [
            r"C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe",
            r"C:\Windows\System32\notepad.exe",
            r"C:\Program Files\Microsoft VS Code\Code.exe",
        ] {
            assert!(!is_script_host(viewer), "{viewer}");
        }
    }

    /// A launcher stub: `body` is the shell script after the shebang.
    #[cfg(not(windows))]
    fn launcher_stub(dir: &Path, body: &str) -> tokio::process::Command {
        let stub = dir.join("launcher");
        crate::process::write_test_script(&stub, &format!("#!/bin/sh\n{body}\n"));
        tokio::process::Command::new(stub)
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn launcher_failure_reports_what_it_said() {
        let dir = tempfile::tempdir().expect("tempdir");
        let command = launcher_stub(
            dir.path(),
            "echo 'No application knows how to open it.' >&2\nexit 1",
        );
        let err = run_default_app_launcher(
            command,
            DefaultAppLauncher::CapturesStderr,
            Path::new("/repo/a.xyz"),
            Duration::from_secs(10),
        )
        .await
        .expect_err("non-zero exit");
        assert!(
            matches!(
                err.code,
                crate::app_error::AppErrorCode::ExternalCommandFailed
            ),
            "{err:?}"
        );
        assert!(err.message.contains("Failed to open"), "{err:?}");
        let detail = err.detail.unwrap_or_default();
        assert!(detail.contains("/repo/a.xyz"), "{detail}");
        assert!(detail.contains("No application knows"), "{detail}");
    }

    /// `xdg-open`'s stderr is not read (an application it runs in the
    /// foreground inherits it); its documented exit code says why instead.
    #[cfg(not(windows))]
    #[tokio::test]
    async fn xdg_open_failure_is_told_by_its_exit_code() {
        let dir = tempfile::tempdir().expect("tempdir");
        let command = launcher_stub(dir.path(), "echo unread >&2\nexit 4");
        let err = run_default_app_launcher(
            command,
            DefaultAppLauncher::XdgOpen,
            Path::new("/a.xyz"),
            Duration::from_secs(10),
        )
        .await
        .expect_err("non-zero exit");
        let detail = err.detail.unwrap_or_default();
        assert!(detail.contains("no application could open it"), "{detail}");
        assert!(!detail.contains("unread"), "{detail}");

        let command = launcher_stub(dir.path(), "exit 1");
        let err = run_default_app_launcher(
            command,
            DefaultAppLauncher::Silent,
            Path::new("/a.xyz"),
            Duration::from_secs(10),
        )
        .await
        .expect_err("non-zero exit");
        assert!(
            err.detail.as_deref().unwrap_or_default().contains('1'),
            "{err:?}"
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn launcher_success_and_a_still_running_launcher_both_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        let command = launcher_stub(dir.path(), "exit 0");
        run_default_app_launcher(
            command,
            DefaultAppLauncher::CapturesStderr,
            Path::new("/a"),
            Duration::from_secs(10),
        )
        .await
        .expect("exit 0");

        // An `xdg-open` fallback running the application in the foreground.
        let command = launcher_stub(dir.path(), "sleep 5");
        let started = Instant::now();
        run_default_app_launcher(
            command,
            DefaultAppLauncher::XdgOpen,
            Path::new("/a"),
            Duration::from_millis(200),
        )
        .await
        .expect("still running at the verdict");
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
