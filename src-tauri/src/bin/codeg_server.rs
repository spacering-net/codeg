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
    // This process's `codeg-cli` discovery file, for everything it starts: a
    // CLI run from one of its terminals or agents connects back to THIS
    // runtime, not to whichever else shares the data directory. Overrides a
    // value inherited from a runtime this one was started from.
    std::env::set_var(
        codeg_lib::cli_run::discovery::ENDPOINT_FILE_ENV,
        codeg_lib::cli_run::discovery::file_for(&resolved_data_dir, std::process::id()),
    );

    // The codeg-cli installed beside this server, for everything it starts
    // (`cli_run::shim`): the matching one, whatever else is on their PATH.
    if let Some(cli) = codeg_lib::update::runtime::self_exe()
        .parent()
        .map(|dir| dir.join(if cfg!(windows) { "codeg-cli.exe" } else { "codeg-cli" }))
        .filter(|p| p.metadata().is_ok_and(|m| m.is_file() && m.len() > 0))
    {
        std::env::set_var(codeg_lib::cli_run::shim::CLI_ENV, cli);
    }

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

    // The opt-in proxy-JWT authentication is all-or-nothing: a half-set or
    // misspelled configuration aborts here rather than serving with an
    // authentication the operator did not mean (see `web::proxy_auth`).
    let proxy_auth_config = match codeg_lib::web::proxy_auth::ProxyAuthConfig::from_env() {
        Ok(config) => config,
        Err(err) => {
            tracing::error!("[AUTH][FATAL] {err}; aborting startup.");
            return ExitCode::from(2);
        }
    };

    // Before anything opens the database (see `runtime_lock`): every server
    // shares the data directory, and waits while a `codeg-cli --standalone`
    // server has it — which itself takes it alone, or leaves untouched.
    let exclusive = std::env::var(codeg_lib::runtime_lock::EXCLUSIVE_ENV).is_ok_and(|v| v == "1");
    let _runtime_lock = match codeg_lib::runtime_lock::hold_for_server(&resolved_data_dir) {
        Ok(Some(lock)) => Some(lock),
        Ok(None) => {
            tracing::error!(
                "[SERVER] {} is in use by another codeg; a --standalone server needs it alone",
                resolved_data_dir.display()
            );
            return ExitCode::from(codeg_lib::runtime_lock::BUSY_EXIT_CODE);
        }
        Err(e) if exclusive => {
            tracing::error!(
                "[SERVER][FATAL] cannot take {} alone: {e}",
                resolved_data_dir.display()
            );
            return ExitCode::from(1);
        }
        Err(e) if codeg_lib::runtime_lock::locking_unsupported(&e) => {
            tracing::warn!(
                "[SERVER][WARN] {} cannot lock files ({e}); going on without, so a \
                 `codeg-cli --standalone` there would not see this server",
                resolved_data_dir.display()
            );
            None
        }
        Err(e) => {
            // Not run unlocked: a private server could be using the database.
            tracing::error!(
                "[SERVER][FATAL] cannot lock {} for this runtime: {e}",
                resolved_data_dir.display()
            );
            return ExitCode::from(1);
        }
    };

    // A `codeg-cli --standalone` server ends with the codeg-cli that started
    // it: its stdin closes when that process is gone, a crash included.
    if std::env::var(codeg_lib::runtime_lock::EXIT_ON_STDIN_EOF_ENV).is_ok_and(|v| v == "1") {
        let endpoint =
            codeg_lib::cli_run::discovery::file_for(&resolved_data_dir, std::process::id());
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdin = std::io::stdin();
            let mut sink = [0u8; 256];
            while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
            // No CLI may find this process once it is gone, and its broker
            // socket goes with it: `exit` runs no destructor to remove either.
            let _ = std::fs::remove_file(&endpoint);
            #[cfg(unix)]
            let _ = std::fs::remove_file(
                codeg_lib::acp::delegation::listener::default_socket_path(&std::env::temp_dir()),
            );
            std::process::exit(0);
        });
    }

    // `main` returns the worker's exit code so `_log_guard` drops here — after
    // the runtime finishes — flushing any buffered file logs on a clean exit.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime")
        .block_on(async_main(proxy_auth_config))
}

