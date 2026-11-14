use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Who carries a step out (7.6).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, Serialize, Deserialize,
)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    /// A work assistant: codeg writes it a message, and its answer is the
    /// step's conclusion.
    #[sea_orm(string_value = "bot")]
    Bot,
    /// An executor config: codeg dispatches the step to it.
    #[sea_orm(string_value = "assistant")]
    Assistant,
}

/// Where a step stands.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, Serialize, Deserialize,
)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    /// Not started: waiting for the steps it depends on, or for the plan.
    #[sea_orm(string_value = "pending")]
    Pending,
    /// Handed out: its dispatch or message is under way.
    #[sea_orm(string_value = "running")]
    Running,
    #[sea_orm(string_value = "done")]
    Done,
    /// Its work failed, or it could not be handed out.
    #[sea_orm(string_value = "failed")]
    Failed,
    /// Its work was canceled, or taken over by the owner.
    #[sea_orm(string_value = "canceled")]
    Canceled,
    /// The plan was stopped before it started.
    #[sea_orm(string_value = "stopped")]
    Stopped,
}

impl StepState {
    /// Can still be changed: it has not started, or its work came to
    /// nothing.
    pub fn changeable(self) -> bool {
        matches!(
            self,
            Self::Pending | Self::Failed | Self::Canceled | Self::Stopped
        )
    }
}

/// One step of a plan.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_plan_step")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub plan_id: i32,
    pub seq: i32,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    pub target_kind: TargetKind,
    pub target_id: i32,
    #[sea_orm(column_type = "Text")]
    pub target_name: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub mode: Option<String>,
    pub project_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub deliverable: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub prompt: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub done_when: Option<String>,
    /// JSON list of step numbers.
    #[sea_orm(column_type = "Text")]
    pub depends_on: String,
    pub state: StepState,
    pub confirmed: bool,
    pub dispatch_id: Option<i32>,
    pub message_id: Option<i32>,
    pub attempt: i32,
    pub failures: i32,
    #[sea_orm(column_type = "Text", nullable)]
    pub result: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error: Option<String>,
    pub started_at: Option<DateTimeUtc>,
    pub ended_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    /// The kind of work it is (7.9), handed on to its dispatch.
    #[sea_orm(column_type = "Text", nullable)]
    pub kind: Option<String>,
}

impl Model {
    /// The steps it waits for.
    pub fn deps(&self) -> Vec<i32> {
        serde_json::from_str(&self.depends_on).unwrap_or_default()
    }
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
