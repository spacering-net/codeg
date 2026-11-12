//! Quota and rate-limit manager for AI coding agents.
//!
//! Includes:
//! - `QuotaProbePolicy`: Smart per-agent `CODEG_QUOTA_PROBE_MODE` (`auto` | `on` | `off`)
//!   that automatically enables quota probing when an agent is in official
//!   account/subscription login mode and disables it when switched to a 3rd-party
//!   API key, custom Base URL, or bound Model Provider.
//! - `QuotaManager`: Unified in-memory cache and dispatcher for Codex (zero-network
//!   rollout log extraction + cold-start fallback) and Antigravity (including custom
//!   `agy_acp_server` instances via `GEMINI_HOME`).

pub mod antigravity;
pub mod codex;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::acp::file_system_runtime::env_value;
use crate::models::{AgentQuotaInfo, AgentType};
use crate::parsers::AgentEnv;

/// Per-agent `env_json` key controlling whether subscription quota probing is enabled.
/// Values: `"auto"` (default: enabled iff official account login is active), `"on"`, `"off"`.
pub const QUOTA_PROBE_MODE_ENV: &str = "CODEG_QUOTA_PROBE_MODE";

/// Default time-to-live for cached quota information (180 seconds = 3 minutes).
pub const DEFAULT_QUOTA_TTL: Duration = Duration::from_secs(180);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuotaProbeMode {
    /// Follow authentication mode: enabled iff official account/subscription login is active.
    Auto,
    /// Explicitly enabled by the user.
    On,
    /// Explicitly disabled by the user even in official account login mode.
    Off,
}

impl QuotaProbeMode {
    pub fn from_env_map(runtime_env: &BTreeMap<String, String>) -> Self {
        match env_value(runtime_env, QUOTA_PROBE_MODE_ENV).as_deref() {
            None | Some("") | Some("auto") => Self::Auto,
            Some("on") | Some("true") | Some("1") => Self::On,
            Some("off") | Some("false") | Some("0") => Self::Off,
            Some(_) => Self::Auto,
        }
    }

    pub fn from_agent_env(env: &AgentEnv) -> Self {
        match env.var(QUOTA_PROBE_MODE_ENV).as_deref().map(str::trim) {
            None | Some("") | Some("auto") => Self::Auto,
            Some("on") | Some("true") | Some("1") => Self::On,
            Some("off") | Some("false") | Some("0") => Self::Off,
            Some(_) => Self::Auto,
        }
    }
}

/// Checks whether a custom agent is an Antigravity (`agy_acp_server`) instance.
pub fn is_custom_antigravity_agent(agent_type: &str, env: &AgentEnv) -> bool {
    let Some(custom_id) = agent_type.strip_prefix("custom:") else {
        return false;
    };
    if custom_id.to_ascii_lowercase().contains("antigravity")
        || custom_id.to_ascii_lowercase().starts_with("agy")
    {
        return true;
    }
    if env
        .var("GEMINI_HOME")
        .is_some_and(|v| !v.trim().is_empty())
        || env
            .var("AGY_AUTH_METHOD")
            .is_some_and(|v| !v.trim().is_empty())
    {
        return true;
    }
    if let Ok(parsed_type) = serde_json::from_value::<AgentType>(serde_json::Value::String(
        agent_type.to_string(),
    )) {
        let meta = crate::acp::registry::get_agent_meta(parsed_type);
        {
            let desc_lower = meta.description.to_ascii_lowercase();
            let name_lower = meta.name.to_ascii_lowercase();
            if name_lower.contains("antigravity") || desc_lower.contains("antigravity") {
                return true;
            }
        }
    }
    false
}

