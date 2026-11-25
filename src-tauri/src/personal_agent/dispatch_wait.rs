//! `dispatch_wait`: the assistant waits, within the turn it is answering,
//! for news of work it handed out — for when the owner wants the result in
//! this reply ("have it checked, then tell me").
//!
//! Without it an assistant that wants to answer in one go sleeps and polls
//! the work's session, reads the result there and reports it; the news then
//! reaches it once more as an event after the turn, and it reports it again.
//! With it the news comes back numbered, as an event's line would, and the
//! turn may report it: what its reply said in full it reported (its
//! `[[quote:#N]]`) is settled with the turn and not delivered again.
//!
//! Waiting changes nothing. The news stays pending while the turn runs, so
//! a turn that is cut off, stopped, gives way to the owner or never marks
//! it leaves it to go out as ever — nothing is lost for having been seen.
//! Bounded (`MAX_WAIT`, under the shortest tool-call timeout an agent host
//! puts on an MCP call), and ended early once the turn is over or told to
//! give way to the owner.

use std::time::Duration;

use super::cards;
use super::dispatch::state_sentence;
use super::engine::{enum_str, PersonalAgentEngine};
use super::tools::ToolOutcome;
use crate::db::entities::personal_agent_dispatch::{DispatchMode, DispatchState};
use crate::db::entities::personal_agent_event::EventState;
use crate::db::service::personal_agent_service as svc;

/// The longest one call waits, and how long it waits when not told: under
/// the 60 s a codex host gives an MCP tool call, with room for the round
/// trip. Waiting longer is another call.
pub const MAX_WAIT: Duration = Duration::from_secs(45);

/// How often the news is looked for while waiting.
const TICK: Duration = Duration::from_millis(500);

/// What one look at the work found.
enum Look {
    /// Something to say: the call ends with it.
    Done(ToolOutcome),
    /// Nothing yet.
    Wait,
}

