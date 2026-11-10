use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set, Statement,
};

use crate::db::entities::folder;
use crate::db::entities::folder::FolderKind;
use crate::db::entities::folder_group;
use crate::db::error::DbError;
use crate::models::agent::AgentType;
use crate::models::{FolderDetail, FolderHistoryEntry};

/// Theme color sentinel stored in the DB. The frontend leaves the folder group
/// unscoped so it inherits the app-wide appearance theme color.
pub const DEFAULT_FOLDER_COLOR: &str = "inherit";

/// The position a newly created folder should take: after everything already in
/// the sidebar.
///
/// Reads BOTH tables, because the sidebar's top level is one numeric sequence
/// shared by folder groups and ungrouped folders — that shared space is what
/// lets the two interleave. Taking `MAX(folder.sort_order)` alone hands the new
/// folder a position a group already occupies, and instead of appending it
/// sorts into the middle of the list (with three groups at 1/2/3 and no
/// top-level folders, a newly opened folder would land at 1 and render between
/// the first and second group).
///
/// The folder side is deliberately unfiltered — worktree children and hidden
/// chat folders count too — so the result only ever moves forward. That is the
/// pre-groups behavior, kept as-is.
async fn next_sort_order(conn: &DatabaseConnection) -> Result<i32, DbError> {
    let max_folder = folder::Entity::find()
        .order_by_desc(folder::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(0);
    let max_group = folder_group::Entity::find()
        .order_by_desc(folder_group::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(0);
    Ok(max_folder.max(max_group) + 1)
}

fn to_entry(m: folder::Model) -> FolderHistoryEntry {
    FolderHistoryEntry {
        id: m.id,
        path: m.path,
        name: m.name,
        last_opened_at: m.last_opened_at,
    }
}

fn parse_agent_type(s: &Option<String>) -> Option<AgentType> {
    s.as_deref()
        .and_then(|v| serde_json::from_value(serde_json::Value::String(v.to_string())).ok())
}

fn to_detail(m: folder::Model) -> FolderDetail {
    let default_agent_type = parse_agent_type(&m.default_agent_type);
    FolderDetail {
        id: m.id,
        name: m.name,
        path: m.path,
        git_branch: m.git_branch,
        default_agent_type,
        last_opened_at: m.last_opened_at,
        sort_order: m.sort_order,
        color: m.color,
        parent_id: m.parent_id,
        kind: m.kind,
        alias: m.alias,
        group_id: m.group_id,
    }
}

pub async fn get_folder_by_id(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    Ok(row.map(to_detail))
}

/// How [`add_folder_inner`] writes the `parent_id` column. The two callers want
/// different semantics on reopen of an existing path, which a bare `Option<i32>`
/// could not express (it conflates "no parent" with "don't touch the parent").
enum ParentWrite {
    /// Plain open: leave an existing row's `parent_id` untouched (insert NULL).
    /// A plain reopen must never clear a worktree's recorded root.
    Preserve,
    /// Worktree open: write this exact value on both insert and reopen — so the
    /// stored relationship always reflects the latest call (including `None` to
    /// demote to a top-level folder) and can never go stale.
    Set(Option<i32>),
}

pub async fn add_folder(
    conn: &DatabaseConnection,
    path: &str,
) -> Result<FolderHistoryEntry, DbError> {
    add_folder_inner(conn, path, ParentWrite::Preserve).await
}

/// Like [`add_folder`] but authoritatively sets `parent_id` — the *root* folder
/// this path was created under (used by the worktree flow so a worktree folder
/// remembers its originating repo folder). The value is written on both insert
/// and reopen, so it always reflects the latest worktree relationship and never
/// a stale one.
pub async fn add_folder_with_parent(
    conn: &DatabaseConnection,
    path: &str,
    parent_id: Option<i32>,
) -> Result<FolderHistoryEntry, DbError> {
    add_folder_inner(conn, path, ParentWrite::Set(parent_id)).await
}

async fn add_folder_inner(
    conn: &DatabaseConnection,
    path: &str,
    parent: ParentWrite,
) -> Result<FolderHistoryEntry, DbError> {
    let now = Utc::now();
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let existing = folder::Entity::find()
        .filter(folder::Column::Path.eq(path))
        .one(conn)
        .await?;

    let model = if let Some(row) = existing {
        let mut active = row.into_active_model();
        active.name = Set(name);
        active.last_opened_at = Set(now);
        active.updated_at = Set(now);
        active.deleted_at = Set(None);
        active.is_open = Set(true);
        // Plain reopen leaves the relationship as-is; the worktree flow writes
        // the authoritative value (including NULL) so it can never go stale.
        if let ParentWrite::Set(parent_id) = parent {
            active.parent_id = Set(parent_id);
        }
        active.update(conn).await?
    } else {
        let next_order = next_sort_order(conn).await?;
        let active = folder::ActiveModel {
            id: NotSet,
            name: Set(name.clone()),
            path: Set(path.to_string()),
            git_branch: Set(None),
            default_agent_type: Set(None),
            last_opened_at: Set(now),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(None),
            is_open: Set(true),
            sort_order: Set(next_order),
            color: Set(DEFAULT_FOLDER_COLOR.to_string()),
            parent_id: Set(match parent {
                ParentWrite::Preserve => None,
                ParentWrite::Set(parent_id) => parent_id,
            }),
            kind: Set(FolderKind::Regular),
            alias: Set(None),
            // A newly opened folder always lands at the top level; the user
            // moves it into a group afterwards.
            group_id: Set(None),
        };
        active.insert(conn).await?
    };

    Ok(to_entry(model))
}

/// Get (or create) the folder row for a directory a BACKGROUND producer needs to
/// name, without opening it into the workspace.
///
/// The delegation host needs a `folder_id` to write a child conversation row and
/// to resolve that child's cwd on resume — nothing more. [`add_folder`] is the
/// wrong tool for that: it unconditionally sets `is_open = true`, so an agent
/// choosing a scratch `working_dir` (a PR checkout in `/tmp`, a throwaway
/// worktree) would silently mint a top-level PROJECT in the user's sidebar, and
/// a delegation into a folder the user had closed would silently reopen it.
///
/// Nothing is lost by keeping the row closed: delegation children are not
/// sidebar rows at all (`conversation_service` lists roots only, and children
/// render lazily under their parent), while both cwd lookups —
/// [`get_folder_by_id`] and [`list_all_folder_details`] — deliberately ignore
/// `is_open`.
///
/// So, against [`add_folder`]:
/// - A live existing row is left ALONE — `is_open`, `last_opened_at`,
///   `parent_id`, `name` and `group_id` all keep their values.
/// - A soft-deleted row is revived (`deleted_at` cleared), because the two cwd
///   lookups above both filter on it and a deleted row would fail the resume it
///   is being created for — but revived CLOSED. [`remove_folder`] stamps only
///   `deleted_at` and leaves `is_open` behind at whatever it was, so a deleted
///   row's `is_open` says nothing; "deleted" already means "not in the
///   workspace", and honoring the stale flag would put a folder the user removed
///   back in their sidebar.
/// - A new row starts `is_open = false`. It still takes a `sort_order` so that
///   opening it later (deliberately, by the user) lands it in a sane position.
pub async fn ensure_folder_for_path(
    conn: &DatabaseConnection,
    path: &str,
) -> Result<FolderHistoryEntry, DbError> {
    ensure_folder_inner(conn, path, None).await
}

/// [`ensure_folder_for_path`] for a worktree a background producer made under
/// the root folder `root_id` (a `codeg-cli --worktree` run): a new row is
/// recorded under that root — closed, as every row this family makes — and an
/// existing live one is left as it is.
pub async fn ensure_worktree_folder_closed(
    conn: &DatabaseConnection,
    path: &str,
    root_id: i32,
) -> Result<FolderHistoryEntry, DbError> {
    ensure_folder_inner(conn, path, Some(root_id)).await
}

/// Whether the live folder `folder_id` is open in the workspace.
pub async fn is_open(conn: &DatabaseConnection, folder_id: i32) -> Result<bool, DbError> {
    Ok(folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .is_some_and(|row| row.is_open))
}

async fn ensure_folder_inner(
    conn: &DatabaseConnection,
    path: &str,
    parent_on_insert: Option<i32>,
) -> Result<FolderHistoryEntry, DbError> {
    let now = Utc::now();

    let existing = folder::Entity::find()
        .filter(folder::Column::Path.eq(path))
        .one(conn)
        .await?;

    let model = if let Some(row) = existing {
        if row.deleted_at.is_none() {
            return Ok(to_entry(row));
        }
        let mut active = row.into_active_model();
        active.deleted_at = Set(None);
        active.is_open = Set(false);
        active.updated_at = Set(now);
        active.update(conn).await?
    } else {
        let name = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        let next_order = next_sort_order(conn).await?;
        let active = folder::ActiveModel {
            id: NotSet,
            name: Set(name),
            path: Set(path.to_string()),
            git_branch: Set(None),
            default_agent_type: Set(None),
            last_opened_at: Set(now),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(None),
            is_open: Set(false),
            sort_order: Set(next_order),
            color: Set(DEFAULT_FOLDER_COLOR.to_string()),
            parent_id: Set(parent_on_insert),
            kind: Set(FolderKind::Regular),
            alias: Set(None),
            group_id: Set(None),
        };
        match active.insert(conn).await {
            Ok(model) => model,
            // Another caller made the row meanwhile — the runs of one
            // `codeg-cli -a x -a y` in a new workspace, started together, say
            // (`UNIQUE(path)`): the row it made is this caller's too.
            Err(err) => match folder::Entity::find()
                .filter(folder::Column::Path.eq(path))
                .one(conn)
                .await?
            {
                Some(row) if row.deleted_at.is_none() => row,
                _ => return Err(err.into()),
            },
        }
    };

    Ok(to_entry(model))
}

/// Create a dedicated hidden folder backing a single chat-mode conversation.
///
/// Unlike [`add_folder`], the display name is a fixed sentinel ("Chat") rather
/// than derived from the path, and `kind = chat` is set so the frontend routes
/// this folder's conversations to the sidebar "Chat" group and hides
/// folder-bound chrome. `path` is a freshly generated per-conversation scratch dir, so it
/// never collides on the `UNIQUE(path)` constraint. Returns the full
/// [`FolderDetail`] so the caller can hand it straight to the frontend.
pub async fn add_chat_folder(
    conn: &DatabaseConnection,
    path: &str,
) -> Result<FolderDetail, DbError> {
    let now = Utc::now();
    let next_order = next_sort_order(conn).await?;
    let active = folder::ActiveModel {
        id: NotSet,
        name: Set("Chat".to_string()),
        path: Set(path.to_string()),
        git_branch: Set(None),
        default_agent_type: Set(None),
        last_opened_at: Set(now),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
        is_open: Set(true),
        sort_order: Set(next_order),
        color: Set(DEFAULT_FOLDER_COLOR.to_string()),
        parent_id: Set(None),
        kind: Set(FolderKind::Chat),
        alias: Set(None),
        // Hidden chat folders never appear in the sidebar's folder list, so
        // they are never in a group.
        group_id: Set(None),
    };
    let model = active.insert(conn).await?;
    Ok(to_detail(model))
}

pub async fn update_folder_color(
    conn: &DatabaseConnection,
    folder_id: i32,
    color: &str,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let mut active = row.into_active_model();
    active.color = Set(color.to_string());
    active.updated_at = Set(Utc::now());
    let updated = active.update(conn).await?;
    Ok(Some(to_detail(updated)))
}

/// Sets (or clears) a folder's display alias. `alias = None` clears it; callers
/// are expected to have already normalized empty/whitespace input to `None`.
pub async fn update_folder_alias(
    conn: &DatabaseConnection,
    folder_id: i32,
    alias: Option<String>,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let mut active = row.into_active_model();
    active.alias = Set(alias);
    active.updated_at = Set(Utc::now());
    let updated = active.update(conn).await?;
    Ok(Some(to_detail(updated)))
}

/// Fill in a folder's alias only when it has none — the worktree flow's
/// "default the label to the branch name" write.
///
/// A single conditional UPDATE (`… WHERE alias IS NULL OR alias = ''`) rather
/// than read-then-write: a worktree folder can be re-registered concurrently
/// (task relaunch, automation run, the user re-opening the same directory)
/// while its owner is renaming it in the sidebar, and the read-then-write shape
/// would let the seed land on top of that rename. Returns whether a row was
/// actually written, so the caller only re-reads / broadcasts on a real change.
/// The alias is user-editable afterwards, including back to empty — clearing it
/// makes the folder eligible for seeding again, which is the same "no alias set"
/// state a fresh worktree starts in.
pub async fn seed_folder_alias(
    conn: &DatabaseConnection,
    folder_id: i32,
    alias: &str,
) -> Result<bool, DbError> {
    use sea_orm::sea_query::Expr;
    let alias = alias.trim();
    if alias.is_empty() {
        return Ok(false);
    }
    let res = folder::Entity::update_many()
        .col_expr(folder::Column::Alias, Expr::value(alias))
        .col_expr(folder::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(folder::Column::Id.eq(folder_id))
        .filter(folder::Column::DeletedAt.is_null())
        .filter(
            sea_orm::Condition::any()
                .add(folder::Column::Alias.is_null())
                .add(folder::Column::Alias.eq("")),
        )
        .exec(conn)
        .await?;
    Ok(res.rows_affected > 0)
}

/// `(id, path)` of every live worktree folder still without an alias — the work
/// list for the startup backfill that labels worktrees registered before aliases
/// were seeded at creation. `parent_id IS NOT NULL` is exactly "is a worktree
/// folder" in this schema (only the worktree flow ever writes a parent).
///
/// Closed folders are included on purpose, so reopening one later already reads
/// as its branch. Whether a row may be *announced* is a separate, later question
/// — see [`get_open_folder_by_id`].
pub async fn list_worktree_folders_missing_alias(
    conn: &DatabaseConnection,
) -> Result<Vec<(i32, String)>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::ParentId.is_not_null())
        .filter(
            sea_orm::Condition::any()
                .add(folder::Column::Alias.is_null())
                .add(folder::Column::Alias.eq("")),
        )
        .order_by_asc(folder::Column::Id)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(|m| (m.id, m.path)).collect())
}

