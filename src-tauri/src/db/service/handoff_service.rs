//! Persistence for in-place agent handoffs (`acp::handoff`).
//!
//! A conversation row names only its current agent and session; these rows
//! are the chain of earlier segments. Append-only: a handoff is history the
//! moment it happens, and nothing edits it afterwards.

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, Set,
};

use crate::db::entities::conversation_handoff;
use crate::db::error::DbError;
use crate::models::AgentType;

/// Everything a handoff record needs. `seq` is assigned here, never by the
/// caller, so two records can never claim the same slot.
#[derive(Debug, Clone)]
pub struct NewHandoff {
    pub conversation_id: i32,
    pub from_agent_type: AgentType,
    pub from_external_id: Option<String>,
    pub to_agent_type: AgentType,
    pub to_external_id: String,
    /// `acp::handoff::HandoffPath::as_str()`.
    pub path: &'static str,
    pub carried: bool,
    pub user_turns_before: u32,
    pub note: Option<String>,
    pub briefing: Option<String>,
    pub truncated: bool,
    pub from_account_id: Option<String>,
    pub to_account_id: Option<String>,
    pub history_json: Option<String>,
    pub context_id: Option<String>,
    pub context_pending: bool,
    pub source_stats_json: Option<String>,
    pub source_model: Option<String>,
}

/// Append one handoff to the conversation's chain and return the stored row.
pub async fn record(
    conn: &impl sea_orm::ConnectionTrait,
    new: NewHandoff,
) -> Result<conversation_handoff::Model, DbError> {
    let seq = conversation_handoff::Entity::find()
        .filter(conversation_handoff::Column::ConversationId.eq(new.conversation_id))
        .order_by_desc(conversation_handoff::Column::Seq)
        .one(conn)
        .await?
        .map(|last| last.seq + 1)
        .unwrap_or(0);
    let row = conversation_handoff::ActiveModel {
        id: NotSet,
        conversation_id: Set(new.conversation_id),
        seq: Set(seq),
        from_agent_type: Set(new.from_agent_type.as_wire().into_owned()),
        from_external_id: Set(new.from_external_id),
        to_agent_type: Set(new.to_agent_type.as_wire().into_owned()),
        to_external_id: Set(new.to_external_id),
        path: Set(new.path.to_string()),
        carried: Set(new.carried),
        user_turns_before: Set(i32::try_from(new.user_turns_before).unwrap_or(i32::MAX)),
        note: Set(new.note),
        briefing: Set(new.briefing),
        truncated: Set(new.truncated),
        created_at: Set(Utc::now()),
        from_account_id: Set(new.from_account_id),
        to_account_id: Set(new.to_account_id),
        history_json: Set(new.history_json),
        context_id: Set(new.context_id),
        context_pending: Set(new.context_pending),
        source_stats_json: Set(new.source_stats_json),
        source_model: Set(new.source_model),
    };
    Ok(row.insert(conn).await?)
}

