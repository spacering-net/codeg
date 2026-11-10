//! An executor's questions and plan approvals, answered by the assistant that
//! dispatched the work (7.3.1, 4.11).
//!
//! - **One wait per underlying request.** A question (`question_id`), an
//!   extension plan approval (`approval_id`, Grok and Cursor) and the two
//!   plan approvals that arrive as permission requests (`request_id`:
//!   Claude Code's `ExitPlanMode`, a Codex plan review) on a dispatched
//!   session's or task's connection each get one ask card, keyed by the
//!   connection and the request id — however often the dispatch flips
//!   between waiting and running. Every other permission request stays the
//!   owner's, as the executor config says.
//! - **The assistant answers, or forwards.** The card's event wakes the
//!   dispatching assistant with the request as a `<codeg-ask>` block; it
//!   answers with `dispatch_answer` or forwards it. The owner's settings,
//!   a request for a secret, and an assistant with no brain send it straight
//!   to the owner; so do a turn that ends without an answer and ten minutes
//!   without one.
//! - **One settle point; the first answer wins.** Every answer — the
//!   assistant's, the owner's on the page, the owner's in the session — goes
//!   through the connection manager's `answer_*_from`, which takes the
//!   request out and records whose answer took effect in one step. The card
//!   is written from that record only: a late answer shows the winner's, and
//!   never lands on another request. A plan approval that is a permission
//!   request settles when its `PermissionResolved` names the option and the
//!   answerer; until then the card reads "submitting".
//! - **Mirrors.** An ask forwarded to the owner shows in the conversation
//!   the work came from too, when that is another assistant's (4.11): a row
//!   there that follows the card.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::dispatch::{cut, executor_of, mode_label, FollowupAuth};
use super::engine::{brain_of, PersonalAgentEngine};
use crate::acp::plan_approval::{PlanApprovalAnswer, PlanApprovalDecision};
use crate::acp::question::{QuestionAnswer, QuestionAnswerItem, QuestionSpec};
use crate::acp::types::{
    AcpEvent, AnswerOrigin, AnswerOutcome, AnswerResolution, AskDelegate, EventEnvelope,
    PermissionAnswerOrigin, PermissionOptionInfo, PlanPermission,
};
use crate::db::entities::personal_agent_dispatch::{self as dispatch_entity, DispatchMode, DispatchState};
use crate::db::entities::personal_agent_notice::{NoticeKind, NoticeLevel, NoticeState};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewEvent, NewNotice, NewRow};
use crate::models::personal_agent::PersonalAgentChange;
use crate::models::personal_agent_prefs::ExecAnswers;
use crate::models::AgentType;

/// How long an ask waits on the assistant before it is the owner's.
pub const ASK_TIMEOUT: chrono::Duration = chrono::Duration::minutes(10);
/// How much of a plan a `<codeg-ask>` carries.
const PLAN_CHARS: usize = 8_000;
/// How much of the executor's last words and of the dispatch's request.
const WORDS_CHARS: usize = 1_200;

/// The card of one wait, as its notice and its timeline row keep it (the
/// row is what the page draws; the notice's payload is the same object).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AskCard {
    /// Always `ask`: what the page draws it as.
    pub notice: String,
    /// The card's notice id: the one id of this wait, everywhere.
    pub ask_id: i32,
    /// The assistant answering for the owner.
    pub bot_id: i32,
    pub dispatch_id: i32,
    pub title: String,
    pub executor: String,
    pub executor_id: i32,
    pub agent_type: Option<AgentType>,
    pub mode: Option<DispatchMode>,
    pub folder_id: Option<i32>,
    pub conversation_id: Option<i32>,
    pub conversation_folder_id: Option<i32>,
    pub work_task_id: Option<i32>,
    /// The executor's connection the request is on.
    pub conn: String,
    /// `question`, `plan` (an extension request) or `plan_permission`.
    pub request: String,
    pub request_id: String,
    pub questions: Vec<QuestionSpec>,
    pub plan: Option<String>,
    /// What a plan answer can be: `approve`, `revise`, `abandon`.
    pub plan_actions: Vec<String>,
    /// A plan permission's options, as offered.
    pub options: Vec<PermissionOptionInfo>,
    pub flavor: Option<PlanPermission>,
    /// The executor config's own permission mode: what Claude Code goes on
    /// in once its plan is approved.
    pub exec_mode: Option<String>,
    /// `asking` (the assistant answers), `forwarded` (the owner does),
    /// `submitting` (a plan permission's answer is on its way), `answered`,
    /// `withdrawn`.
    pub state: String,
    /// Why the owner answers it: `assistant` (it forwarded it), `settings`,
    /// `secret`, `no_brain`, `turn_ended`, `turn_failed`, `timeout`.
    pub forward_reason: Option<String>,
    /// The answer the assistant leans to, when it forwarded it.
    pub suggestion: Option<String>,
    /// The assistant's reason, for its answer or for forwarding.
    pub reason: Option<String>,
    /// Who answered: `{kind: assistant, bot_id, name}`, `{kind: owner,
    /// where: session|page}`, `{kind: channel}`, `{kind: policy}`.
    pub answered_by: Option<Value>,
    /// What took effect: a `QuestionOutcome`, a `PlanApprovalAnswer`, or a
    /// plan permission's `{option_id, name, kind}`.
    pub answer: Option<Value>,
    /// The answer in a line, for the brain.
    pub answer_text: Option<String>,
    pub answered_at: Option<DateTime<Utc>>,
    /// A plan permission's answer on its way: `{option_id, by}`.
    pub submitted: Option<Value>,
    /// What the executor is told after a plan is sent back, when the answer
    /// cannot carry it (Grok, Claude Code, Codex); sent as the next message
    /// once its round ends.
    pub feedback: Option<String>,
    pub feedback_sent: bool,
    pub asked_at: Option<DateTime<Utc>>,
    pub forwarded_at: Option<DateTime<Utc>>,
    /// On a mirror: `{bot_id, row_id, ask_id}` of the card it follows.
    pub mirror_of: Option<Value>,
    /// On a card: its mirrors, `{bot_id, row_id}`.
    pub mirrors: Vec<Value>,
}

impl AskCard {
    pub fn is_open(&self) -> bool {
        matches!(self.state.as_str(), "asking" | "forwarded" | "submitting")
    }

    /// The kind the windows notify by.
    fn notify_kind(&self) -> &'static str {
        match self.request.as_str() {
            "question" => "question",
            "plan" => "plan",
            _ => "permission",
        }
    }

    fn read(raw: &str) -> Option<Self> {
        serde_json::from_str(raw).ok()
    }
}

/// One wait an executor raised.
#[derive(Debug, Clone)]
pub enum AskRequest {
    Question {
        id: String,
        questions: Vec<QuestionSpec>,
    },
    Plan {
        id: String,
        plan: String,
    },
    PlanPermission {
        id: String,
        plan: String,
        options: Vec<PermissionOptionInfo>,
        flavor: PlanPermission,
    },
}

impl AskRequest {
    fn id(&self) -> &str {
        match self {
            Self::Question { id, .. } | Self::Plan { id, .. } | Self::PlanPermission { id, .. } => id,
        }
    }

    /// The request a permission request is, when it is a plan approval.
    pub fn of_permission(
        request_id: &str,
        tool_call: &Value,
        options: &[PermissionOptionInfo],
    ) -> Option<Self> {
        let flavor = PlanPermission::of(tool_call, options)?;
        let input = tool_call
            .get("rawInput")
            .or_else(|| tool_call.get("raw_input"));
        let plan = input
            .and_then(|i| i.get("plan"))
            .and_then(|p| p.as_str())
            .unwrap_or_default()
            .to_string();
        Some(Self::PlanPermission {
            id: request_id.to_string(),
            plan,
            options: options.to_vec(),
            flavor,
        })
    }
}

/// An answer to an ask, as the assistant or the owner gives it.
#[derive(Debug, Clone)]
pub enum AskAnswer {
    Question(QuestionAnswer),
    Plan {
        decision: PlanApprovalDecision,
        feedback: Option<String>,
    },
}

/// Who is answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answerer {
    /// The assistant that dispatched the work (`dispatch_answer`).
    Assistant,
    /// The owner, on the assistant's page.
    OwnerPage,
}

/// What an answer came to, from the settle point.
#[derive(Debug, Clone)]
pub struct AskReply {
    /// `answered`, `already_answered`, `withdrawn`, `submitted`, `forwarded`.
    pub state: &'static str,
    pub text: String,
    pub card: AskCard,
}

/// Who an origin is, as a card says it.
fn answered_by(origin: Option<&AnswerOrigin>, names: &dyn Fn(i32) -> String) -> Value {
    match origin {
        Some(AnswerOrigin::User) => json!({ "kind": "owner", "where": "session" }),
        Some(AnswerOrigin::AssistantPage) => json!({ "kind": "owner", "where": "page" }),
        Some(AnswerOrigin::Assistant { bot_id }) => {
            json!({ "kind": "assistant", "bot_id": bot_id, "name": names(*bot_id) })
        }
        Some(AnswerOrigin::ChatChannel) => json!({ "kind": "channel" }),
        Some(AnswerOrigin::CliPolicy) => json!({ "kind": "policy" }),
        None => Value::Null,
    }
}

