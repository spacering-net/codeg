//! Axum handlers mirroring `commands::harness_plugins`: installing,
//! updating, switching and repairing plugins from Harness, as a browser or a
//! remote workspace window reaches it. The plugin store, the skill store and
//! the agents' hosts are this server's. Each body is the Tauri command's
//! arguments, as the frontend names them (camelCase; agents by their wire
//! names); each answer is the command's.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::harness_plugins as commands;
use crate::harness::plugins::hosts::HookTrust;
use crate::harness::plugins::model::{
    HarnessPluginInstallRequest, HarnessPluginInstallResult, HarnessPluginPlan,
    HarnessPluginRepairRequest, HarnessPluginSetEnabledRequest, HarnessPluginSetHostRequest,
    HarnessPluginUninstallRequest, HarnessPluginUninstallResult, HarnessPluginUpdatePlan,
    HarnessPluginUpdateRequest, PlanMode,
};
use crate::harness::Harness;
use crate::models::agent::AgentType;

/// Skills agents' acks: by agent, by member.
type Acks = BTreeMap<AgentType, BTreeMap<String, String>>;

/// `{ itemRef, agents?, modes? }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanParams {
    pub item_ref: String,
    #[serde(default)]
    pub agents: Option<Vec<AgentType>>,
    #[serde(default)]
    pub modes: Option<BTreeMap<AgentType, PlanMode>>,
}

/// `{ itemRef, revision, installName, hosts, stateSha256, consentExec?,
/// acks?, expertsAcks?, acceptYanked? }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallParams {
    pub item_ref: String,
    pub revision: u64,
    pub install_name: String,
    pub hosts: BTreeMap<AgentType, PlanMode>,
    pub state_sha256: String,
    #[serde(default)]
    pub consent_exec: Option<String>,
    #[serde(default)]
    pub acks: Option<Acks>,
    #[serde(default)]
    pub experts_acks: Option<BTreeMap<AgentType, String>>,
    #[serde(default)]
    pub accept_yanked: Option<bool>,
}

impl From<InstallParams> for HarnessPluginInstallRequest {
    fn from(params: InstallParams) -> Self {
        Self {
            item_ref: params.item_ref,
            revision: params.revision,
            install_name: params.install_name,
            hosts: params.hosts,
            state_sha256: params.state_sha256,
            consent_exec: params.consent_exec,
            acks: params.acks.unwrap_or_default(),
            experts_acks: params.experts_acks.unwrap_or_default(),
            accept_yanked: params.accept_yanked.unwrap_or(false),
        }
    }
}

/// `{ itemId, preflight?, ack? }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallParams {
    pub item_id: String,
    #[serde(default)]
    pub preflight: Option<bool>,
    #[serde(default)]
    pub ack: Option<String>,
}

impl From<UninstallParams> for HarnessPluginUninstallRequest {
    fn from(params: UninstallParams) -> Self {
        Self {
            item_id: params.item_id,
            preflight: params.preflight.unwrap_or(false),
            ack: params.ack,
        }
    }
}

/// `{ itemId }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemParams {
    pub item_id: String,
}

/// `{ itemId, revision, stateSha256, consentExec?, acks?, expertsAcks?,
/// acceptYanked? }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateParams {
    pub item_id: String,
    pub revision: u64,
    pub state_sha256: String,
    #[serde(default)]
    pub consent_exec: Option<String>,
    #[serde(default)]
    pub acks: Option<Acks>,
    #[serde(default)]
    pub experts_acks: Option<BTreeMap<AgentType, String>>,
    #[serde(default)]
    pub accept_yanked: Option<bool>,
}

impl From<UpdateParams> for HarnessPluginUpdateRequest {
    fn from(params: UpdateParams) -> Self {
        Self {
            item_id: params.item_id,
            revision: params.revision,
            state_sha256: params.state_sha256,
            consent_exec: params.consent_exec,
            acks: params.acks.unwrap_or_default(),
            experts_acks: params.experts_acks.unwrap_or_default(),
            accept_yanked: params.accept_yanked.unwrap_or(false),
        }
    }
}

