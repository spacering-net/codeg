use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use codeg_lib::app_state::AppState;
use codeg_lib::web::event_bridge::{EventEmitter, WebEventBroadcaster};
use codeg_lib::web::{
    addresses_for_bind, advertise_host, find_static_dir_standalone, resolve_persisted_server_token,
    WebServerState,
};

fn main() -> ExitCode {
    // Capture our own executable path before anything can rename it (an
    // in-place upgrade swaps the binary mid-run; `current_exe()` would then
    // resolve to a `" (deleted)"` path on Linux). Cheap, single-shot.
    codeg_lib::update::runtime::prime_self_exe();

    // Support --version flag
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    // `--supervise`: run as the process supervisor that owns the worker's
    // lifecycle (PID 1 in Docker). It spawns `codeg-server` without this
    // flag and relaunches it after an in-place upgrade. Never returns.
    if args.iter().any(|a| a == "--supervise") {
        // This mode never reaches init_server(); install a stderr-only
        // subscriber so the supervisor's diagnostics still reach Docker logs.
        let _log_guard = codeg_lib::logging::init::init_stderr_only();
        codeg_lib::supervise::run();
    }

    // When invoked as a git credential helper (by the script written via
    // `git_credential::create_credential_helper_script`), respond to git's
    // credential protocol on stdin and exit. Mirrors the desktop binary's
    // early-exit in `main.rs` so server deployments don't accidentally try
    // to start a second server instance per `git credential` invocation.
    if args.iter().any(|a| a == "--credential-helper") {
        // Subprocess mode, before init_server(): stderr-only subscriber so
        // helper diagnostics aren't dropped, while stdout stays the git
        // credential protocol channel.
        let _log_guard = codeg_lib::logging::init::init_stderr_only();
        codeg_lib::git_credential::run_credential_helper();
        return ExitCode::SUCCESS;
    }

    // PATH initialisation MUST happen before the tokio runtime is created.
    // std::env::set_var is not thread-safe (unsafe in Rust edition 2024);
    // #[tokio::main] would spawn worker threads before we reach this point.
    codeg_lib::process::ensure_node_in_path();
    codeg_lib::process::ensure_user_npm_prefix_in_path();

    // Resolve and pin `CODEG_DATA_DIR` before any threads exist.
    //
    // Two things matter here, both single-shot:
    //
    // 1. Absolutize: child processes (notably the credential helper
    //    subprocess invoked by git from inside the user's repo) inherit
    //    the env var and use it via `keyring_store::tokens_file_path` to
    //    find `tokens.json`. A relative `CODEG_DATA_DIR=data` would
    //    otherwise resolve against git's CWD, not the server's startup
    //    CWD, and the helper would silently miss the token file even
    //    though we found the database.
    //
    // 2. Fill in the default if unset, so every downstream resolver —
    //    `paths::codeg_uploads_root`, `paths::codeg_pets_root`,
    //    the credential subprocess — converges on the same root the
    //    server itself chose for the database. Without this, a default
    //    deployment (env var unset) puts the DB under
    //    `dirs::data_dir()/codeg` but uploads under `~/.codeg/uploads`,
    //    splitting the persistent surface across two filesystem roots
    //    and silently breaking single-volume backups, container mounts,
    //    and any `file://` URI in session history that points at an
    //    upload.
    //
    // `std::env::set_var` is not thread-safe (unsafe in Rust edition
    // 2024); doing this before the tokio runtime is built guarantees we
    // are still single-threaded.
    let resolved_data_dir = std::env::var("CODEG_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_data_dir());
    let resolved_data_dir = codeg_lib::git_credential::absolutize(&resolved_data_dir);
    std::env::set_var("CODEG_DATA_DIR", &resolved_data_dir);

    // Install the logging subscriber now that CODEG_DATA_DIR is pinned (the logs
    // dir resolves from it). Doing it here — before the first server diagnostic
    // below — captures even the CODEG_HOME warning and the FATAL upload-quota
    // abort. Hold the guard for the whole process so buffered file lines flush
    // on a graceful exit.
    let _log_guard = codeg_lib::logging::init::init_server();

    // `CODEG_HOME` overrides `CODEG_DATA_DIR` for uploads/pets inside
    // `paths::codeg_*_root` (legacy `~/.codeg/` layout). If both are set
    // and resolve to different roots, the database and uploads land on
    // different filesystems — a silent split. Warn loudly so the
    // operator notices before relying on a backup or volume mount that
    // only covers one of them.
    if let Some(home) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
        let home_path = codeg_lib::git_credential::absolutize(std::path::Path::new(&home));
        if home_path != resolved_data_dir {
            tracing::warn!(
                "[paths][WARN] CODEG_HOME ({}) and CODEG_DATA_DIR ({}) point at different roots. \
                 Uploads/pets follow CODEG_HOME; the database follows CODEG_DATA_DIR. \
                 Unset one or align them to avoid split state.",
                home_path.display(),
                resolved_data_dir.display()
            );
        }
    }

    // Strict-mode quota validation runs before any I/O. Failing fast
    // here means a misconfigured strict deployment never reaches the
    // tokio runtime, never binds a port, and never persists config —
    // the operator sees the FATAL line and a clean exit code 2.
    codeg_lib::web::handlers::files::log_upload_quota_config_at_startup();
    if let Err(err) = codeg_lib::web::handlers::files::validate_upload_quota_config() {
        tracing::error!("[uploads][FATAL] {err}; aborting startup.");
        // Return (don't process::exit) so `_log_guard` drops on the way out and
        // flushes the non-blocking file appender before the process ends.
        return ExitCode::from(2);
    }

    // `main` returns the worker's exit code so `_log_guard` drops here — after
    // the runtime finishes — flushing any buffered file logs on a clean exit.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime")
        .block_on(async_main())
}

