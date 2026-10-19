//! Restarting on macOS without leaving a second Dock icon behind.
//!
//! tauri's restart (2.12.2 and later) runs `open -n <bundle>` and waits for
//! LaunchServices to finish the launch before this process exits, so for a
//! moment two codegs are running. The Dock gives the new one a tile of its own,
//! because the old one still holds the app's tile, and when the old one is
//! gone the tile it held stays where the user kept it: codeg is in the Dock
//! twice, the kept icon idle and the running codeg at the end, until the user
//! quits that one. The update from 0.36.0 to 0.37.0 did exactly this on
//! macOS 27 — the Dock logged "Inserting tile … for reason: -[DockBar
//! _handleLaunchNotification:data:]" for the new instance while the old one
//! was still exiting.
//!
//! So on macOS the restart is handed to a detached `/bin/sh` that waits until
//! this process is gone, from the process table and from LaunchServices, and
//! only then runs `open -n`. The Dock gives the new instance the tile the old
//! one left ("Launch of tile with child processes"). Chromium and Electron
//! relaunch the same way, for the same reason.
//!
//! Every restart codeg asks for comes through here: `restart_app` after an
//! update, and the renderer's `relaunch()` (`tauri-plugin-process`). Both
//! request the exit with `RESTART_EXIT_CODE`, which [`note_exit_requested`]
//! records, and reach `RunEvent::Exit`, where [`relaunch_after_exit`] takes
//! over before tauri's own restart would run. `AppHandle::restart()` on the
//! main thread skips both events and stays tauri's; codeg never calls it there
//! (see `commands::app_update::restart_app`).

use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set once an exit has been requested in order to restart.
static RESTART_PENDING: AtomicBool = AtomicBool::new(false);

/// What launches the new instance, as in tauri's restart.
const OPEN: &str = "/usr/bin/open";

/// How many times the relauncher looks for the old instance, 50 ms apart,
/// before it launches anyway: about ten seconds. Past that something is
/// holding this process up, and a second icon is better than no codeg.
const WAIT_TRIES: u32 = 200;

/// The relauncher. Run as
/// `/bin/sh -c RELAUNCHER codeg-relaunch <pid> <tries> <open> <bundle> <exe> [args…]`.
///
/// It waits until `<pid>` has left the process table, or is a zombie nobody
/// has reaped yet (`kill -0` would still find one), and LaunchServices no
/// longer lists it, so the Dock has heard that the old instance quit before it
/// hears about the new one. Then `open -n`, as tauri does, or, if that fails,
/// the executable itself, as tauri's fallback does. Paths are absolute: PATH is
/// whatever codeg's was.
const RELAUNCHER: &str = r#"pid=$1 tries=$2 open=$3 bundle=$4 exe=$5
shift 5
while [ "$tries" -gt 0 ]; do
  case $(/bin/ps -o stat= -p "$pid" 2>/dev/null) in
    '' | Z*) [ -z "$(/usr/bin/lsappinfo find "pid=$pid" 2>/dev/null)" ] && break ;;
  esac
  tries=$((tries - 1))
  /bin/sleep 0.05
done
"$open" -n "$bundle" --args "$@" && exit 0
exec "$exe" "$@"
"#;

/// From `RunEvent::ExitRequested`: remembers whether the exit is a restart.
/// tauri requests one with `RESTART_EXIT_CODE` and nothing else uses it.
pub(crate) fn note_exit_requested(code: Option<i32>) {
    if code == Some(tauri::RESTART_EXIT_CODE) && !RESTART_PENDING.swap(true, Ordering::SeqCst) {
        // Logged here, while the app still runs: the process ends inside
        // `RunEvent::Exit`, before the log writer would get to anything said
        // there.
        tracing::info!("[relaunch] restart requested; relaunching once this process has exited");
    }
}

/// From `RunEvent::Exit`, after `shut_down`. With a restart pending, starts the
/// relauncher and ends the process: tauri's own restart would come next and run
/// `open -n` while this process is still alive.
///
/// Returns, leaving the restart to tauri, when codeg is not running from an app
/// bundle — tauri then spawns the executable directly, which gets no Dock tile
/// of its own until this process is gone — or when the relauncher cannot be
/// started.
pub(crate) fn relaunch_after_exit(app: &tauri::AppHandle) {
    use tauri::Manager;

    if !RESTART_PENDING.load(Ordering::SeqCst) {
        return;
    }
    let env = app.env();
    let Ok(exe) = tauri::process::current_binary(&env) else {
        return;
    };
    let Some(bundle) = app_bundle(&exe) else {
        return;
    };
    let args = env.args_os.get(1..).unwrap_or_default();
    match relauncher(
        std::process::id(),
        WAIT_TRIES,
        Path::new(OPEN),
        bundle,
        &exe,
        args,
    )
    .spawn()
    {
        Ok(_) => {
            // What tauri does after this event before it restarts.
            app.cleanup_before_exit();
            std::process::exit(0);
        }
        Err(err) => {
            tracing::error!(
                "[relaunch] cannot start the relauncher, tauri restarts instead: {err}"
            );
        }
    }
}

/// The `.app` bundle `exe` runs from, `<bundle>.app/Contents/MacOS/<exe>`: the
/// layout tauri restarts through `open -n`.
fn app_bundle(exe: &Path) -> Option<&Path> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app")))
    .then_some(bundle)
}

