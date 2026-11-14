pub mod agent_mentions;
pub mod air_contract;
pub mod agent_process;
pub mod agent_session;
pub mod antigravity_login;
pub mod background_watch;
pub mod binary_cache;
pub mod browser_tools;
pub mod chat_authoring;
pub mod claude_model_picker;
pub mod codex_catalog_commit;
pub mod codex_catalog_refresh;
pub mod codex_catalog_source;
pub mod codex_context;
pub mod codex_endpoint_catalog;
pub mod codex_goal;
pub mod codex_model_catalog;
pub mod codex_runtime;
pub mod command_code;
pub mod computer_tools;
pub mod connection;
pub mod cursor_acp_retry_compat;
pub mod cursor_ext;
pub mod custom_registry;
pub mod delegation;
pub mod error;
pub mod event_stream;
pub mod feedback;
pub mod file_system_runtime;
pub mod fork;
pub mod host_tools_policy;
pub mod idle_sweep;
pub mod internal_bus;
pub mod js_text;
pub mod latest_release;
pub mod lifecycle;
pub mod manager;
pub mod minimax_code;
pub mod one_shot;
pub mod opencode_catalog;
pub(crate) mod opencode_config;
pub(crate) mod opencode_credentials;
pub mod opencode_launch;
pub mod opencode_plugins;
pub(crate) mod opencode_skills;
pub mod plan_approval;
pub mod preflight;
pub mod prompt_hydration;
pub mod provider_models;
pub mod question;
pub(crate) mod qoder;
pub mod registry;
pub mod remote_registry;
pub(crate) mod reported_usage;
pub mod result_tool;
pub mod scratch_dir;
pub mod service_error;
pub mod session_info;
pub mod session_title;
pub mod session_state;
pub mod stderr_tail;
pub mod temp_reclaim;
pub mod terminal_runtime;
pub mod trae;
pub mod types;
pub mod work_task_tools;
pub mod zcode;
pub(crate) mod zcode_turn;

pub use idle_sweep::{idle_sweep_task, idle_timeout_from_env, SWEEP_INTERVAL_SECS};
pub use internal_bus::{EventBusMetrics, EventBusMetricsSnapshot, InternalEventBus};
pub use lifecycle::lifecycle_subscriber_task;
pub use session_state::{LiveSessionSnapshot, SessionState};
// Re-export the inner types of LiveSessionSnapshot for downstream consumers; not all are
// directly named in Rust today (they ride along through the snapshot struct), so silence
// dead-import warnings rather than dropping them.
#[allow(unused_imports)]
pub use session_state::{
    LiveContentBlock, LiveMessage, PendingPermissionState, ToolCallOutput, ToolCallState,
    ToolCallStatus, ToolKind, UsageInfo,
};
pub use types::{
    user_blocks_from_prompt, AcpEvent, ConversationConnectionInfo, EventEnvelope, UserMessageBlock,
};

/// The session ids `session_id` carries forward — i.e. earlier sessions of the
/// SAME conversation, whose turns remain readable through `session_id`.
///
/// Feed this to [`crate::db::service::conversation_service::bind_external_id`]
/// so it can tell "this conversation continues under a new agent session" from
/// "an unrelated session landed on this row". The first is routine: when a
/// custom agent has forgotten a session, codeg opens a fresh one and links the
/// transcripts, and both the reader and the generic parser then treat the chain
/// as one conversation. Splitting there would clone the conversation in the
/// sidebar on every restart. The second is codeg#500, where the split is the
/// whole point.
///
/// Empty for agents with native history stores. Custom agents and ZCode
/// use Codeg transcripts and can carry continuation ancestors forward.
pub fn continued_session_ids(agent_type: crate::models::AgentType, session_id: &str) -> Vec<String> {
    if !agent_type.uses_acp_transcript() {
        return Vec::new();
    }
    crate::acp_transcript::continuation_ancestors(registry::registry_id_for(agent_type), session_id)
}

/// `CODEG_AUTO_APPROVE=1` turns codeg into the approver for every ACP child it
/// launches: a `session/request_permission` is answered with its `allow_once`
/// option instead of being raised as a card (#447).
///
/// Read from the process env, which every ACP child inherits, so the flag is
/// inherited rather than plumbed per-connection. Off unless the variable is
/// exactly `1`, `true` or `yes` — an unset or empty value keeps the ordinary
/// card flow.
///
/// This exists because some adapters cannot express an approval policy at all:
/// `deepseek-acp` 0.9.0 has no `set_mode`, no `availableModes`, and a
/// hard-coded allow-once / reject-once pair in its `approval/request` handler,
/// so a write tool call parked forever and its parent delegation waited on it.
pub fn auto_approve_enabled() -> bool {
    parse_auto_approve(std::env::var(crate::acp::AUTO_APPROVE_ENV).ok().as_deref())
}

