//! Conversation tags: user-defined labels (a name and one colour) that can be
//! put on conversations, several per conversation.
//!
//! ## Scope
//!
//! A tag is either GLOBAL (`folder_id` NULL) — offered on every conversation,
//! chat-mode ones included — or owned by one ROOT folder and offered only on the
//! conversations of that folder family. A worktree child folder never owns tags:
//! asking for one resolves to its root (`folder.parent_id` is already flattened
//! to the original root), so a repo's tags follow its conversations into every
//! worktree, exactly like the sidebar draws worktrees under their repo. Hidden
//! chat folders cannot own tags, which is what leaves a chat-mode conversation
//! with the global ones only.
//!
//! ## Writes
//!
//! No transaction here ever reads before it writes. SQLite in WAL mode cannot
//! upgrade a read snapshot that another connection has written past, and
//! SeaORM only issues a deferred `BEGIN`, so a read-then-write transaction fails
//! with `SQLITE_BUSY_SNAPSHOT` (517) under concurrent load. Validation reads run
//! first, outside any transaction; the transactions that follow are write-only.
//! The races that opens are closed by the schema rather than by the read: a
//! tag deleted mid-assignment trips the link's foreign key, and two writers
//! creating the same name trip the scope/name unique index.
//!
//! ## The branch tag
//!
//! Not a tag row: one app-wide setting (in `app_metadata`) for whether every
//! conversation's git branch is drawn as a chip beside its tags, and in which
//! colour. Nothing is stored per conversation — the branch is the summary's
//! own `git_branch`.

use std::collections::HashMap;

use chrono::Utc;
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseConnection,
    DbErr, EntityTrait, QueryFilter, QueryOrder, Set, SqlErr, TransactionTrait,
};

use crate::db::entities::folder::FolderKind;
use crate::db::entities::{conversation, conversation_tag, conversation_tag_link, folder};
use crate::db::error::DbError;
use crate::db::service::app_metadata_service;
use crate::models::{ConversationBranchTag, ConversationTagDetail};

/// Longest tag name kept, in characters. A tag renders as a small chip that
/// truncates far sooner; this only stops a pasted paragraph from becoming one.
pub const MAX_TAG_NAME_CHARS: usize = 64;

/// Why a tag operation was refused. Everything but `Db` is the caller's input
/// being wrong for the current state, and maps to a 4xx-style error.
#[derive(Debug, thiserror::Error)]
pub enum TagError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error("Tag name cannot be empty")]
    EmptyName,
    #[error("A tag named \"{0}\" already exists here")]
    DuplicateName(String),
    #[error("Invalid tag color \"{0}\": expected #rrggbb")]
    InvalidColor(String),
    #[error("Folder {0} not found")]
    FolderNotFound(i32),
    #[error("Folder {0} cannot have its own tags")]
    FolderNotTaggable(i32),
    #[error("Tag {0} not found")]
    TagNotFound(i32),
    #[error("Conversation {0} not found")]
    ConversationNotFound(i32),
    #[error("Tag {tag_id} belongs to another folder and cannot be put on conversation {conversation_id}")]
    NotApplicable { tag_id: i32, conversation_id: i32 },
}

impl From<DbErr> for TagError {
    fn from(err: DbErr) -> Self {
        TagError::Db(DbError::Database(err))
    }
}

fn to_detail(m: conversation_tag::Model) -> ConversationTagDetail {
    ConversationTagDetail {
        id: m.id,
        folder_id: m.folder_id,
        name: m.name,
        color: m.color,
        sort_order: m.sort_order,
    }
}

/// Trim and length-cap a tag name. An all-whitespace name would render as an
/// empty chip nobody can read or pick, so it is refused rather than stored.
pub fn normalize_tag_name(name: &str) -> Result<String, TagError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(TagError::EmptyName);
    }
    Ok(trimmed.chars().take(MAX_TAG_NAME_CHARS).collect())
}

/// Normalize a colour to lowercase `#rrggbb`. The three-digit shorthand is
/// expanded; anything else — names, `rgb()`, alpha — is refused, because the
/// frontend derives both theme treatments from exactly these six digits.
pub fn normalize_tag_color(color: &str) -> Result<String, TagError> {
    let trimmed = color.trim();
    let invalid = || TagError::InvalidColor(trimmed.to_string());
    let hex = trimmed.strip_prefix('#').ok_or_else(invalid)?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let expanded = match hex.len() {
        6 => hex.to_string(),
        3 => hex.chars().flat_map(|c| [c, c]).collect(),
        _ => return Err(invalid()),
    };
    Ok(format!("#{}", expanded.to_ascii_lowercase()))
}

/// The key two names collide on: Unicode lowercase, so "Bug", "BUG" and "bug"
/// are one tag — and so are "Ärger" and "ärger", which SQLite's ASCII-only
/// NOCASE (the unique index's fold) would let through.
fn name_key(name: &str) -> String {
    name.to_lowercase()
}