/// `{ itemId, agent, mode, preflight?, stateSha256?, consentExec?, acks?,
/// expertsAck? }` — `acks` by member.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetHostParams {
    pub item_id: String,
    pub agent: AgentType,
    pub mode: PlanMode,
    #[serde(default)]
    pub preflight: Option<bool>,
    #[serde(default)]
    pub state_sha256: Option<String>,
    #[serde(default)]
    pub consent_exec: Option<String>,
    #[serde(default)]
    pub acks: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub experts_ack: Option<String>,
}

impl From<SetHostParams> for HarnessPluginSetHostRequest {
    fn from(params: SetHostParams) -> Self {
        Self {
            item_id: params.item_id,
            agent: params.agent,
            mode: params.mode,
            preflight: params.preflight.unwrap_or(false),
            state_sha256: params.state_sha256,
            consent_exec: params.consent_exec,
            acks: params.acks.unwrap_or_default(),
            experts_ack: params.experts_ack,
        }
    }
}

/// `{ itemId, agent, enabled, preflight?, acks?, expertsAck? }` — `acks` by
/// member.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEnabledParams {
    pub item_id: String,
    pub agent: AgentType,
    pub enabled: bool,
    #[serde(default)]
    pub preflight: Option<bool>,
    #[serde(default)]
    pub acks: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub experts_ack: Option<String>,
}

impl From<SetEnabledParams> for HarnessPluginSetEnabledRequest {
    fn from(params: SetEnabledParams) -> Self {
        Self {
            item_id: params.item_id,
            agent: params.agent,
            enabled: params.enabled,
            preflight: params.preflight.unwrap_or(false),
            acks: params.acks.unwrap_or_default(),
            experts_ack: params.experts_ack,
        }
    }
}

/// `{ itemId, agent?, preflight?, acks?, expertsAcks? }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairParams {
    pub item_id: String,
    #[serde(default)]
    pub agent: Option<AgentType>,
    #[serde(default)]
    pub preflight: Option<bool>,
    #[serde(default)]
    pub acks: Option<Acks>,
    #[serde(default)]
    pub experts_acks: Option<BTreeMap<AgentType, String>>,
}

impl From<RepairParams> for HarnessPluginRepairRequest {
    fn from(params: RepairParams) -> Self {
        Self {
            item_id: params.item_id,
            agent: params.agent,
            preflight: params.preflight.unwrap_or(false),
            acks: params.acks.unwrap_or_default(),
            experts_acks: params.experts_acks.unwrap_or_default(),
        }
    }
}

/// `{ itemId, agent }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookTrustParams {
    pub item_id: String,
    pub agent: AgentType,
}

pub async fn harness_plugin_plan(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PlanParams>,
) -> Result<Json<HarnessPluginPlan>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_plugin_plan_core(
        &state.db,
        &state.data_dir,
        &harness,
        &params.item_ref,
        params.agents,
        params.modes,
    )
    .await
    .map(Json)
}

pub async fn harness_plugin_install(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<InstallParams>,
) -> Result<Json<HarnessPluginInstallResult>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_plugin_install_core(
        &state.db,
        &state.data_dir,
        &state.emitter,
        &harness,
        params.into(),
    )
    .await
    .map(Json)
}

pub async fn harness_plugin_uninstall(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UninstallParams>,
) -> Result<Json<HarnessPluginUninstallResult>, AppCommandError> {
    commands::harness_plugin_uninstall_core(
        &state.db,
        &state.data_dir,
        &state.emitter,
        params.into(),
    )
    .await
    .map(Json)
}

pub async fn harness_plugin_plan_update(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemParams>,
) -> Result<Json<HarnessPluginUpdatePlan>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_plugin_plan_update_core(&state.db, &state.data_dir, &harness, &params.item_id)
        .await
        .map(Json)
}

pub async fn harness_plugin_update(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateParams>,
) -> Result<Json<HarnessPluginInstallResult>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_plugin_update_core(
        &state.db,
        &state.data_dir,
        &state.emitter,
        &harness,
        params.into(),
    )
    .await
    .map(Json)
}

pub async fn harness_plugin_set_host(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetHostParams>,
) -> Result<Json<HarnessPluginInstallResult>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_plugin_set_host_core(
        &state.db,
        &state.data_dir,
        &state.emitter,
        &harness,
        params.into(),
    )
    .await
    .map(Json)
}

