//! Chat-authoring domain types — backing the `create_automation` and
//! `create_work_task` MCP tools.
//!
//! These are the first codeg-mcp tools that *write* app state: an agent talking
//! to the user in an ordinary chat can park recurring work as an automation, or
//! queue a task on the work-task board, without the user leaving the
//! conversation to fill in a form.
//!
//! This module holds the layer-shared pieces (mirroring
//! [`crate::acp::session_info`]):
//!   * [`NewAutomationSpec`] / [`NewWorkTaskSpec`] — the validated request the
//!     companion parsed out of the tool arguments.
//!   * [`AuthoringContext`] — who is asking (resolved by the listener from the
//!     per-launch token) so the target folder can default to the caller's own
//!     session.
//!   * [`AuthoringOutcome`] — the self-describing result delivered back over the
//!     broker socket, rendered by the companion without re-querying.
//!   * [`ChatAuthoringAccess`] — the listener-facing trait the production
//!     `DbChatAuthoring` (in `crate::commands::chat_authoring`) implements.
//!   * [`ChatAuthoringRuntimeConfig`] — the hot-swappable "is the feature on?"
//!     pair of flags, read BOTH at MCP injection time and again at call time
//!     (see the note on that type).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::models::AutomationAction;

/// Cap on an automation name / task title. Long enough for a descriptive
/// sentence, short enough that a board card and the automations list stay
/// readable. Over-long input is truncated, never rejected — the LLM's intent is
/// still honored.
pub const MAX_TITLE_CHARS: usize = 120;

/// Cap on the stored prompt body. Generous (a full task briefing is welcome)
/// but bounded so a runaway generation can't push a multi-megabyte blob into
/// the config JSON.
pub const MAX_PROMPT_CHARS: usize = 20_000;

/// Cap on how many files one `create_work_task` call may attach. A briefing
/// needs a few screenshots or logs, not a directory dump; more is rejected so
/// the LLM picks the ones that matter instead of silently losing the tail.
pub const MAX_WORK_TASK_ATTACHMENTS: usize = 10;

/// Cap on one attached image's bytes — the same ceiling the composer puts on a
/// dropped local image (`DRAG_DROP_IMAGE_MAX_BYTES`), since the bytes are stored
/// inline in the task exactly as that composer stores them.
pub const MAX_ATTACHMENT_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// Cap on the image bytes one task may carry in total. The images live inline in
/// the task row's config JSON (as base64), so this bounds the row.
pub const MAX_ATTACHMENT_IMAGE_TOTAL_BYTES: u64 = 40 * 1024 * 1024;

/// Who is calling, resolved by the listener from the per-launch token. Both
/// fields are hints for defaulting the target folder — an explicit
/// `folder_path` on the spec wins over either.
#[derive(Debug, Clone)]
pub struct AuthoringContext {
    /// The caller's current conversation (via `ParentSessionLookup`). `None`
    /// when the parent connection has no conversation yet.
    pub conversation_id: Option<i32>,
    /// The working directory the companion was launched with.
    pub working_dir: PathBuf,
    /// Whether codeg may read files on this caller's behalf (to store an
    /// attached image in the task). `false` when the caller hosts its own file
    /// access (`CODEG_ACP_HOST_TOOLS=agent`): codeg's process sits outside the
    /// agent's sandbox, so a read here would hand the agent bytes its sandbox
    /// denies it. Attachments are then only referenced by path, for the
    /// executing agent to read itself.
    pub host_reads_files: bool,
}

/// A validated `create_automation` request. The companion has already checked
/// the required strings are non-empty; ranges/enums are re-checked by the
/// automation service at save.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewAutomationSpec {
    pub name: String,
    pub prompt: String,
    /// 5- or 6-field cron. `None` → a manual-trigger automation (run from the
    /// Automations page on demand).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    /// IANA zone name. `None` → the host's detected zone (see
    /// [`local_timezone`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// What firing does: start a headless session, or queue a board task.
    #[serde(default)]
    pub action: AutomationAction,
    /// Agent wire slug. `None` → the target folder's default agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Absolute path of the target project. `None` → the caller's own folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    pub enabled: bool,
}

/// A validated `create_work_task` request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewWorkTaskSpec {
    pub title: String,
    pub prompt: String,
    /// Per-task agent override. `None` → inherit the board's settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Absolute path of the target project. `None` → the caller's own folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    /// Files to attach, as paths (a relative one is read against the caller's
    /// working directory). Images are read and stored inline; any other file is
    /// referenced by its path. At most [`MAX_WORK_TASK_ATTACHMENTS`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
}