/// The root of the folder family `folder_id` belongs to: the folder itself, or
/// for a worktree child the root it was created under.
pub async fn root_folder_id<C: ConnectionTrait>(
    conn: &C,
    folder_id: i32,
) -> Result<Option<i32>, DbErr> {
    Ok(folder::Entity::find_by_id(folder_id)
        .one(conn)
        .await?
        .map(|f| f.parent_id.unwrap_or(f.id)))
}

/// Resolve the folder a caller asked to scope a tag to into the root folder
/// that will own it. The folder ASKED FOR must be live and user-facing
/// (`regular`); its root owns the tag even in the odd case where the root row
/// itself was removed while this worktree lives on — that root is still the
/// scope the worktree's conversations resolve to (`folder.parent_id`), so
/// owning the tag anywhere else would make it unusable on them.
async fn resolve_owner_folder(conn: &DatabaseConnection, folder_id: i32) -> Result<i32, TagError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .ok_or(TagError::FolderNotFound(folder_id))?;
    if row.kind != FolderKind::Regular {
        return Err(TagError::FolderNotTaggable(folder_id));
    }
    Ok(row.parent_id.unwrap_or(row.id))
}

/// Every tag of one scope (`None` = global), in display order.
async fn tags_in_scope(
    conn: &DatabaseConnection,
    scope: Option<i32>,
) -> Result<Vec<conversation_tag::Model>, DbErr> {
    let query = conversation_tag::Entity::find();
    let query = match scope {
        Some(folder_id) => query.filter(conversation_tag::Column::FolderId.eq(folder_id)),
        None => query.filter(conversation_tag::Column::FolderId.is_null()),
    };
    query
        .order_by_asc(conversation_tag::Column::SortOrder)
        .order_by_asc(conversation_tag::Column::Id)
        .all(conn)
        .await
}

/// A unique-index violation on insert/update is the scope/name index — the
/// only unique constraint on the table besides the primary key — so it means
/// a concurrent writer took the name after our own check passed.
fn duplicate_or_db(err: DbErr, name: &str) -> TagError {
    match err.sql_err() {
        Some(SqlErr::UniqueConstraintViolation(_)) => TagError::DuplicateName(name.to_string()),
        _ => err.into(),
    }
}

/// Every tag, global ones first, then by owning folder; within a scope in
/// `sort_order`, ties broken on `id` so the order is stable. Tags of a folder
/// that has since been removed are included: they come back with the folder,
/// and the UI only offers a folder's tags where that folder is shown.
pub async fn list_tags(conn: &DatabaseConnection) -> Result<Vec<ConversationTagDetail>, DbError> {
    let rows = conversation_tag::Entity::find()
        // SQLite sorts NULL first on ASC, which puts the global scope on top.
        .order_by_asc(conversation_tag::Column::FolderId)
        .order_by_asc(conversation_tag::Column::SortOrder)
        .order_by_asc(conversation_tag::Column::Id)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(to_detail).collect())
}

/// Create a tag at the end of its scope. `folder_id` names the folder the user
/// was looking at; a worktree child resolves to its root.
pub async fn create_tag(
    conn: &DatabaseConnection,
    folder_id: Option<i32>,
    name: &str,
    color: &str,
) -> Result<ConversationTagDetail, TagError> {
    let name = normalize_tag_name(name)?;
    let color = normalize_tag_color(color)?;
    let scope = match folder_id {
        Some(id) => Some(resolve_owner_folder(conn, id).await?),
        None => None,
    };

    let siblings = tags_in_scope(conn, scope).await?;
    let key = name_key(&name);
    if siblings.iter().any(|t| name_key(&t.name) == key) {
        return Err(TagError::DuplicateName(name));
    }
    // A lost race here only means two tags share a position, which the `id`
    // tie-break absorbs — the same bargain `create_folder_group` makes.
    let next_order = siblings.iter().map(|t| t.sort_order).max().unwrap_or(0) + 1;

    let now = Utc::now();
    let active = conversation_tag::ActiveModel {
        id: NotSet,
        folder_id: Set(scope),
        name: Set(name.clone()),
        color: Set(color),
        sort_order: Set(next_order),
        created_at: Set(now),
        updated_at: Set(now),
    };
    let row = active
        .insert(conn)
        .await
        .map_err(|e| duplicate_or_db(e, &name))?;
    Ok(to_detail(row))
}

