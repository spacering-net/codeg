//! `codeg-cli --standalone`: a codeg-server of the command's own, for a job
//! with no codeg running — started on a data directory of its own (a fresh
//! temporary one, or `--data-dir`), used for this one command, stopped when
//! the command ends.
//!
//! It is only ever started when asked for: a runtime that does not answer,
//! or fails its proof, is reported, never replaced by one of these. The
//! server takes its data directory alone (`runtime_lock`): with another codeg
//! alive there — even one that cannot be reached — it leaves before touching
//! anything, and the command says so. It ends with this process: its stdin
//! is a pipe from here, which closes however this process ends. It runs in a
//! process group of its own, so the terminal's Ctrl-C reaches this command
//! alone, which cancels its run before the server goes.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::time::Instant;

use crate::cli_run::discovery;
use crate::cli_run::wire::Subtype;
use crate::runtime_lock;

use super::connect::{self, CandidateState, Env, Level};
use super::Failure;

/// How long the server may take to come up: migrations of a database it may
/// be meeting for the first time included.
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// After its stdin closed: how long the server has to leave on its own.
const STOP_WAIT: Duration = Duration::from_secs(5);
/// The last lines of the server's stderr kept, for a failure to quote.
const STDERR_LINES: usize = 40;

/// A private server, running.
pub struct Standalone {
    child: Child,
    stdin: Option<ChildStdin>,
    endpoint_file: PathBuf,
    data_dir: PathBuf,
    temporary: Option<tempfile::TempDir>,
}

