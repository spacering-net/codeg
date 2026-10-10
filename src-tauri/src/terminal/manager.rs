use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use super::error::TerminalError;
#[cfg(target_os = "windows")]
use super::shell_flavor::ShellFamily;
use super::types::{TerminalEvent, TerminalInfo, TerminalSnapshot};
use crate::browser::service_url::ServiceScanner;
use crate::browser::services::ServiceWatch;
use crate::browser::types::ServiceSource;
use crate::web::event_bridge::EventEmitter;

/// How much recent PTY output a terminal keeps for re-attaching viewers. Sized
/// to cover a screenful of `ls -R` or a compile log, not a whole session: this
/// is a "pick the pane back up where you left it" buffer, not a transcript.
const SCROLLBACK_MAX_CHARS: usize = 128 * 1024;
/// How long a close of a terminal not yet launched is remembered, so its
/// launch is refused when it lands. Marks only ever name random ids, which
/// are never reused, so keeping one too long refuses nothing it should not;
/// letting one go too soon lets a closed tab's command run after all. This
/// outlasts any request a page can still have on its way here.
const CANCELLED_SPAWN_TTL: Duration = Duration::from_secs(10 * 60);

/// Recent output of one terminal, kept so a viewer that mounts after the spawn
/// (or re-mounts after its host view was unmounted — a canvas terminal card
/// crossing a route switch) can redraw instead of showing a blank pane while
/// the shell sits there waiting at a prompt it already printed.
///
/// Whole chunks are evicted from the front rather than characters: the buffer
/// holds raw terminal bytes, and slicing one at an arbitrary offset would cut
/// an escape sequence in half and paint the replay with whatever the truncated
/// tail happens to mean.
#[derive(Default)]
struct Scrollback {
    chunks: VecDeque<String>,
    chars: usize,
    /// Chunks appended since the terminal spawned — the monotonic cursor the
    /// output events carry. Never reset, so it stays comparable across a
    /// re-attach.
    seq: u64,
}

impl Scrollback {
    /// Record a chunk and return the seq it was assigned (= the seq an event
    /// carrying this chunk must report).
    fn append(&mut self, data: &str) -> u64 {
        self.seq += 1;
        self.chars += data.chars().count();
        self.chunks.push_back(data.to_string());
        while self.chars > SCROLLBACK_MAX_CHARS && self.chunks.len() > 1 {
            if let Some(old) = self.chunks.pop_front() {
                self.chars = self.chars.saturating_sub(old.chars().count());
            }
        }
        self.seq
    }

    fn read(&self) -> (String, u64) {
        (self.chunks.iter().cloned().collect(), self.seq)
    }
}

struct TerminalInstance {
    write_tx: mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    _child: Box<dyn portable_pty::Child + Send>,
    title: String,
    owner_window_label: String,
    generation: String,
    /// Shared with this terminal's reader thread — the thread appends, viewers
    /// read. Held behind its own lock rather than the map's so a chunk of
    /// output never waits on a write / resize / list call.
    scrollback: Arc<Mutex<Scrollback>>,
    /// Temp files (credential store + helper script) to clean up on exit.
    temp_files: Vec<std::path::PathBuf>,
}

pub struct TerminalManager {
    terminals: Arc<Mutex<HashMap<String, TerminalInstance>>>,
    completed: Arc<Mutex<CompletedTerminals>>,
    cancelled_spawns: Arc<Mutex<HashMap<String, Instant>>>,
    spawning: Arc<Mutex<HashMap<String, String>>>,
}

/// Kept through the whole spawn call, including its fallible setup steps.
/// A second request with the same id must never start a second OS child.
struct SpawnReservation {
    id: String,
    spawning: Arc<Mutex<HashMap<String, String>>>,
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        self.spawning
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
    }
}

/// A terminal whose process has ended (or is being ended by
/// [`TerminalManager::stop`]), kept so its pane can still be drawn: by a
/// reloaded panel tab, a remounted canvas card, or a viewer that reconnects.
struct CompletedTerminal {
    scrollback: Arc<Mutex<Scrollback>>,
    owner_window_label: String,
    generation: String,
    /// `None` once whoever is ending the process has taken it to reap.
    child: Option<Box<dyn portable_pty::Child + Send>>,
    exit_code: Option<u32>,
    /// The PTY's size when it ended: the geometry its output was drawn for.
    size: Option<PtySize>,
}

impl CompletedTerminal {
    /// The record of `instance`, plus what the record does not keep: its
    /// child, which the caller keeps with the record or ends itself, and its
    /// input. Dropping the input sends the PTY a newline and end-of-input (see
    /// portable-pty's writer), so the caller decides when that happens.
    fn from_instance(
        mut instance: TerminalInstance,
        exit_code: Option<u32>,
    ) -> (
        Self,
        Box<dyn portable_pty::Child + Send>,
        mpsc::Sender<Vec<u8>>,
    ) {
        cleanup_temp_files(&mut instance.temp_files);
        let entry = Self {
            size: instance.master.get_size().ok(),
            scrollback: instance.scrollback,
            owner_window_label: instance.owner_window_label,
            generation: instance.generation,
            child: None,
            exit_code,
        };
        (entry, instance._child, instance.write_tx)
    }
}

/// Ended terminals, each kept for as long as something may still show it —
/// not for a fixed time or up to a fixed count. A record goes when its
/// terminal is closed ([`TerminalManager::kill`]), when a new process takes
/// its id, or when its window's terminals are reclaimed. The output of a
/// command that finished while its page was away is what a reload is for.
#[derive(Default)]
struct CompletedTerminals {
    entries: HashMap<String, CompletedTerminal>,
}

impl CompletedTerminals {
    /// Record a terminal whose process has ended, or may have: its child
    /// stays with the record, to be reaped once it exits.
    fn insert(&mut self, id: String, instance: TerminalInstance, exit_code: Option<u32>) {
        let (mut entry, child, _input) = CompletedTerminal::from_instance(instance, exit_code);
        entry.child = Some(child);
        self.remove(&id);
        self.entries.insert(id, entry);
    }

    /// Record a terminal the caller is about to end, handing back its child
    /// and its input: the kill and the wait happen outside this table's
    /// lock, and the input is to be dropped only once the process is gone.
    fn insert_ending(
        &mut self,
        id: String,
        instance: TerminalInstance,
    ) -> (Box<dyn portable_pty::Child + Send>, mpsc::Sender<Vec<u8>>) {
        let (entry, child, input) = CompletedTerminal::from_instance(instance, None);
        self.remove(&id);
        self.entries.insert(id, entry);
        (child, input)
    }

    fn remove(&mut self, id: &str) -> bool {
        let Some(mut entry) = self.entries.remove(id) else {
            return false;
        };
        if let (None, Some(child)) = (entry.exit_code, entry.child.as_mut()) {
            // Reap it if it has exited since, so it leaves no zombie, but
            // never kill it. Reader EOF does not prove the process ended:
            // a child can close its terminal and keep running, and such a
            // process was always left alone once its PTY closed. Dropping
            // a cache entry must not be what ends it — and a kill + wait
            // here would stall every caller holding the terminal table.
            let _ = child.try_wait();
        }
        true
    }
}

