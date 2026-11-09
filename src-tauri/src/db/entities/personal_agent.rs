use sea_orm::entity::prelude::*;

/// One assistant of this data dir: its identity, its "brain" (an agent with
/// every option picked, stored exactly the way an `assistant` row stores it)
/// and its settings. The primary assistant — the personal agent there was
/// first — is one row (`kind = primary`, at most one undeleted, by a partial
/// unique index); workers are any number more. Not an `assistant` row on
/// purpose — see `m20261103_000001_personal_agent`; a worker is bound to one
/// (`executor_assistant_id`), the executor profile its work runs as.
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
    /// JSON: this assistant's `PersonalAgentSettings`; on the primary's row
    /// also the account's (`AccountSettings`).
    #[sea_orm(column_type = "Text")]
    pub settings: String,
    /// The owner's working directory; `None` is `<data dir>/personal-agent`
    /// for the primary, `<data dir>/personal-agent-bots/<uid>` for a worker.
    #[sea_orm(column_type = "Text", nullable)]
    pub workdir: Option<String>,
    /// The hidden `personal` folder backing the working directory.
    pub folder_id: Option<i32>,
    /// Bumped in SQL by every write.
    pub revision: i64,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub kind: BotKind,
    /// Stable; names a worker's working directory.
    #[sea_orm(column_type = "Text", nullable)]
    pub uid: Option<String>,
    /// The template a worker was made from.
    #[sea_orm(column_type = "Text", nullable)]
    pub template: Option<String>,
    /// The executor profile a worker is bound to.
    pub executor_assistant_id: Option<i32>,
    pub sort_order: i32,
    pub pinned_at: Option<DateTimeUtc>,
    #[sea_orm(column_type = "Text", nullable)]
    pub section: Option<String>,
    /// Runs as usual; never notifies, not counted on the dock.
    pub hidden: bool,
    /// No system notifications; still counted as unread.
    pub muted: bool,
    /// The owner marked it unread.
    pub unread_mark: bool,
    pub notify: bool,
    pub deleted_at: Option<DateTimeUtc>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, serde::Serialize, serde::Deserialize,
)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum BotKind {
    /// The owner's main contact: the personal agent there was first.
    #[sea_orm(string_value = "primary")]
    Primary,
    /// One more assistant, for one line of work.
    #[sea_orm(string_value = "worker")]
    Worker,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
