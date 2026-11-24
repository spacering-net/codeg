use sea_orm::entity::prelude::*;

/// One thing the time machine finds (8.2): a timeline row, a message between
/// assistants, a turn of a conversation (the owner's input or the agent's
/// last answer), or a board task. `personal_agent_history_fts` indexes its
/// body.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_history_doc")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// `timeline`, `message`, `session` or `task`.
    #[sea_orm(column_type = "Text")]
    pub source: String,
    /// The row, message, conversation or task.
    pub ref_id: i32,
    /// Within a conversation, its turn or `title`; empty otherwise.
    #[sea_orm(column_type = "Text")]
    pub part: String,
    /// `owner`, `assistant`, `agent`, `codeg`, `message`, `task`, `title`.
    #[sea_orm(column_type = "Text")]
    pub role: String,
    pub bot_id: Option<i32>,
    pub peer_bot_id: Option<i32>,
    pub folder_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub agent_type: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub title: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub body: String,
    /// 3 the assistants' own, 2 the rest, 1 what automations, the board and
    /// dispatches made.
    pub weight: i32,
    pub at: DateTimeUtc,
    /// The timeline row a hit opens at.
    pub row_id: Option<i32>,
    /// The conversation a hit opens.
    pub conversation_id: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
