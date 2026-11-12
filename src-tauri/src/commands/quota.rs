#[cfg(feature = "tauri-runtime")]
use std::sync::Arc;

use crate::app_error::AppCommandError;
use crate::db::service::agent_setting_service;
use crate::db::AppDatabase;
use crate::models::{AgentQuotaInfo, AgentType};
use crate::parsers::AgentEnv;
use crate::quota::QuotaManager;

async fn resolve_agent_quota_context(
    db: Option<&AppDatabase>,
    agent_type_str: &str,
) -> (AgentEnv, Option<i32>) {
    let Some(db) = db else {
        return (AgentEnv::inherited(), None);
    };
    let Ok(parsed_type) = serde_json::from_value::<AgentType>(serde_json::Value::String(
        agent_type_str.to_string(),
    )) else {
        return (AgentEnv::inherited(), None);
    };

    let setting = agent_setting_service::get_by_agent_type(&db.conn, parsed_type)
        .await
        .ok()
        .flatten();
    let model_provider_id = setting.as_ref().and_then(|s| s.model_provider_id);
    let local_config_json = crate::commands::acp::load_agent_local_config_json(parsed_type);
    let runtime_env = crate::commands::acp::build_runtime_env_from_setting(
        parsed_type,
        setting.as_ref(),
        local_config_json.as_deref(),
    );

    (AgentEnv::from_overrides(runtime_env), model_provider_id)
}

pub async fn get_agent_quota_core(
    quota_manager: &QuotaManager,
    agent_type: &str,
) -> Result<AgentQuotaInfo, AppCommandError> {
    get_agent_quota_with_db_core(quota_manager, None, agent_type).await
}

pub async fn get_agent_quota_with_db_core(
    quota_manager: &QuotaManager,
    db: Option<&AppDatabase>,
    agent_type: &str,
) -> Result<AgentQuotaInfo, AppCommandError> {
    let (env, model_provider_id) = resolve_agent_quota_context(db, agent_type).await;
    quota_manager
        .get_quota_for_env(agent_type, &env, model_provider_id)
        .await
        .map_err(|e| AppCommandError::external_command("Failed to get agent quota", e))
}

pub async fn refresh_agent_quota_core(
    quota_manager: &QuotaManager,
    agent_type: &str,
) -> Result<AgentQuotaInfo, AppCommandError> {
    refresh_agent_quota_with_db_core(quota_manager, None, agent_type).await
}

pub async fn refresh_agent_quota_with_db_core(
    quota_manager: &QuotaManager,
    db: Option<&AppDatabase>,
    agent_type: &str,
) -> Result<AgentQuotaInfo, AppCommandError> {
    let (env, model_provider_id) = resolve_agent_quota_context(db, agent_type).await;
    quota_manager
        .fetch_quota_for_env(agent_type, &env, model_provider_id)
        .await
        .map_err(|e| AppCommandError::external_command("Failed to refresh agent quota", e))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_agent_quota(
    #[cfg(feature = "tauri-runtime")] quota_manager: tauri::State<'_, Arc<QuotaManager>>,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, AppDatabase>,
    agent_type: String,
) -> Result<AgentQuotaInfo, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        get_agent_quota_with_db_core(&quota_manager, Some(&db), &agent_type).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = agent_type;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn refresh_agent_quota(
    #[cfg(feature = "tauri-runtime")] quota_manager: tauri::State<'_, Arc<QuotaManager>>,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, AppDatabase>,
    agent_type: String,
) -> Result<AgentQuotaInfo, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        refresh_agent_quota_with_db_core(&quota_manager, Some(&db), &agent_type).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = agent_type;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}
