use sea_orm_migration::prelude::*;

/// Proposal rules (6.7): what codeg's rules have seen and since when — an
/// uncommitted change, a pull request waiting for the owner's review, the
/// projects there were — and, per rule (object `""`), whether the owner
/// muted it from a card and whether codeg lowered it after they kept
/// dismissing its cards.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentRuleState::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentRuleState::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentRuleState::Rule)
                            .text()
                            .not_null(),
                    )
                    // What it is about (`folder:12`, `pr:3:41`); `""` is the
                    // rule itself.
                    .col(
                        ColumnDef::new(PersonalAgentRuleState::Object)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentRuleState::BotId)
                            .integer()
                            .null(),
                    )
                    // When it was first seen so — the time a rule's
                    // threshold counts from when nothing else records it.
                    .col(
                        ColumnDef::new(PersonalAgentRuleState::FirstSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentRuleState::LastSeenAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PersonalAgentRuleState::Data).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentRuleState::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentRuleState::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_rule_state_key")
                    .table(PersonalAgentRuleState::Table)
                    .col(PersonalAgentRuleState::Rule)
                    .col(PersonalAgentRuleState::Object)
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
                    .table(PersonalAgentRuleState::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum PersonalAgentRuleState {
    Table,
    Id,
    Rule,
    Object,
    BotId,
    FirstSeenAt,
    LastSeenAt,
    Data,
    CreatedAt,
    UpdatedAt,
}
