use sea_orm_migration::prelude::*;

/// The kind of work a dispatch is (7.9): one of the division's kinds —
/// writing code, review, testing, fixing CI, docs, releases, research,
/// checking — as the assistant named it, or codeg for its own rounds. Each
/// executor's record is kept by it, and the division's pick for that kind
/// is compared against the others. A plan's step carries it to the
/// dispatch it becomes.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .add_column(ColumnDef::new(PersonalAgentDispatch::Kind).text().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentPlanStep::Table)
                    .add_column(ColumnDef::new(PersonalAgentPlanStep::Kind).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentPlanStep::Table)
                    .drop_column(PersonalAgentPlanStep::Kind)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .drop_column(PersonalAgentDispatch::Kind)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum PersonalAgentDispatch {
    Table,
    Kind,
}

#[derive(DeriveIden)]
enum PersonalAgentPlanStep {
    Table,
    Kind,
}
