use sea_orm_migration::prelude::*;

/// Plans (7.6): a big piece of work split into steps, each handed to a work
/// assistant or an executor config, with what it depends on — laid out by
/// an assistant, carried out by codeg step by step as the steps it depends
/// on are done.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentPlan::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentPlan::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // The assistant that laid it out: its card is there.
                    .col(
                        ColumnDef::new(PersonalAgentPlan::BotId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PersonalAgentPlan::Title).text().not_null())
                    .col(ColumnDef::new(PersonalAgentPlan::Goal).text().null())
                    // draft | running | stuck | stopped | done | canceled
                    .col(ColumnDef::new(PersonalAgentPlan::State).text().not_null())
                    // Its card.
                    .col(ColumnDef::new(PersonalAgentPlan::NoticeId).integer().null())
                    .col(
                        ColumnDef::new(PersonalAgentPlan::OriginBatchId)
                            .integer()
                            .null(),
                    )
                    // The input it was laid out for, and where that chain
                    // started (4.11): its work is filed there.
                    .col(ColumnDef::new(PersonalAgentPlan::ForInput).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentPlan::OriginBotId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlan::OriginRowId)
                            .integer()
                            .null(),
                    )
                    .col(ColumnDef::new(PersonalAgentPlan::ThreadId).integer().null())
                    // What it waits on when stuck, in a sentence.
                    .col(ColumnDef::new(PersonalAgentPlan::StuckReason).text().null())
                    // The changes made to it (JSON list), each with what
                    // undoes it.
                    .col(
                        ColumnDef::new(PersonalAgentPlan::Changes)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    // The news told of it (JSON): stuck once per failure,
                    // done once.
                    .col(ColumnDef::new(PersonalAgentPlan::Told).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentPlan::StartedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlan::EndedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlan::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlan::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_plan_bot_state")
                    .table(PersonalAgentPlan::Table)
                    .col(PersonalAgentPlan::BotId)
                    .col(PersonalAgentPlan::State)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentPlanStep::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::PlanId)
                            .integer()
                            .not_null(),
                    )
                    // Its number in the plan, from 1; kept when steps are
                    // added or removed.
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::Seq)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::Title)
                            .text()
                            .not_null(),
                    )
                    // bot (a work assistant) | assistant (an executor config)
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::TargetKind)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::TargetId)
                            .integer()
                            .not_null(),
                    )
                    // Its name when the step was written, for the card.
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::TargetName)
                            .text()
                            .not_null(),
                    )
                    // An executor config's: task | chat | session.
                    .col(ColumnDef::new(PersonalAgentPlanStep::Mode).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::ProjectId)
                            .integer()
                            .null(),
                    )
                    // change | report (a task's)
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::Deliverable)
                            .text()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::Prompt)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::DoneWhen)
                            .text()
                            .null(),
                    )
                    // The numbers of the steps it waits for (JSON list).
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::DependsOn)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    // pending | running | done | failed | canceled | stopped
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::State)
                            .text()
                            .not_null(),
                    )
                    // Whether the owner's "confirm first" settings are met:
                    // false waits for their click.
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::Confirmed)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    // What carries it out: a dispatch, or a message to a work
                    // assistant.
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::DispatchId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::MessageId)
                            .integer()
                            .null(),
                    )
                    // Times codeg started it.
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::Attempt)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    // Times it failed: names the assistant's turn on each.
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::Failures)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    // What it came to, or why it failed.
                    .col(ColumnDef::new(PersonalAgentPlanStep::Result).text().null())
                    .col(ColumnDef::new(PersonalAgentPlanStep::Error).text().null())
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::StartedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::EndedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentPlanStep::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_plan_step_plan")
                    .table(PersonalAgentPlanStep::Table)
                    .col(PersonalAgentPlanStep::PlanId)
                    .col(PersonalAgentPlanStep::Seq)
                    .unique()
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_plan_step_dispatch")
                    .table(PersonalAgentPlanStep::Table)
                    .col(PersonalAgentPlanStep::DispatchId)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_plan_step_message")
                    .table(PersonalAgentPlanStep::Table)
                    .col(PersonalAgentPlanStep::MessageId)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(PersonalAgentPlanStep::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(PersonalAgentPlan::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum PersonalAgentPlan {
    Table,
    Id,
    BotId,
    Title,
    Goal,
    State,
    NoticeId,
    OriginBatchId,
    ForInput,
    OriginBotId,
    OriginRowId,
    ThreadId,
    StuckReason,
    Changes,
    Told,
    StartedAt,
    EndedAt,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentPlanStep {
    Table,
    Id,
    PlanId,
    Seq,
    Title,
    TargetKind,
    TargetId,
    TargetName,
    Mode,
    ProjectId,
    Deliverable,
    Prompt,
    DoneWhen,
    DependsOn,
    State,
    Confirmed,
    DispatchId,
    MessageId,
    Attempt,
    Failures,
    Result,
    Error,
    StartedAt,
    EndedAt,
    CreatedAt,
    UpdatedAt,
}
