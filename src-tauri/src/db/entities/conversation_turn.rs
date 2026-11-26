use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_turn")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub turn_id: String,
    pub conversation_id: i32,
    pub state: String,
    pub result_text: Option<String>,
    pub stop_reason: Option<String>,
    pub cause_message_id: Option<String>,
    pub root_id: String,
    pub source_conversation_id: i32,
    pub hop: i32,
    pub created_at: DateTimeUtc,
    pub completed_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}
