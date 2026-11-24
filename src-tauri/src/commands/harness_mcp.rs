//! Installing MCP servers from Harness: the plan the install dialog is built
//! from, the install (and update) it confirms, the listing of what was
//! installed, and the uninstall. The work is in `harness::mcp`; these are the
//! `_core` functions both runtimes call, and the Tauri commands. The Web
//! handlers are in `web/handlers/harness_mcp.rs`.
//!
//! With `CODEG_HARNESS=off`, the plan and the install fail with
//! `Harness.errors.disabled` before anything is read; the listing and the
//! uninstall only touch this machine's files and keep working.
//!
//! `codeg-mcp` exposes none of them: an install is something a person
//! confirms, in the interface.

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::harness::mcp::{
    self, HarnessInstalled, HarnessMcpInstallRequest, HarnessMcpInstallResult, HarnessMcpPlan,
    HarnessMcpUninstallRequest, HarnessMcpUninstallResult, Local,
};
use crate::harness::{Harness, HarnessError};
use crate::web::event_bridge::EventEmitter;

fn ensure_enabled(harness: &Harness) -> Result<(), AppCommandError> {
    if harness.enabled() {
        Ok(())
    } else {
        Err(HarnessError::Disabled.into())
    }
}

pub async fn harness_mcp_plan_core(
    db: &AppDatabase,
    harness: &Harness,
    item_ref: &str,
    revision: Option<u64>,
) -> Result<HarnessMcpPlan, AppCommandError> {
    ensure_enabled(harness)?;
    let local = Local::from_db(db).await;
    mcp::plan(&local, harness, item_ref, revision).await
}

pub async fn harness_mcp_install_core(
    db: &AppDatabase,
    emitter: &EventEmitter,
    harness: &Harness,
    request: HarnessMcpInstallRequest,
) -> Result<HarnessMcpInstallResult, AppCommandError> {
    ensure_enabled(harness)?;
    let local = Local::from_db(db).await;
    mcp::install(&local, harness, emitter, request).await
}

pub async fn harness_installed_core(
    db: &AppDatabase,
    data_dir: &std::path::Path,
    emitter: &EventEmitter,
) -> Result<HarnessInstalled, AppCommandError> {
    let local = Local::from_db(db).await;
    let plugins = crate::commands::harness_plugins::plugins_local(db, data_dir, false).await;
    // The update check's last answers (read, never asked): the plugins'
    // update marks.
    let updates = crate::harness::updates::checker_for(data_dir, emitter)
        .updates()
        .await
        .map(|updates| updates.items)
        .unwrap_or_default();
    harness_installed_in(
        &local,
        crate::skills::SkillsCtx::user(),
        &plugins,
        &updates,
        emitter,
    )
    .await
}

/// [`harness_installed_core`] over the given MCP side, skill store and
/// plugin side. A record that cannot be read (the MCP record, the skills
/// manifest, the plugins record) empties only its own part and says so in
/// that part's problem; anything else rejects as before.
pub(crate) async fn harness_installed_in(
    local: &Local,
    skills: crate::skills::SkillsCtx,
    plugins: &crate::harness::plugins::install::PluginsLocal,
    updates: &[crate::harness::updates::UpdateItem],
    emitter: &EventEmitter,
) -> Result<HarnessInstalled, AppCommandError> {
    let unreadable = |error: &AppCommandError| {
        (error.i18n_key.as_deref() == Some(mcp::I18N_KEY_RECORD_UNREADABLE)).then(|| {
            mcp::Reason::new(mcp::codes::RECORD_UNREADABLE)
                .detail(error.detail.clone().unwrap_or_default())
        })
    };
    let mut listed = match mcp::installed(local, emitter).await {
        Ok(listed) => listed,
        Err(error) => HarnessInstalled {
            mcp: Vec::new(),
            skills: Vec::new(),
            mcp_problem: Some(unreadable(&error).ok_or(error)?),
            skills_problem: None,
            plugins: Vec::new(),
            plugins_problem: None,
        },
    };
    match crate::harness::skills::installed_skills(skills).await {
        Ok(skills) => listed.skills = skills,
        Err(error) => listed.skills_problem = Some(unreadable(&error).ok_or(error)?),
    }
    match crate::harness::plugins::listing::installed(plugins, updates).await? {
        Ok(rows) => listed.plugins = rows,
        Err(problem) => listed.plugins_problem = Some(problem),
    }
    Ok(listed)
}

pub async fn harness_mcp_uninstall_core(
    db: &AppDatabase,
    emitter: &EventEmitter,
    request: HarnessMcpUninstallRequest,
) -> Result<HarnessMcpUninstallResult, AppCommandError> {
    let local = Local::from_db(db).await;
    mcp::uninstall(&local, emitter, request).await
}

#[cfg(feature = "tauri-runtime")]
mod tauri_commands {
    use std::collections::BTreeMap;

    use super::*;
    use crate::commands::mcp::McpAppType;

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
    pub async fn harness_mcp_plan(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_ref: String,
        revision: Option<u64>,
    ) -> Result<HarnessMcpPlan, AppCommandError> {
        harness_mcp_plan_core(&db, &harness(&app), &item_ref, revision).await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn harness_mcp_install(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_ref: String,
        revision: u64,
        option_id: String,
        values: Option<BTreeMap<String, String>>,
        key: String,
        agents: Vec<McpAppType>,
        replace: Option<Vec<McpAppType>>,
        state_sha256: String,
        basis: Option<BTreeMap<McpAppType, String>>,
        accept_yanked: Option<bool>,
    ) -> Result<HarnessMcpInstallResult, AppCommandError> {
        let request = HarnessMcpInstallRequest {
            item_ref,
            revision,
            option_id,
            values: values.unwrap_or_default(),
            key,
            agents,
            replace: replace.unwrap_or_default(),
            state_sha256,
            basis: basis.unwrap_or_default(),
            accept_yanked: accept_yanked.unwrap_or(false),
        };
        let emitter = EventEmitter::from_app(&app);
        harness_mcp_install_core(&db, &emitter, &harness(&app), request).await
    }

    #[tauri::command]
    pub async fn harness_installed(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
    ) -> Result<HarnessInstalled, AppCommandError> {
        use tauri::Manager;
        let data_dir = crate::paths::resolve_effective_data_dir(
            &app.path().app_data_dir().unwrap_or_default(),
        );
        harness_installed_core(&db, &data_dir, &EventEmitter::from_app(&app)).await
    }

    #[tauri::command]
    pub async fn harness_mcp_uninstall(
        app: tauri::AppHandle,
        db: tauri::State<'_, AppDatabase>,
        item_id: String,
        agents: Option<Vec<McpAppType>>,
        remove_changed: Option<Vec<McpAppType>>,
        basis: Option<BTreeMap<McpAppType, String>>,
        preflight: Option<bool>,
    ) -> Result<HarnessMcpUninstallResult, AppCommandError> {
        let request = HarnessMcpUninstallRequest {
            item_id,
            agents,
            remove_changed: remove_changed.unwrap_or_default(),
            basis: basis.unwrap_or_default(),
            preflight: preflight.unwrap_or(false),
        };
        harness_mcp_uninstall_core(&db, &EventEmitter::from_app(&app), request).await
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_commands::*;
