//! One prompt, one answer, on a hidden throwaway ACP session.
//!
//! Some features want an agent to write a short piece of text for codeg — a
//! commit message today — without that becoming a conversation. [`run`] starts
//! a fresh connection, sends one prompt and hands back the reply:
//!
//! - **Nothing to see.** The connection is never bound to a conversation row
//!   and its events go to a no-op emitter, so no window, lifecycle worker, pet
//!   or chat channel ever hears of it. It runs in an empty codeg-owned
//!   directory ([`crate::paths::codeg_text_generation_root`]), so whatever
//!   history an agent still writes of it is filed under that directory: out of
//!   the repository's resume list in the agent's own CLI, and skipped by
//!   codeg's session scans ([`GenerationPaths`]).
//! - **Nothing to run.** No MCP server is offered, neither the user's nor
//!   codeg-mcp. Claude additionally gets no tools, no on-disk session and a
//!   system prompt of its own ([`session_meta`]).
//! - **No one to ask.** Permission requests are refused once, questions are
//!   declined and plan approvals abandoned the moment they arrive.
//!
//! There is no deadline. The caller ends a run it no longer wants by
//! cancelling its token, and a run whose future is dropped takes its agent
//! process with it.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast::error::RecvError;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::acp::manager::ConnectionManager;
use crate::acp::plan_approval::{PlanApprovalAnswer, PlanApprovalDecision};
use crate::acp::question::QuestionAnswer;
use crate::acp::types::{AcpEvent, ConnectionStatus, PermissionOptionInfo, PromptInputBlock};
use crate::acp::SessionState;
use crate::cli_run::policy::{decide_permission, PermissionDecision, PermissionPolicy};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::parsers::normalize_path_for_matching;
use crate::web::event_bridge::EventEmitter;

/// Owner label of every one-shot connection. Not a window, so closing one
/// never takes a run with it. The connection reads it to leave out MCP
/// servers and to give Claude [`session_meta`].
pub const OWNER_LABEL: &str = "one_shot";

/// How long a run waits on its event stream before it looks at the connection
/// itself. The stream outlives the connection (the run holds its state), so a
/// connection that ended before the run subscribed would otherwise be waited
/// on forever. Also the backstop for a permission request whose event was
/// lost to lag.
const LIVENESS_INTERVAL: Duration = Duration::from_secs(2);

/// Claude's entire system prompt on a one-shot session, in place of Claude
/// Code's own: the session has no tools for that prompt to describe, and the
/// request carries every instruction that matters.
const SYSTEM_PROMPT: &str = "You write text for Codeg, a coding workbench, when it asks you to. \
Answer with exactly the text requested: no preamble, no commentary, no sign-off. \
You have no tools; everything you need is in the request.";

/// The title a one-shot Claude session is given so that it never asks the
/// model for one; nobody sees it.
const SESSION_TITLE: &str = "Codeg text generation";

/// Whether a connection was started by [`run`].
pub fn is_one_shot_owner(owner_window_label: &str) -> bool {
    owner_window_label == OWNER_LABEL
}

/// The `session/new` `_meta` a one-shot Claude session is created with:
/// codeg's usual raw-SDK meta (prompt suggestions off — nobody composes a next
/// prompt here), plus SDK options claude-agent-acp hands through unchanged:
///
/// - `persistSession: false` — nothing written to `~/.claude/projects`, so
///   the session never shows up in `claude --resume` or a session scan.
/// - `tools: []` — no built-in tool at all.
/// - `strictMcpConfig: true` — none of the user's own MCP servers either
///   (codeg passes none), which also saves starting them.
/// - `title` — a session with a title of its own skips generating one, a
///   whole second request that would carry the entire prompt again.
///
/// `None` for every other agent: none of them takes such options.
pub(crate) fn session_meta(
    agent_type: AgentType,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut meta = crate::acp::connection::claude_raw_sdk_session_meta(agent_type, false)?;
    if let Some(serde_json::Value::Object(claude_code)) = meta.get_mut("claudeCode") {
        let options = claude_code
            .entry("options")
            .or_insert_with(|| serde_json::json!({}));
        if let serde_json::Value::Object(options) = options {
            options.insert("persistSession".to_string(), false.into());
            options.insert("tools".to_string(), serde_json::json!([]));
            options.insert("strictMcpConfig".to_string(), true.into());
            options.insert("title".to_string(), SESSION_TITLE.into());
        }
    }
    meta.insert("systemPrompt".to_string(), SYSTEM_PROMPT.into());
    Some(meta)
}

