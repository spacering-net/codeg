//! Launch the driver, hold it to the pins, and talk to it.
//!
//! On macOS the driver runs with the helper's TCC grants, which makes three
//! things about how it is started part of the security boundary:
//!
//! * **What runs.** The file is hashed against the pinned digest (which
//!   catches a damaged download early), then spawned under a launch
//!   requirement naming trycua's Team ID, the driver's identifier and the
//!   pinned cdhashes — the kernel kills any other image at `exec`, before it
//!   runs, which is what holds even if the file is swapped after it was
//!   hashed. The child starts suspended, and the *running image* is checked
//!   again (designated requirement plus cdhash, hardened runtime, the exact
//!   entitlement list) before it is resumed. Where the kernel cannot take a
//!   launch requirement (macOS before 14.4) the driver is not started at
//!   all: the suspended check alone is not a gate, because any process of
//!   the user's may resume a suspended child.
//! * **What it finds on `PATH`.** The driver runs `plutil`, `ps` and
//!   `osascript` by bare name. codeg's own `PATH` carries directories the user
//!   (and so any agent) can write — the login shell's, `~/.codeg/npm-global/bin`
//!   first of all, Homebrew's — and a fake `ps` in one of them would run with
//!   the helper's grants the next time the driver lists applications. So the
//!   driver gets a fixed system `PATH` and nothing else from this process's
//!   environment.
//! * **What else it inherits.** Nothing: exactly three descriptors, a fresh
//!   home directory per launch (the driver reads its configuration from
//!   there), telemetry and the update check off, and embedded mode, which
//!   only ever removes capability (no disclaim re-exec, no relaunch as its
//!   own app, no permission prompts).
//!
//! On Windows and Linux the same environment rules apply for the same
//! reasons, and the file is hashed before every launch; there is no running
//! image to check, and no TCC grant for a replacement to borrow.
//!
//! The same pinned build also answers the helper's permission questions on
//! macOS ([`probe_permissions`]): a copy started only to report what TCC says
//! and exit, under the same launch requirement and checks.
//!
//! Two settings in that home decide how the driver behaves over a long life:
//!
//! * **Its session never idles out.** The driver ends a caller's session
//!   after five idle minutes, and with it every snapshot the session holds —
//!   every ref, and the capture a point is aimed by — and the helper's
//!   driver lives for as long as computer use is on.
//! * **It captures windows at their own size.** The driver converts a click's
//!   pixel coordinates by the scale of the capture in the window's latest
//!   snapshot, at whatever size it was taken — one taken smaller in between
//!   would move every later click. At full size there is no scale to
//!   remember: the helper shrinks images itself, asks the driver for no other
//!   size, and a point is always the window's own pixel.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use super::mcp::{McpClient, McpError, ToolCallResult};
use crate::computer::driver::{self, DriverArtifact};
#[cfg(target_os = "macos")]
use crate::computer::protocol::PermissionReport;
use crate::computer::protocol::{HelperError, HelperErrorCode};

/// How long the driver has to finish the MCP handshake.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the driver has to report its configuration after the handshake.
const CONFIG_TIMEOUT: Duration = Duration::from_secs(10);

/// The driver's idle-session timeout, in seconds: ten years, which is to say
/// never. The driver treats `0` as "use the default" (five minutes).
const SESSION_IDLE_TTL_SECS: &str = "315360000";

/// The driver's configuration file, relative to its home: captures at the
/// window's own size (`0` is "no limit"). See the module note.
const DRIVER_CONFIG: &[u8] = br#"{"max_image_dimension":0}"#;

/// The argument that has the pinned driver answer one question and exit:
/// what TCC lets its responsible process — the helper — do. Checked by the
/// driver before anything else runs, logging and telemetry included.
#[cfg(target_os = "macos")]
const PERMISSION_PROBE_ARG: &str = "--cua-internal-permission-probe";

/// How long a permission probe has to answer.
#[cfg(target_os = "macos")]
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// The most a probe may print; its answer is one short line.
#[cfg(target_os = "macos")]
const MAX_PROBE_OUTPUT: u64 = 4096;

