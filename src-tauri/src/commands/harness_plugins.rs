//! Installing plugins from Harness: the plan the install dialog is built
//! from, the install it confirms, the uninstall; the update prompt and the
//! update; one agent's mode changed, switched off and on; the repair of what
//! an interrupted operation left; and Codex's trust of a plugin's hooks,
//! asked for on demand. The work is in `harness::plugins`; these are the
//! `_core` functions both runtimes call, and the Tauri commands. The Web
//! handlers are in `web/handlers/harness_plugins.rs`. The listing is
//! `harness_installed`'s `plugins` (`commands::harness_mcp`).
//!
//! Every call that writes answers a result whose `outcome` says what came
//! of it (`refused`, `busy`, `failed`, …) rather than an error; call the
//! writing ones with `preflight: true` first where they take it, then again
//! with its `acks` (and the plan's `stateSha256`).
//!
//! Each agent's host is reached with the environment its sessions start
//! with (`guard::launch_envs`, from the agent's settings); an agent whose
//! settings cannot be read is never reached with a guessed one.
//!
//! With `CODEG_HARNESS=off`, the plans, the install and the update fail
//! with `Harness.errors.disabled` before anything is read; the uninstall,
//! switching off, the repair (as far as it needs no catalog) and the hook
//! trust only touch this machine and keep working.
//!
//! `codeg-mcp` exposes none of them: an install is something a person
//! confirms, in the interface.

use std::collections::BTreeMap;
use std::path::Path;

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::harness::plugins::guard::launch_envs;
use crate::harness::plugins::hosts::{HookTrust, HostId};
use crate::harness::plugins::install::{self, PluginsLocal};
use crate::harness::plugins::listing;
use crate::harness::plugins::model::{
    HarnessPluginInstallRequest, HarnessPluginInstallResult, HarnessPluginPlan,
    HarnessPluginRepairRequest, HarnessPluginSetEnabledRequest, HarnessPluginSetHostRequest,
    HarnessPluginUninstallRequest, HarnessPluginUninstallResult, HarnessPluginUpdatePlan,
    HarnessPluginUpdateRequest, PlanMode,
};
use crate::harness::plugins::update;
use crate::harness::skills::Local as SkillsLocal;
use crate::harness::{Harness, HarnessError};
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

fn ensure_enabled(harness: &Harness) -> Result<(), AppCommandError> {
    if harness.enabled() {
        Ok(())
    } else {
        Err(HarnessError::Disabled.into())
    }
}

/// The agents whose host has an adapter: the ones a launch environment is
/// read for.
fn host_agents() -> Vec<AgentType> {
    [AgentType::ClaudeCode, AgentType::Codex, AgentType::OpenCode]
        .into_iter()
        .filter(|agent| HostId::for_agent(*agent).is_some())
        .collect()
}

/// This machine's plugin store, skill store and hosts, each host agent with
/// its launch environment. `installed`: with which agents are installed
/// here (what the install plan's rows need).
pub(crate) async fn plugins_local(
    db: &AppDatabase,
    data_dir: &Path,
    installed: bool,
) -> PluginsLocal {
    let skills = if installed {
        SkillsLocal::from_db(db).await
    } else {
        SkillsLocal::here()
    };
    let envs = launch_envs(db, data_dir, &host_agents()).await;
    PluginsLocal::here(skills, envs)
}

pub async fn harness_plugin_plan_core(
    db: &AppDatabase,
    data_dir: &Path,
    harness: &Harness,
    item_ref: &str,
    agents: Option<Vec<AgentType>>,
    modes: Option<BTreeMap<AgentType, PlanMode>>,
) -> Result<HarnessPluginPlan, AppCommandError> {
    ensure_enabled(harness)?;
    let local = plugins_local(db, data_dir, true).await;
    install::plan(&local, harness, item_ref, agents, modes).await
}

pub async fn harness_plugin_install_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    harness: &Harness,
    request: HarnessPluginInstallRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    ensure_enabled(harness)?;
    let local = plugins_local(db, data_dir, false).await;
    install::install(&local, harness, emitter, request).await
}

