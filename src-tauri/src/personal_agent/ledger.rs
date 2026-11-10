//! The action ledger: what the personal agent's acting calls did — and the
//! ones codeg makes for it, such as a card the owner clicked.
//!
//! Not a restriction: it stops no call. It does two things. A batch delivered
//! again after an interruption, a message the owner sends again, a second
//! click — none of them does the same thing twice: the call finds its earlier
//! entry and gets back what it made. And a step cut off between going out and
//! being confirmed says afterwards whether it took effect, from evidence the
//! RECEIVING side gives — never from the target merely having moved, which
//! the owner, or anything else, can do too.
//!
//! An entry is `prepared` (the intent, written before anything runs),
//! `committed` (it took effect; `ref_id` names what it made), `not_executed`
//! (it certainly did not — the same call may run again) or `unknown` (that
//! cannot be told: never redone on its own; the owner gets a card).
//!
//! How each kind is made safe:
//!
//! - **A dispatch** is local and fits one transaction: the dispatch row, its
//!   entry (`committed` at once) and — when a card runs it — the card's
//!   settling commit together, or none of them does.
//! - **A follow-up of a task** goes through the board's claim, which writes
//!   a `user_action` in its own transaction; the entry's `op_id` rides in it.
//!   That record alone proves the follow-up took effect.
//! - **A follow-up of a conversation** is a send, in three marks:
//!   1. *claimed* — the claim that sets the dispatch running writes the
//!      entry's `op_id` onto it (`round_op_id`);
//!   2. *attempted* — right before the request is written to the agent, the
//!      connection has the entry marked (`attempted_at`); refused, it writes
//!      nothing (`acp::prompt_receipt`);
//!   3. *received* — the agent's own answer to that very request, or its echo
//!      of the prompt with the operation frame in it, commits the entry. So
//!      does the operation id found in the agent's OWN record of the session
//!      (`AgentParser::own_record_contains`); codeg's own copy of a prompt,
//!      written before it went out, never counts.
//!
//!   An entry left without "received": attempted → `unknown`; never attempted
//!   → `not_executed`, and the round it claimed is put back as it was.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::dispatch::executor_of;
use super::engine::{enum_str, PersonalAgentEngine};
use crate::acp::prompt_receipt::{PromptReceiptSink, ReceiptVia};
use crate::db::entities::personal_agent_action::{self as action_entity, ActionState};
use crate::db::entities::personal_agent_batch::BatchStatus;
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::personal_agent_notice::{NoticeKind, NoticeLevel, NoticeState};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{DispatchWrite, NewNotice, NewRow};
use crate::models::personal_agent::PersonalAgentChange;

// ── keys and ids ────────────────────────────────────────────────────────────

/// A title as the ledger compares it: case and spacing do not make a
/// different call.
fn normalize_title(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The ledger key of a dispatch. The prompt is left out: a turn delivered
/// again words it afresh, and the same work to the same executor in the same
/// place under the same title is the same call.
pub fn dispatch_key(
    assistant_id: i32,
    mode: DispatchMode,
    project_id: Option<i32>,
    title: &str,
) -> String {
    format!(
        "dispatch|{assistant_id}|{}|{}|{}",
        enum_str(&mode),
        project_id.map(|p| p.to_string()).unwrap_or_default(),
        normalize_title(title)
    )
}

/// The ledger key of a follow-up: one per dispatch and intent in a batch.
pub fn followup_key(dispatch_id: i32, intent: Option<&str>) -> String {
    format!("followup|{dispatch_id}|{}", intent.unwrap_or(""))
}

/// Whether `op_id` is a card's run ([`card_op_id`]).
pub fn is_card_op(op_id: &str) -> bool {
    op_id.starts_with("pa-card-")
}

/// A new operation id. Letters, digits and `-` only, so it reads back
/// verbatim from any record of the prompt it rides.
pub fn fresh_op_id() -> String {
    format!("pa-{}", uuid::Uuid::new_v4().simple())
}

/// The operation id of the `attempt`-th run of card `notice_id` (from 1):
/// stable, so a second click finds the first one's entry.
pub fn card_op_id(notice_id: i32, attempt: usize) -> String {
    if attempt <= 1 {
        format!("pa-card-{notice_id}")
    } else {
        format!("pa-card-{notice_id}-{attempt}")
    }
}

// ── what an entry keeps ─────────────────────────────────────────────────────

/// A follow-up as its entry keeps it: enough to show it and make it again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FollowupCall {
    pub dispatch_id: i32,
    pub message: String,
    #[serde(default)]
    pub intent: Option<String>,
}

