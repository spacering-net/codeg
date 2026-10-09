//! OpenCode provider catalog backed by [models.dev](https://models.dev).
//!
//! OpenCode resolves its built-in providers and their model lists from the
//! models.dev registry (`https://models.dev/api.json`). To drive a guided
//! "connect a provider" experience we mirror that catalog here, normalized to
//! a slim shape the frontend can render.
//!
//! Resolution order (most fresh first):
//! 1. live fetch of `models.dev/api.json` (when forced, or when the cache is
//!    stale), normalized and written back to the on-disk cache;
//! 2. the on-disk cache under `<data_dir>/cache/opencode/models-dev.json`;
//! 3. the snapshot bundled into the binary, so the catalog is always available
//!    offline.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;

/// models.dev JSON API — the same source OpenCode itself reads.
pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";

/// Cache lifetime before we attempt a fresh fetch. Stale cache is still used as
/// a fallback when the network is unavailable.
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Snapshot bundled at build time so the catalog works fully offline. Generated
/// from the live models.dev API, already normalized to [`CatalogProvider`].
const BUNDLED_SNAPSHOT: &str = include_str!("../../resources/opencode/models-dev.json");

/// Providers OpenCode can authenticate with an OAuth/browser flow rather than a
/// pasted API key (ChatGPT Plus/Pro, GitHub Copilot, GitLab Duo). Everything
/// else is treated as an API-key provider. Anthropic Claude Pro/Max OAuth is
/// intentionally excluded — OpenCode removed its bundled plugin and Anthropic
/// prohibits third-party OAuth use.
fn is_oauth_provider(provider_id: &str) -> bool {
    matches!(provider_id, "openai" | "github-copilot" | "gitlab")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub tool_call: bool,
    #[serde(default)]
    pub context: Option<u64>,
    #[serde(default)]
    pub cost_in: Option<f64>,
    #[serde(default)]
    pub cost_out: Option<f64>,
    #[serde(default)]
    pub cost_cache_read: Option<f64>,
    #[serde(default)]
    pub cost_cache_write: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogProvider {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub npm: Option<String>,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub doc: Option<String>,
    /// `"api"` or `"oauth"`.
    pub auth_kind: String,
    #[serde(default)]
    pub models: Vec<CatalogModel>,
}

/// Normalize the raw models.dev `api.json` (a `{ providerId: Provider }` map)
/// into the slim catalog shape. Tolerant of missing/extra fields.
pub fn normalize_models_dev(raw: &str) -> Result<Vec<CatalogProvider>, AppCommandError> {
    let root: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| AppCommandError::configuration_invalid(format!("parse models.dev: {e}")))?;
    let obj = root.as_object().ok_or_else(|| {
        AppCommandError::configuration_invalid("models.dev root is not a JSON object")
    })?;

    let mut providers = Vec::with_capacity(obj.len());
    for (key, raw_provider) in obj {
        let Some(p) = raw_provider.as_object() else {
            continue;
        };
        let id = p
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(key)
            .to_string();
        let name = p
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&id)
            .to_string();
        let npm = p
            .get("npm")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let doc = p
            .get("doc")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let env = p
            .get("env")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let auth_kind = if is_oauth_provider(&id) { "oauth" } else { "api" }.to_string();

        let mut models = Vec::new();
        if let Some(model_obj) = p.get("models").and_then(|v| v.as_object()) {
            for (model_key, raw_model) in model_obj {
                let Some(m) = raw_model.as_object() else {
                    continue;
                };
                let model_id = m
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(model_key)
                    .to_string();
                let model_name = m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&model_id)
                    .to_string();
                models.push(CatalogModel {
                    id: model_id,
                    name: model_name,
                    reasoning: m.get("reasoning").and_then(|v| v.as_bool()).unwrap_or(false),
                    tool_call: m.get("tool_call").and_then(|v| v.as_bool()).unwrap_or(false),
                    context: m
                        .get("limit")
                        .and_then(|v| v.get("context"))
                        .and_then(|v| v.as_u64()),
                    cost_in: m
                        .get("cost")
                        .and_then(|v| v.get("input"))
                        .and_then(|v| v.as_f64()),
                    cost_out: m
                        .get("cost")
                        .and_then(|v| v.get("output"))
                        .and_then(|v| v.as_f64()),
                    cost_cache_read: m
                        .get("cost")
                        .and_then(|v| v.get("cache_read"))
                        .and_then(|v| v.as_f64()),
                    cost_cache_write: m
                        .get("cost")
                        .and_then(|v| v.get("cache_write"))
                        .and_then(|v| v.as_f64()),
                });
            }
        }
        models.sort_by(|a, b| a.id.cmp(&b.id));

        providers.push(CatalogProvider {
            id,
            name,
            npm,
            env,
            doc,
            auth_kind,
            models,
        });
    }

    providers.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(providers)
}

/// The snapshot compiled into the binary. Always available; the last-resort
/// fallback when both the network and the on-disk cache are unavailable.
pub fn bundled_catalog() -> Vec<CatalogProvider> {
    serde_json::from_str::<Vec<CatalogProvider>>(BUNDLED_SNAPSHOT).unwrap_or_default()
}

