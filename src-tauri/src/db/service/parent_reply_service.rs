//! Persistent, authenticated direct-child reports to a parent's inbox.
use crate::db::{
    entities::{
        conversation,
        parent_reply::{self, Column, Entity, Model},
    },
    error::DbError,
};
use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

pub async fn parent_of(conn: &DatabaseConnection, child: i32) -> Result<i32, DbError> {
    let row = conversation::Entity::find_by_id(child)
        .one(conn)
        .await?
        .filter(|r| r.deleted_at.is_none() && r.kind == conversation::ConversationKind::Delegate)
        .ok_or_else(|| DbError::NotFound("delegated child".into()))?;
    let parent = row
        .parent_id
        .ok_or_else(|| DbError::NotFound("parent".into()))?;
    if conversation::Entity::find_by_id(parent)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .is_none()
    {
        return Err(DbError::NotFound("parent".into()));
    }
    Ok(parent)
}

pub async fn enqueue(
    conn: &DatabaseConnection,
    child: i32,
    message: &str,
) -> Result<Model, DbError> {
    let parent = parent_of(conn, child).await?;
    if message.trim().is_empty() || message.chars().count() > 32_000 {
        return Err(DbError::Validation(
            "message must contain 1 to 32000 characters".into(),
        ));
    }
    let now = Utc::now();
    Ok(parent_reply::ActiveModel {
        message_id: Set(uuid::Uuid::new_v4().to_string()),
        parent_conversation_id: Set(parent),
        child_conversation_id: Set(child),
        message: Set(message.into()),
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

pub async fn next(conn: &DatabaseConnection, parent: i32) -> Result<Option<Model>, DbError> {
    Ok(Entity::find()
        .filter(Column::ParentConversationId.eq(parent))
        .filter(Column::Status.eq("queued"))
        .order_by_asc(Column::Id)
        .one(conn)
        .await?)
}

pub async fn get(conn: &DatabaseConnection, message: &str) -> Result<Option<Model>, DbError> {
    Ok(Entity::find()
        .filter(Column::MessageId.eq(message))
        .one(conn)
        .await?)
}

pub async fn fail_queued(
    conn: &DatabaseConnection,
    message: &str,
    error: &str,
) -> Result<(), DbError> {
    Entity::update_many()
        .col_expr(Column::Status, Expr::value("failed"))
        .col_expr(Column::Error, Expr::value(error))
        .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(Column::MessageId.eq(message))
        .filter(Column::Status.eq("queued"))
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn claim(conn: &DatabaseConnection, row: &Model) -> Result<bool, DbError> {
    if parent_of(conn, row.child_conversation_id).await? != row.parent_conversation_id {
        return Err(DbError::NotFound("parent".into()));
    }
    let result = Entity::update_many()
        .col_expr(Column::Status, Expr::value("running"))
        .col_expr(Column::OwnerPid, Expr::value(i64::from(std::process::id())))
        .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(Column::MessageId.eq(&row.message_id))
        .filter(Column::Status.eq("queued"))
        .exec(conn)
        .await;
    match result {
        Ok(r) => Ok(r.rows_affected == 1),
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

pub async fn finish(
    conn: &DatabaseConnection,
    message: &str,
    status: &str,
    text: Option<&str>,
    error: Option<&str>,
) -> Result<(), DbError> {
    if !matches!(status, "queued" | "completed" | "failed" | "canceled") {
        return Err(DbError::Validation("invalid parent reply status".into()));
    }
    Entity::update_many()
        .col_expr(Column::Status, Expr::value(status))
        .col_expr(Column::Result, Expr::value(text.map(str::to_owned)))
        .col_expr(Column::Error, Expr::value(error.map(str::to_owned)))
        .col_expr(
            Column::OwnerPid,
            Expr::value(if status == "queued" {
                None
            } else {
                Some(i64::from(std::process::id()))
            }),
        )
        .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(Column::MessageId.eq(message))
        .filter(Column::Status.eq("running"))
        .filter(Column::OwnerPid.eq(i64::from(std::process::id())))
        .exec(conn)
        .await?;
    Ok(())
}

pub async fn recover(conn: &DatabaseConnection) -> Result<Vec<i32>, DbError> {
    // An already dispatched prompt must never run again after a restart.
    for row in Entity::find()
        .filter(Column::Status.eq("running"))
        .all(conn)
        .await?
    {
        if row
            .owner_pid
            .and_then(|p| u32::try_from(p).ok())
            .is_some_and(crate::cli_run::discovery::pid_is_dead)
        {
            Entity::update_many()
                .col_expr(Column::Status, Expr::value("interrupted"))
                .col_expr(Column::UpdatedAt, Expr::value(Utc::now()))
                .filter(Column::Id.eq(row.id))
                .filter(Column::Status.eq("running"))
                .filter(Column::OwnerPid.eq(row.owner_pid))
                .exec(conn)
                .await?;
        }
    }
    let mut parents: Vec<i32> = Entity::find()
        .filter(Column::Status.eq("queued"))
        .all(conn)
        .await?
        .into_iter()
        .map(|r| r.parent_conversation_id)
        .collect();
    parents.sort_unstable();
    parents.dedup();
    Ok(parents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;

    #[tokio::test]
    async fn only_live_delegated_children_can_report_and_claims_serialize_siblings() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "D:/parent-reply").await;
        let parent = seed_conversation(&db, folder, AgentType::Codex).await;
        let child = seed_conversation(&db, folder, AgentType::Codex).await;
        assert!(enqueue(&db.conn, child, "cannot spoof a parent")
            .await
            .is_err());
        conversation::Entity::update_many()
            .col_expr(conversation::Column::ParentId, Expr::value(parent))
            .col_expr(conversation::Column::Kind, Expr::value("delegate"))
            .filter(conversation::Column::Id.eq(child))
            .exec(&db.conn)
            .await
            .unwrap();
        let a = enqueue(&db.conn, child, "first").await.unwrap();
        let b = enqueue(&db.conn, child, "second").await.unwrap();
        assert_eq!(
            next(&db.conn, parent).await.unwrap().unwrap().message_id,
            a.message_id
        );
        assert!(claim(&db.conn, &a).await.unwrap());
        assert!(!claim(&db.conn, &a).await.unwrap());
        assert!(!claim(&db.conn, &b).await.unwrap());
        finish(&db.conn, &a.message_id, "completed", Some("received"), None)
            .await
            .unwrap();
        assert!(claim(&db.conn, &b).await.unwrap());
        finish(&db.conn, &b.message_id, "queued", None, None)
            .await
            .unwrap();
        assert_eq!(
            get(&db.conn, &b.message_id).await.unwrap().unwrap().status,
            "queued"
        );
        assert_eq!(recover(&db.conn).await.unwrap(), vec![parent]);
        assert!(claim(&db.conn, &b).await.unwrap());
        Entity::update_many()
            .col_expr(Column::OwnerPid, Expr::value(2_000_000_000i64))
            .filter(Column::Id.eq(b.id))
            .exec(&db.conn)
            .await
            .unwrap();
        recover(&db.conn).await.unwrap();
        assert_eq!(
            get(&db.conn, &b.message_id).await.unwrap().unwrap().status,
            "interrupted"
        );
        assert!(!claim(&db.conn, &b).await.unwrap());
        conversation::Entity::update_many()
            .col_expr(conversation::Column::DeletedAt, Expr::value(Utc::now()))
            .filter(conversation::Column::Id.eq(parent))
            .exec(&db.conn)
            .await
            .unwrap();
        assert!(enqueue(&db.conn, child, "deleted").await.is_err());
    }
}