/// What a follow-up acts on — for a conversation, written before the claim,
/// so a round that never went out can be put back as it was.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendTarget {
    pub dispatch_id: i32,
    #[serde(default)]
    pub task_id: Option<i32>,
    #[serde(default)]
    pub conversation_id: Option<i32>,
    /// The state the round was claimed from.
    #[serde(default)]
    pub claimed_from: Option<DispatchState>,
    /// It waits for a session slot (the dispatch is `queued`, its round this
    /// operation's).
    #[serde(default)]
    pub queued: bool,
}

pub fn parse<T: DeserializeOwned>(raw: Option<&str>) -> Option<T> {
    serde_json::from_str(raw?).ok()
}

/// The evidence an entry records, and when it came.
pub fn observed(via: &str) -> Value {
    json!({ "via": via, "at": chrono::Utc::now() })
}

/// A conversation send no longer running, judged by its own evidence alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendVerdict {
    Committed,
    NotExecuted,
    Unknown,
}

/// `received`: the agent confirmed the request; `attempted`: it was about
/// to be written; `own_record`: the agent's own record of the session holds
/// the operation id (`None`: there is none to ask). Whether the dispatch's
/// round is still this operation's does not enter: a later claim overwrites
/// it, and that proves nothing about an earlier send.
pub fn send_verdict(received: bool, attempted: bool, own_record: Option<bool>) -> SendVerdict {
    if received || (attempted && own_record == Some(true)) {
        SendVerdict::Committed
    } else if !attempted {
        SendVerdict::NotExecuted
    } else {
        SendVerdict::Unknown
    }
}

/// How an operation came out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpOutcome {
    Committed,
    NotExecuted(String),
    Unknown(String),
    /// Still running, or waiting its turn: nothing to settle yet.
    Pending,
}

/// The dispatch states a running round is in.
const ROUND_STATES: &[DispatchState] = &[DispatchState::Running, DispatchState::WaitingInput];

impl PersonalAgentEngine {
    // ── live operations ─────────────────────────────────────────────────────

    /// Mark an operation as running in this process (`true`) or done.
    pub(super) async fn set_live(&self, op_id: &str, live: bool) {
        let mut st = self.state.lock().await;
        if live {
            st.live_ops.insert(op_id.to_string());
        } else {
            st.live_ops.remove(op_id);
        }
    }

    pub(super) async fn is_live(&self, op_id: &str) -> bool {
        self.state.lock().await.live_ops.contains(op_id)
    }

    // ── settling ────────────────────────────────────────────────────────────

