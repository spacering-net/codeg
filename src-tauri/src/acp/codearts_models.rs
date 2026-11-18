//! The model list the CodeArts ACP bridge advertises over `configOptions`.
//!
//! `codearts models --verbose` prints a two-column table followed by one JSON
//! object per model. Each object carries `options.creditRatioDisplay` (the
//! credit multiplier Huawei shows in its TUI as e.g. `0.7x`), `limit.context`,
//! `capabilities.reasoning` and `variants`. There is no documented API for the
//! catalogue, so parsing is deliberately defensive: anything unrecognised
//! falls back to the bundled table below and the bridge still starts.

use std::time::{Duration, Instant};

use serde_json::Value;

/// How long a `codearts models --verbose` fetch may take before the cached
/// list is used instead. The CLI has to contact Huawei's model service and a
/// cold start easily takes a few seconds; ten is the point where a stale list
/// is more useful than a hanging session.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a successful fetch stays fresh across turns in one bridge process.
pub const CACHE_TTL: Duration = Duration::from_secs(300);

/// Fallback reasoning levels when neither the CLI nor litellm declares any.
/// These are the values `codearts run --variant` documents (`high`, `max`,
/// `minimal`) plus the rest of the OpenCode vocabulary.
pub const DEFAULT_EFFORT_LEVELS: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
];

/// Rank in the known effort vocabulary, so the CLI's `variants` object keys
/// (an unordered JSON map) can be shown from weakest to strongest. Unknown
/// values sort last rather than being dropped.
fn effort_strength(level: &str) -> usize {
    DEFAULT_EFFORT_LEVELS
        .iter()
        .position(|known| known.eq_ignore_ascii_case(level))
        .unwrap_or(DEFAULT_EFFORT_LEVELS.len())
}

/// The reasoning level the picker selects by default. `max` is the extreme
/// (and most expensive) level, so it is never the default when there is a
/// gentler strong option: if the last level is `max`, or there are three or
/// more levels, take the second-to-last. Only a short list whose last level
/// is NOT `max` falls back to the last one. A single level is used as-is.
pub fn default_effort_level(levels: &[String]) -> Option<String> {
    let len = levels.len();
    if len == 0 {
        return None;
    }
    if len == 1 {
        return Some(levels[0].clone());
    }
    let last_is_max = levels[len - 1].eq_ignore_ascii_case("max");
    let index = if last_is_max || len >= 3 {
        len - 2
    } else {
        len - 1
    };
    Some(levels[index].clone())
}

/// Levels the CLI itself declares in `variants` — the values `--variant`
/// actually accepts. Prefer these over litellm matches: e.g. GLM-5.2 declares
/// only `high` and `max`, so offering `low`/`medium`/`xhigh` would let the
/// user pick a value the CLI rejects.
fn declared_variant_levels(value: &Value) -> Vec<String> {
    let Some(variants) = value.get("variants").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut levels: Vec<String> = variants.keys().cloned().collect();
    levels.sort_by(|a, b| {
        effort_strength(a)
            .cmp(&effort_strength(b))
            .then_with(|| a.cmp(b))
    });
    levels
}

/// Env var codeg sets to the resolved vendor CLI, so a GUI-launched bridge
/// finds the same `codearts` the preflight check did.
pub const CODEARTS_CLI_ENV: &str = "CODEG_CODEARTS_CLI";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeArtsModel {
    /// Full id passed to `--model`, e.g. `huaweicloud-maas/GLM-5.2`.
    pub id: String,
    /// Provider-stripped id, used to match litellm entries.
    pub short_id: String,
    pub name: String,
    /// `creditRatioDisplay`, e.g. `0.7x`.
    pub credit: Option<String>,
    pub context: Option<u64>,
    /// Gate for the reasoning-effort selector. Huawei only accepts `--variant`
    /// on models that advertise thinking support.
    pub reasoning_capable: bool,
    /// Empty when the model does not support reasoning: no selector is shown.
    pub effort_levels: Vec<String>,
}

