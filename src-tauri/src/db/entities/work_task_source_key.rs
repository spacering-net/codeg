use sea_orm::entity::prelude::*;

/// One work item a forge-sourced task handles: the item's canonical source key
/// (`forge::source_key` output) and its place in the task's own list.
///
/// The ONLY record of which items a task carries. A task triggered from one
/// item has one row; a task the repository panel made from several related
/// issues has one per issue, the lead first. Every question of the form "which
/// tasks handle item X" — the create dedup, the resurrection guards, the
/// panel's reverse lookup, auto-processing's "has this ever had a task" — is
/// answered from here and never from `work_task.source_key`, which keeps only
/// the lead item for display.
///
/// Written in the same transaction as the task row and never changed after:
/// a task's items are frozen when it is created, the same rule its
/// `source_meta` snapshot follows. Tasks are only ever soft-deleted, so a
/// deleted task keeps its rows — which is what auto-processing's "has this
/// ever had a task" relies on. The task FK cascades for completeness.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "work_task_source_key")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub task_id: i32,
    pub source_key: String,
    /// The item's place in the task, from 0 (the lead item).
    pub position: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::work_task::Entity",
        from = "Column::TaskId",
        to = "super::work_task::Column::Id",
        on_delete = "Cascade"
    )]
    Task,
}

impl Related<super::work_task::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Task.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
