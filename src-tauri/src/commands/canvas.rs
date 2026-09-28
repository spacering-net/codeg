//! Conversation canvas: persisted regions / pinned cards / notes, shared by
//! every window and client of one workspace backend.
//!
//! The `*_core` fns are mode-agnostic (plain references, no `tauri::State`) and
//! emit `CANVAS_CHANGED_EVENT` after commit so both the Tauri command wrappers
//! and the Axum handlers share one code path. Ordering protocol: every
//! committed mutation is exactly one event carrying a dense server revision
//! (see `canvas_service`); clients apply events in revision order, treat a gap
//! as "refetch the snapshot", and never advance their revision from a command
//! response — so response/event arrival order cannot lose state.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tokio::sync::Mutex;

use crate::app_error::AppCommandError;
use crate::db::entities::canvas_node::CanvasNodeKind;
use crate::db::error::DbError;
use crate::db::service::canvas_service;
use crate::db::AppDatabase;
use crate::models::canvas::{CanvasMutation, CanvasNode, CanvasSnapshot};
use crate::terminal::manager::TerminalManager;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Serializes each mutation's `commit → broadcast` PAIR. The service's
/// revision lock only orders the commits; without this outer lock two commands
/// could commit as revisions N and N+1 but broadcast in the opposite order,
/// and every client would burn a snapshot refetch on a phantom gap. Outer lock
/// here, inner lock in the service — always acquired in that order, so the
/// pair cannot deadlock, and service fns stay directly callable (funnel,
/// tests) under their own serialization.
fn event_order_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Broadcast on every committed canvas mutation, to every window / web client /
/// remote session of this backend.
pub const CANVAS_CHANGED_EVENT: &str = "canvas://changed";

/// One committed mutation. Payloads are full-state and idempotent so every
/// client — including the originator — applies them identically; `revision` is
/// the dense total order (exactly one event per bump).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CanvasChange {
    Upsert {
        node: Box<CanvasNode>,
        revision: i64,
    },
    Moved {
        moves: Vec<CanvasNodeMovePayload>,
        revision: i64,
    },
    Deleted {
        id: i32,
        revision: i64,
    },
    /// A member card dragged out of a region: membership removal (custom
    /// regions only) and pin creation in one transaction, hence one event.
    Detached {
        removed_from: Option<i32>,
        node: Box<CanvasNode>,
        revision: i64,
    },
    /// Conversations collected into a region — a box-selection made into a new
    /// one, a card dragged into an existing one, or two cards dropped onto each
    /// other: the region and the pinned cards it absorbed, in one transaction
    /// and one event. Apply order is delete-then-upsert; both halves are
    /// idempotent.
    Grouped {
        node: Box<CanvasNode>,
        deleted_ids: Vec<i32>,
        revision: i64,
    },
    /// Deletion-funnel cleanup after conversations were removed: pinned nodes
    /// dropped and custom regions scrubbed, as one batch event.
    Pruned {
        deleted_ids: Vec<i32>,
        updated: Vec<CanvasNode>,
        revision: i64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CanvasNodeMovePayload {
    pub id: i32,
    pub x: f64,
    pub y: f64,
}

/// Request shape for `canvas_create_node`. camelCase like every other request
/// struct (`FolderLinkRequest` precedent); binding columns are validated
/// kind-specifically at the service chokepoint.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCanvasNode {
    pub kind: CanvasNodeKind,
    #[serde(default)]
    pub folder_id: Option<i32>,
    #[serde(default)]
    pub folder_group_id: Option<i32>,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<i32>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    /// Required for `file` (the document's absolute path) and `terminal` (its
    /// working directory); rejected for every other kind.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub grid_columns: Option<i32>,
    #[serde(default)]
    pub grid_rows: Option<i32>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Request shape for `canvas_group_into_region` — every "collect these
/// conversations" gesture: box-select → new region, a pinned card dragged into
/// a custom region, and two cards dropped onto each other.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupIntoRegionInput {
    /// Existing custom region to merge into. Absent = create a new one from the
    /// geometry below.
    #[serde(default)]
    pub target_region_id: Option<i32>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Required, not defaulted: "collect nothing" is never a gesture, and an
    /// omitted list would quietly build an empty region instead of saying the
    /// request was malformed. Matches `GroupIntoRegionInput` in `lib/api.ts`,
    /// where both are non-optional.
    pub member_ids: Vec<i32>,
    /// Pinned conversation cards the selection swallowed; deleted in the same
    /// transaction. Non-pin ids are ignored, not rejected.
    pub consume_node_ids: Vec<i32>,
    #[serde(default)]
    pub grid_columns: Option<i32>,
    #[serde(default)]
    pub grid_rows: Option<i32>,
    /// Where a NEW region goes. Omitted when merging into an existing one —
    /// see `canvas_service::GroupIntoRegion::geometry`.
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
}

/// The frame for a NEW region, or `None` when merging into one that already has
/// its own. All four fields or none of them: a half-specified frame is a caller
/// bug either way, and both ways of papering over it are worse than the error —
/// inventing the missing sides places a region nobody asked for, and dropping
/// the whole frame turns a malformed create into a silent one.
fn region_geometry(
    input: &GroupIntoRegionInput,
) -> Result<Option<canvas_service::RegionGeometry>, AppCommandError> {
    match (input.x, input.y, input.width, input.height) {
        (Some(x), Some(y), Some(width), Some(height)) => {
            Ok(Some(canvas_service::RegionGeometry {
                x,
                y,
                width,
                height,
            }))
        }
        (None, None, None, None) => Ok(None),
        _ => Err(AppCommandError::invalid_input(
            "a region frame needs x, y, width and height together",
        )),
    }
}

/// Response of `canvas_group_into_region`: the region plus the pinned cards
/// actually deleted, mirroring the `Grouped` event payload so an optimistic
/// client applies exactly what the broadcast will.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupIntoRegionResult {
    pub node: CanvasNode,
    pub deleted_ids: Vec<i32>,
}

