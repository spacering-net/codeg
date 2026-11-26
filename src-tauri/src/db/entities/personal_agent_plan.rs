use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Where a plan stands (7.6).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, Serialize, Deserialize,
)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum PlanState {
    /// Laid out, waiting for the owner's [Start]: they asked to see plans
    /// first, or one of its steps is what they confirm first.
    #[sea_orm(string_value = "draft")]
    Draft,
    /// codeg hands out each step once the steps it depends on are done.
    #[sea_orm(string_value = "running")]
    Running,
    /// A step failed and stayed failed after its assistant had its turn,
    /// or one was canceled: what does not wait on it still goes on.
    #[sea_orm(string_value = "stuck")]
    Stuck,
    /// The owner stopped it: no new step is handed out; those under way
    /// run to their end.
    #[sea_orm(string_value = "stopped")]
    Stopped,
    #[sea_orm(string_value = "done")]
    Done,
    /// The owner did not start it.
    #[sea_orm(string_value = "canceled")]
    Canceled,
}

impl PlanState {
    /// Still to be carried out, or looked at.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            Self::Draft | Self::Running | Self::Stuck | Self::Stopped
        )
    }
}

/// One assistant's plan.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_plan")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub bot_id: i32,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub goal: Option<String>,
    pub state: PlanState,
    pub notice_id: Option<i32>,
    pub origin_batch_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub for_input: Option<String>,
    pub origin_bot_id: Option<i32>,
    pub origin_row_id: Option<i32>,
    pub thread_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub stuck_reason: Option<String>,
    /// JSON list ([`crate::personal_agent::plans::Change`]).
    #[sea_orm(column_type = "Text")]
    pub changes: String,
    /// JSON ([`crate::personal_agent::plans::Told`]).
    #[sea_orm(column_type = "Text", nullable)]
    pub told: Option<String>,
    pub started_at: Option<DateTimeUtc>,
    pub ended_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