impl Standalone {
    /// Start the server, and wait until it proves itself on its endpoint
    /// file — or `deadline` passes.
    pub async fn start(
        data_dir: Option<&Path>,
        deadline: Option<Instant>,
    ) -> Result<Self, Failure> {
        let server = locate_server().ok_or_else(|| {
            Failure::new(
                Subtype::ErrorRuntimeUnavailable,
                "no_server",
                "--standalone starts a codeg-server, and there is none next to codeg-cli or on \
                 PATH",
            )
            .with_next_steps([
                "curl -fsSL https://raw.githubusercontent.com/spacering-net/codeg/main/install.sh \
                 | bash"
                    .to_string(),
            ])
        })?;
        let (temporary, data_dir) = match data_dir {
            Some(dir) => {
                let dir = std::path::absolute(dir).map_err(|e| {
                    Failure::usage("bad_data_dir", format!("--data-dir {}: {e}", dir.display()))
                })?;
                (None, dir)
            }
            None => {
                let temp = tempfile::Builder::new()
                    .prefix("codeg-cli-")
                    .tempdir()
                    .map_err(|e| {
                        Failure::new(
                            Subtype::ErrorRuntimeUnavailable,
                            "standalone_failed",
                            format!("--standalone: no temporary data directory: {e}"),
                        )
                    })?;
                let dir = temp.path().to_path_buf();
                (Some(temp), dir)
            }
        };

        let mut command = Command::new(&server);
        command
            .env("CODEG_DATA_DIR", &data_dir)
            .env("CODEG_HOST", "127.0.0.1")
            .env("CODEG_PORT", "0")
            .env("CODEG_TOKEN", crate::cli_run::hello::random_hex(32))
            .env("CODEG_BRIDGE_PORTS", "off")
            .env(runtime_lock::EXCLUSIVE_ENV, "1")
            .env(runtime_lock::EXIT_ON_STDIN_EOF_ENV, "1")
            // Its own, not the one of a codeg this command may run inside.
            .env_remove(discovery::ENDPOINT_FILE_ENV)
            .env_remove("CODEG_SUPERVISED")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        {
            // CREATE_NEW_PROCESS_GROUP: the console's Ctrl-C is not its.
            command.creation_flags(0x0000_0200);
        }
        let mut child = command.spawn().map_err(|e| {
            Failure::new(
                Subtype::ErrorRuntimeUnavailable,
                "standalone_failed",
                format!("--standalone: cannot start {}: {e}", server.display()),
            )
        })?;
        let stdin = child.stdin.take();
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            // Drained all along: a full pipe would stall the server.
            let tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut tail = tail.lock().expect("stderr tail");
                    if tail.len() == STDERR_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            });
        }
        let pid = child.id().unwrap_or_default();
        let mut standalone = Self {
            child,
            stdin,
            endpoint_file: discovery::file_for(&data_dir, pid),
            data_dir,
            temporary,
        };
        match standalone.until_ready(deadline, &stderr_tail).await {
            Ok(()) => Ok(standalone),
            Err(failure) => {
                standalone.stop().await;
                Err(failure)
            }
        }
    }

    /// What the command connects with: this server's endpoint file, and
    /// nothing else to look at.
    pub fn env(&self, env: &Env) -> Env {
        Env {
            endpoint_file: Some(self.endpoint_file.clone()),
            url: None,
            token: None,
            data_dir: None,
            caller: env.caller.clone(),
            platform_data_dir: None,
        }
    }

    async fn until_ready(
        &mut self,
        deadline: Option<Instant>,
        stderr_tail: &Arc<Mutex<VecDeque<String>>>,
    ) -> Result<(), Failure> {
        let give_up = Instant::now() + START_TIMEOUT;
        let give_up = deadline.map_or(give_up, |d| d.min(give_up));
        let level = Level::EndpointFile(self.endpoint_file.clone());
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(match status.code() {
                    Some(code) if code == i32::from(runtime_lock::BUSY_EXIT_CODE) => Failure::new(
                        Subtype::ErrorRuntimeUnavailable,
                        "data_dir_in_use",
                        format!(
                            "{} is in use by another codeg, so --standalone cannot have it to \
                             itself. Nothing was sent.",
                            self.data_dir.display()
                        ),
                    )
                    .with_next_steps([
                        "leave out --data-dir, for a data directory of the command's own"
                            .to_string(),
                        "or drop --standalone, to use the codeg that is running".to_string(),
                    ]),
                    _ => Failure::new(
                        Subtype::ErrorRuntimeUnavailable,
                        "standalone_failed",
                        format!(
                            "the --standalone codeg-server ended at startup ({status}){}",
                            last_lines(stderr_tail)
                        ),
                    ),
                });
            }
            if self.endpoint_file.is_file() {
                let candidates = connect::examine(&level).await;
                if candidates.iter().any(|c| c.state == CandidateState::Ready) {
                    return Ok(());
                }
            }
            if Instant::now() >= give_up {
                return Err(match deadline {
                    Some(d) if d <= give_up => Failure::new(
                        Subtype::ErrorTimeout,
                        "timeout",
                        "--timeout ran out while the --standalone codeg-server started; nothing \
                         was sent",
                    ),
                    _ => Failure::new(
                        Subtype::ErrorRuntimeUnavailable,
                        "standalone_failed",
                        format!(
                            "the --standalone codeg-server did not come up within {} s{}",
                            START_TIMEOUT.as_secs(),
                            last_lines(stderr_tail)
                        ),
                    ),
                });
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// End the server and take its temporary data directory away. Its
    /// stdin closes first, which it leaves on; one that does not is made to.
    pub async fn stop(mut self) {
        drop(self.stdin.take());
        if tokio::time::timeout(STOP_WAIT, self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
        if let Some(temp) = self.temporary.take() {
            // The server's agents may still be letting go of files in it
            // (Windows keeps a directory with an open file in it).
            let path = temp.keep();
            for _ in 0..10 {
                if std::fs::remove_dir_all(&path).is_ok() || !path.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// `codeg-server` next to this program — as the server package installs the
/// two — or else on PATH.
fn locate_server() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "codeg-server.exe"
    } else {
        "codeg-server"
    };
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|p| p.metadata().is_ok_and(|m| m.is_file() && m.len() > 0));
    beside.or_else(|| which::which("codeg-server").ok())
}

fn last_lines(tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    let tail = tail.lock().expect("stderr tail");
    if tail.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = tail.iter().rev().take(5).map(String::as_str).collect();
    let lines: Vec<&str> = lines.into_iter().rev().collect();
    format!(": {}", lines.join(" | "))
}