/// Field-by-field patch; absent = untouched, empty string clears a nullable
/// text field. `member_add` / `member_remove` are atomic server-side list ops.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNodePatchInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub collapsed: Option<bool>,
    #[serde(default)]
    pub grid_columns: Option<i32>,
    #[serde(default)]
    pub grid_rows: Option<i32>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub member_add: Option<i32>,
    #[serde(default)]
    pub member_remove: Option<i32>,
}

impl From<CanvasNodePatchInput> for canvas_service::CanvasNodePatch {
    fn from(p: CanvasNodePatchInput) -> Self {
        canvas_service::CanvasNodePatch {
            title: p.title,
            content: p.content,
            color: p.color,
            collapsed: p.collapsed,
            grid_columns: p.grid_columns,
            grid_rows: p.grid_rows,
            x: p.x,
            y: p.y,
            width: p.width,
            height: p.height,
            member_add: p.member_add,
            member_remove: p.member_remove,
        }
    }
}

/// Map service errors onto user-facing codes: liveness/shape rejections are the
/// caller's mistake (`invalid_input`), missing rows are `not_found` — the
/// blanket `From<DbError>` would flatten both into an opaque `database_error`.
fn map_db(e: DbError) -> AppCommandError {
    match e {
        DbError::NotFound(msg) => AppCommandError::not_found(msg),
        DbError::Validation(msg) => AppCommandError::invalid_input(msg),
        other => AppCommandError::from(other),
    }
}

// ---------------------------------------------------------------------------
// Core (mode-agnostic)
// ---------------------------------------------------------------------------

pub async fn canvas_list_nodes_core(db: &AppDatabase) -> Result<CanvasSnapshot, AppCommandError> {
    let (rows, revision) = canvas_service::snapshot(&db.conn).await.map_err(map_db)?;
    Ok(CanvasSnapshot {
        nodes: rows.into_iter().map(CanvasNode::from).collect(),
        revision,
    })
}

pub async fn canvas_create_node_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    input: CreateCanvasNode,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    let (row, revision) = canvas_service::create_node(
        &db.conn,
        canvas_service::NewCanvasNode {
            kind: input.kind,
            folder_id: input.folder_id,
            folder_group_id: input.folder_group_id,
            agent_type: input.agent_type,
            conversation_id: input.conversation_id,
            title: input.title,
            content: input.content,
            path: input.path,
            color: input.color,
            grid_columns: input.grid_columns,
            grid_rows: input.grid_rows,
            x: input.x,
            y: input.y,
            width: input.width,
            height: input.height,
        },
    )
    .await
    .map_err(map_db)?;
    let node = CanvasNode::from(row);
    emit_event(
        emitter,
        CANVAS_CHANGED_EVENT,
        CanvasChange::Upsert {
            node: Box::new(node.clone()),
            revision,
        },
    );
    Ok(CanvasMutation {
        value: node,
        revision,
    })
}

pub async fn canvas_group_into_region_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    input: GroupIntoRegionInput,
) -> Result<CanvasMutation<GroupIntoRegionResult>, AppCommandError> {
    // Read the frame before the request is taken apart: a malformed one is
    // rejected without ever reaching the write lock.
    let geometry = region_geometry(&input)?;
    let _order = event_order_lock().lock().await;
    let outcome = canvas_service::group_into_region(
        &db.conn,
        canvas_service::GroupIntoRegion {
            target_region_id: input.target_region_id,
            title: input.title,
            color: input.color,
            member_ids: input.member_ids,
            consume_node_ids: input.consume_node_ids,
            grid_columns: input.grid_columns,
            grid_rows: input.grid_rows,
            geometry,
        },
    )
    .await
    .map_err(map_db)?;
    let node = CanvasNode::from(outcome.node);
    emit_event(
        emitter,
        CANVAS_CHANGED_EVENT,
        CanvasChange::Grouped {
            node: Box::new(node.clone()),
            deleted_ids: outcome.deleted_ids.clone(),
            revision: outcome.revision,
        },
    );
    Ok(CanvasMutation {
        value: GroupIntoRegionResult {
            node,
            deleted_ids: outcome.deleted_ids,
        },
        revision: outcome.revision,
    })
}

pub async fn canvas_update_node_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    node_id: i32,
    patch: CanvasNodePatchInput,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    let (row, revision) = canvas_service::update_node(&db.conn, node_id, patch.into())
        .await
        .map_err(map_db)?;
    let node = CanvasNode::from(row);
    emit_event(
        emitter,
        CANVAS_CHANGED_EVENT,
        CanvasChange::Upsert {
            node: Box::new(node.clone()),
            revision,
        },
    );
    Ok(CanvasMutation {
        value: node,
        revision,
    })
}

/// Returns the moves as actually written (clamped, ghosts dropped) — the same
/// payload the broadcast carries, so optimistic client state can't diverge
/// from the database.
pub async fn canvas_move_nodes_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    moves: Vec<CanvasNodeMovePayload>,
) -> Result<CanvasMutation<Vec<CanvasNodeMovePayload>>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    let service_moves: Vec<canvas_service::CanvasNodeMove> = moves
        .iter()
        .map(|m| canvas_service::CanvasNodeMove {
            id: m.id,
            x: m.x,
            y: m.y,
        })
        .collect();
    match canvas_service::move_nodes(&db.conn, &service_moves)
        .await
        .map_err(map_db)?
    {
        Some((applied, revision)) => {
            let applied: Vec<CanvasNodeMovePayload> = applied
                .into_iter()
                .map(|m| CanvasNodeMovePayload {
                    id: m.id,
                    x: m.x,
                    y: m.y,
                })
                .collect();
            emit_event(
                emitter,
                CANVAS_CHANGED_EVENT,
                CanvasChange::Moved {
                    moves: applied.clone(),
                    revision,
                },
            );
            Ok(CanvasMutation {
                value: applied,
                revision,
            })
        }
        // Nothing was written (empty batch / every id raced a delete): no
        // bump, no event — report the current revision for coherence.
        None => {
            let revision = canvas_service::get_revision(&db.conn)
                .await
                .map_err(map_db)?;
            Ok(CanvasMutation {
                value: Vec::new(),
                revision,
            })
        }
    }
}

