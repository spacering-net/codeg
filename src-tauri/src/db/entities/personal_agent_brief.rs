use sea_orm::entity::prelude::*;

/// A morning brief or a day's wrap-up (6.4, 6.5).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_brief")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// The assistant that writes it: the primary.
    pub bot_id: i32,
    /// `brief` or `wrap`.
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    /// The owner's day it is for, `YYYY-MM-DD` (a day runs from 04:00).
    #[sea_orm(column_type = "Text")]
    pub day: String,
    /// One per day for a brief and for the wrap-up codeg brings; each one
    /// the owner asks for has its own.
    #[sea_orm(column_type = "Text")]
    pub key: String,
    /// `preparing` (its assistant is woken for it), `ready` (written, not
    /// yet brought to the owner), `delivered`, `empty` (nothing to say: not
    /// written), `native` (codeg wrote it itself, not yet brought),
    /// `stopped` (the owner stopped its turn), `failed`.
    #[sea_orm(column_type = "Text")]
    pub state: String,
    /// What it covers from.
    pub since: DateTimeUtc,
    /// JSON: the materials codeg gathered (`brief::Material`).
    #[sea_orm(column_type = "Text", nullable)]
    pub material: Option<String>,
    pub event_id: Option<i32>,
    /// The delivery that writes it.
    pub batch_id: Option<i32>,
    /// What the owner sees: the reply, or codeg's own card.
    pub row_id: Option<i32>,
    /// JSON `{ cards, dispatches, messages }`: what the owner had done
    /// tonight from a wrap-up.
    #[sea_orm(column_type = "Text", nullable)]
    pub tonight: Option<String>,
    pub created_at: DateTimeUtc,
    pub ready_at: Option<DateTimeUtc>,
    pub delivered_at: Option<DateTimeUtc>,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
