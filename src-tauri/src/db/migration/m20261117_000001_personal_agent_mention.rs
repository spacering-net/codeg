use sea_orm_migration::prelude::*;

/// A matter that comes up when the owner mentions something (6.8): its
/// keywords, how often and how long it may come up, and how often it has.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // JSON: { keywords, cooldown_hours, max_times, expires_at, times, last_at? }.
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentItem::Table)
                    .add_column(ColumnDef::new(PersonalAgentItem::Mention).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentItem::Table)
                    .drop_column(PersonalAgentItem::Mention)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum PersonalAgentItem {
    Table,
    Mention,
}
