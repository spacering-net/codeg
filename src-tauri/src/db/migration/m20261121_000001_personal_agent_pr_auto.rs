use sea_orm_migration::prelude::*;

/// What codeg does on a watched pull request by itself (7.4, phase 3): on
/// the watch, the rounds it started to fix the PR (CI, conflicts) and what
/// each was, the review feedback it has read and what came of it, and the
/// merge it made; on a dispatch, that it is (or carries) such a round —
/// which pull request, why, and whether codeg delivers it once accepted.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // JSON: { fixes: [..], feedback: {..}, merge: {..} }.
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentWatch::Table)
                    .add_column(ColumnDef::new(PersonalAgentWatch::Auto).text().null())
                    .to_owned(),
            )
            .await?;
        // JSON: { watch_id, cause, n, head, how }.
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .add_column(ColumnDef::new(PersonalAgentDispatch::PrFix).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .drop_column(PersonalAgentDispatch::PrFix)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentWatch::Table)
                    .drop_column(PersonalAgentWatch::Auto)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum PersonalAgentWatch {
    Table,
    Auto,
}

#[derive(DeriveIden)]
enum PersonalAgentDispatch {
    Table,
    PrFix,
}
