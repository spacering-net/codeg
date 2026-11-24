use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Provenance of a task triggered from a forge (GitHub/GitLab) work
        // item. Three columns instead of a blob inside `config` because two of
        // them are QUERIED — dedup ("is an active task already handling this
        // issue?") and the issue list's reverse lookup — while `config` has a
        // standing "replayed at launch, never queried" contract.
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    // 'forge_issue' | 'forge_pr'; NULL = not forge-sourced.
                    .add_column(ColumnDef::new(WorkTask::SourceKind).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    // Canonical dedup/lookup key
                    // `{provider}:{server_host}:{owner_repo}:{kind}:{number}`,
                    // always produced by `forge::source_key` — never hand-built.
                    .add_column(ColumnDef::new(WorkTask::SourceKey).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    // JSON snapshot (URL, title, account id, PR head/base …).
                    // Same discipline as `config`: replayed, never queried.
                    .add_column(ColumnDef::new(WorkTask::SourceMeta).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_work_task_source_key")
                    .table(WorkTask::Table)
                    .col(WorkTask::SourceKey)
                    // Deliberately NOT unique: "one active task per work item"
                    // is an advisory rule with an explicit user override,
                    // enforced transactionally in the command layer; finished
                    // tasks for the same item are legitimate history.
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_work_task_source_key")
                    .table(WorkTask::Table)
                    .to_owned(),
            )
            .await?;
        for col in [WorkTask::SourceMeta, WorkTask::SourceKey, WorkTask::SourceKind] {
            manager
                .alter_table(
                    Table::alter().table(WorkTask::Table).drop_column(col).to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum WorkTask {
    Table,
    SourceKind,
    SourceKey,
    SourceMeta,
}