pub async fn canvas_detach_member_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    region_id: i32,
    conversation_id: i32,
    x: f64,
    y: f64,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    let outcome = canvas_service::detach_member(&db.conn, region_id, conversation_id, x, y)
        .await
        .map_err(map_db)?;
    let node = CanvasNode::from(outcome.node);
    emit_event(
        emitter,
        CANVAS_CHANGED_EVENT,
        CanvasChange::Detached {
            removed_from: outcome.removed_from,
            node: Box::new(node.clone()),
            revision: outcome.revision,
        },
    );
    Ok(CanvasMutation {
        value: node,
        revision: outcome.revision,
    })
}


/// The PTY id a `terminal` card owns. Mirrors `canvasTerminalId` in
/// `canvas-model.ts` — the card spawns under this name, so the two spellings
/// have to match exactly or a deleted card's shell becomes unreachable.
fn canvas_terminal_id(node_id: i32) -> String {
    format!("canvas-term-{node_id}")
}

/// End the shells of canvas nodes that were just deleted.
///
/// A terminal card's PTY outlives its component on purpose — the canvas is a
/// full-page route that really unmounts whenever the user looks at another
/// page, and a running command must not die with a view switch — so the one
/// thing that ends it is the CARD being deleted. That decision has to be made
/// where the deletion is authoritative: a client-side kill issued after its own
/// successful delete is a second, unretried request, and whenever THAT is the
/// one that gets lost the process keeps running with no card left to reach it
/// from.
///
/// Attempted for every deleted id rather than only the terminal rows: the id is
/// derived from the row id alone, terminal-panel tabs are uuid-named so they
/// cannot collide, and `kill` on an unknown id is a `NotFound` we ignore — so
/// this needs neither the row's kind nor a read of a row that no longer exists.
fn kill_canvas_terminals(terminals: &TerminalManager, node_ids: &[i32]) {
    for node_id in node_ids {
        let _ = terminals.kill(&canvas_terminal_id(*node_id));
    }
}

pub async fn canvas_delete_node_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    terminals: &TerminalManager,
    node_id: i32,
) -> Result<CanvasMutation<()>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    match canvas_service::delete_node(&db.conn, node_id)
        .await
        .map_err(map_db)?
    {
        Some(revision) => {
            kill_canvas_terminals(terminals, &[node_id]);
            emit_event(
                emitter,
                CANVAS_CHANGED_EVENT,
                CanvasChange::Deleted {
                    id: node_id,
                    revision,
                },
            );
            Ok(CanvasMutation {
                value: (),
                revision,
            })
        }
        // Already gone: nothing changed, no bump, no event — report the current
        // revision so the response stays coherent for the caller.
        None => {
            let revision = canvas_service::get_revision(&db.conn)
                .await
                .map_err(map_db)?;
            Ok(CanvasMutation {
                value: (),
                revision,
            })
        }
    }
}

/// Batch delete for a multi-selection: one transaction, one event. Reuses the
/// `Pruned` payload — "these ids are gone, these nodes changed" is exactly what
/// it means, and the client already applies it idempotently.
pub async fn canvas_delete_nodes_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    terminals: &TerminalManager,
    node_ids: Vec<i32>,
) -> Result<CanvasMutation<Vec<i32>>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    match canvas_service::delete_nodes(&db.conn, &node_ids)
        .await
        .map_err(map_db)?
    {
        Some((deleted_ids, revision)) => {
            // Only what was actually deleted: an id the batch skipped still has
            // a card, and that card still owns its shell.
            kill_canvas_terminals(terminals, &deleted_ids);
            emit_event(
                emitter,
                CANVAS_CHANGED_EVENT,
                CanvasChange::Pruned {
                    deleted_ids: deleted_ids.clone(),
                    updated: Vec::new(),
                    revision,
                },
            );
            Ok(CanvasMutation {
                value: deleted_ids,
                revision,
            })
        }
        // Empty batch / every id already gone: no bump, no event — report the
        // current revision so the response stays coherent for the caller.
        None => {
            let revision = canvas_service::get_revision(&db.conn)
                .await
                .map_err(map_db)?;
            Ok(CanvasMutation {
                value: Vec::new(),
                revision,
            })
        }
    }
}

