//! Durable turn results and automatic session-message delivery share one transaction.
use chrono::Utc;
use sea_orm::{
    sea_query::Expr, ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr,
    EntityTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};

use super::session_message_service as queue;
use crate::db::entities::{conversation, conversation_turn, delegation_delivery, session_message};

#[derive(Debug, Clone)]
pub struct DeliveryPolicy {
    pub parent_conversation_id: i32,
    pub notify_mode: String,
    pub follow: bool,
}

#[derive(Debug, Clone)]
pub struct MessageProvenance {
    pub result_turn_id: Option<String>,
    pub cause_message_id: Option<String>,
    pub root_id: String,
    pub source_conversation_id: i32,
    pub hop: i32,
}

/// Called under the connection's prompt admission lock, before sending to the CLI.
pub async fn begin(
    db: &DatabaseConnection,
    conversation_id: i32,
    input_message_id: Option<&str>,
    policy: Option<&DeliveryPolicy>,
) -> Result<String, DbErr> {
    let txn = db.begin().await?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    let input = match input_message_id {
        Some(id) => {
            session_message::Entity::find()
                .filter(session_message::Column::MessageId.eq(id))
                .filter(session_message::Column::ConversationId.eq(conversation_id))
                .filter(session_message::Column::Status.eq("in_flight"))
                .one(&txn)
                .await?
        }
        None => None,
    };
    let parent_turn = if let Some(policy) = policy {
        active(&txn, policy.parent_conversation_id).await?
    } else {
        None
    };
    let root_id = input
        .as_ref()
        .and_then(|row| row.root_id.clone())
        .or_else(|| parent_turn.as_ref().map(|turn| turn.root_id.clone()))
        .unwrap_or_else(|| turn_id.clone());
    let source = input
        .as_ref()
        .and_then(|row| row.source_conversation_id)
        .or_else(|| parent_turn.as_ref().map(|turn| turn.source_conversation_id))
        .unwrap_or(conversation_id);
    let hop = input
        .as_ref()
        .map(|row| row.hop)
        .or_else(|| parent_turn.as_ref().map(|turn| turn.hop))
        .unwrap_or(0);
    conversation_turn::ActiveModel {
        turn_id: Set(turn_id.clone()),
        conversation_id: Set(conversation_id),
        state: Set("in_flight".into()),
        result_text: Set(None),
        stop_reason: Set(None),
        cause_message_id: Set(input.as_ref().map(|row| row.message_id.clone())),
        root_id: Set(root_id),
        source_conversation_id: Set(source),
        hop: Set(hop),
        created_at: Set(Utc::now()),
        completed_at: Set(None),
    }
    .insert(&txn)
    .await?;
    if let Some(input) = input {
        bind_in_tx(&txn, input.id, &turn_id).await?;
    }
    if let Some(policy) = policy {
        if !matches!(policy.notify_mode.as_str(), "poll" | "deliver") {
            return Err(DbErr::Custom("notify_mode must be poll or deliver".into()));
        }
        delegation_delivery::ActiveModel {
            child_conversation_id: Set(conversation_id),
            parent_conversation_id: Set(policy.parent_conversation_id),
            first_turn_id: Set(turn_id.clone()),
            notify_mode: Set(policy.notify_mode.clone()),
            follow: Set(policy.follow),
        }
        .insert(&txn)
        .await?;
    }
    txn.commit().await?;
    Ok(turn_id)
}

pub async fn active<C: ConnectionTrait>(
    db: &C,
    conversation_id: i32,
) -> Result<Option<conversation_turn::Model>, DbErr> {
    conversation_turn::Entity::find()
        .filter(conversation_turn::Column::ConversationId.eq(conversation_id))
        .filter(conversation_turn::Column::State.eq("in_flight"))
        .order_by_desc(conversation_turn::Column::CreatedAt)
        .one(db)
        .await
}