/// Where one-shot sessions run, recognised in a session list: a scan drops
/// every session whose working directory is the generation root or under it.
///
/// Both spellings of the root are matched, as configured and as the file
/// system resolves it, because an agent may record either (a data directory
/// under a symlink, macOS `/tmp` → `/private/tmp`).
pub struct GenerationPaths {
    roots: Vec<String>,
}

impl GenerationPaths {
    pub fn current() -> Self {
        let root = crate::paths::codeg_text_generation_root();
        let mut roots = vec![normalize_path_for_matching(&root.to_string_lossy())];
        if let Ok(real) = std::fs::canonicalize(&root) {
            let real = normalize_path_for_matching(&real.to_string_lossy());
            if !roots.contains(&real) {
                roots.push(real);
            }
        }
        Self { roots }
    }

    pub fn contains(&self, folder_path: &str) -> bool {
        let path = normalize_path_for_matching(folder_path);
        self.roots.iter().any(|root| {
            path == *root
                || path
                    .strip_prefix(root.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    }
}

/// What to run: the agent, the selections it is started with (applied before
/// the prompt, like any launch's preferences) and the prompt itself.
#[derive(Debug, Clone)]
pub struct OneShotRequest {
    pub agent_type: AgentType,
    pub mode_id: Option<String>,
    pub config_values: BTreeMap<String, String>,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OneShotError {
    /// The agent could not be started: disabled, not installed, or its
    /// process would not launch.
    #[error("{0}")]
    Unavailable(String),
    /// The agent started but gave no answer.
    #[error("{0}")]
    Failed(String),
    #[error("cancelled")]
    Cancelled,
}

/// Run `request` and return the agent's answer: the text of its reply after
/// its last tool call, untrimmed. See the module docs for how the session is
/// kept out of sight and unattended.
pub async fn run(
    manager: &ConnectionManager,
    db: &AppDatabase,
    data_dir: &Path,
    request: OneShotRequest,
    cancel: &CancellationToken,
) -> Result<String, OneShotError> {
    let OneShotRequest {
        agent_type,
        mode_id,
        config_values,
        prompt,
    } = request;
    let runtime_env =
        crate::commands::acp::build_session_runtime_env(db, agent_type, None, data_dir)
            .await
            .map_err(|e| OneShotError::Unavailable(e.to_string()))?;
    crate::commands::acp::verify_agent_installed(agent_type)
        .await
        .map_err(|e| OneShotError::Unavailable(e.to_string()))?;
    let cwd = crate::paths::codeg_text_generation_root();
    std::fs::create_dir_all(&cwd).map_err(|e| {
        OneShotError::Unavailable(format!("could not create {}: {e}", cwd.display()))
    })?;
    if cancel.is_cancelled() {
        return Err(OneShotError::Cancelled);
    }

    let connection_id = manager
        .spawn_agent(
            agent_type,
            Some(cwd.to_string_lossy().into_owned()),
            None,
            runtime_env,
            OWNER_LABEL.to_string(),
            EventEmitter::Noop,
            mode_id,
            config_values,
        )
        .await
        .map_err(|e| OneShotError::Unavailable(e.to_string()))?;
    let _guard = DisconnectOnDrop {
        manager: manager.clone_ref(),
        connection_id: connection_id.clone(),
    };
    // A stop that came while the agent was starting: never send it the prompt.
    if cancel.is_cancelled() {
        return Err(OneShotError::Cancelled);
    }
    let Some(state) = manager.get_state(&connection_id).await else {
        return Err(OneShotError::Failed(
            "the agent process ended while it was starting".to_string(),
        ));
    };
    // Subscribed under the read lock, so no event can slip between reading the
    // turn count and registering (see `ConnectionEventStream::subscribe`).
    let (mut rx, turns_before) = {
        let s = state.read().await;
        (s.event_stream().subscribe(), s.turns_completed)
    };
    manager
        .send_prompt(
            &connection_id,
            vec![PromptInputBlock::Text { text: prompt }],
        )
        .await
        .map_err(|e| OneShotError::Failed(e.to_string()))?;

    let mut last_error: Option<String> = None;
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Err(OneShotError::Cancelled),
            next = tokio::time::timeout(LIVENESS_INTERVAL, rx.recv()) => next,
        };
        let step = match next {
            Ok(Ok(envelope)) => {
                on_event(manager, &connection_id, &envelope.payload, &mut last_error).await
            }
            // Fell behind, or heard nothing for a while: the state says whether
            // the turn is over, and holds any permission card still waiting.
            Ok(Err(RecvError::Lagged(_))) | Err(_) => {
                match check_state(
                    manager,
                    &connection_id,
                    &state,
                    turns_before,
                    &mut last_error,
                )
                .await
                {
                    Some(step) => step,
                    None => continue,
                }
            }
            Ok(Err(RecvError::Closed)) => Step::Ended,
        };
        match step {
            Step::Continue => {}
            Step::TurnEnded(stop_reason) => {
                return answer(&state, &stop_reason, last_error).await;
            }
            Step::Ended => {
                // The connection can end right after the turn did, with the
                // `TurnComplete` still unread behind its `Disconnected`.
                let s = state.read().await;
                if s.turns_completed > turns_before && !s.turn_in_flight {
                    drop(s);
                    return answer(&state, "end_turn", last_error).await;
                }
                return Err(OneShotError::Failed(last_error.unwrap_or_else(|| {
                    "the agent process ended before it answered".to_string()
                })));
            }
        }
    }
}

enum Step {
    Continue,
    TurnEnded(String),
    Ended,
}

async fn on_event(
    manager: &ConnectionManager,
    connection_id: &str,
    event: &AcpEvent,
    last_error: &mut Option<String>,
) -> Step {
    match event {
        AcpEvent::TurnComplete { stop_reason, .. } => Step::TurnEnded(stop_reason.clone()),
        AcpEvent::StatusChanged {
            status: ConnectionStatus::Disconnected | ConnectionStatus::Error,
        } => Step::Ended,
        AcpEvent::Error {
            message, terminal, ..
        } => {
            *last_error = Some(message.clone());
            if *terminal {
                Step::Ended
            } else {
                Step::Continue
            }
        }
        AcpEvent::PermissionRequest {
            request_id,
            tool_call,
            options,
            ..
        } => {
            refuse(
                manager,
                connection_id,
                request_id,
                tool_call,
                options,
                last_error,
            )
            .await
        }
        AcpEvent::QuestionRequest { question_id, .. } => {
            // As if the card were dismissed: the agent goes on by its own
            // judgment.
            let _ = manager
                .answer_question(
                    connection_id,
                    question_id,
                    QuestionAnswer {
                        answers: Vec::new(),
                        declined: true,
                    },
                )
                .await;
            Step::Continue
        }
        AcpEvent::PlanApprovalRequest { approval_id, .. } => {
            let _ = manager
                .answer_plan_approval(
                    connection_id,
                    approval_id,
                    PlanApprovalAnswer {
                        decision: PlanApprovalDecision::Abandon,
                        feedback: None,
                    },
                )
                .await;
            Step::Continue
        }
        _ => Step::Continue,
    }
}

/// Refuse a permission request once, the way `codeg-cli run --permissions
/// deny` does. A request that offers no one-time refusal ends the run: the
/// only other ways to answer it would write a standing rule into the user's
/// agent settings.
async fn refuse(
    manager: &ConnectionManager,
    connection_id: &str,
    request_id: &str,
    tool_call: &serde_json::Value,
    options: &[PermissionOptionInfo],
    last_error: &mut Option<String>,
) -> Step {
    let tool_kind = tool_call.get("kind").and_then(|v| v.as_str());
    match decide_permission(PermissionPolicy::Deny, options, tool_kind) {
        PermissionDecision::Answer { option_id, .. } => {
            let _ = manager
                .respond_permission(connection_id, request_id, &option_id)
                .await;
            Step::Continue
        }
        PermissionDecision::AnswerThenFail { .. } | PermissionDecision::Leave => {
            let tool = tool_call
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|t| !t.is_empty())
                .unwrap_or("a tool");
            *last_error = Some(format!(
                "the agent asked to use {tool}, and the request could not be refused"
            ));
            Step::Ended
        }
    }
}

/// The backstop read of the connection's state, for when events may have been
/// missed: `Some` when the run is over, after answering whatever card is still
/// waiting (a permission, a question, a plan approval) the way [`on_event`]
/// would have.
async fn check_state(
    manager: &ConnectionManager,
    connection_id: &str,
    state: &Arc<RwLock<SessionState>>,
    turns_before: u64,
    last_error: &mut Option<String>,
) -> Option<Step> {
    let (ended, permission, question, plan) = {
        let s = state.read().await;
        (
            s.turns_completed > turns_before && !s.turn_in_flight,
            s.pending_permission
                .as_ref()
                .map(|p| AcpEvent::PermissionRequest {
                    request_id: p.request_id.clone(),
                    tool_call: p.tool_call.clone(),
                    options: p.options.clone(),
                    queued: p.queued,
                }),
            s.pending_question
                .as_ref()
                .map(|q| AcpEvent::QuestionRequest {
                    question_id: q.question_id.clone(),
                    questions: q.questions.clone(),
                }),
            s.pending_plan_approval
                .as_ref()
                .map(|p| AcpEvent::PlanApprovalRequest {
                    approval_id: p.approval_id.clone(),
                    tool_call_id: p.tool_call_id.clone(),
                    plan_markdown: String::new(),
                }),
        )
    };
    if ended {
        return Some(Step::TurnEnded("end_turn".to_string()));
    }
    if manager.get_state(connection_id).await.is_none() {
        return Some(Step::Ended);
    }
    for card in [permission, question, plan].into_iter().flatten() {
        if let Step::Ended = on_event(manager, connection_id, &card, last_error).await {
            return Some(Step::Ended);
        }
    }
    None
}

/// The turn's answer. A refusal, or a turn the agent cancelled on its own,
/// is not one even when it has text: that text explains why there is no
/// answer, and it becomes the error. A turn cut short by its token limit
/// keeps what it wrote — the caller shows it to someone who can finish it.
async fn answer(
    state: &Arc<RwLock<SessionState>>,
    stop_reason: &str,
    last_error: Option<String>,
) -> Result<String, OneShotError> {
    let text = state
        .read()
        .await
        .last_assistant_text
        .clone()
        .filter(|t| !t.trim().is_empty());
    match (stop_reason, text) {
        ("refusal" | "cancelled", text) => Err(OneShotError::Failed(
            text.or(last_error)
                .unwrap_or_else(|| format!("the agent ended its turn ({stop_reason})")),
        )),
        (_, Some(text)) => Ok(text),
        (_, None) => Err(OneShotError::Failed(last_error.unwrap_or_else(|| {
            format!("the agent ended its turn without an answer ({stop_reason})")
        }))),
    }
}

/// Ends the run's connection however the run ends — answered, failed,
/// cancelled, or dropped mid-wait by a caller that went away.
struct DisconnectOnDrop {
    manager: ConnectionManager,
    connection_id: String,
}

impl Drop for DisconnectOnDrop {
    fn drop(&mut self) {
        let manager = self.manager.clone_ref();
        let connection_id = std::mem::take(&mut self.connection_id);
        // `disconnect` only takes the map lock and queues a command, but it is
        // async and a drop cannot wait.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = manager.disconnect(&connection_id).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_sessions_get_no_tools_no_history_and_their_own_prompt() {
        let meta = session_meta(AgentType::ClaudeCode).expect("claude takes the meta");
        let options = &meta["claudeCode"]["options"];
        assert_eq!(options["persistSession"], serde_json::json!(false));
        assert_eq!(options["tools"], serde_json::json!([]));
        assert_eq!(options["strictMcpConfig"], serde_json::json!(true));
        assert_eq!(options["title"], serde_json::json!(SESSION_TITLE));
        assert_eq!(options["promptSuggestions"], serde_json::json!(false));
        assert_eq!(
            meta["claudeCode"]["emitRawSDKMessages"],
            serde_json::json!(true)
        );
        assert_eq!(meta["systemPrompt"], serde_json::json!(SYSTEM_PROMPT));
    }

