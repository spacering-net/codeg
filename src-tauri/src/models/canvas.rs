use chrono::{DateTime, Utc};
use serde::Serialize;

pub use crate::db::entities::canvas_node::CanvasNodeKind;
use crate::db::service::canvas_service;

/// Wire shape of one canvas element. Snake_case fields, matching the other
/// list-row models the canvas UI sits alongside (`DbConversationSummary`,
/// `FolderDetail`); the write-side inputs in `commands/canvas.rs` are camelCase
/// like every other request struct.
#[derive(Debug, Clone, Serialize)]
pub struct CanvasNode {
    pub id: i32,
    /// The canvas this node sits on. Fixed for the node's life, so a client
    /// holding one board scopes the global `canvas://changed` stream by it.
    pub board_id: i32,
    pub kind: CanvasNodeKind,
    pub folder_id: Option<i32>,
    pub folder_group_id: Option<i32>,
    pub agent_type: Option<String>,
    pub conversation_id: Option<i32>,
    /// kind=custom: pinned conversation ids in insertion order; `[]` otherwise.
    pub member_ids: Vec<i32>,
    pub title: Option<String>,
    pub content: Option<String>,
    /// kind=file: the document's absolute path; kind=terminal: its working
    /// directory. `None` for every other kind.
    pub path: Option<String>,
    pub color: Option<String>,
    pub collapsed: bool,
    /// Region grid shape; 0 on either axis means "auto" (see the entity).
    pub grid_columns: i32,
    pub grid_rows: i32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<crate::db::entities::canvas_node::Model> for CanvasNode {
    fn from(m: crate::db::entities::canvas_node::Model) -> Self {
        CanvasNode {
            id: m.id,
            board_id: m.board_id,
            kind: m.kind,
            folder_id: m.folder_id,
            folder_group_id: m.folder_group_id,
            agent_type: m.agent_type,
            conversation_id: m.conversation_id,
            member_ids: canvas_service::parse_member_ids(m.member_ids.as_deref()),
            title: m.title,
            content: m.content,
            path: m.path,
            color: m.color,
            collapsed: m.collapsed,
            grid_columns: m.grid_columns,
            grid_rows: m.grid_rows,
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
            created_at: m.created_at,
            updated_at: m.updated_at,
        }
    }
}

/// Response for `canvas_list_nodes`: one board's full node set plus the
/// revision it was read at (single read transaction — see
/// `canvas_service::snapshot`). Clients seed `lastRevision` from this and accept
/// a snapshot only when its revision is at or above what they already applied.
/// The revision is the workspace-global one, not a per-board counter.
#[derive(Debug, Clone, Serialize)]
pub struct CanvasSnapshot {
    /// Which board `nodes` is — echoed so a client that has switched boards
    /// since asking can tell the answer is not for the board it now shows.
    pub board_id: i32,
    pub nodes: Vec<CanvasNode>,
    pub revision: i64,
}

/// Response envelope for every canvas mutation: the command's result value plus
/// the revision its single broadcast event carries. Responses never advance the
/// client's `lastRevision` (the event stream is the only ordered channel); a
/// response's value is applied as optimistic confirmation only while its
/// revision is still ahead of `lastRevision`.
#[derive(Debug, Clone, Serialize)]
pub struct CanvasMutation<T: Serialize> {
    pub value: T,
    pub revision: i64,
}

/// Wire shape of one canvas (a board on the canvas list). Snake_case like
/// [`CanvasNode`]. `name` is `None` until the user names it — the client shows
/// a localized "Untitled canvas" rather than the backend inventing a string in
/// one language.
#[derive(Debug, Clone, Serialize)]
pub struct CanvasBoard {
    pub id: i32,
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Last change to the board or anything on it (node writes stamp it too).
    pub updated_at: DateTime<Utc>,
}

impl From<crate::db::entities::canvas_board::Model> for CanvasBoard {
    fn from(m: crate::db::entities::canvas_board::Model) -> Self {
        CanvasBoard {
            id: m.id,
            name: m.name,
            description: m.description,
            color: m.color,
            created_at: m.created_at,
            updated_at: m.updated_at,
        }
    }
}

/// One node's footprint on a board's list card — just enough to draw its
/// silhouette.
#[derive(Debug, Clone, Serialize)]
pub struct CanvasBoardPreviewRect {
    pub kind: CanvasNodeKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: Option<String>,
}

/// Row of `canvas_list_boards`: the board plus what its card shows about the
/// nodes on it.
#[derive(Debug, Clone, Serialize)]
pub struct CanvasBoardSummary {
    pub board: CanvasBoard,
    pub node_count: i64,
    /// Terminal cards on the board: shells a board delete would stop.
    pub terminal_count: i64,
    /// Largest-first footprints, capped at
    /// `canvas_service::MAX_BOARD_PREVIEW_RECTS`.
    pub preview: Vec<CanvasBoardPreviewRect>,
}

impl From<canvas_service::BoardSummary> for CanvasBoardSummary {
    fn from(s: canvas_service::BoardSummary) -> Self {
        CanvasBoardSummary {
            board: CanvasBoard::from(s.board),
            node_count: s.node_count,
            terminal_count: s.terminal_count,
            preview: s
                .preview
                .into_iter()
                .map(|r| CanvasBoardPreviewRect {
                    kind: r.kind,
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                    color: r.color,
                })
                .collect(),
        }
    }
}
