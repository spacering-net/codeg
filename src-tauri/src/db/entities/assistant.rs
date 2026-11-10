use sea_orm::entity::prelude::*;

/// A user-defined delegation preset the composer can @-mention: an identity,
/// the agent it runs on with every option picked, and standing instructions.
///
/// The JSON columns are only ever written by `assistant_service`, which
/// validates them first; readers still tolerate a value that no longer parses
/// rather than failing the whole list. Soft-deleted: see
/// `m20261016_000001_assistant`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "assistant")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// Config sync's natural key; never changes.
    #[sea_orm(column_type = "Text", unique)]
    pub uid: String,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub description: String,
    /// JSON `AssistantAvatar`.
    #[sea_orm(column_type = "Text")]
    pub avatar: String,
    /// The agent's wire slug.
    #[sea_orm(column_type = "Text")]
    pub agent_type: String,
    /// JSON `AgentDelegationDefaults`, complete against `label_snapshot`.
    #[sea_orm(column_type = "Text")]
    pub agent_options: String,
    /// JSON `AssistantLabelSnapshot`.
    #[sea_orm(column_type = "Text")]
    pub label_snapshot: String,
    #[sea_orm(column_type = "Text")]
    pub instructions: String,
    pub enabled: bool,
    pub sort_order: i32,
    /// Bumped in SQL by every write; see the migration.
    pub revision: i64,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub deleted_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