    /// Settle an operation that is no longer running, from its own evidence,
    /// and say how it came out. A send that never went out puts back the
    /// round it claimed (a queued one goes back in the queue, still this
    /// operation's).
    pub(super) async fn resolve_op(&self, op: &action_entity::Model) -> OpOutcome {
        let Some(op_id) = op.op_id.clone() else {
            // Recorded by the first build of the ledger, which kept no
            // operation id: a committed one stands; one still prepared was
            // cut off with nothing to tell by.
            return match op.state {
                ActionState::Committed => OpOutcome::Committed,
                s if s.not_executed() => OpOutcome::NotExecuted(String::new()),
                _ => OpOutcome::Unknown("recorded before codeg could tell".into()),
            };
        };
        match op.state {
            ActionState::Committed => return OpOutcome::Committed,
            ActionState::NotExecuted | ActionState::Failed => {
                return OpOutcome::NotExecuted(op.detail.clone().unwrap_or_default())
            }
            ActionState::Unknown => {
                return OpOutcome::Unknown(op.detail.clone().unwrap_or_default())
            }
            ActionState::Prepared => {}
        }
        if self.is_live(&op_id).await {
            return OpOutcome::Pending;
        }
        match op.kind.as_str() {
            // Written committed with what it made, in one transaction; a
            // prepared one is the first build's, cut off before its insert.
            "dispatch" => {
                if op.ref_id.is_some() {
                    let _ = svc::op_settle(
                        &self.db.conn,
                        &op_id,
                        &[ActionState::Prepared],
                        ActionState::Committed,
                        None,
                        None,
                        None,
                    )
                    .await;
                    OpOutcome::Committed
                } else {
                    let why = "it was cut off before the dispatch was recorded".to_string();
                    let _ = svc::op_settle(
                        &self.db.conn,
                        &op_id,
                        &[ActionState::Prepared],
                        ActionState::NotExecuted,
                        None,
                        Some(why.clone()),
                        None,
                    )
                    .await;
                    OpOutcome::NotExecuted(why)
                }
            }
            "followup" => self.resolve_followup(op, &op_id).await,
            _ => OpOutcome::Pending,
        }
    }

    async fn resolve_followup(&self, op: &action_entity::Model, op_id: &str) -> OpOutcome {
        let Some(call) = parse::<FollowupCall>(op.payload.as_deref()) else {
            let why = "its record is unreadable".to_string();
            let _ = svc::op_settle(
                &self.db.conn,
                op_id,
                &[ActionState::Prepared],
                ActionState::Unknown,
                None,
                Some(why.clone()),
                None,
            )
            .await;
            return OpOutcome::Unknown(why);
        };
        let target = parse::<SendTarget>(op.target.as_deref()).unwrap_or_default();
        let d = match svc::get_dispatch(&self.db.conn, call.dispatch_id).await {
            Ok(Some(d)) => d,
            _ => {
                // Nothing left to have acted on.
                let why = format!("dispatch #{} is gone", call.dispatch_id);
                let _ = svc::op_unattempted_to_not_executed(&self.db.conn, op_id, &why).await;
                return match svc::get_op(&self.db.conn, op_id).await {
                    Ok(Some(now)) if now.state.not_executed() => OpOutcome::NotExecuted(why),
                    _ => self.settle_unknown(op_id, "dispatch is gone").await,
                };
            }
        };
        if d.mode == DispatchMode::Task {
            return self.resolve_task_followup(&d, op_id).await;
        }
        let ours = d.round_op_id.as_deref() == Some(op_id);
        if op.attempted_at.is_none() {
            if target.queued && ours {
                match d.state {
                    // Still waiting for its slot.
                    DispatchState::Queued => return OpOutcome::Pending,
                    // Claimed off the queue, never sent: back in it.
                    s if ROUND_STATES.contains(&s) => {
                        let back = svc::update_dispatch(
                            &self.db.conn,
                            d.id,
                            Some(ROUND_STATES),
                            DispatchWrite {
                                state: Some(DispatchState::Queued),
                                connection_id: Some(None),
                                followup: Some(Some(call.message.clone())),
                                expect_round_op: Some(op_id.to_string()),
                                ..Default::default()
                            },
                        )
                        .await;
                        if let Ok(Some(_)) = back {
                            self.state
                                .lock()
                                .await
                                .dispatch_conns
                                .retain(|_, c| c.id != d.id);
                            self.emit(PersonalAgentChange::Dispatch { id: d.id });
                            return OpOutcome::Pending;
                        }
                    }
                    _ => {}
                }
            }
            let why = "it was never sent".to_string();
            if svc::op_unattempted_to_not_executed(&self.db.conn, op_id, &why)
                .await
                .unwrap_or(false)
            {
                // The round it claimed never ran: put it back as it was —
                // only while the round is still this operation's.
                if ours && ROUND_STATES.contains(&d.state) {
                    let back_to = target.claimed_from.unwrap_or(DispatchState::Completed);
                    if let Ok(Some(_)) = svc::update_dispatch(
                        &self.db.conn,
                        d.id,
                        Some(ROUND_STATES),
                        DispatchWrite {
                            state: Some(back_to),
                            connection_id: Some(None),
                            round_op_id: Some(None),
                            expect_round_op: Some(op_id.to_string()),
                            ..Default::default()
                        },
                    )
                    .await
                    {
                        self.state
                            .lock()
                            .await
                            .dispatch_conns
                            .retain(|_, c| c.id != d.id);
                        self.emit(PersonalAgentChange::Dispatch { id: d.id });
                    }
                }
                return OpOutcome::NotExecuted(why);
            }
            // Marked attempted meanwhile: judged as an attempted one below.
        }
        let fresh = match svc::get_op(&self.db.conn, op_id).await {
            Ok(Some(o)) => o,
            _ => return OpOutcome::Pending,
        };
        if fresh.state == ActionState::Committed {
            return OpOutcome::Committed;
        }
        let own = self.own_record_has(&d, op_id).await;
        match send_verdict(fresh.observed.is_some(), fresh.attempted_at.is_some(), own) {
            SendVerdict::Committed => {
                let _ = svc::op_received(&self.db.conn, op_id, observed("own_record")).await;
                self.outcome_now(op_id).await
            }
            SendVerdict::NotExecuted => OpOutcome::NotExecuted("it was never sent".into()),
            SendVerdict::Unknown => {
                self.settle_unknown(op_id, "it was cut off after it started going out and before the executor confirmed it")
                    .await
            }
        }
    }