fn answered_by_permission(origin: Option<&PermissionAnswerOrigin>, names: &dyn Fn(i32) -> String) -> Value {
    match origin {
        Some(PermissionAnswerOrigin::User) => json!({ "kind": "owner" }),
        Some(PermissionAnswerOrigin::AssistantPage) => json!({ "kind": "owner", "where": "page" }),
        Some(PermissionAnswerOrigin::ChatChannel) => json!({ "kind": "channel" }),
        Some(PermissionAnswerOrigin::CliPolicy { .. }) => json!({ "kind": "policy" }),
        Some(PermissionAnswerOrigin::Assistant { bot_id }) => {
            json!({ "kind": "assistant", "bot_id": bot_id, "name": names(*bot_id) })
        }
        None => Value::Null,
    }
}

/// Who answered, in words for the brain.
fn by_words(by: &Value) -> String {
    match by.get("kind").and_then(|k| k.as_str()) {
        Some("assistant") => match by.get("name").and_then(|n| n.as_str()) {
            Some(n) => format!("{n} (an assistant)"),
            None => "an assistant".into(),
        },
        Some("owner") => match by.get("where").and_then(|w| w.as_str()) {
            Some("page") => "the owner, on the assistants page".into(),
            Some("session") => "the owner, in the session".into(),
            _ => "the owner".into(),
        },
        Some("channel") => "the owner, from a chat channel".into(),
        Some("policy") => "a codeg-cli run's policy".into(),
        _ => "someone".into(),
    }
}

