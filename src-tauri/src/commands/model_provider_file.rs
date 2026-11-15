//! Backend for the shared Model Provider catalog stored in `models.json`.
//!
//! This deliberately runs beside the legacy database-backed provider commands.
//! Native Claude/Codex/Gemini provider bindings continue to use those paths;
//! the new agent-independent source uses this ordered, atomic JSON store.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::app_error::AppCommandError;
use crate::models::agent::AgentType;
use crate::models::model_provider_file::{
    draft_model_to_file, file_model_to_draft, mask_api_key, parse_positive, read_models_file,
    validate_model_ids, write_models_file, BuiltinProviderInfo, ModelEntryDraft, ModelEntryFile,
    ModelProviderApiType, ModelProviderDraft, ModelProviderRecord, ModelsFile, ProbeOutcome,
    ProviderFile, SaveResult, TestOutcome,
};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub const MODEL_PROVIDERS_UPDATED_EVENT: &str = "model-providers://updated";

static MODEL_PROVIDER_FILE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));
static PROVIDER_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").expect("valid regex"));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeParams {
    pub base_url: String,
    pub api: ModelProviderApiType,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub auth_header: Option<bool>,
}

/// Resolve the catalog path. The environment override intentionally supports
/// pointing at an existing pios file without copying it.
pub fn models_json_path(data_dir: &Path) -> PathBuf {
    std::env::var_os("CODEG_MODELS_JSON")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("models.json"))
}

pub fn model_provider_api_types(agent_type: &AgentType) -> Vec<ModelProviderApiType> {
    match agent_type {
        AgentType::ClaudeCode => vec![ModelProviderApiType::AnthropicMessages],
        AgentType::Codex => vec![ModelProviderApiType::OpenAiResponses],
        AgentType::Gemini => vec![ModelProviderApiType::GoogleGenerativeAi],
        AgentType::OpenCode | AgentType::Pi | AgentType::KimiCode => vec![
            ModelProviderApiType::OpenAiCompletions,
            ModelProviderApiType::OpenAiResponses,
            ModelProviderApiType::AnthropicMessages,
            ModelProviderApiType::GoogleGenerativeAi,
        ],
        AgentType::Cline => vec![
            ModelProviderApiType::AnthropicMessages,
            ModelProviderApiType::OpenAiCompletions,
            ModelProviderApiType::GoogleGenerativeAi,
        ],
        AgentType::Grok => vec![
            ModelProviderApiType::OpenAiCompletions,
            ModelProviderApiType::OpenAiResponses,
            ModelProviderApiType::AnthropicMessages,
        ],
        AgentType::Hermes => vec![
            ModelProviderApiType::OpenAiCompletions,
            ModelProviderApiType::AnthropicMessages,
            ModelProviderApiType::GoogleGenerativeAi,
        ],
        AgentType::CodeBuddy | AgentType::DeepSeek => vec![ModelProviderApiType::OpenAiCompletions],
        AgentType::Antigravity => vec![ModelProviderApiType::GoogleGenerativeAi],
        // Custom agents are resolved per-definition by
        // [`model_provider_api_types_for_agent`], which consults the stored
        // declaration and codeg's verified contracts
        // (see `custom_registry::known_model_provider_contract`).
        _ => Vec::new(),
    }
}

/// [`model_provider_api_types`] with the DB-aware custom-agent case.
///
/// A custom agent advertises the shared Model Provider source only when codeg
/// can actually project it: the definition declares the env-var names
/// (`model_env`) or the agent is a verified standard-convention reader. Every
/// API family the projection can express is advertised — the provider choice
/// plus the declaration decide the wire format.
pub fn model_provider_api_types_for_agent(agent_type: &AgentType) -> Vec<ModelProviderApiType> {
    match agent_type {
        AgentType::Custom(registry_id) => {
            // The stored declaration can be read straight from the hydrated
            // registry cache; the DB row is the same data.
            let declared = crate::acp::custom_registry::model_env_of(registry_id);
            crate::acp::custom_registry::model_provider_api_types(
                registry_id,
                declared.as_ref(),
            )
        }
        other => model_provider_api_types(other),
    }
}

fn valid_url(raw: &str, label: &str) -> Result<(), AppCommandError> {
    if raw.len() > 2048 {
        return Err(AppCommandError::invalid_input(format!(
            "{label} must be 2048 characters or less"
        )));
    }
    if !raw.starts_with("http://") && !raw.starts_with("https://") {
        return Err(AppCommandError::invalid_input(format!(
            "{label} must start with http:// or https://"
        )));
    }
    Ok(())
}

