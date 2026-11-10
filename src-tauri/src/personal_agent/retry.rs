//! Work a restart interrupted is retried by codeg itself (7.3): once per
//! interruption, at most `retry_rounds` times for one dispatch (2 unless the
//! owner changes it), then it is the owner's. With "ask me first" the owner
//! gets a card to retry it instead.
//!
//! Each retry is an operation of its own, `pa-retry-<dispatch>-<round>`: the
//! round is the one the restart cut off (a session's turn count, a task's
//! run), so a second restart before the retry went out finds it on record
//! and does not retry the same round twice.

use std::sync::Arc;

use serde_json::json;

use super::dispatch::{executor_of, FollowupAuth};
use super::engine::PersonalAgentEngine;
use super::notices::ProposalAction;
use crate::db::entities::personal_agent_dispatch::{self as dispatch_entity, DispatchMode, DispatchState};
use crate::db::entities::personal_agent_notice::NoticeKind;
use crate::db::service::personal_agent_service as svc;
use crate::models::personal_agent_prefs::AskFirst;

/// What the executor is told when its interrupted work is picked up again.
pub const RETRY_MESSAGE: &str = "codeg restarted while you were working on this, and your turn \
was cut off. Pick it up where you left off and finish it.";

/// What codeg does about a dispatch a restart interrupted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryPlan {
    /// Retried by codeg: the `attempt`th of at most `max`.
    Auto { attempt: u32, max: u32 },
    /// The owner is asked on a card first.
    Ask,
    /// Retried `max` times already: the owner's now.
    Exhausted { max: u32 },
    /// The owner turned automatic retries off.
    Off,
    /// This round's retry is on record already.
    Done,
}

impl RetryPlan {
    /// What the result card says about it.
    pub fn card(self) -> serde_json::Value {
        match self {
            Self::Auto { attempt, max } => json!({ "state": "pending", "attempt": attempt, "max": max }),
            Self::Ask => json!({ "state": "asked" }),
            Self::Exhausted { max } => json!({ "state": "exhausted", "max": max }),
            Self::Off | Self::Done => serde_json::Value::Null,
        }
    }

    /// What the assistant is told about it, and whether it needs waking.
    pub fn sentence(self) -> Option<(String, bool)> {
        match self {
            Self::Auto { attempt, max } => Some((
                format!(" codeg retries it by itself (attempt {attempt} of {max}); nothing for you to do."),
                false,
            )),
            Self::Ask => Some((
                " The owner is asked on a card whether to retry it.".into(),
                false,
            )),
            Self::Exhausted { max } => Some((
                format!(" codeg retried it {max} times already; whether to go on is the owner's call."),
                true,
            )),
            Self::Off | Self::Done => None,
        }
    }
}

/// The operation ids of one dispatch's retries: letters, digits and `-`
/// only, as every id riding a prompt (`pa-retry-<dispatch>-<round>`).
fn op_prefix(dispatch_id: i32) -> String {
    format!("pa-retry-{dispatch_id}-")
}

impl PersonalAgentEngine {
    /// The round a restart cut off: a session's turn, a task's run.
    async fn interrupted_round(&self, d: &dispatch_entity::Model) -> i32 {
        match (d.mode, d.work_task_id) {
            (DispatchMode::Task, Some(tid)) => {
                crate::db::service::work_task_service::get_model(&self.db.conn, tid)
                    .await
                    .map(|t| t.run_seq)
                    .unwrap_or(0)
            }
            _ => d.turns,
        }
    }

    /// What codeg does about dispatch `d` a restart interrupted.
    pub(super) async fn retry_plan(&self, d: &dispatch_entity::Model) -> RetryPlan {
        let prefs = self.prefs().await;
        let max = prefs.retry_rounds;
        if max == 0 {
            return RetryPlan::Off;
        }
        let round = self.interrupted_round(d).await;
        let op_id = format!("{}{round}", op_prefix(d.id));
        if svc::get_op(&self.db.conn, &op_id).await.ok().flatten().is_some() {
            return RetryPlan::Done;
        }
        let done = svc::count_ops_with_prefix(&self.db.conn, &op_prefix(d.id))
            .await
            .unwrap_or(0) as u32;
        if done >= max {
            return RetryPlan::Exhausted { max };
        }
        if prefs.interrupt_retry == AskFirst::Ask {
            return RetryPlan::Ask;
        }
        RetryPlan::Auto {
            attempt: done + 1,
            max,
        }
    }