async fn async_main(
    proxy_auth_config: Option<codeg_lib::web::proxy_auth::ProxyAuthConfig>,
) -> ExitCode {
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
    let cli_runs = codeg_lib::cli_run::CliRunService::new(
        &db,
        &connection_manager,
        emitter.clone(),
        acp_event_bus.clone(),
        data_dir.clone(),
        codeg_lib::cli_run::wire::RuntimeKind::Server,
    );
    let cli_access = codeg_lib::cli_run::CliAccess::new(cli_runs.clone(), data_dir.clone());
    let delegation =
        codeg_lib::boot::DelegationStack::build(&connection_manager, &db.conn, &data_dir);
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
        pet_state: pet_state_handle,
        delegation_broker: delegation.broker.clone(),
        delegation_tokens: delegation.tokens.clone(),
        delegation_socket_path: delegation.socket_path.clone(),
        feedback_config: delegation.feedback.clone(),
        question_config: delegation.question.clone(),
        session_info_config: delegation.session_info.clone(),
        chat_authoring_config: delegation.chat_authoring.clone(),
        browser_tools_config: delegation.browser_tools.clone(),
        computer_tools_config: delegation.computer_tools.clone(),
        computer_service: std::sync::OnceLock::new(),
        system_op_lock: codeg_lib::app_state::default_system_op_lock(),
        update_state: codeg_lib::app_state::default_update_state(),
        cli_runs,
        cli_access,
    });
    // Logging phase 3: wire the emitter so the Logs viewer's live tail
    // (`logs://appended`) reaches WS clients.
    if let Some(hub) = codeg_lib::logging::hub::log_hub() {
        hub.set_emitter(state.emitter.clone());
    }

    // The daemon, started the same way the desktop app starts it (`boot`,
    // steps in its order); what sits between the steps here is what only the
    // server has.
    codeg_lib::boot::spawn_startup_housekeeping(&state.db.conn, &state.data_dir, &state.emitter);

    // Persisted terminal and tool settings into their live runtimes before
    // the delegation listener accepts and before the server takes a request,
    // so even the first companion launch sees the operator's configured
    // behavior.
    codeg_lib::boot::apply_persisted_settings(
        &state.db.conn,
        &state.connection_manager,
        &delegation,
    )
    .await;
    // Computer use: only where whoever runs this server says so, by
    // CODEG_COMPUTER_USE — the server's web clients then share this
    // machine's windows with agents, and Stop them, from the panel. Nothing
    // else here can: a web client holds the token, not the machine.
    if computer_use_requested() {
        let service = codeg_lib::commands::computer::ComputerService::start(
            codeg_lib::commands::computer::ComputerHost::Server {
                broadcaster: state.event_broadcaster.clone(),
                emitter: state.emitter.clone(),
            },
            state.computer_tools_config.clone(),
        );
        let _ = state.computer_service.set(service);
        eprintln!(
            "[SERVER] Computer use is offered (CODEG_COMPUTER_USE): this server's web clients \
             may share this machine's windows with agents."
        );
        if !has_desktop_session() {
            tracing::warn!(
                "[SERVER] CODEG_COMPUTER_USE is set, but this process does not look like it \
                 runs in a desktop session; computer use will report what stops it"
            );
        }
    }
    // A server an earlier install.ps1 put in %LOCALAPPDATA%\codeg shares that
    // folder with the desktop app once it is installed there too: each
    // install replaces the other's codeg-mcp.exe, codeg-computer-helper.exe
    // and web\. install.ps1 moves the server out.
    #[cfg(windows)]
    if std::env::current_exe().is_ok_and(|exe| beside_the_desktop_app(&exe)) {
        eprintln!(
            "[SERVER] This codeg-server is in the codeg desktop app's folder, where each \
             replaces the other's codeg-mcp.exe, codeg-computer-helper.exe and web\\. Re-run \
             install.ps1 to move it to %LOCALAPPDATA%\\codeg-server."
        );
    }
    let daemon = codeg_lib::boot::Daemon {
        conn: &state.db.conn,
        data_dir: &state.data_dir,
        connection_manager: &state.connection_manager,
        chat_channels: &state.chat_channel_manager,
        broadcaster: &state.event_broadcaster,
        bus: &state.acp_event_bus,
        emitter: &state.emitter,
        pet_state: &state.pet_state,
        delegation: &delegation,
    };
    codeg_lib::boot::start_delegation_service(
        &daemon,
        // No native webviews in this process: what a web user sees in a
        // "browser tab" is an iframe their own browser renders, which nothing
        // here can reach.
        Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs),
        // The screen this server runs on, where it is let share it
        // (`CODEG_COMPUTER_USE`); none otherwise.
        match state.computer_service.get() {
            Some(service) => Arc::new(codeg_lib::commands::computer::McpComputerTools::new(
                service.clone(),
            ))
                as Arc<dyn codeg_lib::acp::computer_tools::ComputerToolAccess>,
            None => Arc::new(codeg_lib::acp::computer_tools::NoComputerDesktop),
        },
    );
    // Awaited: every enabled channel has had its auto-connect attempt before
    // the server binds.
    codeg_lib::boot::start_chat_channels(&daemon).await;
    let daemon_services = codeg_lib::boot::spawn_daemon_services(&daemon);

    // Headless `codeg-cli` runs: the policy backstop here; the loopback
    // listener and its discovery file once the server has its own socket
    // (below), so a server that fails to start publishes none.
    state.cli_runs.spawn_background();

    // Sweep abandoned upload staging files from any prior run before
    // serving the first request. The quota log/validate ran earlier in
    // `main` so strict-mode misconfigurations abort before we touch
    // disk; no second log line here.
    codeg_lib::web::handlers::files::purge_upload_staging().await;

    // Build router
    let proxy_auth = match proxy_auth_config {
        None => None,
        Some(config) => match codeg_lib::web::proxy_auth::ProxyJwtAuth::new(config) {
            Ok(auth) => {
                let config = auth.config();
                tracing::info!(
                    "[AUTH] proxy-jwt on: header {}, issuer {}, audience {}, keys from {}",
                    config.header,
                    config.issuer,
                    config.audience,
                    config.jwks_url
                );
                auth.prime().await;
                Some(Arc::new(auth))
            }
            Err(err) => {
                tracing::error!("[AUTH][FATAL] proxy-jwt key client: {err}; aborting startup.");
                return ExitCode::from(1);
            }
        },
    };

    let shutdown_signal = state.web_server_state.shutdown_signal();
    let router = codeg_lib::web::router::build_router_with_proxy_auth(
        state.clone(),
        token.clone(),
        proxy_auth,
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

    // Command-line access, unless the setting is off. Every return after this
    // point stops it again (the serve error path and the end of `main`).
    state.cli_access.start_if_enabled(&state.db.conn).await;

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
        state.cli_access.stop().await;
        return ExitCode::from(1);
    }
    // No CLI may find this process once it is gone.
    state.cli_access.stop().await;
    // Graceful shutdown: release any live office watch preview servers
    // (kill_on_drop is the backstop, but this frees their ports promptly).
    daemon_services.stop();
    ExitCode::SUCCESS
}

