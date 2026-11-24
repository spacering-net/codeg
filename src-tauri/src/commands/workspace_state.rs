use crate::app_error::AppCommandError;
use crate::web::event_bridge::EventEmitter;
use crate::workspace_state::WorkspaceSnapshotResponse;

pub(crate) async fn start_workspace_state_stream_core(
    emitter: EventEmitter,
    root_path: String,
    wants_tree_git: bool,
) -> Result<WorkspaceSnapshotResponse, AppCommandError> {
    crate::workspace_state::start_workspace_state_stream_core(emitter, root_path, wants_tree_git)
        .await
}

pub(crate) async fn stop_workspace_state_stream_core(
    root_path: String,
    wants_tree_git: bool,
) -> Result<(), AppCommandError> {
    crate::workspace_state::stop_workspace_state_stream_core(root_path, wants_tree_git).await
}

pub(crate) async fn get_workspace_snapshot_core(
    root_path: String,
    since_seq: Option<u64>,
) -> Result<WorkspaceSnapshotResponse, AppCommandError> {
    crate::workspace_state::get_workspace_snapshot_core(root_path, since_seq).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn start_workspace_state_stream(
    app: tauri::AppHandle,
    root_path: String,
    wants_tree_git: Option<bool>,
) -> Result<WorkspaceSnapshotResponse, AppCommandError> {
    let emitter = EventEmitter::from_app(&app);
    // Default true: absent param means a legacy full subscriber.
    start_workspace_state_stream_core(emitter, root_path, wants_tree_git.unwrap_or(true)).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn stop_workspace_state_stream(
    root_path: String,
    wants_tree_git: Option<bool>,
) -> Result<(), AppCommandError> {
    stop_workspace_state_stream_core(root_path, wants_tree_git.unwrap_or(true)).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_workspace_snapshot(
    root_path: String,
    since_seq: Option<u64>,
) -> Result<WorkspaceSnapshotResponse, AppCommandError> {
    get_workspace_snapshot_core(root_path, since_seq).await
}