    /// Retry what a restart interrupted, or put it to the owner (7.3). Only
    /// the recent ones: an old interruption is left as it is.
    pub(super) async fn retry_interrupted(self: &Arc<Self>) {
        let interrupted = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            &[DispatchState::Interrupted],
            None,
            50,
        )
        .await
        .unwrap_or_default();
        let recent = chrono::Utc::now() - chrono::Duration::days(1);
        for d in interrupted.into_iter().filter(|d| d.updated_at > recent) {
            // Only what its card says codeg goes on with: an interruption
            // told before (an older build's, one the owner was handed) is
            // left as it was told.
            let noted = match svc::latest_result_row(&self.db.conn, d.id).await {
                Ok(Some(card)) => card
                    .data
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                    .and_then(|v| v.get("auto_retry").and_then(|a| a.get("state")).and_then(|s| s.as_str()).map(str::to_string)),
                _ => None,
            };
            if !matches!(noted.as_deref(), Some("pending" | "asked")) {
                continue;
            }
            match self.retry_plan(&d).await {
                RetryPlan::Auto { attempt, max } => {
                    let round = self.interrupted_round(&d).await;
                    let op_id = format!("{}{round}", op_prefix(d.id));
                    let sent = self
                        .followup_call(d.id, RETRY_MESSAGE.into(), None, FollowupAuth::Op { op_id })
                        .await;
                    let note = match &sent {
                        Ok(_) => json!({ "state": "retried", "attempt": attempt, "max": max }),
                        Err(e) => json!({ "state": "failed", "attempt": attempt, "max": max, "error": e }),
                    };
                    if let Err(e) = &sent {
                        tracing::info!("[personal_agent] dispatch #{} was not retried: {e}", d.id);
                    }
                    self.note_retry(d.id, note).await;
                }
                RetryPlan::Ask => self.propose_retry(&d).await,
                _ => {}
            }
        }
    }

    /// The owner's card to retry dispatch `d`, once per interruption.
    async fn propose_retry(&self, d: &dispatch_entity::Model) {
        let round = self.interrupted_round(d).await;
        let subject = format!("{}{round}", op_prefix(d.id));
        let bot = self.bot().await;
        if svc::notice_of_subject(&self.db.conn, bot, NoticeKind::Proposal, &subject)
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return;
        }
        let executor = executor_of(d);
        let display = json!({
            "dispatch_id": d.id,
            "title": d.title,
            "executor": executor.name,
            "executor_id": executor.assistant_id,
            "agent_type": executor.agent_type,
            "mode": d.mode,
            "message": RETRY_MESSAGE,
            "intent": null,
            "retry": true,
        });
        let raised = self
            .raise_proposal(
                ProposalAction::Followup {
                    dispatch_id: d.id,
                    message: RETRY_MESSAGE.into(),
                    intent: None,
                },
                display,
                d.title.clone(),
                None,
                Some("interrupted by a restart".into()),
                Some(subject),
                "confirm",
            )
            .await;
        if let Err(e) = raised {
            tracing::warn!("[personal_agent] no retry card for dispatch #{}: {e}", d.id);
        }
    }

    /// Write how the automatic retry went on the dispatch's latest result
    /// card.
    async fn note_retry(&self, dispatch_id: i32, note: serde_json::Value) {
        let Ok(Some(card)) = svc::latest_result_row(&self.db.conn, dispatch_id).await else {
            return;
        };
        let mut data = card
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .unwrap_or_else(|| json!({}));
        if let Some(map) = data.as_object_mut() {
            map.insert("auto_retry".into(), note);
        }
        let _ = svc::update_row_data(&self.db.conn, card.id, None, Some(data)).await;
        if let Ok(Some(updated)) = svc::get_row(&self.db.conn, card.id).await {
            self.emit_rows(vec![svc::to_row(updated)]);
        }
    }
}
