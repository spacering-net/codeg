use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_context")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub conversation_id: i32,
    pub brief: String,
    pub brief_updated_at: Option<DateTimeUtc>,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}
