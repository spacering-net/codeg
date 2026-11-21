//! `/btw` side questions — the `/btw` command's backend.
//!
//! One call forks the parent conversation's agent session at its settled
//! history (a COPY fork: the parent keeps streaming, untouched), binds the
//! fork to a new `kind = btw` conversation row, and asks the side question in
//! it on a connection of the child's own. The two endings are the frontend's
//! ordinary verbs plus one new one: destroy is `delete_conversation`, promote
//! is [`btw_promote_core`]. Design: `docs/btw-side-question-design.md`.
//!
//! Why this is not `fork_session`: an in-place fork RE-POINTS the row the user
//! is looking at and freezes the old history in a sibling — the right shape
//! for "branch from here", the wrong one for a side question, whose whole
//! point is that the parent thread neither moves nor notices. The copy fork
//! has its own command (`ConnectionCommand::ForkCopy`) precisely because it
//! also has different concurrency rules (no re-point → no turn gate; see
//! `ConnectionManager::fork_copy_session`).

use serde::Serialize;

use crate::acp::agent_mentions::render_btw_boundary_frame;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::PromptInputBlock;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::conversations::{emit_conversation_deleted, emit_conversation_upsert};
use crate::db::entities::conversation::ConversationKind;
use crate::db::service::conversation_service;
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

/// Wire result of `/btw`: the child's new row and connection, so the frontend
/// can open its tab and watch the live stream immediately.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwCreateResult {
    pub conversation_id: i32,
    pub connection_id: String,
}

/// Create the side question: copy-fork on the parent's connection, row, child
/// connection, first prompt with the btw boundary frame. Every step before
/// the row exists leaves nothing behind; a failing step after the row exists
/// unwinds the row and the child connection, because a btw section entry that
/// never answered reads as a bug, not as a cancelled question.
///
/// The `emitter`/`data_dir` split mirrors how the callers resolve them per
/// runtime (tauri wrappers go through `AppHandle`; the web handlers through
/// `AppState`), same as the conversation commands.
#[allow(clippy::too_many_arguments)]
pub async fn btw_create_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &std::path::Path,
    parent_connection_id: &str,
    parent_conversation_id: i32,
    question: String,
) -> Result<BtwCreateResult, AppCommandError> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err(AppCommandError::invalid_input("btw question is empty"));
    }
    let parent = conversation_service::get_by_id(&db.conn, parent_conversation_id)
        .await
        .map_err(|_| AppCommandError::not_found(format!("conversation {parent_conversation_id}")))?;

    // Server-side gate (the menu only offers `/btw` where it works, but the
    // web API takes the call from anyone): the parent's agent must support
    // fork AND resume, or the child connection could not load the fork.
    let launch = manager
        .connection_launch_context(parent_connection_id)
        .await
        .ok_or_else(|| {
            AppCommandError::new(
                AppErrorCode::NotFound,
                format!("connection {parent_connection_id} not found"),
            )
        })?;
    // The command's two ids come from the client: a connection already linked
    // to a DIFFERENT conversation would fork that conversation's history and
    // parent it under the row this call names (the strip, the subtree and the
    // answer would disagree from day one). Unlinked connections (resumed, not
    // yet prompted) carry no history anyone could be misled about — allowed.
    if let Some(bound) = launch.conversation_id {
        if bound != parent_conversation_id {
            return Err(AppCommandError::invalid_input(format!(
                "connection {parent_connection_id} serves conversation {bound}, not {parent_conversation_id}"
            )));
        }
    }
    if !launch.btw_supported {
        return Err(AppCommandError::new(
            AppErrorCode::InvalidInput,
            "this agent cannot serve /btw (needs session fork and resume)".to_string(),
        )
        .with_i18n("btw.unsupportedAgent", Default::default()));
    }

    let fork = manager
        .fork_copy_session(parent_connection_id)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(format!("btw copy fork failed: {e}")))?;

    let row = conversation_service::create_btw_fork(
        &db.conn,
        parent.folder_id,
        parent.agent_type,
        btw_title(&question),
        parent.git_branch.clone(),
        parent.model.clone(),
        fork.forked_session_id.clone(),
        parent.id,
    )
    .await
    .map_err(AppCommandError::db)?;

    // The child connection carries the parent's settings (the same
    // build_session_runtime_env the user-facing connect and the delegation
    // spawner use — disabled check, provider creds, git helper) and the SAME
    // emitter, or the child's stream goes to a broadcaster nobody watches.
    // Deliberately NOT `inherit_cli_run_tag`: a btw is a human driving a side
    // thread, and the delegate rule that a connection a person steers must not
    // take the run's policy applies with more force to its instigator.
    let runtime_env = match crate::commands::acp::build_session_runtime_env(
        db,
        parent.agent_type,
        Some(&fork.forked_session_id),
        data_dir,
    )
    .await
    {
        Ok(env) => env,
        Err(e) => {
            roll_back_btw_row(db, manager, emitter, row.id).await;
            return Err(AppCommandError::task_execution_failed(format!(
                "btw child env failed: {e}"
            )));
        }
    };
    let spawn = manager
        .spawn_agent_with_outcome(
            parent.agent_type,
            launch.working_dir.map(|p| p.to_string_lossy().to_string()),
            Some(fork.forked_session_id.clone()),
            runtime_env,
            launch.owner_window_label,
            emitter.clone(),
            launch.preferred_mode_id,
            launch.preferred_config_values,
        )
        .await
        .map_err(|e| AppCommandError::task_execution_failed(format!("btw child connection failed: {e}")));
    let spawn = match spawn {
        Ok(spawn) => spawn,
        Err(e) => {
            roll_back_btw_row(db, manager, emitter, row.id).await;
            return Err(e);
        }
    };

    if let Err(e) = manager
        .send_prompt_linked_with_suffix(
            db,
            &spawn.connection_id,
            vec![PromptInputBlock::Text { text: question }],
            Some(parent.folder_id),
            Some(row.id),
            None,
            vec![PromptInputBlock::Text {
                text: render_btw_boundary_frame(),
            }],
        )
        .await
    {
        roll_back_btw_row(db, manager, emitter, row.id).await;
        return Err(map_btw_send_error(e));
    }

    emit_conversation_upsert(emitter, &db.conn, row.id).await;
    Ok(BtwCreateResult {
        conversation_id: row.id,
        connection_id: spawn.connection_id,
    })
}

