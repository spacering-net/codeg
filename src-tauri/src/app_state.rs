use std::path::PathBuf;
use std::sync::Arc;

use crate::acp::delegation::broker::DelegationBroker;
use crate::acp::delegation::listener::TokenRegistry;
use crate::acp::manager::ConnectionManager;
use crate::acp::InternalEventBus;
use crate::chat_channel::manager::ChatChannelManager;
use crate::db::AppDatabase;
use crate::pet_state_mapper::PetStateHandle;
use crate::terminal::manager::TerminalManager;
use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};
use crate::web::WebServerState;
use crate::workspace_transfer::WorkspaceTransferManager;

pub struct AppState {
    pub db: AppDatabase,
    pub connection_manager: ConnectionManager,
    pub terminal_manager: TerminalManager,
    pub event_broadcaster: Arc<WebEventBroadcaster>,
    /// Process-wide bus for typed `Arc<EventEnvelope>` delivery to
    /// in-process consumers (lifecycle, pet state mapper, chat-channel
    /// subscribers). Distinct from `event_broadcaster`, which carries
    /// JSON-shaped `WebEvent`s for transport-bound delivery.
    pub acp_event_bus: Arc<InternalEventBus>,
    pub emitter: EventEmitter,
    pub data_dir: PathBuf,
    pub web_server_state: WebServerState,
    pub chat_channel_manager: ChatChannelManager,
    pub workspace_transfer: Arc<WorkspaceTransferManager>,
    /// Latest ambient `PetState` written by `pet_state_subscriber_task`.
    /// Read by `pet_get_current_state` so a freshly-opened pet window can
    /// pick up the current state without waiting for the next transition.
    pub pet_state: PetStateHandle,
    /// Multi-agent delegation broker. Spawned in both desktop and server
    /// mode at startup; the UDS listener task forwards incoming companion
    /// requests here. v1 uses the default `DelegationConfig`; settings UI
    /// hot-swaps via `delegation_broker.set_config`.
    pub delegation_broker: Arc<DelegationBroker>,
    /// Per-launch ephemeral tokens identifying parent ACP connections.
    /// Registered when `load_mcp_servers_for_agent` injects the
    /// `codeg-mcp` MCP entry, revoked on parent teardown.
    pub delegation_tokens: Arc<TokenRegistry>,
    /// Absolute path of the UDS / named pipe the companion connects to.
    /// PID-scoped so multiple codeg processes on the same host don't fight.
    pub delegation_socket_path: PathBuf,
    /// Hot-swappable live-feedback (`check_user_feedback`) enable flag. Shared
    /// with the `DelegationInjection` so MCP injection reads it, and updated by
    /// the feedback settings command on save. Populated at startup by
    /// `apply_persisted_feedback_config`.
    pub feedback_config: crate::acp::feedback::FeedbackRuntimeConfig,
    /// Hot-swappable ask-user-question (`ask_user_question`) enable flag. Shared
    /// with the `DelegationInjection` so MCP injection reads it, and updated by
    /// the question settings command on save. Populated at startup by
    /// `apply_persisted_question_config`.
    pub question_config: crate::acp::question::QuestionRuntimeConfig,
    /// Hot-swappable get-session-info (`get_session_info`) enable flag. Shared
    /// with the `DelegationInjection` so MCP injection reads it, and updated by
    /// the session-info settings command on save. Populated at startup by
    /// `apply_persisted_session_info_config`.
    pub session_info_config: crate::acp::session_info::SessionInfoRuntimeConfig,
    /// Hot-swappable chat-authoring flags (`create_automation` /
    /// `create_work_task`). Shared with the `DelegationInjection` so MCP
    /// injection reads it, re-read by the authoring write path at call time, and
    /// updated by the chat-authoring settings command on save. Populated at
    /// startup by `apply_persisted_chat_authoring_config`.
    pub chat_authoring_config: crate::acp::chat_authoring::ChatAuthoringRuntimeConfig,
    /// Hot-swappable browser-tools (`browser_list_tabs` / `browser_snapshot`)
    /// enable flag. Shared with the `DelegationInjection` so MCP injection
    /// reads it, and re-read at call time by the access impl so switching it
    /// off reaches sessions that are already running. Populated at startup by
    /// `apply_persisted_browser_tools_config`. Carried in both runtimes even
    /// though only the desktop one has a browser: the status popover lists
    /// every group, and a flag that existed in one build only would be a
    /// second shape of `AppState` to keep in step.
    pub browser_tools_config: crate::acp::browser_tools::BrowserToolsRuntimeConfig,
    /// Serializes mutually-exclusive system operations — in-place
    /// self-update, restart, rollback — so a second click can't race a
    /// download/swap already in flight. Handlers `try_lock` and reject when
    /// held (an upgrade is already running).
    pub system_op_lock: Arc<tokio::sync::Mutex<()>>,
    /// Source of truth for an in-flight / completed app self-update, shared by
    /// the desktop (tauri-plugin-updater) and server (in-place swap) paths.
    /// The upgrade UI subscribes to it and re-syncs from a snapshot on mount,
    /// so download progress survives settings-page navigation and reloads.
    pub update_state: crate::update::AppUpdateStateHandle,
}

