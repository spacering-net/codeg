use sea_orm::entity::prelude::*;

/// A user-registered ACP agent. See `crate::acp::custom_registry` for how a row
/// becomes launch metadata, and `crate::models::agent::AgentType::Custom` for
/// how it is referenced from conversations.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "custom_agent")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// ACP registry id — the agent's identity everywhere else in codeg.
    #[sea_orm(unique)]
    pub registry_id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// `npx` | `uvx` | `binary`.
    pub distribution_kind: String,
    /// The ACP registry `distribution` object, verbatim.
    pub spec_json: String,
    pub icon_url: Option<String>,
    /// User declaration that the agent reads the shared `.agents/skills`
    /// store — with `skills_dir`, the gate for every skills surface. See
    /// `CustomAgentDef::skills_shared_store`.
    pub skills_shared_store: bool,
    /// Absolute path of the agent's own skills directory, when declared. See
    /// `CustomAgentDef::skills_dir`.
    pub skills_dir: Option<String>,
    /// `registry` | `manual`. See `CustomAgentDef::source`.
    pub source: String,
    /// Optional command that prints the locally installed version. See
    /// `CustomAgentDef::version_probe`.
    pub version_probe: Option<String>,
    /// Whether MCP servers may be forwarded to the agent over the ACP wire.
    /// See `CustomAgentDef::supports_mcp`.
    pub supports_mcp: bool,
    /// Optional JSON declaration of the env-var names the agent reads for the
    /// shared Model Provider projection. See `CustomAgentDef::model_env`.
    pub model_env: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
