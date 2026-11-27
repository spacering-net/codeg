use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_collaborator")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub source_id: i32,
    #[sea_orm(primary_key, auto_increment = false)]
    pub target_id: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
