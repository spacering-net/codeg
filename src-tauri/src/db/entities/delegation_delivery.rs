use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "delegation_delivery")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub child_conversation_id: i32,
    pub parent_conversation_id: i32,
    pub first_turn_id: String,
    pub notify_mode: String,
    pub follow: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}
