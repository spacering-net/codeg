//! The model catalog: litellm's public price/context table, trimmed to what a
//! custom model form can use.
//!
//! Resolution order (most fresh first):
//! 1. a live fetch of the configured URL (when forced, or when the cache is
//!    stale), trimmed and written back to `<data_dir>/cache/model-catalog/`;
//! 2. that on-disk cache, however old it is;
//! 3. the snapshot bundled into the binary, so the catalog always resolves.
//!
//! There is no mirror fallback: one URL, configurable in System settings, and a
//! failure says so while the old cache keeps serving.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;

pub mod scheduler;

/// Where the catalog comes from unless the user changes it.
pub const DEFAULT_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

pub const MODEL_CATALOG_SETTINGS_KEY: &str = "model_catalog_settings";

/// Emitted after a background refresh, so an open settings page repaints its
/// status without polling.
pub const MODEL_CATALOG_REFRESHED_EVENT: &str = "app://model-catalog-refreshed";

/// How long a cache counts as current before a refresh is attempted.
pub const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Trimmed snapshot compiled into the binary.
const BUNDLED_SNAPSHOT: &str = include_str!("../../resources/model-catalog/litellm.json");

/// One model the catalog knows, in the shape a custom-model form needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// The litellm key, provider prefix included (`anthropic/claude-sonnet-4-5`).
    pub id: String,
    /// The id a provider expects, prefix removed (`claude-sonnet-4-5`).
    pub model: String,
    pub provider: String,
    #[serde(default)]
    pub max_input_tokens: Option<u64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub supports_reasoning: bool,
    #[serde(default)]
    pub reasoning_effort_levels: Vec<String>,
    #[serde(default)]
    pub default_reasoning_effort: Option<String>,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_function_calling: bool,
}

/// What the cache and the bundled snapshot hold.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFile {
    /// Unix seconds when this content was fetched; 0 for the bundled snapshot.
    pub fetched_at: i64,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSettings {
    pub url: String,
    pub auto_update: bool,
}

impl Default for CatalogSettings {
    fn default() -> Self {
        Self {
            url: DEFAULT_CATALOG_URL.to_string(),
            auto_update: true,
        }
    }
}

/// Where the entries served right now came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogSource {
    Live,
    Cache,
    Bundled,
}

impl CatalogSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Cache => "cache",
            Self::Bundled => "bundled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    pub url: String,
    pub auto_update: bool,
    pub entry_count: usize,
    /// Unix seconds; `None` for the bundled snapshot.
    pub updated_at: Option<i64>,
    pub source: String,
    /// Why a fetch failed while older entries are being served.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub status: CatalogStatus,
    pub entries: Vec<CatalogEntry>,
}

/// A resolved catalog plus why it is not fresh, if it is not.
pub struct ResolvedCatalog {
    pub file: CatalogFile,
    pub source: CatalogSource,
    pub error: Option<String>,
}

const REASONING_LEVELS: [&str; 7] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// The id a provider expects: litellm keys carry a provider prefix
/// (`anthropic/claude-sonnet-4-5`), forms do not.
fn model_id_of(key: &str) -> String {
    key.split_once('/')
        .map(|(_, rest)| rest)
        .unwrap_or(key)
        .to_string()
}

/// Aggregators and regional resellers list the same models as the original
/// provider; when two entries share a provider-facing id, the original wins so
/// the form is filled from the first-party record.
fn provider_rank(provider: &str) -> u8 {
    const RESELLERS: [&str; 12] = [
        "azure",
        "azure_ai",
        "azure_text",
        "bedrock",
        "bedrock_converse",
        "vertex_ai",
        "openrouter",
        "replicate",
        "databricks",
        "sagemaker",
        "fireworks_ai",
        "together_ai",
    ];
    u8::from(RESELLERS.contains(&provider))
}

