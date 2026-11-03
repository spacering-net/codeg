use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, Set, TransactionTrait,
};
use serde::Deserialize;

use crate::db::entities::message_queue_item;
use crate::db::error::DbError;
use crate::models::MessageQueueItem;

/// A queue item as supplied by the frontend when saving. Field names are
/// camelCase on the wire (both the Tauri command and the axum web handler
/// expect it), so serde rename handles the mapping to the Rust fields.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemInput {
    pub id: String,
    pub draft_json: String,
    pub mode_id: Option<String>,
    pub adopt_send_time_mode: bool,
}

fn to_item(m: message_queue_item::Model) -> MessageQueueItem {
    MessageQueueItem {
        id: m.item_uid,
        draft_json: m.draft_json,
        mode_id: m.mode_id,
        adopt_send_time_mode: m.adopt_send_time_mode,
    }
}

pub async fn list(
    conn: &DatabaseConnection,
    owner_id: &str,
) -> Result<Vec<MessageQueueItem>, DbError> {
    let rows = message_queue_item::Entity::find()
        .filter(message_queue_item::Column::OwnerId.eq(owner_id))
        .order_by_asc(message_queue_item::Column::SortOrder)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(to_item).collect())
}

/// Replace the entire queue for `owner_id` with `items` (in order). Simple and
/// idempotent: last-writer-wins, and the broadcast converges every client to the
/// same list. Multi-end sync is the goal, so the frontend is the source of
/// truth for ordering and the backend just persists the canonical list. The
/// whole replace runs in one transaction so a concurrent reader never sees a
/// half-written queue.
pub async fn save(
    conn: &DatabaseConnection,
    owner_id: &str,
    items: Vec<QueueItemInput>,
) -> Result<Vec<MessageQueueItem>, DbError> {
    let txn = conn.begin().await?;
    message_queue_item::Entity::delete_many()
        .filter(message_queue_item::Column::OwnerId.eq(owner_id))
        .exec(&txn)
        .await?;

    let mut saved = Vec::with_capacity(items.len());
    for (idx, item) in items.into_iter().enumerate() {
        let now = Utc::now();
        let active = message_queue_item::ActiveModel {
            id: NotSet,
            owner_id: Set(owner_id.to_string()),
            item_uid: Set(item.id),
            draft_json: Set(item.draft_json),
            mode_id: Set(item.mode_id),
            adopt_send_time_mode: Set(item.adopt_send_time_mode),
            sort_order: Set(idx as i32),
            created_at: Set(now),
            updated_at: Set(now),
        };
        let m = active.insert(&txn).await?;
        saved.push(to_item(m));
    }
    txn.commit().await?;
    Ok(saved)
}
