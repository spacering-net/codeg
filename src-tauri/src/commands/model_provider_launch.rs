//! Phase 4 — launch adapters for the shared Model Provider source.
//!
//! A resolved conversation model selection is projected into an agent process
//! at spawn via one of two mechanisms, both of which never touch the user's
//! real configuration files:
//!
//! 1. **Env-only** — agents whose process reads launch env vars directly
//!    (Claude Code, Gemini, Grok, DeepSeek, CodeBuddy, and Kimi Code in its
//!    OpenAI-completions mode). No files are written.
//!
//! 2. **Empty session workspace** — agents that require structured config
//!    files (Codex, Pi, OpenCode, Cline, Hermes, and Kimi Code for the other
//!    API families). A per-(agent, conversation) directory under
//!    `<data_dir>/model-provider/` is created from scratch, the minimal
//!    provider config is written into it, and the agent's config-home env var
//!    points at it. The directory is reused on resume and removed when the
//!    conversation is deleted.
//!
//! The shared `CODEG_MODEL_*` keys injected by
//! [`crate::commands::acp::apply_conversation_model_selection_env`] remain in
//! the launch env: they feed the config fingerprint and keep the projected
//! config observable for debugging.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::acp::codex_model_catalog::CATALOG_REL as CODEX_WORKSPACE_CATALOG_REL;
use crate::acp::codex_model_catalog::{
    expand_customs_only, fallback_base_slug, CodexCustomEntry, CodexModelConfig,
};
use crate::acp::custom_registry::ModelEnvDeclaration;
use crate::acp::error::AcpError;
use crate::commands::acp::ResolvedConversationModelSelection;
use crate::models::agent::AgentType;
use crate::models::model_provider_file::ModelProviderApiType;

/// Directory (under codeg's data dir) that holds the per-conversation session
/// workspaces for agents requiring a real config dir at launch.
pub const MODEL_PROVIDER_WORKSPACE_ROOT: &str = "model-provider";

/// Kimi's fixed managed provider/model names, default context window and
/// synthetic gate token. Mirrors the constants in `commands::acp`; the
/// workspace writer needs them to emit a self-contained `config.toml` and the
/// ACP gate token without re-reading the legacy writer.
const KIMI_MANAGED_PROVIDER: &str = "codeg";
const KIMI_MANAGED_MODEL_ALIAS: &str = "codeg-managed";
/// Fallback context window for a kimi model whose metadata carries none. Kimi
/// derives the request's `max_completion_tokens` from this number, and a
/// provider that validates it against a smaller model limit rejects the whole
/// request with a 400 the ACP layer never surfaces (the turn just ends with no
/// output). 128K is the largest value every current OpenAI-compatible coding
/// endpoint accepts — e.g. Volcengine ARK caps `max_completion_tokens` at the
/// model's 131072-token window, so the previous 256K (kimi-k2) default turned
/// every GLM request into a silent failure. When the selection DOES carry a
/// context window (or a max output size), those win — see
/// [`apply_kimi_env_model_metadata`] and [`write_kimi_workspace`].
const KIMI_DEFAULT_MAX_CONTEXT_SIZE: i64 = 131_072;
const KIMI_SYNTHETIC_TOKEN_ACCESS: &str = "codeg-local-gate";

/// Neutral thinking level for a reasoning-capable pi model. The user can change
/// the level per session; pi clamps it to the model's supported vocabulary.
const PI_DEFAULT_THINKING_LEVEL: &str = "medium";

/// Resolve the Pi session store **before** the provider workspace replaces the
/// agent home. Pi relocates its sessions independently of its config/auth
/// files, so provider isolation must not make an existing session disappear.
fn pi_native_sessions_dir(
    runtime_env: &BTreeMap<String, String>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    crate::parsers::pi::resolve_pi_sessions_dir_from(
        runtime_env
            .get("PI_CODING_AGENT_SESSION_DIR")
            .cloned()
            .map(OsString::from),
        runtime_env
            .get("PI_CODING_AGENT_DIR")
            .cloned()
            .map(OsString::from),
        home_dir,
    )
}

/// Apply the launch adapter for a resolved shared-provider selection.
///
/// Runs at spawn time, after the generic `CODEG_MODEL_*` keys are injected.
/// The projection is deterministic for a given selection, so re-running on
/// resume regenerates the same workspace content.
pub(crate) fn apply_launch_adapter(
    agent_type: AgentType,
    selection: &ResolvedConversationModelSelection,
    runtime_env: &mut BTreeMap<String, String>,
    data_dir: &Path,
    conversation_id: i32,
    model_env: Option<&ModelEnvDeclaration>,
) -> Result<(), AcpError> {
    let api = selection
        .provider
        .api
        .unwrap_or(ModelProviderApiType::OpenAiCompletions);
    // A line break would break the `.env` / config shapes (KEY=value lines and
    // string literals); reject it up front rather than writing a malformed file.
    if let Some(key) = non_empty(selection.provider.api_key.as_deref()) {
        if key.contains('\n') || key.contains('\r') {
            return Err(AcpError::protocol(
                "provider API key must not contain line breaks",
            ));
        }
    }
    let ws = workspace_dir(data_dir, agent_type, conversation_id);
    match agent_type {
        AgentType::ClaudeCode
        | AgentType::Gemini
        | AgentType::Grok
        | AgentType::DeepSeek
        | AgentType::CodeBuddy => apply_env_only(agent_type, selection, runtime_env)?,
        // Kimi reads the KIMI_MODEL_* env family in its OpenAI-completions
        // mode; every other API family needs a structured config.toml.
        AgentType::KimiCode if api == ModelProviderApiType::OpenAiCompletions => {
            apply_env_only(agent_type, selection, runtime_env)?;
            apply_kimi_env_model_metadata(selection, runtime_env);
        }
        AgentType::Codex => write_codex_workspace(&ws, selection, api, runtime_env)?,
        AgentType::Pi => write_pi_workspace(&ws, selection, api, runtime_env)?,
        AgentType::OpenCode => write_opencode_workspace(&ws, selection, api, runtime_env)?,
        AgentType::Cline => write_cline_workspace(&ws, selection, api, runtime_env)?,
        AgentType::Hermes => write_hermes_workspace(&ws, selection, api, runtime_env)?,
        AgentType::KimiCode => write_kimi_workspace(&ws, selection, api, runtime_env)?,
        AgentType::Custom(_) => apply_custom_env_only(selection, runtime_env, model_env)?,
        other => {
            return Err(AcpError::protocol(format!(
                "{other:?} does not support the shared Model Provider source"
            )));
        }
    }
    apply_proxy_env(selection, runtime_env);
    Ok(())
}

/// Project a provider-level proxy into the session launch env. Every agent
/// family reads the standard `HTTP(S)_PROXY` / `ALL_PROXY` variables (both
/// casings — curl and Node differ), so a provider that declares one gets it
/// applied to the agent process; a provider without a proxy leaves the user's
/// global proxy environment untouched.
fn apply_proxy_env(
    selection: &ResolvedConversationModelSelection,
    runtime_env: &mut BTreeMap<String, String>,
) {
    let Some(proxy) = non_empty(selection.provider.proxy.as_deref()) else {
        return;
    };
    for var in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        runtime_env.insert(var.to_string(), proxy.to_string());
    }
}

/// The per-conversation workspace path for an agent.
pub(crate) fn workspace_dir(
    data_dir: &Path,
    agent_type: AgentType,
    conversation_id: i32,
) -> PathBuf {
    data_dir
        .join(MODEL_PROVIDER_WORKSPACE_ROOT)
        .join(agent_type.as_wire().as_ref())
        .join(conversation_id.to_string())
}

/// Remove the provider workspace(s) for a deleted conversation. Sweeps every
/// agent dir because the conversation's agent type is not reliably available
/// at delete time (it may have been changed since the workspace was created).
/// Best-effort: failures are logged, never propagated.
pub(crate) fn cleanup_conversation_workspaces(data_dir: &Path, conversation_id: i32) {
    let root = data_dir.join(MODEL_PROVIDER_WORKSPACE_ROOT);
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path().join(conversation_id.to_string());
        match fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(
                "[model-provider] workspace cleanup failed for {:?}: {e}",
                dir
            ),
        }
    }
}