/// The relauncher's command line. It gets a process group of its own, because
/// a codeg started at login is the process of a launchd job
/// (`~/Library/LaunchAgents/codeg.plist`), and launchd kills whatever is left
/// in the job's process group when the job exits. No stdio of codeg's.
fn relauncher(
    pid: u32,
    tries: u32,
    open: &Path,
    bundle: &Path,
    exe: &Path,
    args: &[OsString],
) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(RELAUNCHER)
        .arg("codeg-relaunch")
        .arg(pid.to_string())
        .arg(tries.to_string())
        .arg(open)
        .arg(bundle)
        .arg(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Child;
    use std::time::{Duration, Instant};

    #[test]
    fn finds_the_bundle_an_executable_runs_from() {
        assert_eq!(
            app_bundle(Path::new("/Applications/codeg.app/Contents/MacOS/codeg")),
            Some(Path::new("/Applications/codeg.app"))
        );
        assert_eq!(
            app_bundle(Path::new(
                "/Users/me/Apps/Codeg Beta.APP/Contents/MacOS/codeg"
            )),
            Some(Path::new("/Users/me/Apps/Codeg Beta.APP"))
        );
        // Not in a bundle: a development build, a bare binary.
        assert_eq!(
            app_bundle(Path::new("/src/codeg/src-tauri/target/debug/codeg")),
            None
        );
        assert_eq!(
            app_bundle(Path::new("/Applications/codeg/Contents/MacOS/codeg")),
            None
        );
        assert_eq!(app_bundle(Path::new("/Contents/MacOS/codeg")), None);
        assert_eq!(app_bundle(Path::new("codeg")), None);
    }

    /// A stand-in for `open` or the executable that writes the arguments it
    /// was given, one per line, to `<script>.out`, then exits with `code`.
    fn recorder(dir: &Path, name: &str, code: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        std::fs::write(
            &script,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.tmp\" && mv \"$0.tmp\" \"$0.out\"\nexit {code}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    fn recorded(script: &Path) -> PathBuf {
        script.with_extension("out")
    }

    fn wait_for(path: &Path, within: Duration) -> Option<String> {
        let deadline = Instant::now() + within;
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                return Some(text);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Bounded, so a relauncher that never finishes fails the test instead of
    /// hanging it.
    fn reap(child: &mut Child) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "the relauncher did not finish");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn opens_the_bundle_only_once_the_old_instance_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let open = recorder(dir.path(), "open", 0);
        let exe = recorder(dir.path(), "exe", 0);
        // The quitting codeg. Killed below and deliberately not reaped until
        // the end: a zombie must count as gone.
        let mut old = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let bundle = Path::new("/Applications/Some App.app");
        let mut relauncher = relauncher(
            old.id(),
            WAIT_TRIES,
            &open,
            bundle,
            &exe,
            &args(&["--flag", "two words"]),
        )
        .spawn()
        .unwrap();

        // Its own process group, out of reach of launchd's cleanup of codeg's.
        let pid = relauncher.id() as libc::pid_t;
        assert_eq!(unsafe { libc::getpgid(pid) }, pid);

        std::thread::sleep(Duration::from_millis(400));
        assert!(
            !recorded(&open).exists(),
            "launched while the old instance was still running"
        );

        old.kill().unwrap();
        let launched = wait_for(&recorded(&open), Duration::from_secs(10))
            .expect("not relaunched after the old instance exited");
        assert_eq!(
            launched,
            "-n\n/Applications/Some App.app\n--args\n--flag\ntwo words\n"
        );
        reap(&mut relauncher);
        assert!(
            !recorded(&exe).exists(),
            "fell back although open succeeded"
        );
        old.wait().unwrap();
    }

    #[test]
    fn runs_the_executable_itself_when_open_fails() {
        let dir = tempfile::tempdir().unwrap();
        let open = recorder(dir.path(), "open", 1);
        let exe = recorder(dir.path(), "exe", 0);
        let mut gone = Command::new("/usr/bin/true").spawn().unwrap();
        gone.wait().unwrap();

        // A small budget, in case the reaped pid is already someone else's.
        let mut relauncher = relauncher(
            gone.id(),
            3,
            &open,
            Path::new("/Applications/codeg.app"),
            &exe,
            &args(&["--x"]),
        )
        .spawn()
        .unwrap();

        let ran = wait_for(&recorded(&exe), Duration::from_secs(10))
            .expect("did not fall back to the executable");
        assert_eq!(ran, "--x\n");
        assert_eq!(
            std::fs::read_to_string(recorded(&open)).unwrap(),
            "-n\n/Applications/codeg.app\n--args\n--x\n"
        );
        reap(&mut relauncher);
    }

    #[test]
    fn launches_anyway_when_the_old_instance_never_exits() {
        let dir = tempfile::tempdir().unwrap();
        let open = recorder(dir.path(), "open", 0);
        let exe = recorder(dir.path(), "exe", 0);
        let mut stuck = Command::new("/bin/sleep").arg("30").spawn().unwrap();

        let started = Instant::now();
        let mut relauncher = relauncher(
            stuck.id(),
            3,
            &open,
            Path::new("/Applications/codeg.app"),
            &exe,
            &[],
        )
        .spawn()
        .unwrap();

        let launched =
            wait_for(&recorded(&open), Duration::from_secs(10)).expect("waited past its budget");
        assert_eq!(launched, "-n\n/Applications/codeg.app\n--args\n");
        // Three looks, 50 ms apart.
        assert!(started.elapsed() >= Duration::from_millis(150));
        reap(&mut relauncher);
        stuck.kill().unwrap();
        stuck.wait().unwrap();
    }
}