    /// Settle a prepared operation as unknown.
    pub(super) async fn settle_unknown_op(&self, op_id: &str, why: &str) -> OpOutcome {
        self.settle_unknown(op_id, why).await
    }

    async fn settle_unknown(&self, op_id: &str, why: &str) -> OpOutcome {
        let settled = svc::op_settle(
            &self.db.conn,
            op_id,
            &[ActionState::Prepared],
            ActionState::Unknown,
            None,
            Some(why.to_string()),
            None,
        )
        .await
        .unwrap_or(false);
        if settled {
            OpOutcome::Unknown(why.to_string())
        } else {
            // Settled meanwhile — a confirmation that came late, say: that
            // is how it came out.
            self.outcome_now(op_id).await
        }
    }

    /// How an operation stands as recorded right now.
    async fn outcome_now(&self, op_id: &str) -> OpOutcome {
        match svc::get_op(&self.db.conn, op_id).await {
            Ok(Some(op)) => match op.state {
                ActionState::Committed => OpOutcome::Committed,
                ActionState::NotExecuted | ActionState::Failed => {
                    OpOutcome::NotExecuted(op.detail.unwrap_or_default())
                }
                ActionState::Unknown => OpOutcome::Unknown(op.detail.unwrap_or_default()),
                ActionState::Prepared => OpOutcome::Pending,
            },
            _ => OpOutcome::Pending,
        }
    }

    /// A task follow-up: its claim's `user_action` is the whole evidence.
    async fn resolve_task_followup(&self, d: &dispatch_entity::Model, op_id: &str) -> OpOutcome {
        let found = match d.work_task_id {
            Some(task) => {
                crate::db::service::work_task_service::user_action_by_op(&self.db.conn, task, op_id)
                    .await
                    .ok()
                    .flatten()
            }
            None => None,
        };
        match found {
            Some(run_seq) => {
                let mut seen = observed("user_action");
                if let Some(map) = seen.as_object_mut() {
                    map.insert("run_seq".into(), run_seq.into());
                }
                let _ = svc::op_settle(
                    &self.db.conn,
                    op_id,
                    &[ActionState::Prepared],
                    ActionState::Committed,
                    Some(d.id.to_string()),
                    None,
                    Some(seen),
                )
                .await;
                self.outcome_now(op_id).await
            }
            None => {
                let why = "the board has no record of it: the task was not claimed".to_string();
                let _ = svc::op_settle(
                    &self.db.conn,
                    op_id,
                    &[ActionState::Prepared],
                    ActionState::NotExecuted,
                    None,
                    Some(why),
                    None,
                )
                .await;
                self.outcome_now(op_id).await
            }
        }
    }

