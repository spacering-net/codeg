//! Health report for the codeg-mcp service, and the one action that can fix
//! it from the UI.
//!
//! "The codeg-mcp service" is really three things stacked, and a session loses
//! its codeg tools if ANY of them is missing:
//!
//!   1. the **companion binary** on disk — `codeg-mcp`, which the agent CLI
//!      spawns as a stdio MCP server (see `acp::connection::inject_codeg_mcp`);
//!   2. the **broker socket** inside this process, which every companion
//!      round-trips through (see `acp::delegation::service`);
//!   3. at least one **enabled tool group** — with all of them off, injection
//!      short-circuits before it even looks for the binary.
//!
//! Each fails differently and each is invisible today: a missing binary logs
//! one line at spawn time, a dead socket logs nothing at all, and "everything
//! is off in settings" looks identical to both from a conversation. This
//! module collapses the three into one [`CodegMcpServiceStatus`] the status-bar
//! indicator renders, with a single headline [`CodegMcpServiceState`] so the
//! popover can offer exactly one next step.
//!
//! Only #2 is startable from here — #1 needs a reinstall. #3 is a settings
//! write, which [`set_codeg_mcp_tool_group_core`] performs through the very
//! same `_core` setters the settings window uses.

// Only the Tauri command signatures (and the tests) name `Arc` directly; the
// `_core` helpers take plain references so both transports can share them.
#[cfg(any(test, feature = "tauri-runtime"))]
use std::sync::Arc;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::browser_tools::BrowserToolsRuntimeConfig;
use crate::acp::chat_authoring::ChatAuthoringRuntimeConfig;
use crate::acp::delegation::broker::DelegationBroker;
use crate::acp::delegation::listener::TokenRegistry;
use crate::acp::delegation::service;
use crate::acp::feedback::FeedbackRuntimeConfig;
use crate::acp::question::QuestionRuntimeConfig;
use crate::acp::session_info::SessionInfoRuntimeConfig;
use crate::app_error::AppCommandError;
use crate::web::event_bridge::EventEmitter;

/// Headline verdict. Ordered by which problem to solve first, not by severity:
/// the socket is the only piece this process can repair, so it outranks a
/// missing binary even though that one is more fundamental. Everything the
/// state hides is still reported field-by-field alongside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodegMcpServiceState {
    /// The broker socket isn't answering. Companions would launch and fail to
    /// reach codeg. Fixable here — see [`start_codeg_mcp_service_core`].
    Stopped,
    /// The socket is fine but the `codeg-mcp` binary isn't on disk, so nothing
    /// gets injected into an agent's MCP config. Needs a reinstall or
    /// `CODEG_MCP_BIN`; there is nothing to start.
    Unavailable,
    /// Everything is in place, but every tool group is switched off, so no
    /// companion is injected. Fixed in settings, not here.
    Disabled,
    /// Socket answering, binary present, at least one tool group live.
    Running,
}

/// One toggleable tool group, named by the `--features` slug the companion
/// parses. Sent as a list rather than a struct of bools so the popover can
/// render whatever the backend currently supports without a lockstep frontend
/// change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodegMcpToolGroup {
    pub key: String,
    pub enabled: bool,
    /// The slug this one is part of, when it is part of one: `browser_eval`
    /// is nothing on its own, and the runtime drops it whenever `browser` is
    /// off. Sent rather than hardcoded in the UI so the two surfaces that
    /// render this list cannot disagree about which switch gates which.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<String>,
}

impl CodegMcpToolGroup {
    fn group(key: &str, enabled: bool) -> Self {
        Self {
            key: key.to_string(),
            enabled,
            requires: None,
        }
    }

