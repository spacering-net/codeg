//! File-backed model provider types.
//!
//! The `models.json` file is intentionally close to pios' shape: providers are
//! an ordered map and models use pios' `input: ["text", "image"]` metadata.
//! The API-facing records below use codeg's compact `"text-image"` value so the
//! existing settings form keeps a single input selector.

use std::collections::BTreeMap;

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_error::AppCommandError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelProviderApiType {
    // Serde's kebab-case would render these as "open-ai-completions" /
    // "open-ai-responses", but the wire value everywhere else (frontend,
    // pios models.json, `as_str`) is "openai-completions" / "openai-responses".
    // Pin the exact spelling so a copied pios file round-trips.
    #[serde(rename = "openai-completions")]
    OpenAiCompletions,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
    #[serde(rename = "google-generative-ai")]
    GoogleGenerativeAi,
}

impl ModelProviderApiType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCompletions => "openai-completions",
            Self::OpenAiResponses => "openai-responses",
            Self::AnthropicMessages => "anthropic-messages",
            Self::GoogleGenerativeAi => "google-generative-ai",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelInputKind {
    Text,
    Image,
}

impl ModelInputKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
        }
    }
}

/// One model as it is persisted in `models.json`. `input` is intentionally an
/// array to stay compatible with files created by pios.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntryFile {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub input: Vec<ModelInputKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<Value>,
}

/// A provider as it is persisted in `models.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFile {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub api: Option<ModelProviderApiType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default)]
    pub auth_header: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<Value>,
    /// These can carry credentials. They are preserved server-side and never
    /// projected into an API response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub models: Vec<ModelEntryFile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub providers: IndexMap<String, ProviderFile>,
}

impl ModelsFile {
    pub fn new() -> Self {
        Self {
            version: 1,
            providers: IndexMap::new(),
        }
    }
}

/// Model metadata on the command wire. Numeric fields remain strings because
/// the settings editor edits them as text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntryDraft {
    pub id: String,
    pub reasoning: bool,
    pub input: WireModelInput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WireModelInput {
    Text,
    TextImage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderRecord {
    pub provider_id: String,
    pub api: ModelProviderApiType,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    pub enabled: bool,
    pub models: Vec<ModelEntryDraft>,
    pub api_key_masked: String,
    pub has_api_key: bool,
    pub compat_supports_developer_role: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderDraft {
    pub provider_id: String,
    #[serde(default)]
    pub original_id: String,
    pub api: ModelProviderApiType,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub auth_header: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat_supports_developer_role: Option<bool>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ModelEntryDraft>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_api_key: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinProviderInfo {
    pub id: String,
    pub api_type: ModelProviderApiType,
    pub base_url: String,
    pub configured: bool,
    pub models: Vec<ModelEntryDraft>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub record: ModelProviderRecord,
    pub affected_running_sessions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelEntryDraft>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOutcome {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_true() -> bool {
    true
}

pub fn mask_api_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let len = chars.len();
    if len == 0 {
        return String::new();
    }
    if len <= 8 {
        return "\u{2022}".repeat(len);
    }
    let prefix = chars[..4].iter().collect::<String>();
    let suffix = chars[len - 4..].iter().collect::<String>();
    format!("{prefix}\u{2022}\u{2022}\u{2022}{suffix}")
}

pub fn file_model_to_draft(model: ModelEntryFile) -> ModelEntryDraft {
    let has_text = model.input.contains(&ModelInputKind::Text);
    let has_image = model.input.contains(&ModelInputKind::Image);
    let input = if has_image || (!has_text && !has_image) {
        WireModelInput::TextImage
    } else {
        WireModelInput::Text
    };

    ModelEntryDraft {
        id: model.id,
        reasoning: model.reasoning,
        input,
        context_window: model.context_window.map(|v| v.to_string()),
        max_tokens: model.max_tokens.map(|v| v.to_string()),
        base_instructions: model.base_instructions,
    }
}

pub fn draft_model_to_file(model: ModelEntryDraft) -> Result<ModelEntryFile, AppCommandError> {
    let input = match model.input {
        WireModelInput::Text => vec![ModelInputKind::Text],
        WireModelInput::TextImage => vec![ModelInputKind::Text, ModelInputKind::Image],
    };

    Ok(ModelEntryFile {
        id: model.id,
        name: None,
        reasoning: model.reasoning,
        input,
        context_window: parse_positive(&model.context_window, "Context window")?,
        max_tokens: parse_positive(&model.max_tokens, "Max tokens")?,
        base_instructions: model.base_instructions,
        compat: None,
    })
}

pub(crate) fn parse_positive(
    raw: &Option<String>,
    label: &str,
) -> Result<Option<i64>, AppCommandError> {
    let Some(raw) = raw.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let value = raw
        .parse::<i64>()
        .map_err(|_| AppCommandError::invalid_input(format!("{label} must be a whole number")))?;
    if value <= 0 {
        return Err(AppCommandError::invalid_input(format!(
            "{label} must be greater than zero"
        )));
    }
    Ok(Some(value))
}

/// Remove JSON comments without interpreting the contents of string literals.
/// URLs legitimately contain `//`, so naive line-stripping is not safe.
pub(crate) fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }

        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                chars.next();
                while let Some(next) = chars.peek() {
                    if *next == '\n' {
                        break;
                    }
                    chars.next();
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                loop {
                    match chars.next() {
                        Some('*') if chars.peek() == Some(&'/') => {
                            chars.next();
                            break;
                        }
                        Some(_) => {}
                        None => break,
                    }
                }
            }
            _ => out.push(c),
        }
    }

    out
}

