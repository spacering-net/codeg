//! Periodic sweeper that puts idle ACP connections to sleep.
//!
//! "Sleep" ends the agent CLI process but keeps its session: the
//! conversation stays where it was, and the next message resumes it with
//! `session/load`. What the sweep must never do is end work the user is
//! waiting for, so a connection is only ever a candidate while nothing is in
//! flight (see [`ConnectionManager::sweep_idle_with`] for the exemptions).
//!
//! Two runtimes, two policies:
//!
//! * **Desktop** — the agent lives as long as a window shows it. Every open
//!   tab touches its connection every 30 s, so a connection nobody touched
//!   for a few minutes belongs to a window that is gone, and is reclaimed.
//! * **Server** (`codeg-server` on a VM, used from several devices) — the
//!   agent belongs to the server. A phone that locks its screen freezes the
//!   page and stops touching; a laptop lid does the same. Neither means "I
//!   am done with this agent", so a short timeout reads as agents dying
//!   whenever the user looks away. The server keeps idle agents for hours
//!   and bounds the cost with a cap on how many idle agents nobody is
//!   watching stay warm, instead of with a clock tied to a browser tab.
//!
//! Connections no person composes prompts for — automation runs, `codeg-cli`
//! runs, one-shot generations — get the short timeout in both runtimes: no
//! tab will ever come back to them, and they must not hold cap slots that an
//! interactive conversation could use.

use std::time::Duration;

use crate::acp::manager::ConnectionManager;

/// Desktop idle threshold (3 minutes). Override via
/// `CODEG_ACP_IDLE_TIMEOUT_SECS`. `last_activity_at` is bumped on every emit
/// and on every frontend keepalive touch (~30 s cadence for open tabs), so a
/// visible connection never qualifies.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 180;
/// Server idle threshold (2 hours). Override via `CODEG_ACP_IDLE_TIMEOUT_SECS`.
pub const DEFAULT_SERVER_IDLE_TIMEOUT_SECS: u64 = 2 * 60 * 60;
/// Server cap on idle interactive agents kept warm. Override via
/// `CODEG_ACP_MAX_IDLE_AGENTS` (`0` = no cap). Each agent CLI is a process
/// tree (often with MCP servers of its own) worth hundreds of megabytes, so
/// an unbounded pool on a small VM is the thing this replaces the short
/// timeout with.
pub const DEFAULT_SERVER_MAX_IDLE_AGENTS: usize = 8;
/// Upper bound of the idle threshold for connections no person composes
/// prompts for (automation, `codeg-cli`, one-shot).
pub const HEADLESS_IDLE_TIMEOUT_SECS: u64 = DEFAULT_IDLE_TIMEOUT_SECS;
/// A connection touched within this window is being watched by an open tab
/// (tabs touch every 30 s; a desktop browser throttles a background tab's
/// timers to about once a minute). The cap never puts a watched agent to
/// sleep.
pub const WATCHED_WINDOW_SECS: u64 = 180;
/// Sweep cadence — runs once per minute. Each tick is a brief lock on the
/// connections map plus per-state `try_read`s, so a 1-minute interval is
/// trivially cheap relative to the wall-clock idle threshold.
pub const SWEEP_INTERVAL_SECS: u64 = 60;

/// Which runtime the sweep is running in; picks the defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SweepRuntime {
    Desktop,
    Server,
}

/// When the sweep puts an idle connection to sleep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleSweepPolicy {
    /// Idle time after which a connection a person works in is put to sleep.
    pub idle_timeout: Duration,
    /// Idle time after which a connection nobody composes prompts for
    /// (automation, `codeg-cli`, one-shot) is reclaimed.
    pub headless_idle_timeout: Duration,
    /// Most idle interactive connections kept warm. Past it, the ones idle
    /// the longest are put to sleep early — but only those no open tab is
    /// watching. `None` = no cap.
    pub max_idle: Option<usize>,
    /// See [`WATCHED_WINDOW_SECS`].
    pub watched_window: Duration,
}

impl IdleSweepPolicy {
    /// One timeout for every connection and no cap — the behavior before
    /// runtimes had separate policies. Kept for tests and callers that only
    /// care about the clock.
    pub fn uniform(idle_timeout: Duration) -> Self {
        Self {
            idle_timeout,
            headless_idle_timeout: idle_timeout,
            max_idle: None,
            watched_window: Duration::from_secs(WATCHED_WINDOW_SECS),
        }
    }

    /// Build the policy for `runtime` from the process environment. `None`
    /// when `CODEG_ACP_IDLE_TIMEOUT_SECS=0` disables the sweep.
    pub fn from_env(runtime: SweepRuntime) -> Option<Self> {
        Self::from_values(
            runtime,
            std::env::var("CODEG_ACP_IDLE_TIMEOUT_SECS").ok().as_deref(),
            std::env::var("CODEG_ACP_MAX_IDLE_AGENTS").ok().as_deref(),
        )
    }

