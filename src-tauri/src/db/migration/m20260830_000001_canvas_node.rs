use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // canvas_node: one row per element on the conversation canvas — a
        // binding region (folder / agent / single conversation), a hand-curated
        // custom region, or a sticky note. One table for all five kinds because
        // they share geometry, lifecycle, ordering and the `canvas://changed`
        // side-channel; kind-specific column invariants are enforced in
        // `canvas_service`, not by the schema.
        //
        // `folder_id` / `conversation_id` are SOFT references (no FK): folders
        // and conversations soft-delete, so a cascade would never fire anyway.
        // Conversation references are scrubbed by the explicit deletion funnel
        // (`prune_for_conversations`); folder regions deliberately survive a
        // closed/deleted folder — the folder row can be reopened, at which point
        // the region comes back to life (the UI renders an "unresolved" state
        // meanwhile).
        manager
            .create_table(
                Table::create()
                    .table(CanvasNode::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(CanvasNode::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    // "folder" | "agent" | "conversation" | "custom" | "note"
                    .col(ColumnDef::new(CanvasNode::Kind).string().not_null())
                    .col(ColumnDef::new(CanvasNode::FolderId).integer())
                    .col(ColumnDef::new(CanvasNode::AgentType).text())
                    .col(ColumnDef::new(CanvasNode::ConversationId).integer())
                    // kind=custom only: JSON array of conversation ids, insertion
                    // order. Whole-node read/write, never queried per member —
                    // which is why it is a column and not a join table.
                    .col(ColumnDef::new(CanvasNode::MemberIds).text())
                    .col(ColumnDef::new(CanvasNode::Title).text())
                    // kind=note only: the note text.
                    .col(ColumnDef::new(CanvasNode::Content).text())
                    // Theme-preset color name (FolderThemeColor vocabulary).
                    .col(ColumnDef::new(CanvasNode::Color).text())
                    .col(
                        ColumnDef::new(CanvasNode::Collapsed)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(ColumnDef::new(CanvasNode::X).double().not_null())
                    .col(ColumnDef::new(CanvasNode::Y).double().not_null())
                    .col(ColumnDef::new(CanvasNode::Width).double().not_null())
                    .col(ColumnDef::new(CanvasNode::Height).double().not_null())
                    .col(
                        ColumnDef::new(CanvasNode::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CanvasNode::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // Deletion-funnel scans: "which nodes pin this conversation" runs on
        // every conversation delete, so it must not be a table scan.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_canvas_node_conversation_id")
                    .table(CanvasNode::Table)
                    .col(CanvasNode::ConversationId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_canvas_node_folder_id")
                    .table(CanvasNode::Table)
                    .col(CanvasNode::FolderId)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(CanvasNode::Table).if_exists().to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum CanvasNode {
    Table,
    Id,
    Kind,
    FolderId,
    AgentType,
    ConversationId,
    MemberIds,
    Title,
    Content,
    Color,
    Collapsed,
    X,
    Y,
    Width,
    Height,
    CreatedAt,
    UpdatedAt,
}