    /// Whether the executor's own record of the dispatched session holds
    /// `op_id` (`None`: it keeps none codeg can read).
    async fn own_record_has(&self, d: &dispatch_entity::Model, op_id: &str) -> Option<bool> {
        let cid = d.conversation_id?;
        let conv = crate::db::service::conversation_service::get_by_id(&self.db.conn, cid)
            .await
            .ok()?;
        let session = conv.external_id?;
        let agent_type = executor_of(d).agent_type;
        let env =
            crate::db::service::agent_setting_service::load_agent_env(&self.db.conn, agent_type)
                .await;
        let needle = op_id.to_string();
        tokio::task::spawn_blocking(move || {
            crate::parsers::build_agent_parser(agent_type, &env)
                .own_record_contains(&session, &needle)
        })
        .await
        .ok()
        .flatten()
    }

    /// What follows an operation's outcome: the card it ran settles; one cut
    /// off with no telling gets a card of its own, and the assistant hears of
    /// it with its next delivery.
    pub(super) async fn after_op(&self, op_id: &str, outcome: &OpOutcome) {
        let Ok(Some(op)) = svc::get_op(&self.db.conn, op_id).await else {
            return;
        };
        let card = match op.notice_id {
            Some(id) => svc::get_notice(&self.db.conn, id).await.ok().flatten(),
            None => None,
        };
        // A card this operation runs for (not one raised about it).
        let running_card = card.as_ref().filter(|_| is_card_op(op_id));
        if let Some(card) = running_card {
            match outcome {
                OpOutcome::Committed => {
                    let made = if op.kind == "message" {
                        "message_id"
                    } else {
                        "dispatch_id"
                    };
                    let result = op
                        .ref_id
                        .as_deref()
                        .and_then(|r| r.parse::<i32>().ok())
                        .map(|id| json!({ made: id }))
                        .unwrap_or(Value::Null);
                    self.settle_card_state(
                        card.id,
                        &[NoticeState::Acting, NoticeState::Unknown],
                        NoticeState::Acted,
                        "acted",
                        result,
                        None,
                    )
                    .await;
                }
                OpOutcome::NotExecuted(why) => {
                    self.settle_card_state(
                        card.id,
                        &[NoticeState::Acting],
                        NoticeState::Open,
                        "open",
                        Value::Null,
                        Some(why.clone()),
                    )
                    .await;
                }
                OpOutcome::Unknown(why) => {
                    self.settle_card_state(
                        card.id,
                        &[NoticeState::Acting],
                        NoticeState::Unknown,
                        "unknown",
                        Value::Null,
                        Some(why.clone()),
                    )
                    .await;
                }
                OpOutcome::Pending => {}
            }
            return;
        }
        match (outcome, card.as_ref()) {
            (OpOutcome::Unknown(why), None) => self.raise_uncertain(&op, why).await,
            // Confirmed after all, once its card was up: the card says so and
            // asks nothing any more; the agent hears it arrived.
            (OpOutcome::Committed, Some(card)) if card.kind == NoticeKind::Uncertain => {
                let dispatch_id = parse::<FollowupCall>(op.payload.as_deref())
                    .map(|c| c.dispatch_id)
                    .unwrap_or_default();
                self.resolve_uncertain_card(card.id, op_id, dispatch_id, true)
                    .await;
            }
            _ => {}
        }
    }

