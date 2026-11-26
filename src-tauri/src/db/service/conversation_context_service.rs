use crate::db::entities::{conversation, conversation_context};
use crate::db::error::DbError;
use chrono::{DateTime, Utc};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    QueryFilter, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};

pub const BRIEF_MAX_CHARS: usize = 12_000;
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefEdit {
    pub old_text: String,
    pub new_text: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum BriefOperation {
    Read,
    Write { text: String },
    Edit { edits: Vec<BriefEdit> },
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrief {
    pub text: String,
    pub updated_at: Option<DateTime<Utc>>,
}

async fn ensure_live<C: ConnectionTrait>(db: &C, id: i32) -> Result<(), DbError> {
    if conversation::Entity::find_by_id(id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(db)
        .await?
        .is_none()
    {
        return Err(DbError::NotFound(format!("Conversation {id}")));
    }
    Ok(())
}

// Acquire SQLite's writer lock before reading the document. This also serializes
// edits with deletion; a deferred read-then-write transaction can lose that race.
pub(crate) async fn lock_context(
    db: &DatabaseConnection,
    id: i32,
) -> Result<DatabaseTransaction, DbError> {
    let txn = db.begin().await?;
    let locked = conversation::Entity::update_many()
        .col_expr(
            conversation::Column::Id,
            Expr::col(conversation::Column::Id).into(),
        )
        .filter(conversation::Column::Id.eq(id))
        .filter(conversation::Column::DeletedAt.is_null())
        .exec(&txn)
        .await?;
    if locked.rows_affected != 1 {
        return Err(DbError::NotFound(format!("Conversation {id}")));
    }
    conversation_context::Entity::insert(conversation_context::ActiveModel {
        conversation_id: Set(id),
        brief: Set(String::new()),
        brief_updated_at: Set(None),
        digest: Set(None),
        dismissed_suggestions: Set("[]".into()),
    })
    .on_conflict(
        OnConflict::column(conversation_context::Column::ConversationId)
            .do_nothing()
            .to_owned(),
    )
    .do_nothing()
    .exec(&txn)
    .await?;
    Ok(txn)
}

pub async fn read_brief(db: &DatabaseConnection, id: i32) -> Result<SessionBrief, DbError> {
    ensure_live(db, id).await?;
    let row = conversation_context::Entity::find_by_id(id).one(db).await?;
    Ok(SessionBrief {
        text: row.as_ref().map(|r| r.brief.clone()).unwrap_or_default(),
        updated_at: row.and_then(|r| r.brief_updated_at),
    })
}

pub async fn update_brief(
    db: &DatabaseConnection,
    id: i32,
    operation: BriefOperation,
) -> Result<SessionBrief, DbError> {
    if matches!(operation, BriefOperation::Read) {
        return read_brief(db, id).await;
    }
    let txn = lock_context(db, id).await?;
    let row = conversation_context::Entity::find_by_id(id)
        .one(&txn)
        .await?
        .ok_or_else(|| DbError::NotFound("Session context".into()))?;
    let text = match operation {
        BriefOperation::Read => unreachable!(),
        BriefOperation::Write { text } => text,
        BriefOperation::Edit { edits } => {
            if edits.is_empty() {
                return Err(DbError::Validation("edits must not be empty".into()));
            }
            let mut text = row.brief;
            for edit in edits {
                if edit.old_text.is_empty()
                    || text
                        .as_bytes()
                        .windows(edit.old_text.len())
                        .filter(|part| *part == edit.old_text.as_bytes())
                        .count()
                        != 1
                {
                    return Err(DbError::Validation(
                        "Each oldText must match exactly once".into(),
                    ));
                }
                text = text.replacen(&edit.old_text, &edit.new_text, 1);
            }
            text
        }
    };
    if text.chars().count() > BRIEF_MAX_CHARS {
        return Err(DbError::Validation("brief exceeds 12000 characters".into()));
    }
    let now = Utc::now();
    conversation_context::Entity::update_many()
        .col_expr(
            conversation_context::Column::Brief,
            Expr::value(text.clone()),
        )
        .col_expr(
            conversation_context::Column::BriefUpdatedAt,
            Expr::value(now),
        )
        .filter(conversation_context::Column::ConversationId.eq(id))
        .exec(&txn)
        .await?;
    txn.commit().await?;
    Ok(SessionBrief {
        text,
        updated_at: Some(now),
    })
}

pub fn delegation_brief(
    parent_id: i32,
    text: &str,
    assistant_brief: Option<String>,
) -> Option<String> {
    if text.is_empty() {
        return assistant_brief;
    }
    let shared = format!("<codeg_session_brief source_conversation_id=\"{parent_id}\">\n{text}\n</codeg_session_brief>");
    Some(match assistant_brief {
        Some(assistant) => format!("{assistant}\n\n{shared}"),
        None => shared,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;

    #[tokio::test]
    async fn brief_edits_are_atomic_and_require_exactly_one_match() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/context").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        update_brief(
            &db.conn,
            id,
            BriefOperation::Write {
                text: "one two two".into(),
            },
        )
        .await
        .unwrap();
        let edits = vec![
            BriefEdit {
                old_text: "one".into(),
                new_text: "changed".into(),
            },
            BriefEdit {
                old_text: "two".into(),
                new_text: "bad".into(),
            },
        ];
        assert!(update_brief(&db.conn, id, BriefOperation::Edit { edits })
            .await
            .is_err());
        assert_eq!(read_brief(&db.conn, id).await.unwrap().text, "one two two");
        assert!(update_brief(
            &db.conn,
            id,
            BriefOperation::Edit {
                edits: vec![BriefEdit {
                    old_text: "missing".into(),
                    new_text: "bad".into()
                }]
            }
        )
        .await
        .is_err());
        let result = update_brief(
            &db.conn,
            id,
            BriefOperation::Edit {
                edits: vec![BriefEdit {
                    old_text: "one".into(),
                    new_text: "三".into(),
                }],
            },
        )
        .await
        .unwrap();
        assert_eq!(result.text, "三 two two");
    }

    #[tokio::test]
    async fn brief_limit_counts_characters_and_delete_clears_context() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/context-limit").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        update_brief(
            &db.conn,
            id,
            BriefOperation::Write {
                text: "字".repeat(12_000),
            },
        )
        .await
        .unwrap();
        assert!(update_brief(
            &db.conn,
            id,
            BriefOperation::Write {
                text: "字".repeat(12_001)
            }
        )
        .await
        .is_err());
        crate::db::service::conversation_service::update_status(
            &db.conn,
            id,
            crate::db::entities::conversation::ConversationStatus::Completed,
        )
        .await
        .unwrap();
        assert_eq!(
            read_brief(&db.conn, id).await.unwrap().text.chars().count(),
            12_000
        );
        crate::db::service::conversation_service::soft_delete(&db.conn, id)
            .await
            .unwrap();
        assert!(conversation_context::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .is_none());
        assert!(update_brief(
            &db.conn,
            id,
            BriefOperation::Write {
                text: "revive".into()
            }
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn overlapping_matches_are_ambiguous() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/context-overlap").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        update_brief(&db.conn, id, BriefOperation::Write { text: "aaa".into() })
            .await
            .unwrap();
        assert!(update_brief(
            &db.conn,
            id,
            BriefOperation::Edit {
                edits: vec![BriefEdit {
                    old_text: "aa".into(),
                    new_text: "x".into()
                }]
            }
        )
        .await
        .is_err());
    }

    #[test]
    fn delegation_keeps_assistant_instructions_and_shared_context() {
        let brief = delegation_brief(12, "goal", Some("assistant instructions".into())).unwrap();
        assert!(brief.starts_with("assistant instructions"));
        assert!(brief.contains("source_conversation_id=\"12\""));
        assert!(brief.contains("goal"));
    }

    #[tokio::test]
    async fn concurrent_brief_edits_preserve_both_updates() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/context-serial").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        update_brief(
            &db.conn,
            id,
            BriefOperation::Write {
                text: "alpha beta".into(),
            },
        )
        .await
        .unwrap();
        let a = BriefOperation::Edit {
            edits: vec![BriefEdit {
                old_text: "alpha".into(),
                new_text: "A".into(),
            }],
        };
        let b = BriefOperation::Edit {
            edits: vec![BriefEdit {
                old_text: "beta".into(),
                new_text: "B".into(),
            }],
        };
        let (a, b) = tokio::join!(update_brief(&db.conn, id, a), update_brief(&db.conn, id, b));
        a.unwrap();
        b.unwrap();
        assert_eq!(read_brief(&db.conn, id).await.unwrap().text, "A B");
    }
}
