// The ACP connection driver (`acp::connection`) wraps the enormous
// `run_connection` future in a `block_on(async move { … })` frame whose type
// layout nests deep enough to blow rustc's default query depth of 128 (it
// overflowed by ~130 when computing the async block's layout). This is a
// compile-time type-recursion knob, unrelated to any runtime limit — bump it
// so the giant future's layout resolves. See the big-stack thread in
// `acp/connection.rs` for the sibling *runtime* mitigation of the same frame.
#![recursion_limit = "256"]

pub mod acp;
pub mod acp_transcript;
pub use acp::{
    idle_sweep_task, idle_timeout_from_env, lifecycle_subscriber_task, SWEEP_INTERVAL_SECS,
};
pub use acp::scratch_dir::scratch_sweep_task;
pub use network::proxy::init_proxy_from_db;
mod app_error;
pub mod app_state;
pub mod automation;
pub mod backgrounds;
/// Built-in browser. Only its wire types and its grant rules compile in server
/// mode — see `browser/mod.rs` for why those two, and only those two.
pub mod browser;
pub mod chat_channel;
pub mod commands;
pub mod db;
pub mod deep_link;
pub mod folder_links;
pub mod forge;
pub mod git_credential;
pub mod git_repo;
pub mod intern;
pub mod keyring_store;
pub mod logging;
pub mod models;
mod network;
pub mod office_watch;
pub mod parsers;
pub mod paths;
pub mod pet_sessions;
pub mod pet_state_mapper;
pub mod pets;
#[cfg(feature = "tauri-runtime")]
pub mod preferences;
pub mod process;
pub mod supervise;
mod terminal;
pub mod turn_timings;
pub mod update;
pub mod web;
pub mod work_task;
pub mod workspace_state;
pub mod workspace_transfer;

/// Sweep stale ACP binary cache trash created by the rename-aside fallback in
/// `acp::binary_cache::clear_agent_cache`. Safe to call any time; intended to
/// be invoked once at startup from a detached OS thread. Does not block, does
/// not panic, errors are silently dropped.
pub fn sweep_acp_binary_trash() {
    crate::acp::binary_cache::sweep_trash();
}

/// Reclaim per-launch ACP scratch directories left by a previous run — the
/// crash/force-quit backstop for the in-session sweep. Same contract as
/// [`sweep_acp_binary_trash`]: safe any time, intended for a detached startup
/// thread, never panics.
///
/// Deletes only directories whose recorded owner is positively confirmed dead
/// (or is this process and not live — see `acp::scratch_dir`), and never leaves
/// codeg's own `codeg-acp/` subtree, so a peer codeg instance's work and any
/// other application's temp files are both out of reach by construction.
pub fn sweep_acp_scratch_dirs() {
    crate::acp::scratch_dir::sweep_foreign_orphans();
    crate::acp::scratch_dir::sweep_own_orphans();
}

#[cfg(feature = "tauri-runtime")]
mod tauri_app {
    use std::sync::atomic::{AtomicBool, Ordering};

    use crate::acp::manager::ConnectionManager;
    use crate::chat_channel::manager::ChatChannelManager;
    use crate::commands::{
        acp as acp_commands, app_update as app_update_commands,
        automation as automation_commands, background as background_commands, backup,
        browser as browser_commands,
        canvas as canvas_commands,
        chat_authoring as chat_authoring_commands, chat_channel as chat_channel_commands,
        clipboard as clipboard_commands,
        config_sync,
        conversations,
        custom_skills as custom_skills_commands,
        deepseek_settings as deepseek_settings_commands, delegation as delegation_commands,
        experts as experts_commands, feedback as feedback_commands, file_io, folder_commands,
        folder_links, office_tools as office_tools_commands, open_in,
        folders, logging as logging_commands, mcp as mcp_commands,
        model_provider as model_provider_commands, notification, pet as pet_commands, project_boot,
        question as question_commands, quick_messages as quick_messages_commands,
        remote_proxy as remote_proxy_commands,
        remote_workspace as remote_workspace_commands, science as science_commands,
        session_info as session_info_commands,
        system_settings, terminal as terminal_commands,
        token_usage as token_usage_commands,
        forge as forge_commands, version_control, windows, work_task as work_task_commands,
        workspace_state as workspace_state_commands,
    };
    use crate::terminal::manager::TerminalManager;
    use crate::{db, git_credential, network, paths, process, web};
    use tauri::Manager;

    static APP_QUITTING: AtomicBool = AtomicBool::new(false);

    /// Routes one close-button press to hide, exit, or a prompt.
    ///
    /// Called with the close already prevented; every branch is responsible
    /// for what happens instead. The prompt branches must never be able to
    /// swallow the press: if no dialog can answer it, each falls back to
    /// acting on its own.
    ///
    /// Two things stand behind that, because nothing here can observe whether a
    /// dialog actually appeared. `main` is built visible and the dialog only
    /// starts listening once React has mounted in it, so
    /// [`system_settings::close_prompt_listener_ready`] holds the press back
    /// until there is something to answer it; and
    /// [`system_settings::ClosePromptClaim::Expired`] hands the press back if a
    /// prompt that WAS sent goes unanswered, which is the only defence against
    /// everything readiness cannot see.
    ///
    /// The two branches that actually dismiss the window go through
    /// [`windows::with_macos_fullscreen_drained`], because hiding or exiting
    /// while the window still owns a macOS native-fullscreen Space leaves a
    /// black blank plus leftover toolbar chrome (issue #507). Only those
    /// branches: draining ahead of the prompt would cost the user their
    /// fullscreen even when they answer "cancel". The dialog is a webview
    /// overlay, so it is perfectly readable inside the Space.
    fn handle_main_close_request(window: &tauri::Window, label: &str) {
        use crate::commands::system_settings;
        use crate::models::CloseWindowBehavior;
        use tauri::Emitter;

        let app = window.app_handle().clone();
        let behavior = if windows::can_hide_to_tray() {
            system_settings::cached_close_behavior()
        } else {
            CloseWindowBehavior::Exit
        };

        // Only asked for once a prompt is actually going to be shown — it
        // reaps exited children, and the hide path has no business doing that.
        let running_terminals = |app: &tauri::AppHandle| {
            app.try_state::<TerminalManager>()
                .map(|tm| {
                    let emitter = web::event_bridge::EventEmitter::Tauri(app.clone());
                    tm.count_live_by_owner_window(label, Some(&emitter))
                })
                .unwrap_or(0)
        };

        let prompt = |mode: &'static str, count: usize| -> bool {
            if !system_settings::close_prompt_listener_ready() {
                // Nothing in the main webview is listening yet — it is still
                // booting, or its JS never came up at all. Emitting anyway
                // would claim the prompt flag, show no dialog, and leave the
                // press unanswered: the window would simply not react, and
                // every later press would be suppressed as a duplicate until
                // the dialog mounts and clears the flag. Report "could not
                // prompt" so the caller acts on the preference instead.
                return false;
            }
            match system_settings::try_open_close_prompt() {
                // A dialog is already up; this press is a duplicate.
                system_settings::ClosePromptClaim::AlreadyOpen => return true,
                // The last prompt was never answered, so it never arrived —
                // readiness said a listener existed and it turned out not to
                // reach one. Act on the preference instead of sending a second
                // prompt down the same silent path.
                system_settings::ClosePromptClaim::Expired => return false,
                system_settings::ClosePromptClaim::Granted => {}
            }
            let payload = system_settings::CloseRequestPayload {
                mode,
                running_terminals: count,
            };
            // Addressed to `main`, which is where the only listener lives.
            // Note this is intent, not enforcement: `TauriTransport.subscribe`
            // registers with `EventTarget::Any`, and Tauri delivers to those
            // listeners whatever the emit targets. What actually keeps the
            // prompt out of the pet / settings / pet-panel webviews — which
            // share the root layout the dialog is mounted in — is the window
            // label gate inside `CloseRequestDialog`.
            match window.emit_to(label, system_settings::CLOSE_REQUEST_EVENT, payload) {
                Ok(()) => true,
                Err(err) => {
                    tracing::warn!("[close] failed to deliver close prompt: {err}");
                    system_settings::release_close_prompt();
                    false
                }
            }
        };

        let hide = || {
            let window = window.clone();
            windows::with_macos_fullscreen_drained(&app, move || {
                let _ = window.hide();
            });
        };