    fn within(key: &str, parent: &str, enabled: bool) -> Self {
        Self {
            key: key.to_string(),
            enabled,
            requires: Some(parent.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodegMcpServiceStatus {
    pub state: CodegMcpServiceState,
    /// Whether the broker socket answered a liveness ping just now.
    pub listening: bool,
    /// UDS path (unix) or named-pipe name (Windows) the companions dial.
    pub socket_path: String,
    /// Resolved `codeg-mcp` path, or `None` when the lookup came up empty.
    pub binary_path: Option<String>,
    /// Tool groups and their current switches, in companion `--features` order.
    pub tool_groups: Vec<CodegMcpToolGroup>,
    /// Companions currently holding a valid token, and how many distinct agent
    /// sessions they belong to.
    pub companion_count: u32,
    pub session_count: u32,
    /// Delegations parked on a child's turn right now.
    pub active_delegations: u32,
    /// Delegation chain depth ceiling, echoed so the popover doesn't need a
    /// second round trip to explain a refused `delegate_to_agent`.
    pub depth_limit: u32,
    /// Unix millis of the bind that produced the current accept loop.
    pub started_at: Option<i64>,
    /// Why the last bind attempt failed, when one did.
    pub last_error: Option<String>,
    /// Whether this process holds a service handle at all. `false` in runtimes
    /// that never bound a socket — the UI must hide the start button rather
    /// than offer one that can only fail.
    pub can_start: bool,
}

/// The runtime pieces a status report reads. Bundled into one struct because
/// they arrive from different places in each runtime (Tauri managed state vs
/// `AppState` fields) and seven positional `&` arguments of similar type is a
/// silent argument-swap waiting to happen.
pub struct CodegMcpStatusSources<'a> {
    pub broker: &'a DelegationBroker,
    pub tokens: &'a TokenRegistry,
    pub feedback: &'a FeedbackRuntimeConfig,
    pub question: &'a QuestionRuntimeConfig,
    pub session_info: &'a SessionInfoRuntimeConfig,
    pub authoring: &'a ChatAuthoringRuntimeConfig,
    pub browser: &'a BrowserToolsRuntimeConfig,
}

/// Build the report. Probes the socket for real (one ping round-trip), so
/// callers should treat this as a network-ish call, not a field read.
pub async fn codeg_mcp_service_status_core(
    sources: CodegMcpStatusSources<'_>,
) -> CodegMcpServiceStatus {
    let handle = service::current();
    // Without an installed handle there is no socket to probe and no way to
    // start one; report the configured path so the popover can still name what
    // it is talking about.
    let socket_path = handle
        .as_ref()
        .map(|s| s.socket_path().to_string_lossy().to_string())
        .unwrap_or_default();
    let listening = match handle.as_ref() {
        Some(s) => s.is_listening().await,
        None => false,
    };
    let snapshot = match handle.as_ref() {
        Some(s) => s.snapshot().await,
        None => Default::default(),
    };

    let binary_path = crate::acp::connection::locate_codeg_mcp_binary()
        .map(|p| p.to_string_lossy().to_string());

    let delegation_cfg = sources.broker.config_snapshot().await;
    let authoring_cfg = sources.authoring.snapshot().await;
    // Same order the companion's `CompanionFeatures::parse` recognizes. `tasks`
    // is deliberately absent: it is a per-spawn flag on task-engine launches,
    // not a setting anyone can toggle, so listing it here would invite the user
    // to look for a switch that doesn't exist.
    let browser_cfg = sources.browser.snapshot().await;
    let tool_groups = vec![
        CodegMcpToolGroup::group("delegation", delegation_cfg.enabled),
        CodegMcpToolGroup::group("feedback", sources.feedback.is_enabled().await),
        CodegMcpToolGroup::group("ask", sources.question.is_enabled().await),
        CodegMcpToolGroup::group("sessions", sources.session_info.is_enabled().await),
        CodegMcpToolGroup::group("automations", authoring_cfg.automations_enabled),
        CodegMcpToolGroup::group("taskboard", authoring_cfg.work_tasks_enabled),
        CodegMcpToolGroup::group("browser", browser_cfg.enabled),
        // `browser_eval` reports what the runtime would actually hand an
        // agent, which is the pair ANDed: a stored `true` under a group that
        // is off is not a switch anyone can act on, and showing it on would
        // say an agent may run code when none can.
        CodegMcpToolGroup::within(
            "browser_eval",
            "browser",
            browser_cfg.enabled && browser_cfg.eval,
        ),
    ];
    // Only the groups proper. A dependent switch cannot be on with its group
    // off, so counting them changes nothing today — but "is anything live"
    // is a question about groups, and an entry that could answer it on its
    // own would be a group.
    let any_group_enabled = tool_groups
        .iter()
        .any(|g| g.requires.is_none() && g.enabled);

    let state = if !listening {
        CodegMcpServiceState::Stopped
    } else if binary_path.is_none() {
        CodegMcpServiceState::Unavailable
    } else if !any_group_enabled {
        CodegMcpServiceState::Disabled
    } else {
        CodegMcpServiceState::Running
    };

    let token_stats = sources.tokens.stats().await;
    CodegMcpServiceStatus {
        state,
        listening,
        socket_path,
        binary_path,
        tool_groups,
        companion_count: token_stats.companions as u32,
        session_count: token_stats.parent_connections as u32,
        active_delegations: sources.broker.running_delegation_count().await as u32,
        depth_limit: delegation_cfg.depth_limit,
        started_at: snapshot.started_at,
        last_error: snapshot.last_error,
        can_start: handle.is_some(),
    }
}

/// The configs a tool-group toggle writes through. Deliberately not
/// [`CodegMcpStatusSources`]: a write needs neither the token registry (a
/// read-only census) nor, conversely, can it do without the database and the
/// event emitter that the read path never touches.
pub struct CodegMcpToolGroupTargets<'a> {
    pub broker: &'a DelegationBroker,
    pub feedback: &'a FeedbackRuntimeConfig,
    pub question: &'a QuestionRuntimeConfig,
    pub session_info: &'a SessionInfoRuntimeConfig,
    pub authoring: &'a ChatAuthoringRuntimeConfig,
    pub browser: &'a BrowserToolsRuntimeConfig,
}

/// Flip one tool group by the same slug [`codeg_mcp_service_status_core`]
/// reports.
///
/// This dispatches into each feature's own settings module rather than writing
/// the metadata keys itself, so the popover inherits the settings window's
/// clamping and its cross-window change events (a conversation's feedback bar
/// only learns the flag moved through that backend broadcast).
///
/// Every arm writes exactly the one key it owns. The whole-struct
/// `set_*_settings_core` writers are wrong here: `delegation` also carries
/// `depth_limit`, `completed_cache_max_mb` and the per-agent defaults, and
/// `automations`/`taskboard`, like `browser`/`browser_eval`, are two switches
/// over one record that sit one click apart in this very popover — a
/// read-modify-write of the pair loses whichever flip lands first. `feedback`,
/// `ask` and `sessions` each own a single-field record, so their existing
/// writer is already narrow.
pub async fn set_codeg_mcp_tool_group_core(
    conn: &DatabaseConnection,
    targets: CodegMcpToolGroupTargets<'_>,
    emitter: &EventEmitter,
    key: &str,
    enabled: bool,
) -> Result<(), AppCommandError> {
    use crate::commands::chat_authoring::ChatAuthoringFlag;
    use crate::commands::{
        browser_tools, chat_authoring, delegation, feedback, question, session_info,
    };

    match key {
        "delegation" => {
            delegation::set_delegation_enabled_core(conn, targets.broker, emitter, enabled).await?;
        }
        "feedback" => {
            feedback::set_feedback_settings_core(
                conn,
                targets.feedback,
                emitter,
                feedback::FeedbackSettings { enabled },
            )
            .await?;
        }
        "ask" => {
            question::set_question_settings_core(
                conn,
                targets.question,
                emitter,
                question::QuestionSettings { enabled },
            )
            .await?;
        }
        "sessions" => {
            session_info::set_session_info_settings_core(
                conn,
                targets.session_info,
                emitter,
                session_info::SessionInfoSettings { enabled },
            )
            .await?;
        }
        "browser" | "browser_eval" => {
            let flag = if key == "browser" {
                browser_tools::BrowserToolsFlag::Group
            } else {
                browser_tools::BrowserToolsFlag::Eval
            };
            browser_tools::set_browser_tools_flag_core(
                conn,
                targets.browser,
                emitter,
                flag,
                enabled,
            )
            .await?;
        }
        "automations" | "taskboard" => {
            let flag = if key == "automations" {
                ChatAuthoringFlag::Automations
            } else {
                ChatAuthoringFlag::WorkTasks
            };
            chat_authoring::set_chat_authoring_flag_core(
                conn,
                targets.authoring,
                emitter,
                flag,
                enabled,
            )
            .await?;
        }
        // A slug the backend never reports. Refusing beats writing nothing and
        // returning success, which would leave the popover's switch stuck in a
        // position no setting backs.
        other => {
            return Err(AppCommandError::configuration_invalid(format!(
                "unknown codeg-mcp tool group: {other}"
            )))
        }
    }
    Ok(())
}

/// Bind the broker socket if it isn't already answering. Idempotent — a click
/// on an already-healthy service is a no-op success, not an error, because the
/// UI's view of "stopped" can be a probe or two out of date.
pub async fn start_codeg_mcp_service_core() -> Result<(), AppCommandError> {
    let Some(handle) = service::current() else {
        return Err(AppCommandError::configuration_invalid(
            "codeg-mcp broker socket is not managed by this process",
        ));
    };
    handle
        .ensure_running()
        .await
        .map_err(AppCommandError::configuration_invalid)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_codeg_mcp_service_status(
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    #[cfg(feature = "tauri-runtime")] tokens: tauri::State<'_, Arc<TokenRegistry>>,
    #[cfg(feature = "tauri-runtime")] feedback: tauri::State<'_, FeedbackRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] question: tauri::State<'_, QuestionRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] session_info: tauri::State<'_, SessionInfoRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] authoring: tauri::State<'_, ChatAuthoringRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] browser: tauri::State<'_, BrowserToolsRuntimeConfig>,
) -> Result<CodegMcpServiceStatus, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(codeg_mcp_service_status_core(CodegMcpStatusSources {
            broker: broker.inner(),
            tokens: tokens.inner(),
            feedback: feedback.inner(),
            question: question.inner(),
            session_info: session_info.inner(),
            authoring: authoring.inner(),
            browser: browser.inner(),
        })
        .await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        // Server mode reaches this via the web handler, not this command.
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn start_codeg_mcp_service() -> Result<(), AppCommandError> {
    start_codeg_mcp_service_core().await
}

// Six runtime configs plus the db, the app handle and the two payload fields.
// Tauri injects managed state positionally, so these cannot be bundled the way
// `CodegMcpToolGroupTargets` bundles them for the `_core` helper below.
#[allow(clippy::too_many_arguments)]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_codeg_mcp_tool_group(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    #[cfg(feature = "tauri-runtime")] feedback: tauri::State<'_, FeedbackRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] question: tauri::State<'_, QuestionRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] session_info: tauri::State<'_, SessionInfoRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] authoring: tauri::State<'_, ChatAuthoringRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] browser: tauri::State<'_, BrowserToolsRuntimeConfig>,
    key: String,
    enabled: bool,
) -> Result<(), AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        // `app.emit` fans out to every window, so the settings window's own
        // switch for this group converges with the one just flipped here.
        let emitter = EventEmitter::Tauri(app);
        set_codeg_mcp_tool_group_core(
            &db.conn,
            CodegMcpToolGroupTargets {
                broker: broker.inner(),
                feedback: feedback.inner(),
                question: question.inner(),
                session_info: session_info.inner(),
                authoring: authoring.inner(),
                browser: browser.inner(),
            },
            &emitter,
            &key,
            enabled,
        )
        .await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = (key, enabled);
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::chat_authoring::ChatAuthoringConfig;
    use crate::acp::delegation::broker::{
        ConversationDepthLookup, DelegationBroker, DelegationConfig,
    };
    use crate::acp::delegation::listener::TokenEntry;
    use crate::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
    use crate::acp::delegation::types::DelegationError;
    use crate::acp::feedback::FeedbackConfig;
    use async_trait::async_trait;

    struct NoParent;
    #[async_trait]
    impl ConversationDepthLookup for NoParent {
        async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
            Ok(None)
        }
    }

    struct Fixture {
        broker: Arc<DelegationBroker>,
        tokens: Arc<TokenRegistry>,
        feedback: FeedbackRuntimeConfig,
        question: QuestionRuntimeConfig,
        session_info: SessionInfoRuntimeConfig,
        authoring: ChatAuthoringRuntimeConfig,
        browser: BrowserToolsRuntimeConfig,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                broker: Arc::new(DelegationBroker::new(
                    Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
                    Arc::new(NoParent) as Arc<dyn ConversationDepthLookup>,
                )),
                tokens: Arc::new(TokenRegistry::default()),
                feedback: FeedbackRuntimeConfig::new(),
                question: QuestionRuntimeConfig::new(),
                session_info: SessionInfoRuntimeConfig::new(),
                authoring: ChatAuthoringRuntimeConfig::new(),
                browser: BrowserToolsRuntimeConfig::new(),
            }
        }

