//! `codeg-computer-helper`: the process that holds the OS permissions for
//! computer use, and runs the driver as its child.
//!
//! On macOS the helper is launched by codeg as its own TCC responsible
//! process, so Accessibility and Screen Recording are granted to it and not to
//! codeg — where every agent's shell would inherit them. That makes the helper
//! the thing an agent would most like to drive itself: any process can launch
//! a copy of it the same way codeg does. So **before it reads a byte, the
//! helper checks that the process on the other end of its stdin is codeg** —
//! by the audit token the kernel attached to the socket, against codeg's
//! designated requirement compiled into this binary — and exits, having done
//! nothing, if it is not.
//!
//! The requirement is compiled in (`CODEG_COMPUTER_PEER_REQUIREMENT`, set by
//! the release build) rather than read from anywhere at run time: the app
//! bundle both binaries ship in is owned by the user and writable by any of
//! their processes. A build without it is a development build. Development
//! builds skip the peer check and say so in their first frame — tolerable only
//! because such a build is ad-hoc signed, so the permissions granted to it are
//! keyed to that one build's cdhash. **A helper that carries a Team ID and no
//! requirement refuses to start**: that would be a helper matching the release
//! signing identity with no check in front of it, a standing key to whatever
//! the user granted.
//!
//! On Windows and Linux there is no TCC to guard and no code signature to
//! check; the helper serves its stdin, which is the pipe codeg gave it.

pub mod act;
#[cfg(target_os = "macos")]
pub mod axwin;
pub mod clipboard;
pub mod driver_proc;
#[cfg(windows)]
pub mod hwnd;
pub mod keystate;
pub mod mcp;
pub mod ops;
pub mod screen;
pub mod session;
pub mod tree;
#[cfg(all(target_os = "linux", feature = "computer-helper"))]
pub mod x11win;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

use self::act::SnapshotBook;
use self::driver_proc::DriverProc;
use self::ops::AppCache;
use super::driver;
use super::protocol::{
    read_frame, HelperError, HelperErrorCode, HelperMessage, HelperOp, HelperReady, HelperReply,
    HelperRequest, OsPermission, PeerCheck, PermissionReport, ProcessRun, RawAct, RawApp,
    RawWindow, MAX_FRAME_BYTES, PROTOCOL_VERSION, SOURCE_FINGERPRINT, STOP_ALL,
};

/// Exit codes, for codeg's log: they are all the helper says to a peer it has
/// refused.
pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_PEER_REFUSED: i32 = 2;
pub const EXIT_UNANCHORED: i32 = 3;

/// codeg's designated requirement, compiled into release builds. See the
/// module note.
pub const PEER_REQUIREMENT: Option<&str> = option_env!("CODEG_COMPUTER_PEER_REQUIREMENT");

/// The helper's whole life: check the peer, serve it, exit when it goes away.
///
/// (Asking macOS for a permission is not part of it: codeg starts a helper
/// of its own for each request — see `REQUEST_PERMISSION_ARG` — and the
/// binary answers that before it gets here, so nothing codeg itself links
/// can raise a request in codeg's name.)
pub fn run() -> i32 {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_target(false)
        .try_init();

    let channel = match open_channel() {
        Ok(channel) => channel,
        Err((code, why)) => {
            tracing::error!("refusing to serve: {why}");
            return code;
        }
    };

    // Everything the helper writes lives under its own directory; being there
    // keeps the driver (which inherits the working directory) out of wherever
    // codeg happened to be started. Done before any thread exists, and not
    // optional: a helper that stayed where it was started would hand that
    // directory to the driver.
    if let Some(dir) = driver_proc::helper_data_dir() {
        if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::env::set_current_dir(&dir))
        {
            tracing::error!("could not move to {}: {e}", dir.display());
            return EXIT_FAILED;
        }
    }

    serve_on_own_runtime(
        move || channel.raw.into_tokio(),
        channel.peer,
        channel.guard,
    )
}

/// Build the helper's runtime, open the channel on it (tokio's socket wrapper
/// registers with its reactor) and serve — then leave without waiting on
/// whatever is still running there: codeg is gone, and the process exits
/// when this returns.
fn serve_on_own_runtime(
    open: impl FnOnce() -> std::io::Result<Halves>,
    peer: PeerCheck,
    guard: Option<PeerGuard>,
) -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!("no runtime: {e}");
            return EXIT_FAILED;
        }
    };
    let code = runtime.block_on(async move {
        let (reader, writer) = match open() {
            Ok(halves) => halves,
            Err(e) => {
                tracing::error!("could not open the channel: {e}");
                return EXIT_FAILED;
            }
        };
        serve(reader, writer, peer, guard).await
    });
    runtime.shutdown_background();
    code
}

enum RawChannel {
    /// macOS: the socketpair end codeg handed over as both stdin and stdout.
    #[cfg(target_os = "macos")]
    Socket(std::os::unix::net::UnixStream),
    Stdio,
}

type Halves = (
    Box<dyn AsyncRead + Send + Unpin>,
    Box<dyn AsyncWrite + Send + Unpin>,
);

impl RawChannel {
    /// Needs a runtime: tokio's socket wrapper registers with its reactor.
    fn into_tokio(self) -> std::io::Result<Halves> {
        match self {
            #[cfg(target_os = "macos")]
            RawChannel::Socket(socket) => {
                socket.set_nonblocking(true)?;
                let (r, w) = tokio::net::UnixStream::from_std(socket)?.into_split();
                Ok((Box::new(r), Box::new(w)))
            }
            RawChannel::Stdio => Ok((Box::new(tokio::io::stdin()), Box::new(tokio::io::stdout()))),
        }
    }
}

struct Channel {
    raw: RawChannel,
    peer: PeerCheck,
    guard: Option<PeerGuard>,
}

/// The codeg that was checked, for checking every request against.
///
/// The kernel's peer token names the last process to have used the other end
/// of the socket, not the one that created it — so a single check at start
/// would vouch for whoever wrote next. Each request is held to the process
/// that passed the check: same pid, same incarnation of it.
pub struct PeerGuard {
    #[cfg(target_os = "macos")]
    token: super::codesign::AuditToken,
}