/// Promote a btw row to an ordinary conversation: one transaction clears the
/// lineage with the kind, and arms `btw_promoted` so the row's next user
/// prompt carries the promotion frame (`send_prompt_linked_full`). The
/// connection keeps running — the row never changed identity, only placement,
/// so no teardown/rebuild dance is needed (contrast OpenChamber, which patches
/// JSON metadata with rollback compensation for exactly less than this).
pub async fn btw_promote_core(
    db: &AppDatabase,
    emitter: &EventEmitter,
    conversation_id: i32,
) -> Result<(), AppCommandError> {
    let summary = conversation_service::get_by_id(&db.conn, conversation_id)
        .await
        .map_err(|_| {
            AppCommandError::invalid_input(format!(
                "conversation {conversation_id} is not a live btw"
            ))
        })?;
    if summary.kind != ConversationKind::Btw {
        return Err(AppCommandError::invalid_input(format!(
            "conversation {conversation_id} is not a live btw"
        )));
    }
    conversation_service::promote_btw(&db.conn, summary.id)
        .await
        .map_err(AppCommandError::db)?;
    emit_conversation_upsert(emitter, &db.conn, summary.id).await;
    Ok(())
}

fn map_btw_send_error(e: crate::acp::error::AcpError) -> AppCommandError {
    AppCommandError::task_execution_failed(format!("btw first prompt failed: {e}"))
}

/// Undo a btw row whose setup failed after insert: end any agent work, soft
/// delete, and broadcast removal. Not `delete_conversation_with_cleanup_core`
/// — the tab/canvas/chat-folder teardown presumes a row the user could open,
/// and this one is dying before its first render; the delete event keeps every
/// client's list honest either way.
async fn roll_back_btw_row(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    conversation_id: i32,
) {
    // The child may already own an agent-side turn the prompt failed on mid-
    // send; disconnect ends it, the soft delete hides the row, and the deleted
    // event tells the sidebar (a row never upserted still needs the delete to
    // clear an optimistic insert on another client).
    manager.disconnect_by_conversation_id(conversation_id).await;
    if let Err(e) = conversation_service::soft_delete(&db.conn, conversation_id).await {
        tracing::warn!("[btw] rollback soft-delete of {conversation_id} failed: {e}");
        return;
    }
    emit_conversation_deleted(emitter, conversation_id);
}

/// The section row's name — the question itself, OpenChamber-style. The title
/// lock keeps the auto-title backfill (which only reads unlocked rows and the
/// session file, where no `btw:` string exists) off it.
fn btw_title(question: &str) -> String {
    const MAX: usize = 72;
    let flat = question.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX {
        format!("btw: {flat}")
    } else {
        let head: String = flat.chars().take(MAX - 1).collect();
        format!("btw: {head}…")
    }
}

#[cfg(feature = "tauri-runtime")]
use tauri::Manager;

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn btw_create(
    parent_connection_id: String,
    parent_conversation_id: i32,
    question: String,
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    app_handle: tauri::AppHandle,
) -> Result<BtwCreateResult, AppCommandError> {
    // Same effective-data-dir resolution (and first-launch fallback) as
    // `acp_connect`: the child's runtime env reads the user's settings and
    // credentials off it.
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    btw_create_core(
        &db,
        &manager,
        &crate::web::event_bridge::EventEmitter::from_app(&app_handle),
        &data_dir,
        &parent_connection_id,
        parent_conversation_id,
        question,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn btw_promote(
    conversation_id: i32,
    db: tauri::State<'_, crate::db::AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppCommandError> {
    btw_promote_core(
        &db,
        &crate::web::event_bridge::EventEmitter::from_app(&app_handle),
        conversation_id,
    )
    .await
}