/// The flag's whole reading of its value, split out so it is testable without
/// touching the process env (which is shared by every test in the binary).
///
/// `None` (unset) and any unrecognized string keep the card flow. Accepting
/// `1`/`true`/`yes` in any case is deliberate: the var is set by hand, in a
/// shell or an OS environment dialog, and a `TRUE` that silently did nothing
/// would be worse than the extra leniency.
fn parse_auto_approve(raw: Option<&str>) -> bool {
    matches!(
        raw.unwrap_or_default().trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

/// The env var [`auto_approve_enabled`] reads.
pub const AUTO_APPROVE_ENV: &str = "CODEG_AUTO_APPROVE";

/// The [`crate::acp::types::ToolApprovalInfo::origin`] an auto-approved
/// permission records.
pub const AUTO_APPROVE_ORIGIN: &str = "auto_approve";

/// The whole "should this card be auto-approved?" decision, split out so its
/// every branch is unit-testable without a live ACP connection.
///
/// `None` means "leave it on the card path"; `Some(id)` means "answer with this
/// option". Three gates, in the order the caller checks them:
///
/// 1. the flag must be on;
/// 2. the connection must NOT carry a `cli_run` tag — that tag marks a
///    headless `codeg-cli` run (or a delegation child that inherited it) whose
///    `--permissions` policy is authoritative, and answering here would
///    overrule `deny` / `reads` / `fail` / `wait`;
/// 3. the request must actually offer an `allow_once` option. Rejection
///    deliberately comes first in some adapters (claude-agent-acp 0.91.0
///    leads with it for `defaultToNo` calls), so this is a kind lookup, never
///    a positional one. `allow_always` alone is NOT enough: picking it would
///    write a standing rule into the user's own agent settings.
pub fn auto_approve_option(
    enabled: bool,
    cli_run_tagged: bool,
    options: &[crate::acp::types::PermissionOptionInfo],
) -> Option<String> {
    if !enabled || cli_run_tagged {
        return None;
    }
    crate::acp::types::PermissionOptionInfo::allow_once_in(options)
        .map(|o| o.option_id.clone())
}

#[cfg(test)]
mod auto_approve_flag_tests {
    use super::{auto_approve_option, parse_auto_approve, AUTO_APPROVE_ORIGIN};
    use crate::acp::types::PermissionOptionInfo;

    fn opt(id: &str, kind: &str) -> PermissionOptionInfo {
        PermissionOptionInfo {
            option_id: id.to_string(),
            name: id.to_string(),
            kind: kind.to_string(),
            meta: None,
        }
    }

    /// The enabled spellings. Case and surrounding whitespace are irrelevant
    /// because the value is typed by hand into a shell or an OS env dialog.
    #[test]
    fn recognises_the_enabled_spellings() {
        for raw in ["1", "true", "TRUE", "yes", " Yes ", "\ttrue\n"] {
            assert!(parse_auto_approve(Some(raw)), "{raw:?} must enable it");
        }
    }

    /// Everything else keeps the card flow. Unset is the important one: a
    /// machine that never set the variable must behave exactly as before, and
    /// an empty value is how a shell writes "set but blank".
    #[test]
    fn everything_else_leaves_the_card_flow_alone() {
        for raw in [None, Some(""), Some("   "), Some("0"), Some("false"), Some("no"), Some("on")] {
            assert!(
                !parse_auto_approve(raw),
                "{raw:?} must NOT enable auto-approval"
            );
        }
    }

    /// The origin string is a wire value the frontend's ApprovalChip matches on
    /// (`src/components/message/activity/approval-chip.tsx`). Changing it here
    /// without changing that file would silently render an unattended approval
    /// as a person's click.
    #[test]
    fn origin_is_the_string_the_frontend_expects() {
        assert_eq!(AUTO_APPROVE_ORIGIN, "auto_approve");
    }

    /// Regression for the review's "Preserve CLI permission policies" finding:
    /// a `cli_run` connection (a headless `codeg-cli` run, or a delegation
    /// child that inherited its tag) must keep the card path so its
    /// `--permissions` policy stays authoritative.
    #[test]
    fn cli_run_tagged_connection_is_never_auto_approved() {
        let opts = vec![opt("allow", "allow_once"), opt("deny", "reject_once")];
        assert_eq!(
            auto_approve_option(true, true, &opts),
            None,
            "the run's permission ceiling must win over CODEG_AUTO_APPROVE"
        );
    }

    /// The flag off is the default state of every machine that never set it.
    #[test]
    fn disabled_flag_keeps_the_card_path() {
        let opts = vec![opt("allow", "allow_once")];
        assert_eq!(auto_approve_option(false, false, &opts), None);
    }

    /// claude-agent-acp 0.91.0 leads with the rejection for `defaultToNo`
    /// calls. Selection is by kind, never by position.
    #[test]
    fn chooses_allow_once_even_when_rejection_comes_first() {
        let opts = vec![
            opt("reject-1", "reject_once"),
            opt("allow-1", "allow_once"),
        ];
        assert_eq!(
            auto_approve_option(true, false, &opts),
            Some("allow-1".to_string())
        );
    }

    /// `allow_always` alone must NOT be auto-picked: it would write a standing
    /// rule into the user's own agent settings. Fall through to the card.
    #[test]
    fn only_allow_always_available_falls_through_to_the_card() {
        let opts = vec![
            opt("always", "allow_always"),
            opt("reject", "reject_once"),
        ];
        assert_eq!(auto_approve_option(true, false, &opts), None);
    }

    /// An empty option list, and a list with no allow-kind at all, are both
    /// ordinary card cases — no panic, no approval invented.
    #[test]
    fn no_usable_option_falls_through_to_the_card() {
        assert_eq!(auto_approve_option(true, false, &[]), None);
        assert_eq!(
            auto_approve_option(true, false, &[opt("reject", "reject_once")]),
            None
        );
    }

    /// The happy path, once, to pin the returned id rather than just Some(_).
    #[test]
    fn enabled_non_cli_request_with_allow_once_is_answered() {
        let opts = vec![
            opt("allow-1", "allow_once"),
            opt("reject-1", "reject_once"),
        ];
        assert_eq!(
            auto_approve_option(true, false, &opts),
            Some("allow-1".to_string())
        );
    }
}
