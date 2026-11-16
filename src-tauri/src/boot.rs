//! The daemon's startup, shared by both runtimes that host one: the desktop
//! app (`lib.rs`, the Tauri `setup` hook) and `codeg-server`
//! (`bin/codeg_server.rs`).
//!
//! Before this module each of the two carried its own copy of the same steps,
//! kept in step by "mirrors lib.rs setup" comments. Everything a daemon does
//! whatever hosts it lives here now; what stays with the hosts is what only
//! one of them has:
//!
//! * the desktop app: the tray, windows, deep links, the updater, the close
//!   behavior, the pet panel, native browser tabs, computer use on the screen
//!   it runs on, the optional embedded web server, the startup sweep of the
//!   ACP binary cache;
//! * `codeg-server`: binding the HTTP listener, the access token, proxy-JWT,
//!   computer use only when asked for, the upload staging purge.
//!
//! Both also keep building their own `codeg-cli` run service, which each
//! constructs at a different point (managed Tauri state vs. a field of the
//! server's `AppState`).
//!
//! The steps are in the order a host calls them:
//!
//! 1. [`spawn_startup_housekeeping`]: background cleanups and installs.
//! 2. [`DelegationStack::build`]: the broker and the per-tool runtime configs.
//! 3. [`apply_persisted_settings`]: stored settings into those live configs
//!    (and the terminal's), before anything can start an agent.
//! 4. The host's computer-use service, if any (it reads the configs from 3).
//! 5. [`start_delegation_service`]: the broker's socket for companions.
//! 6. [`start_chat_channels`]: chat-channel background tasks and auto-connect.
//! 7. [`spawn_daemon_services`]: the long-lived background services; the
//!    returned [`DaemonServices`] stops what has to be stopped at exit.
//!
//! Nothing here touches Tauri: events go out through [`EventEmitter`], which
//! the desktop app builds over its `AppHandle` and the server over its web
//! broadcaster. Every function that spawns must be called inside a tokio
//! runtime context (the server's `#[tokio::main]` runtime, or the desktop's
//! `tauri::async_runtime::block_on`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sea_orm::DatabaseConnection;

use crate::acp::browser_tools::{BrowserToolAccess, BrowserToolsRuntimeConfig};
use crate::acp::chat_authoring::ChatAuthoringRuntimeConfig;
use crate::acp::computer_tools::{ComputerToolAccess, ComputerToolsRuntimeConfig};
use crate::acp::delegation::broker::DelegationBroker;
use crate::acp::delegation::listener::TokenRegistry;
use crate::acp::feedback::FeedbackRuntimeConfig;
use crate::acp::manager::ConnectionManager;
use crate::acp::question::QuestionRuntimeConfig;
use crate::acp::session_info::SessionInfoRuntimeConfig;
use crate::acp::InternalEventBus;
use crate::chat_channel::manager::ChatChannelManager;
use crate::db::AppDatabase;
use crate::pet_state_mapper::PetStateHandle;
use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};

/// The pieces of a running daemon both hosts own, borrowed from wherever the
/// host keeps them (Tauri managed state, or the server's `AppState`).
pub struct Daemon<'a> {
    pub conn: &'a DatabaseConnection,
    pub data_dir: &'a Path,
    pub connection_manager: &'a ConnectionManager,
    pub chat_channels: &'a ChatChannelManager,
    pub broadcaster: &'a Arc<WebEventBroadcaster>,
    pub bus: &'a Arc<InternalEventBus>,
    pub emitter: &'a EventEmitter,
    pub pet_state: &'a PetStateHandle,
    pub delegation: &'a DelegationStack,
}

impl Daemon<'_> {
    fn db(&self) -> AppDatabase {
        AppDatabase {
            conn: self.conn.clone(),
        }
    }
}

