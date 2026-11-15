//! Holding a turn-driven run open while its agent still works after the turn.
//!
//! The engines that drive an agent turn by turn — work tasks and automations —
//! settle a run when its prompt's `TurnComplete` arrives, and settling ends the
//! connection. That used to be unconditional, and ending the connection ends
//! the agent CLI with everything it still had going: an agent that started its
//! test gate as a background shell (or a `Monitor` waiting on it) and ended its
//! turn with "I'll report when it finishes" had the gate killed a few
//! milliseconds later, and the run settled on that "still running" sentence.
//!
//! Claude Code does not need a prompt to carry on: when a background task
//! finishes it writes a `<task-notification>` and starts a turn of its own to
//! read the result. claude-agent-acp (0.97.0+) publishes that turn as an AIR
//! async task of type `turn` (`autonomous-turn-<uuid>`) for as long as it runs,
//! next to the rows of the background shells and monitors themselves, so the
//! connection's async-task table is a complete "still working" signal — and
//! [`SessionState::has_active_background_work`] already reads it (together
//! with the transcript watcher's count) for the idle sweeps. The turn itself
//! never reaches the wire as a prompt's turn; its answer arrives only as the
//! watcher's `BackgroundActivity` turns (see
//! [`SessionState::last_background_reply`]).
//!
//! So an engine asks [`should_hold`] at its turn's end, and when the answer is
//! yes it leaves the connection up and awaits [`wait_until_settled`]: the run
//! settles once nothing is running and nothing has moved for [`HOLD_QUIET`],
//! when the cap runs out ([`HoldTiming::from_env`]), when the caller stops the
//! wait, or when the connection goes away by itself.

use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;

use crate::acp::manager::{ConnectionBusy, ConnectionManager};
use crate::acp::session_state::{background_keepalive_max_age, SessionState};
use crate::acp::types::{async_task_state_is_terminal, ConnectionStatus};
use crate::models::agent::AgentType;

/// How often a held connection is looked at.
pub(crate) const HOLD_POLL: Duration = Duration::from_secs(2);

/// How long a held connection must stay idle — nothing running, no activity
/// reported — before the run settles. Covers the gap between a background
/// task's terminal frame and the announcement of the turn the agent starts to
/// read its result: claude-agent-acp announces that turn the moment the CLI
/// reports itself running again (milliseconds, measured up to about a second),
/// so this mostly buys margin, at the price of settling a little later.
pub(crate) const HOLD_QUIET: Duration = Duration::from_secs(15);

/// The async-task type claude-agent-acp gives a turn Claude Code started on
/// its own. It is the agent working, not work the agent left running, so it
/// keeps a hold open but is never listed as one of the things waited for.
const AUTONOMOUS_TURN_TASK_TYPE: &str = "turn";

/// The clock of a hold: how often it looks, how long it must stay quiet, and
/// the longest it may last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HoldTiming {
    pub poll: Duration,
    pub quiet: Duration,
    pub cap: Duration,
}

impl HoldTiming {
    /// [`HOLD_POLL`] and [`HOLD_QUIET`], capped at the background keep-alive's
    /// window (`CODEG_ACP_BACKGROUND_KEEPALIVE_MAX_SECS`, default an hour) —
    /// the same answer the idle sweeps give to "how long may background work
    /// keep a connection alive". `None` when that is `0`, which turns the hold
    /// off altogether: runs settle at their turn's end, as they used to.
    pub(crate) fn from_env() -> Option<Self> {
        let cap = background_keepalive_max_age()
            .to_std()
            .ok()
            .filter(|cap| !cap.is_zero())?;
        Some(Self {
            poll: HOLD_POLL,
            quiet: HOLD_QUIET,
            cap,
        })
    }
}

/// Whether this agent carries on by itself once its background work ends, so
/// that keeping the connection up gets the work's result read. Claude Code
/// starts a turn for every `<task-notification>`; Grok starts turns of its own
/// on its idle loop. The others (codex's background terminals among them)
/// wait to be prompted — keeping their connection up would only keep the run
/// from settling, with nobody left to read what the work produced.
pub(crate) fn agent_resumes_after_background_work(agent_type: AgentType) -> bool {
    matches!(agent_type, AgentType::ClaudeCode | AgentType::Grok)
}

