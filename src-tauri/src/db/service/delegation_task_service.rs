//! Persistence for the delegation task ledger.
//!
//! A child conversation is a SESSION; a [`DelegationTaskRecord`] is one ROUND
//! of work inside it. `delegate_to_agent` writes the first round,
//! `continue_delegation` appends a successor that shares the child
//! conversation and its ACP session but owns a new task id, parent tool-call
//! id, status and result.
//!
//! Two rules shape this module:
//!   * terminal fields are written once (`finish` only updates a `running`
//!     row), so a successor can never rewrite the round it followed;
//!   * a source has at most one successor, enforced by the partial unique
//!     index installed by the migration and surfaced as [`DbError::Conflict`].
//!
//! [`DelegationTaskRecord`] is the broker's view: it resolves the two values a
//! ledger row may legitimately lack from the child conversation row — the ACP
//! session id (bound asynchronously on `SessionStarted`) and the working
//! directory (the child's folder) — because those are exactly the facts
//! `continue_delegation` must recover without ever guessing.

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

use crate::acp::delegation::types::{
    AssistantRef, DelegationAssistant, DelegationTaskLedger, TaskStatus,
};
use crate::db::entities::delegation_task::{self, Model as DelegationTaskModel};
use crate::db::entities::{conversation, folder};
use crate::db::error::DbError;
use crate::models::{AgentType, AssistantRunSnapshot};

/// A round about to start. `task_id` is minted by the broker; a continue
/// round carries its `source_task_id` and request fingerprint.
#[derive(Debug, Clone)]
pub struct NewDelegationTask {
    pub task_id: String,
    pub source_task_id: Option<String>,
    pub request_hash: Option<String>,
    pub parent_conversation_id: i32,
    pub parent_tool_use_id: Option<String>,
    pub child_conversation_id: i32,
    pub agent_type: AgentType,
    pub external_session_id: Option<String>,
    pub working_dir: Option<String>,
    pub assistant: Option<DelegationAssistant>,
    pub task_preview: Option<String>,
}

/// The one write a terminal round accepts. Applied only while the row is
/// still `running`, which makes every terminal path idempotent and keeps a
/// late duplicate from overwriting a real outcome.
#[derive(Debug, Clone)]
pub struct TerminalUpdate {
    pub status: TaskStatus,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub duration_ms: Option<u64>,
    pub result_preview: Option<String>,
    /// Learned once the child's `SessionStarted` bound it. Never overwrites a
    /// value already on the row.
    pub external_session_id: Option<String>,
}

/// A ledger row as the broker reads it, with the compatibility resolution
/// applied (session id / cwd / assistant snapshot may come from the child
/// conversation row when the ledger column is NULL).
#[derive(Debug, Clone)]
pub struct DelegationTaskRecord {
    pub task_id: String,
    pub source_task_id: Option<String>,
    pub request_hash: Option<String>,
    pub parent_conversation_id: i32,
    pub parent_tool_use_id: Option<String>,
    pub child_conversation_id: i32,
    /// The child row's folder — the continue/resume prompt adopts the row, so
    /// it must name the folder that row lives in.
    pub folder_id: i32,
    pub agent_type: AgentType,
    pub external_session_id: Option<String>,
    pub working_dir: Option<String>,
    pub assistant: Option<DelegationAssistant>,
    pub assistant_ref: Option<AssistantRef>,
    pub task_preview: Option<String>,
    pub status: TaskStatus,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub duration_ms: Option<u64>,
    pub result_preview: Option<String>,
    /// The round that followed this one, when there is one.
    pub successor_task_id: Option<String>,
}

impl DelegationTaskRecord {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled
        )
    }
}

fn status_from_str(raw: &str) -> TaskStatus {
    match raw {
        delegation_task::STATUS_COMPLETED => TaskStatus::Completed,
        delegation_task::STATUS_FAILED => TaskStatus::Failed,
        delegation_task::STATUS_CANCELED => TaskStatus::Canceled,
        delegation_task::STATUS_RUNNING => TaskStatus::Running,
        _ => TaskStatus::Unknown,
    }
}

