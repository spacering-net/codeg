//! Spawning an external ACP agent as a child process and connecting to it
//! over stdio.
//!
//! codeg's own copy of the `AcpAgent` transport. It started life as the
//! `sacp-tokio` crate (vendored with codeg's patches) and moved in-tree when
//! codeg switched to the official `agent-client-protocol` runtime. That crate
//! ships an `AcpAgent` too — built on `async-process`; on Unix it starts the
//! child in its own process group and kills the group on drop — but it has no
//! room for the rest of what codeg depends on:
//!
//! * the whole process TREE is killed on drop (`kill_tree`), on every platform
//!   and including descendants that left the child's process group, so an
//!   `npx`/`node` launcher cannot leave the real agent behind;
//! * [`AcpAgent::with_current_dir`] sets the child's cwd (Hermes derives its
//!   working directory from the process cwd, not from `session/new`);
//! * an EMPTY env value means "remove the inherited variable" rather than "set
//!   it empty" (see `spawn_process`);
//! * [`AcpAgent::on_spawn`] publishes the pid, and [`AcpAgent::on_exit`] fires
//!   only once the child is really reaped, so a host's shutdown backstop never
//!   aims a kill at a recycled pid;
//! * a UNC workspace behind a Windows batch launcher takes a `pushd` detour so
//!   `cmd.exe` does not silently swap the cwd for `C:\Windows`.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{EnvVariable, McpServer, McpServerStdio};
use agent_client_protocol::{Client, Conductor, ConnectTo, LineDirection, Lines, Role};
use tokio::process::Child;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// Observer for every line crossing the agent's stdio, and which way it went.
type DebugCallback = Arc<dyn Fn(&str, LineDirection) + Send + Sync + 'static>;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_STDERR_CAPTURE_BYTES: usize = 1024 * 1024;

/// Windows' extended-length spelling of a UNC path, e.g. what
/// `fs::canonicalize` returns for `\\server\share`.
const VERBATIM_UNC_PREFIX: &str = r"\\?\UNC\";

fn is_windows_unc_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with(r"\\?\unc\")
        || (path.starts_with(r"\\") && !path.starts_with(r"\\?\") && !path.starts_with(r"\\.\"))
}

fn is_windows_batch_file(command: &std::path::Path) -> bool {
    let lower = command.to_string_lossy().to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// True for a path `cmd.exe` runs outright, without consulting a search order:
/// drive-absolute (`C:\…`, `C:/…`) or UNC (`\\…`).
///
/// `Path::is_absolute` cannot answer this — it follows the HOST's rules, and
/// this decision has to hold (and be testable) on the Linux CI that runs this
/// crate's tests. Drive-relative (`C:x`) and root-relative (`\x`) both resolve
/// against the *current* drive and directory, so neither counts.
///
/// A forward-slash UNC spelling (`//server/share/agent.cmd`) is deliberately
/// NOT recognised, and neither is one as the cwd. Win32 accepts it, but cmd
/// reads a leading `/` inconsistently, and nothing reaches this crate spelled
/// that way — `which`, `PathBuf::join` and the OS dialogs all hand back
/// backslashes. Such a launch keeps the direct spawn, which is to say the
/// behaviour it already had; widening a hand-built cmd command line to cover
/// a shape no caller produces would cost more than it buys.
fn is_absolute_windows_path(path: &std::path::Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    if text.starts_with(r"\\") {
        return true;
    }
    let bytes = text.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// The directory `pushd` has to map for this launch, or `None` when the plain
/// direct spawn is the right one.
///
/// This is the ONLY place that decides a launch takes the cmd detour: both the
/// command line and the `current_dir` call read it, so they cannot drift apart
/// and leave `cmd.exe` holding a UNC cwd it would silently trade for
/// `C:\Windows` — the very bug the detour exists to fix.
///
/// The launcher must already be an absolute path. Rust resolves a bare program
/// name against PATH and pointedly NOT against the child's cwd; cmd.exe's own
/// search order starts at the current directory, which `pushd` has just pointed
/// at the workspace. Taking the detour with a relative launcher would therefore
/// let an `agent.cmd` committed to the repo shadow the trusted one on PATH, so
/// that shape keeps the direct spawn instead — the cwd stays wrong there, which
/// is exactly what it already was.
///
/// The answer is the plain `\\server\share\…` spelling with any trailing
/// separator removed, because `pushd` is a cmd BUILT-IN rather than a batch
/// file, and cmd parses its own command line:
///
/// * it cannot resolve an extended-length `\\?\UNC\…` path at all (the shape
///   `fs::canonicalize` hands back on Windows), and
/// * it never undoes the `\` doubling `append_windows_batch_arg` applies to a
///   trailing backslash — right for an argument a batch file re-parses, wrong
///   here, where the doubled pair would reach `pushd` verbatim.
///
/// Either shape makes `pushd` fail, and `&&` then takes the whole agent launch
/// down with it. Every other path survives that quoting byte-for-byte, so the
/// two agree once these two shapes are ruled out.
fn windows_pushd_cwd(
    current_dir: Option<&std::path::Path>,
    command: &std::path::Path,
) -> Option<String> {
    if !is_windows_batch_file(command) || !is_absolute_windows_path(command) {
        return None;
    }
    let dir = current_dir?.to_str()?;
    if !is_windows_unc_path(dir) {
        return None;
    }
    // `\\?\UNC\server\share` → `\\server\share`; a plain UNC path keeps its
    // own leading pair. Casing is not ours to predict — Windows accepts
    // `\\?\unc\` as readily as `\\?\UNC\`.
    let rest = match dir.get(..VERBATIM_UNC_PREFIX.len()) {
        Some(head) if head.eq_ignore_ascii_case(VERBATIM_UNC_PREFIX) => {
            &dir[VERBATIM_UNC_PREFIX.len()..]
        }
        // `is_windows_unc_path` already proved the first two bytes are ASCII
        // backslashes, so this can neither split a character nor run past the
        // end.
        _ => &dir[2..],
    };
    Some(format!(r"\\{}", rest.trim_end_matches(['\\', '/'])))
}

#[cfg(windows)]
fn system_cmd_exe() -> PathBuf {
    // Avoid resolving cmd.exe from a potentially untrusted workspace. Agent
    // environment overrides are applied only after this path is selected.
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("cmd.exe")
}

/// Append one argument using the same defensive quoting rules Rust's standard
/// library applies when it launches a Windows batch file. In particular, cmd
/// metacharacters stay quoted and percent signs cannot expand environment vars.
#[cfg(any(windows, test))]
fn append_windows_batch_arg(output: &mut String, arg: &str) -> std::io::Result<()> {
    if arg.contains(['\r', '\n', '\0']) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "batch file arguments may not contain line breaks or NUL bytes",
        ));
    }

    const UNQUOTED: &str = r"#$*+-./:?@\_";
    let quote = arg.is_empty()
        || arg.ends_with('\\')
        || arg.chars().any(|ch| {
            (ch.is_ascii() && !(ch.is_ascii_alphanumeric() || UNQUOTED.contains(ch)))
                || ch.is_control()
        });

    if quote {
        output.push('"');
    }
    let mut backslashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            output.extend(std::iter::repeat_n('\\', backslashes * 2));
            output.push_str("\"\"");
        } else {
            output.extend(std::iter::repeat_n('\\', backslashes));
            if ch == '%' || ch == '\r' {
                output.push_str("%%cd:~,");
            }
            output.push(ch);
        }
        backslashes = 0;
    }
    if quote {
        output.extend(std::iter::repeat_n('\\', backslashes * 2));
        output.push('"');
    } else {
        output.extend(std::iter::repeat_n('\\', backslashes));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn make_unc_batch_command_line(
    cwd: &str,
    command: &std::path::Path,
    args: &[String],
) -> std::io::Result<String> {
    let mut line = String::from("/e:ON /v:OFF /d /s /c \"pushd ");
    append_windows_batch_arg(&mut line, cwd)?;
    // Do not use `call`: it reparses arguments and can expand metacharacters a
    // second time. The batch file may take over this short-lived cmd process.
    line.push_str(" && ");
    append_windows_batch_arg(
        &mut line,
        command.to_str().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "batch file path is not valid Unicode",
            )
        })?,
    )?;
    for arg in args {
        line.push(' ');
        append_windows_batch_arg(&mut line, arg)?;
    }
    line.push('"');
    Ok(line)
}

