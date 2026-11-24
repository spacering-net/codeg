use sea_orm::entity::prelude::*;

/// One in-place agent switch of a conversation (see `acp::handoff`).
///
/// The conversation row names only its CURRENT agent and session. Each handoff
/// leaves one of these behind so the segment that lived under the previous
/// agent stays reachable: the detail read walks the rows in `seq` order, reads
/// every uncarried segment from its own agent's store, and renders a divider
/// between segments. `conversation_id` is a soft reference (conversations
/// soft-delete), matching every other cross-table reference in this schema.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_handoff")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub conversation_id: i32,
    /// Position in the conversation's chain, oldest first.
    pub seq: i32,
    /// Wire form of the agent the segment ran under (`AgentType::as_wire`).
    #[sea_orm(column_type = "Text")]
    pub from_agent_type: String,
    /// The session that segment is read from, in `from_agent_type`'s store.
    #[sea_orm(column_type = "Text", nullable)]
    pub from_external_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub to_agent_type: String,
    #[sea_orm(column_type = "Text")]
    pub to_external_id: String,
    /// `"native"` or `"summary"` (`acp::handoff::HandoffPath::as_str`).
    #[sea_orm(column_type = "Text")]
    pub path: String,
    /// The target session carries the whole prior history itself, so the
    /// earlier segment is NOT read again (it would render twice).
    pub carried: bool,
    /// User turns rendered at handoff time; where the divider goes inside a
    /// carried session, whose own store holds both halves.
    pub user_turns_before: i32,
    #[sea_orm(column_type = "Text", nullable)]
    pub note: Option<String>,
    /// The briefing the target was seeded with (summary path only).
    #[sea_orm(column_type = "Text", nullable)]
    pub briefing: Option<String>,
    /// The briefing had to drop earlier turns to fit the prompt budget.
    pub truncated: bool,
    pub created_at: DateTimeUtc,
    pub from_account_id: Option<String>,
    pub to_account_id: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub history_json: Option<String>,
    pub context_id: Option<String>,
    pub context_pending: bool,
    pub source_stats_json: Option<String>,
    pub source_model: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
