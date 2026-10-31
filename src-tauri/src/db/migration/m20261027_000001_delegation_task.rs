//! The delegation task ledger: one row per round of delegated work.
//!
//! Before this table a delegation child conversation WAS the task — one row,
//! one `delegation_call_id`, one lifecycle. Continuing a session with new work
//! therefore had nowhere to live: overwriting the row's linkage would break
//! the old card, its status routing and its cancel path. The ledger separates
//! the session (the conversation row) from its rounds, and its partial unique
//! index on `source_task_id` is what guarantees a source can have at most one
//! successor.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

const IDX_SOURCE: &str = "idx_delegation_task_source";
const IDX_PARENT: &str = "idx_delegation_task_parent_conversation";
const IDX_CHILD: &str = "idx_delegation_task_child_conversation";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(DelegationTask::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(DelegationTask::TaskId)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(DelegationTask::SourceTaskId).text().null())
                    .col(ColumnDef::new(DelegationTask::RequestHash).text().null())
                    .col(
                        ColumnDef::new(DelegationTask::ParentConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(DelegationTask::ParentToolUseId).text().null())
                    .col(
                        ColumnDef::new(DelegationTask::ChildConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DelegationTask::AgentType)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(DelegationTask::ExternalSessionId).text().null())
                    .col(ColumnDef::new(DelegationTask::WorkingDir).text().null())
                    .col(ColumnDef::new(DelegationTask::AssistantId).integer().null())
                    .col(ColumnDef::new(DelegationTask::AssistantName).text().null())
                    .col(ColumnDef::new(DelegationTask::AssistantSnapshot).text().null())
                    .col(ColumnDef::new(DelegationTask::TaskPreview).text().null())
                    .col(
                        ColumnDef::new(DelegationTask::Status)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(DelegationTask::ErrorCode).text().null())
                    .col(ColumnDef::new(DelegationTask::ErrorMessage).text().null())
                    .col(ColumnDef::new(DelegationTask::DurationMs).big_integer().null())
                    .col(ColumnDef::new(DelegationTask::ResultPreview).text().null())
                    .col(
                        ColumnDef::new(DelegationTask::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DelegationTask::FinishedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        // SQLite's table builder cannot express a PARTIAL unique index, so the
        // one-source-one-successor invariant is installed directly. NULL
        // sources (every first round) are exempt, which is exactly what a
        // plain UNIQUE column would get wrong on some engines and what the
        // contract requires.
        let conn = manager.get_connection();
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            format!(
                "CREATE UNIQUE INDEX IF NOT EXISTS {IDX_SOURCE} \
                 ON delegation_task(source_task_id) WHERE source_task_id IS NOT NULL"
            ),
        ))
        .await?;
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            format!(
                "CREATE INDEX IF NOT EXISTS {IDX_PARENT} \
                 ON delegation_task(parent_conversation_id)"
            ),
        ))
        .await?;
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            format!(
                "CREATE INDEX IF NOT EXISTS {IDX_CHILD} \
                 ON delegation_task(child_conversation_id)"
            ),
        ))
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .if_exists()
                    .table(DelegationTask::Table)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum DelegationTask {
    Table,
    TaskId,
    SourceTaskId,
    RequestHash,
    ParentConversationId,
    ParentToolUseId,
    ChildConversationId,
    AgentType,
    ExternalSessionId,
    WorkingDir,
    AssistantId,
    AssistantName,
    AssistantSnapshot,
    TaskPreview,
    Status,
    ErrorCode,
    ErrorMessage,
    DurationMs,
    ResultPreview,
    CreatedAt,
    FinishedAt,
}