/// Determines whether an agent is in official account/subscription login mode
/// (as opposed to 3rd-party API Key, custom Base URL, or bound Model Provider).
pub fn is_agent_official_subscription_mode(
    agent_type: &str,
    env: &AgentEnv,
    model_provider_id: Option<i32>,
) -> bool {
    if model_provider_id.is_some() {
        return false;
    }
    match agent_type {
        "codex" => codex::is_codex_official_subscription(env, model_provider_id),
        "antigravity" => antigravity::is_antigravity_official_subscription(env, model_provider_id),
        other if is_custom_antigravity_agent(other, env) => {
            antigravity::is_antigravity_official_subscription(env, model_provider_id)
        }
        "claude_code" => {
            env.var("ANTHROPIC_BASE_URL")
                .is_none_or(|v| v.trim().is_empty())
                && env
                    .var("ANTHROPIC_API_KEY")
                    .is_none_or(|v| v.trim().is_empty())
                && env
                    .var("ANTHROPIC_AUTH_TOKEN")
                    .is_none_or(|v| v.trim().is_empty())
        }
        "gemini" => {
            env.var("GEMINI_API_KEY")
                .is_none_or(|v| v.trim().is_empty())
                && env
                    .var("GOOGLE_API_KEY")
                    .is_none_or(|v| v.trim().is_empty())
                && env
                    .var("GOOGLE_GEMINI_BASE_URL")
                    .is_none_or(|v| v.trim().is_empty())
                && env
                    .var("GOOGLE_GENAI_USE_VERTEXAI")
                    .is_none_or(|v| v.trim() != "true")
        }
        "cursor" => {
            env.var("CURSOR_AUTH_MODE")
                .is_none_or(|v| v.trim() != "custom")
                && env
                    .var("CURSOR_API_KEY")
                    .is_none_or(|v| v.trim().is_empty())
        }
        "grok" => {
            env.var("GROK_AUTH_MODE")
                .is_none_or(|v| v.trim() == "subscription" || v.trim().is_empty())
                && env.var("XAI_API_KEY").is_none_or(|v| v.trim().is_empty())
        }
        "kimi_code" => {
            env.var("KIMI_API_KEY")
                .is_none_or(|v| v.trim().is_empty())
                && env
                    .var("KIMI_BASE_URL")
                    .is_none_or(|v| v.trim().is_empty())
        }
        "kiro" => env.var("KIRO_API_KEY").is_none_or(|v| v.trim().is_empty()),
        "qoder" => env
            .var("QODER_PERSONAL_ACCESS_TOKEN")
            .is_none_or(|v| v.trim().is_empty()),
        "trae" => env
            .var("TRAECLI_PERSONAL_ACCESS_TOKEN")
            .is_none_or(|v| v.trim().is_empty()),
        "command_code" => env
            .var("COMMAND_CODE_API_KEY")
            .is_none_or(|v| v.trim().is_empty()),
        "cline" => {
            env.var("CLINE_API_KEY")
                .is_none_or(|v| v.trim().is_empty())
                && env
                    .var("CLINE_BASE_URL")
                    .is_none_or(|v| v.trim().is_empty())
        }
        "zcode" => true,
        _ => false,
    }
}

/// Evaluates whether quota probing is effectively enabled for `agent_type` given
/// its environment and `model_provider_id`.
pub fn is_quota_probe_enabled(
    agent_type: &str,
    env: &AgentEnv,
    model_provider_id: Option<i32>,
) -> bool {
    if !is_agent_official_subscription_mode(agent_type, env, model_provider_id) {
        return false;
    }
    match QuotaProbeMode::from_agent_env(env) {
        QuotaProbeMode::Auto | QuotaProbeMode::On => true,
        QuotaProbeMode::Off => false,
    }
}

/// Centralized manager for querying and caching agent quotas.
#[derive(Debug, Clone)]
pub struct QuotaManager {
    cache: Arc<RwLock<HashMap<String, (AgentQuotaInfo, Instant)>>>,
    ttl: Duration,
}

impl Default for QuotaManager {
    fn default() -> Self {
        Self::new()
    }
}

impl QuotaManager {
    /// Create a new QuotaManager with the default TTL (180s).
    pub fn new() -> Self {
        Self::with_ttl(DEFAULT_QUOTA_TTL)
    }

