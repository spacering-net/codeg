use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "agent_setting")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub agent_type: String,
    pub registry_id: String,
    pub enabled: bool,
    pub sort_order: i32,
    pub installed_version: Option<String>,
    pub env_json: Option<String>,
    pub model_provider_id: Option<i32>,
    pub model_source: String,
    /// Last shared-catalog provider applied to one of this agent's
    /// conversations. Read by launch paths that have no conversation selection
    /// of their own (the pre-bind session, or a conversation the user has not
    /// picked a provider for yet). See the migration for why.
    pub catalog_provider_id: Option<String>,
    /// Catalog model id that went with [`Self::catalog_provider_id`].
    pub catalog_model_id: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