/// Return a deterministic blob of the provider workspace config files when
/// `runtime_env` points an agent's config home at a model-provider workspace.
/// The config fingerprint folds this in so a running session is flagged stale
/// if the projected files change.
pub(crate) fn workspace_fingerprint_blob(
    agent_type: AgentType,
    runtime_env: &BTreeMap<String, String>,
) -> Option<String> {
    let home_var = match agent_type {
        AgentType::Codex => "CODEX_HOME",
        AgentType::Pi => "PI_CODING_AGENT_DIR",
        AgentType::OpenCode => "XDG_CONFIG_HOME",
        AgentType::Cline => "CLINE_DIR",
        AgentType::Hermes => "HERMES_HOME",
        AgentType::KimiCode => "KIMI_CODE_HOME",
        _ => return None,
    };
    let root = PathBuf::from(runtime_env.get(home_var)?);
    if !root
        .components()
        .any(|c| c.as_os_str() == MODEL_PROVIDER_WORKSPACE_ROOT)
    {
        return None;
    }
    let mut blob = String::new();
    collect_tree(&root, &root, &mut blob);
    Some(blob)
}

/// Depth-first, name-sorted dump of a workspace tree into `blob`:
/// `relpath\0content\0` per file, `relpath\0` per directory.
fn collect_tree(root: &Path, dir: &Path, blob: &mut String) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<_> = entries.flatten().map(|e| e.file_name()).collect();
    names.sort();
    for name in names {
        let path = dir.join(&name);
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        if path.is_dir() {
            blob.push_str(&rel);
            blob.push('\0');
            collect_tree(root, &path, blob);
        } else if let Ok(bytes) = fs::read(&path) {
            blob.push_str(&rel);
            blob.push('\0');
            blob.push_str(&String::from_utf8_lossy(&bytes));
            blob.push('\0');
        }
    }
}

// ---------------------------------------------------------------------------
// Env-only projection
// ---------------------------------------------------------------------------

/// Project the selection into the agent's own launch env vars. Only non-empty
/// values are written; a provider without a base URL or key leaves the agent's
/// existing resolution alone.
fn apply_env_only(
    agent_type: AgentType,
    selection: &ResolvedConversationModelSelection,
    runtime_env: &mut BTreeMap<String, String>,
) -> Result<(), AcpError> {
    let base_url = non_empty(selection.provider.base_url.as_deref());
    let api_key = non_empty(selection.provider.api_key.as_deref());
    let model_id = non_empty(Some(selection.model_id.as_str()));

    let (url_key, key_key, model_key) = match agent_type {
        // CodeBuddy authenticates via env vars and has no model env var; the
        // generic `agent_env_keys` fallback would land on inert OPENAI_* keys.
        AgentType::CodeBuddy => ("CODEBUDDY_BASE_URL", "CODEBUDDY_API_KEY", ""),
        _ => crate::commands::acp::agent_env_keys(agent_type),
    };

    if let Some(url) = base_url {
        runtime_env.insert(url_key.to_string(), url.to_string());
    }
    if let Some(key) = api_key {
        runtime_env.insert(key_key.to_string(), key.to_string());
    }
    if !model_key.is_empty() {
        if let Some(model) = model_id {
            runtime_env.insert(model_key.to_string(), model.to_string());
        }
    }
    Ok(())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// Project the selection into a custom agent's launch env.
///
/// codeg cannot know which env keys an arbitrary ACP agent's CLI reads, so the
/// keys come from two sources: the agent's optional [`ModelEnvDeclaration`]
/// (`CustomAgentDef::model_env`, per slot) wins, and slots it leaves unset fall
/// back to the standard convention for the provider's API family —
/// `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` for both OpenAI wire
/// formats (the completions and responses URLs differ by path suffix, the env
/// contract does not) and `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/
/// `ANTHROPIC_MODEL` for Anthropic. Qwen Code reads the OpenAI family
/// natively; `glm-acp-agent` needs the declaration
/// (`ACP_GLM_BASE_URL`/`Z_AI_API_KEY`/`ACP_GLM_MODEL`).
///
/// Like [`apply_env_only`], only non-empty values are written — a provider
/// without a base URL or key leaves the agent's own resolution alone, and an
/// empty `modelEnv` object therefore injects nothing at all.
pub(crate) fn apply_custom_env_only(
    selection: &ResolvedConversationModelSelection,
    runtime_env: &mut BTreeMap<String, String>,
    model_env: Option<&ModelEnvDeclaration>,
) -> Result<(), AcpError> {
    let base_url = non_empty(selection.provider.base_url.as_deref());
    let api_key = non_empty(selection.provider.api_key.as_deref());
    let model_id = non_empty(Some(selection.model_id.as_str()));

    let api = selection
        .provider
        .api
        .unwrap_or(ModelProviderApiType::OpenAiCompletions);
    let (std_url, std_key, std_model) = if api == ModelProviderApiType::AnthropicMessages {
        (
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL",
        )
    } else {
        ("OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL")
    };
    fn declared(slot: Option<&String>) -> Option<&str> {
        slot.map(|s| s.trim()).filter(|s| !s.is_empty())
    }
    let url_key = declared(model_env.and_then(|d| d.base_url.as_ref())).unwrap_or(std_url);
    let key_key = declared(model_env.and_then(|d| d.api_key.as_ref())).unwrap_or(std_key);
    let model_key = declared(model_env.and_then(|d| d.model.as_ref())).unwrap_or(std_model);

    if let Some(url) = base_url {
        runtime_env.insert(url_key.to_string(), url.to_string());
    }
    if let Some(key) = api_key {
        runtime_env.insert(key_key.to_string(), key.to_string());
    }
    if let Some(model) = model_id {
        runtime_env.insert(model_key.to_string(), model.to_string());
    }
    Ok(())
}

/// Project the selection's size metadata into kimi's env-model overlay.
///
/// Kimi synthesizes the `KIMI_MODEL_*` env model (`__kimi_env_model__`) with
/// hardcoded defaults: a 262144-token context window and no output cap. It then
/// sends `max_completion_tokens` equal to that window, so any provider whose
/// model limit is smaller (ARK's GLM models cap at 131072) 400s the request —
/// and kimi-acp ends the turn without forwarding the error, which codeg can
/// only report as "status updates, no reply".
///
/// Two env keys close the gap, both consumed by kimi's `kimiModelEnvOverlay`:
/// `KIMI_MODEL_MAX_CONTEXT_SIZE` (kimi's window belief, and the
/// `max_completion_tokens` source when no output cap exists) and
/// `KIMI_MODEL_MAX_OUTPUT_SIZE` (the hard output cap, which wins over the
/// window). Real model metadata is used when the catalog entry carries it; the
/// bounded [`KIMI_DEFAULT_MAX_CONTEXT_SIZE`] fallback replaces kimi's 256K one.
fn apply_kimi_env_model_metadata(
    selection: &ResolvedConversationModelSelection,
    runtime_env: &mut BTreeMap<String, String>,
) {
    let context_window =
        positive_int(selection.model.context_window).unwrap_or(KIMI_DEFAULT_MAX_CONTEXT_SIZE);
    runtime_env.insert(
        "KIMI_MODEL_MAX_CONTEXT_SIZE".to_string(),
        context_window.to_string(),
    );
    if let Some(max_output) = positive_int(selection.model.max_tokens) {
        runtime_env.insert(
            "KIMI_MODEL_MAX_OUTPUT_SIZE".to_string(),
            max_output.to_string(),
        );
    }
}

/// Keep only usable positive integers from model metadata (`0`, negatives, and
/// `i64::MIN`-style sentinels mean "unset").
fn positive_int(value: Option<i64>) -> Option<i64> {
    value.filter(|v| *v > 0)
}

// ---------------------------------------------------------------------------
// Empty session workspace writers
// ---------------------------------------------------------------------------

fn write_codex_workspace(
    ws: &Path,
    selection: &ResolvedConversationModelSelection,
    api: ModelProviderApiType,
    runtime_env: &mut BTreeMap<String, String>,
) -> Result<(), AcpError> {
    let wire_api = match api {
        ModelProviderApiType::OpenAiResponses => "responses",
        other => {
            return Err(AcpError::protocol(format!(
                "Codex requires the OpenAI Responses API; provider {} uses {}",
                selection.provider_id,
                other.as_str()
            )))
        }
    };

    // auth.json — codex reads the key under `OPENAI_API_KEY` only when the
    // provider table sets `requires_openai_auth = true` (below).
    if let Some(key) = non_empty(selection.provider.api_key.as_deref()) {
        let auth = Map::from_iter([("OPENAI_API_KEY".to_string(), Value::String(key.to_string()))]);
        write_json(&ws.join("auth.json"), &auth, true)?;
    }

    // codeg-model-catalog.json — codex's `model_catalog_json` is a
    // whole-table replace, and the per-conversation workspace is a fresh
    // Codex home that has no inherited catalog. Without an explicit
    // `model_catalog_json` codex falls back to its bundled OpenAI-only
    // catalog and rejects the selected provider model with
    // `Model metadata for '<model_id>' not found in model catalog`. Emit
    // a customs-only catalog so the selected model is the only entry —
    // the workspace is per-conversation and the picker is not in play.
    {
        let snapshot = crate::acp::codex_catalog_source::cached_or_bundled_snapshot();
        let base = fallback_base_slug(&snapshot).ok_or_else(|| {
            AcpError::protocol("codex bundled snapshot is empty; cannot build workspace catalog")
        })?;
        let custom = CodexCustomEntry {
            slug: selection.model_id.clone(),
            display_name: selection.model.name.clone(),
            context_window: selection
                .model
                .context_window
                .and_then(|n| u64::try_from(n).ok()),
            base,
            overrides: Map::new(),
        };
        let cfg = CodexModelConfig {
            customs: vec![custom],
            excluded_officials: Vec::new(),
            default: None,
            catalog: None,
        };
        let catalog = expand_customs_only(&cfg, &snapshot);
        let body = serde_json::to_string_pretty(&catalog).map_err(|e| {
            AcpError::protocol(format!("serialize codex workspace catalog failed: {e}"))
        })?;
        write_file(
            &ws.join(CODEX_WORKSPACE_CATALOG_REL),
            &format!("{body}\n"),
            false,
        )?;
    }

    // config.toml — a self-contained `[model_providers.<id>]` block pointing
    // at the provider and selecting the model. `model_catalog_json` is
    // resolved against `CODEX_HOME` (the workspace dir), so a bare file
    // name is enough.
    let mut root = toml::map::Map::new();
    root.insert(
        "model".to_string(),
        toml::Value::String(selection.model_id.clone()),
    );
    root.insert(
        "model_provider".to_string(),
        toml::Value::String(selection.provider_id.clone()),
    );
    root.insert(
        "model_catalog_json".to_string(),
        toml::Value::String(CODEX_WORKSPACE_CATALOG_REL.to_string()),
    );
    let mut providers = toml::map::Map::new();
    let mut provider = toml::map::Map::new();
    provider.insert(
        "name".to_string(),
        toml::Value::String(selection.provider_id.clone()),
    );
    if let Some(url) = non_empty(selection.provider.base_url.as_deref()) {
        provider.insert("base_url".to_string(), toml::Value::String(url.to_string()));
    }
    provider.insert(
        "wire_api".to_string(),
        toml::Value::String(wire_api.to_string()),
    );
    provider.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(true),
    );
    providers.insert(selection.provider_id.clone(), toml::Value::Table(provider));
    root.insert("model_providers".to_string(), toml::Value::Table(providers));
    let body = toml::to_string_pretty(&toml::Value::Table(root))
        .map_err(|e| AcpError::protocol(format!("serialize codex config.toml failed: {e}")))?;
    write_file(&ws.join("config.toml"), &format!("{body}\n"), false)?;

    runtime_env.insert("CODEX_HOME".to_string(), ws.to_string_lossy().into_owned());
    Ok(())
}