/// An external ACP agent running as a child process, connected over stdio.
///
/// Implements [`ConnectTo`] so it can be handed straight to
/// `Client.builder().connect_with(...)`: the process is spawned when the
/// connection starts, its stdout/stdin become the JSON-RPC line streams, and
/// the connection ends with an error if the process exits early.
pub struct AcpAgent {
    server: McpServer,
    debug_callback: Option<DebugCallback>,
    current_dir: Option<PathBuf>,
    spawn_callback: Option<Arc<dyn Fn(u32) + Send + Sync + 'static>>,
    exit_callback: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
}

impl std::fmt::Debug for AcpAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpAgent")
            .field("server", &self.server)
            .field(
                "debug_callback",
                &self.debug_callback.as_ref().map(|_| "..."),
            )
            .field("current_dir", &self.current_dir)
            .field(
                "spawn_callback",
                &self.spawn_callback.as_ref().map(|_| "..."),
            )
            .field("exit_callback", &self.exit_callback.as_ref().map(|_| "..."))
            .finish()
    }
}

impl AcpAgent {
    /// Create a new `AcpAgent` from an [`McpServer`] launch configuration.
    pub fn new(server: McpServer) -> Self {
        Self {
            server,
            debug_callback: None,
            current_dir: None,
            spawn_callback: None,
            exit_callback: None,
        }
    }

    /// Add a debug callback that will be invoked for each line sent/received.
    ///
    /// The callback receives the line content and the direction (stdin/stdout/stderr).
    /// This is useful for logging, debugging, or monitoring agent communication.
    ///
    pub fn with_debug<F>(mut self, callback: F) -> Self
    where
        F: Fn(&str, LineDirection) + Send + Sync + 'static,
    {
        self.debug_callback = Some(Arc::new(callback));
        self
    }