/// Whether whoever runs this server lets it share the screen it runs on with
/// agents: `CODEG_COMPUTER_USE` set to 1, true, yes or on.
fn computer_use_requested() -> bool {
    computer_use_requested_by(std::env::var("CODEG_COMPUTER_USE").ok().as_deref())
}

/// [`computer_use_requested`], for the variable's value.
fn computer_use_requested_by(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// Whether this process looks like it runs where there is a screen: on
/// Linux, a display it can reach; elsewhere it is not told apart here (the
/// helper finds out, and says).
fn has_desktop_session() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
    } else {
        true
    }
}

/// Whether `exe` sits beside the desktop app's `codeg.exe`.
#[cfg(any(windows, test))]
fn beside_the_desktop_app(exe: &std::path::Path) -> bool {
    exe.parent()
        .is_some_and(|dir| dir.join("codeg.exe").is_file())
}

fn default_data_dir() -> PathBuf {
    dirs::data_dir()
        .map(|d| d.join("codeg"))
        .unwrap_or_else(|| PathBuf::from(".codeg-data"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the desktop app's own executable beside the server counts.
    #[test]
    fn a_server_beside_the_desktop_app_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("codeg-server.exe");
        std::fs::write(&exe, b"").unwrap();
        assert!(!beside_the_desktop_app(&exe));
        std::fs::write(dir.path().join("codeg-mcp.exe"), b"").unwrap();
        std::fs::create_dir(dir.path().join("codeg")).unwrap();
        assert!(!beside_the_desktop_app(&exe));
        std::fs::write(dir.path().join("codeg.exe"), b"").unwrap();
        assert!(beside_the_desktop_app(&exe));
    }

    /// Computer use is offered only when the variable says so in words —
    /// anything else, unset included, is no.
    #[test]
    fn computer_use_is_offered_only_when_asked_for() {
        for yes in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(computer_use_requested_by(Some(yes)), "{yes}");
        }
        for no in ["", "0", "false", "off", "no", "2", "enabled"] {
            assert!(!computer_use_requested_by(Some(no)), "{no}");
        }
        assert!(!computer_use_requested_by(None));
    }
}
