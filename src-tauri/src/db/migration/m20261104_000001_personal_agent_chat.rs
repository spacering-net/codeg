use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite takes one ADD COLUMN per ALTER TABLE.
        //
        // reply_to: the timeline row this one quotes (an owner message the
        // owner replied to, the reply a result card follows up on, the row an
        // assistant reply answers).
        add_column(
            manager,
            PersonalAgentTimeline::Table,
            ColumnDef::new(PersonalAgentTimeline::ReplyTo).integer().null(),
        )
        .await?;
        // read_at: when the assistant started on it — an owner message or a
        // result card. NULL is unread.
        add_column(
            manager,
            PersonalAgentTimeline::Table,
            ColumnDef::new(PersonalAgentTimeline::ReadAt)
                .timestamp_with_time_zone()
                .null(),
        )
        .await?;
        // event_id: the event a result card stands for, written with it in one
        // transaction.
        add_column(
            manager,
            PersonalAgentTimeline::Table,
            ColumnDef::new(PersonalAgentTimeline::EventId).integer().null(),
        )
        .await?;
        // seen_at: when the owner saw it — an assistant reply that settled, or
        // a result card. NULL is new to the owner.
        add_column(
            manager,
            PersonalAgentTimeline::Table,
            ColumnDef::new(PersonalAgentTimeline::SeenAt)
                .timestamp_with_time_zone()
                .null(),
        )
        .await?;
        // source_batch_id: the delivery that last dispatched or continued the
        // work; its result cards quote that turn's reply.
        add_column(
            manager,
            PersonalAgentDispatch::Table,
            ColumnDef::new(PersonalAgentDispatch::SourceBatchId).integer().null(),
        )
        .await?;

        index(
            manager,
            "idx_personal_agent_timeline_batch",
            PersonalAgentTimeline::Table,
            PersonalAgentTimeline::BatchId,
        )
        .await?;
        index(
            manager,
            "idx_personal_agent_timeline_event",
            PersonalAgentTimeline::Table,
            PersonalAgentTimeline::EventId,
        )
        .await?;
        index(
            manager,
            "idx_personal_agent_timeline_updated",
            PersonalAgentTimeline::Table,
            PersonalAgentTimeline::UpdatedAt,
        )
        .await?;

        // What phase-one rows already are: an owner message past the queue
        // was handled, every result card counts as read, a dispatch's source
        // is the turn that made it, and the owner has seen every reply and
        // card.
        let db = manager.get_connection();
        db.execute_unprepared(
            "UPDATE personal_agent_timeline SET read_at = updated_at \
             WHERE kind = 'owner' AND status IS NOT NULL AND status != 'queued'",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE personal_agent_timeline SET read_at = updated_at WHERE kind = 'result'",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE personal_agent_timeline SET seen_at = updated_at \
             WHERE kind IN ('reply', 'result')",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE personal_agent_dispatch SET source_batch_id = origin_batch_id \
             WHERE origin_batch_id IS NOT NULL",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for name in [
            "idx_personal_agent_timeline_updated",
            "idx_personal_agent_timeline_event",
            "idx_personal_agent_timeline_batch",
        ] {
            manager
                .drop_index(
                    Index::drop()
                        .name(name)
                        .table(PersonalAgentTimeline::Table)
                        .to_owned(),
                )
                .await?;
        }
        manager
            .alter_table(
                Table::alter()
                    .table(PersonalAgentDispatch::Table)
                    .drop_column(PersonalAgentDispatch::SourceBatchId)
                    .to_owned(),
            )
            .await?;
        for col in [
            PersonalAgentTimeline::SeenAt,
            PersonalAgentTimeline::EventId,
            PersonalAgentTimeline::ReadAt,
            PersonalAgentTimeline::ReplyTo,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(PersonalAgentTimeline::Table)
                        .drop_column(col)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
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

async fn index<T: IntoIden + 'static, C: IntoIden + 'static>(
    manager: &SchemaManager<'_>,
    name: &str,
    table: T,
    col: C,
) -> Result<(), DbErr> {
    manager
        .create_index(
            Index::create()
                .name(name)
                .table(table)
                .col(col)
                .to_owned(),
        )
        .await
}

#[derive(DeriveIden)]
enum PersonalAgentTimeline {
    Table,
    BatchId,
    UpdatedAt,
    ReplyTo,
    ReadAt,
    EventId,
    SeenAt,
}

#[derive(DeriveIden)]
enum PersonalAgentDispatch {
    Table,
    SourceBatchId,
}
