use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Three columns, one migration — they land together because they are one
        // product change: regions stop being "a bag that grows downwards" and
        // become a bindable, dimensioned grid.
        //
        // `folder_group_id` backs the new `kind = "group"` region, which mirrors
        // the sidebar's folder groups (`m20260829_000001_folder_group`). SOFT
        // reference, exactly like `folder_id`: groups are hard-deleted, but a
        // region pointing at a vanished group must survive as a visible
        // "unresolved" frame the user can remove or re-bind, not disappear
        // silently — and a group re-created with the same id revives it.
        //
        // `grid_columns` / `grid_rows` are the region's DEFAULT grid shape.
        // 0 means "auto": columns derive from the region width (the pre-existing
        // behaviour) and rows are capped by the frontend's MAX_VISIBLE_MEMBERS.
        // A non-zero value pins that axis, which is what makes a resize step by
        // whole cards instead of pixels. NOT NULL + default 0 so every existing
        // row reads as "auto" without a backfill pass.
        // One ALTER per column: SQLite's ALTER TABLE takes a single option per
        // statement, and sea-query panics rather than splitting them for us.
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasNode::Table)
                    .add_column(ColumnDef::new(CanvasNode::FolderGroupId).integer().null())
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasNode::Table)
                    .add_column(
                        ColumnDef::new(CanvasNode::GridColumns)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasNode::Table)
                    .add_column(
                        ColumnDef::new(CanvasNode::GridRows)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;

        // "Which regions bind this group" runs whenever a group is renamed or
        // deleted, on the same hot path as the folder-region lookup that already
        // has an index.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_canvas_node_folder_group_id")
                    .table(CanvasNode::Table)
                    .col(CanvasNode::FolderGroupId)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .if_exists()
                    .name("idx_canvas_node_folder_group_id")
                    .table(CanvasNode::Table)
                    .to_owned(),
            )
            .await?;
        for column in [
            CanvasNode::FolderGroupId,
            CanvasNode::GridColumns,
            CanvasNode::GridRows,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(CanvasNode::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum CanvasNode {
    Table,
    FolderGroupId,
    GridColumns,
    GridRows,
}