fn level_supported(entry: &serde_json::Map<String, serde_json::Value>, level: &str) -> bool {
    entry
        .get(&format!("supports_{level}_reasoning_effort"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn effort_levels_of(entry: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    if let Some(levels) = entry.get("reasoning_effort_levels").and_then(|v| v.as_array()) {
        let levels: Vec<String> = levels
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::to_string)
            .collect();
        if !levels.is_empty() {
            return levels;
        }
    }
    if entry
        .get("supports_reasoning")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return REASONING_LEVELS
            .iter()
            .filter(|level| level_supported(entry, level))
            .map(|level| level.to_string())
            .collect();
    }
    Vec::new()
}

fn supports_vision_of(entry: &serde_json::Map<String, serde_json::Value>) -> bool {
    let flag = |key: &str| {
        entry
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    };
    if flag("supports_vision") || flag("supports_image_input") {
        return true;
    }
    entry
        .get("supported_modalities")
        .and_then(|v| v.as_array())
        .map(|modalities| modalities.iter().any(|m| m.as_str() == Some("image")))
        .unwrap_or(false)
}

fn u64_of(entry: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<u64> {
    entry.get(key).and_then(|v| v.as_u64())
}

/// Trim litellm's table to chat models, one entry per provider-facing id.
///
/// The first entry for an id wins: litellm lists the same model under several
/// regions and resellers (`azure/gpt-5`, `vertex_ai/gpt-5`), and a form asking
/// for "the model id" only needs one.
pub fn normalize_catalog(raw: &str) -> Result<Vec<CatalogEntry>, AppCommandError> {
    let root: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        AppCommandError::configuration_invalid("Failed to parse model catalog").with_detail(e.to_string())
    })?;
    let obj = root.as_object().ok_or_else(|| {
        AppCommandError::configuration_invalid("Model catalog root is not a JSON object")
    })?;

    let mut best: std::collections::BTreeMap<String, (u8, CatalogEntry)> =
        std::collections::BTreeMap::new();
    for (key, raw_entry) in obj {
        let Some(entry) = raw_entry.as_object() else {
            continue;
        };
        if entry.get("mode").and_then(|v| v.as_str()) != Some("chat") {
            continue;
        }
        let model = model_id_of(key);
        let provider = entry
            .get("litellm_provider")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| key.split_once('/').map(|(p, _)| p).unwrap_or(""))
            .to_string();
        let rank = provider_rank(&provider);
        if best
            .get(&model)
            .is_some_and(|(known_rank, _)| *known_rank <= rank)
        {
            continue;
        }
        let supports_reasoning = entry
            .get("supports_reasoning")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        best.insert(
            model.clone(),
            (
                rank,
                CatalogEntry {
                    id: key.to_string(),
                    model,
                    provider,
                    max_input_tokens: u64_of(entry, "max_input_tokens")
                        .or_else(|| u64_of(entry, "max_tokens")),
                    max_output_tokens: u64_of(entry, "max_output_tokens"),
                    supports_reasoning,
                    reasoning_effort_levels: effort_levels_of(entry),
                    default_reasoning_effort: entry
                        .get("default_reasoning_effort")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    supports_vision: supports_vision_of(entry),
                    supports_function_calling: entry
                        .get("supports_function_calling")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                },
            ),
        );
    }

    let mut entries: Vec<CatalogEntry> = best.into_values().map(|(_, e)| e).collect();

    entries.sort_by(|a, b| {
        a.model
            .to_lowercase()
            .cmp(&b.model.to_lowercase())
            .then_with(|| a.provider.cmp(&b.provider))
    });
    Ok(entries)
}

fn bundled_catalog() -> CatalogFile {
    serde_json::from_str::<CatalogFile>(BUNDLED_SNAPSHOT).unwrap_or(CatalogFile {
        fetched_at: 0,
        entries: Vec::new(),
    })
}