impl PeerGuard {
    fn still_peer(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            super::codesign::peer_audit_token(0).is_ok_and(|now| {
                now.pid() == self.token.pid() && now.pid_version() == self.token.pid_version()
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }
}

/// Decide who is on the other end of stdin, before anything is read from it.
#[cfg(target_os = "macos")]
fn open_channel() -> Result<Channel, (i32, String)> {
    use super::codesign::{check_guest, peer_audit_token, self_info, Guest};

    let requirement = PEER_REQUIREMENT.filter(|r| !r.trim().is_empty());
    if requirement.is_none() {
        // A helper that cannot tell whether it is a release build is treated
        // as one.
        let me = self_info()
            .map_err(|e| (EXIT_UNANCHORED, format!("cannot read my own signature: {e}")))?;
        if me.team_id.is_some() {
            return Err((
                EXIT_UNANCHORED,
                "this helper is signed with a Team ID but was built without codeg's \
                 designated requirement; it would serve any caller"
                    .into(),
            ));
        }
    }

    if !is_socket(0) {
        return match requirement {
            Some(_) => Err((EXIT_PEER_REFUSED, "stdin is not a socket".into())),
            None => {
                tracing::warn!("development build: serving plain stdio without a peer check");
                Ok(Channel {
                    raw: RawChannel::Stdio,
                    peer: PeerCheck::Development,
                    guard: None,
                })
            }
        };
    }
    let (peer, guard) = match requirement {
        Some(requirement) => {
            // Replies go back down the socket the requests came in on, never
            // to a descriptor someone else wired up as stdout.
            if !same_file(0, 1) {
                return Err((EXIT_PEER_REFUSED, "stdout is not the stdin socket".into()));
            }
            let token = peer_audit_token(0)
                .map_err(|e| (EXIT_PEER_REFUSED, format!("no peer token: {e}")))?;
            // The codeg this helper serves is the one that launched it: the
            // peer must be this process's parent. Otherwise a process could
            // get a genuine codeg to write once into a socket of its own
            // making and start the helper on the other end — the token would
            // name that codeg, and the helper would serve whoever started it.
            // SAFETY: getppid cannot fail.
            let parent = unsafe { libc::getppid() };
            if i64::from(token.pid()) != i64::from(parent) {
                return Err((
                    EXIT_PEER_REFUSED,
                    format!(
                        "the peer (pid {}) is not the process that launched this helper \
                         (pid {parent})",
                        token.pid()
                    ),
                ));
            }
            let info = check_guest(Guest::Audit(token), requirement)
                .map_err(|e| (EXIT_PEER_REFUSED, format!("the peer is not codeg: {e}")))?;
            info.entitlements_clean().map_err(|e| {
                (
                    EXIT_PEER_REFUSED,
                    format!("the peer is not a codeg this helper serves: {e}"),
                )
            })?;
            (PeerCheck::Verified, Some(PeerGuard { token }))
        }
        None => {
            tracing::warn!("development build: serving without checking the peer's signature");
            (PeerCheck::Development, None)
        }
    };
    // SAFETY: fd 0 is a socket (checked above) that this process owns for its
    // whole life; nothing else in the helper touches descriptor 0.
    let socket = unsafe {
        use std::os::fd::FromRawFd;
        std::os::unix::net::UnixStream::from_raw_fd(0)
    };
    Ok(Channel {
        raw: RawChannel::Socket(socket),
        peer,
        guard,
    })
}

#[cfg(not(target_os = "macos"))]
fn open_channel() -> Result<Channel, (i32, String)> {
    Ok(Channel {
        raw: RawChannel::Stdio,
        peer: PeerCheck::NotApplicable,
        guard: None,
    })
}

#[cfg(target_os = "macos")]
fn fstat(fd: i32) -> Option<libc::stat> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: fstat on a descriptor number with a valid out-parameter.
    (unsafe { libc::fstat(fd, &mut st) } == 0).then_some(st)
}

#[cfg(target_os = "macos")]
fn is_socket(fd: i32) -> bool {
    fstat(fd).is_some_and(|st| (st.st_mode & libc::S_IFMT) == libc::S_IFSOCK)
}

#[cfg(target_os = "macos")]
fn same_file(a: i32, b: i32) -> bool {
    match (fstat(a), fstat(b)) {
        (Some(x), Some(y)) => x.st_dev == y.st_dev && x.st_ino == y.st_ino,
        _ => false,
    }
}

/// How long an answer that a permission is missing stands before the helper
/// asks the system again. Asking starts a process; an agent retrying a
/// screenshot in a loop should not start one per try.
#[cfg(any(test, target_os = "macos"))]
const RECHECK_MISSING: Duration = Duration::from_secs(2);

/// The running driver, and the Stop count of the request that started it —
/// so a Stop from after that request ends it and one from before does not.
struct RunningDriver {
    proc: Arc<DriverProc>,
    stop: u64,
}

/// What the running helper holds between requests.
struct HelperState {
    /// Set by `Configure`.
    driver_path: Mutex<Option<PathBuf>>,
    /// The running driver, started on first use and again after it exits.
    driver: Mutex<Option<RunningDriver>>,
    apps: Mutex<AppCache>,
    /// The latest snapshot of each window, as the running driver keeps them.
    snapshots: std::sync::Mutex<SnapshotBook>,
    /// The latest of the person's Stops codeg has told of (`Halt::stop`),
    /// moved the moment its frame is read — and to [`STOP_ALL`] when codeg
    /// goes. Nothing of a request from before it (`HelperRequest::stop`)
    /// reaches a driver after that, whichever frame arrived first; what is
    /// from after it runs as usual. Shared with each action's [`Delivery`].
    stopped: Arc<AtomicU64>,
    /// The helper's permissions as the system last answered, and when. Never
    /// asked in this process on macOS: a process keeps the first "not
    /// granted" it hears for the rest of its life (see [`permissions`]).
    ///
    /// [`permissions`]: Self::permissions
    permissions: Mutex<Option<(PermissionReport, Instant)>>,
    /// The permissions in force when the running driver started, while one
    /// runs.
    driver_saw: std::sync::Mutex<Option<PermissionReport>>,
    /// A permission is in force that the running driver started without. The
    /// driver may still hold the system's earlier "no" — for Screen Recording
    /// macOS keeps it until the process ends — so the next call that needs
    /// the driver starts a fresh one.
    driver_stale: AtomicBool,
}

impl HelperState {
    fn snapshots(&self) -> std::sync::MutexGuard<'_, SnapshotBook> {
        // Every change to the book is a single insert or removal, so a
        // poisoned lock still guards a consistent book.
        self.snapshots.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Whether a request codeg let through at Stop count `stop` may still
    /// reach a driver: no later Stop has been heard of.
    fn check_not_stopped(&self, stop: u64) -> Result<(), HelperError> {
        if self.stopped.load(Ordering::Acquire) > stop {
            return Err(stopped());
        }
        Ok(())
    }

