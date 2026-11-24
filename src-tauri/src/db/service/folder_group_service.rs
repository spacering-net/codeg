//! Sidebar folder groups: named containers the user drops workspace folders
//! into so a long folder list can be split into "work / open source / scratch".
//!
//! ## The one ordering invariant
//!
//! `sort_order` is a folder's / group's position **among its siblings in the
//! same container**:
//!
//! - The TOP-LEVEL container holds every group plus every ungrouped, non-worktree
//!   folder. Both share one numeric sequence *across the two tables* — that
//!   shared space is exactly what lets groups and loose folders interleave in a
//!   single sidebar list.
//! - A group's container holds the folders whose `group_id` is that group, with
//!   their own 1..n sequence.
//! - Worktree children (`parent_id` set) are in neither: they follow their repo
//!   and always keep `group_id = NULL`.
//!
//! Nothing here reads a folder's `kind` beyond skipping hidden chat folders,
//! and nothing outside the sidebar consults a group.

use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, Set,
};

use crate::db::entities::folder;
use crate::db::entities::folder::FolderKind;
use crate::db::entities::folder_group;
use crate::db::error::DbError;
use crate::db::service::folder_service::{assign_folder_positions, DEFAULT_FOLDER_COLOR};
use crate::models::{FolderGroupDetail, SidebarEntryKind, SidebarLayoutEntry};

fn to_detail(m: folder_group::Model) -> FolderGroupDetail {
    FolderGroupDetail {
        id: m.id,
        name: m.name,
        color: m.color,
        sort_order: m.sort_order,
    }
}

/// Every group, in sidebar order. Ties break on `id` so the sequence is stable
/// even when two rows share a `sort_order` (possible right after a partial
/// write, or for two groups created before either was ever dragged).
pub async fn list_folder_groups(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderGroupDetail>, DbError> {
    let rows = folder_group::Entity::find()
        .order_by_asc(folder_group::Column::SortOrder)
        .order_by_asc(folder_group::Column::Id)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(to_detail).collect())
}