/// The trimmed litellm entries compiled into the binary, for in-process callers
/// that need capability metadata (e.g. reasoning-effort levels) without a live
/// fetch or a database handle — the CodeArts ACP bridge runs as a standalone
/// subprocess and has neither.
pub fn bundled_entries() -> Vec<CatalogEntry> {
    bundled_catalog().entries
}

fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir
        .join("cache")
        .join("model-catalog")
        .join("litellm.json")
}

fn read_cache(data_dir: &Path, require_fresh: bool) -> Option<CatalogFile> {
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
    serde_json::from_str::<CatalogFile>(&text).ok()
}

/// Whether the on-disk cache is still inside [`CACHE_TTL`].
pub fn cache_is_fresh(data_dir: &Path) -> bool {
    read_cache(data_dir, true).is_some()
}

/// The cached record's fetch time, for a status without loading the entries.
pub fn cache_fetched_at(data_dir: &Path) -> Option<i64> {
    read_cache(data_dir, false).map(|file| file.fetched_at)
}

pub fn write_cache(data_dir: &Path, file: &CatalogFile) {
    let path = cache_path(data_dir);
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(text) = serde_json::to_string(file) {
        let _ = std::fs::write(&path, text);
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn fetch_live(url: &str) -> Result<Vec<CatalogEntry>, AppCommandError> {
    // This document is a few megabytes: slower than the other catalogs, and
    // still bounded so a black-holed connection fails instead of hanging.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| AppCommandError::network(format!("failed to build catalog http client: {e}")))?;
    let response = client.get(url).send().await.map_err(|e| {
        AppCommandError::network("Failed to download the model catalog").with_detail(e.to_string())
    })?;
    if !response.status().is_success() {
        return Err(AppCommandError::network(format!(
            "Failed to download the model catalog: HTTP {}",
            response.status()
        )));
    }
    let text = response.text().await.map_err(|e| {
        AppCommandError::network("Failed to read the model catalog response")
            .with_detail(e.to_string())
    })?;
    let entries = normalize_catalog(&text)?;
    if entries.is_empty() {
        return Err(AppCommandError::configuration_invalid(
            "The model catalog has no chat models",
        ));
    }
    Ok(entries)
}

/// Resolve the catalog: live when forced or stale, then the old cache, then the
/// bundled snapshot. A failed fetch is reported alongside the entries served.
pub async fn resolve(data_dir: &Path, url: &str, force: bool) -> ResolvedCatalog {
    if !force {
        if let Some(file) = read_cache(data_dir, true) {
            return ResolvedCatalog {
                file,
                source: CatalogSource::Cache,
                error: None,
            };
        }
    }

    match fetch_live(url).await {
        Ok(entries) => {
            let file = CatalogFile {
                fetched_at: now_unix(),
                entries,
            };
            write_cache(data_dir, &file);
            ResolvedCatalog {
                file,
                source: CatalogSource::Live,
                error: None,
            }
        }
        Err(err) => {
            let error = Some(err.message.clone());
            match read_cache(data_dir, false) {
                Some(file) => ResolvedCatalog {
                    file,
                    source: CatalogSource::Cache,
                    error,
                },
                None => ResolvedCatalog {
                    file: bundled_catalog(),
                    source: CatalogSource::Bundled,
                    error,
                },
            }
        }
    }
}

fn normalize_url(raw: &str) -> Result<String, AppCommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::configuration_missing(
            "Model catalog URL is required",
        ));
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| {
        AppCommandError::configuration_invalid("Invalid model catalog URL").with_detail(e.to_string())
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppCommandError::configuration_invalid(
            "The model catalog URL must be http or https",
        ));
    }
    Ok(trimmed.to_string())
}

pub fn normalize_settings(settings: CatalogSettings) -> Result<CatalogSettings, AppCommandError> {
    Ok(CatalogSettings {
        url: normalize_url(&settings.url)?,
        auto_update: settings.auto_update,
    })
}

