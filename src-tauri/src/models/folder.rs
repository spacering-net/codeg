use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::AgentType;
use crate::db::entities::folder::FolderKind;

#[derive(Debug, Clone, Serialize)]
pub struct FolderHistoryEntry {
    pub id: i32,
    pub path: String,
    pub name: String,
    pub last_opened_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderDetail {
    pub id: i32,
    pub name: String,
    pub path: String,
    pub git_branch: Option<String>,
    pub default_agent_type: Option<AgentType>,
    pub last_opened_at: DateTime<Utc>,
    pub sort_order: i32,
    pub color: String,
    /// Root folder this one was created under (worktree folders only); NULL for
    /// top-level folders. Drives sidebar merge + worktree-branch detection.
    pub parent_id: Option<i32>,
    /// Folder classification (mirrors `folder.kind`). `chat` folders are kept in
    /// `allFolders` (so cwd / active-folder resolve) but hidden from folder
    /// lists; their conversations route to the sidebar "Chat" group.
    pub kind: FolderKind,
    /// User-supplied display alias, or NULL when unset. When present the sidebar
    /// folder header and conversation header render `alias [name]`.
    pub alias: Option<String>,
    /// Sidebar folder group this folder belongs to, or NULL for top level.
    /// Display-only grouping — never consulted for cwd, agent or conversation
    /// resolution. Always NULL on worktree children (they follow their repo).
    pub group_id: Option<i32>,
}

/// A sidebar folder group. Ordered against ungrouped top-level folders by the
/// shared `sort_order` space, so the two interleave in one list.
#[derive(Debug, Clone, Serialize)]
pub struct FolderGroupDetail {
    pub id: i32,
    pub name: String,
    /// One of the shared theme colors, or `"inherit"`. Tints only the group's
    /// own header row; member folders keep their own color.
    pub color: String,
    pub sort_order: i32,
}

/// Which kind of sidebar entry a {@link SidebarLayoutEntry} names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SidebarEntryKind {
    Folder,
    Group,
}

/// One row of the sidebar's desired layout, as submitted by the client after a
/// drag. The client sends the COMPLETE visible layout — the top-level sequence
/// followed by each group's members, in render order — and the writer assigns
/// `sort_order` from a per-container counter, so the call is idempotent and
/// self-healing. Rows not named here (e.g. closed folders) are left untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarLayoutEntry {
    pub kind: SidebarEntryKind,
    pub id: i32,
    /// Only meaningful for `folder` entries: the group it lands in, or None for
    /// top level. Ignored (and always None) for `group` entries — groups never
    /// nest.
    #[serde(default)]
    pub group_id: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenedTab {
    pub id: i32,
    pub folder_id: i32,
    pub conversation_id: Option<i32>,
    pub agent_type: AgentType,
    pub position: i32,
    pub is_active: bool,
    pub is_pinned: bool,
}

/// Response for `list_opened_tabs`: the persisted tab set plus the current
/// workspace tab version. Clients seed their compare-and-set / echo logic from
/// `version`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedTabsSnapshot {
    pub items: Vec<OpenedTab>,
    pub version: i64,
}

/// Response for `save_opened_tabs`: whether the compare-and-set was applied, the
/// authoritative version after the call, and the canonical tab set. When
/// `accepted` is false the save was stale (another client won) and `tabs` is the
/// current truth to reconcile against.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTabsOutcome {
    pub accepted: bool,
    pub version: i64,
    pub tabs: Vec<OpenedTab>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderCommandInfo {
    pub id: i32,
    pub folder_id: i32,
    pub name: String,
    pub command: String,
    pub sort_order: i32,
    /// Run by the desktop app on its own machine, detached, instead of in a
    /// terminal on the folder's host.
    pub run_local: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
