use sea_orm_migration::prelude::*;

/// The personal agent's records of its own acting: where each delivery came
/// from (recorded only), the ledger that keeps a re-delivered batch from
/// acting twice, and the native cards codeg writes itself.
///
/// Its first build also added the authority columns (`batch.subjects`,
/// `dispatch.grant_id` / `for_item_id`, `item.grant_id` / `origin_batch_id`)
/// and the `personal_agent_grant` table. That build never shipped; a dev
/// database that ran it keeps them, unused — nothing declares, reads or
/// writes them.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite takes one ADD COLUMN per ALTER TABLE.
        //
        // trigger: what started a delivery — `owner` when it carries a message
        // of the owner's, `event` when only news of dispatched work; recorded
        // only. NULL for a compaction and for every batch before this.
        add_column(
            manager,
            PersonalAgentBatch::Table,
            ColumnDef::new(PersonalAgentBatch::Trigger).text().null(),
        )
        .await?;
        // personal_agent_action: the ledger of what the agent's acting calls
        // did. A re-delivered batch finds its earlier call here and gets the
        // product back instead of acting again. (Its later columns are
        // m20261107_000002's.)
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentAction::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentAction::Id))
                    .col(
                        ColumnDef::new(PersonalAgentAction::BatchId)
                            .integer()
                            .not_null(),
                    )
                    // The tool and its normalized arguments.
                    .col(ColumnDef::new(PersonalAgentAction::Key).text().not_null())
                    // dispatch | followup
                    .col(ColumnDef::new(PersonalAgentAction::Kind).text().not_null())
                    // prepared | committed | not_executed | unknown (the first
                    // build wrote `failed`, read as not_executed)
                    .col(ColumnDef::new(PersonalAgentAction::State).text().not_null())
                    // What it made: a dispatch id, as text.
                    .col(ColumnDef::new(PersonalAgentAction::RefId).text().null())
                    .col(ts(PersonalAgentAction::CreatedAt))
                    .col(ts(PersonalAgentAction::UpdatedAt))
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_action_key")
                    .table(PersonalAgentAction::Table)
                    .col(PersonalAgentAction::BatchId)
                    .col(PersonalAgentAction::Key)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // personal_agent_notice: a native card's state. The card itself is a
        // timeline row (`kind = 'notice'`); this is what it is about and
        // where it stands.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentNotice::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentNotice::Id))
                    // proposal | uncertain, later approval | reminder |
                    // memory | … (text: a new kind needs no migration)
                    .col(ColumnDef::new(PersonalAgentNotice::Kind).text().not_null())
                    // What it is about, for keeping one card per matter.
                    .col(
                        ColumnDef::new(PersonalAgentNotice::SubjectKey)
                            .text()
                            .null(),
                    )
                    // urgent | normal | low
                    .col(ColumnDef::new(PersonalAgentNotice::Level).text().not_null())
                    // open | acting | acted | unknown | dismissed | muted |
                    // expired
                    .col(ColumnDef::new(PersonalAgentNotice::State).text().not_null())
                    .col(
                        ColumnDef::new(PersonalAgentNotice::TimelineId)
                            .integer()
                            .null(),
                    )
                    // The delivery that raised it, when one did.
                    .col(
                        ColumnDef::new(PersonalAgentNotice::BatchId)
                            .integer()
                            .null(),
                    )
                    // JSON, shaped per kind: what acting on it does.
                    .col(
                        ColumnDef::new(PersonalAgentNotice::Payload)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentNotice::NotifiedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentNotice::ActedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentNotice::ExpiresAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(ts(PersonalAgentNotice::CreatedAt))
                    .col(ts(PersonalAgentNotice::UpdatedAt))
                    .to_owned(),
            )
            .await?;
        index(
            manager,
            "idx_personal_agent_notice_state",
            PersonalAgentNotice::Table,
            PersonalAgentNotice::State,
        )
        .await?;
        index(
            manager,
            "idx_personal_agent_notice_subject",
            PersonalAgentNotice::Table,
            PersonalAgentNotice::SubjectKey,
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in [
            PersonalAgentNotice::Table.into_iden(),
            PersonalAgentAction::Table.into_iden(),
        ] {
            manager
                .drop_table(Table::drop().table(table).if_exists().to_owned())
                .await?;
        }
        drop_column(
            manager,
            PersonalAgentBatch::Table,
            PersonalAgentBatch::Trigger,
        )
        .await?;
        Ok(())
    }
}

fn pk<T: IntoIden>(col: T) -> ColumnDef {
    ColumnDef::new(col)
        .integer()
        .not_null()
        .auto_increment()
        .primary_key()
        .to_owned()
}

fn ts<T: IntoIden>(col: T) -> ColumnDef {
    ColumnDef::new(col)
        .timestamp_with_time_zone()
        .not_null()
        .to_owned()
}

async fn add_column<T: IntoIden + 'static>(
    manager: &SchemaManager<'_>,
    table: T,
    col: &mut ColumnDef,
) -> Result<(), DbErr> {
    manager
        .alter_table(
            Table::alter()
                .table(table)
                .add_column(col.to_owned())
                .to_owned(),
        )
        .await
}

async fn drop_column<T: IntoIden + 'static, C: IntoIden + 'static>(
    manager: &SchemaManager<'_>,
    table: T,
    col: C,
) -> Result<(), DbErr> {
    manager
        .alter_table(Table::alter().table(table).drop_column(col).to_owned())
        .await
}

async fn index<T: IntoIden + 'static, C: IntoIden + 'static>(
    manager: &SchemaManager<'_>,
    name: &str,
    table: T,
    col: C,
) -> Result<(), DbErr> {
    manager
        .create_index(Index::create().name(name).table(table).col(col).to_owned())
        .await
}

#[derive(DeriveIden)]
enum PersonalAgentBatch {
    Table,
    Trigger,
}

#[derive(DeriveIden)]
enum PersonalAgentAction {
    Table,
    Id,
    BatchId,
    Key,
    Kind,
    State,
    RefId,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentNotice {
    Table,
    Id,
    Kind,
    SubjectKey,
    Level,
    State,
    TimelineId,
    BatchId,
    Payload,
    NotifiedAt,
    ActedAt,
    ExpiresAt,
    CreatedAt,
    UpdatedAt,
}