pub async fn harness_plugin_uninstall_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    request: HarnessPluginUninstallRequest,
) -> Result<HarnessPluginUninstallResult, AppCommandError> {
    let local = plugins_local(db, data_dir, false).await;
    install::uninstall(&local, emitter, request).await
}

pub async fn harness_plugin_plan_update_core(
    db: &AppDatabase,
    data_dir: &Path,
    harness: &Harness,
    item_id: &str,
) -> Result<HarnessPluginUpdatePlan, AppCommandError> {
    ensure_enabled(harness)?;
    let local = plugins_local(db, data_dir, false).await;
    update::plan_update(&local, harness, item_id).await
}

pub async fn harness_plugin_update_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    harness: &Harness,
    request: HarnessPluginUpdateRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    ensure_enabled(harness)?;
    let local = plugins_local(db, data_dir, false).await;
    update::update(&local, harness, emitter, request).await
}

pub async fn harness_plugin_set_host_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    harness: &Harness,
    request: HarnessPluginSetHostRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    let local = plugins_local(db, data_dir, false).await;
    update::set_host_mode(&local, harness, emitter, request).await
}

pub async fn harness_plugin_set_enabled_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    harness: &Harness,
    request: HarnessPluginSetEnabledRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    let local = plugins_local(db, data_dir, false).await;
    update::set_enabled(&local, harness, emitter, request).await
}

pub async fn harness_plugin_repair_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    harness: &Harness,
    request: HarnessPluginRepairRequest,
) -> Result<HarnessPluginInstallResult, AppCommandError> {
    let local = plugins_local(db, data_dir, false).await;
    update::repair(&local, harness, emitter, request).await
}

pub async fn harness_plugin_hook_trust_core(
    db: &AppDatabase,
    data_dir: &Path,
    item_id: &str,
    agent: AgentType,
) -> Result<HookTrust, AppCommandError> {
    let local = PluginsLocal::here(
        SkillsLocal::here(),
        launch_envs(db, data_dir, &[agent]).await,
    );
    listing::hook_trust(&local, item_id, agent).await
}

#[cfg(feature = "tauri-runtime")]
mod tauri_commands {
    use std::path::PathBuf;

    use super::*;

    /// The data directory every other part of the app uses (see
    /// `commands::harness`).
    fn data_dir(app: &tauri::AppHandle) -> PathBuf {
        use tauri::Manager;
        crate::paths::resolve_effective_data_dir(&app.path().app_data_dir().unwrap_or_default())
    }

    /// The catalog as the desktop app is configured.
    fn harness(app: &tauri::AppHandle) -> Harness {
        Harness::from_env(&data_dir(app))
    }