/// The conversation's handoff chain, oldest first. Empty for a conversation
/// that never changed agents, which is the overwhelmingly common answer.
pub async fn list_for_conversation(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Vec<conversation_handoff::Model>, DbError> {
    Ok(conversation_handoff::Entity::find()
        .filter(conversation_handoff::Column::ConversationId.eq(conversation_id))
        .order_by_asc(conversation_handoff::Column::Seq)
        .all(conn)
        .await?)
}

pub async fn native_turns(
    conn: &DatabaseConnection,
    agent: AgentType,
    session: &str,
    account_id: Option<&str>,
) -> Result<Vec<crate::models::MessageTurn>, DbError> {
    let home = match account_id {
        Some(id) => {
            let account = super::agent_account_service::get(conn, id).await?;
            if account.agent_type != agent.as_wire() {
                return Err(DbError::Validation(
                    "The saved account belongs to a different agent.".into(),
                ));
            }
            Some(std::path::PathBuf::from(account.home_dir))
        }
        None => None,
    };
    let env = super::agent_setting_service::load_agent_env(conn, agent).await;
    let session = session.to_string();
    tokio::task::spawn_blocking(move || {
        crate::parsers::build_account_parser(agent, home.as_deref(), &env)
            .and_then(|p| p.get_conversation(&session))
            .map(|d| d.turns)
            .map_err(|_| DbError::Validation("The saved conversation could not be read. Restore its history before switching agents.".into()))
    }).await.map_err(|e| DbError::Validation(e.to_string()))?
}

/// New handoffs own a durable snapshot. Older development builds retain their
/// original account-aware read, and fail visibly if its history is missing.
pub async fn read_segment(
    conn: &DatabaseConnection,
    row: &conversation_handoff::Model,
) -> Result<Vec<crate::models::MessageTurn>, DbError> {
    if row.carried {
        return Ok(Vec::new());
    }
    if let Some(json) = &row.history_json {
        return serde_json::from_str(json)
            .map_err(|_| DbError::Validation("Saved handoff history could not be read.".into()));
    }
    let agent = AgentType::from_wire(&row.from_agent_type)
        .ok_or_else(|| DbError::Validation("Unknown source agent in saved history.".into()))?;
    let session = row
        .from_external_id
        .as_deref()
        .ok_or_else(|| DbError::Validation("Saved history has no session.".into()))?;
    native_turns(conn, agent, session, row.from_account_id.as_deref()).await
}

/// Commit the new binding AND its saved history together. A later edit, deleted
/// conversation, removed account or active child refuses the whole transaction.
pub async fn commit(
    conn: &DatabaseConnection,
    expected: &crate::models::DbConversationSummary,
    new: NewHandoff,
) -> Result<(), DbError> {
    use sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};
    let txn = conn.begin().await?;
    let result = txn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
        "UPDATE conversation SET agent_type = ?, agent_account_id = ?, external_id = ?, model = NULL, title_locked = 1, updated_at = ? \
         WHERE id = ? AND agent_type = ? AND agent_account_id IS ? AND external_id IS ? \
         AND folder_id = ? AND origin_cwd IS ? AND deleted_at IS NULL AND parent_id IS NULL \
         AND NOT EXISTS (SELECT 1 FROM conversation child WHERE child.parent_id = conversation.id AND child.status = 'in_progress') \
         AND (? IS NULL OR EXISTS (SELECT 1 FROM agent_account WHERE id = ? AND removed = 0 AND agent_type = ?))",
        vec![new.to_agent_type.as_wire().into_owned().into(), new.to_account_id.clone().into(), new.to_external_id.clone().into(), Utc::now().into(),
            expected.id.into(), expected.agent_type.as_wire().into_owned().into(), expected.agent_account_id.clone().into(), expected.external_id.clone().into(),
            expected.folder_id.into(), expected.origin_cwd.clone().into(), new.to_account_id.clone().into(), new.to_account_id.clone().into(), new.to_agent_type.as_wire().into_owned().into()]
    )).await?;
    if result.rows_affected() != 1 {
        return Err(DbError::Conflict(
            "The conversation or account changed. Reload and try the switch again.".into(),
        ));
    }
    record(&txn, new).await?;
    txn.commit().await?;
    Ok(())
}

