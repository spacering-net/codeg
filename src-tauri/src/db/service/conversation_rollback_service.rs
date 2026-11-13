use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

use crate::db::entities::{conversation_checkpoint, conversation_rollback_state};
use crate::db::error::DbError;

pub async fn record_checkpoint(
    conn: &DatabaseConnection,
    conversation_id: i32,
    turn_id: String,
    turn_index: i32,
    user_prompt_text: String,
    shadow_tree_hash: Option<String>,
    prev_turn_id: Option<String>,
) -> Result<conversation_checkpoint::Model, DbError> {
    let model = conversation_checkpoint::ActiveModel {
        conversation_id: Set(conversation_id),
        turn_id: Set(turn_id),
        turn_index: Set(turn_index),
        user_prompt_text: Set(user_prompt_text),
        shadow_tree_hash: Set(shadow_tree_hash),
        prev_turn_id: Set(prev_turn_id),
        created_at: Set(Utc::now()),
        ..Default::default()
    };
    Ok(model.insert(conn).await?)
}

pub async fn find_checkpoint_for_undo(
    conn: &DatabaseConnection,
    conversation_id: i32,
    turn_id: &str,
    user_turn_index: Option<i32>,
) -> Result<Option<conversation_checkpoint::Model>, DbError> {
    let all = conversation_checkpoint::Entity::find()
        .filter(conversation_checkpoint::Column::ConversationId.eq(conversation_id))
        .order_by_asc(conversation_checkpoint::Column::TurnIndex)
        .order_by_asc(conversation_checkpoint::Column::Id)
        .all(conn)
        .await?;

    if let Some(exact) = all.iter().find(|c| c.turn_id == turn_id) {
        return Ok(Some(exact.clone()));
    }
    if let Some(idx) = user_turn_index {
        if let Some(by_idx) = all.iter().find(|c| c.turn_index == idx) {
            return Ok(Some(by_idx.clone()));
        }
    }
    Ok(None)
}

pub async fn delete_checkpoints_from(
    conn: &DatabaseConnection,
    conversation_id: i32,
    from_turn_index: i32,
) -> Result<(), DbError> {
    conversation_checkpoint::Entity::delete_many()
        .filter(conversation_checkpoint::Column::ConversationId.eq(conversation_id))
        .filter(conversation_checkpoint::Column::TurnIndex.gte(from_turn_index))
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn count_checkpoints(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<usize, DbError> {
    let all = conversation_checkpoint::Entity::find()
        .filter(conversation_checkpoint::Column::ConversationId.eq(conversation_id))
        .all(conn)
        .await?;
    Ok(all.len())
}

pub async fn get_rollback_state(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Option<conversation_rollback_state::Model>, DbError> {
    Ok(conversation_rollback_state::Entity::find_by_id(conversation_id)
        .one(conn)
        .await?)
}

pub async fn upsert_rollback_state(
    conn: &DatabaseConnection,
    conversation_id: i32,
    preserved_turns_json: Option<String>,
    pending_context_notice: Option<String>,
) -> Result<(), DbError> {
    let existing = conversation_rollback_state::Entity::find_by_id(conversation_id)
        .one(conn)
        .await?;
    let now = Utc::now();
    if let Some(row) = existing {
        let mut active: conversation_rollback_state::ActiveModel = row.into();
        active.preserved_turns_json = Set(preserved_turns_json);
        active.pending_context_notice = Set(pending_context_notice);
        active.updated_at = Set(now);
        active.update(conn).await?;
    } else {
        let active = conversation_rollback_state::ActiveModel {
            conversation_id: Set(conversation_id),
            preserved_turns_json: Set(preserved_turns_json),
            pending_context_notice: Set(pending_context_notice),
            updated_at: Set(now),
        };
        active.insert(conn).await?;
    }
    Ok(())
}

pub async fn take_pending_context_notice(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Option<String>, DbError> {
    let Some(row) = conversation_rollback_state::Entity::find_by_id(conversation_id)
        .one(conn)
        .await?
    else {
        return Ok(None);
    };
    let notice = row.pending_context_notice.clone();
    if notice.is_some() {
        let mut active: conversation_rollback_state::ActiveModel = row.into();
        active.pending_context_notice = Set(None);
        active.updated_at = Set(Utc::now());
        active.update(conn).await?;
    }
    Ok(notice)
}