fn validate_provider_id(raw: &str) -> Result<String, AppCommandError> {
    let id = raw.trim();
    if !PROVIDER_ID_RE.is_match(id) {
        return Err(AppCommandError::invalid_input(
            "Provider id must start with a letter or number and contain only letters, numbers, dot, underscore, or dash",
        ));
    }
    Ok(id.to_string())
}

fn validate_draft(draft: &ModelProviderDraft, creating: bool) -> Result<(), AppCommandError> {
    let provider_id = validate_provider_id(&draft.provider_id)?;
    if !creating && draft.original_id.trim() != provider_id {
        return Err(AppCommandError::invalid_input(
            "Provider id is immutable; create a new provider instead of renaming it",
        ));
    }
    if draft.api_key.len() > 4096 {
        return Err(AppCommandError::invalid_input(
            "API key must be 4096 characters or less",
        ));
    }
    valid_url(draft.base_url.trim(), "Base URL")?;
    if let Some(proxy) = draft
        .proxy
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        valid_url(proxy, "Proxy")?;
    }
    if draft.models.is_empty() {
        return Err(AppCommandError::invalid_input(
            "A provider must contain at least one model",
        ));
    }

    let mut seen = IndexSet::new();
    for (index, model) in draft.models.iter().enumerate() {
        let id = model.id.trim();
        if id.is_empty() {
            return Err(AppCommandError::invalid_input(format!(
                "Model #{} is missing an id",
                index + 1
            )));
        }
        if id.len() > 256 {
            return Err(AppCommandError::invalid_input(format!(
                "Model #{} id must be 256 characters or less",
                index + 1
            )));
        }
        if !seen.insert(id.to_string()) {
            return Err(AppCommandError::invalid_input(format!(
                "Duplicate model id \"{id}\""
            )));
        }
        parse_positive(&model.context_window, "Context window")?;
        parse_positive(&model.max_tokens, "Max tokens")?;
        if model
            .base_instructions
            .as_deref()
            .map(str::len)
            .unwrap_or(0)
            > 262_144
        {
            return Err(AppCommandError::invalid_input(
                "Base instructions must be 262144 characters or less",
            ));
        }
    }
    Ok(())
}

fn draft_models_to_file(draft: &[ModelEntryDraft]) -> Result<Vec<ModelEntryFile>, AppCommandError> {
    draft
        .iter()
        .map(|model| {
            let mut file = draft_model_to_file(model.clone())?;
            file.id = model.id.trim().to_string();
            Ok(file)
        })
        .collect()
}

fn set_developer_role_compat(provider: &mut ProviderFile, value: Option<bool>) {
    let Some(value) = value else {
        return;
    };
    let mut compat = match provider.compat.take() {
        Some(Value::Object(map)) => map,
        Some(_) => Map::new(),
        None => Map::new(),
    };
    compat.insert("supportsDeveloperRole".to_string(), Value::Bool(value));
    provider.compat = Some(Value::Object(compat));
}

fn provider_supports_developer_role(provider: &ProviderFile) -> Option<bool> {
    match provider.compat.as_ref()?.get("supportsDeveloperRole") {
        Some(Value::Bool(value)) => Some(*value),
        _ => None,
    }
}

fn provider_to_record(provider_id: &str, provider: &ProviderFile) -> ModelProviderRecord {
    let api = provider
        .api
        .unwrap_or(ModelProviderApiType::OpenAiCompletions);
    let key = provider.api_key.as_deref().unwrap_or_default();
    ModelProviderRecord {
        provider_id: provider_id.to_string(),
        api,
        base_url: provider.base_url.clone().unwrap_or_default(),
        proxy: provider.proxy.clone(),
        enabled: provider.enabled,
        models: provider
            .models
            .clone()
            .into_iter()
            .map(file_model_to_draft)
            .collect(),
        api_key_masked: mask_api_key(key),
        has_api_key: !key.trim().is_empty(),
        compat_supports_developer_role: provider_supports_developer_role(provider),
    }
}

async fn read_catalog(path: PathBuf) -> Result<ModelsFile, AppCommandError> {
    tokio::task::spawn_blocking(move || read_models_file(&path))
        .await
        .map_err(|e| {
            AppCommandError::configuration_invalid(format!("models.json read task failed: {e}"))
        })?
}