    /// What an action on `pid`'s window `window_id`, let through at Stop
    /// count `stop`, must still find when it goes out (see [`Delivery`]).
    fn delivery(
        &self,
        pid: u32,
        window_id: u64,
        started_at: u64,
        content: Option<ProcessRun>,
        stop: u64,
    ) -> Delivery {
        Delivery {
            stopped: self.stopped.clone(),
            stop,
            pid,
            window_id,
            started_at,
            content,
        }
    }

    /// The driver running now, for a request codeg let through at Stop count
    /// `stop` — never one started for it: none running, or one a Stop since
    /// has ended, refuses the request, which codeg asks again about after
    /// [`HelperOp::DriverReady`].
    async fn running_driver(&self, stop: u64) -> Result<Arc<DriverProc>, HelperError> {
        self.check_not_stopped(stop)?;
        let slot = self.driver.lock().await;
        self.check_not_stopped(stop)?;
        let stopped = self.stopped.load(Ordering::Acquire);
        slot.as_ref()
            .filter(|d| d.stop >= stopped && d.proc.alive())
            .map(|d| d.proc.clone())
            .ok_or_else(|| {
                HelperError::new(
                    HelperErrorCode::ActionFailed,
                    "The driver restarted just before the action, so nothing was sent; try again.",
                )
            })
    }

    /// The running driver, for a request codeg let through at Stop count
    /// `stop` — starting one if there is none, if the one running started
    /// before a permission it now has (`driver_stale`), or if it started for
    /// a request from before a Stop since heard of (the `Halt` that ends it
    /// may still be on its way to the slot).
    async fn driver(&self, stop: u64) -> Result<Arc<DriverProc>, HelperError> {
        self.check_not_stopped(stop)?;
        let mut slot = self.driver.lock().await;
        // A Stop heard of while this one waited for the slot.
        self.check_not_stopped(stop)?;
        let stopped = self.stopped.load(Ordering::Acquire);
        let stale = self.driver_stale.swap(false, Ordering::AcqRel);
        if !stale {
            if let Some(running) = slot
                .as_ref()
                .filter(|d| d.stop >= stopped && d.proc.alive())
            {
                return Ok(running.proc.clone());
            }
        }
        if let Some(old) = slot.take() {
            self.forget_driver_saw();
            if old.stop >= stopped {
                old.proc.shutdown().await;
            } else {
                self.snapshots().clear();
                old.proc.kill().await;
            }
        }
        let path = self.driver_path.lock().await.clone().ok_or_else(|| {
            HelperError::new(
                HelperErrorCode::NotConfigured,
                "the helper has not been told where the driver is",
            )
        })?;
        let artifact = driver::artifact_for_current_platform().ok_or_else(|| {
            HelperError::new(
                HelperErrorCode::DriverUnavailable,
                "no driver release for this platform",
            )
        })?;
        // What the new driver starts with, so a permission granted later is
        // told apart from one it had all along.
        let had = self.permissions(false).await;
        let launched =
            Arc::new(DriverProc::launch(&path, artifact, || self.check_not_stopped(stop)).await?);
        // A Stop that arrived while this one was starting stops it too.
        if let Err(halted) = self.check_not_stopped(stop) {
            launched.shutdown().await;
            return Err(halted);
        }
        // A fresh driver has taken no snapshots.
        self.snapshots().clear();
        *self.driver_saw.lock().unwrap_or_else(|p| p.into_inner()) = Some(had);
        // A check that ran while this one was starting, and found more than
        // it started with, compared itself with no driver: compare now.
        if self
            .permissions
            .lock()
            .await
            .as_ref()
            .is_some_and(|(last, _)| gained(&had, last))
        {
            self.driver_stale.store(true, Ordering::Release);
        }
        *slot = Some(RunningDriver {
            proc: launched.clone(),
            stop,
        });
        Ok(launched)
    }

    fn forget_driver_saw(&self) {
        *self.driver_saw.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    async fn shutdown(&self) {
        let driver = self.driver.lock().await.take();
        self.snapshots().clear();
        self.forget_driver_saw();
        if let Some(driver) = driver {
            driver.proc.shutdown().await;
        }
    }

    /// The helper's own OS permissions. `fresh` asks the system now;
    /// otherwise a recent answer stands — one that both are granted until a
    /// driver call says otherwise (see [`handle`]), one that something is
    /// missing for [`RECHECK_MISSING`].
    ///
    /// On macOS the system is asked in a process started for the purpose
    /// (`driver_proc::probe_permissions`), never in this one: macOS keeps a
    /// process's first "not granted" for its whole life, and a helper that
    /// asked itself would go on reporting a permission missing after the
    /// person had granted it — and could not use it itself (see `axwin`).
    /// When no such process can be started, the last answer stands for now
    /// and the next call asks again; with none, nothing is granted. A
    /// permission that has appeared since the running driver started marks
    /// that driver stale.
    async fn permissions(&self, fresh: bool) -> PermissionReport {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = fresh;
            PermissionReport {
                required: false,
                accessibility: true,
                screen_recording: true,
            }
        }
        #[cfg(target_os = "macos")]
        {
            let mut last = self.permissions.lock().await;
            if !fresh {
                if let Some((report, at)) = last.as_ref() {
                    if answer_stands(report, at.elapsed()) {
                        return *report;
                    }
                }
            }
            let Some(report) = self.ask_system().await else {
                return last.as_ref().map_or(
                    PermissionReport {
                        required: true,
                        accessibility: false,
                        screen_recording: false,
                    },
                    |(report, _)| *report,
                );
            };
            if self
                .driver_saw
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .is_some_and(|saw| gained(saw, &report))
            {
                self.driver_stale.store(true, Ordering::Release);
            }
            *last = Some((report, Instant::now()));
            report
        }
    }

