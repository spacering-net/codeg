use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
#[cfg(feature = "tauri-runtime")]
use tauri::{Manager, State};

use crate::acp::{account_auth, agent_accounts, error::AcpError, manager::ConnectionManager};
use crate::db::{entities::agent_account, service::agent_account_service as service, AppDatabase};
use crate::models::AgentType;
use crate::web::event_bridge::EventEmitter;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsResult {
    pub accounts: Vec<agent_account::Model>,
    pub capabilities: Vec<agent_accounts::AccountCapability>,
}

pub async fn list_core(db: &AppDatabase, agent: AgentType) -> Result<AccountsResult, AcpError> {
    Ok(AccountsResult {
        accounts: service::list_for_display(&db.conn, agent)
            .await
            .map_err(|e| AcpError::protocol(e.to_string()))?,
        capabilities: agent_accounts::capabilities(),
    })
}

pub async fn create_core(
    db: &AppDatabase,
    data_dir: &Path,
    agent: AgentType,
    name: &str,
    home: Option<&str>,
    emitter: &EventEmitter,
) -> Result<agent_account::Model, AcpError> {
    let account = service::create(&db.conn, data_dir, agent, name, home)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    crate::commands::acp::emit_acp_agents_updated(emitter, "account_created", Some(agent));
    Ok(account)
}

pub async fn rename_core(
    db: &AppDatabase,
    id: &str,
    name: &str,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    service::rename(&db.conn, id, name)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    crate::commands::acp::emit_acp_agents_updated(emitter, "account_renamed", None);
    Ok(())
}