pub async fn load_settings(conn: &DatabaseConnection) -> Result<CatalogSettings, AppCommandError> {
    let raw = app_metadata_service::get_value(conn, MODEL_CATALOG_SETTINGS_KEY)
        .await
        .map_err(AppCommandError::from)?;
    let Some(raw) = raw else {
        return Ok(CatalogSettings::default());
    };
    let parsed = serde_json::from_str::<CatalogSettings>(&raw).map_err(|e| {
        AppCommandError::configuration_invalid("Failed to parse stored model catalog settings")
            .with_detail(e.to_string())
    })?;
    normalize_settings(parsed)
}

pub async fn save_settings(
    conn: &DatabaseConnection,
    settings: &CatalogSettings,
) -> Result<(), AppCommandError> {
    let serialized = serde_json::to_string(settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize model catalog settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, MODEL_CATALOG_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)
}

/// Load the settings, resolve the catalog, and describe both.
pub async fn view_core(
    data_dir: &Path,
    conn: &DatabaseConnection,
    force: bool,
) -> Result<CatalogView, AppCommandError> {
    let settings = load_settings(conn).await?;
    let resolved = resolve(data_dir, &settings.url, force).await;
    Ok(view_from(settings, resolved))
}

fn view_from(settings: CatalogSettings, resolved: ResolvedCatalog) -> CatalogView {
    CatalogView {
        status: CatalogStatus {
            url: settings.url,
            auto_update: settings.auto_update,
            entry_count: resolved.file.entries.len(),
            updated_at: (resolved.file.fetched_at > 0).then_some(resolved.file.fetched_at),
            source: resolved.source.as_str().to_string(),
            error: resolved.error,
        },
        entries: resolved.file.entries,
    }
}