    #[test]
    fn other_agents_get_no_meta() {
        assert!(session_meta(AgentType::Codex).is_none());
        assert!(session_meta(AgentType::OpenCode).is_none());
    }

    #[test]
    fn only_the_one_shot_label_is_one_shot() {
        assert!(is_one_shot_owner(OWNER_LABEL));
        assert!(!is_one_shot_owner("main"));
        assert!(!is_one_shot_owner("automation"));
    }

    fn state_with_answer(text: Option<&str>) -> Arc<RwLock<SessionState>> {
        let mut state = SessionState::new(
            "conn".to_string(),
            AgentType::ClaudeCode,
            None,
            OWNER_LABEL.to_string(),
            None,
        );
        state.last_assistant_text = text.map(str::to_string);
        Arc::new(RwLock::new(state))
    }

    #[tokio::test]
    async fn a_finished_turn_hands_back_its_text_even_when_cut_short() {
        let state = state_with_answer(Some("fix: a"));
        assert_eq!(
            answer(&state, "end_turn", None).await,
            Ok("fix: a".to_string())
        );
        assert_eq!(
            answer(&state, "max_tokens", None).await,
            Ok("fix: a".to_string())
        );
    }

    #[tokio::test]
    async fn a_refusal_is_an_error_carrying_the_agents_explanation() {
        let state = state_with_answer(Some("I can't help with that."));
        assert_eq!(
            answer(&state, "refusal", None).await,
            Err(OneShotError::Failed("I can't help with that.".to_string()))
        );
        let silent = state_with_answer(None);
        assert_eq!(
            answer(&silent, "cancelled", Some("boom".to_string())).await,
            Err(OneShotError::Failed("boom".to_string()))
        );
    }

    #[tokio::test]
    async fn a_turn_without_text_is_an_error() {
        let state = state_with_answer(Some("   "));
        assert_eq!(
            answer(&state, "end_turn", None).await,
            Err(OneShotError::Failed(
                "the agent ended its turn without an answer (end_turn)".to_string()
            ))
        );
    }

    #[test]
    fn generation_paths_match_the_root_and_below_only() {
        let paths = GenerationPaths {
            roots: vec!["/data/text-generation".to_string()],
        };
        assert!(paths.contains("/data/text-generation"));
        assert!(paths.contains("/data/text-generation/"));
        assert!(paths.contains("/data/text-generation/nested"));
        assert!(!paths.contains("/data/text-generation-other"));
        assert!(!paths.contains("/data"));
        assert!(!paths.contains("/repo"));
    }
}
