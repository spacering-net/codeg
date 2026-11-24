use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};
use std::sync::OnceLock;
use tokio::sync::Mutex;

use crate::db::entities::opened_tab;
use crate::db::error::DbError;
use crate::db::service::app_metadata_service;
use crate::models::agent::AgentType;
use crate::models::OpenedTab;

/// Serializes all version-mutating tab operations within the process so the
/// logical clock advances strictly sequentially. Two concurrent writers would
/// otherwise both read the version and then both try to bump it; under SQLite
/// WAL the loser fails with a snapshot/busy error instead of cleanly observing
/// the new version and returning `accepted: false`. Tab mutations are tiny and
/// client-side debounced, so serializing them costs nothing — this is a
/// correctness lock on a shared counter, not a throughput cap.
fn version_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Workspace-global logical clock for the open-tab set, stored in the
/// `app_metadata` KV table (survives restart, stays monotonic). Bumped on every
/// accepted mutation; used for compare-and-set (lost-update prevention) and for
/// client-side echo/ordering on the `tabs://changed` side-channel.
const OPENED_TABS_VERSION_KEY: &str = "opened_tabs_version";

/// Outcome of a compare-and-set tab save.
pub struct CasOutcome {
    /// Whether the write was applied (the version matched).
    pub accepted: bool,
    /// Authoritative version after the call (incremented iff `accepted`).
    pub version: i64,
    /// Canonical persisted tab set after the call.
    pub tabs: Vec<OpenedTab>,
}

fn parse_agent_type(s: &str) -> Option<AgentType> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
}

/// Read the current tab-set version (0 when never written).
pub async fn get_tabs_version<C: ConnectionTrait>(conn: &C) -> Result<i64, DbError> {
    let raw = app_metadata_service::get_value_conn(conn, OPENED_TABS_VERSION_KEY).await?;
    Ok(raw.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0))
}

pub async fn list_all_tabs<C: ConnectionTrait>(conn: &C) -> Result<Vec<OpenedTab>, DbError> {
    let rows = opened_tab::Entity::find()
        .order_by_asc(opened_tab::Column::Position)
        .all(conn)
        .await?;

    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let agent_type = parse_agent_type(&r.agent_type)?;
            Some(OpenedTab {
                id: r.id,
                folder_id: r.folder_id,
                conversation_id: r.conversation_id,
                agent_type,
                position: r.position,
                is_active: r.is_active,
                is_pinned: r.is_pinned,
            })
        })
        .collect())
}

/// Read the tab set and its version in a single transaction so a concurrent
/// save can't tear the pair — returning old tabs stamped with the new version,
/// which a client could then CAS-save as if it were current, dropping the
/// concurrent change.
pub async fn snapshot_tabs(conn: &DatabaseConnection) -> Result<(Vec<OpenedTab>, i64), DbError> {
    let txn = conn.begin().await?;
    let tabs = list_all_tabs(&txn).await?;
    let version = get_tabs_version(&txn).await?;
    txn.commit().await?;
    Ok((tabs, version))
}

/// Replace all tabs with the given list (full replacement).
///
/// Draft tabs (`conversation_id == None`) are **never persisted** — a draft is a
/// device-local working surface (volatile id, provisional agent, live ACP
/// connection) and must not leak across clients via this shared table. This is
/// the single persistence chokepoint, so the invariant holds for every caller.
///
/// Ensures at most one `is_active = true` (first active wins; others forced
/// false). `is_active` marks the focused tab and is mirrored across clients
/// (see `tab-context.tsx`).
pub async fn save_all_tabs<C: ConnectionTrait>(
    conn: &C,
    items: Vec<OpenedTab>,
) -> Result<(), DbError> {
    opened_tab::Entity::delete_many().exec(conn).await?;

    let now = Utc::now();
    let mut active_seen = false;

    for item in items {
        // Skip drafts — never persist a conversation-less tab.
        if item.conversation_id.is_none() {
            continue;
        }

        let agent_str = serde_json::to_value(item.agent_type)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();

        let is_active = if item.is_active && !active_seen {
            active_seen = true;
            true
        } else {
            false
        };

        let active = opened_tab::ActiveModel {
            id: NotSet,
            folder_id: Set(item.folder_id),
            conversation_id: Set(item.conversation_id),
            agent_type: Set(agent_str),
            position: Set(item.position),
            is_active: Set(is_active),
            is_pinned: Set(item.is_pinned),
            created_at: Set(now),
            updated_at: Set(now),
        };
        active.insert(conn).await?;
    }

    Ok(())
}