/// Status only, for a caller that does not need the entries.
pub async fn status_core(
    data_dir: &Path,
    conn: &DatabaseConnection,
    force: bool,
) -> Result<CatalogStatus, AppCommandError> {
    Ok(view_core(data_dir, conn, force).await?.status)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "gpt-5": {
            "litellm_provider": "openai",
            "mode": "chat",
            "max_input_tokens": 272000,
            "max_output_tokens": 128000,
            "supports_reasoning": true,
            "supports_none_reasoning_effort": false,
            "supports_minimal_reasoning_effort": true,
            "supports_low_reasoning_effort": true,
            "default_reasoning_effort": "low",
            "supports_vision": true,
            "supports_function_calling": true
        },
        "anthropic/claude-sonnet-4-5": {
            "litellm_provider": "anthropic",
            "mode": "chat",
            "max_input_tokens": 200000,
            "max_output_tokens": 64000,
            "supports_reasoning": true,
            "reasoning_effort_levels": ["low", "medium", "high"],
            "supports_vision": true
        },
        "azure/gpt-5": {
            "litellm_provider": "azure",
            "mode": "chat",
            "max_input_tokens": 1,
            "max_output_tokens": 1
        },
        "text-embedding-3-large": {
            "litellm_provider": "openai",
            "mode": "embedding"
        },
        "gpt-4o-mini": {
            "litellm_provider": "openai",
            "mode": "chat",
            "max_tokens": 16384,
            "supports_function_calling": true,
            "supported_modalities": ["text", "image"]
        }
    }"#;

    #[test]
    fn normalize_keeps_only_chat_and_one_entry_per_model() {
        let entries = normalize_catalog(SAMPLE).expect("normalize");
        let models: Vec<&str> = entries.iter().map(|e| e.model.as_str()).collect();
        assert_eq!(models, vec!["claude-sonnet-4-5", "gpt-4o-mini", "gpt-5"]);
        let gpt5 = entries.iter().find(|e| e.model == "gpt-5").unwrap();
        assert_eq!(gpt5.id, "gpt-5", "the first entry for a model id wins");
        assert_eq!(gpt5.provider, "openai");
    }

    #[test]
    fn normalize_maps_capacity_and_capabilities() {
        let entries = normalize_catalog(SAMPLE).expect("normalize");
        let gpt5 = entries.iter().find(|e| e.model == "gpt-5").unwrap();
        assert_eq!(gpt5.max_input_tokens, Some(272000));
        assert_eq!(gpt5.max_output_tokens, Some(128000));
        assert!(gpt5.supports_reasoning);
        assert_eq!(
            gpt5.reasoning_effort_levels,
            vec!["minimal", "low"],
            "levels derive from the per-level flags, in canonical order"
        );
        assert_eq!(gpt5.default_reasoning_effort.as_deref(), Some("low"));
        assert!(gpt5.supports_vision);
        assert!(gpt5.supports_function_calling);

        let claude = entries
            .iter()
            .find(|e| e.model == "claude-sonnet-4-5")
            .unwrap();
        assert_eq!(claude.id, "anthropic/claude-sonnet-4-5");
        assert_eq!(
            claude.reasoning_effort_levels,
            vec!["low", "medium", "high"],
            "an explicit list wins over the flags"
        );
        assert!(!claude.supports_function_calling);

        let mini = entries.iter().find(|e| e.model == "gpt-4o-mini").unwrap();
        assert_eq!(mini.max_input_tokens, Some(16384), "max_tokens is the fallback");
        assert_eq!(mini.max_output_tokens, None);
        assert!(mini.supports_vision, "supported_modalities counts as vision");
        assert!(mini.reasoning_effort_levels.is_empty());
    }

    #[test]
    fn normalize_rejects_non_object_root() {
        assert!(normalize_catalog("[]").is_err());
        assert!(normalize_catalog("not json").is_err());
    }

    #[test]
    fn settings_require_an_http_url() {
        assert!(normalize_settings(CatalogSettings {
            url: "  https://example.com/catalog.json ".into(),
            auto_update: true
        })
        .is_ok());
        assert!(normalize_settings(CatalogSettings {
            url: "example.com/catalog.json".into(),
            auto_update: true
        })
        .is_err());
        assert!(normalize_settings(CatalogSettings {
            url: "file:///tmp/catalog.json".into(),
            auto_update: true
        })
        .is_err());
        assert!(normalize_settings(CatalogSettings {
            url: "   ".into(),
            auto_update: true
        })
        .is_err());
    }

    #[test]
    fn bundled_snapshot_parses_and_carries_chat_models() {
        let file = bundled_catalog();
        assert!(
            file.entries.len() > 500,
            "bundled snapshot should carry the trimmed catalog, got {}",
            file.entries.len()
        );
        assert!(file.entries.iter().any(|e| e.model == "gpt-5"));
        assert!(file
            .entries
            .iter()
            .any(|e| !e.reasoning_effort_levels.is_empty()));
    }

    #[test]
    fn cache_round_trip_respects_freshness() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(read_cache(dir.path(), true).is_none());
        let file = CatalogFile {
            fetched_at: 42,
            entries: normalize_catalog(SAMPLE).expect("normalize"),
        };
        write_cache(dir.path(), &file);
        let cached = read_cache(dir.path(), true).expect("fresh cache");
        assert_eq!(cached.fetched_at, 42);
        assert_eq!(cached.entries.len(), 3);
        assert_eq!(cache_fetched_at(dir.path()), Some(42));
    }

    #[test]
    fn view_reports_bundled_entries_as_stale_without_a_timestamp() {
        let view = view_from(
            CatalogSettings::default(),
            ResolvedCatalog {
                file: bundled_catalog(),
                source: CatalogSource::Bundled,
                error: Some("offline".into()),
            },
        );
        assert_eq!(view.status.source, "bundled");
        assert_eq!(view.status.updated_at, None);
        assert_eq!(view.status.error.as_deref(), Some("offline"));
        assert!(!view.entries.is_empty());
    }
}