/// Rename and/or recolour a tag. `None` leaves that field alone, so the rename
/// field and the colour picker can share one endpoint without either clobbering
/// the other's value. A tag never changes scope.
pub async fn update_tag(
    conn: &DatabaseConnection,
    id: i32,
    name: Option<&str>,
    color: Option<&str>,
) -> Result<ConversationTagDetail, TagError> {
    let name = name.map(normalize_tag_name).transpose()?;
    let color = color.map(normalize_tag_color).transpose()?;
    let row = conversation_tag::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or(TagError::TagNotFound(id))?;

    if let Some(ref name) = name {
        let key = name_key(name);
        let siblings = tags_in_scope(conn, row.folder_id).await?;
        if siblings
            .iter()
            .any(|t| t.id != id && name_key(&t.name) == key)
        {
            return Err(TagError::DuplicateName(name.clone()));
        }
    }
    if name.is_none() && color.is_none() {
        return Ok(to_detail(row));
    }

    let mut active: conversation_tag::ActiveModel = row.into();
    let new_name = name.clone();
    if let Some(name) = name {
        active.name = Set(name);
    }
    if let Some(color) = color {
        active.color = Set(color);
    }
    active.updated_at = Set(Utc::now());
    let updated = active
        .update(conn)
        .await
        .map_err(|e| duplicate_or_db(e, new_name.as_deref().unwrap_or_default()))?;
    Ok(to_detail(updated))
}

