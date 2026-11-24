use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait,
    QueryFilter, QueryOrder, Set, TransactionTrait,
};

use crate::db::entities::{conversation, session_message};

/// Queue a message only while both conversations still exist and are visible.
pub async fn enqueue(
    db: &DatabaseConnection,
    sender: i32,
    recipient: i32,
    message: String,
    mode: String,
    reply: bool,
) -> Result<String, DbErr> {
    if message.trim().is_empty() || !matches!(mode.as_str(), "queue" | "steer") {
        return Err(DbErr::Custom("invalid session message".into()));
    }
    let txn = db.begin().await?;
    // Claim SQLite's writer lock before the liveness reads so parallel creation
    // cannot leave another caller trying to write through a stale read snapshot.
    txn.execute_unprepared("UPDATE session_message SET id = id WHERE 0").await?;
    ensure_live(&txn, sender).await?;
    ensure_live(&txn, recipient).await?;
    let id = insert(&txn, sender, recipient, message, mode, reply).await?;
    txn.commit().await?;
    Ok(id)
}

async fn ensure_live<C: ConnectionTrait>(db: &C, id: i32) -> Result<(), DbErr> {
    let row = conversation::Entity::find_by_id(id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(db)
        .await?;
    if row.is_none() {
        return Err(DbErr::Custom(format!(
            "conversation {id} not found or deleted"
        )));
    }
    Ok(())
}

async fn insert<C: ConnectionTrait>(
    db: &C,
    sender: i32,
    recipient: i32,
    message: String,
    mode: String,
    reply: bool,
) -> Result<String, DbErr> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    session_message::ActiveModel {
        message_id: Set(id.clone()),
        sender_conversation_id: Set(sender),
        conversation_id: Set(recipient),
        message: Set(message),
        mode: Set(mode),
        reply_back: Set(reply),
        status: Set("queued".into()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(id)
}

pub async fn queued(db: &DatabaseConnection) -> Result<Vec<session_message::Model>, DbErr> {
    session_message::Entity::find()
        .filter(session_message::Column::Status.eq("queued"))
        .order_by_asc(session_message::Column::Id)
        .all(db)
        .await
}

/// Compare-and-set prevents competing dispatchers from accepting the same row.
pub async fn claim(db: &DatabaseConnection, row: &session_message::Model) -> Result<bool, DbErr> {
    let result = transition_update(row.id, "queued", "in_flight", None)
        .filter(session_message::Column::UpdatedAt.eq(row.updated_at))
        .exec(db)
        .await?;
    Ok(result.rows_affected == 1)
}

pub async fn transition(
    db: &DatabaseConnection,
    id: i32,
    from: &str,
    to: &str,
    error: Option<String>,
) -> Result<bool, DbErr> {
    let result = transition_update(id, from, to, error).exec(db).await?;
    Ok(result.rows_affected == 1)
}

fn transition_update(
    id: i32,
    from: &str,
    to: &str,
    error: Option<String>,
) -> sea_orm::UpdateMany<session_message::Entity> {
    session_message::Entity::update_many()
        .col_expr(
            session_message::Column::Status,
            sea_orm::sea_query::Expr::value(to),
        )
        .col_expr(
            session_message::Column::Error,
            sea_orm::sea_query::Expr::value(error),
        )
        .col_expr(
            session_message::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(session_message::Column::Id.eq(id))
        .filter(session_message::Column::Status.eq(from))
}

pub async fn defer_as_queue(db: &DatabaseConnection, id: i32) -> Result<(), DbErr> {
    session_message::Entity::update_many()
        .col_expr(
            session_message::Column::Status,
            sea_orm::sea_query::Expr::value("queued"),
        )
        .col_expr(
            session_message::Column::Mode,
            sea_orm::sea_query::Expr::value("queue"),
        )
        .col_expr(
            session_message::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(session_message::Column::Id.eq(id))
        .filter(session_message::Column::Status.eq("in_flight"))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn interrupt_in_flight(db: &DatabaseConnection) -> Result<(), DbErr> {
    session_message::Entity::update_many()
        .col_expr(
            session_message::Column::Status,
            sea_orm::sea_query::Expr::value("interrupted"),
        )
        .col_expr(
            session_message::Column::Error,
            sea_orm::sea_query::Expr::value("process restarted during delivery"),
        )
        .col_expr(
            session_message::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(session_message::Column::Status.eq("in_flight"))
        .exec(db)
        .await?;
    Ok(())
}

/// Settle and enqueue the automatic reply in the same transaction.
pub async fn settle(
    db: &DatabaseConnection,
    row: &session_message::Model,
    success: bool,
    result: Option<String>,
    error: Option<String>,
) -> Result<bool, DbErr> {
    let txn = db.begin().await?;
    let mut reason = error;
    let reply_text = result.filter(|s| !s.trim().is_empty());
    let reply = success && row.reply_back && reply_text.is_some();
    if reply
        && conversation::Entity::find_by_id(row.sender_conversation_id)
            .filter(conversation::Column::DeletedAt.is_null())
            .one(&txn)
            .await?
            .is_none()
    {
        reason = Some("automatic reply recipient was deleted".into());
    }
    if reply
        && conversation::Entity::find_by_id(row.conversation_id)
            .filter(conversation::Column::DeletedAt.is_null())
            .one(&txn)
            .await?
            .is_none()
    {
        reason = Some("automatic reply sender was deleted".into());
    }
    let updated = session_message::Entity::update_many()
        .col_expr(
            session_message::Column::Status,
            sea_orm::sea_query::Expr::value(if success { "completed" } else { "failed" }),
        )
        .col_expr(
            session_message::Column::Error,
            sea_orm::sea_query::Expr::value(reason.clone()),
        )
        .col_expr(
            session_message::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(session_message::Column::Id.eq(row.id))
        .filter(session_message::Column::Status.eq("in_flight"))
        .exec(&txn)
        .await?;
    if updated.rows_affected == 1 && reply && reason.is_none() {
        insert(
            &txn,
            row.conversation_id,
            row.sender_conversation_id,
            format!(
                "[Automatic reply from session {}; replying to {}]\n\n{}",
                row.conversation_id,
                row.message_id,
                reply_text.unwrap()
            ),
            "queue".into(),
            false,
        )
        .await?;
    }
    txn.commit().await?;
    Ok(updated.rows_affected == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder},
        models::agent::AgentType,
    };

    #[tokio::test]
    async fn claim_and_reply_are_idempotent() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/session-messages").await;
        let sender = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let recipient = seed_conversation(&db, folder, AgentType::Codex).await;
        enqueue(
            &db.conn,
            sender,
            recipient,
            "hello".into(),
            "queue".into(),
            true,
        )
        .await
        .unwrap();
        let row = queued(&db.conn).await.unwrap().remove(0);
        let (first, second) = tokio::join!(claim(&db.conn, &row), claim(&db.conn, &row));
        assert_ne!(first.unwrap(), second.unwrap());
        assert!(settle(&db.conn, &row, true, Some("answer".into()), None)
            .await
            .unwrap());
        assert!(!settle(&db.conn, &row, true, Some("answer".into()), None)
            .await
            .unwrap());
        let replies = queued(&db.conn).await.unwrap();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0].conversation_id, sender);
        assert!(!replies[0].reply_back);
        assert!(replies[0].message.contains("answer"));
    }

    #[tokio::test]
    async fn reply_insert_failure_rolls_back_settlement() {
        use sea_orm::{DbBackend, Statement};
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/session-messages-rollback").await;
        let sender = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let recipient = seed_conversation(&db, folder, AgentType::Codex).await;
        enqueue(
            &db.conn,
            sender,
            recipient,
            "hello".into(),
            "queue".into(),
            true,
        )
        .await
        .unwrap();
        let row = queued(&db.conn).await.unwrap().remove(0);
        claim(&db.conn, &row).await.unwrap();
        db.conn.execute(Statement::from_string(DbBackend::Sqlite, "CREATE TRIGGER reject_reply BEFORE INSERT ON session_message BEGIN SELECT RAISE(ABORT, 'test'); END".to_owned())).await.unwrap();
        assert!(settle(&db.conn, &row, true, Some("answer".into()), None)
            .await
            .is_err());
        let saved = session_message::Entity::find_by_id(row.id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.status, "in_flight");
    }

    #[tokio::test]
    async fn restart_interrupts_only_claimed_messages() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/session-messages-restart").await;
        let sender = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let recipient = seed_conversation(&db, folder, AgentType::Codex).await;
        enqueue(
            &db.conn,
            sender,
            recipient,
            "first".into(),
            "queue".into(),
            false,
        )
        .await
        .unwrap();
        enqueue(
            &db.conn,
            sender,
            recipient,
            "second".into(),
            "queue".into(),
            false,
        )
        .await
        .unwrap();
        let first = queued(&db.conn).await.unwrap().remove(0);
        claim(&db.conn, &first).await.unwrap();
        interrupt_in_flight(&db.conn).await.unwrap();
        let saved = session_message::Entity::find_by_id(first.id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.status, "interrupted");
        assert_eq!(queued(&db.conn).await.unwrap().len(), 1);
    }
}