/// Deletion-funnel hook, called from `delete_conversation_with_cleanup_core`
/// right next to the tab cleanup (same reasoning: conversation deletion is
/// soft, so no FK cascade will ever scrub the references). Best-effort at this
/// layer — the prune itself is transactional, and if it fails the references
/// stay behind as visible "unresolved" cards the user can remove by hand; the
/// liveness write-barrier guarantees no NEW reference to the dead conversation
/// can ever be minted, so the damage cannot grow.
pub(crate) async fn cleanup_canvas_for_deleted_conversation(
    emitter: &EventEmitter,
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
) {
    let _order = event_order_lock().lock().await;
    match canvas_service::prune_for_conversations(conn, &[conversation_id]).await {
        Ok(Some(outcome)) => {
            emit_event(
                emitter,
                CANVAS_CHANGED_EVENT,
                CanvasChange::Pruned {
                    deleted_ids: outcome.deleted_ids,
                    updated: outcome.updated.into_iter().map(CanvasNode::from).collect(),
                    revision: outcome.revision,
                },
            );
        }
        Ok(None) => {}
        Err(e) => tracing::error!(
            "[canvas] prune failed after deleting conversation {conversation_id}: {e}"
        ),
    }
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_list_nodes(
    db: tauri::State<'_, AppDatabase>,
) -> Result<CanvasSnapshot, AppCommandError> {
    canvas_list_nodes_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_create_node(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    input: CreateCanvasNode,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    canvas_create_node_core(&EventEmitter::Tauri(app), &db, input).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_group_into_region(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    input: GroupIntoRegionInput,
) -> Result<CanvasMutation<GroupIntoRegionResult>, AppCommandError> {
    canvas_group_into_region_core(&EventEmitter::Tauri(app), &db, input).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_update_node(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    node_id: i32,
    patch: CanvasNodePatchInput,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    canvas_update_node_core(&EventEmitter::Tauri(app), &db, node_id, patch).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_move_nodes(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    moves: Vec<CanvasNodeMovePayload>,
) -> Result<CanvasMutation<Vec<CanvasNodeMovePayload>>, AppCommandError> {
    canvas_move_nodes_core(&EventEmitter::Tauri(app), &db, moves).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_detach_member(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    region_id: i32,
    conversation_id: i32,
    x: f64,
    y: f64,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    canvas_detach_member_core(&EventEmitter::Tauri(app), &db, region_id, conversation_id, x, y)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_delete_node(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    terminals: tauri::State<'_, TerminalManager>,
    node_id: i32,
) -> Result<CanvasMutation<()>, AppCommandError> {
    canvas_delete_node_core(&EventEmitter::Tauri(app), &db, &terminals, node_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_delete_nodes(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    terminals: tauri::State<'_, TerminalManager>,
    node_ids: Vec<i32>,
) -> Result<CanvasMutation<Vec<i32>>, AppCommandError> {
    canvas_delete_nodes_core(&EventEmitter::Tauri(app), &db, &terminals, node_ids).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;

    fn emitter() -> EventEmitter {
        EventEmitter::Noop
    }

    #[test]
    fn the_pty_id_is_derived_from_the_row_alone() {
        // Must match `canvasTerminalId` in `canvas-model.ts` byte for byte: the
        // card spawns under this name and the delete below is the only handle
        // left to end it once the row is gone.
        assert_eq!(canvas_terminal_id(12), "canvas-term-12");
    }

    #[tokio::test]
    async fn deleting_a_terminal_card_ends_its_shell() {
        // The kill rides the deletion rather than following it from the client:
        // a client-side kill after its own successful delete is a second,
        // unretried request, and whenever that one is lost the process keeps
        // running with no card left to reach it from.
        let db = fresh_in_memory_db().await;
        let terminals = TerminalManager::new();
        let node = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                kind: CanvasNodeKind::Terminal,
                path: Some("/tmp".to_string()),
                ..region_input(CanvasNodeKind::Terminal)
            },
        )
        .await
        .expect("create terminal card")
        .value;

        // No PTY was ever spawned for this row, so the kill is a NotFound the
        // command swallows — what this pins down is that the command REACHES
        // for it, with the right id, and does not fail the delete over it.
        canvas_delete_node_core(&emitter(), &db, &terminals, node.id)
            .await
            .expect("delete succeeds even when there is no shell to end");
        assert!(terminals
            .kill(&canvas_terminal_id(node.id))
            .is_err());
    }

    fn region_input(kind: CanvasNodeKind) -> CreateCanvasNode {
        CreateCanvasNode {
            kind,
            folder_id: None,
            folder_group_id: None,
            agent_type: None,
            conversation_id: None,
            title: None,
            content: None,
            path: None,
            color: None,
            grid_columns: None,
            grid_rows: None,
            x: 100.0,
            y: 80.0,
            width: 480.0,
            height: 320.0,
        }
    }

    /// A bare region of the given kind, returning its id — the setup step of
    /// every test that cares about what happens TO a region.
    async fn seed_region(db: &AppDatabase, kind: CanvasNodeKind) -> i32 {
        canvas_create_node_core(&emitter(), db, region_input(kind))
            .await
            .expect("create region")
            .value
            .id
    }

    #[tokio::test]
    async fn create_list_roundtrip_advances_the_revision_once_per_mutation() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-a").await;

        let first = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_id: Some(folder_id),
                ..region_input(CanvasNodeKind::Folder)
            },
        )
        .await
        .expect("create folder region");
        assert_eq!(first.revision, 1);
        assert_eq!(first.value.folder_id, Some(folder_id));

        let second = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                agent_type: Some("claude_code".into()),
                ..region_input(CanvasNodeKind::Agent)
            },
        )
        .await
        .expect("create agent region");
        assert_eq!(second.revision, 2);

        let snapshot = canvas_list_nodes_core(&db).await.expect("snapshot");
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.nodes.len(), 2);
    }

    /// Every mutation transaction opens with `claim_writer` so SQLite hands it
    /// the writer lock instead of a read snapshot it would fail to promote
    /// (`SQLITE_BUSY_SNAPSHOT`). That claim is a write, so it must not be
    /// mistaken for a bump: revisions are a DENSE sequence, and a client that
    /// sees one skipped treats it as a gap and refetches the whole snapshot.
    ///
    /// So drive the paths that write nothing — a move and a delete naming ids
    /// that do not exist — and pin that the counter did not move, and that the
    /// next real mutation is still the immediate successor.
    #[tokio::test]
    async fn a_mutation_that_changes_nothing_consumes_no_revision() {
        let db = fresh_in_memory_db().await;
        let region = seed_region(&db, CanvasNodeKind::Custom).await;
        let after_create = canvas_list_nodes_core(&db).await.expect("snapshot").revision;
        assert_eq!(after_create, 1, "the one real mutation so far");

        let moved = canvas_move_nodes_core(
            &emitter(),
            &db,
            vec![CanvasNodeMovePayload {
                id: region + 4242, // no such node
                x: 10.0,
                y: 10.0,
            }],
        )
        .await
        .expect("move of a ghost is not an error");
        assert!(moved.value.is_empty(), "nothing was written");
        assert_eq!(moved.revision, after_create, "and nothing was consumed");

        let deleted = canvas_delete_nodes_core(&emitter(), &db, &TerminalManager::new(), vec![region + 4242])
            .await
            .expect("delete of a ghost is not an error");
        assert!(deleted.value.is_empty());
        assert_eq!(deleted.revision, after_create);

        // The real one that follows is the immediate successor — no gap for a
        // client to trip over.
        let next = seed_region(&db, CanvasNodeKind::Custom).await;
        assert_ne!(next, region);
        assert_eq!(
            canvas_list_nodes_core(&db).await.expect("snapshot").revision,
            after_create + 1
        );
    }

    #[tokio::test]
    async fn create_rejects_missing_bindings_and_dead_conversations() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-b").await;

        let no_folder =
            canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Folder)).await;
        assert!(no_folder.is_err(), "folder region without folder_id");

        let ghost_folder = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_id: Some(9999),
                ..region_input(CanvasNodeKind::Folder)
            },
        )
        .await;
        assert!(ghost_folder.is_err(), "folder region for a missing folder");

        // A conversation node must reference a LIVE conversation: the liveness
        // check is the write barrier that keeps a delayed create from
        // resurrecting a deleted reference after the prune ran.
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        crate::db::service::conversation_service::soft_delete(&db.conn, conv)
            .await
            .expect("soft delete");
        let dead = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                conversation_id: Some(conv),
                ..region_input(CanvasNodeKind::Conversation)
            },
        )
        .await;
        assert!(dead.is_err(), "conversation node for a deleted conversation");
    }

    #[tokio::test]
    async fn member_add_is_validated_deduplicated_and_scrubbed_by_the_prune() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-c").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let region = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Custom))
            .await
            .expect("custom region")
            .value;

        let patch = CanvasNodePatchInput {
            member_add: Some(conv),
            ..Default::default()
        };
        let updated = canvas_update_node_core(&emitter(), &db, region.id, patch.clone())
            .await
            .expect("member add");
        assert_eq!(updated.value.member_ids, vec![conv]);

        // Adding the same conversation again must not duplicate it.
        let again = canvas_update_node_core(&emitter(), &db, region.id, patch)
            .await
            .expect("idempotent add");
        assert_eq!(again.value.member_ids, vec![conv]);

        // Also pin it as a standalone card so the prune has both shapes to scrub.
        let pin = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                conversation_id: Some(conv),
                ..region_input(CanvasNodeKind::Conversation)
            },
        )
        .await
        .expect("pin")
        .value;

        crate::db::service::conversation_service::soft_delete(&db.conn, conv)
            .await
            .expect("soft delete");
        let outcome = canvas_service::prune_for_conversations(&db.conn, &[conv])
            .await
            .expect("prune")
            .expect("something referenced the conversation");
        assert_eq!(outcome.deleted_ids, vec![pin.id]);
        assert_eq!(outcome.updated.len(), 1);
        assert!(
            canvas_service::parse_member_ids(outcome.updated[0].member_ids.as_deref()).is_empty()
        );

        // Post-prune, a stale member_add for the dead conversation is rejected
        // (the liveness half of the barrier).
        let stale = canvas_update_node_core(
            &emitter(),
            &db,
            region.id,
            CanvasNodePatchInput {
                member_add: Some(conv),
                ..Default::default()
            },
        )
        .await;
        assert!(stale.is_err(), "member_add after deletion must be rejected");
    }

    #[tokio::test]
    async fn detach_moves_from_custom_and_copies_from_bindings() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-d").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let custom =
            canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Custom))
                .await
                .expect("custom")
                .value;
        canvas_update_node_core(
            &emitter(),
            &db,
            custom.id,
            CanvasNodePatchInput {
                member_add: Some(conv),
                ..Default::default()
            },
        )
        .await
        .expect("seed member");

        // Custom region: MOVE — membership goes away, a pin appears, one event.
        let moved = canvas_detach_member_core(&emitter(), &db, custom.id, conv, 900.0, 40.0)
            .await
            .expect("detach");
        assert_eq!(moved.value.conversation_id, Some(conv));
        let snapshot = canvas_list_nodes_core(&db).await.expect("snapshot");
        let region_row = snapshot
            .nodes
            .iter()
            .find(|n| n.id == custom.id)
            .expect("region still there");
        assert!(region_row.member_ids.is_empty(), "membership was removed");

        // A stale retry (membership already gone) must NOT mint a second pin.
        let retry = canvas_detach_member_core(&emitter(), &db, custom.id, conv, 900.0, 40.0).await;
        assert!(retry.is_err(), "detach without membership is stale");

        // Folder region: COPY — the binding has no member to remove.
        let folder_region = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_id: Some(folder_id),
                ..region_input(CanvasNodeKind::Folder)
            },
        )
        .await
        .expect("folder region")
        .value;
        let copied =
            canvas_detach_member_core(&emitter(), &db, folder_region.id, conv, 12.0, 24.0)
                .await
                .expect("copy detach");
        assert_eq!(copied.value.conversation_id, Some(conv));
    }

    #[tokio::test]
    async fn delete_is_idempotent_and_only_bumps_when_something_was_removed() {
        let db = fresh_in_memory_db().await;
        let node = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Note))
            .await
            .expect("note")
            .value;

        let first = canvas_delete_node_core(&emitter(), &db, &TerminalManager::new(), node.id)
            .await
            .expect("delete");
        assert_eq!(first.revision, 2);

        // Second delete: no-op, revision unchanged (no phantom event/bump).
        let second = canvas_delete_node_core(&emitter(), &db, &TerminalManager::new(), node.id)
            .await
            .expect("idempotent delete");
        assert_eq!(second.revision, 2);
    }

    #[tokio::test]
    async fn move_nodes_bumps_once_for_the_whole_batch_and_skips_ghosts() {
        let db = fresh_in_memory_db().await;
        let a = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Note))
            .await
            .expect("a")
            .value;
        let b = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Custom))
            .await
            .expect("b")
            .value;

        let moved = canvas_move_nodes_core(
            &emitter(),
            &db,
            vec![
                CanvasNodeMovePayload {
                    id: a.id,
                    x: 5.0,
                    y: 6.0,
                },
                CanvasNodeMovePayload {
                    id: b.id,
                    x: 7.0,
                    // Out of range: the response/broadcast must carry the
                    // value the database stored, not the caller's raw one.
                    y: 9_999_999.0,
                },
                // Racing a delete: unknown ids are skipped, not fatal.
                CanvasNodeMovePayload {
                    id: 424242,
                    x: 0.0,
                    y: 0.0,
                },
            ],
        )
        .await
        .expect("move batch");
        assert_eq!(moved.revision, 3, "one bump for the whole batch");
        let applied: Vec<(i32, f64, f64)> =
            moved.value.iter().map(|m| (m.id, m.x, m.y)).collect();
        assert_eq!(
            applied,
            vec![(a.id, 5.0, 6.0), (b.id, 7.0, 1_000_000.0)],
            "clamped, ghost dropped"
        );

        let snapshot = canvas_list_nodes_core(&db).await.expect("snapshot");
        let a_row = snapshot.nodes.iter().find(|n| n.id == a.id).unwrap();
        assert_eq!((a_row.x, a_row.y), (5.0, 6.0));

        // Every id a ghost: nothing written → no bump, no phantom revision.
        let noop = canvas_move_nodes_core(
            &emitter(),
            &db,
            vec![CanvasNodeMovePayload {
                id: 424242,
                x: 1.0,
                y: 1.0,
            }],
        )
        .await
        .expect("ghost-only move");
        assert_eq!(noop.revision, 3, "no bump when nothing was written");
        assert!(noop.value.is_empty());
    }

    #[tokio::test]
    async fn color_vocabulary_and_note_only_content_are_enforced() {
        let db = fresh_in_memory_db().await;

        let bad_color = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                color: Some("#ff0000".into()),
                ..region_input(CanvasNodeKind::Custom)
            },
        )
        .await;
        assert!(bad_color.is_err(), "hex colors are not preset names");

        let region = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Custom))
            .await
            .expect("region")
            .value;
        let good = canvas_update_node_core(
            &emitter(),
            &db,
            region.id,
            CanvasNodePatchInput {
                color: Some("violet".into()),
                ..Default::default()
            },
        )
        .await
        .expect("preset color accepted");
        assert_eq!(good.value.color.as_deref(), Some("violet"));

        let content_on_region = canvas_update_node_core(
            &emitter(),
            &db,
            region.id,
            CanvasNodePatchInput {
                content: Some("smuggled".into()),
                ..Default::default()
            },
        )
        .await;
        assert!(
            content_on_region.is_err(),
            "content is the note body, not region state"
        );
    }

    #[tokio::test]
    async fn snapshot_reads_nodes_and_revision_in_one_transaction() {
        // The pair must come from a single read transaction; the observable
        // contract here is that a snapshot taken after N mutations reports
        // exactly N with the matching node set (no torn pair on the happy
        // path — the transactional read is what extends this to races).
        let db = fresh_in_memory_db().await;
        for _ in 0..3 {
            canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Note))
                .await
                .expect("create");
        }
        let (nodes, revision) = canvas_service::snapshot(&db.conn).await.expect("snapshot");
        assert_eq!(revision, 3);
        assert_eq!(nodes.len(), 3);
    }

    async fn seed_group(db: &AppDatabase, name: &str) -> i32 {
        crate::db::service::folder_group_service::create_folder_group(
            &db.conn,
            name.to_string(),
            None,
        )
        .await
        .expect("seed folder group")
        .id
    }

    #[tokio::test]
    async fn group_regions_require_a_live_folder_group() {
        let db = fresh_in_memory_db().await;

        let missing = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_group_id: Some(4242),
                ..region_input(CanvasNodeKind::Group)
            },
        )
        .await;
        assert!(missing.is_err(), "unknown group id must not create a region");
        assert_eq!(
            canvas_list_nodes_core(&db).await.expect("snapshot").revision,
            0,
            "a rejected create must not bump the revision"
        );

        let unbound =
            canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Group)).await;
        assert!(unbound.is_err(), "group region needs folder_group_id");

        let group_id = seed_group(&db, "Work").await;
        let created = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_group_id: Some(group_id),
                ..region_input(CanvasNodeKind::Group)
            },
        )
        .await
        .expect("create group region");
        assert_eq!(created.value.folder_group_id, Some(group_id));
        assert_eq!(created.value.folder_id, None);
    }

    #[tokio::test]
    async fn grid_shape_is_clamped_and_region_only() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-grid").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let region = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                grid_columns: Some(99),
                grid_rows: Some(-4),
                ..region_input(CanvasNodeKind::Custom)
            },
        )
        .await
        .expect("create custom region");
        assert_eq!(
            region.value.grid_columns,
            canvas_service::MAX_GRID_AXIS,
            "an out-of-range column count clamps instead of failing the write"
        );
        assert_eq!(region.value.grid_rows, 0, "negative reads as auto");

        let patched = canvas_update_node_core(
            &emitter(),
            &db,
            region.value.id,
            CanvasNodePatchInput {
                grid_columns: Some(3),
                grid_rows: Some(2),
                ..Default::default()
            },
        )
        .await
        .expect("patch grid");
        assert_eq!(patched.value.grid_columns, 3);
        assert_eq!(patched.value.grid_rows, 2);

        let pin = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                conversation_id: Some(conv),
                grid_columns: Some(4),
                ..region_input(CanvasNodeKind::Conversation)
            },
        )
        .await
        .expect("create pin");
        assert_eq!(
            pin.value.grid_columns, 0,
            "a pinned card never carries a grid shape"
        );

        let rejected = canvas_update_node_core(
            &emitter(),
            &db,
            pin.value.id,
            CanvasNodePatchInput {
                grid_columns: Some(2),
                ..Default::default()
            },
        )
        .await;
        assert!(rejected.is_err(), "grid shape is region-only");
    }

    #[tokio::test]
    async fn group_into_region_rejects_a_dead_conversation_without_bumping() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-select-dead").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        crate::db::service::conversation_service::soft_delete(&db.conn, conv)
            .await
            .expect("soft delete");

        let result = canvas_group_into_region_core(
            &emitter(),
            &db,
            GroupIntoRegionInput {
                target_region_id: None,
                title: None,
                color: None,
                member_ids: vec![conv],
                consume_node_ids: Vec::new(),
                grid_columns: None,
                grid_rows: None,
                x: Some(0.0),
                y: Some(0.0),
                width: Some(400.0),
                height: Some(300.0),
            },
        )
        .await;

        assert!(result.is_err(), "a deleted conversation cannot be collected");
        let snapshot = canvas_list_nodes_core(&db).await.expect("snapshot");
        assert_eq!(snapshot.revision, 0);
        assert!(
            snapshot.nodes.is_empty(),
            "the transaction rolled back whole"
        );
    }

    /// Dragging a pinned card into an existing custom region: the member lands
    /// in the region and the loose card is gone, in one revision.
    #[tokio::test]
    async fn group_into_existing_region_merges_members_and_consumes_the_pin() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-group-into").await;
        let seated = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        let dragged = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let region = seed_region(&db, CanvasNodeKind::Custom).await;
        canvas_update_node_core(
            &emitter(),
            &db,
            region,
            CanvasNodePatchInput {
                member_add: Some(seated),
                ..Default::default()
            },
        )
        .await
        .expect("seed member");
        let pin = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                conversation_id: Some(dragged),
                ..region_input(CanvasNodeKind::Conversation)
            },
        )
        .await
        .expect("create pin");

        let before = canvas_list_nodes_core(&db).await.expect("snapshot").revision;
        let merged = canvas_group_into_region_core(
            &emitter(),
            &db,
            GroupIntoRegionInput {
                target_region_id: Some(region),
                title: None,
                color: None,
                // `seated` is already there: the merge is a set union, not an
                // append, or a re-drop would double the card.
                member_ids: vec![dragged, seated],
                consume_node_ids: vec![pin.value.id],
                grid_columns: None,
                grid_rows: None,
                // No geometry: the frame is already on the board.
                x: None,
                y: None,
                width: None,
                height: None,
            },
        )
        .await
        .expect("merge into region");

        assert_eq!(merged.value.node.id, region, "no new region was created");
        assert_eq!(merged.value.node.member_ids, vec![seated, dragged]);
        assert_eq!(merged.value.deleted_ids, vec![pin.value.id]);
        assert_eq!(
            merged.revision,
            before + 1,
            "membership + deletion is ONE bump"
        );
    }

    /// Creating a region without saying where it goes is a caller bug, not a
    /// region at the 48px minimum in the top-left corner.
    #[tokio::test]
    async fn group_into_a_new_region_requires_geometry() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-no-geometry").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let rejected = canvas_group_into_region_core(
            &emitter(),
            &db,
            GroupIntoRegionInput {
                target_region_id: None,
                title: None,
                color: None,
                member_ids: vec![conv],
                consume_node_ids: Vec::new(),
                grid_columns: None,
                grid_rows: None,
                x: Some(10.0),
                y: Some(10.0),
                // Half a frame is no frame.
                width: None,
                height: None,
            },
        )
        .await;

        assert!(rejected.is_err());
        assert_eq!(
            canvas_list_nodes_core(&db).await.expect("snapshot").revision,
            0
        );
    }

    #[tokio::test]
    async fn group_into_region_rejects_a_binding_region_target() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-group-binding").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        let folder_region = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_id: Some(folder_id),
                ..region_input(CanvasNodeKind::Folder)
            },
        )
        .await
        .expect("create folder region");

        let before = canvas_list_nodes_core(&db).await.expect("snapshot").revision;
        let rejected = canvas_group_into_region_core(
            &emitter(),
            &db,
            GroupIntoRegionInput {
                target_region_id: Some(folder_region.value.id),
                title: None,
                color: None,
                member_ids: vec![conv],
                consume_node_ids: Vec::new(),
                grid_columns: None,
                grid_rows: None,
                x: None,
                y: None,
                width: None,
                height: None,
            },
        )
        .await;

        assert!(
            rejected.is_err(),
            "a folder region's members are a live binding"
        );
        assert_eq!(
            canvas_list_nodes_core(&db).await.expect("snapshot").revision,
            before,
            "a rejected merge does not bump"
        );
    }

    /// The merge path ignores geometry, but "ignores" must not mean "accepts
    /// anything": a caller that half-fills the frame has a bug worth hearing
    /// about, and staying silent here is what let the create path's own
    /// half-frame slip through as a plain "needs geometry".
    #[tokio::test]
    async fn merging_still_rejects_a_half_specified_frame() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-merge-half-frame").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        let region = seed_region(&db, CanvasNodeKind::Custom).await;
        let before = canvas_list_nodes_core(&db).await.expect("snapshot").revision;

        let rejected = canvas_group_into_region_core(
            &emitter(),
            &db,
            GroupIntoRegionInput {
                target_region_id: Some(region),
                title: None,
                color: None,
                member_ids: vec![conv],
                consume_node_ids: Vec::new(),
                grid_columns: None,
                grid_rows: None,
                x: Some(10.0),
                y: None,
                width: None,
                height: None,
            },
        )
        .await;

        assert!(rejected.is_err());
        assert_eq!(
            canvas_list_nodes_core(&db).await.expect("snapshot").revision,
            before,
            "a rejected merge does not bump"
        );
    }

    /// Consuming a card means the region took it over. If the takeover isn't in
    /// the member list the card is simply destroyed — and the `Grouped` event
    /// would report that loss as a successful collection.
    #[tokio::test]
    async fn a_consumed_card_the_region_never_adopts_is_refused() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-orphan-consume").await;
        let stranded = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        let region = seed_region(&db, CanvasNodeKind::Custom).await;
        let pin = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                conversation_id: Some(stranded),
                ..region_input(CanvasNodeKind::Conversation)
            },
        )
        .await
        .expect("create pin");
        let before = canvas_list_nodes_core(&db).await.expect("snapshot").revision;

        let rejected = canvas_group_into_region_core(
            &emitter(),
            &db,
            GroupIntoRegionInput {
                target_region_id: Some(region),
                title: None,
                color: None,
                // The card is named for deletion, its conversation for nothing.
                member_ids: Vec::new(),
                consume_node_ids: vec![pin.value.id],
                grid_columns: None,
                grid_rows: None,
                x: None,
                y: None,
                width: None,
                height: None,
            },
        )
        .await;

        assert!(rejected.is_err());
        let after = canvas_list_nodes_core(&db).await.expect("snapshot");
        assert_eq!(after.revision, before, "a refused consume does not bump");
        assert!(
            after.nodes.iter().any(|n| n.id == pin.value.id),
            "the card the region declined to adopt is still on the board"
        );
    }

    #[tokio::test]
    async fn delete_nodes_removes_the_batch_in_one_revision() {
        let db = fresh_in_memory_db().await;
        let first = seed_region(&db, CanvasNodeKind::Custom).await;
        let second = seed_region(&db, CanvasNodeKind::Custom).await;
        let before = canvas_list_nodes_core(&db).await.expect("snapshot").revision;

        let deleted = canvas_delete_nodes_core(&emitter(), &db, &TerminalManager::new(), vec![first, second, 4242])
            .await
            .expect("delete batch");
        assert_eq!(deleted.value, vec![first, second], "ghost ids are skipped");
        assert_eq!(deleted.revision, before + 1);
        assert!(canvas_list_nodes_core(&db)
            .await
            .expect("snapshot")
            .nodes
            .is_empty());

        // Nothing left to delete: no bump, no phantom event.
        let noop = canvas_delete_nodes_core(&emitter(), &db, &TerminalManager::new(), vec![first])
            .await
            .expect("delete gone");
        assert!(noop.value.is_empty());
        assert_eq!(noop.revision, deleted.revision);
    }
}

