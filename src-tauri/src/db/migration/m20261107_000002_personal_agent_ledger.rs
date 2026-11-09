use sea_orm_migration::prelude::*;

/// What the ledger needs to tell, after an interruption, whether an action
/// took effect: the operation's id (carried to the receiving side, so its own
/// record can name it), the call in full, the evidence observed, the target,
/// the card about it, when a send was about to go out, and why it stands as
/// it does. And, on a dispatch, the operation that claimed its current round.
///
/// A migration of its own because m20261107_000001 already ran on a dev
/// database: columns added there would never reach it.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite takes one ADD COLUMN per ALTER TABLE.
        for col in [
            ColumnDef::new(PersonalAgentAction::OpId)
                .text()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgentAction::Payload)
                .text()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgentAction::Observed)
                .text()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgentAction::Target)
                .text()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgentAction::NoticeId)
                .integer()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgentAction::AttemptedAt)
                .timestamp_with_time_zone()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgentAction::Detail)
                .text()
                .null()
                .to_owned(),
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(PersonalAgentAction::Table)
                        .add_column(col)
                        .to_owned(),
                )
                .await?;
        }
        // Unique where set: an operation is one entry. (SQLite lets NULLs —
        // entries from before this — repeat under a unique index.)
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_action_op")
                    .table(PersonalAgentAction::Table)
                    .col(PersonalAgentAction::OpId)
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_action_state")
                    .table(PersonalAgentAction::Table)
                    .col(PersonalAgentAction::State)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .add_column(
                        ColumnDef::new(PersonalAgentDispatch::RoundOpId)
                            .text()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .drop_column(PersonalAgentDispatch::RoundOpId)
                    .to_owned(),
            )
            .await?;
        for name in [
            "idx_personal_agent_action_state",
            "idx_personal_agent_action_op",
        ] {
            manager
                .drop_index(
                    Index::drop()
                        .name(name)
                        .table(PersonalAgentAction::Table)
                        .to_owned(),
                )
                .await?;
        }
        for col in [
            PersonalAgentAction::Detail,
            PersonalAgentAction::AttemptedAt,
            PersonalAgentAction::NoticeId,
            PersonalAgentAction::Target,
            PersonalAgentAction::Observed,
            PersonalAgentAction::Payload,
            PersonalAgentAction::OpId,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(PersonalAgentAction::Table)
                        .drop_column(col)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum PersonalAgentAction {
    Table,
    State,
    OpId,
    Payload,
    Observed,
    Target,
    NoticeId,
    AttemptedAt,
    Detail,
}

#[derive(DeriveIden)]
enum PersonalAgentDispatch {
    Table,
    RoundOpId,
}
