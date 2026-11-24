use sea_orm::entity::prelude::*;

/// Something that happened in codeg's coding work, recorded once (6.9):
/// handed-out work settling, a board task moving, a session starting to
/// wait on the owner, a watched pull request changing. Routines with an
/// event trigger read them in order.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_signal")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// One of [`crate::personal_agent::signals::KINDS`].
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    /// Its identity: the same thing is recorded once.
    #[sea_orm(column_type = "Text", unique)]
    pub key: String,
    /// The assistant it is about, when it is one's.
    pub bot_id: Option<i32>,
    /// The project it happened in.
    pub folder_id: Option<i32>,
    #[sea_orm(column_type = "Text")]
    pub facts: String,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