        match behavior {
            CloseWindowBehavior::Minimize => hide(),
            CloseWindowBehavior::Exit => {
                let count = running_terminals(&app);
                // Nothing to lose, or the confirmation could not be shown —
                // either way the pinned choice stands.
                if count == 0 || !prompt("confirm_terminals", count) {
                    let quit = app.clone();
                    windows::with_macos_fullscreen_drained(&app, move || quit.exit(0));
                }
            }
            CloseWindowBehavior::Ask => {
                let count = running_terminals(&app);
                if !prompt("ask", count) {
                    // Fall back to the behavior codeg has always had. Exiting
                    // on a press the user never got to answer would discard
                    // work; hiding discards nothing.
                    hide();
                }
            }
        }
    }

    fn summarize_web_auto_start_error(err: &crate::app_error::AppCommandError) -> String {
        match err
            .detail
            .as_deref()
            .filter(|detail| !detail.trim().is_empty())
        {
            Some(detail) if detail != err.message.as_str() => {
                format!("{}: {}", err.message, detail)
            }
            _ => err.message.clone(),
        }
    }

    fn notify_web_auto_start_failed(
        app: &tauri::AppHandle,
        port: u16,
        err: &crate::app_error::AppCommandError,
    ) {
        let app = app.clone();
        let body = format!(
            "Could not start the Web service on port {}: {}",
            port,
            summarize_web_auto_start_error(err)
        );
        tauri::async_runtime::spawn(async move {
            let _ =
                notification::send_notification(app, "Codeg Web service".to_string(), body).await;
        });
    }

    /// Chromium command line WebView2 appends to its own when launching.
    #[cfg(target_os = "windows")]
    const WEBVIEW2_ARGS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

    /// Matches the dominant pattern across the Tauri 2 ecosystem (Dorion,
    /// Seelen-UI, and most production Tauri 2 apps that ship a "disable
    /// hardware acceleration" toggle all use `--disable-gpu`).
    #[cfg(target_os = "windows")]
    const WEBVIEW2_DISABLE_GPU_ARGS: [&str; 1] = ["--disable-gpu"];

    /// WebKitGTK has no command line — it reads one boolean env var per
    /// rendering path, and the two that matter fail independently:
    ///
    /// - `WEBKIT_DISABLE_DMABUF_RENDERER` drops the DMA-BUF buffer sharing
    ///   between the web and UI processes (the default since WebKitGTK 2.42).
    ///   This is the fix for the blank/black window under the proprietary
    ///   NVIDIA driver.
    /// - `WEBKIT_DISABLE_COMPOSITING_MODE` turns off accelerated compositing
    ///   outright, which is what breaks under software GL (llvmpipe) and inside
    ///   VMs / remote desktops.
    ///
    /// Both are set: the user reaching for this toggle has a black screen and
    /// no way to tell which path is at fault. An unknown variable is inert on
    /// WebKitGTK builds that no longer read it.
    #[cfg(target_os = "linux")]
    const WEBKITGTK_DISABLE_ENVS: [&str; 2] = [
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    ];

    /// Comma-separated list of the env vars *this* process injected below.
    ///
    /// "Restart now" in the settings UI goes through `tauri::process::restart`,
    /// which spawns the replacement with `Command::new(exe).spawn()` — no
    /// `env_clear`, so the child inherits everything we set. Without this
    /// marker an injected override is indistinguishable from one the user
    /// exported in their shell, and turning the toggle back **off** would never
    /// take effect: the next launch would read `false`, do nothing, and still
    /// hand WebKitGTK/WebView2 the inherited flags.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    const RENDERING_OVERRIDE_OWNED_ENV: &str = "CODEG_WEBVIEW_RENDERING_OVERRIDE";

    /// Opt-out users can disable webview hardware acceleration to work around
    /// GPU driver bugs that produce a black-screen or glitching webview. The
    /// flag is stored in a tiny sidecar file at `~/.codeg/preferences.json` so
    /// it can be read **before** anything else in `run()` — `set_var` is only
    /// sound while the process is single-threaded, and the logging init alone
    /// spawns a `tracing_appender` worker.
    ///
    /// Each webview has its own knob: Windows/WebView2 takes a Chromium command
    /// line, Linux/WebKitGTK reads boolean env vars. macOS/WKWebView exposes
    /// neither, so the toggle is hidden there and this function is not compiled.
    ///
    /// # Safety
    ///
    /// Must be called before any thread is spawned — see
    /// [`RENDERING_OVERRIDE_OWNED_ENV`] for why it also runs when the toggle is
    /// off.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    unsafe fn apply_webview_rendering_override() {
        let owned_raw = std::env::var(RENDERING_OVERRIDE_OWNED_ENV).unwrap_or_default();
        // What a previous launch of *ours* injected. Anything not listed here
        // that is already set came from the user and stays untouched.
        let inherited: Vec<&str> = owned_raw.split(',').filter(|s| !s.is_empty()).collect();

        if !crate::preferences::load().disable_hardware_acceleration {
            // SAFETY: forwarded from this function's own contract.
            unsafe { withdraw_webview_rendering_override(&inherited) };
            return;
        }

        // Keys this process now owns: the ones inherited from our own previous
        // launch plus the ones we set here. Re-published so ownership survives
        // an arbitrary number of restarts with the toggle left on.
        let mut owned: Vec<&str> = Vec::new();

        #[cfg(target_os = "windows")]
        {
            let ours = inherited.contains(&WEBVIEW2_ARGS_ENV);
            // Append rather than replace: the variable is a whole command line
            // the user may already have exported for unrelated reasons.
            let mut tokens: Vec<String> = match std::env::var(WEBVIEW2_ARGS_ENV) {
                Ok(prev) => prev.split_whitespace().map(str::to_string).collect(),
                Err(_) => Vec::new(),
            };
            let mut added = false;
            for arg in WEBVIEW2_DISABLE_GPU_ARGS {
                if !tokens.iter().any(|t| t == arg) {
                    tokens.push(arg.to_string());
                    added = true;
                }
            }
            if added {
                // SAFETY: forwarded from this function's own contract.
                unsafe { std::env::set_var(WEBVIEW2_ARGS_ENV, tokens.join(" ")) };
            }
            // Claim the variable only if the flag is there because of us. A
            // user who put `--disable-gpu` in their own command line keeps it
            // when the toggle goes off.
            if added || ours {
                owned.push(WEBVIEW2_ARGS_ENV);
            }
        }

        #[cfg(target_os = "linux")]
        {
            for key in WEBKITGTK_DISABLE_ENVS {
                // A value the user exported themselves wins — they may have set
                // it to `0` deliberately on a build where the fallback is worse.
                if !inherited.contains(&key) && std::env::var_os(key).is_some() {
                    continue;
                }
                // SAFETY: forwarded from this function's own contract.
                unsafe { std::env::set_var(key, "1") };
                owned.push(key);
            }
        }

        // SAFETY: forwarded from this function's own contract.
        unsafe {
            if owned.is_empty() {
                std::env::remove_var(RENDERING_OVERRIDE_OWNED_ENV);
            } else {
                std::env::set_var(RENDERING_OVERRIDE_OWNED_ENV, owned.join(","));
            }
        }
    }

    /// Undo the overrides listed in `inherited` — the ones a previous launch of
    /// ours injected and this process inherited across a restart. Variables the
    /// user exported are not listed and so are left alone.
    ///
    /// # Safety
    ///
    /// Same as [`apply_webview_rendering_override`]: single-threaded only.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    unsafe fn withdraw_webview_rendering_override(inherited: &[&str]) {
        if inherited.is_empty() {
            return;
        }

        #[cfg(target_os = "windows")]
        if inherited.contains(&WEBVIEW2_ARGS_ENV) {
            // Drop only our own flags; the rest of the command line is the
            // user's and must survive.
            let remaining: Vec<String> = std::env::var(WEBVIEW2_ARGS_ENV)
                .unwrap_or_default()
                .split_whitespace()
                .filter(|t| !WEBVIEW2_DISABLE_GPU_ARGS.contains(t))
                .map(str::to_string)
                .collect();
            // SAFETY: forwarded from this function's own contract.
            unsafe {
                if remaining.is_empty() {
                    std::env::remove_var(WEBVIEW2_ARGS_ENV);
                } else {
                    std::env::set_var(WEBVIEW2_ARGS_ENV, remaining.join(" "));
                }
            }
        }

        #[cfg(target_os = "linux")]
        for key in WEBKITGTK_DISABLE_ENVS {
            if inherited.contains(&key) {
                // SAFETY: forwarded from this function's own contract.
                unsafe { std::env::remove_var(key) };
            }
        }

        // SAFETY: forwarded from this function's own contract.
        unsafe { std::env::remove_var(RENDERING_OVERRIDE_OWNED_ENV) };
    }

    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        // Ahead of the logging init, which is otherwise the first statement
        // here: `init_desktop` builds a `tracing_appender::non_blocking` file
        // writer, and that spawns a worker thread. `set_var` is UB once any
        // other thread exists, so the rendering override has to run while the
        // process is still single-threaded — `main()` calls straight into
        // `run()`, making this the first thing the GUI path does. The cost is
        // that a `preferences.json` read error here has no subscriber to log
        // to; it degrades to defaults either way.
        //
        // SAFETY: single-threaded as argued above.
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        unsafe {
            apply_webview_rendering_override()
        };

        // Install the logging subscriber next so it captures everything from
        // here on. The file appender's logs dir is resolved from env (no DB
        // needed); hold the guard for the whole process so buffered file lines
        // flush on a graceful exit.
        let _log_guard = crate::logging::init::init_desktop();

        if let Err(err) = fix_path_env::fix() {
            tracing::error!("[PATH] fix_path_env failed: {err}");
        }
        process::ensure_node_in_path();
        process::ensure_user_npm_prefix_in_path();

        let builder = tauri::Builder::default();

        // Must be the first plugin: it short-circuits second launches by
        // signalling the running instance and exiting before any other
        // initialization. The callback runs in the *original* process.
        //
        // Skipped in debug builds so a locally-built `cargo run` instance
        // can run alongside an installed release build of codeg during
        // development. Debug desktop builds use an isolated SQLite file, but
        // they still share other `app.codeg` data-dir artifacts with release.
        #[cfg(not(debug_assertions))]
        let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second launches on Windows/Linux carry `codeg://…` on argv.
            // macOS delivers the same URL via the deep-link plugin instead.
            crate::deep_link::handle_argv(app, &argv);
        }));

        builder
            // Persist every window flag EXCEPT decorations. Decorations are a
            // per-platform decision made by `apply_platform_window_style`
            // (undecorated on Windows/Linux so the app draws its own chrome),
            // not a user preference. Restoring a stale `decorated: true` saved
            // by an older build would call `set_decorations(true)` after the
            // window is built and re-add the native title bar on top of the
            // app's own toolbar — the Linux "double title bar".
            .plugin(
                tauri_plugin_window_state::Builder::new()
                    .with_state_flags(
                        tauri_plugin_window_state::StateFlags::all()
                            & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                    )
                    .build(),
            )
            .plugin(tauri_plugin_deep_link::init())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_notification::init())
            // "Launch at login". LaunchAgent rather than AppleScript on macOS:
            // writing `~/Library/LaunchAgents/codeg.plist` needs no Automation
            // consent prompt, where scripting System Events does. No extra
            // startup args — an auto-started codeg is the same app the user
            // would have launched by hand.
            //
            // Nothing rewrites the registration at startup, deliberately. The
            // entry records an absolute path that no backend re-validates, so a
            // refresh would repair a moved app — but `is_enabled()` only knows
            // whether the *file* is there, and the desktop environments disable
            // an entry in place: GNOME sets `X-GNOME-Autostart-enabled=false`
            // inside the .desktop file the plugin would overwrite from a fixed
            // template. Refreshing would therefore silently undo a disable the
            // user made outside codeg. Re-toggling the setting rewrites the
            // path, which is the same repair with consent attached.
            //
            // Two accepted defects live in `auto-launch`, which this plugin
            // wraps, and are still unfixed as of its 0.6 line — so there is no
            // version to upgrade to, and pinning past `auto-launch ^0.5` (what
            // the plugin requires) would not help:
            //   * Windows writes the Run value as `{app_path} {args}` with the
            //     path unquoted. Per-user installs land under
            //     `C:\Users\<name>\AppData\Local\codeg\`, so a username with a
            //     space produces the classic unquoted-path value. Windows'
            //     successive-prefix parsing still resolves it; the residual
            //     risk is the usual hijack, which already requires the attacker
            //     to be able to write `C:\Users\<first>.exe`.
            //   * macOS builds the plist with a bare `<string>{path}</string>`
            //     and no XML escaping, so an install path containing `&`, `<`
            //     or `>` yields a malformed plist and autostart silently fails.
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .manage(ConnectionManager::new())
            .manage(crate::browser::BrowserRegistry::default())
            .manage(crate::browser::egress::EgressRegistry::default())
            .manage(crate::browser::BrowserDownloads::default())
            .manage(crate::browser::DocGuests::default())
            .manage(crate::browser::confirm::EvalConsent::new())
            .manage(crate::browser::open_request::OpenRequests::new())
            .manage(crate::browser::policy::BrowserPolicy::load())
            .manage(TerminalManager::new())
            .manage(ChatChannelManager::new())
            .manage(windows::SettingsWindowState::new())
            .manage(windows::CommitWindowState::new())
            .manage(windows::MergeWindowState::new())
            .manage(windows::AuxWindowState::new())
            .manage(web::WebServerState::new())
            // Remote-workspace IPC proxy. Routes HTTP / WS for windows
            // opened against a remote codeg-server through Rust so we
            // bypass webview mixed-content blocking and can centrally
            // manage per-window subscriptions.
            .manage(std::sync::Arc::new(
                crate::commands::remote_proxy::RemoteProxyState::new(),
            ))
            .manage(std::sync::Arc::new(
                crate::workspace_transfer::WorkspaceTransferManager::new_from_env(),
            ))
            .manage(std::sync::Arc::new(
                web::event_bridge::WebEventBroadcaster::new(),
            ))
            // In-process ACP event bus — typed `Arc<EventEnvelope>` delivery
            // to lifecycle / pet / chat-channel subscribers. Distinct from
            // the JSON-shape `WebEventBroadcaster` above. The metrics handle
            // lives inside the bus so the `/debug/event_metrics` endpoint
            // and shutdown logs can read it.
            .manage({
                let metrics =
                    std::sync::Arc::new(crate::acp::EventBusMetrics::default());
                std::sync::Arc::new(crate::acp::InternalEventBus::new(metrics))
            })
            .manage(crate::pet_state_mapper::new_pet_state_handle())
            // Source of truth for an in-flight app self-update. Shared with the
            // embedded web server's AppState so HTTP and webview clients see the
            // same download progress; lets the upgrade UI survive navigation.
            .manage(crate::update::new_update_state_handle())
            .setup(|app| {
                let app_data_dir = app.path().app_data_dir()?;

                // Unify the data root across every consumer:
                //   * SQLite database (initialised below)
                //   * `paths::codeg_uploads_root` / `codeg_pets_root`
                //   * `AppState.data_dir` and every desktop command
                //     that injects a git credential helper / askpass
                //     into a subprocess (terminal, ACP, folder ops)
                //
                // The contract is "one effective root, end of story."
                // `paths::resolve_effective_data_dir` is the single
                // source of truth; every desktop call site that
                // historically read `app.path().app_data_dir()` and
                // passed it to a credential helper has been migrated
                // to the same helper so a pre-set `CODEG_DATA_DIR` is
                // honored end-to-end.
                //
                // We also write the absolutized value back to the env,
                // even when the operator pre-set it, so:
                //   * subprocesses inherit an absolute path (a relative
                //     `CODEG_DATA_DIR` would otherwise re-resolve
                //     against the subprocess CWD, which may differ
                //     from ours), and
                //   * any future caller that reaches for the env
                //     directly sees the same value the in-process
                //     resolver returns.
                //
                // `set_var` is `unsafe` in edition 2024. We are still
                // single-threaded at this point: `setup` runs on the
                // main thread before any window or async runtime task
                // reads the var, the Tauri plugins registered above
                // (window state, opener, dialog, updater, process,
                // notification) do not read `CODEG_DATA_DIR`, and the
                // value is never mutated again for the lifetime of the
                // process.
                let effective_data_dir = paths::resolve_effective_data_dir(&app_data_dir);
                // SAFETY: see the rationale block above — still
                // single-threaded at setup; edition 2024 will require
                // the `unsafe` block, mirroring the WebView2 rendering
                // override.
                unsafe {
                    std::env::set_var("CODEG_DATA_DIR", &effective_data_dir);
                }

                // `CODEG_HOME` overrides `CODEG_DATA_DIR` inside
                // `paths::codeg_uploads_root` / `codeg_pets_root` for
                // backwards-compatibility with the legacy `~/.codeg/`
                // layout. If both are set and point at different roots,
                // uploads/pets land on `CODEG_HOME` while the database
                // lands on `CODEG_DATA_DIR` — a silent split. The
                // backup story here is "loud warning, no automatic
                // override": the operator likely meant one of them, but
                // we don't know which.
                if let Some(home) = std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()) {
                    let home_path = git_credential::absolutize(std::path::Path::new(&home));
                    if home_path != effective_data_dir {
                        tracing::warn!(
                            "[paths][WARN] CODEG_HOME ({}) and CODEG_DATA_DIR ({}) point at different roots. \
                             Uploads/pets follow CODEG_HOME; the database follows CODEG_DATA_DIR. \
                             Unset one or align them to avoid split state.",
                            home_path.display(),
                            effective_data_dir.display()
                        );
                    }
                }

                let app_version = env!("CARGO_PKG_VERSION");
                let database = tauri::async_runtime::block_on(db::init_database(
                    &effective_data_dir,
                    app_version,
                ))
                .map_err(|e| e.to_string())?;
                app.manage(database);

                // Restore and apply saved system proxy settings before any network operation.
                let db = app.state::<db::AppDatabase>();
                tauri::async_runtime::block_on(network::proxy::init_proxy_from_db(&db.conn));

                // Logging phase 2/3: override the default level from the
                // persisted `logging.level` now that the DB is open, then wire
                // the emitter so the Logs viewer's live tail (`logs://appended`)
                // starts flowing.
                tauri::async_runtime::block_on(crate::logging::init::apply_persisted_level(
                    &db.conn,
                ));
                if let Some(hub) = crate::logging::hub::log_hub() {
                    hub.set_emitter(crate::web::event_bridge::EventEmitter::Tauri(
                        app.handle().clone(),
                    ));
                }

                // Load saved appearance settings before any window is created.
                tauri::async_runtime::block_on(windows::load_saved_zoom(&db.conn));
                tauri::async_runtime::block_on(windows::load_saved_appearance_mode(&db.conn));

                // System tray: required for the WeChat-style hide-on-close
                // flow on Windows/Linux (no built-in dock to bring the
                // workspace back). Locale comes from the persisted language
                // settings; system mode falls back to English here, which
                // the user can fix by switching to manual mode.
                let tray_locale = tauri::async_runtime::block_on(
                    crate::commands::system_settings::load_system_language_settings(&db.conn),
                )
                .map(|settings| settings.language)
                .unwrap_or_default();
                if let Err(err) = windows::install_tray_icon(app.handle(), tray_locale) {
                    tracing::error!("[Tray] failed to install tray icon: {err}");
                }

                // Sweep stale ACP binary cache trash (rename-aside fallback
                // artifacts). Detached OS thread: cannot block startup, panics
                // are caught and dropped, errors are silenced, no subprocesses
                // spawned. Anything still locked is left for next startup.
                std::thread::spawn(|| {
                    let _ = std::panic::catch_unwind(|| {
                        crate::acp::binary_cache::migrate_legacy_root();
                        crate::sweep_acp_binary_trash();
                        crate::sweep_acp_scratch_dirs();
                    });
                });

                // Reclaim scratch directories this process loses track of
                // mid-session. Its own timer on purpose: the ACP idle sweep is
                // not spawned at all when `CODEG_ACP_IDLE_TIMEOUT_SECS=0`, and
                // turning off idle disconnects must not also turn off disk
                // reclamation on a machine leaking gigabytes per launch.
                tauri::async_runtime::spawn(crate::scratch_sweep_task());

                // Install bundled expert skills into the central store
                // (`~/.codeg/skills/`). Runs in the background and does
                // not block startup; failures are logged but non-fatal.
                tauri::async_runtime::spawn(async move {
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

                // Install bundled scientific-research skills into the same
                // central store (`~/.codeg/skills/`). Background, non-blocking;
                // failures are logged but non-fatal.
                tauri::async_runtime::spawn(async move {
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

                // Reclaim orphaned chat scratch dirs (pre-send drafts that never
                // bound to a conversation, plus dirs left behind by deleted chat
                // conversations). Background, non-blocking; failures are logged
                // but non-fatal — anything still in use is left for next startup.
                {
                    let gc_conn = app.state::<db::AppDatabase>().conn.clone();
                    let gc_data_dir = effective_data_dir.clone();
                    tauri::async_runtime::spawn(async move {
                        match crate::commands::conversations::gc_orphan_chat_dirs_core(
                            &gc_conn,
                            &gc_data_dir,
                        )
                        .await
                        {
                            Ok(n) if n > 0 => tracing::info!(
                                "[conversations] chat-dir GC: reclaimed {n} orphan scratch dir(s)"
                            ),
                            Ok(_) => {}
                            Err(err) => {
                                tracing::error!("[conversations] chat-dir GC failed: {err}")
                            }
                        }
                    });
                }

                // Push the persisted terminal settings into their live
                // runtimes BEFORE any background task that can spawn an agent
                // (the chat-channel dispatcher below is one). For the shell
                // handle a late seed would only ever be a narrow race, since
                // it is read at terminal-create time; the command-color flag
                // is read while BUILDING a launch's env, so a late seed there
                // would silently hand the first agent of the run the wrong
                // one. "Seeded before anything can connect" covers both, and
                // matches server startup, which seeds before it binds.
                {
                    let db_for_shell = app.state::<db::AppDatabase>().conn.clone();
                    let shell_config = app.state::<ConnectionManager>().terminal_shell_config();
                    tauri::async_runtime::block_on(async move {
                        crate::commands::system_settings::apply_persisted_terminal_settings(
                            &db_for_shell,
                            &shell_config,
                        )
                        .await;
                    });
                }

                // Seed the close-behavior atomic. `CloseRequested` is a
                // synchronous callback that reads the cache, not the database,
                // so an unseeded cache would serve "ask" to a user who pinned
                // a choice months ago. Blocking here keeps that impossible
                // even for a close in the first moments after launch.
                {
                    let db_for_close = app.state::<db::AppDatabase>().conn.clone();
                    tauri::async_runtime::block_on(async move {
                        crate::commands::system_settings::apply_persisted_close_behavior(
                            &db_for_close,
                        )
                        .await;
                    });
                }

                // Start the config-sync uploader. Background and detached:
                // it sleeps a minute before its first hash compare, reads its
                // settings every tick (so toggling sync in the UI takes effect
                // without a restart), and does nothing at all until the user
                // configures a WebDAV endpoint.
                {
                    let db_for_sync = app.state::<db::AppDatabase>().conn.clone();
                    let emitter = std::sync::Arc::new(web::event_bridge::EventEmitter::Tauri(
                        app.handle().clone(),
                    ));
                    tauri::async_runtime::spawn(async move {
                        crate::commands::config_sync::auto_sync::run_auto_sync_loop(
                            db_for_sync,
                            emitter,
                            env!("CARGO_PKG_VERSION").to_string(),
                        )
                        .await;
                    });
                }

                // Label worktree folders registered before aliases were seeded at
                // creation with the branch they have checked out, so the sidebar
                // names them by branch rather than by their (long, derived)
                // directory. Background, non-blocking; changed folders are
                // broadcast, so a client that already fetched its folder list
                // still picks them up.
                {
                    let db = db::AppDatabase {
                        conn: app.state::<db::AppDatabase>().conn.clone(),
                    };
                    let emitter = web::event_bridge::EventEmitter::Tauri(app.handle().clone());
                    tauri::async_runtime::spawn(async move {
                        let n =
                            crate::commands::folders::backfill_worktree_folder_aliases(&emitter, &db)
                                .await;
                        if n > 0 {
                            tracing::info!("[folders] labeled {n} worktree folder(s) by branch");
                        }
                    });
                }

                // Hand the chat-channel manager to the connection manager
                // BEFORE the chat background tasks below start accepting
                // messages: a `/new` that lands first would write its live ACP
                // title against an `install_chat_channel` that hasn't happened
                // yet, and skip the topic rename for good (the later
                // reconciliation passes only sync titles their own conditional
                // UPDATE wrote, and this one already converged).
                {
                    let cm = app.state::<ConnectionManager>();
                    let ccm = app.state::<ChatChannelManager>();
                    cm.install_chat_channel(ccm.clone_ref());
                }

                // Start chat channel background tasks
                {
                    let ccm = app.state::<ChatChannelManager>();
                    let broadcaster =
                        app.state::<std::sync::Arc<web::event_bridge::WebEventBroadcaster>>();
                    let db_conn = app.state::<db::AppDatabase>().conn.clone();
                    let data_dir = effective_data_dir.clone();
                    let ccm_ref = ccm.clone_ref();
                    let br = broadcaster.inner().clone();
                    let bus = app
                        .state::<std::sync::Arc<crate::acp::InternalEventBus>>()
                        .inner()
                        .clone();
                    let cm = app.state::<ConnectionManager>().clone_ref();
                    let emitter = web::event_bridge::EventEmitter::Tauri(app.handle().clone());
                    tauri::async_runtime::spawn(async move {
                        ccm_ref
                            .start_background(br, bus, db_conn, data_dir, cm, emitter)
                            .await;
                    });
                }

                // Spawn the desktop pet state mapper: subscribes to ACP events
                // (typed envelopes via the in-process bus) AND folder/app
                // side-channel notifications (JSON via the broadcaster), and
                // emits `pet://state` whenever the aggregated pet state
                // changes. The renderer in the floating pet window listens
                // for these events to drive its sprite animation row.
                {
                    let bus = app
                        .state::<std::sync::Arc<crate::acp::InternalEventBus>>()
                        .inner()
                        .clone();
                    let broadcaster = app
                        .state::<std::sync::Arc<web::event_bridge::WebEventBroadcaster>>()
                        .inner()
                        .clone();
                    let emitter = web::event_bridge::EventEmitter::Tauri(app.handle().clone());
                    let pet_state_handle = app
                        .state::<crate::pet_state_mapper::PetStateHandle>()
                        .inner()
                        .clone();
                    tauri::async_runtime::spawn(
                        crate::pet_state_mapper::pet_state_subscriber_task(
                            bus,
                            broadcaster,
                            emitter,
                            pet_state_handle,
                        ),
                    );
                }

                // Spawn the pet panel active-session aggregator: rebuilds the
                // `PetSessionsPayload` (running/waiting/error counts + per-
                // session rows with titles and pending permissions) on ACP
                // lifecycle events and emits `pet://sessions` for the sprite
                // badge + panel window. Shares the same buses as the ambient
                // mapper but is kept separate so the DB-free ambient task stays
                // simple; desktop-only (server mode has no pet window).
                {
                    let bus = app
                        .state::<std::sync::Arc<crate::acp::InternalEventBus>>()
                        .inner()
                        .clone();
                    let broadcaster = app
                        .state::<std::sync::Arc<web::event_bridge::WebEventBroadcaster>>()
                        .inner()
                        .clone();
                    let emitter = web::event_bridge::EventEmitter::Tauri(app.handle().clone());
                    let manager = app.state::<ConnectionManager>().inner().clone_ref();
                    let db_conn = app.state::<db::AppDatabase>().conn.clone();
                    tauri::async_runtime::spawn(
                        crate::pet_sessions::pet_sessions_subscriber_task(
                            bus,
                            broadcaster,
                            emitter,
                            manager,
                            db_conn,
                        ),
                    );
                }

                // Delegation broker + UDS listener. Built from the managed
                // ConnectionManager + DB so spawn / depth-lookup work against
                // live state. Managed alongside the existing per-resource
                // states so commands (Tauri + web) can resolve them by type.
                // MUST run before the LifecycleSubscriber spawn below so the
                // broker handle is available to it.
                let broker_for_lifecycle = {
                    let cm_state = app.state::<ConnectionManager>();
                    let db_conn = app.state::<db::AppDatabase>().conn.clone();
                    let (
                        broker,
                        tokens,
                        socket_path,
                        feedback_config,
                        question_config,
                        session_info_config,
                        chat_authoring_config,
                        browser_tools_config,
                    ) = crate::app_state::build_delegation_stack(
                        &cm_state,
                        db_conn.clone(),
                        effective_data_dir.clone(),
                    );
                    app.manage(broker.clone());
                    app.manage(tokens.clone());
                    app.manage(feedback_config.clone());
                    app.manage(question_config.clone());
                    app.manage(session_info_config.clone());
                    app.manage(chat_authoring_config.clone());
                    app.manage(browser_tools_config.clone());
                    app.manage(crate::commands::delegation::DelegationSocketPath(
                        socket_path.clone(),
                    ));

                    // Push persisted settings into the broker + feedback + question
                    // + session-info config before listener accept.
                    let broker_for_init = broker.clone();
                    let db_for_init = db_conn.clone();
                    let feedback_for_init = feedback_config.clone();
                    let question_for_init = question_config.clone();
                    let session_info_for_init = session_info_config.clone();
                    let chat_authoring_for_init = chat_authoring_config.clone();
                    let browser_tools_for_init = browser_tools_config.clone();
                    tauri::async_runtime::block_on(async move {
                        delegation_commands::apply_persisted_config(
                            &db_for_init,
                            &broker_for_init,
                        )
                        .await;
                        crate::commands::feedback::apply_persisted_feedback_config(
                            &db_for_init,
                            &feedback_for_init,
                        )
                        .await;
                        crate::commands::question::apply_persisted_question_config(
                            &db_for_init,
                            &question_for_init,
                        )
                        .await;
                        crate::commands::session_info::apply_persisted_session_info_config(
                            &db_for_init,
                            &session_info_for_init,
                        )
                        .await;
                        crate::commands::chat_authoring::apply_persisted_chat_authoring_config(
                            &db_for_init,
                            &chat_authoring_for_init,
                        )
                        .await;
                        crate::commands::browser_tools::apply_persisted_browser_tools_config(
                            &db_for_init,
                            &browser_tools_for_init,
                        )
                        .await;
                    });

                    let listener_broker = broker.clone();
                    let listener = crate::acp::delegation::listener::DelegationListener::new(
                        listener_broker,
                        tokens,
                        std::sync::Arc::new(
                            crate::acp::manager::ConnectionManagerParentLookup {
                                manager: std::sync::Arc::new(cm_state.clone_ref()),
                            },
                        ),
                        std::sync::Arc::new(
                            crate::acp::manager::ConnectionManagerFeedbackLookup {
                                manager: std::sync::Arc::new(cm_state.clone_ref()),
                            },
                        ),
                        std::sync::Arc::new(
                            crate::acp::manager::ConnectionManagerQuestionLookup {
                                manager: std::sync::Arc::new(cm_state.clone_ref()),
                            },
                        ),
                        std::sync::Arc::new(
                            crate::commands::session_info::DbSessionInfoLookup::new(
                                std::sync::Arc::new(db::AppDatabase {
                                    conn: db_conn.clone(),
                                }),
                            ),
                        ),
                        std::sync::Arc::new(crate::work_task::EngineWorkTaskTools),
                        std::sync::Arc::new(
                            crate::commands::chat_authoring::DbChatAuthoring::new(
                                std::sync::Arc::new(db::AppDatabase {
                                    conn: db_conn.clone(),
                                }),
                                crate::web::event_bridge::EventEmitter::Tauri(
                                    app.handle().clone(),
                                ),
                                chat_authoring_config.clone(),
                            ),
                        ),
                        std::sync::Arc::new(
                            crate::commands::browser::McpBrowserTools::new(
                                app.handle().clone(),
                                browser_tools_config.clone(),
                            ),
                        ),
                    );
                    // Bind through the service handle rather than a bare
                    // `listener.run` spawn: it keeps the bind error and the
                    // accept-loop handle around, which is what lets the
                    // workspace status indicator report why the broker socket
                    // is down and rebind it without an app restart.
                    let service = crate::acp::delegation::service::DelegationService::new(
                        listener,
                        socket_path,
                    );
                    crate::acp::delegation::service::install(service.clone());
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = service.start().await {
                            tracing::error!("[delegation] listener failed to start: {e}");
                        }
                    });
                    broker
                };

                // Spawn the LifecycleSubscriber: persists cross-connection DB state
                // (currently `external_id` on conversation rows when SessionStarted fires)
                // off the emit hot path. `subscribe()` runs synchronously inside
                // `lifecycle_subscriber_task` before the future is returned, so the
                // subscribe-before-spawn invariant holds. The setup callback runs
                // outside any tokio runtime, so we use `tauri::async_runtime::spawn`.
                {
                    let db_conn = app.state::<db::AppDatabase>().conn.clone();
                    let cm = app.state::<ConnectionManager>().clone_ref();
                    let bus = app
                        .state::<std::sync::Arc<crate::acp::InternalEventBus>>()
                        .inner()
                        .clone();
                    tauri::async_runtime::spawn(crate::acp::lifecycle_subscriber_task(
                        db_conn,
                        cm,
                        bus,
                        Some(broker_for_lifecycle),
                    ));
                }

                match tauri::async_runtime::block_on(web::load_web_service_config(&db.conn)) {
                    Ok(config) if config.auto_start => {
                        let port = config.port.unwrap_or(web::DEFAULT_WEB_SERVICE_PORT);
                        let ws = app.state::<web::WebServerState>();
                        if let Err(err) =
                            tauri::async_runtime::block_on(web::do_start_web_server_tauri(
                                app.handle().clone(),
                                &ws,
                                config.port,
                                None,
                                config.token,
                            ))
                        {
                            tracing::error!("[WEB] auto-start failed: {err}");
                            notify_web_auto_start_failed(app.handle(), port, &err);
                        }
                    }
                    Ok(_) => {}
                    Err(err) => tracing::error!("[WEB] failed to load auto-start config: {err}"),
                }

                // Spawn the idle sweep so connections abandoned without an
                // explicit disconnect (e.g. window/tab closed without
                // teardown, panic survivors) are reaped. Override the
                // 60-second default via `CODEG_ACP_IDLE_TIMEOUT_SECS`
                // (set to `0` to disable).
                if let Some(idle_timeout) = crate::acp::idle_timeout_from_env() {
                    let cm = app.state::<ConnectionManager>().clone_ref();
                    tauri::async_runtime::spawn(crate::acp::idle_sweep_task(
                        cm,
                        idle_timeout,
                        std::time::Duration::from_secs(crate::acp::SWEEP_INTERVAL_SECS),
                    ));
                }

                // Office watch preview servers: reap dead children + ref0
                // stragglers (live previews are never swept). Override via
                // `CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS` (`0` disables).
                if let Some(idle_timeout) = crate::office_watch::idle_timeout_from_env() {
                    tauri::async_runtime::spawn(crate::office_watch::office_watch_idle_sweep_task(
                        idle_timeout,
                        std::time::Duration::from_secs(crate::office_watch::SWEEP_INTERVAL_SECS),
                    ));
                }

                // Automation engine: drives manual + scheduled fires, settles
                // runs off the event bus, reconciles, and recovers on boot. One
                // per process; mirrored in `bin/codeg_server.rs`.
                if let Some(engine) = crate::automation::build_engine(
                    crate::db::AppDatabase {
                        conn: app.state::<crate::db::AppDatabase>().conn.clone(),
                    },
                    app.state::<ConnectionManager>().clone_ref(),
                    crate::web::event_bridge::EventEmitter::Tauri(app.handle().clone()),
                    app.state::<std::sync::Arc<crate::acp::InternalEventBus>>()
                        .inner()
                        .clone(),
                    effective_data_dir.clone(),
                ) {
                    tauri::async_runtime::spawn(crate::automation::run_automation_engine(engine));
                }

                // Work-task engine: drives the todo→…→done pipeline, settles
                // runs off the event bus, recovers merges from git truth on
                // boot. One per process; mirrored in `bin/codeg_server.rs`.
                if let Some(engine) = crate::work_task::build_task_engine(
                    crate::db::AppDatabase {
                        conn: app.state::<crate::db::AppDatabase>().conn.clone(),
                    },
                    app.state::<ConnectionManager>().clone_ref(),
                    crate::web::event_bridge::EventEmitter::Tauri(app.handle().clone()),
                    app.state::<std::sync::Arc<crate::acp::InternalEventBus>>()
                        .inner()
                        .clone(),
                    effective_data_dir.clone(),
                ) {
                    tauri::async_runtime::spawn(crate::work_task::run_task_engine(engine));
                }

                // OS `codeg://` URLs. Register the listener after the DB is
                // live so a warm-start click can look the conversation up.
                // Cold-start URLs are also read here and baked into the main
                // window path — an event emitted before the webview subscribes
                // would be dropped, but `DeepLinkBootstrap` reads the query.
                // macOS delivers its launch URL only after this hook returns,
                // so that path lands on the listener below and is parked for
                // `take_pending_deep_link` instead.
                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    let handle = app.handle().clone();
                    let _ = app.deep_link().on_open_url(move |event| {
                        let urls: Vec<String> =
                            event.urls().iter().map(|url| url.to_string()).collect();
                        crate::deep_link::handle_raw_urls(&handle, &urls);
                    });
                    // The Linux bundler writes a `.desktop` whose `Exec` has no
                    // `%u` field code (tauri#16014), so an installed deb/rpm/
                    // AppImage is advertised as the `x-scheme-handler/codeg`
                    // owner but is launched with no argument at all. The
                    // plugin's own registration writes a handler entry that
                    // does pass `%u`; on Windows it adds the HKCU class key a
                    // portable/zip copy never gets from the installer. Debug
                    // builds are skipped so a dev run cannot steal the scheme
                    // from the installed app (same reason single-instance is
                    // release-only above).
                    #[cfg(all(not(debug_assertions), any(windows, target_os = "linux")))]
                    if let Err(e) = app.deep_link().register_all() {
                        tracing::warn!("[deep-link] scheme registration failed: {e}");
                    }
                }
                let startup_urls: Vec<String> = {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    app.deep_link()
                        .get_current()
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|url| url.to_string())
                        .collect()
                };
                let workspace_path = tauri::async_runtime::block_on(
                    crate::deep_link::startup_workspace_path(
                        &db::AppDatabase {
                            conn: app.state::<db::AppDatabase>().conn.clone(),
                        },
                        &startup_urls,
                    ),
                );

                // Before any inspectable webview exists: web inspectors in
                // this app open in a window of their own instead of docking
                // into the window they are inspecting, which for a browser
                // tab would be the whole workspace. Here rather than at the
                // menu item that opens one, because a page can be
                // right-clicked into "Inspect Element" without going through
                // any of our code.
                #[cfg(target_os = "macos")]
                crate::browser::shim::macos::prefer_detached_inspector();

                // Single-window workspace: ensure the main window exists.
                // Workspace state (open folders, opened tabs, active tab) is
                // restored by the frontend via `list_open_folder_details` /
                // `list_opened_tabs` inside the main window.
                if app.get_webview_window("main").is_none() {
                    let url = tauri::WebviewUrl::App(workspace_path.into());
                    let builder = tauri::WebviewWindowBuilder::new(app, "main", url)
                        .title("Codeg")
                        .inner_size(1260.0, 860.0)
                        .min_inner_size(400.0, 600.0);
                    let builder = windows::apply_platform_window_style(builder);
                    // The workspace title bar is taller than the shared default
                    // (it hosts the tab strips), so nudge the native macOS
                    // traffic lights down to stay vertically centred.
                    #[cfg(target_os = "macos")]
                    let builder = builder.traffic_light_position(
                        windows::workspace_window_traffic_light_position(),
                    );
                    if let Ok(w) = builder.build() {
                        windows::post_window_setup(&w);
                    }
                }

                #[cfg(all(
                    feature = "browser-child",
                    any(target_os = "macos", target_os = "windows")
                ))]
                crate::browser::surface_child::init_main_thread();
                crate::browser::surface_window::init_main_thread();

                #[cfg(feature = "browser-smoke")]
                crate::browser::smoke::spawn_if_enabled(app.handle().clone());

                Ok(())
            })
            .on_menu_event(|app, event| {
                let id = event.id().as_ref().to_string();

                // Tray menu items act in Rust directly: showing the
                // workspace and quitting are both pure runtime concerns
                // with no UI state to coordinate.
                if id.starts_with(windows::TRAY_MENU_ID_PREFIX) {
                    match id.as_str() {
                        windows::TRAY_MENU_ID_SHOW => windows::show_main_window(app),
                        windows::TRAY_MENU_ID_QUIT => app.exit(0),
                        _ => {}
                    }
                    return;
                }

                // Dispatch native pet context-menu actions. Items live under
                // the `pet:` id namespace; everything else (future app
                // menus) flows past untouched. We re-emit a webview event
                // rather than acting in Rust so the existing frontend
                // commands (pet_save_window_state, open_settings_window,
                // close_pet_window) stay the single source of truth — the
                // native menu is just a different *trigger*.
                if !id.starts_with(windows::PET_MENU_ID_PREFIX) {
                    return;
                }
                let payload: serde_json::Value =
                    if let Some(scale) = windows::pet_menu_scale_from_id(&id) {
                        serde_json::json!({ "type": "scale", "value": scale })
                    } else if id == windows::PET_MENU_ID_OPEN_MANAGER {
                        serde_json::json!({ "type": "open_manager" })
                    } else if id == windows::PET_MENU_ID_CLOSE {
                        serde_json::json!({ "type": "close" })
                    } else {
                        // Header / unknown — nothing to do.
                        return;
                    };
                use tauri::Emitter;
                let _ = app.emit_to("pet", "pet://menu-action", payload);
            })
            .on_window_event(|window, event| {
                let label = window.label().to_string();

                // A window's browser tabs die with it: child webviews are
                // destroyed by the platform, owned windows are closed here.
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    browser_commands::close_all_for_owner(window.app_handle(), &label);
                }

                if (label == "settings" || label.starts_with("remote-settings-"))
                    && matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                    )
                {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<windows::SettingsWindowState>() {
                        windows::restore_windows_after_settings(app, &state, &label);
                    }
                }

                if (label.starts_with("commit-") || label.starts_with("remote-commit-"))
                    && matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                    )
                {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<windows::CommitWindowState>() {
                        windows::restore_window_after_commit(app, &state, &label);
                    }
                }

                if (label.starts_with("merge-") || label.starts_with("remote-merge-"))
                    && matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                    )
                {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<windows::MergeWindowState>() {
                        windows::restore_window_after_merge(app, &state, &label);
                    }
                    if label.starts_with("merge-") {
                        let app_clone = window.app_handle().clone();
                        let label_clone = label.clone();
                        tauri::async_runtime::spawn(async move {
                            windows::cleanup_dangling_merge(&app_clone, &label_clone).await;
                        });
                    }
                }

                // Stash, push, project boot and the session importer share one
                // owner map, so this arm matches on the map instead of a list
                // of label prefixes: a window that never registered an owner
                // has none to hand back, and `main` never registers one at all.
                if matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                ) {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<windows::AuxWindowState>() {
                        windows::restore_window_after_aux(app, &state, &label);
                    }
                }

                if label == "pet"
                    && matches!(
                        event,
                        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                    )
                {
                    // Persist `enabled = false` so the next launch doesn't
                    // race-open the pet before the user asks for it. We
                    // intentionally do NOT clear `active_pet_id` — the user
                    // chose that pet, they want it back next time they open
                    // the window.
                    if let Some(db) = window.app_handle().try_state::<db::AppDatabase>() {
                        let conn = db.conn.clone();
                        let save = async move {
                            let _ = crate::commands::pet::pet_save_window_state_core(
                                &conn,
                                crate::models::pet::PetWindowStatePatch {
                                    x: None,
                                    y: None,
                                    scale: None,
                                    always_on_top: None,
                                    enabled: Some(false),
                                },
                            )
                            .await;
                        };
                        // During app shutdown the runtime is about to be torn
                        // down — a fire-and-forget spawn would lose the save
                        // and `enabled = true` would survive into the next
                        // launch. Block here so the write lands before
                        // ExitRequested returns.
                        if APP_QUITTING.load(Ordering::Relaxed) {
                            tauri::async_runtime::block_on(save);
                        } else {
                            tauri::async_runtime::spawn(save);
                        }
                    }
                }

                if label == windows::PET_PANEL_LABEL
                    && matches!(event, tauri::WindowEvent::Focused(false))
                {
                    // Click-away dismiss for the session panel.
                    windows::close_pet_panel_on_blur(window.app_handle());
                }

                if label == "main" {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // What the close button does is the user's choice
                        // (`ask` / `minimize` / `exit`), with one platform
                        // override:
                        //
                        //   * tray not usable (Linux, tray install failed):
                        //     the preference cannot apply. Letting only `main`
                        //     close would orphan the desktop pet and other
                        //     aux windows in a process with no workspace and
                        //     no way to bring it back — `pet` runs with
                        //     `skip_taskbar(true)`, and the single-instance
                        //     callback's `show_main_window` is a no-op once
                        //     main is destroyed. So the choice folds to Exit,
                        //     rather than exiting right here: folding keeps
                        //     the running-terminal confirmation below on the
                        //     path for this platform too.
                        //
                        // ExitRequested itself reaches this branch with
                        // APP_QUITTING already set — that's the only path
                        // that should fall through to the cleanup below.
                        if !APP_QUITTING.load(Ordering::Relaxed) {
                            api.prevent_close();
                            handle_main_close_request(window, &label);
                            return;
                        }
                        let app = window.app_handle();
                        if let Some(cm) = app.try_state::<ConnectionManager>() {
                            let disconnected = tauri::async_runtime::block_on(
                                cm.disconnect_by_owner_window(&label),
                            );
                            tracing::info!(
                                "[ACP] main window closing disconnected_connections={}",
                                disconnected
                            );
                        }
                        if let Some(tm) = app.try_state::<TerminalManager>() {
                            let killed = tm.kill_by_owner_window(&label);
                            tracing::info!("[TERM] main window closing killed_terminals={}", killed);
                        }
                    }
                }
            })
            .invoke_handler(tauri::generate_handler![
                browser_commands::browser_capabilities,
                browser_commands::browser_open_tab,
                browser_commands::browser_close,
                browser_commands::browser_set_bounds,
                browser_commands::browser_set_visible,
                browser_commands::browser_freeze_frame,
                browser_commands::browser_navigate,
                browser_commands::browser_reload,
                browser_commands::browser_go_back,
                browser_commands::browser_go_forward,
                browser_commands::browser_stop,
                browser_commands::browser_open_devtools,
                browser_commands::browser_get_state,
                browser_commands::browser_list_tabs,
                browser_commands::browser_list_services,
                browser_commands::browser_clear_data,
                browser_commands::browser_find,
                browser_commands::browser_list_downloads,
                browser_commands::browser_reveal_download,
                browser_commands::browser_clear_downloads,
                browser_commands::browser_set_host_rules,
                browser_commands::browser_set_sign_in_user_agent,
                browser_commands::browser_set_blank_page_theme,
                browser_commands::browser_remove_profile,
                browser_commands::browser_doc_open,
                browser_commands::browser_doc_set_mode,
                browser_commands::browser_doc_state,
                browser_commands::browser_agent_grant,
                browser_commands::browser_agent_snapshot,
                browser_commands::browser_agent_act,
                browser_commands::browser_agent_console,
                browser_commands::browser_agent_capture,
                browser_commands::browser_agent_eval,
                browser_commands::browser_eval_decide,
                browser_commands::browser_answer_open_request,
                browser_commands::browser_pick_element,
                browser_commands::browser_pick_cancel,
                browser_commands::browser_page_capture,
                browser_commands::browser_page_console,
                conversations::list_conversations,
                conversations::get_conversation,
                conversations::list_all_conversations,
                conversations::list_child_conversations,
                conversations::list_opened_tabs,
                conversations::save_opened_tabs,
                conversations::import_local_conversations,
                conversations::scan_importable_sessions,
                conversations::import_selected_sessions,
                conversations::get_folder_conversation,
                conversations::get_folder_conversation_turns,
                conversations::list_folders,
                conversations::get_stats,
                conversations::get_sidebar_data,
                conversations::create_conversation,
                conversations::create_chat_conversation,
                conversations::create_chat_dir,
                conversations::update_conversation_status,
                conversations::update_conversation_title,
                conversations::update_conversation_pinned,
                conversations::delete_conversation,
                folders::load_folder_history,
                folders::get_folder,
                folders::list_open_folder_details,
                folders::list_all_folder_details,
                folders::open_folder,
                folders::open_worktree_folder,
                folders::resolve_worktree_folder,
                folders::open_folder_in_workspace,
                folders::open_folder_by_id,
                open_in::open_in_code,
                folders::remove_folder_from_workspace,
                folders::list_folder_groups,
                folders::create_folder_group,
                folders::update_folder_group,
                folders::delete_folder_group,
                folders::apply_sidebar_layout,
                folders::set_folder_group,
                folders::update_folder_color,
                folders::update_folder_alias,
                folders::update_folder_default_agent,
                folder_links::list_folder_links,
                folder_links::preview_folder_links,
                folder_links::create_folder_links,
                folder_links::rename_folder_link,
                folder_links::repair_folder_link,
                folder_links::remove_folder_link,
                canvas_commands::canvas_list_nodes,
                canvas_commands::canvas_create_node,
                canvas_commands::canvas_group_into_region,
                canvas_commands::canvas_update_node,
                canvas_commands::canvas_move_nodes,
                canvas_commands::canvas_detach_member,
                canvas_commands::canvas_delete_node,
                canvas_commands::canvas_delete_nodes,
                folders::add_folder_to_history,
                folders::remove_folder_from_history,
                folders::create_folder_directory,
                folders::clone_repository,
                folders::get_git_branch,
                folders::get_git_head,
                folders::git_init,
                folders::git_pull,
                folders::git_start_pull_merge,
                folders::git_has_merge_head,
                folders::git_fetch,
                folders::git_update_branch,
                folders::git_push_info,
                folders::git_push,
                folders::git_new_branch,
                folders::git_worktree_add,
                folders::git_checkout,
                folders::git_reset,
                folders::git_list_branches,
                folders::git_stash_push,
                folders::git_stash_pop,
                folders::git_stash_list,
                folders::git_stash_apply,
                folders::git_stash_drop,
                folders::git_stash_clear,
                folders::git_stash_show,
                folders::git_status,
                folders::git_is_tracked,
                folders::git_diff,
                folders::git_diff_with_branch,
                folders::git_show_diff,
                folders::git_show_file,
                folders::git_show_file_base64,
                folders::git_commit,
                folders::git_rollback_file,
                folders::git_add_files,
                folders::git_list_all_branches,
                folders::git_list_remotes,
                folders::git_fetch_remote,
                folders::git_add_remote,
                folders::git_remove_remote,
                folders::git_set_remote_url,
                folders::git_merge,
                folders::git_rebase,
                folders::git_delete_branch,
                folders::git_remove_worktree,
                folders::git_delete_remote_branch,
                folders::git_list_conflicts,
                folders::git_conflict_file_versions,
                folders::git_resolve_conflict,
                folders::git_abort_operation,
                folders::git_continue_operation,
                workspace_state_commands::start_workspace_state_stream,
                workspace_state_commands::stop_workspace_state_stream,
                workspace_state_commands::get_workspace_snapshot,
                folders::get_home_directory,
                folders::list_directory_entries,
                folders::list_directory_with_files,
                folders::get_file_tree,
                folders::list_workspace_files,
                folders::read_file_base64,
                folders::read_workspace_file_base64,
                folders::read_file_preview,
                folders::read_file_for_edit,
                folders::save_file_content,
                folders::save_file_copy,
                folders::rename_file_tree_entry,
                folders::move_file_tree_entry,
                folders::delete_file_tree_entry,
                folders::create_file_tree_entry,
                folders::git_log,
                folders::git_current_user,
                folders::git_commit_files,
                folders::git_search_authors,
                folders::git_commit_branches,
                windows::open_folder_window,
                windows::open_commit_window,
                windows::open_settings_window,
                windows::open_merge_window,
                windows::open_stash_window,
                windows::open_push_window,
                windows::open_project_boot_window,
                windows::open_import_sessions_window,
                remote_workspace_commands::list_remote_workspace_connections,
                remote_workspace_commands::create_remote_workspace_connection,
                remote_workspace_commands::update_remote_workspace_connection,
                remote_workspace_commands::delete_remote_workspace_connection,
                remote_workspace_commands::test_remote_workspace_connection,
                remote_workspace_commands::get_remote_workspace_connection,
                remote_workspace_commands::reorder_remote_workspace_connections,
                remote_workspace_commands::open_remote_workspace,
                remote_proxy_commands::remote_http_call,
                remote_proxy_commands::remote_upload_attachment,
                remote_proxy_commands::remote_upload_workspace_paths,
                remote_proxy_commands::remote_cancel_workspace_transfer,
                remote_proxy_commands::remote_download_workspace_file,
                remote_proxy_commands::remote_download_workspace_dir,
                remote_proxy_commands::read_local_file_for_upload,
                remote_proxy_commands::remote_ws_subscribe,
                remote_proxy_commands::remote_ws_unsubscribe,
                remote_proxy_commands::remote_ws_send_text,
                windows::open_pet_window,
                windows::close_pet_window,
                windows::pet_window_record_position,
                windows::pet_show_context_menu,
                windows::toggle_pet_panel,
                windows::close_pet_panel,
                windows::resize_pet_panel,
                windows::focus_conversation,
                crate::deep_link::take_pending_deep_link,
                windows::update_traffic_light_position,
                windows::update_appearance_mode,
                windows::set_tray_locale,
                pet_commands::pet_list,
                pet_commands::pet_get,
                pet_commands::pet_read_spritesheet,
                pet_commands::pet_add,
                pet_commands::pet_update_meta,
                pet_commands::pet_replace_sprite,
                pet_commands::pet_delete,
                pet_commands::pet_list_importable_codex,
                pet_commands::pet_import_codex,
                pet_commands::pet_codex_import_available,
                pet_commands::pet_get_settings,
                pet_commands::pet_set_active,
                pet_commands::pet_save_window_state,
                pet_commands::pet_marketplace_list,
                pet_commands::pet_marketplace_install,
                pet_commands::pet_marketplace_asset,
                pet_commands::pet_celebrate,
                pet_commands::pet_get_current_state,
                pet_commands::pet_list_active_sessions,
                background_commands::background_read,
                background_commands::background_set,
                background_commands::background_clear,
                background_commands::background_market_search,
                background_commands::background_market_asset,
                background_commands::background_market_download,
                app_update_commands::app_update_state,
                app_update_commands::perform_app_update,
                app_update_commands::restart_app,
                project_boot::detect_package_manager,
                project_boot::create_shadcn_project,
                project_boot::detect_hyperframes_skills,
                project_boot::install_hyperframes_skills,
                project_boot::create_hyperframes_project,
                system_settings::get_system_proxy_settings,
                system_settings::update_system_proxy_settings,
                system_settings::get_system_language_settings,
                system_settings::update_system_language_settings,
                system_settings::get_system_terminal_settings,
                system_settings::update_system_terminal_settings,
                system_settings::get_available_terminal_shells,
                system_settings::probe_terminal_shell_path,
                system_settings::get_system_rendering_settings,
                system_settings::update_system_rendering_settings,
                system_settings::get_system_autostart_settings,
                system_settings::update_system_autostart_settings,
                system_settings::get_system_close_behavior_settings,
                system_settings::update_system_close_behavior_settings,
                system_settings::resolve_close_request,
                logging_commands::get_log_settings,
                logging_commands::set_log_settings,
                logging_commands::get_recent_logs,
                logging_commands::list_log_files,
                logging_commands::open_logs_dir,
                delegation_commands::get_delegation_settings,
                delegation_commands::set_delegation_settings,
                crate::commands::mcp_service::get_codeg_mcp_service_status,
                crate::commands::mcp_service::start_codeg_mcp_service,
                crate::commands::mcp_service::set_codeg_mcp_tool_group,
                feedback_commands::get_feedback_settings,
                feedback_commands::set_feedback_settings,
                feedback_commands::submit_session_feedback,
                question_commands::get_question_settings,
                question_commands::set_question_settings,
                session_info_commands::get_session_info_settings,
                session_info_commands::set_session_info_settings,
                chat_authoring_commands::get_chat_authoring_settings,
                chat_authoring_commands::set_chat_authoring_settings,
                crate::commands::browser_tools::get_browser_tools_settings,
                crate::commands::browser_tools::set_browser_tools_settings,
                version_control::detect_git,
                version_control::test_git_path,
                version_control::get_git_settings,
                version_control::update_git_settings,
                version_control::get_github_accounts,
                version_control::validate_github_token,
                version_control::validate_gitlab_token,
                version_control::validate_gitea_token,
                version_control::update_github_accounts,
                version_control::save_account_token,
                version_control::get_account_token,
                version_control::delete_account_token,
                acp_commands::acp_preflight,
                acp_commands::acp_cursor_auth_status,
                acp_commands::acp_cursor_list_models,
                acp_commands::acp_qoder_auth_status,
                acp_commands::acp_connect,
                acp_commands::acp_prompt,
                acp_commands::acp_set_mode,
                acp_commands::acp_set_config_option,
                acp_commands::acp_goal_control,
                acp_commands::acp_describe_agent_options,
                acp_commands::acp_cancel,
                acp_commands::acp_fork,
                acp_commands::acp_stop_async_task,
                acp_commands::acp_respond_permission,
                acp_commands::acp_answer_question,
                acp_commands::acp_answer_plan_approval,
                acp_commands::acp_disconnect,
                acp_commands::acp_touch_connection,
                acp_commands::acp_list_connections,
                acp_commands::acp_get_session_snapshot,
                acp_commands::acp_get_session_snapshot_by_conversation,
                acp_commands::acp_find_connection_for_conversation,
                acp_commands::acp_list_agents,
                acp_commands::acp_get_agent_status,
                acp_commands::acp_env_diagnostics,
                acp_commands::acp_clear_binary_cache,
                acp_commands::acp_scan_leaked_temp,
                acp_commands::acp_reclaim_leaked_temp,
                acp_commands::acp_download_agent_binary,
                acp_commands::acp_install_uv_tool,
                acp_commands::acp_detect_agent_local_version,
                acp_commands::acp_prepare_npx_agent,
                acp_commands::acp_uninstall_agent,
                acp_commands::acp_update_agent_preferences,
                acp_commands::acp_update_agent_env,
                acp_commands::acp_update_agent_config,
                acp_commands::acp_update_hermes_config,
                acp_commands::acp_update_kimi_code_config,
                acp_commands::acp_fetch_kimi_models,
                deepseek_settings_commands::acp_load_deepseek_model_catalog,
                deepseek_settings_commands::acp_update_deepseek_model_catalog,
                acp_commands::acp_update_pi_config,
                acp_commands::acp_load_pi_config,
                acp_commands::acp_validate_pi_command,
                acp_commands::acp_sync_antigravity_settings,
                acp_commands::acp_antigravity_login_start,
                acp_commands::acp_antigravity_login_finish,
                acp_commands::acp_antigravity_login_cancel,
                acp_commands::acp_antigravity_sign_out,
                acp_commands::acp_pi_project_trust_state,
                acp_commands::acp_pi_set_project_trust,
                acp_commands::acp_pi_acknowledge_project_trust,
                acp_commands::acp_pi_list_trust_entries,
                acp_commands::acp_install_pi_binary,
                acp_commands::acp_uninstall_pi_binary,
                acp_commands::acp_open_hermes_setup_terminal,
                acp_commands::acp_reveal_hermes_home,
                acp_commands::acp_reorder_agents,
                crate::commands::custom_agents::acp_list_custom_agents,
                crate::commands::custom_agents::acp_save_custom_agent,
                crate::commands::custom_agents::acp_delete_custom_agent,
                crate::commands::custom_agents::acp_fetch_registry_catalog,
                crate::commands::custom_agents::acp_add_registry_agent,
                crate::commands::custom_agents::acp_current_platform,
                acp_commands::acp_list_agent_skills,
                acp_commands::acp_read_agent_skill,
                acp_commands::acp_save_agent_skill,
                acp_commands::acp_delete_agent_skill,
                acp_commands::opencode_list_plugins,
                acp_commands::opencode_provider_catalog,
                acp_commands::codex_bundled_catalog,
                acp_commands::opencode_install_plugins,
                acp_commands::opencode_uninstall_plugin,
                acp_commands::codex_request_device_code,
                acp_commands::codex_poll_device_code,
                experts_commands::experts_list,
                experts_commands::experts_get_install_status,
                experts_commands::experts_list_all_install_statuses,
                experts_commands::experts_link_to_agent,
                experts_commands::experts_unlink_from_agent,
                experts_commands::experts_apply_links,
                experts_commands::experts_read_content,
                experts_commands::experts_open_central_dir,
                science_commands::science_list,
                science_commands::science_get_install_status,
                science_commands::science_list_all_install_statuses,
                science_commands::science_link_to_agent,
                science_commands::science_unlink_from_agent,
                science_commands::science_apply_links,
                science_commands::science_read_content,
                science_commands::science_open_central_dir,
                custom_skills_commands::custom_list,
                custom_skills_commands::custom_list_all_install_statuses,
                custom_skills_commands::custom_apply_links,
                custom_skills_commands::custom_read_skill,
                custom_skills_commands::custom_create_skill,
                custom_skills_commands::custom_save_skill,
                custom_skills_commands::custom_duplicate_skill,
                custom_skills_commands::custom_import_skill,
                custom_skills_commands::custom_import_from_agent,
                custom_skills_commands::custom_delete_skills,
                office_tools_commands::officecli_detect,
                office_tools_commands::officecli_install,
                office_tools_commands::officecli_uninstall,
                office_tools_commands::officecli_list_skills,
                office_tools_commands::officecli_sync_skills,
                office_tools_commands::officecli_skill_link_to_agent,
                office_tools_commands::officecli_skill_unlink_from_agent,
                office_tools_commands::officecli_skill_get_install_status,
                office_tools_commands::officecli_skill_list_all_install_statuses,
                office_tools_commands::officecli_skill_apply_links,
                office_tools_commands::officecli_skill_read_content,
                office_tools_commands::officecli_render_html,
                office_tools_commands::start_office_watch,
                office_tools_commands::stop_office_watch,
                folder_commands::list_folder_commands,
                folder_commands::create_folder_command,
                folder_commands::update_folder_command,
                folder_commands::delete_folder_command,
                folder_commands::reorder_folder_commands,
                folder_commands::bootstrap_folder_commands_from_package_json,
                quick_messages_commands::quick_messages_list,
                quick_messages_commands::quick_messages_create,
                quick_messages_commands::quick_messages_update,
                quick_messages_commands::quick_messages_delete,
                quick_messages_commands::quick_messages_reorder,
                automation_commands::automation_list,
                automation_commands::automation_get,
                automation_commands::automation_runs,
                automation_commands::automation_create,
                automation_commands::automation_update,
                automation_commands::automation_set_enabled,
                automation_commands::automation_delete,
                automation_commands::automation_mark_seen,
                automation_commands::automation_compute_next_run,
                automation_commands::automation_run_now,
                automation_commands::automation_cancel_run,
                token_usage_commands::token_usage_report,
                token_usage_commands::token_usage_facets,
                token_usage_commands::token_usage_status,
                token_usage_commands::token_usage_sync,
                work_task_commands::work_task_list,
                work_task_commands::work_task_get,
                work_task_commands::work_task_events,
                work_task_commands::work_task_attention_count,
                work_task_commands::work_task_create,
                work_task_commands::work_task_update,
                work_task_commands::work_task_reorder,
                work_task_commands::work_task_delete,
                work_task_commands::work_task_start,
                work_task_commands::work_task_start_all,
                work_task_commands::work_task_retry,
                work_task_commands::work_task_requeue,
                work_task_commands::work_task_schedule,
                work_task_commands::work_task_return,
                work_task_commands::work_task_cancel,
                work_task_commands::work_task_merge,
                work_task_commands::work_task_merge_unqueue,
                work_task_commands::work_task_deliver_pr,
                work_task_commands::work_task_complete,
                work_task_commands::work_task_archive,
                work_task_commands::work_task_cleanup,
                work_task_commands::work_task_diff,
                work_task_commands::work_task_changed_files,
                work_task_commands::work_task_settings_get,
                work_task_commands::work_task_settings_get_own,
                work_task_commands::work_task_settings_effective,
                work_task_commands::work_task_settings_set,
                work_task_commands::work_task_settings_delete,
                work_task_commands::work_task_template_list,
                work_task_commands::work_task_template_save,
                work_task_commands::work_task_template_delete,
                forge_commands::folder_forge_remote,
                forge_commands::forge_list_issues,
                forge_commands::forge_tab_count,
                forge_commands::forge_list_labels,
                forge_commands::forge_list_comments,
                forge_commands::forge_create_comment,
                forge_commands::forge_set_item_state,
                forge_commands::forge_create_issue,
                forge_commands::forge_change_detail,
                forge_commands::forge_change_files,
                forge_commands::forge_identity,
                forge_commands::forge_merge_options,
                forge_commands::forge_merge_change,
                forge_commands::work_task_create_from_forge,
                forge_commands::work_task_lookup_by_source,
                forge_commands::forge_settings_get,
                forge_commands::forge_settings_set,
                terminal_commands::terminal_spawn,
                terminal_commands::terminal_write,
                terminal_commands::terminal_resize,
                terminal_commands::terminal_snapshot,
                terminal_commands::terminal_kill,
                terminal_commands::terminal_list,
                mcp_commands::mcp_scan_local,
                mcp_commands::mcp_list_marketplaces,
                mcp_commands::mcp_search_marketplace,
                mcp_commands::mcp_get_marketplace_server_detail,
                mcp_commands::mcp_install_from_marketplace,
                mcp_commands::mcp_upsert_local_server,
                mcp_commands::mcp_set_server_apps,
                mcp_commands::mcp_remove_server,
                notification::send_notification,
                notification::notification_identity,
                notification::open_system_notification_settings,
                file_io::save_binary_file,
                file_io::save_text_file,
                clipboard_commands::copy_files_to_clipboard,
                config_sync::config_sync_export_file,
                config_sync::config_sync_peek_file,
                config_sync::config_sync_import_file,
                config_sync::config_sync_get_settings,
                config_sync::config_sync_update_settings,
                config_sync::config_sync_get_state,
                config_sync::config_sync_test_connection,
                config_sync::config_sync_upload_now,
                config_sync::config_sync_peek_remote,
                config_sync::config_sync_download_apply,
                config_sync::config_sync_export_content,
                config_sync::config_sync_peek_content,
                config_sync::config_sync_import_content,
                config_sync::config_sync_list_rollbacks,
                config_sync::config_sync_apply_rollback,
                backup::backup_create,
                backup::backup_prepare_source,
                backup::backup_release_source,
                backup::backup_scan_external_conflicts,
                backup::backup_restore_stage,
                backup::backup_cancel,
                backup::backup_list_safety_snapshots,
                backup::backup_rollback,
                backup::backup_discard_pending,
                backup::backup_active_agents,
                chat_channel_commands::list_chat_channels,
                chat_channel_commands::create_chat_channel,
                chat_channel_commands::update_chat_channel,
                chat_channel_commands::delete_chat_channel,
                chat_channel_commands::save_chat_channel_token,
                chat_channel_commands::get_chat_channel_has_token,
                chat_channel_commands::delete_chat_channel_token,
                chat_channel_commands::connect_chat_channel,
                chat_channel_commands::disconnect_chat_channel,
                chat_channel_commands::test_chat_channel,
                chat_channel_commands::get_chat_channel_status,
                chat_channel_commands::list_chat_channel_messages,
                chat_channel_commands::get_chat_command_prefix,
                chat_channel_commands::set_chat_command_prefix,
                chat_channel_commands::get_chat_event_filter,
                chat_channel_commands::set_chat_event_filter,
                chat_channel_commands::get_chat_event_webhooks,
                chat_channel_commands::set_chat_event_webhooks,
                chat_channel_commands::get_chat_message_language,
                chat_channel_commands::set_chat_message_language,
                chat_channel_commands::weixin_get_qrcode,
                chat_channel_commands::weixin_check_qrcode,
                model_provider_commands::list_model_providers,
                model_provider_commands::create_model_provider,
                model_provider_commands::update_model_provider,
                model_provider_commands::delete_model_provider,
                web::start_web_server,
                web::stop_web_server,
                web::get_web_server_status,
                web::get_web_service_config,
                web::update_web_service_config,
                web::probe_web_service_port,
            ])
            .build(tauri::generate_context!())
            .expect("error while building tauri application")
            .run(|app, event| match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    APP_QUITTING.store(true, Ordering::Relaxed);
                    // Drop the desktop pet alongside the workspace so it
                    // never outlives a real quit. Tauri also tears down all
                    // windows on shutdown, but doing it explicitly here lets
                    // the pet's CloseRequested handler persist `enabled = false`
                    // before the runtime races to exit.
                    if let Some(pet) = app.get_webview_window("pet") {
                        let _ = pet.close();
                    }
                    if let Some(ws) = app.try_state::<web::WebServerState>() {
                        tauri::async_runtime::block_on(web::do_stop_web_server(&ws));
                    }
                    if let Some(tm) = app.try_state::<TerminalManager>() {
                        tm.kill_all();
                    }
                    crate::office_watch::stop_all_office_watches();
                    if let Some(cm) = app.try_state::<ConnectionManager>() {
                        tauri::async_runtime::block_on(cm.disconnect_all());
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    // Dock-icon click: bring the workspace forward
                    // unconditionally. `has_visible_windows` is true
                    // whenever any aux window (pet, settings, commit…)
                    // is alive, so gating on it would suppress recovery
                    // even though `main` itself is hidden.
                    // `show_main_window` is idempotent — already-visible
                    // windows just get re-focused, which is what dock
                    // activation should do anyway.
                    windows::show_main_window(app);
                }
                _ => {}
            });
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_app::run;
