use sea_orm::entity::prelude::*;

/// A Codeg Web sign-in waiting for the browser to come back from SpaceRing
/// (`srn::web`, `m20261116_000001_srn_web`). The callback takes the row with
/// `DELETE … RETURNING`, so a sign-in completes once at most.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "srn_web_logins")]
pub struct Model {
    /// SHA-256 (hex) of the flow's `state`.
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub state_hash: String,
    /// SHA-256 (hex) of the flow cookie (`__Host-codeg_srn_flow`) the sign-in
    /// is bound to.
    #[sea_orm(column_type = "Text")]
    pub flow_hash: String,
    /// The PKCE verifier, sealed.
    #[sea_orm(column_type = "Text")]
    pub verifier: String,
    /// SpaceRing's request ID, sealed: what the authorization page's address
    /// carries in its fragment.
    #[sea_orm(column_type = "Text")]
    pub request_id: String,
    pub created_at: DateTimeUtc,
    pub expires_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