fn lock_completed(
    completed: &Mutex<CompletedTerminals>,
) -> std::sync::MutexGuard<'_, CompletedTerminals> {
    completed.lock().unwrap_or_else(|p| p.into_inner())
}

/// Lock the terminal table, ignoring the poison flag.
///
/// Every reader and writer of this map goes through here, so the policy is one
/// decision rather than a per-call-site one.
///
/// The flag guards nothing here. A `HashMap<String, TerminalInstance>` cannot be
/// observed half-updated: a panic between two of its mutations leaves entries
/// that are each individually whole, and the callers below all re-read the map
/// rather than caching a view of it. What the flag WOULD do is convert an
/// unrelated earlier panic — one tokio swallowed, in a task that touched a
/// terminal — into a permanent failure of every later terminal operation.
///
/// Two of those operations make that fatal rather than merely broken.
/// [`TerminalManager::kill_by_owner_window`] runs inside Tauri's
/// `on_window_event` and [`TerminalManager::kill_all`] inside the quit's
/// `RunEvent::ExitRequested` or `RunEvent::Exit`: both on the main thread,
/// inside the platform event loop, where a panic unwinds across an
/// `extern "system"` boundary and Rust turns that into an immediate `abort`
/// (Windows reports it as `0xc0000409`). So a poisoned mutex would take the
/// whole process down at the next window close. The reader thread's own
/// removal is the mirror case — it would leak the entry and its temp files for
/// the rest of the process.
///
/// Matches the form already used in `office_watch` and `background_watch`.
fn lock_terminals(
    terminals: &Mutex<HashMap<String, TerminalInstance>>,
) -> std::sync::MutexGuard<'_, HashMap<String, TerminalInstance>> {
    terminals.lock().unwrap_or_else(|p| p.into_inner())
}