/// Like [`get_folder_by_id`], but `None` unless the folder is currently in the
/// workspace.
///
/// For background producers deciding whether to broadcast a `folder://changed`
/// Upsert, which means "insert-or-replace in the client's OPEN folder list" —
/// sending one for a closed folder puts it back in the user's sidebar.
/// `FolderDetail` carries no open state, so that check cannot be made from the
/// returned value, and a producer that walks many folders must not reuse an
/// open/closed reading taken when its work list was built: the user can close a
/// folder while it works. Reading both here, as late as possible, keeps the two
/// facts consistent.
pub async fn get_open_folder_by_id(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::IsOpen.eq(true))
        .one(conn)
        .await?;

    Ok(row.map(to_detail))
}

pub async fn update_folder_default_agent(
    conn: &DatabaseConnection,
    folder_id: i32,
    default_agent_type: Option<AgentType>,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    // Serialize AgentType to its snake_case wire form (e.g. "claude_code").
    // Mirrors `parse_agent_type`'s round-trip through serde_json.
    let serialized = default_agent_type
        .map(|t| serde_json::to_value(t).ok())
        .and_then(|v| v.and_then(|val| val.as_str().map(|s| s.to_string())));

    let mut active = row.into_active_model();
    active.default_agent_type = Set(serialized);
    active.updated_at = Set(Utc::now());
    let updated = active.update(conn).await?;
    Ok(Some(to_detail(updated)))
}

