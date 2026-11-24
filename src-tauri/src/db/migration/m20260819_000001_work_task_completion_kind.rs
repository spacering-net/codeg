use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Explicit evidence for HOW a task reached `done`. Not a loosening of
        // an invariant — `done ⟺ merged` was already untrue before this column
        // existed (`complete_without_merge` writes `done` for an empty diff and
        // for a worktree that is gone), so a reader had to guess from
        // `merge_commit` being NULL. Delivering to a PR adds a third way in and
        // makes the guess impossible; this records the answer instead.
        //
        // A column rather than a `config` key: the board and the detail sheet
        // both branch on it, and `config` is contractually "replayed at launch,
        // never queried".
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    // 'merged' | 'delivered_pr' | 'accepted_without_merge'.
                    // NULL = a row that finished before this column existed.
                    .add_column(ColumnDef::new(WorkTask::CompletionKind).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    .drop_column(WorkTask::CompletionKind)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum WorkTask {
    Table,
    CompletionKind,
}
