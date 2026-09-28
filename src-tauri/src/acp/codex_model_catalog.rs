//! Codex custom-model catalog generation for codex's `model_catalog_json`.
//!
//! Codex only lists a model in its picker when the model is a first-class
//! catalog entry with `visibility: "list"` (and `supported_in_api: true`, or a
//! ChatGPT login). A model set only via the root `model` key is visible *only*
//! while it is the current value — which is why a stale preference replay makes
//! a custom model vanish, and why it cannot be re-selected once dropped.
//!
//! To make custom models first-class we generate a `model_catalog_json` file
//! and point `~/.codex/config.toml` at it. Because that key is a **whole-table
//! replace** (codex ignores its own catalog entirely once set), the generated
//! file must contain *every* model the user wants visible — so we auto-include
//! the current official catalog **verbatim** (minus any the user removed) and
//! append the user's custom entries.
//!
//! The official catalog is sourced at runtime from the codex codeg actually
//! launches (see [`crate::acp::codex_catalog_source`]); this module is the pure,
//! snapshot-in / catalog-out core. We store a **compact** intent
//! ([`CodexModelConfig`]: sparse `customs` + `excluded_officials`) so the set of
//! officials tracks whatever codex ships, and expand it against a provided
//! `snapshot` at write time.
//!
//! A single unknown enum value makes codex reject the *entire* catalog (every
//! model then vanishes), so custom overrides are **sanitized** here against the
//! authoritative enum sets before they can reach the file.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::app_error::{AppCommandError, AppErrorCode};

/// Official codex catalog snapshot compiled into the binary. Generated from the
/// `codex debug models --bundled` of the codex that `codex-acp` drives (shape
/// `{"models":[ ModelInfo, ... ]}`). This is only the **offline fallback**; the
/// live catalog is fetched at runtime by [`crate::acp::codex_catalog_source`].
const BUNDLED_SNAPSHOT: &str = include_str!("../../resources/codex/bundled-catalog.json");

/// File name (relative to `CODEX_HOME`) of the generated catalog codex reads.
pub const CATALOG_REL: &str = "codeg-model-catalog.json";
/// File name (relative to `CODEX_HOME`) of the compact source list we round-trip
/// back into the editor when no DB provider owns the list (api-key mode).
pub const SOURCE_REL: &str = "codeg-model-catalog.source.json";

/// Fields codeg owns/derives itself, so they are never captured as `overrides`
/// when importing a pre-existing catalog: `slug`/`display_name`/`context_window`
/// map to dedicated compact fields, and `visibility`/`supported_in_api`/
/// `priority`/`upgrade` are force-set by [`expand_to_catalog`].
const IMPORT_SKIP_KEYS: &[&str] = &[
    "slug",
    "display_name",
    "context_window",
    "visibility",
    "supported_in_api",
    "priority",
    "upgrade",
];

/// One strict-enum field: its allowed values and whether JSON `null` is also
/// accepted. Both halves are load-bearing — codex rejects the WHOLE catalog on
/// an unknown variant *and* on a `null` in a non-optional slot.
struct EnumSpec {
    allowed: &'static [&'static str],
    nullable: bool,
}

// Authoritative value sets + nullability, extracted from the codex binary itself
// by feeding it candidate catalogs and reading the full `unknown variant …,
// expected …` / `invalid type: null, expected …` errors (re-probed on 0.156.1,
// unchanged since 0.147 — treat these as version-specific and re-probe when
// codex moves).
fn enum_spec_for(key: &str) -> Option<EnumSpec> {
    let spec = |allowed, nullable| Some(EnumSpec { allowed, nullable });
    match key {
        "default_reasoning_summary" => spec(&["auto", "concise", "detailed", "none"], false),
        "default_verbosity" => spec(&["low", "medium", "high"], true),
        "shell_type" => spec(
            &["default", "local", "unified_exec", "disabled", "shell_command"],
            false,
        ),
        // Only `freeform` is a variant; `function` would reject the whole catalog.
        "apply_patch_tool_type" => spec(&["freeform"], true),
        "web_search_tool_type" => spec(&["text", "text_and_image"], false),
        // `tool_mode` / `multi_agent_version` parse leniently (codex silently
        // downgrades an unknown value to `None`), but pinning them keeps the
        // written catalog honest about what the user actually selected.
        "tool_mode" => spec(&["direct", "code_mode", "code_mode_only"], true),
        "multi_agent_version" => spec(&["v1", "v2"], true),
        _ => None,
    }
}

/// `ModelInfo` fields codex parses as a plain `bool`. A string here ("true",
/// "yes", …) rejects the whole catalog, so the type is checked, not assumed.
///
/// `supports_parallel_tool_calls` is kept although 0.153.4 dropped the field
/// (it now parses as an ignored unknown key): guarding it still costs nothing
/// and keeps a stored override honest for anyone pinned to an older codex.
///
/// `supports_experimental_context` is the only `ModelInfo` field 0.154.0 added
/// (codex-acp 1.12.0 moves `@openai/codex` ^0.153.4 → ^0.154.0). It is strict:
/// `supports_experimental_context = "yes"` earns `invalid type: string "yes",
/// expected a boolean` and takes the WHOLE catalog down with it — probed
/// against the 0.154.0 binary, same as the rest of this list.
///
/// `node_repl_auto_review_required` / `node_repl_disabled` ship as booleans on
/// every entry and are just as strict: a string earns the same `expected a
/// boolean` rejection, and so does a `null` — probed against the 0.155.1
/// binary, which also re-confirmed every other entry here. The editor offers
/// no control for either, so only an imported or hand-edited override can
/// carry one, which is exactly the input this list exists to catch.
///
/// `supports_reasoning_effort_updates` is the only boolean 0.156.1 added
/// (codex-acp 1.13.1 moves `@openai/codex` ^0.155.1 → ^0.156.1). It ships on
/// every entry and is as strict as the rest: `"yes"` earns `expected a
/// boolean`, and so does `null` — probed against the 0.156.1 binary, which
/// also re-confirmed every other entry here and every enum set above. The one
/// other key the 0.156.1 snapshot newly carries, `default_service_tier`
/// (`"priority"` on GPT-6 Sol and Luna), is an optional string rather than an
/// enum — an unknown tier name parses and only a non-string is refused — so
/// it needs no entry in either list.
const BOOL_FIELDS: &[&str] = &[
    "use_responses_lite",
    "supported_in_api",
    "support_verbosity",
    "supports_parallel_tool_calls",
    "supports_search_tool",
    "supports_image_detail_original",
    "supports_reasoning_summary_parameter",
    "supports_experimental_context",
    "include_apps_usage_instructions",
    "include_plugin_usage_instructions",
    "include_skills_usage_instructions",
    "node_repl_auto_review_required",
    "node_repl_disabled",
    "supports_reasoning_effort_updates",
];