fn status_to_str(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Completed => delegation_task::STATUS_COMPLETED,
        TaskStatus::Failed => delegation_task::STATUS_FAILED,
        TaskStatus::Canceled => delegation_task::STATUS_CANCELED,
        TaskStatus::Running | TaskStatus::Unknown => delegation_task::STATUS_RUNNING,
    }
}

/// Append a round. A duplicate `source_task_id` is [`DbError::Conflict`] — the
/// caller re-reads the successor and answers idempotently or with
/// `continuation_conflict`.
pub async fn insert(
    conn: &DatabaseConnection,
    task: NewDelegationTask,
) -> Result<DelegationTaskModel, DbError> {
    let now = Utc::now();
    let (assistant_id, assistant_name, assistant_snapshot) = match &task.assistant {
        Some(a) => (
            Some(a.id),
            Some(a.name.clone()),
            Some(serde_json::to_string(&a.run_snapshot()).map_err(|e| {
                DbError::Validation(format!("assistant snapshot: {e}"))
            })?),
        ),
        None => (None, None, None),
    };
    let model = delegation_task::ActiveModel {
        task_id: Set(task.task_id),
        source_task_id: Set(task.source_task_id),
        request_hash: Set(task.request_hash),
        parent_conversation_id: Set(task.parent_conversation_id),
        parent_tool_use_id: Set(task.parent_tool_use_id),
        child_conversation_id: Set(task.child_conversation_id),
        agent_type: Set(serde_json::to_value(task.agent_type)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default()),
        external_session_id: Set(task.external_session_id),
        working_dir: Set(task.working_dir),
        assistant_id: Set(assistant_id),
        assistant_name: Set(assistant_name),
        assistant_snapshot: Set(assistant_snapshot),
        task_preview: Set(task.task_preview),
        status: Set(delegation_task::STATUS_RUNNING.to_string()),
        error_code: Set(None),
        error_message: Set(None),
        duration_ms: Set(None),
        result_preview: Set(None),
        created_at: Set(now),
        finished_at: Set(None),
    };
    model.insert(conn).await.map_err(|e| match unique_violation(&e) {
        true => DbError::Conflict("delegation source already has a successor".to_string()),
        false => DbError::Database(e),
    })
}

fn unique_violation(e: &sea_orm::DbErr) -> bool {
    let text = e.to_string();
    text.contains("UNIQUE constraint failed")
        || text.contains("unique constraint")
        || text.contains("UNIQUE constraint")
}

pub async fn find(
    conn: &DatabaseConnection,
    task_id: &str,
) -> Result<Option<DelegationTaskModel>, DbError> {
    Ok(delegation_task::Entity::find_by_id(task_id.to_string())
        .one(conn)
        .await?)
}

pub async fn find_successor(
    conn: &DatabaseConnection,
    source_task_id: &str,
) -> Result<Option<DelegationTaskModel>, DbError> {
    Ok(delegation_task::Entity::find()
        .filter(delegation_task::Column::SourceTaskId.eq(source_task_id))
        .one(conn)
        .await?)
}

pub async fn list_by_child_conversation(
    conn: &DatabaseConnection,
    child_conversation_id: i32,
) -> Result<Vec<DelegationTaskModel>, DbError> {
    Ok(delegation_task::Entity::find()
        .filter(delegation_task::Column::ChildConversationId.eq(child_conversation_id))
        .order_by_asc(delegation_task::Column::CreatedAt)
        .all(conn)
        .await?)
}

pub async fn list_by_parent_conversation(
    conn: &DatabaseConnection,
    parent_conversation_id: i32,
) -> Result<Vec<DelegationTaskModel>, DbError> {
    Ok(delegation_task::Entity::find()
        .filter(delegation_task::Column::ParentConversationId.eq(parent_conversation_id))
        .order_by_asc(delegation_task::Column::CreatedAt)
        .all(conn)
        .await?)
}