/// Compare-and-set save: only writes when `expected_version` matches the stored
/// version, then bumps it. A stale save (built from an older version because
/// another client committed first) is rejected without touching the table — the
/// caller is handed the current truth (`accepted: false`) to reconcile against.
/// The read-check-write runs in a single transaction so it is atomic.
pub async fn save_all_tabs_cas(
    conn: &DatabaseConnection,
    items: Vec<OpenedTab>,
    expected_version: i64,
) -> Result<CasOutcome, DbError> {
    let _guard = version_lock().lock().await;
    let txn = conn.begin().await?;

    let current = get_tabs_version(&txn).await?;
    if current != expected_version {
        let tabs = list_all_tabs(&txn).await?;
        txn.commit().await?;
        return Ok(CasOutcome {
            accepted: false,
            version: current,
            tabs,
        });
    }

    save_all_tabs(&txn, items).await?;
    let next = current + 1;
    app_metadata_service::upsert_value(&txn, OPENED_TABS_VERSION_KEY, &next.to_string()).await?;
    let tabs = list_all_tabs(&txn).await?;
    txn.commit().await?;

    Ok(CasOutcome {
        accepted: true,
        version: next,
        tabs,
    })
}

/// Outcome of a server-side tab invalidation (conversation/folder deletion).
///
/// The `version` is ALWAYS advanced — it acts as a *barrier*: a concurrent stale
/// `save_all_tabs_cas` built before the deletion (and possibly re-adding a tab
/// for the now-deleted entity) no longer matches the version and is rejected,
/// forcing it to reconcile. `emit` carries the new snapshot to broadcast ONLY
/// when a persisted row actually changed; a zero-row invalidation needs no
/// broadcast — any client still holding that tab is mid-debounce and reconciles
/// via its rejected save, and clients with a persisted tab are the rows-removed
/// case.
pub struct TabInvalidation {
    pub version: i64,
    pub emit: Option<Vec<OpenedTab>>,
}

/// The server-side tab mutations that run under [`mutate_tabs_and_bump`].
enum TabMutation<'a> {
    DeleteConversation(i32),
    DeleteFolder(i32),
    RetargetConversations(&'a [i32]),
}

/// The skeleton every server-side tab invalidation shares: take
/// [`version_lock`], open ONE transaction, apply `mutation`, ALWAYS bump the
/// version (the barrier that rejects a concurrent stale `save_all_tabs_cas`),
/// and snapshot only when a row actually changed.
async fn mutate_tabs_and_bump(
    conn: &DatabaseConnection,
    mutation: TabMutation<'_>,
) -> Result<TabInvalidation, DbError> {
    let _guard = version_lock().lock().await;
    let txn = conn.begin().await?;
    let changed = match mutation {
        TabMutation::DeleteConversation(conversation_id) => {
            opened_tab::Entity::delete_many()
                .filter(opened_tab::Column::ConversationId.eq(conversation_id))
                .exec(&txn)
                .await?
                .rows_affected
        }
        TabMutation::DeleteFolder(folder_id) => {
            opened_tab::Entity::delete_many()
                .filter(opened_tab::Column::FolderId.eq(folder_id))
                .exec(&txn)
                .await?
                .rows_affected
        }
        TabMutation::RetargetConversations(conversation_ids) => {
            retarget_rows(&txn, conversation_ids).await?
        }
    };
    let next = get_tabs_version(&txn).await? + 1;
    app_metadata_service::upsert_value(&txn, OPENED_TABS_VERSION_KEY, &next.to_string()).await?;
    let emit = if changed > 0 {
        Some(list_all_tabs(&txn).await?)
    } else {
        None
    };
    txn.commit().await?;
    Ok(TabInvalidation {
        version: next,
        emit,
    })
}