/// Highest `sort_order` currently in use at the TOP LEVEL — across both tables,
/// since they share that sequence. Used to append a new group after everything
/// already there.
async fn max_top_level_sort_order(conn: &DatabaseConnection) -> Result<i32, DbError> {
    let max_group = folder_group::Entity::find()
        .order_by_desc(folder_group::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(0);
    let max_folder = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .filter(folder::Column::GroupId.is_null())
        .filter(folder::Column::ParentId.is_null())
        .order_by_desc(folder::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(0);
    Ok(max_group.max(max_folder))
}

/// Create a group, appended after every existing top-level entry.
///
/// The max-order read happens BEFORE the insert and outside any explicit
/// transaction on purpose: wrapping a read and a write in one SQLite
/// transaction is how this codebase has produced `SQLITE_BUSY` (517) snapshot
/// upgrades before. A lost race here just means two groups share a
/// `sort_order`, which the id tie-break in [`list_folder_groups`] absorbs.
pub async fn create_folder_group(
    conn: &DatabaseConnection,
    name: String,
    color: Option<String>,
) -> Result<FolderGroupDetail, DbError> {
    let now = Utc::now();
    let next_order = max_top_level_sort_order(conn).await? + 1;
    let active = folder_group::ActiveModel {
        id: NotSet,
        name: Set(name),
        color: Set(color.unwrap_or_else(|| DEFAULT_FOLDER_COLOR.to_string())),
        sort_order: Set(next_order),
        created_at: Set(now),
        updated_at: Set(now),
    };
    Ok(to_detail(active.insert(conn).await?))
}

/// Patch a group's name and/or color. `None` leaves that field alone, so the
/// rename dialog and the color picker can share one endpoint without either
/// clobbering the other's value.
pub async fn update_folder_group(
    conn: &DatabaseConnection,
    id: i32,
    name: Option<String>,
    color: Option<String>,
) -> Result<Option<FolderGroupDetail>, DbError> {
    let Some(row) = folder_group::Entity::find_by_id(id).one(conn).await? else {
        return Ok(None);
    };
    if name.is_none() && color.is_none() {
        return Ok(Some(to_detail(row)));
    }
    let mut active: folder_group::ActiveModel = row.into();
    if let Some(name) = name {
        active.name = Set(name);
    }
    if let Some(color) = color {
        active.color = Set(color);
    }
    active.updated_at = Set(Utc::now());
    Ok(Some(to_detail(active.update(conn).await?)))
}

/// Delete a group and return its members to the top level.
///
/// The folders themselves are never touched beyond `group_id` / `sort_order` —
/// deleting a group must not close, hide or forget a single folder. Members are
/// appended after the existing top-level entries, preserving their relative
/// order, so the list reads the same minus the group band.
pub async fn delete_folder_group(conn: &DatabaseConnection, id: i32) -> Result<bool, DbError> {
    let members = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::GroupId.eq(id))
        .order_by_asc(folder::Column::SortOrder)
        .order_by_asc(folder::Column::Id)
        .all(conn)
        .await?;

    if !members.is_empty() {
        let base = max_top_level_sort_order(conn).await?;
        let assignments: Vec<(i32, i32, Option<i32>)> = members
            .iter()
            .enumerate()
            .map(|(idx, m)| (m.id, base + 1 + idx as i32, None))
            .collect();
        assign_folder_positions(conn, &assignments).await?;
    }

    let deleted = folder_group::Entity::delete_by_id(id).exec(conn).await?;
    Ok(deleted.rows_affected > 0)
}

/// Write a whole sidebar layout: the top-level sequence followed by each
/// group's members, in render order.
///
/// The client always submits the COMPLETE visible layout rather than a delta,
/// so this is idempotent and self-healing — a dropped event or a stale
/// optimistic order is corrected by the next drop. Rows the client did not name
/// (closed folders, groups it never saw) are left untouched, matching how the
/// old folder-only reorder behaved.
///
/// Positions are assigned from a per-container counter as the array is walked,
/// which is what makes the wire format positional: the caller does not compute
/// `sort_order` values, only order.
///
/// Deliberately does no reads: everything needed is in `entries`, so there is
/// no read-then-write inside one transaction to upgrade into `SQLITE_BUSY`.
pub async fn apply_sidebar_layout(
    conn: &DatabaseConnection,
    entries: Vec<SidebarLayoutEntry>,
) -> Result<(), DbError> {
    if entries.is_empty() {
        return Ok(());
    }

    // One counter per container: `None` is the top level (shared by groups and
    // ungrouped folders), `Some(g)` is inside group `g`.
    let mut next_order: std::collections::HashMap<Option<i32>, i32> =
        std::collections::HashMap::new();
    let mut folder_assignments: Vec<(i32, i32, Option<i32>)> = Vec::new();
    let mut group_assignments: Vec<(i32, i32)> = Vec::new();
    // A group can only appear once, and only at the top level; a repeated id
    // would otherwise consume two slots and shift everything after it.
    let mut seen_groups: std::collections::HashSet<i32> = std::collections::HashSet::new();
    let mut seen_folders: std::collections::HashSet<i32> = std::collections::HashSet::new();

    for entry in entries {
        match entry.kind {
            SidebarEntryKind::Group => {
                if !seen_groups.insert(entry.id) {
                    continue;
                }
                let slot = next_order.entry(None).or_insert(0);
                *slot += 1;
                group_assignments.push((entry.id, *slot));
            }
            SidebarEntryKind::Folder => {
                if !seen_folders.insert(entry.id) {
                    continue;
                }
                let container = entry.group_id;
                let slot = next_order.entry(container).or_insert(0);
                *slot += 1;
                folder_assignments.push((entry.id, *slot, container));
            }
        }
    }

    assign_folder_positions(conn, &folder_assignments).await?;

    if !group_assignments.is_empty() {
        let now = Utc::now();
        for (id, order) in group_assignments {
            // `update_many` rather than `ActiveModel::update`, which turns "no
            // such row" into `RecordNotUpdated`. A drag that began before
            // another window deleted a group still names it on drop, and
            // failing here would fail AFTER the folder writes above committed —
            // the client would then roll its optimistic state back over a
            // database that had already moved on. Matching zero rows is the
            // right outcome: the group is gone, its slot was already skipped by
            // the reader, and the folders landed where the user dropped them.
            folder_group::Entity::update_many()
                .col_expr(folder_group::Column::SortOrder, Expr::value(order))
                .col_expr(folder_group::Column::UpdatedAt, Expr::value(now))
                .filter(folder_group::Column::Id.eq(id))
                .exec(conn)
                .await?;
        }
    }

    Ok(())
}

/// Move one folder into (or out of) a group without touching anything else —
/// the context menu's "Move to group…" path, which has no drag geometry to
/// derive a position from. The folder is appended to the end of its new
/// container.
pub async fn set_folder_group(
    conn: &DatabaseConnection,
    folder_id: i32,
    group_id: Option<i32>,
) -> Result<(), DbError> {
    let next_order = match group_id {
        Some(g) => {
            folder::Entity::find()
                .filter(folder::Column::DeletedAt.is_null())
                .filter(folder::Column::GroupId.eq(g))
                .select_only()
                .column(folder::Column::SortOrder)
                .order_by_desc(folder::Column::SortOrder)
                .into_tuple::<i32>()
                .one(conn)
                .await?
                .unwrap_or(0)
                + 1
        }
        None => max_top_level_sort_order(conn).await? + 1,
    };
    assign_folder_positions(conn, &[(folder_id, next_order, group_id)]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    async fn seed_folder(
        conn: &DatabaseConnection,
        path: &str,
        sort_order: i32,
        group_id: Option<i32>,
    ) -> i32 {
        let now = Utc::now();
        folder::ActiveModel {
            id: NotSet,
            name: Set(path.to_string()),
            path: Set(path.to_string()),
            git_branch: Set(None),
            default_agent_type: Set(None),
            last_opened_at: Set(now),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(None),
            is_open: Set(true),
            sort_order: Set(sort_order),
            color: Set(DEFAULT_FOLDER_COLOR.to_string()),
            parent_id: Set(None),
            kind: Set(FolderKind::Regular),
            alias: Set(None),
            group_id: Set(group_id),
        }
        .insert(conn)
        .await
        .expect("seed folder")
        .id
    }

    async fn folder_row(conn: &DatabaseConnection, id: i32) -> folder::Model {
        folder::Entity::find_by_id(id)
            .one(conn)
            .await
            .expect("query")
            .expect("row")
    }

    #[tokio::test]
    async fn create_appends_after_every_top_level_entry() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        seed_folder(conn, "/a", 4, None).await;

        let group = create_folder_group(conn, "Work".into(), None)
            .await
            .expect("create");
        // The new group must sort AFTER the loose folder at 4 — the two share
        // one top-level sequence, so seeding from the group table alone (max 0)
        // would have put it on top.
        assert_eq!(group.sort_order, 5);
        assert_eq!(group.color, DEFAULT_FOLDER_COLOR);

        let second = create_folder_group(conn, "OSS".into(), Some("blue".into()))
            .await
            .expect("create");
        assert_eq!(second.sort_order, 6);
        assert_eq!(second.color, "blue");
    }

    #[tokio::test]
    async fn update_patches_only_the_fields_given() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let group = create_folder_group(conn, "Work".into(), Some("red".into()))
            .await
            .expect("create");

        let renamed = update_folder_group(conn, group.id, Some("Day job".into()), None)
            .await
            .expect("update")
            .expect("present");
        assert_eq!(renamed.name, "Day job");
        // The color picker and the rename dialog share this endpoint, so a
        // rename must not reset the color to the default.
        assert_eq!(renamed.color, "red");

        let recolored = update_folder_group(conn, group.id, None, Some("green".into()))
            .await
            .expect("update")
            .expect("present");
        assert_eq!(recolored.name, "Day job");
        assert_eq!(recolored.color, "green");

        assert!(update_folder_group(conn, 9999, Some("x".into()), None)
            .await
            .expect("update")
            .is_none());
    }

    #[tokio::test]
    async fn delete_returns_members_to_the_top_level_in_order() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let loose = seed_folder(conn, "/loose", 1, None).await;
        let group = create_folder_group(conn, "Work".into(), None)
            .await
            .expect("create");
        let first = seed_folder(conn, "/first", 1, Some(group.id)).await;
        let second = seed_folder(conn, "/second", 2, Some(group.id)).await;

        assert!(delete_folder_group(conn, group.id).await.expect("delete"));

        // Members survive — deleting a group must never close a folder.
        let a = folder_row(conn, first).await;
        let b = folder_row(conn, second).await;
        assert_eq!(a.group_id, None);
        assert_eq!(b.group_id, None);
        // Appended after the existing top level, relative order preserved.
        assert!(a.sort_order > folder_row(conn, loose).await.sort_order);
        assert!(b.sort_order > a.sort_order);
        assert!(list_folder_groups(conn).await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn apply_layout_writes_per_container_positions() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let group = create_folder_group(conn, "Work".into(), None)
            .await
            .expect("create");
        let loose = seed_folder(conn, "/loose", 1, None).await;
        let member_a = seed_folder(conn, "/a", 2, None).await;
        let member_b = seed_folder(conn, "/b", 3, None).await;

        // Layout: [loose, group[a, b]] — the group is second at the top level,
        // and the two folders become its members at positions 1 and 2.
        apply_sidebar_layout(
            conn,
            vec![
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Folder,
                    id: loose,
                    group_id: None,
                },
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Group,
                    id: group.id,
                    group_id: None,
                },
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Folder,
                    id: member_a,
                    group_id: Some(group.id),
                },
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Folder,
                    id: member_b,
                    group_id: Some(group.id),
                },
            ],
        )
        .await
        .expect("apply");

        assert_eq!(folder_row(conn, loose).await.sort_order, 1);
        let groups = list_folder_groups(conn).await.expect("list");
        assert_eq!(groups[0].sort_order, 2);
        let a = folder_row(conn, member_a).await;
        let b = folder_row(conn, member_b).await;
        assert_eq!((a.group_id, a.sort_order), (Some(group.id), 1));
        assert_eq!((b.group_id, b.sort_order), (Some(group.id), 2));
    }

    #[tokio::test]
    async fn apply_layout_leaves_unnamed_rows_alone_and_is_idempotent() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let named = seed_folder(conn, "/named", 9, None).await;
        // A closed folder the sidebar never rendered: its position must survive.
        let untouched = seed_folder(conn, "/untouched", 42, None).await;

        let layout = vec![SidebarLayoutEntry {
            kind: SidebarEntryKind::Folder,
            id: named,
            group_id: None,
        }];
        apply_sidebar_layout(conn, layout.clone())
            .await
            .expect("apply");
        assert_eq!(folder_row(conn, named).await.sort_order, 1);
        assert_eq!(folder_row(conn, untouched).await.sort_order, 42);

        // Replaying the same layout must not drift.
        apply_sidebar_layout(conn, layout).await.expect("apply");
        assert_eq!(folder_row(conn, named).await.sort_order, 1);
        assert_eq!(folder_row(conn, untouched).await.sort_order, 42);
    }

    #[tokio::test]
    async fn apply_layout_ignores_repeated_ids() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let first = seed_folder(conn, "/first", 1, None).await;
        let second = seed_folder(conn, "/second", 2, None).await;

        // A duplicate would otherwise consume a slot and push `second` to 3,
        // leaving a gap that reads as a phantom row.
        apply_sidebar_layout(
            conn,
            vec![
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Folder,
                    id: first,
                    group_id: None,
                },
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Folder,
                    id: first,
                    group_id: None,
                },
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Folder,
                    id: second,
                    group_id: None,
                },
            ],
        )
        .await
        .expect("apply");

        assert_eq!(folder_row(conn, first).await.sort_order, 1);
        assert_eq!(folder_row(conn, second).await.sort_order, 2);
    }

    #[tokio::test]
    async fn a_newly_opened_folder_lands_after_every_group() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        // Three groups and no top-level folders — so the `folder` table's max
        // `sort_order` is 0. An allocator that reads only that table hands the
        // new folder position 1, which the FIRST group already holds, and the
        // folder renders between groups instead of on the end. The two tables
        // share one top-level sequence, so the allocator has to read both.
        for name in ["Work", "OSS", "Scratch"] {
            create_folder_group(conn, name.into(), None)
                .await
                .expect("create group");
        }

        let added = crate::db::service::folder_service::add_folder(conn, "/repo")
            .await
            .expect("add folder");

        assert_eq!(
            folder_row(conn, added.id).await.sort_order,
            4,
            "appended after all three groups, not into the middle"
        );
    }

    #[tokio::test]
    async fn apply_layout_survives_a_group_deleted_mid_drag() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let folder = seed_folder(conn, "/kept", 9, None).await;

        // A drag that began before another window deleted the group still
        // submits it. Failing the whole call here would be the worst outcome:
        // the folder writes land first, so the client would roll its optimistic
        // state back over a database that had already moved on.
        apply_sidebar_layout(
            conn,
            vec![
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Group,
                    id: 4242,
                    group_id: None,
                },
                SidebarLayoutEntry {
                    kind: SidebarEntryKind::Folder,
                    id: folder,
                    group_id: None,
                },
            ],
        )
        .await
        .expect("a group that vanished mid-drag must not fail the whole write");

        // The vanished group still consumed its top-level slot, so the folder
        // keeps the position the user actually dropped it in.
        assert_eq!(folder_row(conn, folder).await.sort_order, 2);
    }

    #[tokio::test]
    async fn set_folder_group_appends_to_the_target_container() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let group = create_folder_group(conn, "Work".into(), None)
            .await
            .expect("create");
        seed_folder(conn, "/existing", 1, Some(group.id)).await;
        let moved = seed_folder(conn, "/moved", 7, None).await;

        set_folder_group(conn, moved, Some(group.id))
            .await
            .expect("move in");
        let row = folder_row(conn, moved).await;
        assert_eq!(row.group_id, Some(group.id));
        assert_eq!(row.sort_order, 2, "appended after the existing member");

        set_folder_group(conn, moved, None).await.expect("move out");
        let row = folder_row(conn, moved).await;
        assert_eq!(row.group_id, None);
        // Back at the top level, after the group (sort_order 1 there).
        assert!(row.sort_order > group.sort_order);
    }
}
