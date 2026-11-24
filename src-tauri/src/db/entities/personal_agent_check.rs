use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Where a check of a message stands (10.3).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, Serialize, Deserialize,
)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum FactCheckState {
    /// Handed out, not back yet.
    #[sea_orm(string_value = "checking")]
    Checking,
    /// Back, with a verdict.
    #[sea_orm(string_value = "done")]
    Done,
    /// It did not finish: failed, stopped, cut off by a restart.
    #[sea_orm(string_value = "failed")]
    Failed,
}

/// What a check found the message to be.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, Serialize, Deserialize,
)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum FactVerdict {
    #[sea_orm(string_value = "true")]
    True,
    #[sea_orm(string_value = "false")]
    False,
    #[sea_orm(string_value = "partly")]
    Partly,
    /// It could not tell — or said true or false with no evidence.
    #[sea_orm(string_value = "unsure")]
    Unsure,
}

/// One check of a message of an ordinary conversation, at the owner's
/// request.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_check")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub bot_id: i32,
    pub conversation_id: i32,
    #[sea_orm(column_type = "Text")]
    pub message_fp: String,
    /// "" when the whole message was checked.
    #[sea_orm(column_type = "Text")]
    pub quote_fp: String,
    #[sea_orm(column_type = "Text")]
    pub message: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub quote: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub asked: Option<String>,
    pub state: FactCheckState,
    pub verdict: Option<FactVerdict>,
    #[sea_orm(column_type = "Text", nullable)]
    pub evidence: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub note: Option<String>,
    pub dispatch_id: Option<i32>,
    pub notice_id: Option<i32>,
    /// When what it came to was told (its card, the brain, the owner).
    pub told_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