pub fn read_models_file(path: &std::path::Path) -> Result<ModelsFile, AppCommandError> {
    if !path.exists() {
        return Ok(ModelsFile::new());
    }
    let raw = std::fs::read_to_string(path).map_err(AppCommandError::io)?;
    let stripped = strip_json_comments(&raw);
    let parsed: ModelsFile = serde_json::from_str(&stripped)
        .map_err(|e| AppCommandError::configuration_invalid(format!("Invalid models.json: {e}")))?;
    if parsed.version > 1 {
        return Err(AppCommandError::configuration_invalid(format!(
            "Unsupported models.json version: {}",
            parsed.version
        )));
    }
    Ok(parsed)
}

pub fn write_models_file(path: &std::path::Path, file: &ModelsFile) -> Result<(), AppCommandError> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(AppCommandError::io)?;
    }
    let mut bytes = serde_json::to_vec_pretty(file).map_err(|e| {
        AppCommandError::configuration_invalid(format!("Serialize models.json failed: {e}"))
    })?;
    bytes.push(b'\n');

    let temp_path =
        tempfile::NamedTempFile::new_in(path.parent().unwrap_or_else(|| std::path::Path::new(".")))
            .map_err(AppCommandError::io)?;
    {
        let mut handle = temp_path.as_file();
        handle.write_all(&bytes).map_err(AppCommandError::io)?;
        handle.sync_all().map_err(AppCommandError::io)?;
    }
    temp_path
        .persist(path)
        .map_err(|e| AppCommandError::io(e.error))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, permissions).map_err(AppCommandError::io)?;
    }
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

pub fn validate_model_ids(models: &[ModelEntryFile]) -> Result<(), AppCommandError> {
    let mut seen = IndexSet::new();
    for (index, model) in models.iter().enumerate() {
        if model.id.trim().is_empty() {
            return Err(AppCommandError::invalid_input(format!(
                "Model #{} is missing an id",
                index + 1
            )));
        }
        if model.id.len() > 256 {
            return Err(AppCommandError::invalid_input(format!(
                "Model #{} id must be 256 characters or less",
                index + 1
            )));
        }
        if !seen.insert(model.id.clone()) {
            return Err(AppCommandError::invalid_input(format!(
                "Duplicate model id \"{}\"",
                model.id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_are_stripped_outside_strings() {
        let raw = r#"{
            // provider list
            "providers": {
                "a": {"baseUrl": "https://example.com//api"}
            }
        }"#;
        let parsed: ModelsFile =
            serde_json::from_str(&strip_json_comments(raw)).expect("parse JSONC");
        assert_eq!(
            parsed.providers["a"].base_url.as_deref(),
            Some("https://example.com//api")
        );
    }

    #[test]
    fn invalid_json_is_not_silently_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.json");
        std::fs::write(&path, "{not json").unwrap();
        assert!(read_models_file(&path).is_err());
    }

    #[test]
    fn api_wire_values_round_trip_through_serde() {
        // The frontend and pios use "openai-completions" (no hyphen after
        // "open"); serde's kebab-case of `OpenAiCompletions` would otherwise
        // produce "open-ai-completions" and reject the very files we read.
        let parsed: ModelProviderApiType =
            serde_json::from_str("\"openai-completions\"").expect("openai-completions");
        assert_eq!(parsed, ModelProviderApiType::OpenAiCompletions);
        let parsed: ModelProviderApiType =
            serde_json::from_str("\"openai-responses\"").expect("openai-responses");
        assert_eq!(parsed, ModelProviderApiType::OpenAiResponses);
        assert_eq!(
            serde_json::to_string(&ModelProviderApiType::OpenAiCompletions).unwrap(),
            "\"openai-completions\""
        );
    }

    #[test]
    fn pios_style_file_parses_and_round_trips() {
        // The exact shape pi writes today: camelCase, array `input`, no
        // `version`, kebab api names. Codeg must read it as-is.
        let raw = r#"{
          "providers": {
            "ark": {
              "api": "openai-completions",
              "baseUrl": "https://ark.example.com/v1",
              "apiKey": "sk-test",
              "authHeader": true,
              "compat": { "supportsDeveloperRole": false },
              "models": [
                { "id": "glm-5.3", "reasoning": true, "input": ["text", "image"] },
                { "id": "MiniMax-M2.7", "reasoning": true }
              ]
            }
          }
        }"#;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.json");
        std::fs::write(&path, raw).unwrap();
        let parsed = read_models_file(&path).expect("read pi-style file");
        let provider = &parsed.providers["ark"];
        assert_eq!(provider.api, Some(ModelProviderApiType::OpenAiCompletions));
        assert_eq!(provider.models.len(), 2);
        // Omitted `input` is preserved as an empty list (frontend maps it to
        // text+image), and the api spelling survives a write.
        write_models_file(&path, &parsed).unwrap();
        let reparsed = read_models_file(&path).expect("re-read after write");
        assert_eq!(
            reparsed.providers["ark"].api,
            Some(ModelProviderApiType::OpenAiCompletions)
        );
        assert_eq!(reparsed.providers["ark"].models[1].input, vec![]);
    }

    #[test]
    fn api_keys_are_masked_without_byte_slice_panics() {
        assert_eq!(
            mask_api_key("sk-密钥123456"),
            "sk-密\u{2022}\u{2022}\u{2022}3456"
        );
    }
}