    /// Set the working directory for the spawned agent process.
    ///
    /// Without this the child inherits the parent process's cwd. Agents that
    /// derive their effective working directory from the process cwd (e.g.
    /// Hermes' local backend force-exports `TERMINAL_CWD = os.getcwd()`)
    /// rather than from the ACP `session/new` `cwd` need this to run in the
    /// right place.
    pub fn with_current_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(dir.into());
        self
    }

    /// Register a callback invoked once with the OS process id (pid) of the
    /// spawned agent process, right after it launches.
    ///
    /// The child is otherwise owned entirely by
    /// [`ConnectTo::connect_to`]'s internal `ChildGuard`, which kills the
    /// whole process tree on drop. But that drop
    /// only runs when the driving future completes — during a host-process
    /// shutdown the driver may be torn down before it can, leaking the agent
    /// (and its own child processes) as orphans. Exposing the pid lets the host
    /// record it and force a synchronous `kill_tree` on exit as a backstop.
    ///
    pub fn on_spawn<F>(mut self, callback: F) -> Self
    where
        F: Fn(u32) + Send + Sync + 'static,
    {
        self.spawn_callback = Some(Arc::new(callback));
        self
    }

    /// Register a callback invoked once when the agent process has been
    /// *reaped* — the counterpart to [`on_spawn`](Self::on_spawn), telling a
    /// host that the pid it recorded no longer names this process.
    ///
    /// It deliberately does NOT fire merely because the connection ended. When
    /// the protocol future finishes first, the internal `ChildGuard` kills the
    /// tree on drop, but `kill_tree` only signals (SIGTERM on Unix) and does
    /// not wait — the process can still be alive, so a host that cleared its
    /// pid record there would disarm its own shutdown backstop.
    ///
    /// The callback fires only where the pid genuinely stops being ours: after
    /// a successful `wait`, on drop of an already-reaped child, or from the
    /// detached reaper that `drop` hands a still-running child to. That last
    /// one is why the guard keeps owning the child instead of letting it fall
    /// into Tokio's orphan queue — a pid reaped out of sight would go stale
    /// while the host still believed it named this agent.
    ///
    pub fn on_exit<F>(mut self, callback: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.exit_callback = Some(Arc::new(callback));
        self
    }

    /// Spawn the process and get stdio streams.
    /// Used internally by the Component trait implementation.
    pub fn spawn_process(
        &self,
    ) -> Result<
        (
            tokio::process::ChildStdin,
            tokio::process::ChildStdout,
            tokio::process::ChildStderr,
            Child,
        ),
        agent_client_protocol::Error,
    > {
        match &self.server {
            McpServer::Stdio(stdio) => {
                // cmd.exe cannot use a UNC path as its process cwd, and a
                // batch launcher always runs under cmd.exe (std spawns one for
                // any `.cmd`/`.bat` program). Left alone it drops the cwd for
                // `C:\Windows`, so that one combination is launched through a
                // `pushd` detour instead, which maps the share to a temporary
                // drive first. `None` on every other host and every other
                // launch — and the single decision both branches below read.
                let pushd_cwd = if cfg!(windows) {
                    windows_pushd_cwd(self.current_dir.as_deref(), &stdio.command)
                } else {
                    None
                };
                #[cfg(windows)]
                let mut cmd = {
                    use std::os::windows::process::CommandExt;

                    if let Some(dir) = pushd_cwd.as_deref() {
                        let command_line =
                            make_unc_batch_command_line(dir, &stdio.command, &stdio.args)
                                .map_err(agent_client_protocol::Error::into_internal_error)?;
                        let mut command = tokio::process::Command::new(system_cmd_exe());
                        command.as_std_mut().raw_arg(command_line);
                        command
                    } else {
                        let mut command = tokio::process::Command::new(&stdio.command);
                        command.args(&stdio.args);
                        command
                    }
                };
                #[cfg(not(windows))]
                let mut cmd = {
                    let mut command = tokio::process::Command::new(&stdio.command);
                    command.args(&stdio.args);
                    command
                };
                for env_var in &stdio.env {
                    // codeg convention: an empty value means "ensure this var is
                    // ABSENT from the child" (strip an inherited value) rather
                    // than setting it empty. The child otherwise inherits this
                    // process's environment, so this lets the launch layer
                    // deterministically clear a leaked credential — e.g. Cursor
                    // subscription mode removing an inherited CURSOR_API_KEY so
                    // the CLI uses its browser-login credential. No current
                    // caller passes an intentional empty value.
                    if env_var.value.is_empty() {
                        cmd.env_remove(&env_var.name);
                    } else {
                        cmd.env(&env_var.name, &env_var.value);
                    }
                }
                if let Some(dir) = &self.current_dir {
                    // The `pushd` detour already owns the cwd for this launch,
                    // and handing the same UNC path to `CreateProcess` is the
                    // very thing cmd.exe would refuse.
                    if pushd_cwd.is_none() {
                        cmd.current_dir(dir);
                    }
                }
                #[cfg(windows)]
                {
                    cmd.creation_flags(CREATE_NO_WINDOW);
                }
                cmd.stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());

                let mut child = cmd.spawn().map_err(agent_client_protocol::Error::into_internal_error)?;

                let child_stdin = child
                    .stdin
                    .take()
                    .ok_or_else(|| agent_client_protocol::util::internal_error("Failed to open stdin"))?;
                let child_stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| agent_client_protocol::util::internal_error("Failed to open stdout"))?;
                let child_stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| agent_client_protocol::util::internal_error("Failed to open stderr"))?;

                Ok((child_stdin, child_stdout, child_stderr, child))
            }
            McpServer::Http(_) => Err(agent_client_protocol::util::internal_error(
                "HTTP transport not yet supported by AcpAgent",
            )),
            McpServer::Sse(_) => Err(agent_client_protocol::util::internal_error(
                "SSE transport not yet supported by AcpAgent",
            )),
            _ => Err(agent_client_protocol::util::internal_error(
                "Unknown MCP server transport type",
            )),
        }
    }
}