/// An answer that took effect, in a line.
fn answer_words(card: &AskCard, answer: &Value) -> String {
    match card.request.as_str() {
        "question" => {
            if answer.get("declined").and_then(|d| d.as_bool()) == Some(true) {
                return "skipped (no answer given)".into();
            }
            let items: Vec<String> = answer
                .get("answers")
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .map(|i| {
                            let q = i
                                .get("header")
                                .and_then(|h| h.as_str())
                                .filter(|h| !h.is_empty())
                                .or_else(|| i.get("question").and_then(|q| q.as_str()))
                                .unwrap_or("");
                            let picked: Vec<&str> = i
                                .get("selected")
                                .and_then(|s| s.as_array())
                                .map(|s| s.iter().filter_map(|v| v.as_str()).collect())
                                .unwrap_or_default();
                            format!("{}: {}", cut(q, 80), picked.join(", "))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if items.is_empty() {
                "an empty answer".into()
            } else {
                items.join("; ")
            }
        }
        "plan" => {
            let decision = answer.get("decision").and_then(|d| d.as_str()).unwrap_or("");
            let feedback = answer
                .get("feedback")
                .and_then(|f| f.as_str())
                .map(str::trim)
                .filter(|f| !f.is_empty());
            let word = match decision {
                "approve" => "approved the plan",
                "request_changes" => "asked for changes to the plan",
                "abandon" => "abandoned the plan",
                other => other,
            };
            match feedback {
                Some(f) => format!("{word}: {}", cut(f, 300)),
                None => word.to_string(),
            }
        }
        _ => {
            let name = answer.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let allow = answer
                .get("kind")
                .and_then(|k| k.as_str())
                .is_some_and(|k| k.starts_with("allow"));
            if allow {
                format!("approved the plan (\"{name}\")")
            } else {
                format!("sent the plan back (\"{name}\")")
            }
        }
    }
}

/// The option of a plan permission that answers `decision` (7.3.1):
/// approving goes on in the executor config's own mode — the default one
/// when it was set to plan — never in one that clears the context; sending
/// back keeps planning.
fn plan_option(card: &AskCard, decision: PlanApprovalDecision) -> Option<String> {
    let offered = |id: &str| card.options.iter().any(|o| o.option_id == id);
    let first = |allow: bool| {
        card.options
            .iter()
            .find(|o| {
                o.kind.starts_with(if allow { "allow" } else { "reject" })
                    && !o.option_id.contains("clear")
            })
            .map(|o| o.option_id.clone())
    };
    let approve = decision == PlanApprovalDecision::Approve;
    match card.flavor {
        Some(PlanPermission::ClaudeExitPlan) if approve => {
            let wanted = match card.exec_mode.as_deref() {
                Some("acceptEdits") => "exit-plan-accept-edits",
                Some("auto") => "exit-plan-auto",
                Some("bypassPermissions") => "exit-plan-bypass",
                _ => "exit-plan-default",
            };
            if offered(wanted) {
                Some(wanted.into())
            } else if offered("exit-plan-default") {
                Some("exit-plan-default".into())
            } else {
                first(true)
            }
        }
        Some(PlanPermission::ClaudeExitPlan) => {
            if offered("reject") {
                Some("reject".into())
            } else {
                first(false)
            }
        }
        Some(PlanPermission::CodexPlanReview) if approve => {
            if offered("implement_plan") {
                Some("implement_plan".into())
            } else {
                first(true)
            }
        }
        Some(PlanPermission::CodexPlanReview) => {
            if offered("revise_plan") {
                Some("revise_plan".into())
            } else {
                first(false)
            }
        }
        None => first(approve),
    }
}

/// Every plan answer takes all three: Grok and Cursor offer them, and on
/// Claude Code and Codex an abandon is a revise saying so.
fn plan_actions() -> Vec<String> {
    vec!["approve".into(), "revise".into(), "abandon".into()]
}

/// The note sent back with an abandoned plan the answer cannot carry.
const ABANDON_NOTE: &str = "Abandon this plan; do not implement it.";

impl PersonalAgentEngine {
    // ── where the waits come from ───────────────────────────────────────────

    /// An event on a connection of dispatch `d` (a session's, or its task's):
    /// a wait raised, or settled.
    pub(super) async fn on_ask_event(self: &Arc<Self>, d: &dispatch_entity::Model, env: &EventEnvelope) {
        let conn = env.connection_id.as_str();
        match &env.payload {
            AcpEvent::QuestionRequest {
                question_id,
                questions,
            } => {
                self.open_ask(
                    d,
                    conn,
                    AskRequest::Question {
                        id: question_id.clone(),
                        questions: questions.clone(),
                    },
                )
                .await;
            }
            AcpEvent::PlanApprovalRequest {
                approval_id,
                plan_markdown,
                ..
            } => {
                self.open_ask(
                    d,
                    conn,
                    AskRequest::Plan {
                        id: approval_id.clone(),
                        plan: plan_markdown.clone(),
                    },
                )
                .await;
            }
            AcpEvent::PermissionRequest {
                request_id,
                tool_call,
                options,
                ..
            } => {
                if let Some(req) = AskRequest::of_permission(request_id, tool_call, options) {
                    self.open_ask(d, conn, req).await;
                }
            }
            AcpEvent::QuestionResolved {
                question_id,
                resolution,
            } => {
                let r = resolution
                    .clone()
                    .or_else(|| self.manager.resolution_of(question_id));
                self.settle_ask(conn, question_id, r).await;
            }
            AcpEvent::PlanApprovalResolved {
                approval_id,
                resolution,
            } => {
                let r = resolution
                    .clone()
                    .or_else(|| self.manager.resolution_of(approval_id));
                self.settle_ask(conn, approval_id, r).await;
            }
            AcpEvent::PermissionResolved {
                request_id,
                option_id,
                origin,
            } => {
                self.settle_permission_ask(conn, request_id, option_id.as_deref(), origin.as_ref())
                    .await;
            }
            _ => {}
        }
    }

    /// The waits a connection of dispatch `d` holds now that no card was
    /// raised for — events lost on the bus, a start while one was up — and
    /// the open cards whose request is gone.
    pub(super) async fn scan_asks_on(self: &Arc<Self>, d: &dispatch_entity::Model, conn: &str) {
        let Some(state) = self.manager.get_state(conn).await else {
            return;
        };
        let (question, plan, permission) = {
            let s = state.read().await;
            (
                s.pending_question.clone(),
                s.pending_plan_approval.clone(),
                s.pending_permission.clone(),
            )
        };
        if let Some(q) = question {
            self.open_ask(
                d,
                conn,
                AskRequest::Question {
                    id: q.question_id,
                    questions: q.questions,
                },
            )
            .await;
        }
        if let Some(p) = plan {
            self.open_ask(
                d,
                conn,
                AskRequest::Plan {
                    id: p.approval_id,
                    plan: p.plan_markdown,
                },
            )
            .await;
        }
        if let Some(p) = permission {
            if let Some(req) = AskRequest::of_permission(&p.request_id, &p.tool_call, &p.options) {
                self.open_ask(d, conn, req).await;
            }
        }
    }

    /// Every open card of this assistant whose request is no longer up:
    /// settled from the manager's record when it has one, withdrawn when
    /// the connection is gone. A card of a connection still up and a request
    /// still pending is left alone.
    pub(super) async fn sweep_asks(&self) {
        let bot = self.bot().await;
        for n in svc::open_asks(&self.db.conn, Some(bot)).await.unwrap_or_default() {
            let Some(card) = AskCard::read(&n.payload) else {
                continue;
            };
            let pending = match self.manager.get_state(&card.conn).await {
                Some(state) => {
                    let s = state.read().await;
                    match card.request.as_str() {
                        "question" => s
                            .pending_question
                            .as_ref()
                            .is_some_and(|q| q.question_id == card.request_id),
                        "plan" => s
                            .pending_plan_approval
                            .as_ref()
                            .is_some_and(|p| p.approval_id == card.request_id),
                        _ => {
                            s.pending_permission
                                .as_ref()
                                .is_some_and(|p| p.request_id == card.request_id)
                                || card.state == "submitting"
                        }
                    }
                }
                None => false,
            };
            if pending {
                continue;
            }
            let resolution = self
                .manager
                .resolution_of(&card.request_id)
                .unwrap_or_else(AnswerResolution::withdrawn);
            if card.request == "plan_permission" {
                self.settle_permission_ask(&card.conn, &card.request_id, None, None)
                    .await;
            } else {
                self.settle_ask(&card.conn, &card.request_id, Some(resolution))
                    .await;
            }
        }
    }

    /// Tell the windows of a dispatched connection what this assistant
    /// answers for the owner there (7.3.1): they hold back their
    /// notification of those until one is forwarded.
    pub(super) async fn delegate_asks(&self, conn: &str) {
        // Serialized with raising a card (`open_ask`), which reads the
        // delegate to tell whether the windows held its request back: a
        // request is then either found here or told there — never neither.
        let one = self.asks_lock.lock().await;
        let delegate = self.ask_delegate().await;
        let before = match self.manager.get_state(conn).await {
            Some(state) => state.read().await.ask_delegate,
            None => None,
        };
        self.manager.set_ask_delegate(conn, delegate).await;
        // What the windows held back and no longer would: the owner's now,
        // and told so — whether or not its card was raised yet.
        let questions_freed = before.is_some_and(|b| b.questions) && !delegate.is_some_and(|d| d.questions);
        let plans_freed = before.is_some_and(|b| b.plans) && !delegate.is_some_and(|d| d.plans);
        if !questions_freed && !plans_freed {
            return;
        }
        let Some(state) = self.manager.get_state(conn).await else {
            return;
        };
        let (question, plan, permission) = {
            let s = state.read().await;
            (
                s.pending_question
                    .as_ref()
                    .filter(|q| !q.questions.iter().any(|x| x.is_secret))
                    .map(|q| q.question_id.clone()),
                s.pending_plan_approval.as_ref().map(|p| p.approval_id.clone()),
                s.pending_permission
                    .as_ref()
                    .filter(|p| PlanPermission::of(&p.tool_call, &p.options).is_some())
                    .map(|p| p.request_id.clone()),
            )
        };
        let mut freed: Vec<(String, &'static str)> = Vec::new();
        if questions_freed {
            freed.extend(question.map(|id| (id, "question")));
        }
        if plans_freed {
            freed.extend(plan.map(|id| (id, "plan")));
            freed.extend(permission.map(|id| (id, "permission")));
        }
        let mut answering = Vec::new();
        for (request_id, kind) in freed {
            let subject = format!("ask:{conn}:{request_id}");
            match svc::ask_by_subject(&self.db.conn, &subject).await.ok().flatten() {
                // The assistant was answering it: the owner's now.
                Some(n) if AskCard::read(&n.payload).is_some_and(|c| c.state == "asking") => {
                    answering.push(n.id);
                }
                // Raised already, as the owner's: its raising read the old
                // delegate under this lock and told them. Or settled.
                Some(_) => {}
                // Its card is still to come, and will read the new delegate:
                // tell them now.
                None => self.manager.ask_forwarded(conn, &request_id, kind).await,
            }
        }
        drop(one);
        for ask_id in answering {
            self.forward_ask(ask_id, "settings", None, None).await;
        }
    }

    /// The owner's settings changed: every connection of this assistant's
    /// running work is told anew what it answers there.
    pub(super) async fn refresh_ask_delegates(&self) {
        let live = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            &[DispatchState::Queued, DispatchState::Running, DispatchState::WaitingInput, DispatchState::Review],
            None,
            200,
        )
        .await
        .unwrap_or_default();
        for d in live {
            if let Some(conn) = self.connection_of(&d).await {
                self.delegate_asks(&conn).await;
            }
        }
    }

    /// The connection dispatch `d` runs on now: its session's, or its
    /// task's.
    async fn connection_of(&self, d: &dispatch_entity::Model) -> Option<String> {
        match d.mode {
            DispatchMode::Task => crate::db::service::work_task_service::get_model(&self.db.conn, d.work_task_id?)
                .await
                .ok()
                .and_then(|t| t.connection_id),
            _ => d.connection_id.clone(),
        }
    }

    /// The owner took dispatch `d` over: nothing on its connection is the
    /// assistant's to answer any more — the windows notify as usual, and
    /// what it was answering is the owner's.
    pub(super) async fn after_handover(&self, d: &dispatch_entity::Model, conn: Option<&str>) {
        if let Some(c) = conn {
            self.manager.set_ask_delegate(c, None).await;
        }
        for n in svc::open_asks(&self.db.conn, Some(self.bot().await)).await.unwrap_or_default() {
            if AskCard::read(&n.payload).is_some_and(|c| c.dispatch_id == d.id && c.state == "asking") {
                self.forward_ask(n.id, "handed_over", None, None).await;
            }
        }
    }

    /// Whether the windows of `card`'s connection held back their
    /// notification of it, by the delegate they hold now.
    async fn window_held_back(&self, card: &AskCard) -> bool {
        let Some(state) = self.manager.get_state(&card.conn).await else {
            return false;
        };
        let Some(delegate) = state.read().await.ask_delegate else {
            return false;
        };
        match card.request.as_str() {
            "question" => delegate.questions && !card.questions.iter().any(|q| q.is_secret),
            _ => delegate.plans,
        }
    }

    async fn ask_delegate(&self) -> Option<AskDelegate> {
        let brain = self.agent_row().await.and_then(|r| brain_of(&r)).is_some();
        if !brain {
            return None;
        }
        let prefs = self.prefs().await;
        let questions = prefs.exec_questions == ExecAnswers::Assistant;
        let plans = prefs.exec_plans == ExecAnswers::Assistant;
        (questions || plans).then_some(AskDelegate {
            bot_id: self.bot().await,
            questions,
            plans,
        })
    }

    /// The waits of this assistant's running work no card was raised for:
    /// read off each connection's state (events the bus dropped).
    pub(super) async fn scan_live_asks(self: &Arc<Self>) {
        let live = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            &[DispatchState::Running, DispatchState::WaitingInput],
            None,
            200,
        )
        .await
        .unwrap_or_default();
        for d in live {
            let conn = match d.mode {
                DispatchMode::Task => match d.work_task_id {
                    Some(tid) => crate::db::service::work_task_service::get_model(&self.db.conn, tid)
                        .await
                        .ok()
                        .and_then(|t| t.connection_id),
                    None => None,
                },
                _ => d.connection_id.clone(),
            };
            if let Some(conn) = conn {
                self.scan_asks_on(&d, &conn).await;
            }
        }
    }

    /// The periodic part (7.3.1, 7.3): the asks left unanswered too long, the
    /// feedback of plans sent back, the waits missed, the dispatches a
    /// restart interrupted.
    pub(super) async fn ask_tick(self: &Arc<Self>) {
        self.scan_live_asks().await;
        self.sweep_asks().await;
        self.forward_stale_asks().await;
        self.send_plan_feedback().await;
        self.retry_interrupted().await;
    }

    // ── the card ────────────────────────────────────────────────────────────

    /// Raise the card of one wait, once: the assistant is woken to answer
    /// it, or — by the owner's settings, a secret, no brain — it goes to the
    /// owner straight away.
    pub(super) async fn open_ask(self: &Arc<Self>, d: &dispatch_entity::Model, conn: &str, req: AskRequest) {
        let bot = self.bot().await;
        if d.bot_id != Some(bot) {
            return;
        }
        // Taken over: the owner's own now (v2.2).
        if d.state == DispatchState::HandedOver {
            return;
        }
        let subject = format!("ask:{conn}:{}", req.id());
        let _one = self.asks_lock.lock().await;
        if let Ok(Some(_)) = svc::ask_by_subject(&self.db.conn, &subject).await {
            return;
        }
        let prefs = self.prefs().await;
        let executor = executor_of(d);
        let mut card = AskCard {
            notice: "ask".into(),
            bot_id: bot,
            dispatch_id: d.id,
            title: d.title.clone(),
            executor: executor.name.clone(),
            executor_id: executor.assistant_id,
            agent_type: Some(executor.agent_type),
            mode: Some(d.mode),
            folder_id: d.folder_id,
            conversation_id: d.conversation_id,
            work_task_id: d.work_task_id,
            conn: conn.to_string(),
            request_id: req.id().to_string(),
            exec_mode: executor
                .agent_options
                .mode_id
                .clone()
                .or_else(|| executor.agent_options.config_values.get("mode").cloned()),
            asked_at: Some(Utc::now()),
            ..Default::default()
        };
        let setting = match &req {
            AskRequest::Question { questions, .. } => {
                card.request = "question".into();
                card.questions = questions.clone();
                prefs.exec_questions
            }
            AskRequest::Plan { plan, .. } => {
                card.request = "plan".into();
                card.plan = Some(plan.clone());
                card.plan_actions = plan_actions();
                prefs.exec_plans
            }
            AskRequest::PlanPermission {
                plan,
                options,
                flavor,
                ..
            } => {
                card.request = "plan_permission".into();
                card.plan = Some(plan.clone());
                card.options = options.clone();
                card.flavor = Some(*flavor);
                card.plan_actions = plan_actions();
                prefs.exec_plans
            }
        };
        // The plan text the request left out: the executor's last words.
        if card.request != "question" && card.plan.as_deref().is_none_or(|p| p.trim().is_empty()) {
            card.plan = self.last_words(conn).await;
        }
        // A task asks in its own session on the board.
        if card.conversation_id.is_none() {
            if let Some(tid) = d.work_task_id {
                card.conversation_id = crate::db::service::work_task_service::get_model(&self.db.conn, tid)
                    .await
                    .ok()
                    .and_then(|t| t.conversation_id);
            }
        }
        card.conversation_folder_id = match card.conversation_id {
            Some(cid) => crate::db::service::conversation_service::get_by_id(&self.db.conn, cid)
                .await
                .ok()
                .map(|c| c.folder_id),
            None => None,
        };
        let brain = self.agent_row().await.and_then(|r| brain_of(&r)).is_some();
        let secret = card.questions.iter().any(|q| q.is_secret);
        let forward = if setting == ExecAnswers::Owner {
            Some("settings")
        } else if secret {
            Some("secret")
        } else if !brain {
            Some("no_brain")
        } else {
            None
        };
        card.state = if forward.is_some() { "forwarded" } else { "asking" }.into();
        card.forward_reason = forward.map(str::to_string);
        if forward.is_some() {
            card.forwarded_at = Some(Utc::now());
        }
        let what = match card.request.as_str() {
            "question" => "asked a question",
            _ => "asked for its plan to be approved",
        };
        let summary = match forward {
            None => format!(
                "Dispatch #{} \"{}\": the executor {what}; you answer it for the owner.",
                d.id, d.title
            ),
            Some(why) => format!(
                "Dispatch #{} \"{}\": the executor {what}; it went to the owner ({}). Nothing for you \
                 to answer.",
                d.id,
                d.title,
                forward_words(why)
            ),
        };
        let mut row = NewRow::new(TimelineKind::Notice, card_body(&card));
        row.dispatch_id = Some(d.id);
        row.segment_id = self.state.lock().await.connection_segment;
        let payload = serde_json::to_value(&card).unwrap_or_default();
        row.data = Some(payload.clone());
        let made = svc::create_ask(
            &self.db.conn,
            bot,
            NewNotice {
                kind: NoticeKind::Ask,
                subject_key: Some(subject),
                level: NoticeLevel::Urgent,
                batch_id: None,
                payload,
            },
            row,
            NewEvent {
                kind: svc::ASK_EVENT.into(),
                source_key: String::new(),
                coalesce_key: None,
                summary,
                payload: Some(json!({ "dispatch_id": d.id })),
                wake: forward.is_none(),
                lineage: svc::Lineage {
                    origin_bot_id: d.origin_bot_id,
                    origin_row_id: d.origin_row_id,
                    thread_id: d.thread_id,
                    for_input: d.for_input.clone(),
                },
            },
        )
        .await;
        let (notice, row) = match made {
            Ok((n, r, _)) => (n, r),
            Err(e) => {
                tracing::warn!("[personal_agent] dispatch #{}'s question not recorded: {e}", d.id);
                return;
            }
        };
        // The id is the notice's: written into the card itself too.
        card.ask_id = notice.id;
        let _ = self.write_ask(notice.id, &card).await;
        // Read under the same lock a change of the delegate takes
        // (`delegate_asks`): of the two, exactly one tells the owner.
        let held_back = forward.is_some() && self.window_held_back(&card).await;
        drop(_one);
        let _ = row;
        if forward.is_some() {
            // The windows notified the owner of it already unless the
            // delegate they hold said the assistant answers it (one set
            // before the owner's settings changed): then they are told now.
            if held_back {
                self.after_forward(&card).await;
            } else {
                self.mirror_ask(&card).await;
            }
        } else {
            self.nudge();
        }
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        self.emit(PersonalAgentChange::Status);
    }

    /// The executor's last words on `conn` this turn.
    async fn last_words(&self, conn: &str) -> Option<String> {
        let state = self.manager.get_state(conn).await?;
        let text = state.read().await.last_assistant_text.clone()?;
        let text = text.trim();
        (!text.is_empty()).then(|| cut(text, PLAN_CHARS))
    }

    /// Write card `ask_id` as `card` — its notice, its row, its mirrors —
    /// and show it.
    async fn write_ask(&self, ask_id: i32, card: &AskCard) -> Result<(), String> {
        let notice = svc::get_notice(&self.db.conn, ask_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such question card")?;
        let value = serde_json::to_value(card).map_err(|e| e.to_string())?;
        crate::db::service::personal_agent_service::set_notice_payload(&self.db.conn, ask_id, &value)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(row_id) = notice.timeline_id {
            svc::update_row_data(&self.db.conn, row_id, Some(card_body(card)), Some(value.clone()))
                .await
                .map_err(|e| e.to_string())?;
            if let Ok(Some(row)) = svc::get_row(&self.db.conn, row_id).await {
                self.emit_for(
                    notice.bot_id.unwrap_or(0),
                    PersonalAgentChange::Timeline {
                        rows: vec![svc::to_row(row)],
                    },
                );
            }
        }
        for m in &card.mirrors {
            let (Some(bot), Some(row_id)) = (
                m.get("bot_id").and_then(|v| v.as_i64()).and_then(|v| i32::try_from(v).ok()),
                m.get("row_id").and_then(|v| v.as_i64()).and_then(|v| i32::try_from(v).ok()),
            ) else {
                continue;
            };
            let mut mirror = card.clone();
            mirror.mirrors = Vec::new();
            mirror.mirror_of = Some(json!({
                "bot_id": card.bot_id,
                "row_id": notice.timeline_id,
                "ask_id": ask_id,
                "name": self.bot_name(card.bot_id).await,
            }));
            let mvalue = serde_json::to_value(&mirror).unwrap_or_default();
            let _ = svc::update_row_data(&self.db.conn, row_id, Some(card_body(&mirror)), Some(mvalue)).await;
            if let Ok(Some(row)) = svc::get_row(&self.db.conn, row_id).await {
                self.emit_for(
                    bot,
                    PersonalAgentChange::Timeline {
                        rows: vec![svc::to_row(row)],
                    },
                );
                self.emit_for(bot, PersonalAgentChange::Status);
            }
        }
        Ok(())
    }

    async fn bot_name(&self, bot: i32) -> String {
        svc::get_bot_any(&self.db.conn, bot)
            .await
            .ok()
            .flatten()
            .map(|b| super::messages::display_name(&b))
            .unwrap_or_else(|| format!("assistant #{bot}"))
    }

    /// The card of `ask_id`, as recorded, when it is one.
    pub(super) async fn ask_card(&self, ask_id: i32) -> Option<AskCard> {
        let n = svc::get_notice(&self.db.conn, ask_id).await.ok().flatten()?;
        if n.kind != NoticeKind::Ask {
            return None;
        }
        AskCard::read(&n.payload).map(|mut c| {
            c.ask_id = n.id;
            c
        })
    }

    // ── settling ────────────────────────────────────────────────────────────

    /// A question or extension plan approval on `conn` settled: write whose
    /// answer took effect (or that it was withdrawn) on its card.
    pub(super) async fn settle_ask(
        &self,
        conn: &str,
        request_id: &str,
        resolution: Option<AnswerResolution>,
    ) {
        let subject = format!("ask:{conn}:{request_id}");
        let Ok(Some(notice)) = svc::ask_by_subject(&self.db.conn, &subject).await else {
            return;
        };
        if notice.bot_id != Some(self.bot().await) {
            return;
        }
        let _one = self.asks_lock.lock().await;
        let Some(mut card) = self.ask_card(notice.id).await else {
            return;
        };
        if !card.is_open() {
            return;
        }
        let resolution = resolution.unwrap_or_else(AnswerResolution::withdrawn);
        match resolution.answer.as_ref() {
            Some(answer) => {
                let names = self.names_now().await;
                card.state = "answered".into();
                card.answered_by = Some(answered_by(resolution.origin.as_ref(), &|b| {
                    names.get(&b).cloned().unwrap_or_else(|| format!("assistant #{b}"))
                }));
                card.answer = Some(answer.clone());
                card.answer_text = Some(answer_words(&card, answer));
                card.answered_at = Some(resolution.at);
                // Grok drops what rides with a request for changes: it is
                // sent as the next message (7.3.1).
                if card.request == "plan" && card.agent_type == Some(AgentType::Grok) {
                    let decision = answer.get("decision").and_then(|d| d.as_str());
                    let feedback = answer
                        .get("feedback")
                        .and_then(|f| f.as_str())
                        .map(str::trim)
                        .filter(|f| !f.is_empty())
                        .map(str::to_string);
                    if decision == Some("request_changes") {
                        card.feedback = feedback;
                    }
                }
                let _ = svc::move_notice(&self.db.conn, notice.id, &[NoticeState::Open], NoticeState::Acted).await;
            }
            None => {
                card.state = "withdrawn".into();
                let _ = svc::move_notice(&self.db.conn, notice.id, &[NoticeState::Open], NoticeState::Expired).await;
            }
        }
        let _ = self.write_ask(notice.id, &card).await;
        self.emit(PersonalAgentChange::Dispatch { id: card.dispatch_id });
        self.emit(PersonalAgentChange::Status);
    }

    /// A plan approval that is a permission request settled: the option
    /// that took effect and whose it was (`None`: withdrawn).
    pub(super) async fn settle_permission_ask(
        &self,
        conn: &str,
        request_id: &str,
        option_id: Option<&str>,
        origin: Option<&PermissionAnswerOrigin>,
    ) {
        let subject = format!("ask:{conn}:{request_id}");
        let Ok(Some(notice)) = svc::ask_by_subject(&self.db.conn, &subject).await else {
            return;
        };
        if notice.bot_id != Some(self.bot().await) {
            return;
        }
        let _one = self.asks_lock.lock().await;
        let Some(mut card) = self.ask_card(notice.id).await else {
            return;
        };
        if !card.is_open() {
            return;
        }
        match option_id {
            Some(id) => {
                let option = card.options.iter().find(|o| o.option_id == id).cloned();
                let names = self.names_now().await;
                let answer = json!({
                    "option_id": id,
                    "name": option.as_ref().map(|o| o.name.clone()),
                    "kind": option.as_ref().map(|o| o.kind.clone()),
                });
                card.state = "answered".into();
                card.answered_by = Some(answered_by_permission(origin, &|b| {
                    names.get(&b).cloned().unwrap_or_else(|| format!("assistant #{b}"))
                }));
                card.answer_text = Some(answer_words(&card, &answer));
                card.answer = Some(answer);
                card.answered_at = Some(Utc::now());
                // The feedback rides only with the answer that took effect:
                // someone else's answer is theirs.
                let submitted = card.submitted.as_ref();
                let same_option = submitted
                    .and_then(|s| s.get("option_id"))
                    .and_then(|v| v.as_str())
                    == Some(id);
                let same_answerer = match (submitted.and_then(|s| s.get("by")).and_then(|v| v.as_str()), origin) {
                    (Some("assistant"), Some(PermissionAnswerOrigin::Assistant { bot_id })) => *bot_id == card.bot_id,
                    (Some("owner"), Some(PermissionAnswerOrigin::AssistantPage)) => true,
                    _ => false,
                };
                let ours = same_option && same_answerer;
                let rejected = option.as_ref().is_some_and(|o| o.kind.starts_with("reject"));
                if !(ours && rejected) {
                    card.feedback = None;
                }
                let _ = svc::move_notice(&self.db.conn, notice.id, &[NoticeState::Open], NoticeState::Acted).await;
            }
            None => {
                card.state = "withdrawn".into();
                card.feedback = None;
                let _ = svc::move_notice(&self.db.conn, notice.id, &[NoticeState::Open], NoticeState::Expired).await;
            }
        }
        card.submitted = None;
        let _ = self.write_ask(notice.id, &card).await;
        self.emit(PersonalAgentChange::Dispatch { id: card.dispatch_id });
        self.emit(PersonalAgentChange::Status);
    }

    async fn names_now(&self) -> std::collections::HashMap<i32, String> {
        svc::list_bots(&self.db.conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|b| (b.id, super::messages::display_name(&b)))
            .collect()
    }

    // ── answering ───────────────────────────────────────────────────────────

    /// Answer ask `ask_id` — the one way every answer from codeg goes
    /// (`dispatch_answer`, the page). The answer lands only on the request
    /// the card is about; a request gone or answered already gets its
    /// recorded outcome back, never another request's.
    pub async fn answer_ask(
        &self,
        ask_id: i32,
        answer: AskAnswer,
        by: Answerer,
        reason: Option<String>,
    ) -> Result<AskReply, String> {
        let bot = self.bot().await;
        let card = self.ask_card(ask_id).await.ok_or("no such question")?;
        if card.bot_id != bot {
            return Err("this question is another assistant's to answer".into());
        }
        if !card.is_open() || card.state == "submitting" {
            return Ok(self.recorded_reply(card));
        }
        if by == Answerer::Assistant && card.state == "forwarded" && card.forward_reason.as_deref() == Some("secret") {
            return Err("this question asks for a secret: the owner answers it".into());
        }
        // Taken over meanwhile: the owner's work, and the owner's to answer.
        if by == Answerer::Assistant
            && svc::get_dispatch(&self.db.conn, card.dispatch_id)
                .await
                .ok()
                .flatten()
                .is_some_and(|d| d.state == DispatchState::HandedOver)
        {
            return Err("the owner took this work over: the question is theirs to answer".into());
        }
        let origin = match by {
            Answerer::Assistant => AnswerOrigin::Assistant { bot_id: bot },
            Answerer::OwnerPage => AnswerOrigin::AssistantPage,
        };
        let outcome = match (card.request.as_str(), answer) {
            ("question", AskAnswer::Question(a)) => {
                self.manager
                    .answer_question_from(&card.conn, &card.request_id, a, origin)
                    .await
            }
            ("plan", AskAnswer::Plan { decision, feedback }) => {
                let answer = PlanApprovalAnswer { decision, feedback };
                self.manager
                    .answer_plan_approval_from(&card.conn, &card.request_id, answer, origin)
                    .await
            }
            ("plan_permission", AskAnswer::Plan { decision, feedback }) => {
                return self
                    .submit_plan_permission(card, decision, feedback, by, reason)
                    .await;
            }
            ("question", _) => return Err("this is a question: answer it with `answers`".into()),
            _ => return Err("this is a plan approval: answer it with `decision`".into()),
        };
        // Recorded from the settle point's own result.
        let resolution = match &outcome {
            AnswerOutcome::Answered(r) | AnswerOutcome::AlreadyAnswered(r) => Some(r.clone()),
            AnswerOutcome::Withdrawn => None,
        };
        if matches!(outcome, AnswerOutcome::Answered(_)) && reason.is_some() {
            let _one = self.asks_lock.lock().await;
            if let Some(mut now) = self.ask_card(ask_id).await {
                now.reason = reason;
                let _ = self.write_ask(ask_id, &now).await;
            }
        }
        self.settle_ask(&card.conn, &card.request_id, resolution).await;
        let now = self.ask_card(ask_id).await.unwrap_or(card);
        Ok(match outcome {
            AnswerOutcome::Answered(_) => AskReply {
                state: "answered",
                text: format!(
                    "Answered: {}. The executor goes on with it.",
                    now.answer_text.clone().unwrap_or_default()
                ),
                card: now,
            },
            AnswerOutcome::AlreadyAnswered(_) => self.recorded_reply(now),
            AnswerOutcome::Withdrawn => AskReply {
                state: "withdrawn",
                text: "Nothing was answered: the question is no longer there (withdrawn, or its \
                       session ended)."
                    .into(),
                card: now,
            },
        })
    }

    /// A plan approval that is a permission request: the option for the
    /// decision is submitted; the card settles when the executor's
    /// `PermissionResolved` names the answer that took effect.
    async fn submit_plan_permission(
        &self,
        mut card: AskCard,
        decision: PlanApprovalDecision,
        feedback: Option<String>,
        by: Answerer,
        reason: Option<String>,
    ) -> Result<AskReply, String> {
        let option_id = plan_option(&card, decision).ok_or("this plan approval offers no such answer")?;
        let bot = self.bot().await;
        let origin = match by {
            Answerer::Assistant => PermissionAnswerOrigin::Assistant { bot_id: bot },
            Answerer::OwnerPage => PermissionAnswerOrigin::AssistantPage,
        };
        // What the answer cannot carry goes as the next message.
        let feedback = match decision {
            PlanApprovalDecision::Approve => None,
            PlanApprovalDecision::RequestChanges => feedback
                .map(|f| f.trim().to_string())
                .filter(|f| !f.is_empty()),
            PlanApprovalDecision::Abandon => Some(match feedback.map(|f| f.trim().to_string()).filter(|f| !f.is_empty()) {
                Some(f) => format!("{ABANDON_NOTE} {f}"),
                None => ABANDON_NOTE.to_string(),
            }),
        };
        {
            let _one = self.asks_lock.lock().await;
            // Settled meanwhile (the owner's answer took effect): never back
            // to submitting.
            match self.ask_card(card.ask_id).await {
                Some(now) if now.state == "asking" || now.state == "forwarded" => card = now,
                Some(now) => return Ok(self.recorded_reply(now)),
                None => return Err("no such question".into()),
            }
            card.state = "submitting".into();
            card.submitted = Some(json!({
                "option_id": option_id,
                "by": if by == Answerer::Assistant { "assistant" } else { "owner" },
            }));
            card.feedback = feedback;
            if reason.is_some() {
                card.reason = reason;
            }
            let _ = self.write_ask(card.ask_id, &card).await;
        }
        let sent = self
            .manager
            .respond_permission_from(&card.conn, &card.request_id, &option_id, origin)
            .await;
        if sent.is_err() {
            // The session is gone: nothing can take effect.
            self.settle_permission_ask(&card.conn, &card.request_id, None, None)
                .await;
            let now = self.ask_card(card.ask_id).await.unwrap_or(card);
            return Ok(AskReply {
                state: "withdrawn",
                text: "Nothing was answered: the session asking is gone.".into(),
                card: now,
            });
        }
        self.emit(PersonalAgentChange::Status);
        let now = self.ask_card(card.ask_id).await.unwrap_or(card);
        Ok(AskReply {
            state: if now.state == "answered" { "answered" } else { "submitted" },
            text: "Submitted. It takes effect once the executor confirms it — unless someone \
                   answered first; the card says whose answer it was."
                .into(),
            card: now,
        })
    }

    /// The outcome on record for a card no longer open to an answer.
    fn recorded_reply(&self, card: AskCard) -> AskReply {
        match card.state.as_str() {
            "answered" => {
                let by = card
                    .answered_by
                    .as_ref()
                    .map(by_words)
                    .unwrap_or_else(|| "someone".into());
                AskReply {
                    state: "already_answered",
                    text: format!(
                        "Already answered by {by}: {}. Your answer was not used.",
                        card.answer_text.clone().unwrap_or_default()
                    ),
                    card,
                }
            }
            "submitting" => AskReply {
                state: "submitted",
                text: "An answer to it is on its way to the executor already.".into(),
                card,
            },
            _ => AskReply {
                state: "withdrawn",
                text: "Nothing was answered: the question is no longer there (withdrawn, or its \
                       session ended)."
                    .into(),
                card,
            },
        }
    }

    // ── forwarding ──────────────────────────────────────────────────────────

    /// The owner answers ask `ask_id` now: `why` as on the card, with the
    /// assistant's lean and reason when it forwarded it. False when it was
    /// no longer the assistant's to forward.
    pub async fn forward_ask(
        &self,
        ask_id: i32,
        why: &str,
        suggestion: Option<String>,
        reason: Option<String>,
    ) -> bool {
        let card = {
            let _one = self.asks_lock.lock().await;
            let Some(mut card) = self.ask_card(ask_id).await else {
                return false;
            };
            if card.state != "asking" {
                return false;
            }
            card.state = "forwarded".into();
            card.forward_reason = Some(why.to_string());
            card.forwarded_at = Some(Utc::now());
            if suggestion.is_some() {
                card.suggestion = suggestion;
            }
            if reason.is_some() {
                card.reason = reason;
            }
            let _ = self.write_ask(ask_id, &card).await;
            card
        };
        self.after_forward(&card).await;
        self.emit(PersonalAgentChange::Dispatch { id: card.dispatch_id });
        self.emit(PersonalAgentChange::Status);
        true
    }

    /// An ask the owner answers now: its windows notify them, and the
    /// conversation the work came from shows it too (4.11).
    async fn after_forward(&self, card: &AskCard) {
        self.manager
            .ask_forwarded(&card.conn, &card.request_id, card.notify_kind())
            .await;
        self.mirror_ask(card).await;
    }

    /// Show ask `card` where the work came from, when that is another
    /// assistant's conversation: once.
    async fn mirror_ask(&self, card: &AskCard) {
        if !card.mirrors.is_empty() {
            return;
        }
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, card.dispatch_id).await else {
            return;
        };
        let Some(origin) = d.origin_bot_id.filter(|b| *b != card.bot_id) else {
            return;
        };
        if svc::get_bot(&self.db.conn, origin).await.ok().flatten().is_none() {
            return;
        }
        let Ok(Some(notice)) = svc::get_notice(&self.db.conn, card.ask_id).await else {
            return;
        };
        let mut mirror = card.clone();
        mirror.mirror_of = Some(json!({
            "bot_id": card.bot_id,
            "row_id": notice.timeline_id,
            "ask_id": card.ask_id,
            "name": self.bot_name(card.bot_id).await,
        }));
        let mut row = NewRow::new(TimelineKind::Notice, card_body(&mirror));
        row.ref_id = Some(card.ask_id.to_string());
        row.reply_to = d.origin_row_id;
        row.data = Some(serde_json::to_value(&mirror).unwrap_or_default());
        let Ok(made) = svc::insert_row(&self.db.conn, origin, row).await else {
            return;
        };
        self.emit_for(
            origin,
            PersonalAgentChange::Timeline {
                rows: vec![svc::to_row(made.clone())],
            },
        );
        self.emit_for(origin, PersonalAgentChange::Status);
        let _one = self.asks_lock.lock().await;
        if let Some(mut now) = self.ask_card(card.ask_id).await {
            now.mirrors = vec![json!({ "bot_id": origin, "row_id": made.id })];
            let _ = self.write_ask(card.ask_id, &now).await;
        }
    }

    /// After a delivery: an ask it carried (`asks`, read before its events
    /// were settled or put back) that is still the assistant's to answer
    /// goes to the owner — the turn ended, or failed, without an answer.
    pub(super) async fn forward_unanswered(&self, asks: &[i32], failed: bool) {
        for ask_id in asks {
            self.forward_ask(
                *ask_id,
                if failed { "turn_failed" } else { "turn_ended" },
                None,
                None,
            )
            .await;
        }
    }

    /// No turn could be started to answer them (the brain would not start,
    /// a delivery failed): what the assistant was to answer is the owner's.
    pub(super) async fn forward_all_asking(&self, why: &str) {
        let bot = self.bot().await;
        for n in svc::open_asks(&self.db.conn, Some(bot)).await.unwrap_or_default() {
            if AskCard::read(&n.payload).is_some_and(|c| c.state == "asking") {
                self.forward_ask(n.id, why, None, None).await;
            }
        }
    }

    /// The asks a batch carries, before its events are put back or settled.
    pub(super) async fn asks_of_batch(&self, batch_id: i32) -> Vec<i32> {
        svc::events_of_batch(&self.db.conn, batch_id)
            .await
            .unwrap_or_default()
            .iter()
            .filter(|e| e.kind == svc::ASK_EVENT)
            .filter_map(|e| {
                e.payload
                    .as_deref()
                    .and_then(|p| serde_json::from_str::<Value>(p).ok())
                    .and_then(|p| p.get("ask_id").and_then(|v| v.as_i64()))
                    .and_then(|v| i32::try_from(v).ok())
            })
            .collect()
    }

    /// An ask the assistant has not answered in [`ASK_TIMEOUT`] is the
    /// owner's.
    pub(super) async fn forward_stale_asks(&self) {
        let bot = self.bot().await;
        let now = Utc::now();
        for n in svc::open_asks(&self.db.conn, Some(bot)).await.unwrap_or_default() {
            let Some(card) = AskCard::read(&n.payload) else {
                continue;
            };
            if card.state == "asking" && card.asked_at.is_some_and(|at| now - at > ASK_TIMEOUT) {
                self.forward_ask(n.id, "timeout", None, None).await;
            }
        }
    }

    /// The feedback a plan approval could not carry, sent to the executor as
    /// the next message once the round it ended is over — once. When the
    /// work cannot take one (its task was canceled, the owner took it over,
    /// the send failed), the assistant is told the feedback instead, so it
    /// is not lost.
    pub(super) async fn send_plan_feedback(self: &Arc<Self>) {
        let bot = self.bot().await;
        let rows = svc::ask_rows_with_feedback(&self.db.conn, bot)
            .await
            .unwrap_or_default();
        for r in rows {
            let Some(card) = r.data.as_deref().and_then(AskCard::read) else {
                continue;
            };
            if card.mirror_of.is_some() || card.feedback_sent || card.state != "answered" {
                continue;
            }
            let Some(text) = card.feedback.clone() else {
                continue;
            };
            let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, card.dispatch_id).await else {
                continue;
            };
            // How the work takes it, once its round is over: a task in
            // review is sent back with it, a failed one retried with it; a
            // conversation gets it as its next turn.
            let how: Result<Option<&str>, &str> = match (d.mode, d.state) {
                (DispatchMode::Task, DispatchState::Review) => Ok(Some("revise")),
                (DispatchMode::Task, DispatchState::Failed | DispatchState::Interrupted) => Ok(None),
                (DispatchMode::Task, DispatchState::Canceled | DispatchState::Completed) => {
                    Err("its task ended, so it cannot take a follow-up")
                }
                (_, DispatchState::HandedOver) => Err("the owner took the work over"),
                (DispatchMode::Task, _) => continue,
                (
                    _,
                    DispatchState::Completed
                    | DispatchState::Failed
                    | DispatchState::Canceled
                    | DispatchState::Interrupted,
                ) => Ok(None),
                _ => continue,
            };
            let op_id = format!("pa-askfb-{}", card.ask_id);
            // Sent already (a restart came before it was marked): only the
            // mark is owed.
            let earlier = svc::get_op(&self.db.conn, &op_id).await.ok().flatten();
            let failed = match (&earlier, how) {
                (Some(op), _) if op.state != crate::db::entities::personal_agent_action::ActionState::NotExecuted => None,
                (Some(op), _) => Some(op.detail.clone().unwrap_or_else(|| "it could not be sent".into())),
                (None, Ok(intent)) => self
                    .followup_call(
                        d.id,
                        text.clone(),
                        intent.map(str::to_string),
                        FollowupAuth::Op { op_id },
                    )
                    .await
                    .err(),
                (None, Err(why)) => Some(why.to_string()),
            };
            // Not sent: the assistant is told before the card says it was
            // handled — a crash between the two tells it again (the event's
            // key makes it once), never neither.
            if let Some(why) = failed {
                let told = svc::insert_event(
                    &self.db.conn,
                    bot,
                    "dispatch_status",
                    &format!("askfb:{}", card.ask_id),
                    None,
                    format!(
                        "Dispatch #{} \"{}\": its plan was sent back, but codeg could not send the \
                         feedback to it ({why}). Follow up with it yourself if the work should go \
                         on: \"{}\"",
                        d.id,
                        d.title,
                        cut(&text, 1_500)
                    ),
                    Some(json!({ "dispatch_id": d.id })),
                    true,
                )
                .await;
                if told.is_err() {
                    continue;
                }
                self.nudge();
            }
            let _one = self.asks_lock.lock().await;
            if let Some(mut now) = self.ask_card(card.ask_id).await {
                now.feedback_sent = true;
                let _ = self.write_ask(card.ask_id, &now).await;
            }
        }
    }

    /// Whether dispatch `d` waits on a question or a plan approval — one its
    /// card tells, not the waiting-for-input news: an open card, or a wait
    /// up on its connection that the card is about to be raised for.
    pub(super) async fn waits_on_ask(&self, d: &dispatch_entity::Model) -> bool {
        if svc::ask_rows_of_dispatches(&self.db.conn, &[d.id])
            .await
            .unwrap_or_default()
            .iter()
            .filter_map(|r| r.data.as_deref().and_then(AskCard::read))
            .any(|c| c.mirror_of.is_none() && c.is_open())
        {
            return true;
        }
        let conn = match d.mode {
            DispatchMode::Task => match d.work_task_id {
                Some(tid) => crate::db::service::work_task_service::get_model(&self.db.conn, tid)
                    .await
                    .ok()
                    .and_then(|t| t.connection_id),
                None => None,
            },
            _ => d.connection_id.clone(),
        };
        let Some(state) = (match conn {
            Some(c) => self.manager.get_state(&c).await,
            None => None,
        }) else {
            return false;
        };
        let s = state.read().await;
        s.pending_question.is_some()
            || s.pending_plan_approval.is_some()
            || s
                .pending_permission
                .as_ref()
                .is_some_and(|p| PlanPermission::of(&p.tool_call, &p.options).is_some())
    }

    /// Whether a plan of dispatch `id` was sent back with feedback still to
    /// send.
    pub(super) async fn feedback_pending(&self, id: i32) -> bool {
        svc::ask_rows_of_dispatches(&self.db.conn, &[id])
            .await
            .unwrap_or_default()
            .iter()
            .filter_map(|r| r.data.as_deref().and_then(AskCard::read))
            .any(|c| c.mirror_of.is_none() && c.state == "answered" && c.feedback.is_some() && !c.feedback_sent)
    }

    // ── what the assistant reads ────────────────────────────────────────────

    /// The `<codeg-ask>` block of an ask event: the request in full and what
    /// to answer it from. An ask no longer the assistant's (answered,
    /// forwarded, withdrawn meanwhile) reads as a line of news instead.
    pub(super) async fn ask_block(&self, e: &crate::db::entities::personal_agent_event::Model) -> String {
        let ask_id = e
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str::<Value>(p).ok())
            .and_then(|p| p.get("ask_id").and_then(|v| v.as_i64()))
            .and_then(|v| i32::try_from(v).ok());
        let Some(card) = (match ask_id {
            Some(id) => self.ask_card(id).await,
            None => None,
        }) else {
            return format!("- {}", e.summary);
        };
        let head = format!(
            "Dispatch #{} \"{}\" · executor {} · {}",
            card.dispatch_id,
            card.title,
            card.executor,
            card.mode.map(mode_label).unwrap_or("")
        );
        if card.state != "asking" {
            let now = match card.state.as_str() {
                "answered" => format!(
                    "it was answered by {}: {}",
                    card.answered_by.as_ref().map(by_words).unwrap_or_else(|| "someone".into()),
                    card.answer_text.clone().unwrap_or_default()
                ),
                "forwarded" => format!(
                    "it went to the owner ({})",
                    forward_words(card.forward_reason.as_deref().unwrap_or("assistant"))
                ),
                "submitting" => "an answer to it is on its way".into(),
                _ => "it was withdrawn".into(),
            };
            return format!(
                "- {head}: the executor's {} (ask {}) — {now}. Nothing for you to answer.",
                if card.request == "question" { "question" } else { "plan approval" },
                card.ask_id
            );
        }
        let d = svc::get_dispatch(&self.db.conn, card.dispatch_id).await.ok().flatten();
        let mut lines = vec![head];
        if let Some(d) = d.as_ref() {
            if let Some(words) = self.owner_words(d).await {
                lines.push(format!("What the owner said when this work began: \"{}\"", cut(&words, WORDS_CHARS)));
            }
            lines.push(format!("What you asked of it: {}", cut(&d.prompt, WORDS_CHARS)));
        }
        if let Some(last) = self.last_words(&card.conn).await {
            if card.request == "question" || card.plan.as_deref() != Some(last.as_str()) {
                lines.push(format!("The executor's last words: \"{}\"", cut(&last, WORDS_CHARS)));
            }
        }
        match card.request.as_str() {
            "question" => {
                for (i, q) in card.questions.iter().enumerate() {
                    let header = if q.header.trim().is_empty() {
                        String::new()
                    } else {
                        format!(" [{}]", q.header.trim())
                    };
                    let pick = if q.multi_select {
                        "pick any"
                    } else if q.options.is_empty() {
                        "write the answer"
                    } else {
                        "pick one"
                    };
                    lines.push(format!("Question {}{header} ({pick}): {}", i + 1, q.question.trim()));
                    for o in &q.options {
                        if o.description.trim().is_empty() {
                            lines.push(format!("  - {}", o.label));
                        } else {
                            lines.push(format!("  - {} — {}", o.label, o.description.trim()));
                        }
                    }
                    if !q.options.is_empty() {
                        lines.push("  (or write an answer of your own as `text`)".into());
                    }
                }
            }
            _ => {
                lines.push("The plan to approve:".into());
                lines.push(cut(card.plan.as_deref().unwrap_or("(no plan text)"), PLAN_CHARS));
                lines.push(format!(
                    "Answer with `decision`: {} (`feedback` says what to change).",
                    card.plan_actions.join(" | ")
                ));
            }
        }
        format!(
            "<codeg-ask id=\"{}\" dispatch=\"{}\">\n\
This is a {} from the session of work you dispatched — the executor's, not the owner's words. \
Answer it for the owner with `dispatch_answer` (ask_id {}), from what they asked for and what you \
know of them, quoting what you base it on in `reason`; when you cannot settle it, forward it to \
them with `forward: true` (say what you lean to in `suggestion`).\n{}\n</codeg-ask>",
            card.ask_id,
            card.dispatch_id,
            if card.request == "question" { "question" } else { "plan approval" },
            card.ask_id,
            lines.join("\n").replace("</codeg-ask>", "<\\/codeg-ask>")
        )
    }

    /// The owner's words that began the work: the message the dispatch
    /// was made for.
    async fn owner_words(&self, d: &dispatch_entity::Model) -> Option<String> {
        let row = svc::get_row(&self.db.conn, d.origin_row_id?).await.ok().flatten()?;
        (row.kind == TimelineKind::Owner).then(|| row.body.trim().to_string()).filter(|b| !b.is_empty())
    }
}

