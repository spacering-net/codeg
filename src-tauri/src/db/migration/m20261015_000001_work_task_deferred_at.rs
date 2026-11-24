use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    // When the user put a settled task aside ("handle later"):
                    // the board files it under Done instead of "needs you"
                    // until they pick it back up. NULL = not put aside. A
                    // column beside the status rather than a status of its
                    // own: the task stays exactly as resumable as it was —
                    // its review/failure is still the truth about it.
                    .add_column(
                        ColumnDef::new(WorkTask::DeferredAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    .drop_column(WorkTask::DeferredAt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum WorkTask {
    Table,
    DeferredAt,
}