async fn async_main() -> ExitCode {
    // Sweep stale ACP binary cache trash (rename-aside fallback artifacts).
    // Detached OS thread: cannot block startup, panics are caught and dropped,
    // errors are silenced, no subprocesses spawned.
    std::thread::spawn(|| {
        let _ = std::panic::catch_unwind(|| {
            codeg_lib::acp::binary_cache::migrate_legacy_root();
            codeg_lib::sweep_acp_binary_trash();
            codeg_lib::sweep_acp_scratch_dirs();
        });
    });

    let port: u16 = std::env::var("CODEG_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3080);
    let host = std::env::var("CODEG_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    // CODEG_DATA_DIR was already resolved and absolutized in `main()` so
    // all path resolvers across the process see the same root. Read it
    // back rather than re-deriving the default.
    let data_dir =
        PathBuf::from(std::env::var("CODEG_DATA_DIR").expect("CODEG_DATA_DIR set by main()"));
    let static_dir_env = std::env::var("CODEG_STATIC_DIR").ok();

    let static_dir = find_static_dir_standalone(static_dir_env.as_deref());
    let app_version = env!("CARGO_PKG_VERSION");

    // Staged-upgrade marker lifecycle. The marker is a proof token: it stays on
    // disk for the whole trial window so a second self-update is refused while
    // this freshly-swapped version is still unproven (re-swapping would clobber
    // the only good `.bak` and make a trial-failure rollback restore the
    // unproven version).
    if codeg_lib::update::runtime::is_supervised() {
        // Supervised trial: if this launch is the trial of a freshly-swapped
        // version (marker present), keep the marker until we have stayed up
        // past the trial window — at which point the upgrade is proven and the
        // marker is cleared so future updates are allowed again. The supervisor
        // only peeks at the marker to set probation; clearing is the worker's
        // job. If this version can't survive the window the supervisor rolls it
        // back first (which clears the marker), so this task never fires.
        if codeg_lib::update::install::upgrade_staged() {
            let trial = codeg_lib::update::runtime::upgrade_trial_secs();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(trial)).await;
                let _ = codeg_lib::update::install::take_upgrade_staged();
            });
        }
    } else {
        // Standalone (non-supervised) self-update re-execs this binary in place,
        // with no supervisor and thus no trial/rollback. Clear the marker on
        // startup so a re-exec'd upgrade doesn't leave it behind and block every
        // future update with "already staged".
        let _ = codeg_lib::update::install::take_upgrade_staged();
    }

    tracing::info!("[SERVER] codeg-server v{}", app_version);
    tracing::info!("[SERVER] Data directory: {}", data_dir.display());
    tracing::info!("[SERVER] Static directory: {}", static_dir.display());

    // Initialize database
    let db = codeg_lib::db::init_database(&data_dir, app_version)
        .await
        .expect("Failed to initialize database");

    // Logging phase 2: override the default level from the persisted
    // `logging.level` now that the DB is open. Phase 3 (wiring the emitter)
    // happens once AppState exists, below.
    codeg_lib::logging::init::apply_persisted_level(&db.conn).await;

    // Resolve the access token *after* the DB is up so a generated token can be
    // persisted and reused across restarts (a self-update restart must not
    // rotate it). An empty/whitespace CODEG_TOKEN is treated as unset.
    let mut token_generated = false;
    let token = resolve_persisted_server_token(
        &db.conn,
        std::env::var("CODEG_TOKEN").ok(),
        &mut token_generated,
    )
    .await;
    if token_generated {
        // Operator-facing startup notice on stderr ONLY: the access token is a
        // bearer credential and must never enter the durable log files or the
        // in-app log viewer. `eprintln!` bypasses the tracing sinks (file +
        // ring buffer); only the local terminal / Docker stderr sees it.
        eprintln!(
            "[SERVER] No CODEG_TOKEN set; generated an access token (persisted): {token}"
        );
        eprintln!("[SERVER] Pin your own by setting the CODEG_TOKEN environment variable.");
    }

    // Restore and apply saved system proxy settings before any network operation.
    // reqwest clients (including the LazyLock in check_app_update) cache the proxy
    // config at build time, so this must run before the first one is constructed.
    codeg_lib::init_proxy_from_db(&db.conn).await;

    // Reclaim orphaned chat scratch dirs (pre-send drafts that never bound to a
    // conversation, plus dirs left behind by deleted chat conversations).
    // Background, non-blocking; failures are logged but non-fatal.
    {
        let gc_conn = db.conn.clone();
        let gc_data_dir = data_dir.clone();
        tokio::spawn(async move {
            match codeg_lib::commands::conversations::gc_orphan_chat_dirs_core(
                &gc_conn,
                &gc_data_dir,
            )
            .await
            {
                Ok(n) if n > 0 => {
                    tracing::info!("[SERVER] chat-dir GC: reclaimed {n} orphan scratch dir(s)")
                }
                Ok(_) => {}
                Err(err) => tracing::error!("[SERVER] chat-dir GC failed: {err}"),
            }
        });
    }

    // Create shared broadcaster + internal ACP event bus.
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let event_bus_metrics = Arc::new(codeg_lib::acp::EventBusMetrics::default());
    let acp_event_bus = Arc::new(codeg_lib::acp::InternalEventBus::new(
        event_bus_metrics.clone(),
    ));
    let emitter = EventEmitter::web_only(broadcaster.clone(), acp_event_bus.clone());

    // Build AppState
    let pet_state_handle = codeg_lib::pet_state_mapper::new_pet_state_handle();
    let connection_manager = codeg_lib::app_state::default_connection_manager();
    let (
        delegation_broker,
        delegation_tokens,
        delegation_socket_path,
        feedback_config,
        question_config,
        session_info_config,
        chat_authoring_config,
        browser_tools_config,
    ) = codeg_lib::app_state::build_delegation_stack(
        &connection_manager,
        db.conn.clone(),
        data_dir.clone(),
    );
    let state = Arc::new(AppState {
        db,
        connection_manager,
        terminal_manager: codeg_lib::app_state::default_terminal_manager(),
        event_broadcaster: broadcaster,
        acp_event_bus: acp_event_bus.clone(),
        emitter,
        data_dir,
        web_server_state: WebServerState::new(),
        chat_channel_manager: codeg_lib::app_state::default_chat_channel_manager(),
        workspace_transfer: Arc::new(
            codeg_lib::workspace_transfer::WorkspaceTransferManager::new_from_env(),
        ),
        pet_state: pet_state_handle.clone(),
        delegation_broker: delegation_broker.clone(),
        delegation_tokens: delegation_tokens.clone(),
        delegation_socket_path: delegation_socket_path.clone(),
        feedback_config: feedback_config.clone(),
        question_config: question_config.clone(),
        session_info_config: session_info_config.clone(),
        chat_authoring_config: chat_authoring_config.clone(),
        browser_tools_config: browser_tools_config.clone(),
        system_op_lock: codeg_lib::app_state::default_system_op_lock(),
        update_state: codeg_lib::app_state::default_update_state(),
    });
    state
        .connection_manager
        .install_chat_channel(state.chat_channel_manager.clone_ref());

    // Logging phase 3: wire the emitter so the Logs viewer's live tail
    // (`logs://appended`) reaches WS clients.
    if let Some(hub) = codeg_lib::logging::hub::log_hub() {
        hub.set_emitter(state.emitter.clone());
    }

    // Apply persisted delegation settings (depth, enabled) before
    // the listener starts accepting so even the first companion request
    // sees the operator's configured behavior. Cancellation is handled
    // out-of-band via MCP `notifications/cancelled` — no broker-side
    // timeout to apply here.
    codeg_lib::commands::delegation::apply_persisted_config(&state.db.conn, &delegation_broker)
        .await;
    // Same for the live-feedback enable flag, so the first companion launch
    // sees the operator's configured behavior.
    codeg_lib::commands::feedback::apply_persisted_feedback_config(
        &state.db.conn,
        &feedback_config,
    )
    .await;
    // Same for the ask-user-question enable flag.
    codeg_lib::commands::question::apply_persisted_question_config(
        &state.db.conn,
        &question_config,
    )
    .await;
    // Same for the get-session-info enable flag.
    codeg_lib::commands::session_info::apply_persisted_session_info_config(
        &state.db.conn,
        &session_info_config,
    )
    .await;
    // Same for the chat-authoring flags, so the first companion launch knows
    // whether to advertise `create_automation` / `create_work_task`.
    codeg_lib::commands::chat_authoring::apply_persisted_chat_authoring_config(
        &state.db.conn,
        &chat_authoring_config,
    )
    .await;
    // And the browser-tools switch, so the popover reports it truthfully.
    // Server mode never advertises the group (there are no native tabs here),
    // but the flag is one setting shared by both runtimes.
    codeg_lib::commands::browser_tools::apply_persisted_browser_tools_config(
        &state.db.conn,
        &state.browser_tools_config,
    )
    .await;
    // Before accepting connections: keep ACP model terminal fallbacks aligned
    // with the same default-shell preference the built-in terminal uses, and
    // seed the command-color opt-in that every launch env is built from.
    let terminal_shell_config = state.connection_manager.terminal_shell_config();
    codeg_lib::commands::system_settings::apply_persisted_terminal_settings(
        &state.db.conn,
        &terminal_shell_config,
    )
    .await;

    // Spawn the delegation listener so companion processes can round-trip
    // through the broker. Path is PID-scoped, so the listener owns it for
    // the lifetime of the process.
    {
        let listener = codeg_lib::acp::delegation::listener::DelegationListener::new(
            delegation_broker,
            delegation_tokens,
            Arc::new(codeg_lib::acp::manager::ConnectionManagerParentLookup {
                manager: Arc::new(state.connection_manager.clone_ref()),
            }),
            Arc::new(codeg_lib::acp::manager::ConnectionManagerFeedbackLookup {
                manager: Arc::new(state.connection_manager.clone_ref()),
            }),
            Arc::new(codeg_lib::acp::manager::ConnectionManagerQuestionLookup {
                manager: Arc::new(state.connection_manager.clone_ref()),
            }),
            Arc::new(codeg_lib::commands::session_info::DbSessionInfoLookup::new(
                Arc::new(codeg_lib::db::AppDatabase {
                    conn: state.db.conn.clone(),
                }),
            )),
            Arc::new(codeg_lib::work_task::EngineWorkTaskTools),
            Arc::new(codeg_lib::commands::chat_authoring::DbChatAuthoring::new(
                Arc::new(codeg_lib::db::AppDatabase {
                    conn: state.db.conn.clone(),
                }),
                state.emitter.clone(),
                chat_authoring_config.clone(),
            )),
            // No native webviews in this process: what a web user sees in a
            // "browser tab" is an iframe their own browser renders, which
            // nothing here can reach.
            Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs),
        );
        // Bind through the service handle rather than a bare `listener.run`
        // spawn: it keeps the bind error and the accept-loop handle around, so
        // the workspace status indicator can report why the broker socket is
        // down and rebind it without restarting the server.
        let service = codeg_lib::acp::delegation::service::DelegationService::new(
            listener,
            delegation_socket_path.clone(),
        );
        codeg_lib::acp::delegation::service::install(service.clone());
        tokio::spawn(async move {
            if let Err(e) = service.start().await {
                tracing::error!("[delegation] listener failed to start: {e}");
            }
        });
    }

    // Install bundled expert skills into the central store
    // (`~/.codeg/skills/`). Runs in the background; failures are logged
    // but non-fatal.
    tokio::spawn(async move {
        let report = codeg_lib::commands::experts::ensure_central_experts_installed().await;
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

    // Install bundled scientific-research skills into the same central store.
    // Runs in the background; failures are logged but non-fatal.
    tokio::spawn(async move {
        let report = codeg_lib::commands::science::ensure_central_science_installed().await;
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

    // Start chat channel background tasks (event subscriber, command dispatcher, scheduler, auto-connect)
    state
        .chat_channel_manager
        .start_background(
            state.event_broadcaster.clone(),
            state.acp_event_bus.clone(),
            state.db.conn.clone(),
            state.data_dir.clone(),
            state.connection_manager.clone_ref(),
            state.emitter.clone(),
        )
        .await;

    // Spawn the LifecycleSubscriber for cross-connection DB writes. The
    // broker is supplied so TurnComplete on a delegation child resolves the
    // parent's pending `delegate_to_agent` tool_use_id and emits
    // `DelegationCompleted`.
    tokio::spawn(codeg_lib::lifecycle_subscriber_task(
        state.db.conn.clone(),
        state.connection_manager.clone_ref(),
        state.acp_event_bus.clone(),
        Some(state.delegation_broker.clone()),
    ));

    // Spawn the desktop pet state mapper so server-mode browsers viewing
    // /pet receive `pet://state` and `pet://oneshot` over the WebSocket
    // bridge, just like the Tauri webview does in desktop mode. ACP events
    // come through the typed bus; folder/app side-channels stay on the
    // JSON broadcaster.
    tokio::spawn(codeg_lib::pet_state_mapper::pet_state_subscriber_task(
        state.acp_event_bus.clone(),
        state.event_broadcaster.clone(),
        state.emitter.clone(),
        pet_state_handle,
    ));

    // Spawn the idle sweep so connections abandoned without an explicit
    // disconnect (e.g. browser tab closed, panic survivors) are reaped.
    // Override the 60-second default via `CODEG_ACP_IDLE_TIMEOUT_SECS`
    // (set to `0` to disable).
    if let Some(idle_timeout) = codeg_lib::idle_timeout_from_env() {
        tokio::spawn(codeg_lib::idle_sweep_task(
            state.connection_manager.clone_ref(),
            idle_timeout,
            std::time::Duration::from_secs(codeg_lib::SWEEP_INTERVAL_SECS),
        ));
    }

    // Reclaim scratch directories lost track of mid-session. Deliberately NOT
    // gated on `idle_timeout_from_env` like the sweep above: setting
    // `CODEG_ACP_IDLE_TIMEOUT_SECS=0` disables idle disconnects, not disk
    // reclamation.
    tokio::spawn(codeg_lib::scratch_sweep_task());

    // Office watch preview servers: reap dead children + ref0 stragglers.
    if let Some(idle_timeout) = codeg_lib::office_watch::idle_timeout_from_env() {
        tokio::spawn(codeg_lib::office_watch::office_watch_idle_sweep_task(
            idle_timeout,
            std::time::Duration::from_secs(codeg_lib::office_watch::SWEEP_INTERVAL_SECS),
        ));
    }

    // Automation engine (mirrors lib.rs setup): manual + scheduled fires,
    // event-bus completion, reconcile, boot recovery. One per process.
    if let Some(engine) = codeg_lib::automation::build_engine(
        codeg_lib::db::AppDatabase {
            conn: state.db.conn.clone(),
        },
        state.connection_manager.clone_ref(),
        state.emitter.clone(),
        state.acp_event_bus.clone(),
        state.data_dir.clone(),
    ) {
        tokio::spawn(codeg_lib::automation::run_automation_engine(engine));
    }

    // Work-task engine (mirrors lib.rs setup): manual pipeline, event-bus
    // settlement, merging git-truth recovery. One per process.
    if let Some(engine) = codeg_lib::work_task::build_task_engine(
        codeg_lib::db::AppDatabase {
            conn: state.db.conn.clone(),
        },
        state.connection_manager.clone_ref(),
        state.emitter.clone(),
        state.acp_event_bus.clone(),
        state.data_dir.clone(),
    ) {
        tokio::spawn(codeg_lib::work_task::run_task_engine(engine));
    }

    // Config-sync uploader (mirrors lib.rs setup): sleeps a minute, then
    // compares the configuration's hash every interval and uploads only when
    // it changed. Does nothing at all until a WebDAV endpoint is configured.
    {
        let db_for_sync = state.db.conn.clone();
        let emitter = std::sync::Arc::new(state.emitter.clone());
        tokio::spawn(async move {
            codeg_lib::commands::config_sync::auto_sync::run_auto_sync_loop(
                db_for_sync,
                emitter,
                codeg_lib::commands::config_sync::APP_VERSION.to_string(),
            )
            .await;
        });
    }

    // Label worktree folders registered before aliases were seeded at creation
    // with the branch they have checked out (mirrors lib.rs setup). Background;
    // changed folders are broadcast, so a browser that already fetched its
    // folder list still picks them up.
    {
        let db = codeg_lib::db::AppDatabase {
            conn: state.db.conn.clone(),
        };
        let emitter = state.emitter.clone();
        tokio::spawn(async move {
            let n =
                codeg_lib::commands::folders::backfill_worktree_folder_aliases(&emitter, &db).await;
            if n > 0 {
                tracing::info!("[folders] labeled {n} worktree folder(s) by branch");
            }
        });
    }

    // Sweep abandoned upload staging files from any prior run before
    // serving the first request. The quota log/validate ran earlier in
    // `main` so strict-mode misconfigurations abort before we touch
    // disk; no second log line here.
    codeg_lib::web::handlers::files::purge_upload_staging().await;

    // Build router
    let shutdown_signal = state.web_server_state.shutdown_signal();
    let router = codeg_lib::web::router::build_router(
        state.clone(),
        token.clone(),
        static_dir,
        shutdown_signal,
    );

    // Bind
    let addr = format!("{}:{}", host, port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(e) => {
            tracing::error!("[SERVER] Failed to bind {}: {}", addr, e);
            return ExitCode::from(1);
        }
    };

    if let Err(e) = codeg_lib::web::socket_inherit::mark_listener_non_inheritable(&listener) {
        tracing::warn!(
            "[SERVER][WARN] failed to mark listener non-inheritable: {}",
            e
        );
    }

    let local_addr = listener.local_addr().ok();
    let actual_port = local_addr.map(|a| a.port()).unwrap_or(port);
    // `CODEG_HOST` may be `localhost` or a bracketed IPv6 (`[::1]`); advertise
    // the concrete IP the socket bound to, not the raw config string.
    let advertised_host = advertise_host(local_addr, &host);

    // Publish runtime state so the settings page (served by us) shows
    // the truth — running on `actual_port` with this token — instead of
    // the placeholder "stopped" that triggers the stale-port banner.
    state
        .web_server_state
        .mark_externally_running(advertised_host.clone(), actual_port, token.clone());
    let addresses = addresses_for_bind(&advertised_host, actual_port);

    // Token on stderr ONLY (bearer credential — keep it out of the log files
    // and the in-app viewer); the bind addresses are safe to log normally.
    eprintln!("[SERVER] Token: {}", token);
    // Port bridge for dev servers on this host (web-mode built-in browser):
    // bound where our own socket is, on the ports after ours unless
    // CODEG_BRIDGE_PORTS says otherwise — or nothing of its own at all when
    // CODEG_BRIDGE_HOST_PATTERN names the targets by hostname on this port.
    let bridge =
        codeg_lib::web::browser_bridge::BridgeConfig::from_env(&advertised_host, actual_port);
    match &bridge {
        Some(config) => tracing::info!(
            "[SERVER] Port bridge for dev servers: {}",
            codeg_lib::web::describe_bridge(config)
        ),
        None => tracing::info!(
            "[SERVER] Port bridge for dev servers: {}",
            codeg_lib::web::BRIDGE_OFF
        ),
    }
    codeg_lib::web::browser_bridge::configure(bridge);

    tracing::info!("[SERVER] Listening on:");
    for addr in &addresses {
        tracing::info!("  {}", addr);
    }

    // Start serving
    if let Err(e) = axum::serve(listener, router).await {
        tracing::error!("[SERVER] Server error: {}", e);
        return ExitCode::from(1);
    }
    // Graceful shutdown: release any live office watch preview servers
    // (kill_on_drop is the backstop, but this frees their ports promptly).
    codeg_lib::office_watch::stop_all_office_watches();
    ExitCode::SUCCESS
}

fn default_data_dir() -> PathBuf {
    dirs::data_dir()
        .map(|d| d.join("codeg"))
        .unwrap_or_else(|| PathBuf::from(".codeg-data"))
}