pub async fn remove_core(
    db: &AppDatabase,
    id: &str,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    service::remove(&db.conn, id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    crate::commands::acp::emit_acp_agents_updated(emitter, "account_removed", None);
    Ok(())
}

pub async fn login_core(
    db: &AppDatabase,
    id: &str,
) -> Result<crate::commands::custom_agents::ExtraSlotLoginResult, AcpError> {
    let account = service::get(&db.conn, id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let agent = AgentType::from_wire(&account.agent_type)
        .ok_or_else(|| AcpError::protocol("Unknown agent account"))?;
    service::resolve(&db.conn, agent, id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let spec = agent_accounts::layout(agent)
        .ok_or_else(|| AcpError::protocol("This agent does not support isolated sign-in"))?;
    let env = agent_accounts::isolation_env(agent, Path::new(&account.home_dir))
        .map_err(AcpError::protocol)?;
    let command = isolated_login_command(agent, env).await?;
    Ok(crate::commands::custom_agents::ExtraSlotLoginResult {
        family: account.agent_type,
        isolator_key: spec.env_key.into(),
        home: account.home_dir,
        command,
        launched: false,
    })
}

async fn resolved_account(
    db: &AppDatabase,
    id: &str,
) -> Result<(AgentType, agent_account::Model), AcpError> {
    let account = service::get(&db.conn, id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let agent = AgentType::from_wire(&account.agent_type)
        .ok_or_else(|| AcpError::protocol("Unknown agent account"))?;
    let account = service::resolve(&db.conn, agent, id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    if let Some(reason) = agent_accounts::unsupported_reason(agent) {
        return Err(AcpError::protocol(reason));
    }
    Ok((agent, account))
}

fn check_account_write_paths(
    agent: AgentType,
    account: &agent_account::Model,
) -> Result<(), AcpError> {
    let home = Path::new(&account.home_dir);
    let canonical = home
        .canonicalize()
        .map_err(|_| AcpError::protocol("Restore the account folder before changing sign-in."))?;
    if !crate::parsers::path_eq_for_matching(&canonical.to_string_lossy(), &home.to_string_lossy())
    {
        return Err(AcpError::protocol(
            "The account folder has moved. Restore it before changing sign-in.",
        ));
    }
    account_auth::check_paths(agent, Path::new(&account.home_dir))?;
    Ok(())
}

async fn require_closed(manager: &ConnectionManager, id: &str) -> Result<(), AcpError> {
    if manager.account_has_running_process(id).await {
        return Err(AcpError::protocol(
            "Close this account's chats and wait for the agent to stop before changing sign-in.",
        ));
    }
    Ok(())
}

pub async fn login_method_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    id: &str,
    method: Option<account_auth::AccountAuthMethod>,
    emitter: &EventEmitter,
) -> Result<crate::commands::custom_agents::ExtraSlotLoginResult, AcpError> {
    let (agent, account) = resolved_account(db, id).await?;
    if let Some(method) = method {
        if !account_auth::methods(agent).contains(&method)
            || method == account_auth::AccountAuthMethod::ApiKey
        {
            return Err(AcpError::protocol(
                "Choose one of this agent's supported sign-in methods.",
            ));
        }
    }
    if agent == AgentType::ClaudeCode && method == Some(account_auth::AccountAuthMethod::SignIn) {
        let _guard = manager.lock_out_new_connections().await;
        require_closed(manager, id).await?;
        check_account_write_paths(agent, &account)?;
        account_auth::set_claude_key(Path::new(&account.home_dir), None)?;
        account_auth::changed();
        crate::commands::acp::emit_acp_agents_updated(emitter, "account_auth_updated", Some(agent));
    }
    login_core(db, id).await
}

pub async fn set_api_key_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    id: &str,
    key: &str,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    account_auth::validate_key(key)?;
    let _guard = manager.lock_out_new_connections().await;
    let (agent, account) = resolved_account(db, id).await?;
    if !account_auth::methods(agent).contains(&account_auth::AccountAuthMethod::ApiKey) {
        return Err(AcpError::protocol(
            "Use this agent's own setup to configure its sign-in.",
        ));
    }
    require_closed(manager, id).await?;
    check_account_write_paths(agent, &account)?;
    let home = Path::new(&account.home_dir);
    match agent {
        AgentType::ClaudeCode => account_auth::set_claude_key(home, Some(key))?,
        AgentType::Codex => {
            let executable = login_executable(agent).await.ok_or_else(|| {
                AcpError::protocol("Install Codex in Settings > Agents before adding its API key.")
            })?;
            let env = account_auth::runtime_env(db, &account, data_dir).await?;
            account_auth::save_codex_key(&executable, home, &env, key).await?;
        }
        _ => unreachable!("supported API-key methods checked above"),
    }
    account_auth::changed();
    crate::commands::acp::emit_acp_agents_updated(emitter, "account_auth_updated", Some(agent));
    Ok(())
}

pub async fn check_auth_core(
    db: &AppDatabase,
    data_dir: &Path,
    id: &str,
    emitter: &EventEmitter,
) -> Result<account_auth::AccountAuthStatus, AcpError> {
    let (agent, account) = resolved_account(db, id).await?;
    if !matches!(agent, AgentType::ClaudeCode | AgentType::Codex) {
        return Ok(account_auth::AccountAuthStatus {
            state: account_auth::AuthState::Unavailable,
            method: None,
        });
    }
    let executable = login_executable(agent).await.ok_or_else(|| {
        AcpError::protocol("Install the agent in Settings > Agents before checking sign-in.")
    })?;
    let env = account_auth::runtime_env(db, &account, data_dir).await?;
    let status =
        account_auth::check(agent, &executable, Path::new(&account.home_dir), &env).await?;
    account_auth::changed();
    crate::commands::acp::emit_acp_agents_updated(emitter, "account_auth_checked", Some(agent));
    Ok(status)
}

/// The official sign-in command for `agent`, run with `env` pointing it at an
/// isolated home: a native account's, or a custom agent's extra slot. Shared
/// so the two cannot drift apart.
pub(crate) async fn isolated_login_command(
    agent: AgentType,
    mut env: BTreeMap<String, String>,
) -> Result<String, AcpError> {
    let spec = agent_accounts::layout(agent)
        .ok_or_else(|| AcpError::protocol("This agent does not support isolated sign-in"))?;
    // Credentials inherited from the terminal would sign in, or be used,
    // instead of the isolated home's own login. A value `env` sets itself is
    // the caller's choice and stays.
    for key in agent_accounts::credential_env_keys(agent) {
        env.entry(key.into()).or_default();
    }
    let cli = spec
        .login
        .first()
        .ok_or_else(|| AcpError::protocol("Use browser sign-in for this account"))?;
    let executable = login_executable(agent)
        .await
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| (*cli).into());
    let mut argv = vec![executable.as_str()];
    argv.extend_from_slice(&spec.login[1..]);
    crate::acp::family_isolator::shell_command_with_env(&env, &argv).map_err(AcpError::protocol)
}

pub(crate) async fn login_executable(agent: AgentType) -> Option<std::path::PathBuf> {
    let cli = *agent_accounts::layout(agent)?.login.first()?;
    // Managed binaries and npm prefixes need not be on a terminal's PATH.
    // Resolve the vendor CLI, never the adapter's ACP entry point.
    use crate::acp::{binary_cache, registry};
    let meta = registry::get_agent_meta(agent);
    if let registry::AgentDistribution::Binary { cmd, .. } = &meta.distribution {
        binary_cache::find_best_cached_binary_for_agent(agent, cmd)
            .ok()
            .flatten()
            .map(|(path, _)| path)
            .or_else(|| crate::commands::acp::resolve_system_agent_binary_for(agent, cli))
    } else if let Some(relation) = registry::acp_adapter_relation(agent) {
        crate::commands::acp::resolve_vendor_cli(cli, relation.extra_dirs).await
    } else {
        crate::commands::acp::resolve_npx_command(cli).await
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_list_agent_accounts(
    agent_type: AgentType,
    db: State<'_, AppDatabase>,
) -> Result<AccountsResult, AcpError> {
    list_core(&db, agent_type).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_create_agent_account(
    agent_type: AgentType,
    name: String,
    home_dir: Option<String>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<agent_account::Model, AcpError> {
    let data = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    create_core(
        &db,
        &data,
        agent_type,
        &name,
        home_dir.as_deref(),
        &EventEmitter::Tauri(app),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_rename_agent_account(
    account_id: String,
    name: String,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    rename_core(&db, &account_id, &name, &EventEmitter::Tauri(app)).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_remove_agent_account(
    account_id: String,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    remove_core(&db, &account_id, &EventEmitter::Tauri(app)).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_login_agent_account(
    account_id: String,
    method: Option<account_auth::AccountAuthMethod>,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
    app: tauri::AppHandle,
) -> Result<crate::commands::custom_agents::ExtraSlotLoginResult, AcpError> {
    let result = login_method_core(
        &db,
        &manager,
        &account_id,
        method,
        &EventEmitter::Tauri(app),
    )
    .await?;
    #[cfg(not(test))]
    let result = {
        let mut result = result;
        result.launched =
            crate::commands::acp::open_external_terminal_impl(&result.command, Some(&result.home))
                .is_ok();
        result
    };
    Ok(result)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_set_agent_account_api_key(
    account_id: String,
    api_key: String,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let data = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(|_| AcpError::protocol("Could not open account settings."))?;
    set_api_key_core(
        &db,
        &manager,
        &data,
        &account_id,
        &api_key,
        &EventEmitter::Tauri(app),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_check_agent_account_auth(
    account_id: String,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<account_auth::AccountAuthStatus, AcpError> {
    let data = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(|_| AcpError::protocol("Could not open account settings."))?;
    check_auth_core(&db, &data, &account_id, &EventEmitter::Tauri(app)).await
}