impl PersonalAgentEngine {
    /// `dispatch_wait`: wait up to `wait` (`MAX_WAIT` at most) for news of
    /// dispatch `id`, this assistant's own, while it answers a delivery.
    pub(super) async fn dispatch_wait(&self, id: i32, wait: Option<Duration>) -> ToolOutcome {
        let Some((batch_id, _)) = self.waiting_turn().await else {
            return ToolOutcome::refused(
                "dispatch_wait works only while you are answering: news of your work comes to \
                 you as events",
            );
        };
        let bot = self.bot().await;
        let d = match svc::get_dispatch_of(&self.db.conn, bot, id).await {
            Ok(Some(d)) => d,
            Ok(None) => return ToolOutcome::refused(format!("dispatch #{id} does not exist")),
            Err(e) => return ToolOutcome::refused(e.to_string()),
        };
        // An acceptance check is codeg's, and its verdict is drawn on the
        // work it checks: it comes as an event, with that work.
        if d.is_check {
            return ToolOutcome::refused(format!(
                "dispatch #{id} is the acceptance check codeg runs; its verdict comes to you as an \
                 event"
            ));
        }
        let budget = wait.unwrap_or(MAX_WAIT).min(MAX_WAIT);
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            match self.waiting_turn().await {
                Some((b, false)) if b == batch_id => {}
                Some((b, true)) if b == batch_id => {
                    return ToolOutcome::ok(
                        format!(
                            "Stopped waiting: the owner just wrote. End your reply now; news of \
                             dispatch #{id} comes to you as an event."
                        ),
                        serde_json::json!({ "dispatch_id": id, "waiting": "stopped" }),
                    );
                }
                _ => return ToolOutcome::refused("your turn is over; this wait ended with it"),
            }
            if let Look::Done(outcome) = self.look_for_news(id, bot, batch_id).await {
                return outcome;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                let state = svc::get_dispatch_of(&self.db.conn, bot, id)
                    .await
                    .ok()
                    .flatten()
                    .map(|d| d.state)
                    .unwrap_or(d.state);
                return ToolOutcome::ok(
                    format!(
                        "Dispatch #{id} {} after {} s of waiting. Wait again with dispatch_wait if \
                         the owner asked for the result in this reply and it should be done soon; \
                         otherwise end your reply saying it is under way — its result comes to \
                         you as an event.",
                        state_sentence(state),
                        budget.as_secs()
                    ),
                    serde_json::json!({ "dispatch_id": id, "state": state, "waiting": "timed_out" }),
                );
            }
            tokio::time::sleep(TICK.min(deadline - now)).await;
        }
    }

    /// Code work in review that its assistant has checked before it hears
    /// of it (7.5), as the news of its review says.
    async fn accepting(&self, d: &crate::db::entities::personal_agent_dispatch::Model) -> bool {
        if d.state != DispatchState::Review || d.mode != DispatchMode::Task {
            return false;
        }
        let Some(tid) = d.work_task_id else {
            return false;
        };
        match crate::db::service::work_task_service::get_model(&self.db.conn, tid).await {
            Ok(t) => super::acceptance::wants_acceptance(d, &t, &self.prefs().await),
            Err(_) => false,
        }
    }

    /// One look at dispatch `id`: news not yet delivered, handed to the turn
    /// of `batch_id`; or why there will be none to wait for.
    async fn look_for_news(&self, id: i32, bot: i32, batch_id: i32) -> Look {
        let Ok(Some(d)) = svc::get_dispatch_of(&self.db.conn, bot, id).await else {
            return Look::Done(ToolOutcome::refused(format!("dispatch #{id} does not exist")));
        };
        // Code work in review that codeg checks first (7.5): its news says
        // only that, and what matters — the check's verdict — comes to the
        // assistant as an acceptance of its own, after the turn. Not waited
        // for here, and its news is left to go out with that.
        if self.accepting(&d).await {
            return Look::Done(ToolOutcome::ok(
                format!(
                    "Dispatch #{id} is in review and codeg has it checked (read-only) first. The \
                     check's verdict comes to you after this turn, not here: end your reply \
                     saying it is being checked."
                ),
                serde_json::json!({ "dispatch_id": id, "state": d.state, "waiting": "checking" }),
            ));
        }
        let key = format!("dispatch:{id}");
        let pending = svc::pending_events_of_coalesce(&self.db.conn, bot, &key)
            .await
            .unwrap_or_default();
        if !pending.is_empty() {
            // The newest is the news, as a delivery would say it.
            let lines = self.event_lines(&pending).await;
            let Some(line) = lines.into_iter().last() else {
                return Look::Wait;
            };
            let Some(row) = line.row_id else {
                // No card to number: it goes out as an event.
                return Look::Done(ToolOutcome::ok(
                    format!("{}\nIt comes to you as an event after this turn.", line.summary.trim()),
                    serde_json::json!({ "dispatch_id": id }),
                ));
            };
            if !self.note_waited(batch_id, row).await {
                return Look::Done(ToolOutcome::refused(
                    "your turn is over; this wait ended with it",
                ));
            }
            let block = cards::events_block(std::slice::from_ref(&line)).unwrap_or_default();
            return Look::Done(ToolOutcome::ok(
                format!(
                    "{block}\n\nThis came in while you were answering. Report it in this reply \
                     and mark it [[quote:#{row}]]: then it is settled with this reply and does not \
                     come to you again. Without the marker it comes to you as an event after \
                     this turn."
                ),
                serde_json::json!({ "dispatch_id": id, "row_id": row, "waiting": "news" }),
            ));
        }
        match d.state {
            DispatchState::Queued | DispatchState::Running => return Look::Wait,
            // A question or a permission request of its own: the owner's or
            // yours, by its own card or event — nothing to wait for here.
            DispatchState::WaitingInput => {
                return Look::Done(ToolOutcome::ok(
                    format!(
                        "Dispatch #{id} {}: it goes on once that is answered. End your reply \
                         saying so; what it asks comes to you or the owner on its own.",
                        state_sentence(d.state)
                    ),
                    serde_json::json!({ "dispatch_id": id, "state": d.state, "waiting": "input" }),
                ));
            }
            _ => {}
        }
        // Settled, and its news written already: in this turn's events, or
        // told to you before. The news of a state is written as the state
        // is, so a state with none yet is waited for.
        let latest = svc::latest_event_of_coalesce(&self.db.conn, &key)
            .await
            .ok()
            .flatten()
            .filter(|e| e.bot_id == Some(bot) && e.state != EventState::Pending);
        let told = latest.filter(|e| {
            e.payload
                .as_deref()
                .and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok())
                .and_then(|p| p.get("state").and_then(|s| s.as_str()).map(str::to_string))
                .as_deref()
                == Some(enum_str(&d.state).as_str())
        });
        let Some(e) = told else {
            return Look::Wait;
        };
        let row = svc::result_rows_of_events(&self.db.conn, &[e.id])
            .await
            .ok()
            .and_then(|rows| rows.into_iter().next())
            .map(|r| r.id);
        let ours = e.batch_id == Some(batch_id) || {
            let given = self.turn_covers(batch_id).await;
            row.is_some_and(|r| given.contains(&r))
        };
        let at = row.map(|r| format!(" [#{r}]")).unwrap_or_default();
        Look::Done(ToolOutcome::ok(
            if ours {
                format!(
                    "Dispatch #{id} {}: its news{at} is in this turn's events already.",
                    state_sentence(d.state)
                )
            } else {
                format!(
                    "Dispatch #{id} {}: its news{at} reached you earlier, nothing new since.",
                    state_sentence(d.state)
                )
            },
            serde_json::json!({ "dispatch_id": id, "state": d.state, "waiting": "told" }),
        ))
    }
}