async fn write_catalog(path: PathBuf, file: &ModelsFile) -> Result<(), AppCommandError> {
    let file = file.clone();
    tokio::task::spawn_blocking(move || write_models_file(&path, &file))
        .await
        .map_err(|e| {
            AppCommandError::configuration_invalid(format!("models.json write task failed: {e}"))
        })?
}

fn file_lock() -> &'static tokio::sync::Mutex<()> {
    &MODEL_PROVIDER_FILE_LOCK
}

pub async fn list_model_provider_records_core(
    data_dir: &Path,
) -> Result<Vec<ModelProviderRecord>, AppCommandError> {
    let file = read_catalog(models_json_path(data_dir)).await?;
    Ok(file
        .providers
        .iter()
        .map(|(id, provider)| provider_to_record(id, provider))
        .collect())
}

pub async fn list_builtin_model_providers_core(
    data_dir: &Path,
) -> Result<Vec<BuiltinProviderInfo>, AppCommandError> {
    let records = list_model_provider_records_core(data_dir).await?;
    let configured = |builtin_id: &str, base_url: &str| {
        records.iter().any(|record| {
            record.provider_id == builtin_id && record.base_url == base_url && record.has_api_key
        })
    };

    Ok(vec![
        BuiltinProviderInfo {
            id: "anthropic".to_string(),
            api_type: ModelProviderApiType::AnthropicMessages,
            base_url: "https://api.anthropic.com".to_string(),
            configured: configured("anthropic", "https://api.anthropic.com"),
            models: vec![
                text_model("claude-sonnet-4-5", false),
                text_model("claude-opus-4-5", true),
                text_model("claude-haiku-4-5", false),
            ],
        },
        BuiltinProviderInfo {
            id: "openai".to_string(),
            api_type: ModelProviderApiType::OpenAiCompletions,
            base_url: "https://api.openai.com/v1".to_string(),
            configured: configured("openai", "https://api.openai.com/v1"),
            models: vec![
                text_model("gpt-5.1-mini", false),
                text_model("gpt-5.1", false),
                text_model("o4-mini", true),
            ],
        },
        BuiltinProviderInfo {
            id: "gemini".to_string(),
            api_type: ModelProviderApiType::GoogleGenerativeAi,
            base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
            configured: configured("gemini", "https://generativelanguage.googleapis.com/v1beta"),
            models: vec![
                image_model("gemini-2.5-pro", true),
                image_model("gemini-2.5-flash", false),
            ],
        },
        BuiltinProviderInfo {
            id: "deepseek".to_string(),
            api_type: ModelProviderApiType::OpenAiCompletions,
            base_url: "https://api.deepseek.com/v1".to_string(),
            configured: configured("deepseek", "https://api.deepseek.com/v1"),
            models: vec![
                text_model("deepseek-chat", false),
                text_model("deepseek-reasoner", true),
            ],
        },
        BuiltinProviderInfo {
            id: "kimi".to_string(),
            api_type: ModelProviderApiType::OpenAiCompletions,
            base_url: "https://api.moonshot.cn/v1".to_string(),
            configured: configured("kimi", "https://api.moonshot.cn/v1"),
            models: vec![
                text_model("kimi-k2.5", true),
                text_model("kimi-latest", false),
            ],
        },
        BuiltinProviderInfo {
            id: "grok".to_string(),
            api_type: ModelProviderApiType::OpenAiCompletions,
            base_url: "https://api.x.ai/v1".to_string(),
            configured: configured("grok", "https://api.x.ai/v1"),
            models: vec![
                text_model("grok-4.5", true),
                text_model("grok-composer-2.5-fast", false),
            ],
        },
    ])
}

fn text_model(id: &str, reasoning: bool) -> ModelEntryDraft {
    ModelEntryDraft {
        id: id.to_string(),
        reasoning,
        input: crate::models::model_provider_file::WireModelInput::Text,
        context_window: None,
        max_tokens: None,
        base_instructions: None,
    }
}

fn image_model(id: &str, reasoning: bool) -> ModelEntryDraft {
    ModelEntryDraft {
        id: id.to_string(),
        reasoning,
        input: crate::models::model_provider_file::WireModelInput::TextImage,
        context_window: None,
        max_tokens: None,
        base_instructions: None,
    }
}

