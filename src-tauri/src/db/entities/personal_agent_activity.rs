use sea_orm::entity::prelude::*;

/// When the owner was in codeg (1.12): the minutes they were active in one
/// five-minute slot of one local day. The account's, not an assistant's.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_activity")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// The owner's local date, `YYYY-MM-DD`.
    #[sea_orm(column_type = "Text")]
    pub day: String,
    /// The slot of the day, 0..=287 (00:00, 00:05, …).
    pub slot: i32,
    /// Minutes active in it, 0..=5.
    pub count: i32,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