/// A wrapper around Child that kills the process when dropped.
struct ChildGuard {
    /// `None` once the child has been handed to the detached reaper in `drop`.
    child: Option<Child>,
    /// Fired exactly once, at the moment the child is *reaped* — see
    /// [`AcpAgent::on_exit`] for why that moment, and only that moment, is the
    /// one worth reporting.
    exit_callback: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
}

impl ChildGuard {
    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let Some(child) = self.child.as_mut() else {
            return Err(std::io::Error::other("child already handed to the reaper"));
        };
        let status = child.wait().await;
        if status.is_ok() {
            // `wait` succeeded, so the child has been reaped and its pid is
            // free for the OS to reassign.
            self.notify_exit();
        }
        status
    }

    fn notify_exit(&mut self) {
        if let Some(callback) = self.exit_callback.take() {
            callback();
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let Some(pid) = child.id() else {
            // Already reaped, so the pid is free — report the exit.
            let _ = child.start_kill();
            self.notify_exit();
            return;
        };

        let _ = kill_tree::blocking::kill_tree(pid);

        // `kill_tree` only signals (SIGTERM on Unix) and does not wait, so the
        // process may well outlive this call. Keep OWNING the child until it is
        // really reaped, and report the exit from there.
        //
        // Simply dropping it here would hand it to Tokio's orphan queue, which
        // reaps it out of sight: the pid would silently become reusable while a
        // host still held it as "this agent", and a later kill could land on an
        // unrelated process tree. Holding the child keeps the pid pinned — a
        // zombie on Unix, an open process handle on Windows — until we ourselves
        // observe the exit and say so.
        let exit_callback = self.exit_callback.take();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    // Same gate as `ChildGuard::wait`: only a successful `wait`
                    // proves the child was reaped. Reporting an exit we failed
                    // to observe would tell the host to stop tracking a pid
                    // whose process may still be running.
                    if child.wait().await.is_ok() {
                        if let Some(callback) = exit_callback {
                            callback();
                        }
                    }
                });
            }
            Err(_) => {
                // Dropped outside a runtime, so there is nothing to reap on.
                // Fall back to the previous behaviour and deliberately stay
                // silent about an exit we cannot observe.
                drop(child);
            }
        }
    }
}

fn append_limited_utf8(output: &mut String, chunk: &str, limit: usize) -> bool {
    output.push_str(chunk);
    if output.len() <= limit {
        return false;
    }

    let mut start = output.len().saturating_sub(limit);
    while start < output.len() && !output.is_char_boundary(start) {
        start += 1;
    }

    output.drain(..start);
    true
}

/// Waits for a child process and returns an error if it exits with non-zero status.
///
/// The error message includes any stderr output collected by the background task.
/// Dropping the returned future drops a [`ChildGuard`], which signals the
/// child's process tree and — given a runtime to reap on — keeps owning the
/// child until it is really gone. Neither half is unconditional: see
/// [`AcpAgent::on_exit`] for why the kill is only a signal, and
/// `ChildGuard::drop` for why a drop outside a runtime stays silent.
///
/// That much has to survive a drop landing *before the first poll*, which is
/// why this is deliberately NOT an `async fn`: an `async fn` body does not run
/// until it is first polled, so the guard below would not exist yet and the
/// captured raw `Child` would be dropped on its own instead. Tokio never kills
/// on that path and reaps the child out of sight (at once if it has already
/// exited, via the orphan queue otherwise), so a live agent survives as an
/// orphan, `exit_callback` never fires, and the host is left publishing a pid
/// the OS may since have reassigned. The test
/// `dropping_an_unpolled_child_monitor_still_reaps_and_reports_exit` is what
/// catches a change back to `async fn`.
///
/// `+ Send` is stated rather than left to auto-trait leakage because
/// `ConnectTo::connect_to` promises a `Send` future and holds this one
/// across an await: without the bound, a non-`Send` capture added here would be
/// reported against that impl rather than against this function.
fn monitor_child(
    child: Child,
    stderr_rx: tokio::sync::oneshot::Receiver<String>,
    exit_callback: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
) -> impl Future<Output = Result<(), agent_client_protocol::Error>> + Send {
    // Construct the guard before returning the future. `connect_to` races this
    // future against the protocol driver; when that driver wins before the
    // child monitor's first poll, dropping the future must still drop a guard
    // that owns the child and starts the detached reap.
    let guard = ChildGuard {
        child: Some(child),
        exit_callback,
    };

    async move {
        let mut guard = guard;

        // Wait for the child to exit
        let status = guard.wait().await.map_err(|e| {
            agent_client_protocol::util::internal_error(format!("Failed to wait for process: {}", e))
        })?;

        if status.success() {
            Ok(())
        } else {
            // Get stderr content if available
            let stderr = stderr_rx.await.unwrap_or_default();

            let message = if stderr.is_empty() {
                format!("Process exited with {}", status)
            } else {
                format!("Process exited with {}: {}", status, stderr)
            };

            Err(agent_client_protocol::util::internal_error(message))
        }
    }
}

