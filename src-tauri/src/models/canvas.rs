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

/// Response for `canvas_list_nodes`: the full node set plus the revision it was
/// read at (single read transaction — see `canvas_service::snapshot`). Clients
/// seed `lastRevision` from this and accept a snapshot only when its revision
/// is at or above what they already applied.
#[derive(Debug, Clone, Serialize)]
pub struct CanvasSnapshot {
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
