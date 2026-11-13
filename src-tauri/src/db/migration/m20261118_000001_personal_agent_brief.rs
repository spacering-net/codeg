use sea_orm_migration::prelude::*;

/// The morning brief and the day's wrap-up (6.4, 6.5): one row each — the
/// day it is for, how far it got, the materials codeg gathered for it, the
/// turn that wrote it and the card it is, and the work the owner had done
/// tonight from it.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentBrief::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentBrief::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentBrief::BotId)
                            .integer()
                            .not_null(),
                    )
                    // `brief` or `wrap`.
                    .col(ColumnDef::new(PersonalAgentBrief::Kind).text().not_null())
                    // The owner's day it is for (`YYYY-MM-DD`, from 04:00).
                    .col(ColumnDef::new(PersonalAgentBrief::Day).text().not_null())
                    // `brief:<day>`, `wrap:<day>`; one the owner asked for,
                    // `wrap:<day>:<batch>`.
                    .col(ColumnDef::new(PersonalAgentBrief::Key).text().not_null())
                    .col(ColumnDef::new(PersonalAgentBrief::State).text().not_null())
                    .col(
                        ColumnDef::new(PersonalAgentBrief::Since)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PersonalAgentBrief::Material).text().null())
                    .col(ColumnDef::new(PersonalAgentBrief::EventId).integer().null())
                    .col(ColumnDef::new(PersonalAgentBrief::BatchId).integer().null())
                    .col(ColumnDef::new(PersonalAgentBrief::RowId).integer().null())
                    // JSON: { cards, dispatches, messages } had done tonight.
                    .col(ColumnDef::new(PersonalAgentBrief::Tonight).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentBrief::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentBrief::ReadyAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentBrief::DeliveredAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentBrief::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_brief_key")
                    .table(PersonalAgentBrief::Table)
                    .col(PersonalAgentBrief::BotId)
                    .col(PersonalAgentBrief::Key)
                    .unique()
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_brief_batch")
                    .table(PersonalAgentBrief::Table)
                    .col(PersonalAgentBrief::BatchId)
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
                    .table(PersonalAgentBrief::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum PersonalAgentBrief {
    Table,
    Id,
    BotId,
    Kind,
    Day,
    Key,
    State,
    Since,
    Material,
    EventId,
    BatchId,
    RowId,
    Tonight,
    CreatedAt,
    ReadyAt,
    DeliveredAt,
    UpdatedAt,
}
