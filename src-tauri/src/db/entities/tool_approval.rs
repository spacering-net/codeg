use sea_orm::entity::prelude::*;

/// How a permission request was answered, keyed by the tool call it was about —
/// one row per (conversation, tool call), the latest answer winning. Written by
/// the lifecycle worker on `AcpEvent::ToolApproval`; read on every conversation
/// detail load and stamped onto the matching tool calls. See
/// `m20261022_000001_tool_approval`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "tool_approval")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub conversation_id: i32,
    #[sea_orm(column_type = "Text")]
    pub tool_call_id: String,
    /// The chosen option's ACP kind, verbatim.
    #[sea_orm(column_type = "Text")]
    pub option_kind: String,
    /// The chosen option's label in the agent's own words.
    #[sea_orm(column_type = "Text")]
    pub option_name: String,
    /// `user`, `chat_channel` or `cli_policy`.
    #[sea_orm(column_type = "Text")]
    pub origin: String,
    pub decided_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::conversation::Entity",
        from = "Column::ConversationId",
        to = "super::conversation::Column::Id",
        on_delete = "Cascade"
    )]
    Conversation,
}

impl Related<super::conversation::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Conversation.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
