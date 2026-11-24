use sea_orm::entity::prelude::*;

/// What number `number` of `kind` names in project `folder_id`: the item it
/// was resolved to there the first time (7.4), kept so the project's later
/// `origin` does not move it.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_watch_name")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub folder_id: i32,
    /// `pr` | `issue`
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    pub number: i64,
    pub watch_id: i32,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
