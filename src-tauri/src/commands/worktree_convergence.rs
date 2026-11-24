//! Converging the workspace once a worktree directory is off disk: its
//! conversations move to the project folder (remembering where they ran), its
//! tabs close, its folder row is soft-deleted, and every client is told.
//!
//! Two paths remove worktrees — the branch selector's "delete worktree"
//! (`commands::folders`) and the to-do task engine's cleanup
//! (`work_task::engine`) — and both used to carry their own copy of this
//! sequence. They differ only in the task bookkeeping each does between the
//! database writes and the announcement, so the sequence is split there:
//! [`converge_db`] first, the caller's bookkeeping, then [`announce`].
//!
//! Write order matters — conversations first, so they are never left pointing
//! at a folder that has already vanished — and each step ends in a broadcast,
//! because a removal no client hears about is a removal no client shows: the
//! sidebar keeps the dead worktree until the next full `fetchFolders`.

use crate::db::service::{conversation_service, folder_service, tab_service};
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;
use crate::web::event_bridge::{
    emit_event, ConversationsBulkChanged, TabsChanged, CONVERSATIONS_BULK_CHANGED_EVENT,
    TABS_CHANGED_EVENT,
};

/// What [`converge_db`] did, for the caller's bookkeeping and [`announce`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ConvergeOutcome {
    /// Conversations re-parented onto the project folder.
    pub moved: u64,
    /// The folder row is gone (now, or it already was). Only then is the drop
    /// announced, so a failed write can't leave clients disagreeing with what a
    /// refetch would return.
    pub folder_gone: bool,
}

/// The database half: re-parent the worktree's conversations onto
/// `project_folder_id` (through the same primitive a user's "move to project"
/// uses, so `origin_cwd` follows one rule), close the worktree's tabs (the
/// folder is going away, so they are closed rather than re-pointed) and
/// broadcast the new tab set, then soft-delete the folder row.
///
/// `wt_path` is the folder's OWN registered path, not git's canonicalization of
/// it: the agents that fall back to matching on `origin_cwd ?? folder.path`
/// were pointed at the registered spelling.
pub(crate) async fn converge_db(
    db: &AppDatabase,
    emitter: &EventEmitter,
    wt_id: i32,
    project_folder_id: i32,
    wt_path: &str,
) -> ConvergeOutcome {
    let moved = conversation_service::reparent_folder_conversations(
        &db.conn,
        wt_id,
        project_folder_id,
        wt_path,
    )
    .await
    .unwrap_or_else(|e| {
        tracing::warn!("[worktree] re-parenting conversations of folder {wt_id} failed: {e}");
        0
    });

    match tab_service::delete_folder_tabs_and_bump(&db.conn, wt_id).await {
        Ok(inv) => {
            if let Some(tabs) = inv.emit {
                emit_event(
                    emitter,
                    TABS_CHANGED_EVENT,
                    TabsChanged {
                        version: inv.version,
                        origin: "server".to_string(),
                        tabs,
                    },
                );
            }
        }
        Err(e) => tracing::warn!("[worktree] tab cleanup failed for folder {wt_id}: {e}"),
    }

    // An id that is already soft-deleted (a retried cleanup) or never existed
    // succeeds untouched, so the retry still re-announces the drop.
    let folder_gone = match folder_service::soft_delete_folder(&db.conn, wt_id).await {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("[worktree] worktree folder {wt_id} soft-delete failed: {e}");
            false
        }
    };

    ConvergeOutcome { moved, folder_gone }
}

/// The announcement half: conversations first — that starts every client's
/// refetch, so the moved rows have the shortest possible window with no folder
/// to render under — then the folder drop.
pub(crate) fn announce(
    emitter: &EventEmitter,
    outcome: ConvergeOutcome,
    project_folder_id: i32,
    wt_id: i32,
) {
    emit_event(
        emitter,
        CONVERSATIONS_BULK_CHANGED_EVENT,
        ConversationsBulkChanged {
            imported: 0,
            updated: outcome.moved as u32,
            folder_ids: vec![project_folder_id],
        },
    );
    if outcome.folder_gone {
        crate::commands::folders::emit_folder_deleted(emitter, wt_id);
    }
}