impl PersonalAgentEngine {
    /// `dispatch_answer`: answer an ask for the owner, or forward it to them
    /// (7.3.1). Through the ledger, keyed by the ask: the turn a delivery
    /// repeats gets what the first call got — and the first answer wins at
    /// the settle point anyway.
    pub(super) async fn dispatch_answer_call(&self, args: &Value) -> super::tools::ToolOutcome {
        use super::tools::ToolOutcome;
        let Some(ask_id) = args
            .get("ask_id")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.trim().trim_start_matches('#').parse().ok()))
            .and_then(|v| i32::try_from(v).ok())
        else {
            return ToolOutcome::refused("`ask_id` is required: the id on the <codeg-ask> block");
        };
        let reason = args
            .get("reason")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| cut(s, 1_000));
        let Some(reason) = reason else {
            return ToolOutcome::refused("`reason` is required: one sentence on what the answer rests on");
        };
        let Some(card) = self.ask_card(ask_id).await else {
            return ToolOutcome::refused(format!("there is no question {ask_id}"));
        };
        if card.bot_id != self.bot().await {
            return ToolOutcome::refused(
                "this question is another assistant's to answer: the one that dispatched the work",
            );
        }
        let key = format!("ask:{ask_id}");
        let batch = self.ledger_batch().await;
        if let Some((_, scope)) = batch.as_ref() {
            if let Some(earlier) = svc::ledger_entries(&self.db.conn, scope, &key)
                .await
                .unwrap_or_default()
                .into_iter()
                .last()
            {
                let now = self.ask_card(ask_id).await.unwrap_or(card);
                let reply = self.recorded_reply(now.clone());
                return ToolOutcome::ok(
                    format!(
                        "Done in the turn this delivery repeats: {} Now: {}",
                        earlier.detail.unwrap_or_default(),
                        reply.text
                    ),
                    json!({ "ask_id": ask_id, "state": now.state }),
                );
            }
        }
        let forward = args.get("forward").and_then(|v| v.as_bool()).unwrap_or(false);
        let outcome = if forward {
            let suggestion = args
                .get("suggestion")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| cut(s, 1_000));
            if self.forward_ask(ask_id, "assistant", suggestion, Some(reason.clone())).await {
                let now = self.ask_card(ask_id).await.unwrap_or(card);
                AskReply {
                    state: "forwarded",
                    text: "Forwarded to the owner, with your reason and suggestion on the card.                            Their answer goes to the executor directly."
                        .into(),
                    card: now,
                }
            } else {
                let now = self.ask_card(ask_id).await.unwrap_or(card);
                self.recorded_reply(now)
            }
        } else {
            let answer = match card.request.as_str() {
                "question" => match args.get("answers") {
                    Some(raw) => match question_answer(&card.questions, raw) {
                        Ok(a) => AskAnswer::Question(a),
                        Err(e) => return ToolOutcome::refused(e),
                    },
                    None => {
                        return ToolOutcome::refused(
                            "this is a question: give `answers` (or `forward: true`)",
                        )
                    }
                },
                _ => {
                    let Some(word) = args.get("decision").and_then(|v| v.as_str()) else {
                        return ToolOutcome::refused(
                            "this is a plan approval: give `decision` (or `forward: true`)",
                        );
                    };
                    let decision = match plan_decision(word) {
                        Ok(d) => d,
                        Err(e) => return ToolOutcome::refused(e),
                    };
                    let feedback = args
                        .get("feedback")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                    if decision == PlanApprovalDecision::RequestChanges && feedback.is_none() {
                        return ToolOutcome::refused("`revise` needs `feedback`: what to change");
                    }
                    AskAnswer::Plan { decision, feedback }
                }
            };
            match self.answer_ask(ask_id, answer, Answerer::Assistant, Some(reason)).await {
                Ok(r) => r,
                Err(e) => return ToolOutcome::refused(e),
            }
        };
        if let Some((batch_id, _)) = batch {
            let _ = svc::record_done_op(
                &self.db.conn,
                self.bot().await,
                &svc::LedgerSlot::in_batch(batch_id, key, super::ledger::fresh_op_id()),
                "ask",
                args.clone(),
                &outcome.text,
                json!({ "state": outcome.state }),
            )
            .await;
        }
        ToolOutcome::ok(
            outcome.text,
            json!({ "ask_id": ask_id, "state": outcome.state }),
        )
    }
}