    /// An uncertain card whose step was confirmed after all: closed, saying
    /// it went through; `tell` the agent when it heard otherwise.
    async fn resolve_uncertain_card(&self, notice_id: i32, op_id: &str, dispatch_id: i32, tell: bool) {
        if !self
            .settle_card_state(
                notice_id,
                &[NoticeState::Open],
                NoticeState::Expired,
                "resolved",
                json!({ "delivered": true }),
                None,
            )
            .await
        {
            return;
        }
        if tell {
            let _ = svc::insert_event(
                &self.db.conn,
                self.bot().await,
                "ledger",
                &format!("ledger:{op_id}:arrived"),
                None,
                format!(
                    "Your follow-up of dispatch #{dispatch_id} did reach it after all: the \
                     executor confirmed it. Nothing needs sending again."
                ),
                Some(json!({ "op_id": op_id, "dispatch_id": dispatch_id })),
                false,
            )
            .await;
        }
    }

    /// Settle a card's state and its timeline row.
    pub(super) async fn settle_card_state(
        &self,
        notice_id: i32,
        from: &[NoticeState],
        to: NoticeState,
        state: &str,
        result: Value,
        error: Option<String>,
    ) -> bool {
        if !svc::move_notice(&self.db.conn, notice_id, from, to)
            .await
            .unwrap_or(false)
        {
            return false;
        }
        if let Ok(Some(notice)) = svc::get_notice(&self.db.conn, notice_id).await {
            let _ = self.write_card_row(&notice, state, result, error).await;
        }
        true
    }

