use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

use crate::acp::types::ToolApprovalInfo;
use crate::db::entities::tool_approval;
use crate::db::error::DbError;

/// Keep `approval` as the answer about its tool call in `conversation_id`,
/// replacing whatever an earlier answer about the same call left there.
pub async fn record(
    conn: &DatabaseConnection,
    conversation_id: i32,
    approval: &ToolApprovalInfo,
) -> Result<(), DbError> {
    tool_approval::Entity::insert(tool_approval::ActiveModel {
        id: NotSet,
        conversation_id: Set(conversation_id),
        tool_call_id: Set(approval.tool_call_id.clone()),
        option_kind: Set(approval.option_kind.clone()),
        option_name: Set(approval.option_name.clone()),
        origin: Set(approval.origin.clone()),
        decided_at: Set(approval.decided_at),
    })
    .on_conflict(
        OnConflict::columns([
            tool_approval::Column::ConversationId,
            tool_approval::Column::ToolCallId,
        ])
        .update_columns([
            tool_approval::Column::OptionKind,
            tool_approval::Column::OptionName,
            tool_approval::Column::Origin,
            tool_approval::Column::DecidedAt,
        ])
        .to_owned(),
    )
    .exec(conn)
    .await?;
    Ok(())
}

/// Every approval kept for `conversation_id`, oldest first.
pub async fn list_by_conversation(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Vec<ToolApprovalInfo>, DbError> {
    let rows = tool_approval::Entity::find()
        .filter(tool_approval::Column::ConversationId.eq(conversation_id))
        .order_by_asc(tool_approval::Column::DecidedAt)
        .order_by_asc(tool_approval::Column::Id)
        .all(conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| ToolApprovalInfo {
            tool_call_id: row.tool_call_id,
            option_kind: row.option_kind,
            option_name: row.option_name,
            origin: row.origin,
            decided_at: row.decided_at,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;
    use chrono::{TimeZone, Utc};

    fn approval(tool_call_id: &str, option_kind: &str, minute: u32) -> ToolApprovalInfo {
        ToolApprovalInfo {
            tool_call_id: tool_call_id.into(),
            option_kind: option_kind.into(),
            option_name: format!("{option_kind} label"),
            origin: "user".into(),
            decided_at: Utc.with_ymd_and_hms(2026, 10, 22, 9, minute, 0).unwrap(),
        }
    }

    #[tokio::test]
    async fn records_one_answer_per_tool_call_and_lists_them_oldest_first() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/approvals").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let other = seed_conversation(&db, folder, AgentType::ClaudeCode).await;

        record(&db.conn, conversation, &approval("tc-2", "allow_once", 2))
            .await
            .unwrap();
        record(&db.conn, conversation, &approval("tc-1", "allow_once", 1))
            .await
            .unwrap();
        record(&db.conn, other, &approval("tc-1", "reject_once", 3))
            .await
            .unwrap();
        // A second answer about the same call replaces the first.
        record(&db.conn, conversation, &approval("tc-2", "allow_always", 4))
            .await
            .unwrap();

        let listed = list_by_conversation(&db.conn, conversation).await.unwrap();
        assert_eq!(
            listed,
            vec![
                approval("tc-1", "allow_once", 1),
                approval("tc-2", "allow_always", 4)
            ]
        );
        let theirs = list_by_conversation(&db.conn, other).await.unwrap();
        assert_eq!(theirs, vec![approval("tc-1", "reject_once", 3)]);
    }
}