pub async fn create_model_provider_core(
    data_dir: &Path,
    draft: ModelProviderDraft,
) -> Result<SaveResult, AppCommandError> {
    validate_draft(&draft, true)?;
    let provider_id = validate_provider_id(&draft.provider_id)?;
    let mut provider = ProviderFile {
        enabled: draft.enabled,
        api: Some(draft.api),
        base_url: Some(draft.base_url.trim().to_string()),
        proxy: draft
            .proxy
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string),
        api_key: (!draft.api_key.trim().is_empty()).then(|| draft.api_key.trim().to_string()),
        auth_header: draft.auth_header,
        name: None,
        compat: None,
        headers: None,
        models: draft_models_to_file(&draft.models)?,
    };
    validate_model_ids(&provider.models)?;
    set_developer_role_compat(&mut provider, draft.compat_supports_developer_role);

    let path = models_json_path(data_dir);
    let _guard = file_lock().lock().await;
    let mut file = read_catalog(path.clone()).await?;
    if file.providers.contains_key(&provider_id) {
        return Err(AppCommandError::invalid_input(format!(
            "A provider with the id \"{provider_id}\" already exists"
        )));
    }
    file.version = 1;
    file.providers.insert(provider_id.clone(), provider.clone());
    write_catalog(path, &file).await?;

    Ok(SaveResult {
        record: provider_to_record(&provider_id, &provider),
        affected_running_sessions: 0,
    })
}

pub async fn update_model_provider_core(
    data_dir: &Path,
    draft: ModelProviderDraft,
) -> Result<SaveResult, AppCommandError> {
    validate_draft(&draft, false)?;
    let _provider_id = validate_provider_id(&draft.provider_id)?;
    let original_id = draft.original_id.trim().to_string();
    let path = models_json_path(data_dir);
    let _guard = file_lock().lock().await;
    let mut file = read_catalog(path.clone()).await?;
    let Some(existing) = file.providers.get_mut(&original_id) else {
        return Err(AppCommandError::not_found(format!(
            "Provider \"{original_id}\" no longer exists"
        )));
    };

    existing.enabled = draft.enabled;
    existing.api = Some(draft.api);
    existing.base_url = Some(draft.base_url.trim().to_string());
    existing.proxy = draft
        .proxy
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    if draft.clear_api_key.unwrap_or(false) {
        existing.api_key = None;
    } else if !draft.api_key.trim().is_empty() {
        existing.api_key = Some(draft.api_key.trim().to_string());
    }
    existing.auth_header = draft.auth_header;
    existing.models = draft_models_to_file(&draft.models)?;
    validate_model_ids(&existing.models)?;
    set_developer_role_compat(existing, draft.compat_supports_developer_role);
    let record = provider_to_record(original_id.as_str(), existing);

    file.version = 1;
    write_catalog(path, &file).await?;

    Ok(SaveResult {
        record,
        affected_running_sessions: 0,
    })
}

pub async fn delete_model_provider_core(
    data_dir: &Path,
    provider_id: String,
) -> Result<(), AppCommandError> {
    let provider_id = provider_id.trim().to_string();
    let path = models_json_path(data_dir);
    let _guard = file_lock().lock().await;
    let mut file = read_catalog(path.clone()).await?;
    if file.providers.shift_remove(&provider_id).is_none() {
        return Err(AppCommandError::not_found(format!(
            "Provider \"{provider_id}\" does not exist"
        )));
    }
    write_catalog(path, &file).await
}

pub async fn set_model_provider_enabled_core(
    data_dir: &Path,
    provider_id: String,
    enabled: bool,
) -> Result<(), AppCommandError> {
    let provider_id = provider_id.trim().to_string();
    let path = models_json_path(data_dir);
    let _guard = file_lock().lock().await;
    let mut file = read_catalog(path.clone()).await?;
    let Some(provider) = file.providers.get_mut(&provider_id) else {
        return Err(AppCommandError::not_found(format!(
            "Provider \"{provider_id}\" does not exist"
        )));
    };
    provider.enabled = enabled;
    write_catalog(path, &file).await
}

pub async fn reorder_model_providers_core(
    data_dir: &Path,
    provider_ids: Vec<String>,
) -> Result<(), AppCommandError> {
    let path = models_json_path(data_dir);
    let _guard = file_lock().lock().await;
    let mut file = read_catalog(path.clone()).await?;
    let requested: IndexSet<String> = provider_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .collect();
    let mut reordered = IndexMap::new();
    for id in requested {
        if let Some(provider) = file.providers.shift_remove(&id) {
            reordered.insert(id, provider);
        }
    }
    for (id, provider) in file.providers.drain(..) {
        reordered.insert(id, provider);
    }
    file.providers = reordered;
    write_catalog(path, &file).await
}