/// Roles that an ACP agent executable can potentially serve.
pub trait AcpAgentCounterpartRole: Role {}

impl AcpAgentCounterpartRole for Client {}

impl AcpAgentCounterpartRole for Conductor {}

impl<Counterpart: AcpAgentCounterpartRole> ConnectTo<Counterpart> for AcpAgent {
    async fn connect_to(
        self,
        client: impl ConnectTo<Counterpart::Counterpart>,
    ) -> Result<(), agent_client_protocol::Error> {
        use futures::AsyncBufReadExt;
        use futures::AsyncWriteExt;
        use futures::StreamExt;
        use futures::io::BufReader;

        let (child_stdin, child_stdout, child_stderr, child) = self.spawn_process()?;

        // Publish the OS pid to the spawn callback so the host can kill the
        // process tree deterministically at shutdown rather than relying solely
        // on `ChildGuard::drop` (which never runs if the driving thread is torn
        // down by process exit before the connect future unwinds).
        if let Some(callback) = self.spawn_callback.as_ref() {
            if let Some(pid) = child.id() {
                callback(pid);
            }
        }

        // Create a channel to collect stderr for error reporting
        let (stderr_tx, stderr_rx) = tokio::sync::oneshot::channel::<String>();

        // Spawn a task to read stderr, optionally calling the debug callback
        let debug_callback = self.debug_callback.clone();
        tokio::spawn(async move {
            let stderr_reader = BufReader::new(child_stderr.compat());
            let mut stderr_lines = stderr_reader.lines();
            let mut collected = String::new();
            let mut truncated = false;
            while let Some(line_result) = stderr_lines.next().await {
                if let Ok(line) = line_result {
                    // Call debug callback if present
                    if let Some(ref callback) = debug_callback {
                        callback(&line, LineDirection::Stderr);
                    }
                    // Always collect for error reporting
                    if !collected.is_empty() {
                        truncated |= append_limited_utf8(
                            &mut collected,
                            "\n",
                            MAX_STDERR_CAPTURE_BYTES,
                        );
                    }
                    truncated |=
                        append_limited_utf8(&mut collected, &line, MAX_STDERR_CAPTURE_BYTES);
                }
            }
            if truncated {
                let prefix = "[stderr truncated to last 1 MiB]\n";
                let mut marked = String::with_capacity(prefix.len() + collected.len());
                marked.push_str(prefix);
                marked.push_str(&collected);
                collected = marked;
            }
            let _ = stderr_tx.send(collected);
        });

        // Create a future that monitors the child process for early exit
        let child_monitor = monitor_child(child, stderr_rx, self.exit_callback.clone());

        // Convert stdio to line streams with optional debug inspection
        let incoming_lines = if let Some(callback) = self.debug_callback.clone() {
            Box::pin(
                BufReader::new(child_stdout.compat())
                    .lines()
                    .inspect(move |result| {
                        if let Ok(line) = result {
                            callback(line, LineDirection::Stdout);
                        }
                    }),
            )
                as std::pin::Pin<Box<dyn futures::Stream<Item = std::io::Result<String>> + Send>>
        } else {
            Box::pin(BufReader::new(child_stdout.compat()).lines())
        };

        // Create a sink that writes lines (with newlines) to stdin with optional debug logging
        let outgoing_sink = if let Some(callback) = self.debug_callback.clone() {
            Box::pin(futures::sink::unfold(
                (child_stdin.compat_write(), callback),
                async move |(mut writer, callback), line: String| {
                    callback(&line, LineDirection::Stdin);
                    let mut bytes = line.into_bytes();
                    bytes.push(b'\n');
                    writer.write_all(&bytes).await?;
                    Ok::<_, std::io::Error>((writer, callback))
                },
            ))
                as std::pin::Pin<Box<dyn futures::Sink<String, Error = std::io::Error> + Send>>
        } else {
            Box::pin(futures::sink::unfold(
                child_stdin.compat_write(),
                async move |mut writer, line: String| {
                    let mut bytes = line.into_bytes();
                    bytes.push(b'\n');
                    writer.write_all(&bytes).await?;
                    Ok::<_, std::io::Error>(writer)
                },
            ))
        };

        // Race the protocol against child process exit
        // If the child exits early (e.g., with an error), we return that error
        let protocol_future = ConnectTo::<Counterpart>::connect_to(
            Lines::new(outgoing_sink, incoming_lines),
            client,
        );

        tokio::select! {
            result = protocol_future => result,
            result = child_monitor => result,
        }
    }
}

