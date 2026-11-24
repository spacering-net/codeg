use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // folder_group: a named, optionally colored container the user drops
        // workspace folders into, so a long sidebar can be split into
        // "work / open source / scratch". Purely a sidebar-organisation concept —
        // nothing about a conversation, cwd or agent resolution consults it.
        //
        // HARD-deleted (no `deleted_at`, unlike `folder`): the only thing that
        // ever references a group is `folder.group_id`, and deleting a group
        // clears that on its members rather than taking them with it. A
        // tombstone would keep an invisible row claiming folders forever.
        manager
            .create_table(
                Table::create()
                    .table(FolderGroup::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(FolderGroup::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(FolderGroup::Name).text().not_null())
                    // One of the shared theme colors, or "inherit" (use the app
                    // theme) — the same vocabulary as `folder.color`.
                    .col(
                        ColumnDef::new(FolderGroup::Color)
                            .text()
                            .not_null()
                            .default("inherit"),
                    )
                    // Position among TOP-LEVEL siblings. Deliberately the same
                    // numeric space as `folder.sort_order` for ungrouped
                    // folders: that shared sequence is exactly what lets groups
                    // and loose folders interleave in one sidebar list.
                    .col(
                        ColumnDef::new(FolderGroup::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FolderGroup::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(FolderGroup::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // Which group a folder sits in; NULL = top level. Nullable, no default,
        // no FK — matches every other folder column added via ALTER TABLE. A
        // dangling id (group hard-deleted out from under it) is tolerated by the
        // reader, which falls the folder back to top level.
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .add_column(ColumnDef::new(Folder::GroupId).integer().null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_folder_group_id")
                    .table(Folder::Table)
                    .col(Folder::GroupId)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .name("idx_folder_group_id")
                    .table(Folder::Table)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .drop_column(Folder::GroupId)
                    .to_owned(),
            )
            .await?;

        manager
            .drop_table(Table::drop().table(FolderGroup::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum FolderGroup {
    Table,
    Id,
    Name,
    Color,
    SortOrder,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    GroupId,
}