/// Where the helper keeps the driver's per-launch home directories.
///
/// Computed from the account database, not from `$HOME`: the helper's
/// decisions do not read the environment it inherited.
pub fn helper_data_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let home = account_home_dir()?;
        let base = if cfg!(target_os = "macos") {
            home.join("Library").join("Application Support")
        } else {
            home.join(".local").join("share")
        };
        Some(base.join("app.codeg").join("computer-helper"))
    }
    #[cfg(windows)]
    {
        dirs::data_local_dir().map(|d| d.join("app.codeg").join("computer-helper"))
    }
}

/// This user's home directory from `getpwuid_r`.
#[cfg(unix)]
fn account_home_dir() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: all out-parameters point at live, correctly sized storage.
    let rc = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    // SAFETY: `pw_dir` points into `buf`, NUL-terminated by getpwuid_r.
    let dir = unsafe { CStr::from_ptr(pwd.pw_dir) };
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
}

/// The driver's whole environment for one launch. See the module note.
pub fn driver_environment(run_dir: &Path) -> Vec<(String, String)> {
    driver_environment_with(run_dir, |key| std::env::var(key).ok())
}

/// [`driver_environment`], reading the few variables it passes through
/// (Windows' system root; Linux's display and session bus) with `lookup`.
/// Nothing else of the helper's environment is ever consulted.
fn driver_environment_with(
    run_dir: &Path,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let run = run_dir.to_string_lossy().to_string();
    let tmp = run_dir.join("tmp").to_string_lossy().to_string();
    let mut env: Vec<(String, String)> = vec![
        ("CUA_DRIVER_RS_TELEMETRY_ENABLED".into(), "false".into()),
        ("CUA_TELEMETRY_ENABLED".into(), "false".into()),
        ("CUA_DRIVER_RS_UPDATE_CHECK".into(), "false".into()),
        ("CUA_DRIVER_EMBEDDED".into(), "1".into()),
        (
            "CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS".into(),
            SESSION_IDLE_TTL_SECS.into(),
        ),
    ];
    if cfg!(windows) {
        let system_root = lookup("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        env.extend([
            (
                "PATH".into(),
                format!(r"{system_root}\System32;{system_root};{system_root}\System32\Wbem"),
            ),
            ("SystemRoot".into(), system_root.clone()),
            ("windir".into(), system_root),
            ("TEMP".into(), tmp.clone()),
            ("TMP".into(), tmp),
            ("LOCALAPPDATA".into(), run.clone()),
            ("APPDATA".into(), run.clone()),
            ("USERPROFILE".into(), run),
        ]);
    } else {
        env.extend([
            ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("HOME".into(), run),
            ("TMPDIR".into(), format!("{tmp}/")),
        ]);
    }
    // Linux: the driver cannot find the display, the accessibility bus or
    // the session's runtime directory without these. X11 is not a boundary
    // against a same-user process to begin with, so passing the session's own
    // addresses through costs nothing the platform had not already given.
    if cfg!(target_os = "linux") {
        for key in [
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XAUTHORITY",
            "XDG_RUNTIME_DIR",
            "XDG_SESSION_TYPE",
            "XDG_CURRENT_DESKTOP",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            if let Some(value) = lookup(key) {
                env.push((key.into(), value));
            }
        }
    }
    env
}

/// Write the driver's configuration file into its home — `$HOME` on macOS and
/// Linux, `%USERPROFILE%` on Windows, both the run directory. See the module
/// note for what it sets.
fn write_driver_config(run_dir: &Path) -> std::io::Result<()> {
    let dir = run_dir.join(".cua-driver");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("config.json"), DRIVER_CONFIG)
}