impl AcpAgent {
    /// Create an `AcpAgent` from an iterator of command-line arguments.
    ///
    /// Leading arguments of the form `NAME=value` are parsed as environment variables.
    /// The first non-env argument is the command, and the rest are arguments.
    ///
    pub fn from_args<I, T>(args: I) -> Result<Self, agent_client_protocol::Error>
    where
        I: IntoIterator<Item = T>,
        T: ToString,
    {
        let args: Vec<String> = args.into_iter().map(|s| s.to_string()).collect();

        if args.is_empty() {
            return Err(agent_client_protocol::util::internal_error("Arguments cannot be empty"));
        }

        let mut env = vec![];
        let mut command_idx = 0;

        // Parse leading FOO=bar arguments as environment variables
        for (i, arg) in args.iter().enumerate() {
            if let Some((name, value)) = parse_env_var(arg) {
                env.push(EnvVariable::new(name, value));
                command_idx = i + 1;
            } else {
                break;
            }
        }

        if command_idx >= args.len() {
            return Err(agent_client_protocol::util::internal_error(
                "No command found (only environment variables provided)",
            ));
        }

        let command = PathBuf::from(&args[command_idx]);
        let cmd_args = args[command_idx + 1..].to_vec();

        // Generate a name from the command
        let name = command
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("agent")
            .to_string();

        Ok(AcpAgent {
            server: McpServer::Stdio(
                McpServerStdio::new(name, command)
                    .args(cmd_args)
                    .env(env),
            ),
            debug_callback: None,
            current_dir: None,
            spawn_callback: None,
            exit_callback: None,
        })
    }
}