pub async fn clone_builtin_model_provider_core(
    data_dir: &Path,
    builtin_id: String,
) -> Result<ModelProviderDraft, AppCommandError> {
    let builtins = list_builtin_model_providers_core(data_dir).await?;
    let builtin = builtins
        .iter()
        .find(|provider| provider.id == builtin_id.trim())
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Built-in provider \"{builtin_id}\" does not exist"))
        })?;
    let records = list_model_provider_records_core(data_dir).await?;
    let taken: IndexSet<String> = records.iter().map(|r| r.provider_id.clone()).collect();
    let mut suffix = 2;
    let mut provider_id = format!("{}-2", builtin.id);
    while taken.contains(&provider_id) {
        suffix += 1;
        provider_id = format!("{}-{suffix}", builtin.id);
    }

    Ok(ModelProviderDraft {
        provider_id,
        original_id: String::new(),
        api: builtin.api_type,
        base_url: builtin.base_url.clone(),
        proxy: None,
        api_key: String::new(),
        auth_header: true,
        compat_supports_developer_role: None,
        enabled: true,
        models: builtin.models.clone(),
        clear_api_key: None,
    })
}

pub async fn probe_model_provider_models_core(
    params: ProbeParams,
) -> Result<ProbeOutcome, AppCommandError> {
    Ok(crate::commands::model_provider_probe::probe_models(
        &params.base_url,
        params.api,
        params.api_key.as_deref(),
        params.auth_header.unwrap_or(true),
    )
    .await)
}

pub async fn test_model_provider_model_core(
    data_dir: &Path,
    provider_id: String,
    model_id: String,
    api_key: Option<String>,
) -> Result<TestOutcome, AppCommandError> {
    let (provider, _model) =
        resolve_model_selection_core(data_dir, &provider_id, &model_id).await?;
    let api = provider
        .api
        .unwrap_or(ModelProviderApiType::OpenAiCompletions);
    let base_url = provider.base_url.unwrap_or_default();
    let key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(provider.api_key.as_deref());
    Ok(crate::commands::model_provider_probe::test_model(
        &base_url,
        api,
        key,
        &model_id,
        provider.auth_header,
    )
    .await)
}

pub async fn resolve_model_selection_core(
    data_dir: &Path,
    provider_id: &str,
    model_id: &str,
) -> Result<(ProviderFile, ModelEntryFile), AppCommandError> {
    let file = read_catalog(models_json_path(data_dir)).await?;
    let provider = file.providers.get(provider_id).ok_or_else(|| {
        AppCommandError::not_found(format!("Provider \"{provider_id}\" does not exist"))
    })?;
    if !provider.enabled {
        return Err(AppCommandError::configuration_missing(format!(
            "Provider \"{provider_id}\" is disabled"
        )));
    }
    let model = provider
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| {
            AppCommandError::not_found(format!(
                "Model \"{model_id}\" does not exist in provider \"{provider_id}\""
            ))
        })?;
    Ok((provider.clone(), model.clone()))
}

fn emit_changed(emitter: &EventEmitter) {
    emit_event(
        emitter,
        MODEL_PROVIDERS_UPDATED_EVENT,
        json!({ "reason": "changed" }),
    );
}

/// Web handlers use a sibling module; expose the same emit payload without
/// making the event-name constant part of every handler surface.
pub fn emit_event_for_web(emitter: &EventEmitter) {
    emit_changed(emitter);
}

#[cfg(feature = "tauri-runtime")]
mod tauri_commands {
    use super::*;
    use tauri::Manager;

    fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppCommandError> {
        Ok(app
            .path()
            .app_data_dir()
            .map(|path| crate::paths::resolve_effective_data_dir(&path))
            .unwrap_or_else(|_| PathBuf::from(".")))
    }

    fn tauri_emitter(app: tauri::AppHandle) -> EventEmitter {
        EventEmitter::Tauri(app)
    }

    #[tauri::command]
    pub async fn model_provider_list(
        app: tauri::AppHandle,
    ) -> Result<Vec<ModelProviderRecord>, AppCommandError> {
        list_model_provider_records_core(&data_dir(&app)?).await
    }

    #[tauri::command]
    pub async fn model_provider_builtin_list(
        app: tauri::AppHandle,
    ) -> Result<Vec<BuiltinProviderInfo>, AppCommandError> {
        list_builtin_model_providers_core(&data_dir(&app)?).await
    }

