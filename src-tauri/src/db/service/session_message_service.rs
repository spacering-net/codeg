//! Durable messages between existing conversations. Management is scoped to the authenticated sender.
use crate::db::{
    entities::{
        conversation,
        session_message::{self, Column, Entity, Model},
    },
    error::DbError,
};
use chrono::Utc;
use sea_orm::sea_query::{Alias, Expr, Query};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

async fn validate(conn: &DatabaseConnection, sender: i32, recipient: i32) -> Result<(), DbError> {
    if sender <= 0 || recipient <= 0 || sender == recipient {
        return Err(DbError::Validation(
            "distinct positive conversation IDs are required".into(),
        ));
    }
    let live = conversation::Entity::find()
        .filter(conversation::Column::Id.is_in([sender, recipient]))
        .filter(conversation::Column::DeletedAt.is_null())
        .all(conn)
        .await?;
    if live.len() != 2 {
        return Err(DbError::NotFound("session".into()));
    }
    Ok(())
}
fn scoped(sender: i32, recipient: i32) -> sea_orm::Select<Entity> {
    Entity::find()
        .filter(Column::SenderConversationId.eq(sender))
        .filter(Column::ConversationId.eq(recipient))
}
pub async fn enqueue(
    conn: &DatabaseConnection,
    sender: i32,
    recipient: i32,
    message: &str,
    delivery: &str,
) -> Result<Model, DbError> {
    validate(conn, sender, recipient).await?;
    if !matches!(delivery, "queue" | "immediate") {
        return Err(DbError::Validation("invalid delivery".into()));
    }
    if message.trim().is_empty() {
        return Err(DbError::Validation("message is empty".into()));
    }
    let now = Utc::now();
    Ok(session_message::ActiveModel {
        message_id: Set(uuid::Uuid::new_v4().to_string()),
        sender_conversation_id: Set(sender),
        conversation_id: Set(recipient),
        message: Set(message.into()),
        delivery: Set(delivery.into()),
        status: Set("queued".into()),
        owner_pid: Set(None),
        result: Set(None),
        error: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(conn)
    .await?)
}
pub async fn list(
    conn: &DatabaseConnection,
    sender: i32,
    recipient: i32,
) -> Result<Vec<Model>, DbError> {
    validate(conn, sender, recipient).await?;
    Ok(scoped(sender, recipient)
        .order_by_asc(Column::Id)
        .all(conn)
        .await?)
}
pub async fn get(
    conn: &DatabaseConnection,
    sender: i32,
    recipient: i32,
    message_id: &str,
) -> Result<Option<Model>, DbError> {
    validate(conn, sender, recipient).await?;
    Ok(scoped(sender, recipient)
        .filter(Column::MessageId.eq(message_id))
        .one(conn)
        .await?)
}
pub async fn next_queued(
    conn: &DatabaseConnection,
    recipient: i32,
) -> Result<Option<Model>, DbError> {
    Ok(Entity::find()
        .filter(Column::ConversationId.eq(recipient))
        .filter(Column::Status.eq("queued"))
        .filter(
            Column::SenderConversationId.in_subquery(
                Query::select()
                    .column(conversation::Column::Id)
                    .from(conversation::Entity)
                    .and_where(Expr::col(conversation::Column::DeletedAt).is_null())
                    .to_owned(),
            ),
        )
        .order_by_asc(Column::Delivery)
        .order_by_asc(Column::Id)
        .one(conn)
        .await?)
}
pub async fn update_queued(
    conn: &DatabaseConnection,
    sender: i32,
    recipient: i32,
    message_id: &str,
    message: &str,
) -> Result<Option<Model>, DbError> {
    validate(conn, sender, recipient).await?;
    if message.trim().is_empty() {
        return Err(DbError::Validation("message is empty".into()));
    }
    let changed = Entity::update_many()
        .col_expr(Column::Message, Expr::value(message))
        .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(Column::SenderConversationId.eq(sender))
        .filter(Column::ConversationId.eq(recipient))
        .filter(Column::MessageId.eq(message_id))
        .filter(Column::Status.eq("queued"))
        .exec(conn)
        .await?
        .rows_affected;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, sender, recipient, message_id).await
}
pub async fn cancel_queued(
    conn: &DatabaseConnection,
    sender: i32,
    recipient: i32,
    message_id: &str,
) -> Result<Option<Model>, DbError> {
    validate(conn, sender, recipient).await?;
    let changed = Entity::update_many()
        .col_expr(Column::Status, Expr::value("canceled"))
        .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(Column::SenderConversationId.eq(sender))
        .filter(Column::ConversationId.eq(recipient))
        .filter(Column::MessageId.eq(message_id))
        .filter(Column::Status.eq("queued"))
        .exec(conn)
        .await?
        .rows_affected;
    if changed == 0 {
        return Ok(None);
    }
    get(conn, sender, recipient, message_id).await
}
async fn validate_message(conn: &DatabaseConnection, message_id: &str) -> Result<bool, DbError> {
    let Some(row) = Entity::find()
        .filter(Column::MessageId.eq(message_id))
        .one(conn)
        .await?
    else {
        return Ok(false);
    };
    validate(conn, row.sender_conversation_id, row.conversation_id).await?;
    Ok(true)
}
async fn claim_as(
    conn: &DatabaseConnection,
    message_id: &str,
    status: &str,
) -> Result<bool, DbError> {
    if !validate_message(conn, message_id).await? {
        return Ok(false);
    }
    let mut eligible = sea_orm::Condition::any().add(Column::Status.eq("queued"));
    if status == "running" {
        eligible = eligible.add(
            sea_orm::Condition::all()
                .add(Column::Status.eq("dispatching"))
                .add(Column::OwnerPid.eq(i64::from(std::process::id()))),
        );
    }
    // Correlated NOT EXISTS executes in the same write as the claim, so a
    // different process cannot reserve steering between an ownership read and write.
    let other = Alias::new("other_message");
    let foreign_active = Query::select()
        .expr(Expr::value(1))
        .from_as(Entity, other.clone())
        .and_where(
            Expr::col((other.clone(), Column::ConversationId))
                .equals((Entity, Column::ConversationId)),
        )
        .and_where(Expr::col((other.clone(), Column::Status)).is_in(["running", "dispatching"]))
        .cond_where(
            sea_orm::Condition::any()
                .add(Expr::col((other.clone(), Column::OwnerPid)).ne(i64::from(std::process::id())))
                .add(Expr::col((other, Column::OwnerPid)).is_null()),
        )
        .to_owned();
    let result = Entity::update_many()
        .col_expr(Column::Status, Expr::value(status))
        .col_expr(Column::OwnerPid, Expr::value(i64::from(std::process::id())))
        .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(Column::MessageId.eq(message_id))
        .filter(eligible)
        .filter(
            sea_orm::Condition::all()
                .not()
                .add(Expr::exists(foreign_active)),
        )
        .exec(conn)
        .await;
    match result {
        Ok(result) => Ok(result.rows_affected == 1),
        Err(e)
            if matches!(
                e.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
}
/// Internal runtime claim; the unique index prevents two runtimes executing one recipient.
pub async fn claim(conn: &DatabaseConnection, message_id: &str) -> Result<bool, DbError> {
    claim_as(conn, message_id, "running").await
}

/// The ACP send gate rejected the prompt before dispatch; let the next idle
/// turn claim it again instead of treating a competing prompt as a failure.
pub async fn release_claim(conn: &DatabaseConnection, message_id: &str) -> Result<(), DbError> {
    Entity::update_many()
        .col_expr(Column::Status, Expr::value("queued"))
        .col_expr(Column::OwnerPid, Expr::value(Option::<i64>::None))
        .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(Column::MessageId.eq(message_id))
        .filter(Column::Status.eq("running"))
        .filter(Column::OwnerPid.eq(i64::from(std::process::id())))
        .exec(conn)
        .await?;
    Ok(())
}
/// Reserve an immediate steering note while the recipient's existing turn keeps running.
pub async fn claim_delivery(conn: &DatabaseConnection, message_id: &str) -> Result<bool, DbError> {
    claim_as(conn, message_id, "dispatching").await
}
pub async fn finish(
    conn: &DatabaseConnection,
    message_id: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<bool, DbError> {
    if Entity::find()
        .filter(Column::MessageId.eq(message_id))
        .one(conn)
        .await?
        .is_none()
    {
        return Ok(false);
    }
    if !matches!(
        status,
        "delivered" | "completed" | "failed" | "canceled" | "interrupted"
    ) {
        return Err(DbError::Validation("invalid terminal status".into()));
    }
    Ok(Entity::update_many()
        .col_expr(Column::Status, Expr::value(status))
        .col_expr(Column::Result, Expr::value(result.map(str::to_owned)))
        .col_expr(Column::Error, Expr::value(error.map(str::to_owned)))
        .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(Column::MessageId.eq(message_id))
        .filter(Column::OwnerPid.eq(i64::from(std::process::id())))
        .filter(Column::Status.is_in(["running", "dispatching"]))
        .exec(conn)
        .await?
        .rows_affected
        == 1)
}
/// Recover only rows whose claiming process is demonstrably dead.
pub async fn recover_interrupted(
    conn: &DatabaseConnection,
    recipient: i32,
) -> Result<u64, DbError> {
    let rows = Entity::find()
        .filter(Column::ConversationId.eq(recipient))
        .filter(Column::Status.is_in(["running", "dispatching"]))
        .all(conn)
        .await?;
    let mut count = 0;
    for row in rows {
        let Some(pid) = row.owner_pid.and_then(|pid| u32::try_from(pid).ok()) else {
            continue;
        };
        if !crate::cli_run::discovery::pid_is_dead(pid) {
            continue;
        }
        count += Entity::update_many()
            .col_expr(Column::Status, Expr::value("interrupted"))
            .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
            .filter(Column::Id.eq(row.id))
            .filter(Column::OwnerPid.eq(i64::from(pid)))
            .filter(Column::Status.is_in(["running", "dispatching"]))
            .exec(conn)
            .await?
            .rows_affected;
    }
    Ok(count)
}

pub async fn has_active(conn: &DatabaseConnection, recipient: i32) -> Result<bool, DbError> {
    Ok(Entity::find()
        .filter(Column::ConversationId.eq(recipient))
        .filter(Column::Status.is_in(["running", "dispatching"]))
        .one(conn)
        .await?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder},
        AppDatabase,
    };
    use crate::models::agent::AgentType;

    #[tokio::test]
    async fn recovery_and_deleted_senders_do_not_block_other_senders() {
        let (db, sender, recipient, other) = setup().await;
        let first = enqueue(&db.conn, sender, recipient, "old owner", "queue")
            .await
            .unwrap();
        assert!(claim(&db.conn, &first.message_id).await.unwrap());
        Entity::update_many()
            .col_expr(Column::OwnerPid, Expr::value(i64::from(u32::MAX)))
            .filter(Column::Id.eq(first.id))
            .exec(&db.conn)
            .await
            .unwrap();
        let second = enqueue(&db.conn, other, recipient, "next sender", "queue")
            .await
            .unwrap();
        assert_eq!(recover_interrupted(&db.conn, recipient).await.unwrap(), 1);
        assert!(claim(&db.conn, &second.message_id).await.unwrap());
        conversation::Entity::update_many()
            .col_expr(conversation::Column::DeletedAt, Expr::value(Utc::now()))
            .filter(conversation::Column::Id.eq(other))
            .exec(&db.conn)
            .await
            .unwrap();
        assert!(finish(
            &db.conn,
            &second.message_id,
            "completed",
            Some("done"),
            None
        )
        .await
        .unwrap());
        let invalid = enqueue(
            &db.conn,
            sender,
            recipient,
            "deleted queued sender",
            "queue",
        )
        .await
        .unwrap();
        conversation::Entity::update_many()
            .col_expr(conversation::Column::DeletedAt, Expr::value(Utc::now()))
            .filter(conversation::Column::Id.eq(sender))
            .exec(&db.conn)
            .await
            .unwrap();
        assert!(next_queued(&db.conn, recipient).await.unwrap().is_none());
        let folder_id = conversation::Entity::find_by_id(recipient)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap()
            .folder_id;
        let fresh = seed_conversation(&db, folder_id, AgentType::Codex).await;
        let valid = enqueue(&db.conn, fresh, recipient, "valid next sender", "queue")
            .await
            .unwrap();
        assert_eq!(
            next_queued(&db.conn, recipient)
                .await
                .unwrap()
                .unwrap()
                .message_id,
            valid.message_id
        );
        assert_eq!(
            Entity::find_by_id(invalid.id)
                .one(&db.conn)
                .await
                .unwrap()
                .unwrap()
                .status,
            "queued"
        );
    }
    async fn setup() -> (AppDatabase, i32, i32, i32) {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "D:/subsession-test").await;
        let sender = seed_conversation(&db, folder, AgentType::Codex).await;
        let recipient = seed_conversation(&db, folder, AgentType::Codex).await;
        let foreign = seed_conversation(&db, folder, AgentType::Codex).await;
        conversation::Entity::update_many()
            .col_expr(conversation::Column::ParentId, Expr::value(sender))
            .col_expr(conversation::Column::Kind, Expr::value("delegate"))
            .filter(conversation::Column::Id.eq(recipient))
            .exec(&db.conn)
            .await
            .unwrap();
        (db, sender, recipient, foreign)
    }
    #[tokio::test]
    async fn ownership_and_deleted_parents_are_rejected() {
        let (db, sender, recipient, foreign) = setup().await;
        let row = enqueue(&db.conn, sender, recipient, "hello", "queue")
            .await
            .unwrap();
        assert!(list(&db.conn, foreign, recipient).await.unwrap().is_empty());
        assert!(enqueue(&db.conn, sender, foreign, "hello", "queue")
            .await
            .is_ok());
        assert!(get(&db.conn, foreign, recipient, &row.message_id)
            .await
            .unwrap()
            .is_none());
        assert!(
            update_queued(&db.conn, foreign, recipient, &row.message_id, "bad")
                .await
                .unwrap()
                .is_none()
        );
        assert!(cancel_queued(&db.conn, foreign, recipient, &row.message_id)
            .await
            .unwrap()
            .is_none());

        assert_eq!(recover_interrupted(&db.conn, recipient).await.unwrap(), 0);
        conversation::Entity::update_many()
            .col_expr(conversation::Column::DeletedAt, Expr::value(Utc::now()))
            .filter(conversation::Column::Id.eq(sender))
            .exec(&db.conn)
            .await
            .unwrap();
        assert!(list(&db.conn, sender, recipient).await.is_err());
        assert!(claim(&db.conn, &row.message_id).await.is_err());
    }
    #[tokio::test]
    async fn priority_fifo_and_terminal_results_are_durable() {
        let (db, p, c, _) = setup().await;
        let first = enqueue(&db.conn, p, c, "first", "queue").await.unwrap();
        let second = enqueue(&db.conn, p, c, "second", "queue").await.unwrap();
        let immediate = enqueue(&db.conn, p, c, "now", "immediate").await.unwrap();
        assert_eq!(
            next_queued(&db.conn, c).await.unwrap().unwrap().message_id,
            immediate.message_id
        );
        assert!(claim_delivery(&db.conn, &immediate.message_id)
            .await
            .unwrap());
        assert!(finish(
            &db.conn,
            &immediate.message_id,
            "delivered",
            Some("steered"),
            None
        )
        .await
        .unwrap());
        assert_eq!(
            next_queued(&db.conn, c).await.unwrap().unwrap().message_id,
            first.message_id
        );
        assert!(claim(&db.conn, &first.message_id).await.unwrap());
        assert!(finish(
            &db.conn,
            &first.message_id,
            "completed",
            Some("answer"),
            None
        )
        .await
        .unwrap());
        assert!(
            !finish(&db.conn, &first.message_id, "failed", None, Some("late"))
                .await
                .unwrap()
        );
        assert_eq!(
            get(&db.conn, p, c, &first.message_id)
                .await
                .unwrap()
                .unwrap()
                .result
                .as_deref(),
            Some("answer")
        );
        assert_eq!(
            next_queued(&db.conn, c).await.unwrap().unwrap().message_id,
            second.message_id
        );
    }
    #[tokio::test]
    async fn dispatching_reservation_promotes_only_for_its_owner_and_live_owners_survive_recovery()
    {
        let (db, p, c, _) = setup().await;
        let row = enqueue(&db.conn, p, c, "steer", "immediate").await.unwrap();
        assert!(claim_delivery(&db.conn, &row.message_id).await.unwrap());
        assert!(!claim_delivery(&db.conn, &row.message_id).await.unwrap());
        assert!(cancel_queued(&db.conn, p, c, &row.message_id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(recover_interrupted(&db.conn, c).await.unwrap(), 0);
        Entity::update_many()
            .col_expr(Column::OwnerPid, Expr::value(1i64))
            .filter(Column::MessageId.eq(&row.message_id))
            .exec(&db.conn)
            .await
            .unwrap();
        assert!(!claim(&db.conn, &row.message_id).await.unwrap());
        Entity::update_many()
            .col_expr(Column::OwnerPid, Expr::value(i64::from(std::process::id())))
            .filter(Column::MessageId.eq(&row.message_id))
            .exec(&db.conn)
            .await
            .unwrap();
        assert!(claim(&db.conn, &row.message_id).await.unwrap());
        assert_eq!(recover_interrupted(&db.conn, c).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn foreign_runtime_cannot_finish_or_reserve_the_child() {
        let (db, p, c, _) = setup().await;
        let a = enqueue(&db.conn, p, c, "active", "queue").await.unwrap();
        let b = enqueue(&db.conn, p, c, "steer", "immediate").await.unwrap();
        assert!(claim(&db.conn, &a.message_id).await.unwrap());
        Entity::update_many()
            .col_expr(Column::OwnerPid, Expr::value(1i64))
            .filter(Column::MessageId.eq(&a.message_id))
            .exec(&db.conn)
            .await
            .unwrap();
        assert!(
            !finish(&db.conn, &a.message_id, "completed", Some("foreign"), None)
                .await
                .unwrap()
        );
        assert!(!claim_delivery(&db.conn, &b.message_id).await.unwrap());
        assert!(!claim(&db.conn, &b.message_id).await.unwrap());
        assert!(!finish(&db.conn, &b.message_id, "failed", None, None)
            .await
            .unwrap());
        Entity::update_many()
            .col_expr(Column::Status, Expr::value("dispatching"))
            .filter(Column::MessageId.eq(&a.message_id))
            .exec(&db.conn)
            .await
            .unwrap();
        assert!(!claim(&db.conn, &b.message_id).await.unwrap());
        assert!(!claim_delivery(&db.conn, &b.message_id).await.unwrap());
        assert!(!finish(&db.conn, &a.message_id, "delivered", None, None)
            .await
            .unwrap());
        assert_eq!(
            get(&db.conn, p, c, &a.message_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            "dispatching"
        );
    }

    #[tokio::test]
    async fn dispatching_claims_compete_but_allow_same_owner_running() {
        let (db, p, c, _) = setup().await;
        let active = enqueue(&db.conn, p, c, "active", "queue").await.unwrap();
        let a = enqueue(&db.conn, p, c, "a", "immediate").await.unwrap();
        let b = enqueue(&db.conn, p, c, "b", "immediate").await.unwrap();
        assert!(claim(&db.conn, &active.message_id).await.unwrap());
        let (left, right) = tokio::join!(
            claim_delivery(&db.conn, &a.message_id),
            claim_delivery(&db.conn, &b.message_id)
        );
        assert_eq!(usize::from(left.unwrap()) + usize::from(right.unwrap()), 1);
        assert_eq!(
            get(&db.conn, p, c, &active.message_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            "running"
        );
    }

    #[tokio::test]
    async fn claims_compete_and_queue_edits_cannot_touch_claimed_rows() {
        let (db, p, c, _) = setup().await;
        let a = enqueue(&db.conn, p, c, "a", "queue").await.unwrap();
        let b = enqueue(&db.conn, p, c, "b", "queue").await.unwrap();
        let (left, right) = tokio::join!(
            claim(&db.conn, &a.message_id),
            claim(&db.conn, &a.message_id)
        );
        assert_eq!(usize::from(left.unwrap()) + usize::from(right.unwrap()), 1);
        assert!(!claim(&db.conn, &b.message_id).await.unwrap());
        assert!(update_queued(&db.conn, p, c, &a.message_id, "edit")
            .await
            .unwrap()
            .is_none());
        assert!(cancel_queued(&db.conn, p, c, &a.message_id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            update_queued(&db.conn, p, c, &b.message_id, "edited")
                .await
                .unwrap()
                .unwrap()
                .message,
            "edited"
        );
        assert!(cancel_queued(&db.conn, p, c, &b.message_id)
            .await
            .unwrap()
            .is_some());
        assert!(!claim(&db.conn, &b.message_id).await.unwrap());
        assert!(finish(&db.conn, &a.message_id, "interrupted", None, None)
            .await
            .unwrap());
        assert_eq!(
            get(&db.conn, p, c, &a.message_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            "interrupted"
        );
    }
}
