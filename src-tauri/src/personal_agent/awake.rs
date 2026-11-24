//! Keeping the computer awake while work the owner had done tonight runs
//! (6.5) — on the desktop only, and only on mains power where the platform
//! says which it is on.
//!
//! - **macOS**: `caffeinate -s -w <codeg's pid>`. `-s` keeps the system
//!   from sleeping and holds only on AC power by itself; `-w` lets go when
//!   codeg exits, however it does.
//! - **Linux**: `systemd-inhibit --what=sleep:idle` around a shell that
//!   waits for codeg to exit. On battery (a `Mains` supply reading offline
//!   in `/sys/class/power_supply`) nothing is held.
//! - **Windows**: `SetThreadExecutionState(ES_CONTINUOUS |
//!   ES_SYSTEM_REQUIRED)` from a thread of its own, released by clearing it;
//!   the system lets it go with the process. On battery (`GetSystemPowerStatus`)
//!   nothing is held.
//!
//! [`hold`] is called on every tick with what is wanted; it starts or stops
//! the hold only when that changes (or the power source does).

use std::sync::{LazyLock, Mutex};

/// What holds the computer awake now.
#[derive(Default)]
struct Hold {
    /// Wanted at the last call.
    wanted: bool,
    #[cfg(all(
        feature = "tauri-runtime",
        not(test),
        any(target_os = "macos", target_os = "linux")
    ))]
    child: Option<std::process::Child>,
    #[cfg(all(feature = "tauri-runtime", not(test), target_os = "windows"))]
    stop: Option<std::sync::mpsc::Sender<()>>,
    /// Held now (in tests: what would be).
    held: bool,
}

static HOLD: LazyLock<Mutex<Hold>> = LazyLock::new(Default::default);

fn state() -> std::sync::MutexGuard<'static, Hold> {
    HOLD.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the computer is held awake now.
pub fn holding() -> bool {
    state().held
}

/// Hold the computer awake (`want`), or let it go. Cheap when nothing
/// changes.
pub fn hold(want: bool) {
    state().set(want && on_mains());
}

impl Hold {
    fn set(&mut self, want: bool) {
        // A hold that could not start is not tried again until it is let go.
        if self.wanted == want {
            return;
        }
        self.wanted = want;
        if want {
            start(self);
        } else {
            stop(self);
        }
    }
}

// ── the platforms ───────────────────────────────────────────────────────────

#[cfg(any(test, not(feature = "tauri-runtime")))]
fn on_mains() -> bool {
    true
}

#[cfg(any(test, not(feature = "tauri-runtime")))]
fn start(h: &mut Hold) {
    // The server has no computer of the owner's to keep awake; tests only
    // note what would be held.
    h.held = cfg!(test);
}

#[cfg(any(test, not(feature = "tauri-runtime")))]
fn stop(h: &mut Hold) {
    h.held = false;
}

#[cfg(all(feature = "tauri-runtime", not(test), target_os = "macos"))]
fn on_mains() -> bool {
    // `caffeinate -s` holds only on AC power by itself.
    true
}

#[cfg(all(feature = "tauri-runtime", not(test), target_os = "linux"))]
fn on_mains() -> bool {
    // A mains supply that says it is offline: on battery. None found (a
    // desktop, a system that does not say): on mains.
    let Ok(dir) = std::fs::read_dir("/sys/class/power_supply") else {
        return true;
    };
    let mut mains = Vec::new();
    for e in dir.flatten() {
        let p = e.path();
        let kind = std::fs::read_to_string(p.join("type")).unwrap_or_default();
        if kind.trim() == "Mains" {
            mains.push(
                std::fs::read_to_string(p.join("online"))
                    .unwrap_or_default()
                    .trim()
                    == "1",
            );
        }
    }
    mains.is_empty() || mains.iter().any(|on| *on)
}

#[cfg(all(
    feature = "tauri-runtime",
    not(test),
    any(target_os = "macos", target_os = "linux")
))]
fn start(h: &mut Hold) {
    let pid = std::process::id().to_string();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("/usr/bin/caffeinate")
        .args(["-s", "-w", &pid])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    #[cfg(target_os = "linux")]
    let spawned = std::process::Command::new("systemd-inhibit")
        .args([
            "--what=sleep:idle",
            "--who=codeg",
            "--why=Work you chose for tonight is running",
            "--mode=block",
            "sh",
            "-c",
            "while kill -0 \"$1\" 2>/dev/null; do sleep 30; done",
            "sh",
            &pid,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(child) => {
            h.child = Some(child);
            h.held = true;
            tracing::info!("[personal_agent] keeping the computer awake for tonight's work");
        }
        Err(e) => {
            h.held = false;
            tracing::warn!("[personal_agent] could not keep the computer awake: {e}");
        }
    }
}

#[cfg(all(
    feature = "tauri-runtime",
    not(test),
    any(target_os = "macos", target_os = "linux")
))]
fn stop(h: &mut Hold) {
    if let Some(mut child) = h.child.take() {
        let _ = child.kill();
        let _ = child.wait();
        tracing::info!("[personal_agent] the computer may sleep again");
    }
    h.held = false;
}

#[cfg(all(feature = "tauri-runtime", not(test), target_os = "windows"))]
fn on_mains() -> bool {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    // SAFETY: a plain out-parameter of the size the call expects.
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
        return true;
    }
    // 0: offline (battery); 1: online; 255: unknown.
    s.ACLineStatus != 0
}

#[cfg(all(feature = "tauri-runtime", not(test), target_os = "windows"))]
fn start(h: &mut Hold) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let spawned = std::thread::Builder::new()
        .name("codeg-keep-awake".into())
        .spawn(move || {
            // SAFETY: flags only; the state belongs to this thread.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            let _ = rx.recv();
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        });
    match spawned {
        Ok(_) => {
            h.stop = Some(tx);
            h.held = true;
            tracing::info!("[personal_agent] keeping the computer awake for tonight's work");
        }
        Err(e) => {
            h.held = false;
            tracing::warn!("[personal_agent] could not keep the computer awake: {e}");
        }
    }
}

#[cfg(all(feature = "tauri-runtime", not(test), target_os = "windows"))]
fn stop(h: &mut Hold) {
    if let Some(tx) = h.stop.take() {
        let _ = tx.send(());
        tracing::info!("[personal_agent] the computer may sleep again");
    }
    h.held = false;
}

#[cfg(all(
    feature = "tauri-runtime",
    not(test),
    not(any(target_os = "macos", target_os = "linux", target_os = "windows"))
))]
fn on_mains() -> bool {
    true
}

#[cfg(all(
    feature = "tauri-runtime",
    not(test),
    not(any(target_os = "macos", target_os = "linux", target_os = "windows"))
))]
fn start(h: &mut Hold) {
    h.held = false;
}

#[cfg(all(
    feature = "tauri-runtime",
    not(test),
    not(any(target_os = "macos", target_os = "linux", target_os = "windows"))
))]
fn stop(h: &mut Hold) {
    h.held = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hold_starts_once_and_lets_go_when_no_longer_wanted() {
        let mut h = Hold::default();
        h.set(false);
        assert!(!h.held && !h.wanted);
        h.set(true);
        assert!(h.held && h.wanted);
        h.set(true);
        assert!(h.held, "held still, not started twice");
        h.set(false);
        assert!(!h.held && !h.wanted);
    }
}