/// Whether a custom `overrides` entry is safe to write. A single value codex
/// can't parse rejects the entire catalog, so:
/// - strict enum fields must carry a string in their allowed set, or `null`
///   only where that enum is genuinely optional;
/// - boolean fields must carry an actual boolean;
/// - `default_reasoning_level` must name one of the clone base's supported
///   efforts (codex 0.147 accepts it leniently, but older codex is strict and
///   the meaningful values are per-model anyway);
/// - every other field passes through (unknown keys are ignored by codex).
fn sanitized_override(key: &str, value: &Value, base: Option<&Map<String, Value>>) -> bool {
    if let Some(spec) = enum_spec_for(key) {
        if value.is_null() {
            return spec.nullable;
        }
        return value
            .as_str()
            .map(|s| spec.allowed.contains(&s))
            .unwrap_or(false);
    }
    if BOOL_FIELDS.contains(&key) {
        return value.is_boolean();
    }
    if value.is_null() {
        return true;
    }
    if key == "default_reasoning_level" {
        let Some(s) = value.as_str() else {
            return false;
        };
        return base
            .and_then(|b| b.get("supported_reasoning_levels"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e.get("effort").and_then(Value::as_str))
                    .any(|e| e == s)
            })
            .unwrap_or(false);
    }
    true
}

/// One user-configured **custom** codex model, stored compactly. Heavy
/// `ModelInfo` fields are cloned from `base` at expansion time; `overrides`
/// holds only the fields the user actually changed. Field names mirror the TS
/// `CodexCustomEntry`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCustomEntry {
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Snapshot slug whose full `ModelInfo` is the clone template.
    pub base: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub overrides: Map<String, Value>,
}

/// The compact intent stored in `provider.model` / the source sidecar. The set
/// of official models is **not** stored — it is auto-included from the runtime
/// snapshot at expand time, so it tracks whatever codex ships; only the user's
/// deviations (custom additions + removed officials) are persisted.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelConfig {
    #[serde(default)]
    pub customs: Vec<CodexCustomEntry>,
    /// Official slugs the user removed from the picker.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub excluded_officials: Vec<String>,
    /// Slug that becomes codex's root `model` + `OPENAI_MODEL`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// What the caller must inject into `config.toml` after files are written.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogInjection {
    /// Relative path to write as the `model_catalog_json` value.
    pub catalog_rel: &'static str,
    /// The default model slug to write as root `model`.
    pub default_model: Option<String>,
}

