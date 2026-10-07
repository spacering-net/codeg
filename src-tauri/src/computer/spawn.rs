//! `posix_spawn` with the two attributes computer use depends on, and a child
//! handle that cannot signal a recycled pid.
//!
//! * **Disclaim** (`responsibility_spawnattrs_setdisclaim`) makes the child
//!   its own TCC responsible process. codeg launches the helper this way, so
//!   the permissions the user grants land on the helper and not on codeg —
//!   where every agent's shell would inherit them. It is exported by
//!   libSystem but absent from the public headers, so it is looked up at run
//!   time; where it is missing, launching the helper fails rather than
//!   quietly charging its permissions to codeg.
//! * **A launch requirement** (see [`super::launch_req`]) has the kernel
//!   refuse any image that is not the one named, at `exec`, before it runs.
//!   This is what holds a spawn from a user-writable path to the pinned build:
//!   the file can be swapped after it was checked, but not past this.
//! * **Start suspended** (`POSIX_SPAWN_START_SUSPENDED`) lets the helper look
//!   at the image the kernel has just mapped before resuming it, and kill it
//!   instead. It is a second look, not a gate: a child started suspended is
//!   stopped by a signal, and any process of the same user may send the
//!   `SIGCONT` that starts it.
//!
//! Every spawn also sets `POSIX_SPAWN_CLOEXEC_DEFAULT`: the child gets exactly
//! the three descriptors named here and nothing else this process has open.

use std::ffi::{c_int, CString};
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// What the child's fd 0, 1 or 2 is.
#[derive(Debug, Clone, Copy)]
pub enum ChildFd {
    /// A descriptor of ours, duplicated into the child's slot.
    Inherit(RawFd),
    /// `/dev/null`.
    Null,
}

pub struct SpawnSpec<'a> {
    pub program: &'a Path,
    /// `argv[1..]`; `argv[0]` is the program path.
    pub args: &'a [&'a str],
    /// The child's whole environment. Nothing of this process's own is
    /// passed on unless it is listed here.
    pub env: &'a [(String, String)],
    pub stdio: [ChildFd; 3],
    pub disclaim: bool,
    pub suspended: bool,
    /// An encoded launch requirement the image must satisfy, or the kernel
    /// kills the child at `exec`.
    pub launch_requirement: Option<&'a [u8]>,
}

type DisclaimFn = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

fn disclaim_fn() -> Option<DisclaimFn> {
    static NAME: &[u8] = b"responsibility_spawnattrs_setdisclaim\0";
    // SAFETY: RTLD_DEFAULT with a NUL-terminated name; the symbol, when
    // present, has exactly this signature (libSystem, macOS 10.14+).
    let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, NAME.as_ptr().cast()) };
    if sym.is_null() {
        None
    } else {
        // SAFETY: see above.
        Some(unsafe { std::mem::transmute::<*mut libc::c_void, DisclaimFn>(sym) })
    }
}

/// Whether this system can launch a process as its own TCC principal.
pub fn can_disclaim() -> bool {
    disclaim_fn().is_some()
}

fn cstring(bytes: &[u8]) -> std::io::Result<CString> {
    CString::new(bytes).map_err(|_| std::io::Error::other("argument contains a NUL byte"))
}

