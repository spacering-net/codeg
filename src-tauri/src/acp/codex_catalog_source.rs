//! Runtime source for codex's official model catalog.
//!
//! Because `model_catalog_json` is a whole-table replace, codeg must reproduce
//! codex's own catalog inside the generated file — so it has to match the codex
//! codeg **actually launches**. That codex is the one **nested** under the
//! codex-acp a launch runs (`.../codex-acp/node_modules/@openai/codex`), NOT
//! the `codex` on PATH (often an unrelated standalone install of a different
//! version, and the version that gets hoisted to the top-level `node_modules`).
//! [`crate::acp::codex_runtime`] resolves it from the launch's own codex-acp
//! command.
//!
//! We run `codex debug models --bundled` and cache the JSON on disk with a
//! live → cache → bundled-snapshot fallback chain, mirroring
//! [`crate::acp::opencode_catalog`]. Infallible by construction: the compiled-in
//! snapshot ([`crate::acp::codex_model_catalog::bundled_snapshot_models`])
//! guarantees a result offline.
//!
//! The cache lives under [`crate::paths::codeg_home_dir`] (not the app data dir)
//! so both the async editor path and the **synchronous** config-write paths can
//! reach it with zero `data_dir` threading. It records the codex version it was
//! read from: a cache from another version is never fresh, so a codex upgraded
//! outside codeg is re-read instead of serving the old list for a day.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde_json::Value;

/// On-disk cache freshness window — matches the OpenCode catalog cache.
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

fn cache_path() -> PathBuf {
    crate::paths::codeg_home_dir()
        .join("cache")
        .join("codex")
        .join("bundled-catalog.json")
}

/// Extract the `models` array from a `{"models":[...]}` document, in codex's
/// picker order: `debug models --bundled` prints FILE order, which is not
/// priority order since 0.159.1 (see
/// [`crate::acp::codex_model_catalog::sort_by_priority`]).
fn parse_models(text: &str) -> Option<Vec<Value>> {
    let mut models = serde_json::from_str::<Value>(text)
        .ok()?
        .get("models")?
        .as_array()
        .cloned()?;
    crate::acp::codex_model_catalog::sort_by_priority(&mut models);
    Some(models)
}

/// The cached catalog. `fresh_for` asks for one read from that codex version
/// within the TTL; `None` takes whatever is there.
fn read_cache(fresh_for: Option<&str>) -> Option<Vec<Value>> {
    let path = cache_path();
    let metadata = std::fs::metadata(&path).ok()?;
    let text = std::fs::read_to_string(&path).ok()?;
    if let Some(version) = fresh_for {
        let age = metadata
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())?;
        if age > CACHE_TTL {
            return None;
        }
        let cached_version = serde_json::from_str::<Value>(&text)
            .ok()?
            .get("codexVersion")?
            .as_str()?
            .to_string();
        if cached_version != version {
            return None;
        }
    }
    parse_models(&text).filter(|m| !m.is_empty())
}

fn write_cache(models: &[Value], version: &str) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let doc = serde_json::json!({ "codexVersion": version, "models": models });
    if let Ok(text) = serde_json::to_vec(&doc) {
        let _ = crate::acp::codex_endpoint_catalog::write_atomic(&path, &text);
    }
}

/// Run the launch's nested codex `debug models --bundled` and return its
/// `models`.
async fn fetch_live() -> Option<(Vec<Value>, String)> {
    let runtime = crate::acp::codex_runtime::current().await;
    let codex_js = runtime.codex_js.as_deref()?;
    let output = crate::acp::codex_runtime::bundled_catalog_output(codex_js).await?;
    let models = parse_models(&output)?;
    (!models.is_empty()).then_some((models, runtime.version))
}

/// Resolve the official codex catalog with the live → cache → bundled-snapshot
/// fallback chain. Infallible. Used by the editor (may spawn codex + refresh the
/// cache); the write paths use the sync [`cached_or_bundled_snapshot`] instead.
pub async fn runtime_catalog(force_refresh: bool) -> Vec<Value> {
    if !force_refresh {
        let runtime = crate::acp::codex_runtime::current().await;
        if runtime.confirmed {
            if let Some(fresh) = read_cache(Some(&runtime.version)) {
                return fresh;
            }
        }
    }
    if let Some(models) = refresh_live_catalog().await {
        return models;
    }
    read_cache(None).unwrap_or_else(crate::acp::codex_model_catalog::bundled_snapshot_models)
}

/// Re-read the catalog from the installed codex and store it in the cache.
/// `None` when no live catalog could be produced — unlike [`runtime_catalog`]
/// this never falls back, so a caller about to rewrite files from the result
/// can tell a real refresh from a stale cache or the compiled-in snapshot.
pub async fn refresh_live_catalog() -> Option<Vec<Value>> {
    let (models, version) = fetch_live().await?;
    write_cache(&models, &version);
    Some(models)
}

/// The official catalog of the codex that `runtime` resolved to: the cache
/// when it was read from that version, else a live read. `None` when neither
/// is available — a caller building a catalog FOR this runtime must not
/// substitute another version's list.
pub async fn catalog_for_runtime(
    runtime: &crate::acp::codex_runtime::CodexRuntime,
) -> Option<Vec<Value>> {
    if runtime.confirmed {
        if let Some(models) = read_cache(Some(&runtime.version)) {
            return Some(models);
        }
    }
    let codex_js = runtime.codex_js.as_deref()?;
    let output = crate::acp::codex_runtime::bundled_catalog_output(codex_js).await?;
    let models = parse_models(&output).filter(|m| !m.is_empty())?;
    if runtime.confirmed {
        write_cache(&models, &runtime.version);
    }
    Some(models)
}

/// Synchronous catalog for the config-write paths: the on-disk cache (kept warm
/// by the editor's [`runtime_catalog`] fetch), else the bundled snapshot. Never
/// spawns a subprocess, so saving stays fast and works from sync contexts.
pub fn cached_or_bundled_snapshot() -> Vec<Value> {
    read_cache(None).unwrap_or_else(crate::acp::codex_model_catalog::bundled_snapshot_models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_models_extracts_array() {
        assert_eq!(
            parse_models(r#"{"models":[{"slug":"a"}]}"#).unwrap().len(),
            1
        );
        assert!(parse_models("not json").is_none());
        assert!(parse_models(r#"{"nope":1}"#).is_none());
    }

    /// `debug models --bundled` prints file order; the editor, the cache and
    /// the catalog writers all read position as codex's rank.
    #[test]
    fn parse_models_returns_codex_priority_order() {
        let models = parse_models(
            r#"{"models":[{"slug":"astra","priority":2},{"slug":"sol","priority":1},{"slug":"x"},{"slug":"luna","priority":2}]}"#,
        )
        .unwrap();
        let slugs: Vec<&str> = models.iter().map(|m| m["slug"].as_str().unwrap()).collect();
        // Ascending, ties in file order, no priority last.
        assert_eq!(slugs, ["sol", "astra", "luna", "x"]);
    }

    #[test]
    fn cached_or_bundled_falls_back_to_snapshot() {
        // Whatever the cache state, the fallback guarantees a non-empty catalog
        // (the compiled-in snapshot), so callers never get an empty list.
        assert!(!cached_or_bundled_snapshot().is_empty());
    }
}
