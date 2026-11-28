use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // What kind of failure a watched pull request's last read was
        // (`auth`, `no_account`, `config`, `network`, `timeout`,
        // `rate_limited`, `not_found`, `api`): the activity tells by it when
        // a watch it cannot read is the owner's to see to. NULL once a read
        // comes back, and on every row from before.
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentWatch::Table)
                    .add_column(ColumnDef::new(PersonalAgentWatch::LastErrorKind).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentWatch::Table)
                    .drop_column(PersonalAgentWatch::LastErrorKind)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum PersonalAgentWatch {
    Table,
    LastErrorKind,
}
