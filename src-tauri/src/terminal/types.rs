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
}

/// Recent output of a live terminal plus the cursor it was read at — the
/// re-attach payload behind `terminal_snapshot`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSnapshot {
    /// False when no terminal with that id is running: the caller should spawn
    /// one rather than attach. `data` is then empty.
    pub alive: bool,
    /// Recent PTY output, oldest chunk possibly trimmed by the scrollback cap.
    /// Raw terminal bytes (escape sequences included) — written straight back
    /// into a fresh emulator.
    pub data: String,
    /// The `seq` of the last chunk included in `data`.
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub id: String,
    pub title: String,
}