pub(crate) fn resolve_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            let trimmed = shell.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Ok(comspec) = std::env::var("COMSPEC") {
            let trimmed = comspec.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        "cmd.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            let trimmed = shell.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        // Try common shells in order of preference
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        "/bin/sh".to_string()
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
enum WindowsShellFlavor {
    Cmd,
    PowerShell,
    Posix,
}

#[cfg(target_os = "windows")]
fn detect_windows_shell_flavor(shell: &str) -> WindowsShellFlavor {
    // Shares one classifier with the ACP terminal runtime so the two can't
    // drift on what `COMSPEC` means — see `terminal::shell_flavor`.
    match crate::terminal::shell_flavor::classify_shell_family(shell) {
        ShellFamily::PowerShell => WindowsShellFlavor::PowerShell,
        ShellFamily::Posix => WindowsShellFlavor::Posix,
        ShellFamily::Cmd => WindowsShellFlavor::Cmd,
    }
}

/// POSIX-side shell flavor. We only inject the `-l -i` login/interactive
/// flags and the `eval "$CODEG_CMD"` wrapping for shells we know speak that
/// dialect — passing those to nu / xonsh / elvish / pwsh would cause spawn
/// failures or weird behavior. Unknown shells get raw spawn (no flags) and,
/// when an `initial_command` is requested, a plain `-c <command>` (the
/// closest thing to a universal "run this and exit" convention).
#[cfg(not(target_os = "windows"))]
#[derive(Debug, Clone, Copy)]
enum PosixShellFlavor {
    /// bash / zsh / sh / dash / ksh / ash / mksh / busybox / fish — accept
    /// `-l -i` and the `eval "$VAR"` pattern.
    BashLike,
    /// Anything else. Don't assume POSIX flag conventions.
    Unknown,
}

#[cfg(not(target_os = "windows"))]
fn detect_posix_shell_flavor(shell: &str) -> PosixShellFlavor {
    let name = crate::terminal::shell_flavor::shell_basename(shell);

    if matches!(
        name.as_str(),
        "bash" | "zsh" | "sh" | "dash" | "ksh" | "ash" | "mksh" | "busybox" | "fish"
    ) {
        PosixShellFlavor::BashLike
    } else {
        PosixShellFlavor::Unknown
    }
}

fn configure_shell_command(cmd: &mut CommandBuilder, shell: &str, initial_command: Option<&str>) {
    #[cfg(target_os = "windows")]
    {
        // Force UTF-8 output for all Windows shell flavors
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");

        match detect_windows_shell_flavor(shell) {
            WindowsShellFlavor::Cmd => {
                if let Some(command) = initial_command {
                    cmd.env("CODEG_CMD", command);
                    // Set UTF-8 code page before running the actual command
                    cmd.args(["/D", "/S", "/C", "chcp 65001 >nul & %CODEG_CMD%"]);
                } else {
                    // /K runs the command then stays open for interactive use
                    cmd.args(["/D", "/S", "/K", "chcp 65001 >nul"]);
                }
            }
            WindowsShellFlavor::PowerShell => {
                if let Some(command) = initial_command {
                    cmd.env("CODEG_CMD", command);
                    cmd.args([
                        "-NoLogo",
                        "-NoProfile",
                        "-Command",
                        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; Invoke-Expression $env:CODEG_CMD",
                    ]);
                } else {
                    // -NoExit runs the command then stays open for interactive use
                    cmd.args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NoExit",
                        "-Command",
                        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $host.UI.RawUI.WindowTitle = 'codeg'",
                    ]);
                }
            }
            WindowsShellFlavor::Posix => {
                cmd.env("TERM", "xterm-256color");
                cmd.env("COLORTERM", "truecolor");
                cmd.env("TERM_PROGRAM", "codeg");
                cmd.env("LANG", "C.UTF-8");
                if let Some(command) = initial_command {
                    cmd.env("CODEG_CMD", command);
                    cmd.args(["-l", "-i", "-c", "eval \"$CODEG_CMD\""]);
                } else {
                    cmd.args(["-l", "-i"]);
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // GUI app environments often miss TERM; force a sane terminal type so
        // readline/zle can redraw lines correctly (history navigation, etc.).
        // Locale env (LANG/LC_ALL) is intentionally NOT injected — interactive
        // PTYs should respect whatever the user's shell rc files set up.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "codeg");

        match detect_posix_shell_flavor(shell) {
            PosixShellFlavor::BashLike => {
                if let Some(command) = initial_command {
                    // Indirection via env var avoids quoting/escaping bugs
                    // for arbitrary commands (and keeps long commands off
                    // argv for readability in `ps`).
                    cmd.env("CODEG_CMD", command);
                    cmd.args(["-l", "-i", "-c", "eval \"$CODEG_CMD\""]);
                } else {
                    cmd.args(["-l", "-i"]);
                }
            }
            PosixShellFlavor::Unknown => {
                // No-flag spawn for nu/xonsh/elvish/pwsh on Linux/etc. Most
                // modern shells default to interactive when stdin is a TTY,
                // so we get a usable session without guessing flag syntax.
                if let Some(command) = initial_command {
                    cmd.args(["-c", command]);
                }
            }
        }
    }
}

/// Options for spawning a new terminal session.
pub struct SpawnOptions {
    pub terminal_id: String,
    pub working_dir: String,
    pub owner_window_label: String,
    pub shell: Option<String>,
    pub initial_command: Option<String>,
    pub extra_env: Option<HashMap<String, String>>,
    pub temp_files: Vec<std::path::PathBuf>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(HashMap::new())),
            completed: Arc::new(Mutex::new(CompletedTerminals::default())),
            cancelled_spawns: Arc::new(Mutex::new(HashMap::new())),
            spawning: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Returns a shallow clone sharing the same underlying terminal map.
    pub fn clone_ref(&self) -> Self {
        Self {
            terminals: self.terminals.clone(),
            completed: self.completed.clone(),
            cancelled_spawns: self.cancelled_spawns.clone(),
            spawning: self.spawning.clone(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn_with_id(
        &self,
        opts: SpawnOptions,
        emitter: EventEmitter,
    ) -> Result<String, TerminalError> {
        // Reserve the ID before any fallible OS work. The guard releases it
        // on every error path, and insertion happens before the guard drops.
        let _reservation = {
            let terminals = lock_terminals(&self.terminals);
            let mut spawning = self.spawning.lock().unwrap_or_else(|p| p.into_inner());
            if terminals.contains_key(&opts.terminal_id) || spawning.contains_key(&opts.terminal_id)
            {
                return Err(TerminalError::SpawnFailed(format!(
                    "terminal id '{}' already exists",
                    opts.terminal_id
                )));
            }
            // Usually an explicit tab close is followed by a still-pending
            // spawn request. Reject before starting the child when possible.
            let mut pending = self
                .cancelled_spawns
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if pending.remove(&opts.terminal_id).is_some() {
                return Err(TerminalError::SpawnFailed(
                    "terminal launch was cancelled".to_string(),
                ));
            }
            spawning.insert(opts.terminal_id.clone(), opts.owner_window_label.clone());
            SpawnReservation {
                id: opts.terminal_id.clone(),
                spawning: self.spawning.clone(),
            }
        };

        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let shell = opts
            .shell
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(resolve_shell);
        let mut cmd = CommandBuilder::new(&shell);
        configure_shell_command(&mut cmd, &shell, opts.initial_command.as_deref());
        cmd.cwd(&opts.working_dir);

        // Inject extra environment variables (e.g. git credential helper config)
        if let Some(env) = &opts.extra_env {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let terminal_id = opts.terminal_id;
        let generation = uuid::Uuid::new_v4().to_string();
        // Boundary-, length-, and NUL-safe prefix for the PTY thread names; see
        // `thread_name_prefix`. `terminal_id` is caller-supplied.
        let short_id = thread_name_prefix(&terminal_id);

        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>();
        let scrollback = Arc::new(Mutex::new(Scrollback::default()));

        let owner_window = opts.owner_window_label.clone();
        let instance = TerminalInstance {
            write_tx,
            master: pair.master,
            _child: child,
            title: "Terminal".to_string(),
            owner_window_label: opts.owner_window_label,
            generation: generation.clone(),
            scrollback: scrollback.clone(),
            temp_files: opts.temp_files,
        };

        {
            // A completed terminal may be explicitly restarted by another
            // feature (canvas cards). Its old scrollback must not mask the new PTY.
            let mut terminals = lock_terminals(&self.terminals);
            let cancelled = {
                let mut pending = self
                    .cancelled_spawns
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                pending.remove(&terminal_id).is_some()
            };
            if cancelled {
                drop(terminals);
                let mut instance = instance;
                terminate_terminal(&mut instance);
                return Err(TerminalError::SpawnFailed(
                    "terminal launch was cancelled".to_string(),
                ));
            }
            lock_completed(&self.completed).remove(&terminal_id);
            terminals.insert(terminal_id.clone(), instance);
        }

        // Named writer thread
        std::thread::Builder::new()
            .name(format!("pty-writer-{short_id}"))
            .spawn(move || {
                write_loop(writer, write_rx);
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        // Named reader thread — emits per-terminal events
        let id_for_reader = terminal_id.clone();
        let terminals_ref = self.terminals.clone();
        let completed_ref = self.completed.clone();
        // The watch that notices a dev server announcing itself in this
        // terminal's output. Built here because this is where the owning
        // window is known; it probes and emits on threads of its own, so the
        // reader below never waits on a socket.
        let watch = ServiceWatch::new(emitter.clone(), owner_window, ServiceSource::Terminal);
        std::thread::Builder::new()
            .name(format!("pty-reader-{short_id}"))
            .spawn(move || {
                read_loop(
                    reader,
                    id_for_reader,
                    generation,
                    &emitter,
                    &terminals_ref,
                    &completed_ref,
                    &scrollback,
                    &watch,
                );
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        Ok(terminal_id)
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let terminals = lock_terminals(&self.terminals);
        let instance = terminals
            .get(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        instance
            .write_tx
            .send(data.to_vec())
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))?;
        Ok(())
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let terminals = lock_terminals(&self.terminals);
        let instance = terminals
            .get(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_string()))?;
        instance
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::ResizeFailed(e.to_string()))?;
        Ok(())
    }

    /// Recent output of a live or recently completed PTY, for a viewer that
    /// mounts after it spawned or reconnects after losing events.
    ///
    /// Never an error: an unknown id returns `exists: false`. A canvas card
    /// may spawn then, while a restored panel tab must never replay its old
    /// command. Note
    /// the map lock is taken only to find the instance — the buffer has its own,
    /// so a large scrollback is never copied while output is blocked.
    pub fn snapshot(&self, terminal_id: &str) -> TerminalSnapshot {
        // The active→completed transfer happens under the active map lock, so
        // a snapshot never mistakes an exiting PTY for a missing one.
        let (buffer, alive, exit_code, generation, size) = {
            let terminals = lock_terminals(&self.terminals);
            if let Some(instance) = terminals.get(terminal_id) {
                (
                    Some(instance.scrollback.clone()),
                    true,
                    None,
                    Some(instance.generation.clone()),
                    instance.master.get_size().ok(),
                )
            } else {
                let mut completed = lock_completed(&self.completed);
                match completed.entries.get_mut(terminal_id) {
                    Some(entry) => {
                        if let (None, Some(child)) = (entry.exit_code, entry.child.as_mut()) {
                            entry.exit_code = child
                                .try_wait()
                                .ok()
                                .flatten()
                                .map(|status| status.exit_code());
                        }
                        (
                            Some(entry.scrollback.clone()),
                            false,
                            entry.exit_code,
                            Some(entry.generation.clone()),
                            entry.size,
                        )
                    }
                    None => (None, false, None, None, None),
                }
            }
        };
        let Some(buffer) = buffer else {
            return TerminalSnapshot {
                exists: false,
                alive: false,
                data: String::new(),
                seq: 0,
                exit_code: None,
                generation: None,
                cols: None,
                rows: None,
            };
        };
        let (data, seq) = buffer
            .lock()
            .map(|s| s.read())
            .unwrap_or_else(|_| (String::new(), 0));
        TerminalSnapshot {
            exists: true,
            alive,
            data,
            seq,
            exit_code,
            generation,
            cols: size.map(|size| size.cols),
            rows: size.map(|size| size.rows),
        }
    }

    /// Close a terminal: end its process and forget it, final output included.
    pub fn kill(&self, terminal_id: &str) -> Result<(), TerminalError> {
        self.end(terminal_id, false)
    }

    /// End a terminal's process but keep its record, as if it had exited on
    /// its own: the final output stays there for any viewer — a reloaded tab
    /// included — until the terminal is closed with [`Self::kill`].
    pub fn stop(&self, terminal_id: &str) -> Result<(), TerminalError> {
        self.end(terminal_id, true)
    }

    fn end(&self, terminal_id: &str, keep_record: bool) -> Result<(), TerminalError> {
        let mut terminals = lock_terminals(&self.terminals);
        if let Some(mut instance) = terminals.remove(terminal_id) {
            if keep_record {
                // Recorded before the table lock is released, so no snapshot
                // finds this id in neither table while the process dies.
                let (mut child, input) = lock_completed(&self.completed)
                    .insert_ending(terminal_id.to_string(), instance);
                drop(terminals);
                let _ = child.kill();
                let _ = child.wait();
                // Only now: closed earlier, the input hands a live program an
                // Enter and an end-of-input before it dies (a prompt would
                // take its default), and the echoed "^D" ends up in the
                // output kept for the tab.
                drop(input);
            } else {
                lock_completed(&self.completed).remove(terminal_id);
                drop(terminals);
                terminate_terminal(&mut instance);
            }
            return Ok(());
        }
        {
            let mut completed = lock_completed(&self.completed);
            if completed.entries.contains_key(terminal_id) {
                // It has ended already. A stop leaves that as it is; a close
                // forgets it.
                if !keep_record {
                    completed.remove(terminal_id);
                }
                return Ok(());
            }
        }
        // A close (or stop) can overtake an in-flight spawn request, or arrive
        // just before it. Remember only random terminal IDs, for
        // `CANCELLED_SPAWN_TTL`; no other close can push the mark out early.
        // The later insert consumes it atomically under the terminal map
        // lock; ordinary view unmount never calls kill.
        if uuid::Uuid::parse_str(terminal_id).is_ok() {
            let spawning = self.spawning.lock().unwrap_or_else(|p| p.into_inner());
            let mut pending = self
                .cancelled_spawns
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let now = Instant::now();
            // A mark whose launch is already underway is kept regardless of
            // age: that launch checks it again just before it inserts.
            pending.retain(|id, time| {
                spawning.contains_key(id) || now.duration_since(*time) < CANCELLED_SPAWN_TTL
            });
            pending.insert(terminal_id.to_string(), now);
            return Ok(());
        }
        Err(TerminalError::NotFound(terminal_id.to_string()))
    }

    /// THE liveness gate. Drops terminals whose child has exited and returns
    /// their ids so the caller can announce them.
    ///
    /// Every "is this terminal still running" question routes through here.
    /// A second copy of the `try_wait` logic is how a close confirmation ends
    /// up claiming three terminals will die while the kill that follows
    /// reports two.
    ///
    /// Reaped instances get their temp files removed. Dropping a
    /// `TerminalInstance` releases the PTY but not the credential store and
    /// helper script on disk — only [`terminate_terminal`] did that, and it is
    /// not on this path.
    fn reap_exited(
        terminals: &mut HashMap<String, TerminalInstance>,
        completed: &Mutex<CompletedTerminals>,
    ) -> Vec<(String, String)> {
        let mut exited_terminal_ids: Vec<(String, String, Option<u32>)> = Vec::new();

        // Windows ConPTY may not always surface EOF promptly; reconcile exited
        // child processes here so frontend running-state can recover reliably.
        for (id, instance) in terminals.iter_mut() {
            match instance._child.try_wait() {
                Ok(Some(status)) => exited_terminal_ids.push((
                    id.clone(),
                    instance.generation.clone(),
                    Some(status.exit_code()),
                )),
                Ok(None) => {}
                Err(err) => {
                    tracing::error!(
                        "[TERM] failed to query child status for terminal {}: {}",
                        id,
                        err
                    );
                    exited_terminal_ids.push((id.clone(), instance.generation.clone(), None));
                }
            }
        }

        for (terminal_id, _, exit_code) in &exited_terminal_ids {
            if let Some(instance) = terminals.remove(terminal_id) {
                lock_completed(completed).insert(terminal_id.clone(), instance, *exit_code);
            }
        }

        exited_terminal_ids
            .into_iter()
            .map(|(id, generation, _)| (id, generation))
            .collect()
    }

    pub fn list_with_exit_check(&self, emitter: Option<&EventEmitter>) -> Vec<TerminalInfo> {
        let mut terminals = lock_terminals(&self.terminals);
        let exited_terminal_ids = Self::reap_exited(&mut terminals, &self.completed);

        let infos = terminals
            .iter()
            .map(|(id, inst)| TerminalInfo {
                id: id.clone(),
                title: inst.title.clone(),
            })
            .collect();

        drop(terminals);

        if let Some(emitter) = emitter {
            for (terminal_id, generation) in exited_terminal_ids {
                emit_terminal_exit_event(emitter, &terminal_id, &generation);
            }
        }

        infos
    }

    /// How many of `owner_window_label`'s terminals are still running.
    ///
    /// Shares [`Self::reap_exited`] with `list_with_exit_check` so a finished
    /// build is never counted as work in progress — the close confirmation
    /// this feeds is ignored the moment it cries wolf.
    pub fn count_live_by_owner_window(
        &self,
        owner_window_label: &str,
        emitter: Option<&EventEmitter>,
    ) -> usize {
        let mut terminals = lock_terminals(&self.terminals);
        let exited_terminal_ids = Self::reap_exited(&mut terminals, &self.completed);

        let live = terminals
            .values()
            .filter(|instance| instance.owner_window_label == owner_window_label)
            .count();

        drop(terminals);

        if let Some(emitter) = emitter {
            for (terminal_id, generation) in exited_terminal_ids {
                emit_terminal_exit_event(emitter, &terminal_id, &generation);
            }
        }

        live
    }

    pub fn kill_by_owner_window(&self, owner_window_label: &str) -> usize {
        let mut instances = {
            let mut terminals = lock_terminals(&self.terminals);
            let ids: Vec<String> = terminals
                .iter()
                .filter_map(|(id, instance)| {
                    if instance.owner_window_label == owner_window_label {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();

            let spawning = self.spawning.lock().unwrap_or_else(|p| p.into_inner());
            let mut pending = self
                .cancelled_spawns
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            for (id, owner) in spawning.iter() {
                // A launch still holds its reservation for a moment after its
                // terminal is in the table. That one is ended below; a mark
                // for it would only linger and refuse the id's next launch.
                if owner == owner_window_label && !terminals.contains_key(id) {
                    pending.insert(id.clone(), Instant::now());
                }
            }
            let mut removed = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(instance) = terminals.remove(&id) {
                    removed.push(instance);
                }
            }
            removed
        };

        let killed = instances.len();
        {
            let mut completed = lock_completed(&self.completed);
            let ids: Vec<_> = completed
                .entries
                .iter()
                .filter(|(_, item)| item.owner_window_label == owner_window_label)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                completed.remove(&id);
            }
        }
        for instance in &mut instances {
            terminate_terminal(instance);
        }
        killed
    }

    /// Poison-tolerant for the reason given on [`Self::kill_by_owner_window`]:
    /// the quit path runs inside `RunEvent::ExitRequested` or `RunEvent::Exit`,
    /// on the main thread.
    pub fn kill_all(&self) -> usize {
        let mut instances: Vec<TerminalInstance> = {
            let mut terminals = lock_terminals(&self.terminals);
            let spawning = self.spawning.lock().unwrap_or_else(|p| p.into_inner());
            let mut pending = self
                .cancelled_spawns
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            for id in spawning.keys() {
                // As in `kill_by_owner_window`: only launches not yet in the table.
                if !terminals.contains_key(id) {
                    pending.insert(id.clone(), Instant::now());
                }
            }
            terminals.drain().map(|(_, inst)| inst).collect()
        };
        let killed = instances.len();
        {
            let mut completed = lock_completed(&self.completed);
            let ids: Vec<_> = completed.entries.keys().cloned().collect();
            for id in ids {
                completed.remove(&id);
            }
        }
        for instance in &mut instances {
            terminate_terminal(instance);
        }
        tracing::info!("[TERM] kill_all killed_terminals={}", killed);
        killed
    }
}

fn terminate_terminal(instance: &mut TerminalInstance) {
    let _ = instance._child.kill();
    let _ = instance._child.wait();
    cleanup_temp_files(&mut instance.temp_files);
}

fn cleanup_temp_files(files: &mut Vec<std::path::PathBuf>) {
    for path in files.drain(..) {
        let _ = std::fs::remove_file(&path);
    }
}

fn write_loop(mut writer: Box<dyn Write + Send>, rx: mpsc::Receiver<Vec<u8>>) {
    while let Ok(data) = rx.recv() {
        if writer.write_all(&data).is_err() {
            break;
        }
        while let Ok(more) = rx.try_recv() {
            if writer.write_all(&more).is_err() {
                return;
            }
        }
        if writer.flush().is_err() {
            break;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn read_loop(
    mut reader: Box<dyn Read + Send>,
    terminal_id: String,
    generation: String,
    emitter: &EventEmitter,
    terminals: &Arc<Mutex<HashMap<String, TerminalInstance>>>,
    completed: &Arc<Mutex<CompletedTerminals>>,
    scrollback: &Arc<Mutex<Scrollback>>,
    watch: &ServiceWatch,
) {
    let output_event = format!("terminal://output/{}", terminal_id);
    let mut buf = [0u8; 8192];
    // Thread-confined, so the carry buffer and the rate limit need no lock.
    let mut services = ServiceScanner::new();

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let data = String::from_utf8_lossy(&buf[..n]).to_string();
                // Record BEFORE emitting, and take the seq from the same
                // critical section: a snapshot read concurrent with this chunk
                // either sees it (and reports a seq at least this high) or does
                // not (and reports one below it). Either way the receiving
                // client can tell overlap from new output — see `TerminalEvent`.
                // A poisoned lock is not fatal here: the buffer is an
                // optimisation, so fall back to an un-deduplicable seq of 0
                // rather than killing the reader thread and the terminal with it.
                let seq = scrollback
                    .lock()
                    .map(|mut s| s.append(&data))
                    .unwrap_or_default();
                // Before the emit, not after: this is the only place a
                // terminal's output passes through in one piece, and a viewer
                // that is not mounted (the mobile drawer, a canvas card on
                // another route) never sees it at all.
                watch.feed(&mut services, &data, &terminal_id);
                let event = TerminalEvent {
                    terminal_id: terminal_id.clone(),
                    data,
                    seq,
                    generation: generation.clone(),
                };
                crate::web::event_bridge::emit_event(emitter, &output_event, event.clone());
            }
            Err(_) => break,
        }
    }

    // Terminal exited — remove from map and clean up temp files. Poison-tolerant
    // like the scrollback lock above: this runs on the long-lived `pty-reader-*`
    // thread, and refusing the removal would leak the entry and its temp files
    // for the rest of the process.
    finish_terminal_reader(&terminal_id, terminals, completed, scrollback);
    emit_terminal_exit_event(emitter, &terminal_id, &generation);
}

/// A previous reader can finish after a same-ID canvas terminal has restarted.
/// Only the reader of the current process may transfer that row to completed.
fn finish_terminal_reader(
    terminal_id: &str,
    terminals: &Mutex<HashMap<String, TerminalInstance>>,
    completed: &Mutex<CompletedTerminals>,
    scrollback: &Arc<Mutex<Scrollback>>,
) {
    let mut terminals = lock_terminals(terminals);
    if terminals
        .get(terminal_id)
        .is_some_and(|instance| Arc::ptr_eq(&instance.scrollback, scrollback))
    {
        let mut instance = terminals.remove(terminal_id).expect("matching terminal");
        let exit_code = instance
            ._child
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.exit_code());
        lock_completed(completed).insert(terminal_id.to_string(), instance, exit_code);
    }
}

fn emit_terminal_exit_event(emitter: &EventEmitter, terminal_id: &str, generation: &str) {
    let exit_event = format!("terminal://exit/{}", terminal_id);
    let event = TerminalEvent {
        terminal_id: terminal_id.to_string(),
        data: String::new(),
        seq: 0,
        generation: generation.to_string(),
    };
    crate::web::event_bridge::emit_event(emitter, &exit_event, event.clone());
}

/// Build a thread-name-safe short prefix from a caller-supplied `terminal_id`.
///
/// `terminal_id` arrives from the frontend (Tauri/web spawn paths) and is not
/// guaranteed to be ASCII, at least 8 bytes long, or free of NUL bytes. Naive
/// `&terminal_id[..8]` panics on a short id or a multibyte char straddling
/// byte 8, and `std::thread::Builder::spawn` panics if the resulting thread
/// name contains an interior NUL. Take the first 8 Unicode scalar values
/// (boundary- and length-safe) and replace NUL with `_`.
fn thread_name_prefix(terminal_id: &str) -> String {
    terminal_id
        .chars()
        .take(8)
        .map(|c| if c == '\0' { '_' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{thread_name_prefix, Scrollback, SCROLLBACK_MAX_CHARS};
    #[cfg(not(target_os = "windows"))]
    use super::{Arc, EventEmitter, SpawnOptions, TerminalManager};

    #[test]
    fn scrollback_seq_counts_every_chunk_and_never_rewinds() {
        // The seq is what a re-attaching client uses to tell "already in the
        // snapshot" from "arrived after it". A repeated or reset value would
        // make the replay either double-print or swallow output.
        let mut buffer = Scrollback::default();
        assert_eq!(buffer.append("a"), 1);
        assert_eq!(buffer.append("b"), 2);
        assert_eq!(buffer.read(), ("ab".to_string(), 2));
    }

    #[test]
    fn scrollback_evicts_whole_chunks_and_keeps_counting() {
        // Whole chunks, never a character slice: the buffer holds raw terminal
        // bytes, and cutting one mid-escape paints the replay with whatever the
        // truncated tail happens to mean.
        let mut buffer = Scrollback::default();
        let chunk = "x".repeat(SCROLLBACK_MAX_CHARS / 2 + 1);
        buffer.append(&chunk);
        buffer.append(&chunk);
        let seq = buffer.append("tail");
        let (data, read_seq) = buffer.read();
        assert_eq!(read_seq, seq, "eviction must not rewind the cursor");
        assert!(data.ends_with("tail"));
        assert!(
            data.chars().count() <= SCROLLBACK_MAX_CHARS,
            "kept {} chars",
            data.chars().count()
        );
    }

    #[test]
    fn scrollback_keeps_the_last_chunk_even_when_it_alone_is_too_big() {
        // A single chunk over the cap must not evict itself into an empty
        // buffer — the newest output is the part worth keeping.
        let mut buffer = Scrollback::default();
        let huge = "y".repeat(SCROLLBACK_MAX_CHARS * 2);
        buffer.append(&huge);
        let (data, seq) = buffer.read();
        assert_eq!(seq, 1);
        assert_eq!(data.chars().count(), huge.chars().count());
    }

    #[test]
    fn a_missing_terminal_reports_not_alive_rather_than_failing() {
        // "No such terminal" is the answer that tells a caller to spawn one;
        // an error would force it to parse a string to tell that apart from a
        // transport failure.
        let manager = super::TerminalManager::new();
        let snapshot = manager.snapshot("nope");
        assert!(!snapshot.alive);
        assert!(snapshot.data.is_empty());
        assert_eq!(snapshot.seq, 0);
    }

    /// A PTY child whose exit the manager never observed. Records whether the
    /// manager ended it (a kill, or a blocking wait that only a kill would end).
    #[derive(Debug)]
    struct UnobservedChild {
        ended: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl portable_pty::ChildKiller for UnobservedChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.ended.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(UnobservedChild {
                ended: self.ended.clone(),
            })
        }
    }

    impl portable_pty::Child for UnobservedChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            self.ended.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    #[test]
    fn a_completed_entry_never_ends_a_process_whose_exit_it_did_not_see() {
        // Reader EOF only says the PTY closed: a child can close its terminal
        // and keep running. However its record goes — an explicit close, a
        // window's bulk kill, the quit — the process it names must be left
        // running, as it was before the records existed. A stop of a
        // terminal that already ended changes nothing.
        use std::sync::atomic::{AtomicBool, Ordering};

        let manager = super::TerminalManager::new();
        let mut flags = Vec::new();
        {
            let mut completed = super::lock_completed(&manager.completed);
            for n in 0..4 {
                let id = format!("detached-{n}");
                let owner = if n % 2 == 0 { "main" } else { "other" };
                let ended = std::sync::Arc::new(AtomicBool::new(false));
                flags.push((id.clone(), ended.clone()));
                completed.entries.insert(
                    id,
                    super::CompletedTerminal {
                        scrollback: std::sync::Arc::new(std::sync::Mutex::new(
                            Scrollback::default(),
                        )),
                        owner_window_label: owner.to_string(),
                        generation: "generation".to_string(),
                        child: Some(Box::new(UnobservedChild { ended })),
                        exit_code: None,
                        size: None,
                    },
                );
            }
        }

        manager
            .stop("detached-1")
            .expect("stop of an ended terminal");
        assert!(manager.snapshot("detached-1").exists, "a stop forgot it");
        manager.kill("detached-3").expect("explicit close");
        manager.kill_by_owner_window("main");
        manager.kill_all();

        assert!(super::lock_completed(&manager.completed).entries.is_empty());
        for (id, ended) in flags {
            assert!(
                !ended.load(Ordering::SeqCst),
                "{id}: dropping its record ended a process still running"
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn sleeping_shell(id: &str, command: &str) -> SpawnOptions {
        SpawnOptions {
            terminal_id: id.to_string(),
            working_dir: std::env::temp_dir().to_string_lossy().to_string(),
            owner_window_label: "main".to_string(),
            shell: Some("/bin/sh".to_string()),
            initial_command: Some(command.to_string()),
            extra_env: None,
            temp_files: vec![],
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn a_stopped_terminal_keeps_its_output_until_it_is_closed() {
        // The command launcher's Stop ends the process but leaves the tab
        // open, so a reload of that tab must find the output it showed —
        // not "unavailable", which is what forgetting the terminal leaves.
        // The command ignores SIGHUP, so ending it takes the escalation to
        // SIGKILL, and then a wait to reap what that killed.
        use crate::web::event_bridge::WebEventBroadcaster;
        use std::time::{Duration, Instant};

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut events = broadcaster.subscribe();
        let manager = TerminalManager::new();
        let id = "stopped-output";
        manager
            .spawn_with_id(
                sleeping_shell(id, "trap '' HUP; printf 'stop-marker\\n'; exec sleep 30"),
                EventEmitter::test_web_only(broadcaster),
            )
            .expect("spawn");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !manager.snapshot(id).data.contains("stop-marker") {
            assert!(Instant::now() < deadline, "no output to keep");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let pid = super::lock_terminals(&manager.terminals)
            .get(id)
            .and_then(|instance| instance._child.process_id())
            .expect("child pid") as libc::pid_t;

        manager.stop(id).expect("stop");
        // Ended and reaped by the time stop returns: no longer a child of
        // ours at all. Still running, waitpid would answer 0; a zombie, its pid.
        let waited = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!(
            (waited, std::io::Error::last_os_error().raw_os_error()),
            (-1, Some(libc::ECHILD)),
            "stop left its process running or unreaped"
        );
        // The input is closed only after that, so no Enter and end-of-input
        // reached the process, and no echoed "^D" reached the kept output.
        // The reader reports the exit once it has read all it ever will.
        let exit_channel = format!("terminal://exit/{id}");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match events.recv().await {
                    Ok(event) if event.channel == exit_channel => return,
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(err) => panic!("event bus: {err}"),
                }
            }
        })
        .await
        .expect("the reader's exit");
        let stopped = manager.snapshot(id);
        assert!(stopped.exists, "the stop forgot the terminal");
        assert!(!stopped.alive);
        assert!(stopped.data.contains("stop-marker"));
        assert!(!stopped.data.contains("^D"), "{:?}", stopped.data);
        // Ended by us, not by itself: no exit status to report.
        assert_eq!(stopped.exit_code, None);
        assert!(super::lock_terminals(&manager.terminals).is_empty());

        manager.kill(id).expect("close");
        assert!(!manager.snapshot(id).exists);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn a_closed_launch_stays_refused_however_many_others_close() {
        // Every close of a terminal not yet launched leaves a mark; none of
        // them may push another out before its time, or that tab's command
        // runs after all when its launch finally lands.
        let manager = TerminalManager::new();
        let first = uuid::Uuid::new_v4().to_string();
        manager.kill(&first).expect("close before launch");
        for _ in 0..500 {
            manager
                .kill(&uuid::Uuid::new_v4().to_string())
                .expect("other closes");
        }
        let refused = manager
            .spawn_with_id(sleeping_shell(&first, "sleep 30"), EventEmitter::Noop)
            .expect_err("the closed tab's launch");
        assert!(refused.to_string().contains("cancelled"), "{refused}");
        assert!(!manager.snapshot(&first).exists);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn a_launch_underway_keeps_its_mark_however_old() {
        // The launch checks for a mark once more just before it inserts.
        // Pruning by age must not take the mark out from under it then.
        use std::time::{Duration, Instant};

        let manager = TerminalManager::new();
        let launching = uuid::Uuid::new_v4().to_string();
        let ages_ago = Instant::now()
            .checked_sub(super::CANCELLED_SPAWN_TTL + Duration::from_secs(1))
            .expect("a past instant");
        manager
            .spawning
            .lock()
            .unwrap()
            .insert(launching.clone(), "main".to_string());
        manager
            .cancelled_spawns
            .lock()
            .unwrap()
            .insert(launching.clone(), ages_ago);

        manager
            .kill(&uuid::Uuid::new_v4().to_string())
            .expect("prune");
        assert!(manager
            .cancelled_spawns
            .lock()
            .unwrap()
            .contains_key(&launching));

        // Once nothing is launching under that id, age applies again.
        manager.spawning.lock().unwrap().remove(&launching);
        manager
            .kill(&uuid::Uuid::new_v4().to_string())
            .expect("prune");
        assert!(!manager
            .cancelled_spawns
            .lock()
            .unwrap()
            .contains_key(&launching));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn a_snapshot_reports_the_size_its_output_was_drawn_for() {
        let manager = TerminalManager::new();
        let id = "sized-output";
        manager
            .spawn_with_id(sleeping_shell(id, "sleep 30"), EventEmitter::Noop)
            .expect("spawn");
        manager.resize(id, 133, 41).expect("resize");
        let live = manager.snapshot(id);
        assert_eq!((live.cols, live.rows), (Some(133), Some(41)));

        // Kept with the record once the process has ended.
        manager.stop(id).expect("stop");
        let ended = manager.snapshot(id);
        assert!(!ended.alive);
        assert_eq!((ended.cols, ended.rows), (Some(133), Some(41)));
        manager.kill(id).expect("close");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn bulk_kills_mark_only_launches_not_yet_in_the_table() {
        // A launch keeps its reservation for a moment after inserting its
        // terminal. A bulk kill in that moment ends the terminal itself; a
        // cancellation mark for it would outlive it and refuse the next
        // launch of that id.
        let manager = TerminalManager::new();
        let pending = |manager: &TerminalManager| {
            manager
                .cancelled_spawns
                .lock()
                .unwrap()
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>()
        };
        let reserve = |manager: &TerminalManager, id: &str| {
            manager
                .spawning
                .lock()
                .unwrap()
                .insert(id.to_string(), "main".to_string());
        };

        manager
            .spawn_with_id(sleeping_shell("inserted", "sleep 30"), EventEmitter::Noop)
            .expect("spawn");
        reserve(&manager, "inserted");
        reserve(&manager, "launching");
        manager.kill_by_owner_window("main");
        assert_eq!(
            pending(&manager),
            std::collections::HashSet::from(["launching".to_string()])
        );

        manager.cancelled_spawns.lock().unwrap().clear();
        manager.spawning.lock().unwrap().clear();
        manager
            .spawn_with_id(sleeping_shell("inserted", "sleep 30"), EventEmitter::Noop)
            .expect("spawn again");
        reserve(&manager, "inserted");
        reserve(&manager, "launching");
        manager.kill_all();
        assert_eq!(
            pending(&manager),
            std::collections::HashSet::from(["launching".to_string()])
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn finished_terminal_keeps_final_output_and_exit_status_until_explicit_close() {
        use crate::web::event_bridge::WebEventBroadcaster;
        use std::time::{Duration, Instant};

        let manager = TerminalManager::new();
        let emitter = EventEmitter::test_web_only(Arc::new(WebEventBroadcaster::new()));
        manager
            .spawn_with_id(
                SpawnOptions {
                    terminal_id: "finished-output".to_string(),
                    working_dir: std::env::temp_dir().to_string_lossy().to_string(),
                    owner_window_label: "main".to_string(),
                    shell: Some("/bin/sh".to_string()),
                    initial_command: Some("printf 'last-output-marker\\n'; exit 7".to_string()),
                    extra_env: None,
                    temp_files: vec![],
                },
                emitter,
            )
            .expect("spawn");

        let deadline = Instant::now() + Duration::from_secs(10);
        let completed = loop {
            // list can observe child exit before reader EOF. Neither order may
            // throw away the final bytes needed by a reloaded pane.
            let _ = manager.list_with_exit_check(None);
            let snapshot = manager.snapshot("finished-output");
            if !snapshot.alive && snapshot.exists && snapshot.data.contains("last-output-marker") {
                break snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "last output vanished: {snapshot:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(completed.exit_code, Some(7));
        manager.kill("finished-output").expect("explicit close");
        let removed = manager.snapshot("finished-output");
        assert!(!removed.exists);
        assert!(removed.data.is_empty());
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn reader_eof_first_preserves_status_and_stale_reader_cannot_remove_new_pty() {
        use crate::web::event_bridge::WebEventBroadcaster;
        use std::time::{Duration, Instant};

        let manager = TerminalManager::new();
        let emitter = EventEmitter::test_web_only(Arc::new(WebEventBroadcaster::new()));
        let opts = |command: &str| SpawnOptions {
            terminal_id: "reused-id".to_string(),
            working_dir: std::env::temp_dir().to_string_lossy().to_string(),
            owner_window_label: "main".to_string(),
            shell: Some("/bin/sh".to_string()),
            initial_command: Some(command.to_string()),
            extra_env: None,
            temp_files: vec![],
        };

        manager
            .spawn_with_id(
                opts("printf 'eof-first-marker\\n'; exit 9"),
                emitter.clone(),
            )
            .expect("first spawn");
        let old_scrollback = super::lock_terminals(&manager.terminals)
            .get("reused-id")
            .expect("first terminal")
            .scrollback
            .clone();

        // Do not call list: the reader must be the one to move it to completed.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let snapshot = manager.snapshot("reused-id");
            if !snapshot.alive
                && snapshot.exists
                && snapshot.data.contains("eof-first-marker")
                && snapshot.exit_code == Some(9)
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "EOF-first status missing: {snapshot:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        manager
            .spawn_with_id(opts("sleep 30"), emitter)
            .expect("new process with reused id");
        let new_generation = manager.snapshot("reused-id").generation;
        super::finish_terminal_reader(
            "reused-id",
            &manager.terminals,
            &manager.completed,
            &old_scrollback,
        );
        let current = manager.snapshot("reused-id");
        assert!(current.alive, "old reader removed new PTY");
        assert_eq!(current.generation, new_generation);
        assert!(!Arc::ptr_eq(
            &old_scrollback,
            &super::lock_terminals(&manager.terminals)
                .get("reused-id")
                .expect("new terminal")
                .scrollback
        ));
        manager.kill("reused-id").expect("cleanup");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn explicit_close_before_spawn_cancels_only_that_uuid_once() {
        let manager = TerminalManager::new();
        let id = uuid::Uuid::new_v4().to_string();
        let opts = |id: &str| SpawnOptions {
            terminal_id: id.to_string(),
            working_dir: std::env::temp_dir().to_string_lossy().to_string(),
            owner_window_label: "main".to_string(),
            shell: Some("/bin/sh".to_string()),
            initial_command: Some("sleep 30".to_string()),
            extra_env: None,
            temp_files: vec![],
        };
        manager.kill(&id).expect("close overtakes spawn");
        let refused = manager
            .spawn_with_id(opts(&id), EventEmitter::Noop)
            .expect_err("the closed tab's launch");
        assert!(refused.to_string().contains("cancelled"), "{refused}");
        assert!(!manager.snapshot(&id).exists);
        // Reservation is consumed. An intentional later new tab may use the ID.
        manager
            .spawn_with_id(opts(&id), EventEmitter::Noop)
            .expect("new launch");
        manager.kill(&id).expect("close live process");

        // Canvas cards use deterministic, non-UUID IDs. Their missing kill
        // must not reserve the ID and prevent the existing restart behavior.
        assert!(manager.kill("canvas-term-42").is_err());
        manager
            .spawn_with_id(opts("canvas-term-42"), EventEmitter::Noop)
            .expect("canvas restart");
        manager.kill("canvas-term-42").expect("canvas cleanup");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn concurrent_same_id_spawn_creates_one_child() {
        use std::sync::Barrier;
        use std::time::{Duration, Instant};

        let manager = Arc::new(TerminalManager::new());
        let id = uuid::Uuid::new_v4().to_string();
        let output = std::env::temp_dir().join(format!("codeg-749-spawn-{}", uuid::Uuid::new_v4()));
        let gate = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let manager = manager.clone();
            let id = id.clone();
            let output = output.clone();
            let gate = gate.clone();
            threads.push(std::thread::spawn(move || {
                gate.wait();
                manager.spawn_with_id(
                    SpawnOptions {
                        terminal_id: id,
                        working_dir: std::env::temp_dir().to_string_lossy().to_string(),
                        owner_window_label: "main".to_string(),
                        shell: Some("/bin/sh".to_string()),
                        initial_command: Some(format!(
                            "printf 'started\\n' >> '{}'; sleep 30",
                            output.display()
                        )),
                        extra_env: None,
                        temp_files: vec![],
                    },
                    EventEmitter::Noop,
                )
            }));
        }
        gate.wait();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().expect("join"))
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);

        let deadline = Instant::now() + Duration::from_secs(5);
        while !output.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let text = std::fs::read_to_string(&output).expect("spawn marker");
        assert_eq!(text.lines().count(), 1, "command was run twice");
        manager.kill(&id).expect("the winning child is reachable");
        let _ = std::fs::remove_file(output);
    }

    #[test]
    fn keeps_short_ascii_id() {
        assert_eq!(thread_name_prefix("abc"), "abc");
        assert_eq!(thread_name_prefix(""), "");
    }

    #[test]
    fn truncates_to_first_eight_chars() {
        assert_eq!(thread_name_prefix("0123456789"), "01234567");
    }

    #[test]
    fn is_char_boundary_safe() {
        // '密' occupies bytes 7..10, so `&s[..8]` would slice inside it and
        // panic; taking 8 scalar values keeps the whole char.
        assert_eq!(thread_name_prefix("abcdefg密钥"), "abcdefg密");
    }

    #[test]
    fn sanitizes_interior_nul_so_thread_spawns() {
        assert_eq!(thread_name_prefix("ab\0cd"), "ab_cd");
        // The result must be usable as a real thread name without panicking.
        std::thread::Builder::new()
            .name(thread_name_prefix("ab\0cdefghij"))
            .spawn(|| {})
            .expect("spawn with sanitized name")
            .join()
            .expect("join");
    }

    /// The whole local-server path over a REAL pty: a real shell prints a real
    /// banner, the watch reads it out of the output stream, connects to the
    /// socket, and the frontend's event arrives naming the window that owns
    /// the terminal.
    ///
    /// The pieces have unit tests of their own; what only an end-to-end run
    /// can show is that the watch is wired into the reader at all, and that a
    /// banner survives a real PTY (its line endings, its echo, its shell).
    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn a_server_announced_in_a_terminal_reaches_the_frontend() {
        use crate::browser::types::SERVICE_DETECTED_EVENT;
        use crate::web::event_bridge::WebEventBroadcaster;
        use std::time::Duration;

        // Something really listening, so the probe has something to find.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        // Subscribed before the spawn: the broadcaster drops what it sends
        // with no receivers, and a shell prints fast.
        let mut events = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster);

        let manager = TerminalManager::new();
        manager
            .spawn_with_id(
                SpawnOptions {
                    terminal_id: "svc-e2e".to_string(),
                    working_dir: std::env::temp_dir().to_string_lossy().to_string(),
                    owner_window_label: "main".to_string(),
                    shell: Some("/bin/sh".to_string()),
                    initial_command: Some(format!(
                        "printf '  ➜  Local:   http://127.0.0.1:{port}/\\n'"
                    )),
                    extra_env: None,
                    temp_files: vec![],
                },
                emitter,
            )
            .expect("spawn");

        let detected = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let event = events.recv().await.expect("event bus");
                if event.channel == SERVICE_DETECTED_EVENT {
                    return event;
                }
            }
        })
        .await
        .expect("the service event");

        let payload = detected.payload;
        assert_eq!(payload["origin"], format!("http://127.0.0.1:{port}"));
        assert_eq!(payload["url"], format!("http://127.0.0.1:{port}/"));
        assert_eq!(payload["authority"], format!("127.0.0.1:{port}"));
        assert_eq!(payload["ownerWindow"], "main");
        assert_eq!(payload["source"], "terminal");
        assert_eq!(payload["terminalId"], "svc-e2e");

        let _ = manager.kill("svc-e2e");
    }
}
