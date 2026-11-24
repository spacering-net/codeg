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
                    // JSON `WorkTaskDelivery`: where a task WITHOUT forge
                    // provenance delivered its work — the repository and
                    // account it resolved from the project's `origin` at its
                    // first delivery — and the pull request it opened there.
                    // NULL until such a task is first delivered. Forge-sourced
                    // tasks keep recording into `source_meta`, which already
                    // names their repository and pinned account.
                    .add_column(ColumnDef::new(WorkTask::Delivery).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    .drop_column(WorkTask::Delivery)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum WorkTask {
    Table,
    Delivery,
}