/// Write a round's terminal state. Returns `false` when the row was no longer
/// `running` — a duplicate terminal (or a successor's attempt to touch a
/// finished round) is a no-op, never an overwrite.
pub async fn finish(
    conn: &DatabaseConnection,
    task_id: &str,
    update: TerminalUpdate,
) -> Result<bool, DbError> {
    let Some(row) = find(conn, task_id).await? else {
        return Ok(false);
    };
    if row.status != delegation_task::STATUS_RUNNING {
        return Ok(false);
    }
    let mut active: delegation_task::ActiveModel = row.into();
    active.status = Set(status_to_str(update.status).to_string());
    active.error_code = Set(update.error_code);
    active.error_message = Set(update.error_message);
    active.duration_ms = Set(update.duration_ms.map(|ms| ms as i64));
    active.result_preview = Set(update.result_preview);
    if update.external_session_id.is_some() {
        active.external_session_id = Set(update.external_session_id);
    }
    active.finished_at = Set(Some(Utc::now()));
    let result = delegation_task::Entity::update_many()
        .set(active)
        .filter(delegation_task::Column::TaskId.eq(task_id))
        .filter(delegation_task::Column::Status.eq(delegation_task::STATUS_RUNNING))
        .exec(conn)
        .await?;
    Ok(result.rows_affected > 0)
}

/// Return a finished round to `running` when `resume_delegation` revives the
/// SAME task id. Resume is a continuation of one task, not a successor, so its
/// row is the only one that may leave a terminal state — and only when nothing
/// has followed it (a task with a successor is refused before reaching here).
pub async fn reopen(conn: &DatabaseConnection, task_id: &str) -> Result<bool, DbError> {
    let Some(row) = find(conn, task_id).await? else {
        return Ok(false);
    };
    if find_successor(conn, task_id).await?.is_some() {
        return Ok(false);
    }
    let mut active: delegation_task::ActiveModel = row.into();
    active.status = Set(delegation_task::STATUS_RUNNING.to_string());
    active.error_code = Set(None);
    active.error_message = Set(None);
    active.duration_ms = Set(None);
    active.result_preview = Set(None);
    active.finished_at = Set(None);
    let result = delegation_task::Entity::update_many()
        .set(active)
        .filter(delegation_task::Column::TaskId.eq(task_id))
        .exec(conn)
        .await?;
    Ok(result.rows_affected > 0)
}

/// Drop a continue round that never dispatched a prompt.
///
/// `continue_delegation` appends its successor row before the strict session
/// load (the ledger is what reserves the one-successor slot atomically). A
/// load that fails, a session already driven by someone else, or a spawn that
/// dies would otherwise burn that slot on work nobody ran, and every retry
/// would answer `continuation_conflict` forever. Only a still-`running`,
/// still-childless successor may be dropped: originals and finished rounds are
/// never touched.
pub async fn discard(conn: &DatabaseConnection, task_id: &str) -> Result<bool, DbError> {
    let Some(row) = find(conn, task_id).await? else {
        return Ok(false);
    };
    if row.status != delegation_task::STATUS_RUNNING || row.source_task_id.is_none() {
        return Ok(false);
    }
    if find_successor(conn, task_id).await?.is_some() {
        return Ok(false);
    }
    let result = delegation_task::Entity::delete_many()
        .filter(delegation_task::Column::TaskId.eq(task_id))
        .filter(delegation_task::Column::Status.eq(delegation_task::STATUS_RUNNING))
        .filter(delegation_task::Column::SourceTaskId.is_not_null())
        .exec(conn)
        .await?;
    Ok(result.rows_affected > 0)
}

