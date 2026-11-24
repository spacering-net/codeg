use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // assistant: a user-defined delegation preset the composer can
        // @-mention. An identity (name, avatar, description), the agent it runs
        // on with every option that agent advertises picked explicitly, and
        // standing instructions handed to the child with its task.
        //
        // SOFT-deleted (`deleted_at`): mention links in sent messages,
        // delegation cards and delegated child rows refer to an assistant by
        // id, and must keep drawing its name and avatar after it is removed.
        manager
            .create_table(
                Table::create()
                    .table(Assistant::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Assistant::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // A v4 UUID, never changed: the natural key config sync
                    // matches rows on, so a rename on one device updates the
                    // same assistant on another instead of adding a second.
                    .col(
                        ColumnDef::new(Assistant::Uid)
                            .text()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(Assistant::Name).text().not_null())
                    .col(
                        ColumnDef::new(Assistant::Description)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    // JSON, tagged by `kind`: monogram / emoji / image.
                    .col(ColumnDef::new(Assistant::Avatar).text().not_null())
                    // The agent's wire slug (a built-in or `custom:<id>`).
                    .col(ColumnDef::new(Assistant::AgentType).text().not_null())
                    // JSON `AgentDelegationDefaults`: a COMPLETE selection —
                    // every option listed in `label_snapshot` has a value.
                    .col(ColumnDef::new(Assistant::AgentOptions).text().not_null())
                    // JSON: the option list as it was when the selection was
                    // saved, with display names, so the settings list reads
                    // without probing the agent.
                    .col(ColumnDef::new(Assistant::LabelSnapshot).text().not_null())
                    .col(
                        ColumnDef::new(Assistant::Instructions)
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .col(
                        ColumnDef::new(Assistant::Enabled)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .col(
                        ColumnDef::new(Assistant::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    // Bumped in SQL by every write. Clients keep a row only
                    // when it carries a higher revision than the one they hold,
                    // which is what stops a late reply or an out-of-order
                    // broadcast from rolling a newer row back.
                    .col(
                        ColumnDef::new(Assistant::Revision)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(Assistant::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Assistant::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Assistant::DeletedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        // One live assistant per name, case-insensitively. Partial, so a
        // deleted assistant's name is free to be taken again. NOCASE only folds
        // ASCII; the service layer's check folds the rest, and this index is the
        // backstop for two writers racing past that check.
        let conn = manager.get_connection();
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_live_name \
             ON assistant (name COLLATE NOCASE) WHERE deleted_at IS NULL"
                .to_string(),
        ))
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Assistant::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Assistant {
    Table,
    Id,
    Uid,
    Name,
    Description,
    Avatar,
    AgentType,
    AgentOptions,
    LabelSnapshot,
    Instructions,
    Enabled,
    SortOrder,
    Revision,
    CreatedAt,
    UpdatedAt,
    DeletedAt,
}
