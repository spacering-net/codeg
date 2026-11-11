use sea_orm_migration::prelude::*;

/// When the owner is in codeg (6.2, 1.12): per local date and five-minute
/// slot of the day, how many minutes they were active. The account's — no
/// assistant's. Kept 60 days; codeg learns the owner's usual hours from it.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentActivity::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentActivity::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // The owner's local date, `YYYY-MM-DD`.
                    .col(ColumnDef::new(PersonalAgentActivity::Day).text().not_null())
                    // The five-minute slot of that day, 0..=287.
                    .col(
                        ColumnDef::new(PersonalAgentActivity::Slot)
                            .integer()
                            .not_null(),
                    )
                    // Minutes the owner was active in it, 0..=5.
                    .col(
                        ColumnDef::new(PersonalAgentActivity::Count)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentActivity::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_activity_day_slot")
                    .table(PersonalAgentActivity::Table)
                    .col(PersonalAgentActivity::Day)
                    .col(PersonalAgentActivity::Slot)
                    .unique()
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(PersonalAgentActivity::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum PersonalAgentActivity {
    Table,
    Id,
    Day,
    Slot,
    Count,
    UpdatedAt,
}