/// Spawn per `spec`. Returns the child's handle; a suspended child stays
/// stopped until [`Child::resume`].
pub fn spawn(spec: &SpawnSpec<'_>) -> std::io::Result<Child> {
    let program = cstring(spec.program.as_os_str().as_bytes())?;
    let mut argv_owned = vec![program.clone()];
    for arg in spec.args {
        argv_owned.push(cstring(arg.as_bytes())?);
    }
    let mut argv: Vec<*mut libc::c_char> =
        argv_owned.iter().map(|s| s.as_ptr() as *mut _).collect();
    argv.push(std::ptr::null_mut());
    let env_owned: Vec<CString> = spec
        .env
        .iter()
        .map(|(k, v)| cstring(format!("{k}={v}").as_bytes()))
        .collect::<Result<_, _>>()?;
    let mut envp: Vec<*mut libc::c_char> = env_owned.iter().map(|s| s.as_ptr() as *mut _).collect();
    envp.push(std::ptr::null_mut());
    let dev_null = cstring(b"/dev/null")?;

    let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
    let mut actions: libc::posix_spawn_file_actions_t = std::ptr::null_mut();
    // SAFETY: plain initialisers of the two out-parameters, destroyed below on
    // every path.
    unsafe {
        check(libc::posix_spawnattr_init(&mut attr))?;
        if let Err(e) = check(libc::posix_spawn_file_actions_init(&mut actions)) {
            libc::posix_spawnattr_destroy(&mut attr);
            return Err(e);
        }
    }
    let result = (|| -> std::io::Result<libc::pid_t> {
        let mut flags = libc::POSIX_SPAWN_CLOEXEC_DEFAULT;
        if spec.suspended {
            flags |= libc::POSIX_SPAWN_START_SUSPENDED;
        }
        // SAFETY: `attr` / `actions` were initialised above; every pointer
        // passed below outlives the `posix_spawn` call that reads it.
        unsafe {
            check(libc::posix_spawnattr_setflags(
                &mut attr,
                flags as libc::c_short,
            ))?;
            if let Some(requirement) = spec.launch_requirement {
                super::launch_req::apply(&mut attr, requirement)?;
            }
            if spec.disclaim {
                let disclaim = disclaim_fn().ok_or_else(|| {
                    std::io::Error::other(
                        "this macOS cannot launch a process as its own TCC principal \
                         (responsibility_spawnattrs_setdisclaim is missing)",
                    )
                })?;
                check(disclaim(&mut attr, 1))?;
            }
            for (slot, fd) in spec.stdio.iter().enumerate() {
                let slot = slot as c_int;
                match *fd {
                    ChildFd::Inherit(fd) => {
                        check(libc::posix_spawn_file_actions_adddup2(
                            &mut actions,
                            fd,
                            slot,
                        ))?;
                    }
                    ChildFd::Null => {
                        let mode = if slot == 0 {
                            libc::O_RDONLY
                        } else {
                            libc::O_WRONLY
                        };
                        check(libc::posix_spawn_file_actions_addopen(
                            &mut actions,
                            slot,
                            dev_null.as_ptr(),
                            mode,
                            0,
                        ))?;
                    }
                }
            }
            let mut pid: libc::pid_t = 0;
            check(libc::posix_spawn(
                &mut pid,
                program.as_ptr(),
                &actions,
                &attr,
                argv.as_mut_ptr(),
                envp.as_mut_ptr(),
            ))?;
            Ok(pid)
        }
    })();
    // SAFETY: both were initialised above and are destroyed exactly once.
    unsafe {
        libc::posix_spawn_file_actions_destroy(&mut actions);
        libc::posix_spawnattr_destroy(&mut attr);
    }
    let pid = result?;
    Child::new(pid as u32)
}

/// `posix_spawn` and friends return the error number instead of setting
/// `errno`.
fn check(rc: c_int) -> std::io::Result<()> {
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(rc))
    }
}

#[derive(Debug, Default)]
struct ChildState {
    /// Set in the same critical section as the reap. Until the reap, the
    /// kernel keeps the pid reserved (a zombie), so a signal sent under this
    /// lock while this is `false` can only ever reach this child.
    reaped: bool,
    exit_status: Option<i32>,
}

/// A spawned child. Signals are sent only while the child is known to be
/// unreaped; exit is observed by a waiter thread that first waits for the exit
/// *without* reaping (a kqueue `NOTE_EXIT`, which fires when the child becomes
/// a zombie), then collects it under the lock with a `waitpid` that does not
/// block — so there is no moment at which this handle still believes in a pid
/// the kernel has already handed to someone else, and the lock is never held
/// while the child runs.
///
/// The watch is set up before the handle exists. A child whose exit could not
/// be watched is killed and collected on the spot rather than handed out: a
/// handle that cannot see its child exit could neither signal it safely nor
/// know when to stop.
#[derive(Debug, Clone)]
pub struct Child {
    pid: u32,
    state: Arc<Mutex<ChildState>>,
    exited: tokio::sync::watch::Receiver<bool>,
}

/// A kqueue registered for one child's `NOTE_EXIT`.
struct ExitWatch {
    kq: c_int,
    /// The registration found the child already gone (`ESRCH`): it is a
    /// zombie, there is nothing to wait for.
    exited: bool,
}

