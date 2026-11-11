use sea_orm_migration::prelude::*;

/// An assistant's open matters get a time (6.1): when one is due (UTC), how
/// it repeats, what happens then — a reminder card for the owner, or the
/// assistant woken to do it — what it is to do, and when the current
/// occurrence fired, so a tick never fires it twice.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite takes one ADD COLUMN per ALTER TABLE.
        for col in [
            ColumnDef::new(PersonalAgentItem::DueAt)
                .timestamp_with_time_zone()
                .null()
                .to_owned(),
            // JSON: { every, days?, day?, at, until? }.
            ColumnDef::new(PersonalAgentItem::Repeat)
                .text()
                .null()
                .to_owned(),
            // notify | act
            ColumnDef::new(PersonalAgentItem::AtDue)
                .text()
                .null()
                .to_owned(),
            // JSON: { what, dispatch? }.
            ColumnDef::new(PersonalAgentItem::ActSpec)
                .text()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgentItem::FiredAt)
                .timestamp_with_time_zone()
                .null()
                .to_owned(),
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(PersonalAgentItem::Table)
                        .add_column(col)
                        .to_owned(),
                )
                .await?;
        }
        // The clock asks for what is due every few seconds.
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_item_due")
                    .table(PersonalAgentItem::Table)
                    .col(PersonalAgentItem::DueAt)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_personal_agent_item_due")
                    .table(PersonalAgentItem::Table)
                    .to_owned(),
            )
            .await?;
        for col in [
            PersonalAgentItem::FiredAt,
            PersonalAgentItem::ActSpec,
            PersonalAgentItem::AtDue,
            PersonalAgentItem::Repeat,
            PersonalAgentItem::DueAt,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(PersonalAgentItem::Table)
                        .drop_column(col)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum PersonalAgentItem {
    Table,
    DueAt,
    Repeat,
    AtDue,
    ActSpec,
    FiredAt,
}