/// Of these dispatches, those whose executor waits on a question or plan
/// approval its assistant is answering (`asking`, `submitting`): not the
/// owner's to answer (7.3.1).
pub async fn answering_dispatches(
    db: &crate::db::AppDatabase,
    ids: &[i32],
) -> std::collections::HashSet<i32> {
    svc::ask_rows_of_dispatches(&db.conn, ids)
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|r| r.data.as_deref().and_then(AskCard::read))
        .filter(|c| c.mirror_of.is_none() && matches!(c.state.as_str(), "asking" | "submitting"))
        .map(|c| c.dispatch_id)
        .collect()
}

/// Every dispatch with an open ask card (any assistant's), and how many of
/// each dispatch's asks its assistant answered.
pub async fn asked_dispatches(db: &crate::db::AppDatabase) -> std::collections::HashSet<i32> {
    svc::open_asks(&db.conn, None)
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|n| AskCard::read(&n.payload))
        .filter(|c| c.is_open())
        .map(|c| c.dispatch_id)
        .collect()
}

/// How many of each dispatch's questions and plan approvals its assistant
/// answered for the owner (the dispatch card's "answered for you N times").
pub async fn answered_for_owner(
    db: &crate::db::AppDatabase,
    ids: &[i32],
) -> std::collections::HashMap<i32, u32> {
    let mut out = std::collections::HashMap::new();
    for c in svc::ask_rows_of_dispatches(&db.conn, ids)
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|r| r.data.as_deref().and_then(AskCard::read))
        .filter(|c| c.mirror_of.is_none() && c.state == "answered")
    {
        let by_assistant = c
            .answered_by
            .as_ref()
            .and_then(|b| b.get("kind"))
            .and_then(|k| k.as_str())
            == Some("assistant");
        if by_assistant {
            *out.entry(c.dispatch_id).or_insert(0) += 1;
        }
    }
    out
}

