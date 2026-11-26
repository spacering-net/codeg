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
//! The work runs on its assistant's work agent, frozen at dispatch: the
//! agent, its options and the assistant's standing instructions for its
//! work (appended to its first input as the same brief delegation uses). Conversation dispatches run like the automation engine's
//! runs: the connection is registered before its first prompt, each turn is
//! settled from `TurnComplete`, and a reconcile tick settles the ones whose
//! event was lost. Every state change lands as an event for the agent and a
//! result card on the timeline at once.

use chrono::Utc;

use super::engine::{enum_str, settings_of, PersonalAgentEngine};
use super::read_check::OrFailed;
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
use crate::models::personal_agent::{DispatchWorkSnapshot, PersonalAgentChange};
use crate::models::{AgentType, AssistantRunSnapshot, FollowUpIntent, WorkTaskConfig, WorkTaskDraft};

/// Longest result excerpt kept on a dispatch, in characters.
const EXCERPT_CHARS: usize = 2_000;
/// Longest title.
pub const MAX_TITLE_CHARS: usize = 120;
/// Longest prompt or follow-up message.
pub const MAX_PROMPT_CHARS: usize = 20_000;
/// Longest acceptance criteria (7.5).
pub const MAX_DONE_WHEN_CHARS: usize = 4_000;
/// What an assistant hears when the agent its work runs on cannot run.
pub const NO_WORK_AGENT: &str = "you cannot start work yourself right now: the agent your work runs \
     on is not installed, or turned off in the agents' settings. Ask the owner to pick another \
     in your settings; until then, hand the work to another assistant with `bot_message`, or \
     tell the owner.";
/// What an assistant works with, as it reads it: the agent, its mode and
/// options.
pub fn work_words(w: &DispatchWorkSnapshot) -> String {
    label_words(w.agent_type, w.label_snapshot.as_ref())
}

/// The name of the agent a piece of work ran on.
pub fn agent_words(w: &DispatchWorkSnapshot) -> String {
    w.label_snapshot
        .as_ref()
        .map(|l| l.agent.clone())
        .filter(|a| !a.trim().is_empty())
        .unwrap_or_else(|| crate::acp::registry::get_agent_meta(w.agent_type).name.to_string())
}

/// An agent and its picked mode and options, in words.
pub fn label_words(
    agent_type: crate::models::AgentType,
    label: Option<&crate::models::AssistantLabelSnapshot>,
) -> String {
    let Some(l) = label else {
        return agent_type.to_string();
    };
    let mut parts = vec![l.agent.clone()];
    parts.extend(l.mode.iter().map(|m| format!("mode {m}")));
    parts.extend(
        l.options
            .iter()
            .filter(|o| !o.value_label.trim().is_empty())
            .map(|o| format!("{}: {}", o.name, o.value_label)),
    );
    parts.join(" · ")
}
/// A dispatch as the tool asked for it — and as a proposal card keeps it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DispatchRequest {
    pub mode: DispatchMode,
    pub title: String,
    pub prompt: String,
    pub project_id: Option<i32>,
    pub report: bool,
    pub on_done: Option<String>,
    /// What done looks like, criterion by criterion (7.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_when: Option<String>,
    /// The failed (or stopped) work of this assistant's it takes over (B1):
    /// that work's matter is handed to this one as it is recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<i32>,
}

/// A dispatch checked against the projects, ready to record. What runs it
/// is not here: the work agent of the assistant that records it, as it is
/// the moment it is recorded.
#[derive(Debug, Clone)]
pub struct ValidDispatch {
    pub mode: DispatchMode,
    pub folder_id: Option<i32>,
    pub title: String,
    pub prompt: String,
    pub report: bool,
    pub on_done: Option<String>,
    pub done_when: Option<String>,
    /// codeg's own check of other work (7.5), not work of the assistant's:
    /// kept out of what the assistants' work is compared by.
    pub is_check: bool,
    /// The input it is dispatched for, and the chain and thread it inherits
    /// from that input (`for`, 4.11); empty when nothing started it.
    pub lineage: svc::Lineage,
    /// A round codeg starts on a watched pull request (7.4): its task works
    /// on that pull request and is delivered back to it once accepted.
    pub pr_fix: Option<super::pr_auto::PrFix>,
    /// The failed work it takes over (B1).
    pub replaces: Option<i32>,
}

impl ValidDispatch {
    /// Its ledger key: what makes two calls the same one.
    pub fn ledger_key(&self) -> String {
        super::ledger::replacing_key(
            super::ledger::dispatch_key(self.mode, self.folder_id, &self.title),
            self.replaces,
        )
    }

    /// The request it was checked from, as a proposal card keeps it.
    pub fn to_request(&self) -> DispatchRequest {
        DispatchRequest {
            mode: self.mode,
            title: self.title.clone(),
            prompt: self.prompt.clone(),
            project_id: self.folder_id,
            report: self.report,
            on_done: self.on_done.clone(),
            done_when: self.done_when.clone(),
            replaces: self.replaces,
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
    /// A routine's run hands it out (6.9): once per run, whatever repeats
    /// it. `label` names the routine on its card.
    Routine { run_id: i32, label: serde_json::Value },
    /// codeg's own step under a stable operation id (a round fixing a
    /// watched pull request, 7.4): one on record already is not made again.
    Op { op_id: String },
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
    /// codeg's own step, under a stable operation id (an automatic retry,
    /// a plan's feedback): one that is on record already is not run again.
    Op { op_id: String },
}

/// What a follow-up's send answers when its session is still busy with the
/// round before (a stop just went out, the executor has not wound down):
/// said before the round is claimed, so nothing of it was written.
pub(super) const FOLLOWUP_BUSY: &str = "the conversation is busy; wait for its result first";

/// The states in which a dispatch still holds or waits for its session.
pub(super) const LIVE_STATES: &[DispatchState] = &[
    DispatchState::Queued,
    DispatchState::Running,
    DispatchState::WaitingInput,
    DispatchState::Review,
];

/// The round a dispatch's news was of, from its event's source key
/// (`dispatch:<id>:<round>:<state>:<cause>`).
/// A work assistant's keys are scoped (`bot<id>:` first).
pub(super) fn round_of_source_key(key: &str) -> Option<i32> {
    let key = match key.split_once(':') {
        Some((scope, rest)) if scope.starts_with("bot") => rest,
        _ => key,
    };
    let mut parts = key.split(':');
    (parts.next()? == "dispatch").then_some(())?;
    parts.next()?;
    parts.next()?.parse().ok()
}

/// How long work of an assistant's that failed is left to it before the
/// owner is told (B6): the assistant often picks it up again at once — a
/// new attempt, a follow-up — and then a failure is not the owner's news.
pub const FAILED_HOLD_SECS: i64 = 120;

/// Whether the failure of attempt `f` is still news (B6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StillNews {
    Yes,
    /// Taken over in that attempt, or gone on since: a newer card of it
    /// (one that went on and ended, or failed again — that one has its own
    /// news), or — a board task's — the board in a newer run.
    No,
    /// Not failed now, with nothing newer to tell: picked up, the pick-up
    /// not known to have gone out (a follow-up's claim before it is sent
    /// can fall back to failed). Asked again a moment later.
    NotYet,
}

pub(crate) async fn failure_still_news(
    db: &crate::db::AppDatabase,
    f: &super::reach::FailHold,
) -> StillNews {
    let Ok(Some(d)) = svc::get_dispatch(&db.conn, f.dispatch_id).await else {
        return StillNews::No;
    };
    if let Some(by) = d.replaced_by {
        let taken = match svc::get_dispatch(&db.conn, by).await {
            Ok(Some(n)) => n.replaces_run_seq,
            _ => None,
        };
        match (taken, f.task) {
            (Some(run), Some((_, failed))) if run != failed => {}
            _ => return StillNews::No,
        }
    }
    if svc::latest_result_row(&db.conn, d.id)
        .await
        .ok()
        .flatten()
        .is_some_and(|c| c.id > f.card_id)
    {
        return StillNews::No;
    }
    if let Some((task, run)) = f.task {
        let now = crate::db::service::work_task_service::get_model(&db.conn, task)
            .await
            .map(|t| t.run_seq);
        if now.is_ok_and(|r| r != run) {
            return StillNews::No;
        }
    }
    if d.state != DispatchState::Failed {
        return StillNews::NotYet;
    }
    StillNews::Yes
}

/// When this process's assistants first booted: work recorded before it was
/// recorded by a process that is gone (B1's start-up repairs).
static BOOTED_AT: std::sync::OnceLock<chrono::DateTime<Utc>> = std::sync::OnceLock::new();

pub(super) fn booted_at() -> chrono::DateTime<Utc> {
    *BOOTED_AT.get_or_init(Utc::now)
}

/// Whether dispatch `d` was taken over by other work (B1) in the run it
/// is in now: then nothing of codeg's picks it up again — an automatic
/// retry, a retry card, a late update reopening its matter — and it is not
/// listed as failed. A board task the owner ran again since (its run past
/// the one taken over) is theirs, and moves as any.
pub(crate) async fn superseded(db: &crate::db::AppDatabase, d: &dispatch_entity::Model) -> bool {
    superseded_with(db, d, None).await
}

/// [`superseded`], with `d`'s board task as the caller read it (`seen`):
/// judged by that read's run.
pub(crate) async fn superseded_with(
    db: &crate::db::AppDatabase,
    d: &dispatch_entity::Model,
    seen: Option<&crate::db::entities::work_task::Model>,
) -> bool {
    let Some(by) = d.replaced_by else {
        return false;
    };
    let taken = svc::get_dispatch(&db.conn, by)
        .await
        .or_failed()
        .and_then(|n| n.replaces_run_seq);
    match (taken, d.work_task_id, seen) {
        (Some(run), Some(t), Some(task)) if task.id == t => task.run_seq == run,
        (Some(run), Some(t), _) => super::read_check::found(
            crate::db::service::work_task_service::get_model(&db.conn, t).await,
        )
        .is_none_or(|task| task.run_seq == run),
        _ => true,
    }
}

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
#[derive(Debug, Clone)]
pub(crate) struct DispatchConn {
    pub(crate) id: i32,
    /// The connection's `event_seq` when the open round's prompt was sent;
    /// `None` between rounds. Only a completion above it settles the round,
    /// so a late or repeated completion of an earlier round cannot close the
    /// one running now.
    pub(crate) round_since: Option<u64>,
    /// The operation the open round runs for (`round_op_id` as the round
    /// opened: none for the first, a follow-up's op after): what settles,
    /// and what an event of this round is checked against — a round
    /// stopped and followed up at once writes a new op on the dispatch,
    /// which an event of the old one does not match.
    pub(crate) round_op: Option<String>,
}

/// How a round's end found its registration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RoundOf {
    /// Not this round's (an earlier one's late end): nothing to settle.
    NotIt,
    /// Nothing tracks the connection (after a restart): settled by the
    /// dispatch row, while the row is still on this connection.
    Untracked,
    /// The round open on the connection, run for `op`.
    Open { op: Option<String> },
}