    /// Pure form of [`Self::from_env`]: unparseable values fall back to the
    /// runtime's default, the same way a missing one does.
    pub fn from_values(
        runtime: SweepRuntime,
        idle_timeout_secs: Option<&str>,
        max_idle_agents: Option<&str>,
    ) -> Option<Self> {
        let (default_timeout, default_cap) = match runtime {
            SweepRuntime::Desktop => (DEFAULT_IDLE_TIMEOUT_SECS, None),
            SweepRuntime::Server => (
                DEFAULT_SERVER_IDLE_TIMEOUT_SECS,
                Some(DEFAULT_SERVER_MAX_IDLE_AGENTS),
            ),
        };
        let secs = idle_timeout_secs
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(default_timeout);
        if secs == 0 {
            return None;
        }
        let max_idle = match max_idle_agents.and_then(|raw| raw.trim().parse::<usize>().ok()) {
            Some(0) => None,
            Some(n) => Some(n),
            None => default_cap,
        };
        let idle_timeout = Duration::from_secs(secs);
        Some(Self {
            idle_timeout,
            headless_idle_timeout: idle_timeout
                .min(Duration::from_secs(HEADLESS_IDLE_TIMEOUT_SECS)),
            max_idle,
            watched_window: Duration::from_secs(WATCHED_WINDOW_SECS),
        })
    }
}

/// Long-running task that calls `ConnectionManager::sweep_idle_with` on a
/// fixed interval. The caller spawns the returned future onto whichever
/// runtime they manage (`tokio::spawn` from inside an async context,
/// `tauri::async_runtime::spawn` from a Tauri `setup` callback that runs
/// outside the runtime).
///
/// Never exits on its own — the caller drops the spawned handle when
/// shutting down (process exit cleans up everything).
pub async fn idle_sweep_task(
    manager: ConnectionManager,
    policy: IdleSweepPolicy,
    interval: Duration,
) {
    tracing::info!(
        "[ACP] idle sweep: sleep after {}s idle (headless {}s), max idle agents {}",
        policy.idle_timeout.as_secs(),
        policy.headless_idle_timeout.as_secs(),
        policy
            .max_idle
            .map_or_else(|| "unlimited".to_string(), |n| n.to_string()),
    );
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First `tick().await` returns immediately. Skip it so we don't
    // sweep at startup before any connections have a chance to settle.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let n = manager.sweep_idle_with(&policy).await;
        if n > 0 {
            tracing::info!("[ACP] idle sweep put {n} connection(s) to sleep");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_defaults_keep_the_three_minute_timeout_and_no_cap() {
        let p = IdleSweepPolicy::from_values(SweepRuntime::Desktop, None, None).unwrap();
        assert_eq!(p.idle_timeout.as_secs(), DEFAULT_IDLE_TIMEOUT_SECS);
        assert_eq!(p.headless_idle_timeout.as_secs(), DEFAULT_IDLE_TIMEOUT_SECS);
        assert_eq!(p.max_idle, None);
    }

    #[test]
    fn server_defaults_keep_agents_for_hours_under_a_cap() {
        let p = IdleSweepPolicy::from_values(SweepRuntime::Server, None, None).unwrap();
        assert_eq!(p.idle_timeout.as_secs(), DEFAULT_SERVER_IDLE_TIMEOUT_SECS);
        assert_eq!(
            p.headless_idle_timeout.as_secs(),
            HEADLESS_IDLE_TIMEOUT_SECS
        );
        assert_eq!(p.max_idle, Some(DEFAULT_SERVER_MAX_IDLE_AGENTS));
    }

    #[test]
    fn zero_timeout_disables_the_sweep_in_both_runtimes() {
        for runtime in [SweepRuntime::Desktop, SweepRuntime::Server] {
            assert!(IdleSweepPolicy::from_values(runtime, Some("0"), None).is_none());
        }
    }

    #[test]
    fn unparseable_values_fall_back_to_the_runtime_default() {
        let p =
            IdleSweepPolicy::from_values(SweepRuntime::Server, Some("soon"), Some("lots")).unwrap();
        assert_eq!(p.idle_timeout.as_secs(), DEFAULT_SERVER_IDLE_TIMEOUT_SECS);
        assert_eq!(p.max_idle, Some(DEFAULT_SERVER_MAX_IDLE_AGENTS));
    }

    #[test]
    fn explicit_values_override_and_zero_cap_means_unlimited() {
        let p = IdleSweepPolicy::from_values(SweepRuntime::Server, Some("600"), Some("0")).unwrap();
        assert_eq!(p.idle_timeout.as_secs(), 600);
        assert_eq!(p.max_idle, None);

        let p =
            IdleSweepPolicy::from_values(SweepRuntime::Desktop, Some(" 120 "), Some("3")).unwrap();
        assert_eq!(p.idle_timeout.as_secs(), 120);
        assert_eq!(p.max_idle, Some(3));
    }

    #[test]
    fn headless_timeout_never_exceeds_the_interactive_one() {
        let p = IdleSweepPolicy::from_values(SweepRuntime::Server, Some("60"), None).unwrap();
        assert_eq!(p.headless_idle_timeout.as_secs(), 60);
    }
}