/// A wire label for a [`ConnectionBusy`] reason (timeline payloads, logs).
pub(crate) fn busy_label(reason: ConnectionBusy) -> &'static str {
    match reason {
        ConnectionBusy::Turn => "turn",
        ConnectionBusy::PendingPermission => "pending_permission",
        ConnectionBusy::BackgroundWork => "background_work",
        ConnectionBusy::RemoteControl => "remote_control",
        ConnectionBusy::DelegatedChild => "delegated_child",
        ConnectionBusy::Goal => "goal",
    }
}

/// What a connection is doing after its turn ended, read in one go.
#[derive(Debug, Clone)]
pub(crate) struct TurnEndProbe {
    /// The first reason the run must not settle yet (see [`turn_end_blocker`]).
    pub blocker: Option<ConnectionBusy>,
    /// The two clocks the agent's background reports move: the transcript
    /// watcher's and the async-task table's. A change between two looks is
    /// activity even when nothing is running at either instant — a background
    /// task's terminal frame, say, just before the turn that reads it opens.
    pub activity: (Option<DateTime<Utc>>, Option<DateTime<Utc>>),
    /// See [`SessionState::last_background_reply`].
    pub last_background_reply: Option<(DateTime<Utc>, String)>,
    /// When the connection's last turn ended
    /// ([`SessionState::last_turn_completed_at`]), with the answer it gave, if
    /// any — on the same clock as `last_background_reply`, so the two can be
    /// ordered.
    pub last_turn: Option<(DateTime<Utc>, Option<String>)>,
    /// The background work still running, one short description each.
    pub running: Vec<String>,
}

/// Why a connection whose turn just ended must stay up, or `None` when its
/// run can settle now.
///
/// The idle sweep's reasons ([`crate::acp::manager`]'s `teardown_blocker`),
/// narrowed to what the agent itself is still doing:
/// - a permission the agent is waiting on;
/// - background work, for an agent that carries on by itself once it ends
///   ([`agent_resumes_after_background_work`]);
/// - a codeg delegation whose child still runs: ending the parent cancels
///   every child it has in flight, mid-edit, whatever the agent;
/// - a turn in flight — one the agent started on its own (Grok), or a prompt
///   someone sent the session meanwhile. Last, because it alone never STARTS
///   a hold (see [`should_hold`]); it only keeps one going.
///
/// Not Remote Control or an open goal loop: neither is work the turn left
/// behind, and both kept their old behaviour (the run settles, the connection
/// ends).
pub(crate) fn turn_end_blocker(
    state: &SessionState,
    agent_type: AgentType,
    now: DateTime<Utc>,
    child_live: impl Fn(&str) -> bool,
) -> Option<ConnectionBusy> {
    if state.pending_permission.is_some() {
        return Some(ConnectionBusy::PendingPermission);
    }
    if agent_resumes_after_background_work(agent_type)
        && background_work_running(state, agent_type, now)
    {
        return Some(ConnectionBusy::BackgroundWork);
    }
    if state
        .delegated_children
        .iter()
        .any(|child| child_live(child))
    {
        return Some(ConnectionBusy::DelegatedChild);
    }
    if state.turn_in_flight || state.status == ConnectionStatus::Prompting {
        return Some(ConnectionBusy::Turn);
    }
    None
}

/// Whether this agent's async-task table carries every kind of background
/// work it runs, so that the table can stand in for the watcher's count.
/// claude-agent-acp publishes every background shell and monitor there, and
/// the agent's own follow-up turn. Grok publishes only its workflow runs: its
/// background sub-agents are counted by `BackgroundActivity` alone.
fn async_table_is_complete(agent_type: AgentType) -> bool {
    matches!(agent_type, AgentType::ClaudeCode)
}

/// Whether the async-task table alone decides what still runs — see
/// [`background_work_running`].
fn async_table_decides(state: &SessionState, agent_type: AgentType) -> bool {
    async_table_is_complete(agent_type) && !state.async_tasks.is_empty()
}

/// Whether background work still runs, for a hold.
///
/// The idle sweeps OR the transcript watcher's count with the async-task table
/// ([`SessionState::has_active_background_work`]): a false "still running"
/// costs them one idle connection. A hold pays more for one — a task stuck in
/// "running" until the cap — so once an adapter whose table is complete
/// ([`async_table_is_complete`]) has published a row, that table alone
/// decides: it carries an explicit terminal state per task, where the
/// watcher infers its count from transcript records that can go missing. Any
/// other adapter — one that never published a row, or one whose table covers
/// only part of its work — keeps the OR: a source that only one of them
/// reports must not settle the run under work still running.
fn background_work_running(
    state: &SessionState,
    agent_type: AgentType,
    now: DateTime<Utc>,
) -> bool {
    if async_table_decides(state, agent_type) {
        state.has_live_async_task(now)
    } else {
        state.has_active_background_work(now)
    }
}