/// Hex SHA-256 of a file.
fn file_sha256(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn rejected(why: impl Into<String>) -> HelperError {
    HelperError::new(HelperErrorCode::DriverRejected, why)
}

fn unavailable(why: impl Into<String>) -> HelperError {
    HelperError::new(HelperErrorCode::DriverUnavailable, why)
}

/// The designated requirement the running driver must satisfy: trycua's
/// signing identity AND one of the pinned builds.
pub fn driver_requirement() -> String {
    let builds = driver::DRIVER_CDHASHES
        .iter()
        .map(|h| format!("cdhash H\"{h}\""))
        .collect::<Vec<_>>()
        .join(" or ");
    format!("({}) and ({builds})", driver::DRIVER_DESIGNATED_REQUIREMENT)
}

enum ChildProc {
    #[cfg(target_os = "macos")]
    Mac(crate::computer::spawn::Child),
    #[cfg(not(target_os = "macos"))]
    Tokio {
        child: tokio::sync::Mutex<tokio::process::Child>,
        exited: std::sync::atomic::AtomicBool,
    },
}

/// A running, verified driver.
pub struct DriverProc {
    client: Arc<McpClient>,
    child: ChildProc,
    run_dir: PathBuf,
    /// The driver said it captures windows at their own size (see the module
    /// note). Without it a capture's pixels cannot be mapped back to the
    /// window's, and nothing may be pointed at by coordinates.
    full_size_captures: bool,
}

impl DriverProc {
    /// Launch the driver at `path` for this platform's pin. Fails with
    /// [`HelperErrorCode::DriverRejected`] for any file or image that is not
    /// the pinned build, and [`HelperErrorCode::DriverUnavailable`] for one
    /// that is and would not start.
    ///
    /// `stopped` is asked once more just before the driver is spawned, after
    /// the file has been hashed — which takes as long as the disk makes it —
    /// so a Stop, or codeg leaving, while that runs spawns nothing, and what
    /// is left of a start once a driver exists is bounded (see `SHUTDOWN_GRACE`
    /// in the helper).
    pub async fn launch(
        path: &Path,
        artifact: &DriverArtifact,
        stopped: impl Fn() -> Result<(), HelperError>,
    ) -> Result<Self, HelperError> {
        if !path.is_absolute() {
            return Err(rejected("the driver path is not absolute"));
        }
        let digest = file_sha256(path).map_err(|e| {
            unavailable(format!(
                "could not read the driver at {}: {e}",
                path.display()
            ))
        })?;
        if digest != artifact.executable_sha256 {
            return Err(rejected(format!(
                "{} is not the pinned cua-driver {} (sha256 {digest})",
                path.display(),
                driver::DRIVER_VERSION
            )));
        }

        let base =
            helper_data_dir().ok_or_else(|| unavailable("no home directory for this account"))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let run_dir = base
            .join("runs")
            .join(format!("{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(run_dir.join("tmp"))
            .map_err(|e| unavailable(format!("could not create {}: {e}", run_dir.display())))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700));
        }
        if let Err(e) = write_driver_config(&run_dir) {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(unavailable(format!(
                "could not write the driver's configuration: {e}"
            )));
        }
        let env = driver_environment(&run_dir);

        if let Err(halted) = stopped() {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(halted);
        }
        let launched = Self::spawn(path, &env, &run_dir).await;
        let (child, reader, writer, stderr) = match launched {
            Ok(parts) => parts,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&run_dir);
                return Err(e);
            }
        };
        tokio::spawn(forward_stderr(stderr));
        let client = McpClient::start(reader, writer);
        let mut proc = Self {
            client,
            child,
            run_dir,
            full_size_captures: false,
        };
        if let Err(e) = proc.client.initialize(INITIALIZE_TIMEOUT).await {
            proc.shutdown().await;
            return Err(unavailable(format!("the driver did not start: {e}")));
        }
        proc.full_size_captures = proc.captures_at_full_size().await;
        if !proc.full_size_captures {
            tracing::warn!(
                "the driver did not take its full-size capture setting; pointing by \
                 coordinates is off for this driver"
            );
        }
        Ok(proc)
    }

    /// Whether the driver runs with the configuration written for it: no
    /// ceiling on a capture's size. Asked, not assumed — a driver that read
    /// its configuration from somewhere else would scale every capture and
    /// every click with it.
    async fn captures_at_full_size(&self) -> bool {
        match self
            .client
            .call_tool("get_config", serde_json::json!({}), CONFIG_TIMEOUT)
            .await
        {
            Ok(result) if !result.is_error => {
                result
                    .structured
                    .as_ref()
                    .and_then(|s| s.get("max_image_dimension"))
                    .and_then(Value::as_u64)
                    == Some(0)
            }
            _ => false,
        }
    }

    /// See [`DriverProc::full_size_captures`].
    pub fn full_size_captures(&self) -> bool {
        self.full_size_captures
    }

    #[cfg(target_os = "macos")]
    #[allow(clippy::type_complexity)]
    async fn spawn(
        path: &Path,
        env: &[(String, String)],
        _run_dir: &Path,
    ) -> Result<
        (
            ChildProc,
            Box<dyn AsyncRead + Send + Unpin>,
            Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
            Box<dyn AsyncRead + Send + Unpin>,
        ),
        HelperError,
    > {
        use crate::computer::spawn::{spawn, ChildFd, SpawnSpec};
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;

        // One socket for stdin+stdout (the driver reads and writes MCP on it),
        // one for stderr. A socket is as good as a pipe to the driver, and a
        // single bidirectional one is one descriptor to hand over instead of
        // two.
        let (io_ours, io_theirs) =
            UnixStream::pair().map_err(|e| unavailable(format!("socketpair: {e}")))?;
        let (err_ours, err_theirs) =
            UnixStream::pair().map_err(|e| unavailable(format!("socketpair: {e}")))?;
        let requirement = driver_launch_requirement()?;
        let child = spawn(&SpawnSpec {
            program: path,
            args: &["mcp", "--direct", "--no-overlay"],
            env,
            stdio: [
                ChildFd::Inherit(io_theirs.as_raw_fd()),
                ChildFd::Inherit(io_theirs.as_raw_fd()),
                ChildFd::Inherit(err_theirs.as_raw_fd()),
            ],
            // The driver's TCC requests must be charged to the helper, which
            // is the whole reason it runs under the helper.
            disclaim: false,
            suspended: true,
            launch_requirement: Some(&requirement),
        })
        .map_err(|e| unavailable(format!("could not start the driver: {e}")))?;
        drop(io_theirs);
        drop(err_theirs);

        if let Err(why) = verify_running_driver(child.pid()) {
            child.kill();
            let _ = child.wait().await;
            return Err(rejected(why));
        }
        if let Err(e) = child.resume() {
            child.kill();
            return Err(unavailable(format!("could not resume the driver: {e}")));
        }

        let to_tokio = |s: UnixStream| -> Result<tokio::net::UnixStream, HelperError> {
            s.set_nonblocking(true)
                .and_then(|_| tokio::net::UnixStream::from_std(s))
                .map_err(|e| unavailable(format!("socket: {e}")))
        };
        let (reader, writer) = to_tokio(io_ours)?.into_split();
        let (err_reader, _) = to_tokio(err_ours)?.into_split();
        Ok((
            ChildProc::Mac(child),
            Box::new(reader),
            Box::new(writer),
            Box::new(err_reader),
        ))
    }

    #[cfg(not(target_os = "macos"))]
    #[allow(clippy::type_complexity)]
    async fn spawn(
        path: &Path,
        env: &[(String, String)],
        run_dir: &Path,
    ) -> Result<
        (
            ChildProc,
            Box<dyn AsyncRead + Send + Unpin>,
            Box<dyn tokio::io::AsyncWrite + Send + Unpin>,
            Box<dyn AsyncRead + Send + Unpin>,
        ),
        HelperError,
    > {
        let mut command = tokio::process::Command::new(path);
        command
            .args(["mcp", "--direct", "--no-overlay"])
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(run_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| unavailable(format!("could not start the driver: {e}")))?;
        let stdin = child.stdin.take().ok_or_else(|| unavailable("no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| unavailable("no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| unavailable("no stderr"))?;
        Ok((
            ChildProc::Tokio {
                child: tokio::sync::Mutex::new(child),
                exited: std::sync::atomic::AtomicBool::new(false),
            },
            Box::new(stdout),
            Box::new(stdin),
            Box::new(stderr),
        ))
    }

    /// Whether the driver is still there to answer.
    pub fn alive(&self) -> bool {
        if self.client.is_closed() {
            return false;
        }
        match &self.child {
            #[cfg(target_os = "macos")]
            ChildProc::Mac(child) => !child.has_exited(),
            #[cfg(not(target_os = "macos"))]
            ChildProc::Tokio { exited, .. } => !exited.load(std::sync::atomic::Ordering::Acquire),
        }
    }

    pub async fn call(
        &self,
        tool: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<ToolCallResult, HelperError> {
        let result = self
            .client
            .call_tool(tool, arguments, timeout)
            .await
            .map_err(|e| match e {
                McpError::Closed => unavailable("the driver exited"),
                McpError::Timeout => {
                    HelperError::failed(format!("the driver did not answer {tool} in time"))
                }
                other => HelperError::failed(other.to_string()),
            })?;
        if result.is_error && result.code() == Some("session_ended") {
            // A driver whose session has ended refuses everything from then
            // on. It should not happen (the session is set never to idle
            // out); if it does, this driver is done and the next call starts
            // another.
            self.client.close();
            return Err(unavailable(
                "the driver ended its session; it is started again on the next call",
            ));
        }
        Ok(result)
    }

    /// Kill the driver at once — no time to finish what it is doing — and
    /// remove its home directory. Every call waiting on it fails now rather
    /// than when the pipe closes.
    pub async fn kill(&self) {
        self.client.close();
        match &self.child {
            #[cfg(target_os = "macos")]
            ChildProc::Mac(child) => {
                child.kill();
                let _ = child.wait().await;
            }
            #[cfg(not(target_os = "macos"))]
            ChildProc::Tokio { child, exited } => {
                let mut child = child.lock().await;
                let _ = child.start_kill();
                let _ = child.wait().await;
                exited.store(true, std::sync::atomic::Ordering::Release);
            }
        }
        let _ = std::fs::remove_dir_all(&self.run_dir);
    }

    /// Stop the driver and remove its home directory.
    pub async fn shutdown(&self) {
        match &self.child {
            #[cfg(target_os = "macos")]
            ChildProc::Mac(child) => {
                child.terminate();
                if tokio::time::timeout(Duration::from_secs(2), child.wait())
                    .await
                    .is_err()
                {
                    child.kill();
                    let _ = child.wait().await;
                }
            }
            #[cfg(not(target_os = "macos"))]
            ChildProc::Tokio { child, exited } => {
                let mut child = child.lock().await;
                let _ = child.start_kill();
                let _ = child.wait().await;
                exited.store(true, std::sync::atomic::Ordering::Release);
            }
        }
        let _ = std::fs::remove_dir_all(&self.run_dir);
    }
}

/// Which of the helper's permissions are in force, as a fresh copy of the
/// pinned driver at `path` reports them.
///
/// A fresh process because macOS keeps a process's first "not granted" for
/// the rest of its life: the helper asking itself would go on hearing "no"
/// after the person has said yes in System Settings. (Raising a request is
/// not done here: the driver's own request asks for every missing
/// permission at once, and a person who pressed the button for one should
/// see the dialog for that one — codeg starts a helper for each instead.)
/// The copy does not disclaim, so TCC answers it for its responsible
/// process, the helper; and
/// it is started as the driver is — under the launch requirement, suspended,
/// its running image checked, then resumed — since it runs with the helper's
/// grants too. (The file is not hashed first: the kernel refuses any other
/// image, and a damaged download is the next launch's to report.)
#[cfg(target_os = "macos")]
pub async fn probe_permissions(path: &Path) -> Result<PermissionReport, HelperError> {
    use crate::computer::spawn::{spawn, ChildFd, SpawnSpec};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use tokio::io::AsyncReadExt;

    #[derive(serde::Deserialize)]
    struct Probe {
        accessibility: bool,
        screen_recording: bool,
    }

    if !path.is_absolute() {
        return Err(rejected("the driver path is not absolute"));
    }
    // The driver's own environment, homed in the helper's directory: the
    // probe reads nothing from there, and gets nothing of the helper's.
    let home =
        helper_data_dir().ok_or_else(|| unavailable("no home directory for this account"))?;
    let env = driver_environment(&home);
    let (ours, theirs) = UnixStream::pair().map_err(|e| unavailable(format!("socketpair: {e}")))?;
    let requirement = driver_launch_requirement()?;
    let child = spawn(&SpawnSpec {
        program: path,
        args: &[PERMISSION_PROBE_ARG],
        env: &env,
        stdio: [
            ChildFd::Null,
            ChildFd::Inherit(theirs.as_raw_fd()),
            ChildFd::Null,
        ],
        disclaim: false,
        suspended: true,
        launch_requirement: Some(&requirement),
    })
    .map_err(|e| unavailable(format!("could not start the permission check: {e}")))?;
    drop(theirs);
    if let Err(why) = verify_running_driver(child.pid()) {
        child.kill();
        let _ = child.wait().await;
        return Err(rejected(why));
    }
    if let Err(e) = child.resume() {
        child.kill();
        let _ = child.wait().await;
        return Err(unavailable(format!(
            "could not resume the permission check: {e}"
        )));
    }
    let read = async {
        ours.set_nonblocking(true)?;
        let stream = tokio::net::UnixStream::from_std(ours)?;
        let mut out = Vec::new();
        stream
            .take(MAX_PROBE_OUTPUT + 1)
            .read_to_end(&mut out)
            .await?;
        std::io::Result::Ok(out)
    };
    let out = tokio::time::timeout(PROBE_TIMEOUT, read).await;
    // Done or not, it is not left behind.
    child.kill();
    let _ = child.wait().await;
    let out = match out {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return Err(unavailable(format!(
                "could not read the permission check: {e}"
            )))
        }
        Err(_) => return Err(unavailable("the permission check did not answer in time")),
    };
    if out.len() as u64 > MAX_PROBE_OUTPUT {
        return Err(HelperError::failed(
            "the permission check answered with more than one short line",
        ));
    }
    let probe: Probe = serde_json::from_slice(out.trim_ascii())
        .map_err(|e| HelperError::failed(format!("the permission check answered oddly: {e}")))?;
    Ok(PermissionReport {
        required: true,
        accessibility: probe.accessibility,
        screen_recording: probe.screen_recording,
    })
}