/// Resolve a ledger row into the broker's view. The child conversation row is
/// consulted ONLY for values the ledger may legitimately lack (the session id
/// bound after `SessionStarted`, the folder's path, the assistant snapshot) —
/// never as an alternative identity.
pub async fn resolve(
    conn: &DatabaseConnection,
    task_id: &str,
) -> Result<Option<DelegationTaskRecord>, DbError> {
    let Some(row) = find(conn, task_id).await? else {
        return Ok(None);
    };
    let child = conversation::Entity::find_by_id(row.child_conversation_id)
        .one(conn)
        .await?;
    let working_dir = match row.working_dir.clone() {
        Some(dir) => Some(dir),
        None => match child.as_ref() {
            Some(c) => folder::Entity::find_by_id(c.folder_id)
                .one(conn)
                .await?
                .map(|f| f.path),
            None => None,
        },
    };
    let external_session_id = row
        .external_session_id
        .clone()
        .or_else(|| child.as_ref().and_then(|c| c.external_id.clone()));
    let snapshot_raw = row
        .assistant_snapshot
        .clone()
        .or_else(|| child.as_ref().and_then(|c| c.assistant_snapshot.clone()));
    let assistant_id = row
        .assistant_id
        .or_else(|| child.as_ref().and_then(|c| c.assistant_id));
    let assistant_name = row.assistant_name.clone().or_else(|| {
        snapshot_raw
            .as_deref()
            .and_then(AssistantRunSnapshot::name_from_json)
    });
    let assistant = match (assistant_id, snapshot_raw.as_deref()) {
        (Some(id), Some(raw)) => serde_json::from_str::<AssistantRunSnapshot>(raw)
            .ok()
            .map(|snapshot| DelegationAssistant {
                id,
                name: snapshot.name,
                agent_options: snapshot.agent_options,
                instructions: snapshot.instructions,
            }),
        _ => None,
    };
    let successor_task_id = find_successor(conn, &row.task_id)
        .await?
        .map(|s| s.task_id);
    Ok(Some(DelegationTaskRecord {
        task_id: row.task_id,
        source_task_id: row.source_task_id,
        request_hash: row.request_hash,
        parent_conversation_id: row.parent_conversation_id,
        parent_tool_use_id: row.parent_tool_use_id,
        child_conversation_id: row.child_conversation_id,
        folder_id: child.as_ref().map(|c| c.folder_id).unwrap_or_default(),
        agent_type: AgentType::from_wire(&row.agent_type).unwrap_or(AgentType::ClaudeCode),
        external_session_id,
        working_dir,
        assistant_ref: assistant_id.map(|id| AssistantRef {
            id,
            name: assistant_name.clone().unwrap_or_default(),
        }),
        assistant,
        task_preview: row.task_preview,
        status: status_from_str(&row.status),
        error_code: row.error_code,
        error_message: row.error_message,
        duration_ms: row.duration_ms.map(|ms| ms.max(0) as u64),
        result_preview: row.result_preview,
        successor_task_id,
    }))
}

/// Create baseline ledger rows for delegation children recorded before the
/// ledger existed. Idempotent, so it is safe to run on every startup.
///
/// The historical mapping is deliberately lossy and documented on
/// [`backfill_record`]: the conversation row could not distinguish a failure
/// from a cancel, and never stored the full task text.
pub async fn backfill_from_conversations(conn: &DatabaseConnection) -> Result<usize, DbError> {
    let rows = conversation::Entity::find()
        .filter(conversation::Column::DelegationCallId.is_not_null())
        .filter(conversation::Column::ParentId.is_not_null())
        .all(conn)
        .await?;
    let mut inserted = 0usize;
    for child in rows {
        let Some(task_id) = child.delegation_call_id.clone() else {
            continue;
        };
        if find(conn, &task_id).await?.is_some() {
            continue;
        }
        let working_dir = folder::Entity::find_by_id(child.folder_id)
            .one(conn)
            .await?
            .map(|f| f.path);
        let assistant_name = child
            .assistant_snapshot
            .as_deref()
            .and_then(AssistantRunSnapshot::name_from_json);
        let model = delegation_task::ActiveModel {
            task_id: Set(task_id),
            source_task_id: Set(None),
            request_hash: Set(None),
            parent_conversation_id: Set(child.parent_id.unwrap_or_default()),
            parent_tool_use_id: Set(child.parent_tool_use_id.clone()),
            child_conversation_id: Set(child.id),
            agent_type: Set(child.agent_type.clone()),
            external_session_id: Set(child.external_id.clone()),
            working_dir: Set(working_dir),
            assistant_id: Set(child.assistant_id),
            assistant_name: Set(assistant_name),
            assistant_snapshot: Set(child.assistant_snapshot.clone()),
            // The full task text was never stored; the row's title was seeded
            // from it, so it is the closest surviving preview.
            task_preview: Set(child.title.clone()),
            status: Set(historical_status(&child.status).to_string()),
            error_code: Set(None),
            error_message: Set(None),
            duration_ms: Set(None),
            result_preview: Set(None),
            created_at: Set(child.created_at),
            finished_at: Set(match historical_status(&child.status) {
                delegation_task::STATUS_RUNNING => None,
                _ => Some(child.updated_at),
            }),
        };
        match model.insert(conn).await {
            Ok(_) => inserted += 1,
            // A concurrent startup/backfill won the race; its row is the same
            // baseline.
            Err(e) if unique_violation(&e) => {}
            Err(e) => return Err(DbError::Database(e)),
        }
    }
    Ok(inserted)
}