pub async fn list_folders(conn: &DatabaseConnection) -> Result<Vec<FolderHistoryEntry>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        // Only regular folders are user-facing in folder history / open-folder
        // pickers — hidden chat folders (and future engine-created kinds) are an
        // implementation detail.
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_entry).collect())
}

pub async fn remove_folder(conn: &DatabaseConnection, path: &str) -> Result<(), DbError> {
    let now = Utc::now();
    let row = folder::Entity::find()
        .filter(folder::Column::Path.eq(path))
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    if let Some(row) = row {
        let mut active = row.into_active_model();
        active.deleted_at = Set(Some(now));
        active.updated_at = Set(now);
        active.update(conn).await?;
    }
    Ok(())
}

/// Soft-delete a folder by id and close it — the permanent counterpart of
/// [`set_folder_open`]`(.., false)`, used when the directory behind the row is
/// gone for good (a removed git worktree).
///
/// An id that is already soft-deleted (or never existed) succeeds untouched, so
/// a caller retrying a half-finished cleanup still reaches its "announce the
/// drop" step instead of aborting on a row it already removed.
pub async fn soft_delete_folder(conn: &DatabaseConnection, folder_id: i32) -> Result<(), DbError> {
    let Some(row) = folder::Entity::find_by_id(folder_id).one(conn).await? else {
        return Ok(());
    };
    if row.deleted_at.is_some() {
        return Ok(());
    }
    let now = Utc::now();
    let mut active = row.into_active_model();
    active.is_open = Set(false);
    active.deleted_at = Set(Some(now));
    active.updated_at = Set(now);
    active.update(conn).await?;
    Ok(())
}

