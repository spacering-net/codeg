use sea_orm_migration::prelude::*;

/// More than one assistant: `personal_agent` holds one row per assistant —
/// the primary one (the personal agent there was so far) and any number of
/// workers — and every table of its records says whose a row is.
///
/// - `personal_agent` gains what tells assistants apart (kind, a stable uid
///   naming a worker's directory, its template, the executor profile a worker
///   is bound to) and what the roster keeps (order, pin, section, hidden,
///   muted, the unread mark, notifications, soft deletion). The row there was
///   becomes the primary assistant; a partial unique index lets only one
///   undeleted primary exist — before, "at most one row" was the code's word.
/// - The eight tables of its records gain `bot_id`, filled in with the
///   primary's id (with no assistant yet, they are empty). Nullable, so no
///   table is rebuilt; every write sets it from now on.
/// - Where an input came from, kept per input: an event and a dispatch name
///   the assistant and the row their chain started at and the thread they
///   are on; a dispatch also names the input it was made for.
/// - The assistants' messages to each other, and the threads those form.
///
/// `personal_agent_event.source_key` stays unique across the table: a
/// worker's keys carry a `bot<id>:` prefix, the primary's are as they were.
#[derive(DeriveMigrationName)]
pub struct Migration;

/// The tables of an assistant's records, and the index each gets on
/// `(bot_id, <col>)`.
const CHILDREN: &[(&str, Option<&str>)] = &[
    ("personal_agent_segment", Some("ended_at")),
    ("personal_agent_timeline", Some("id")),
    ("personal_agent_batch", Some("status")),
    ("personal_agent_event", Some("state")),
    ("personal_agent_item", Some("status")),
    ("personal_agent_dispatch", Some("state")),
    ("personal_agent_action", None),
    ("personal_agent_notice", Some("state")),
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        // SQLite takes one ADD COLUMN per ALTER TABLE.
        for col in [
            // primary | worker
            ColumnDef::new(PersonalAgent::Kind)
                .text()
                .not_null()
                .default("primary")
                .to_owned(),
            // Stable, names a worker's working directory.
            ColumnDef::new(PersonalAgent::Uid).text().null().to_owned(),
            // The template a worker was made from.
            ColumnDef::new(PersonalAgent::Template)
                .text()
                .null()
                .to_owned(),
            // The executor profile (`assistant` row) a worker is bound to.
            ColumnDef::new(PersonalAgent::ExecutorAssistantId)
                .integer()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgent::SortOrder)
                .integer()
                .not_null()
                .default(0)
                .to_owned(),
            ColumnDef::new(PersonalAgent::PinnedAt)
                .timestamp_with_time_zone()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgent::Section)
                .text()
                .null()
                .to_owned(),
            ColumnDef::new(PersonalAgent::Hidden)
                .boolean()
                .not_null()
                .default(false)
                .to_owned(),
            ColumnDef::new(PersonalAgent::Muted)
                .boolean()
                .not_null()
                .default(false)
                .to_owned(),
            ColumnDef::new(PersonalAgent::UnreadMark)
                .boolean()
                .not_null()
                .default(false)
                .to_owned(),
            ColumnDef::new(PersonalAgent::Notify)
                .boolean()
                .not_null()
                .default(true)
                .to_owned(),
            ColumnDef::new(PersonalAgent::DeletedAt)
                .timestamp_with_time_zone()
                .null()
                .to_owned(),
        ] {
            add_column(manager, PersonalAgent::Table, col).await?;
        }
        // Every row a uid. More than one row was never reachable (the code
        // read the lowest id): any beyond the first is set aside as deleted,
        // so the one-primary index below holds.
        db.execute_unprepared(
            "UPDATE personal_agent SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL",
        )
        .await?;
        db.execute_unprepared(
            "UPDATE personal_agent SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') \
             WHERE id != (SELECT MIN(id) FROM personal_agent) AND deleted_at IS NULL",
        )
        .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_personal_agent_uid")
                    .table(PersonalAgent::Table)
                    .col(PersonalAgent::Uid)
                    .unique()
                    .to_owned(),
            )
            .await?;
        db.execute_unprepared(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_agent_one_primary \
             ON personal_agent (kind) WHERE kind = 'primary' AND deleted_at IS NULL",
        )
        .await?;

        for (table, col) in CHILDREN {
            db.execute_unprepared(&format!(
                "ALTER TABLE {table} ADD COLUMN bot_id INTEGER NULL"
            ))
            .await?;
            db.execute_unprepared(&format!(
                "UPDATE {table} SET bot_id = (SELECT MIN(id) FROM personal_agent) \
                 WHERE bot_id IS NULL"
            ))
            .await?;
            let index = match col {
                Some(c) => format!(
                    "CREATE INDEX IF NOT EXISTS idx_{table}_bot_{c} ON {table} (bot_id, {c})"
                ),
                None => format!("CREATE INDEX IF NOT EXISTS idx_{table}_bot ON {table} (bot_id)"),
            };
            db.execute_unprepared(&index).await?;
        }

        // Where an input came from: the assistant and row its chain started
        // at, and the thread it is on.
        for table in ["personal_agent_event", "personal_agent_dispatch"] {
            for col in ["origin_bot_id", "origin_row_id", "thread_id"] {
                db.execute_unprepared(&format!(
                    "ALTER TABLE {table} ADD COLUMN {col} INTEGER NULL"
                ))
                .await?;
            }
        }
        // The input a dispatch was made for: its kind and id, as text.
        db.execute_unprepared("ALTER TABLE personal_agent_dispatch ADD COLUMN for_input TEXT NULL")
            .await?;

        // personal_agent_message: one assistant's message to another.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentMessage::Table)
                    .if_not_exists()
                    .col(pk(PersonalAgentMessage::Id))
                    .col(
                        ColumnDef::new(PersonalAgentMessage::ThreadId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentMessage::FromBotId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentMessage::ToBotId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentMessage::ReplyTo)
                            .integer()
                            .null(),
                    )
                    .col(ColumnDef::new(PersonalAgentMessage::Body).text().not_null())
                    .col(
                        ColumnDef::new(PersonalAgentMessage::WantsReply)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    // queued | delivered | replied | closed | stopped |
                    // looped | canceled
                    .col(
                        ColumnDef::new(PersonalAgentMessage::State)
                            .text()
                            .not_null()
                            .default("queued"),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentMessage::SentBatchId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentMessage::DeliveredBatchId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentMessage::OriginBotId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentMessage::OriginRowId)
                            .integer()
                            .null(),
                    )
                    .col(ColumnDef::new(PersonalAgentMessage::ForInput).text().null())
                    .col(ts(PersonalAgentMessage::CreatedAt))
                    .col(ts(PersonalAgentMessage::UpdatedAt))
                    .to_owned(),
            )
            .await?;
        db.execute_unprepared(
            "CREATE INDEX IF NOT EXISTS idx_personal_agent_message_to_state \
             ON personal_agent_message (to_bot_id, state)",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX IF NOT EXISTS idx_personal_agent_message_thread \
             ON personal_agent_message (thread_id)",
        )
        .await?;

        // personal_agent_thread: the exchange a first message starts; its id
        // is that message's.
        manager
            .create_table(
                Table::create()
                    .table(PersonalAgentThread::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PersonalAgentThread::Id)
                            .integer()
                            .not_null()
                            .primary_key(),
                    )
                    // open | stopped | looped
                    .col(
                        ColumnDef::new(PersonalAgentThread::State)
                            .text()
                            .not_null()
                            .default("open"),
                    )
                    // JSON: the back-and-forth count of each pair.
                    .col(
                        ColumnDef::new(PersonalAgentThread::Counts)
                            .text()
                            .not_null()
                            .default("{}"),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentThread::LastProgressAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentThread::OriginBotId)
                            .integer()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PersonalAgentThread::OriginRowId)
                            .integer()
                            .null(),
                    )
                    .col(ts(PersonalAgentThread::CreatedAt))
                    .col(ts(PersonalAgentThread::UpdatedAt))
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        manager
            .drop_table(Table::drop().table(PersonalAgentThread::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(PersonalAgentMessage::Table).to_owned())
            .await?;
        db.execute_unprepared("ALTER TABLE personal_agent_dispatch DROP COLUMN for_input")
            .await?;
        for table in ["personal_agent_event", "personal_agent_dispatch"] {
            for col in ["thread_id", "origin_row_id", "origin_bot_id"] {
                db.execute_unprepared(&format!("ALTER TABLE {table} DROP COLUMN {col}"))
                    .await?;
            }
        }
        for (table, col) in CHILDREN {
            let index = match col {
                Some(c) => format!("idx_{table}_bot_{c}"),
                None => format!("idx_{table}_bot"),
            };
            db.execute_unprepared(&format!("DROP INDEX IF EXISTS {index}"))
                .await?;
            db.execute_unprepared(&format!("ALTER TABLE {table} DROP COLUMN bot_id"))
                .await?;
        }
        db.execute_unprepared("DROP INDEX IF EXISTS idx_personal_agent_one_primary")
            .await?;
        db.execute_unprepared("DROP INDEX IF EXISTS idx_personal_agent_uid")
            .await?;
        for col in [
            "deleted_at",
            "notify",
            "unread_mark",
            "muted",
            "hidden",
            "section",
            "pinned_at",
            "sort_order",
            "executor_assistant_id",
            "template",
            "uid",
            "kind",
        ] {
            db.execute_unprepared(&format!("ALTER TABLE personal_agent DROP COLUMN {col}"))
                .await?;
        }
        Ok(())
    }
}

async fn add_column<T: IntoIden + 'static>(
    manager: &SchemaManager<'_>,
    table: T,
    col: ColumnDef,
) -> Result<(), DbErr> {
    manager
        .alter_table(Table::alter().table(table).add_column(col).to_owned())
        .await
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

#[derive(DeriveIden)]
enum PersonalAgent {
    Table,
    Kind,
    Uid,
    Template,
    ExecutorAssistantId,
    SortOrder,
    PinnedAt,
    Section,
    Hidden,
    Muted,
    UnreadMark,
    Notify,
    DeletedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentMessage {
    Table,
    Id,
    ThreadId,
    FromBotId,
    ToBotId,
    ReplyTo,
    Body,
    WantsReply,
    State,
    SentBatchId,
    DeliveredBatchId,
    OriginBotId,
    OriginRowId,
    ForInput,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum PersonalAgentThread {
    Table,
    Id,
    State,
    Counts,
    LastProgressAt,
    OriginBotId,
    OriginRowId,
    CreatedAt,
    UpdatedAt,
}