/// The kernel-held form of the pins: trycua's Developer ID, the driver's
/// identifier, one of the pinned builds.
#[cfg(target_os = "macos")]
fn driver_launch_requirement() -> Result<Vec<u8>, HelperError> {
    crate::computer::launch_req::pinned_build(
        driver::DRIVER_TEAM_ID,
        driver::DRIVER_SIGNING_ID,
        driver::DRIVER_CDHASHES,
    )
    .ok_or_else(|| rejected("the driver's pinned cdhashes are malformed"))
}

/// Everything the running image must be. See the module note.
#[cfg(target_os = "macos")]
fn verify_running_driver(pid: u32) -> Result<(), String> {
    use crate::computer::codesign::{
        check_guest, running_cdhash, running_status, Guest, CS_DEBUGGED, CS_GET_TASK_ALLOW,
        CS_RUNTIME, CS_VALID,
    };
    let info = check_guest(Guest::ChildPid(pid), &driver_requirement())
        .map_err(|e| format!("the driver's signature is not the pinned build's: {e}"))?;
    let cdhash =
        running_cdhash(pid).map_err(|e| format!("could not read the driver's cdhash: {e}"))?;
    if !driver::DRIVER_CDHASHES.contains(&cdhash.as_str()) {
        return Err(format!(
            "the running driver's cdhash {cdhash} is not a pinned build"
        ));
    }
    let status =
        running_status(pid).map_err(|e| format!("could not read the driver's status: {e}"))?;
    if status & CS_VALID == 0 {
        return Err("the running driver is not validly signed".into());
    }
    if status & CS_RUNTIME == 0 || info.flags.unwrap_or(0) & CS_RUNTIME == 0 {
        return Err("the driver does not run with the hardened runtime".into());
    }
    if status & (CS_GET_TASK_ALLOW | CS_DEBUGGED) != 0 {
        return Err("the driver can be attached to by a debugger".into());
    }
    driver::driver_entitlements_ok(&info.entitlements)
}