impl CodeArtsModel {
    /// Label in the composer's model picker. The multiplier rides along here
    /// so no frontend change is needed to show it.
    pub fn label(&self) -> String {
        match &self.credit {
            Some(credit) => format!("{} ({})", self.name, credit),
            None => self.name.clone(),
        }
    }

    pub fn description(&self) -> Option<String> {
        self.context
            .map(|tokens| format!("{}K context", tokens / 1024))
    }
}

/// The eight built-in models of CodeArts 26.10.9 with their official credit
/// coefficients (Huawei's "模型积分消耗系数" table). Used when the CLI cannot
/// be reached at all — including a first run with no cache.
pub fn fallback_models() -> Vec<CodeArtsModel> {
    const ROWS: &[(&str, &str, &str, u64)] = &[
        ("deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", "0.18x", 1048576),
        ("deepseek-v4.1-flash-1017", "DeepSeek-V4.1-Flash-1017", "0.18x", 1048576),
        ("GLM-5.2", "GLM-5.2", "0.7x", 202752),
        ("glm-5.2-sft-harmony", "GLM-5.2-ArkTS-SPARK", "0.7x", 202752),
        ("glm-5.3", "GLM-5.3", "0.79x", 1048576),
        ("kimi-k3", "Kimi-K3", "2.38x", 1048576),
        ("openpangu-2.0-flash", "OpenPangu-2.0-Flash", "0.32x", 524288),
        ("openpangu-2.0-pro", "OpenPangu-2.0-Pro", "0.7x", 524288),
    ];
    ROWS.iter()
        .map(|(short, name, credit, context)| CodeArtsModel {
            id: format!("huaweicloud-maas/{short}"),
            short_id: (*short).to_string(),
            name: (*name).to_string(),
            credit: Some((*credit).to_string()),
            context: Some(*context),
            // All eight built-ins report `capabilities.reasoning: false` and
            // `variants: {}` on 26.10.9, so the bundled fallback shows NO
            // reasoning selector. Only a live fetch that finds `variants`
            // (GLM-5.2 / GLM-5.2-ArkTS-SPARK) enables it.
            reasoning_capable: false,
            effort_levels: Vec::new(),
        })
        .collect()
}

/// Normalize a model id for loose matching against litellm keys, which carry
/// provider prefixes (`accounts/fireworks/models/kimi-k3`) or `@cf/…` namespaces.
fn normalize_id(value: &str) -> String {
    value
        .rsplit('/')
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect()
}

/// Reasoning levels for one model: the litellm catalogue wins, a hard-coded
/// vocabulary is the fallback. The CLI's `capabilities.reasoning` flag is NOT
/// a gate here — CodeArts reports `false` for its built-in models even though
/// `codearts run --variant` accepts a provider-specific effort, and matching
/// the model catalogue is exactly how the composer learns the levels each
/// model supports. Levels therefore vary per model (the useful kind of gate).
pub fn effort_levels_for(short_id: &str) -> Vec<String> {
    let needle = normalize_id(short_id);
    if !needle.is_empty() {
        for entry in crate::model_catalog::bundled_entries() {
            if entry.reasoning_effort_levels.is_empty() {
                continue;
            }
            let candidate = normalize_id(&entry.model);
            let matches = candidate == needle
                || candidate.contains(&needle)
                || (candidate.len() >= 5 && needle.contains(&candidate));
            if matches {
                return entry.reasoning_effort_levels.clone();
            }
        }
    }
    DEFAULT_EFFORT_LEVELS
        .iter()
        .map(|level| (*level).to_string())
        .collect()
}