/// Step 1. Background cleanups and installs that need nothing else running:
/// the periodic scratch-directory sweep, the bundled expert and science
/// skills, orphaned chat scratch directories, and branch labels for worktree
/// folders registered before those were seeded. All detached; failures are
/// logged and never fatal.
pub fn spawn_startup_housekeeping(
    conn: &DatabaseConnection,
    data_dir: &Path,
    emitter: &EventEmitter,
) {
    // Reclaim scratch directories this process loses track of mid-session.
    // Its own timer on purpose: the ACP idle sweep is not spawned at all when
    // `CODEG_ACP_IDLE_TIMEOUT_SECS=0`, and turning off idle disconnects must
    // not also turn off disk reclamation on a machine leaking gigabytes per
    // launch.
    tokio::spawn(crate::scratch_sweep_task());

    // Bundled expert skills into the central store (`~/.codeg/skills/`).
    tokio::spawn(async move {
        let report = crate::commands::experts::ensure_central_experts_installed().await;
        if !report.errors.is_empty() {
            tracing::error!(
                "[Experts] install finished with {} error(s): {:?}",
                report.errors.len(),
                report.errors
            );
        } else {
            tracing::info!(
                "[Experts] install ok: installed={} updated={} pending_review={}",
                report.installed_count,
                report.updated_count,
                report.pending_user_review.len()
            );
        }
    });

    // Bundled scientific-research skills into the same central store.
    tokio::spawn(async move {
        let report = crate::commands::science::ensure_central_science_installed().await;
        if !report.errors.is_empty() {
            tracing::error!(
                "[Science] install finished with {} error(s): {:?}",
                report.errors.len(),
                report.errors
            );
        } else {
            tracing::info!(
                "[Science] install ok: installed={} updated={} pending_review={}",
                report.installed_count,
                report.updated_count,
                report.pending_user_review.len()
            );
        }
    });

    // Orphaned chat scratch dirs: pre-send drafts that never bound to a
    // conversation, plus dirs left behind by deleted chat conversations.
    // Anything still in use is left for next startup.
    {
        let conn = conn.clone();
        let data_dir = data_dir.to_path_buf();
        tokio::spawn(async move {
            match crate::commands::conversations::gc_orphan_chat_dirs_core(&conn, &data_dir).await {
                Ok(n) if n > 0 => tracing::info!(
                    "[conversations] chat-dir GC: reclaimed {n} orphan scratch dir(s)"
                ),
                Ok(_) => {}
                Err(err) => tracing::error!("[conversations] chat-dir GC failed: {err}"),
            }
        });
    }

    // Worktree folders registered before aliases were seeded at creation get
    // the branch they have checked out, so the sidebar names them by branch
    // rather than by their (long, derived) directory. Changed folders are
    // broadcast, so a client that already fetched its folder list still picks
    // them up.
    {
        let db = AppDatabase { conn: conn.clone() };
        let emitter = emitter.clone();
        tokio::spawn(async move {
            let n = crate::commands::folders::backfill_worktree_folder_aliases(&emitter, &db).await;
            if n > 0 {
                tracing::info!("[folders] labeled {n} worktree folder(s) by branch");
            }
        });
    }
}

/// Step 2. The delegation broker, its token registry and socket path, and the
/// live runtime config of every tool group a companion can be offered. The
/// broker's listener is started later ([`start_delegation_service`]), once
/// the host holds what it borrows.
#[derive(Clone)]
pub struct DelegationStack {
    pub broker: Arc<DelegationBroker>,
    pub tokens: Arc<TokenRegistry>,
    pub socket_path: PathBuf,
    pub feedback: FeedbackRuntimeConfig,
    pub question: QuestionRuntimeConfig,
    pub session_info: SessionInfoRuntimeConfig,
    pub chat_authoring: ChatAuthoringRuntimeConfig,
    pub browser_tools: BrowserToolsRuntimeConfig,
    pub computer_tools: ComputerToolsRuntimeConfig,
}

impl DelegationStack {
    pub fn build(
        connection_manager: &ConnectionManager,
        conn: &DatabaseConnection,
        data_dir: &Path,
    ) -> Self {
        let (
            broker,
            tokens,
            socket_path,
            feedback,
            question,
            session_info,
            chat_authoring,
            browser_tools,
            computer_tools,
        ) = crate::app_state::build_delegation_stack(
            connection_manager,
            conn.clone(),
            data_dir.to_path_buf(),
        );
        Self {
            broker,
            tokens,
            socket_path,
            feedback,
            question,
            session_info,
            chat_authoring,
            browser_tools,
            computer_tools,
        }
    }
}

/// Step 3. Stored settings into their live runtimes, before anything can
/// start an agent: the default shell and command-color flag every launch env
/// is built from, then the delegation depth/enable flags and each tool
/// group's switches (so even the first companion sees the configured
/// behavior), then the generative-UI skill's central copy (before any command
/// runs, so its one-time move from 0.35.0's `json-render` can never undo a
/// change made on the settings page).
pub async fn apply_persisted_settings(
    conn: &DatabaseConnection,
    connection_manager: &ConnectionManager,
    delegation: &DelegationStack,
) {
    crate::commands::system_settings::apply_persisted_terminal_settings(
        conn,
        &connection_manager.terminal_shell_config(),
    )
    .await;
    crate::commands::delegation::apply_persisted_config(conn, &delegation.broker).await;
    crate::commands::feedback::apply_persisted_feedback_config(conn, &delegation.feedback).await;
    crate::commands::question::apply_persisted_question_config(conn, &delegation.question).await;
    crate::commands::session_info::apply_persisted_session_info_config(
        conn,
        &delegation.session_info,
    )
    .await;
    crate::commands::chat_authoring::apply_persisted_chat_authoring_config(
        conn,
        &delegation.chat_authoring,
    )
    .await;
    crate::commands::browser_tools::apply_persisted_browser_tools_config(
        conn,
        &delegation.browser_tools,
    )
    .await;
    crate::commands::computer_tools::apply_persisted_computer_tools_config(
        conn,
        &delegation.computer_tools,
    )
    .await;
    crate::commands::generative_ui::install_generative_ui_skill(conn).await;
}