pub async fn set_folder_open(
    conn: &DatabaseConnection,
    folder_id: i32,
    is_open: bool,
) -> Result<(), DbError> {
    let row = folder::Entity::find_by_id(folder_id).one(conn).await?;

    if let Some(row) = row {
        let mut active = row.into_active_model();
        active.is_open = Set(is_open);
        active.updated_at = Set(Utc::now());
        active.update(conn).await?;
    }
    Ok(())
}

pub async fn list_open_folders(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderHistoryEntry>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::IsOpen.eq(true))
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_entry).collect())
}

pub async fn list_open_folder_details(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderDetail>, DbError> {
    // Excludes hidden chat folders from the workspace "open folders" surface.
    // `list_all_folder_details` (below) intentionally keeps them so the frontend
    // can still resolve an active chat conversation's cwd / active folder by id.
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::IsOpen.eq(true))
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .order_by_asc(folder::Column::SortOrder)
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_detail).collect())
}

pub async fn list_all_folder_details(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderDetail>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .order_by_asc(folder::Column::SortOrder)
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_detail).collect())
}

/// Paths of all *live* (non-deleted) chat scratch folders. Consumed by the
/// startup orphan-scratch-dir GC to spare directories still bound to a chat
/// conversation, while reclaiming pre-send drafts (no row at all) and
/// post-delete dirs (soft-deleted row → `DeletedAt` set → excluded here).
pub async fn list_live_chat_folder_paths(
    conn: &DatabaseConnection,
) -> Result<Vec<String>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::Kind.eq(FolderKind::Chat))
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(|m| m.path).collect())
}

