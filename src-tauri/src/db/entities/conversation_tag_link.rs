use sea_orm::entity::prelude::*;

/// One tag on one conversation. The pair is the primary key, so a tag can sit
/// on a conversation at most once; both sides cascade on delete.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_tag_link")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub conversation_id: i32,
    #[sea_orm(primary_key, auto_increment = false)]
    pub tag_id: i32,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::conversation::Entity",
        from = "Column::ConversationId",
        to = "super::conversation::Column::Id",
        on_delete = "Cascade"
    )]
    Conversation,
    #[sea_orm(
        belongs_to = "super::conversation_tag::Entity",
        from = "Column::TagId",
        to = "super::conversation_tag::Column::Id",
        on_delete = "Cascade"
    )]
    Tag,
}

impl Related<super::conversation::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Conversation.def()
    }
}

impl Related<super::conversation_tag::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Tag.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
