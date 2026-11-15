use sea_orm_migration::prelude::*;

/// "Is this right?" (10.3): a message of an ordinary conversation the owner
/// had checked — the conversation, the message's fingerprint (and the
/// sentence's, when they checked one), what the check concluded and on
/// what evidence, and the dispatch that checked it. The same message is
/// answered from here the next time.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentCheck::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentCheck::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // The assistant it was checked through: its card is there.
                    .col(
                        ColumnDef::new(PersonalAgentCheck::BotId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentCheck::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    // The message's fingerprint, and the sentence's ("" for
                    // the whole message).
                    .col(
                        ColumnDef::new(PersonalAgentCheck::MessageFp)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentCheck::QuoteFp)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentCheck::Message)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PersonalAgentCheck::Quote).text().null())
                    // The owner's message it answered.
                    .col(ColumnDef::new(PersonalAgentCheck::Asked).text().null())
                    // checking | done | failed
                    .col(ColumnDef::new(PersonalAgentCheck::State).text().not_null())
                    // true | false | partly | unsure
                    .col(ColumnDef::new(PersonalAgentCheck::Verdict).text().null())
                    .col(ColumnDef::new(PersonalAgentCheck::Evidence).text().null())
                    // Why it is unsure for want of evidence, or why it did
                    // not finish.
                    .col(ColumnDef::new(PersonalAgentCheck::Note).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentCheck::DispatchId)
                            .integer()
                            .null(),
                    )
                    // Its card.
                    .col(
                        ColumnDef::new(PersonalAgentCheck::NoticeId)
                            .integer()
                            .null(),
                    )
                    // When what it came to was told — its card, the brain, the
                    // owner: a check that ended and was not is told again.
                    .col(
                        ColumnDef::new(PersonalAgentCheck::ToldAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentCheck::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentCheck::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_check_conversation")
                    .table(PersonalAgentCheck::Table)
                    .col(PersonalAgentCheck::ConversationId)
                    .col(PersonalAgentCheck::MessageFp)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_check_dispatch")
                    .table(PersonalAgentCheck::Table)
                    .col(PersonalAgentCheck::DispatchId)
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
                    .table(PersonalAgentCheck::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum PersonalAgentCheck {
    Table,
    Id,
    BotId,
    ConversationId,
    MessageFp,
    QuoteFp,
    Message,
    Quote,
    Asked,
    State,
    Verdict,
    Evidence,
    Note,
    DispatchId,
    NoticeId,
    ToldAt,
    CreatedAt,
    UpdatedAt,
}
