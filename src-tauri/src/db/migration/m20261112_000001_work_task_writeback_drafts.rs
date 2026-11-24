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
                    // JSON `{"<item number>": "<markdown>"}`: the reply a
                    // forge-sourced task's agent drafted for each thread it
                    // handles, as the user last saw (and maybe edited) it.
                    // Posted only after the user accepts the task; cleared
                    // whenever a new run is claimed, so a reply always
                    // describes the run it came from. NULL = no draft.
                    .add_column(ColumnDef::new(WorkTask::WritebackDrafts).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    .drop_column(WorkTask::WritebackDrafts)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum WorkTask {
    Table,
    WritebackDrafts,
}
