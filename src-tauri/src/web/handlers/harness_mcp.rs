//! Axum handlers mirroring `commands::harness_mcp`: installing MCP servers
//! from Harness, as a browser or a remote workspace window reaches it. The
//! agents written to are this server's.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::harness_mcp as commands;
use crate::commands::mcp::McpAppType;
use crate::harness::mcp::{
    HarnessInstalled, HarnessMcpInstallRequest, HarnessMcpInstallResult, HarnessMcpPlan,
    HarnessMcpUninstallRequest, HarnessMcpUninstallResult,
};
use crate::harness::Harness;

/// `{ itemRef, revision? }`, as the frontend names them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanParams {
    pub item_ref: String,
    #[serde(default)]
    pub revision: Option<u64>,
}

/// `harness_mcp_install`'s arguments: `{ itemRef, revision, optionId,
/// values?, key, agents, replace?, stateSha256, basis?, acceptYanked? }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallParams {
    pub item_ref: String,
    pub revision: u64,
    pub option_id: String,
    #[serde(default)]
    pub values: Option<BTreeMap<String, String>>,
    pub key: String,
    pub agents: Vec<McpAppType>,
    #[serde(default)]
    pub replace: Option<Vec<McpAppType>>,
    pub state_sha256: String,
    #[serde(default)]
    pub basis: Option<BTreeMap<McpAppType, String>>,
    #[serde(default)]
    pub accept_yanked: Option<bool>,
}

/// `{ itemId, agents?, removeChanged?, basis?, preflight? }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallParams {
    pub item_id: String,
    #[serde(default)]
    pub agents: Option<Vec<McpAppType>>,
    #[serde(default)]
    pub remove_changed: Option<Vec<McpAppType>>,
    #[serde(default)]
    pub basis: Option<BTreeMap<McpAppType, String>>,
    #[serde(default)]
    pub preflight: Option<bool>,
}

pub async fn harness_mcp_plan(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PlanParams>,
) -> Result<Json<HarnessMcpPlan>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_mcp_plan_core(&state.db, &harness, &params.item_ref, params.revision)
        .await
        .map(Json)
}

pub async fn harness_mcp_install(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<InstallParams>,
) -> Result<Json<HarnessMcpInstallResult>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    let request = HarnessMcpInstallRequest {
        item_ref: params.item_ref,
        revision: params.revision,
        option_id: params.option_id,
        values: params.values.unwrap_or_default(),
        key: params.key,
        agents: params.agents,
        replace: params.replace.unwrap_or_default(),
        state_sha256: params.state_sha256,
        basis: params.basis.unwrap_or_default(),
        accept_yanked: params.accept_yanked.unwrap_or(false),
    };
    commands::harness_mcp_install_core(&state.db, &state.emitter, &harness, request)
        .await
        .map(Json)
}

pub async fn harness_installed(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<HarnessInstalled>, AppCommandError> {
    commands::harness_installed_core(&state.db, &state.data_dir, &state.emitter)
        .await
        .map(Json)
}

pub async fn harness_mcp_uninstall(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UninstallParams>,
) -> Result<Json<HarnessMcpUninstallResult>, AppCommandError> {
    let request = HarnessMcpUninstallRequest {
        item_id: params.item_id,
        agents: params.agents,
        remove_changed: params.remove_changed.unwrap_or_default(),
        basis: params.basis.unwrap_or_default(),
        preflight: params.preflight.unwrap_or(false),
    };
    commands::harness_mcp_uninstall_core(&state.db, &state.emitter, request)
        .await
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The frontend sends camelCase argument names — the ones the desktop
    /// commands take — and snake_case agent names inside them.
    #[test]
    fn arguments_are_read_as_the_frontend_names_them() {
        let plan: PlanParams = serde_json::from_value(json!({ "itemRef": "acme/notes" })).unwrap();
        assert_eq!(plan.item_ref, "acme/notes");
        assert_eq!(plan.revision, None);
        let plan: PlanParams =
            serde_json::from_value(json!({ "itemRef": "acme/notes", "revision": 3 })).unwrap();
        assert_eq!(plan.revision, Some(3));
        assert!(serde_json::from_value::<PlanParams>(json!({ "item_ref": "acme/notes" })).is_err());

        let install: InstallParams = serde_json::from_value(json!({
            "itemRef": "acme/notes", "revision": 3, "optionId": "official:package:0:stdio",
            "values": { "env.NOTES_TOKEN": "t" }, "key": "notes",
            "agents": ["claude_code", "codex"], "replace": ["codex"],
            "stateSha256": "feed", "basis": { "claude_code": "missing", "codex": "ab12" },
            "acceptYanked": true
        }))
        .unwrap();
        assert_eq!(install.option_id, "official:package:0:stdio");
        assert_eq!(install.agents, [McpAppType::ClaudeCode, McpAppType::Codex]);
        assert_eq!(install.state_sha256, "feed");
        assert_eq!(install.basis.unwrap()[&McpAppType::Codex], "ab12");
        assert_eq!(install.accept_yanked, Some(true));
        // the optional ones may be left out
        let install: InstallParams = serde_json::from_value(json!({
            "itemRef": "acme/notes", "revision": 3, "optionId": "x", "key": "notes",
            "agents": ["gemini"], "stateSha256": "feed"
        }))
        .unwrap();
        assert!(install.values.is_none() && install.replace.is_none() && install.basis.is_none());

        let uninstall: UninstallParams = serde_json::from_value(json!({
            "itemId": "0199b0aa-0000-7000-8000-000000000001",
            "removeChanged": ["cline"], "preflight": true
        }))
        .unwrap();
        assert_eq!(uninstall.remove_changed.unwrap(), [McpAppType::Cline]);
        assert_eq!(uninstall.preflight, Some(true));
        assert!(uninstall.agents.is_none());
    }
}
