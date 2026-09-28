use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Manual position within the sidebar's "Pinned" section, written when
        // the user drags pinned conversations into an order of their own
        // (`reorder_conversation_pins`). Pinning or unpinning clears it again.
        //
        // Nullable with no default: a row without a position sorts by
        // `pinned_at` exactly as the whole section did before this column
        // existed, so every pre-existing row is already correct and no backfill
        // is needed.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::PinOrder).integer().null())
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::PinOrder)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    PinOrder,
}
