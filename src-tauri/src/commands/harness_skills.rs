//! Installing skills from Harness: the plan the install dialog is built
//! from, the install (and update) it confirms, and the uninstall. The work
//! is in `harness::skills`; these are the `_core` functions both runtimes
//! call, and the Tauri commands. The Web handlers are in
//! `web/handlers/harness_skills.rs`. The listing is `harness_installed`'s
//! `skills` (`commands::harness_mcp`).
//!
//! With `CODEG_HARNESS=off`, the plan and the install fail with
//! `Harness.errors.disabled` before anything is read; the uninstall (and the
//! listing, and the startup recovery) only touch this machine's files and
//! keep working.
//!
//! `codeg-mcp` exposes none of them: an install is something a person
//! confirms, in the interface.

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::harness::skills::{
    self, HarnessSkillInstallRequest, HarnessSkillInstallResult, HarnessSkillPlan,
    HarnessSkillUninstallRequest, HarnessSkillUninstallResult, Local,
};
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

pub async fn harness_skill_plan_core(
    db: &AppDatabase,
    harness: &Harness,
    item_ref: &str,
    revision: Option<u64>,
    agents: Option<Vec<AgentType>>,
) -> Result<HarnessSkillPlan, AppCommandError> {
    ensure_enabled(harness)?;
    let local = Local::from_db(db).await;
    skills::plan(&local, harness, item_ref, revision, agents).await
}

pub async fn harness_skill_install_core(
    emitter: &EventEmitter,
    harness: &Harness,
    request: HarnessSkillInstallRequest,
) -> Result<HarnessSkillInstallResult, AppCommandError> {
    ensure_enabled(harness)?;
    skills::install(&Local::here(), harness, emitter, request).await
}

pub async fn harness_skill_uninstall_core(
    emitter: &EventEmitter,
    request: HarnessSkillUninstallRequest,
) -> Result<HarnessSkillUninstallResult, AppCommandError> {
    skills::uninstall(&Local::here(), emitter, request).await
}

#[cfg(feature = "tauri-runtime")]
mod tauri_commands {
    use std::collections::BTreeMap;

    use super::*;

    /// The catalog as the desktop app is configured (see
    /// `commands::harness`).
    fn harness(app: &tauri::AppHandle) -> Harness {
        use tauri::Manager;
        let data_dir = crate::paths::resolve_effective_data_dir(
            &app.path().app_data_dir().unwrap_or_default(),
        );
        Harness::from_env(&data_dir)
    }

    #[tauri::command]
    pub async fn harness_skill_plan(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_ref: String,
        revision: Option<u64>,
        agents: Option<Vec<AgentType>>,
    ) -> Result<HarnessSkillPlan, AppCommandError> {
        harness_skill_plan_core(&db, &harness(&app), &item_ref, revision, agents).await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn harness_skill_install(
        app: tauri::AppHandle,
        item_ref: String,
        revision: u64,
        install_name: String,
        agents: Vec<AgentType>,
        keep_allowed_tools: Option<bool>,
        state_sha256: String,
        acks: Option<BTreeMap<AgentType, String>>,
        accept_yanked: Option<bool>,
    ) -> Result<HarnessSkillInstallResult, AppCommandError> {
        let request = HarnessSkillInstallRequest {
            item_ref,
            revision,
            install_name,
            agents,
            keep_allowed_tools: keep_allowed_tools.unwrap_or(false),
            state_sha256,
            acks: acks.unwrap_or_default(),
            accept_yanked: accept_yanked.unwrap_or(false),
        };
        let emitter = EventEmitter::from_app(&app);
        harness_skill_install_core(&emitter, &harness(&app), request).await
    }

    #[tauri::command]
    pub async fn harness_skill_uninstall(
        app: tauri::AppHandle,
        item_id: String,
        preflight: Option<bool>,
        ack: Option<String>,
    ) -> Result<HarnessSkillUninstallResult, AppCommandError> {
        let request = HarnessSkillUninstallRequest {
            item_id,
            preflight: preflight.unwrap_or(false),
            ack,
        };
        harness_skill_uninstall_core(&EventEmitter::from_app(&app), request).await
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_commands::*;