/// Most descriptions kept per probe — what a card or a timeline entry has room
/// for, not a functional limit.
const MAX_RUNNING_LISTED: usize = 8;
/// Longest single description, in chars.
const MAX_DESCRIPTION_CHARS: usize = 120;

/// The background work still running on this connection, described: the
/// async-task rows that are not terminal (the agent's own autonomous turn
/// aside), and — unless that table alone decides — what the transcript watcher
/// still counts (the same source rule as [`background_work_running`]).
fn running_work(state: &SessionState, agent_type: AgentType) -> Vec<String> {
    fn push(text: &str, out: &mut Vec<String>) {
        let text: String = text.trim().chars().take(MAX_DESCRIPTION_CHARS).collect();
        if !text.is_empty() && !out.contains(&text) {
            out.push(text);
        }
    }
    let mut ids = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for task in state.async_tasks.values() {
        if async_task_state_is_terminal(&task.state) || task.task_type == AUTONOMOUS_TURN_TASK_TYPE
        {
            continue;
        }
        ids.insert(task.task_id.as_str());
        let label = if task.description.trim().is_empty() {
            &task.name
        } else {
            &task.description
        };
        push(label, &mut out);
    }
    if !async_table_decides(state, agent_type) {
        for task in &state.background_outstanding_tasks {
            if ids.insert(task.task_id.as_str()) {
                push(
                    task.description.as_deref().unwrap_or(&task.task_id),
                    &mut out,
                );
            }
        }
    }
    out.truncate(MAX_RUNNING_LISTED);
    out
}

/// Read a connection for [`TurnEndProbe`]. `None` when it is no longer usable:
/// gone from the map, or its agent ended (`Disconnected` / `Error`).
pub(crate) fn probe(
    state: &SessionState,
    agent_type: AgentType,
    now: DateTime<Utc>,
    child_live: impl Fn(&str) -> bool,
) -> Option<TurnEndProbe> {
    if matches!(
        state.status,
        ConnectionStatus::Disconnected | ConnectionStatus::Error
    ) {
        return None;
    }
    Some(TurnEndProbe {
        blocker: turn_end_blocker(state, agent_type, now, child_live),
        activity: (state.background_activity_at, state.async_task_activity_at),
        last_background_reply: state.last_background_reply.clone(),
        last_turn: state
            .last_turn_completed_at
            .map(|at| (at, turn_reply_of(state).map(|(_, text)| text))),
        running: running_work(state, agent_type),
    })
}

/// Whether the run whose turn on `conn_id` just ended with `stop_reason` should
/// be held open instead of settled — and if so, what the connection is doing.
///
/// Only a turn that ended normally (`end_turn`) is held: a cancel, an error or
/// a refused prompt settles at once, as it always has. And only for work the
/// turn left behind — a turn already running again (a prompt someone sent the
/// session the moment it ended) is not that, and settles as before; once a
/// hold is on, though, such a turn keeps it going. The engine adds its own
/// conditions on top: that holding is on at all ([`HoldTiming::from_env`]),
/// and, for a work task, that the agent did not close it with `task_complete`
/// already.
pub(crate) async fn should_hold(
    manager: &ConnectionManager,
    conn_id: &str,
    stop_reason: &str,
) -> Option<TurnEndProbe> {
    if stop_reason != "end_turn" {
        return None;
    }
    manager
        .turn_end_probe(conn_id)
        .await
        .filter(|probe| probe.blocker.is_some_and(|b| b != ConnectionBusy::Turn))
}

/// How a hold ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HoldOutcome {
    /// Nothing ran and nothing moved for [`HoldTiming::quiet`].
    Drained,
    /// [`HoldTiming::cap`] ran out with work still going.
    TimedOut,
    /// The caller cancelled the wait.
    Stopped,
    /// The connection went away by itself (its agent exited, or something else
    /// ended it).
    ConnectionLost,
}

impl HoldOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            HoldOutcome::Drained => "drained",
            HoldOutcome::TimedOut => "timeout",
            HoldOutcome::Stopped => "stopped",
            HoldOutcome::ConnectionLost => "connection_lost",
        }
    }
}