/// Copy the driver's stderr into the helper's, which codeg logs.
async fn forward_stderr(stderr: Box<dyn AsyncRead + Send + Unpin>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::warn!(target: "cua_driver", "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The driver's environment is built from nothing: a fixed system PATH, a
    /// private home, and the switches that turn off everything that talks to
    /// the network. Even when every variable the helper might look at is set
    /// to something hostile, only the named pass-throughs are ever read.
    #[test]
    fn the_driver_inherits_no_environment() {
        let run = Path::new(if cfg!(windows) { r"C:\run" } else { "/run/x" });
        let asked = std::cell::RefCell::new(Vec::new());
        let env = driver_environment_with(run, |key| {
            asked.borrow_mut().push(key.to_string());
            Some(format!("/hostile/{key}"))
        });
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        for leaked in [
            "DEVELOPER_DIR",
            "DYLD_INSERT_LIBRARIES",
            "CUA_DRIVER_PERMISSION_MODE",
        ] {
            assert_eq!(get(leaked), None, "{leaked} must not reach the driver");
            assert!(!asked.borrow().iter().any(|k| k == leaked));
        }
        if !cfg!(windows) {
            assert_eq!(get("PATH"), Some("/usr/bin:/bin:/usr/sbin:/sbin"));
            assert_eq!(get("HOME"), Some("/run/x"));
        }
        if cfg!(target_os = "macos") {
            // Nothing at all is read from the environment on macOS.
            assert!(asked.borrow().is_empty(), "{:?}", asked.borrow());
        }
        assert_eq!(get("CUA_DRIVER_RS_TELEMETRY_ENABLED"), Some("false"));
        assert_eq!(get("CUA_DRIVER_RS_UPDATE_CHECK"), Some("false"));
        assert_eq!(get("CUA_DRIVER_EMBEDDED"), Some("1"));
        // A session that idled out would refuse every later call.
        let ttl: u64 = get("CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS")
            .and_then(|v| v.parse().ok())
            .expect("an idle timeout");
        assert!(ttl >= 365 * 24 * 60 * 60, "{ttl}");
    }

    /// The configuration lands where the driver reads it — its home, which is
    /// the run directory on every platform — and asks for full-size captures.
    #[test]
    fn the_driver_is_configured_for_full_size_captures() {
        let run = tempfile::tempdir().unwrap();
        write_driver_config(run.path()).unwrap();
        let written: Value = serde_json::from_slice(
            &std::fs::read(run.path().join(".cua-driver").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(written["max_image_dimension"], 0);
        let env = driver_environment(run.path());
        let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        assert!(env
            .iter()
            .any(|(k, v)| k == home_key && Path::new(v) == run.path()));
    }

    #[test]
    fn the_requirement_names_the_signer_and_the_builds() {
        let req = driver_requirement();
        assert!(req.starts_with("(identifier \"cua-driver\""));
        for cdhash in driver::DRIVER_CDHASHES {
            assert!(req.contains(&format!("cdhash H\"{cdhash}\"")));
        }
    }

    /// The running-image check refuses a validly signed program that is not
    /// the pinned driver, while it is still suspended — the check that stands
    /// even if the file were swapped after it was hashed.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_suspended_image_that_is_not_the_driver_is_refused() {
        use crate::computer::spawn::{spawn, ChildFd, SpawnSpec};
        let child = spawn(&SpawnSpec {
            program: Path::new("/bin/ls"),
            args: &[],
            env: &[],
            stdio: [ChildFd::Null, ChildFd::Null, ChildFd::Null],
            disclaim: false,
            suspended: true,
            launch_requirement: None,
        })
        .unwrap();
        let verdict = verify_running_driver(child.pid());
        child.kill();
        let _ = child.wait().await;
        let why = verdict.unwrap_err();
        assert!(why.contains("not the pinned build"), "{why}");
    }

    /// Under the driver's launch requirement no other image runs at all —
    /// the kernel kills it at `exec`, so resuming it (as any process of the
    /// user's could) resumes nothing.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn the_kernel_refuses_any_image_but_the_pinned_driver() {
        use crate::computer::launch_req::{held_here, supported};
        use crate::computer::spawn::{spawn, ChildFd, SpawnSpec};
        if !supported() || !held_here() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let script = format!("touch '{}'", marker.display());
        let requirement = driver_launch_requirement().unwrap();
        let child = spawn(&SpawnSpec {
            program: Path::new("/bin/sh"),
            args: &["-c", &script],
            env: &[],
            stdio: [ChildFd::Null, ChildFd::Null, ChildFd::Null],
            disclaim: false,
            suspended: true,
            launch_requirement: Some(&requirement),
        })
        .unwrap();
        let _ = child.resume();
        assert_eq!(child.wait().await, Some(-libc::SIGKILL));
        assert!(!marker.exists());
    }

    /// A file that is not the pinned build is refused before anything is
    /// spawned.
    #[tokio::test]
    async fn a_file_that_is_not_the_pin_is_refused_unrun() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("cua-driver");
        std::fs::write(&fake, b"#!/bin/sh\ntouch ran\n").unwrap();
        let artifact = driver::artifact_for_current_platform().unwrap();
        let err = DriverProc::launch(&fake, artifact, || Ok(()))
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, HelperErrorCode::DriverRejected);
        assert!(!dir.path().join("ran").exists());
    }
}
