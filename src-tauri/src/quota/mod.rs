//! Quota and rate-limit manager for AI coding agents.

pub mod antigravity;
pub mod codex;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::models::AgentQuotaInfo;

/// Default time-to-live for cached quota information (30 seconds).
pub const DEFAULT_QUOTA_TTL: Duration = Duration::from_secs(30);

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
    /// Create a new QuotaManager with the default TTL (30s).
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

    /// Get quota for an agent. Returns cached info if valid; otherwise fetches fresh info.
    pub async fn get_quota(&self, agent_type: &str) -> Result<AgentQuotaInfo, String> {
        if let Some(cached) = self.get_cached(agent_type).await {
            return Ok(cached);
        }
        self.fetch_quota(agent_type).await
    }

    /// Fetch fresh quota from the respective agent backend and cache it.
    pub async fn fetch_quota(&self, agent_type: &str) -> Result<AgentQuotaInfo, String> {
        let info = match agent_type {
            "codex" => self.fetch_codex_quota().await?,
            "antigravity" => self.fetch_antigravity_quota().await?,
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

        // Wait for TTL to expire
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
}