/// Point every persisted tab of `conversation_ids` at the folder its
/// conversation row is in NOW (read inside the same transaction, so a move
/// that lands after another one still leaves the tab on the final folder).
/// Returns how many rows changed.
async fn retarget_rows<C: ConnectionTrait>(
    conn: &C,
    conversation_ids: &[i32],
) -> Result<u64, DbError> {
    use crate::db::entities::conversation;
    use sea_orm::QuerySelect;

    if conversation_ids.is_empty() {
        return Ok(0);
    }
    // Lead with a (self-assigning) write so SQLite takes the writer lock now,
    // not a read snapshot it may fail to upgrade at the first real write — the
    // delete mutations get this from their opening DELETE.
    opened_tab::Entity::update_many()
        .col_expr(
            opened_tab::Column::UpdatedAt,
            sea_orm::sea_query::Expr::col(opened_tab::Column::UpdatedAt).into(),
        )
        .filter(opened_tab::Column::ConversationId.is_in(conversation_ids.to_vec()))
        .exec(conn)
        .await?;
    let current: std::collections::HashMap<i32, i32> = conversation::Entity::find()
        .select_only()
        .column(conversation::Column::Id)
        .column(conversation::Column::FolderId)
        .filter(conversation::Column::Id.is_in(conversation_ids.to_vec()))
        .into_tuple::<(i32, i32)>()
        .all(conn)
        .await?
        .into_iter()
        .collect();
    let tabs = opened_tab::Entity::find()
        .filter(opened_tab::Column::ConversationId.is_in(conversation_ids.to_vec()))
        .all(conn)
        .await?;
    let now = Utc::now();
    let mut changed = 0;
    for tab in tabs {
        let Some(folder_id) = tab.conversation_id.and_then(|id| current.get(&id).copied()) else {
            continue;
        };
        if tab.folder_id == folder_id {
            continue;
        }
        let mut active: opened_tab::ActiveModel = tab.into();
        active.folder_id = Set(folder_id);
        active.updated_at = Set(now);
        active.update(conn).await?;
        changed += 1;
    }
    Ok(changed)
}

/// Atomically invalidate every tab pointing at a conversation: delete the rows,
/// ALWAYS bump the version (barrier), and snapshot — all in ONE transaction
/// under [`version_lock`]. Conversation deletion is a SOFT delete (sets
/// `deleted_at`), so the FK `ON DELETE CASCADE` never fires; without explicit
/// cleanup the tab row survives and resurrects as a ghost. Doing delete + bump +
/// snapshot atomically AND serialized means a concurrent stale `save_all_tabs_cas`
/// either ran first (its row is deleted here) or is rejected by the bumped
/// version — it can never persist a tab for the deleted conversation.
pub async fn delete_conversation_tabs_and_bump(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<TabInvalidation, DbError> {
    mutate_tabs_and_bump(conn, TabMutation::DeleteConversation(conversation_id)).await
}

/// Atomically invalidate every tab belonging to a folder (folder removed from
/// the workspace): delete the rows, ALWAYS bump the version (barrier), snapshot —
/// one transaction under [`version_lock`], same race-free guarantee as
/// [`delete_conversation_tabs_and_bump`].
pub async fn delete_folder_tabs_and_bump(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<TabInvalidation, DbError> {
    mutate_tabs_and_bump(conn, TabMutation::DeleteFolder(folder_id)).await
}

/// Re-point every persisted tab of `conversation_ids` at its conversation's
/// current folder (conversations the user moved to another project): the tab
/// id embeds the folder, so a tab left on the old folder would open the
/// conversation in the directory it just left. Same barrier and snapshot rules
/// as [`delete_conversation_tabs_and_bump`]. Client-submitted saves are not
/// rewritten — each client re-points its own tabs from the conversation rows.
pub async fn retarget_conversation_tabs_and_bump(
    conn: &DatabaseConnection,
    conversation_ids: &[i32],
) -> Result<TabInvalidation, DbError> {
    mutate_tabs_and_bump(conn, TabMutation::RetargetConversations(conversation_ids)).await
}