/// Parse a string as an environment variable assignment (NAME=value).
/// Returns None if it doesn't match the pattern.
fn parse_env_var(s: &str) -> Option<(String, String)> {
    // Must contain '=' and the part before must be a valid env var name
    let eq_pos = s.find('=')?;
    if eq_pos == 0 {
        return None;
    }

    let name = &s[..eq_pos];
    let value = &s[eq_pos + 1..];

    // Env var names must start with a letter or underscore, and contain only
    // alphanumeric characters and underscores
    let mut chars = name.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() && first != '_' {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }

    Some((name.to_string(), value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_limited_utf8_truncates_ascii() {
        let mut output = String::new();
        let truncated = append_limited_utf8(&mut output, "abcdefghij", 6);
        assert!(truncated);
        assert_eq!(output, "efghij");
    }

    #[test]
    fn test_append_limited_utf8_keeps_char_boundaries() {
        let mut output = String::new();
        let truncated = append_limited_utf8(&mut output, "A中文B", 5);
        assert!(truncated);
        assert_eq!(output, "文B");
    }

    #[test]
    fn with_current_dir_sets_field() {
        let agent = AcpAgent::from_args(["python", "agent.py"])
            .unwrap()
            .with_current_dir("/some/dir");
        // The directory is private; surfaced via Debug so callers can confirm.
        assert!(format!("{agent:?}").contains("/some/dir"));
    }

    /// The exit callback is a promise about ONE thing: the pid has stopped
    /// naming this child and the OS may reassign it. These tests pin the three
    /// moments that promise is (and isn't) true. A host records the pid at spawn
    /// and kills that tree at shutdown, so firing early aims its kill at a
    /// stranger, and firing late leaves an orphan alive.
    ///
    /// Unix-only: they need a process that can refuse a kill signal, which has
    /// no Windows analogue (`TerminateProcess` is unconditional). The ownership
    /// property they cover is platform-neutral though — holding the `Child`
    /// keeps a Windows process handle open, which is exactly what stops the OS
    /// from reusing the pid there.
    #[cfg(unix)]
    fn counting_callback(calls: &Arc<std::sync::atomic::AtomicUsize>) -> Arc<dyn Fn() + Send + Sync>
    {
        let calls = Arc::clone(calls);
        Arc::new(move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
    }

    /// A reaped child means its pid is free for the OS to reassign, so the exit
    /// callback has to fire — a host still holding that pid would aim its
    /// shutdown kill at whatever inherits the number next.
    #[cfg(unix)]
    #[test]
    fn exit_callback_fires_once_the_child_is_reaped() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let child = tokio::process::Command::new("/bin/sh")
                .args(["-c", "exit 0"])
                .spawn()
                .expect("spawn sh");
            let mut guard = ChildGuard {
                child: Some(child),
                exit_callback: Some(counting_callback(&calls)),
            };
            guard.wait().await.expect("wait");
            assert_eq!(
                calls.load(Ordering::SeqCst),
                1,
                "a reaped child must report its exit"
            );
            drop(guard);
        });
        // Exactly once, even though `drop` also runs its own notify path.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// Regression for the select race in `connect_to`: the protocol side may
    /// finish before the child-monitor future receives its first poll. The
    /// monitor must already own a `ChildGuard`, otherwise dropping that
    /// unpolled future bypasses kill/reap and never fires `on_exit`.
    #[cfg(unix)]
    #[test]
    fn dropping_an_unpolled_child_monitor_still_reaps_and_reports_exit() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async {
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "sleep 30"]);
            command.stderr(std::process::Stdio::piped());
            let mut child = command.spawn().expect("spawn sh");
            let stderr = child.stderr.take().expect("stderr");
            let (stderr_tx, stderr_rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut stderr = stderr;
                let mut bytes = Vec::new();
                let _ = stderr.read_to_end(&mut bytes).await;
                let _ = stderr_tx.send(String::from_utf8_lossy(&bytes).into_owned());
            });

            let monitor = monitor_child(child, stderr_rx, Some(counting_callback(&calls)));
            // Deliberately never poll it.
            drop(monitor);

            let mut reported = false;
            for _ in 0..200 {
                if calls.load(Ordering::SeqCst) == 1 {
                    reported = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(reported, "unpolled monitor bypassed the reap callback");
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// Dropping the guard kills the tree but does not wait, so the exit is not
    /// observed yet — and must not be reported yet. It has to be reported once
    /// the child actually dies, which only works because `drop` keeps owning the
    /// child instead of letting Tokio's orphan queue reap it out of sight.
    ///
    /// A current-thread runtime makes the ordering exact: the detached reaper
    /// cannot run during the synchronous assertion right after `drop`.
    #[cfg(unix)]
    #[test]
    fn dropping_the_guard_reports_the_exit_only_once_the_child_is_reaped() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async {
            let child = tokio::process::Command::new("/bin/sh")
                .args(["-c", "sleep 30"])
                .spawn()
                .expect("spawn sh");
            let guard = ChildGuard {
                child: Some(child),
                exit_callback: Some(counting_callback(&calls)),
            };

            drop(guard);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "the kill was only signalled — the exit has not been observed yet"
            );

            let mut reported = false;
            for _ in 0..200 {
                if calls.load(Ordering::SeqCst) > 0 {
                    reported = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(
                reported,
                "the killed child was never reaped — its pid would stay published forever"
            );
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// The case that makes the whole design necessary: a child that ignores the
    /// kill signal is STILL RUNNING after `drop`. Its pid must stay published so
    /// a host's shutdown backstop still sweeps it — reporting an exit here would
    /// disarm that backstop and leave a real orphan behind.
    #[cfg(unix)]
    #[test]
    fn a_child_that_survives_the_kill_keeps_its_pid_published() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        // The shell announces itself only AFTER installing the trap. Killing it
        // before that point would hit the default disposition and the test would
        // "fail" for a reason it isn't testing.
        let ready = std::env::temp_dir().join(format!(
            "codeg-agent-process-trap-ready-{}-{:p}",
            std::process::id(),
            &calls
        ));
        let _ = std::fs::remove_file(&ready);

        rt.block_on(async {
            // Ignores SIGTERM and respawns the `sleep` that `kill_tree` reaches,
            // so the whole tree outlives the guard's kill.
            let child = tokio::process::Command::new("/bin/sh")
                .args([
                    "-c",
                    &format!(
                        "trap '' TERM; echo ready > '{}'; while true; do sleep 1; done",
                        ready.display()
                    ),
                ])
                .spawn()
                .expect("spawn sh");
            let pid = child.id().expect("child has a pid").to_string();
            let guard = ChildGuard {
                child: Some(child),
                exit_callback: Some(counting_callback(&calls)),
            };

            let mut trapped = false;
            for _ in 0..200 {
                if ready.exists() {
                    trapped = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(trapped, "the shell never installed its SIGTERM trap");

            drop(guard);

            // Well past the signal it ignored. `kill -0` probes for existence
            // without sending anything (no `libc` dependency in this crate).
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid])
                .status()
                .expect("run kill -0")
                .success();
            assert!(
                alive,
                "test setup is wrong — the child was supposed to survive SIGTERM"
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "a still-running child must keep its pid published"
            );

            // And once it really dies, the exit is reported — the reaper is
            // armed the whole time, not abandoned.
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid])
                .status();
            let mut reported = false;
            for _ in 0..200 {
                if calls.load(Ordering::SeqCst) > 0 {
                    reported = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(reported, "the reaper never observed the child's death");
        });
        let _ = std::fs::remove_file(&ready);
    }

    #[test]
    fn detects_windows_unc_paths_without_misclassifying_device_or_drive_paths() {
        assert!(is_windows_unc_path(
            r"\\wsl.localhost\Ubuntu\home\user\repo"
        ));
        assert!(is_windows_unc_path(r"\\wsl$\Ubuntu\home\user\repo"));
        assert!(is_windows_unc_path(r"\\?\UNC\server\share\repo"));
        assert!(!is_windows_unc_path(r"C:\Users\user\repo"));
        assert!(!is_windows_unc_path(r"\\?\C:\Users\user\repo"));
        assert!(!is_windows_unc_path(r"\\.\pipe\codeg"));
    }

    #[test]
    fn detects_batch_launchers_case_insensitively() {
        assert!(is_windows_batch_file(std::path::Path::new("hermes.CmD")));
        assert!(is_windows_batch_file(std::path::Path::new("agent.BAT")));
        assert!(!is_windows_batch_file(std::path::Path::new("agent.exe")));
        assert!(!is_windows_batch_file(std::path::Path::new("hermes")));
    }

    /// The detour is a rescue for exactly one combination. Widening it would
    /// put a cmd.exe in front of agents that do not need one; narrowing it
    /// puts the agent back in `C:\Windows`.
    #[test]
    fn pushd_is_reserved_for_a_unc_workspace_behind_a_batch_launcher() {
        use std::path::Path;

        let batch = Path::new(r"C:\npm\hermes.cmd");
        let unc = Path::new(r"\\wsl.localhost\Ubuntu\home\user\repo");

        assert_eq!(
            windows_pushd_cwd(Some(unc), batch).as_deref(),
            Some(r"\\wsl.localhost\Ubuntu\home\user\repo")
        );
        // A native executable takes a UNC cwd fine — no cmd.exe involved.
        assert_eq!(
            windows_pushd_cwd(Some(unc), Path::new(r"C:\npm\uvx.exe")),
            None
        );
        assert_eq!(
            windows_pushd_cwd(Some(Path::new(r"C:\Users\user\repo")), batch),
            None
        );
        assert_eq!(windows_pushd_cwd(None, batch), None);
    }

    /// Rust resolves a bare program name against PATH and never against the
    /// child's cwd. cmd.exe searches the current directory FIRST — which
    /// `pushd` has just pointed at the workspace — so handing it a relative
    /// launcher would let a `hermes.cmd` committed to the repo run instead of
    /// the trusted one on PATH. Those launches keep the direct spawn.
    #[test]
    fn a_relative_launcher_never_takes_the_detour() {
        use std::path::Path;

        let unc = Path::new(r"\\wsl.localhost\Ubuntu\home\user\repo");
        for relative in [
            "hermes.cmd",
            r".\hermes.cmd",
            r"node_modules\.bin\hermes.cmd",
            // Root-relative and drive-relative both resolve against the drive
            // and directory `pushd` just changed.
            r"\hermes.cmd",
            "C:hermes.cmd",
        ] {
            assert_eq!(
                windows_pushd_cwd(Some(unc), Path::new(relative)),
                None,
                "{relative} would be resolved out of the workspace"
            );
        }
        for absolute in [
            r"C:\npm\hermes.cmd",
            r"c:/npm/hermes.cmd",
            r"\\tools\share\hermes.cmd",
        ] {
            assert!(
                windows_pushd_cwd(Some(unc), Path::new(absolute)).is_some(),
                "{absolute} needs the detour"
            );
        }
    }

    /// `pushd` is a cmd built-in, so cmd parses this argument itself: the two
    /// spellings it cannot resolve have to be gone before it ever sees them,
    /// or `&&` takes the whole agent launch down with the failed `pushd`.
    #[test]
    fn pushd_cwd_is_spelled_the_only_way_cmd_can_resolve_it() {
        use std::path::Path;

        let batch = Path::new(r"C:\npm\hermes.cmd");
        // The extended-length form is what `fs::canonicalize` hands back on
        // Windows, and cmd.exe supports none of it.
        for verbatim in [
            r"\\?\UNC\wsl.localhost\Ubuntu\home\user\repo",
            r"\\?\unc\wsl.localhost\Ubuntu\home\user\repo",
        ] {
            assert_eq!(
                windows_pushd_cwd(Some(Path::new(verbatim)), batch).as_deref(),
                Some(r"\\wsl.localhost\Ubuntu\home\user\repo")
            );
        }
        // A trailing separator comes out of `append_windows_batch_arg` as a
        // doubled backslash — correct for an argument a batch file re-parses,
        // but cmd never unescapes its own command line, so `pushd` would
        // receive the pair verbatim and reject the path.
        assert_eq!(
            windows_pushd_cwd(Some(Path::new(r"\\srv\share\repo\")), batch).as_deref(),
            Some(r"\\srv\share\repo")
        );
        assert_eq!(
            windows_pushd_cwd(Some(Path::new(r"\\srv\share\repo/")), batch).as_deref(),
            Some(r"\\srv\share\repo")
        );
    }

    #[test]
    fn unc_batch_command_uses_pushd_and_escapes_cmd_metacharacters() {
        let command = make_unc_batch_command_line(
            r"\\wsl.localhost\Ubuntu\home\a&b\repo",
            std::path::Path::new(r"C:\Program Files\nodejs\hermes.cmd"),
            &["acp".into(), "100% ready".into(), "x&whoami".into()],
        )
        .expect("valid command line");

        assert_eq!(
            command,
            r#"/e:ON /v:OFF /d /s /c "pushd "\\wsl.localhost\Ubuntu\home\a&b\repo" && "C:\Program Files\nodejs\hermes.cmd" acp "100%%cd:~,% ready" "x&whoami"""#
        );
    }

    #[test]
    fn unc_batch_command_rejects_line_breaks() {
        assert!(make_unc_batch_command_line(
            r"\\wsl.localhost\Ubuntu\home\user\repo",
            std::path::Path::new("hermes.cmd"),
            &["line\nbreak".into()],
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn spawn_process_honors_current_dir() {
        use tokio::io::AsyncReadExt;
        // A real, canonical directory distinct from the test process's own cwd.
        let dir = std::env::temp_dir()
            .canonicalize()
            .expect("temp dir canonicalizes");
        let agent = AcpAgent::from_args(["/bin/sh", "-c", "pwd -P"])
            .unwrap()
            .with_current_dir(&dir);
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let out = rt.block_on(async {
            let (_stdin, mut stdout, _stderr, mut child) =
                agent.spawn_process().expect("spawn");
            let mut out = String::new();
            stdout.read_to_string(&mut out).await.expect("read stdout");
            let _ = child.wait().await;
            out
        });
        // The child ran `pwd -P` from `dir`, so it must print exactly `dir`.
        assert_eq!(out.trim(), dir.to_string_lossy());
    }
}