/// Parse the mixed table/JSON output of `codearts models --verbose`.
///
/// Each model is a standalone `{ … }` block whose braces sit on lines of their
/// own, separated by the `model_id  model_name` rows. Blocks that fail to parse
/// are skipped rather than failing the whole catalogue.
pub fn parse_verbose_output(output: &str) -> Vec<CodeArtsModel> {
    let mut models = Vec::new();
    let mut block: Option<String> = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if block.is_none() {
            if trimmed.starts_with('{') {
                block = Some(trimmed.to_string());
            }
        } else if let Some(buf) = block.as_mut() {
            buf.push('\n');
            buf.push_str(line);
        } else {
            continue;
        }
        let Some(buf) = block.as_ref() else { continue };
        // Nested objects end with their own `  }` line, so a bare "}" cannot
        // mark the end of a block. A formatted object only parses as valid JSON
        // once its TOP-LEVEL closing brace arrived — that is the signal. This
        // also handles a single-line `{...}` object (the first candidate).
        match serde_json::from_str::<Value>(buf) {
            Ok(value) => {
                if let Some(model) = parse_model_object(&value) {
                    if !models.iter().any(|m: &CodeArtsModel| m.id == model.id) {
                        models.push(model);
                    }
                }
                block = None;
            }
            Err(_) if buf.len() > 64 * 1024 => block = None,
            Err(_) => {}
        }
    }
    models
}