pub fn default_system_op_lock() -> Arc<tokio::sync::Mutex<()>> {
    Arc::new(tokio::sync::Mutex::new(()))
}

pub fn default_update_state() -> crate::update::AppUpdateStateHandle {
    crate::update::new_update_state_handle()
}

pub fn default_connection_manager() -> ConnectionManager {
    ConnectionManager::new()
}

pub fn default_terminal_manager() -> TerminalManager {
    TerminalManager::new()
}

pub fn default_chat_channel_manager() -> ChatChannelManager {
    ChatChannelManager::new()
}

/// Build the delegation broker + token registry + per-process UDS socket
/// path. Shared between codeg-server bootstrap and the Tauri `setup` block
/// so both modes apply identical depth limit + timeout defaults.
///
/// The listener task is _not_ spawned here — callers spawn it after they
/// own an `Arc<AppState>` (or the relevant pieces) so the listener can
/// borrow the long-lived state without circular Arc shenanigans.
pub fn build_delegation_stack(
    connection_manager: &ConnectionManager,
    db_conn: sea_orm::DatabaseConnection,
    data_dir: PathBuf,
) -> (
    Arc<DelegationBroker>,
    Arc<TokenRegistry>,
    PathBuf,
    crate::acp::feedback::FeedbackRuntimeConfig,
    crate::acp::question::QuestionRuntimeConfig,
    crate::acp::session_info::SessionInfoRuntimeConfig,
    crate::acp::chat_authoring::ChatAuthoringRuntimeConfig,
    crate::acp::browser_tools::BrowserToolsRuntimeConfig,
) {
    use crate::acp::connection::DelegationInjection;
    use crate::acp::delegation::broker::{
        ChildStatusLookup, ConversationDepthLookup, DbChildStatusLookup, DbDepthLookup,
    };
    use crate::acp::delegation::event_emitter::{
        ConnectionManagerEventEmitter, DelegationEventEmitter,
    };
    use crate::acp::delegation::listener::default_socket_path;
    use crate::acp::delegation::live_reply::{
        ChildLiveReplyLookup, ConnectionManagerLiveReplyLookup,
    };
    use crate::acp::delegation::meta_writer::{ConnectionManagerMetaWriter, DelegationMetaWriter};
    use crate::acp::delegation::spawner::ConnectionSpawner;
    use crate::acp::manager::ConnectionManagerSpawner;

    let cm_arc = Arc::new(connection_manager.clone_ref());
    let db_arc = Arc::new(AppDatabase {
        conn: db_conn.clone(),
    });
    let spawner = Arc::new(ConnectionManagerSpawner {
        manager: cm_arc.clone(),
        db: db_arc.clone(),
        data_dir: Arc::new(data_dir),
    }) as Arc<dyn ConnectionSpawner>;
    let depth_lookup =
        Arc::new(DbDepthLookup { db: db_arc.clone() }) as Arc<dyn ConversationDepthLookup>;
    let agent_availability = Arc::new(crate::acp::connection::DbAgentAvailabilityLookup {
        db: db_arc.clone(),
    })
        as Arc<dyn crate::acp::connection::AgentAvailabilityLookup>;
    let status_lookup = Arc::new(DbChildStatusLookup { db: db_arc }) as Arc<dyn ChildStatusLookup>;
    let meta_writer = Arc::new(ConnectionManagerMetaWriter {
        manager: cm_arc.clone(),
    }) as Arc<dyn DelegationMetaWriter>;
    let live_reply_lookup = Arc::new(ConnectionManagerLiveReplyLookup {
        manager: cm_arc.clone(),
    }) as Arc<dyn ChildLiveReplyLookup>;
    let event_emitter = Arc::new(ConnectionManagerEventEmitter { manager: cm_arc })
        as Arc<dyn DelegationEventEmitter>;
    let broker = Arc::new(
        DelegationBroker::with_writers(spawner, depth_lookup, meta_writer, event_emitter)
            .with_status_lookup(status_lookup)
            .with_live_reply_lookup(live_reply_lookup),
    );
    let tokens = Arc::new(TokenRegistry::default());
    let socket_path = default_socket_path(&std::env::temp_dir());
    let feedback = crate::acp::feedback::FeedbackRuntimeConfig::new();
    let ask = crate::acp::question::QuestionRuntimeConfig::new();
    let sessions = crate::acp::session_info::SessionInfoRuntimeConfig::new();
    let authoring = crate::acp::chat_authoring::ChatAuthoringRuntimeConfig::new();
    let browser = crate::acp::browser_tools::BrowserToolsRuntimeConfig::new();

    // Install the injection on the manager so spawn_agent picks it up
    // without an extra parameter at every call site.
    connection_manager.install_delegation(DelegationInjection {
        broker: broker.clone(),
        tokens: tokens.clone(),
        socket_path: socket_path.clone(),
        agent_availability,
        feedback: feedback.clone(),
        ask: ask.clone(),
        sessions: sessions.clone(),
        authoring: authoring.clone(),
        browser: browser.clone(),
        // Same backing manager as the listener's question lookup; used only by
        // the run_connection teardown guard to reclaim a parked ask.
        questions: Arc::new(crate::acp::manager::ConnectionManagerQuestionLookup {
            manager: Arc::new(connection_manager.clone_ref()),
        }) as Arc<dyn crate::acp::question::SessionQuestionAccess>,
        // Grok `exit_plan_mode` bridge — always wired (native plan mode, no
        // feature flag), same backing manager as the question lookup.
        plan_approvals: Arc::new(crate::acp::manager::ConnectionManagerPlanApprovalLookup {
            manager: Arc::new(connection_manager.clone_ref()),
        }) as Arc<dyn crate::acp::plan_approval::SessionPlanApprovalAccess>,
    });

    (
        broker, tokens, socket_path, feedback, ask, sessions, authoring, browser,
    )
}