    #[tauri::command]
    pub async fn harness_plugin_plan(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_ref: String,
        agents: Option<Vec<AgentType>>,
        modes: Option<BTreeMap<AgentType, PlanMode>>,
    ) -> Result<HarnessPluginPlan, AppCommandError> {
        harness_plugin_plan_core(
            &db,
            &data_dir(&app),
            &harness(&app),
            &item_ref,
            agents,
            modes,
        )
        .await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn harness_plugin_install(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_ref: String,
        revision: u64,
        install_name: String,
        hosts: BTreeMap<AgentType, PlanMode>,
        state_sha256: String,
        consent_exec: Option<String>,
        acks: Option<BTreeMap<AgentType, BTreeMap<String, String>>>,
        experts_acks: Option<BTreeMap<AgentType, String>>,
        accept_yanked: Option<bool>,
    ) -> Result<HarnessPluginInstallResult, AppCommandError> {
        let request = HarnessPluginInstallRequest {
            item_ref,
            revision,
            install_name,
            hosts,
            state_sha256,
            consent_exec,
            acks: acks.unwrap_or_default(),
            experts_acks: experts_acks.unwrap_or_default(),
            accept_yanked: accept_yanked.unwrap_or(false),
        };
        harness_plugin_install_core(
            &db,
            &data_dir(&app),
            &EventEmitter::from_app(&app),
            &harness(&app),
            request,
        )
        .await
    }

    #[tauri::command]
    pub async fn harness_plugin_uninstall(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_id: String,
        preflight: Option<bool>,
        ack: Option<String>,
    ) -> Result<HarnessPluginUninstallResult, AppCommandError> {
        let request = HarnessPluginUninstallRequest {
            item_id,
            preflight: preflight.unwrap_or(false),
            ack,
        };
        harness_plugin_uninstall_core(&db, &data_dir(&app), &EventEmitter::from_app(&app), request)
            .await
    }

    #[tauri::command]
    pub async fn harness_plugin_plan_update(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_id: String,
    ) -> Result<HarnessPluginUpdatePlan, AppCommandError> {
        harness_plugin_plan_update_core(&db, &data_dir(&app), &harness(&app), &item_id).await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn harness_plugin_update(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_id: String,
        revision: u64,
        state_sha256: String,
        consent_exec: Option<String>,
        acks: Option<BTreeMap<AgentType, BTreeMap<String, String>>>,
        experts_acks: Option<BTreeMap<AgentType, String>>,
        accept_yanked: Option<bool>,
    ) -> Result<HarnessPluginInstallResult, AppCommandError> {
        let request = HarnessPluginUpdateRequest {
            item_id,
            revision,
            state_sha256,
            consent_exec,
            acks: acks.unwrap_or_default(),
            experts_acks: experts_acks.unwrap_or_default(),
            accept_yanked: accept_yanked.unwrap_or(false),
        };
        harness_plugin_update_core(
            &db,
            &data_dir(&app),
            &EventEmitter::from_app(&app),
            &harness(&app),
            request,
        )
        .await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn harness_plugin_set_host(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_id: String,
        agent: AgentType,
        mode: PlanMode,
        preflight: Option<bool>,
        state_sha256: Option<String>,
        consent_exec: Option<String>,
        acks: Option<BTreeMap<String, String>>,
        experts_ack: Option<String>,
    ) -> Result<HarnessPluginInstallResult, AppCommandError> {
        let request = HarnessPluginSetHostRequest {
            item_id,
            agent,
            mode,
            preflight: preflight.unwrap_or(false),
            state_sha256,
            consent_exec,
            acks: acks.unwrap_or_default(),
            experts_ack,
        };
        harness_plugin_set_host_core(
            &db,
            &data_dir(&app),
            &EventEmitter::from_app(&app),
            &harness(&app),
            request,
        )
        .await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn harness_plugin_set_enabled(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_id: String,
        agent: AgentType,
        enabled: bool,
        preflight: Option<bool>,
        acks: Option<BTreeMap<String, String>>,
        experts_ack: Option<String>,
    ) -> Result<HarnessPluginInstallResult, AppCommandError> {
        let request = HarnessPluginSetEnabledRequest {
            item_id,
            agent,
            enabled,
            preflight: preflight.unwrap_or(false),
            acks: acks.unwrap_or_default(),
            experts_ack,
        };
        harness_plugin_set_enabled_core(
            &db,
            &data_dir(&app),
            &EventEmitter::from_app(&app),
            &harness(&app),
            request,
        )
        .await
    }

    #[tauri::command]
    pub async fn harness_plugin_repair(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_id: String,
        agent: Option<AgentType>,
        preflight: Option<bool>,
        acks: Option<BTreeMap<AgentType, BTreeMap<String, String>>>,
        experts_acks: Option<BTreeMap<AgentType, String>>,
    ) -> Result<HarnessPluginInstallResult, AppCommandError> {
        let request = HarnessPluginRepairRequest {
            item_id,
            agent,
            preflight: preflight.unwrap_or(false),
            acks: acks.unwrap_or_default(),
            experts_acks: experts_acks.unwrap_or_default(),
        };
        harness_plugin_repair_core(
            &db,
            &data_dir(&app),
            &EventEmitter::from_app(&app),
            &harness(&app),
            request,
        )
        .await
    }

    #[tauri::command]
    pub async fn harness_plugin_hook_trust(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_id: String,
        agent: AgentType,
    ) -> Result<HookTrust, AppCommandError> {
        harness_plugin_hook_trust_core(&db, &data_dir(&app), &item_id, agent).await
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_commands::*;