fn parse_model_object(value: &Value) -> Option<CodeArtsModel> {
    let short_id = value.get("id")?.as_str()?.to_string();
    if short_id.is_empty() {
        return None;
    }
    let provider = value
        .get("providerID")
        .and_then(Value::as_str)
        .unwrap_or("huaweicloud-maas");
    let id = format!("{provider}/{short_id}");
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&short_id)
        .to_string();
    let credit = value
        .get("options")
        .and_then(|o| o.get("creditRatioDisplay"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let context = value
        .get("limit")
        .and_then(|l| l.get("context"))
        .and_then(Value::as_u64);
    let declared_reasoning = value
        .get("capabilities")
        .and_then(|c| c.get("reasoning"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let declared = declared_variant_levels(value);
    let has_variants = !declared.is_empty();
    // Only a model that declares `variants` (or reasoning support) is known to
    // accept `--variant`. Models without it must NOT show a reasoning
    // selector at all — offering levels the CLI rejects would mislead the
    // user into thinking a setting took effect.
    let reasoning_capable = declared_reasoning || has_variants;
    let effort_levels = if !reasoning_capable {
        Vec::new()
    } else if has_variants {
        declared
    } else {
        // Declared reasoning support but no variant names: fall back to
        // matching the litellm model catalogue, then the hardcoded vocabulary.
        effort_levels_for(&short_id)
    };
    Some(CodeArtsModel {
        id,
        short_id,
        name,
        credit,
        context,
        reasoning_capable,
        effort_levels,
    })
}

/// A `tokio::process::Command` for the vendor CLI. On Windows the installer
/// drops a `.cmd` shim, which `CreateProcess` cannot execute directly, so it
/// goes through `cmd.exe /c` with no console window.
#[cfg(windows)]
pub fn codearts_command(args: &[&str]) -> tokio::process::Command {
    use std::os::windows::process::CommandExt;
    let cli = std::env::var(CODEARTS_CLI_ENV).unwrap_or_else(|_| "codearts".to_string());
    let is_script = {
        let lower = cli.to_ascii_lowercase();
        lower.ends_with(".cmd") || lower.ends_with(".bat")
    };
    let mut cmd = if is_script || !cli.contains(['\\', '/']) {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.arg("/c").arg(&cli);
        c
    } else {
        tokio::process::Command::new(&cli)
    };
    cmd.args(args);
    cmd.as_std_mut().creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(not(windows))]
pub fn codearts_command(args: &[&str]) -> tokio::process::Command {
    let cli = std::env::var(CODEARTS_CLI_ENV).unwrap_or_else(|_| "codearts".to_string());
    let mut cmd = tokio::process::Command::new(&cli);
    cmd.args(args);
    cmd
}

/// Per-bridge-process model cache. A fetch that times out, fails or returns
/// nothing leaves the previous list (the bundled fallback on first run) in
/// place, so a slow network never clears the composer's model picker.
pub struct ModelCatalog {
    models: Vec<CodeArtsModel>,
    fetched_at: Option<Instant>,
}

impl Default for ModelCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelCatalog {
    pub fn new() -> Self {
        Self {
            // The fallback levels are computed from `reasoning_capable` at
            // parse time; make sure they are filled even before the first fetch.
            models: fallback_models(),
            fetched_at: None,
        }
    }

    pub fn models(&self) -> &[CodeArtsModel] {
        &self.models
    }

    pub fn is_fresh(&self) -> bool {
        self.fetched_at
            .is_some_and(|at| at.elapsed() < CACHE_TTL)
    }

    /// Refresh unless the cache is still fresh. Returns whether the list changed.
    pub async fn refresh(&mut self, force: bool) -> bool {
        if !force && self.is_fresh() {
            return false;
        }
        let fetched = tokio::time::timeout(FETCH_TIMEOUT, async {
            codearts_command(&["models", "--verbose"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .output()
                .await
        })
        .await;
        let output = match fetched {
            Ok(Ok(out)) if out.status.success() => out,
            Ok(Ok(out)) => {
                tracing::warn!(
                    "[CodeArts] models --verbose exited {:?}; keeping cached list",
                    out.status
                );
                return false;
            }
            Ok(Err(err)) => {
                tracing::warn!("[CodeArts] could not run models: {err}; keeping cached list");
                return false;
            }
            Err(_) => {
                tracing::warn!(
                    "[CodeArts] models --verbose timed out after {:?}; keeping cached list",
                    FETCH_TIMEOUT
                );
                return false;
            }
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let parsed = parse_verbose_output(&text);
        if parsed.is_empty() {
            tracing::warn!("[CodeArts] models --verbose produced no usable entries; keeping cached list");
            return false;
        }
        self.models = parsed;
        self.fetched_at = Some(Instant::now());
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"model_id                                   model_name
-----------------------------------------------------
huaweicloud-maas/GLM-5.2                   GLM-5.2
{
  "id": "GLM-5.2",
  "providerID": "huaweicloud-maas",
  "name": "GLM-5.2",
  "capabilities": { "reasoning": false },
  "limit": { "context": 202752 },
  "options": { "creditRatioDisplay": "0.7x" },
  "variants": {}
}
huaweicloud-maas/kimi-k3                   Kimi-K3
{
  "id": "kimi-k3",
  "providerID": "huaweicloud-maas",
  "name": "Kimi-K3",
  "capabilities": { "reasoning": true },
  "options": { "creditRatioDisplay": "2.38x" },
  "variants": { "high": {} }
}
"#;

    #[test]
    fn parses_table_and_json_blocks() {
        let models = parse_verbose_output(SAMPLE);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "huaweicloud-maas/GLM-5.2");
        assert_eq!(models[0].credit.as_deref(), Some("0.7x"));
        assert_eq!(models[0].context, Some(202752));
        assert_eq!(models[0].label(), "GLM-5.2 (0.7x)");
        assert!(!models[0].reasoning_capable);
        assert!(
            models[0].effort_levels.is_empty(),
            "unsupported models must show NO reasoning selector"
        );
        assert!(models[1].reasoning_capable);
        assert_eq!(models[1].effort_levels, vec!["high".to_string()]);
    }

    /// The real CLI pretty-prints each model, so nested objects close on their
    /// own bare `}` line. A parser that stops at the first `}` would truncate
    /// the block and silently fall back to the bundled table.
    #[test]
    fn parses_pretty_printed_nested_objects() {
        let pretty = r#"model_id                                   model_name
-----------------------------------------------------
huaweicloud-maas/glm-5.3                   GLM-5.3
{
  "id": "glm-5.3",
  "providerID": "huaweicloud-maas",
  "name": "GLM-5.3",
  "capabilities": {
    "reasoning": false
  },
  "limit": {
    "context": 1048576
  },
  "options": {
    "creditRatioDisplay": "0.79x"
  }
}
"#;
        let models = parse_verbose_output(pretty);
        assert_eq!(models.len(), 1, "nested `}}` lines must not end the block");
        assert_eq!(models[0].credit.as_deref(), Some("0.79x"));
        assert_eq!(models[0].context, Some(1048576));
    }

    #[test]
    fn malformed_output_yields_nothing() {
        assert!(parse_verbose_output("not a catalogue\n").is_empty());
        assert!(parse_verbose_output("").is_empty());
    }

    #[test]
    fn effort_levels_follow_the_catalogue_with_a_fallback() {
        // GLM-5.2 matches a litellm entry whose levels differ from the
        // hardcoded vocabulary — that is the per-model gating the picker needs.
        let glm = effort_levels_for("GLM-5.2");
        assert!(!glm.is_empty());
        assert!(glm.contains(&"high".to_string()));
        assert_eq!(
            effort_levels_for("unknown-model-xyz"),
            DEFAULT_EFFORT_LEVELS
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn default_level_avoids_max_and_long_lists() {
        let levels =
            |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // `max` at the end -> second-to-last, even with only two levels.
        assert_eq!(
            default_effort_level(&levels(&["high", "max"])).as_deref(),
            Some("high")
        );
        assert_eq!(
            default_effort_level(&levels(&["none", "minimal", "low", "medium", "high", "xhigh", "max"]))
                .as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            default_effort_level(&levels(&["low", "high", "max"])).as_deref(),
            Some("high")
        );
        // Three or more whose last is NOT max -> still second-to-last.
        assert_eq!(
            default_effort_level(&levels(&["low", "medium", "high"])).as_deref(),
            Some("medium")
        );
        // A short list without `max` -> the last one.
        assert_eq!(
            default_effort_level(&levels(&["high", "xhigh"])).as_deref(),
            Some("xhigh")
        );
        // Degenerate cases.
        assert_eq!(
            default_effort_level(&levels(&["max"])).as_deref(),
            Some("max")
        );
        assert_eq!(default_effort_level(&[]), None);
    }

    #[test]
    fn cli_declared_variants_override_the_catalogue() {
        let pretty = r#"model_id  model_name
---
huaweicloud-maas/GLM-5.2  GLM-5.2
{
  "id": "GLM-5.2",
  "providerID": "huaweicloud-maas",
  "name": "GLM-5.2",
  "variants": { "max": {}, "high": {} },
  "options": { "creditRatioDisplay": "0.7x" }
}
"#;
        let models = parse_verbose_output(pretty);
        assert_eq!(models.len(), 1);
        assert_eq!(
            models[0].effort_levels,
            vec!["high".to_string(), "max".to_string()],
            "variants are strength-sorted, not map order"
        );
        assert!(models[0].reasoning_capable);
        assert_eq!(
            default_effort_level(&models[0].effort_levels).as_deref(),
            Some("high"),
            "`max` must not be the default"
        );
    }

    #[test]
    fn fallback_covers_the_builtin_table() {
        let models = fallback_models();
        assert_eq!(models.len(), 8);
        assert!(models.iter().all(|m| m.credit.is_some()));
        assert!(models.iter().all(|m| !m.reasoning_capable));
        assert!(
            models.iter().all(|m| m.effort_levels.is_empty()),
            "the fallback table must not imply reasoning support it cannot verify"
        );
    }

    #[test]
    fn fresh_cache_skips_fetch() {
        let mut catalog = ModelCatalog::new();
        catalog.fetched_at = Some(Instant::now());
        assert!(catalog.is_fresh());
        assert_eq!(catalog.models().len(), 8);
    }
}
