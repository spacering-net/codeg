use sea_orm::entity::prelude::*;

/// What one of codeg's proposal rules (6.7) has seen of one thing, and
/// since when; object `""` is the rule itself (muted, lowered).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_rule_state")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    #[sea_orm(column_type = "Text")]
    pub rule: String,
    #[sea_orm(column_type = "Text")]
    pub object: String,
    pub bot_id: Option<i32>,
    pub first_seen_at: DateTimeUtc,
    pub last_seen_at: DateTimeUtc,
    /// JSON, shaped per rule.
    #[sea_orm(column_type = "Text", nullable)]
    pub data: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