        fn sources(&self) -> CodegMcpStatusSources<'_> {
            CodegMcpStatusSources {
                broker: &self.broker,
                tokens: &self.tokens,
                feedback: &self.feedback,
                question: &self.question,
                session_info: &self.session_info,
                authoring: &self.authoring,
                browser: &self.browser,
            }
        }

        async fn status(&self) -> CodegMcpServiceStatus {
            codeg_mcp_service_status_core(self.sources()).await
        }

        async fn set_group(
            &self,
            conn: &sea_orm::DatabaseConnection,
            key: &str,
            enabled: bool,
        ) -> Result<(), AppCommandError> {
            set_codeg_mcp_tool_group_core(
                conn,
                CodegMcpToolGroupTargets {
                    broker: &self.broker,
                    feedback: &self.feedback,
                    question: &self.question,
                    session_info: &self.session_info,
                    authoring: &self.authoring,
                    browser: &self.browser,
                },
                &EventEmitter::Noop,
                key,
                enabled,
            )
            .await
        }
    }

    /// No service handle is installed in unit tests, so every report here is
    /// the "socket down" branch — which is exactly the case that must never
    /// offer a start button it cannot honor.
    #[tokio::test]
    async fn reports_stopped_and_unstartable_without_an_installed_handle() {
        let f = Fixture::new();
        let status = f.status().await;
        assert_eq!(status.state, CodegMcpServiceState::Stopped);
        assert!(!status.listening);
        assert!(!status.can_start);
        assert!(start_codeg_mcp_service_core().await.is_err());
    }

    /// The socket verdict outranks the tool switches: turning every group on
    /// cannot make a dead socket read as running.
    #[tokio::test]
    async fn enabled_groups_do_not_override_a_dead_socket() {
        let f = Fixture::new();
        f.broker
            .set_config(DelegationConfig {
                enabled: true,
                ..DelegationConfig::default()
            })
            .await;
        f.feedback.set(FeedbackConfig { enabled: true }).await;
        assert_eq!(f.status().await.state, CodegMcpServiceState::Stopped);
    }

    #[tokio::test]
    async fn tool_groups_mirror_the_live_switches() {
        let f = Fixture::new();
        f.broker
            .set_config(DelegationConfig {
                enabled: true,
                depth_limit: 5,
                ..DelegationConfig::default()
            })
            .await;
        f.authoring
            .set(ChatAuthoringConfig {
                automations_enabled: true,
                work_tasks_enabled: false,
            })
            .await;

        let status = f.status().await;
        let group = |key: &str| {
            status
                .tool_groups
                .iter()
                .find(|g| g.key == key)
                .unwrap_or_else(|| panic!("missing group {key}"))
                .enabled
        };
        assert!(group("delegation"));
        assert!(group("automations"));
        assert!(!group("taskboard"));
        assert_eq!(status.depth_limit, 5);
        // `tasks` is per-spawn, never a switch — it must not appear.
        assert!(status.tool_groups.iter().all(|g| g.key != "tasks"));
    }

    /// `browser_eval` is reported as a switch of its own so both surfaces that
    /// render this list can show it — and reported as belonging to `browser`,
    /// so neither has to hardcode that relation. It never reads as on while
    /// the group is off, whatever the database says.
    #[tokio::test]
    async fn browser_eval_is_reported_under_the_group_it_belongs_to() {
        let f = Fixture::new();
        let row = |status: &CodegMcpServiceStatus, key: &str| {
            status
                .tool_groups
                .iter()
                .find(|g| g.key == key)
                .unwrap_or_else(|| panic!("missing group {key}"))
                .clone()
        };

        f.browser
            .set(crate::acp::browser_tools::BrowserToolsConfig {
                enabled: true,
                eval: true,
            })
            .await;
        let status = f.status().await;
        assert_eq!(row(&status, "browser").requires, None);
        assert_eq!(
            row(&status, "browser_eval").requires.as_deref(),
            Some("browser")
        );
        assert!(row(&status, "browser_eval").enabled);

        // The group off takes it with it — the runtime already drops it, and
        // a popover showing it on would be promising a tool nothing can call.
        f.browser
            .set(crate::acp::browser_tools::BrowserToolsConfig {
                enabled: false,
                eval: true,
            })
            .await;
        let status = f.status().await;
        assert!(!row(&status, "browser_eval").enabled);
        // And a dependent switch does not by itself make the service "live".
        assert_eq!(status.state, CodegMcpServiceState::Stopped);
        assert!(status
            .tool_groups
            .iter()
            .all(|g| !(g.requires.is_none() && g.enabled)));
    }

    /// `browser` and `browser_eval` are two keys of one record, one popover
    /// row apart. Each must move on its own: a writer that read the pair and
    /// wrote it back would silently revert whichever flip landed first.
    #[tokio::test]
    async fn the_two_browser_switches_do_not_clobber_each_other() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let f = Fixture::new();

        f.set_group(&db.conn, "browser", true).await.unwrap();
        f.set_group(&db.conn, "browser_eval", true).await.unwrap();
        let saved = crate::commands::browser_tools::load_browser_tools_settings(&db.conn).await;
        assert!(saved.enabled);
        assert!(saved.eval);

        // Turning eval off leaves the group alone...
        f.set_group(&db.conn, "browser_eval", false).await.unwrap();
        let saved = crate::commands::browser_tools::load_browser_tools_settings(&db.conn).await;
        assert!(saved.enabled, "the sibling must be untouched");
        assert!(!saved.eval);

        // ...and turning the group off does not erase the answer someone gave
        // about eval: it stops being live (the runtime drops it), and comes
        // back as they left it.
        f.set_group(&db.conn, "browser_eval", true).await.unwrap();
        f.set_group(&db.conn, "browser", false).await.unwrap();
        let saved = crate::commands::browser_tools::load_browser_tools_settings(&db.conn).await;
        assert!(!saved.enabled);
        assert!(saved.eval, "the stored answer survives the group going off");
        assert!(!f.browser.is_eval_enabled().await, "but nothing is live");
        f.set_group(&db.conn, "browser", true).await.unwrap();
        assert!(f.browser.is_eval_enabled().await);
    }

    /// The popover's per-group switches must go through the same writers the
    /// settings window uses, which means a toggle carries the sibling fields
    /// forward untouched. `delegation` is the sharp case: its record also holds
    /// `depth_limit` and the per-agent defaults, so a writer that sent a fresh
    /// struct would reset a user's configured depth on every switch flip.
    #[tokio::test]
    async fn toggling_delegation_preserves_the_rest_of_its_record() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let f = Fixture::new();
        crate::commands::delegation::set_delegation_settings_core(
            &db.conn,
            &f.broker,
            &EventEmitter::Noop,
            crate::commands::delegation::DelegationSettings {
                enabled: false,
                depth_limit: 4,
                ..Default::default()
            },
        )
        .await
        .unwrap();

        f.set_group(&db.conn, "delegation", true).await.unwrap();

        let saved = crate::commands::delegation::load_delegation_settings(&db.conn).await;
        assert!(saved.enabled, "the flip must land");
        assert_eq!(saved.depth_limit, 4, "the depth limit must survive it");
        // The broker is re-applied too, so the very next status read agrees.
        assert!(f.broker.config_snapshot().await.enabled);
    }

    /// `automations` and `taskboard` share one settings record, so each must
    /// carry the other across — the two switches sit adjacent in the popover
    /// and are the likeliest pair to be flipped in sequence.
    #[tokio::test]
    async fn the_two_authoring_switches_do_not_clobber_each_other() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let f = Fixture::new();

        f.set_group(&db.conn, "automations", true).await.unwrap();
        f.set_group(&db.conn, "taskboard", true).await.unwrap();

        let saved = crate::commands::chat_authoring::load_chat_authoring_settings(&db.conn).await;
        assert!(saved.automations_enabled);
        assert!(saved.work_tasks_enabled);

        f.set_group(&db.conn, "taskboard", false).await.unwrap();
        let saved = crate::commands::chat_authoring::load_chat_authoring_settings(&db.conn).await;
        assert!(saved.automations_enabled, "the sibling must be untouched");
        assert!(!saved.work_tasks_enabled);
    }

    /// The sharp version of the case above: the popover leaves every switch
    /// but the in-flight one live, so the two authoring toggles can genuinely
    /// be in flight together. A writer that read the pair, edited one field and
    /// wrote the pair back would drop whichever flip lost the race — both must
    /// survive regardless of interleaving.
    #[tokio::test]
    async fn concurrent_authoring_flips_both_survive() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let f = Fixture::new();

        let (a, b) = tokio::join!(
            f.set_group(&db.conn, "automations", true),
            f.set_group(&db.conn, "taskboard", true),
        );
        a.unwrap();
        b.unwrap();

        let saved = crate::commands::chat_authoring::load_chat_authoring_settings(&db.conn).await;
        assert!(saved.automations_enabled, "the automations flip was lost");
        assert!(saved.work_tasks_enabled, "the taskboard flip was lost");
        // The runtime config the companion actually reads must agree with the
        // database, not with whichever writer happened to finish last.
        let live = f.authoring.snapshot().await;
        assert!(live.automations_enabled && live.work_tasks_enabled);
    }

    /// The popover owns one bool per group. Flipping delegation must not
    /// republish the rest of that record, which the settings form owns.
    #[tokio::test]
    async fn toggling_delegation_does_not_republish_its_siblings() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let f = Fixture::new();
        crate::commands::delegation::set_delegation_settings_core(
            &db.conn,
            &f.broker,
            &EventEmitter::Noop,
            crate::commands::delegation::DelegationSettings {
                enabled: false,
                depth_limit: 4,
                ..Default::default()
            },
        )
        .await
        .unwrap();

        f.set_group(&db.conn, "delegation", true).await.unwrap();

        let saved = crate::commands::delegation::load_delegation_settings(&db.conn).await;
        assert!(saved.enabled);
        assert_eq!(saved.depth_limit, 4, "the depth limit must survive it");
    }

    /// Every slug the status report emits must be writable. A group added to
    /// the read side without a matching write arm would render a switch that
    /// errors on click, so pin the two lists together.
    #[tokio::test]
    async fn every_reported_group_is_toggleable() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let f = Fixture::new();
        for group in f.status().await.tool_groups {
            f.set_group(&db.conn, &group.key, true)
                .await
                .unwrap_or_else(|e| panic!("group {} is not writable: {e}", group.key));
        }
        // …and only those. An unknown slug is refused rather than silently
        // succeeding with nothing written.
        assert!(f.set_group(&db.conn, "tasks", true).await.is_err());
    }

    /// Two companions on one connection is one session, not two — the popover
    /// counts agent sessions, and re-injection can leave an old token behind.
    #[tokio::test]
    async fn counts_companions_and_distinct_sessions() {
        let f = Fixture::new();
        for token in ["t1", "t2"] {
            f.tokens
                .register(
                    token.into(),
                    TokenEntry {
                        parent_connection_id: "conn-a".into(),
                        working_dir: std::path::PathBuf::from("/tmp"),
                    },
                )
                .await;
        }
        f.tokens
            .register(
                "t3".into(),
                TokenEntry {
                    parent_connection_id: "conn-b".into(),
                    working_dir: std::path::PathBuf::from("/tmp"),
                },
            )
            .await;

        let status = f.status().await;
        assert_eq!(status.companion_count, 3);
        assert_eq!(status.session_count, 2);
    }
}