impl ExitWatch {
    fn register(pid: libc::pid_t) -> std::io::Result<Self> {
        // SAFETY: plain kqueue calls on a descriptor this value owns (closed
        // on drop); `change` is valid for the call that reads it.
        unsafe {
            let kq = libc::kqueue();
            if kq < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let watch = Self { kq, exited: false };
            let change = libc::kevent {
                ident: pid as libc::uintptr_t,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            if libc::kevent(kq, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) == 0 {
                return Ok(watch);
            }
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                return Ok(Self {
                    exited: true,
                    ..watch
                });
            }
            Err(err)
        }
    }

    /// Block until the child has exited, or the queue fails — after which the
    /// caller polls instead.
    fn wait(&self) {
        if self.exited {
            return;
        }
        // SAFETY: `event` is a valid out-parameter for the call.
        unsafe {
            let mut event: libc::kevent = std::mem::zeroed();
            loop {
                let n = libc::kevent(self.kq, std::ptr::null(), 0, &mut event, 1, std::ptr::null());
                if n > 0 {
                    return;
                }
                if n < 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
                {
                    return;
                }
            }
        }
    }
}

impl Drop for ExitWatch {
    fn drop(&mut self) {
        // SAFETY: closing the descriptor this value owns, once.
        unsafe { libc::close(self.kq) };
    }
}

/// Kill and collect a child no handle will be given for. Blocking is fine: a
/// `SIGKILL` ends even a stopped child.
fn discard(pid: libc::pid_t) {
    let mut status: c_int = 0;
    // SAFETY: our own unreaped child; nothing else holds its pid.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
        libc::waitpid(pid, &mut status, 0);
    }
}

/// How often the waiter looks again when the exit it was told of has not
/// happened yet (a failed queue, or a spurious wakeup).
const REAP_POLL: std::time::Duration = std::time::Duration::from_millis(50);

impl Child {
    fn new(pid: u32) -> std::io::Result<Self> {
        let raw = pid as libc::pid_t;
        let watch = match ExitWatch::register(raw) {
            Ok(watch) => watch,
            Err(e) => {
                discard(raw);
                return Err(e);
            }
        };
        let state = Arc::new(Mutex::new(ChildState::default()));
        let (tx, rx) = tokio::sync::watch::channel(false);
        let waiter_state = state.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("computer-child-{pid}"))
            .spawn(move || {
                watch.wait();
                loop {
                    {
                        let mut state = waiter_state.lock().unwrap_or_else(|p| p.into_inner());
                        let mut status: c_int = 0;
                        // SAFETY: collecting our own child. `WNOHANG`: under
                        // this lock a signal cannot be in flight to the pid
                        // being collected, and nothing waits here while the
                        // child still runs.
                        let rc = unsafe { libc::waitpid(raw, &mut status, libc::WNOHANG) };
                        if rc == raw {
                            state.reaped = true;
                            state.exit_status = Some(if libc::WIFEXITED(status) {
                                libc::WEXITSTATUS(status)
                            } else {
                                -libc::WTERMSIG(status)
                            });
                            break;
                        }
                        if rc < 0
                            && std::io::Error::last_os_error().kind()
                                != std::io::ErrorKind::Interrupted
                        {
                            // Not ours to collect any more: the pid must not be
                            // signalled again.
                            state.reaped = true;
                            break;
                        }
                    }
                    std::thread::sleep(REAP_POLL);
                }
                let _ = tx.send(true);
            });
        if let Err(e) = spawned {
            discard(raw);
            return Err(e);
        }
        Ok(Self {
            pid,
            state,
            exited: rx,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    fn signal(&self, sig: c_int) -> std::io::Result<()> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.reaped {
            return Err(std::io::Error::other("the child has already exited"));
        }
        // SAFETY: the pid is our unreaped child (checked under the lock the
        // waiter takes before reaping).
        let rc = unsafe { libc::kill(self.pid as libc::pid_t, sig) };
        if rc == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    /// Let a suspended child run.
    pub fn resume(&self) -> std::io::Result<()> {
        self.signal(libc::SIGCONT)
    }

    /// Ask the child to stop.
    pub fn terminate(&self) {
        let _ = self.signal(libc::SIGTERM);
    }

    /// Stop the child outright. A suspended child ignores nothing but this and
    /// `SIGCONT`, which is why a child that failed its checks is killed rather
    /// than asked.
    pub fn kill(&self) {
        let _ = self.signal(libc::SIGKILL);
    }

    pub fn has_exited(&self) -> bool {
        *self.exited.borrow()
    }

    /// Wait for the child to exit and be collected.
    pub async fn wait(&self) -> Option<i32> {
        let mut rx = self.exited.clone();
        let _ = rx.wait_for(|done| *done).await;
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .exit_status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Vec<(String, String)> {
        vec![("PATH".into(), "/usr/bin:/bin".into())]
    }

    /// A suspended child does not run until resumed, then runs with exactly
    /// the environment it was given.
    #[tokio::test]
    async fn a_suspended_child_runs_only_once_resumed() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let script = format!("printf '%s' \"$ONLY_THIS\" > '{}'", marker.display());
        let env = vec![("ONLY_THIS".to_string(), "yes".to_string())];
        let child = spawn(&SpawnSpec {
            program: Path::new("/bin/sh"),
            args: &["-c", &script],
            env: &env,
            stdio: [ChildFd::Null, ChildFd::Null, ChildFd::Null],
            disclaim: false,
            suspended: true,
            launch_requirement: None,
        })
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!marker.exists(), "a suspended child must not have run");
        child.resume().unwrap();
        assert_eq!(child.wait().await, Some(0));
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "yes");
        // Collected: no further signal can go to that pid.
        assert!(child.resume().is_err());
    }