    /// Ask macOS, in a fresh process; `None` where that cannot be done — no
    /// driver configured yet, or one that would not start. Never asked here
    /// instead: this process would keep a "not granted" for the rest of its
    /// life, and it makes Accessibility calls of its own.
    #[cfg(target_os = "macos")]
    async fn ask_system(&self) -> Option<PermissionReport> {
        let path = self.driver_path.lock().await.clone()?;
        match driver_proc::probe_permissions(&path).await {
            Ok(report) => Some(report),
            Err(e) => {
                tracing::warn!(
                    "could not check permissions in a fresh process: {}",
                    e.message
                );
                None
            }
        }
    }

    /// Refuse an op up front when the helper lacks the permission it needs,
    /// so the answer names the permission instead of being whatever the
    /// driver makes of a failed system call.
    async fn require(&self, permission: OsPermission) -> Result<(), HelperError> {
        if self.permissions(false).await.has(permission) {
            Ok(())
        } else {
            Err(HelperError::permission_missing(permission))
        }
    }

    /// The normal windows, each joined with its application — with the
    /// minimized ones, and on macOS those of hidden applications, marked
    /// ([`mark_out_of_sight`](Self::mark_out_of_sight)).
    async fn list_windows(
        &self,
        driver: &DriverProc,
        pid: Option<u32>,
    ) -> Result<Vec<RawWindow>, HelperError> {
        let windows = ops::list_windows(driver, &self.apps, pid).await?;
        Ok(self.mark_out_of_sight(windows).await)
    }

    /// The running applications: on macOS and Windows the owners of the
    /// windows a person could mean ([`ops::apps_of`]), from the listing
    /// [`list_windows`](Self::list_windows) gives; elsewhere the driver's
    /// own list.
    async fn list_apps(&self, driver: &DriverProc) -> Result<Vec<RawApp>, HelperError> {
        #[cfg(any(target_os = "macos", windows))]
        {
            Ok(ops::apps_of(self.list_windows(driver, None).await?))
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            ops::list_apps(driver, &self.apps).await
        }
    }

    /// `windows`, with the minimized ones and those of hidden applications
    /// marked — on macOS when this helper may ask Accessibility, which only a
    /// process started for the purpose can establish (see
    /// [`permissions`](Self::permissions)); without it they stay unmarked,
    /// and unlisted. On X11 the window manager is asked. Elsewhere the
    /// driver's listing says all it can.
    async fn mark_out_of_sight(&self, mut windows: Vec<RawWindow>) -> Vec<RawWindow> {
        #[cfg(target_os = "macos")]
        if self.permissions(false).await.accessibility {
            ops::mark_out_of_sight(&mut windows).await;
        }
        #[cfg(all(target_os = "linux", feature = "computer-helper"))]
        ops::mark_out_of_sight(&mut windows).await;
        #[cfg(not(any(
            target_os = "macos",
            all(target_os = "linux", feature = "computer-helper")
        )))]
        let _ = &mut windows;
        windows
    }

    /// Whether `pid`'s window `window_id` is minimized or its application
    /// hidden, when this helper may ask Accessibility and the application
    /// says.
    #[cfg(target_os = "macos")]
    async fn out_of_sight(&self, pid: u32, window_id: u64) -> Option<axwin::OutOfSight> {
        if !self.permissions(false).await.accessibility {
            return None;
        }
        axwin::out_of_sight(pid, window_id).await
    }

    /// The person's `stop`-th Stop: kill the driver started for a request
    /// from before it now, whatever that driver is doing — unlike
    /// [`shutdown`], it is given no time to finish what it is in the middle
    /// of, and every call waiting on it fails at once. A driver started for
    /// a request from after this Stop is left be. A driver still starting
    /// cannot be in the middle of anything; one started for a request from
    /// before the Stop stops itself when it has (see [`driver`](Self::driver)).
    ///
    /// [`shutdown`]: Self::shutdown
    async fn halt(&self, stop: u64) {
        let mut slot = self.driver.lock().await;
        if slot.as_ref().is_none_or(|d| d.stop >= stop) {
            return;
        }
        let driver = slot.take();
        drop(slot);
        self.snapshots().clear();
        self.forget_driver_saw();
        if let Some(driver) = driver {
            driver.proc.kill().await;
        }
    }
}

/// What must hold at the moment an action goes out: no Stop has come since
/// codeg let it through, the pid is still the process the window was shared
/// from (a relaunch under a reused pid is another process, whose windows
/// nobody shared), so is the process drawing inside it where that is another
/// (a frame's application, relaunched into the same frame, is a window nobody
/// shared), and the session is affirmatively unlocked and on this console.
/// Asked just before each driver call — and, for the change the helper makes
/// itself through Accessibility, on the thread that makes it, after
/// everything read to decide on it: owned for that.
#[derive(Clone)]
pub struct Delivery {
    stopped: Arc<AtomicU64>,
    stop: u64,
    pid: u32,
    window_id: u64,
    started_at: u64,
    content: Option<ProcessRun>,
}

impl Delivery {
    /// Whether the action may go out now.
    pub fn check(&self) -> Result<(), HelperError> {
        if self.stopped.load(Ordering::Acquire) > self.stop {
            return Err(stopped());
        }
        if super::procinfo::process_start(self.pid) != Some(self.started_at) {
            return Err(HelperError::new(
                HelperErrorCode::NoSuchWindow,
                "the window's process is gone",
            ));
        }
        if let Some(run) = self.content {
            if self.content_start(run) != Some(run.started_at) {
                return Err(HelperError::new(
                    HelperErrorCode::NoSuchWindow,
                    "the application that was in the window is gone from it",
                ));
            }
        }
        match session::state() {
            session::SessionState::Unlocked => Ok(()),
            session::SessionState::Locked => Err(HelperError::new(
                HelperErrorCode::Paused,
                "The screen is locked, or another user's session is active.",
            )),
            session::SessionState::Unknown => Err(HelperError::new(
                HelperErrorCode::ActionFailed,
                "codeg cannot tell whether this desktop's session is locked, so it does not act \
                 on windows here; retrying will not change that. Reading windows still works.",
            )),
        }
    }

