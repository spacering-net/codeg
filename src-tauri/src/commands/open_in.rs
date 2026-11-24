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
}