pub async fn harness_plugin_set_enabled(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetEnabledParams>,
) -> Result<Json<HarnessPluginInstallResult>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_plugin_set_enabled_core(
        &state.db,
        &state.data_dir,
        &state.emitter,
        &harness,
        params.into(),
    )
    .await
    .map(Json)
}

pub async fn harness_plugin_repair(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RepairParams>,
) -> Result<Json<HarnessPluginInstallResult>, AppCommandError> {
    let harness = Harness::from_env(&state.data_dir);
    commands::harness_plugin_repair_core(
        &state.db,
        &state.data_dir,
        &state.emitter,
        &harness,
        params.into(),
    )
    .await
    .map(Json)
}

pub async fn harness_plugin_hook_trust(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<HookTrustParams>,
) -> Result<Json<HookTrust>, AppCommandError> {
    commands::harness_plugin_hook_trust_core(
        &state.db,
        &state.data_dir,
        &params.item_id,
        params.agent,
    )
    .await
    .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "01a1f230-a5b2-7bca-9cee-bd63eb5aee5c";

    /// The frontend sends the desktop commands' argument names (camelCase)
    /// and the engine's agent and mode names inside them; what it leaves
    /// out takes the commands' defaults.
    #[test]
    fn the_plan_and_the_install_read_their_arguments_as_the_frontend_names_them() {
        let plan: PlanParams =
            serde_json::from_value(json!({ "itemRef": "obra/superpowers" })).unwrap();
        assert_eq!(plan.item_ref, "obra/superpowers");
        assert!(plan.agents.is_none() && plan.modes.is_none());
        let plan: PlanParams = serde_json::from_value(json!({
            "itemRef": "obra/superpowers",
            "agents": ["claude_code", "gemini"],
            "modes": { "claude_code": "native", "gemini": "skills", "codex": "none" }
        }))
        .unwrap();
        assert_eq!(
            plan.agents.unwrap(),
            [AgentType::ClaudeCode, AgentType::Gemini]
        );
        let modes = plan.modes.unwrap();
        assert_eq!(modes[&AgentType::ClaudeCode], PlanMode::Native);
        assert_eq!(modes[&AgentType::Codex], PlanMode::None);
        assert!(serde_json::from_value::<PlanParams>(json!({
            "itemRef": "obra/superpowers", "modes": { "claude_code": "whole" }
        }))
        .is_err());

        let install: InstallParams = serde_json::from_value(json!({
            "itemRef": "obra/superpowers", "revision": 4, "installName": "superpowers",
            "hosts": { "claude_code": "native", "gemini": "skills" },
            "stateSha256": "feed", "consentExec": "c0de",
            "acks": { "gemini": { "brainstorming": "ab12" } },
            "expertsAcks": { "claude_code": "e1" }, "acceptYanked": true
        }))
        .unwrap();
        let request = HarnessPluginInstallRequest::from(install);
        assert_eq!(request.revision, 4);
        assert_eq!(request.install_name, "superpowers");
        assert_eq!(request.hosts[&AgentType::Gemini], PlanMode::Skills);
        assert_eq!(request.consent_exec.as_deref(), Some("c0de"));
        assert_eq!(request.acks[&AgentType::Gemini]["brainstorming"], "ab12");
        assert_eq!(request.experts_acks[&AgentType::ClaudeCode], "e1");
        assert!(request.accept_yanked);
        let request = HarnessPluginInstallRequest::from(
            serde_json::from_value::<InstallParams>(json!({
                "itemRef": "obra/superpowers", "revision": 4, "installName": "superpowers",
                "hosts": {}, "stateSha256": "feed"
            }))
            .unwrap(),
        );
        assert!(request.acks.is_empty() && request.experts_acks.is_empty());
        assert!(request.consent_exec.is_none() && !request.accept_yanked);
        // Required: what the install confirms.
        for missing in ["revision", "installName", "hosts", "stateSha256"] {
            let mut body = json!({
                "itemRef": "obra/superpowers", "revision": 4, "installName": "superpowers",
                "hosts": {}, "stateSha256": "feed"
            });
            body.as_object_mut().unwrap().remove(missing);
            assert!(
                serde_json::from_value::<InstallParams>(body).is_err(),
                "{missing}"
            );
        }
        assert!(serde_json::from_value::<InstallParams>(json!({
            "itemRef": "obra/superpowers", "revision": 4, "installName": "superpowers",
            "hosts": { "no_such_agent": "native" }, "stateSha256": "feed"
        }))
        .is_err());
    }

    #[test]
    fn the_other_calls_read_their_arguments_as_the_frontend_names_them() {
        let uninstall = HarnessPluginUninstallRequest::from(
            serde_json::from_value::<UninstallParams>(json!({ "itemId": ID })).unwrap(),
        );
        assert_eq!(uninstall.item_id, ID);
        assert!(!uninstall.preflight && uninstall.ack.is_none());
        let uninstall = HarnessPluginUninstallRequest::from(
            serde_json::from_value::<UninstallParams>(
                json!({ "itemId": ID, "preflight": true, "ack": "a1" }),
            )
            .unwrap(),
        );
        assert!(uninstall.preflight);
        assert_eq!(uninstall.ack.as_deref(), Some("a1"));

        let item: ItemParams = serde_json::from_value(json!({ "itemId": ID })).unwrap();
        assert_eq!(item.item_id, ID);

        let update = HarnessPluginUpdateRequest::from(
            serde_json::from_value::<UpdateParams>(json!({
                "itemId": ID, "revision": 5, "stateSha256": "feed",
                "acks": { "gemini": { "writing-plans": "b2" } }
            }))
            .unwrap(),
        );
        assert_eq!(update.revision, 5);
        assert_eq!(update.acks[&AgentType::Gemini]["writing-plans"], "b2");
        assert!(update.consent_exec.is_none() && !update.accept_yanked);
        assert!(serde_json::from_value::<UpdateParams>(
            json!({ "itemId": ID, "stateSha256": "feed" })
        )
        .is_err());

        let set_host = HarnessPluginSetHostRequest::from(
            serde_json::from_value::<SetHostParams>(json!({
                "itemId": ID, "agent": "codex", "mode": "skills", "preflight": true,
                "acks": { "brainstorming": "c3" }, "expertsAck": "e2"
            }))
            .unwrap(),
        );
        assert_eq!(set_host.agent, AgentType::Codex);
        assert_eq!(set_host.mode, PlanMode::Skills);
        assert!(set_host.preflight);
        assert_eq!(set_host.acks["brainstorming"], "c3");
        assert_eq!(set_host.experts_ack.as_deref(), Some("e2"));
        assert!(set_host.state_sha256.is_none());
        assert!(
            serde_json::from_value::<SetHostParams>(json!({ "itemId": ID, "agent": "codex" }))
                .is_err()
        );

        let set_enabled = HarnessPluginSetEnabledRequest::from(
            serde_json::from_value::<SetEnabledParams>(
                json!({ "itemId": ID, "agent": "open_code", "enabled": false }),
            )
            .unwrap(),
        );
        assert_eq!(set_enabled.agent, AgentType::OpenCode);
        assert!(!set_enabled.enabled && !set_enabled.preflight);
        assert!(set_enabled.acks.is_empty());
        assert!(serde_json::from_value::<SetEnabledParams>(
            json!({ "itemId": ID, "agent": "open_code" })
        )
        .is_err());

        let repair = HarnessPluginRepairRequest::from(
            serde_json::from_value::<RepairParams>(json!({ "itemId": ID })).unwrap(),
        );
        assert!(repair.agent.is_none() && !repair.preflight);
        let repair = HarnessPluginRepairRequest::from(
            serde_json::from_value::<RepairParams>(json!({
                "itemId": ID, "agent": "claude_code", "preflight": true,
                "expertsAcks": { "claude_code": "e3" }
            }))
            .unwrap(),
        );
        assert_eq!(repair.agent, Some(AgentType::ClaudeCode));
        assert_eq!(repair.experts_acks[&AgentType::ClaudeCode], "e3");

        let trust: HookTrustParams =
            serde_json::from_value(json!({ "itemId": ID, "agent": "codex" })).unwrap();
        assert_eq!(trust.agent, AgentType::Codex);
        assert!(serde_json::from_value::<HookTrustParams>(json!({ "itemId": ID })).is_err());
    }
}