/// Parse the compiled-in offline snapshot into its `models` array (opaque
/// `Value`s). Only used as a fallback when the runtime catalog is unavailable.
pub fn bundled_snapshot_models() -> Vec<Value> {
    serde_json::from_str::<Value>(BUNDLED_SNAPSHOT)
        .ok()
        .as_ref()
        .and_then(|v| v.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The safest default clone base: the highest-priority (lowest `priority`)
/// snapshot entry, so a stored `base` that codex later renames still expands to
/// a valid entry rather than one missing required fields.
pub fn fallback_base_slug(snapshot: &[Value]) -> Option<String> {
    snapshot
        .iter()
        .min_by_key(|m| m.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX))
        .and_then(|m| m.get("slug").and_then(Value::as_str))
        .map(str::to_owned)
}

fn slug_of(model: &Value) -> Option<&str> {
    model.get("slug").and_then(Value::as_str)
}

fn is_listable(model: &Value) -> bool {
    model.get("visibility").and_then(Value::as_str) == Some("list")
}

/// Expand a compact config into a full `{"models":[ ModelInfo, ... ]}` catalog.
///
/// Because `model_catalog_json` is a whole-table replace, the output contains
/// **all** official models (verbatim, so codex's hidden entries such as
/// `codex-auto-review` stay hidden) minus the ones the user removed, plus the
/// user's custom entries. Custom entries clone their `base` snapshot ModelInfo
/// (falling back to the highest-priority entry when `base` is unknown), apply
/// **sanitized** overrides, and are forced `visibility:"list"` +
/// `supported_in_api:true`. Priority is renumbered by final order (customs
/// first) so the picker ordering is deterministic without colliding official
/// priorities.
pub fn expand_to_catalog(config: &CodexModelConfig, snapshot: &[Value]) -> Value {
    let excluded: HashSet<&str> = config
        .excluded_officials
        .iter()
        .map(String::as_str)
        .collect();
    let fallback = fallback_base_slug(snapshot);
    let mut out: Vec<Value> = Vec::with_capacity(config.customs.len() + snapshot.len());

    // Customs first — surface the user's own models at the top of the picker.
    for c in &config.customs {
        let base = snapshot
            .iter()
            .find(|m| slug_of(m) == Some(c.base.as_str()))
            .or_else(|| snapshot.iter().find(|m| slug_of(m) == fallback.as_deref()));
        let base_obj = base.and_then(Value::as_object);
        let mut obj = base_obj.cloned().unwrap_or_default();

        for (k, v) in &c.overrides {
            if sanitized_override(k, v, base_obj) {
                obj.insert(k.clone(), v.clone());
            }
        }

        obj.insert("slug".into(), Value::String(c.slug.clone()));
        obj.insert(
            "display_name".into(),
            Value::String(c.display_name.clone().unwrap_or_else(|| c.slug.clone())),
        );
        if let Some(cw) = c.context_window {
            obj.insert("context_window".into(), Value::from(cw));
            let max = obj
                .get("max_context_window")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .max(cw);
            obj.insert("max_context_window".into(), Value::from(max));
        }
        obj.insert("visibility".into(), Value::String("list".into()));
        obj.insert("supported_in_api".into(), Value::Bool(true));
        obj.insert("upgrade".into(), Value::Null);
        out.push(Value::Object(obj));
    }

    // Then every official verbatim, minus the ones the user removed. A removal
    // only applies to models codex actually *lists*: codex retires a model by
    // flipping it to `hide` while keeping it around as a migration stub (its
    // `upgrade` block) or for internal use (`codex-auto-review`), and dropping
    // those breaks codex rather than tidying the picker.
    for m in snapshot {
        if let Some(slug) = slug_of(m) {
            if excluded.contains(slug) && is_listable(m) {
                continue;
            }
            out.push(m.clone());
        }
    }

    // Renumber priority by final order so ordering is deterministic.
    for (i, entry) in out.iter_mut().enumerate() {
        if let Some(o) = entry.as_object_mut() {
            o.insert("priority".into(), Value::from(i as i64));
        }
    }

    Value::Object(Map::from_iter([("models".to_string(), Value::Array(out))]))
}

/// The default model slug written as codex's root `model`: the explicit
/// `default` when it names a listed model, else the first custom, else the first
/// non-excluded listable official, else `None`.
pub fn default_slug(config: &CodexModelConfig, snapshot: &[Value]) -> Option<String> {
    let excluded: HashSet<&str> = config
        .excluded_officials
        .iter()
        .map(String::as_str)
        .collect();
    let is_listed = |slug: &str| -> bool {
        config.customs.iter().any(|c| c.slug == slug)
            || snapshot
                .iter()
                .any(|m| slug_of(m) == Some(slug) && !excluded.contains(slug))
    };
    if let Some(d) = &config.default {
        if is_listed(d) {
            return Some(d.clone());
        }
    }
    if let Some(c) = config.customs.first() {
        return Some(c.slug.clone());
    }
    snapshot
        .iter()
        .find(|m| {
            slug_of(m).map(|s| !excluded.contains(s)).unwrap_or(false) && is_listable(m)
        })
        .and_then(|m| slug_of(m).map(str::to_owned))
}

/// Whether the config still deviates from codex's own catalog **in a way that
/// applies** — i.e. "feature off", so codex should use its own catalog
/// untouched. Removals of models codex has since retired to `hide` are ghosts:
/// [`expand_to_catalog`] ignores them, so a config carrying only ghosts would
/// have codeg replace the whole model table (freezing the official list) for a
/// result identical to codex's own. Treating it as empty hands control back.
pub fn is_effectively_empty(config: &CodexModelConfig, snapshot: &[Value]) -> bool {
    if !config.customs.is_empty() {
        return false;
    }
    let listable: HashSet<&str> = snapshot
        .iter()
        .filter(|m| is_listable(m))
        .filter_map(|m| slug_of(m))
        .collect();
    // An empty/unavailable snapshot can't prove a removal is stale — stay
    // conservative and keep whatever the user configured.
    if listable.is_empty() {
        return config.excluded_officials.is_empty();
    }
    !config
        .excluded_officials
        .iter()
        .any(|s| listable.contains(s.as_str()))
}

/// The default slug for `OPENAI_MODEL` / root `model` **without** a snapshot:
/// the explicit `default`, else the first custom. Officials are omitted (they
/// need the snapshot to enumerate); when neither is set the caller leaves the
/// key unset so codex picks its own default from its catalog. Used on the env /
/// provider paths that don't (and shouldn't) spawn codex.
pub fn default_slug_for_env(config: &CodexModelConfig) -> Option<String> {
    config
        .default
        .clone()
        .or_else(|| config.customs.first().map(|c| c.slug.clone()))
}

/// Map one legacy `{slug,base,…}` entry (or the old `CodexModelEntry` shape)
/// into a custom entry.
fn legacy_value_to_custom(m: &Value) -> Option<CodexCustomEntry> {
    let obj = m.as_object()?;
    let slug = obj
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let base = obj
        .get("base")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(slug)
        .to_string();
    let overrides = obj
        .get("overrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Some(CodexCustomEntry {
        slug: slug.to_string(),
        display_name: obj
            .get("displayName")
            .or_else(|| obj.get("display_name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        context_window: obj
            .get("contextWindow")
            .or_else(|| obj.get("context_window"))
            .and_then(Value::as_u64),
        base,
        overrides,
    })
}

fn single_custom_config(slug: &str) -> CodexModelConfig {
    let slug = slug.trim().to_string();
    if slug.is_empty() {
        return CodexModelConfig::default();
    }
    CodexModelConfig {
        customs: vec![CodexCustomEntry {
            slug: slug.clone(),
            display_name: None,
            context_window: None,
            base: slug.clone(),
            overrides: Map::new(),
        }],
        excluded_officials: Vec::new(),
        default: Some(slug),
    }
}

/// Parse the compact config from a stored value, leniently and with migration.
///
/// - `None`/blank → empty config (feature off).
/// - New shape `{"customs":[…],"excludedOfficials":[…],"default":…}` → parsed.
/// - Legacy `{"models":[…],"default":…}` → each model migrated to a custom.
/// - Any other JSON object → empty config.
/// - A bare slug (JSON-quoted or not) → a single custom cloning that slug.
pub fn parse_model_config(raw: Option<&str>) -> CodexModelConfig {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return CodexModelConfig::default();
    };

    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(obj)) => {
            if obj.contains_key("customs") || obj.contains_key("excludedOfficials") {
                return serde_json::from_value(Value::Object(obj)).unwrap_or_default();
            }
            if let Some(models) = obj.get("models").and_then(Value::as_array) {
                return CodexModelConfig {
                    customs: models.iter().filter_map(legacy_value_to_custom).collect(),
                    excluded_officials: Vec::new(),
                    default: obj
                        .get("default")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                };
            }
            CodexModelConfig::default()
        }
        Ok(Value::String(s)) => single_custom_config(&s),
        _ => single_custom_config(raw),
    }
}