    /// The start stamp of `run`, the process drawing inside the window — on
    /// Windows read through a handle held while the frame is found still
    /// showing that process, where it says (see `hwnd::frame_holds`): a frame
    /// showing another is not the window that was shared. Elsewhere no window
    /// has another process drawing inside it.
    fn content_start(&self, run: ProcessRun) -> Option<u64> {
        #[cfg(windows)]
        {
            super::procinfo::process_start_while(run.pid, || {
                hwnd::frame_holds(self.window_id, self.pid, run.pid) != Some(false)
            })
        }
        #[cfg(not(windows))]
        {
            let _ = self.window_id;
            super::procinfo::process_start(run.pid)
        }
    }
}

/// The entire screen is offered on macOS and Windows; Linux has no one list
/// of every window on it to judge them by (and Wayland no picture of it).
fn screen_offered() -> Result<(), HelperError> {
    if cfg!(any(target_os = "macos", windows)) {
        Ok(())
    } else {
        Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            "The entire screen is not offered on Linux: share windows or applications instead.",
        ))
    }
}

/// What a request cut off by the person's Stop is answered.
fn stopped() -> HelperError {
    HelperError::new(
        HelperErrorCode::Stopped,
        "The user pressed Stop in codeg's Computer use panel.",
    )
}

/// Whether a remembered answer still stands: one that both permissions are
/// granted does until a driver call says otherwise; one that something is
/// missing, for [`RECHECK_MISSING`].
#[cfg(any(test, target_os = "macos"))]
fn answer_stands(report: &PermissionReport, age: Duration) -> bool {
    (report.accessibility && report.screen_recording) || age < RECHECK_MISSING
}

/// Whether `now` grants something `before` did not.
fn gained(before: &PermissionReport, now: &PermissionReport) -> bool {
    (now.accessibility && !before.accessibility)
        || (now.screen_recording && !before.screen_recording)
}

/// Serve one op, which codeg let through at Stop count `stop`. A driver call
/// that turns out to lack a permission the remembered answer says is granted
/// clears that answer, so the next call asks the system again rather than
/// going on believing it. (A refusal that came from the remembered answer
/// itself leaves it be: it is asked again on its own schedule.)
async fn handle(
    state: &HelperState,
    op: HelperOp,
    stop: u64,
) -> Result<serde_json::Value, HelperError> {
    let result = handle_op(state, op, stop).await;
    if let Err(HelperError {
        code: HelperErrorCode::PermissionMissing,
        permission: Some(permission),
        ..
    }) = &result
    {
        let mut last = state.permissions.lock().await;
        if last
            .as_ref()
            .is_some_and(|(report, _)| report.has(*permission))
        {
            last.take();
        }
    }
    result
}

