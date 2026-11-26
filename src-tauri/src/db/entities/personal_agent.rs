use sea_orm::entity::prelude::*;

/// One assistant of this data dir: its identity, its "brain" (an agent with
/// every option picked, stored exactly the way an `assistant` row stores it),
/// the agent its work runs on (stored the same way, its own: copied from the
/// brain when it was made, if so, and on its own since) and its settings.
/// The primary assistant — the personal agent there was first — is one row
/// (`kind = primary`, at most one undeleted, by a partial unique index);
/// workers are any number more, among them the assistants of the
/// collaboration settings made workers on upgrade (`legacy_assistant_*`).
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
    /// The brain's agent, its wire slug. `None` (and the other two with it)
    /// for an assistant converted on upgrade while there is no primary yet:
    /// it is given a copy of the primary's when there is one.
    #[sea_orm(column_type = "Text", nullable)]
    pub agent_type: Option<String>,
    /// JSON `AgentDelegationDefaults`, complete against `label_snapshot`.
    #[sea_orm(column_type = "Text", nullable)]
    pub agent_options: Option<String>,
    /// JSON `AssistantLabelSnapshot`.
    #[sea_orm(column_type = "Text", nullable)]
    pub label_snapshot: Option<String>,
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
    /// The agent its work runs on — dispatches, an @ in a conversation —
    /// its wire slug.
    #[sea_orm(column_type = "Text")]
    pub work_agent_type: String,
    /// JSON `AgentDelegationDefaults`, complete against `work_label_snapshot`.
    #[sea_orm(column_type = "Text")]
    pub work_agent_options: String,
    /// JSON `AssistantLabelSnapshot`.
    #[sea_orm(column_type = "Text")]
    pub work_label_snapshot: String,
    /// What every session its work runs in is told first; the brain does not
    /// read it.
    #[sea_orm(column_type = "Text", nullable)]
    pub work_instructions: Option<String>,
    /// Its persona's first paragraph, while its working directory is not
    /// made yet: written into SOUL.md when it is (`None`: the default one).
    #[sea_orm(column_type = "Text", nullable)]
    pub seed_persona: Option<String>,
    /// Bumped by every write of `seed_persona`: the directory made records
    /// the one it wrote, and only that one is cleared.
    pub seed_version: i32,
    /// Whether its working directory is made. A worker converted on upgrade
    /// or imported has none until it is first needed.
    pub workdir_ready: bool,
    /// The assistant of the collaboration settings it was converted from:
    /// what old links (`codeg://assistant/<id>`) name.
    pub legacy_assistant_id: Option<i32>,
    /// Its uid, or the uid of the sync package entry that made it: what a
    /// sync package names it by.
    #[sea_orm(column_type = "Text", nullable)]
    pub legacy_assistant_uid: Option<String>,
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