/// Step 5. Bind the delegation broker's socket so companion processes can
/// round-trip through it. `browser` and `computer` are the host's: native
/// browser tabs and the screen exist only where it has them.
///
/// Bound through the service handle rather than a bare `listener.run` spawn:
/// it keeps the bind error and the accept-loop handle around, so the
/// workspace status indicator can report why the broker socket is down and
/// rebind it without a restart.
pub fn start_delegation_service(
    daemon: &Daemon<'_>,
    browser: Arc<dyn BrowserToolAccess>,
    computer: Arc<dyn ComputerToolAccess>,
) {
    use crate::acp::manager::{
        ConnectionManagerFeedbackLookup, ConnectionManagerParentLookup,
        ConnectionManagerQuestionLookup,
    };

    let manager = || Arc::new(daemon.connection_manager.clone_ref());
    let listener = crate::acp::delegation::listener::DelegationListener::new(
        daemon.delegation.broker.clone(),
        daemon.delegation.tokens.clone(),
        Arc::new(ConnectionManagerParentLookup { manager: manager() }),
        Arc::new(ConnectionManagerFeedbackLookup { manager: manager() }),
        Arc::new(ConnectionManagerQuestionLookup { manager: manager() }),
        Arc::new(crate::commands::session_info::DbSessionInfoLookup::new(
            Arc::new(daemon.db()),
        )),
        Arc::new(crate::work_task::EngineWorkTaskTools),
        Arc::new(crate::commands::chat_authoring::DbChatAuthoring::new(
            Arc::new(daemon.db()),
            daemon.emitter.clone(),
            daemon.delegation.chat_authoring.clone(),
        )),
        browser,
        computer,
        Arc::new(crate::acp::result_tool::ConnectionManagerResultLookup { manager: manager() }),
    );
    let service = crate::acp::delegation::service::DelegationService::new(
        listener,
        daemon.delegation.socket_path.clone(),
    );
    crate::acp::delegation::service::install(service.clone());
    tokio::spawn(async move {
        if let Err(e) = service.start().await {
            tracing::error!("[delegation] listener failed to start: {e}");
        }
    });
}

/// Step 6. Chat channels: hand the manager to the connection manager, then
/// start the event subscribers, command dispatcher, daily-report scheduler,
/// and auto-connect every enabled channel. The hand-over comes first: a
/// `/new` that landed before it would write its live ACP title against an
/// `install_chat_channel` that hasn't happened yet, and skip the topic rename
/// for good (the later reconciliation passes only sync titles their own
/// conditional UPDATE wrote, and this one already converged).
///
/// Resolves once auto-connect has been attempted for every channel. The
/// desktop app spawns it (no window waits on a network round-trip); the
/// server awaits it before it binds.
pub fn start_chat_channels(
    daemon: &Daemon<'_>,
) -> impl std::future::Future<Output = ()> + Send + 'static {
    daemon
        .connection_manager
        .install_chat_channel(daemon.chat_channels.clone_ref());
    let channels = daemon.chat_channels.clone_ref();
    let broadcaster = daemon.broadcaster.clone();
    let bus = daemon.bus.clone();
    let conn = daemon.conn.clone();
    let data_dir = daemon.data_dir.to_path_buf();
    let manager = daemon.connection_manager.clone_ref();
    let emitter = daemon.emitter.clone();
    async move {
        channels
            .start_background(broadcaster, bus, conn, data_dir, manager, emitter)
            .await;
    }
}

