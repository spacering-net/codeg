use sea_orm::Statement;
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // canvas_board: the canvases themselves. Until now the workspace had
        // exactly ONE board — every `canvas_node` row was implicitly on it —
        // and this table is what lets a user keep several, each opened from a
        // card on the canvas list.
        //
        // `name` is NULLABLE on purpose, the same stance `canvas_node.title`
        // takes: NULL means "never named" and the client renders a localized
        // "Untitled canvas" in its place. The backend cannot localize, and the
        // board this migration creates for existing nodes is exactly such a
        // board — writing an English name into it would show English to every
        // user who never renames it. `color` uses the FolderThemeColor
        // vocabulary the nodes already use, validated in `canvas_service`.
        manager
            .create_table(
                Table::create()
                    .table(CanvasBoard::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(CanvasBoard::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(CanvasBoard::Name).text())
                    .col(ColumnDef::new(CanvasBoard::Description).text())
                    .col(ColumnDef::new(CanvasBoard::Color).text())
                    .col(
                        ColumnDef::new(CanvasBoard::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CanvasBoard::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // Which board a node lives on. A SOFT reference like every other
        // binding column on this table (no FK): deleting a board deletes its
        // nodes explicitly, in the same transaction, inside `canvas_service` —
        // the single write chokepoint that also kills a deleted terminal's
        // shell and broadcasts the removal, none of which a cascade could do.
        //
        // NOT NULL with a placeholder default because SQLite cannot add a NOT
        // NULL column without one; every existing row is re-pointed at a real
        // board just below, and every later write sets it explicitly.
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasNode::Table)
                    .add_column(
                        ColumnDef::new(CanvasNode::BoardId)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;

        // Existing nodes move onto one board, so the canvas a user already
        // built shows up on the list as a card rather than disappearing. Only
        // when there IS something to move: a database that never used the
        // canvas starts with an empty list, not with a board nobody made.
        let db = manager.get_connection();
        let backend = manager.get_database_backend();
        let existing = db
            .query_one(Statement::from_string(
                backend,
                "SELECT COUNT(*) AS n FROM canvas_node".to_owned(),
            ))
            .await?
            .map(|row| row.try_get::<i64>("", "n"))
            .transpose()?
            .unwrap_or(0);
        if existing > 0 {
            let now = chrono::Utc::now();
            let inserted = db
                .execute(
                    backend.build(
                        Query::insert()
                            .into_table(CanvasBoard::Table)
                            .columns([CanvasBoard::CreatedAt, CanvasBoard::UpdatedAt])
                            .values_panic([now.into(), now.into()]),
                    ),
                )
                .await?;
            // Fully qualified: the sea-query prelude also puts a `try_from`
            // (`ValueType`) on `i32`.
            let board_id = <i32 as TryFrom<u64>>::try_from(inserted.last_insert_id())
                .map_err(|_| DbErr::Custom("canvas board id out of range".to_owned()))?;
            manager
                .exec_stmt(
                    Query::update()
                        .table(CanvasNode::Table)
                        .value(CanvasNode::BoardId, board_id)
                        .to_owned(),
                )
                .await?;
        }

        // Every board read is "the nodes of board N": the canvas snapshot, the
        // list's per-board counts and previews, and the board delete.
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_canvas_node_board_id")
                    .table(CanvasNode::Table)
                    .col(CanvasNode::BoardId)
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
                    .name("idx_canvas_node_board_id")
                    .table(CanvasNode::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasNode::Table)
                    .drop_column(CanvasNode::BoardId)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(
                Table::drop()
                    .table(CanvasBoard::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum CanvasBoard {
    Table,
    Id,
    Name,
    Description,
    Color,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum CanvasNode {
    Table,
    BoardId,
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, EntityTrait, Statement};
    use sea_orm_migration::MigratorTrait;

    use crate::db::entities::{canvas_board, canvas_node};
    use crate::db::migration::Migrator;

    fn sql(s: &str) -> Statement {
        Statement::from_string(DbBackend::Sqlite, s.to_owned())
    }

    /// Every migration BEFORE this one, located by name rather than
    /// `total - 1` so a migration added after this file can't make the setup
    /// run this one too.
    async fn legacy_db() -> sea_orm::DatabaseConnection {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let idx = migrations
            .iter()
            .position(|m| m.name().contains("canvas_board"))
            .expect("board migration is registered");
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("legacy migrations");
        conn
    }

    async fn insert_legacy_node(conn: &sea_orm::DatabaseConnection, id: i32, kind: &str) {
        conn.execute(sql(&format!(
            "INSERT INTO canvas_node (id, kind, collapsed, grid_columns, grid_rows, \
             x, y, width, height, created_at, updated_at, content) VALUES \
             ({id}, '{kind}', 0, 0, 0, 10.0, 20.0, 200.0, 140.0, \
              '2026-09-01 00:00:00', '2026-09-01 00:00:00', NULL)"
        )))
        .await
        .expect("legacy node");
    }

    /// The canvas a user built before boards existed must come through as ONE
    /// board holding every node — and that board has to read back through the
    /// entity, timestamps included, or the list would fail on the very first
    /// launch after the upgrade.
    #[tokio::test]
    async fn existing_nodes_move_onto_one_board() {
        let conn = legacy_db().await;
        insert_legacy_node(&conn, 1, "note").await;
        insert_legacy_node(&conn, 2, "custom").await;

        Migrator::up(&conn, None).await.expect("board migration");

        let boards = canvas_board::Entity::find()
            .all(&conn)
            .await
            .expect("boards decode");
        assert_eq!(boards.len(), 1, "exactly one board for the legacy canvas");
        let board = &boards[0];
        assert_eq!(board.name, None, "unnamed: the client localizes the title");

        let nodes = canvas_node::Entity::find()
            .all(&conn)
            .await
            .expect("nodes decode");
        assert_eq!(nodes.len(), 2);
        assert!(
            nodes.iter().all(|n| n.board_id == board.id),
            "every legacy node is on the new board"
        );
    }

    /// A database that never used the canvas gets no board: the list starts
    /// empty instead of with a board the user never made.
    #[tokio::test]
    async fn an_unused_canvas_gets_no_board() {
        let conn = legacy_db().await;
        Migrator::up(&conn, None).await.expect("board migration");
        let row = conn
            .query_one(sql("SELECT COUNT(*) AS n FROM canvas_board"))
            .await
            .expect("count")
            .expect("row");
        let n: i64 = row.try_get("", "n").expect("n");
        assert_eq!(n, 0);
    }
}
