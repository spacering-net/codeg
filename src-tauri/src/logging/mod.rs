//! Application diagnostic logging built on `tracing`.
//!
//! One subscriber feeds three sinks: **stderr** (preserves the pre-tracing
//! `eprintln!` behavior for terminal users), a **daily-rotating JSON-lines
//! file** under [`crate::paths::codeg_logs_root`], and an **in-memory ring
//! buffer** ([`hub`]) that the Settings → Logs viewer reads and live-tails.
//!
//! - [`init`] wires the subscriber into each of the three binaries and owns
//!   the level-reload / persisted-level machinery.
//! - [`hub`] holds the process-global runtime state (ring buffer, reload
//!   handle, and the event emitter wired in once `AppState` exists).
//! - [`layer`] is the custom `tracing` layer that converts events into
//!   [`hub::LogRecord`]s.
//! - [`budget`] caps how much the file sink may write per day, so no log
//!   firehose can fill the user's disk before the next rotation.
//! - [`throttle`] collapses bursts of a near-duplicate line to one per window.
//! - [`panic_hook`] makes a panic leave a record behind instead of a silent
//!   abort, writing it to the file sink synchronously so it survives the death
//!   of the process.

pub mod budget;
pub mod hub;
pub mod init;
pub mod layer;
pub mod panic_hook;
pub mod throttle;

use serde::{Deserialize, Serialize};

/// `app_metadata` KV key under which the persisted [`LogSettings`] live.
pub const LOGGING_LEVEL_KEY: &str = "logging.level";

/// Global side-channel announcing a log-level change so a Logs viewer open in
/// another window / WS client converges. Mirrors the `*-settings://changed`
/// constants in [`crate::web::event_bridge`]. Payload: [`LogSettings`].
pub const LOG_SETTINGS_CHANGED_EVENT: &str = "log-settings://changed";

/// Per-record append event consumed by the Logs viewer's live tail. Payload:
/// [`hub::LogRecord`]. The broadcaster gates on `receiver_count`, so this costs
/// nothing when no viewer is attached.
pub const LOG_APPENDED_EVENT: &str = "logs://appended";

/// Minimum severity captured by the subscriber.
///
/// `Off` disables capture entirely. Folding "enabled" into a dedicated variant
/// avoids a meaningless `enabled = false, level = Debug` two-axis state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Off,
    Error,
    Warn,
    #[default]
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    /// The `EnvFilter` directive string for this level (`"off"`..`"trace"`).
    pub fn directive(self) -> &'static str {
        match self {
            LogLevel::Off => "off",
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
            LogLevel::Trace => "trace",
        }
    }

    /// Severity rank for "record is at least this severe" filtering in
    /// `get_recent_logs`. Higher = more severe. Consistent with
    /// [`hub::level_rank`] (which ranks tracing's uppercase level strings).
    pub fn rank(self) -> u8 {
        match self {
            LogLevel::Off => 0,
            LogLevel::Trace => 1,
            LogLevel::Debug => 2,
            LogLevel::Info => 3,
            LogLevel::Warn => 4,
            LogLevel::Error => 5,
        }
    }
}

/// A per-target level override, e.g. `codeg_lib::acp` at `Debug` while the
/// global level stays `Info`. `target` is a `tracing` target (a Rust module
/// path); it maps directly to an `EnvFilter` directive `target=level`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetDirective {
    pub target: String,
    pub level: LogLevel,
}

/// Persisted logging configuration. Stored as a JSON object (not a bare
/// string) under [`LOGGING_LEVEL_KEY`] so the shape can grow without a
/// migration.
///
/// `targets` is omitted from the serialized form when empty (`skip_serializing_if`)
/// and defaults on read (`serde(default)`), so a pre-existing `{"level":"info"}`
/// value still deserializes and the common case still serializes to that exact
/// shape — no migration needed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LogSettings {
    pub level: LogLevel,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<TargetDirective>,
}