/// The answer the connection's last turn gave, stamped when that turn ended
/// ([`SessionState::last_turn_completed_at`]).
fn turn_reply_of(state: &SessionState) -> Option<(DateTime<Utc>, String)> {
    let at = state.last_turn_completed_at?;
    let text = state
        .last_assistant_text
        .clone()
        .filter(|text| !text.trim().is_empty())?;
    Some((at, text))
}

/// Read [`turn_reply_of`] off a live connection: what a turn that just ended
/// on a held connection leaves for the settle ([`LaterTurns::record`]).
pub(crate) async fn last_turn_reply(
    manager: &ConnectionManager,
    conn_id: &str,
) -> Option<(DateTime<Utc>, String)> {
    let (state, _) = manager.get_state_and_emitter(conn_id).await?;
    let state = state.read().await;
    turn_reply_of(&state)
}

impl TurnEndProbe {
    /// The answer the connection's last turn gave, with when it ended.
    fn turn_reply(&self) -> Option<(DateTime<Utc>, String)> {
        match &self.last_turn {
            Some((at, Some(text))) => Some((*at, text.clone())),
            _ => None,
        }
    }

    /// When the turn this probe followed ended — the start of a hold begun on
    /// it, on the clock its answers are stamped with
    /// ([`HoldResult::latest_reply`]). Now, for a connection that never
    /// recorded one.
    pub(crate) fn turn_ended_at(&self) -> DateTime<Utc> {
        self.last_turn
            .as_ref()
            .map(|(at, _)| *at)
            .unwrap_or_else(Utc::now)
    }
}

/// What the turns that ended on a held connection after the held one leave
/// for its settle. A turn the agent starts on its own (Grok), or a prompt
/// someone sends the task's session while it waits, ends with a
/// `TurnComplete` of its own — a later word on the run than the held turn's
/// `end_turn` and answer.
#[derive(Debug, Default)]
pub(crate) struct LaterTurns {
    /// The newest answer one of them gave, stamped by the session when its
    /// turn ended ([`last_turn_reply`]). Kept here because the session keeps
    /// only its last turn's answer — a turn that said nothing clears it — and
    /// goes with the connection.
    pub reply: Option<(DateTime<Utc>, String)>,
    /// How the first such turn that did not end normally (`end_turn`) ended:
    /// stopped, refused, failed. The run settles that way.
    pub ended: Option<String>,
}

impl LaterTurns {
    /// Note a later turn's end, with the connection's last turn answer read
    /// as it was handled. `true` when it ends the wait: a turn that was
    /// stopped or failed is how the run ends now, as it would have been for
    /// the held turn itself.
    pub(crate) fn record(
        &mut self,
        stop_reason: &str,
        reply: Option<(DateTime<Utc>, String)>,
    ) -> bool {
        if let Some(reply) = reply {
            if self.reply.as_ref().is_none_or(|(at, _)| *at < reply.0) {
                self.reply = Some(reply);
            }
        }
        if stop_reason == "end_turn" {
            return false;
        }
        self.ended.get_or_insert_with(|| stop_reason.to_string());
        true
    }
}

/// What [`wait_until_settled`] saw last.
#[derive(Debug, Clone)]
pub(crate) struct HoldResult {
    pub outcome: HoldOutcome,
    /// The last look at the connection, `None` once it is gone. Read the
    /// agent's final answer and what is still running from it — before ending
    /// the connection, after which there is nothing left to read.
    pub last: Option<TurnEndProbe>,
}

impl HoldResult {
    /// The newest answer the agent gave after `since` — the held turn's end
    /// ([`TurnEndProbe::turn_ended_at`]) — if any: what it wrote in a turn of
    /// its own (the result it read once its background work finished), or the
    /// answer of a later turn on the connection (as the last look found it, or
    /// as `later` kept it), whichever came last. All are stamped by the
    /// session as they arrive, so the order is theirs, not that of whoever
    /// read them.
    pub(crate) fn latest_reply(&self, since: DateTime<Utc>, later: &LaterTurns) -> Option<String> {
        let probe = self.last.as_ref();
        let background = probe.and_then(|probe| probe.last_background_reply.clone());
        let turn = probe.and_then(TurnEndProbe::turn_reply);
        [background, turn, later.reply.clone()]
            .into_iter()
            .flatten()
            .filter(|(at, _)| *at > since)
            .max_by_key(|(at, _)| *at)
            .map(|(_, text)| text)
    }

