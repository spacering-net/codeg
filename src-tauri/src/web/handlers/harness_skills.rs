//! Axum handlers mirroring `commands::harness_skills`: installing skills
//! from Harness, as a browser or a remote workspace window reaches it. The
//! store and the agents linked to are this server's.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::harness_skills as commands;
use crate::harness::skills::{
    HarnessSkillInstallRequest, HarnessSkillInstallResult, HarnessSkillPlan,
    HarnessSkillUninstallRequest, HarnessSkillUninstallResult,
};
use crate::harness::Harness;
use crate::models::agent::AgentType;

/// `{ itemRef, revision?, agents? }`, as the frontend names them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanParams {
    pub item_ref: String,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub agents: Option<Vec<AgentType>>,
}

/// `harness_skill_install`'s arguments: `{ itemRef, revision, installName,
/// agents, keepAllowedTools?, stateSha256, acks?, acceptYanked? }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallParams {
    pub item_ref: String,
    pub revision: u64,
    pub install_name: String,
    pub agents: Vec<AgentType>,
    #[serde(default)]
    pub keep_allowed_tools: Option<bool>,
    pub state_sha256: String,
    #[serde(default)]
    pub acks: Option<BTreeMap<AgentType, String>>,
    #[serde(default)]
    pub accept_yanked: Option<bool>,
}

/// `{ itemId, preflight?, ack? }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallParams {
    pub item_id: String,
    #[serde(default)]
    pub preflight: Option<bool>,
    #[serde(default)]
    pub ack: Option<String>,
}

pub async fn harness_skill_plan(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PlanParams>,
) -> Result<Json<HarnessSkillPlan>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_skill_plan_core(
        &state.db,
        &harness,
        &params.item_ref,
        params.revision,
        params.agents,
    )
    .await
    .map(Json)
}

pub async fn harness_skill_install(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<InstallParams>,
) -> Result<Json<HarnessSkillInstallResult>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    let request = HarnessSkillInstallRequest {
        item_ref: params.item_ref,
        revision: params.revision,
        install_name: params.install_name,
        agents: params.agents,
        keep_allowed_tools: params.keep_allowed_tools.unwrap_or(false),
        state_sha256: params.state_sha256,
        acks: params.acks.unwrap_or_default(),
        accept_yanked: params.accept_yanked.unwrap_or(false),
    };
    commands::harness_skill_install_core(&state.emitter, &harness, request)
        .await
        .map(Json)
}

pub async fn harness_skill_uninstall(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UninstallParams>,
) -> Result<Json<HarnessSkillUninstallResult>, AppCommandError> {
    let request = HarnessSkillUninstallRequest {
        item_id: params.item_id,
        preflight: params.preflight.unwrap_or(false),
        ack: params.ack,
    };
    commands::harness_skill_uninstall_core(&state.emitter, request)
        .await
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The frontend sends camelCase argument names — the ones the desktop
    /// commands take — and the engine's agent names inside them.
    #[test]
    fn arguments_are_read_as_the_frontend_names_them() {
        let plan: PlanParams = serde_json::from_value(json!({ "itemRef": "acme/pdf" })).unwrap();
        assert_eq!(plan.item_ref, "acme/pdf");
        assert!(plan.revision.is_none() && plan.agents.is_none());
        let plan: PlanParams = serde_json::from_value(
            json!({ "itemRef": "acme/pdf", "revision": 2, "agents": ["claude_code", "custom:mine"] }),
        )
        .unwrap();
        assert_eq!(plan.revision, Some(2));
        assert_eq!(plan.agents.unwrap()[0], AgentType::ClaudeCode);

        let install: InstallParams = serde_json::from_value(json!({
            "itemRef": "acme/pdf", "revision": 3, "installName": "pdf",
            "agents": ["claude_code", "cline"], "keepAllowedTools": true,
            "stateSha256": "feed", "acks": { "cline": "ab12" }, "acceptYanked": true
        }))
        .unwrap();
        assert_eq!(install.install_name, "pdf");
        assert_eq!(install.agents, [AgentType::ClaudeCode, AgentType::Cline]);
        assert_eq!(install.acks.unwrap()[&AgentType::Cline], "ab12");
        assert_eq!(install.keep_allowed_tools, Some(true));
        let install: InstallParams = serde_json::from_value(json!({
            "itemRef": "acme/pdf", "revision": 3, "installName": "pdf",
            "agents": [], "stateSha256": "feed"
        }))
        .unwrap();
        assert!(install.acks.is_none() && install.accept_yanked.is_none());
        assert!(serde_json::from_value::<InstallParams>(json!({
            "itemRef": "acme/pdf", "revision": 3, "installName": "pdf",
            "agents": ["no_such_agent"], "stateSha256": "feed"
        }))
        .is_err());

        let uninstall: UninstallParams =
            serde_json::from_value(json!({ "itemId": "0199", "preflight": true })).unwrap();
        assert_eq!(uninstall.preflight, Some(true));
        assert!(uninstall.ack.is_none());
    }
}