    #[tauri::command]
    pub async fn model_provider_create(
        app: tauri::AppHandle,
        draft: ModelProviderDraft,
    ) -> Result<SaveResult, AppCommandError> {
        let result = create_model_provider_core(&data_dir(&app)?, draft).await?;
        emit_changed(&tauri_emitter(app));
        Ok(result)
    }

    #[tauri::command]
    pub async fn model_provider_update(
        app: tauri::AppHandle,
        draft: ModelProviderDraft,
    ) -> Result<SaveResult, AppCommandError> {
        let result = update_model_provider_core(&data_dir(&app)?, draft).await?;
        emit_changed(&tauri_emitter(app));
        Ok(result)
    }

    #[tauri::command]
    pub async fn model_provider_delete(
        app: tauri::AppHandle,
        provider_id: String,
    ) -> Result<(), AppCommandError> {
        delete_model_provider_core(&data_dir(&app)?, provider_id).await?;
        emit_changed(&tauri_emitter(app));
        Ok(())
    }

    #[tauri::command]
    pub async fn model_provider_set_enabled(
        app: tauri::AppHandle,
        provider_id: String,
        enabled: bool,
    ) -> Result<(), AppCommandError> {
        set_model_provider_enabled_core(&data_dir(&app)?, provider_id, enabled).await?;
        emit_changed(&tauri_emitter(app));
        Ok(())
    }

    #[tauri::command]
    pub async fn model_provider_reorder(
        app: tauri::AppHandle,
        provider_ids: Vec<String>,
    ) -> Result<(), AppCommandError> {
        reorder_model_providers_core(&data_dir(&app)?, provider_ids).await?;
        emit_changed(&tauri_emitter(app));
        Ok(())
    }

    #[tauri::command]
    pub async fn model_provider_clone_builtin(
        app: tauri::AppHandle,
        builtin_id: String,
    ) -> Result<ModelProviderDraft, AppCommandError> {
        clone_builtin_model_provider_core(&data_dir(&app)?, builtin_id).await
    }

    #[tauri::command]
    pub async fn model_provider_probe(
        params: ProbeParams,
    ) -> Result<ProbeOutcome, AppCommandError> {
        probe_model_provider_models_core(params).await
    }