async fn bind_in_tx<C: ConnectionTrait>(
    db: &C,
    message_id: i32,
    turn_id: &str,
) -> Result<(), DbErr> {
    session_message::Entity::update_many()
        .col_expr(
            session_message::Column::RecipientTurnId,
            Expr::value(turn_id),
        )
        .filter(session_message::Column::Id.eq(message_id))
        .filter(session_message::Column::Status.eq("in_flight"))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn bind(db: &DatabaseConnection, message_id: i32, turn_id: &str) -> Result<(), DbErr> {
    bind_in_tx(db, message_id, turn_id).await
}

pub async fn unbind(db: &DatabaseConnection, message_id: i32) -> Result<(), DbErr> {
    session_message::Entity::update_many()
        .col_expr(
            session_message::Column::RecipientTurnId,
            Expr::value(None::<String>),
        )
        .filter(session_message::Column::Id.eq(message_id))
        .filter(session_message::Column::Status.eq("in_flight"))
        .exec(db)
        .await?;
    Ok(())
}

/// CAS the immutable result, settle its bound input messages and enqueue replies
/// atomically. Retries use the committed result, never a caller's newer text.
pub async fn complete(
    db: &DatabaseConnection,
    turn_id: &str,
    stop_reason: &str,
    text: &str,
) -> Result<(), DbErr> {
    let txn = db.begin().await?;
    conversation_turn::Entity::update_many()
        .col_expr(conversation_turn::Column::State, Expr::value("completed"))
        .col_expr(conversation_turn::Column::ResultText, Expr::value(text))
        .col_expr(
            conversation_turn::Column::StopReason,
            Expr::value(stop_reason),
        )
        .col_expr(
            conversation_turn::Column::CompletedAt,
            Expr::value(Utc::now()),
        )
        .filter(conversation_turn::Column::TurnId.eq(turn_id))
        .filter(conversation_turn::Column::State.eq("in_flight"))
        .exec(&txn)
        .await?;
    let turn = conversation_turn::Entity::find_by_id(turn_id)
        .one(&txn)
        .await?
        .ok_or_else(|| DbErr::Custom(format!("turn {turn_id} not found")))?;
    if turn.state != "completed" {
        txn.commit().await?;
        return Ok(());
    }
    let inputs = session_message::Entity::find()
        .filter(session_message::Column::RecipientTurnId.eq(turn_id))
        .filter(session_message::Column::Status.is_in([
            "in_flight",
            "interrupted",
            "completed",
            "failed",
        ]))
        .order_by_asc(session_message::Column::Id)
        .all(&txn)
        .await?;
    for input in inputs {
        let success = turn.stop_reason.as_deref() == Some("end_turn");
        session_message::Entity::update_many()
            .col_expr(
                session_message::Column::Status,
                Expr::value(if success { "completed" } else { "failed" }),
            )
            .col_expr(
                session_message::Column::Error,
                Expr::value(if success {
                    None
                } else {
                    turn.stop_reason.clone()
                }),
            )
            .col_expr(session_message::Column::UpdatedAt, Expr::value(Utc::now()))
            .filter(session_message::Column::Id.eq(input.id))
            .exec(&txn)
            .await?;
        if success && input.reply_back {
            deliver_in_tx(
                &txn,
                &turn,
                input.sender_conversation_id,
                Some(input.message_id),
            )
            .await?;
        }
    }
    txn.commit().await?;
    Ok(())
}

async fn deliver_in_tx<C: ConnectionTrait>(
    db: &C,
    turn: &conversation_turn::Model,
    recipient: i32,
    cause: Option<String>,
) -> Result<(), DbErr> {
    let exists = session_message::Entity::find()
        .filter(session_message::Column::ResultTurnId.eq(turn.turn_id.clone()))
        .filter(session_message::Column::ConversationId.eq(recipient))
        .one(db)
        .await?
        .is_some();
    if exists {
        return Ok(());
    }
    for id in [turn.conversation_id, recipient] {
        if conversation::Entity::find_by_id(id)
            .filter(conversation::Column::DeletedAt.is_null())
            .one(db)
            .await?
            .is_none()
        {
            return Ok(());
        }
    }
    let provenance = MessageProvenance {
        result_turn_id: Some(turn.turn_id.clone()),
        cause_message_id: cause.or_else(|| turn.cause_message_id.clone()),
        root_id: turn.root_id.clone(),
        source_conversation_id: turn.source_conversation_id,
        hop: turn.hop + 1,
    };
    queue::insert_in_tx(
        db,
        turn.conversation_id,
        recipient,
        format!(
            "[Result from conversation {}; turn {}; stop_reason {}]\n\n{}",
            turn.conversation_id,
            turn.turn_id,
            turn.stop_reason.as_deref().unwrap_or("unknown"),
            turn.result_text.as_deref().unwrap_or_default()
        ),
        "queue".into(),
        false,
        Some(&provenance),
    )
    .await?;
    Ok(())
}

/// Only committed results can be reconciled. An in-flight CLI delivery has an
/// unknowable acceptance boundary after process loss and must not be replayed.
pub async fn recover(db: &DatabaseConnection) -> Result<(), DbErr> {
    let finished = conversation_turn::Entity::find()
        .filter(conversation_turn::Column::State.eq("completed"))
        .all(db)
        .await?;
    for turn in finished {
        complete(db, &turn.turn_id, "end_turn", "").await?;
    }
    conversation_turn::Entity::update_many()
        .col_expr(conversation_turn::Column::State, Expr::value("interrupted"))
        .col_expr(
            conversation_turn::Column::StopReason,
            Expr::value("delivery_unconfirmed_after_restart"),
        )
        .filter(conversation_turn::Column::State.eq("in_flight"))
        .exec(db)
        .await?;
    session_message::Entity::update_many()
        .col_expr(session_message::Column::Status, Expr::value("interrupted"))
        .col_expr(session_message::Column::Error, Expr::value("delivery unconfirmed: CLI may have accepted it before Codeg stopped; not automatically replayed"))
        .col_expr(session_message::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(session_message::Column::Status.eq("in_flight")).exec(db).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder},
        models::AgentType,
    };

    #[tokio::test]
    async fn committed_result_reply_is_atomic_and_restart_is_idempotent() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/delivery").await;
        let parent = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let child = seed_conversation(&db, folder, AgentType::Codex).await;
        let message_id =
            queue::enqueue(&db.conn, parent, child, "task".into(), "queue".into(), true)
                .await
                .unwrap();
        let row = queue::queued(&db.conn).await.unwrap().remove(0);
        queue::claim(&db.conn, &row).await.unwrap();
        let turn = begin(&db.conn, child, Some(&message_id), None)
            .await
            .unwrap();
        complete(&db.conn, &turn, "end_turn", "answer")
            .await
            .unwrap();
        complete(&db.conn, &turn, "end_turn", "wrong replay")
            .await
            .unwrap();
        recover(&db.conn).await.unwrap();
        recover(&db.conn).await.unwrap();
        let replies = queue::queued(&db.conn).await.unwrap();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0].conversation_id, parent);
        assert!(replies[0].message.contains("answer"));
        assert_eq!(replies[0].result_turn_id.as_deref(), Some(turn.as_str()));
        let saved = conversation_turn::Entity::find_by_id(turn)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.result_text.as_deref(), Some("answer"));
    }

    #[tokio::test]
    async fn result_and_reply_insert_roll_back_together() {
        use sea_orm::{DbBackend, Statement};
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/delivery-rollback").await;
        let parent = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let child = seed_conversation(&db, folder, AgentType::Codex).await;
        let message = queue::enqueue(&db.conn, parent, child, "task".into(), "queue".into(), true)
            .await
            .unwrap();
        let row = queue::queued(&db.conn).await.unwrap().remove(0);
        queue::claim(&db.conn, &row).await.unwrap();
        let turn = begin(&db.conn, child, Some(&message), None).await.unwrap();
        db.conn.execute(Statement::from_string(DbBackend::Sqlite,"CREATE TRIGGER reject_delivery BEFORE INSERT ON session_message BEGIN SELECT RAISE(ABORT, 'test'); END".to_owned())).await.unwrap();
        assert!(complete(&db.conn, &turn, "end_turn", "answer")
            .await
            .is_err());
        let saved = conversation_turn::Entity::find_by_id(turn)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.state, "in_flight");
        assert!(saved.result_text.is_none());
    }

    #[tokio::test]
    async fn unconfirmed_cli_delivery_stays_interrupted_and_is_not_replayed() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/unconfirmed").await;
        let parent = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let child = seed_conversation(&db, folder, AgentType::Codex).await;
        queue::enqueue(&db.conn, parent, child, "task".into(), "queue".into(), true)
            .await
            .unwrap();
        let row = queue::queued(&db.conn).await.unwrap().remove(0);
        queue::claim(&db.conn, &row).await.unwrap();
        begin(&db.conn, child, Some(&row.message_id), None)
            .await
            .unwrap();
        recover(&db.conn).await.unwrap();
        let saved = session_message::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.status, "interrupted");
        assert!(saved.error.unwrap().contains("unconfirmed"));
        assert!(queue::queued(&db.conn).await.unwrap().is_empty());
    }
}