/// The failure a dispatched conversation's open round told as its reply
/// (`SessionFailureRecord::echoed_in_reply` — Antigravity's dead executor),
/// by `connection_id`: codeg took those words out of the reply, so the
/// round's `end_turn` is no success with an empty result. Process-wide, as
/// connection ids are, so it holds whichever engine routes the round (a
/// hand-over moves the route, not this); every way of seeing the round end
/// reads it, none takes it, so two racing to settle the round read the
/// same; the next round's opening clears it. One short entry per
/// connection whose round told a failure.
static ROUND_FAILURES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(Default::default);

fn round_failure(conn_id: &str) -> Option<String> {
    ROUND_FAILURES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(conn_id)
        .cloned()
}

fn set_round_failure(conn_id: &str, failure: Option<String>) {
    let mut map = ROUND_FAILURES.lock().unwrap_or_else(|e| e.into_inner());
    match failure {
        Some(f) => map.insert(conn_id.to_string(), f),
        None => map.remove(conn_id),
    };
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
    /// It ended `end_turn` on a failure the agent told as its reply, which
    /// codeg took out of that reply: the failure, in the agent's words.
    Told(String),
}

impl RoundEnd {
    /// The end, given the failure the round told as its reply: one that
    /// ended as if well (`end_turn`, or found over by the backstop or with
    /// its connection gone) failed in those words; a cancel or another stop
    /// stays what it was.
    fn told(self, failure: Option<String>) -> RoundEnd {
        match (failure, self) {
            (Some(failure), RoundEnd::Stop(reason)) if reason == "end_turn" => RoundEnd::Told(failure),
            (Some(failure), RoundEnd::Missed { .. } | RoundEnd::Gone { canceled: false }) => {
                RoundEnd::Told(failure)
            }
            (_, end) => end,
        }
    }

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
                        "the work's turn stopped: {}",
                        if other.is_empty() { "unknown" } else { other }
                    )),
                ),
            },
            RoundEnd::Missed { abnormal: false } | RoundEnd::Gone { canceled: false } => {
                (DispatchState::Completed, None)
            }
            RoundEnd::Missed { abnormal: true } => (
                DispatchState::Failed,
                Some("the work's turn ended abnormally".into()),
            ),
            RoundEnd::Gone { canceled: true } => (DispatchState::Canceled, None),
            RoundEnd::Told(failure) => (DispatchState::Failed, Some(failure.clone())),
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

/// A result excerpt as a dispatch keeps it: whole when it fits, cut
/// otherwise — its cards turned into words first, so none is cut in half
/// (9.5).
pub(super) fn excerpt_of(text: &str) -> String {
    if text.trim().chars().count() <= EXCERPT_CHARS {
        return text.trim().to_string();
    }
    cut(&super::spec_text::cards_as_text(text), EXCERPT_CHARS)
}

pub(super) fn cut(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let mut s: String = t.chars().take(max).collect();
        s.push('…');
        s
    }
}

pub(super) fn mode_label(mode: DispatchMode) -> &'static str {
    match mode {
        DispatchMode::Task => "kanban task",
        DispatchMode::Chat => "chat",
        DispatchMode::Session => "work session",
    }
}

pub(super) fn state_sentence(state: DispatchState) -> &'static str {
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

/// An assistant's work agent when it can run now: one codeg knows, not
/// turned off in the agents' settings. (One not installed fails when its
/// session starts, as a launch of it anywhere does.)
pub async fn usable_work(
    db: &crate::db::AppDatabase,
    row: &crate::db::entities::personal_agent::Model,
) -> Option<crate::models::AssistantAgentConfig> {
    let work = super::engine::work_of_row(row)?;
    if !work_agent_on(db, work.agent_type).await {
        return None;
    }
    Some(work)
}

/// Whether `agent_type` is not turned off in the agents' settings (an
/// agent with no settings row is on).
pub async fn work_agent_on(db: &crate::db::AppDatabase, agent_type: AgentType) -> bool {
    crate::db::service::agent_setting_service::get_by_agent_type(&db.conn, agent_type)
        .await
        .ok()
        .flatten()
        .is_none_or(|s| s.enabled)
}