async fn handle_op(
    state: &HelperState,
    op: HelperOp,
    stop: u64,
) -> Result<serde_json::Value, HelperError> {
    fn value(v: impl serde::Serialize) -> Result<serde_json::Value, HelperError> {
        serde_json::to_value(v).map_err(|e| HelperError::failed(format!("encode: {e}")))
    }
    match op {
        HelperOp::Configure {
            driver_path,
            driver_version,
        } => {
            if driver_version != driver::DRIVER_VERSION {
                return Err(HelperError::new(
                    HelperErrorCode::BadRequest,
                    format!(
                        "this helper runs cua-driver {}, not {driver_version}",
                        driver::DRIVER_VERSION
                    ),
                ));
            }
            let path = PathBuf::from(driver_path);
            let mut current = state.driver_path.lock().await;
            if current.as_ref() != Some(&path) {
                *current = Some(path);
                drop(current);
                // A driver started from another path is not the one codeg now
                // names; stop it, and the next call starts the right one.
                state.shutdown().await;
            }
            value(())
        }
        HelperOp::Permissions => value(state.permissions(true).await),
        HelperOp::ListApps => {
            let driver = state.driver(stop).await?;
            value(state.list_apps(&driver).await?)
        }
        HelperOp::FindApp { name, key } => {
            let driver = state.driver(stop).await?;
            value(ops::find_app(&driver, name.as_deref(), key.as_deref()).await?)
        }
        HelperOp::LaunchApp { app } => {
            let driver = state.driver(stop).await?;
            value(ops::launch_app(&driver, &app).await?)
        }
        HelperOp::ListWindows { pid } => {
            let driver = state.driver(stop).await?;
            value(state.list_windows(&driver, pid).await?)
        }
        HelperOp::ProcessStart { pid } => value(super::procinfo::process_start(pid)),
        HelperOp::Capture {
            pid,
            window_id,
            max_dimension,
        } => {
            state.require(OsPermission::ScreenRecording).await?;
            #[cfg(target_os = "macos")]
            if let Some(why) = state.out_of_sight(pid, window_id).await {
                return Err(ops::out_of_sight_capture(why));
            }
            let driver = state.driver(stop).await?;
            let captured = ops::capture(&driver, pid, window_id, max_dimension).await;
            // Where a capture replaces the window's snapshot, the refs from
            // the one before name nothing any more — whether or not this
            // capture is handed on.
            if ops::capture_replaces_snapshot() {
                state.snapshots().record(pid, window_id, None);
            }
            value(captured?)
        }
        HelperOp::Snapshot {
            pid,
            window_id,
            max_depth,
            max_elements,
            query,
            app_menus,
        } => {
            state.require(OsPermission::Accessibility).await?;
            let driver = state.driver(stop).await?;
            let (raw, facts) = ops::snapshot(
                &driver,
                pid,
                window_id,
                max_depth,
                max_elements,
                query,
                app_menus,
            )
            .await?;
            state.snapshots().record(pid, window_id, facts);
            value(raw)
        }
        HelperOp::Verify {
            pid,
            window_id,
            request,
        } => {
            if request.expect.iter().any(|p| p.element.is_some()) {
                state.require(OsPermission::Accessibility).await?;
            }
            let driver = state.driver(stop).await?;
            value(ops::verify(&driver, pid, window_id, &request).await?)
        }
        HelperOp::Act {
            pid,
            window_id,
            started_at,
            content,
            app_key,
            action,
            delivery: mode,
            clipboard: use_of,
        } => {
            // Asked first so a doomed action does not start a driver, and
            // again (inside `act`) just before each driver call goes out —
            // starting the driver and measuring the window take time in which
            // the screen can lock, the application quit or the person press
            // Stop.
            let delivery = state.delivery(pid, window_id, started_at, content, stop);
            delivery.check()?;
            for permission in act::permissions_for(&action) {
                state.require(*permission).await?;
            }
            let driver = state.driver(stop).await?;
            // Whatever pastes goes only while the clipboard is still what the
            // agent put there: asked as late as the helper can before it goes.
            let paste_ok = match use_of.paste {
                Some(expect) => {
                    let now = clipboard::stamp(&driver).await?;
                    now.value == expect && !now.concealed
                }
                None => false,
            };
            if !paste_ok && act::pastes(&action) {
                return Err(act::paste_refused());
            }
            let element_frame = {
                let book = state.snapshots();
                book.check(pid, window_id, &action, app_key.as_deref(), paste_ok)?;
                action
                    .element()
                    .and_then(|element| book.frame(pid, window_id, element))
            };
            let mut window_frame =
                act::check_points(&driver, pid, window_id, &action.points()).await?;
            let before = if use_of.track {
                Some(clipboard::stamp(&driver).await?)
            } else {
                None
            };
            let first = act::act(&driver, pid, window_id, &action, mode, &delivery, paste_ok).await;
            let done = match first {
                // The driver aims a point only by its snapshot's capture of
                // the window, and holds none just now — no snapshot taken
                // since it started, or one it let go. Nothing went out: it is
                // given a capture, the window is measured again (it may have
                // changed size meanwhile), and the action goes once more. The
                // capture becomes the window's snapshot, so the refs from the
                // one before name nothing any more.
                Err(e) if act::needs_capture(&e) => {
                    if ops::publish_capture(&driver, pid, window_id).await? {
                        state.snapshots().record(pid, window_id, None);
                    }
                    window_frame =
                        act::check_points(&driver, pid, window_id, &action.points()).await?;
                    act::act(&driver, pid, window_id, &action, mode, &delivery, paste_ok).await?
                }
                done => done?,
            };
            let copied = match before {
                Some(before) => clipboard::changed_since(&driver, before.value).await,
                None => None,
            };
            value(RawAct {
                element_frame,
                window_frame,
                clipboard: copied,
                ..done
            })
        }
        HelperOp::CaptureScreen {
            rules,
            max_dimension,
        } => {
            state.require(OsPermission::ScreenRecording).await?;
            screen_offered()?;
            let driver = state.driver(stop).await?;
            value(screen::capture(&driver, &rules, max_dimension).await?)
        }
        HelperOp::DriverReady => {
            state.driver(stop).await?;
            value(())
        }
        HelperOp::ActScreen {
            rules,
            action,
            geometry,
        } => {
            for permission in act::permissions_for(&action) {
                state.require(*permission).await?;
            }
            screen_offered()?;
            let driver = state.running_driver(stop).await?;
            // As for a window, minus the window: no Stop since, and a
            // session that is unlocked — asked again just before it goes.
            let stopped_now = state.stopped.clone();
            let ready = move || {
                if stopped_now.load(Ordering::Acquire) > stop {
                    return Err(stopped());
                }
                match session::state() {
                    session::SessionState::Unlocked => Ok(()),
                    session::SessionState::Locked => Err(HelperError::new(
                        HelperErrorCode::Paused,
                        "The screen is locked, or another user's session is active.",
                    )),
                    session::SessionState::Unknown => Err(HelperError::new(
                        HelperErrorCode::ActionFailed,
                        "codeg cannot tell whether this desktop's session is locked, so it does \
                         not act on the screen here.",
                    )),
                }
            };
            ready()?;
            value(screen::act(&driver, &rules, &action, geometry, ready).await?)
        }
        HelperOp::ClipboardRead { expect } => {
            let driver = state.driver(stop).await?;
            value(ops::clipboard_read(&driver, expect).await?)
        }
        HelperOp::ClipboardWrite { text } => {
            let driver = state.driver(stop).await?;
            value(ops::clipboard_write(&driver, &text).await?)
        }
        // The Stop was noted when its frame was read (see `serve`); what is
        // left is the driver.
        HelperOp::Halt { stop } => {
            state.halt(stop).await;
            value(())
        }
    }
}

/// Encode one message, or — for a reply too large for the channel — the
/// refusal that says so, so an oversized capture costs the caller one answer
/// rather than the connection.
fn encode(message: &HelperMessage) -> Vec<u8> {
    let bytes = serde_json::to_vec(message).unwrap_or_default();
    if bytes.len() <= MAX_FRAME_BYTES {
        return bytes;
    }
    let id = match message {
        HelperMessage::Reply(reply) => reply.id,
        HelperMessage::Ready(_) => 0,
    };
    serde_json::to_vec(&HelperMessage::Reply(HelperReply::error(
        id,
        HelperError::failed(format!(
            "the answer was {} bytes, more than the {MAX_FRAME_BYTES} a reply can carry; ask for a \
             smaller image",
            bytes.len()
        )),
    )))
    .unwrap_or_default()
}

/// How long, once codeg has gone, the helper waits for its driver to stop
/// before it exits anyway (the driver then sees its stdin close and exits on
/// its own). Long enough for a driver still starting to finish starting and
/// be stopped: past the file hash (after which a launch that meets a Stop
/// spawns nothing — see `DriverProc::launch`), a start is bounded by the
/// driver's handshake and configuration; one already running stops in
/// seconds.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(60);