/// Adopt a **pre-existing** `{"models":[ ModelInfo, ... ]}` catalog (one the user
/// configured by hand, or codeg's own catalog when its source sidecar is missing)
/// into the compact config, reconciled against the live official catalog:
/// non-official models become `customs`, listable officials **absent** from the
/// foreign catalog are recorded as `excluded_officials` (the user removed them),
/// and `root_model` seeds `default`. This makes the editor show the user's real
/// intent instead of appearing empty (and being clobbered on the next save).
pub fn import_catalog(
    catalog: &Value,
    root_model: Option<&str>,
    snapshot: &[Value],
) -> CodexModelConfig {
    let official_slugs: HashSet<&str> = snapshot.iter().filter_map(|m| slug_of(m)).collect();
    let fallback = fallback_base_slug(snapshot).unwrap_or_default();
    let foreign: Vec<&Map<String, Value>> = catalog
        .get("models")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    let foreign_slugs: HashSet<&str> = foreign
        .iter()
        .filter_map(|o| o.get("slug").and_then(Value::as_str))
        .collect();

    let base_obj = snapshot
        .iter()
        .find(|b| slug_of(b) == Some(fallback.as_str()))
        .and_then(Value::as_object);

    let mut customs = Vec::new();
    for obj in &foreign {
        let Some(slug) = obj
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        // An official the user kept needs no storage — it is auto-included.
        if official_slugs.contains(slug) {
            continue;
        }
        let mut overrides = Map::new();
        for (k, v) in *obj {
            if IMPORT_SKIP_KEYS.contains(&k.as_str()) {
                continue;
            }
            if base_obj.and_then(|b| b.get(k)) != Some(v) {
                overrides.insert(k.clone(), v.clone());
            }
        }
        customs.push(CodexCustomEntry {
            slug: slug.to_string(),
            display_name: obj
                .get("display_name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            context_window: obj.get("context_window").and_then(Value::as_u64),
            base: fallback.clone(),
            overrides,
        });
    }

    // Listable officials the foreign catalog dropped = deliberately removed.
    // Hidden officials are never inferred-excluded (the user likely never saw
    // them, and they may back codex internals).
    let excluded_officials: Vec<String> = snapshot
        .iter()
        .filter(|m| is_listable(m))
        .filter_map(|m| slug_of(m))
        .filter(|s| !foreign_slugs.contains(s))
        .map(str::to_owned)
        .collect();

    let default = root_model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    CodexModelConfig {
        customs,
        excluded_officials,
        default,
    }
}

fn io_err(context: &str, e: std::io::Error) -> AppCommandError {
    AppCommandError::new(AppErrorCode::IoError, format!("{context}: {e}"))
}

/// Write the expanded catalog + the compact source sidecar under `codex_home`,
/// expanding against `snapshot` (the runtime official catalog).
///
/// The sidecar is written **verbatim** from `raw_compact` so the value the
/// editor reads back is byte-identical to what it stored. A config with no
/// customs and no removal that still applies (see [`is_effectively_empty`])
/// removes both files and returns `None`, signalling the caller to drop the
/// `model_catalog_json` key so codex uses its own catalog.
pub fn write_catalog_files(
    raw_compact: &str,
    codex_home: &Path,
    snapshot: &[Value],
) -> Result<Option<CatalogInjection>, AppCommandError> {
    let config = parse_model_config(Some(raw_compact));
    let catalog_path = codex_home.join(CATALOG_REL);
    let source_path = codex_home.join(SOURCE_REL);

    if is_effectively_empty(&config, snapshot) {
        let _ = std::fs::remove_file(&catalog_path);
        let _ = std::fs::remove_file(&source_path);
        return Ok(None);
    }

    std::fs::create_dir_all(codex_home).map_err(|e| io_err("create codex home", e))?;
    let catalog = serde_json::to_string_pretty(&expand_to_catalog(&config, snapshot)).map_err(|e| {
        AppCommandError::new(AppErrorCode::IoError, format!("serialize catalog: {e}"))
    })?;
    std::fs::write(&catalog_path, catalog).map_err(|e| io_err("write catalog file", e))?;
    std::fs::write(&source_path, raw_compact).map_err(|e| io_err("write catalog source", e))?;

    Ok(Some(CatalogInjection {
        catalog_rel: CATALOG_REL,
        default_model: default_slug(&config, snapshot),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> Vec<Value> {
        bundled_snapshot_models()
    }

    fn find<'a>(cat: &'a Value, slug: &str) -> Option<&'a Value> {
        cat.get("models")?
            .as_array()?
            .iter()
            .find(|m| slug_of(m) == Some(slug))
    }

    fn slugs(cat: &Value) -> Vec<String> {
        cat.get("models")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|m| slug_of(m).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn bundled_snapshot_matches_launched_codex_shape() {
        let models = snap();
        assert_eq!(
            models.len(),
            11,
            "snapshot should carry codex 0.156.1's catalog"
        );
        assert!(models.iter().any(|m| slug_of(m) == Some("gpt-6-astra")));
        // 0.156.1 adds GPT-6 Sol and Luna, both listed.
        for added in ["gpt-6-sol", "gpt-6-luna"] {
            let m = models
                .iter()
                .find(|m| slug_of(m) == Some(added))
                .unwrap_or_else(|| panic!("{added} missing — regenerate the snapshot"));
            assert!(is_listable(m), "{added} should be listed");
        }
        assert!(models.iter().any(|m| slug_of(m) == Some("gpt-5.6-sol")));
        assert!(models.iter().any(|m| slug_of(m) == Some("gpt-5.5")));
        // codex-auto-review ships hidden.
        let review = models
            .iter()
            .find(|m| slug_of(m) == Some("codex-auto-review"))
            .expect("present");
        assert_eq!(review.get("visibility").unwrap(), "hide");
        // Every codex required ModelInfo field present on entry 0.
        let required = [
            "slug",
            "display_name",
            "visibility",
            "supported_in_api",
            "priority",
            "supported_reasoning_levels",
            "support_verbosity",
            "shell_type",
            "web_search_tool_type",
            "experimental_supported_tools",
            "base_instructions",
            "truncation_policy",
        ];
        for f in required {
            assert!(models[0].get(f).is_some(), "missing required field {f}");
        }
        // Fields codex retired: 0.147 renamed `supports_reasoning_summaries` to
        // `supports_reasoning_summary_parameter` and 0.153 dropped
        // `supports_parallel_tool_calls`. Both are now unknown keys codex simply
        // ignores, and neither is serialized, so seeing one back means the
        // snapshot went stale rather than being regenerated.
        for gone in [
            "supports_reasoning_summaries",
            "supports_parallel_tool_calls",
        ] {
            assert!(
                models.iter().all(|m| m.get(gone).is_none()),
                "codex dropped {gone} — regenerate the snapshot"
            );
        }
        assert_eq!(fallback_base_slug(&models).as_deref(), Some("gpt-6-astra"));
    }

    #[test]
    fn expand_auto_includes_officials_and_forces_only_customs() {
        let config = CodexModelConfig {
            customs: vec![CodexCustomEntry {
                slug: "gw/opus".into(),
                display_name: Some("Gateway Opus".into()),
                context_window: Some(123_456),
                base: "gpt-5.6-sol".into(),
                overrides: Map::new(),
            }],
            excluded_officials: Vec::new(),
            default: None,
        };
        let cat = expand_to_catalog(&config, &snap());
        // All 11 officials auto-included + 1 custom = 12.
        assert_eq!(slugs(&cat).len(), 12);
        // Custom is first (top of picker) and forced list + api.
        let c = find(&cat, "gw/opus").expect("custom present");
        assert_eq!(c.get("visibility").unwrap(), "list");
        assert_eq!(c.get("supported_in_api").unwrap(), &Value::Bool(true));
        assert_eq!(c.get("priority").unwrap().as_i64(), Some(0));
        assert!(c.get("base_instructions").and_then(Value::as_str).is_some());
        // codex 0.156.1 points gpt-5.6-sol at gpt-6-sol through an `upgrade`
        // block, which codex's TUI raises as a model-migration prompt. A custom
        // that clones it must not inherit a migration offer for a model it is
        // not, so the base's block is cleared — the official itself keeps it
        // verbatim.
        assert_eq!(c.get("upgrade"), Some(&Value::Null));
        let official = find(&cat, "gpt-5.6-sol").expect("official present");
        assert_eq!(
            official.pointer("/upgrade/model").and_then(Value::as_str),
            Some("gpt-6-sol")
        );
        // Official preserved VERBATIM — hidden stays hidden.
        let review = find(&cat, "codex-auto-review").expect("official present");
        assert_eq!(review.get("visibility").unwrap(), "hide");
    }

    fn excluding(slugs: &[&str]) -> CodexModelConfig {
        CodexModelConfig {
            customs: Vec::new(),
            excluded_officials: slugs.iter().map(|s| s.to_string()).collect(),
            default: None,
        }
    }

    #[test]
    fn expand_excludes_removed_officials_and_empty_is_off() {
        let config = excluding(&["gpt-5.5"]);
        let cat = expand_to_catalog(&config, &snap());
        let s = slugs(&cat);
        assert!(!s.iter().any(|x| x == "gpt-5.5"));
        assert!(s.iter().any(|x| x == "gpt-5.6-sol"));
        // Empty config = feature off.
        assert!(is_effectively_empty(&CodexModelConfig::default(), &snap()));
        assert!(!is_effectively_empty(&config, &snap()));
    }

    /// codex retires a model by flipping it to `hide` (keeping its `upgrade`
    /// migration stub), which turns an old removal into a ghost. Honouring the
    /// ghost would delete the stub from the table codex reads.
    #[test]
    fn expand_keeps_hidden_officials_even_when_excluded() {
        let s = snap();
        // gpt-5.4 and the two daybreak builds ship hidden; codex-auto-review
        // always is.
        for slug in ["gpt-5.4", "gpt-daybreak-blue-latest", "codex-auto-review"] {
            let hidden = s
                .iter()
                .find(|m| slug_of(m) == Some(slug))
                .expect("in snapshot");
            assert_eq!(hidden.get("visibility").unwrap(), "hide", "{slug}");
        }
        let cat = expand_to_catalog(&excluding(&["gpt-5.4", "gpt-daybreak-blue-latest"]), &s);
        let out = slugs(&cat);
        assert!(out.iter().any(|x| x == "gpt-5.4"));
        assert!(out.iter().any(|x| x == "gpt-daybreak-blue-latest"));
        assert_eq!(out.len(), s.len(), "nothing dropped");
    }

    #[test]
    fn effectively_empty_ignores_ghost_exclusions() {
        let s = snap();
        // Only stale removals of now-hidden officials → hand control back.
        assert!(is_effectively_empty(
            &excluding(&["gpt-5.4", "gpt-daybreak-blue-latest"]),
            &s
        ));
        // A removal that still applies keeps the takeover.
        assert!(!is_effectively_empty(&excluding(&["gpt-5.5"]), &s));
        // Mixed: the live one wins.
        assert!(!is_effectively_empty(&excluding(&["gpt-5.4", "gpt-5.5"]), &s));
        // codex 0.155.1 DELETED gpt-5.2 and gpt-5.4-mini outright rather than
        // hiding them, which is the other way a stored exclusion goes stale. A
        // slug that is not in the catalog at all cannot be listable either, so
        // it reads as a ghost by the same rule and control goes back to codex.
        assert!(is_effectively_empty(
            &excluding(&["gpt-5.2", "gpt-5.4-mini"]),
            &s
        ));
        // A custom always counts.
        let with_custom = CodexModelConfig {
            customs: vec![CodexCustomEntry {
                slug: "gw/x".into(),
                display_name: None,
                context_window: None,
                base: "gpt-5.6-sol".into(),
                overrides: Map::new(),
            }],
            ..Default::default()
        };
        assert!(!is_effectively_empty(&with_custom, &s));
        // No snapshot → can't prove staleness, so don't discard the intent.
        assert!(!is_effectively_empty(&excluding(&["gpt-5.4"]), &[]));
        assert!(is_effectively_empty(&CodexModelConfig::default(), &s));
    }

    #[test]
    fn expand_sanitizes_bad_enums_but_keeps_valid_ones() {
        let config = CodexModelConfig {
            customs: vec![CodexCustomEntry {
                slug: "gw/x".into(),
                display_name: None,
                context_window: None,
                base: "gpt-5.6-sol".into(),
                overrides: Map::from_iter([
                    // Invalid → must be dropped (would reject the whole catalog).
                    ("shell_type".into(), Value::String("bogus".into())),
                    ("default_verbosity".into(), Value::String("screaming".into())),
                    // `function` is NOT a valid apply_patch variant on codex 0.144.
                    ("apply_patch_tool_type".into(), Value::String("function".into())),
                    // Valid → must be kept.
                    ("supports_search_tool".into(), Value::Bool(true)),
                    ("default_reasoning_summary".into(), Value::String("concise".into())),
                ]),
            }],
            excluded_officials: Vec::new(),
            default: None,
        };
        let cat = expand_to_catalog(&config, &snap());
        let x = find(&cat, "gw/x").expect("present");
        // Bad enum values fell back to the base's (never the invalid string).
        assert_ne!(x.get("shell_type").unwrap(), "bogus");
        assert_ne!(x.get("default_verbosity").unwrap(), "screaming");
        assert_ne!(x.get("apply_patch_tool_type").unwrap(), "function");
        // Valid overrides preserved.
        assert_eq!(x.get("supports_search_tool").unwrap(), &Value::Bool(true));
        assert_eq!(x.get("default_reasoning_summary").unwrap(), "concise");
    }

    /// Nullability is per-key: codex answers `invalid type: null, expected
    /// string or map` for the non-optional enums and rejects the whole catalog,
    /// so a stray `null` (from a legacy override or an imported hand-written
    /// file) must be dropped rather than written.
    #[test]
    fn expand_rejects_null_in_non_nullable_enums_but_allows_optional_ones() {
        let config = CodexModelConfig {
            customs: vec![CodexCustomEntry {
                slug: "gw/n".into(),
                display_name: None,
                context_window: None,
                base: "gpt-5.6-sol".into(),
                overrides: Map::from_iter([
                    ("default_reasoning_summary".into(), Value::Null),
                    ("web_search_tool_type".into(), Value::Null),
                    ("shell_type".into(), Value::Null),
                    // These three ARE optional in codex.
                    ("apply_patch_tool_type".into(), Value::Null),
                    ("tool_mode".into(), Value::Null),
                    ("multi_agent_version".into(), Value::Null),
                ]),
            }],
            ..Default::default()
        };
        let cat = expand_to_catalog(&config, &snap());
        let x = find(&cat, "gw/n").expect("present");
        for key in ["default_reasoning_summary", "web_search_tool_type", "shell_type"] {
            assert!(!x.get(key).unwrap().is_null(), "{key} must keep the base value");
        }
        for key in ["apply_patch_tool_type", "tool_mode", "multi_agent_version"] {
            assert!(x.get(key).unwrap().is_null(), "{key} must accept null");
        }
    }

    /// The compatibility template the editor writes must survive sanitization
    /// intact — it is the whole point of the "third-party gateway" preset.
    #[test]
    fn expand_keeps_the_openai_compatible_override_bundle() {
        let config = CodexModelConfig {
            customs: vec![CodexCustomEntry {
                slug: "gw/compat".into(),
                display_name: None,
                context_window: None,
                base: "gpt-5.6-sol".into(),
                overrides: Map::from_iter([
                    ("tool_mode".into(), Value::Null),
                    ("multi_agent_version".into(), Value::Null),
                    ("use_responses_lite".into(), Value::Bool(false)),
                    ("apply_patch_tool_type".into(), Value::Null),
                    ("supports_image_detail_original".into(), Value::Bool(false)),
                ]),
            }],
            ..Default::default()
        };
        let x = expand_to_catalog(&config, &snap());
        let x = find(&x, "gw/compat").expect("present");
        assert!(x.get("tool_mode").unwrap().is_null());
        assert!(x.get("multi_agent_version").unwrap().is_null());
        assert!(x.get("apply_patch_tool_type").unwrap().is_null());
        assert_eq!(x.get("use_responses_lite").unwrap(), &Value::Bool(false));
        assert_eq!(
            x.get("supports_image_detail_original").unwrap(),
            &Value::Bool(false)
        );
        // Enum values the editor offers for these keys are accepted too.
        let picked = CodexModelConfig {
            customs: vec![CodexCustomEntry {
                slug: "gw/pick".into(),
                display_name: None,
                context_window: None,
                base: "gpt-5.6-sol".into(),
                overrides: Map::from_iter([
                    ("tool_mode".into(), Value::String("direct".into())),
                    ("multi_agent_version".into(), Value::String("v1".into())),
                    ("web_search_tool_type".into(), Value::String("text".into())),
                ]),
            }],
            ..Default::default()
        };
        let p = expand_to_catalog(&picked, &snap());
        let p = find(&p, "gw/pick").expect("present");
        assert_eq!(p.get("tool_mode").unwrap(), "direct");
        assert_eq!(p.get("multi_agent_version").unwrap(), "v1");
        assert_eq!(p.get("web_search_tool_type").unwrap(), "text");
    }

    /// A non-boolean in a boolean slot answers `invalid type: string …, expected
    /// a boolean` and takes the whole catalog down with it.
    #[test]
    fn expand_drops_non_boolean_values_in_boolean_fields() {
        let config = CodexModelConfig {
            customs: vec![CodexCustomEntry {
                slug: "gw/b".into(),
                display_name: None,
                context_window: None,
                base: "gpt-5.6-sol".into(),
                overrides: Map::from_iter([
                    ("use_responses_lite".into(), Value::String("yes".into())),
                    ("supports_search_tool".into(), Value::Null),
                    (
                        "supports_reasoning_summary_parameter".into(),
                        Value::Bool(false),
                    ),
                    ("node_repl_disabled".into(), Value::String("true".into())),
                    ("node_repl_auto_review_required".into(), Value::Null),
                    (
                        "supports_reasoning_effort_updates".into(),
                        Value::String("yes".into()),
                    ),
                ]),
            }],
            ..Default::default()
        };
        let cat = expand_to_catalog(&config, &snap());
        let x = find(&cat, "gw/b").expect("present");
        assert_eq!(x.get("use_responses_lite").unwrap(), &Value::Bool(true));
        assert_eq!(x.get("supports_search_tool").unwrap(), &Value::Bool(true));
        // The node_repl pair keeps gpt-5.6-sol's own `false`s.
        assert_eq!(x.get("node_repl_disabled").unwrap(), &Value::Bool(false));
        assert_eq!(
            x.get("node_repl_auto_review_required").unwrap(),
            &Value::Bool(false)
        );
        // So does 0.156.1's `supports_reasoning_effort_updates`.
        assert_eq!(
            x.get("supports_reasoning_effort_updates").unwrap(),
            &Value::Bool(false)
        );
        // A real boolean still lands.
        assert_eq!(
            x.get("supports_reasoning_summary_parameter").unwrap(),
            &Value::Bool(false)
        );
    }

    #[test]
    fn default_slug_prefers_explicit_then_custom_then_official() {
        let s = snap();
        let cfg = CodexModelConfig {
            customs: vec![CodexCustomEntry {
                slug: "mine".into(),
                display_name: None,
                context_window: None,
                base: "gpt-5.6-sol".into(),
                overrides: Map::new(),
            }],
            excluded_officials: Vec::new(),
            default: Some("gpt-5.5".into()),
        };
        assert_eq!(default_slug(&cfg, &s).as_deref(), Some("gpt-5.5"));
        // Explicit naming an absent model → first custom.
        let cfg2 = CodexModelConfig {
            default: Some("zzz".into()),
            ..cfg.clone()
        };
        assert_eq!(default_slug(&cfg2, &s).as_deref(), Some("mine"));
        // No custom, no default → first listable official (not hidden).
        let cfg3 = CodexModelConfig::default();
        assert_eq!(default_slug(&cfg3, &s).as_deref(), Some("gpt-6-astra"));
    }

    #[test]
    fn parse_new_legacy_and_bare_slug() {
        // New shape.
        let cfg = parse_model_config(Some(
            r#"{"customs":[{"slug":"a","base":"gpt-5.5"}],"excludedOfficials":["gpt-5.2"],"default":"a"}"#,
        ));
        assert_eq!(cfg.customs.len(), 1);
        assert_eq!(cfg.excluded_officials, vec!["gpt-5.2"]);
        assert_eq!(cfg.default.as_deref(), Some("a"));
        // Legacy {models} → customs.
        let legacy = parse_model_config(Some(
            r#"{"models":[{"slug":"x","base":"gpt-5.4","overrides":{"description":"d"}}],"default":"x"}"#,
        ));
        assert_eq!(legacy.customs.len(), 1);
        assert_eq!(legacy.customs[0].slug, "x");
        assert!(legacy.excluded_officials.is_empty());
        // Legacy bare slug.
        let bare = parse_model_config(Some("gpt-5.9"));
        assert_eq!(bare.customs.len(), 1);
        assert_eq!(bare.customs[0].slug, "gpt-5.9");
        assert_eq!(bare.customs[0].base, "gpt-5.9");
        assert_eq!(bare.default.as_deref(), Some("gpt-5.9"));
        // Blank / empty object → feature off.
        let off = |raw| is_effectively_empty(&parse_model_config(raw), &snap());
        assert!(off(None));
        assert!(off(Some("   ")));
        assert!(off(Some("{}")));
        assert!(off(Some(r#"{"customs":[]}"#)));
    }

    #[test]
    fn config_round_trips_canonically() {
        let raw = r#"{"customs":[{"slug":"a","displayName":"A","base":"gpt-5.5","overrides":{"description":"x"}}],"excludedOfficials":["gpt-5.2"],"default":"a"}"#;
        let cfg = parse_model_config(Some(raw));
        let reserialized = serde_json::to_string(&cfg).unwrap();
        assert_eq!(parse_model_config(Some(&reserialized)), cfg);
    }

    #[test]
    fn import_splits_officials_customs_and_infers_exclusions() {
        let s = snap();
        // A foreign catalog that kept only gpt-5.5 + one custom gateway model.
        // The gateway model clones the *clone base* import will assign it, so
        // its description is the only field that genuinely differs — and the
        // test keeps that meaning across catalog refreshes, which move which
        // model is highest-priority.
        let base_slug = fallback_base_slug(&s).expect("snapshot has a clone base");
        let base_model = s
            .iter()
            .find(|m| slug_of(m) == Some(base_slug.as_str()))
            .cloned()
            .unwrap();
        let mut gw = base_model.as_object().unwrap().clone();
        gw.insert("slug".into(), Value::String("gw/opus".into()));
        // A field that genuinely differs from the clone base (its own description),
        // so import must capture it as an override.
        gw.insert("description".into(), Value::String("My private gateway".into()));
        let kept = s
            .iter()
            .find(|m| slug_of(m) == Some("gpt-5.5"))
            .cloned()
            .unwrap();
        let foreign = serde_json::json!({"models": [kept, Value::Object(gw)]});

        let cfg = import_catalog(&foreign, Some("gpt-5.5"), &s);
        // The gateway model became a custom.
        assert_eq!(cfg.customs.len(), 1);
        assert_eq!(cfg.customs[0].slug, "gw/opus");
        assert_eq!(cfg.customs[0].base, base_slug);
        assert_eq!(
            cfg.customs[0].overrides.get("description").unwrap(),
            "My private gateway"
        );
        // Every listable official except the kept gpt-5.5 is inferred-excluded.
        assert!(cfg.excluded_officials.iter().any(|x| x == "gpt-5.6-sol"));
        assert!(!cfg.excluded_officials.iter().any(|x| x == "gpt-5.5"));
        // Hidden official is never inferred-excluded.
        assert!(!cfg.excluded_officials.iter().any(|x| x == "codex-auto-review"));
        assert_eq!(cfg.default.as_deref(), Some("gpt-5.5"));

        // Round-trip: expanding reproduces gpt-5.5 + the custom, drops the
        // listable officials the foreign catalog left out…
        let cat = expand_to_catalog(&cfg, &s);
        assert!(find(&cat, "gpt-5.5").is_some());
        assert!(find(&cat, "gw/opus").is_some());
        assert!(find(&cat, "gpt-5.2").is_none());
        // …while hidden ones survive: they were never inferred-excluded, and
        // expansion would keep them regardless (they back codex internals).
        assert!(find(&cat, "gpt-5.4").is_some());
        assert!(find(&cat, "codex-auto-review").is_some());
    }

    #[test]
    fn write_and_clear_catalog_files() {
        let dir = std::env::temp_dir().join(format!("codeg-catalog-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = snap();
        let raw = r#"{"customs":[{"slug":"gw/x","base":"gpt-5.6-sol"}],"default":"gw/x"}"#;
        // write_catalog_files parses `raw` itself; snapshot is the runtime catalog.
        let inj = write_catalog_files(raw, &dir, &s)
            .unwrap()
            .expect("non-empty → injection");
        assert_eq!(inj.catalog_rel, CATALOG_REL);
        assert_eq!(inj.default_model.as_deref(), Some("gw/x"));
        assert_eq!(std::fs::read_to_string(dir.join(SOURCE_REL)).unwrap(), raw);
        let cat: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(CATALOG_REL)).unwrap()).unwrap();
        assert!(find(&cat, "gw/x").is_some());
        assert!(find(&cat, "gpt-5.6-sol").is_some()); // official auto-included
        // Empty config clears files + signals key removal.
        assert!(write_catalog_files(r#"{"customs":[]}"#, &dir, &s)
            .unwrap()
            .is_none());
        assert!(!dir.join(CATALOG_REL).exists());
        assert!(!dir.join(SOURCE_REL).exists());

        // A ghost-only config (removals of officials codex has since hidden)
        // behaves the same: the files go away and the caller is told to drop the
        // `model_catalog_json` key, so the two never get out of sync.
        write_catalog_files(r#"{"customs":[{"slug":"gw/y","base":"gpt-5.6-sol"}]}"#, &dir, &s)
            .unwrap()
            .expect("seeded");
        assert!(dir.join(CATALOG_REL).exists());
        let ghosts = r#"{"customs":[],"excludedOfficials":["gpt-5.4","gpt-5.4-mini"]}"#;
        assert!(write_catalog_files(ghosts, &dir, &s).unwrap().is_none());
        assert!(!dir.join(CATALOG_REL).exists());
        assert!(!dir.join(SOURCE_REL).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