    /// An image that does not satisfy the launch requirement is killed at
    /// `exec`, before it runs a single instruction — even though nothing
    /// here ever resumes or checks it.
    #[tokio::test]
    async fn an_image_outside_its_launch_requirement_never_runs() {
        use super::super::launch_req::{held_here, supported};
        if !supported() || !held_here() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let script = format!("touch '{}'", marker.display());
        // /bin/sh is Apple's, not a Developer ID build of this team's.
        let requirement = super::super::launch_req::signed_by("ABCDE12345", "not-sh");
        let child = spawn(&SpawnSpec {
            program: Path::new("/bin/sh"),
            args: &["-c", &script],
            env: &env(),
            stdio: [ChildFd::Null, ChildFd::Null, ChildFd::Null],
            disclaim: false,
            suspended: false,
            launch_requirement: Some(&requirement),
        })
        .unwrap();
        assert_eq!(child.wait().await, Some(-libc::SIGKILL));
        assert!(!marker.exists());
    }

    /// A killed suspended child never runs.
    #[tokio::test]
    async fn a_killed_suspended_child_never_runs() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let script = format!("touch '{}'", marker.display());
        let child = spawn(&SpawnSpec {
            program: Path::new("/bin/sh"),
            args: &["-c", &script],
            env: &env(),
            stdio: [ChildFd::Null, ChildFd::Null, ChildFd::Null],
            disclaim: false,
            suspended: true,
            launch_requirement: None,
        })
        .unwrap();
        child.kill();
        assert_eq!(child.wait().await, Some(-libc::SIGKILL));
        assert!(!marker.exists());
    }

    /// Only the three named descriptors reach the child.
    #[tokio::test]
    async fn the_child_inherits_nothing_but_its_stdio() {
        use std::io::Read;
        let (mut read_end, write_end) = std::os::unix::net::UnixStream::pair().unwrap();
        use std::os::fd::AsRawFd;
        // A descriptor this process holds that is NOT one of the three; the
        // child lists what it has and must not see it.
        let stray = std::fs::File::open("/dev/null").unwrap();
        let script = format!(
            "for fd in 0 1 2 {}; do if [ -e /dev/fd/$fd ]; then printf '%s ' $fd; fi; done",
            stray.as_raw_fd()
        );
        let child = spawn(&SpawnSpec {
            program: Path::new("/bin/sh"),
            args: &["-c", &script],
            env: &env(),
            stdio: [
                ChildFd::Null,
                ChildFd::Inherit(write_end.as_raw_fd()),
                ChildFd::Null,
            ],
            disclaim: false,
            suspended: false,
            launch_requirement: None,
        })
        .unwrap();
        drop(write_end);
        assert_eq!(child.wait().await, Some(0));
        let mut out = String::new();
        read_end.read_to_string(&mut out).unwrap();
        assert_eq!(out.trim(), "0 1 2");
    }
}
