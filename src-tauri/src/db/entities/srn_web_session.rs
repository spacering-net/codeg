use sea_orm::entity::prelude::*;

/// Which SRN user a browser is, for Codeg Web (`srn::web`,
/// `m20261116_000001_srn_web`). It grants nothing on the instance.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "srn_web_sessions")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// SHA-256 (hex) of the session cookie (`__Host-codeg_srn`).
    #[sea_orm(unique, column_type = "Text")]
    pub cookie_hash: String,
    /// The SRN number.
    pub srn: i64,
    /// The display name as shown (cleaned); may be empty.
    #[sea_orm(column_type = "Text")]
    pub display_name: String,
    /// `/api/avatars/<id>/<file>` on SpaceRing, or none.
    #[sea_orm(column_type = "Text", nullable)]
    pub avatar_path: Option<String>,
    /// SpaceRing's ID of the connection the token belongs to.
    #[sea_orm(column_type = "Text", nullable)]
    pub connection_id: Option<String>,
    /// The SRN token (`profile:read`), sealed.
    #[sea_orm(column_type = "Text")]
    pub token: String,
    pub created_at: DateTimeUtc,
    pub last_used_at: DateTimeUtc,
    pub last_checked_at: DateTimeUtc,
    pub last_confirmed_at: Option<DateTimeUtc>,
    /// Why the last check did not confirm the account (see the migration);
    /// none after a confirmation.
    #[sea_orm(column_type = "Text", nullable)]
    pub check_problem: Option<String>,
    pub next_check_at: DateTimeUtc,
    pub expires_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