/// Event-shape coverage: the funnel prune emits ONE `Pruned` event carrying the
/// scrubbed state, over the same broadcaster the web/tauri bridges consume.
#[cfg(test)]
mod broadcast_tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;
    use crate::web::event_bridge::WebEventBroadcaster;
    use std::sync::Arc;

    #[tokio::test]
    async fn prune_broadcasts_a_single_batched_event() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-e").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let noop = EventEmitter::Noop;
        canvas_create_node_core(
            &noop,
            &db,
            CreateCanvasNode {
                kind: crate::db::entities::canvas_node::CanvasNodeKind::Conversation,
                folder_id: None,
                folder_group_id: None,
                agent_type: None,
                conversation_id: Some(conv),
                title: None,
                content: None,
                path: None,
                color: None,
                grid_columns: None,
                grid_rows: None,
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 120.0,
            },
        )
        .await
        .expect("pin");

        crate::db::service::conversation_service::soft_delete(&db.conn, conv)
            .await
            .expect("soft delete");

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        cleanup_canvas_for_deleted_conversation(&emitter, &db.conn, conv).await;

        let event = rx.try_recv().expect("one canvas event");
        assert_eq!(event.channel, CANVAS_CHANGED_EVENT);
        assert_eq!(event.payload["kind"], "pruned");
        assert_eq!(event.payload["revision"], 2);
        assert_eq!(
            event.payload["deleted_ids"].as_array().map(|a| a.len()),
            Some(1)
        );
        assert!(rx.try_recv().is_err(), "exactly one event for the prune");
    }

    fn pin_input(conversation_id: i32) -> CreateCanvasNode {
        CreateCanvasNode {
            kind: CanvasNodeKind::Conversation,
            folder_id: None,
            folder_group_id: None,
            agent_type: None,
            conversation_id: Some(conversation_id),
            title: None,
            content: None,
            path: None,
            color: None,
            grid_columns: None,
            grid_rows: None,
            x: 0.0,
            y: 0.0,
            width: 224.0,
            height: 132.0,
        }
    }

    #[tokio::test]
    async fn group_into_new_region_collects_and_consumes_in_one_event() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-select").await;
        let first = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        let second = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let noop = EventEmitter::Noop;
        let pin = canvas_create_node_core(&noop, &db, pin_input(first))
            .await
            .expect("create pin");
        // A region is NOT a pin: naming it must not delete it.
        let bystander = canvas_create_node_core(
            &noop,
            &db,
            CreateCanvasNode {
                kind: CanvasNodeKind::Custom,
                conversation_id: None,
                width: 480.0,
                height: 320.0,
                ..pin_input(first)
            },
        )
        .await
        .expect("create bystander region");

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        let created = canvas_group_into_region_core(
            &emitter,
            &db,
            GroupIntoRegionInput {
                target_region_id: None,
                title: Some("  Selection  ".into()),
                color: None,
                // `first` twice: the same conversation can be selected through
                // two mirrors of itself.
                member_ids: vec![first, second, first],
                consume_node_ids: vec![pin.value.id, bystander.value.id, 9999],
                grid_columns: Some(2),
                grid_rows: None,
                x: Some(10.0),
                y: Some(20.0),
                width: Some(500.0),
                height: Some(400.0),
            },
        )
        .await
        .expect("create region from selection");

        assert_eq!(created.value.node.member_ids, vec![first, second]);
        assert_eq!(created.value.node.title.as_deref(), Some("Selection"));
        assert_eq!(created.value.node.grid_columns, 2);
        assert_eq!(
            created.value.deleted_ids,
            vec![pin.value.id],
            "only pinned cards are consumable"
        );

        let event = rx.try_recv().expect("one canvas event");
        assert_eq!(event.channel, CANVAS_CHANGED_EVENT);
        assert_eq!(event.payload["kind"], "grouped");
        assert_eq!(event.payload["revision"], created.revision);
        assert!(
            rx.try_recv().is_err(),
            "the whole gesture broadcasts exactly once"
        );

        let snapshot = canvas_list_nodes_core(&db).await.expect("snapshot");
        assert_eq!(snapshot.revision, created.revision);
        assert!(
            snapshot.nodes.iter().all(|n| n.id != pin.value.id),
            "the consumed pin is gone"
        );
        assert!(
            snapshot.nodes.iter().any(|n| n.id == bystander.value.id),
            "the bystander region survived"
        );
    }

    /// Multi-select delete: one `Pruned` event for the whole batch, not one
    /// `Deleted` per node (which would make every other client watch the
    /// selection disappear in pieces, each costing a revision).
    #[tokio::test]
    async fn delete_nodes_broadcasts_one_pruned_event() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-batch-delete").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let noop = EventEmitter::Noop;
        let first = canvas_create_node_core(&noop, &db, pin_input(conv))
            .await
            .expect("create pin");
        let second = canvas_create_node_core(
            &noop,
            &db,
            CreateCanvasNode {
                kind: CanvasNodeKind::Note,
                conversation_id: None,
                ..pin_input(conv)
            },
        )
        .await
        .expect("create note");

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        let deleted =
            canvas_delete_nodes_core(&emitter, &db, &TerminalManager::new(), vec![first.value.id, second.value.id])
                .await
                .expect("delete batch");

        let event = rx.try_recv().expect("one canvas event");
        assert_eq!(event.channel, CANVAS_CHANGED_EVENT);
        assert_eq!(event.payload["kind"], "pruned");
        assert_eq!(event.payload["revision"], deleted.revision);
        assert!(
            rx.try_recv().is_err(),
            "the whole batch broadcasts exactly once"
        );
        assert!(canvas_list_nodes_core(&db)
            .await
            .expect("snapshot")
            .nodes
            .is_empty());
    }
}
