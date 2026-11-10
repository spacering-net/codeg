//! Work the personal agent hands to a role assistant.
//!
//! Three modes, all owned by the runtime rather than by the personal agent's
//! session — so switching that session, or the brain under it, never touches
//! what was dispatched:
//!
//! - **task**: a kanban task in the target project, run by the work-task
//!   engine in its own worktree. It lands as the board's settings say:
//!   merged on its own when the project has auto-merge on, by the owner
//!   otherwise — like any other task.
//! - **chat**: a chat-mode conversation in a scratch directory.
//! - **session**: a conversation in the project's current checkout.
//!
//! The executor is a role assistant, frozen at dispatch: its agent, options
//! and standing instructions (appended to its first input as the same brief
//! delegation uses). Conversation dispatches run like the automation engine's
//! runs: the connection is registered before its first prompt, each turn is
//! settled from `TurnComplete`, and a reconcile tick settles the ones whose
//! event was lost. Every state change lands as an event for the agent and a
//! result card on the timeline at once.

use chrono::Utc;

use super::engine::{enum_str, settings_of, PersonalAgentEngine};
use super::DISPATCH_OWNER_LABEL;
use crate::acp::types::{AcpEvent, ConnectionStatus, EventEnvelope, PromptInputBlock};
use crate::db::entities::folder::FolderKind;
use crate::db::entities::personal_agent_dispatch::{self as dispatch_entity, DispatchMode, DispatchState};
use crate::db::entities::personal_agent_item::{ItemKind, ItemStatus, WaitsFor};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::entities::work_task::WorkTaskStatus;
use super::ledger::{self, FollowupCall, OpOutcome, SendTarget};
use crate::db::entities::personal_agent_action::{self as action_entity, ActionState};
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{
    CardSettle, DispatchWrite, ItemWrite, LedgerSlot, Ledgered, NewDispatch, NewEvent, NewOp, NewRow,
};
use crate::models::personal_agent::{DispatchExecutorSnapshot, PersonalAgentChange};
use crate::models::{AgentType, AssistantRunSnapshot, FollowUpIntent, WorkTaskConfig, WorkTaskDraft};

/// Longest result excerpt kept on a dispatch, in characters.
const EXCERPT_CHARS: usize = 2_000;
/// What a dispatch the owner stopped records as its error (4.10).
pub const STOPPED_NOTE: &str = "stopped by the owner";
/// Longest title.
pub const MAX_TITLE_CHARS: usize = 120;
/// Longest prompt or follow-up message.
pub const MAX_PROMPT_CHARS: usize = 20_000;

/// A dispatch as the tool asked for it — and as a proposal card keeps it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DispatchRequest {
    pub mode: DispatchMode,
    pub assistant_id: i32,
    pub title: String,
    pub prompt: String,
    pub project_id: Option<i32>,
    pub report: bool,
    pub on_done: Option<String>,
}

/// A dispatch checked against the roster and the projects, ready to record.
#[derive(Debug, Clone)]
pub struct ValidDispatch {
    pub mode: DispatchMode,
    pub snapshot: DispatchExecutorSnapshot,
    pub folder_id: Option<i32>,
    pub title: String,
    pub prompt: String,
    pub report: bool,
    pub on_done: Option<String>,
    /// The input it is dispatched for, and the chain and thread it inherits
    /// from that input (`for`, 4.11); empty when nothing started it.
    pub lineage: svc::Lineage,
}

impl ValidDispatch {
    /// The request it was checked from, as a proposal card keeps it.
    pub fn to_request(&self) -> DispatchRequest {
        DispatchRequest {
            mode: self.mode,
            assistant_id: self.snapshot.assistant_id,
            title: self.title.clone(),
            prompt: self.prompt.clone(),
            project_id: self.folder_id,
            report: self.report,
            on_done: self.on_done.clone(),
        }
    }
}

/// How a dispatch is recorded in the ledger (`ledger`). Nothing here
/// decides whether it may run — every one does.
#[derive(Debug, Clone)]
pub enum DispatchAuth {
    /// A delivery's tool call: one per batch and key, across the batches it
    /// re-delivers (`scope`).
    Ledgered { batch_id: i32, scope: Vec<i32> },
    /// The owner said so on card `notice_id`: the card settles in the same
    /// transaction.
    Card { notice_id: i32 },
    /// Outside any delivery and any card (a call that came late, tests).
    Direct,
}

/// What recording a dispatch came to.
#[derive(Debug, Clone)]
pub struct DispatchMade {
    pub dispatch: dispatch_entity::Model,
    /// The same call was made before (a re-delivered batch): this is the
    /// dispatch it made then, and nothing new runs.
    pub earlier: bool,
}

/// How a follow-up is recorded in the ledger. Like [`DispatchAuth`], it
/// never decides whether the follow-up may run.
#[derive(Debug, Clone)]
pub enum FollowupAuth {
    /// A delivery's tool call: one per batch and key, across the batches it
    /// re-delivers (`scope`).
    Ledgered { batch_id: i32, scope: Vec<i32> },
    /// The owner said so on card `notice_id`; `op_id` is that run's.
    Card { notice_id: i32, op_id: String },
    /// Outside any delivery and any card.
    Direct,
}

/// The states in which a dispatch still holds or waits for its executor.
pub(super) const LIVE_STATES: &[DispatchState] = &[
    DispatchState::Queued,
    DispatchState::Running,
    DispatchState::WaitingInput,
    DispatchState::Review,
];

/// The states a conversation dispatch takes a follow-up in.
const FOLLOWUP_FROM: &[DispatchState] = &[
    DispatchState::Completed,
    DispatchState::Failed,
    DispatchState::Canceled,
    DispatchState::Interrupted,
];

/// Held while a dispatched session's route changes hands: its registration
/// (`register_conn`) and a deleted assistant's hand-over to the primary.
pub(super) static ROUTES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A dispatched conversation's connection, as the engine tracks it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DispatchConn {
    pub(crate) id: i32,
    /// The connection's `event_seq` when the open round's prompt was sent;
    /// `None` between rounds. Only a completion above it settles the round,
    /// so a late or repeated completion of an earlier round cannot close the
    /// one running now.
    pub(crate) round_since: Option<u64>,
}

/// How a dispatched conversation's round was seen to end.
#[derive(Debug, Clone)]
enum RoundEnd {
    /// Its `TurnComplete`, with the agent's stop reason.
    Stop(String),
    /// The backstop found the turn over without seeing that; the session
    /// still records whether it ended abnormally.
    Missed { abnormal: bool },
    /// The connection is gone and the conversation reads finished, or
    /// cancelled.
    Gone { canceled: bool },
}

impl RoundEnd {
    /// The dispatch's state after the round, and why it failed when it did.
    /// The automation engine's reading: a normal end did the work, an
    /// explicit cancel is a cancel, and anything else — a refusal, the token
    /// limit, an empty or unknown end, a login prompt — did not.
    fn outcome(&self) -> (DispatchState, Option<String>) {
        match self {
            RoundEnd::Stop(reason) => match reason.as_str() {
                "end_turn" => (DispatchState::Completed, None),
                "cancelled" | "canceled" => (DispatchState::Canceled, None),
                other => (
                    DispatchState::Failed,
                    Some(format!(
                        "the executor's turn stopped: {}",
                        if other.is_empty() { "unknown" } else { other }
                    )),
                ),
            },
            RoundEnd::Missed { abnormal: false } | RoundEnd::Gone { canceled: false } => {
                (DispatchState::Completed, None)
            }
            RoundEnd::Missed { abnormal: true } => (
                DispatchState::Failed,
                Some("the executor's turn ended abnormally".into()),
            ),
            RoundEnd::Gone { canceled: true } => (DispatchState::Canceled, None),
        }
    }
}

/// What the ledger already holds for a follow-up a delivery makes again.
enum Earlier {
    /// Nothing: run it.
    None,
    /// Settled one way or another: this is the answer, and nothing runs.
    Settled(String),
    /// This batch's own entry certainly never ran: it runs now, again.
    Rearmed(Box<action_entity::Model>),
}

/// A board claim that lost: the task moved meanwhile (the owner returned or
/// retried it themselves, say) and this follow-up did nothing.
fn moved_meanwhile(task_id: i32, e: String) -> String {
    if e.starts_with("task is not in") {
        format!(
            "task #{task_id} changed meanwhile — someone else returned, retried or moved it —              so this follow-up did nothing; check item_read"
        )
    } else {
        e
    }
}

fn cut(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let mut s: String = t.chars().take(max).collect();
        s.push('…');
        s
    }
}

fn mode_label(mode: DispatchMode) -> &'static str {
    match mode {
        DispatchMode::Task => "kanban task",
        DispatchMode::Chat => "chat",
        DispatchMode::Session => "work session",
    }
}

fn state_sentence(state: DispatchState) -> &'static str {
    match state {
        DispatchState::Queued => "is queued",
        DispatchState::Running => "is running",
        DispatchState::WaitingInput => {
            "is waiting for the owner (a question or permission request in its own session)"
        }
        DispatchState::Review => "is waiting for the owner's review",
        DispatchState::Completed => "finished",
        DispatchState::Failed => "failed",
        DispatchState::Canceled => "was canceled",
        DispatchState::Interrupted => "was interrupted by a restart",
        DispatchState::HandedOver => "was taken over by the owner",
    }
}

pub fn executor_of(d: &dispatch_entity::Model) -> DispatchExecutorSnapshot {
    serde_json::from_str(&d.executor_snapshot).unwrap_or(DispatchExecutorSnapshot {
        assistant_id: d.executor_assistant_id,
        name: format!("#{}", d.executor_assistant_id),
        agent_type: AgentType::ClaudeCode,
        agent_options: Default::default(),
        label_snapshot: None,
        instructions: String::new(),
        dispatcher: None,
    })
}

