use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum TimelineKind {
    /// The owner's message.
    #[sea_orm(string_value = "owner")]
    Owner,
    /// The assistant's reply in one turn: created when the turn starts
    /// (`data.state` = `running`), settled in place when it ends with the
    /// last text the assistant wrote. `data.state` = `discarded` is a reply
    /// whose prompt never reached the agent: it is treated as absent.
    #[sea_orm(string_value = "reply")]
    Reply,
    /// A question the assistant asked, with the owner's answer.
    #[sea_orm(string_value = "question")]
    Question,
    /// A permission request, with the owner's choice.
    #[sea_orm(string_value = "permission")]
    Permission,
    /// A piece of work handed to a role assistant.
    #[sea_orm(string_value = "dispatch")]
    Dispatch,
    /// Progress of dispatched work.
    #[sea_orm(string_value = "result")]
    Result,
    /// Segment boundaries, option changes, reconnects, compactions.
    #[sea_orm(string_value = "marker")]
    Marker,
    /// A native card codeg wrote itself — a proposal waiting for the owner,
    /// say; its state is a `personal_agent_notice` row (`ref_id`).
    #[sea_orm(string_value = "notice")]
    Notice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum OwnerStatus {
    #[sea_orm(string_value = "queued")]
    Queued,
    #[sea_orm(string_value = "delivered")]
    Delivered,
    #[sea_orm(string_value = "answered")]
    Answered,
    /// The turn carrying it never ended on its own; offered for resending.
    #[sea_orm(string_value = "interrupted")]
    Interrupted,
}

/// One row of the personal agent's timeline. `id` is the global order.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_timeline")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub segment_id: Option<i32>,
    pub batch_id: Option<i32>,
    pub kind: TimelineKind,
    /// Owner rows only.
    pub status: Option<OwnerStatus>,
    #[sea_orm(column_type = "Text")]
    pub body: String,
    /// JSON, shaped per kind.
    #[sea_orm(column_type = "Text", nullable)]
    pub data: Option<String>,
    pub dispatch_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub ref_id: Option<String>,
    /// The row this one quotes.
    pub reply_to: Option<i32>,
    /// When the assistant started on it (owner messages and result cards);
    /// `None` is unread.
    pub read_at: Option<DateTimeUtc>,
    /// The event a result card stands for.
    pub event_id: Option<i32>,
    /// When the owner saw it (an assistant reply once it settled, a result
    /// card); `None` is new to the owner.
    pub seen_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    /// The assistant it belongs to (`personal_agent.id`).
    pub bot_id: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