/// Step 7. The long-lived background services:
///
/// * the LifecycleSubscriber (cross-connection DB writes off the emit hot
///   path; resolves a delegation child's pending `delegate_to_agent` with the
///   broker, which is why it comes after [`DelegationStack::build`]);
/// * the pet state mapper (`pet://state` / `pet://oneshot`, to a webview or a
///   `/pet` browser alike);
/// * the ACP idle sweep and the office-watch preview sweep;
/// * the automation engine; the work-task engine and, only beside it, the
///   repository panel's auto-processing (it mints tasks unattended). One of
///   each per process;
/// * the config-sync uploader;
/// * the Codex model list refresher.
pub fn spawn_daemon_services(daemon: &Daemon<'_>) -> DaemonServices {
    // `subscribe()` runs synchronously inside the task constructor, before
    // the future is returned, so subscribe-before-spawn holds.
    tokio::spawn(crate::acp::lifecycle_subscriber_task(
        daemon.conn.clone(),
        daemon.connection_manager.clone_ref(),
        daemon.bus.clone(),
        Some(daemon.delegation.broker.clone()),
    ));

    // ACP events come through the typed bus; folder/app side-channels stay on
    // the JSON broadcaster.
    tokio::spawn(crate::pet_state_mapper::pet_state_subscriber_task(
        daemon.bus.clone(),
        daemon.broadcaster.clone(),
        daemon.emitter.clone(),
        daemon.pet_state.clone(),
    ));

    // Connections abandoned without an explicit disconnect (window or tab
    // closed without teardown, panic survivors) are reaped. Override the
    // 60-second default via `CODEG_ACP_IDLE_TIMEOUT_SECS` (`0` disables).
    if let Some(idle_timeout) = crate::acp::idle_timeout_from_env() {
        tokio::spawn(crate::acp::idle_sweep_task(
            daemon.connection_manager.clone_ref(),
            idle_timeout,
            std::time::Duration::from_secs(crate::acp::SWEEP_INTERVAL_SECS),
        ));
    }

    // Office watch preview servers: reap dead children + ref0 stragglers
    // (live previews are never swept). Override via
    // `CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS` (`0` disables).
    if let Some(idle_timeout) = crate::office_watch::idle_timeout_from_env() {
        tokio::spawn(crate::office_watch::office_watch_idle_sweep_task(
            idle_timeout,
            std::time::Duration::from_secs(crate::office_watch::SWEEP_INTERVAL_SECS),
        ));
    }

    // Automation engine: drives manual + scheduled fires, settles runs off
    // the event bus, reconciles, and recovers on boot.
    if let Some(engine) = crate::automation::build_engine(
        daemon.db(),
        daemon.connection_manager.clone_ref(),
        daemon.emitter.clone(),
        daemon.bus.clone(),
        daemon.data_dir.to_path_buf(),
    ) {
        tokio::spawn(crate::automation::run_automation_engine(engine));
    }

    // Work-task engine: drives the todo→…→done pipeline, settles runs off the
    // event bus, recovers merges from git truth on boot. The repository
    // panel's auto-processing mints tasks unattended, so it runs only where
    // the task engine does — the one process holding this data directory's
    // task lock.
    if let Some(engine) = crate::work_task::build_task_engine(
        daemon.db(),
        daemon.connection_manager.clone_ref(),
        daemon.emitter.clone(),
        daemon.bus.clone(),
        daemon.data_dir.to_path_buf(),
    ) {
        tokio::spawn(crate::work_task::run_task_engine(engine));
        if let Some(processor) = crate::forge::auto::build(daemon.db(), daemon.emitter.clone()) {
            tokio::spawn(crate::forge::auto::run(processor));
        }
    }

    // Config-sync uploader: sleeps a minute, then compares the
    // configuration's hash every interval and uploads only when it changed;
    // reads its settings every tick, so toggling sync takes effect without a
    // restart. Does nothing at all until a WebDAV endpoint is configured.
    {
        let conn = daemon.conn.clone();
        let emitter = Arc::new(daemon.emitter.clone());
        tokio::spawn(async move {
            crate::commands::config_sync::auto_sync::run_auto_sync_loop(
                conn,
                emitter,
                crate::commands::config_sync::APP_VERSION.to_string(),
            )
            .await;
        });
    }

    // Keeps the Codex model list codeg published current (a provider list
    // past its age, a codex upgraded outside codeg) and clears what a release
    // left behind.
    if let Some(scheduler) = crate::acp::codex_catalog_refresh::build(daemon.emitter.clone()) {
        tokio::spawn(crate::acp::codex_catalog_refresh::run(scheduler));
    }

    DaemonServices { _private: () }
}

/// Handle on what [`spawn_daemon_services`] started that outlives a dropped
/// task: child processes, which no runtime shutdown reaches.
#[must_use = "call `stop` at exit, or the office-watch preview servers outlive the daemon"]
#[derive(Clone)]
pub struct DaemonServices {
    _private: (),
}

impl DaemonServices {
    /// Release the office-watch preview servers (`kill_on_drop` is the
    /// backstop, but this frees their ports promptly). Idempotent.
    pub fn stop(&self) {
        crate::office_watch::stop_all_office_watches();
    }
}
