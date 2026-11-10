use std::path::Path;

use serde::Deserialize;

use crate::acp::manager::ConnectionManager;
use crate::acp::provider_models::{self, KeyHeader, ModelList, ModelsProtocol, ModelsRequest};
use crate::acp::types::ConfigStaleKind;
use crate::app_error::AppCommandError;
use crate::commands::acp;
use crate::db::service::{agent_setting_service, model_provider_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::models::model_provider::ModelProviderInfo;
use crate::web::event_bridge::EventEmitter;

// ---------------------------------------------------------------------------
// Shared core functions (used by both Tauri commands and web handlers)
// ---------------------------------------------------------------------------

fn validate_agent_type(agent_type: &str) -> Result<(), AppCommandError> {
    if agent_type.trim().is_empty() {
        return Err(AppCommandError::invalid_input("Agent type is required"));
    }
    let _: AgentType = serde_json::from_value(serde_json::Value::String(agent_type.to_string()))
        .map_err(|_| AppCommandError::invalid_input(format!("Invalid agent type: {agent_type}")))?;
    Ok(())
}

fn validate_fields(
    name: Option<&str>,
    api_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<(), AppCommandError> {
    if let Some(n) = name {
        if n.len() > 256 {
            return Err(AppCommandError::invalid_input(
                "Name must be 256 characters or less",
            ));
        }
    }
    if let Some(u) = api_url {
        if u.len() > 2048 {
            return Err(AppCommandError::invalid_input(
                "API URL must be 2048 characters or less",
            ));
        }
        if !u.starts_with("http://") && !u.starts_with("https://") {
            return Err(AppCommandError::invalid_input(
                "API URL must start with http:// or https://",
            ));
        }
    }
    if let Some(k) = api_key {
        if k.len() > 4096 {
            return Err(AppCommandError::invalid_input(
                "API Key must be 4096 characters or less",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_model(agent_type: &str, model: Option<&str>) -> Result<(), AppCommandError> {
    let Some(raw) = model.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    // Codex stores a structured multi-model catalog whose entries may carry
    // per-model `base_instructions` overrides (a full system prompt), so allow a
    // much larger payload than the plain-string agents.
    // A Claude provider's model JSON may carry its `/model` picker ids.
    let max_len = match agent_type {
        "codex" => 262_144,
        "claude_code" => 65_536,
        _ => 4096,
    };
    if raw.len() > max_len {
        return Err(AppCommandError::invalid_input(format!(
            "Model must be {max_len} characters or less"
        )));
    }
    // ClaudeCode requires a JSON object; other agents accept a plain string.
    if agent_type == "claude_code" {
        let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
            AppCommandError::invalid_input(format!("Invalid Claude model JSON: {e}"))
        })?;
        if !value.is_object() {
            return Err(AppCommandError::invalid_input(
                "Claude model must be a JSON object",
            ));
        }
        validate_claude_picker_models(&value)?;
    }
    // Codex accepts either the structured config `{"customs":[{slug, base, …}],
    // "excludedOfficials":[…]}`, a legacy `{"models":[…]}` catalog, or a legacy
    // plain slug string. When structured, every custom entry needs a non-empty
    // slug and base (the snapshot clone template).
    if agent_type == "codex" {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
            let entries = value
                .get("customs")
                .or_else(|| value.get("models"))
                .and_then(|m| m.as_array());
            if let Some(models) = entries {
                let non_empty = |m: &serde_json::Value, k: &str| {
                    m.get(k)
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .map(|s| !s.is_empty())
                        .unwrap_or(false)
                };
                for (i, m) in models.iter().enumerate() {
                    if !non_empty(m, "slug") {
                        return Err(AppCommandError::invalid_input(format!(
                            "Codex custom model #{} is missing a slug",
                            i + 1
                        )));
                    }
                    if !non_empty(m, "base") {
                        return Err(AppCommandError::invalid_input(format!(
                            "Codex custom model #{} is missing a base model",
                            i + 1
                        )));
                    }
                }
            }
            if let Some(source) = value.get("catalog") {
                validate_codex_catalog_source(source)?;
            }
        }
    }
    Ok(())
}

/// A Claude model JSON's `pickerModels`, when present: a list of ids
/// (`acp::claude_model_picker`).
fn validate_claude_picker_models(value: &serde_json::Value) -> Result<(), AppCommandError> {
    use crate::acp::claude_model_picker as picker;
    let Some(raw) = value.get(picker::PROVIDER_FIELD) else {
        return Ok(());
    };
    let Some(items) = raw.as_array() else {
        return Err(AppCommandError::invalid_input(
            "pickerModels must be a list of model ids",
        ));
    };
    if !items
        .iter()
        .all(|id| id.as_str().is_some_and(|s| !s.trim().is_empty()))
    {
        return Err(AppCommandError::invalid_input(
            "pickerModels must be a list of model ids",
        ));
    }
    let ids: Vec<String> = items
        .iter()
        .filter_map(|id| id.as_str().map(str::to_string))
        .collect();
    match picker::invalid(&ids) {
        Some(why) => Err(AppCommandError::invalid_input(why)),
        None => Ok(()),
    }
}

/// The `catalog` of a Codex model config: where the list comes from when it
/// is the provider's (`{url?, format?, selected?}`).
fn validate_codex_catalog_source(source: &serde_json::Value) -> Result<(), AppCommandError> {
    let invalid =
        |what: &str| AppCommandError::invalid_input(format!("Codex model list source: {what}"));
    let Some(obj) = source.as_object() else {
        return Err(invalid("must be an object"));
    };
    if let Some(url) = obj.get("url").filter(|v| !v.is_null()) {
        let ok = url
            .as_str()
            .and_then(|u| url::Url::parse(u.trim()).ok())
            .is_some_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some());
        if !ok {
            return Err(invalid("url must be an http(s) URL"));
        }
    }
    if let Some(format) = obj.get("format").filter(|v| !v.is_null()) {
        if !matches!(format.as_str(), Some("native" | "openai_list")) {
            return Err(invalid("format must be \"native\" or \"openai_list\""));
        }
    }
    if let Some(selected) = obj.get("selected").filter(|v| !v.is_null()) {
        let Some(ids) = selected.as_array() else {
            return Err(invalid("selected must be a list of model ids"));
        };
        if ids.len() > 4096 {
            return Err(invalid("selected holds more than 4096 ids"));
        }
        if !ids
            .iter()
            .all(|id| id.as_str().is_some_and(|s| !s.trim().is_empty()))
        {
            return Err(invalid("selected must be a list of model ids"));
        }
    }
    Ok(())
}

pub async fn list_model_providers_core(
    db: &AppDatabase,
) -> Result<Vec<ModelProviderInfo>, AppCommandError> {
    let rows = model_provider_service::list_all(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    Ok(rows.into_iter().map(ModelProviderInfo::from).collect())
}

pub async fn create_model_provider_core(
    db: &AppDatabase,
    name: String,
    api_url: String,
    api_key: String,
    agent_type: String,
    model: Option<String>,
) -> Result<ModelProviderInfo, AppCommandError> {
    validate_fields(Some(&name), Some(&api_url), Some(&api_key))?;
    validate_agent_type(&agent_type)?;
    validate_model(&agent_type, model.as_deref())?;

    let model_row =
        model_provider_service::create(&db.conn, name, api_url, api_key, agent_type, model)
            .await
            .map_err(AppCommandError::from)?;
    Ok(ModelProviderInfo::from(model_row))
}

/// Update a model provider. For the `model` parameter:
/// - `None` (omitted) means "don't change"
/// - `Some("")` means "clear"
/// - `Some(value)` means "set to value"
#[allow(clippy::too_many_arguments)]
pub async fn update_model_provider_core(
    db: &AppDatabase,
    id: i32,
    name: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    agent_type: Option<String>,
    model: Option<String>,
    emitter: &EventEmitter,
) -> Result<ModelProviderInfo, AppCommandError> {
    validate_fields(name.as_deref(), api_url.as_deref(), api_key.as_deref())?;
    if let Some(ref at) = agent_type {
        validate_agent_type(at)?;
    }

    // Fetch old provider to detect changes and to determine effective agent_type for model validation.
    let old_provider = model_provider_service::get_by_id(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("model provider not found: {id}")))?;

    // agent_type is immutable after creation: dependent agents bind to a provider by id
    // and rely on provider.agent_type matching their own. Changing it would silently
    // mis-parse provider.model (e.g. Claude JSON written into Codex's config.toml).
    if let Some(ref new_at) = agent_type {
        if new_at != &old_provider.agent_type {
            return Err(AppCommandError::invalid_input(format!(
                "agent_type is immutable after creation (current: {}, requested: {new_at})",
                old_provider.agent_type
            )));
        }
    }

    let effective_agent_type = old_provider.agent_type.as_str();
    if let Some(ref raw) = model {
        validate_model(effective_agent_type, Some(raw))?;
    }

    // Translate Some("") to Some(None) (clear), Some(value) to Some(Some(value)), None to None.
    let model_patch: Option<Option<String>> = model.as_ref().map(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let model_row = model_provider_service::update(
        &db.conn,
        id,
        name,
        api_url.clone(),
        api_key.clone(),
        None, // agent_type is immutable; rejected above if differs
        model_patch.clone(),
    )
    .await
    .map_err(AppCommandError::from)?;

    // Cascade credential/model changes to all dependent agent settings and config files.
    let url_changed = api_url
        .as_deref()
        .is_some_and(|u| u != old_provider.api_url);
    let key_changed = api_key
        .as_deref()
        .is_some_and(|k| k != old_provider.api_key);
    let model_changed = model_patch
        .as_ref()
        .is_some_and(|new_value| new_value.as_deref() != old_provider.model.as_deref());

    if url_changed || key_changed || model_changed {
        let final_url = api_url.as_deref().unwrap_or(&old_provider.api_url);
        let final_key = api_key.as_deref().unwrap_or(&old_provider.api_key);
        let final_model_owned: Option<String> = match &model_patch {
            Some(inner) => inner.clone(),
            None => old_provider.model.clone(),
        };
        acp::cascade_update_model_provider(
            db,
            id,
            final_url,
            final_key,
            final_model_owned.as_deref(),
            emitter,
        )
        .await
        .map_err(|e| AppCommandError::invalid_input(e.to_string()))?;
    }

    Ok(ModelProviderInfo::from(model_row))
}

/// Result of `update_model_provider`: the updated provider row plus how many
/// running sessions the cascade left on stale (launch-time) config — for the
/// settings-side "N sessions need restart" toast.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateModelProviderResult {
    pub provider: ModelProviderInfo,
    pub affected_running_sessions: usize,
}

/// `update_model_provider_core` followed by a staleness refresh for every agent
/// bound to this provider. Shared by the Tauri command and the web handler so
/// both surface how many running sessions need a restart to pick up the new
/// credentials/model. If the save didn't actually change url/key/model, the
/// cascade is skipped, fingerprints are unchanged, and the refresh is a silent
/// no-op returning 0.
#[allow(clippy::too_many_arguments)]
pub async fn update_model_provider_and_refresh(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    id: i32,
    name: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    agent_type: Option<String>,
    model: Option<String>,
    emitter: &EventEmitter,
) -> Result<UpdateModelProviderResult, AppCommandError> {
    let provider =
        update_model_provider_core(db, id, name, api_url, api_key, agent_type, model, emitter)
            .await?;

    // Every agent bound to this provider may now be on stale config (the cascade
    // rewrote their env_json + native config files). Recompute and notify.
    let agent_types: Vec<AgentType> = agent_setting_service::find_by_model_provider_id(&db.conn, id)
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|setting| serde_json::from_str(&setting.agent_type).ok())
        .collect();
    let affected_running_sessions = acp::refresh_config_staleness(
        manager,
        db,
        data_dir,
        &agent_types,
        ConfigStaleKind::ModelProvider,
    )
    .await;

    Ok(UpdateModelProviderResult {
        provider,
        affected_running_sessions,
    })
}

pub async fn delete_model_provider_core(db: &AppDatabase, id: i32) -> Result<(), AppCommandError> {
    // Check if any agent settings reference this provider.
    let dependents = agent_setting_service::find_by_model_provider_id(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;

    if !dependents.is_empty() {
        let agent_names: Vec<String> = dependents
            .iter()
            .filter_map(|row| {
                serde_json::from_str::<AgentType>(&row.agent_type)
                    .ok()
                    .map(|at| at.to_string())
            })
            .collect();
        let names_joined = agent_names.join(", ");
        return Err(AppCommandError::invalid_input(format!(
            "PROVIDER_IN_USE:{names_joined}"
        )));
    }

    model_provider_service::delete(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(())
}

/// Where the key for listing a provider's models comes from. Its `Debug`
/// never shows a key.
#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ModelsKeySource {
    /// Typed into the page.
    Inline { api_key: String },
    /// A saved provider; a key typed into its dialog wins over the stored one.
    Provider {
        provider_id: i32,
        #[serde(default)]
        api_key: Option<String>,
    },
    /// The key pi keeps for one of its providers (its `auth.json`), which the
    /// Pi panel never shows.
    PiAuth { provider: String },
    /// The key OpenCode 2 keeps for one of its integrations (its credential
    /// store), read through OpenCode itself; the OpenCode panel never shows it.
    OpencodeCredential { integration_id: String },
}

impl std::fmt::Debug for ModelsKeySource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelsKeySource::Inline { .. } => f.write_str("Inline { .. }"),
            ModelsKeySource::Provider { provider_id, .. } => f
                .debug_struct("Provider")
                .field("provider_id", provider_id)
                .finish_non_exhaustive(),
            ModelsKeySource::PiAuth { provider } => f
                .debug_struct("PiAuth")
                .field("provider", provider)
                .finish(),
            ModelsKeySource::OpencodeCredential { integration_id } => f
                .debug_struct("OpencodeCredential")
                .field("integration_id", integration_id)
                .finish(),
        }
    }
}

