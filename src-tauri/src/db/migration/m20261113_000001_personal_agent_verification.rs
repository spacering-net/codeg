use sea_orm_migration::prelude::*;

/// Acceptance (7.5): what done looks like, written when the work is
/// dispatched, and one row per round of acceptance — the check codeg sent
/// out, the version it is bound to (the task's `run_seq` and the worktree's
/// fingerprint), what the check found, what the assistant (or codeg, or the
/// owner) concluded, and the chain from that version to what was delivered
/// and merged.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .add_column(
                        ColumnDef::new(PersonalAgentDispatch::DoneWhen)
                            .text()
                            .null()
                            .to_owned(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentVerification::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentVerification::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // Whose: the assistant that dispatched the work.
                    .col(
                        ColumnDef::new(PersonalAgentVerification::BotId)
                            .integer()
                            .null(),
                    )
                    // The work being accepted.
                    .col(
                        ColumnDef::new(PersonalAgentVerification::DispatchId)
                            .integer()
                            .not_null(),
                    )
                    // The check codeg sent out for it; none when no executor
                    // config could check it.
                    .col(
                        ColumnDef::new(PersonalAgentVerification::CheckDispatchId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::Round)
                            .integer()
                            .not_null(),
                    )
                    // The version it is bound to.
                    .col(
                        ColumnDef::new(PersonalAgentVerification::RunSeq)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::Fingerprint)
                            .text()
                            .not_null(),
                    )
                    // checking | deciding | asked | accepted | revised |
                    // stale | void | changed
                    .col(
                        ColumnDef::new(PersonalAgentVerification::State)
                            .text()
                            .not_null(),
                    )
                    // PASS | FAIL | UNVERIFIED
                    .col(
                        ColumnDef::new(PersonalAgentVerification::CheckVerdict)
                            .text()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::CheckEvidence)
                            .text()
                            .null(),
                    )
                    // accept | revise | ask_owner
                    .col(
                        ColumnDef::new(PersonalAgentVerification::Decision)
                            .text()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::Reason)
                            .text()
                            .null(),
                    )
                    // What a revise sends back (on an ask card: what it
                    // would send).
                    .col(
                        ColumnDef::new(PersonalAgentVerification::Message)
                            .text()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::Question)
                            .text()
                            .null(),
                    )
                    // assistant | fallback | owner
                    .col(
                        ColumnDef::new(PersonalAgentVerification::DecidedBy)
                            .text()
                            .null(),
                    )
                    // The acceptance card.
                    .col(
                        ColumnDef::new(PersonalAgentVerification::NoticeId)
                            .integer()
                            .null(),
                    )
                    // The work was accepted without an independent check.
                    .col(
                        ColumnDef::new(PersonalAgentVerification::Unchecked)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    // The head pushed when the accepted version was delivered
                    // as a pull request, and the merge commit that landed it.
                    .col(
                        ColumnDef::new(PersonalAgentVerification::DeliveredHead)
                            .text()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::MergeCommit)
                            .text()
                            .null(),
                    )
                    // Whether what was merged is certainly the version
                    // accepted (a forge that merges a given head only).
                    .col(
                        ColumnDef::new(PersonalAgentVerification::VersionGuaranteed)
                            .boolean()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentVerification::DecidedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_verification_dispatch")
                    .table(PersonalAgentVerification::Table)
                    .col(PersonalAgentVerification::DispatchId)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_verification_check")
                    .table(PersonalAgentVerification::Table)
                    .col(PersonalAgentVerification::CheckDispatchId)
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
                    .table(PersonalAgentVerification::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .drop_column(PersonalAgentDispatch::DoneWhen)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum PersonalAgentDispatch {
    Table,
    DoneWhen,
}

#[derive(DeriveIden)]
enum PersonalAgentVerification {
    Table,
    Id,
    BotId,
    DispatchId,
    CheckDispatchId,
    Round,
    RunSeq,
    Fingerprint,
    State,
    CheckVerdict,
    CheckEvidence,
    Decision,
    Reason,
    Message,
    Question,
    DecidedBy,
    NoticeId,
    Unchecked,
    DeliveredHead,
    MergeCommit,
    VersionGuaranteed,
    CreatedAt,
    UpdatedAt,
    DecidedAt,
}
