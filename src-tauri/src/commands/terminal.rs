use std::collections::HashMap;

#[cfg(feature = "tauri-runtime")]
use tauri::Manager;
#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::git_credential;
#[cfg(feature = "tauri-runtime")]
use crate::terminal::error::TerminalError;
#[cfg(feature = "tauri-runtime")]
use crate::terminal::manager::{SpawnOptions, TerminalManager};
#[cfg(feature = "tauri-runtime")]
use crate::terminal::types::{TerminalInfo, TerminalSnapshot};
#[cfg(feature = "tauri-runtime")]
use crate::web::event_bridge::EventEmitter;

/// Build extra env vars for the terminal session.
///
/// Uses `credential.helper` with a script that calls the app binary with
/// `--credential-helper`. The binary opens the DB, looks up the matching
/// account, and outputs credentials. No credentials are written to disk.
pub(crate) fn prepare_credential_env(
    app_data_dir: &std::path::Path,
) -> Option<HashMap<String, String>> {
    // Get the path to the current running binary
    let app_binary = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("[TERM] failed to get current exe path: {}", e);
            return None;
        }
    };

    let helper_script =
        match git_credential::create_credential_helper_script(app_data_dir, &app_binary) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("[TERM] failed to create credential helper script: {}", e);
                return None;
            }
        };

    let helper_path_str = helper_script.to_string_lossy().to_string();

    // GIT_CONFIG_COUNT adds config entries that are tried BEFORE file-based config.
    // For multi-valued keys like credential.helper, this means our helper runs first;
    // if it exits 0 with no output, git falls through to the user's existing helpers.
    let mut env = HashMap::new();
    env.insert("GIT_CONFIG_COUNT".to_string(), "1".to_string());
    env.insert(
        "GIT_CONFIG_KEY_0".to_string(),
        "credential.helper".to_string(),
    );
    // The '!' prefix tells git to run the rest as `sh -c <value>`. Single-quote
    // the path so spaces, `$`, backticks, etc. don't get re-interpreted by sh.
    env.insert(
        "GIT_CONFIG_VALUE_0".to_string(),
        format!("!{}", git_credential::sh_single_quote(&helper_path_str)),
    );

    Some(env)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn terminal_spawn(
    working_dir: String,
    shell: Option<String>,
    initial_command: Option<String>,
    terminal_id: Option<String>,
    manager: State<'_, TerminalManager>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, TerminalError> {
    let terminal_id = terminal_id
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
    // Honor a pre-set `CODEG_DATA_DIR` so the credential helper
    // injected into this terminal points at the same database the
    // desktop process initialized in `lib.rs setup`. Without this,
    // a custom `CODEG_DATA_DIR` would leave terminals reading an
    // empty / nonexistent DB at the Tauri default path.
    let effective_data_dir = crate::paths::resolve_effective_data_dir(&app_data_dir);

    let extra_env = prepare_credential_env(&effective_data_dir);

    manager.spawn_with_id(
        SpawnOptions {
            terminal_id,
            working_dir,
            owner_window_label: window.label().to_string(),
            shell,
            initial_command,
            extra_env,
            temp_files: vec![],
        },
        EventEmitter::Tauri(app_handle),
    )
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn terminal_write(
    terminal_id: String,
    data: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.write(&terminal_id, data.as_bytes())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn terminal_resize(
    terminal_id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.resize(&terminal_id, cols, rows)
}

/// Recent output of a terminal that is already running, so a viewer mounting
/// over an existing PTY (a canvas terminal card returning from another route)
/// can redraw instead of attaching to a blank pane. `alive: false` means there
/// is nothing to attach to and the caller should spawn.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn terminal_snapshot(
    terminal_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<TerminalSnapshot, TerminalError> {
    Ok(manager.snapshot(&terminal_id))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn terminal_kill(
    terminal_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.kill(&terminal_id)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn terminal_list(
    manager: State<'_, TerminalManager>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<TerminalInfo>, TerminalError> {
    let emitter = EventEmitter::Tauri(app_handle);
    Ok(manager.list_with_exit_check(Some(&emitter)))
}