/// Why an ask is the owner's, in words for the brain.
fn forward_words(why: &str) -> &'static str {
    match why {
        "settings" => "their settings send these to them",
        "secret" => "it asks for a secret",
        "no_brain" => "no brain is set up to answer it",
        "turn_ended" => "the turn ended without an answer",
        "turn_failed" => "the turn failed",
        "timeout" => "no answer came in ten minutes",
        _ => "forwarded",
    }
}

/// A card's text in the timeline (the page draws the data; this is what a
/// search or an excerpt reads).
fn card_body(card: &AskCard) -> String {
    match card.request.as_str() {
        "question" => card
            .questions
            .iter()
            .map(|q| q.question.trim().to_string())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => cut(card.plan.as_deref().unwrap_or("Plan approval"), 2_000),
    }
}

/// The answers to a question as the model writes them: by number (1-based)
/// or id, `choose` the options' labels, `text` its own words. Checked
/// against the questions: every one answered, labels offered, one answer
/// to a single choice.
pub fn question_answer(questions: &[QuestionSpec], raw: &Value) -> Result<QuestionAnswer, String> {
    let items = raw
        .as_array()
        .ok_or("`answers` is a list: one {question, choose, text} for each question")?;
    let mut out: Vec<QuestionAnswerItem> = Vec::new();
    for item in items {
        let which = item.get("question");
        let spec = match which {
            Some(Value::Number(n)) => n
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .and_then(|n| n.checked_sub(1))
                .and_then(|i| questions.get(i)),
            Some(Value::String(s)) => {
                let s = s.trim();
                questions
                    .iter()
                    .find(|q| q.id == s)
                    .or_else(|| s.parse::<usize>().ok().and_then(|n| n.checked_sub(1)).and_then(|i| questions.get(i)))
                    .or_else(|| questions.iter().find(|q| q.question.trim() == s))
            }
            None if questions.len() == 1 => questions.first(),
            _ => None,
        }
        .ok_or("each answer names its `question` by number (1, 2, …)")?;
        let mut labels: Vec<String> = Vec::new();
        if let Some(choose) = item.get("choose") {
            let picked: Vec<String> = match choose {
                Value::String(s) => vec![s.clone()],
                Value::Array(a) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
                _ => Vec::new(),
            };
            for p in picked {
                let p = p.trim();
                let label = spec
                    .options
                    .iter()
                    .find(|o| o.label.trim().eq_ignore_ascii_case(p))
                    .map(|o| o.label.clone())
                    .ok_or_else(|| {
                        format!(
                            "\"{p}\" is not an option of question \"{}\"; the options are: {}",
                            cut(&spec.question, 80),
                            spec.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>().join(", ")
                        )
                    })?;
                labels.push(label);
            }
        }
        if let Some(text) = item.get("text").and_then(|t| t.as_str()).map(str::trim).filter(|t| !t.is_empty()) {
            labels.push(text.to_string());
        }
        if labels.is_empty() {
            return Err(format!("question \"{}\" has no answer: `choose` an option or write `text`", cut(&spec.question, 80)));
        }
        if !spec.multi_select && labels.len() > 1 {
            return Err(format!("question \"{}\" takes one answer", cut(&spec.question, 80)));
        }
        if out.iter().any(|o| o.question_id == spec.id) {
            return Err(format!("question \"{}\" is answered twice", cut(&spec.question, 80)));
        }
        out.push(QuestionAnswerItem {
            question_id: spec.id.clone(),
            labels,
        });
    }
    if let Some(missing) = questions.iter().find(|q| !out.iter().any(|o| o.question_id == q.id)) {
        return Err(format!("question \"{}\" has no answer yet", cut(&missing.question, 80)));
    }
    Ok(QuestionAnswer {
        answers: out,
        declined: false,
    })
}

