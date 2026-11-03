//! Work the personal agent hands to a role assistant.
//!
//! Three modes, all owned by the runtime rather than by the personal agent's
//! session — so switching that session, or the brain under it, never touches
//! what was dispatched:
//!
//! - **task**: a kanban task in the target project, run by the work-task
//!   engine in its own worktree. Never auto-merged
//!   (`work_task.personal_agent_dispatch_id`); the owner reviews it.
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
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{DispatchWrite, ItemWrite, NewDispatch, NewRow};
use crate::models::personal_agent::{DispatchExecutorSnapshot, PersonalAgentChange};
use crate::models::{AgentType, AssistantRunSnapshot, FollowUpIntent, WorkTaskConfig, WorkTaskDraft};

/// Longest result excerpt kept on a dispatch, in characters.
const EXCERPT_CHARS: usize = 2_000;
/// Longest title.
pub const MAX_TITLE_CHARS: usize = 120;
/// Longest prompt or follow-up message.
pub const MAX_PROMPT_CHARS: usize = 20_000;

/// A dispatch as the tool asked for it.
#[derive(Debug, Clone)]
pub struct DispatchRequest {
    pub mode: DispatchMode,
    pub assistant_id: i32,
    pub title: String,
    pub prompt: String,
    pub project_id: Option<i32>,
    pub report: bool,
    pub on_done: Option<String>,
}

/// The states in which a dispatch still holds or waits for its executor.
const LIVE_STATES: &[DispatchState] = &[
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
    })
}

impl PersonalAgentEngine {
    // ── dispatch ────────────────────────────────────────────────────────────