/// The outcome handed back to the tool. A refusal (`created: false`) is a SOFT
/// result carrying a `note` the LLM reads and can act on — never a tool error,
/// so a disabled feature or an unresolvable folder doesn't derail the turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthoringOutcome {
    pub created: bool,
    /// What was created: `"automation"` or `"work_task"`. Always set, so the
    /// companion can phrase its text without knowing which arm it rendered.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// The stored cron, when the automation is scheduled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// First fire time, computed by the same evaluator the scheduler uses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<DateTime<Utc>>,
    /// Why it was refused, or an advisory on a successful create.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl AuthoringOutcome {
    /// A soft refusal: nothing was created, and `note` explains why in terms the
    /// LLM can act on (turn the setting on, pass `folder_path`, fix the cron…).
    pub fn rejected(kind: &str, note: impl Into<String>) -> Self {
        Self {
            created: false,
            kind: kind.to_string(),
            note: Some(note.into()),
            ..Default::default()
        }
    }
}

/// Listener-facing access for the two authoring tools. The production impl
/// (`crate::commands::chat_authoring::DbChatAuthoring`) re-checks the feature
/// flags, resolves the target folder, and writes through the same `*_create_core`
/// helpers the UI uses (so the board / automations list get their broadcasts and
/// the work-task pump its nudge). Kept as a trait so the listener stays
/// decoupled from the DB and tests can stub it. Mirrors
/// [`crate::acp::work_task_tools::WorkTaskToolAccess`].
#[async_trait]
pub trait ChatAuthoringAccess: Send + Sync {
    async fn create_automation(
        &self,
        ctx: AuthoringContext,
        spec: NewAutomationSpec,
    ) -> AuthoringOutcome;

    async fn create_work_task(
        &self,
        ctx: AuthoringContext,
        spec: NewWorkTaskSpec,
    ) -> AuthoringOutcome;
}

/// The two independently-toggled feature flags. Both default OFF: unlike the
/// read-only `get_session_info` / `ask_user_question` tools, these WRITE app
/// state and a scheduled automation goes on to spawn agents on its own, so the
/// user opts in explicitly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatAuthoringConfig {
    pub automations_enabled: bool,
    pub work_tasks_enabled: bool,
}

/// Shared, hot-swappable handle to [`ChatAuthoringConfig`]. Cloned into
/// `DelegationInjection` (read at injection, to build `--features`) and into
/// `AppState` (updated on save).
///
/// It is ALSO read again at call time by the production access impl. The
/// read-only tools get away with an injection-time-only check — their tools stay
/// listed for the life of an already-running session after the user flips the
/// setting off. For a tool that creates scheduled background work, "off" has to
/// mean off right now, so the write path re-reads this handle.
#[derive(Clone, Default)]
pub struct ChatAuthoringRuntimeConfig {
    inner: Arc<RwLock<ChatAuthoringConfig>>,
}

impl ChatAuthoringRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> ChatAuthoringConfig {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, cfg: ChatAuthoringConfig) {
        *self.inner.write().await = cfg;
    }

    pub async fn automations_enabled(&self) -> bool {
        self.inner.read().await.automations_enabled
    }

    pub async fn work_tasks_enabled(&self) -> bool {
        self.inner.read().await.work_tasks_enabled
    }
}

/// The host's IANA time zone (e.g. `Asia/Shanghai`), falling back to `UTC` when
/// the platform can't report one. Used as the default zone for a scheduled
/// automation so "every day at 9am" means 9am where the user actually is.
pub fn local_timezone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

/// Truncate to at most `cap` characters (character-, not byte-counted, so a
/// multi-byte name is never split mid-codepoint).
pub fn truncate_chars(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    s.chars().take(cap).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_is_soft_and_carries_note() {
        let out = AuthoringOutcome::rejected("automation", "turned off");
        assert!(!out.created);
        assert_eq!(out.kind, "automation");
        assert_eq!(out.note.as_deref(), Some("turned off"));
        assert!(out.id.is_none());
    }

    #[test]
    fn rejected_serializes_without_absent_option_fields() {
        let v = serde_json::to_value(AuthoringOutcome::rejected("work_task", "no folder")).unwrap();
        assert_eq!(v["created"], false);
        assert_eq!(v["kind"], "work_task");
        assert!(v.get("id").is_none());
        assert!(v.get("cron").is_none());
        assert!(v.get("note").is_some());
    }

    #[tokio::test]
    async fn runtime_config_round_trips_each_flag_independently() {
        let cfg = ChatAuthoringRuntimeConfig::new();
        assert!(!cfg.automations_enabled().await);
        assert!(!cfg.work_tasks_enabled().await);
        cfg.set(ChatAuthoringConfig {
            automations_enabled: true,
            work_tasks_enabled: false,
        })
        .await;
        assert!(cfg.automations_enabled().await);
        assert!(!cfg.work_tasks_enabled().await);
        assert_eq!(
            cfg.snapshot().await,
            ChatAuthoringConfig {
                automations_enabled: true,
                work_tasks_enabled: false,
            }
        );
    }

    #[test]
    fn local_timezone_is_non_empty() {
        assert!(!local_timezone().is_empty());
    }

    #[test]
    fn truncate_chars_respects_codepoints() {
        assert_eq!(truncate_chars("abc", 10), "abc");
        assert_eq!(truncate_chars("每日构建检查", 3), "每日构");
    }
}