/// Serve requests until codeg closes its end. Returns the exit code.
///
/// `guard`, when there is one, is asked before each request is acted on;
/// a request from anyone but the codeg that was checked ends the session.
pub async fn serve(
    mut reader: Box<dyn AsyncRead + Send + Unpin>,
    mut writer: Box<dyn AsyncWrite + Send + Unpin>,
    peer: PeerCheck,
    guard: Option<PeerGuard>,
) -> i32 {
    let (tx, mut rx) = mpsc::unbounded_channel::<HelperMessage>();
    let writer_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let bytes = encode(&message);
            let len = (bytes.len() as u32).to_le_bytes();
            if writer.write_all(&len).await.is_err()
                || writer.write_all(&bytes).await.is_err()
                || writer.flush().await.is_err()
            {
                break;
            }
        }
    });

    let _ = tx.send(HelperMessage::Ready(HelperReady {
        protocol: PROTOCOL_VERSION,
        version: env!("CARGO_PKG_VERSION").to_string(),
        peer,
        source: Some(SOURCE_FINGERPRINT.to_string()),
    }));

    let state = Arc::new(HelperState {
        driver_path: Mutex::new(None),
        driver: Mutex::new(None),
        apps: Mutex::new(AppCache::default()),
        snapshots: std::sync::Mutex::new(SnapshotBook::default()),
        stopped: Arc::new(AtomicU64::new(0)),
        permissions: Mutex::new(None),
        driver_saw: std::sync::Mutex::new(None),
        driver_stale: AtomicBool::new(false),
    });
    let mut code = EXIT_OK;
    loop {
        let request: HelperRequest = match read_frame(&mut reader).await {
            Ok(request) => request,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                // A frame that does not parse is not a request from the codeg
                // this helper was built with; stop rather than guess.
                tracing::error!("unreadable request: {e}");
                code = EXIT_FAILED;
                break;
            }
        };
        if guard.as_ref().is_some_and(|g| !g.still_peer()) {
            tracing::error!("a request came from a process other than the codeg that was checked");
            code = EXIT_PEER_REFUSED;
            break;
        }
        // A Stop takes hold the moment its frame is read, not when its task
        // is scheduled: whatever codeg let through before it meets it at the
        // next check it makes before a driver call — even one whose frame
        // is read later — and whatever codeg let through after it does not.
        if let HelperOp::Halt { stop } = request.op {
            state.stopped.fetch_max(stop, Ordering::AcqRel);
        }
        let state = state.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let reply = match handle(&state, request.op, request.stop).await {
                Ok(value) => HelperReply {
                    id: request.id,
                    ok: Some(value),
                    error: None,
                },
                Err(error) => HelperReply::error(request.id, error),
            };
            let _ = tx.send(HelperMessage::Reply(reply));
        });
    }
    // codeg is gone (or refused): stop the driver, and do not wait on the
    // requests still in flight — nobody is left to answer. As for a Stop,
    // nothing still in flight reaches a driver, and a driver still starting
    // stops itself once it has started.
    state.stopped.store(STOP_ALL, Ordering::Release);
    if tokio::time::timeout(SHUTDOWN_GRACE, state.shutdown())
        .await
        .is_err()
    {
        tracing::warn!("the driver did not stop in time; leaving it to its closed stdin");
    }
    writer_task.abort();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::protocol::write_frame;

    async fn start() -> (
        tokio::task::JoinHandle<i32>,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
        tokio::io::ReadHalf<tokio::io::DuplexStream>,
    ) {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (their_read, their_write) = tokio::io::split(theirs);
        let (our_read, our_write) = tokio::io::split(ours);
        let task = tokio::spawn(serve(
            Box::new(their_read),
            Box::new(their_write),
            PeerCheck::Development,
            None,
        ));
        (task, our_write, our_read)
    }

    /// The helper speaks first, answers by id, refuses an op that needs the
    /// driver before it is told where the driver is, and exits cleanly when
    /// its peer closes.
    #[tokio::test]
    async fn the_helper_greets_first_and_answers_by_id() {
        let (task, mut to_helper, mut from_helper) = start().await;
        let ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        assert!(matches!(
            ready,
            HelperMessage::Ready(HelperReady {
                protocol: PROTOCOL_VERSION,
                peer: PeerCheck::Development,
                source: Some(ref source),
                ..
            }) if source == SOURCE_FINGERPRINT
        ));

        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 7,
                op: HelperOp::ListApps,
                stop: 0,
            },
        )
        .await
        .unwrap();
        let HelperMessage::Reply(reply) = read_frame(&mut from_helper).await.unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.id, 7);
        assert_eq!(reply.error.unwrap().code, HelperErrorCode::NotConfigured);

        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 8,
                stop: 0,
                op: HelperOp::ProcessStart {
                    pid: std::process::id(),
                },
            },
        )
        .await
        .unwrap();
        let HelperMessage::Reply(reply) = read_frame(&mut from_helper).await.unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.id, 8);
        assert!(reply.decode::<Option<u64>>().unwrap().is_some());

        // A half of a duplex stream closes the direction only when told to;
        // dropping it while the read half lives would leave the helper
        // waiting on a peer that is still, as far as it can tell, there.
        to_helper.shutdown().await.unwrap();
        assert_eq!(task.await.unwrap(), EXIT_OK);
    }

    /// A Stop cuts off what codeg let through before it and holds nothing
    /// after it — by codeg's count, not by the order frames arrive in: an
    /// action from before the Stop is refused even when it arrives after the
    /// `Halt`, what comes from after it gets the answer it would have got
    /// with no Stop at all, and an older Stop arriving late changes nothing.
    #[tokio::test]
    async fn a_stop_cuts_off_what_came_before_it_and_nothing_after() {
        use crate::computer::keys::{Chord, Key, Modifiers};
        use crate::computer::protocol::WindowAction;
        async fn ask(
            to: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
            from: &mut tokio::io::ReadHalf<tokio::io::DuplexStream>,
            id: u64,
            op: HelperOp,
            stop: u64,
        ) -> HelperReply {
            write_frame(to, &HelperRequest { id, op, stop })
                .await
                .unwrap();
            let HelperMessage::Reply(reply) = read_frame(from).await.unwrap() else {
                panic!("expected a reply");
            };
            assert_eq!(reply.id, id);
            reply
        }
        let act = || HelperOp::Act {
            pid: std::process::id(),
            window_id: 1,
            started_at: crate::computer::procinfo::process_start(std::process::id()).unwrap(),
            content: None,
            app_key: None,
            action: WindowAction::Key {
                element: None,
                chord: Chord {
                    key: Key::Return,
                    modifiers: Modifiers::default(),
                },
            },
            delivery: Default::default(),
            clipboard: Default::default(),
        };
        let (task, mut to_helper, mut from_helper) = start().await;
        let _ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        let (to, from) = (&mut to_helper, &mut from_helper);
        let halt = |stop| HelperOp::Halt { stop };
        assert!(ask(to, from, 1, halt(2), 2).await.error.is_none());
        // Let through before the Stop, arriving after it.
        assert_eq!(
            ask(to, from, 2, act(), 1).await.error.unwrap().code,
            HelperErrorCode::Stopped
        );
        assert_eq!(
            ask(to, from, 3, HelperOp::ListApps, 1)
                .await
                .error
                .unwrap()
                .code,
            HelperErrorCode::Stopped
        );
        // From after it: the ordinary answers for a helper with no driver.
        assert_eq!(
            ask(to, from, 4, HelperOp::ListApps, 2)
                .await
                .error
                .unwrap()
                .code,
            HelperErrorCode::NotConfigured
        );
        assert_ne!(
            ask(to, from, 5, act(), 2).await.error.unwrap().code,
            HelperErrorCode::Stopped
        );
        // An older Stop arriving late cuts off nothing from after the newer.
        assert!(ask(to, from, 6, halt(1), 1).await.error.is_none());
        assert_eq!(
            ask(to, from, 7, HelperOp::ListApps, 2)
                .await
                .error
                .unwrap()
                .code,
            HelperErrorCode::NotConfigured
        );
        // codeg closing the helper ends everything.
        assert!(ask(to, from, 8, halt(STOP_ALL), STOP_ALL)
            .await
            .error
            .is_none());
        assert_eq!(
            ask(to, from, 9, HelperOp::ListApps, 2)
                .await
                .error
                .unwrap()
                .code,
            HelperErrorCode::Stopped
        );
        to_helper.shutdown().await.unwrap();
        assert_eq!(task.await.unwrap(), EXIT_OK);
    }

    /// A remembered "granted" stands; a remembered "missing" is asked again
    /// once it is a moment old. Only a permission that appeared — not one that
    /// went, nor one that was there all along — makes the running driver stale.
    #[test]
    fn a_missing_permission_is_asked_again_and_a_new_one_restarts_the_driver() {
        let report = |accessibility, screen_recording| PermissionReport {
            required: true,
            accessibility,
            screen_recording,
        };
        let long = RECHECK_MISSING + Duration::from_millis(1);
        assert!(answer_stands(&report(true, true), long));
        assert!(answer_stands(&report(true, false), Duration::ZERO));
        assert!(!answer_stands(&report(true, false), long));
        assert!(!answer_stands(&report(false, false), long));

        assert!(gained(&report(true, false), &report(true, true)));
        assert!(gained(&report(false, true), &report(true, true)));
        assert!(!gained(&report(true, true), &report(true, true)));
        assert!(!gained(&report(true, true), &report(false, true)));
        assert!(!gained(&report(false, false), &report(false, false)));
    }

    /// An action for a pid that is not the process the window was shared
    /// from — a relaunch under a reused pid — is refused before anything
    /// else is looked at.
    #[tokio::test]
    async fn an_action_for_another_process_is_refused() {
        use crate::computer::keys::{Chord, Key, Modifiers};
        use crate::computer::protocol::WindowAction;
        let (task, mut to_helper, mut from_helper) = start().await;
        let _ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        let started_at = crate::computer::procinfo::process_start(std::process::id()).unwrap();
        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 1,
                op: HelperOp::Act {
                    pid: std::process::id(),
                    window_id: 1,
                    started_at: started_at.wrapping_add(1),
                    content: None,
                    app_key: None,
                    action: WindowAction::Key {
                        element: None,
                        chord: Chord {
                            key: Key::Escape,
                            modifiers: Modifiers::default(),
                        },
                    },
                    delivery: Default::default(),
                    clipboard: Default::default(),
                },
                stop: 0,
            },
        )
        .await
        .unwrap();
        let HelperMessage::Reply(reply) = read_frame(&mut from_helper).await.unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.error.unwrap().code, HelperErrorCode::NoSuchWindow);
        to_helper.shutdown().await.unwrap();
        assert_eq!(task.await.unwrap(), EXIT_OK);
    }

    /// A configure for another driver release is refused rather than trusted.
    #[tokio::test]
    async fn a_configure_for_another_release_is_refused() {
        let (task, mut to_helper, mut from_helper) = start().await;
        let _ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 1,
                stop: 0,
                op: HelperOp::Configure {
                    driver_path: "/tmp/cua-driver".into(),
                    driver_version: "0.0.1".into(),
                },
            },
        )
        .await
        .unwrap();
        let HelperMessage::Reply(reply) = read_frame(&mut from_helper).await.unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.error.unwrap().code, HelperErrorCode::BadRequest);
        // A half of a duplex stream closes the direction only when told to;
        // dropping it while the read half lives would leave the helper
        // waiting on a peer that is still, as far as it can tell, there.
        to_helper.shutdown().await.unwrap();
        assert_eq!(task.await.unwrap(), EXIT_OK);
    }

    /// A reply too large for the channel becomes a refusal that says so,
    /// under the same id.
    #[test]
    fn an_oversized_reply_is_replaced_not_sent() {
        let huge = HelperMessage::Reply(HelperReply::ok(9, "x".repeat(MAX_FRAME_BYTES + 1)));
        let bytes = encode(&huge);
        assert!(bytes.len() < 1024);
        let HelperMessage::Reply(reply) = serde_json::from_slice(&bytes).unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.id, 9);
        assert!(reply.error.unwrap().message.contains("more than"));
    }
}