    #[tauri::command]
    pub async fn model_provider_test(
        app: tauri::AppHandle,
        provider_id: String,
        model_id: String,
        api_key: Option<String>,
    ) -> Result<TestOutcome, AppCommandError> {
        test_model_provider_model_core(&data_dir(&app)?, provider_id, model_id, api_key).await
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_commands::{
    __cmd__model_provider_builtin_list, __cmd__model_provider_clone_builtin,
    __cmd__model_provider_create, __cmd__model_provider_delete, __cmd__model_provider_list,
    __cmd__model_provider_probe, __cmd__model_provider_reorder, __cmd__model_provider_set_enabled,
    __cmd__model_provider_test, __cmd__model_provider_update, model_provider_builtin_list,
    model_provider_clone_builtin, model_provider_create, model_provider_delete,
    model_provider_list, model_provider_probe, model_provider_reorder, model_provider_set_enabled,
    model_provider_test, model_provider_update,
    __tauri_command_name_model_provider_builtin_list, __tauri_command_name_model_provider_clone_builtin,
    __tauri_command_name_model_provider_create, __tauri_command_name_model_provider_delete,
    __tauri_command_name_model_provider_list, __tauri_command_name_model_provider_probe,
    __tauri_command_name_model_provider_reorder, __tauri_command_name_model_provider_set_enabled,
    __tauri_command_name_model_provider_test, __tauri_command_name_model_provider_update,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::model_provider_file::WireModelInput;

    fn draft(id: &str) -> ModelProviderDraft {
        ModelProviderDraft {
            provider_id: id.to_string(),
            original_id: String::new(),
            api: ModelProviderApiType::OpenAiCompletions,
            base_url: "https://example.com/v1".to_string(),
            proxy: None,
            api_key: "test-key".to_string(),
            auth_header: true,
            compat_supports_developer_role: None,
            enabled: true,
            models: vec![ModelEntryDraft {
                id: "model-a".to_string(),
                reasoning: true,
                input: WireModelInput::TextImage,
                context_window: Some("128000".to_string()),
                max_tokens: None,
                base_instructions: None,
            }],
            clear_api_key: None,
        }
    }

    #[tokio::test]
    async fn create_update_and_delete_are_atomic_and_ordered() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();

        let created = create_model_provider_core(data_dir, draft("provider-a"))
            .await
            .unwrap();
        assert!(created.record.has_api_key);
        assert_eq!(created.record.models[0].input, WireModelInput::TextImage);

        let mut second = draft("provider-b");
        second.models[0].id = "model-b".to_string();
        create_model_provider_core(data_dir, second).await.unwrap();

        set_model_provider_enabled_core(data_dir, "provider-a".into(), false)
            .await
            .unwrap();
        reorder_model_providers_core(data_dir, vec!["provider-b".into(), "provider-a".into()])
            .await
            .unwrap();
        let records = list_model_provider_records_core(data_dir).await.unwrap();
        assert_eq!(
            records
                .iter()
                .map(|r| r.provider_id.as_str())
                .collect::<Vec<_>>(),
            vec!["provider-b", "provider-a"]
        );
        assert!(!records[1].enabled);

        let raw = std::fs::read_to_string(data_dir.join("models.json")).unwrap();
        assert!(raw.contains("\"providers\""));
        assert!(!raw.contains("\"api_key\""));

        delete_model_provider_core(data_dir, "provider-a".into())
            .await
            .unwrap();
        let records = list_model_provider_records_core(data_dir).await.unwrap();
        assert_eq!(records.len(), 1);
    }

    #[tokio::test]
    async fn provider_renames_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        create_model_provider_core(dir.path(), draft("old"))
            .await
            .unwrap();
        let mut renamed = draft("new");
        renamed.original_id = "old".to_string();
        assert!(update_model_provider_core(dir.path(), renamed)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn blank_key_update_keeps_credential_and_clear_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        create_model_provider_core(dir.path(), draft("provider"))
            .await
            .unwrap();

        let mut keep = draft("provider");
        keep.original_id = "provider".to_string();
        keep.api_key = String::new();
        let result = update_model_provider_core(dir.path(), keep).await.unwrap();
        assert!(result.record.has_api_key);

        let mut clear = draft("provider");
        clear.original_id = "provider".to_string();
        clear.api_key = String::new();
        clear.clear_api_key = Some(true);
        let result = update_model_provider_core(dir.path(), clear).await.unwrap();
        assert!(!result.record.has_api_key);
    }

    #[tokio::test]
    async fn developer_role_compat_is_returned_for_editing() {
        let dir = tempfile::tempdir().unwrap();
        let mut created = draft("provider");
        created.compat_supports_developer_role = Some(false);
        create_model_provider_core(dir.path(), created)
            .await
            .unwrap();

        let record = list_model_provider_records_core(dir.path())
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(record.compat_supports_developer_role, Some(false));
    }

    #[test]
    fn capability_table_matches_source_card_agents() {
        assert!(model_provider_api_types(&AgentType::OpenCode).len() == 4);
        assert!(model_provider_api_types(&AgentType::Cursor).is_empty());
    }

    /// Custom agents carry no static capability: whether codeg may project a
    /// provider selection into one is per-definition
    /// ([`model_provider_api_types_for_agent`]).
    #[test]
    fn custom_agents_have_no_static_capability() {
        assert!(model_provider_api_types(&AgentType::Custom("qwen-code")).is_empty());
    }

    /// The DB-aware variant is what the resolver and the conversation save
    /// path consult: a verified standard-convention agent gets every
    /// projectable family, an unverified one gets none (so the settings card
    /// is not offered and the selection is never applied).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn per_agent_capability_gates_custom_agents_on_their_declaration() {
        use crate::acp::custom_registry::{
            CustomAgentDef, CustomAgentSpec, CustomDistributionKind, ModelEnvDeclaration, NpxSpec,
        };
        // The two `hydrate_registry` calls below wholesale-replace the
        // process-global custom-agent registry; hold the test guard so
        // concurrent registry-sensitive tests never see it clobbered
        // mid-flight.
        let _registry = crate::acp::custom_registry::hydrate_test_guard();

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let def = |id: &str, model_env: Option<ModelEnvDeclaration>| CustomAgentDef {
            registry_id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            version: "1.0.0".into(),
            distribution_kind: CustomDistributionKind::Npx,
            spec: CustomAgentSpec {
                npx: Some(NpxSpec {
                    package: "some-agent@1.0.0".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            source: Default::default(),
            version_probe: None,
            supports_mcp: true,
            model_env,
        };
        for (id, model_env) in [("qwen-code", None), ("kilo", None), ("glm-acp-agent", None)] {
            crate::db::service::custom_agent_service::upsert(&db.conn, &def(id, model_env))
                .await
                .unwrap();
        }
        // The capability reads the hydrated registry cache, same as the launch
        // path — a save must refresh it before the next list/connect.
        crate::db::service::custom_agent_service::hydrate_registry(&db.conn)
            .await
            .unwrap();

        assert_eq!(
            model_provider_api_types_for_agent(&AgentType::Custom("qwen-code")),
            vec![
                ModelProviderApiType::OpenAiCompletions,
                ModelProviderApiType::OpenAiResponses,
                ModelProviderApiType::AnthropicMessages,
            ],
            "verified contract: Qwen speaks all three OpenAI-compatible/Anthropic families"
        );
        assert_eq!(
            model_provider_api_types_for_agent(&AgentType::Custom("glm-acp-agent")),
            vec![ModelProviderApiType::OpenAiCompletions],
            "verified contract: GLM Agent is Chat Completions only"
        );
        // A user declaration widens a known agent back to permissive: we know
        // the names it reads, but the wire format is the user's statement.
        crate::db::service::custom_agent_service::upsert(
            &db.conn,
            &def(
                "qwen-code",
                Some(ModelEnvDeclaration {
                    base_url: Some("MY_BASE_URL".into()),
                    api_key: Some("MY_API_KEY".into()),
                    model: Some("MY_MODEL".into()),
                }),
            ),
        )
        .await
        .unwrap();
        crate::db::service::custom_agent_service::hydrate_registry(&db.conn)
            .await
            .unwrap();
        assert_eq!(
            model_provider_api_types_for_agent(&AgentType::Custom("qwen-code"))
                .len(),
            3,
            "declared env names are permissive"
        );
        assert!(
            model_provider_api_types_for_agent(&AgentType::Custom("kilo"))
                .is_empty(),
            "config-file-only agents get no option"
        );
        assert!(
            model_provider_api_types_for_agent(&AgentType::Custom("never-registered"))
                .is_empty(),
            "unknown ids get no option"
        );
        assert_eq!(
            model_provider_api_types_for_agent(&AgentType::Codex),
            vec![ModelProviderApiType::OpenAiResponses],
            "built-ins keep their static table"
        );
    }

    #[test]
    fn codex_only_accepts_responses_api() {
        assert_eq!(
            model_provider_api_types(&AgentType::Codex),
            vec![ModelProviderApiType::OpenAiResponses]
        );
    }

    #[tokio::test]
    async fn clone_builtin_suffixes_and_dedupes() {
        let dir = tempfile::tempdir().unwrap();
        let cloned = clone_builtin_model_provider_core(dir.path(), "anthropic".to_string())
            .await
            .unwrap();
        assert_eq!(cloned.provider_id, "anthropic-2");
        assert_eq!(cloned.api, ModelProviderApiType::AnthropicMessages);
        assert_eq!(cloned.base_url, "https://api.anthropic.com");
        assert!(!cloned.models.is_empty());
        assert!(cloned.api_key.is_empty());

        // Persisting it and cloning again dedupes to anthropic-3.
        create_model_provider_core(dir.path(), cloned)
            .await
            .unwrap();
        let next = clone_builtin_model_provider_core(dir.path(), "anthropic".to_string())
            .await
            .unwrap();
        assert_eq!(next.provider_id, "anthropic-3");
    }

    #[tokio::test]
    async fn clone_builtin_unknown_id_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            clone_builtin_model_provider_core(dir.path(), "nope".to_string())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn resolve_model_selection_errors_on_corrupt_catalog() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("models.json"), "{not json").unwrap();
        assert!(
            resolve_model_selection_core(dir.path(), "provider", "model")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn concurrent_writes_are_serialized_and_never_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let mut handles = Vec::new();
        for i in 0..20 {
            let path = dir.path().to_path_buf();
            let id = format!("p{i}");
            handles.push(tokio::spawn(async move {
                let draft = draft(&id);
                let _ = create_model_provider_core(&path, draft.clone()).await;
                let mut updated = draft;
                let url = format!("https://{id}.example.com/v1");
                updated.original_id = id;
                updated.base_url = url;
                let _ = update_model_provider_core(&path, updated).await;
            }));
        }
        for handle in handles {
            handle.await.expect("task joined");
        }
        // Every write landed and the file still parses: the in-process lock +
        // atomic rename serialize the create/update pairs.
        let file = read_models_file(&dir.path().join("models.json")).expect("parse");
        assert_eq!(file.providers.len(), 20);
    }
}