/// Pi resolves OpenAI compatibility from the selected model. Project the
/// provider-level developer-role override onto that model so providers such as
/// Ark can force `system` instead of Pi's auto-detected `developer`.
fn pi_model_compat(
    selection: &ResolvedConversationModelSelection,
    api: ModelProviderApiType,
) -> Option<Value> {
    if api != ModelProviderApiType::OpenAiCompletions {
        return None;
    }

    let mut compat = match selection.model.compat.as_ref() {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let explicit_model_value = match selection
        .model
        .compat
        .as_ref()
        .and_then(|compat| compat.get("supportsDeveloperRole"))
    {
        Some(Value::Bool(value)) => Some(*value),
        _ => None,
    };
    let provider_value = match selection
        .provider
        .compat
        .as_ref()?
        .get("supportsDeveloperRole")
    {
        Some(Value::Bool(value)) => Some(*value),
        _ => None,
    };
    if let Some(value) = explicit_model_value.or(provider_value) {
        compat.insert("supportsDeveloperRole".to_string(), Value::Bool(value));
    }
    (!compat.is_empty()).then_some(Value::Object(compat))
}

fn write_pi_workspace(
    ws: &Path,
    selection: &ResolvedConversationModelSelection,
    api: ModelProviderApiType,
    runtime_env: &mut BTreeMap<String, String>,
) -> Result<(), AcpError> {
    let provider_id = selection.provider_id.as_str();
    let model_id = selection.model_id.as_str();

    // settings.json — provider/model selection (thinking level only when the
    // model declares reasoning).
    let mut settings = Map::new();
    settings.insert(
        "defaultProvider".to_string(),
        Value::String(provider_id.to_string()),
    );
    settings.insert(
        "defaultModel".to_string(),
        Value::String(model_id.to_string()),
    );
    if selection.model.reasoning {
        settings.insert(
            "defaultThinkingLevel".to_string(),
            Value::String(PI_DEFAULT_THINKING_LEVEL.to_string()),
        );
    }
    write_json(&ws.join("settings.json"), &settings, false)?;

    // auth.json — the provider credential, keyed by provider id.
    let mut entry = Map::new();
    entry.insert("type".to_string(), Value::String("api_key".to_string()));
    if let Some(key) = non_empty(selection.provider.api_key.as_deref()) {
        entry.insert("key".to_string(), Value::String(key.to_string()));
    }
    let mut auth = Map::new();
    auth.insert(provider_id.to_string(), Value::Object(entry));
    write_json(&ws.join("auth.json"), &auth, true)?;

    // models.json — the provider definition (baseUrl + api + the model entry).
    let mut models_doc = Map::new();
    let mut providers = Map::new();
    let mut provider = Map::new();
    if let Some(url) = non_empty(selection.provider.base_url.as_deref()) {
        provider.insert("baseUrl".to_string(), Value::String(url.to_string()));
    }
    provider.insert("api".to_string(), Value::String(api.as_str().to_string()));
    let mut model = Map::new();
    if let Some(compat) = pi_model_compat(selection, api) {
        model.insert("compat".to_string(), compat);
    }
    model.insert("id".to_string(), Value::String(model_id.to_string()));
    model.insert("name".to_string(), Value::String(model_id.to_string()));
    model.insert(
        "reasoning".to_string(),
        Value::Bool(selection.model.reasoning),
    );
    provider.insert(
        "models".to_string(),
        Value::Array(vec![Value::Object(model)]),
    );
    providers.insert(provider_id.to_string(), Value::Object(provider));
    models_doc.insert("providers".to_string(), Value::Object(providers));
    write_json(&ws.join("models.json"), &models_doc, false)?;

    // Keep the session store where the native/BYO Pi home put it. The provider
    // workspace isolates config, auth, and model catalog—not conversation
    // history—so resumed sessions remain discoverable after a model switch.
    runtime_env.insert(
        "PI_CODING_AGENT_SESSION_DIR".to_string(),
        pi_native_sessions_dir(runtime_env, dirs::home_dir())
            .to_string_lossy()
            .into_owned(),
    );
    runtime_env.insert(
        "PI_CODING_AGENT_DIR".to_string(),
        ws.to_string_lossy().into_owned(),
    );
    Ok(())
}

fn write_opencode_workspace(
    ws: &Path,
    selection: &ResolvedConversationModelSelection,
    api: ModelProviderApiType,
    runtime_env: &mut BTreeMap<String, String>,
) -> Result<(), AcpError> {
    let _ = api; // opencode serves every API family through its provider options.
    let config_home = ws.join("config");
    let data_home = ws.join("data");
    let provider_id = selection.provider_id.as_str();
    let model_id = selection.model_id.as_str();

    // opencode.json — provider definition + model selection. Written to the
    // XDG config dir opencode reads (`$XDG_CONFIG_HOME/opencode`).
    let mut doc = Map::new();
    doc.insert(
        "$schema".to_string(),
        Value::String("https://opencode.ai/config.json".to_string()),
    );
    let mut providers = Map::new();
    let mut provider = Map::new();
    let mut options = Map::new();
    if let Some(url) = non_empty(selection.provider.base_url.as_deref()) {
        options.insert("baseURL".to_string(), Value::String(url.to_string()));
    }
    provider.insert("options".to_string(), Value::Object(options));
    let mut models = Map::new();
    models.insert(model_id.to_string(), Value::Object(Map::new()));
    provider.insert("models".to_string(), Value::Object(models));
    providers.insert(provider_id.to_string(), Value::Object(provider));
    doc.insert("provider".to_string(), Value::Object(providers));
    doc.insert(
        "model".to_string(),
        Value::String(format!("{provider_id}/{model_id}")),
    );
    write_json(
        &config_home.join("opencode").join("opencode.json"),
        &doc,
        false,
    )?;

    // auth.json — the provider credential (`$XDG_DATA_HOME/opencode`).
    let mut entry = Map::new();
    entry.insert("type".to_string(), Value::String("api".to_string()));
    if let Some(key) = non_empty(selection.provider.api_key.as_deref()) {
        entry.insert("key".to_string(), Value::String(key.to_string()));
    }
    let mut auth = Map::new();
    auth.insert(provider_id.to_string(), Value::Object(entry));
    write_json(&data_home.join("opencode").join("auth.json"), &auth, true)?;

    runtime_env.insert(
        "XDG_CONFIG_HOME".to_string(),
        config_home.to_string_lossy().into_owned(),
    );
    runtime_env.insert(
        "XDG_DATA_HOME".to_string(),
        data_home.to_string_lossy().into_owned(),
    );
    Ok(())
}

fn write_cline_workspace(
    ws: &Path,
    selection: &ResolvedConversationModelSelection,
    api: ModelProviderApiType,
    runtime_env: &mut BTreeMap<String, String>,
) -> Result<(), AcpError> {
    let provider = match api {
        ModelProviderApiType::AnthropicMessages => "anthropic",
        ModelProviderApiType::OpenAiCompletions => "openai",
        ModelProviderApiType::GoogleGenerativeAi => "gemini",
        other => {
            return Err(AcpError::protocol(format!(
                "Cline cannot serve API type {}",
                other.as_str()
            )))
        }
    };
    // Cline's globalState model-id keys and baseUrl/secrets keys are
    // provider-specific (mirrors commands::acp's cline helpers).
    let (act_key, plan_key) = match provider {
        "openai" => ("actModeOpenAiModelId", "planModeOpenAiModelId"),
        _ => ("actModeApiModelId", "planModeApiModelId"),
    };
    let base_url_key = match provider {
        "anthropic" => "anthropicBaseUrl",
        "gemini" => "geminiBaseUrl",
        _ => "openAiBaseUrl",
    };
    let secrets_key = match provider {
        "anthropic" => "apiKey",
        "gemini" => "geminiApiKey",
        _ => "openAiApiKey",
    };

    let mut gs = Map::new();
    gs.insert("welcomeViewCompleted".to_string(), Value::Bool(true));
    gs.insert(
        "actModeApiProvider".to_string(),
        Value::String(provider.to_string()),
    );
    gs.insert(
        "planModeApiProvider".to_string(),
        Value::String(provider.to_string()),
    );
    gs.insert(
        act_key.to_string(),
        Value::String(selection.model_id.clone()),
    );
    gs.insert(
        plan_key.to_string(),
        Value::String(selection.model_id.clone()),
    );
    if let Some(url) = non_empty(selection.provider.base_url.as_deref()) {
        gs.insert(base_url_key.to_string(), Value::String(url.to_string()));
    }
    write_json(&ws.join("globalState.json"), &gs, false)?;

    let mut secrets = Map::new();
    if let Some(key) = non_empty(selection.provider.api_key.as_deref()) {
        secrets.insert(secrets_key.to_string(), Value::String(key.to_string()));
    }
    write_json(&ws.join("secrets.json"), &secrets, true)?;

    runtime_env.insert("CLINE_DIR".to_string(), ws.to_string_lossy().into_owned());
    Ok(())
}

fn write_hermes_workspace(
    ws: &Path,
    selection: &ResolvedConversationModelSelection,
    api: ModelProviderApiType,
    runtime_env: &mut BTreeMap<String, String>,
) -> Result<(), AcpError> {
    let (provider_id, key_env, base_url_env, inline_key) = match api {
        ModelProviderApiType::OpenAiCompletions => ("custom", "", "", true),
        ModelProviderApiType::AnthropicMessages => (
            "anthropic",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            false,
        ),
        ModelProviderApiType::GoogleGenerativeAi => {
            ("gemini", "GOOGLE_API_KEY", "GEMINI_BASE_URL", false)
        }
        other => {
            return Err(AcpError::protocol(format!(
                "Hermes cannot serve API type {}",
                other.as_str()
            )))
        }
    };

    // config.yaml — `model.provider/default/base_url`, with the API key inline
    // for the `custom` (self-hosted OpenAI-compatible) provider.
    use serde_yaml::{Mapping, Value as YamlValue};
    let mut root = Mapping::new();
    let mut model = Mapping::new();
    model.insert(
        YamlValue::String("provider".to_string()),
        YamlValue::String(provider_id.to_string()),
    );
    model.insert(
        YamlValue::String("default".to_string()),
        YamlValue::String(selection.model_id.clone()),
    );
    if let Some(url) = non_empty(selection.provider.base_url.as_deref()) {
        model.insert(
            YamlValue::String("base_url".to_string()),
            YamlValue::String(url.to_string()),
        );
    }
    if inline_key {
        if let Some(key) = non_empty(selection.provider.api_key.as_deref()) {
            model.insert(
                YamlValue::String("api_key".to_string()),
                YamlValue::String(key.to_string()),
            );
        }
    }
    root.insert(
        YamlValue::String("model".to_string()),
        YamlValue::Mapping(model),
    );
    let yaml = serde_yaml::to_string(&YamlValue::Mapping(root))
        .map_err(|e| AcpError::protocol(format!("serialize hermes config.yaml failed: {e}")))?;
    write_file(&ws.join("config.yaml"), &yaml, false)?;

    // .env — the API key (and best-effort endpoint override) for keyed
    // providers.
    if !inline_key {
        let mut env_body = String::new();
        if let Some(key) = non_empty(selection.provider.api_key.as_deref()) {
            env_body.push_str(&format!("{key_env}={key}\n"));
        }
        if let Some(url) = non_empty(selection.provider.base_url.as_deref()) {
            env_body.push_str(&format!("{base_url_env}={url}\n"));
        }
        write_file(&ws.join(".env"), &env_body, true)?;
    }

    runtime_env.insert("HERMES_HOME".to_string(), ws.to_string_lossy().into_owned());
    Ok(())
}

fn write_kimi_workspace(
    ws: &Path,
    selection: &ResolvedConversationModelSelection,
    api: ModelProviderApiType,
    runtime_env: &mut BTreeMap<String, String>,
) -> Result<(), AcpError> {
    let interface_type = match api {
        ModelProviderApiType::OpenAiCompletions => "openai",
        ModelProviderApiType::OpenAiResponses => "openai_responses",
        ModelProviderApiType::AnthropicMessages => "anthropic",
        ModelProviderApiType::GoogleGenerativeAi => "google-genai",
    };

    // config.toml — a self-contained codeg-managed provider + model block.
    let mut root = toml::map::Map::new();
    let mut providers = toml::map::Map::new();
    let mut provider = toml::map::Map::new();
    provider.insert(
        "type".to_string(),
        toml::Value::String(interface_type.to_string()),
    );
    if let Some(url) = non_empty(selection.provider.base_url.as_deref()) {
        provider.insert("base_url".to_string(), toml::Value::String(url.to_string()));
    }
    if let Some(key) = non_empty(selection.provider.api_key.as_deref()) {
        provider.insert("api_key".to_string(), toml::Value::String(key.to_string()));
    }
    providers.insert(
        KIMI_MANAGED_PROVIDER.to_string(),
        toml::Value::Table(provider),
    );
    root.insert("providers".to_string(), toml::Value::Table(providers));

    let mut models = toml::map::Map::new();
    let mut model = toml::map::Map::new();
    model.insert(
        "provider".to_string(),
        toml::Value::String(KIMI_MANAGED_PROVIDER.to_string()),
    );
    model.insert(
        "model".to_string(),
        toml::Value::String(selection.model_id.clone()),
    );
    // Kimi derives the request's `max_completion_tokens` from
    // `max_context_size` when no output cap is set, so an oversized window
    // makes providers with a smaller model limit (e.g. ARK's 128K GLM models)
    // 400 every request. Real metadata wins; the fallback is the largest
    // value every current OpenAI-compatible endpoint accepts (see
    // [`KIMI_DEFAULT_MAX_CONTEXT_SIZE`]).
    let context_window =
        positive_int(selection.model.context_window).unwrap_or(KIMI_DEFAULT_MAX_CONTEXT_SIZE);
    model.insert(
        "max_context_size".to_string(),
        toml::Value::Integer(context_window),
    );
    if let Some(max_output) = positive_int(selection.model.max_tokens) {
        model.insert(
            "max_output_size".to_string(),
            toml::Value::Integer(max_output),
        );
    }
    let mut capabilities = vec![
        "image_in".to_string(),
        "video_in".to_string(),
        "tool_use".to_string(),
    ];
    if selection.model.reasoning {
        capabilities.push("thinking".to_string());
    }
    model.insert(
        "capabilities".to_string(),
        toml::Value::Array(
            capabilities
                .iter()
                .map(|c| toml::Value::String(c.clone()))
                .collect(),
        ),
    );
    models.insert(
        KIMI_MANAGED_MODEL_ALIAS.to_string(),
        toml::Value::Table(model),
    );
    root.insert("models".to_string(), toml::Value::Table(models));
    root.insert(
        "default_model".to_string(),
        toml::Value::String(KIMI_MANAGED_MODEL_ALIAS.to_string()),
    );
    let body = toml::to_string_pretty(&toml::Value::Table(root))
        .map_err(|e| AcpError::protocol(format!("serialize kimi config.toml failed: {e}")))?;
    write_file(&ws.join("config.toml"), &format!("{body}\n"), true)?;

    // Synthetic ACP gate token — `kimi acp` requires a non-empty access_token
    // to open a session; the API key alone is never enough.
    let token = json!({
        "access_token": KIMI_SYNTHETIC_TOKEN_ACCESS,
        "refresh_token": "",
        "expires_at": 9_999_999_999i64,
        "expires_in": 9_999_999i64,
        "scope": "",
        "token_type": "Bearer",
        "_codeg_synthetic": true,
    });
    let body = serde_json::to_string_pretty(&token)
        .map_err(|e| AcpError::protocol(format!("serialize kimi credential failed: {e}")))?;
    write_file(
        &ws.join("credentials").join("kimi-code.json"),
        &format!("{body}\n"),
        true,
    )?;

    // The KIMI_MODEL_* env family takes priority over config.toml; clear any
    // stale settings-level values (including the env-model size bounds, inert
    // without a model name) so the workspace config is authoritative.
    for var in [
        "KIMI_MODEL_BASE_URL",
        "KIMI_MODEL_API_KEY",
        "KIMI_MODEL_NAME",
        "KIMI_MODEL_MAX_CONTEXT_SIZE",
        "KIMI_MODEL_MAX_OUTPUT_SIZE",
    ] {
        runtime_env.remove(var);
    }
    runtime_env.insert(
        "KIMI_CODE_HOME".to_string(),
        ws.to_string_lossy().into_owned(),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Small write helpers
// ---------------------------------------------------------------------------

fn write_json(path: &Path, doc: &Map<String, Value>, secret: bool) -> Result<(), AcpError> {
    let body = serde_json::to_string_pretty(doc)
        .map_err(|e| AcpError::protocol(format!("serialize {path:?} failed: {e}")))?;
    write_file(path, &format!("{body}\n"), secret)
}

fn write_file(path: &Path, content: &str, secret: bool) -> Result<(), AcpError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            AcpError::protocol(format!("create provider workspace directory failed: {e}"))
        })?;
    }
    fs::write(path, content)
        .map_err(|e| AcpError::protocol(format!("write provider workspace file failed: {e}")))?;
    if secret {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| {
                AcpError::protocol(format!(
                    "set provider workspace file permissions failed: {e}"
                ))
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::model_provider_file::{ModelEntryFile, ModelInputKind, ProviderFile};
    use std::collections::BTreeMap;

    fn sel(
        provider_id: &str,
        model_id: &str,
        api: ModelProviderApiType,
    ) -> ResolvedConversationModelSelection {
        ResolvedConversationModelSelection {
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            provider: ProviderFile {
                enabled: true,
                api: Some(api),
                base_url: Some("https://api.example.com/v1".to_string()),
                proxy: None,
                api_key: Some("sk-test-123".to_string()),
                auth_header: false,
                name: None,
                compat: None,
                headers: None,
                models: vec![],
            },
            model: ModelEntryFile {
                id: model_id.to_string(),
                name: None,
                reasoning: true,
                input: vec![ModelInputKind::Text, ModelInputKind::Image],
                context_window: None,
                max_tokens: None,
                base_instructions: None,
                compat: None,
            },
        }
    }

    fn run(
        agent: AgentType,
        api: ModelProviderApiType,
    ) -> (BTreeMap<String, String>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut env = BTreeMap::new();
        let s = sel("prov.example", "model-1", api);
        apply_launch_adapter(agent, &s, &mut env, tmp.path(), 7, None).expect("adapter ok");
        (env, tmp)
    }

    fn secret_perms(path: &Path) -> u32 {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(path)
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0)
        }
        // Non-unix builds do not enforce 0600 in `write_file`; report the
        // expected mode so the permission assertions stay meaningful on unix
        // and pass trivially elsewhere.
        #[cfg(not(unix))]
        {
            let _ = path;
            0o600
        }
    }

    #[test]
    fn env_only_agents_project_env_and_write_nothing() {
        for (agent, api) in [
            (
                AgentType::ClaudeCode,
                ModelProviderApiType::AnthropicMessages,
            ),
            (AgentType::Gemini, ModelProviderApiType::GoogleGenerativeAi),
            (AgentType::Grok, ModelProviderApiType::AnthropicMessages),
            (AgentType::DeepSeek, ModelProviderApiType::OpenAiCompletions),
            (
                AgentType::CodeBuddy,
                ModelProviderApiType::OpenAiCompletions,
            ),
            (AgentType::KimiCode, ModelProviderApiType::OpenAiCompletions),
        ] {
            let (env, tmp) = run(agent, api);
            let (url_key, key_key, model_key) = match agent {
                AgentType::CodeBuddy => ("CODEBUDDY_BASE_URL", "CODEBUDDY_API_KEY", ""),
                _ => crate::commands::acp::agent_env_keys(agent),
            };
            assert_eq!(
                env.get(url_key).map(String::as_str),
                Some("https://api.example.com/v1"),
                "{agent:?}"
            );
            assert_eq!(
                env.get(key_key).map(String::as_str),
                Some("sk-test-123"),
                "{agent:?}"
            );
            if !model_key.is_empty() {
                assert_eq!(
                    env.get(model_key).map(String::as_str),
                    Some("model-1"),
                    "{agent:?}"
                );
            }
            // No config-home env, no workspace files.
            for var in [
                "CODEX_HOME",
                "PI_CODING_AGENT_DIR",
                "XDG_CONFIG_HOME",
                "CLINE_DIR",
                "HERMES_HOME",
                "KIMI_CODE_HOME",
            ] {
                assert!(!env.contains_key(var), "{agent:?} set {var}");
            }
            let ws = tmp.path().join(MODEL_PROVIDER_WORKSPACE_ROOT);
            assert!(!ws.exists(), "{agent:?} wrote a workspace");
        }
    }

    #[test]
    fn codex_rejects_chat_completions_without_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut env = BTreeMap::new();
        let s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );

        let result = apply_launch_adapter(AgentType::Codex, &s, &mut env, tmp.path(), 7, None);

        assert!(result.is_err());
        assert!(!env.contains_key("CODEX_HOME"));
        assert!(!tmp
            .path()
            .join(MODEL_PROVIDER_WORKSPACE_ROOT)
            .join("codex")
            .join("7")
            .join("config.toml")
            .exists());
    }

    #[test]
    fn codex_responses_workspace_writes_auth_and_config() {
        let (env, tmp) = run(AgentType::Codex, ModelProviderApiType::OpenAiResponses);
        let home = PathBuf::from(env["CODEX_HOME"].as_str());
        assert_eq!(
            home,
            tmp.path()
                .join(MODEL_PROVIDER_WORKSPACE_ROOT)
                .join("codex")
                .join("7")
        );

        let auth: Value =
            serde_json::from_str(&fs::read_to_string(home.join("auth.json")).unwrap()).unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "sk-test-123");
        assert_eq!(secret_perms(&home.join("auth.json")), 0o600);

        let raw = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(raw.contains("model = \"model-1\""), "{raw}");
        assert!(raw.contains("model_provider = \"prov.example\""), "{raw}");
        assert!(
            raw.contains("base_url = \"https://api.example.com/v1\""),
            "{raw}"
        );
        assert!(raw.contains("wire_api = \"responses\""), "{raw}");
        assert!(raw.contains("requires_openai_auth = true"), "{raw}");
        // The workspace is a fresh Codex home; without an explicit
        // `model_catalog_json` codex falls back to its bundled OpenAI-only
        // catalog and rejects the selected provider model. The adapter must
        // write a customs-only catalog and point config.toml at it.
        assert!(
            raw.contains("model_catalog_json = \"codeg-model-catalog.json\""),
            "{raw}"
        );
        let catalog_path = home.join("codeg-model-catalog.json");
        let catalog: Value = serde_json::from_str(
            &fs::read_to_string(&catalog_path).expect("workspace catalog exists"),
        )
        .unwrap();
        let models = catalog["models"].as_array().expect("models array");
        assert_eq!(
            models.len(),
            1,
            "customs-only catalog has exactly one entry"
        );
        assert_eq!(models[0]["slug"], "model-1");
        assert_eq!(models[0]["visibility"], "list");
        assert_eq!(models[0]["supported_in_api"], true);
        assert!(models[0]["upgrade"].is_null());
    }

    /// A provider-defined `context_window` on the selected model is the one
    /// the workspace catalog advertises; `max_context_window` must be at
    /// least that value so a smaller custom does not shrink the upper
    /// bound the clone base carried.
    #[test]
    fn codex_workspace_uses_selection_context_window() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp
            .path()
            .join(MODEL_PROVIDER_WORKSPACE_ROOT)
            .join("codex")
            .join("11");
        let mut s = sel(
            "prov.example",
            "deepseek-v4-flash",
            ModelProviderApiType::OpenAiResponses,
        );
        s.model.context_window = Some(8_192);
        s.model.name = Some("DeepSeek V4 Flash".to_string());
        let mut env = BTreeMap::new();
        write_codex_workspace(&ws, &s, ModelProviderApiType::OpenAiResponses, &mut env)
            .expect("adapter ok");

        let catalog: Value =
            serde_json::from_str(&fs::read_to_string(ws.join("codeg-model-catalog.json")).unwrap())
                .unwrap();
        let entry = &catalog["models"][0];
        assert_eq!(entry["slug"], "deepseek-v4-flash");
        assert_eq!(entry["display_name"], "DeepSeek V4 Flash");
        assert_eq!(entry["context_window"].as_u64(), Some(8_192));
        assert!(
            entry["max_context_window"].as_u64().unwrap() >= 8_192,
            "max_context_window must be >= the custom's context_window"
        );
        // `model_catalog_json` in config.toml still points at the file.
        let raw = fs::read_to_string(ws.join("config.toml")).unwrap();
        assert!(
            raw.contains("model_catalog_json = \"codeg-model-catalog.json\""),
            "{raw}"
        );
    }

    fn run_pi(
        initial_env: BTreeMap<String, String>,
    ) -> (BTreeMap<String, String>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp
            .path()
            .join(MODEL_PROVIDER_WORKSPACE_ROOT)
            .join("pi")
            .join("7");
        let s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::AnthropicMessages,
        );
        let mut env = initial_env;
        write_pi_workspace(&ws, &s, ModelProviderApiType::AnthropicMessages, &mut env)
            .expect("pi adapter ok");
        (env, tmp)
    }

    #[test]
    fn pi_workspace_writes_settings_auth_models() {
        let (env, tmp) = run(AgentType::Pi, ModelProviderApiType::AnthropicMessages);
        let home = PathBuf::from(env["PI_CODING_AGENT_DIR"].as_str());
        assert_eq!(
            home,
            tmp.path()
                .join(MODEL_PROVIDER_WORKSPACE_ROOT)
                .join("pi")
                .join("7")
        );

        let settings: Value =
            serde_json::from_str(&fs::read_to_string(home.join("settings.json")).unwrap()).unwrap();
        assert_eq!(settings["defaultProvider"], "prov.example");
        assert_eq!(settings["defaultModel"], "model-1");
        assert_eq!(settings["defaultThinkingLevel"], "medium");

        let auth: Value =
            serde_json::from_str(&fs::read_to_string(home.join("auth.json")).unwrap()).unwrap();
        assert_eq!(auth["prov.example"]["type"], "api_key");
        assert_eq!(auth["prov.example"]["key"], "sk-test-123");
        assert_eq!(secret_perms(&home.join("auth.json")), 0o600);

        let models: Value =
            serde_json::from_str(&fs::read_to_string(home.join("models.json")).unwrap()).unwrap();
        let p = &models["providers"]["prov.example"];
        assert_eq!(p["baseUrl"], "https://api.example.com/v1");
        assert_eq!(p["api"], "anthropic-messages");
        assert_eq!(p["models"][0]["id"], "model-1");
        assert_eq!(p["models"][0]["reasoning"], true);

        // The default provider workspace must not become an empty Pi session
        // store; sessions stay in the user's native/BYO Pi sessions root.
        assert!(env.contains_key("PI_CODING_AGENT_SESSION_DIR"));
        assert_ne!(
            PathBuf::from(env["PI_CODING_AGENT_SESSION_DIR"].as_str()),
            home.join("sessions")
        );
    }

    #[test]
    fn pi_workspace_preserves_explicit_session_store() {
        let initial = BTreeMap::from([
            (
                "PI_CODING_AGENT_SESSION_DIR".to_string(),
                "/custom/pi/sessions".to_string(),
            ),
            (
                "PI_CODING_AGENT_DIR".to_string(),
                "/custom/pi-home".to_string(),
            ),
        ]);
        let (env, _tmp) = run_pi(initial);

        assert_eq!(env["PI_CODING_AGENT_SESSION_DIR"], "/custom/pi/sessions");
    }

    #[test]
    fn pi_workspace_preserves_byo_agent_session_store() {
        let initial = BTreeMap::from([(
            "PI_CODING_AGENT_DIR".to_string(),
            "/custom/pi-home".to_string(),
        )]);
        let (env, _tmp) = run_pi(initial);

        assert_eq!(
            env["PI_CODING_AGENT_SESSION_DIR"],
            "/custom/pi-home/sessions"
        );
    }

    #[test]
    fn pi_workspace_projects_provider_developer_role_compat() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut selection = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        selection.provider.compat = Some(serde_json::json!({
            "supportsDeveloperRole": false
        }));
        let mut env = BTreeMap::new();
        write_pi_workspace(
            &tmp.path().join("pi"),
            &selection,
            ModelProviderApiType::OpenAiCompletions,
            &mut env,
        )
        .expect("pi adapter ok");

        let models: Value = serde_json::from_str(
            &fs::read_to_string(tmp.path().join("pi").join("models.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            models["providers"]["prov.example"]["models"][0]["compat"]["supportsDeveloperRole"],
            false
        );
    }

    #[test]
    fn pi_workspace_prefers_model_developer_role_compat() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut selection = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        selection.provider.compat = Some(serde_json::json!({
            "supportsDeveloperRole": true
        }));
        selection.model.compat = Some(serde_json::json!({
            "supportsDeveloperRole": false
        }));
        let mut env = BTreeMap::new();
        write_pi_workspace(
            &tmp.path().join("pi"),
            &selection,
            ModelProviderApiType::OpenAiCompletions,
            &mut env,
        )
        .expect("pi adapter ok");

        let models: Value = serde_json::from_str(
            &fs::read_to_string(tmp.path().join("pi").join("models.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            models["providers"]["prov.example"]["models"][0]["compat"]["supportsDeveloperRole"],
            false
        );
    }

    #[test]
    fn pi_workspace_omits_developer_role_compat_when_unset() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let selection = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        let mut env = BTreeMap::new();
        write_pi_workspace(
            &tmp.path().join("pi"),
            &selection,
            ModelProviderApiType::OpenAiCompletions,
            &mut env,
        )
        .expect("pi adapter ok");

        let models: Value = serde_json::from_str(
            &fs::read_to_string(tmp.path().join("pi").join("models.json")).unwrap(),
        )
        .unwrap();
        let model = &models["providers"]["prov.example"]["models"][0];
        assert!(model.get("compat").is_none(), "{model}");
    }

    #[test]
    fn pi_workspace_ignores_developer_role_compat_for_other_apis() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut selection = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::AnthropicMessages,
        );
        selection.provider.compat = Some(serde_json::json!({
            "supportsDeveloperRole": false
        }));
        let mut env = BTreeMap::new();
        write_pi_workspace(
            &tmp.path().join("pi"),
            &selection,
            ModelProviderApiType::AnthropicMessages,
            &mut env,
        )
        .expect("pi adapter ok");

        let models: Value = serde_json::from_str(
            &fs::read_to_string(tmp.path().join("pi").join("models.json")).unwrap(),
        )
        .unwrap();
        let model = &models["providers"]["prov.example"]["models"][0];
        assert!(model.get("compat").is_none(), "{model}");
    }

    #[test]
    fn pi_session_dir_resolution_keeps_native_default() {
        let env = BTreeMap::new();

        assert_eq!(
            pi_native_sessions_dir(&env, Some(PathBuf::from("/home/demo"))),
            PathBuf::from("/home/demo/.pi/agent/sessions")
        );
    }

    #[test]
    fn opencode_workspace_writes_xdg_config_and_auth() {
        let (env, _tmp) = run(
            AgentType::OpenCode,
            ModelProviderApiType::GoogleGenerativeAi,
        );
        let config_home = PathBuf::from(env["XDG_CONFIG_HOME"].as_str());
        let data_home = PathBuf::from(env["XDG_DATA_HOME"].as_str());

        let cfg: Value = serde_json::from_str(
            &fs::read_to_string(config_home.join("opencode").join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            cfg["provider"]["prov.example"]["options"]["baseURL"],
            "https://api.example.com/v1"
        );
        assert!(cfg["provider"]["prov.example"]["models"]
            .as_object()
            .unwrap()
            .contains_key("model-1"));
        assert_eq!(cfg["model"], "prov.example/model-1");

        let auth: Value = serde_json::from_str(
            &fs::read_to_string(data_home.join("opencode").join("auth.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(auth["prov.example"]["type"], "api");
        assert_eq!(auth["prov.example"]["key"], "sk-test-123");
        assert_eq!(
            secret_perms(&data_home.join("opencode").join("auth.json")),
            0o600
        );
    }

    #[test]
    fn cline_workspace_writes_global_state_and_secrets() {
        let (env, tmp) = run(AgentType::Cline, ModelProviderApiType::OpenAiCompletions);
        let home = PathBuf::from(env["CLINE_DIR"].as_str());
        assert_eq!(
            home,
            tmp.path()
                .join(MODEL_PROVIDER_WORKSPACE_ROOT)
                .join("cline")
                .join("7")
        );

        let gs: Value =
            serde_json::from_str(&fs::read_to_string(home.join("globalState.json")).unwrap())
                .unwrap();
        assert_eq!(gs["actModeApiProvider"], "openai");
        assert_eq!(gs["actModeOpenAiModelId"], "model-1");
        assert_eq!(gs["openAiBaseUrl"], "https://api.example.com/v1");
        assert_eq!(gs["welcomeViewCompleted"], true);

        let secrets: Value =
            serde_json::from_str(&fs::read_to_string(home.join("secrets.json")).unwrap()).unwrap();
        assert_eq!(secrets["openAiApiKey"], "sk-test-123");
        assert_eq!(secret_perms(&home.join("secrets.json")), 0o600);
    }

    #[test]
    fn hermes_workspace_inlines_custom_provider_config() {
        let (env, _tmp) = run(AgentType::Hermes, ModelProviderApiType::OpenAiCompletions);
        let home = PathBuf::from(env["HERMES_HOME"].as_str());
        let yaml = fs::read_to_string(home.join("config.yaml")).unwrap();
        assert!(yaml.contains("provider: custom"), "{yaml}");
        assert!(yaml.contains("default: model-1"), "{yaml}");
        assert!(
            yaml.contains("base_url: https://api.example.com/v1"),
            "{yaml}"
        );
        assert!(yaml.contains("api_key: sk-test-123"), "{yaml}");
        // custom reads no .env
        assert!(!home.join(".env").exists());
    }

    #[test]
    fn hermes_keyed_provider_writes_env() {
        let (env, _tmp) = run(AgentType::Hermes, ModelProviderApiType::AnthropicMessages);
        let home = PathBuf::from(env["HERMES_HOME"].as_str());
        let yaml = fs::read_to_string(home.join("config.yaml")).unwrap();
        assert!(yaml.contains("provider: anthropic"), "{yaml}");
        assert!(!yaml.contains("api_key:"), "{yaml}");
        let dotenv = fs::read_to_string(home.join(".env")).unwrap();
        assert!(dotenv.contains("ANTHROPIC_API_KEY=sk-test-123"), "{dotenv}");
        assert_eq!(secret_perms(&home.join(".env")), 0o600);
    }

    #[test]
    fn kimi_workspace_writes_config_and_gate_token() {
        let (env, tmp) = run(AgentType::KimiCode, ModelProviderApiType::AnthropicMessages);
        let home = PathBuf::from(env["KIMI_CODE_HOME"].as_str());
        assert_eq!(
            home,
            tmp.path()
                .join(MODEL_PROVIDER_WORKSPACE_ROOT)
                .join("kimi_code")
                .join("7")
        );

        let raw = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(raw.contains("default_model = \"codeg-managed\""), "{raw}");
        assert!(raw.contains("type = \"anthropic\""), "{raw}");
        assert!(
            raw.contains("base_url = \"https://api.example.com/v1\""),
            "{raw}"
        );
        assert!(raw.contains("api_key = \"sk-test-123\""), "{raw}");
        assert!(raw.contains("capabilities"), "{raw}");
        assert!(raw.contains("\"thinking\""), "{raw}");

        let token: Value = serde_json::from_str(
            &fs::read_to_string(home.join("credentials").join("kimi-code.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(token["_codeg_synthetic"], true);
        assert_eq!(secret_perms(&home.join("config.toml")), 0o600);

        // stale KIMI_MODEL_* overrides must be cleared so config.toml wins.
        assert!(!env.contains_key("KIMI_MODEL_BASE_URL"));
        assert!(!env.contains_key("KIMI_MODEL_API_KEY"));
        assert!(!env.contains_key("KIMI_MODEL_NAME"));
    }

    /// Regression: kimi synthesizes its env model with a 262144-token window
    /// and no output cap, then sends `max_completion_tokens == window` — which
    /// providers with a smaller model limit (e.g. ARK's 128K GLM models) reject
    /// with a 400 kimi-acp never surfaces. The launch projection must bound the
    /// request from the selection's own metadata instead.
    #[test]
    fn kimi_env_model_projects_size_metadata() {
        let mut s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        s.model.context_window = Some(131_072);
        s.model.max_tokens = Some(32_768);
        let mut env = BTreeMap::new();
        apply_launch_adapter(
            AgentType::KimiCode,
            &s,
            &mut env,
            Path::new("/tmp/unused"),
            1,
            None,
        )
        .expect("adapter ok");
        assert_eq!(env["KIMI_MODEL_MAX_CONTEXT_SIZE"], "131072");
        assert_eq!(env["KIMI_MODEL_MAX_OUTPUT_SIZE"], "32768");
    }

    /// Without metadata the projection must still replace kimi's 256K env-model
    /// default with the largest value every OpenAI-compatible endpoint accepts.
    #[test]
    fn kimi_env_model_bounds_context_window_without_metadata() {
        let s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        let mut env = BTreeMap::new();
        apply_launch_adapter(
            AgentType::KimiCode,
            &s,
            &mut env,
            Path::new("/tmp/unused"),
            1,
            None,
        )
        .expect("adapter ok");
        assert_eq!(env["KIMI_MODEL_MAX_CONTEXT_SIZE"], "131072");
        // No max_tokens metadata → no output cap; kimi derives it from the window.
        assert!(!env.contains_key("KIMI_MODEL_MAX_OUTPUT_SIZE"));
    }

    /// Non-positive metadata values mean "unset" and must fall back cleanly.
    #[test]
    fn kimi_env_model_ignores_non_positive_metadata() {
        let mut s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        s.model.context_window = Some(0);
        s.model.max_tokens = Some(-5);
        let mut env = BTreeMap::new();
        apply_launch_adapter(
            AgentType::KimiCode,
            &s,
            &mut env,
            Path::new("/tmp/unused"),
            1,
            None,
        )
        .expect("adapter ok");
        assert_eq!(env["KIMI_MODEL_MAX_CONTEXT_SIZE"], "131072");
        assert!(!env.contains_key("KIMI_MODEL_MAX_OUTPUT_SIZE"));
    }

    /// The workspace config path gets the same treatment: metadata wins,
    /// otherwise the bounded default — and `max_output_size` is written only
    /// when the model declares one.
    #[test]
    fn kimi_workspace_uses_model_size_metadata() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::AnthropicMessages,
        );
        s.model.context_window = Some(1_000_000);
        s.model.max_tokens = Some(128_000);
        let mut env = BTreeMap::new();
        write_kimi_workspace(
            &tmp.path().join("kimi"),
            &s,
            ModelProviderApiType::AnthropicMessages,
            &mut env,
        )
        .expect("workspace ok");
        let raw = fs::read_to_string(tmp.path().join("kimi").join("config.toml")).unwrap();
        assert!(raw.contains("max_context_size = 1000000"), "{raw}");
        assert!(raw.contains("max_output_size = 128000"), "{raw}");

        // And the no-metadata shape: window only.
        let s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::AnthropicMessages,
        );
        let mut env = BTreeMap::new();
        write_kimi_workspace(
            &tmp.path().join("kimi-bare"),
            &s,
            ModelProviderApiType::AnthropicMessages,
            &mut env,
        )
        .expect("workspace ok");
        let raw = fs::read_to_string(tmp.path().join("kimi-bare").join("config.toml")).unwrap();
        assert!(raw.contains("max_context_size = 131072"), "{raw}");
        assert!(!raw.contains("max_output_size"), "{raw}");
    }

    #[test]
    fn rewrite_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // KimiCode needs a non-completions API to exercise its workspace path
        // (OpenAiCompletions is env-only); Codex requires the OpenAI
        // Responses API; every other workspace agent here is exercised on
        // completions.
        for (agent, api) in [
            (AgentType::Codex, ModelProviderApiType::OpenAiResponses),
            (AgentType::Pi, ModelProviderApiType::OpenAiCompletions),
            (AgentType::OpenCode, ModelProviderApiType::OpenAiCompletions),
            (AgentType::Cline, ModelProviderApiType::OpenAiCompletions),
            (AgentType::Hermes, ModelProviderApiType::OpenAiCompletions),
            (AgentType::KimiCode, ModelProviderApiType::AnthropicMessages),
        ] {
            let s = sel("prov.example", "model-1", api);
            let mut env1 = BTreeMap::new();
            let mut env2 = BTreeMap::new();
            apply_launch_adapter(agent, &s, &mut env1, tmp.path(), 3, None).expect("first");
            let blob1 = workspace_fingerprint_blob(agent, &env1)
                .unwrap_or_else(|| panic!("blob1 for {agent:?}"));
            apply_launch_adapter(agent, &s, &mut env2, tmp.path(), 3, None).expect("second");
            let blob2 = workspace_fingerprint_blob(agent, &env2)
                .unwrap_or_else(|| panic!("blob2 for {agent:?}"));
            assert_eq!(blob1, blob2, "{agent:?} workspace not idempotent");
        }
    }

    #[test]
    fn cleanup_removes_conversation_workspace() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiResponses,
        );
        let mut env = BTreeMap::new();
        apply_launch_adapter(AgentType::Codex, &s, &mut env, tmp.path(), 9, None).expect("adapter");
        let ws = tmp
            .path()
            .join(MODEL_PROVIDER_WORKSPACE_ROOT)
            .join("codex")
            .join("9");
        assert!(ws.exists());
        cleanup_conversation_workspaces(tmp.path(), 9);
        assert!(!ws.exists());
    }

    #[test]
    fn fingerprint_blob_only_for_provider_workspace() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // A native (non-provider) CODEX_HOME must not be fingerprinted.
        let mut env = BTreeMap::new();
        env.insert("CODEX_HOME".to_string(), "/home/user/.codex".to_string());
        assert!(workspace_fingerprint_blob(AgentType::Codex, &env).is_none());

        // An env-only agent never has a config-home var.
        let mut env2 = BTreeMap::new();
        env2.insert("ANTHROPIC_BASE_URL".to_string(), "https://x".to_string());
        assert!(workspace_fingerprint_blob(AgentType::ClaudeCode, &env2).is_none());

        // A provider workspace yields a deterministic blob.
        let s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiResponses,
        );
        let mut env3 = BTreeMap::new();
        apply_launch_adapter(AgentType::Codex, &s, &mut env3, tmp.path(), 5, None)
            .expect("adapter");
        let blob = workspace_fingerprint_blob(AgentType::Codex, &env3).expect("blob");
        assert!(blob.contains("config.toml"));
        assert!(blob.contains("model-1"));
        assert_eq!(
            blob,
            workspace_fingerprint_blob(AgentType::Codex, &env3).unwrap()
        );
    }

    #[test]
    fn provider_proxy_is_projected_into_launch_env() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        s.provider.proxy = Some("http://127.0.0.1:8080".to_string());
        let mut env = BTreeMap::new();
        apply_launch_adapter(AgentType::ClaudeCode, &s, &mut env, tmp.path(), 1, None)
            .expect("adapter");
        for var in [
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            assert_eq!(
                env.get(var).map(String::as_str),
                Some("http://127.0.0.1:8080"),
                "{var}"
            );
        }
    }

    #[test]
    fn provider_without_proxy_leaves_global_proxy_alone() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        let mut env = BTreeMap::new();
        env.insert("HTTPS_PROXY".to_string(), "http://global:3128".to_string());
        apply_launch_adapter(AgentType::ClaudeCode, &s, &mut env, tmp.path(), 1, None)
            .expect("adapter");
        assert_eq!(
            env.get("HTTPS_PROXY").map(String::as_str),
            Some("http://global:3128")
        );
        assert!(!env.contains_key("HTTP_PROXY"));
    }

    #[test]
    fn api_key_with_line_break_is_rejected() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        s.provider.api_key = Some("sk-bad\nINJECTED=1".to_string());
        let mut env = BTreeMap::new();
        let err =
            apply_launch_adapter(AgentType::Codex, &s, &mut env, tmp.path(), 1, None).unwrap_err();
        assert!(err.to_string().contains("line breaks"), "{err}");
    }

    #[test]
    fn unsupported_agent_is_rejected() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let s = sel(
            "prov.example",
            "model-1",
            ModelProviderApiType::OpenAiCompletions,
        );
        let mut env = BTreeMap::new();
        let err =
            apply_launch_adapter(AgentType::Cursor, &s, &mut env, tmp.path(), 1, None).unwrap_err();
        assert!(err
            .to_string()
            .contains("does not support the shared Model Provider source"));
    }

    fn custom_sel(api: ModelProviderApiType) -> ResolvedConversationModelSelection {
        sel("prov.example", "model-1", api)
    }

    /// A custom agent without a `modelEnv` declaration projects under the
    /// standard convention keys for the provider's API family, and writes no
    /// config workspace.
    #[test]
    fn custom_without_declaration_uses_standard_family_keys() {
        for (api, (url_key, key_key, model_key)) in [
            (
                ModelProviderApiType::OpenAiCompletions,
                ("OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"),
            ),
            (
                ModelProviderApiType::OpenAiResponses,
                ("OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"),
            ),
            (
                ModelProviderApiType::AnthropicMessages,
                (
                    "ANTHROPIC_BASE_URL",
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_MODEL",
                ),
            ),
        ] {
            let tmp = tempfile::tempdir().expect("tempdir");
            let s = custom_sel(api);
            let mut env = BTreeMap::new();
            apply_launch_adapter(
                AgentType::Custom("qwen-code"),
                &s,
                &mut env,
                tmp.path(),
                1,
                None,
            )
            .expect("adapter ok");
            assert_eq!(env[url_key], "https://api.example.com/v1");
            assert_eq!(env[key_key], "sk-test-123");
            assert_eq!(env[model_key], "model-1");
            assert!(
                !tmp.path().join("custom").exists(),
                "custom agents write no workspace"
            );
        }
    }

    /// A `modelEnv` declaration renames the slots it covers — the GLM Agent
    /// case (`ACP_GLM_BASE_URL`/`Z_AI_API_KEY`/`ACP_GLM_MODEL`).
    #[test]
    fn custom_declaration_overrides_standard_keys() {
        let s = custom_sel(ModelProviderApiType::OpenAiCompletions);
        let mut env = BTreeMap::new();
        apply_custom_env_only(
            &s,
            &mut env,
            Some(&ModelEnvDeclaration {
                base_url: Some("ACP_GLM_BASE_URL".to_string()),
                api_key: Some("Z_AI_API_KEY".to_string()),
                model: Some("ACP_GLM_MODEL".to_string()),
            }),
        )
        .expect("projection ok");
        assert_eq!(env["ACP_GLM_BASE_URL"], "https://api.example.com/v1");
        assert_eq!(env["Z_AI_API_KEY"], "sk-test-123");
        assert_eq!(env["ACP_GLM_MODEL"], "model-1");
        assert!(!env.contains_key("OPENAI_BASE_URL"));
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(!env.contains_key("OPENAI_MODEL"));
    }

    /// A blank or absent slot falls back to the standard key for the family —
    /// a declaration only has to cover the slots the agent actually renames.
    #[test]
    fn custom_declaration_blank_slots_fall_back_to_standard() {
        let s = custom_sel(ModelProviderApiType::OpenAiCompletions);
        let mut env = BTreeMap::new();
        apply_custom_env_only(
            &s,
            &mut env,
            Some(&ModelEnvDeclaration {
                base_url: Some("   ".to_string()),
                api_key: None,
                model: Some("ACP_GLM_MODEL".to_string()),
            }),
        )
        .expect("projection ok");
        assert_eq!(env["OPENAI_BASE_URL"], "https://api.example.com/v1");
        assert_eq!(env["OPENAI_API_KEY"], "sk-test-123");
        assert_eq!(env["ACP_GLM_MODEL"], "model-1");
    }

    /// Empty provider values are never injected, so an agent's own resolution
    /// survives a provider that declares no base URL or key.
    #[test]
    fn custom_empty_values_inject_nothing() {
        let mut s = custom_sel(ModelProviderApiType::OpenAiCompletions);
        s.provider.base_url = None;
        s.provider.api_key = Some("   ".to_string());
        let mut env = BTreeMap::new();
        apply_custom_env_only(&s, &mut env, None).expect("projection ok");
        assert!(!env.contains_key("OPENAI_BASE_URL"));
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert_eq!(env["OPENAI_MODEL"], "model-1");
    }
}
