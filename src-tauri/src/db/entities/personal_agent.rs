use sea_orm::entity::prelude::*;

/// The personal agent of this data dir: its identity, its "brain" (an agent
/// with every option picked, stored exactly the way an `assistant` row stores
/// it) and its settings. At most one row. Not an `assistant` row on purpose —
/// see `m20261103_000001_personal_agent`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// Empty means the localized default name.
    #[sea_orm(column_type = "Text")]
    pub name: String,
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
    /// JSON `PersonalAgentSettings`.
    #[sea_orm(column_type = "Text")]
    pub settings: String,
    /// The owner's working directory; `None` is `<data dir>/personal-agent`.
    #[sea_orm(column_type = "Text", nullable)]
    pub workdir: Option<String>,
    /// The hidden `personal` folder backing the working directory.
    pub folder_id: Option<i32>,
    /// Bumped in SQL by every write.
    pub revision: i64,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
