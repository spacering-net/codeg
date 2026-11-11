//! The time the assistants live by (6.1, 15).
//!
//! Everything about when — the `<codeg-now>` line, a matter's due time, the
//! clock that fires it — reads "now" here. An end-to-end test of a debug
//! build moves it forward: `CODEG_PA_CLOCK_FILE` names a file holding the
//! seconds to add, read on every call. A release build does not look.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

/// Now, as the assistants see it.
pub fn now() -> DateTime<Utc> {
    Utc::now() + offset()
}

#[cfg(debug_assertions)]
fn offset() -> chrono::Duration {
    std::env::var_os("CODEG_PA_CLOCK_FILE")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<i64>().ok())
        .map(chrono::Duration::seconds)
        .unwrap_or_else(chrono::Duration::zero)
}

#[cfg(not(debug_assertions))]
fn offset() -> chrono::Duration {
    chrono::Duration::zero()
}

/// The owner's time zone: the system's, UTC when it cannot be told. (The
/// owner's own choice comes with the "about you" page, 1.12.)
pub fn owner_tz() -> Tz {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|name| name.parse::<Tz>().ok())
        .unwrap_or(Tz::UTC)
}