pub fn work_of(d: &dispatch_entity::Model) -> DispatchWorkSnapshot {
    serde_json::from_str(&d.work_snapshot).unwrap_or(DispatchWorkSnapshot {
        name: String::new(),
        bot_uid: None,
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

    /// Check a dispatch's request: the mode and project fit, the texts are in
    /// bounds. Data checks only — nothing about who asked or when, nor what
    /// runs it (taken when it is recorded).
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
        let on_done = req
            .on_done
            .as_deref()
            .map(|s| cut(s, 2_000))
            .filter(|s| !s.is_empty());
        let done_when = match req
            .done_when
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(w) if w.chars().count() > MAX_DONE_WHEN_CHARS => {
                return Err(format!(
                    "`done_when` is longer than {MAX_DONE_WHEN_CHARS} characters"
                ));
            }
            w => w.map(str::to_string),
        };
        Ok(ValidDispatch {
            mode: req.mode,
            folder_id,
            title,
            prompt,
            report: req.report,
            on_done,
            done_when,
            is_check: false,
            lineage: svc::Lineage::default(),
            pr_fix: None,
            replaces: req.replaces,
        })
    }

    /// What runs this assistant's work, as it is now: its work agent and
    /// options and its standing instructions for its work, frozen into the
    /// dispatch with who handed it out. An agent that cannot run — not
    /// known, not installed, turned off — is said so, for the owner to pick
    /// another in its settings.
    pub(super) async fn work_snapshot(&self) -> Result<DispatchWorkSnapshot, String> {
        let row = self.agent_row().await.ok_or("not set up")?;
        let work = usable_work(&self.db, &row).await.ok_or(NO_WORK_AGENT)?;
        Ok(DispatchWorkSnapshot {
            name: super::messages::display_name(&row),
            bot_uid: row.uid.clone(),
            agent_type: work.agent_type,
            agent_options: work.agent_options,
            label_snapshot: Some(work.label_snapshot),
            instructions: row.work_instructions.clone().unwrap_or_default(),
            dispatcher: Some(self.dispatcher_brief().await),
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
        let key = v.ledger_key();
        let ValidDispatch {
            mode,
            folder_id,
            title,
            prompt,
            report,
            on_done,
            done_when,
            is_check,
            lineage,
            pr_fix,
            replaces,
        } = v;
        let thread = lineage.thread_id;
        let request = DispatchRequest {
            mode,
            title: title.clone(),
            prompt: prompt.clone(),
            project_id: folder_id,
            report,
            on_done: on_done.clone(),
            done_when: done_when.clone(),
            replaces,
        };
        // A repeat costs nothing to find before anything is written — and is
        // found whatever runs this assistant's work now.
        if let DispatchAuth::Ledgered { scope, .. } = &auth {
            let earlier = svc::ledger_entries(&self.db.conn, scope, &key)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(entry) = earlier.iter().find(|e| e.state == ActionState::Committed) {
                return self.earlier_dispatch(entry).await;
            }
        }
        // The same for a card's, a routine run's or codeg's own step: found
        // by its operation before anything is looked up for it.
        let slot_op = match &auth {
            DispatchAuth::Card { notice_id } => Some(ledger::card_op_id(*notice_id, 1)),
            DispatchAuth::Routine { run_id, .. } => Some(format!("routine-run:{run_id}")),
            DispatchAuth::Op { op_id } => Some(op_id.clone()),
            DispatchAuth::Ledgered { .. } | DispatchAuth::Direct => None,
        };
        if let Some(op) = slot_op.as_deref() {
            let earlier = svc::get_op(&self.db.conn, op)
                .await
                .map_err(|e| e.to_string())?
                .filter(|e| e.state == ActionState::Committed);
            if let Some(entry) = earlier {
                return self.earlier_dispatch(&entry).await;
            }
        }
        // The failed work it takes over, as it stands now; claimed with the
        // write, which refuses it if that no longer holds.
        let handover = match replaces {
            Some(p) => Some(self.handover_for(p, folder_id, &title, on_done.clone()).await?),
            None => None,
        };
        let handover = handover.as_ref();
        // What runs it: this assistant's own, as it is the moment it goes out.
        let snapshot = self.work_snapshot().await?;
        let origin_batch_id = match &auth {
            DispatchAuth::Ledgered { batch_id, .. } => Some(*batch_id),
            DispatchAuth::Card { .. } | DispatchAuth::Routine { .. } | DispatchAuth::Op { .. } => {
                None
            }
            DispatchAuth::Direct => self.current_batch().await,
        };
        let routine_label = match &auth {
            DispatchAuth::Routine { label, .. } => Some(label.clone()),
            _ => None,
        };
        // The turn's own batch, for where its card goes among what the turn
        // wrote — never the batch in flight for an older call let through.
        let ledger_batch = match &auth {
            DispatchAuth::Ledgered { batch_id, .. } => Some(*batch_id),
            _ => None,
        };
        let new = NewDispatch {
            bot_id: self.bot().await,
            mode,
            work_snapshot_json: serde_json::to_string(&snapshot).map_err(|e| e.to_string())?,
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
            done_when: done_when.clone(),
            pr_fix: pr_fix.as_ref().and_then(|f| serde_json::to_string(f).ok()),
            is_check,
        };
        let payload = serde_json::to_value(&request).ok();
        let row = match &auth {
            DispatchAuth::Ledgered { batch_id, .. } => {
                let slot = LedgerSlot::in_batch(*batch_id, key, ledger::fresh_op_id());
                match svc::create_dispatch_ledgered(
                    &self.db.conn,
                    new,
                    Some(&slot),
                    payload,
                    None,
                    handover,
                )
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
                match svc::create_dispatch_ledgered(
                    &self.db.conn,
                    new,
                    Some(&slot),
                    payload,
                    Some(card),
                    handover,
                )
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
            DispatchAuth::Direct if handover.is_some() => {
                match svc::create_dispatch_ledgered(&self.db.conn, new, None, payload, None, handover)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    Ledgered::New(row) => row,
                    Ledgered::Earlier(earlier) => return self.earlier_dispatch(&earlier).await,
                }
            }
            DispatchAuth::Direct => svc::create_dispatch(&self.db.conn, new)
                .await
                .map_err(|e| e.to_string())?,
            DispatchAuth::Routine { run_id, .. } => {
                let slot = LedgerSlot::outside(format!("routine-run:{run_id}"));
                match svc::create_dispatch_ledgered(
                    &self.db.conn,
                    new,
                    Some(&slot),
                    payload,
                    None,
                    handover,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    Ledgered::New(row) => row,
                    Ledgered::Earlier(earlier) => return self.earlier_dispatch(&earlier).await,
                }
            }
            DispatchAuth::Op { op_id } => {
                let slot = LedgerSlot::outside(op_id.clone());
                match svc::create_dispatch_ledgered(
                    &self.db.conn,
                    new,
                    Some(&slot),
                    payload,
                    None,
                    handover,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    Ledgered::New(row) => row,
                    Ledgered::Earlier(earlier) => return self.earlier_dispatch(&earlier).await,
                }
            }
        };
        // The card, then the ledger entry pointing back at it — after the
        // text the turn wrote before it, which is pushed first.
        let turn = match ledger_batch {
            Some(b) => self.turn_mark(b).await,
            None => None,
        };
        self.push_reply_now().await;
        let mut card = NewRow::new(TimelineKind::Dispatch, title.clone());
        card.dispatch_id = Some(row.id);
        card.segment_id = self.state.lock().await.connection_segment;
        card.batch_id = row.origin_batch_id;
        card.data = Some(serde_json::json!({
            // Where it goes among what its turn wrote (P6).
            "turn": turn,
            "mode": row.mode,
            "agent_type": snapshot.agent_type,
            "folder_id": folder_id,
            "deliverable": row.deliverable,
            "state": row.state,
            // The assistant's acceptance criteria, for the owner to see (7.5).
            "done_when": done_when,
            // The routine whose run handed it out (6.9).
            "routine": routine_label,
            // The watched pull request it fixes, and why (7.4).
            "pr_fix": pr_fix,
        }));
        let card = self.push_row(card).await;
        // A round on a pull request belongs to the matter of the work that
        // made it, when there is one: no matter of its own (7.4).
        // Work that took failed work over has its matter already, made with
        // it (B1): it only learns its row.
        let handed = match handover {
            Some(_) => svc::item_of_dispatch(&self.db.conn, row.id).await.ok().flatten(),
            None => None,
        };
        if let (Some(item), Some(c)) = (handed.as_ref(), card.as_ref()) {
            let _ = svc::set_item_origin(&self.db.conn, item.id, c.id).await;
            self.emit(PersonalAgentChange::Item { id: item.id });
        }
        let under = handed.is_some()
            || match pr_fix.as_ref().and_then(|f| f.origin_dispatch_id) {
                Some(origin) => svc::item_of_dispatch(&self.db.conn, origin)
                    .await
                    .ok()
                    .flatten()
                    .is_some(),
                None => false,
            };
        if !under {
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
        }
        // Work handed out is progress on the thread it is for (4.9).
        if let Some(t) = thread {
            self.thread_progress(t).await;
        }
        self.settle_handover(&row).await;
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
        // What the first call left to do once its write was in (B1): done
        // again, to no further effect when it was done.
        self.settle_handover(&dispatch).await;
        Ok(DispatchMade {
            dispatch,
            earlier: true,
        })
    }

    /// The result card of `p`'s failure that was taken over: its latest card
    /// telling a failure (or a stop), of run `run` for a task's.
    async fn failure_card_taken_over(
        &self,
        p: i32,
        run: Option<i32>,
    ) -> Option<crate::db::entities::personal_agent_timeline::Model> {
        let cards = svc::result_rows_of_dispatch(&self.db.conn, p).await.ok()?;
        cards.into_iter().rev().find(|c| {
            let data = c
                .data
                .as_deref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                .unwrap_or_default();
            let ended = matches!(data["state"].as_str(), Some("failed" | "interrupted" | "canceled"));
            // A task's: of that run, as the card says (a card from before
            // cards said so is not known to be it).
            let of_run = match run {
                Some(r) => data["run"].as_i64() == Some(i64::from(r)),
                None => true,
            };
            ended && of_run
        })
    }

    /// The card work `d` went out with — made now when codeg went down
    /// between recording the work and writing its card (B1: the failure it
    /// took over points at it) — and its matter pointed at it.
    async fn ensure_dispatch_card(&self, d: &dispatch_entity::Model, at_boot: bool) -> Option<i32> {
        let card = match svc::dispatch_card_row(&self.db.conn, d.id).await.ok()? {
            Some(c) => c.id,
            // The call that recorded it writes its card a moment later: only
            // one long past is missing it.
            // At start-up: what was recorded before it, by a process gone.
            None if at_boot && d.created_at >= booted_at() => return None,
            None if !at_boot && Utc::now() - d.created_at < chrono::Duration::seconds(30) => {
                return None;
            }
            None => {
                let work = work_of(d);
                let mut card = NewRow::new(TimelineKind::Dispatch, d.title.clone());
                card.dispatch_id = Some(d.id);
                card.batch_id = d.origin_batch_id;
                card.data = Some(serde_json::json!({
                    "mode": d.mode,
                    "agent_type": work.agent_type,
                    "folder_id": d.folder_id,
                    "deliverable": d.deliverable,
                    "state": d.state,
                    "done_when": d.done_when,
                }));
                self.push_row(card).await?.id
            }
        };
        if let Ok(Some(item)) = svc::item_of_dispatch(&self.db.conn, d.id).await {
            if item.origin_timeline_id.is_none() {
                let _ = svc::set_item_origin(&self.db.conn, item.id, card).await;
                self.emit(PersonalAgentChange::Item { id: item.id });
            }
        }
        Some(card)
    }

    /// Whether this assistant's work `p` can be taken over by new work in
    /// project `folder_id` (B1), read as it stands — on the board for a
    /// task, which can be a step ahead of the dispatch — and the handing
    /// over to write with the new work. The write claims it again and
    /// refuses if any of it no longer holds.
    async fn handover_for(
        &self,
        p: i32,
        folder_id: Option<i32>,
        title: &str,
        on_done: Option<String>,
    ) -> Result<svc::Handover, String> {
        let me = self.bot().await;
        let d = svc::get_dispatch(&self.db.conn, p)
            .await
            .map_err(|e| e.to_string())?
            .filter(|d| d.bot_id == Some(me))
            .ok_or_else(|| format!("`replaces`: dispatch #{p} is not one of yours"))?;
        if let Some(by) = d.replaced_by {
            return Err(format!("`replaces`: dispatch #{p} was taken over by #{by} already"));
        }
        if d.is_check || d.pr_fix.is_some() {
            return Err(format!(
                "`replaces`: dispatch #{p} is codeg's own (a check, a pull request's round): codeg \
                 retries it, not you"
            ));
        }
        if d.folder_id != folder_id {
            return Err(format!(
                "`replaces`: dispatch #{p} is in another project; new work takes over work in its \
                 own project only"
            ));
        }
        let task = match (d.mode, d.work_task_id) {
            (DispatchMode::Task, Some(t)) => {
                match crate::db::service::work_task_service::get_model(&self.db.conn, t).await {
                    Ok(task) if matches!(task.status, WorkTaskStatus::Failed | WorkTaskStatus::Canceled) => {
                        Some((t, task.run_seq))
                    }
                    Ok(task) => {
                        return Err(format!(
                            "`replaces`: dispatch #{p}'s board task is {} now, not failed: nothing to \
                             take over",
                            enum_str(&task.status)
                        ));
                    }
                    // Deleted from the board: the dispatch's own state says.
                    Err(_) => None,
                }
            }
            _ => None,
        };
        if task.is_none()
            && !matches!(
                d.state,
                DispatchState::Failed | DispatchState::Interrupted | DispatchState::Canceled
            )
        {
            return Err(format!(
                "`replaces`: dispatch #{p} is {} now, not failed or stopped: nothing to take over \
                 (follow it up with dispatch_followup instead)",
                enum_str(&d.state)
            ));
        }
        // Being picked up again already: a follow-up on its way, codeg's
        // own retry of an interruption about to go out.
        if d.followup.is_some() {
            return Err(format!(
                "`replaces`: dispatch #{p} has a follow-up on its way; let it run, or wait for it"
            ));
        }
        if self.retry_pending(p).await {
            return Err(format!(
                "`replaces`: codeg retries dispatch #{p} by itself; nothing for you to take over"
            ));
        }
        Ok(svc::Handover {
            predecessor: p,
            task,
            summary: title.to_string(),
            on_done,
        })
    }

    /// Whether codeg is about to retry dispatch `p`'s interruption itself
    /// (7.3): its card says so, and it has not gone out yet.
    async fn retry_pending(&self, p: i32) -> bool {
        let Ok(Some(card)) = svc::latest_result_row(&self.db.conn, p).await else {
            return false;
        };
        card.data
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .is_some_and(|v| v["auto_retry"]["state"].as_str() == Some("pending"))
    }

    /// What a handing over leaves to do once its write is in (B1): the
    /// failed work's result card says who took it over, and both pieces of
    /// work — and the matter closed — are told to the page. Safe to do
    /// again: a replay and a restart do.
    pub(super) async fn settle_handover(&self, new: &dispatch_entity::Model) {
        self.settle_handover_at(new, false).await
    }

    /// [`Self::settle_handover`]; `at_boot`, at start-up.
    async fn settle_handover_at(&self, new: &dispatch_entity::Model, at_boot: bool) {
        let Some(p) = new.replaces_id else {
            return;
        };
        // No card for it yet: the call that recorded it is writing it, and
        // says who took over itself, with the way to it.
        let Some(row) = self.ensure_dispatch_card(new, at_boot).await else {
            return;
        };
        // The card of the failure it took over: the latest that tells a
        // failure, of the run taken over — a run the owner started on the
        // board since has its own cards; a failure taken over before its
        // card was written has none (nothing more is written of it).
        if let Some(card) = self.failure_card_taken_over(p, new.replaces_run_seq).await {
            let mut data = card
                .data
                .as_deref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            let by = serde_json::json!({ "dispatch_id": new.id, "title": new.title, "row_id": row });
            if data.get("replaced_by") != Some(&by) {
                if let Some(map) = data.as_object_mut() {
                    map.insert("replaced_by".into(), by);
                }
                if svc::update_row_data(&self.db.conn, card.id, None, Some(data))
                    .await
                    .is_ok()
                {
                    if let Ok(Some(updated)) = svc::get_row(&self.db.conn, card.id).await {
                        self.emit_rows(vec![svc::to_row(updated)]);
                    }
                }
            }
        }
        if let Ok(Some(item)) = svc::item_of_dispatch(&self.db.conn, p).await {
            self.emit(PersonalAgentChange::Item { id: item.id });
        }
        self.emit(PersonalAgentChange::Dispatch { id: p });
        self.emit(PersonalAgentChange::Dispatch { id: new.id });
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
        let work = work_of(d);
        let folder_id = d.folder_id.ok_or("a task dispatch without a project")?;
        let mut blocks = vec![serde_json::json!({ "type": "text", "text": d.prompt })];
        if let Some(brief) =
            crate::acp::agent_mentions::render_assistant_brief(&work.name, &work.brief_text())
        {
            blocks.push(serde_json::json!({ "type": "text", "text": brief }));
        }
        let config = WorkTaskConfig {
            prompt_blocks: blocks,
            display_text: d.prompt.clone(),
            agent_type: Some(work.agent_type.as_wire().into_owned()),
            mode_id: work.agent_options.mode_id.clone(),
            config_values: work.agent_options.config_values.clone(),
            label_snapshot: work
                .label_snapshot
                .as_ref()
                .and_then(|l| serde_json::to_value(l).ok()),
            deliverable: (d.deliverable.as_deref() == Some("report"))
                .then(|| crate::models::DELIVERABLE_REPORT.to_string()),
            base_branch: None,
            executor_name: Some(work.name.clone()),
            // The assistant's work tuple, as it is now, is the task's own.
            agent_config_frozen: true,
        };
        let draft = WorkTaskDraft {
            folder_id,
            title: d.title.clone(),
            config: serde_json::to_value(&config).map_err(|e| e.to_string())?,
        };
        // A round on a watched pull request works on that pull request
        // (7.4): it is the task's source, so its delivery pushes back there.
        let on_pull = super::pr_auto::pr_fix_of(d).filter(|f| f.how == super::pr_auto::How::Task);
        let task = match on_pull {
            Some(fix) => {
                let source = self.pull_source(&fix).await?;
                use crate::db::service::work_task_service::ForgeCreateOutcome;
                match crate::db::service::work_task_service::create_on_pull_for_personal_agent(
                    &self.db.conn,
                    draft,
                    source,
                    d.id,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    ForgeCreateOutcome::Created(t) => *t,
                    ForgeCreateOutcome::Duplicate(c) => {
                        let id = c.first().map(|c| c.existing.id).unwrap_or_default();
                        return Err(format!(
                            "task #{id} is already working on this pull request; two tasks \
                             pushing to one branch would undo each other"
                        ));
                    }
                    // Stopped before it had a task: none made, nothing failed.
                    // Made by an earlier start: that one starts it.
                    ForgeCreateOutcome::DispatchStopped | ForgeCreateOutcome::DispatchAlready(_) => {
                        return Ok(())
                    }
                }
            }
            None => {
                use crate::db::service::work_task_service::CreateForDispatch;
                match crate::db::service::work_task_service::create_for_personal_agent(
                    &self.db.conn,
                    draft,
                    d.id,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    CreateForDispatch::Created(t) => *t,
                    CreateForDispatch::Stopped | CreateForDispatch::Already(_) => return Ok(()),
                }
            }
        };
        // The task was made hooked up to the dispatch, in one write: a stop
        // from here on finds it there.
        crate::web::event_bridge::emit_event(
            &self.emitter,
            crate::web::event_bridge::WORK_TASK_CHANGED_EVENT,
            crate::web::event_bridge::WorkTaskChange::Upsert { id: task.id },
        );
        let engine = crate::work_task::engine().ok_or("the task engine is not running")?;
        // Stopped since (the stop's own cancel takes the task with it): no
        // start.
        if self.was_stopped(d.id).await {
            let _ = engine.cancel(task.id, None).await;
            return Ok(());
        }
        if let Err(e) = engine.start(task.id).await {
            // Started by someone else first (the owner's "start all", the
            // board's own processing): under way, not failed.
            let elsewhere = crate::db::service::work_task_service::get_model(&self.db.conn, task.id)
                .await
                .is_ok_and(|t| t.status != WorkTaskStatus::Todo);
            if !elsewhere {
                return Err(e);
            }
        }
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
        // Each one queued tried once a pass, in order: one whose session is
        // still busy is left queued (a later pass, or the round's end, sends
        // it) and the ones behind it still get the free slots.
        let candidates: Vec<i32> = svc::queued_conversation_dispatches(&self.db.conn, self.bot().await)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|d| d.id)
            .collect();
        for id in candidates {
            let active = svc::count_active_conversation_dispatches(&self.db.conn, self.bot().await)
                .await
                .unwrap_or(0) as u32;
            if limit > 0 && active >= limit {
                return;
            }
            // As it is now: the previous one's start took a while, and this
            // one may have been stopped meanwhile.
            let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, id).await else {
                continue;
            };
            if d.state != DispatchState::Queued {
                continue;
            }
            if let Some(message) = d.followup.clone() {
                // Its own operation only: one no longer prepared (taken back
                // by a stop) is not sent under a new one.
                let op_id = match d.round_op_id.clone() {
                    Some(op_id) => match svc::get_op(&self.db.conn, &op_id).await {
                        Ok(Some(op)) if op.state == ActionState::Prepared => op_id,
                        _ => continue,
                    },
                    None => match self.queued_op(&d, &message).await {
                        Ok(op_id) => op_id,
                        Err(e) => {
                            self.fail_followup_card(d.id, None, &e).await;
                            self.fail_dispatch(&d, &e).await;
                            continue;
                        }
                    },
                };
                self.set_live(&op_id, true).await;
                if let Err(e) = self.send_followup(&d, message, &[DispatchState::Queued], &op_id).await {
                    self.set_live(&op_id, false).await;
                    // Busy with the round before: still queued, untouched.
                    if e == FOLLOWUP_BUSY {
                        continue;
                    }
                    // Not claimed because it was stopped meanwhile: nothing
                    // failed.
                    if svc::get_dispatch(&self.db.conn, d.id)
                        .await
                        .ok()
                        .flatten()
                        .is_some_and(|now| super::stop::stopped_by_of(&now).is_some())
                    {
                        continue;
                    }
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
    pub(super) fn kick_queue(self: &std::sync::Arc<Self>) {
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
                round_op: None,
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

    /// Open a round on `conn_id`, just before its prompt goes out: run for
    /// the operation on the dispatch now (a follow-up's; none at first).
    pub(super) async fn open_round(&self, conn_id: &str, id: i32) {
        let since = self.current_seq(conn_id).await;
        // A failure an earlier round told is not this one's.
        set_round_failure(conn_id, None);
        let round_op = svc::get_dispatch(&self.db.conn, id)
            .await
            .ok()
            .flatten()
            .and_then(|d| d.round_op_id);
        self.register_conn(
            conn_id,
            DispatchConn {
                id,
                round_since: Some(since),
                round_op,
            },
        )
        .await;
        // Its questions and plan approvals are this assistant's to answer
        // (7.3.1): the windows hold back their notification of those.
        self.delegate_asks(conn_id).await;
    }


    /// Close the round open on `conn_id` when `seq` (a completion's; `None`
    /// for the backstop, which checked the session itself) belongs to it.
    /// True when this call closed it — or nothing tracks the connection, so
    /// nothing else could settle it.
    #[cfg(test)]
    pub(super) async fn close_round(&self, conn_id: &str, seq: Option<u64>) -> bool {
        self.close_round_of(conn_id, seq).await != RoundOf::NotIt
    }

    /// [`Self::close_round`], saying which round it closed.
    pub(super) async fn close_round_of(&self, conn_id: &str, seq: Option<u64>) -> RoundOf {
        let mut st = self.state.lock().await;
        let Some(conn) = st.dispatch_conns.get_mut(conn_id) else {
            return RoundOf::Untracked;
        };
        match conn.round_since {
            Some(since) if seq.is_none_or(|s| s > since) => {
                conn.round_since = None;
                RoundOf::Open {
                    op: conn.round_op.clone(),
                }
            }
            _ => RoundOf::NotIt,
        }
    }

    /// The round open on `conn_id` an event of `seq` belongs to, and the
    /// operation it runs for — `None` for an event of no open round (an
    /// earlier one's, arriving late).
    pub(super) async fn open_round_of(&self, conn_id: &str, seq: u64) -> Option<Option<String>> {
        let st = self.state.lock().await;
        let conn = st.dispatch_conns.get(conn_id)?;
        conn.round_since
            .filter(|since| seq > *since)
            .map(|_| conn.round_op.clone())
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
        let work = work_of(&d);
        let agent_type = work.agent_type;
        // A check of a message ("is this right?") runs in a conversation
        // nested under the conversation the message is in, the way an ask is —
        // not a root row of the owner's list. Nested as it is created, so no
        // read of the list sees it as a root first. An acceptance check checks
        // no message (it has no fact-check row): its row is an ordinary one.
        let checked = if d.is_check {
            crate::db::service::personal_agent_check_service::of_dispatch(&self.db.conn, d.id)
                .await
                .ok()
                .flatten()
                .map(|c| c.conversation_id)
        } else {
            None
        };
        let (folder_id, cwd, conversation_id) = match d.mode {
            DispatchMode::Chat => {
                let created = match checked {
                    Some(checked) => {
                        crate::commands::conversations::create_chat_check_conversation_core(
                            &self.db.conn,
                            &self.data_dir,
                            checked,
                            agent_type,
                            Some(d.title.clone()),
                        )
                        .await
                    }
                    None => {
                        crate::commands::conversations::create_chat_conversation_core(
                            &self.db.conn,
                            &self.data_dir,
                            agent_type,
                            Some(d.title.clone()),
                            None,
                        )
                        .await
                    }
                }
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
                let cid = match checked {
                    Some(checked) => {
                        crate::commands::conversations::create_check_conversation_core(
                            &self.db.conn,
                            checked,
                            folder_id,
                            agent_type,
                            Some(d.title.clone()),
                        )
                        .await
                        .map(|row| row.id)
                    }
                    None => {
                        crate::commands::conversations::create_conversation_core(
                            &self.db.conn,
                            folder_id,
                            agent_type,
                            Some(d.title.clone()),
                        )
                        .await
                    }
                }
                .map_err(|e| e.to_string())?;
                (folder_id, folder.path, cid)
            }
        };
        let snapshot = AssistantRunSnapshot {
            name: work.name.clone(),
            agent_options: work.agent_options.clone(),
            // A resumed conversation is told who handed it out again.
            instructions: work.brief_text(),
            avatar: None,
        };
        // The assistant whose work it is, as it handed the work out — not
        // the one following it after a handover (`bot_id`).
        let bot_uid = match (work.bot_uid.clone(), d.bot_id) {
            (Some(uid), _) => Some(uid),
            (None, Some(b)) => {
                svc::get_bot_any(&self.db.conn, b).await.ok().flatten().and_then(|r| r.uid)
            }
            (None, None) => None,
        };
        let _ = crate::db::service::conversation_service::set_dispatch_provenance(
            &self.db.conn,
            conversation_id,
            bot_uid.as_deref(),
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
        // The checked conversation's `child_count` (its sidebar chevron) just
        // grew.
        if let Some(parent_id) = checked {
            crate::commands::conversations::emit_conversation_upsert(
                &self.emitter,
                &self.db.conn,
                parent_id,
            )
            .await;
        }
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
                work.agent_options.mode_id.clone(),
                work.agent_options.config_values.clone(),
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
            &work.name,
            &work.brief_text(),
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

    /// Dispatch `id` was stopped (4.10): canceled with a stop's note,
    /// whoever stopped it.
    pub(super) async fn was_stopped(&self, id: i32) -> bool {
        svc::get_dispatch(&self.db.conn, id)
            .await
            .ok()
            .flatten()
            .is_some_and(|d| super::stop::stopped_by_of(&d).is_some())
    }

    // ── progress ────────────────────────────────────────────────────────────

    /// Events on a dispatched conversation's connection.
    pub(super) async fn on_dispatch_event(self: &std::sync::Arc<Self>, id: i32, env: &EventEnvelope) {
        match &env.payload {
            AcpEvent::TurnComplete { stop_reason, .. } => {
                let round = self.close_round_of(&env.connection_id, Some(env.seq)).await;
                if round != RoundOf::NotIt {
                    self.settle_conversation_turn(
                        id,
                        &env.connection_id,
                        RoundEnd::Stop(stop_reason.clone()),
                        round,
                    )
                    .await;
                }
            }
            AcpEvent::SessionFailure { record } if record.echoed_in_reply => {
                // Only the open round's: `session/load` replays a resumed
                // conversation's still-active records of earlier rounds.
                let Some(text) = crate::cli_run::events::error_text(&env.payload) else {
                    return;
                };
                // Written under the engine's lock that the round is read
                // under, so no settle can close the round in between.
                let st = self.state.lock().await;
                let in_round = st
                    .dispatch_conns
                    .get(&env.connection_id)
                    .and_then(|c| c.round_since)
                    .is_some_and(|since| env.seq > since);
                if in_round {
                    set_round_failure(&env.connection_id, Some(text));
                }
                drop(st);
            }
            AcpEvent::PermissionRequest { .. }
            | AcpEvent::QuestionRequest { .. }
            | AcpEvent::PlanApprovalRequest { .. } => {
                // A question or a plan approval is the assistant's to answer
                // (7.3.1): its card says so, not the waiting-for-input news.
                let ask = match &env.payload {
                    AcpEvent::PermissionRequest {
                        tool_call, options, ..
                    } => crate::acp::types::PlanPermission::of(tool_call, options).is_some(),
                    _ => true,
                };
                // Only the open round's: one stopped and followed up since
                // asks nothing of the new round, and its card would wake the
                // assistant for work that was stopped.
                let Some(op) = self.open_round_of(&env.connection_id, env.seq).await else {
                    tracing::info!(
                        "[personal_agent] dispatch #{id}: a request of a round that is over, left alone"
                    );
                    return;
                };
                if let Ok(Some(updated)) = svc::update_dispatch(
                    &self.db.conn,
                    id,
                    Some(&[DispatchState::Running]),
                    DispatchWrite {
                        state: Some(DispatchState::WaitingInput),
                        expect_connection: Some(env.connection_id.clone()),
                        expect_round_op_is: Some(op),
                        ..Default::default()
                    },
                )
                .await
                {
                    if ask {
                        self.emit(PersonalAgentChange::Dispatch { id });
                    } else {
                        self.record_progress(&updated, None, None, "wait").await;
                    }
                }
                if ask {
                    if let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, id).await {
                        self.on_ask_event(&d, env).await;
                    }
                }
            }
            AcpEvent::PermissionResolved { .. }
            | AcpEvent::QuestionResolved { .. }
            | AcpEvent::PlanApprovalResolved { .. } => {
                if let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, id).await {
                    self.on_ask_event(&d, env).await;
                }
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

    /// A dispatched conversation's round ended — `round`, as its
    /// registration says. Settled only as that round's: an end that comes
    /// once the dispatch is on another connection, or on another operation
    /// (stopped and followed up meanwhile), leaves the new round alone.
    async fn settle_conversation_turn(
        self: &std::sync::Arc<Self>,
        id: i32,
        conn_id: &str,
        end: RoundEnd,
        round: RoundOf,
    ) {
        // Whichever way the end was seen — its completion, the backstop, the
        // connection gone — a round that told a failure as its reply failed.
        let end = end.told(round_failure(conn_id));
        let Some(round_op) = self.round_op_of(id, conn_id, round).await else {
            return;
        };
        let full = match self.manager.get_state(conn_id).await {
            Some(state) => state.read().await.last_assistant_text.clone(),
            None => None,
        };
        // A check's verdict comes last, past what an excerpt keeps (7.5,
        // 10.3).
        if let Some(text) = full.as_ref() {
            if self.check_round_of(id).await.is_some() || self.fact_check_of(id).await.is_some() {
                self.state.lock().await.check_texts.insert(id, text.clone());
            }
        }
        let excerpt = full.map(|t| excerpt_of(&t));
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
                expect_connection: Some(conn_id.to_string()),
                expect_round_op_is: Some(round_op.clone()),
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

    /// The operation round `round` on `conn_id` of dispatch `id` ran for:
    /// as registered when it opened; untracked (a restart), the dispatch's
    /// own — only while the dispatch is still on that connection. `None`:
    /// no round of this connection to settle.
    async fn round_op_of(&self, id: i32, conn_id: &str, round: RoundOf) -> Option<Option<String>> {
        match round {
            RoundOf::NotIt => None,
            RoundOf::Open { op } => Some(op),
            RoundOf::Untracked => {
                let d = svc::get_dispatch(&self.db.conn, id).await.ok().flatten()?;
                (d.connection_id.as_deref() == Some(conn_id)).then_some(d.round_op_id)
            }
        }
    }

    /// A dispatched conversation's connection went away mid-turn. Only the
    /// round on this connection is settled: one the dispatch went on to
    /// since (stopped and followed up on another connection) is left be.
    async fn settle_lost_connection(self: &std::sync::Arc<Self>, id: i32, conn_id: &str) {
        let registered = self.state.lock().await.dispatch_conns.remove(conn_id);
        let round = match registered {
            Some(c) => RoundOf::Open { op: c.round_op },
            None => RoundOf::Untracked,
        };
        let Some(round_op) = self.round_op_of(id, conn_id, round).await else {
            return;
        };
        if let Ok(Some(updated)) = svc::update_dispatch(
            &self.db.conn,
            id,
            Some(&[DispatchState::Running, DispatchState::WaitingInput]),
            DispatchWrite {
                state: Some(DispatchState::Failed),
                error: Some(Some("the session's connection was lost".into())),
                bump_turns: true,
                expect_connection: Some(conn_id.to_string()),
                expect_round_op_is: Some(round_op.clone()),
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
                expect_connection: Some(conn_id.to_string()),
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
        // On the heap: its future is a large one, and it is awaited deep in
        // other futures.
        Box::pin(self.record_progress_with(d, excerpt, note, cause, None)).await
    }

    /// [`Self::record_progress`], with the board task as the caller read it
    /// when it decided there was news (`seen`): the run the news is of is
    /// that read's, not a later one's.
    pub(super) async fn record_progress_with(
        &self,
        d: &dispatch_entity::Model,
        excerpt: Option<String>,
        note: Option<String>,
        cause: &str,
        seen: Option<crate::db::entities::work_task::Model>,
    ) {
        use crate::models::personal_agent_roster::FaceState;
        // Taken over by other work (B1): a late word of it is not news — its
        // matter stays with the work that took it over. Judged by the board
        // as the caller read it, when it did.
        if superseded_with(&self.db, d, seen.as_ref()).await {
            self.emit(PersonalAgentChange::Dispatch { id: d.id });
            return;
        }
        // A check codeg sent out for an acceptance (7.5) is news of that
        // acceptance, not work for the assistant to read — unless it waits
        // on a permission, which is the owner's as any session's is.
        if let Some(round) = self.check_round_of(d.id).await {
            if d.state != DispatchState::WaitingInput {
                self.check_progress(d, round, note, cause).await;
                return;
            }
        }
        // So is a check of a message the owner asked for (10.3), of that
        // check.
        if let Some(check) = self.fact_check_of(d.id).await {
            if d.state != DispatchState::WaitingInput {
                self.fact_check_progress(d, check, note).await;
                return;
            }
        }
        match d.state {
            DispatchState::Completed => self.flash_face(FaceState::Done).await,
            DispatchState::Failed | DispatchState::Interrupted => {
                self.flash_face(FaceState::Failed).await
            }
            _ => {}
        }
        let work = work_of(d);
        let task = match (d.mode, d.work_task_id, seen) {
            (DispatchMode::Task, Some(tid), Some(t)) if t.id == tid => Some(t),
            (DispatchMode::Task, Some(tid), _) => {
                crate::db::service::work_task_service::get_model(&self.db.conn, tid)
                    .await
                    .ok()
            }
            _ => None,
        };
        let round = match d.mode {
            DispatchMode::Task => task.as_ref().map(|t| t.run_seq).unwrap_or(0),
            _ => d.turns,
        };
        let mut ladder = super::ladder::ladder_of(d, task.as_ref());
        // Code work its assistant accepts (7.5): in review, it is checked
        // first — the assistant hears again once the check is back.
        let accepting = match (d.state, task.as_ref()) {
            (DispatchState::Review, Some(t)) => {
                super::acceptance::wants_acceptance(d, t, &self.prefs().await)
            }
            _ => false,
        };
        if accepting {
            ladder = crate::models::personal_agent_overview::Ladder::Checking;
        }
        // Accepted work that landed: the round records the merge commit and
        // the owner hears it merged (instead of "done").
        let landed = match (d.state, task.as_ref()) {
            (DispatchState::Completed, Some(t)) => self.acceptance_landed(d, t).await,
            _ => false,
        };
        // Handed-out work that settled is a coding event (6.9); a pull
        // request it delivered is watched from now on (7.4).
        if matches!(
            d.state,
            DispatchState::Completed
                | DispatchState::Failed
                | DispatchState::Interrupted
                | DispatchState::Canceled
                | DispatchState::HandedOver
        ) {
            super::watch::signal(
                &self.db,
                "dispatch_ended",
                format!("dispatch:{}:{}:{}", d.id, round, enum_str(&d.state)),
                d.bot_id,
                d.folder_id,
                serde_json::json!({
                    "dispatch_id": d.id,
                    "title": d.title,
                    "mode": d.mode,
                    "state": d.state,
                    "ladder": ladder,
                    "work_task_id": d.work_task_id,
                    "conversation_id": d.conversation_id,
                    "cause": cause,
                }),
            )
            .await;
        }
        // A routine's run comes to what its work came to (6.9).
        self.routine_dispatch_ended(d).await;
        // A plan's step moves with its work (7.6).
        self.plan_dispatch_moved(d.id).await;
        if let (DispatchState::Completed, Some(t), Some(host)) =
            (d.state, task.as_ref(), self.host_ref())
        {
            if ladder == crate::models::personal_agent_overview::Ladder::PrOpen {
                host.watch_task(t, false).await;
            }
        }
        let source_key = format!("dispatch:{}:{}:{}:{}", d.id, round, enum_str(&d.state), cause);
        let mut summary = format!(
            "Dispatch #{} \"{}\" ({}) {}.",
            d.id,
            d.title,
            mode_label(d.mode),
            state_sentence(d.state)
        );
        if let Some(e) = excerpt.as_deref().filter(|e| !e.trim().is_empty()) {
            summary.push_str(&format!(
                " Result excerpt: {}",
                cut(&super::spec_text::cards_as_text(e), 600)
            ));
        }
        if let Some(n) = note.as_deref() {
            summary.push_str(&format!(" ({n})"));
        }
        if accepting {
            summary.push_str(
                " codeg has it checked (read-only) first; you get the check's verdict to \
                 accept it — nothing to do until then.",
            );
        }
        // Who landed it (A5), as the merge that landed this run recorded —
        // not the project's setting now, which may have changed since, or
        // be on while the owner merged by hand. Unknown: nothing said.
        let merged_by = match (ladder, task.as_ref()) {
            (crate::models::personal_agent_overview::Ladder::Merged, Some(t)) => {
                crate::db::service::work_task_service::merge_actor(&self.db.conn, t.id, t.run_seq)
                    .await
                    .ok()
                    .flatten()
            }
            _ => None,
        };
        match merged_by.as_deref() {
            Some("user") => summary.push_str(" The owner merged it."),
            Some("auto") => summary.push_str(" The board merged it on its own (auto-merge)."),
            _ => {}
        }
        // A pull request is not the end of code work: merged is (8.5).
        if ladder == crate::models::personal_agent_overview::Ladder::PrOpen {
            let pr = task.as_ref().map(super::ladder::pr_of).and_then(|(url, _)| url);
            summary.push_str(&format!(
                " It was delivered as a pull request{}, not merged: codeg watches it and tells \
                 you when its checks fail, it conflicts, it can be merged, or it is merged or \
                 closed — its matter stays open until then.",
                pr.map(|u| format!(" ({u})")).unwrap_or_default()
            ));
        }
        // Waking the agent for a state it has to interpret; a dispatch taken
        // over by the owner only rides along with the next delivery.
        let mut wake = !matches!(
            d.state,
            DispatchState::Queued | DispatchState::Running | DispatchState::HandedOver
        ) && !accepting;
        // A round codeg pushed to a watched pull request: its watch says
        // what comes of it (7.4).
        if super::pr_auto::pushed_or_pushing(d)
            && matches!(d.state, DispatchState::Completed | DispatchState::Review)
        {
            wake = false;
            summary.push_str(
                " codeg pushed it to the pull request and watches its checks; nothing to do \
                 unless you hear more.",
            );
        }
        // A question or a plan approval is told by its own card (7.3.1).
        let asking = d.state == DispatchState::WaitingInput && self.waits_on_ask(d).await;
        let quiet = matches!(d.state, DispatchState::Queued | DispatchState::Running) || asking;
        // A restart cut it off: codeg retries it, or asks the owner (7.3).
        let mut retry = serde_json::Value::Null;
        if d.state == DispatchState::Interrupted {
            let plan = self.retry_plan(d).await;
            retry = plan.card();
            if let Some((sentence, wakes)) = plan.sentence() {
                summary.push_str(&sentence);
                wake = wakes;
            }
        }
        // A plan sent back with feedback the answer could not carry: the
        // feedback goes as its next message, nothing to interpret.
        if self.feedback_pending(d.id).await {
            summary.push_str(" codeg sends it the plan feedback as its next message.");
            wake = false;
        }
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
            // Where it stood on the PR ladder when the news came (8.5).
            "ladder": ladder,
            "title": d.title,
            "agent_type": work.agent_type,
            "excerpt": excerpt,
            // What came of it in a plain sentence (A1).
            "gist": excerpt.as_deref().and_then(super::gist::plain_gist),
            "note": note,
            // What brought the news (`boot`, `lost`, `gone`, `turn`…): the
            // page words the notes codeg writes itself in the owner's
            // language, and shows an agent's own error as it came.
            "cause": cause,
            "work_task_id": d.work_task_id,
            // The board run it tells of, for a task's (B1); the round of
            // its work it tells of (B6).
            "run": task.as_ref().map(|t| t.run_seq),
            "round": round,
            // The commit it landed as, for a card of the merge (A5).
            "merge_commit": task
                .as_ref()
                .filter(|_| ladder == crate::models::personal_agent_overview::Ladder::Merged)
                .and_then(|t| t.merge_commit.clone()),
            "conversation_id": d.conversation_id,
            "conversation_folder_id": conversation_folder_id,
            "folder_id": d.folder_id,
            // How codeg goes on from a restart's interruption (7.3).
            "auto_retry": retry,
        }));
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
        let (event_id, card) = match inserted {
            Ok(Some((event, card))) => (event.id, card),
            // A repeated arrival of the same state.
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("[personal_agent] dispatch #{} progress not recorded: {e}", d.id);
                return;
            }
        };
        let card_id = card.id;
        self.emit_rows(vec![svc::to_row(card)]);
        // Done, failed or ready for review: the owner hears of it (1.13) —
        // of work being accepted, once it is (7.5).
        // A round codeg runs on a watched pull request tells no news of its
        // own: the pull request's card does (7.4).
        let pr_round = super::pr_auto::pushed_or_pushing(d);
        let what = match d.state {
            _ if accepting || landed => None,
            DispatchState::Completed | DispatchState::Review if pr_round => None,
            DispatchState::Completed
                if ladder == crate::models::personal_agent_overview::Ladder::PrOpen =>
            {
                Some(super::reach::What::Review {
                    text: super::reach::glimpse(&d.title),
                })
            }
            DispatchState::Completed => Some(super::reach::What::Done {
                text: super::reach::glimpse(&d.title),
            }),
            DispatchState::Review => Some(super::reach::What::Review {
                text: super::reach::glimpse(&d.title),
            }),
            DispatchState::Failed => Some(super::reach::What::Failed {
                text: super::reach::glimpse(&d.title),
            }),
            _ => None,
        };
        if let (Some(what), Some(host)) = (what, self.host_ref()) {
            let bot = self.bot().await;
            let news = super::reach::News {
                key: format!("done:{bot}:{card_id}"),
                bot_id: bot,
                kind: "done",
                what,
                link: Some(super::reach::NotifyLink::Bot {
                    bot_id: bot,
                    row_id: Some(card_id),
                }),
                need: None,
            };
            // Its assistant, woken by it, may pick it up again at once (B6):
            // the owner is told only if it is still news after a while —
            // or once that turn is over, whichever is first.
            if d.state == DispatchState::Failed && wake {
                let fail = super::reach::FailHold {
                    dispatch_id: d.id,
                    task: match (d.work_task_id, task.as_ref()) {
                        (Some(t), Some(task)) => Some((t, task.run_seq)),
                        _ => None,
                    },
                    card_id,
                    event_id,
                };
                let failed_at = d.finished_at.unwrap_or(d.updated_at);
                host.tell_failure(news, fail, failed_at + chrono::Duration::seconds(FAILED_HOLD_SECS))
                    .await;
            } else {
                host.tell(news).await;
            }
        }
        // Work done is progress on the thread it was for (4.9).
        if let (DispatchState::Completed, Some(t)) = (d.state, d.thread_id) {
            self.thread_progress(t).await;
        }
        if let Ok(Some(item)) = svc::item_of_dispatch(&self.db.conn, d.id).await {
            let (status, waits_for) = match d.state {
                // Being checked and accepted: nobody waits on the owner.
                DispatchState::Review if accepting => (ItemStatus::Open, Some(WaitsFor::External)),
                DispatchState::WaitingInput | DispatchState::Review => {
                    (ItemStatus::Waiting, Some(WaitsFor::Owner))
                }
                // Code work is done when merged (8.5): a pull request waits on
                // its merge, which its watch tells (7.4).
                DispatchState::Completed
                    if ladder == crate::models::personal_agent_overview::Ladder::PrOpen =>
                {
                    (ItemStatus::Waiting, Some(WaitsFor::External))
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
            // Given up by the owner stays so; given up because the work was
            // stopped moves with the work's next round, as done does.
            let stopped = item.status == ItemStatus::Dropped
                && item.closed_how.as_deref() == Some("stopped");
            if item.status != ItemStatus::Dropped || stopped {
                // Not when other work took it over meanwhile (B1): its
                // matter was closed with that, and stays so.
                let _ = svc::update_item_unless_taken_over(
                    &self.db.conn,
                    item.id,
                    d.id,
                    ItemWrite {
                        status: Some(status),
                        waits_for: Some(waits_for),
                        closing: Some(svc::Closing::new(svc::Closer::Codeg, "done")),
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
    /// One look at a time, each read after the last one's writes (B6): two
    /// at once would each tell the run they read, the older one last. A look
    /// asked for while another is under way is queued for that one to do
    /// before it lets go — never waited for, as a look's own news can lead
    /// back here — and never lost.
    pub(super) async fn sync_task_dispatch(&self, id: i32) {
        {
            let mut p = self.task_sync_pending.lock().unwrap_or_else(|e| e.into_inner());
            *p.entry(id).or_insert(0) += 1;
        }
        self.drain_task_syncs().await;
    }

    /// Do the looks asked for, one at a time, unless one is under way (it
    /// does them). An id leaves the queue only once a look begun after its
    /// last ask is done: a caller dropped midway (a page that went away)
    /// leaves it for the next — every tick's poll drains what is left — and
    /// one asked again while it ran is done again.
    pub(super) async fn drain_task_syncs(&self) {
        let pending = || self.task_sync_pending.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let Ok(guard) = self.task_sync_lock.try_lock() else {
                // The look under way takes it.
                return;
            };
            // A look whose own news asks for it again is done again — a few
            // times at most: one that keeps asking is left to the next tick.
            let mut done: std::collections::HashMap<i32, u32> = std::collections::HashMap::new();
            loop {
                let next = pending()
                    .iter()
                    .find(|(id, _)| done.get(*id).copied().unwrap_or(0) < 3)
                    .map(|(id, asked)| (*id, *asked));
                let Some((n, asked)) = next else {
                    break;
                };
                Box::pin(self.sync_task_dispatch_now(n)).await;
                *done.entry(n).or_insert(0) += 1;
                let mut p = pending();
                if p.get(&n) == Some(&asked) {
                    p.remove(&n);
                }
            }
            drop(guard);
            // One asked for just as this let go: taken, by this or by it —
            // not one this drain did its few times already.
            if pending()
                .keys()
                .all(|id| done.get(id).copied().unwrap_or(0) >= 3)
            {
                return;
            }
        }
    }

    async fn sync_task_dispatch_now(&self, id: i32) {
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, id).await else {
            return;
        };
        let Some(task_id) = d.work_task_id else {
            return;
        };
        // Canceled by the owner on the board (deleted since, too): their
        // stop, booked as one — not news (D3).
        if self.book_board_cancel(&d).await {
            return;
        }
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
        // Taken over in an earlier run and run again by the owner on the
        // board since (B1): the new run is theirs, its matter open again as
        // it stands — and a run that failed again between two looks (the
        // state the same both times) is news of its own.
        let mut d = d;
        // The run taken over moving on to its end (failed → canceled, say):
        // not this dispatch's news, and not written — the dispatch stays
        // where the board's sync looks, to see the owner run it again.
        if superseded_with(&self.db, &d, Some(&task)).await {
            return;
        }
        if d.replaced_by.is_some() {
            if let Some(released) = self.release_rerun(&d, state).await {
                d = released;
                // Failed again between two looks: the state the same both
                // times, still news of its own.
                if state == d.state {
                    let excerpt = task.result_summary.as_deref().map(excerpt_of);
                    let note = task.last_error.clone();
                    Box::pin(self.record_progress_with(&d, excerpt, note, "task", Some(task))).await;
                    return;
                }
            }
        }
        // Failed in a newer run as well, between two looks — the state the
        // same both times (B6): the new run's failure is news of its own,
        // with its own card.
        if state == d.state && matches!(state, DispatchState::Failed | DispatchState::Interrupted) {
            // The run its news last told of, by its event (whatever its card
            // says, or when it has none).
            let told = svc::latest_event_of_coalesce(&self.db.conn, &format!("dispatch:{}", d.id))
                .await
                .ok()
                .flatten()
                .and_then(|e| round_of_source_key(&e.source_key));
            // A newer run than any told — or none told at all (codeg went
            // down before the first one's news): told now. A look holding
            // an older read than the news already told does nothing.
            if !d.is_check && told.is_none_or(|r| task.run_seq > r) {
                let excerpt = task.result_summary.as_deref().map(excerpt_of);
                let note = task.last_error.clone();
                // The dispatch says the new run's end, as a change of state
                // would have written it.
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
                    Box::pin(self.record_progress_with(&updated, excerpt, note, "task", Some(task))).await;
                }
                return;
            }
        }
        if state == d.state {
            return;
        }
        // Its start failed before the board took the task up (B1): the
        // failure stands — a task still to do that never ran is not work
        // queued again.
        if matches!(d.state, DispatchState::Failed | DispatchState::Interrupted)
            && task.status == WorkTaskStatus::Todo
            && task.started_at.is_none()
        {
            return;
        }
        let excerpt = task.result_summary.as_deref().map(excerpt_of);
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
            Box::pin(self.record_progress_with(&updated, excerpt, note, "task", Some(task))).await;
        }
    }

    /// Work taken over in an earlier run, run again by the owner on the
    /// board since (B1): the new run is theirs. Once — the claim is let go
    /// in one conditional write, so no later look does this again (a matter
    /// closed since stays closed) — its matter opens again as the run stands
    /// (`state`), and it is work like any from here. The dispatch as it is
    /// now, when this look let it go.
    async fn release_rerun(
        &self,
        d: &dispatch_entity::Model,
        state: DispatchState,
    ) -> Option<dispatch_entity::Model> {
        let by = d.replaced_by?;
        let reopen = match state {
            DispatchState::Queued | DispatchState::Running => Some((ItemStatus::Open, WaitsFor::External)),
            DispatchState::WaitingInput | DispatchState::Review => Some((ItemStatus::Waiting, WaitsFor::Owner)),
            DispatchState::Failed | DispatchState::Interrupted => Some((ItemStatus::Open, WaitsFor::Agent)),
            DispatchState::Completed | DispatchState::Canceled | DispatchState::HandedOver => None,
        };
        if !svc::release_claim(&self.db.conn, d.id, by, reopen).await.ok()? {
            return None;
        }
        if let Ok(Some(item)) = svc::item_of_dispatch(&self.db.conn, d.id).await {
            self.emit(PersonalAgentChange::Item { id: item.id });
        }
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        svc::get_dispatch(&self.db.conn, d.id).await.ok().flatten()
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
        // So can a stopped one other work took over (B1): its claim is let
        // go when the owner does. Read on their own, not to crowd the rest.
        let live = {
            use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
            let mut live = live;
            live.extend(
                dispatch_entity::Entity::find()
                    .filter(dispatch_entity::Column::BotId.eq(self.bot().await))
                    .filter(dispatch_entity::Column::Mode.eq(DispatchMode::Task))
                    .filter(dispatch_entity::Column::State.eq(DispatchState::Canceled))
                    .filter(dispatch_entity::Column::ReplacedBy.is_not_null())
                    // Only those still watched for a manual retry (below).
                    .filter(dispatch_entity::Column::UpdatedAt.gt(Utc::now() - chrono::Duration::days(3)))
                    .order_by_desc(dispatch_entity::Column::Id)
                    .limit(200)
                    .all(&self.db.conn)
                    .await
                    .unwrap_or_default(),
            );
            live
        };
        // A failed task stays a candidate for a manual retry from the board
        // only for a while; older ones are left alone instead of being re-read
        // every few seconds forever.
        let recent = Utc::now() - chrono::Duration::days(3);
        // Looks asked for and left undone (their caller went away).
        self.drain_task_syncs().await;
        for d in live {
            let settled = matches!(
                d.state,
                DispatchState::Failed | DispatchState::Interrupted | DispatchState::Canceled
            );
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
                            let registered =
                                self.state.lock().await.dispatch_conns.remove(&conn_id);
                            let round = match registered {
                                Some(c) => RoundOf::Open { op: c.round_op },
                                None => RoundOf::Untracked,
                            };
                            let end = RoundEnd::Gone {
                                canceled: done == "cancelled",
                            };
                            self.settle_conversation_turn(d.id, &conn_id, end, round).await;
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
                    if ripe && !in_flight && !waiting && idle_for > chrono::Duration::seconds(10) {
                        let round = self.close_round_of(&conn_id, None).await;
                        if round != RoundOf::NotIt {
                            self.settle_conversation_turn(
                                d.id,
                                &conn_id,
                                RoundEnd::Missed { abnormal },
                                round,
                            )
                            .await;
                        }
                    }
                }
            }
        }
        self.kick_queue();
    }

    /// Work that took failed work over and is stuck before its board task
    /// ran (B1): the failed work is out of sight since the handing over, so
    /// the new one must not be. Codeg went down between recording it and
    /// starting its task — before the task was made, before it was linked,
    /// or before it was started. A minute after it was recorded (its own
    /// start had its chance), the same task is linked and started, one never
    /// made is started from the beginning, one the owner deleted is not made
    /// again (the work is canceled, as the board's sync does), and a start
    /// that fails fails the work, for the owner to see.
    pub(super) async fn reconcile_handed_over(self: &std::sync::Arc<Self>) {
        use crate::db::entities::work_task as work_task_entity;
        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
        let queued = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            &[DispatchState::Queued],
            Some(DispatchMode::Task),
            50,
        )
        .await
        .unwrap_or_default();
        let ripe = Utc::now() - chrono::Duration::seconds(60);
        for d in queued
            .into_iter()
            .filter(|d| d.replaces_id.is_some() && d.created_at < ripe)
        {
            let task = match d.work_task_id {
                Some(t) => work_task_entity::Entity::find_by_id(t).one(&self.db.conn).await,
                None => {
                    work_task_entity::Entity::find()
                        .filter(work_task_entity::Column::PersonalAgentDispatchId.eq(d.id))
                        .one(&self.db.conn)
                        .await
                }
            };
            let Ok(task) = task else {
                continue;
            };
            match task {
                // Never made: from the beginning.
                None if d.work_task_id.is_none() => {
                    if crate::work_task::engine().is_none() {
                        continue;
                    }
                    if let Err(e) = self.start_task_dispatch(&d).await {
                        self.fail_dispatch(&d, &e).await;
                    }
                }
                None => {}
                // Canceled by the owner and deleted since: their stop, booked
                // as the board's look would (D3).
                Some(t) if t.deleted_at.is_some() && self.book_board_cancel(&d).await => {}
                Some(t) if t.deleted_at.is_some() => {
                    if let Ok(Some(updated)) = svc::update_dispatch(
                        &self.db.conn,
                        d.id,
                        Some(&[DispatchState::Queued]),
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
                }
                Some(t) => {
                    if d.work_task_id.is_none() {
                        let _ = svc::update_dispatch(
                            &self.db.conn,
                            d.id,
                            None,
                            DispatchWrite {
                                work_task_id: Some(t.id),
                                ..Default::default()
                            },
                        )
                        .await;
                    }
                    // Made and never started: the same one, started.
                    if t.status == WorkTaskStatus::Todo && t.started_at.is_none() {
                        let Some(engine) = crate::work_task::engine() else {
                            continue;
                        };
                        if let Err(e) = engine.start(t.id).await {
                            // Someone else started it first (the owner, the
                            // board's own processing): it is under way.
                            let elsewhere = crate::db::service::work_task_service::get_model(&self.db.conn, t.id)
                                .await
                                .is_ok_and(|t| t.status != WorkTaskStatus::Todo);
                            if !elsewhere {
                                self.fail_dispatch(&d, &e).await;
                            }
                        }
                    }
                }
            }
        }
    }

    /// After a restart: what a handing over left to do once its write was
    /// in (B1) — the failed work's card saying who took it over — done for
    /// the work that took over lately, in case codeg went down in between.
    pub(super) async fn boot_handovers(&self) {
        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
        let lately = Utc::now() - chrono::Duration::days(3);
        let made = dispatch_entity::Entity::find()
            .filter(dispatch_entity::Column::BotId.eq(self.bot().await))
            .filter(dispatch_entity::Column::ReplacesId.is_not_null())
            .filter(dispatch_entity::Column::CreatedAt.gt(lately))
            .all(&self.db.conn)
            .await
            .unwrap_or_default();
        for d in made {
            self.settle_handover_at(&d, true).await;
        }
    }

    /// After a restart: conversation work recorded as failed whose failure
    /// no card tells yet — codeg went down between the two writes (B6). Its
    /// news is written now: the failure is in the conversation, once.
    pub(super) async fn boot_failures(&self) {
        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
        // Every one, however old: the guarantee is the conversation's. codeg's
        // own checks tell their news their own way.
        let failed = dispatch_entity::Entity::find()
            .filter(dispatch_entity::Column::BotId.eq(self.bot().await))
            .filter(dispatch_entity::Column::State.eq(DispatchState::Failed))
            .filter(dispatch_entity::Column::Mode.ne(DispatchMode::Task))
            .filter(dispatch_entity::Column::IsCheck.eq(false))
            .filter(dispatch_entity::Column::ReplacedBy.is_null())
            .all(&self.db.conn)
            .await
            .unwrap_or_default();
        for d in failed {
            // Told: its news of this attempt (its round, as the event's key
            // says — written with its card, in one transaction) is in.
            let told = svc::latest_event_of_coalesce(&self.db.conn, &format!("dispatch:{}", d.id))
                .await
                .ok()
                .flatten()
                .and_then(|e| round_of_source_key(&e.source_key))
                .is_some_and(|r| r == d.turns);
            if !told {
                let excerpt = d.result_excerpt.clone();
                let error = d.error.clone();
                self.record_progress(&d, excerpt, error, "boot").await;
            }
        }
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
        // Its questions are the owner's now (7.3.1).
        self.after_handover(&updated, d.connection_id.as_deref()).await;
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
        if superseded(&self.db, &d).await {
            return Err(format!(
                "dispatch #{id} was taken over by #{}: follow that one up instead",
                d.replaced_by.unwrap_or_default()
            ));
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
        // The assistant's or the owner's own follow-up: the work is theirs
        // again, not a round codeg delivers to a pull request by itself —
        // once the follow-up is taken (refused, the round stays codeg's).
        let forget = !matches!(auth, FollowupAuth::Op { .. }) && d.pr_fix.is_some();
        let (slot, notice_id) = match auth {
            FollowupAuth::Ledgered { batch_id, scope } => {
                let key = ledger::followup_key(id, intent.as_deref());
                match self
                    .earlier_followup(&scope, &key, batch_id, id, payload.clone(), target.clone())
                    .await?
                {
                    Earlier::Settled(text) => return Ok(text),
                    Earlier::Rearmed(op) => {
                        let sent = self.run_followup(&d, call, *op).await;
                        if forget && sent.is_ok() {
                            super::pr_auto::forget_round(&self.db, &d).await;
                        }
                        return sent;
                    }
                    Earlier::None => {}
                }
                (LedgerSlot::in_batch(batch_id, key, ledger::fresh_op_id()), None)
            }
            FollowupAuth::Card { notice_id, op_id } => (LedgerSlot::outside(op_id), Some(notice_id)),
            FollowupAuth::Direct => (LedgerSlot::outside(ledger::fresh_op_id()), None),
            FollowupAuth::Op { op_id } => (LedgerSlot::outside(op_id), None),
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
        let sent = self.run_followup(&d, call, op).await;
        if forget && sent.is_ok() {
            super::pr_auto::forget_round(&self.db, &d).await;
        }
        sent
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
        // Taken over meanwhile (B1): its record is in, so a handing over
        // from now on sees it and waits; one already in is seen here.
        if let Ok(Some(now)) = svc::get_dispatch(&self.db.conn, d.id).await {
            if superseded(&self.db, &now).await {
                let why = format!(
                    "dispatch #{} was taken over by #{}: follow that one up instead",
                    d.id,
                    now.replaced_by.unwrap_or_default()
                );
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
                return Err(why);
            }
        }
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
    async fn record_followup(
        &self,
        d: &dispatch_entity::Model,
        message: &str,
        op_id: &str,
    ) -> Option<i32> {
        let batch = self.current_batch().await;
        // Where its pill goes among what its turn wrote: the turn of the
        // call's own entry only (one let through from a card has none).
        let own_batch = svc::get_op(&self.db.conn, op_id)
            .await
            .ok()
            .flatten()
            .map(|op| op.batch_id)
            .filter(|b| *b > 0);
        let turn = match own_batch {
            Some(b) => self.turn_mark(b).await,
            None => None,
        };
        self.push_reply_now().await;
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
        let work = work_of(d);
        let mut card = NewRow::new(TimelineKind::Dispatch, d.title.clone());
        card.dispatch_id = Some(d.id);
        card.segment_id = self.state.lock().await.connection_segment;
        card.batch_id = batch;
        card.data = Some(serde_json::json!({
            "followup": true,
            "turn": turn,
            "excerpt": cut(message, 200),
            "mode": d.mode,
            "agent_type": work.agent_type,
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
                let card = self.record_followup(d, &message, op_id).await;
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
                let card = self.record_followup(d, &message, op_id).await;
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
            self.record_followup(d, &message, op_id).await;
            self.reopen_item(d.id, op_id).await;
            self.emit(PersonalAgentChange::Dispatch { id: d.id });
            self.emit(PersonalAgentChange::Status);
            return Ok(format!(
                "All {limit} session slots are busy: the follow-up to dispatch #{} waits for one \
                 and starts by itself; its result comes back as an event.",
                d.id
            ));
        }
        let card = self.record_followup(d, &message, op_id).await;
        let sent = self.send_followup(d, message.clone(), FOLLOWUP_FROM, op_id).await;
        // Its session still winding the round before down — stopped a moment
        // ago, the executor not done yet: it waits its turn in the queue, as
        // for a slot — the same entry, sent once that round is over.
        if sent.as_ref().err().map(String::as_str) == Some(FOLLOWUP_BUSY)
            && super::stop::stopped_by_of(d).is_some()
        {
            self.write_send_target(op_id, d, DispatchState::Queued, true).await?;
            let queued = svc::update_dispatch(
                &self.db.conn,
                d.id,
                Some(FOLLOWUP_FROM),
                DispatchWrite {
                    state: Some(DispatchState::Queued),
                    result_excerpt: Some(None),
                    error: Some(None),
                    followup: Some(Some(message)),
                    round_op_id: Some(Some(op_id.to_string())),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            if queued.is_some() {
                self.reopen_item(d.id, op_id).await;
                self.emit(PersonalAgentChange::Dispatch { id: d.id });
                self.emit(PersonalAgentChange::Status);
                return Ok(format!(
                    "Queued: the follow-up to dispatch #{} goes out once its session is done with                      the round before; its result comes back as an event.",
                    d.id
                ));
            }
        }
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
        let work = work_of(d);
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
                        return Err(FOLLOWUP_BUSY.into());
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
                    work.agent_type,
                    Some(&session_id),
                    &self.data_dir,
                )
                .await
                .map_err(|e| e.to_string())?;
                self.manager
                    .spawn_agent(
                        work.agent_type,
                        Some(folder.path.clone()),
                        Some(session_id),
                        env,
                        DISPATCH_OWNER_LABEL.to_string(),
                        self.emitter.clone(),
                        work.agent_options.mode_id.clone(),
                        work.agent_options.config_values.clone(),
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
        self.reopen_item(d.id, op_id).await;
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        Ok(format!(
            "Sent the follow-up to dispatch #{}; its result comes back as an event.",
            d.id
        ))
    }

    /// The dispatch's entry is open again, waiting on its executor — unless
    /// other work took the dispatch over meanwhile (B1).
    /// The matter of dispatch `dispatch_id` open again for follow-up `op_id`
    /// — only while the dispatch still runs that follow-up: one stopped
    /// meanwhile (the follow-up taken back with it) stays given up.
    async fn reopen_item(&self, dispatch_id: i32, op_id: &str) {
        let still = svc::get_dispatch(&self.db.conn, dispatch_id)
            .await
            .ok()
            .flatten()
            .is_some_and(|d| LIVE_STATES.contains(&d.state) && d.round_op_id.as_deref() == Some(op_id));
        if !still {
            return;
        }
        if let Ok(Some(item)) = svc::item_of_dispatch(&self.db.conn, dispatch_id).await {
            let _ = svc::update_item_unless_taken_over(
                &self.db.conn,
                item.id,
                dispatch_id,
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
    fn the_round_is_read_off_a_dispatch_event_s_key() {
        assert_eq!(round_of_source_key("dispatch:7:2:failed:task"), Some(2));
        assert_eq!(round_of_source_key("bot3:dispatch:7:5:failed:task"), Some(5));
        assert_eq!(round_of_source_key("rule:7"), None);
    }

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
        assert_eq!(
            RoundEnd::Told("Quota exhausted.".into()).outcome(),
            (DispatchState::Failed, Some("Quota exhausted.".into()))
        );
    }

    /// A round that told a failure as its reply failed however its end was
    /// seen to be a normal one — its completion, the backstop, the
    /// connection gone; a cancel or another stop keeps its own reading.
    #[test]
    fn a_told_failure_fails_every_normal_end() {
        let told = |end: RoundEnd| end.told(Some("Quota exhausted.".into())).outcome();
        let failed = (DispatchState::Failed, Some("Quota exhausted.".to_string()));
        assert_eq!(told(RoundEnd::Stop("end_turn".into())), failed);
        assert_eq!(told(RoundEnd::Missed { abnormal: false }), failed);
        assert_eq!(told(RoundEnd::Missed { abnormal: true }), failed);
        assert_eq!(told(RoundEnd::Gone { canceled: false }), failed);
        assert_eq!(told(RoundEnd::Gone { canceled: true }).0, DispatchState::Canceled);
        assert_eq!(told(RoundEnd::Stop("cancelled".into())).0, DispatchState::Canceled);
        assert!(told(RoundEnd::Stop("refusal".into())).1.unwrap().contains("refusal"));
        assert_eq!(
            RoundEnd::Stop("end_turn".into()).told(None).outcome(),
            (DispatchState::Completed, None)
        );
    }
}