    /// The card for a step cut off with no telling whether it took effect.
    async fn raise_uncertain(&self, op: &action_entity::Model, why: &str) {
        let Some(op_id) = op.op_id.clone() else {
            return;
        };
        let Some(call) = parse::<FollowupCall>(op.payload.as_deref()) else {
            return;
        };
        let d = svc::get_dispatch(&self.db.conn, call.dispatch_id)
            .await
            .ok()
            .flatten();
        let executor = d.as_ref().map(executor_of);
        let title = d
            .as_ref()
            .map(|d| d.title.clone())
            .unwrap_or_else(|| format!("dispatch #{}", call.dispatch_id));
        let mut row = NewRow::new(TimelineKind::Notice, title.clone());
        row.segment_id = self.state.lock().await.connection_segment;
        row.batch_id = (op.batch_id != 0).then_some(op.batch_id);
        row.data = Some(json!({
            "notice": "uncertain",
            "state": "open",
            "action": "followup",
            "display": {
                "dispatch_id": call.dispatch_id,
                "title": title,
                "executor": executor.as_ref().map(|e| e.name.clone()),
                "executor_id": executor.as_ref().map(|e| e.assistant_id),
                "agent_type": executor.as_ref().map(|e| e.agent_type),
                "mode": d.as_ref().map(|d| d.mode),
                "conversation_id": d.as_ref().and_then(|d| d.conversation_id),
                "folder_id": d.as_ref().and_then(|d| d.folder_id),
                "message": call.message,
                "intent": call.intent,
            },
            "detail": why,
        }));
        let made = svc::create_notice_with_row(
            &self.db.conn,
            self.bot().await,
            NewNotice {
                kind: NoticeKind::Uncertain,
                subject_key: Some(format!("op:{op_id}")),
                level: NoticeLevel::Normal,
                batch_id: row.batch_id,
                payload: json!({
                    "action": "followup",
                    "dispatch_id": call.dispatch_id,
                    "message": call.message,
                    "intent": call.intent,
                    "op_id": op_id,
                }),
            },
            row,
        )
        .await;
        let Ok((notice, card)) = made else {
            return;
        };
        let _ = svc::op_set_notice(&self.db.conn, &op_id, notice.id).await;
        self.emit_rows(vec![svc::to_row(card)]);
        self.emit(PersonalAgentChange::Status);
        // A confirmation that landed while the card was being made finds no
        // card yet: settle it here instead, and say nothing to the agent.
        if matches!(
            svc::get_op(&self.db.conn, &op_id).await,
            Ok(Some(now)) if now.state == ActionState::Committed
        ) {
            self.resolve_uncertain_card(notice.id, &op_id, call.dispatch_id, false)
                .await;
            return;
        }
        // The assistant hears of it with its next delivery.
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            "ledger",
            &format!("ledger:{op_id}:unknown"),
            None,
            format!(
                "codeg cannot tell whether your follow-up of dispatch #{} reached it: {why}. It \
                 was not sent again; the owner has a card to look, send it again, or let it be.",
                call.dispatch_id
            ),
            Some(json!({ "op_id": op_id, "dispatch_id": call.dispatch_id })),
            false,
        )
        .await;
    }

    /// After a restart: every operation still prepared is judged by its
    /// evidence, and every card left acting settles as what it ran did.
    pub(super) async fn boot_ledger(&self) {
        let prepared = svc::ops_in_states(&self.db.conn, self.bot().await, &[ActionState::Prepared])
            .await
            .unwrap_or_default();
        for op in prepared {
            let Some(op_id) = op.op_id.clone() else {
                continue;
            };
            let outcome = self.resolve_op(&op).await;
            self.after_op(&op_id, &outcome).await;
            // A follow-up the assistant was told had gone out, from a turn
            // that is not delivered again: it hears that it did not.
            if let (OpOutcome::NotExecuted(_), "followup") = (&outcome, op.kind.as_str()) {
                if op.batch_id != 0 && !self.batch_redelivered(op.batch_id).await {
                    if let Some(call) = parse::<FollowupCall>(op.payload.as_deref()) {
                        let _ = svc::insert_event(
                            &self.db.conn,
                            self.bot().await,
                            "ledger",
                            &format!("ledger:{op_id}:not_sent"),
                            None,
                            format!(
                                "Your follow-up of dispatch #{} did not go out: codeg stopped \
                                 before sending it. Send it again if it still matters.",
                                call.dispatch_id
                            ),
                            Some(json!({ "op_id": op_id, "dispatch_id": call.dispatch_id })),
                            false,
                        )
                        .await;
                    }
                }
            }
        }
        let acting = svc::notices_in_state(&self.db.conn, self.bot().await, NoticeState::Acting)
            .await
            .unwrap_or_default();
        for card in acting {
            // Its own runs: an uncertain card also names the step it is
            // about.
            let ops: Vec<_> = svc::ops_of_notice(&self.db.conn, card.id)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|o| o.op_id.as_deref().is_some_and(is_card_op))
                .collect();
            match ops.last() {
                // Nothing on record ran for it: a dispatch's entry commits
                // with the card, so the click was cut off before anything.
                None => {
                    self.settle_card_state(
                        card.id,
                        &[NoticeState::Acting],
                        NoticeState::Open,
                        "open",
                        Value::Null,
                        Some("codeg stopped before this ran; nothing was done".into()),
                    )
                    .await;
                }
                Some(op) => {
                    let Some(op_id) = op.op_id.clone() else {
                        continue;
                    };
                    let outcome = self.resolve_op(op).await;
                    self.after_op(&op_id, &outcome).await;
                }
            }
        }
    }

    /// Whether a batch's content is delivered again: an interrupted delivery
    /// puts its events back, and offers its owner messages for resending.
    async fn batch_redelivered(&self, batch_id: i32) -> bool {
        matches!(
            svc::get_batch(&self.db.conn, batch_id).await,
            Ok(Some(b)) if b.status == BatchStatus::Interrupted
        )
    }

    /// The round send `op_id` claimed is over (its turn ended, or its
    /// connection went away): nothing will confirm the send any more, so it
    /// settles now if nothing did — attempted and unconfirmed is unknown
    /// unless the executor's own record names it, never attempted is not
    /// sent.
    pub(super) async fn settle_ended_round(&self, op_id: &str) {
        let Ok(Some(op)) = svc::get_op(&self.db.conn, op_id).await else {
            return;
        };
        if op.state != ActionState::Prepared {
            return;
        }
        self.set_live(op_id, false).await;
        let outcome = self.resolve_op(&op).await;
        self.after_op(op_id, &outcome).await;
    }
}