/// The historical conversation-status mapping required by the ledger
/// contract: `pending_review`/`completed` → completed, `cancelled` → canceled
/// (no error code — the row cannot tell a failure from a cancel),
/// `in_progress` → running.
fn historical_status(status: &conversation::ConversationStatus) -> &'static str {
    match status {
        conversation::ConversationStatus::InProgress => delegation_task::STATUS_RUNNING,
        conversation::ConversationStatus::PendingReview
        | conversation::ConversationStatus::Completed => delegation_task::STATUS_COMPLETED,
        conversation::ConversationStatus::Cancelled => delegation_task::STATUS_CANCELED,
    }
}

/// The production ledger the broker holds. Thin adapter over this module so
/// the broker's trait stays free of SeaORM.
pub struct DbDelegationTaskLedger {
    pub db: std::sync::Arc<crate::db::AppDatabase>,
}

#[async_trait::async_trait]
impl DelegationTaskLedger for DbDelegationTaskLedger {
    async fn insert(&self, task: NewDelegationTask) -> Result<(), DbError> {
        super::delegation_task_service::insert(&self.db.conn, task)
            .await
            .map(|_| ())
    }

    async fn find(&self, task_id: &str) -> Option<DelegationTaskRecord> {
        resolve(&self.db.conn, task_id).await.ok().flatten()
    }

    async fn successor_of(&self, source_task_id: &str) -> Option<DelegationTaskRecord> {
        let successor = find_successor(&self.db.conn, source_task_id)
            .await
            .ok()
            .flatten()?;
        resolve(&self.db.conn, &successor.task_id).await.ok().flatten()
    }

    async fn reopen(&self, task_id: &str) {
        if let Err(e) = super::delegation_task_service::reopen(&self.db.conn, task_id).await {
            tracing::warn!("[delegation] ledger reopen for {task_id} failed: {e}");
        }
    }

    async fn discard(&self, task_id: &str) {
        match super::delegation_task_service::discard(&self.db.conn, task_id).await {
            Ok(true) => tracing::info!(
                "[delegation] discarded never-sent continue round {task_id}"
            ),
            Ok(false) => {}
            Err(e) => tracing::warn!("[delegation] ledger discard for {task_id} failed: {e}"),
        }
    }