fn cache_path(data_dir: &Path) -> PathBuf {
    // v2: cache_read / cache_write joined the slim shape. A new filename so
    // an existing 24h cache is not served without those fields until it ages
    // out, which would leave cache tokens unpriced on Token Usage.
    data_dir
        .join("cache")
        .join("opencode")
        .join("models-dev-v2.json")
}

fn read_cache(data_dir: &Path, require_fresh: bool) -> Option<Vec<CatalogProvider>> {
    let path = cache_path(data_dir);
    let metadata = std::fs::metadata(&path).ok()?;
    if require_fresh {
        let age = metadata
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())?;
        if age > CACHE_TTL {
            return None;
        }
    }
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<Vec<CatalogProvider>>(&text).ok()
}

fn write_cache(data_dir: &Path, providers: &[CatalogProvider]) {
    let path = cache_path(data_dir);
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(text) = serde_json::to_string(providers) {
        let _ = std::fs::write(&path, text);
    }
}

async fn fetch_live() -> Result<Vec<CatalogProvider>, AppCommandError> {
    // reqwest has no default timeout — without these, a black-holed connection
    // would hang the request forever and the UI would spin indefinitely.
    // Bounded here so a slow/blocked network fails fast and we fall back to the
    // on-disk cache or the bundled snapshot.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| {
            AppCommandError::network(format!("failed to build models.dev http client: {e}"))
        })?;
    let response = client
        .get(MODELS_DEV_URL)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("failed to fetch models.dev catalog: {e}")))?;
    if !response.status().is_success() {
        return Err(AppCommandError::network(format!(
            "failed to fetch models.dev catalog: HTTP {}",
            response.status()
        )));
    }
    let text = response.text().await.map_err(|e| {
        AppCommandError::network(format!("failed to read models.dev response: {e}"))
    })?;
    normalize_models_dev(&text)
}

/// Resolve the OpenCode provider catalog with the live → cache → snapshot
/// fallback chain. Infallible: the bundled snapshot guarantees a result.
pub async fn provider_catalog(data_dir: &Path, force_refresh: bool) -> Vec<CatalogProvider> {
    if !force_refresh {
        if let Some(fresh) = read_cache(data_dir, true) {
            return fresh;
        }
    }

    match fetch_live().await {
        Ok(providers) if !providers.is_empty() => {
            write_cache(data_dir, &providers);
            providers
        }
        _ => read_cache(data_dir, false).unwrap_or_else(bundled_catalog),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_snapshot_parses_and_is_non_trivial() {
        let catalog = bundled_catalog();
        assert!(
            catalog.len() > 50,
            "bundled snapshot should carry the full models.dev catalog, got {}",
            catalog.len()
        );
        let openai = catalog.iter().find(|p| p.id == "openai");
        assert!(openai.is_some(), "snapshot must include the openai provider");
        let openai = openai.unwrap();
        assert_eq!(openai.auth_kind, "oauth");
        assert!(!openai.models.is_empty());
    }

    #[test]
    fn oauth_classification_matches_opencode() {
        assert!(is_oauth_provider("openai"));
        assert!(is_oauth_provider("github-copilot"));
        assert!(is_oauth_provider("gitlab"));
        assert!(!is_oauth_provider("anthropic"));
        assert!(!is_oauth_provider("openrouter"));
    }

    #[test]
    fn normalize_extracts_slim_shape() {
        let raw = r#"{
            "demo": {
                "id": "demo",
                "name": "Demo Co",
                "npm": "@ai-sdk/openai-compatible",
                "env": ["DEMO_API_KEY"],
                "doc": "https://demo.example/docs",
                "models": {
                    "demo-large": {
                        "id": "demo-large",
                        "name": "Demo Large",
                        "reasoning": true,
                        "tool_call": true,
                        "limit": { "context": 128000, "output": 8192 },
                        "cost": {
                            "input": 1.5,
                            "output": 6.0,
                            "cache_read": 0.15,
                            "cache_write": 1.875
                        }
                    },
                    "demo-free": {
                        "id": "demo-free",
                        "name": "Demo Free",
                        "cost": { "input": 0.0, "output": 0.0 }
                    }
                }
            }
        }"#;
        let providers = normalize_models_dev(raw).expect("normalize");
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p.id, "demo");
        assert_eq!(p.name, "Demo Co");
        assert_eq!(p.npm.as_deref(), Some("@ai-sdk/openai-compatible"));
        assert_eq!(p.env, vec!["DEMO_API_KEY".to_string()]);
        assert_eq!(p.auth_kind, "api");
        assert_eq!(p.models.len(), 2);
        let m = p
            .models
            .iter()
            .find(|m| m.id == "demo-large")
            .expect("demo-large");
        assert!(m.reasoning);
        assert!(m.tool_call);
        assert_eq!(m.context, Some(128000));
        assert_eq!(m.cost_in, Some(1.5));
        assert_eq!(m.cost_out, Some(6.0));
        assert_eq!(m.cost_cache_read, Some(0.15));
        assert_eq!(m.cost_cache_write, Some(1.875));
        let free = p
            .models
            .iter()
            .find(|m| m.id == "demo-free")
            .expect("demo-free");
        assert_eq!(free.cost_in, Some(0.0));
        assert_eq!(free.cost_cache_read, None);
        assert_eq!(free.cost_cache_write, None);
    }

    #[test]
    fn normalize_rejects_non_object_root() {
        assert!(normalize_models_dev("[]").is_err());
        assert!(normalize_models_dev("not json").is_err());
    }
}
