//! Computer use: letting an agent look at the native windows on the user's
//! desktop — one window at a time, and only the ones a person shared.
//!
//! Acting on a shared window follows the same rules, one level up: a window
//! shared for control, one element or one point of what the agent last read
//! of it, keys that stay inside the window, delivered in the background
//! unless the person lets agents bring a window to the front for an action,
//! and a Stop the person can press at any moment.
//!
//! The shape of this module is decided by one fact about macOS: TCC charges
//! "Accessibility" and "Screen Recording" to a process's *responsible*
//! process, and every process in an agent's tree (the ACP adapter, the agent
//! CLI, its shell, the scripts it runs) reports codeg as its responsible
//! process. A grant given to codeg would therefore be given to every agent's
//! shell, where `screencapture` and `osascript` walk straight past every gate
//! in here. So:
//!
//! * **codeg never holds either grant, and never calls an API governed by
//!   them.** Nothing in this crate that links into the main binary touches
//!   Accessibility, event posting or screen capture. The two read-only
//!   preflight queries in [`tcc`] are the only exception, and they exist so
//!   codeg can notice that it *has* been granted one by mistake.
//! * **The executor is `codeg-computer-helper`**, a separately signed binary
//!   that codeg launches as its own responsible process and that refuses to
//!   serve anything but a code-signature-verified codeg ([`helper`]). On
//!   macOS it is an app of its own, run from a copy outside codeg's bundle:
//!   Screen Recording is charged to the outermost app of the same team around
//!   an executable, which inside the bundle is codeg (`helper_app`).
//! * **The driver (cua-driver) runs as the helper's child** without
//!   disclaiming, so its TCC requests are charged to the helper. It lives in a
//!   user-writable cache, so the helper launches it under a launch requirement
//!   built from pins compiled into it — the kernel will not run any other
//!   image at that path — and checks the running image again before letting
//!   it start ([`driver`], [`launch_req`]).
//!
//! On Windows and X11 none of this is a boundary against an agent with a
//! shell — any process of the user's can inject input and capture the screen
//! there — and the settings copy says so. The helper still owns the driver on
//! those platforms, because the gates below are about what the *tool surface*
//! lets a model do, which is the same question everywhere.
//!
//! Module map:
//! - `types`     — wire types shared with the companion and the frontend
//! - `agent`     — grant rules: what may be shared, what a grant covers, how
//!   titles are narrowed, when a grant lapses
//! - `keys`      — the keys an agent may press, and which a window grant
//!   allows
//! - `stop_shortcut` — the global shortcut that stops every agent at once
//! - `targets`   — codeg's table of windows it has told an agent about, with
//!   the grant on each entry
//! - `protocol`  — frames between codeg and the helper
//! - `driver`    — the pinned cua-driver release and its trust anchors
//! - `backend`   — the trait the tool surface calls, and its errors
//! - `codesign`  — macOS code-signature checks (Security.framework)
//! - `launch_req` — macOS launch requirements: the kernel's check of what a
//!   spawn may run
//! - `spawn`     — macOS `posix_spawn` with the attributes the design needs
//! - `tcc`       — macOS read-only TCC preflight queries
//! - `procinfo`  — process start times, so a reused pid is not the same app
//! - `appident`  — which application a process is, read off the process; a
//!   frame on Windows is the one drawing inside it
//! - `helper`    — the helper process's own logic (runs in the helper binary)
//! - `helper_app` — the helper app's copy outside codeg's bundle, which is
//!   what codeg runs on macOS
//! - `local`     — codeg's side of the helper: launch, verify, talk
//! - `events`    — what the frontend is told
//! - `driver_admin` — the driver as Settings manages it: install, clear, remove
//! - `stop_key`  — the stop shortcut as the OS holds it
//! - `indicator` — the strip above every window while anything is shared
//! - `marker`    — the mark an action leaves where it landed

pub mod agent;
pub mod appident;
pub mod backend;
pub mod driver;
pub mod helper;
pub mod keys;
pub mod procinfo;
pub mod protocol;
pub mod stop_shortcut;
pub mod targets;
pub mod types;

#[cfg(target_os = "macos")]
pub mod codesign;
#[cfg(target_os = "macos")]
pub mod launch_req;
#[cfg(target_os = "macos")]
pub mod spawn;
#[cfg(target_os = "macos")]
pub mod tcc;

// codeg's side of the helper and the events it raises: the desktop app's,
// and codeg-server's where the person who runs it lets it share the screen
// it runs on (`CODEG_COMPUTER_USE`).
pub mod driver_admin;
pub mod events;
#[cfg(target_os = "macos")]
pub mod helper_app;
pub mod local;

// What only the desktop app has: a window above every other, the mark an
// action leaves, and a shortcut held with the OS.
#[cfg(feature = "tauri-runtime")]
pub mod indicator;
#[cfg(feature = "tauri-runtime")]
pub mod marker;
#[cfg(feature = "tauri-runtime")]
pub mod stop_key;