/// A plan decision as the model or the page writes it.
pub fn plan_decision(word: &str) -> Result<PlanApprovalDecision, String> {
    match word.trim() {
        "approve" => Ok(PlanApprovalDecision::Approve),
        "revise" | "request_changes" => Ok(PlanApprovalDecision::RequestChanges),
        "abandon" => Ok(PlanApprovalDecision::Abandon),
        _ => Err("`decision` is approve, revise or abandon".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::question::QuestionOption;

    fn spec(id: &str, multi: bool, options: &[&str]) -> QuestionSpec {
        QuestionSpec {
            id: id.into(),
            question: format!("Which {id}?"),
            header: String::new(),
            multi_select: multi,
            options: options
                .iter()
                .map(|l| QuestionOption {
                    label: l.to_string(),
                    description: String::new(),
                })
                .collect(),
            is_secret: false,
        }
    }

    #[test]
    fn answers_are_read_by_number_and_checked_against_the_options() {
        let qs = vec![spec("a", false, &["A", "B"]), spec("b", true, &["X", "Y"])];
        let a = question_answer(
            &qs,
            &json!([{ "question": 1, "choose": ["a"] }, { "question": 2, "choose": ["X", "Y"], "text": "and Z" }]),
        )
        .unwrap();
        assert_eq!(a.answers[0].labels, vec!["A"]);
        assert_eq!(a.answers[1].labels, vec!["X", "Y", "and Z"]);
        assert!(question_answer(&qs, &json!([{ "question": 1, "choose": ["C"] }])).is_err());
        assert!(question_answer(&qs, &json!([{ "question": 1, "choose": ["A", "B"] }])).is_err());
        // Every question answered.
        assert!(question_answer(&qs, &json!([{ "question": 1, "choose": "A" }])).is_err());
        // One question: its number may be left out.
        let one = vec![spec("a", false, &[])];
        let a = question_answer(&one, &json!([{ "text": "Use A" }])).unwrap();
        assert_eq!(a.answers[0].labels, vec!["Use A"]);
    }

    #[test]
    fn a_plan_is_approved_in_the_executor_s_own_mode_and_never_clearing_the_context() {
        let opt = |id: &str, kind: &str| PermissionOptionInfo {
            option_id: id.into(),
            name: id.into(),
            kind: kind.into(),
            meta: None,
        };
        let mut card = AskCard {
            flavor: Some(PlanPermission::ClaudeExitPlan),
            options: vec![
                opt("exit-plan-clear-auto", "allow_always"),
                opt("exit-plan-auto", "allow_always"),
                opt("exit-plan-accept-edits", "allow_always"),
                opt("exit-plan-default", "allow_once"),
                opt("reject", "reject_once"),
            ],
            ..Default::default()
        };
        card.exec_mode = Some("acceptEdits".into());
        assert_eq!(plan_option(&card, PlanApprovalDecision::Approve).as_deref(), Some("exit-plan-accept-edits"));
        card.exec_mode = Some("plan".into());
        assert_eq!(plan_option(&card, PlanApprovalDecision::Approve).as_deref(), Some("exit-plan-default"));
        card.exec_mode = Some("bypassPermissions".into());
        assert_eq!(plan_option(&card, PlanApprovalDecision::Approve).as_deref(), Some("exit-plan-default"));
        assert_eq!(plan_option(&card, PlanApprovalDecision::RequestChanges).as_deref(), Some("reject"));
        assert_eq!(plan_option(&card, PlanApprovalDecision::Abandon).as_deref(), Some("reject"));
        let codex = AskCard {
            flavor: Some(PlanPermission::CodexPlanReview),
            options: vec![opt("implement_plan", "allow_once"), opt("revise_plan", "reject_once")],
            ..Default::default()
        };
        assert_eq!(plan_option(&codex, PlanApprovalDecision::Approve).as_deref(), Some("implement_plan"));
        assert_eq!(plan_option(&codex, PlanApprovalDecision::RequestChanges).as_deref(), Some("revise_plan"));
    }
}