/// Delete a tag and take it off every conversation. Returns false when there
/// was no such tag.
pub async fn delete_tag(conn: &DatabaseConnection, id: i32) -> Result<bool, DbError> {
    let deleted = conn
        .transaction::<_, bool, DbErr>(|txn| {
            Box::pin(async move {
                // The FK would cascade these on its own; deleting them first
                // keeps the outcome independent of the connection's
                // `foreign_keys` pragma.
                conversation_tag_link::Entity::delete_many()
                    .filter(conversation_tag_link::Column::TagId.eq(id))
                    .exec(txn)
                    .await?;
                let res = conversation_tag::Entity::delete_by_id(id).exec(txn).await?;
                Ok(res.rows_affected > 0)
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(e)
            | sea_orm::TransactionError::Transaction(e) => DbError::Database(e),
        })?;
    Ok(deleted)
}

/// Persist an order: each id gets its position in `ordered_ids` (1-based).
/// The client sends one scope's complete list after a drag; ids that no longer
/// exist simply match no row.
pub async fn reorder_tags(conn: &DatabaseConnection, ordered_ids: &[i32]) -> Result<(), DbError> {
    if ordered_ids.is_empty() {
        return Ok(());
    }
    let ids = ordered_ids.to_vec();
    conn.transaction::<_, (), DbErr>(|txn| {
        Box::pin(async move {
            let now = Utc::now();
            for (idx, id) in ids.into_iter().enumerate() {
                conversation_tag::Entity::update_many()
                    .col_expr(
                        conversation_tag::Column::SortOrder,
                        sea_orm::sea_query::Expr::value(idx as i32 + 1),
                    )
                    .col_expr(
                        conversation_tag::Column::UpdatedAt,
                        sea_orm::sea_query::Expr::value(now),
                    )
                    .filter(conversation_tag::Column::Id.eq(id))
                    .exec(txn)
                    .await?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| match e {
        sea_orm::TransactionError::Connection(e) | sea_orm::TransactionError::Transaction(e) => {
            DbError::Database(e)
        }
    })
}

/// Put tags on / take tags off one conversation. A delta rather than the full
/// set, so two windows toggling different tags at the same moment both land
/// instead of the later write erasing the earlier one. An id in both lists
/// ends up on the conversation (removals apply first). Never touches the
/// conversation row itself — tagging is not activity, so `updated_at` (and with
/// it the sidebar's "updated" order) stays put.
pub async fn update_conversation_tags(
    conn: &DatabaseConnection,
    conversation_id: i32,
    add: &[i32],
    remove: &[i32],
) -> Result<(), TagError> {
    let conv = conversation::Entity::find_by_id(conversation_id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .ok_or(TagError::ConversationNotFound(conversation_id))?;

    let mut add: Vec<i32> = add.to_vec();
    add.sort_unstable();
    add.dedup();
    let mut remove: Vec<i32> = remove
        .iter()
        .copied()
        .filter(|id| add.binary_search(id).is_err())
        .collect();
    remove.sort_unstable();
    remove.dedup();
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }

    if !add.is_empty() {
        // `None` only if the folder row vanished, which never happens (folders
        // are soft-deleted); treating it as "no folder" still lets global tags
        // through and stops every folder-owned one.
        let root = root_folder_id(conn, conv.folder_id).await?;
        let tags = conversation_tag::Entity::find()
            .filter(conversation_tag::Column::Id.is_in(add.clone()))
            .all(conn)
            .await?;
        let by_id: HashMap<i32, &conversation_tag::Model> =
            tags.iter().map(|t| (t.id, t)).collect();
        for &tag_id in &add {
            let tag = by_id.get(&tag_id).ok_or(TagError::TagNotFound(tag_id))?;
            if let Some(owner) = tag.folder_id {
                if Some(owner) != root {
                    return Err(TagError::NotApplicable {
                        tag_id,
                        conversation_id,
                    });
                }
            }
        }
    }

    let result = conn
        .transaction::<_, (), DbErr>(|txn| {
            let add = add.clone();
            Box::pin(async move {
                if !remove.is_empty() {
                    conversation_tag_link::Entity::delete_many()
                        .filter(conversation_tag_link::Column::ConversationId.eq(conversation_id))
                        .filter(conversation_tag_link::Column::TagId.is_in(remove))
                        .exec(txn)
                        .await?;
                }
                if !add.is_empty() {
                    let now = Utc::now();
                    let rows = add.into_iter().map(|tag_id| conversation_tag_link::ActiveModel {
                        conversation_id: Set(conversation_id),
                        tag_id: Set(tag_id),
                        created_at: Set(now),
                    });
                    conversation_tag_link::Entity::insert_many(rows)
                        .on_conflict(
                            OnConflict::columns([
                                conversation_tag_link::Column::ConversationId,
                                conversation_tag_link::Column::TagId,
                            ])
                            .do_nothing()
                            .to_owned(),
                        )
                        // Every link already present inserts nothing, which
                        // SeaORM reports as `RecordNotInserted`; that is the
                        // idempotent outcome we want, not a failure.
                        .do_nothing()
                        .exec(txn)
                        .await?;
                }
                Ok(())
            })
        })
        .await;
    let err = match result {
        Ok(()) => return Ok(()),
        Err(
            sea_orm::TransactionError::Connection(e) | sea_orm::TransactionError::Transaction(e),
        ) => e,
    };
    match err.sql_err() {
        // The only foreign keys an insert here can trip are the tag's (deleted
        // after we validated it) and the conversation's (never hard-deleted).
        // The whole write rolled back, so look again and name the tag that is
        // actually gone rather than whichever came first.
        Some(SqlErr::ForeignKeyConstraintViolation(_)) => {
            let present: std::collections::HashSet<i32> = conversation_tag::Entity::find()
                .filter(conversation_tag::Column::Id.is_in(add.clone()))
                .all(conn)
                .await?
                .into_iter()
                .map(|t| t.id)
                .collect();
            let missing = add
                .iter()
                .copied()
                .find(|id| !present.contains(id))
                .or_else(|| add.first().copied())
                .unwrap_or_default();
            Err(TagError::TagNotFound(missing))
        }
        _ => Err(err.into()),
    }
}

/// Tag ids per conversation for `conversation_ids`, each list ascending. One
/// query over the whole set — never one per row. Conversations without tags
/// are simply absent from the map.
pub async fn tag_ids_by_conversation(
    conn: &DatabaseConnection,
    conversation_ids: &[i32],
) -> Result<HashMap<i32, Vec<i32>>, DbErr> {
    let mut map: HashMap<i32, Vec<i32>> = HashMap::new();
    if conversation_ids.is_empty() {
        return Ok(map);
    }
    let links = conversation_tag_link::Entity::find()
        .filter(conversation_tag_link::Column::ConversationId.is_in(conversation_ids.to_vec()))
        .order_by_asc(conversation_tag_link::Column::ConversationId)
        .order_by_asc(conversation_tag_link::Column::TagId)
        .all(conn)
        .await?;
    for link in links {
        map.entry(link.conversation_id)
            .or_default()
            .push(link.tag_id);
    }
    Ok(map)
}

/// `app_metadata` key of the branch tag setting, one JSON object.
const BRANCH_TAG_KEY: &str = "conversation_branch_tag";

/// The branch tag's colour until the user picks one: the gray preset, which no
/// newly created tag starts on before eight others are taken.
pub const DEFAULT_BRANCH_TAG_COLOR: &str = "#6e7781";

fn default_branch_tag() -> ConversationBranchTag {
    ConversationBranchTag {
        enabled: false,
        color: DEFAULT_BRANCH_TAG_COLOR.to_string(),
    }
}

/// The branch tag setting; off, in the default colour, until first saved. A
/// stored value that no longer reads (hand-edited, say) falls back the same
/// way — the colour alone when only the colour is bad — rather than failing
/// every window's load.
pub async fn get_branch_tag(conn: &DatabaseConnection) -> Result<ConversationBranchTag, DbError> {
    let stored = app_metadata_service::get_value(conn, BRANCH_TAG_KEY).await?;
    Ok(stored
        .and_then(|raw| serde_json::from_str::<ConversationBranchTag>(&raw).ok())
        .map(|setting| ConversationBranchTag {
            color: normalize_tag_color(&setting.color)
                .unwrap_or_else(|_| DEFAULT_BRANCH_TAG_COLOR.to_string()),
            ..setting
        })
        .unwrap_or_else(default_branch_tag))
}

/// Save the branch tag setting whole — one upsert, nothing read first — and
/// return it as stored.
pub async fn set_branch_tag(
    conn: &DatabaseConnection,
    enabled: bool,
    color: &str,
) -> Result<ConversationBranchTag, TagError> {
    let setting = ConversationBranchTag {
        enabled,
        color: normalize_tag_color(color)?,
    };
    let encoded = serde_json::to_string(&setting)
        .map_err(|e| DbError::Validation(format!("branch tag not serializable: {e}")))?;
    app_metadata_service::upsert_value(conn, BRANCH_TAG_KEY, &encoded).await?;
    Ok(setting)
}

/// Give `to` every tag `from` carries. For the rows that split a conversation
/// in two — a fork's sibling and the row a session change preserves the old
/// history on — both of which ARE the original conversation as far as the user
/// can tell, so it would read as the tags falling off. Runs inside the caller's
/// transaction, after its own first write, so the read here is not the opening
/// statement (see the module doc). Links already present are left alone.
pub async fn copy_conversation_tags<C: ConnectionTrait>(
    conn: &C,
    from: i32,
    to: i32,
) -> Result<(), DbErr> {
    let links = conversation_tag_link::Entity::find()
        .filter(conversation_tag_link::Column::ConversationId.eq(from))
        .all(conn)
        .await?;
    if links.is_empty() {
        return Ok(());
    }
    let rows = links
        .into_iter()
        .map(|link| conversation_tag_link::ActiveModel {
            conversation_id: Set(to),
            tag_id: Set(link.tag_id),
            // When the tag was put on the conversation, not when it was split.
            created_at: Set(link.created_at),
        });
    conversation_tag_link::Entity::insert_many(rows)
        .on_conflict(
            OnConflict::columns([
                conversation_tag_link::Column::ConversationId,
                conversation_tag_link::Column::TagId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .do_nothing()
        .exec(conn)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::service::{conversation_service, folder_service};
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;

    async fn global(conn: &DatabaseConnection, name: &str) -> ConversationTagDetail {
        create_tag(conn, None, name, "#d73a4a")
            .await
            .expect("create global tag")
    }

    async fn worktree_of(db: &crate::db::AppDatabase, path: &str, root: i32) -> i32 {
        folder_service::add_folder_with_parent(&db.conn, path, Some(root))
            .await
            .expect("worktree folder")
            .id
    }

    async fn tag_ids(conn: &DatabaseConnection, conversation_id: i32) -> Vec<i32> {
        conversation_service::get_by_id(conn, conversation_id)
            .await
            .expect("summary")
            .tag_ids
    }

    #[test]
    fn colors_normalize_to_lowercase_six_digit_hex() {
        assert_eq!(normalize_tag_color("#D73A4A").unwrap(), "#d73a4a");
        assert_eq!(normalize_tag_color("  #0Af ").unwrap(), "#00aaff");
        for bad in ["d73a4a", "#d73a4", "#d73a4aff", "red", "#ggg", "", "#"] {
            assert!(
                matches!(normalize_tag_color(bad), Err(TagError::InvalidColor(_))),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn names_are_trimmed_capped_and_never_blank() {
        assert_eq!(normalize_tag_name("  bug  ").unwrap(), "bug");
        assert!(matches!(normalize_tag_name(" \t "), Err(TagError::EmptyName)));
        let long: String = "长".repeat(MAX_TAG_NAME_CHARS + 10);
        assert_eq!(
            normalize_tag_name(&long).unwrap().chars().count(),
            MAX_TAG_NAME_CHARS
        );
    }

    #[tokio::test]
    async fn global_names_are_unique_case_insensitively_including_non_ascii() {
        let db = fresh_in_memory_db().await;
        global(&db.conn, "Bug").await;
        assert!(matches!(
            create_tag(&db.conn, None, "bUG", "#000000").await,
            Err(TagError::DuplicateName(name)) if name == "bUG"
        ));

        // NOCASE (the index) folds ASCII only; the service check folds the rest.
        global(&db.conn, "Ärger").await;
        assert!(matches!(
            create_tag(&db.conn, None, "ärger", "#000000").await,
            Err(TagError::DuplicateName(_))
        ));
    }

    #[tokio::test]
    async fn the_unique_index_backstops_a_writer_that_raced_past_the_check() {
        let db = fresh_in_memory_db().await;
        global(&db.conn, "Bug").await;
        // What a second writer that read the scope before the first committed
        // would do next: insert straight away.
        let now = Utc::now();
        let err = conversation_tag::ActiveModel {
            id: NotSet,
            folder_id: Set(None),
            name: Set("BUG".to_string()),
            color: Set("#000000".to_string()),
            sort_order: Set(9),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&db.conn)
        .await
        .expect_err("the scope/name index must refuse it");
        assert!(matches!(
            duplicate_or_db(err, "BUG"),
            TagError::DuplicateName(name) if name == "BUG"
        ));
    }

    #[tokio::test]
    async fn a_worktree_child_resolves_to_its_root_and_scopes_do_not_collide() {
        let db = fresh_in_memory_db().await;
        let repo = seed_folder(&db, "/tmp/tags-repo").await;
        let worktree = worktree_of(&db, "/tmp/tags-repo-wt", repo).await;

        let owned = create_tag(&db.conn, Some(worktree), "Review", "#0e8a16")
            .await
            .expect("folder tag");
        assert_eq!(owned.folder_id, Some(repo), "owned by the root, not the child");

        // Same family, same name: refused, whichever member asks.
        assert!(matches!(
            create_tag(&db.conn, Some(repo), "review", "#000000").await,
            Err(TagError::DuplicateName(_))
        ));
        // Another scope: fine.
        global(&db.conn, "Review").await;
        let other = seed_folder(&db, "/tmp/tags-other").await;
        create_tag(&db.conn, Some(other), "Review", "#000000")
            .await
            .expect("same name, other folder");
    }

    #[tokio::test]
    async fn only_live_regular_folders_own_tags() {
        let db = fresh_in_memory_db().await;
        let chat = folder_service::add_chat_folder(&db.conn, "/tmp/tags-chat")
            .await
            .expect("chat folder");
        assert!(matches!(
            create_tag(&db.conn, Some(chat.id), "x", "#000000").await,
            Err(TagError::FolderNotTaggable(id)) if id == chat.id
        ));
        assert!(matches!(
            create_tag(&db.conn, Some(424242), "x", "#000000").await,
            Err(TagError::FolderNotFound(424242))
        ));
        let gone = seed_folder(&db, "/tmp/tags-gone").await;
        folder_service::soft_delete_folder(&db.conn, gone)
            .await
            .expect("soft delete");
        assert!(matches!(
            create_tag(&db.conn, Some(gone), "x", "#000000").await,
            Err(TagError::FolderNotFound(_))
        ));
    }

    #[tokio::test]
    async fn new_tags_append_to_their_own_scope_and_list_puts_global_first() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/tags-order").await;
        let f1 = create_tag(&db.conn, Some(folder), "f1", "#000000")
            .await
            .unwrap();
        let g1 = global(&db.conn, "g1").await;
        let g2 = global(&db.conn, "g2").await;
        let f2 = create_tag(&db.conn, Some(folder), "f2", "#000000")
            .await
            .unwrap();
        assert_eq!((g1.sort_order, g2.sort_order), (1, 2));
        assert_eq!((f1.sort_order, f2.sort_order), (1, 2));

        let ids: Vec<i32> = list_tags(&db.conn)
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec![g1.id, g2.id, f1.id, f2.id]);

        reorder_tags(&db.conn, &[g2.id, g1.id]).await.unwrap();
        let ids: Vec<i32> = list_tags(&db.conn)
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec![g2.id, g1.id, f1.id, f2.id]);
    }

    #[tokio::test]
    async fn update_renames_and_recolors_independently() {
        let db = fresh_in_memory_db().await;
        let bug = global(&db.conn, "Bug").await;
        global(&db.conn, "Feature").await;

        let recolored = update_tag(&db.conn, bug.id, None, Some("#ABCDEF"))
            .await
            .unwrap();
        assert_eq!(recolored.name, "Bug");
        assert_eq!(recolored.color, "#abcdef");

        // A case-only rename of itself is not a collision.
        let renamed = update_tag(&db.conn, bug.id, Some(" bug "), None)
            .await
            .unwrap();
        assert_eq!(renamed.name, "bug");
        assert_eq!(renamed.color, "#abcdef");

        assert!(matches!(
            update_tag(&db.conn, bug.id, Some("FEATURE"), None).await,
            Err(TagError::DuplicateName(_))
        ));
        assert!(matches!(
            update_tag(&db.conn, 999, Some("x"), None).await,
            Err(TagError::TagNotFound(999))
        ));
    }

    #[tokio::test]
    async fn tagging_is_a_delta_and_never_touches_the_conversation_row() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/tags-delta").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let a = global(&db.conn, "a").await;
        let b = global(&db.conn, "b").await;
        let before = conversation::Entity::find_by_id(conv)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap()
            .updated_at;

        update_conversation_tags(&db.conn, conv, &[b.id, a.id, a.id], &[])
            .await
            .unwrap();
        assert_eq!(tag_ids(&db.conn, conv).await, vec![a.id, b.id]);

        // Re-adding is a no-op, not an error.
        update_conversation_tags(&db.conn, conv, &[a.id], &[])
            .await
            .unwrap();
        update_conversation_tags(&db.conn, conv, &[], &[a.id])
            .await
            .unwrap();
        assert_eq!(tag_ids(&db.conn, conv).await, vec![b.id]);

        // In both lists: removals apply first, so it ends up on.
        update_conversation_tags(&db.conn, conv, &[a.id], &[a.id])
            .await
            .unwrap();
        assert_eq!(tag_ids(&db.conn, conv).await, vec![a.id, b.id]);

        let after = conversation::Entity::find_by_id(conv)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap()
            .updated_at;
        assert_eq!(before, after, "tagging is not activity");
    }

    #[tokio::test]
    async fn folder_tags_only_go_on_their_own_family() {
        let db = fresh_in_memory_db().await;
        let repo = seed_folder(&db, "/tmp/tags-fam-repo").await;
        let worktree = worktree_of(&db, "/tmp/tags-fam-wt", repo).await;
        let other = seed_folder(&db, "/tmp/tags-fam-other").await;
        let repo_tag = create_tag(&db.conn, Some(repo), "repo", "#000000")
            .await
            .unwrap();
        let other_tag = create_tag(&db.conn, Some(other), "other", "#000000")
            .await
            .unwrap();
        let shared = global(&db.conn, "shared").await;

        let in_worktree = seed_conversation(&db, worktree, AgentType::Codex).await;
        update_conversation_tags(&db.conn, in_worktree, &[repo_tag.id, shared.id], &[])
            .await
            .expect("a repo's tags follow it into its worktrees");
        assert!(matches!(
            update_conversation_tags(&db.conn, in_worktree, &[other_tag.id], &[]).await,
            Err(TagError::NotApplicable { tag_id, .. }) if tag_id == other_tag.id
        ));

        // Chat mode: global tags only.
        let chat = folder_service::add_chat_folder(&db.conn, "/tmp/tags-fam-chat")
            .await
            .unwrap();
        let chat_conv = seed_conversation(&db, chat.id, AgentType::ClaudeCode).await;
        update_conversation_tags(&db.conn, chat_conv, &[shared.id], &[])
            .await
            .expect("global tags fit a chat");
        assert!(matches!(
            update_conversation_tags(&db.conn, chat_conv, &[repo_tag.id], &[]).await,
            Err(TagError::NotApplicable { .. })
        ));

        // A refused batch writes nothing — not even its valid half.
        assert!(update_conversation_tags(
            &db.conn,
            chat_conv,
            &[shared.id, repo_tag.id],
            &[shared.id]
        )
        .await
        .is_err());
        assert_eq!(tag_ids(&db.conn, chat_conv).await, vec![shared.id]);
    }

    #[tokio::test]
    async fn unknown_tags_and_dead_conversations_are_refused() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/tags-refuse").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        assert!(matches!(
            update_conversation_tags(&db.conn, conv, &[777], &[]).await,
            Err(TagError::TagNotFound(777))
        ));
        let tag = global(&db.conn, "t").await;
        conversation_service::soft_delete(&db.conn, conv)
            .await
            .unwrap();
        assert!(matches!(
            update_conversation_tags(&db.conn, conv, &[tag.id], &[]).await,
            Err(TagError::ConversationNotFound(_))
        ));
    }

    #[tokio::test]
    async fn deleting_a_tag_takes_it_off_every_conversation() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/tags-delete").await;
        let one = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let two = seed_conversation(&db, folder, AgentType::Codex).await;
        let doomed = global(&db.conn, "doomed").await;
        let kept = global(&db.conn, "kept").await;
        for conv in [one, two] {
            update_conversation_tags(&db.conn, conv, &[doomed.id, kept.id], &[])
                .await
                .unwrap();
        }

        assert!(delete_tag(&db.conn, doomed.id).await.unwrap());
        assert!(!delete_tag(&db.conn, doomed.id).await.unwrap(), "already gone");
        for conv in [one, two] {
            assert_eq!(tag_ids(&db.conn, conv).await, vec![kept.id]);
        }
        let links = conversation_tag_link::Entity::find()
            .filter(conversation_tag_link::Column::TagId.eq(doomed.id))
            .all(&db.conn)
            .await
            .unwrap();
        assert!(links.is_empty());
    }

    #[tokio::test]
    async fn every_summary_path_carries_the_tags() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/tags-summary").await;
        let parent = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let child = conversation_service::create_with_delegation(
            &db.conn,
            folder,
            AgentType::Codex,
            None,
            None,
            Some(crate::acp::delegation::spawner::DelegationLink {
                parent_conversation_id: parent,
                parent_tool_use_id: "tool-1".into(),
                delegation_call_id: "call-1".into(),
            }),
        )
        .await
        .unwrap()
        .id;
        let untagged = seed_conversation(&db, folder, AgentType::Codex).await;
        let tag = global(&db.conn, "t").await;
        for conv in [parent, child] {
            update_conversation_tags(&db.conn, conv, &[tag.id], &[])
                .await
                .unwrap();
        }

        assert_eq!(tag_ids(&db.conn, parent).await, vec![tag.id]);
        let all = conversation_service::list_all(&db.conn, None, None, None, None, None, false)
            .await
            .unwrap();
        let by_id = |id: i32| all.iter().find(|s| s.id == id).unwrap().tag_ids.clone();
        assert_eq!(by_id(parent), vec![tag.id]);
        assert!(by_id(untagged).is_empty());
        let in_folder =
            conversation_service::list_by_folder(&db.conn, folder, None, None, None, None)
                .await
                .unwrap();
        assert_eq!(
            in_folder
                .iter()
                .find(|s| s.id == parent)
                .unwrap()
                .tag_ids,
            vec![tag.id]
        );
        let children = conversation_service::list_children(&db.conn, parent)
            .await
            .unwrap();
        assert_eq!(children[0].tag_ids, vec![tag.id]);
        let by_ref = conversation_service::find_live_by_session_ref(&db.conn, &parent.to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(by_ref.tag_ids, vec![tag.id]);

        // On the wire an untagged row has no `tag_ids` at all, a tagged one an
        // array — the frontend reads absent as "none".
        let untagged_json = serde_json::to_value(
            conversation_service::get_by_id(&db.conn, untagged)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(untagged_json.get("tag_ids").is_none());
        let tagged_json = serde_json::to_value(
            conversation_service::get_by_id(&db.conn, parent)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(tagged_json["tag_ids"], serde_json::json!([tag.id]));
    }

    #[tokio::test]
    async fn a_session_split_keeps_the_tags_on_the_row_holding_the_old_history() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/tags-split").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let tag = global(&db.conn, "t").await;
        update_conversation_tags(&db.conn, conv, &[tag.id], &[])
            .await
            .unwrap();
        conversation_service::bind_external_id(&db.conn, conv, "session-1", &[])
            .await
            .unwrap();

        // A different, unrelated session lands on the bound row: the old
        // history is preserved on a new row, which is the old conversation.
        let preserved = conversation_service::bind_external_id(&db.conn, conv, "session-2", &[])
            .await
            .unwrap()
            .expect("the outgoing session is preserved on its own row");
        assert_eq!(tag_ids(&db.conn, preserved).await, vec![tag.id]);
        assert_eq!(tag_ids(&db.conn, conv).await, vec![tag.id]);
    }

    fn branch_tag(enabled: bool, color: &str) -> ConversationBranchTag {
        ConversationBranchTag {
            enabled,
            color: color.to_string(),
        }
    }

    #[tokio::test]
    async fn the_branch_tag_is_off_until_saved_then_reads_back_as_stored() {
        let db = fresh_in_memory_db().await;
        assert_eq!(
            get_branch_tag(&db.conn).await.unwrap(),
            branch_tag(false, DEFAULT_BRANCH_TAG_COLOR)
        );

        let saved = set_branch_tag(&db.conn, true, " #0A0 ").await.unwrap();
        assert_eq!(saved, branch_tag(true, "#00aa00"));
        assert_eq!(get_branch_tag(&db.conn).await.unwrap(), saved);

        // Saved whole: switching it off keeps the colour it was given.
        set_branch_tag(&db.conn, false, "#00aa00").await.unwrap();
        assert_eq!(
            get_branch_tag(&db.conn).await.unwrap(),
            branch_tag(false, "#00aa00")
        );
    }

    #[tokio::test]
    async fn a_bad_branch_tag_colour_is_refused_and_changes_nothing() {
        let db = fresh_in_memory_db().await;
        set_branch_tag(&db.conn, true, "#123456").await.unwrap();
        let err = set_branch_tag(&db.conn, false, "blue").await.unwrap_err();
        assert!(matches!(err, TagError::InvalidColor(_)), "{err:?}");
        assert_eq!(
            get_branch_tag(&db.conn).await.unwrap(),
            branch_tag(true, "#123456")
        );
    }

    #[tokio::test]
    async fn an_unreadable_stored_branch_tag_falls_back_instead_of_failing() {
        let db = fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, BRANCH_TAG_KEY, "not json")
            .await
            .unwrap();
        assert_eq!(
            get_branch_tag(&db.conn).await.unwrap(),
            default_branch_tag()
        );

        // Only the colour is bad: the switch is still the user's.
        app_metadata_service::upsert_value(
            &db.conn,
            BRANCH_TAG_KEY,
            r#"{"enabled":true,"color":"red"}"#,
        )
        .await
        .unwrap();
        assert_eq!(
            get_branch_tag(&db.conn).await.unwrap(),
            branch_tag(true, DEFAULT_BRANCH_TAG_COLOR)
        );
    }
}