/// The connection's side of a follow-up's send (see the module docs): it
/// writes straight to the ledger, never through the event bus.
#[async_trait::async_trait]
impl PromptReceiptSink for PersonalAgentEngine {
    async fn attempted(&self, op_id: &str) -> Result<(), String> {
        match svc::op_attempted(&self.db.conn, op_id).await {
            Ok(true) => Ok(()),
            Ok(false) => Err("it was withdrawn before it went out".into()),
            Err(e) => Err(format!("it could not be recorded as sent ({e})")),
        }
    }

    async fn received(&self, op_id: &str, via: ReceiptVia) {
        if !svc::op_received(&self.db.conn, op_id, observed(via.as_str()))
            .await
            .unwrap_or(false)
        {
            return;
        }
        self.set_live(op_id, false).await;
        self.after_op(op_id, &OpOutcome::Committed).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_keys_ignore_spacing_and_case_but_not_the_target() {
        let a = dispatch_key(1, DispatchMode::Task, Some(2), "Fix  the Login bug");
        let b = dispatch_key(1, DispatchMode::Task, Some(2), "fix the login bug ");
        assert_eq!(a, b);
        assert_ne!(
            a,
            dispatch_key(1, DispatchMode::Task, Some(3), "fix the login bug")
        );
        assert_ne!(
            a,
            dispatch_key(2, DispatchMode::Task, Some(2), "fix the login bug")
        );
        assert_ne!(
            a,
            dispatch_key(1, DispatchMode::Session, Some(2), "fix the login bug")
        );
        assert_eq!(
            followup_key(5, Some("revise")),
            followup_key(5, Some("revise"))
        );
        assert_ne!(followup_key(5, Some("revise")), followup_key(5, None));
    }

    #[test]
    fn op_ids_are_frame_safe_and_cards_stable() {
        let id = fresh_op_id();
        assert!(id.starts_with("pa-"));
        assert!(
            id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "{id}"
        );
        assert_ne!(fresh_op_id(), id);
        assert_eq!(card_op_id(12, 1), "pa-card-12");
        assert_eq!(card_op_id(12, 0), "pa-card-12");
        assert_eq!(card_op_id(12, 2), "pa-card-12-2");
        // Every id rides the operation frame.
        assert!(crate::acp::agent_mentions::render_operation_frame(&id).is_some());
        assert!(crate::acp::agent_mentions::render_operation_frame(&card_op_id(3, 4)).is_some());
    }

    /// The table of 7.1: the operation's own evidence decides, nothing else.
    #[test]
    fn a_send_is_judged_by_its_own_evidence() {
        // Confirmed: committed, whatever else.
        assert_eq!(send_verdict(true, true, None), SendVerdict::Committed);
        assert_eq!(
            send_verdict(true, true, Some(false)),
            SendVerdict::Committed
        );
        // Attempted, unconfirmed, the agent's own record names it: it arrived.
        assert_eq!(
            send_verdict(false, true, Some(true)),
            SendVerdict::Committed
        );
        // Attempted and nothing else: unknown — no record, or one without it
        // (a sanitized transcript proves nothing either way).
        assert_eq!(send_verdict(false, true, None), SendVerdict::Unknown);
        assert_eq!(send_verdict(false, true, Some(false)), SendVerdict::Unknown);
        // Never attempted: certainly not sent.
        assert_eq!(send_verdict(false, false, None), SendVerdict::NotExecuted);
        assert_eq!(
            send_verdict(false, false, Some(false)),
            SendVerdict::NotExecuted
        );
    }

    #[test]
    fn what_an_entry_keeps_reads_back() {
        let t = SendTarget {
            dispatch_id: 3,
            conversation_id: Some(9),
            claimed_from: Some(DispatchState::Completed),
            queued: false,
            task_id: None,
        };
        let raw = serde_json::to_string(&t).unwrap();
        assert_eq!(parse::<SendTarget>(Some(&raw)), Some(t));
        assert_eq!(
            parse::<SendTarget>(Some("{\"dispatch_id\":4}")).map(|t| t.queued),
            Some(false)
        );
        assert_eq!(parse::<FollowupCall>(None), None);
        assert_eq!(parse::<FollowupCall>(Some("junk")), None);
    }
}