/// Bulk-assign `sort_order` (and `group_id`) to the named folders in one
/// statement. `assignments` is `(id, sort_order, group_id)`; a folder absent
/// from it keeps whatever it had, which is how a closed folder's position
/// survives a reorder of the open ones.
///
/// Raw SQL with a CASE expression rather than one UPDATE per row: the whole
/// sidebar is rewritten on every drop, and this keeps that a single round trip.
/// Every interpolated value is an `i32` (or the formatted timestamp), so there
/// is no injection surface.
pub(crate) async fn assign_folder_positions(
    conn: &DatabaseConnection,
    assignments: &[(i32, i32, Option<i32>)],
) -> Result<(), DbError> {
    if assignments.is_empty() {
        return Ok(());
    }

    let now_str = Utc::now().format("%Y-%m-%d %H:%M:%S %:z").to_string();
    let order_case = assignments
        .iter()
        .map(|(id, order, _)| format!("WHEN {id} THEN {order}"))
        .collect::<Vec<_>>()
        .join(" ");
    let group_case = assignments
        .iter()
        .map(|(id, _, group_id)| match group_id {
            Some(g) => format!("WHEN {id} THEN {g}"),
            None => format!("WHEN {id} THEN NULL"),
        })
        .collect::<Vec<_>>()
        .join(" ");
    let id_list = assignments
        .iter()
        .map(|(id, _, _)| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "UPDATE folder SET sort_order = CASE id {order_case} END, \
         group_id = CASE id {group_case} END, \
         updated_at = '{now_str}' WHERE id IN ({id_list})"
    );
    conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
        .await?;

    Ok(())
}
