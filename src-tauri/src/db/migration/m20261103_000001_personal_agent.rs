use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // personal_agent: the one long-lived assistant this data dir runs —
        // its identity, its "brain" (the agent it runs on with every option
        // picked, the same shape an `assistant` row stores) and its settings.
        // Its own table rather than a kind of `assistant`: every reader of that
        // table (the mention panel, the delegation roster, config sync,
        // reordering, the unique-name index) treats its rows as delegation
        // targets, and the personal agent must never be one.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgent::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgent::Id))
                    .col(
                        ColumnDef::new(PersonalAgent::Name)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    // JSON `AssistantAvatar`.
                    .col(ColumnDef::new(PersonalAgent::Avatar).text().not_null())
                    // The agent's wire slug (a built-in or `custom:<id>`).
                    .col(ColumnDef::new(PersonalAgent::AgentType).text().not_null())
                    // JSON `AgentDelegationDefaults`, complete against
                    // `label_snapshot`, exactly as an assistant stores it.
                    .col(
                        ColumnDef::new(PersonalAgent::AgentOptions)
                            .text()
                            .not_null(),
                    )
                    // JSON `AssistantLabelSnapshot`.
                    .col(
                        ColumnDef::new(PersonalAgent::LabelSnapshot)
                            .text()
                            .not_null(),
                    )
                    // JSON `PersonalAgentSettings`: auto-compaction threshold
                    // and command, handoff budget, dispatch concurrency.
                    .col(
                        ColumnDef::new(PersonalAgent::Settings)
                            .text()
                            .not_null()
                            .default("{}"),
                    )
                    // The working directory the owner picked; NULL is the
                    // default `<data dir>/personal-agent`.
                    .col(ColumnDef::new(PersonalAgent::Workdir).text().null())
                    // The hidden `personal` folder row backing the working
                    // directory (conversations must hang off a folder).
                    .col(ColumnDef::new(PersonalAgent::FolderId).integer().null())
                    .col(
                        ColumnDef::new(PersonalAgent::Revision)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ts(PersonalAgent::CreatedAt))
                    .col(ts(PersonalAgent::UpdatedAt))
                    .to_owned(),
            )
            .await?;

        // personal_agent_segment: one underlying agent session. Exactly one
        // is open (`ended_at IS NULL`) at a time; a new one starts on a brain
        // switch, a working-directory change, the owner's "new session", a
        // failed resume, or a context overflow compaction cannot fix.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentSegment::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentSegment::Id))
                    .col(ColumnDef::new(PersonalAgentSegment::Seq).integer().not_null())
                    .col(ColumnDef::new(PersonalAgentSegment::AgentType).text().not_null())
                    // JSON snapshot of the brain this segment runs on.
                    .col(ColumnDef::new(PersonalAgentSegment::AgentOptions).text().not_null())
                    .col(ColumnDef::new(PersonalAgentSegment::ConversationId).integer().null())
                    .col(ColumnDef::new(PersonalAgentSegment::AgentSessionId).text().null())
                    .col(ColumnDef::new(PersonalAgentSegment::StartReason).text().not_null())
                    .col(ColumnDef::new(PersonalAgentSegment::EndReason).text().null())
                    // Set while a switch is waiting for the next delivery: the
                    // reason the NEXT segment will start with.
                    .col(ColumnDef::new(PersonalAgentSegment::PendingReason).text().null())
                    .col(ts(PersonalAgentSegment::StartedAt))
                    .col(
                        ColumnDef::new(PersonalAgentSegment::EndedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    // JSON `{used, size}` at the end of the segment.
                    .col(ColumnDef::new(PersonalAgentSegment::UsageAtEnd).text().null())
                    .col(ColumnDef::new(PersonalAgentSegment::HandoffSize).integer().null())
                    .col(counter(PersonalAgentSegment::CompactionsAuto))
                    .col(counter(PersonalAgentSegment::CompactionsManual))
                    .col(counter(PersonalAgentSegment::CompactionsAgent))
                    .col(
                        ColumnDef::new(PersonalAgentSegment::AutoCompactPaused)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    // Fingerprint of the persona and rules files at the end of
                    // the last turn, to notice edits made outside codeg.
                    .col(ColumnDef::new(PersonalAgentSegment::PersonaDigest).text().null())
                    // JSON `SegmentState`: what the next batch owes the agent
                    // (state card, persona update) and the compaction streaks.
                    .col(
                        ColumnDef::new(PersonalAgentSegment::State)
                            .text()
                            .not_null()
                            .default("{}"),
                    )
                    .to_owned(),
            )
            .await?;

        // personal_agent_batch: one prompt the engine sent — a delivery of
        // queued input, or a compaction command. Recovery after a restart
        // reads it to tell an interrupted delivery from an interrupted
        // compaction.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentBatch::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentBatch::Id))
                    .col(ColumnDef::new(PersonalAgentBatch::SegmentId).integer().not_null())
                    // 'delivery' | 'compaction'
                    .col(ColumnDef::new(PersonalAgentBatch::Kind).text().not_null())
                    // 'running' | 'completed' | 'interrupted' | 'failed' | 'canceled'
                    .col(ColumnDef::new(PersonalAgentBatch::Status).text().not_null())
                    .col(ColumnDef::new(PersonalAgentBatch::StopReason).text().null())
                    // JSON: which frames rode along and why.
                    .col(ColumnDef::new(PersonalAgentBatch::Detail).text().null())
                    .col(ColumnDef::new(PersonalAgentBatch::Error).text().null())
                    .col(ts(PersonalAgentBatch::StartedAt))
                    .col(
                        ColumnDef::new(PersonalAgentBatch::EndedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        index(manager, "idx_personal_agent_batch_status", PersonalAgentBatch::Table, PersonalAgentBatch::Status).await?;

        // personal_agent_timeline: the assistant's only outward record, in id
        // order across segments — the owner's messages, the replies, questions
        // and permission requests with their answers, dispatch and result
        // cards, and markers. Stored in full: the agents' own session files are
        // never copied and may be cleaned up by their CLIs.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentTimeline::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentTimeline::Id))
                    .col(ColumnDef::new(PersonalAgentTimeline::SegmentId).integer().null())
                    .col(ColumnDef::new(PersonalAgentTimeline::BatchId).integer().null())
                    // owner | reply | question | permission | dispatch | result | marker
                    .col(ColumnDef::new(PersonalAgentTimeline::Kind).text().not_null())
                    // owner rows: queued | delivered | answered | interrupted
                    .col(ColumnDef::new(PersonalAgentTimeline::Status).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentTimeline::Body)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    // JSON, shaped per kind.
                    .col(ColumnDef::new(PersonalAgentTimeline::Data).text().null())
                    .col(ColumnDef::new(PersonalAgentTimeline::DispatchId).integer().null())
                    // A question / permission request id, for its answer.
                    .col(ColumnDef::new(PersonalAgentTimeline::RefId).text().null())
                    .col(ts(PersonalAgentTimeline::CreatedAt))
                    .col(ts(PersonalAgentTimeline::UpdatedAt))
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_timeline_kind_status")
                    .table(PersonalAgentTimeline::Table)
                    .col(PersonalAgentTimeline::Kind)
                    .col(PersonalAgentTimeline::Status)
                    .to_owned(),
            )
            .await?;

        // personal_agent_event: progress of dispatched work waiting to be
        // handed to the assistant. `source_key` is unique so a repeated
        // arrival records once.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentEvent::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentEvent::Id))
                    // 'dispatch_status' | 'system'
                    .col(ColumnDef::new(PersonalAgentEvent::Kind).text().not_null())
                    .col(
                        ColumnDef::new(PersonalAgentEvent::SourceKey)
                            .text()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(PersonalAgentEvent::CoalesceKey).text().null())
                    .col(ColumnDef::new(PersonalAgentEvent::Summary).text().not_null())
                    .col(ColumnDef::new(PersonalAgentEvent::Payload).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentEvent::Wake)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    // 'pending' | 'delivered' | 'done'
                    .col(ColumnDef::new(PersonalAgentEvent::State).text().not_null())
                    .col(ColumnDef::new(PersonalAgentEvent::BatchId).integer().null())
                    // How many times an interrupted delivery put it back.
                    .col(counter(PersonalAgentEvent::Requeues))
                    // The interrupted batch it was put back from.
                    .col(ColumnDef::new(PersonalAgentEvent::RequeuedFrom).integer().null())
                    .col(ts(PersonalAgentEvent::CreatedAt))
                    .col(ts(PersonalAgentEvent::UpdatedAt))
                    .to_owned(),
            )
            .await?;
        index(manager, "idx_personal_agent_event_state", PersonalAgentEvent::Table, PersonalAgentEvent::State).await?;

        // personal_agent_item: the assistant's ledger of open matters.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentItem::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentItem::Id))
                    // dispatch | reminder | followup | question
                    .col(ColumnDef::new(PersonalAgentItem::Kind).text().not_null())
                    .col(ColumnDef::new(PersonalAgentItem::DispatchId).integer().null())
                    // open | waiting | done | dropped
                    .col(ColumnDef::new(PersonalAgentItem::Status).text().not_null())
                    // owner | agent | time | external
                    .col(ColumnDef::new(PersonalAgentItem::WaitsFor).text().null())
                    .col(ColumnDef::new(PersonalAgentItem::Summary).text().not_null())
                    .col(ColumnDef::new(PersonalAgentItem::OnDone).text().null())
                    .col(ColumnDef::new(PersonalAgentItem::OriginTimelineId).integer().null())
                    .col(ts(PersonalAgentItem::CreatedAt))
                    .col(ts(PersonalAgentItem::UpdatedAt))
                    .to_owned(),
            )
            .await?;
        index(manager, "idx_personal_agent_item_status", PersonalAgentItem::Table, PersonalAgentItem::Status).await?;

        // personal_agent_dispatch: one piece of work handed to a role
        // assistant, as a kanban task, a chat-mode conversation, or a work
        // conversation in a project's checkout. `executor_snapshot` freezes the
        // assistant's configuration at dispatch time.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentDispatch::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentDispatch::Id))
                    // task | chat | session
                    .col(ColumnDef::new(PersonalAgentDispatch::Mode).text().not_null())
                    .col(
                        ColumnDef::new(PersonalAgentDispatch::ExecutorAssistantId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentDispatch::ExecutorSnapshot)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PersonalAgentDispatch::FolderId).integer().null())
                    // task only: 'change' | 'report'
                    .col(ColumnDef::new(PersonalAgentDispatch::Deliverable).text().null())
                    .col(ColumnDef::new(PersonalAgentDispatch::Title).text().not_null())
                    .col(ColumnDef::new(PersonalAgentDispatch::Prompt).text().not_null())
                    .col(ColumnDef::new(PersonalAgentDispatch::WorkTaskId).integer().null())
                    .col(ColumnDef::new(PersonalAgentDispatch::ConversationId).integer().null())
                    .col(ColumnDef::new(PersonalAgentDispatch::ConnectionId).text().null())
                    .col(ColumnDef::new(PersonalAgentDispatch::State).text().not_null())
                    .col(ColumnDef::new(PersonalAgentDispatch::ResultExcerpt).text().null())
                    .col(ColumnDef::new(PersonalAgentDispatch::Error).text().null())
                    .col(ColumnDef::new(PersonalAgentDispatch::OriginBatchId).integer().null())
                    .col(ColumnDef::new(PersonalAgentDispatch::OnDone).text().null())
                    // Turns tracked to an end on a dispatched conversation.
                    .col(counter(PersonalAgentDispatch::Turns))
                    // A follow-up waiting for a free session slot.
                    .col(ColumnDef::new(PersonalAgentDispatch::Followup).text().null())
                    .col(ts(PersonalAgentDispatch::CreatedAt))
                    .col(ts(PersonalAgentDispatch::UpdatedAt))
                    .col(
                        ColumnDef::new(PersonalAgentDispatch::FinishedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        index(manager, "idx_personal_agent_dispatch_state", PersonalAgentDispatch::Table, PersonalAgentDispatch::State)
            .await?;
        index(
            manager,
            "idx_personal_agent_dispatch_work_task",
            PersonalAgentDispatch::Table,
            PersonalAgentDispatch::WorkTaskId,
        )
        .await?;
        index(
            manager,
            "idx_personal_agent_dispatch_conversation",
            PersonalAgentDispatch::Table,
            PersonalAgentDispatch::ConversationId,
        )
        .await?;

        // work_task.personal_agent_dispatch_id: the dispatch that created the
        // task. Such a task never auto-merges — its prompt was written by an
        // agent, the same reason forge-sourced tasks are excluded. Not a
        // foreign key, like the other provenance columns.
        manager
            .alter_table(
                Table::alter()
                    .table(WorkTask::Table)
                    .add_column(
                        ColumnDef::new(WorkTask::PersonalAgentDispatchId)
                            .integer()
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
                    .table(WorkTask::Table)
                    .drop_column(WorkTask::PersonalAgentDispatchId)
                    .to_owned(),
            )
            .await?;
        for table in [
            PersonalAgentDispatch::Table.into_iden(),
            PersonalAgentItem::Table.into_iden(),
            PersonalAgentEvent::Table.into_iden(),
            PersonalAgentTimeline::Table.into_iden(),
            PersonalAgentBatch::Table.into_iden(),
            PersonalAgentSegment::Table.into_iden(),
            PersonalAgent::Table.into_iden(),
        ] {
            manager
                .drop_table(Table::drop().table(table).if_exists().to_owned())
                .await?;
        }
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

fn counter<T: IntoIden>(col: T) -> ColumnDef {
    ColumnDef::new(col).integer().not_null().default(0).to_owned()
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
enum PersonalAgent {
    Table,
    Id,
    Name,
    Avatar,
    AgentType,
    AgentOptions,
    LabelSnapshot,
    Settings,
    Workdir,
    FolderId,
    Revision,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentSegment {
    Table,
    Id,
    Seq,
    AgentType,
    AgentOptions,
    ConversationId,
    AgentSessionId,
    StartReason,
    EndReason,
    PendingReason,
    StartedAt,
    EndedAt,
    UsageAtEnd,
    HandoffSize,
    CompactionsAuto,
    CompactionsManual,
    CompactionsAgent,
    AutoCompactPaused,
    PersonaDigest,
    State,
}

#[derive(DeriveIden)]
enum PersonalAgentBatch {
    Table,
    Id,
    SegmentId,
    Kind,
    Status,
    StopReason,
    Detail,
    Error,
    StartedAt,
    EndedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentTimeline {
    Table,
    Id,
    SegmentId,
    BatchId,
    Kind,
    Status,
    Body,
    Data,
    DispatchId,
    RefId,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentEvent {
    Table,
    Id,
    Kind,
    SourceKey,
    CoalesceKey,
    Summary,
    Payload,
    Wake,
    State,
    BatchId,
    Requeues,
    RequeuedFrom,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentItem {
    Table,
    Id,
    Kind,
    DispatchId,
    Status,
    WaitsFor,
    Summary,
    OnDone,
    OriginTimelineId,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentDispatch {
    Table,
    Id,
    Mode,
    ExecutorAssistantId,
    ExecutorSnapshot,
    FolderId,
    Deliverable,
    Title,
    Prompt,
    WorkTaskId,
    ConversationId,
    ConnectionId,
    State,
    ResultExcerpt,
    Error,
    OriginBatchId,
    OnDone,
    Turns,
    Followup,
    CreatedAt,
    UpdatedAt,
    FinishedAt,
}

#[derive(DeriveIden)]
enum WorkTask {
    Table,
    PersonalAgentDispatchId,
}
