//! Periodic sweeper that disconnects ACP connections idle past a deadline.
//!
//! Connections accumulate when frontends close their window/tab without
//! triggering an explicit disconnect — common in web mode (browser tab
//! close has no server-side hook), and possible on desktop after panics.
//! The sweep prevents long-lived processes from leaking ACP child
//! processes, file handles, and memory.
//!
//! A conversation still open in a workspace tab is not abandoned, even when
//! no client is touching its connection: the tab set lives in the database
//! and is shared by every client, so a laptop that went to sleep or a phone
//! with the browser in the background leaves the tab open, and the user
//! picks the conversation up on another device. Its agent is kept. Closing
//! the tab is the explicit "done", and already ends an idle agent.

use std::time::Duration;

use sea_orm::DatabaseConnection;

use crate::acp::manager::ConnectionManager;
use crate::db::service::tab_service::{self, OpenConversations};

/// Default idle threshold (3 minutes). Override at startup via
/// `CODEG_ACP_IDLE_TIMEOUT_SECS`. The sweep only runs against
/// connections in `Connected` state with nothing in flight (see
/// `teardown_blocker`), and `last_activity_at` is bumped on every emit and
/// on every frontend keepalive touch (~30s cadence while a page shows the
/// tab), so an actively-used or visible connection never qualifies. A
/// conversation open in a workspace tab is spared whether or not a page is
/// touching it.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 180;
/// Sweep cadence — runs once per minute. Each tick is a brief lock on the
/// connections map plus per-state `try_read`s, so a 1-minute interval is
/// trivially cheap relative to the wall-clock idle threshold.
pub const SWEEP_INTERVAL_SECS: u64 = 60;

/// Read the idle timeout from `CODEG_ACP_IDLE_TIMEOUT_SECS`, falling back
/// to `DEFAULT_IDLE_TIMEOUT_SECS`. A `0` value disables the sweep
/// (returns `None`); any unparseable value is treated as "use default".
pub fn idle_timeout_from_env() -> Option<Duration> {
    let secs = match std::env::var("CODEG_ACP_IDLE_TIMEOUT_SECS") {
        Ok(raw) => raw.parse::<u64>().unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS),
        Err(_) => DEFAULT_IDLE_TIMEOUT_SECS,
    };
    if secs == 0 {
        return None;
    }
    Some(Duration::from_secs(secs))
}

/// Long-running task that calls `ConnectionManager::sweep_idle_except` on a
/// fixed interval, sparing the conversations open in a workspace tab. When
/// the tab set cannot be read, the tick spares nothing: a sweep that cannot
/// see the tabs behaves as it did before they counted.
///
/// The caller spawns the returned future onto whichever runtime they manage
/// (`tokio::spawn` from inside an async context, `tauri::async_runtime::spawn`
/// from a Tauri `setup` callback that runs outside the runtime).
///
/// Never exits on its own — the caller drops the spawned handle when
/// shutting down (process exit cleans up everything).
pub async fn idle_sweep_task(
    manager: ConnectionManager,
    db: DatabaseConnection,
    idle_timeout: Duration,
    interval: Duration,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First `tick().await` returns immediately. Skip it so we don't
    // sweep at startup before any connections have a chance to settle.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let open = match tab_service::open_conversations(&db).await {
            Ok(open) => open,
            Err(err) => {
                tracing::warn!("[ACP] idle sweep could not read open tabs: {err}");
                OpenConversations::default()
            }
        };
        let n = manager.sweep_idle_except(idle_timeout, &open).await;
        if n > 0 {
            tracing::info!("[ACP] idle sweep disconnected {n} connection(s)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Single test sequences all env-var assertions to avoid the
    /// notorious parallel-test race on shared environment state. Cargo
    /// runs tests in parallel by default; setting `CODEG_ACP_IDLE_TIMEOUT_SECS`
    /// in concurrent tests would interleave with each other.
    #[test]
    fn idle_timeout_env_parsing() {
        // Disabled when zero.
        std::env::set_var("CODEG_ACP_IDLE_TIMEOUT_SECS", "0");
        assert!(idle_timeout_from_env().is_none());

        // Falls back to default when unparseable.
        std::env::set_var("CODEG_ACP_IDLE_TIMEOUT_SECS", "not-a-number");
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );

        // Uses provided value when it parses.
        std::env::set_var("CODEG_ACP_IDLE_TIMEOUT_SECS", "120");
        assert_eq!(idle_timeout_from_env().unwrap().as_secs(), 120);

        // Falls back to default when unset.
        std::env::remove_var("CODEG_ACP_IDLE_TIMEOUT_SECS");
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );
    }
}