    /// Create a new QuotaManager with a custom TTL.
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            ttl,
        }
    }

    /// Get configured TTL.
    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    /// Retrieve cached quota info for `agent_type` if it exists and has not expired.
    pub async fn get_cached(&self, agent_type: &str) -> Option<AgentQuotaInfo> {
        let cache = self.cache.read().await;
        if let Some((info, cached_at)) = cache.get(agent_type) {
            if cached_at.elapsed() < self.ttl {
                return Some(info.clone());
            }
        }
        None
    }

    /// Insert or update the cached quota for `agent_type`.
    pub async fn cache_quota(&self, agent_type: &str, info: AgentQuotaInfo) {
        let mut cache = self.cache.write().await;
        cache.insert(agent_type.to_string(), (info, Instant::now()));
    }

    /// Invalidate the cache entry for a given agent type.
    pub async fn invalidate(&self, agent_type: &str) {
        let mut cache = self.cache.write().await;
        cache.remove(agent_type);
    }

    /// Clear all cached quota entries.
    pub async fn clear(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
    }

    /// Get quota for an agent using the inherited environment.
    pub async fn get_quota(&self, agent_type: &str) -> Result<AgentQuotaInfo, String> {
        self.get_quota_for_env(agent_type, &AgentEnv::inherited(), None)
            .await
    }

    /// Get quota for an agent with its configured `AgentEnv` and `model_provider_id`.
    /// Returns cached info if valid; otherwise fetches fresh info.
    pub async fn get_quota_for_env(
        &self,
        agent_type: &str,
        env: &AgentEnv,
        model_provider_id: Option<i32>,
    ) -> Result<AgentQuotaInfo, String> {
        if !is_quota_probe_enabled(agent_type, env, model_provider_id) {
            return Err(format!(
                "Quota probing is disabled for agent '{agent_type}' (non-subscription mode or turned off)"
            ));
        }
        if let Some(cached) = self.get_cached(agent_type).await {
            return Ok(cached);
        }
        self.fetch_quota_for_env(agent_type, env, model_provider_id)
            .await
    }

    /// Fetch fresh quota from the respective agent backend using the inherited environment.
    pub async fn fetch_quota(&self, agent_type: &str) -> Result<AgentQuotaInfo, String> {
        self.fetch_quota_for_env(agent_type, &AgentEnv::inherited(), None)
            .await
    }

    /// Fetch fresh quota from the respective agent backend and cache it.
    pub async fn fetch_quota_for_env(
        &self,
        agent_type: &str,
        env: &AgentEnv,
        model_provider_id: Option<i32>,
    ) -> Result<AgentQuotaInfo, String> {
        if !is_quota_probe_enabled(agent_type, env, model_provider_id) {
            return Err(format!(
                "Quota probing is disabled for agent '{agent_type}' (non-subscription mode or turned off)"
            ));
        }

        let info = match agent_type {
            "codex" => codex::fetch_codex_quota_for_env(env).await?,
            "antigravity" => antigravity::fetch_antigravity_quota_for_env("antigravity", env).await?,
            other if is_custom_antigravity_agent(other, env) => {
                antigravity::fetch_antigravity_quota_for_env(other, env).await?
            }
            other => {
                return Err(format!("Quota fetching not implemented for agent '{other}'"));
            }
        };

        self.cache_quota(agent_type, info.clone()).await;
        Ok(info)
    }

    /// Fetch Codex quota skeleton.
    pub async fn fetch_codex_quota(&self) -> Result<AgentQuotaInfo, String> {
        codex::fetch_codex_quota().await
    }

    /// Fetch Antigravity quota skeleton.
    pub async fn fetch_antigravity_quota(&self) -> Result<AgentQuotaInfo, String> {
        antigravity::fetch_antigravity_quota().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use tokio::time::sleep;

    #[tokio::test]
    async fn test_cache_and_get() {
        let manager = QuotaManager::new();
        let now = Utc::now();
        let info = AgentQuotaInfo::new("codex", now);

        assert_eq!(manager.get_cached("codex").await, None);

        manager.cache_quota("codex", info.clone()).await;
        let cached = manager.get_cached("codex").await;
        assert_eq!(cached, Some(info));
    }

    #[tokio::test]
    async fn test_cache_ttl_expiration() {
        let ttl = Duration::from_millis(50);
        let manager = QuotaManager::with_ttl(ttl);
        let now = Utc::now();
        let info = AgentQuotaInfo::new("antigravity", now);

        manager.cache_quota("antigravity", info.clone()).await;
        assert_eq!(manager.get_cached("antigravity").await, Some(info.clone()));

        sleep(Duration::from_millis(70)).await;
        assert_eq!(manager.get_cached("antigravity").await, None);
    }

    #[tokio::test]
    async fn test_invalidate_and_clear() {
        let manager = QuotaManager::new();
        let now = Utc::now();
        let codex_info = AgentQuotaInfo::new("codex", now);
        let antigravity_info = AgentQuotaInfo::new("antigravity", now);

        manager.cache_quota("codex", codex_info.clone()).await;
        manager
            .cache_quota("antigravity", antigravity_info.clone())
            .await;

        manager.invalidate("codex").await;
        assert_eq!(manager.get_cached("codex").await, None);
        assert_eq!(
            manager.get_cached("antigravity").await,
            Some(antigravity_info)
        );

        manager.clear().await;
        assert_eq!(manager.get_cached("antigravity").await, None);
    }

    #[tokio::test]
    async fn test_get_quota_caches_result() {
        let manager = QuotaManager::new();
        assert_eq!(manager.get_cached("codex").await, None);

        let quota = manager.get_quota("codex").await.expect("get_quota");
        assert_eq!(quota.agent_type, "codex");

        let cached = manager.get_cached("codex").await;
        assert_eq!(cached, Some(quota));
    }

    #[tokio::test]
    async fn test_get_quota_unsupported_agent() {
        let manager = QuotaManager::new();
        let result = manager.get_quota("unknown_agent").await;
        assert!(result.is_err());
    }

    #[test]
    fn test_quota_probe_policy_across_agents() {
        // 1. Antigravity in oauth-personal => auto enabled
        let agy_oauth = AgentEnv::from_env_json(Some(r#"{"AGY_AUTH_METHOD":"oauth-personal"}"#));
        assert!(is_quota_probe_enabled("antigravity", &agy_oauth, None));

        // 2. Antigravity in oauth-personal but user manually turned OFF
        let agy_off = AgentEnv::from_env_json(Some(
            r#"{"AGY_AUTH_METHOD":"oauth-personal","CODEG_QUOTA_PROBE_MODE":"off"}"#,
        ));
        assert!(!is_quota_probe_enabled("antigravity", &agy_off, None));

        // 3. Antigravity in gemini-api-key => automatically disabled even if CODEG_QUOTA_PROBE_MODE=on
        let agy_apikey = AgentEnv::from_env_json(Some(
            r#"{"AGY_AUTH_METHOD":"gemini-api-key","CODEG_QUOTA_PROBE_MODE":"on"}"#,
        ));
        assert!(!is_quota_probe_enabled("antigravity", &agy_apikey, None));

        // 4. Custom Antigravity instance with GEMINI_HOME => auto enabled
        let custom_agy =
            AgentEnv::from_env_json(Some(r#"{"GEMINI_HOME":"C:\\Users\\Admin\\.gemini-b"}"#));
        assert!(is_custom_antigravity_agent("custom:antigravity-b", &custom_agy));
        assert!(is_quota_probe_enabled("custom:antigravity-b", &custom_agy, None));

        // 5. Claude Code with 3rd-party ANTHROPIC_BASE_URL => automatically disabled
        let claude_proxy = AgentEnv::from_env_json(Some(
            r#"{"ANTHROPIC_BASE_URL":"http://192.168.30.98:13000","ANTHROPIC_AUTH_TOKEN":"sk-xxx"}"#,
        ));
        assert!(!is_quota_probe_enabled("claude_code", &claude_proxy, None));

        // 6. Pure API-key agents => always disabled
        assert!(!is_quota_probe_enabled(
            "open_code",
            &AgentEnv::inherited(),
            None
        ));
        assert!(!is_quota_probe_enabled(
            "deepseek",
            &AgentEnv::inherited(),
            None
        ));
    }
}
