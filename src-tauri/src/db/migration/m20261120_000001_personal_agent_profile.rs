use sea_orm_migration::prelude::*;

/// The owner's profile (5.1, 2.11): what codeg keeps besides what it reads
/// from its own records — the owner's corrections (their hours, the
/// projects it is not to mind), the card levels codeg lowered and the ones
/// the owner set, the weekly review's bookkeeping, the notifications it held
/// back each day. One JSON value per key; account-wide, every assistant's.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentProfile::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentProfile::Key)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(PersonalAgentProfile::Data).text().not_null())
                    .col(
                        ColumnDef::new(PersonalAgentProfile::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(PersonalAgentProfile::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum PersonalAgentProfile {
    Table,
    Key,
    Data,
    UpdatedAt,
}