    /// What was still running when the wait ended (empty once drained).
    pub(crate) fn leftover(&self) -> &[String] {
        match self.outcome {
            HoldOutcome::TimedOut | HoldOutcome::Stopped => self
                .last
                .as_ref()
                .map(|probe| probe.running.as_slice())
                .unwrap_or(&[]),
            HoldOutcome::Drained | HoldOutcome::ConnectionLost => &[],
        }
    }
}

/// Wait until the run held on `conn_id` can settle. See the module docs.
pub(crate) async fn wait_until_settled(
    manager: &ConnectionManager,
    conn_id: &str,
    timing: HoldTiming,
    stop: &CancellationToken,
) -> HoldResult {
    let started = tokio::time::Instant::now();
    let mut quiet_since: Option<tokio::time::Instant> = None;
    let mut last: Option<TurnEndProbe> = None;
    loop {
        if stop.is_cancelled() {
            // Looked at afresh: the last poll may be a whole interval old, or
            // not have happened yet when the stop came straight away.
            let last = manager.turn_end_probe(conn_id).await.or(last);
            return HoldResult {
                outcome: HoldOutcome::Stopped,
                last,
            };
        }
        let Some(probe) = manager.turn_end_probe(conn_id).await else {
            // The last look is all that is left of what the agent said: a
            // follow-up reply it gave before going away still counts.
            return HoldResult {
                outcome: HoldOutcome::ConnectionLost,
                last,
            };
        };
        let now = tokio::time::Instant::now();
        let moved = last
            .as_ref()
            .is_some_and(|prev| prev.activity != probe.activity);
        let busy = probe.blocker.is_some() || moved;
        last = Some(probe);
        if busy {
            quiet_since = None;
        } else if now.duration_since(*quiet_since.get_or_insert(now)) >= timing.quiet {
            return HoldResult {
                outcome: HoldOutcome::Drained,
                last,
            };
        }
        if now.duration_since(started) >= timing.cap {
            return HoldResult {
                outcome: HoldOutcome::TimedOut,
                last,
            };
        }
        tokio::select! {
            _ = tokio::time::sleep(timing.poll) => {}
            _ = stop.cancelled() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::{AcpEvent, AsyncTaskDelta};
    use crate::web::event_bridge::EventEmitter;

    const CONN: &str = "conn-held";

    fn timing(cap_secs: u64) -> HoldTiming {
        HoldTiming {
            poll: HOLD_POLL,
            quiet: HOLD_QUIET,
            cap: Duration::from_secs(cap_secs),
        }
    }

    fn delta(task_id: &str, task_type: &str, state: &str, spawned: bool) -> AcpEvent {
        let delta: AsyncTaskDelta = serde_json::from_value(serde_json::json!({
            "task_id": task_id,
            "spawned": spawned,
            "name": format!("{task_type} {task_id}"),
            "task_type": task_type,
            "description": format!("run {task_id}"),
            "state": state,
        }))
        .expect("delta");
        AcpEvent::AsyncTask { delta }
    }

    async fn connection(agent_type: AgentType) -> ConnectionManager {
        let manager = ConnectionManager::new();
        manager
            .insert_test_connection(CONN, agent_type, None, EventEmitter::Noop)
            .await;
        manager
    }

    async fn apply(manager: &ConnectionManager, event: AcpEvent) {
        let state = manager.get_state(CONN).await.expect("state");
        state.write().await.apply_event(&event);
    }

    #[tokio::test]
    async fn only_self_resuming_agents_hold_for_background_work() {
        for (agent_type, held) in [
            (AgentType::ClaudeCode, true),
            (AgentType::Grok, true),
            (AgentType::Codex, false),
        ] {
            let manager = connection(agent_type).await;
            apply(&manager, delta("b1", "shell", "running", true)).await;
            let probe = should_hold(&manager, CONN, "end_turn").await;
            assert_eq!(probe.is_some(), held, "{agent_type:?}");
            if let Some(probe) = probe {
                assert_eq!(probe.blocker, Some(ConnectionBusy::BackgroundWork));
                assert_eq!(probe.running, vec!["run b1".to_string()]);
            }
        }
    }

    #[tokio::test]
    async fn only_a_normal_turn_end_with_work_left_holds() {
        let manager = connection(AgentType::ClaudeCode).await;
        assert!(
            should_hold(&manager, CONN, "end_turn").await.is_none(),
            "nothing running: settle now"
        );
        apply(&manager, delta("b1", "shell", "running", true)).await;
        for stop_reason in ["cancelled", "max_tokens", "refusal", "rejected"] {
            assert!(
                should_hold(&manager, CONN, stop_reason).await.is_none(),
                "{stop_reason}"
            );
        }
        assert!(should_hold(&manager, CONN, "end_turn").await.is_some());
        assert!(
            should_hold(&manager, "conn-gone", "end_turn")
                .await
                .is_none(),
            "no connection, nothing to hold"
        );
    }

    /// A delegation child outlives the turn that started it whatever the
    /// agent, and ending its parent cancels it mid-work.
    #[tokio::test]
    async fn a_live_delegated_child_holds_any_agent() {
        let manager = connection(AgentType::Codex).await;
        manager
            .insert_test_connection("conn-child", AgentType::Codex, None, EventEmitter::Noop)
            .await;
        {
            let state = manager.get_state(CONN).await.expect("state");
            state
                .write()
                .await
                .delegated_children
                .insert("conn-child".into());
        }
        let probe = should_hold(&manager, CONN, "end_turn").await.expect("held");
        assert_eq!(probe.blocker, Some(ConnectionBusy::DelegatedChild));
        manager.disconnect("conn-child").await.expect("child ends");
        assert!(should_hold(&manager, CONN, "end_turn").await.is_none());
    }

    /// What the transcript watcher (or Grok's sub-agent accounting) reports:
    /// `outstanding` tasks, the one listed described as "watched build".
    fn watcher(outstanding: u32) -> AcpEvent {
        AcpEvent::BackgroundActivity {
            session_id: "sid".into(),
            turns: vec![],
            outstanding,
            outstanding_tasks: vec![crate::acp::types::BackgroundOutstandingTask {
                task_id: "w1".into(),
                kind: crate::acp::types::BackgroundTaskKind::Shell,
                tool_use_id: None,
                description: Some("watched build".into()),
                started_at_ms: 0,
            }],
            settled: vec![],
            watermark: 0,
        }
    }

    /// With async tasks published, their terminal states decide: a watcher
    /// count that never settled must not keep a run waiting for an hour. With
    /// none published, the watcher is all there is.
    #[tokio::test]
    async fn the_async_task_table_outranks_the_watcher_count() {
        let manager = connection(AgentType::ClaudeCode).await;
        apply(&manager, watcher(1)).await;
        let probe = should_hold(&manager, CONN, "end_turn").await.expect("held");
        assert_eq!(probe.running, vec!["watched build".to_string()]);

        apply(&manager, delta("b1", "shell", "running", true)).await;
        apply(&manager, delta("b1", "shell", "completed", false)).await;
        assert!(
            should_hold(&manager, CONN, "end_turn").await.is_none(),
            "every published task is terminal"
        );
    }

    /// Grok's table holds only its workflow runs; a background sub-agent is
    /// counted by `BackgroundActivity` alone. A finished workflow must not
    /// hide a sub-agent still running.
    #[tokio::test]
    async fn a_partial_async_task_table_does_not_outrank_the_other_count() {
        let manager = connection(AgentType::Grok).await;
        apply(&manager, watcher(1)).await;
        apply(&manager, delta("wf1", "workflow", "running", true)).await;
        let probe = should_hold(&manager, CONN, "end_turn").await.expect("held");
        assert_eq!(
            probe.running,
            vec!["run wf1".to_string(), "watched build".to_string()]
        );

        apply(&manager, delta("wf1", "workflow", "completed", false)).await;
        let probe = should_hold(&manager, CONN, "end_turn")
            .await
            .expect("the sub-agent still runs");
        assert_eq!(probe.blocker, Some(ConnectionBusy::BackgroundWork));
        assert_eq!(probe.running, vec!["watched build".to_string()]);

        apply(&manager, watcher(0)).await;
        assert!(should_hold(&manager, CONN, "end_turn").await.is_none());
    }

    /// A turn in flight keeps a hold going but never starts one: what the
    /// held turn left behind is the question, not a turn someone started next.
    #[tokio::test]
    async fn a_turn_in_flight_alone_does_not_start_a_hold() {
        let manager = connection(AgentType::Grok).await;
        {
            let state = manager.get_state(CONN).await.expect("state");
            state.write().await.turn_in_flight = true;
        }
        assert!(should_hold(&manager, CONN, "end_turn").await.is_none());
        assert_eq!(
            manager.turn_end_probe(CONN).await.expect("probe").blocker,
            Some(ConnectionBusy::Turn),
            "but it is still work a running hold waits out"
        );
    }

    #[tokio::test]
    async fn the_agents_own_turn_keeps_the_hold_but_is_not_listed() {
        let manager = connection(AgentType::ClaudeCode).await;
        apply(
            &manager,
            delta("autonomous-turn-1", "turn", "running", true),
        )
        .await;
        apply(&manager, delta("b2", "monitor", "running", true)).await;
        let probe = manager.turn_end_probe(CONN).await.expect("probe");
        assert_eq!(probe.blocker, Some(ConnectionBusy::BackgroundWork));
        assert_eq!(probe.running, vec!["run b2".to_string()]);
    }

    /// The shape of a real hold: the gate runs, finishes, the agent's own turn
    /// opens to read it and closes; the run settles once all of that has been
    /// quiet for `HOLD_QUIET`, and not before.
    #[tokio::test(start_paused = true)]
    async fn drains_once_the_work_and_the_follow_up_turn_are_quiet() {
        let manager = connection(AgentType::ClaudeCode).await;
        apply(&manager, delta("b1", "shell", "running", true)).await;
        let stop = CancellationToken::new();
        let waiter = {
            let manager = manager.clone_ref();
            let stop = stop.clone();
            tokio::spawn(
                async move { wait_until_settled(&manager, CONN, timing(3600), &stop).await },
            )
        };
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!waiter.is_finished(), "the gate is still running");

        apply(&manager, delta("b1", "shell", "completed", false)).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        apply(
            &manager,
            delta("autonomous-turn-1", "turn", "running", true),
        )
        .await;
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!waiter.is_finished(), "the agent is reading the result");

        apply(
            &manager,
            delta("autonomous-turn-1", "turn", "completed", false),
        )
        .await;
        let settled_at = tokio::time::Instant::now();
        let result = waiter.await.expect("waiter");
        assert_eq!(result.outcome, HoldOutcome::Drained);
        let waited = tokio::time::Instant::now().duration_since(settled_at);
        assert!(
            waited >= HOLD_QUIET && waited <= HOLD_QUIET + 3 * HOLD_POLL,
            "settles one quiet window after the last activity, took {waited:?}"
        );
        assert!(result.leftover().is_empty());
        assert!(
            manager.get_state(CONN).await.is_some(),
            "waiting never ends the connection itself"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn times_out_with_what_is_still_running() {
        let manager = connection(AgentType::ClaudeCode).await;
        apply(&manager, delta("dev", "shell", "running", true)).await;
        let stop = CancellationToken::new();
        let result = wait_until_settled(&manager, CONN, timing(120), &stop).await;
        assert_eq!(result.outcome, HoldOutcome::TimedOut);
        assert_eq!(result.leftover(), ["run dev".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_ends_the_wait_at_once() {
        let manager = connection(AgentType::ClaudeCode).await;
        apply(&manager, delta("dev", "shell", "running", true)).await;
        let stop = CancellationToken::new();
        let waiter = {
            let manager = manager.clone_ref();
            let stop = stop.clone();
            tokio::spawn(
                async move { wait_until_settled(&manager, CONN, timing(3600), &stop).await },
            )
        };
        tokio::time::sleep(Duration::from_secs(30)).await;
        stop.cancel();
        let result = waiter.await.expect("waiter");
        assert_eq!(result.outcome, HoldOutcome::Stopped);
        assert_eq!(result.leftover(), ["run dev".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_that_goes_away_ends_the_wait() {
        let manager = connection(AgentType::ClaudeCode).await;
        apply(&manager, delta("b1", "shell", "running", true)).await;
        let stop = CancellationToken::new();
        let waiter = {
            let manager = manager.clone_ref();
            let stop = stop.clone();
            tokio::spawn(
                async move { wait_until_settled(&manager, CONN, timing(3600), &stop).await },
            )
        };
        let since = Utc::now();
        {
            let state = manager.get_state(CONN).await.expect("state");
            state.write().await.last_background_reply = Some((Utc::now(), "all green".into()));
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
        manager.disconnect(CONN).await.expect("disconnect");
        let result = waiter.await.expect("waiter");
        assert_eq!(result.outcome, HoldOutcome::ConnectionLost);
        assert_eq!(
            result
                .latest_reply(since, &LaterTurns::default())
                .as_deref(),
            Some("all green"),
            "what the agent said before going away is kept"
        );
    }

    fn answered(
        background: Option<(DateTime<Utc>, &str)>,
        turn: Option<(DateTime<Utc>, Option<&str>)>,
    ) -> HoldResult {
        HoldResult {
            outcome: HoldOutcome::Drained,
            last: Some(TurnEndProbe {
                blocker: None,
                activity: (None, None),
                last_background_reply: background.map(|(at, text)| (at, text.to_string())),
                last_turn: turn.map(|(at, text)| (at, text.map(str::to_string))),
                running: Vec::new(),
            }),
        }
    }

    #[test]
    fn a_follow_up_reply_counts_only_after_the_hold_began() {
        let since = Utc::now();
        let secs = chrono::Duration::seconds;
        let none = LaterTurns::default();
        assert_eq!(
            answered(Some((since + secs(5), "all green")), None).latest_reply(since, &none),
            Some("all green".to_string())
        );
        assert_eq!(
            answered(Some((since - secs(5), "all green")), None).latest_reply(since, &none),
            None,
            "an answer from before the hold is the turn's own, already captured"
        );
        assert_eq!(
            answered(None, Some((since, Some("still running")))).latest_reply(since, &none),
            None,
            "the held turn's own answer is not a later one"
        );
    }

    /// A background reply and a later turn's answer: the newer one is the
    /// run's result, whichever kind it is — by when the session stamped each.
    #[test]
    fn the_newest_of_the_two_kinds_of_answer_wins() {
        let since = Utc::now();
        let at = |secs: i64| since + chrono::Duration::seconds(secs);
        let none = LaterTurns::default();
        let background = Some((at(5), "gate failed"));
        assert_eq!(
            answered(background, Some((at(9), Some("gate passed"))))
                .latest_reply(since, &none)
                .as_deref(),
            Some("gate passed")
        );
        assert_eq!(
            answered(background, Some((at(2), Some("looking into it"))))
                .latest_reply(since, &none)
                .as_deref(),
            Some("gate failed")
        );
    }

    /// A later turn's answer the engine kept outlives what the session still
    /// shows: a turn after it that said nothing, or the connection gone before
    /// the next look.
    #[test]
    fn a_kept_later_answer_outlives_the_session() {
        let since = Utc::now();
        let at = |secs: i64| since + chrono::Duration::seconds(secs);
        let mut later = LaterTurns::default();
        assert!(!later.record("end_turn", Some((at(7), "gate failed".into()))));
        let empty_turn_after = answered(Some((at(5), "gate passed")), Some((at(9), None)));
        assert_eq!(
            empty_turn_after.latest_reply(since, &later).as_deref(),
            Some("gate failed")
        );
        let gone = HoldResult {
            outcome: HoldOutcome::ConnectionLost,
            last: None,
        };
        assert_eq!(
            gone.latest_reply(since, &later).as_deref(),
            Some("gate failed")
        );
        // An older read never replaces a newer one.
        assert!(!later.record("end_turn", Some((at(6), "stale".into()))));
        assert_eq!(
            later.reply.as_ref().map(|(_, t)| t.as_str()),
            Some("gate failed")
        );
    }

    /// A later turn that ended otherwise than normally ends the wait, and the
    /// first such end is the one the run settles on.
    #[test]
    fn a_later_turn_that_did_not_end_normally_ends_the_wait() {
        let mut later = LaterTurns::default();
        assert!(!later.record("end_turn", None));
        assert!(later.ended.is_none());
        assert!(later.record("cancelled", None));
        assert!(later.record("refusal", None));
        assert_eq!(later.ended.as_deref(), Some("cancelled"));
    }

    /// The probe reads the last turn's answer with the time the session
    /// stamped it, and a hold begun on that turn starts from that time.
    #[tokio::test]
    async fn the_last_turn_is_read_with_the_sessions_stamp() {
        let manager = connection(AgentType::ClaudeCode).await;
        let ended = Utc::now() - chrono::Duration::seconds(3);
        {
            let state = manager.get_state(CONN).await.expect("state");
            let mut s = state.write().await;
            s.last_assistant_text = Some("done".into());
            s.last_turn_completed_at = Some(ended);
        }
        let probe = manager.turn_end_probe(CONN).await.expect("probe");
        assert_eq!(probe.last_turn, Some((ended, Some("done".to_string()))));
        assert_eq!(probe.turn_ended_at(), ended);
    }
}
