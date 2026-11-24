use sea_orm::entity::prelude::*;

/// How far the time machine has read a source (8.2): for the timeline, the
/// messages and the tasks (`ref_id` 0) the last change read, `at` and the
/// row `mark`; for a conversation (`session`, `ref_id` its id) when it was
/// as it was last read.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_history_cursor")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub source: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub ref_id: i32,
    pub at: Option<DateTimeUtc>,
    pub mark: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
