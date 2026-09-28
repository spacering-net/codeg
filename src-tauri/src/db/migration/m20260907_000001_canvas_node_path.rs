use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // One column for the two filesystem-bound node kinds the board gains:
        // `file` (an absolute file path, rendered read-only on the card) and
        // `terminal` (the working directory its PTY is spawned in). Both answer
        // the same question — "which place on disk is this card about" — so they
        // share one column rather than growing a near-duplicate pair that every
        // read path would then have to coalesce.
        //
        // Nullable with no default: every pre-existing row is a region / pinned
        // card / note, none of which is bound to a path, so "absent" is the
        // correct value for all of them and no backfill is needed. The
        // kind-specific requirement (present and non-empty for `file` and
        // `terminal`, absent for everything else) is enforced at the
        // `canvas_service` write chokepoint, where every other cross-column
        // invariant on this table already lives.
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasNode::Table)
                    .add_column(ColumnDef::new(CanvasNode::Path).text().null())
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasNode::Table)
                    .drop_column(CanvasNode::Path)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum CanvasNode {
    Table,
    Path,
}