    /// Validate a dispatch, record it, and set it going. Returns at once: the
    /// work itself starts in the background.
    pub async fn dispatch(
        self: &std::sync::Arc<Self>,
        req: DispatchRequest,
    ) -> Result<dispatch_entity::Model, String> {
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
        let snapshot = DispatchExecutorSnapshot {
            assistant_id: assistant.id,
            name: assistant.name.clone(),
            agent_type: assistant.agent_type,
            agent_options: assistant.agent_options.clone(),
            label_snapshot: Some(assistant.label_snapshot.clone()),
            instructions: assistant.instructions.clone(),
        };
        let on_done = req
            .on_done
            .as_deref()
            .map(|s| cut(s, 2_000))
            .filter(|s| !s.is_empty());
        let row = svc::create_dispatch(
            &self.db.conn,
            NewDispatch {
                mode: req.mode,
                executor_assistant_id: assistant.id,
                executor_snapshot_json: serde_json::to_string(&snapshot).map_err(|e| e.to_string())?,
                folder_id,
                deliverable: if req.mode == DispatchMode::Task {
                    Some(if req.report { "report" } else { "change" }.to_string())
                } else {
                    None
                },
                title: title.clone(),
                prompt: prompt.clone(),
                origin_batch_id: self.current_batch().await,
                on_done: on_done.clone(),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
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
            ItemKind::Dispatch,
            Some(row.id),
            ItemStatus::Open,
            Some(WaitsFor::External),
            title,
            on_done,
            card.map(|c| c.id),
        )
        .await;
        self.emit(PersonalAgentChange::Dispatch { id: row.id });
        let engine = self.clone();
        let id = row.id;
        tokio::spawn(async move {
            engine.start_dispatch(id).await;
        });
        Ok(row)
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
            crate::acp::agent_mentions::render_assistant_brief(&executor.name, &executor.instructions)
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
        engine.start(task.id).await?;
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
            let active = svc::count_active_conversation_dispatches(&self.db.conn)
                .await
                .unwrap_or(0) as u32;
            if limit > 0 && active >= limit {
                return;
            }
            let next = svc::queued_conversation_dispatches(&self.db.conn)
                .await
                .unwrap_or_default()
                .into_iter()
                .next();
            let Some(d) = next else {
                return;
            };
            if let Some(message) = d.followup.clone() {
                if let Err(e) = self.send_followup(&d, message, &[DispatchState::Queued]).await {
                    // Claimed and then not sent: it failed as a round. Not
                    // claimed: it never left the queue.
                    match svc::get_dispatch(&self.db.conn, d.id).await {
                        Ok(Some(now)) if now.state == DispatchState::Failed => {
                            self.record_progress(&now, None, Some(e), "followup").await
                        }
                        _ => self.fail_dispatch(&d, &e).await,
                    }
                }
            } else if let Err(e) = self.start_conversation_dispatch(&d).await {
                self.fail_dispatch(&d, &e).await;
            }
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
        self.state.lock().await.dispatch_conns.insert(
            conn_id.to_string(),
            DispatchConn {
                id,
                round_since: None,
            },
        );
    }

    /// Open a round on `conn_id`, just before its prompt goes out.
    pub(super) async fn open_round(&self, conn_id: &str, id: i32) {
        let since = self.current_seq(conn_id).await;
        self.state.lock().await.dispatch_conns.insert(
            conn_id.to_string(),
            DispatchConn {
                id,
                round_since: Some(since),
            },
        );
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
            instructions: executor.instructions.clone(),
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
        let suffix = crate::acp::agent_mentions::render_assistant_brief(
            &executor.name,
            &executor.instructions,
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
        Ok(())
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
        // The slot is free: the next queued one may start.
        self.kick_queue();
    }

    /// A dispatched conversation's connection went away mid-turn.
    async fn settle_lost_connection(self: &std::sync::Arc<Self>, id: i32, conn_id: &str) {
        self.state.lock().await.dispatch_conns.remove(conn_id);
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
        let fresh = svc::insert_event(
            &self.db.conn,
            "dispatch_status",
            &source_key,
            Some(format!("dispatch:{}", d.id)),
            summary.clone(),
            Some(serde_json::json!({
                "dispatch_id": d.id,
                "state": d.state,
                "on_done": d.on_done,
            })),
            wake,
        )
        .await
        .unwrap_or(false);
        if !fresh {
            return;
        }
        // A chat dispatch's conversation sits in its own hidden folder; the
        // card's link needs it to open the conversation.
        let conversation_folder_id = match d.conversation_id {
            Some(cid) => crate::db::service::conversation_service::get_by_id(&self.db.conn, cid)
                .await
                .ok()
                .map(|c| c.folder_id),
            None => None,
        };
        let mut card = NewRow::new(TimelineKind::Result, summary);
        card.dispatch_id = Some(d.id);
        card.segment_id = self.state.lock().await.connection_segment;
        card.data = Some(serde_json::json!({
            "mode": d.mode,
            "state": d.state,
            "title": d.title,
            "executor": executor.name,
            "executor_id": executor.assistant_id,
            "agent_type": executor.agent_type,
            "excerpt": excerpt,
            "note": note,
            "work_task_id": d.work_task_id,
            "conversation_id": d.conversation_id,
            "conversation_folder_id": conversation_folder_id,
            "folder_id": d.folder_id,
        }));
        self.push_row(card).await;
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
        if d.mode == DispatchMode::Task || d.state == DispatchState::HandedOver {
            return;
        }
        self.state.lock().await.dispatch_conns.remove(connection_id);
        if let Ok(Some(updated)) = svc::update_dispatch(
            &self.db.conn,
            d.id,
            None,
            DispatchWrite {
                state: Some(DispatchState::HandedOver),
                ..Default::default()
            },
        )
        .await
        {
            self.record_progress(&updated, None, None, "handover").await;
        }
    }

    // ── follow-ups ──────────────────────────────────────────────────────────

    /// Continue a dispatch. Returns a sentence for the agent.
    pub async fn followup(
        self: &std::sync::Arc<Self>,
        id: i32,
        message: String,
        intent: Option<String>,
    ) -> Result<String, String> {
        let message = message.trim().to_string();
        if message.is_empty() {
            return Err("`message` is required".into());
        }
        if message.chars().count() > MAX_PROMPT_CHARS {
            return Err(format!("`message` is longer than {MAX_PROMPT_CHARS} characters"));
        }
        let d = svc::get_dispatch(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("dispatch #{id} does not exist"))?;
        match d.mode {
            DispatchMode::Task => self.followup_task(&d, message, intent).await,
            _ => {
                if intent.is_some() {
                    return Err("`intent` applies to task dispatches only".into());
                }
                self.followup_conversation(&d, message).await
            }
        }
    }

    async fn followup_task(
        &self,
        d: &dispatch_entity::Model,
        message: String,
        intent: Option<String>,
    ) -> Result<String, String> {
        let task_id = d.work_task_id.ok_or("this dispatch has no task yet")?;
        let engine = crate::work_task::engine().ok_or("the task engine is not running")?;
        let task = crate::db::service::work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        match task.status {
            WorkTaskStatus::Review => {
                let intent = FollowUpIntent::from_wire(intent.as_deref())?;
                engine.return_task(task_id, intent, message, Vec::new()).await?;
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
                engine.retry(task_id, Some(message), Vec::new(), false).await?;
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
        let active = svc::count_active_conversation_dispatches(&self.db.conn)
            .await
            .unwrap_or(0) as u32;
        if limit > 0 && active >= limit {
            let Some(_) = svc::update_dispatch(
                &self.db.conn,
                d.id,
                Some(FOLLOWUP_FROM),
                DispatchWrite {
                    state: Some(DispatchState::Queued),
                    result_excerpt: Some(None),
                    error: Some(None),
                    followup: Some(Some(message)),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?
            else {
                return Err("the dispatch changed state meanwhile; check item_list".into());
            };
            self.reopen_item(d.id).await;
            self.emit(PersonalAgentChange::Dispatch { id: d.id });
            self.emit(PersonalAgentChange::Status);
            return Ok(format!(
                "All {limit} session slots are busy: the follow-up to dispatch #{} waits for one \
                 and starts by itself; its result comes back as an event.",
                d.id
            ));
        }
        self.send_followup(d, message, FOLLOWUP_FROM).await
    }

    /// Send a follow-up round into a dispatch's conversation, on its live
    /// connection when that is idle or else on a resumed one, claiming the
    /// dispatch from one of `from` (the finished states for a follow-up sent
    /// at once, `queued` for one that waited for a slot). Called under the
    /// dispatch lock, so the slot it takes is the one that was counted.
    async fn send_followup(
        &self,
        d: &dispatch_entity::Model,
        message: String,
        from: &[DispatchState],
    ) -> Result<String, String> {
        let conversation_id = d.conversation_id.ok_or("this dispatch never started a conversation")?;
        let executor = executor_of(d);
        let summary = crate::db::service::conversation_service::get_by_id(&self.db.conn, conversation_id)
            .await
            .map_err(|e| e.to_string())?;
        let folder = crate::commands::folders::get_folder_core(&self.db, summary.folder_id)
            .await
            .map_err(|e| e.to_string())?;
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
        // Claim the round before sending, with the connection it runs on: a
        // handover racing it wins.
        let Some(_) = svc::update_dispatch(
            &self.db.conn,
            d.id,
            Some(from),
            DispatchWrite {
                state: Some(DispatchState::Running),
                connection_id: Some(Some(conn_id.clone())),
                result_excerpt: Some(None),
                error: Some(None),
                followup: Some(None),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?
        else {
            return Err("the dispatch changed state meanwhile; check item_list".into());
        };
        self.open_round(&conn_id, d.id).await;
        let sent = self
            .manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &conn_id,
                vec![PromptInputBlock::Text { text: message }],
                Some(summary.folder_id),
                Some(conversation_id),
                None,
                None,
            )
            .await;
        if let Err(e) = sent {
            self.state.lock().await.dispatch_conns.remove(&conn_id);
            let _ = svc::update_dispatch(
                &self.db.conn,
                d.id,
                Some(&[DispatchState::Running]),
                DispatchWrite {
                    state: Some(DispatchState::Failed),
                    error: Some(Some(e.to_string())),
                    bump_turns: true,
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