/// A failed first prompt must not strand the target without its context. Keep
/// supplying the saved context until the agent's own transcript contains it.
/// Called under the normal prompt lock, so retries use the same send boundary.
pub async fn pending_context(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Option<String>, DbError> {
    let current = super::conversation_service::get_by_id(conn, conversation_id).await?;
    let rows = list_for_conversation(conn, conversation_id).await?;
    let Some(row) = rows.last().cloned() else {
        return Ok(None);
    };
    if row.to_agent_type != current.agent_type.as_wire()
        || Some(row.to_external_id.as_str()) != current.external_id.as_deref()
    {
        return Ok(None);
    }
    if !row.context_pending {
        return Ok(None);
    }
    restore_archive(conn, &row).await?;
    let Some(briefing) = row.briefing.clone() else {
        return Ok(None);
    };
    let written = native_turns(
        conn,
        current.agent_type,
        &row.to_external_id,
        current.agent_account_id.as_deref(),
    )
    .await
    .is_ok_and(|turns| {
        turns
            .iter()
            .filter(|t| matches!(t.role, crate::models::TurnRole::User))
            .any(|t| {
                t.blocks.iter().any(|b| matches!(b,
            crate::models::ContentBlock::Text { text } if row.context_id.as_deref().map_or_else(
                || text.contains(&briefing),
                |id| text.contains(&format!("[codeg-context:{id}]")),
            )))
            })
    });
    if written {
        let mut active: conversation_handoff::ActiveModel = row.into();
        active.context_pending = Set(false);
        active.update(conn).await?;
        return Ok(None);
    }
    Ok(Some(briefing))
}

/// Restore a disposable context copy without changing its identity, delivery
/// state or original seed. Old prompts keep rendering correctly after restart.
async fn restore_archive(
    conn: &DatabaseConnection,
    row: &conversation_handoff::Model,
) -> Result<(), DbError> {
    use crate::acp::handoff::{self, HandoffLink};
    let Some(id) = row.context_id.as_deref() else {
        return Ok(());
    };
    let target = crate::acp::handoff_context::context_directory(id)?;
    if target.join("conversation.md").is_file() {
        return Ok(());
    }
    let rows = list_for_conversation(conn, row.conversation_id).await?;
    let mut segments = Vec::new();
    for prior in rows.iter().filter(|r| r.seq < row.seq) {
        segments.push(read_segment(conn, prior).await?);
    }
    let last = read_segment(conn, row).await?;
    let links: Vec<_> = rows
        .iter()
        .filter(|r| r.seq < row.seq)
        .filter_map(HandoffLink::from_row)
        .collect();
    let turns = handoff::splice_handoffs(&links, segments, last);
    let source = row.from_agent_type.clone();
    let next = row.to_agent_type.clone();
    let note = row.note.clone();
    tokio::task::spawn_blocking(move || -> Result<(), DbError> {
        let mut archive = crate::acp::handoff_context::write_archive(
            &crate::paths::codeg_conversation_context_root(),
            &turns,
            &source,
            &next,
            note.as_deref(),
        )?;
        if target.symlink_metadata().is_ok() {
            // Preserve an incomplete existing copy for recovery. All paths are
            // UUID children of the managed context root, never transcript input.
            let backup = target.with_extension(format!("recovery-{}", uuid::Uuid::new_v4()));
            std::fs::rename(&target, backup)?;
        }
        std::fs::rename(&archive.directory, &target)?;
        archive.directory = target;
        archive.persist();
        Ok(())
    })
    .await
    .map_err(|e| DbError::Validation(e.to_string()))?
}

pub async fn context_for_conversation(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<String>, DbError> {
    let row = conversation_handoff::Entity::find()
        .filter(conversation_handoff::Column::ConversationId.eq(id))
        .filter(conversation_handoff::Column::ContextId.is_not_null())
        .order_by_desc(conversation_handoff::Column::Seq)
        .one(conn)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    restore_archive(conn, &row).await?;
    Ok(row.context_id)
}

pub async fn context_for_binding(
    conn: &DatabaseConnection,
    agent: AgentType,
    session: &str,
    account: Option<&str>,
) -> Result<Option<String>, DbError> {
    use crate::db::entities::conversation;
    let row = conversation::Entity::find()
        .filter(conversation::Column::AgentType.eq(agent.as_wire().into_owned()))
        .filter(conversation::Column::ExternalId.eq(session))
        .filter(super::conversation_service::account_condition(account))
        .filter(conversation::Column::DeletedAt.is_null())
        .one(conn)
        .await?;
    match row {
        Some(row) => context_for_conversation(conn, row.id).await,
        None => Ok(None),
    }
}

/// Imported copies of a handed-off session remain owned by the same logical
/// conversation. Compare saved content, not a timestamp or id alone: later,
/// independent work in the old CLI session must still be importable.
pub async fn archived_sources(
    conn: &DatabaseConnection,
    scope: Option<&str>,
    candidates: &[(AgentType, crate::models::ConversationSummary)],
) -> Result<std::collections::HashSet<(AgentType, String)>, DbError> {
    use crate::acp::handoff::{clean_seeded_turns, HandoffLink};
    use crate::db::entities::conversation;
    let mut owned = std::collections::HashSet::new();
    if candidates.is_empty() {
        return Ok(owned);
    }
    let rows = conversation_handoff::Entity::find()
        .filter(conversation_handoff::Column::HistoryJson.is_not_null())
        .all(conn)
        .await?;
    for (agent, candidate) in candidates {
        if conversation::Entity::find()
            .filter(conversation::Column::AgentType.eq(agent.as_wire().into_owned()))
            .filter(conversation::Column::ExternalId.eq(&candidate.id))
            .filter(super::conversation_service::account_condition(scope))
            .one(conn)
            .await?
            .is_some()
        {
            continue;
        }
        let matching: Vec<_> = rows
            .iter()
            .filter(|row| {
                row.from_agent_type == agent.as_wire()
                    && row.from_external_id.as_deref() == Some(candidate.id.as_str())
                    && (row.from_account_id.as_deref() == scope || *agent == AgentType::ClaudeCode)
            })
            .collect();
        if matching.is_empty() {
            continue;
        }
        let Ok(current) = native_turns(conn, *agent, &candidate.id, scope).await else {
            continue;
        };
        for row in matching {
            if conversation::Entity::find_by_id(row.conversation_id)
                .one(conn)
                .await?
                .is_none()
            {
                continue;
            }
            let Some(archived) = row
                .history_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<crate::models::MessageTurn>>(s).ok())
            else {
                continue;
            };
            let links: Vec<_> = list_for_conversation(conn, row.conversation_id)
                .await?
                .iter()
                .filter_map(HandoffLink::from_row)
                .collect();
            let current = clean_seeded_turns(current.clone(), &links);
            let prefix = !current.is_empty()
                && current.len() <= archived.len()
                && current.iter().zip(&archived).all(|(a, b)| {
                    serde_json::to_value((&a.role, &a.blocks)).ok()
                        == serde_json::to_value((&b.role, &b.blocks)).ok()
                });
            if prefix {
                owned.insert((*agent, candidate.id.clone()));
                break;
            }
        }
    }
    Ok(owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use sea_orm::ConnectionTrait;

    fn new_handoff(conversation_id: i32, to: AgentType, to_ext: &str) -> NewHandoff {
        NewHandoff {
            conversation_id,
            from_agent_type: AgentType::ClaudeCode,
            from_external_id: Some("S1".into()),
            to_agent_type: to,
            to_external_id: to_ext.into(),
            path: "summary",
            carried: false,
            user_turns_before: 3,
            note: Some("finish the tests".into()),
            briefing: Some("briefing".into()),
            truncated: false,
            from_account_id: None,
            to_account_id: None,
            history_json: None,
            context_id: None,
            context_pending: false,
            source_stats_json: None,
            source_model: None,
        }
    }

    #[tokio::test]
    async fn commit_keeps_history_and_binding_atomic_and_refuses_a_stale_source() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/handoff-atomic").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let source = super::super::conversation_service::get_by_id(&db.conn, id)
            .await
            .unwrap();
        let mut change = new_handoff(id, AgentType::Codex, "target-session");
        change.history_json = Some("[]".into());
        commit(&db.conn, &source, change).await.unwrap();
        let current = super::super::conversation_service::get_by_id(&db.conn, id)
            .await
            .unwrap();
        assert_eq!(current.agent_type, AgentType::Codex);
        assert_eq!(current.title, source.title);
        assert!(current.title_locked);
        assert_eq!(current.agent_account_id, None);
        assert_eq!(list_for_conversation(&db.conn, id).await.unwrap().len(), 1);
        assert!(commit(
            &db.conn,
            &source,
            new_handoff(id, AgentType::Grok, "other-session")
        )
        .await
        .is_err());
        assert_eq!(list_for_conversation(&db.conn, id).await.unwrap().len(), 1);
        // Failure while recording history must roll the preceding UPDATE back.
        db.conn.execute_unprepared("CREATE TRIGGER reject_handoff BEFORE INSERT ON conversation_handoff BEGIN SELECT RAISE(ABORT, 'fixture'); END").await.unwrap();
        assert!(commit(
            &db.conn,
            &current,
            new_handoff(id, AgentType::Grok, "other-session")
        )
        .await
        .is_err());
        let kept = super::super::conversation_service::get_by_id(&db.conn, id)
            .await
            .unwrap();
        assert_eq!(kept.external_id, current.external_id);
        assert_eq!(kept.agent_type, AgentType::Codex);
    }

    #[tokio::test]
    async fn records_append_in_seq_order_per_conversation() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-handoff-seq").await;
        let a = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let b = seed_conversation(&db, folder, AgentType::ClaudeCode).await;

        let first = record(&db.conn, new_handoff(a, AgentType::Codex, "S2"))
            .await
            .expect("first");
        let second = record(&db.conn, new_handoff(a, AgentType::Grok, "S3"))
            .await
            .expect("second");
        // A second conversation starts its own chain at 0.
        let other = record(&db.conn, new_handoff(b, AgentType::Codex, "S9"))
            .await
            .expect("other");

        assert_eq!(first.seq, 0);
        assert_eq!(second.seq, 1);
        assert_eq!(other.seq, 0);

        let chain = list_for_conversation(&db.conn, a).await.expect("list");
        assert_eq!(
            chain
                .iter()
                .map(|h| h.to_external_id.as_str())
                .collect::<Vec<_>>(),
            vec!["S2", "S3"]
        );
        assert_eq!(chain[0].from_agent_type, "claude_code");
        assert_eq!(chain[0].to_agent_type, "codex");
        assert_eq!(chain[0].note.as_deref(), Some("finish the tests"));
        assert_eq!(chain[0].user_turns_before, 3);
        assert!(!chain[0].carried);

        assert!(list_for_conversation(&db.conn, 999_999)
            .await
            .expect("unknown")
            .is_empty());
    }

    #[tokio::test]
    async fn custom_agents_round_trip_their_wire_form() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-handoff-wire").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let mut new = new_handoff(id, AgentType::custom("claude-code-2").unwrap(), "S1");
        new.carried = true;
        new.path = "native";
        let row = record(&db.conn, new).await.expect("record");
        assert_eq!(row.to_agent_type, "custom:claude-code-2");
        assert_eq!(
            AgentType::from_wire(&row.to_agent_type),
            Some(AgentType::custom("claude-code-2").unwrap())
        );
        assert!(row.carried);
        assert_eq!(row.path, "native");
    }
}
