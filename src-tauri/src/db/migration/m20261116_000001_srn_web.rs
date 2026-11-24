use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // srn_web_logins: a Codeg Web sign-in waiting for the browser to come
        // back from SpaceRing (`srn::web`). One row per sign-in started, kept
        // ten minutes; the callback takes it with `DELETE … RETURNING`, so it
        // completes once at most. `state` and the flow cookie are kept only
        // as SHA-256 (hex); the PKCE verifier and the request ID are sealed
        // (AES-256-GCM, key outside the database and outside Codeg's backup).
        manager
            .create_table(
                Table::create()
                    .table(SrnWebLogins::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SrnWebLogins::StateHash)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(SrnWebLogins::FlowHash).text().not_null())
                    .col(ColumnDef::new(SrnWebLogins::Verifier).text().not_null())
                    .col(ColumnDef::new(SrnWebLogins::RequestId).text().not_null())
                    .col(
                        ColumnDef::new(SrnWebLogins::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SrnWebLogins::ExpiresAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_srn_web_logins_flow_hash")
                    .table(SrnWebLogins::Table)
                    .col(SrnWebLogins::FlowHash)
                    .to_owned(),
            )
            .await?;

        // srn_web_sessions: which SRN user a browser is, for Codeg Web. It
        // grants nothing on the instance. The session cookie is kept only as
        // SHA-256 (hex); the SRN token is sealed. The identity (SRN number,
        // name, avatar path) is plain: it is what the status bar shows. A
        // session ends after 30 days without use, as SpaceRing's connection
        // does.
        manager
            .create_table(
                Table::create()
                    .table(SrnWebSessions::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SrnWebSessions::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SrnWebSessions::CookieHash)
                            .text()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(SrnWebSessions::Srn).big_integer().not_null())
                    .col(
                        ColumnDef::new(SrnWebSessions::DisplayName)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SrnWebSessions::AvatarPath).text().null())
                    .col(ColumnDef::new(SrnWebSessions::ConnectionId).text().null())
                    .col(ColumnDef::new(SrnWebSessions::Token).text().not_null())
                    .col(
                        ColumnDef::new(SrnWebSessions::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SrnWebSessions::LastUsedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SrnWebSessions::LastCheckedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    // When SpaceRing last confirmed the account (`/me`).
                    .col(
                        ColumnDef::new(SrnWebSessions::LastConfirmedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    // Why the last check did not confirm it: `network`,
                    // `server:<status>`, `rate_limited:<seconds>`,
                    // `invalid_response`; null after a confirmation.
                    .col(ColumnDef::new(SrnWebSessions::CheckProblem).text().null())
                    // The earliest the next `/me` may be made.
                    .col(
                        ColumnDef::new(SrnWebSessions::NextCheckAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SrnWebSessions::ExpiresAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_srn_web_sessions_expires_at")
                    .table(SrnWebSessions::Table)
                    .col(SrnWebSessions::ExpiresAt)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SrnWebSessions::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(SrnWebLogins::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SrnWebLogins {
    Table,
    StateHash,
    FlowHash,
    Verifier,
    RequestId,
    CreatedAt,
    ExpiresAt,
}

#[derive(DeriveIden)]
enum SrnWebSessions {
    Table,
    Id,
    CookieHash,
    Srn,
    DisplayName,
    AvatarPath,
    ConnectionId,
    Token,
    CreatedAt,
    LastUsedAt,
    LastCheckedAt,
    LastConfirmedAt,
    CheckProblem,
    NextCheckAt,
    ExpiresAt,
}