    async fn finish(&self, task_id: &str, update: TerminalUpdate) {
        if let Err(e) = super::delegation_task_service::finish(&self.db.conn, task_id, update).await
        {
            tracing::warn!("[delegation] ledger terminal write for {task_id} failed: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn new_task(task_id: &str, source: Option<&str>, child: i32) -> NewDelegationTask {
        NewDelegationTask {
            task_id: task_id.into(),
            source_task_id: source.map(str::to_string),
            request_hash: source.map(|_| "hash-1".to_string()),
            parent_conversation_id: 1,
            parent_tool_use_id: Some(format!("tu-{task_id}")),
            child_conversation_id: child,
            agent_type: AgentType::Codex,
            external_session_id: Some("sess-1".into()),
            working_dir: Some("/tmp/work".into()),
            assistant: None,
            task_preview: Some(format!("task {task_id}")),
        }
    }

    async fn seed_child(db: &crate::db::AppDatabase) -> i32 {
        let folder = crate::db::test_helpers::seed_folder(db, "/tmp/work").await;
        let parent = crate::db::test_helpers::seed_conversation(db, folder, AgentType::ClaudeCode).await;
        let child = crate::db::service::conversation_service::create_with_delegation(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("original task".into()),
            None,
            Some(crate::acp::delegation::spawner::DelegationLink {
                parent_conversation_id: parent,
                parent_tool_use_id: "tu-original".into(),
                delegation_call_id: "task-1".into(),
                assistant: None,
            }),
        )
        .await
        .expect("seed child");
        child.id
    }

    #[tokio::test]
    async fn a_source_has_at_most_one_successor() {
        let db = fresh_in_memory_db().await;
        let child = seed_child(&db).await;
        insert(&db.conn, new_task("task-1", None, child)).await.unwrap();
        insert(&db.conn, new_task("task-2", Some("task-1"), child))
            .await
            .unwrap();
        let err = insert(&db.conn, new_task("task-3", Some("task-1"), child))
            .await
            .expect_err("second successor must conflict");
        assert!(matches!(err, DbError::Conflict(_)), "{err:?}");
        assert_eq!(
            find_successor(&db.conn, "task-1").await.unwrap().unwrap().task_id,
            "task-2"
        );
    }

    #[tokio::test]
    async fn a_terminal_round_is_never_rewritten() {
        let db = fresh_in_memory_db().await;
        let child = seed_child(&db).await;
        insert(&db.conn, new_task("task-1", None, child)).await.unwrap();
        assert!(finish(
            &db.conn,
            "task-1",
            TerminalUpdate {
                status: TaskStatus::Failed,
                error_code: Some("spawn_failed".into()),
                error_message: Some("boom".into()),
                duration_ms: Some(7),
                result_preview: None,
                external_session_id: None,
            },
        )
        .await
        .unwrap());
        // A successor's late write (or a duplicate terminal) must not touch it.
        assert!(!finish(
            &db.conn,
            "task-1",
            TerminalUpdate {
                status: TaskStatus::Completed,
                error_code: None,
                error_message: None,
                duration_ms: Some(99),
                result_preview: Some("other".into()),
                external_session_id: None,
            },
        )
        .await
        .unwrap());
        let row = find(&db.conn, "task-1").await.unwrap().unwrap();
        assert_eq!(row.status, delegation_task::STATUS_FAILED);
        assert_eq!(row.error_code.as_deref(), Some("spawn_failed"));
        assert_eq!(row.duration_ms, Some(7));
    }

    #[tokio::test]
    async fn historical_child_rows_backfill_once_with_the_documented_mapping() {
        let db = fresh_in_memory_db().await;
        let child = seed_child(&db).await;
        let inserted = backfill_from_conversations(&db.conn).await.unwrap();
        assert_eq!(inserted, 1);
        let row = find(&db.conn, "task-1").await.unwrap().unwrap();
        assert_eq!(row.status, delegation_task::STATUS_RUNNING);
        assert_eq!(row.task_preview.as_deref(), Some("original task"));
        assert_eq!(row.request_hash, None);
        assert_eq!(row.external_session_id, None);
        assert_eq!(row.working_dir.as_deref(), Some("/tmp/work"));
        assert_eq!(row.child_conversation_id, child);
        // Idempotent.
        assert_eq!(backfill_from_conversations(&db.conn).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn resolve_falls_back_to_the_child_row_for_session_and_cwd() {
        let db = fresh_in_memory_db().await;
        let child = seed_child(&db).await;
        insert(
            &db.conn,
            NewDelegationTask {
                external_session_id: None,
                working_dir: None,
                ..new_task("task-1", None, child)
            },
        )
        .await
        .unwrap();
        // Bind the ACP session the way SessionStarted would.
        crate::db::service::conversation_service::bind_external_id(
            &db.conn,
            child,
            "sess-live",
            &[],
        )
        .await
        .unwrap();
        let record = resolve(&db.conn, "task-1").await.unwrap().unwrap();
        assert_eq!(record.external_session_id.as_deref(), Some("sess-live"));
        assert_eq!(record.working_dir.as_deref(), Some("/tmp/work"));
        assert_eq!(record.agent_type, AgentType::Codex);
    }

    #[tokio::test]
    async fn resolve_reports_the_successor_of_a_chain() {
        let db = fresh_in_memory_db().await;
        let child = seed_child(&db).await;
        insert(&db.conn, new_task("task-1", None, child)).await.unwrap();
        insert(&db.conn, new_task("task-2", Some("task-1"), child))
            .await
            .unwrap();
        let record = resolve(&db.conn, "task-1").await.unwrap().unwrap();
        assert_eq!(record.successor_task_id.as_deref(), Some("task-2"));
        assert!(resolve(&db.conn, "task-2").await.unwrap().unwrap().successor_task_id.is_none());
    }
}
