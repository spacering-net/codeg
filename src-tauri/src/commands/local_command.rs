use std::ffi::OsString;
use std::process::Stdio;

use crate::app_error::AppCommandError;
use crate::terminal::shell_flavor::{classify_shell_family, ShellFamily};

/// Run a folder command on the machine this desktop app runs on, even when the
/// window is bound to a remote codeg-server.
///
/// Every other folder-command path goes through the window's transport, which
/// in a remote-desktop window means the remote host. This one is only ever
/// called through the local shell transport, and is not routed in the web
/// server, so the command can only ever land on the user's own machine.
///
/// The command runs detached through the user's shell with nothing attached to
/// stdio — it is meant for launchers (`zed ssh://…`, `open …`), not for jobs
/// whose output matters. A successful return only means the shell was spawned.
///
/// `folder_path` is the active folder's path *on its host* (the remote path in a
/// remote-desktop window) and `remote_host` the remote server's host name; both
/// reach the command as `CODEG_FOLDER_PATH` / `CODEG_REMOTE_HOST`.
///
/// `async` because the spawn needs a tokio runtime in scope, not because it
/// awaits anything.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn run_local_command(
    command: String,
    folder_path: Option<String>,
    remote_host: Option<String>,
) -> Result<(), AppCommandError> {
    let command = validate_local_command(&command)?;
    let shell = crate::terminal::manager::resolve_shell();
    let mut child = tokio::process::Command::new(&shell);
    child
        .args(shell_args(&shell, command))
        .env("CODEG_CMD", command)
        .env("CODEG_FOLDER_PATH", folder_path.unwrap_or_default())
        .env("CODEG_REMOTE_HOST", remote_host.unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(home) = dirs::home_dir() {
        child.current_dir(home);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child.creation_flags(CREATE_NO_WINDOW);
    }

    // Dropping tokio's `Child` hands it to the runtime's orphan queue, which
    // reaps it once it exits (see `open_in::spawn_vscode`).
    child.spawn().map(|_| ()).map_err(|err| {
        AppCommandError::external_command("Failed to run local command", format!("{shell}: {err}"))
    })
}

fn validate_local_command(command: &str) -> Result<&str, AppCommandError> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("command is required"));
    }
    if trimmed.contains('\0') {
        return Err(AppCommandError::invalid_input(
            "command must not contain NUL characters",
        ));
    }
    Ok(trimmed)
}

/// Shell arguments that run `$CODEG_CMD` and exit. The command travels in the
/// env var rather than argv to sidestep quoting — the same indirection the
/// built-in terminal uses. POSIX shells get `-l` so the user's login profile
/// (PATH for `zed`, `code`, …) applies; no `-i`, as there is no TTY here.
fn shell_args(shell: &str, command: &str) -> Vec<OsString> {
    let args: Vec<&str> = match classify_shell_family(shell) {
        ShellFamily::PowerShell => vec![
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Invoke-Expression $env:CODEG_CMD",
        ],
        ShellFamily::Cmd => vec!["/D", "/S", "/C", "%CODEG_CMD%"],
        ShellFamily::Posix if is_bash_like(shell) => vec!["-l", "-c", "eval \"$CODEG_CMD\""],
        // nu / xonsh / elvish: no assumptions about `-l` or `eval`.
        ShellFamily::Posix => vec!["-c", command],
    };
    args.into_iter().map(OsString::from).collect()
}

fn is_bash_like(shell: &str) -> bool {
    matches!(
        crate::terminal::shell_flavor::shell_basename(shell).trim_end_matches(".exe"),
        "bash" | "zsh" | "sh" | "dash" | "ksh" | "ash" | "mksh" | "busybox" | "fish"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_blank_command() {
        let err = validate_local_command("   ").expect_err("blank");
        assert!(err.message.contains("required"), "{err:?}");
    }

    #[test]
    fn validate_trims_command() {
        assert_eq!(validate_local_command("  zed .  ").unwrap(), "zed .");
    }

    #[test]
    fn bash_like_shells_eval_the_env_var_in_a_login_shell() {
        let args = shell_args("/bin/zsh", "zed .");
        assert_eq!(args, ["-l", "-c", "eval \"$CODEG_CMD\""]);
    }

    #[test]
    fn unknown_posix_shells_get_the_command_verbatim() {
        let args = shell_args("/usr/bin/nu", "zed .");
        assert_eq!(args, ["-c", "zed ."]);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn runs_command_with_folder_env() {
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("marker.txt");
        run_local_command(
            format!(
                "printf '%s|%s' \"$CODEG_FOLDER_PATH\" \"$CODEG_REMOTE_HOST\" > '{}'",
                marker.display()
            ),
            Some("/srv/repo".into()),
            Some("devbox".into()),
        )
        .await
        .expect("spawn");

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&marker) {
                if !contents.is_empty() {
                    assert_eq!(contents, "/srv/repo|devbox");
                    return;
                }
            }
            assert!(Instant::now() < deadline, "command never wrote the marker");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
