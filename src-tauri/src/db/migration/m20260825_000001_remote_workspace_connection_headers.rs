use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Extra HTTP headers the desktop client sends on every request to
        // this connection. A JSON array of `{"name","value"}` objects.
        manager
            .alter_table(
                Table::alter()
                    .table(RemoteWorkspaceConnection::Table)
                    .add_column(
                        ColumnDef::new(RemoteWorkspaceConnection::Headers)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(RemoteWorkspaceConnection::Table)
                    .drop_column(RemoteWorkspaceConnection::Headers)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum RemoteWorkspaceConnection {
    Table,
    Headers,
}