/// A settings page asking for a provider's models.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProviderModelsParams {
    pub protocol: ModelsProtocol,
    pub base_url: String,
    pub key_source: ModelsKeySource,
    /// How the agent sends the key, when not the protocol's usual way.
    #[serde(default)]
    pub key_header: Option<KeyHeader>,
}

/// The i18n namespace the pages localize these errors under.
const MODELS_ERROR_NAMESPACE: &str = "providerModels";

/// The models a provider lists, asked the way the agent itself would ask.
pub async fn list_provider_models_core(
    db: &AppDatabase,
    data_dir: &std::path::Path,
    params: ListProviderModelsParams,
) -> Result<ModelList, AppCommandError> {
    let api_key = match params.key_source {
        ModelsKeySource::Inline { api_key } => api_key,
        ModelsKeySource::Provider {
            provider_id,
            api_key,
        } => match api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
            Some(typed) => typed,
            None => {
                model_provider_service::get_by_id(&db.conn, provider_id)
                    .await
                    .map_err(AppCommandError::from)?
                    .ok_or_else(|| {
                        provider_models::EndpointError::new(
                            "provider_not_found",
                            format!("model provider not found: {provider_id}"),
                        )
                        .to_app_error(MODELS_ERROR_NAMESPACE)
                    })?
                    .api_key
            }
        },
        ModelsKeySource::PiAuth { provider } => {
            acp::pi_stored_api_key(db, &provider)
                .await
                .map_err(|e| AppCommandError::io_error(e.to_string()))?
                .unwrap_or_default()
        }
        ModelsKeySource::OpencodeCredential { integration_id } => {
            let env = acp::build_runtime_env_for_agent(
                db,
                crate::models::agent::AgentType::OpenCode,
                None,
                data_dir,
                true,
            )
            .await
            .map_err(|e| AppCommandError::io_error(e.to_string()))?;
            crate::acp::opencode_credentials::stored_key(&env, data_dir, &integration_id)
                .await
                .map_err(|e| AppCommandError::io_error(e.to_string()))?
                .unwrap_or_default()
        }
    };
    let request = ModelsRequest::new(
        params.protocol,
        &params.base_url,
        &api_key,
        params.key_header,
    )
    .map_err(|e| e.to_app_error(MODELS_ERROR_NAMESPACE))?;
    provider_models::list_models(&request)
        .await
        .map_err(|e| e.to_app_error(MODELS_ERROR_NAMESPACE))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_model_providers(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<ModelProviderInfo>, AppCommandError> {
    list_model_providers_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn create_model_provider(
    db: tauri::State<'_, AppDatabase>,
    name: String,
    api_url: String,
    api_key: String,
    agent_type: String,
    model: Option<String>,
) -> Result<ModelProviderInfo, AppCommandError> {
    create_model_provider_core(&db, name, api_url, api_key, agent_type, model).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_model_provider(
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    id: i32,
    name: Option<String>,
    api_url: Option<String>,
    api_key: Option<String>,
    agent_type: Option<String>,
    model: Option<String>,
    app: tauri::AppHandle,
) -> Result<UpdateModelProviderResult, AppCommandError> {
    use tauri::Manager;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let emitter = EventEmitter::Tauri(app);
    update_model_provider_and_refresh(
        &db,
        &manager,
        &app_data_dir,
        id,
        name,
        api_url,
        api_key,
        agent_type,
        model,
        &emitter,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn delete_model_provider(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), AppCommandError> {
    delete_model_provider_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_provider_models(
    params: ListProviderModelsParams,
    db: tauri::State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<ModelList, AppCommandError> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    list_provider_models_core(&db, &data_dir, params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[test]
    fn a_codex_list_source_must_be_well_formed() {
        let ok = |raw: &str| validate_model("codex", Some(raw)).is_ok();
        assert!(ok(r#"{"customs":[],"catalog":{}}"#));
        assert!(ok(
            r#"{"customs":[],"catalog":{"url":"https://r/v1/models","format":"openai_list","selected":["glm-5.2"]}}"#
        ));
        assert!(ok(r#"{"customs":[],"catalog":{"url":null,"format":null}}"#));
        assert!(!ok(r#"{"customs":[],"catalog":"yes"}"#));
        assert!(!ok(
            r#"{"customs":[],"catalog":{"url":"file:///etc/passwd"}}"#
        ));
        assert!(!ok(r#"{"customs":[],"catalog":{"format":"xml"}}"#));
        assert!(!ok(r#"{"customs":[],"catalog":{"selected":"glm"}}"#));
        assert!(!ok(r#"{"customs":[],"catalog":{"selected":["", "x"]}}"#));
        // Only Codex has a list source; another agent's plain model is fine.
        assert!(validate_model("gemini", Some("catalog")).is_ok());
    }

    /// Regression: an `api_key` containing a multibyte character (e.g. a
    /// full-width char typed under a CJK IME) must not panic the masking in
    /// `ModelProviderInfo::from`. Before the fix, `create` persisted the row
    /// and then panicked, after which every `list_model_providers` call
    /// panicked on that row — breaking the settings list and the agent
    /// management provider dropdown until the row was removed.
    /// A listener answering one request with `body`, handing back the request.
    async fn serve_list(body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(response.as_bytes()).await;
            let _ = sock.shutdown().await;
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (format!("http://{addr}/v1"), handle)
    }

    fn list_params(base_url: &str, key_source: ModelsKeySource) -> ListProviderModelsParams {
        ListProviderModelsParams {
            protocol: ModelsProtocol::Openai,
            base_url: base_url.to_string(),
            key_source,
            key_header: None,
        }
    }

    #[tokio::test]
    async fn a_saved_providers_models_are_listed_with_its_stored_key_unless_one_is_typed() {
        let db = fresh_in_memory_db().await;
        let provider = create_model_provider_core(
            &db,
            "Relay".to_string(),
            "https://relay.example/v1".to_string(),
            "sk-stored".to_string(),
            "claude_code".to_string(),
            None,
        )
        .await
        .unwrap();

        let (base, seen) = serve_list(r#"{"data":[{"id":"glm-5.2"}]}"#).await;
        let source = ModelsKeySource::Provider {
            provider_id: provider.id,
            api_key: None,
        };
        let list = list_provider_models_core(&db, std::path::Path::new("."), list_params(&base, source))
            .await
            .unwrap();
        assert_eq!(list.models[0].id, "glm-5.2");
        assert!(seen.await.unwrap().contains("Bearer sk-stored"));

        let (base, seen) = serve_list(r#"{"data":[]}"#).await;
        let source = ModelsKeySource::Provider {
            provider_id: provider.id,
            api_key: Some(" sk-typed ".to_string()),
        };
        list_provider_models_core(&db, std::path::Path::new("."), list_params(&base, source))
            .await
            .unwrap();
        assert!(seen.await.unwrap().contains("Bearer sk-typed"));

        let source = ModelsKeySource::Provider {
            provider_id: provider.id + 1,
            api_key: None,
        };
        let err = list_provider_models_core(&db, std::path::Path::new("."), list_params(&base, source))
            .await
            .unwrap_err();
        assert_eq!(
            err.i18n_key.as_deref(),
            Some("providerModels.provider_not_found")
        );
    }

    #[test]
    fn a_claude_providers_picker_ids_must_be_a_list_of_ids() {
        let ok = |raw: &str| validate_model("claude_code", Some(raw)).is_ok();
        assert!(ok(
            r#"{"main":"glm-5.2","pickerModels":["glm-5.2","kimi-k3"]}"#
        ));
        assert!(ok(r#"{"main":"glm-5.2"}"#));
        assert!(!ok(r#"{"pickerModels":"glm-5.2"}"#));
        assert!(!ok(r#"{"pickerModels":["glm-5.2",""]}"#));
        assert!(!ok(r#"{"pickerModels":[3]}"#));
        // Room for a long list, far past the plain-string limit.
        let many: Vec<String> = (0..300).map(|i| format!("vendor/model-{i:04}")).collect();
        let raw = serde_json::json!({ "main": "m", "pickerModels": many }).to_string();
        assert!(raw.len() > 4096);
        assert!(ok(&raw));
    }

    #[test]
    fn a_key_source_never_prints_its_key() {
        let typed = ModelsKeySource::Provider {
            provider_id: 3,
            api_key: Some("sk-typed".to_string()),
        };
        let inline = ModelsKeySource::Inline {
            api_key: "sk-inline".to_string(),
        };
        for shown in [format!("{typed:?}"), format!("{inline:?}")] {
            assert!(!shown.contains("sk-"), "{shown}");
        }
    }

    #[test]
    fn a_models_request_reads_the_shape_the_pages_send() {
        let params: ListProviderModelsParams = serde_json::from_value(serde_json::json!({
            "protocol": "anthropic",
            "baseUrl": "https://relay.example",
            "keySource": { "kind": "provider", "providerId": 3 },
            "keyHeader": "bearer"
        }))
        .unwrap();
        assert_eq!(params.protocol, ModelsProtocol::Anthropic);
        assert_eq!(params.key_header, Some(KeyHeader::Bearer));
        assert!(matches!(
            params.key_source,
            ModelsKeySource::Provider { provider_id: 3, api_key: None }
        ));
        let inline: ModelsKeySource =
            serde_json::from_value(serde_json::json!({ "kind": "inline", "apiKey": "sk" }))
                .unwrap();
        assert!(matches!(inline, ModelsKeySource::Inline { api_key } if api_key == "sk"));
    }

    #[tokio::test]
    async fn create_and_list_tolerate_multibyte_api_key() {
        let db = fresh_in_memory_db().await;

        let created = create_model_provider_core(
            &db,
            "Provider".to_string(),
            "https://api.example.com".to_string(),
            "sk-密钥abcd1234".to_string(),
            "codex".to_string(),
            None,
        )
        .await;
        assert!(
            created.is_ok(),
            "create panicked/failed: {:?}",
            created.err()
        );

        let rows = list_model_providers_core(&db)
            .await
            .expect("list must not fail on a multibyte api_key");
        assert_eq!(rows.len(), 1);
        // The raw key round-trips; only the masked view is derived.
        assert_eq!(rows[0].api_key, "sk-密钥abcd1234");
        assert!(!rows[0].api_key_masked.is_empty());
    }

    #[test]
    fn validate_model_codex_accepts_structured_and_legacy() {
        // New structured config with custom slug + base is accepted.
        assert!(validate_model(
            "codex",
            Some(
                r#"{"customs":[{"slug":"gw/opus","base":"gpt-5.6-sol"}],"excludedOfficials":["gpt-5.2"],"default":"gw/opus"}"#
            )
        )
        .is_ok());
        // Legacy `{models}` catalog is still accepted (migration).
        assert!(validate_model(
            "codex",
            Some(r#"{"models":[{"slug":"gw/opus","base":"gpt-5.3-codex"}],"default":"gw/opus"}"#)
        )
        .is_ok());
        // Legacy plain slug is accepted (back-compat).
        assert!(validate_model("codex", Some("gpt-5.5")).is_ok());
        // A custom entry missing its slug / base is rejected.
        assert!(validate_model("codex", Some(r#"{"customs":[{"base":"gpt-5.4"}]}"#)).is_err());
        assert!(validate_model("codex", Some(r#"{"customs":[{"slug":"x"}]}"#)).is_err());
        // A base_instructions-heavy payload over the plain 4096 cap is allowed
        // for codex, but the same length is rejected for a plain-string agent.
        let big = format!(
            r#"{{"models":[{{"slug":"x","base":"gpt-5.4","overrides":{{"base_instructions":"{}"}}}}]}}"#,
            "a".repeat(10_000)
        );
        assert!(validate_model("codex", Some(&big)).is_ok());
        assert!(validate_model("open_code", Some(&"a".repeat(10_000))).is_err());
    }

    /// Regression for the model-provider staleness path: editing a provider must
    /// flag the running sessions of agents bound to it. The mechanism is "the
    /// bound agent's config fingerprint shifts" — `refresh_connection_staleness`
    /// (tested in manager.rs) then flags any session whose spawn fingerprint no
    /// longer matches. This proves the shift actually happens for a credential
    /// change, and that a non-runtime edit (display name) does NOT shift it (so
    /// provider edits don't over-flag).
    ///
    /// DB-only: we mutate the provider row directly via the service rather than
    /// `update_model_provider_core`, so the on-disk config cascade never runs and
    /// the test can't touch a developer's real agent config files. The fingerprint
    /// also reads native config files, but only ever reads them and only between
    /// DB mutations, so that component stays constant across the comparisons.
    #[tokio::test]
    async fn provider_credential_change_shifts_bound_agent_fingerprint() {
        use crate::db::entities::agent_setting;
        use crate::models::agent::AgentType;
        use sea_orm::{ActiveModelTrait, NotSet, Set};

        let db = fresh_in_memory_db().await;
        let data_dir = std::env::temp_dir();

        let provider = create_model_provider_core(
            &db,
            "Prov".to_string(),
            "https://api.example.com".to_string(),
            "sk-old-key".to_string(),
            "codex".to_string(),
            None,
        )
        .await
        .expect("create provider");

        // A Codex agent setting bound to that provider.
        let now = chrono::Utc::now();
        agent_setting::ActiveModel {
            id: NotSet,
            agent_type: Set(serde_json::to_string(&AgentType::Codex).unwrap()),
            registry_id: Set("codex".to_string()),
            enabled: Set(true),
            sort_order: Set(0),
            installed_version: Set(None),
            env_json: Set(Some("{}".to_string())),
            model_provider_id: Set(Some(provider.id)),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&db.conn)
        .await
        .expect("insert codex agent setting");

        let fp_before = acp::compute_session_config_fingerprint(&db, AgentType::Codex, &data_dir)
            .await
            .expect("fingerprint before");

        // Changing the api_key (DB-only) must shift the bound agent's fingerprint:
        // `apply_model_provider_env` injects the provider's key into the env.
        model_provider_service::update(
            &db.conn,
            provider.id,
            None,
            None,
            Some("sk-new-key".to_string()),
            None,
            None,
        )
        .await
        .expect("update provider key");

        let fp_after_key =
            acp::compute_session_config_fingerprint(&db, AgentType::Codex, &data_dir)
                .await
                .expect("fingerprint after key change");
        assert_ne!(
            fp_before, fp_after_key,
            "changing the bound provider's api_key must shift the agent fingerprint"
        );

        // A non-runtime change (display name only) must NOT shift it.
        model_provider_service::update(
            &db.conn,
            provider.id,
            Some("Renamed".to_string()),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("rename provider");

        let fp_after_name =
            acp::compute_session_config_fingerprint(&db, AgentType::Codex, &data_dir)
                .await
                .expect("fingerprint after rename");
        assert_eq!(
            fp_after_key, fp_after_name,
            "renaming the provider must not shift the agent fingerprint"
        );
    }
}
