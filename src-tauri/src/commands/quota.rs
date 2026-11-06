#[cfg(feature = "tauri-runtime")]
use std::sync::Arc;

use crate::app_error::AppCommandError;
use crate::models::AgentQuotaInfo;
use crate::quota::QuotaManager;

pub async fn get_agent_quota_core(
    quota_manager: &QuotaManager,
    agent_type: &str,
) -> Result<AgentQuotaInfo, AppCommandError> {
    quota_manager
        .get_quota(agent_type)
        .await
        .map_err(|e| AppCommandError::external_command("Failed to get agent quota", e))
}

pub async fn refresh_agent_quota_core(
    quota_manager: &QuotaManager,
    agent_type: &str,
) -> Result<AgentQuotaInfo, AppCommandError> {
    quota_manager
        .fetch_quota(agent_type)
        .await
        .map_err(|e| AppCommandError::external_command("Failed to refresh agent quota", e))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_agent_quota(
    #[cfg(feature = "tauri-runtime")] quota_manager: tauri::State<'_, Arc<QuotaManager>>,
    agent_type: String,
) -> Result<AgentQuotaInfo, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        get_agent_quota_core(&quota_manager, &agent_type).await
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
    agent_type: String,
) -> Result<AgentQuotaInfo, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        refresh_agent_quota_core(&quota_manager, &agent_type).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = agent_type;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}