impl AppState {
    /// Test-only constructor: build an `AppState` wired to an in-memory
    /// database and a `WebOnly` event emitter. Suitable for axum-test driven
    /// HTTP integration tests where no Tauri runtime is available.
    ///
    /// `data_dir` is a temp directory; handlers that touch it must use
    /// `tempfile::tempdir()` and pass the resulting path in.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn new_for_test(db: crate::db::AppDatabase, data_dir: PathBuf) -> Self {
        use crate::acp::{EventBusMetrics, InternalEventBus};
        use crate::web::event_bridge::WebEventBroadcaster;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let metrics = Arc::new(EventBusMetrics::default());
        let acp_event_bus = Arc::new(InternalEventBus::new(metrics));
        let emitter = EventEmitter::web_only(broadcaster.clone(), acp_event_bus.clone());

        let connection_manager = default_connection_manager();
        let (
            delegation_broker,
            delegation_tokens,
            delegation_socket_path,
            feedback_config,
            question_config,
            session_info_config,
            chat_authoring_config,
            browser_tools_config,
        ) = build_delegation_stack(&connection_manager, db.conn.clone(), data_dir.clone());

        Self {
            db,
            connection_manager,
            terminal_manager: default_terminal_manager(),
            event_broadcaster: broadcaster,
            acp_event_bus,
            emitter,
            data_dir,
            web_server_state: crate::web::WebServerState::new(),
            chat_channel_manager: default_chat_channel_manager(),
            workspace_transfer: Arc::new(
                crate::workspace_transfer::WorkspaceTransferManager::new_for_tests(
                    std::time::Duration::from_secs(60),
                ),
            ),
            pet_state: crate::pet_state_mapper::new_pet_state_handle(),
            delegation_broker,
            delegation_tokens,
            delegation_socket_path,
            feedback_config,
            question_config,
            session_info_config,
            chat_authoring_config,
            browser_tools_config,
            system_op_lock: default_system_op_lock(),
            update_state: default_update_state(),
        }
    }
}
