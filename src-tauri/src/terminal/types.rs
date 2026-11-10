use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalEvent {
    pub terminal_id: String,
    pub data: String,
    /// Cumulative count of output chunks emitted for this terminal, INCLUDING
    /// this one — the cursor a re-attaching client uses to tell which events a
    /// [`TerminalSnapshot`] already contains.
    ///
    /// Assigned under the same lock that appends to the scrollback, so the two
    /// are totally ordered: an event whose `seq` is at or below the snapshot's
    /// is already in the snapshot's `data`, and one above it is not. Without it
    /// a client that (correctly) subscribes before asking for the snapshot
    /// would have to choose between duplicating the overlap and dropping it.
    /// `0` on the exit event, which carries no output.
    #[serde(default)]
    pub seq: u64,
    /// Distinguishes a restarted PTY that reused the same terminal id.
    pub generation: String,
}

/// Recent output of a live or completed terminal plus its cursor — the
/// re-attach payload behind `terminal_snapshot`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSnapshot {
    /// Whether a live or completed PTY with this id is known.
    pub exists: bool,
    /// Exit status retained with the completed output, if the child reported it.
    pub exit_code: Option<u32>,
    /// Same token carried by output/exit events for this PTY generation.
    pub generation: Option<String>,
    /// False for a completed PTY or an unknown id. Use `exists` to distinguish
    /// retained final output from a missing session.
    pub alive: bool,
    /// Recent PTY output, oldest chunk possibly trimmed by the scrollback cap.
    /// Raw terminal bytes (escape sequences included) — written straight back
    /// into a fresh emulator.
    pub data: String,
    /// The `seq` of the last chunk included in `data`.
    pub seq: u64,
    /// The PTY's size, which `data` was laid out for. A viewer replays it at
    /// this size: drawn narrower, a full-width line (zsh's end-of-output
    /// mark pads to the right edge) wraps and leaves a stray line behind.
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub id: String,
    pub title: String,
}