impl PersonalAgentEngine {
    // ── dispatch ────────────────────────────────────────────────────────────

    /// Validate a dispatch, record it, and set it going. Returns at once: the
    /// work itself starts in the background. Outside the ledger: an agent's
    /// tool call records through [`Self::record_dispatch`].
    pub async fn dispatch(
        self: &std::sync::Arc<Self>,
        req: DispatchRequest,
    ) -> Result<dispatch_entity::Model, String> {
        let valid = self.validate_dispatch(&req).await?;
        Ok(self.record_dispatch(valid, DispatchAuth::Direct).await?.dispatch)
    }

    /// Check a dispatch against the roster and the projects: the executor is
    /// an enabled role assistant, the mode and project fit, the texts are in
    /// bounds. Data checks only — nothing about who asked or when.
    pub async fn validate_dispatch(&self, req: &DispatchRequest) -> Result<ValidDispatch, String> {
        let title = cut(&req.title, MAX_TITLE_CHARS);
        if title.is_empty() {
            return Err("`title` is required".into());
        }
        let prompt = req.prompt.trim().to_string();
        if prompt.is_empty() {
            return Err("`prompt` is required".into());
        }
        if prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(format!("`prompt` is longer than {MAX_PROMPT_CHARS} characters"));
        }
        let assistant = crate::db::service::assistant_service::get_live_enabled(
            &self.db.conn,
            req.assistant_id,
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!(
                "assistant #{} is not an enabled role assistant; use assistant_list",
                req.assistant_id
            )
        })?;
        let folder_id = match (req.mode, req.project_id) {
            (DispatchMode::Chat, None) => None,
            (DispatchMode::Chat, Some(_)) => {
                return Err("a chat dispatch takes no project_id".into());
            }
            (_, None) => {
                return Err(format!(
                    "a {} dispatch needs a project_id; use project_list",
                    enum_str(&req.mode)
                ));
            }
            (_, Some(id)) => {
                let folder = crate::db::service::folder_service::get_folder_by_id(&self.db.conn, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("project #{id} does not exist; use project_list"))?;
                if folder.kind != FolderKind::Regular || folder.parent_id.is_some() {
                    return Err(format!(
                        "#{id} is not a project folder that can be targeted; use project_list"
                    ));
                }
                Some(folder.id)
            }
        };
        if req.report && req.mode != DispatchMode::Task {
            return Err("`deliverable` applies to task dispatches only".into());
        }
        // How the owner lets the assistants use it (a chat takes no project,
        // so no project list refuses one).
        self.check_usage(&assistant, req.mode, folder_id).await?;
        let snapshot = DispatchExecutorSnapshot {
            assistant_id: assistant.id,
            name: assistant.name.clone(),
            agent_type: assistant.agent_type,
            agent_options: assistant.agent_options.clone(),
            label_snapshot: Some(assistant.label_snapshot.clone()),
            instructions: assistant.instructions.clone(),
            dispatcher: Some(self.dispatcher_brief().await),
        };
        let on_done = req
            .on_done
            .as_deref()
            .map(|s| cut(s, 2_000))
            .filter(|s| !s.is_empty());
        Ok(ValidDispatch {
            mode: req.mode,
            snapshot,
            folder_id,
            title,
            prompt,
            report: req.report,
            on_done,
            lineage: svc::Lineage::default(),
        })
    }

    /// Record a checked dispatch and set it going. A call the ledger already
    /// holds (a re-delivered batch, a second click) records nothing and gets
    /// back the dispatch it made before. A card's dispatch settles the card
    /// in the same transaction.
    pub async fn record_dispatch(
        self: &std::sync::Arc<Self>,
        v: ValidDispatch,
        auth: DispatchAuth,
    ) -> Result<DispatchMade, String> {
        let ValidDispatch {
            mode,
            snapshot,
            folder_id,
            title,
            prompt,
            report,
            on_done,
            lineage,
        } = v;
        let thread = lineage.thread_id;
        let request = DispatchRequest {
            mode,
            assistant_id: snapshot.assistant_id,
            title: title.clone(),
            prompt: prompt.clone(),
            project_id: folder_id,
            report,
            on_done: on_done.clone(),
        };
        let key = ledger::dispatch_key(snapshot.assistant_id, mode, folder_id, &title);
        // A repeat costs nothing to find before anything is written.
        if let DispatchAuth::Ledgered { scope, .. } = &auth {
            let earlier = svc::ledger_entries(&self.db.conn, scope, &key)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(entry) = earlier.iter().find(|e| e.state == ActionState::Committed) {
                return self.earlier_dispatch(entry).await;
            }
        }
        let origin_batch_id = match &auth {
            DispatchAuth::Ledgered { batch_id, .. } => Some(*batch_id),
            DispatchAuth::Card { .. } => None,
            DispatchAuth::Direct => self.current_batch().await,
        };
        let new = NewDispatch {
            bot_id: self.bot().await,
            mode,
            executor_assistant_id: snapshot.assistant_id,
            executor_snapshot_json: serde_json::to_string(&snapshot).map_err(|e| e.to_string())?,
            folder_id,
            deliverable: if mode == DispatchMode::Task {
                Some(if report { "report" } else { "change" }.to_string())
            } else {
                None
            },
            title: title.clone(),
            prompt: prompt.clone(),
            origin_batch_id,
            on_done: on_done.clone(),
            lineage,
        };
        let payload = serde_json::to_value(&request).ok();
        let row = match &auth {
            DispatchAuth::Ledgered { batch_id, .. } => {
                let slot = LedgerSlot::in_batch(*batch_id, key, ledger::fresh_op_id());
                match svc::create_dispatch_ledgered(&self.db.conn, new, &slot, payload, None)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    Ledgered::New(row) => row,
                    Ledgered::Earlier(earlier) => return self.earlier_dispatch(&earlier).await,
                }
            }
            DispatchAuth::Card { notice_id } => {
                let notice = svc::get_notice(&self.db.conn, *notice_id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("no such card")?;
                let row_id = notice.timeline_id.ok_or("the card's row is missing")?;
                let row_data = svc::get_row(&self.db.conn, row_id)
                    .await
                    .map_err(|e| e.to_string())?
                    .and_then(|r| r.data)
                    .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
                    .unwrap_or_else(|| serde_json::json!({}));
                let slot = LedgerSlot::outside(ledger::card_op_id(*notice_id, 1));
                let card = CardSettle {
                    notice_id: *notice_id,
                    row_id,
                    row_data,
                };
                match svc::create_dispatch_ledgered(&self.db.conn, new, &slot, payload, Some(card))
                    .await
                    .map_err(|e| e.to_string())?
                {
                    Ledgered::New(row) => {
                        if let Ok(Some(r)) = svc::get_row(&self.db.conn, row_id).await {
                            self.emit_rows(vec![svc::to_row(r)]);
                        }
                        row
                    }
                    Ledgered::Earlier(earlier) => return self.earlier_dispatch(&earlier).await,
                }
            }
            DispatchAuth::Direct => svc::create_dispatch(&self.db.conn, new)
                .await
                .map_err(|e| e.to_string())?,
        };
        // The card, then the ledger entry pointing back at it.
        let mut card = NewRow::new(TimelineKind::Dispatch, title.clone());
        card.dispatch_id = Some(row.id);
        card.segment_id = self.state.lock().await.connection_segment;
        card.batch_id = row.origin_batch_id;
        card.data = Some(serde_json::json!({
            "mode": row.mode,
            "executor": snapshot.name,
            "executor_id": snapshot.assistant_id,
            "agent_type": snapshot.agent_type,
            "folder_id": folder_id,
            "deliverable": row.deliverable,
            "state": row.state,
        }));
        let card = self.push_row(card).await;
        let _ = svc::create_item(
            &self.db.conn,
            self.bot().await,
            ItemKind::Dispatch,
            Some(row.id),
            ItemStatus::Open,
            Some(WaitsFor::External),
            title,
            on_done,
            card.map(|c| c.id),
        )
        .await;
        // Work handed out is progress on the thread it is for (4.9).
        if let Some(t) = thread {
            self.thread_progress(t).await;
        }
        self.emit(PersonalAgentChange::Dispatch { id: row.id });
        let engine = self.clone();
        let id = row.id;
        tokio::spawn(async move {
            engine.start_dispatch(id).await;
        });
        Ok(DispatchMade {
            dispatch: row,
            earlier: false,
        })
    }

    /// The dispatch an earlier, identical call made.
    async fn earlier_dispatch(&self, entry: &action_entity::Model) -> Result<DispatchMade, String> {
        let id = entry
            .ref_id
            .as_deref()
            .and_then(|r| r.parse::<i32>().ok())
            .ok_or("an earlier identical call is on record, but what it made is not")?;
        let dispatch = svc::get_dispatch(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("dispatch #{id} of an earlier identical call is gone"))?;
        Ok(DispatchMade {
            dispatch,
            earlier: true,
        })
    }

    /// Start a recorded dispatch: a task right away (the board has its own
    /// limit), a conversation when a slot is free.
    async fn start_dispatch(self: &std::sync::Arc<Self>, id: i32) {
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, id).await else {
            return;
        };
        match d.mode {
            DispatchMode::Task => {
                if let Err(e) = self.start_task_dispatch(&d).await {
                    self.fail_dispatch(&d, &e).await;
                }
            }
            DispatchMode::Chat | DispatchMode::Session => self.start_queued().await,
        }
    }

    async fn fail_dispatch(&self, d: &dispatch_entity::Model, error: &str) {
        if let Ok(Some(updated)) = svc::update_dispatch(
            &self.db.conn,
            d.id,
            Some(LIVE_STATES),
            DispatchWrite {
                state: Some(DispatchState::Failed),
                error: Some(Some(error.to_string())),
                followup: Some(None),
                // A failed start ends its round like any other end: the next
                // attempt's events are its own, not duplicates of these.
                bump_turns: true,
                ..Default::default()
            },
        )
        .await
        {
            self.record_progress(&updated, None, Some(error.to_string()), "start")
                .await;
        }
    }

    async fn start_task_dispatch(&self, d: &dispatch_entity::Model) -> Result<(), String> {
        let executor = executor_of(d);
        let folder_id = d.folder_id.ok_or("a task dispatch without a project")?;
        let mut blocks = vec![serde_json::json!({ "type": "text", "text": d.prompt })];
        if let Some(brief) =
            crate::acp::agent_mentions::render_assistant_brief(&executor.name, &executor.brief_text())
        {
            blocks.push(serde_json::json!({ "type": "text", "text": brief }));
        }
        let config = WorkTaskConfig {
            prompt_blocks: blocks,
            display_text: d.prompt.clone(),
            agent_type: Some(executor.agent_type.as_wire().into_owned()),
            mode_id: executor.agent_options.mode_id.clone(),
            config_values: executor.agent_options.config_values.clone(),
            label_snapshot: executor
                .label_snapshot
                .as_ref()
                .and_then(|l| serde_json::to_value(l).ok()),
            deliverable: (d.deliverable.as_deref() == Some("report"))
                .then(|| crate::models::DELIVERABLE_REPORT.to_string()),
            base_branch: None,
            executor_name: Some(executor.name.clone()),
        };
        let draft = WorkTaskDraft {
            folder_id,
            title: d.title.clone(),
            config: serde_json::to_value(&config).map_err(|e| e.to_string())?,
        };
        let task = crate::db::service::work_task_service::create_for_personal_agent(
            &self.db.conn,
            draft,
            d.id,
        )
        .await
        .map_err(|e| e.to_string())?;
        crate::web::event_bridge::emit_event(
            &self.emitter,
            crate::web::event_bridge::WORK_TASK_CHANGED_EVENT,
            crate::web::event_bridge::WorkTaskChange::Upsert { id: task.id },
        );
        let _ = svc::update_dispatch(
            &self.db.conn,
            d.id,
            None,
            DispatchWrite {
                work_task_id: Some(task.id),
                ..Default::default()
            },
        )
        .await;
        let engine = crate::work_task::engine().ok_or("the task engine is not running")?;
        // Stopped while the task was being made (before it had one to
        // cancel): the task goes too, unstarted (4.10).
        if self.was_stopped(d.id).await {
            let _ = engine.cancel(task.id, None).await;
            return Ok(());
        }
        engine.start(task.id).await?;
        if self.was_stopped(d.id).await {
            let _ = engine.cancel(task.id, None).await;
            return Ok(());
        }
        self.sync_task_dispatch(d.id).await;
        Ok(())
    }

    /// Start queued conversation dispatches while slots are free.
    pub(super) async fn start_queued(self: &std::sync::Arc<Self>) {
        // One pass at a time: two passes counting the same free slot would
        // each start a dispatch into it.
        let _one_pass = self.dispatch_lock.lock().await;
        let limit = match self.agent_row().await {
            Some(row) => settings_of(&row).dispatch_concurrency,
            None => crate::models::personal_agent::DEFAULT_DISPATCH_CONCURRENCY,
        };
        loop {
            let active = svc::count_active_conversation_dispatches(&self.db.conn, self.bot().await)
                .await
                .unwrap_or(0) as u32;
            if limit > 0 && active >= limit {
                return;
            }
            let next = svc::queued_conversation_dispatches(&self.db.conn, self.bot().await)
                .await
                .unwrap_or_default()
                .into_iter()
                .next();
            let Some(d) = next else {
                return;
            };
            if let Some(message) = d.followup.clone() {
                let op_id = match self.queued_op(&d, &message).await {
                    Ok(op_id) => op_id,
                    Err(e) => {
                        self.fail_followup_card(d.id, None, &e).await;
                        self.fail_dispatch(&d, &e).await;
                        continue;
                    }
                };
                self.set_live(&op_id, true).await;
                if let Err(e) = self.send_followup(&d, message, &[DispatchState::Queued], &op_id).await {
                    self.set_live(&op_id, false).await;
                    self.fail_followup_card(d.id, None, &e).await;
                    // Claimed and then not sent: it failed as a round. Not
                    // claimed: it never left the queue.
                    match svc::get_dispatch(&self.db.conn, d.id).await {
                        Ok(Some(now)) if now.state == DispatchState::Failed => {
                            self.record_progress(&now, None, Some(e), "followup").await
                        }
                        _ => self.fail_dispatch(&d, &e).await,
                    }
                    // Its entry settles by what the dispatch came to.
                    if let Ok(Some(op)) = svc::get_op(&self.db.conn, &op_id).await {
                        let outcome = self.resolve_op(&op).await;
                        self.after_op(&op_id, &outcome).await;
                    }
                }
            } else if let Err(e) = self.start_conversation_dispatch(&d).await {
                self.fail_dispatch(&d, &e).await;
            }
        }
    }

    /// The ledger operation a queued follow-up is: the one its round was
    /// queued for, or — for one queued before the ledger kept them — a new
    /// one, so its send is proven like any other.
    async fn queued_op(&self, d: &dispatch_entity::Model, message: &str) -> Result<String, String> {
        if let Some(op_id) = d.round_op_id.as_deref() {
            if let Ok(Some(op)) = svc::get_op(&self.db.conn, op_id).await {
                if op.state == ActionState::Prepared {
                    return Ok(op_id.to_string());
                }
            }
        }
        let op_id = ledger::fresh_op_id();
        let call = FollowupCall {
            dispatch_id: d.id,
            message: message.to_string(),
            intent: None,
        };
        match svc::begin_op(
            &self.db.conn,
            NewOp {
                bot_id: self.bot().await,
                slot: LedgerSlot::outside(op_id.clone()),
                kind: "followup",
                payload: serde_json::to_value(&call).map_err(|e| e.to_string())?,
                target: None,
                notice_id: None,
            },
        )
        .await
        .map_err(|e| e.to_string())?
        {
            Ledgered::New(_) => Ok(op_id),
            Ledgered::Earlier(_) => Err("the queued follow-up's record collided".into()),
        }
    }

    /// Start queued dispatches off the engine's loop: starting one spawns an
    /// agent, which must not hold up the events of everything else.
    fn kick_queue(self: &std::sync::Arc<Self>) {
        let engine = self.clone();
        tokio::spawn(async move {
            engine.start_queued().await;
        });
    }

    /// Route `conn_id`'s events to dispatch `id`, no round open yet.
    pub(super) async fn track_conn(&self, conn_id: &str, id: i32) {
        self.register_conn(
            conn_id,
            DispatchConn {
                id,
                round_since: None,
            },
        )
        .await;
    }

    /// Route a dispatched session to the engine of the assistant the
    /// dispatch belongs to NOW: one handed to the primary while it was
    /// still starting (its assistant deleted, 4.14) goes there, not to the
    /// retired engine that started it.
    async fn register_conn(&self, conn_id: &str, conn: DispatchConn) {
        // The owner read and the route written as one step against a
        // hand-over (`delete_bot`), which moves both under the same lock.
        let _routes = ROUTES.lock().await;
        let owner = svc::get_dispatch(&self.db.conn, conn.id)
            .await
            .ok()
            .flatten()
            .and_then(|d| d.bot_id);
        let me = self.bot().await;
        if let (Some(owner), Some(host)) = (owner.filter(|o| *o != me), self.host_ref()) {
            // An engine already running (never one made here: making one
            // boots it, which registers routes of its own under this lock).
            let engine = if host.primary().serves(owner).await {
                Some(host.primary())
            } else {
                host.existing_worker(owner).await
            };
            if let Some(engine) = engine {
                engine
                    .adopt_dispatch_conns(vec![(conn_id.to_string(), conn)])
                    .await;
                return;
            }
        }
        self.state
            .lock()
            .await
            .dispatch_conns
            .insert(conn_id.to_string(), conn);
    }

    /// Let go of the sessions of dispatches `ids` (their assistant is
    /// deleted): what routes them, for the engine taking them over.
    pub(super) async fn take_dispatch_conns(&self, ids: &[i32]) -> Vec<(String, DispatchConn)> {
        let mut st = self.state.lock().await;
        let keys: Vec<String> = st
            .dispatch_conns
            .iter()
            .filter(|(_, c)| ids.contains(&c.id))
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter()
            .filter_map(|k| st.dispatch_conns.remove(&k).map(|c| (k, c)))
            .collect()
    }

    /// Take over dispatched sessions another engine let go of.
    pub(super) async fn adopt_dispatch_conns(&self, conns: Vec<(String, DispatchConn)>) {
        let mut st = self.state.lock().await;
        for (k, c) in conns {
            st.dispatch_conns.insert(k, c);
        }
    }

    /// Open a round on `conn_id`, just before its prompt goes out.
    pub(super) async fn open_round(&self, conn_id: &str, id: i32) {
        let since = self.current_seq(conn_id).await;
        self.register_conn(
            conn_id,
            DispatchConn {
                id,
                round_since: Some(since),
            },
        )
        .await;
    }


    /// Close the round open on `conn_id` when `seq` (a completion's; `None`
    /// for the backstop, which checked the session itself) belongs to it.
    /// True when this call closed it — or nothing tracks the connection, so
    /// nothing else could settle it.
    pub(super) async fn close_round(&self, conn_id: &str, seq: Option<u64>) -> bool {
        let mut st = self.state.lock().await;
        let Some(conn) = st.dispatch_conns.get_mut(conn_id) else {
            return true;
        };
        match conn.round_since {
            Some(since) if seq.is_none_or(|s| s > since) => {
                conn.round_since = None;
                true
            }
            _ => false,
        }
    }

    /// Run a conversation dispatch's first turn, the way an automation run
    /// starts: the row exists and is announced, the connection is registered,
    /// and only then is the prompt sent.
    async fn start_conversation_dispatch(&self, d: &dispatch_entity::Model) -> Result<(), String> {
        // Claim the slot first, so a second pass cannot start it twice.
        let Some(d) = svc::update_dispatch(
            &self.db.conn,
            d.id,
            Some(&[DispatchState::Queued]),
            DispatchWrite {
                state: Some(DispatchState::Running),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        let executor = executor_of(&d);
        let agent_type = executor.agent_type;
        let (folder_id, cwd, conversation_id) = match d.mode {
            DispatchMode::Chat => {
                let created = crate::commands::conversations::create_chat_conversation_core(
                    &self.db.conn,
                    &self.data_dir,
                    agent_type,
                    Some(d.title.clone()),
                    None,
                )
                .await
                .map_err(|e| e.to_string())?;
                let path = created.folder.path.clone();
                crate::commands::folders::emit_folder_upsert(&self.emitter, created.folder);
                (created.folder_id, path, created.conversation_id)
            }
            _ => {
                let folder_id = d.folder_id.ok_or("a session dispatch without a project")?;
                let folder = crate::commands::folders::get_folder_core(&self.db, folder_id)
                    .await
                    .map_err(|e| e.to_string())?;
                let cid = crate::commands::conversations::create_conversation_core(
                    &self.db.conn,
                    folder_id,
                    agent_type,
                    Some(d.title.clone()),
                )
                .await
                .map_err(|e| e.to_string())?;
                (folder_id, folder.path, cid)
            }
        };
        let snapshot = AssistantRunSnapshot {
            name: executor.name.clone(),
            agent_options: executor.agent_options.clone(),
            // A resumed conversation is told who handed it out again.
            instructions: executor.brief_text(),
        };
        let _ = crate::db::service::conversation_service::set_dispatch_provenance(
            &self.db.conn,
            conversation_id,
            executor.assistant_id,
            &snapshot,
        )
        .await;
        let _ = crate::db::service::conversation_service::lock_title(&self.db.conn, conversation_id).await;
        crate::commands::conversations::emit_conversation_upsert(
            &self.emitter,
            &self.db.conn,
            conversation_id,
        )
        .await;
        let _ = svc::update_dispatch(
            &self.db.conn,
            d.id,
            None,
            DispatchWrite {
                conversation_id: Some(conversation_id),
                ..Default::default()
            },
        )
        .await;

        let env = crate::commands::acp::build_session_runtime_env(&self.db, agent_type, None, &self.data_dir)
            .await
            .map_err(|e| e.to_string())?;
        crate::commands::acp::verify_agent_installed(agent_type)
            .await
            .map_err(|e| e.to_string())?;
        let conn_id = self
            .manager
            .spawn_agent(
                agent_type,
                Some(cwd),
                None,
                env,
                DISPATCH_OWNER_LABEL.to_string(),
                self.emitter.clone(),
                executor.agent_options.mode_id.clone(),
                executor.agent_options.config_values.clone(),
            )
            .await
            .map_err(|e| e.to_string())?;
        self.track_conn(&conn_id, d.id).await;
        let _ = svc::update_dispatch(
            &self.db.conn,
            d.id,
            None,
            DispatchWrite {
                connection_id: Some(Some(conn_id.clone())),
                ..Default::default()
            },
        )
        .await;
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        // Stopped while its agent started: it never gets the work. A stop
        // from here on finds the connection on the row and stops the turn.
        if self.was_stopped(d.id).await {
            self.state.lock().await.dispatch_conns.remove(&conn_id);
            let _ = self.manager.disconnect(&conn_id).await;
            return Ok(());
        }
        let suffix = crate::acp::agent_mentions::render_assistant_brief(
            &executor.name,
            &executor.brief_text(),
        )
        .map(|text| vec![PromptInputBlock::Text { text }])
        .unwrap_or_default();
        self.open_round(&conn_id, d.id).await;
        let sent = self
            .manager
            .send_prompt_linked_with_suffix(
                &self.db,
                &conn_id,
                vec![PromptInputBlock::Text {
                    text: d.prompt.clone(),
                }],
                Some(folder_id),
                Some(conversation_id),
                None,
                suffix,
            )
            .await;
        if let Err(e) = sent {
            self.state.lock().await.dispatch_conns.remove(&conn_id);
            let _ = self.manager.disconnect(&conn_id).await;
            return Err(e.to_string());
        }
        // A stop that came between the check above and the send found an
        // idle connection: the turn the send started is stopped here.
        if self.was_stopped(d.id).await {
            let _ = self.manager.cancel(&self.db.conn, &conn_id).await;
        }
        Ok(())
    }

    /// The owner stopped dispatch `id` (4.10): canceled with the stop's
    /// note.
    pub(super) async fn was_stopped(&self, id: i32) -> bool {
        svc::get_dispatch(&self.db.conn, id)
            .await
            .ok()
            .flatten()
            .is_some_and(|d| d.state == DispatchState::Canceled && d.error.as_deref() == Some(STOPPED_NOTE))
    }

    // ── progress ────────────────────────────────────────────────────────────

    /// Events on a dispatched conversation's connection.
    pub(super) async fn on_dispatch_event(self: &std::sync::Arc<Self>, id: i32, env: &EventEnvelope) {
        match &env.payload {
            AcpEvent::TurnComplete { stop_reason, .. } => {
                if self.close_round(&env.connection_id, Some(env.seq)).await {
                    self.settle_conversation_turn(
                        id,
                        &env.connection_id,
                        RoundEnd::Stop(stop_reason.clone()),
                    )
                    .await;
                }
            }
            AcpEvent::PermissionRequest { .. }
            | AcpEvent::QuestionRequest { .. }
            | AcpEvent::PlanApprovalRequest { .. } => {
                if let Ok(Some(updated)) = svc::update_dispatch(
                    &self.db.conn,
                    id,
                    Some(&[DispatchState::Running]),
                    DispatchWrite {
                        state: Some(DispatchState::WaitingInput),
                        ..Default::default()
                    },
                )
                .await
                {
                    self.record_progress(&updated, None, None, "wait").await;
                }
            }
            AcpEvent::PermissionResolved { .. }
            | AcpEvent::QuestionResolved { .. }
            | AcpEvent::PlanApprovalResolved { .. } => {
                if svc::update_dispatch(
                    &self.db.conn,
                    id,
                    Some(&[DispatchState::WaitingInput]),
                    DispatchWrite {
                        state: Some(DispatchState::Running),
                        ..Default::default()
                    },
                )
                .await
                .ok()
                .flatten()
                .is_some()
                {
                    self.emit(PersonalAgentChange::Dispatch { id });
                }
            }
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected | ConnectionStatus::Error,
            } => {
                self.settle_lost_connection(id, &env.connection_id).await;
            }
            _ => {}
        }
    }

    /// A dispatched conversation's round ended.
    async fn settle_conversation_turn(self: &std::sync::Arc<Self>, id: i32, conn_id: &str, end: RoundEnd) {
        // The send that claimed this round, read before anything can claim
        // the next one.
        let round_op = svc::get_dispatch(&self.db.conn, id)
            .await
            .ok()
            .flatten()
            .and_then(|d| d.round_op_id);
        let excerpt = match self.manager.get_state(conn_id).await {
            Some(state) => state.read().await.last_assistant_text.clone(),
            None => None,
        }
        .map(|t| cut(&t, EXCERPT_CHARS));
        let (state, error) = end.outcome();
        if let Ok(Some(updated)) = svc::update_dispatch(
            &self.db.conn,
            id,
            Some(&[DispatchState::Running, DispatchState::WaitingInput]),
            DispatchWrite {
                state: Some(state),
                result_excerpt: Some(excerpt.clone()),
                error: error.clone().map(Some),
                bump_turns: true,
                ..Default::default()
            },
        )
        .await
        {
            self.record_progress(&updated, excerpt, error, "turn").await;
        }
        if let Some(op_id) = round_op {
            self.settle_ended_round(&op_id).await;
        }
        // The slot is free: the next queued one may start.
        self.kick_queue();
    }

    /// A dispatched conversation's connection went away mid-turn.
    async fn settle_lost_connection(self: &std::sync::Arc<Self>, id: i32, conn_id: &str) {
        self.state.lock().await.dispatch_conns.remove(conn_id);
        let round_op = svc::get_dispatch(&self.db.conn, id)
            .await
            .ok()
            .flatten()
            .and_then(|d| d.round_op_id);
        if let Ok(Some(updated)) = svc::update_dispatch(
            &self.db.conn,
            id,
            Some(&[DispatchState::Running, DispatchState::WaitingInput]),
            DispatchWrite {
                state: Some(DispatchState::Failed),
                error: Some(Some("the session's connection was lost".into())),
                bump_turns: true,
                ..Default::default()
            },
        )
        .await
        {
            self.record_progress(&updated, None, Some("the connection was lost".into()), "lost")
                .await;
        }
        let _ = svc::update_dispatch(
            &self.db.conn,
            id,
            None,
            DispatchWrite {
                connection_id: Some(None),
                ..Default::default()
            },
        )
        .await;
        // Sent and never confirmed: nothing will confirm it now.
        if let Some(op_id) = round_op {
            self.settle_ended_round(&op_id).await;
        }
        self.kick_queue();
    }

    /// Record a dispatch's new state: the event the agent will be handed, the
    /// result card on the timeline (at once, without the model), and its
    /// ledger entry. A repeated arrival of the same state records nothing.
    pub(super) async fn record_progress(
        &self,
        d: &dispatch_entity::Model,
        excerpt: Option<String>,
        note: Option<String>,
        cause: &str,
    ) {
        let executor = executor_of(d);
        let round = match d.mode {
            DispatchMode::Task => match d.work_task_id {
                Some(tid) => crate::db::service::work_task_service::get_model(&self.db.conn, tid)
                    .await
                    .map(|t| t.run_seq)
                    .unwrap_or(0),
                None => 0,
            },
            _ => d.turns,
        };
        let source_key = format!("dispatch:{}:{}:{}:{}", d.id, round, enum_str(&d.state), cause);
        let mut summary = format!(
            "Dispatch #{} \"{}\" ({} · executor {}) {}.",
            d.id,
            d.title,
            mode_label(d.mode),
            executor.name,
            state_sentence(d.state)
        );
        if let Some(e) = excerpt.as_deref().filter(|e| !e.trim().is_empty()) {
            summary.push_str(&format!(" Result excerpt: {}", cut(e, 600)));
        }
        if let Some(n) = note.as_deref() {
            summary.push_str(&format!(" ({n})"));
        }
        // Waking the agent for a state it has to interpret; a dispatch taken
        // over by the owner only rides along with the next delivery.
        let wake = !matches!(
            d.state,
            DispatchState::Queued | DispatchState::Running | DispatchState::HandedOver
        );
        let quiet = matches!(d.state, DispatchState::Queued | DispatchState::Running);
        if quiet {
            self.emit(PersonalAgentChange::Dispatch { id: d.id });
            return;
        }
        // Read before the write: the event and its card go in as one.
        // A chat dispatch's conversation sits in its own hidden folder; the
        // card's link needs it to open the conversation.
        let conversation_folder_id = match d.conversation_id {
            Some(cid) => crate::db::service::conversation_service::get_by_id(&self.db.conn, cid)
                .await
                .ok()
                .map(|c| c.folder_id),
            None => None,
        };
        // The card follows up on the reply of the turn that last dispatched
        // or continued the work.
        let reply_to = match d.source_batch_id {
            Some(b) => svc::anchor_row_of_batch(&self.db.conn, b)
                .await
                .ok()
                .flatten()
                .map(|r| r.id),
            None => None,
        };
        let mut card = NewRow::new(TimelineKind::Result, summary.clone());
        card.dispatch_id = Some(d.id);
        card.segment_id = self.state.lock().await.connection_segment;
        card.reply_to = reply_to;
        card.data = Some(serde_json::json!({
            "mode": d.mode,
            "state": d.state,
            "title": d.title,
            "executor": executor.name,
            "executor_id": executor.assistant_id,
            "agent_type": executor.agent_type,
            "excerpt": excerpt,
            "note": note,
            // What brought the news (`boot`, `lost`, `gone`, `turn`…): the
            // page words the notes codeg writes itself in the owner's
            // language, and shows an agent's own error as it came.
            "cause": cause,
            "work_task_id": d.work_task_id,
            "conversation_id": d.conversation_id,
            "conversation_folder_id": conversation_folder_id,
            "folder_id": d.folder_id,
        }));
        // The owner stopped it: the card says so, and nobody is woken — the
        // stop card already told the owner, and what it stopped is not the
        // assistant's to pick up again (4.10).
        if cause == "stopped" {
            match svc::insert_row(&self.db.conn, self.bot().await, card).await {
                Ok(c) => self.emit_rows(vec![svc::to_row(c)]),
                Err(e) => tracing::warn!("[personal_agent] dispatch #{} stop not recorded: {e}", d.id),
            }
            if let Ok(Some(item)) = svc::item_of_dispatch(&self.db.conn, d.id).await {
                if item.status != ItemStatus::Dropped {
                    let _ = svc::update_item(
                        &self.db.conn,
                        item.id,
                        ItemWrite {
                            status: Some(ItemStatus::Done),
                            waits_for: Some(None),
                            ..Default::default()
                        },
                    )
                    .await;
                    self.emit(PersonalAgentChange::Item { id: item.id });
                }
            }
            self.emit(PersonalAgentChange::Dispatch { id: d.id });
            self.emit(PersonalAgentChange::Status);
            return;
        }
        // One transaction: a delivery that takes the event finds its card
        // there, to number it and to mark it read.
        let inserted = svc::insert_event_with_row(
            &self.db.conn,
            self.bot().await,
            NewEvent {
                kind: "dispatch_status".into(),
                source_key,
                coalesce_key: Some(format!("dispatch:{}", d.id)),
                summary,
                payload: Some(serde_json::json!({
                    "dispatch_id": d.id,
                    "state": d.state,
                    "on_done": d.on_done,
                })),
                wake,
                // The news of a dispatch belongs where the dispatch does.
                lineage: svc::Lineage {
                    origin_bot_id: d.origin_bot_id,
                    origin_row_id: d.origin_row_id,
                    thread_id: d.thread_id,
                    for_input: d.for_input.clone(),
                },
            },
            card,
        )
        .await;
        let card = match inserted {
            Ok(Some((_, card))) => card,
            // A repeated arrival of the same state.
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("[personal_agent] dispatch #{} progress not recorded: {e}", d.id);
                return;
            }
        };
        self.emit_rows(vec![svc::to_row(card)]);
        // Work done is progress on the thread it was for (4.9).
        if let (DispatchState::Completed, Some(t)) = (d.state, d.thread_id) {
            self.thread_progress(t).await;
        }
        if let Ok(Some(item)) = svc::item_of_dispatch(&self.db.conn, d.id).await {
            let (status, waits_for) = match d.state {
                DispatchState::WaitingInput | DispatchState::Review => {
                    (ItemStatus::Waiting, Some(WaitsFor::Owner))
                }
                DispatchState::Completed | DispatchState::Canceled | DispatchState::HandedOver => {
                    (ItemStatus::Done, None)
                }
                DispatchState::Failed | DispatchState::Interrupted => {
                    (ItemStatus::Open, Some(WaitsFor::Agent))
                }
                DispatchState::Queued | DispatchState::Running => {
                    (ItemStatus::Open, Some(WaitsFor::External))
                }
            };
            if item.status != ItemStatus::Dropped {
                let _ = svc::update_item(
                    &self.db.conn,
                    item.id,
                    ItemWrite {
                        status: Some(status),
                        waits_for: Some(waits_for),
                        ..Default::default()
                    },
                )
                .await;
                self.emit(PersonalAgentChange::Item { id: item.id });
            }
        }
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        self.emit(PersonalAgentChange::Status);
        if wake {
            self.nudge();
        }
    }

    /// Follow a task dispatch's card on the board.
    async fn sync_task_dispatch(&self, id: i32) {
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, id).await else {
            return;
        };
        let Some(task_id) = d.work_task_id else {
            return;
        };
        let task = match crate::db::service::work_task_service::get_model(&self.db.conn, task_id).await {
            Ok(t) => t,
            Err(_) => {
                // The task was deleted from the board.
                if let Ok(Some(updated)) = svc::update_dispatch(
                    &self.db.conn,
                    id,
                    Some(LIVE_STATES),
                    DispatchWrite {
                        state: Some(DispatchState::Canceled),
                        error: Some(Some("the task was deleted".into())),
                        ..Default::default()
                    },
                )
                .await
                {
                    self.record_progress(&updated, None, Some("the task was deleted".into()), "gone")
                        .await;
                }
                return;
            }
        };
        let state = match task.status {
            WorkTaskStatus::Todo | WorkTaskStatus::Queued => DispatchState::Queued,
            WorkTaskStatus::Preparing | WorkTaskStatus::Running | WorkTaskStatus::Merging => {
                DispatchState::Running
            }
            WorkTaskStatus::AwaitingInput => DispatchState::WaitingInput,
            WorkTaskStatus::Review => DispatchState::Review,
            WorkTaskStatus::Done => DispatchState::Completed,
            WorkTaskStatus::Failed if task.failure_reason.as_deref() == Some("interrupted") => {
                DispatchState::Interrupted
            }
            WorkTaskStatus::Failed => DispatchState::Failed,
            WorkTaskStatus::Canceled => DispatchState::Canceled,
        };
        if state == d.state {
            return;
        }
        let excerpt = task.result_summary.as_deref().map(|t| cut(t, EXCERPT_CHARS));
        let note = match state {
            DispatchState::Failed | DispatchState::Interrupted => task.last_error.clone(),
            _ => None,
        };
        if let Ok(Some(updated)) = svc::update_dispatch(
            &self.db.conn,
            id,
            Some(&[d.state]),
            DispatchWrite {
                state: Some(state),
                result_excerpt: Some(excerpt.clone()),
                error: Some(note.clone()),
                ..Default::default()
            },
        )
        .await
        {
            self.record_progress(&updated, excerpt, note, "task").await;
        }
    }

    /// Re-read every task dispatch that is still moving. The board's own
    /// broadcast would be faster, but it is only an id nudge to every window;
    /// a few rows a tick are cheaper than another subscriber.
    pub(super) async fn poll_task_dispatches(&self) {
        let live = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            &[
                DispatchState::Queued,
                DispatchState::Running,
                DispatchState::WaitingInput,
                DispatchState::Review,
                // A failed task can be retried from the board by hand.
                DispatchState::Failed,
                DispatchState::Interrupted,
            ],
            Some(DispatchMode::Task),
            200,
        )
        .await
        .unwrap_or_default();
        // A failed task stays a candidate for a manual retry from the board
        // only for a while; older ones are left alone instead of being re-read
        // every few seconds forever.
        let recent = Utc::now() - chrono::Duration::days(3);
        for d in live {
            let settled = matches!(d.state, DispatchState::Failed | DispatchState::Interrupted);
            if d.work_task_id.is_some() && (!settled || d.updated_at > recent) {
                self.sync_task_dispatch(d.id).await;
            }
        }
    }

    /// The backstop for lost events: a running conversation dispatch whose
    /// connection is gone, or whose turn is over without our having seen it.
    pub(super) async fn reconcile_dispatches(self: &std::sync::Arc<Self>) {
        let live = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            &[DispatchState::Running, DispatchState::WaitingInput],
            None,
            200,
        )
        .await
        .unwrap_or_default();
        for d in live.into_iter().filter(|d| d.mode != DispatchMode::Task) {
            let Some(conn_id) = d.connection_id.clone() else {
                continue;
            };
            match self.manager.get_state(&conn_id).await {
                None => {
                    // Gone: settle from the conversation's own terminal status.
                    let status = match d.conversation_id {
                        Some(cid) => crate::db::service::conversation_service::get_by_id(
                            &self.db.conn,
                            cid,
                        )
                        .await
                        .ok()
                        .map(|c| c.status),
                        None => None,
                    };
                    match status.as_deref() {
                        Some(done @ ("pending_review" | "completed" | "cancelled")) => {
                            self.state.lock().await.dispatch_conns.remove(&conn_id);
                            let end = RoundEnd::Gone {
                                canceled: done == "cancelled",
                            };
                            self.settle_conversation_turn(d.id, &conn_id, end).await;
                        }
                        _ => self.settle_lost_connection(d.id, &conn_id).await,
                    }
                }
                Some(state) => {
                    let (in_flight, waiting, seq, abnormal) = {
                        let s = state.read().await;
                        (
                            s.turn_in_flight,
                            s.pending_permission.is_some()
                                || s.pending_question.is_some()
                                || s.pending_plan_approval.is_some(),
                            s.event_seq,
                            s.last_turn_ended_abnormally,
                        )
                    };
                    let round = self
                        .state
                        .lock()
                        .await
                        .dispatch_conns
                        .get(&conn_id)
                        .map(|c| c.round_since);
                    let ripe = match round {
                        // Over only once the session moved past its prompt.
                        Some(Some(since)) => seq > since,
                        // Between rounds: one is being started, or was just
                        // settled.
                        Some(None) => false,
                        // Untracked: this tick is all that can settle it.
                        None => true,
                    };
                    let idle_for = Utc::now() - d.updated_at;
                    if ripe
                        && !in_flight
                        && !waiting
                        && idle_for > chrono::Duration::seconds(10)
                        && self.close_round(&conn_id, None).await
                    {
                        self.settle_conversation_turn(d.id, &conn_id, RoundEnd::Missed { abnormal })
                            .await;
                    }
                }
            }
        }
        self.kick_queue();
    }

    /// After a restart, a conversation dispatch that was running lost its
    /// connection with the process. Tasks recover through the board.
    pub(super) async fn boot_dispatches(&self) {
        let live = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            &[DispatchState::Running, DispatchState::WaitingInput],
            None,
            500,
        )
        .await
        .unwrap_or_default();
        for d in live.into_iter().filter(|d| d.mode != DispatchMode::Task) {
            if let Ok(Some(updated)) = svc::update_dispatch(
                &self.db.conn,
                d.id,
                Some(&[DispatchState::Running, DispatchState::WaitingInput]),
                DispatchWrite {
                    state: Some(DispatchState::Interrupted),
                    connection_id: Some(None),
                    error: Some(Some("interrupted by a restart".into())),
                    bump_turns: true,
                    ..Default::default()
                },
            )
            .await
            {
                self.record_progress(&updated, None, Some("codeg restarted".into()), "boot")
                    .await;
            }
        }
    }

    /// The owner wrote in a dispatched conversation: it is theirs now.
    pub async fn handover(&self, connection_id: &str, conversation_id: Option<i32>) {
        let mut found = svc::dispatch_by_connection(&self.db.conn, connection_id)
            .await
            .ok()
            .flatten();
        if found.is_none() {
            if let Some(cid) = conversation_id {
                found = svc::dispatch_by_conversation(&self.db.conn, cid)
                    .await
                    .ok()
                    .flatten();
            }
        }
        let Some(d) = found else {
            return;
        };
        // Another assistant's dispatch is its engine's to hand over.
        if !self.serves(d.bot_id.unwrap_or(0)).await {
            return;
        }
        self.state.lock().await.dispatch_conns.remove(connection_id);
        self.hand_over(&d).await;
    }

    /// Hand dispatch `d` over to the owner. `d` may be a moment old: the
    /// send withdrawn is the one that holds the round once the dispatch is
    /// handed over — nothing can claim it after that (a claim needs a
    /// finished or queued dispatch), so that is the last one there is.
    pub(super) async fn hand_over(&self, d: &dispatch_entity::Model) {
        if d.mode == DispatchMode::Task || d.state == DispatchState::HandedOver {
            return;
        }
        let Ok(Some(updated)) = svc::update_dispatch(
            &self.db.conn,
            d.id,
            None,
            DispatchWrite {
                state: Some(DispatchState::HandedOver),
                ..Default::default()
            },
        )
        .await
        else {
            return;
        };
        self.record_progress(&updated, None, None, "handover").await;
        // The owner wrote in it, and that wins: the agent's send that has not
        // started going out does not go out at all (the connection is refused
        // it). One already going out cannot be called back — whether it
        // reached the executor is unknown until the executor's own answer
        // says so, and the owner hears of it.
        if let Some(op_id) = updated.round_op_id.as_deref() {
            let why = "the owner took the conversation over";
            if svc::op_unattempted_to_not_executed(&self.db.conn, op_id, why)
                .await
                .unwrap_or(false)
            {
                self.set_live(op_id, false).await;
                self.after_op(op_id, &OpOutcome::NotExecuted(why.into())).await;
            } else if let Ok(Some(op)) = svc::get_op(&self.db.conn, op_id).await {
                if op.state == ActionState::Prepared {
                    self.set_live(op_id, false).await;
                    let outcome = self
                        .settle_unknown_op(op_id, "the owner took the conversation over while it was going out")
                        .await;
                    self.after_op(op_id, &outcome).await;
                }
            }
        }
    }

    // ── follow-ups ──────────────────────────────────────────────────────────

    /// Continue a dispatch, outside the ledger's batches (a call that came
    /// late, tests). Returns a sentence for the agent.
    pub async fn followup(
        self: &std::sync::Arc<Self>,
        id: i32,
        message: String,
        intent: Option<String>,
    ) -> Result<String, String> {
        self.followup_call(id, message, intent, FollowupAuth::Direct)
            .await
    }

    /// Continue a dispatch, as `auth` records it. Every follow-up is an
    /// operation in the ledger first (`prepared`, with the call in full), so
    /// a re-delivered batch finds it and a restart can tell whether it took
    /// effect (`ledger`). Returns a sentence for the agent.
    pub async fn followup_call(
        self: &std::sync::Arc<Self>,
        id: i32,
        message: String,
        intent: Option<String>,
        auth: FollowupAuth,
    ) -> Result<String, String> {
        let message = message.trim().to_string();
        if message.is_empty() {
            return Err("`message` is required".into());
        }
        if message.chars().count() > MAX_PROMPT_CHARS {
            return Err(format!("`message` is longer than {MAX_PROMPT_CHARS} characters"));
        }
        // Only its own: another assistant's work is not this one's to steer.
        let d = svc::get_dispatch_of(&self.db.conn, self.bot().await, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("dispatch #{id} does not exist"))?;
        if d.mode != DispatchMode::Task && intent.is_some() {
            return Err("`intent` applies to task dispatches only".into());
        }
        let call = FollowupCall {
            dispatch_id: id,
            message: message.clone(),
            intent: intent.clone(),
        };
        let payload = serde_json::to_value(&call).map_err(|e| e.to_string())?;
        let target = serde_json::to_value(SendTarget {
            dispatch_id: id,
            task_id: d.work_task_id,
            conversation_id: d.conversation_id,
            ..Default::default()
        })
        .map_err(|e| e.to_string())?;
        let (slot, notice_id) = match auth {
            FollowupAuth::Ledgered { batch_id, scope } => {
                let key = ledger::followup_key(id, intent.as_deref());
                match self
                    .earlier_followup(&scope, &key, batch_id, id, payload.clone(), target.clone())
                    .await?
                {
                    Earlier::Settled(text) => return Ok(text),
                    Earlier::Rearmed(op) => {
                        return self.run_followup(&d, call, *op).await;
                    }
                    Earlier::None => {}
                }
                (LedgerSlot::in_batch(batch_id, key, ledger::fresh_op_id()), None)
            }
            FollowupAuth::Card { notice_id, op_id } => (LedgerSlot::outside(op_id), Some(notice_id)),
            FollowupAuth::Direct => (LedgerSlot::outside(ledger::fresh_op_id()), None),
        };
        let op = match svc::begin_op(
            &self.db.conn,
            NewOp {
                bot_id: self.bot().await,
                slot,
                kind: "followup",
                payload,
                target: Some(target),
                notice_id,
            },
        )
        .await
        .map_err(|e| e.to_string())?
        {
            Ledgered::New(op) => op,
            Ledgered::Earlier(_) => {
                return Err("this follow-up is on record already; check item_read".into())
            }
        };
        self.run_followup(&d, call, op).await
    }

    /// What the ledger already holds for this follow-up in the batches a
    /// delivery covers. Committed: not sent again. Running or waiting: not
    /// sent again. Unknown: not sent again — the owner decides. Certainly not
    /// sent: sent now, under the current batch's entry when it has one.
    async fn earlier_followup(
        &self,
        scope: &[i32],
        key: &str,
        batch_id: i32,
        id: i32,
        payload: serde_json::Value,
        target: serde_json::Value,
    ) -> Result<Earlier, String> {
        let entries = svc::ledger_entries(&self.db.conn, scope, key)
            .await
            .map_err(|e| e.to_string())?;
        let mut own_not_sent: Option<action_entity::Model> = None;
        for entry in entries {
            let outcome = if entry.state == ActionState::Prepared {
                let outcome = self.resolve_op(&entry).await;
                if let Some(op_id) = entry.op_id.as_deref() {
                    self.after_op(op_id, &outcome).await;
                }
                outcome
            } else {
                self.resolve_op(&entry).await
            };
            match outcome {
                OpOutcome::Committed => {
                    return Ok(Earlier::Settled(format!(
                        "Not sent again: this follow-up of dispatch #{id} already reached it in \
                         the turn this delivery repeats. Check its state with item_read before \
                         anything else."
                    )))
                }
                OpOutcome::Pending => {
                    return Ok(Earlier::Settled(format!(
                        "Not sent again: this follow-up of dispatch #{id} from the turn this \
                         delivery repeats is still on its way (being sent, or waiting for a \
                         session slot); its result comes back as an event."
                    )))
                }
                OpOutcome::Unknown(_) => {
                    return Ok(Earlier::Settled(format!(
                        "Not sent again: codeg cannot tell whether this follow-up of dispatch \
                         #{id} reached it in the turn this delivery repeats — it was cut off \
                         mid-send. The owner has a card to look, send it again, or let it be."
                    )))
                }
                OpOutcome::NotExecuted(_) => {
                    if entry.batch_id == batch_id {
                        own_not_sent = Some(entry);
                    }
                }
            }
        }
        // Certainly never sent: this batch's own entry runs again, under a
        // new operation id (a send of the old one still queued somewhere
        // finds nothing to mark, and is never written) and with THIS call in
        // full — what a restart puts back in the queue is what goes out now.
        if let Some(entry) = own_not_sent {
            if let Some(op_id) = entry.op_id.clone() {
                let fresh = ledger::fresh_op_id();
                if svc::op_rearm(&self.db.conn, &op_id, &fresh, payload, target)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    if let Ok(Some(op)) = svc::get_op(&self.db.conn, &fresh).await {
                        return Ok(Earlier::Rearmed(Box::new(op)));
                    }
                }
            }
            return Err("this follow-up is being retried already; check item_read".into());
        }
        Ok(Earlier::None)
    }

    /// Run a follow-up recorded as `op`, and settle its entry by the
    /// receiving side's evidence.
    async fn run_followup(
        self: &std::sync::Arc<Self>,
        d: &dispatch_entity::Model,
        call: FollowupCall,
        op: action_entity::Model,
    ) -> Result<String, String> {
        let op_id = op.op_id.clone().ok_or("the follow-up's record has no id")?;
        self.set_live(&op_id, true).await;
        let out = match d.mode {
            DispatchMode::Task => self.followup_task(d, call.message, call.intent, &op_id).await,
            _ => self.followup_conversation(d, call.message, &op_id).await,
        };
        match &out {
            // A conversation's send stays live until the executor confirms
            // it or its round ends; a task's claim is settled already.
            Ok(_) if d.mode != DispatchMode::Task => {}
            _ => {
                self.set_live(&op_id, false).await;
                if let Ok(Some(now)) = svc::get_op(&self.db.conn, &op_id).await {
                    let outcome = self.resolve_op(&now).await;
                    self.after_op(&op_id, &outcome).await;
                }
            }
        }
        out
    }

    /// A follow-up about to go out (or to wait for a slot): it shows in the
    /// reply of the turn that asked for it, and the results it brings follow
    /// up on that reply — so the dispatch's source is that turn, from before
    /// the round can report. Returns the card.
    async fn record_followup(&self, d: &dispatch_entity::Model, message: &str) -> Option<i32> {
        let batch = self.current_batch().await;
        if let Some(b) = batch {
            let _ = svc::update_dispatch(
                &self.db.conn,
                d.id,
                None,
                DispatchWrite {
                    source_batch_id: Some(Some(b)),
                    ..Default::default()
                },
            )
            .await;
        }
        let executor = executor_of(d);
        let mut card = NewRow::new(TimelineKind::Dispatch, d.title.clone());
        card.dispatch_id = Some(d.id);
        card.segment_id = self.state.lock().await.connection_segment;
        card.batch_id = batch;
        card.data = Some(serde_json::json!({
            "followup": true,
            "excerpt": cut(message, 200),
            "mode": d.mode,
            "executor": executor.name,
            "executor_id": executor.assistant_id,
            "agent_type": executor.agent_type,
            "folder_id": d.folder_id,
            "state": d.state,
        }));
        self.push_row(card).await.map(|r| r.id)
    }

    /// The follow-up card of a round that could not be sent.
    async fn fail_followup_card(&self, dispatch_id: i32, card: Option<i32>, error: &str) {
        let card = match card {
            Some(id) => svc::get_row(&self.db.conn, id).await.ok().flatten(),
            None => svc::latest_followup_row(&self.db.conn, dispatch_id)
                .await
                .ok()
                .flatten(),
        };
        let Some(card) = card else {
            return;
        };
        let mut data = card
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = data.as_object_mut() {
            map.insert("failed".into(), true.into());
            map.insert("error".into(), cut(error, 300).into());
        }
        let _ = svc::update_row_data(&self.db.conn, card.id, None, Some(data)).await;
        if let Ok(Some(updated)) = svc::get_row(&self.db.conn, card.id).await {
            self.emit_rows(vec![svc::to_row(updated)]);
        }
    }

    /// A task follow-up: through the board's claim, which writes `op_id` in
    /// its `user_action` (the entry is settled from that record alone).
    async fn followup_task(
        &self,
        d: &dispatch_entity::Model,
        message: String,
        intent: Option<String>,
        op_id: &str,
    ) -> Result<String, String> {
        let task_id = d.work_task_id.ok_or("this dispatch has no task yet")?;
        let engine = crate::work_task::engine().ok_or("the task engine is not running")?;
        let task = crate::db::service::work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        match task.status {
            WorkTaskStatus::Review => {
                let intent = FollowUpIntent::from_wire(intent.as_deref())?;
                let card = self.record_followup(d, &message).await;
                if let Err(e) = engine
                    .return_task_with_op(task_id, intent, message, Vec::new(), Some(op_id.to_string()))
                    .await
                {
                    let e = moved_meanwhile(task_id, e);
                    self.fail_followup_card(d.id, card, &e).await;
                    return Err(e);
                }
                self.sync_task_dispatch(d.id).await;
                Ok(format!(
                    "Sent a {} round to task #{task_id}; it reports back when it is done.",
                    intent.as_str()
                ))
            }
            WorkTaskStatus::Failed => {
                if intent.is_some() {
                    return Err("a failed task is retried; `intent` applies to a task in review".into());
                }
                let card = self.record_followup(d, &message).await;
                if let Err(e) = engine
                    .retry_with_op(task_id, Some(message), Vec::new(), false, Some(op_id.to_string()))
                    .await
                {
                    let e = moved_meanwhile(task_id, e);
                    self.fail_followup_card(d.id, card, &e).await;
                    return Err(e);
                }
                self.sync_task_dispatch(d.id).await;
                Ok(format!("Retrying task #{task_id}; it reports back when it is done."))
            }
            other => Err(format!(
                "task #{task_id} is {}; a follow-up needs it in review (or failed, to retry)",
                enum_str(&other)
            )),
        }
    }

    async fn followup_conversation(
        self: &std::sync::Arc<Self>,
        d: &dispatch_entity::Model,
        message: String,
        op_id: &str,
    ) -> Result<String, String> {
        match d.state {
            DispatchState::HandedOver => {
                return Err("the owner took this conversation over; leave it to them".into());
            }
            DispatchState::Queued | DispatchState::Running | DispatchState::WaitingInput => {
                return Err("the conversation is busy; wait for its result first".into());
            }
            _ => {}
        }
        if d.conversation_id.is_none() {
            return Err("this dispatch never started a conversation".into());
        }
        // A follow-up is a round like the first: it takes a session slot, or
        // waits for one the way a new dispatch does.
        let _one_pass = self.dispatch_lock.lock().await;
        let limit = match self.agent_row().await {
            Some(row) => settings_of(&row).dispatch_concurrency,
            None => crate::models::personal_agent::DEFAULT_DISPATCH_CONCURRENCY,
        };
        let active = svc::count_active_conversation_dispatches(&self.db.conn, self.bot().await)
            .await
            .unwrap_or(0) as u32;
        if limit > 0 && active >= limit {
            // Waiting for a slot: the round is this operation's, and its
            // message is the entry's — kept there until it is sent, whatever
            // happens to the dispatch row in between.
            self.write_send_target(op_id, d, DispatchState::Queued, true).await?;
            let Some(_) = svc::update_dispatch(
                &self.db.conn,
                d.id,
                Some(FOLLOWUP_FROM),
                DispatchWrite {
                    state: Some(DispatchState::Queued),
                    result_excerpt: Some(None),
                    error: Some(None),
                    followup: Some(Some(message.clone())),
                    round_op_id: Some(Some(op_id.to_string())),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?
            else {
                return Err("the dispatch changed state meanwhile; check item_list".into());
            };
            // Recorded as it is queued: it is the turn asking for it now that
            // it belongs to, whenever a slot frees up.
            self.record_followup(d, &message).await;
            self.reopen_item(d.id).await;
            self.emit(PersonalAgentChange::Dispatch { id: d.id });
            self.emit(PersonalAgentChange::Status);
            return Ok(format!(
                "All {limit} session slots are busy: the follow-up to dispatch #{} waits for one \
                 and starts by itself; its result comes back as an event.",
                d.id
            ));
        }
        let card = self.record_followup(d, &message).await;
        let sent = self.send_followup(d, message, FOLLOWUP_FROM, op_id).await;
        if let Err(e) = &sent {
            self.fail_followup_card(d.id, card, e).await;
        }
        sent
    }

    /// Write what a conversation send claims — before the claim, so a round
    /// that never went out can be put back exactly as it was.
    async fn write_send_target(
        &self,
        op_id: &str,
        d: &dispatch_entity::Model,
        claimed_from: DispatchState,
        queued: bool,
    ) -> Result<(), String> {
        let target = SendTarget {
            dispatch_id: d.id,
            task_id: d.work_task_id,
            conversation_id: d.conversation_id,
            claimed_from: Some(claimed_from),
            queued,
        };
        svc::op_set_target(
            &self.db.conn,
            op_id,
            serde_json::to_value(target).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())
    }

    /// Send a follow-up round into a dispatch's conversation, on its live
    /// connection when that is idle or else on a resumed one, claiming the
    /// dispatch from one of `from` (the finished states for a follow-up sent
    /// at once, `queued` for one that waited for a slot). Called under the
    /// dispatch lock, so the slot it takes is the one that was counted.
    ///
    /// The send is ledger operation `op_id`, in three marks (`ledger`): the
    /// claim writes it onto the dispatch (`round_op_id`); the connection has
    /// it marked attempted right before writing the request — and writes
    /// nothing when that fails; the executor's own answer to the request
    /// commits it. The message carries the id twice: as its message id, and
    /// in an operation frame stripped from every display.
    async fn send_followup(
        self: &std::sync::Arc<Self>,
        d: &dispatch_entity::Model,
        message: String,
        from: &[DispatchState],
        op_id: &str,
    ) -> Result<String, String> {
        let conversation_id = d.conversation_id.ok_or("this dispatch never started a conversation")?;
        let executor = executor_of(d);
        let summary = crate::db::service::conversation_service::get_by_id(&self.db.conn, conversation_id)
            .await
            .map_err(|e| e.to_string())?;
        let folder = crate::commands::folders::get_folder_core(&self.db, summary.folder_id)
            .await
            .map_err(|e| e.to_string())?;
        let frame = crate::acp::agent_mentions::render_operation_frame(op_id)
            .ok_or("the follow-up's id cannot ride the prompt")?;
        // A live, idle connection on it, or a resumed one.
        let mut conn_id = match d.connection_id.clone() {
            Some(c) => Some(c),
            None => self.manager.find_connection_by_conversation_id(conversation_id).await,
        };
        if let Some(c) = conn_id.clone() {
            match self.manager.get_state(&c).await {
                Some(state) => {
                    let s = state.read().await;
                    if s.turn_in_flight
                        || s.pending_permission.is_some()
                        || s.pending_question.is_some()
                        || s.pending_plan_approval.is_some()
                    {
                        return Err("the conversation is busy; wait for its result first".into());
                    }
                }
                None => conn_id = None,
            }
        }
        let conn_id = match conn_id {
            Some(c) => c,
            None => {
                let session_id = summary
                    .external_id
                    .clone()
                    .ok_or("the conversation has no session to resume")?;
                let env = crate::commands::acp::build_session_runtime_env(
                    &self.db,
                    executor.agent_type,
                    Some(&session_id),
                    &self.data_dir,
                )
                .await
                .map_err(|e| e.to_string())?;
                self.manager
                    .spawn_agent(
                        executor.agent_type,
                        Some(folder.path.clone()),
                        Some(session_id),
                        env,
                        DISPATCH_OWNER_LABEL.to_string(),
                        self.emitter.clone(),
                        executor.agent_options.mode_id.clone(),
                        executor.agent_options.config_values.clone(),
                    )
                    .await
                    .map_err(|e| e.to_string())?
            }
        };
        let queued = from == [DispatchState::Queued];
        let claimed_from = if queued { DispatchState::Queued } else { d.state };
        self.write_send_target(op_id, d, claimed_from, queued).await?;
        // Claim the round before sending, with the connection it runs on and
        // the operation it is: a handover racing it wins. A queued round is
        // this operation's already — and only then is it claimed.
        let Some(claimed) = svc::update_dispatch(
            &self.db.conn,
            d.id,
            Some(from),
            DispatchWrite {
                state: Some(DispatchState::Running),
                connection_id: Some(Some(conn_id.clone())),
                result_excerpt: Some(None),
                error: Some(None),
                followup: Some(None),
                round_op_id: Some(Some(op_id.to_string())),
                expect_round_op: if queued { d.round_op_id.clone() } else { None },
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?
        else {
            return Err("the dispatch changed state meanwhile; check item_list".into());
        };
        self.open_round(&conn_id, d.id).await;
        let receipt = crate::acp::prompt_receipt::PromptReceipt {
            op_id: op_id.to_string(),
            sink: self.clone(),
        };
        let sent = self
            .manager
            .send_prompt_with_receipt(
                &self.db,
                &conn_id,
                vec![PromptInputBlock::Text { text: message }],
                Some(summary.folder_id),
                Some(conversation_id),
                Some(op_id.to_string()),
                vec![PromptInputBlock::Text { text: frame }],
                receipt,
            )
            .await;
        if let Err(e) = sent {
            self.state.lock().await.dispatch_conns.remove(&conn_id);
            // Never handed to the connection: certainly not sent.
            let _ = svc::op_unattempted_to_not_executed(&self.db.conn, op_id, &e.to_string()).await;
            let _ = svc::update_dispatch(
                &self.db.conn,
                claimed.id,
                Some(&[DispatchState::Running]),
                DispatchWrite {
                    state: Some(DispatchState::Failed),
                    error: Some(Some(e.to_string())),
                    bump_turns: true,
                    expect_round_op: Some(op_id.to_string()),
                    ..Default::default()
                },
            )
            .await;
            return Err(format!("the follow-up could not be sent: {e}"));
        }
        self.reopen_item(d.id).await;
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        Ok(format!(
            "Sent the follow-up to dispatch #{}; its result comes back as an event.",
            d.id
        ))
    }

    /// The dispatch's entry is open again, waiting on its executor.
    async fn reopen_item(&self, dispatch_id: i32) {
        if let Ok(Some(item)) = svc::item_of_dispatch(&self.db.conn, dispatch_id).await {
            let _ = svc::update_item(
                &self.db.conn,
                item.id,
                ItemWrite {
                    status: Some(ItemStatus::Open),
                    waits_for: Some(Some(WaitsFor::External)),
                    ..Default::default()
                },
            )
            .await;
            self.emit(PersonalAgentChange::Item { id: item.id });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cut_keeps_short_text_and_marks_long_text() {
        assert_eq!(cut("  hi  ", 10), "hi");
        assert_eq!(cut("abcdef", 3), "abc…");
        assert_eq!(cut("派活派活", 2), "派活…");
    }

    #[test]
    fn every_state_reads_as_a_sentence() {
        for state in [
            DispatchState::Queued,
            DispatchState::Running,
            DispatchState::WaitingInput,
            DispatchState::Review,
            DispatchState::Completed,
            DispatchState::Failed,
            DispatchState::Canceled,
            DispatchState::Interrupted,
            DispatchState::HandedOver,
        ] {
            assert!(!state_sentence(state).is_empty());
        }
    }

    /// Only a normal end did the work; a cancel is a cancel; every other
    /// stop failed it, saying which.
    #[test]
    fn a_round_is_done_only_when_it_ended_normally() {
        let stop = |r: &str| RoundEnd::Stop(r.into()).outcome();
        assert_eq!(stop("end_turn"), (DispatchState::Completed, None));
        assert_eq!(stop("cancelled").0, DispatchState::Canceled);
        for reason in ["auth_required", "empty", "max_tokens", "max_turn_requests", "refusal", "rejected", "unknown"] {
            let (state, error) = stop(reason);
            assert_eq!(state, DispatchState::Failed, "{reason}");
            assert!(error.unwrap().contains(reason), "{reason}");
        }
        assert!(stop("").1.unwrap().contains("unknown"));
        assert_eq!(RoundEnd::Missed { abnormal: false }.outcome().0, DispatchState::Completed);
        assert_eq!(RoundEnd::Missed { abnormal: true }.outcome().0, DispatchState::Failed);
        assert_eq!(RoundEnd::Gone { canceled: true }.outcome().0, DispatchState::Canceled);
        assert_eq!(RoundEnd::Gone { canceled: false }.outcome().0, DispatchState::Completed);
    }
}
