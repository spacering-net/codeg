//! DeepSeek Harness deployment settings — the advisory model catalog.
//!
//! `deepseek-acp` composes `@deepseek-ai/dsh-llm-deepseek`, whose plugin config
//! doubles as the `llm-deepseek` section of the harness settings document
//! (`$DSH_HOME/settings.yaml`, default `~/.dsh/settings.yaml`). Its `models`
//! key is the catalog the adapter's `listModels` returns verbatim, which the
//! bridge turns into the ACP `model` config option — i.e. the model dropdown
//! codeg's composer shows for a DeepSeek session. Absent, the session inherits
//! the catalog the agent's own composition declares ([`default_models`]).
//!
//! The catalog is *advisory*: a request naming a model outside it still goes
//! out (the harness only reads the entry for context window, output cap and
//! image support). So an edit here changes what can be PICKED, never what the
//! endpoint accepts.
//!
//! Only deepseek-acp 0.9.0 and earlier read this section. 0.10.0 (DSH 0.2)
//! drops the file-backed settings provider (`dsh-settings-file`) that laid
//! `$DSH_HOME/settings.yaml` over the plugin configs: the official route takes
//! the catalog built into the bridge, and the bridge's own document,
//! `$DSH_HOME/deepseek-acp/settings.yaml`, holds only `llm-pi-ai` routes
//! (measured: a two-model `llm-deepseek.models` list replaces the dropdown on
//! 0.9.0 and leaves 0.11.0's built-in pair). The settings page therefore shows
//! the editor only for an install older than 0.10.0
//! (`deepseekReadsHarnessCatalog`); these commands stay for it.
//!
//! The other half of this module is the surface that DOES still move a 0.10.0+
//! model list: the `llm-pi-ai` provider routes in that bridge document
//! ([`DeepSeekProviderRoute`]). `@deepseek-ai/dsh-llm-pi-ai` turns each route
//! into models the session can pick, so the composer's dropdown grows by a
//! group per configured provider — including gateways and vendors the official
//! DeepSeek route does not serve. codeg does not drive the adapter's UNSTABLE
//! `providers/*` ACP plane; it edits the same document that plane writes, which
//! keeps the behaviour identical with one fewer protocol dependency.
//!
//! On a fresh 0.10.0+ install that document does not exist yet, and the bridge
//! imports `llm-pi-ai` from `$DSH_HOME/settings.yaml` (then
//! `settings.yaml.imported`) read-only. The panel shows those imported routes
//! and moves them into the bridge document on the first save — after which the
//! agent stops looking at the legacy files, exactly as it does for its own
//! `providers/*` writes.
//!
//! Two upstream facts shape the surface:
//!
//! * The settings provider is mounted with `watch: false` — one client
//!   connection is one process — so a save reaches sessions started after it,
//!   not the ones already running.
//! * A section the adapter cannot resolve does not fail the agent: it logs and
//!   keeps the last good configuration, which at startup is the composition
//!   entry, i.e. the DEFAULT catalog. A malformed save would therefore look
//!   like "my models silently disappeared", so every entry is validated here
//!   against the adapter's own `resolveModels` rules before anything is
//!   written.
//!
//! Path resolution follows the repo-wide convention (`resolve_dsh_home_dir`):
//! codeg's own process env, not the per-agent `env_json`, which only reaches
//! the spawned child.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::acp::error::AcpError;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

use super::acp::emit_acp_agents_updated;

/// The settings-document section `@deepseek-ai/dsh-llm-deepseek` registers
/// (`settingsNamespace("llm-deepseek")`, i.e. the plugin's own short name).
const SECTION_KEY: &str = "llm-deepseek";
/// The key inside that section this module owns. Everything else in the
/// section — `baseURL`, `thinking`, `retryPolicy`, … — is left untouched.
const MODELS_KEY: &str = "models";

/// The section `@deepseek-ai/dsh-llm-pi-ai` registers (`settingsNamespace`
/// with the plugin's own short name).
const PI_SECTION_KEY: &str = "llm-pi-ai";
/// The key inside that section this module owns: one entry per provider route,
/// keyed by the route id a request selects with.
const PI_PROVIDERS_KEY: &str = "providers";

/// Wire protocols a route may name — `supportedProtocols()` in
/// `@deepseek-ai/dsh-llm-pi-ai`, in the order that package lists them.
const PI_PROTOCOLS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];

/// pi-ai 1.x renamed these built-in providers (old id → new id).
/// `RENAMED_PROVIDERS` in the bridge's `composition/settings.ts`: it applies the
/// rename while importing a legacy document, and an old id left in place turns
/// into a broken hand-declared route with no models. The panel reads (and on
/// the first save migrates) the same legacy section, so it renames the same way.
const PI_RENAMED_PROVIDERS: &[(&str, &str)] = &[("azure-openai-responses", "azure")];

/// The grammar `apiKeyEnv` must satisfy: `REF_PATTERN` in
/// `@deepseek-ai/dsh-credentials`.
fn is_credential_ref_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('A'..='Z' | 'a'..='z' | '_'))
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `DEFAULT_CONTEXT_WINDOW` in the adapter (1,000,000 tokens).
const DEFAULT_CONTEXT_WINDOW: u64 = 1_000_000;
/// `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` (640,000 px) — the budget the adapter
/// materializes for a vision entry that declares none.
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET: u64 = 640_000;
/// `DEFAULT_REQUEST_IMAGE_MAX_BYTES` (1 MiB).
const DEFAULT_REQUEST_IMAGE_MAX_BYTES: u64 = 1_048_576;

/// JS `Number.MAX_SAFE_INTEGER`. The adapter judges its numeric fields with
/// `Number.isSafeInteger`, so a larger value is rejected there — reject it here
/// too rather than writing a document that would be dropped on load.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The two request modalities the adapter models.
const MODALITY_TEXT: &str = "text";
const MODALITY_IMAGE: &str = "image";

/// The one named pixel budget the adapter accepts in place of a count
/// (`"low"` → its `DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET`, 512×512).
const IMAGE_PIXEL_BUDGET_LOW: &str = "low";

/// The only value the adapter's `systemPromptUpdate` accepts when present.
const SYSTEM_PROMPT_UPDATE_IN_HISTORY: &str = "in-history";

/// A vision entry's per-request pixel budget: a count, or the adapter's named
/// low-detail tier. `z.union([z.number(), "low"])` upstream.
///
/// Untagged, so a YAML scalar lands on the arm its own type picks: `640000`
/// deserializes as [`Self::Pixels`], the bare word `low` falls through to
/// [`Self::Named`]. A misspelled word is therefore a `Named` that validation
/// rejects by name rather than an opaque "unusable entry" parse failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DeepSeekImagePixelBudget {
    /// Total pixels for one request preview.
    Pixels(u64),
    /// A named tier; only `"low"` is one the adapter knows.
    Named(String),
}

/// One entry of the advisory catalog, mirroring the adapter's
/// `DeepSeekCatalogModel`. Field names are the YAML/JSON ones verbatim, so the
/// same struct is both the settings-document shape and the wire shape.
///
/// Optional fields are omitted on write rather than written as `null`: the
/// adapter distinguishes "absent" (use its default) from a present value, and
/// an explicit `null` fails its schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekCatalogModel {
    /// Wire model id accepted by the configured endpoint. Required, unique.
    pub id: String,
    /// Selector label; the adapter falls back to [`Self::id`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Selector detail for deployments with similar variants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Combined request/response capacity; absent falls back to the section's
    /// `defaultContextWindow` (1,000,000 unless the section overrides it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Per-request output cap; absent falls back to the section's `maxTokens`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    /// Accepted request modalities; absent is text-only. Sending an image to a
    /// model without `image` here is refused by the agent, naming the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    /// Total-pixel budget for one request preview. Vision entries only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_pixel_budget: Option<DeepSeekImagePixelBudget>,
    /// Encoded-byte cap for one request preview. Vision entries only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_max_bytes: Option<u64>,
    /// How the system prompt is delivered to this route. The adapter accepts
    /// only `"in-history"`, and its own catalog entry for the default model
    /// declares it — which is why this is carried through rather than dropped:
    /// omitting it does not fail, it silently moves that model to the other
    /// delivery mode.
    ///
    /// Deliberately not editable in the panel: it is an internal of how the
    /// route is driven, not a choice a deployment makes per model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_update: Option<String>,
    /// The retired detail tier. Read-only on purpose, and NEVER serialized:
    /// `deepseek-acp` 0.9.0 refuses a catalog entry that so much as carries the
    /// key (`resolveModels` throws on `Object.hasOwn(model, "imageDetail")`),
    /// and a refused section takes the whole catalog with it.
    ///
    /// Kept in the shape so a document an older codeg wrote still PARSES: the
    /// panel then reports it through [`DeepSeekModelCatalog::invalid`] and the
    /// next save writes the entry without it. Dropping the field instead would
    /// trip the unknown-key guard and refuse to edit a document codeg itself
    /// produced.
    #[serde(default, skip_serializing)]
    pub image_detail: Option<String>,
}

impl DeepSeekCatalogModel {
    fn text_only(id: &str, name: &str, description: &str) -> Self {
        Self {
            id: id.to_string(),
            name: Some(name.to_string()),
            description: Some(description.to_string()),
            context_window: Some(DEFAULT_CONTEXT_WINDOW),
            max_tokens: None,
            input_modalities: None,
            image_pixel_budget: None,
            image_max_bytes: None,
            system_prompt_update: None,
            image_detail: None,
        }
    }

    /// Whether this entry declares image input — the gate for the three image
    /// request-limit fields, which the adapter refuses on a text-only entry.
    fn accepts_images(&self) -> bool {
        self.input_modalities
            .as_deref()
            .is_some_and(|m| m.iter().any(|modality| modality == MODALITY_IMAGE))
    }
}

/// The catalog a DeepSeek session inherits when the section declares no
/// `models`, so the panel shows what it actually offers rather than an empty
/// list.
///
/// **This is `deepseek-acp`'s own `DEEPSEEK_MODELS`, not the adapter's
/// `DEFAULT_MODELS`** — a distinction that only became visible in 0.9.0.
/// `dsh-settings` layers *schema default → the registrant's composition `base`
/// → the user document section*, and `boot.ts` now passes a catalog as that
/// `base` (`ctx.plugin(LlmDeepSeek, { models: DEEPSEEK_MODELS })`), which
/// shadows the adapter's schema default. The adapter's list still carries
/// `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`, both retired by
/// DeepSeek and neither reachable from a stock launch — copying from there
/// (which is what this used to do) shows the user models that do not exist.
///
/// Fields the upstream entries leave out are written here at the values the
/// adapter would resolve them to, because saving from the panel PINS this list
/// and a pin should not silently re-resolve later.
///
/// `deepseek-v4-pro` is listed because the agent still advertises it. Upstream
/// has announced its retirement (2026-09-14, requests routed to V4.1 Flash);
/// it leaves this list when it leaves `DEEPSEEK_MODELS`, not before — the
/// panel's job is to mirror the agent, not to predict it.
pub fn default_models() -> Vec<DeepSeekCatalogModel> {
    vec![
        DeepSeekCatalogModel {
            id: "deepseek-flash".to_string(),
            name: Some("DeepSeek-V4.1-Flash".to_string()),
            description: Some(
                "更快更省，且在各项指标上超越 V4 Pro；支持图像理解。日常编码的默认档。".to_string(),
            ),
            context_window: Some(DEFAULT_CONTEXT_WINDOW),
            max_tokens: None,
            input_modalities: Some(vec![
                MODALITY_TEXT.to_string(),
                MODALITY_IMAGE.to_string(),
            ]),
            image_pixel_budget: Some(DeepSeekImagePixelBudget::Pixels(
                DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
            )),
            image_max_bytes: Some(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
            system_prompt_update: Some(SYSTEM_PROMPT_UPDATE_IN_HISTORY.to_string()),
            image_detail: None,
        },
        DeepSeekCatalogModel::text_only(
            "deepseek-v4-pro",
            "DeepSeek-V4-Pro",
            "旧的高价档，官方已宣布有序下线；除非有特定理由，优先用 Flash。",
        ),
    ]
}

/// What the settings panel reads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekModelCatalog {
    /// Resolved `settings.yaml` path, shown so the user can find (or hand-edit)
    /// the document codeg writes.
    pub path: String,
    /// Whether that document exists at all.
    pub exists: bool,
    /// Whether it declares `llm-deepseek.models`. `false` means [`Self::models`]
    /// is the adapter's built-in list, inherited rather than stored.
    pub configured: bool,
    /// The effective catalog: what is stored, else the built-in defaults.
    pub models: Vec<DeepSeekCatalogModel>,
    /// Why the stored document could not be read. Set only when the file exists
    /// and is unusable — the panel then refuses to edit rather than offering a
    /// save that would overwrite something it never understood.
    pub error: Option<String>,
    /// Why the stored list is one the AGENT will refuse (duplicate ids, a
    /// non-positive context window, image limits on a text-only entry…).
    ///
    /// Distinct from [`Self::error`], and the difference is what the panel does
    /// about it: this document was understood, so its rows are editable and
    /// fixing them is the point. What it means meanwhile is that the harness is
    /// silently running on its BUILT-IN catalog — an unresolvable section keeps
    /// the last good configuration, which at startup is the composition entry —
    /// so without this the panel would confidently show a list no session can
    /// actually pick from.
    pub invalid: Option<String>,
}

/// `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`) — the document
/// `@deepseek-ai/dsh-settings-file` resolves with no explicit `path`.
pub fn dsh_settings_path() -> PathBuf {
    crate::parsers::deepseek::resolve_dsh_home_dir().join("settings.yaml")
}

/// Read the catalog for the settings panel. Never errors: a missing file is
/// "inheriting the defaults", and an unreadable one is reported in-band.
pub fn load_deepseek_model_catalog_core() -> DeepSeekModelCatalog {
    load_deepseek_model_catalog_at(&dsh_settings_path())
}

fn load_deepseek_model_catalog_at(path: &Path) -> DeepSeekModelCatalog {
    let display = path.display().to_string();
    let inherited = |exists: bool, error: Option<String>| DeepSeekModelCatalog {
        path: display.clone(),
        exists,
        configured: false,
        models: default_models(),
        error,
        invalid: None,
    };

    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return inherited(false, None),
        Err(err) => {
            return inherited(
                true,
                Some(format!("could not read the settings document: {err}")),
            )
        }
    };

    match read_models(&raw) {
        Ok(Some(models)) => DeepSeekModelCatalog {
            path: display,
            exists: true,
            configured: true,
            // A stored list the agent would refuse is reported, not hidden:
            // what runs is its built-in catalog, and the rows below are what
            // has to be fixed for that to change.
            invalid: validate_models(&models).err(),
            models,
            error: None,
        },
        Ok(None) => inherited(true, None),
        Err(message) => inherited(true, Some(message)),
    }
}

/// Every field of [`DeepSeekCatalogModel`] as it is spelled in the document.
/// A stored entry carrying anything else is reported rather than parsed: this
/// module rewrites the whole `models` block, so a key it does not model would
/// be silently dropped by the first save.
///
/// `imageDetail` is listed even though the agent no longer accepts it — see
/// [`DeepSeekCatalogModel::image_detail`]. It is a key codeg once wrote, so
/// reading it and reporting it is the repair path; treating it as unknown here
/// would refuse to edit the very documents that need fixing.
const KNOWN_FIELDS: &[&str] = &[
    "id",
    "name",
    "description",
    "contextWindow",
    "maxTokens",
    "inputModalities",
    "imagePixelBudget",
    "imageMaxBytes",
    "systemPromptUpdate",
    "imageDetail",
];

/// Parse `llm-deepseek.models` out of a settings document. `Ok(None)` is a
/// well-formed document that simply does not declare one.
fn read_models(raw: &str) -> Result<Option<Vec<DeepSeekCatalogModel>>, String> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    // Rejects a multi-document stream too ("more than one document"), which is
    // exactly the shape the block splice below could not edit safely anyway.
    let root: serde_yaml::Value =
        serde_yaml::from_str(raw).map_err(|err| format!("could not parse the YAML: {err}"))?;
    if root.is_null() {
        return Ok(None);
    }
    let Some(map) = root.as_mapping() else {
        return Err("the settings document's root is not a mapping".to_string());
    };
    let Some(section) = map.get(serde_yaml::Value::String(SECTION_KEY.to_string())) else {
        return Ok(None);
    };
    if section.is_null() {
        return Ok(None);
    }
    let Some(section) = section.as_mapping() else {
        return Err(format!("`{SECTION_KEY}` is not a mapping"));
    };
    let Some(models) = section.get(serde_yaml::Value::String(MODELS_KEY.to_string())) else {
        return Ok(None);
    };
    let Some(entries) = models.as_sequence() else {
        return Err(format!("`{SECTION_KEY}.{MODELS_KEY}` is not a list"));
    };
    for entry in entries {
        let Some(entry) = entry.as_mapping() else {
            continue; // caught with a better message by the deserialize below
        };
        for key in entry.keys() {
            let unknown = match key.as_str() {
                Some(key) => !KNOWN_FIELDS.contains(&key),
                None => true,
            };
            if unknown {
                let rendered = serde_yaml::to_string(key).unwrap_or_default();
                return Err(format!(
                    "`{SECTION_KEY}.{MODELS_KEY}` uses a field codeg does not know \
                     ({}); edit the document by hand so nothing is lost",
                    rendered.trim()
                ));
            }
        }
    }
    serde_yaml::from_value::<Vec<DeepSeekCatalogModel>>(models.clone())
        .map(Some)
        .map_err(|err| format!("`{SECTION_KEY}.{MODELS_KEY}` has an unusable entry: {err}"))
}

/// Judge a submitted catalog by the adapter's own `resolveModels` rules, so a
/// section codeg writes is one the adapter will actually load. Returns the
/// normalized list to store (ids/names trimmed).
fn validate_models(models: &[DeepSeekCatalogModel]) -> Result<Vec<DeepSeekCatalogModel>, String> {
    let mut seen: Vec<String> = Vec::with_capacity(models.len());
    let mut out: Vec<DeepSeekCatalogModel> = Vec::with_capacity(models.len());

    for model in models {
        let id = model.id.trim().to_string();
        if id.is_empty() {
            return Err("every model needs an id".to_string());
        }
        if seen.iter().any(|prev| prev == &id) {
            return Err(format!("duplicate model id \"{id}\""));
        }
        seen.push(id.clone());

        let name = match model.name.as_deref().map(str::trim) {
            // An empty name is rejected by the adapter, and "no name" already
            // means "show the id" — so a blank field is stored as absent.
            None | Some("") => None,
            Some(name) => Some(name.to_string()),
        };
        let description = match model.description.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(description) => Some(description.to_string()),
        };

        // Every numeric field must be a positive integer, and a section the
        // adapter cannot resolve is dropped whole — so one bad number would
        // silently take the entire catalog with it. The upper bound is JS's
        // safe-integer ceiling: past it the agent's own YAML parse cannot even
        // represent the value it would then judge (and the image fields are
        // explicitly `Number.isSafeInteger`-checked upstream).
        let bounded = |value: Option<u64>, field: &str| -> Result<Option<u64>, String> {
            match value {
                None => Ok(None),
                Some(0) => Err(format!("model \"{id}\" has a {field} of 0; it must be > 0")),
                Some(value) if value > MAX_SAFE_INTEGER => Err(format!(
                    "model \"{id}\" has a {field} above the maximum the agent accepts"
                )),
                Some(value) => Ok(Some(value)),
            }
        };
        let context_window = bounded(model.context_window, "context window")?;
        let max_tokens = bounded(model.max_tokens, "max output tokens")?;
        let image_max_bytes = bounded(model.image_max_bytes, "image byte cap")?;

        // The pixel budget takes a count OR the named `"low"` tier, so it is
        // judged on both arms rather than through `bounded`.
        let image_pixel_budget = match &model.image_pixel_budget {
            None => None,
            Some(DeepSeekImagePixelBudget::Pixels(pixels)) => {
                bounded(Some(*pixels), "image pixel budget")?
                    .map(DeepSeekImagePixelBudget::Pixels)
            }
            Some(DeepSeekImagePixelBudget::Named(named)) => {
                let named = named.trim();
                if named != IMAGE_PIXEL_BUDGET_LOW {
                    return Err(format!(
                        "model \"{id}\" has an image pixel budget of \"{named}\"; it must be \
                         \"{IMAGE_PIXEL_BUDGET_LOW}\" or a whole number above 0"
                    ));
                }
                Some(DeepSeekImagePixelBudget::Named(named.to_string()))
            }
        };

        // Retired in `deepseek-acp` 0.9.0, and not by being ignored: the
        // adapter throws on the key's mere presence and keeps its last good
        // configuration, so ONE of these takes down the whole catalog. Saying
        // which key and what replaced it is the difference between a fixable
        // notice and "my models stopped applying".
        if model.image_detail.is_some() {
            return Err(format!(
                "model \"{id}\" still sets an image detail tier, which the agent no longer \
                 accepts; use the image pixel budget instead (saving from here removes it)"
            ));
        }

        let system_prompt_update = match model.system_prompt_update.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(SYSTEM_PROMPT_UPDATE_IN_HISTORY) => {
                Some(SYSTEM_PROMPT_UPDATE_IN_HISTORY.to_string())
            }
            Some(mode) => {
                return Err(format!(
                    "model \"{id}\" has an unknown system prompt update mode \"{mode}\"; the \
                     agent accepts only \"{SYSTEM_PROMPT_UPDATE_IN_HISTORY}\""
                ))
            }
        };

        let input_modalities = match model.input_modalities.as_deref() {
            None => None,
            Some([]) => return Err(format!("model \"{id}\" lists no input modalities")),
            Some(modalities) => {
                let mut normalized: Vec<String> = Vec::with_capacity(modalities.len());
                for modality in modalities {
                    if modality != MODALITY_TEXT && modality != MODALITY_IMAGE {
                        return Err(format!(
                            "model \"{id}\" has an unknown input modality \"{modality}\""
                        ));
                    }
                    if normalized.iter().any(|prev| prev == modality) {
                        return Err(format!(
                            "model \"{id}\" repeats the input modality \"{modality}\""
                        ));
                    }
                    normalized.push(modality.clone());
                }
                Some(normalized)
            }
        };

        let normalized = DeepSeekCatalogModel {
            id,
            name,
            description,
            context_window,
            max_tokens,
            input_modalities,
            image_pixel_budget,
            image_max_bytes,
            system_prompt_update,
            // Rejected above; carrying it into the normalized entry would put
            // it back on the write path, and the field is never serialized.
            image_detail: None,
        };

        // The adapter refuses image request limits on a text-only entry
        // outright — the whole section would be dropped, not just the field.
        if !normalized.accepts_images()
            && (normalized.image_pixel_budget.is_some() || normalized.image_max_bytes.is_some())
        {
            return Err(format!(
                "model \"{}\" is text-only, so it cannot declare image limits",
                normalized.id
            ));
        }

        out.push(normalized);
    }

    Ok(out)
}

/// Write (or clear) `llm-deepseek.models` in the settings document.
///
/// `None` — and an empty list, which the panel emits when the last row is
/// deleted — REMOVES the key so the adapter's built-in catalog is inherited
/// again. Storing `models: []` instead would be a deployment that advertises no
/// model at all, which is never what deleting the last row asks for.
pub fn update_deepseek_model_catalog_core(
    models: Option<Vec<DeepSeekCatalogModel>>,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let path = dsh_settings_path();
    update_deepseek_model_catalog_at(&path, models)?;
    emit_acp_agents_updated(emitter, "config_updated", Some(AgentType::DeepSeek));
    Ok(())
}

fn update_deepseek_model_catalog_at(
    path: &Path,
    models: Option<Vec<DeepSeekCatalogModel>>,
) -> Result<(), AcpError> {
    let validated = match models {
        Some(models) if !models.is_empty() => Some(validate_models(&models).map_err(|message| {
            AcpError::protocol(format!("invalid DeepSeek model list: {message}"))
        })?),
        _ => None,
    };

    // Read immediately before patching: the document is shared with the harness
    // (and with a hand editor), so the merge is against what is on disk now.
    let existing = match fs::read_to_string(path) {
        Ok(existing) => existing,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => {
            return Err(AcpError::protocol(format!(
                "could not read the DeepSeek settings document: {err}"
            )))
        }
    };

    let patched = patch_settings_models(&existing, validated.as_deref())
        .map_err(|message| AcpError::protocol(format!("DeepSeek settings: {message}")))?;
    if patched == existing {
        return Ok(());
    }
    write_settings_document(path, &patched)
}

/// The file a write to `path` should actually land on.
///
/// `canonicalize` answers it whenever the document exists. It does NOT when the
/// path is a symlink whose target has not been created yet — a dotfiles
/// checkout that links `~/.dsh/settings.yaml` at a file it will write later —
/// and there the link must still be followed: an `open(O_CREAT)` (what this
/// used to do) creates the TARGET, so replacing the link instead would quietly
/// break the setup on the first save.
///
/// The walk stops at the first hop that is not a symlink (existing or not) and
/// FAILS rather than returning one that still is: the caller renames over what
/// this returns, so a chain longer than the bound — or a cycle, which is the
/// same thing here — would otherwise clobber an intermediate link, possibly one
/// outside the harness home entirely.
fn resolve_write_target(path: &Path) -> Result<PathBuf, std::io::Error> {
    /// Whether the chain ends here: nothing at this path (the file to create),
    /// or something that is not a link. An unreadable parent is neither — it is
    /// an error to report rather than a file to create.
    fn is_end_of_chain(candidate: &Path) -> Result<bool, std::io::Error> {
        match fs::symlink_metadata(candidate) {
            Ok(meta) => Ok(!meta.file_type().is_symlink()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(err) => Err(err),
        }
    }

    if let Ok(resolved) = fs::canonicalize(path) {
        return Ok(resolved);
    }
    // The OS gives up around 32–40 hops; a settings document behind more than a
    // handful of DANGLING links is not a setup to guess at.
    let mut current = path.to_path_buf();
    for _ in 0..8 {
        if is_end_of_chain(&current)? {
            return Ok(current);
        }
        let link = fs::read_link(&current)?;
        current = if link.is_absolute() {
            link
        } else {
            // A relative link resolves against the directory holding the link.
            current
                .parent()
                .map(|parent| parent.join(&link))
                .unwrap_or(link)
        };
        // The target may itself exist (only the last hop was dangling).
        if let Ok(resolved) = fs::canonicalize(&current) {
            return Ok(resolved);
        }
    }
    // Where the last hop landed is a candidate too — a chain that spends the
    // whole budget and then names a file to create is still followable.
    if is_end_of_chain(&current)? {
        return Ok(current);
    }
    Err(std::io::Error::other(format!(
        "{} is behind too many symbolic links",
        path.display()
    )))
}

/// Write the settings document the way the harness' own provider writes it:
/// into a sibling temporary file that is then renamed over the target, under a
/// `0700` parent, owner-only.
///
/// The atomic swap is not decoration. This document is the USER's and can hold
/// any other plugin's section; a plain `fs::write` truncates first, so a full
/// disk, an I/O error or a crash mid-write would leave everyone's settings
/// half-written. `dsh-settings-file` writes it through `writeFileAtomic`
/// (`{mode: 0o600, dirMode: 0o700}`) for exactly that reason, so a rename is
/// also what the file's own owner does to it.
///
/// Three consequences of the swap, all deliberate:
/// * A symlinked document keeps its indirection — [`resolve_write_target`]
///   follows the link first, so the temporary lands beside the REAL file and
///   replaces that.
/// * A hard link to the document is left pointing at the old content (the same
///   is true of the harness' own writes).
/// * On Windows, a rename over a file another process holds open without
///   `FILE_SHARE_DELETE` fails. That surfaces as a save error naming the file,
///   which is the honest outcome — and still better than the truncate-first
///   write it replaces, which could leave the document half-written.
///
/// Mode: an existing document keeps its own, minus any world bits (a
/// deliberately group-shared `0640` survives; a `0644` is repaired). A fresh
/// one is `0600` — it is created by codeg, so its mode is codeg's
/// responsibility, and under the usual `022` umask it would otherwise be
/// readable by every local user.
fn write_settings_document(path: &Path, body: &str) -> Result<(), AcpError> {
    let io_err = |what: &str, err: std::io::Error| {
        AcpError::protocol(format!("could not {what} the DeepSeek settings: {err}"))
    };

    // Follow a symlink to the file it names, so the rename replaces the real
    // document rather than the link.
    let target = resolve_write_target(path).map_err(|err| io_err("resolve the path of", err))?;

    if let Some(parent) = target.parent() {
        if !parent.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt as _;
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(parent)
                    .map_err(|err| io_err("create the harness home for", err))?;
            }
            #[cfg(not(unix))]
            fs::create_dir_all(parent).map_err(|err| io_err("create the harness home for", err))?;
        }
    }

    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let stem = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.yaml");

    // The mode the swapped-in file must end up with: an existing document keeps
    // its own minus any world bits, a fresh one is owner-only.
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt as _;
        fs::metadata(&target)
            .map(|meta| meta.permissions().mode() & 0o777 & !0o007)
            .unwrap_or(0o600)
    };

    let (temp, mut file) = create_temp_file(
        parent,
        stem,
        #[cfg(unix)]
        mode,
    )
    .map_err(|err| io_err("create a temporary file for", err))?;

    let mut write_temp = || -> Result<(), std::io::Error> {
        use std::io::Write as _;
        file.write_all(body.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            // `OpenOptions::mode` is masked by the umask, so a group-shared
            // document would come back tightened without this.
            fs::set_permissions(&temp, fs::Permissions::from_mode(mode))?;
        }
        // Flush before the swap: a rename can otherwise be durable while the
        // bytes it points at are not.
        file.sync_all()
    };

    if let Err(err) = write_temp() {
        let _ = fs::remove_file(&temp);
        return Err(io_err("write", err));
    }
    if let Err(err) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(io_err("store", err));
    }

    Ok(())
}

/// Create the temporary file the new document is staged in, beside `target`.
///
/// Beside it, because a rename is only atomic within one filesystem and the
/// system temp dir routinely is a different one.
///
/// The name is unique per CALL, not per process, and the file is created with
/// `create_new`: two saves racing (two windows, or two HTTP requests in the
/// server build) would otherwise stage into one file and rename a document
/// spliced together from both. `create_new` also means a stale temp left by a
/// killed run is never written through — its name is retried instead.
fn create_temp_file(
    parent: &Path,
    stem: &str,
    #[cfg(unix)] mode: u32,
) -> Result<(PathBuf, fs::File), std::io::Error> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let mut last = None;
    for _ in 0..8 {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or_default();
        let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(
            ".{stem}.codeg-{}-{seq}-{nonce}.tmp",
            std::process::id()
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(mode);
        }
        match options.open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => last = Some(err),
            Err(err) => return Err(err),
        }
    }
    Err(last.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "no free temporary file name",
        )
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Block splice
//
// The document is the user's — it can carry any other plugin's section, and
// the harness' own writer patches it as a comment-preserving leaf diff. A
// whole-document `serde_yaml` round trip would drop every comment and blank
// line in it, so the `models` block is replaced TEXTUALLY: every byte outside
// it is carried over verbatim, and the result is re-parsed and compared field
// by field before it is allowed to be written.
// ─────────────────────────────────────────────────────────────────────────────

/// A line of the document, with the byte range it occupies (line terminator
/// included) and its indentation.
struct DocLine {
    /// Byte range in the source, including the trailing newline when present.
    range: std::ops::Range<usize>,
    /// Column of the first non-whitespace byte; `None` for a blank line.
    indent: Option<usize>,
    /// Whether the first non-whitespace byte is `#`.
    comment: bool,
    /// The line without its terminator.
    text: String,
}

fn split_lines(raw: &str) -> Vec<DocLine> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    for line in raw.split_inclusive('\n') {
        let range = offset..offset + line.len();
        offset += line.len();
        let text = line.trim_end_matches('\n').trim_end_matches('\r').to_string();
        let indent = text.find(|c: char| !c.is_whitespace());
        let comment = indent.is_some_and(|i| text.as_bytes()[i] == b'#');
        out.push(DocLine {
            range,
            indent,
            comment,
            text,
        });
    }
    out
}

/// How a line relates to the key being looked for.
#[derive(Debug, PartialEq, Eq)]
enum KeyLine {
    /// A different key (or not a key at all).
    Other,
    /// `key:` opening a block — the value is on the lines below.
    Block,
    /// `key: <something>` on one line. A flow mapping or list cannot be
    /// spliced line-wise, so it is refused rather than guessed at.
    Inline,
}

/// Classify `text` against `key`, accepting the plain, single-quoted and
/// double-quoted spellings of the key.
fn classify_key_line(text: &str, key: &str) -> KeyLine {
    let trimmed = text.trim_start();
    for spelling in [key.to_string(), format!("'{key}'"), format!("\"{key}\"")] {
        let Some(rest) = trimmed.strip_prefix(&spelling) else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim();
        return if rest.is_empty() || rest.starts_with('#') {
            KeyLine::Block
        } else {
            KeyLine::Inline
        };
    }
    KeyLine::Other
}

/// Render `models:` as a block sequence indented to `indent`, with the line
/// terminator the document already uses.
fn render_models_block(
    models: &[DeepSeekCatalogModel],
    indent: usize,
    newline: &str,
) -> Result<String, String> {
    let value = serde_yaml::to_value(models)
        .map_err(|err| format!("could not serialize the model list: {err}"))?;
    let body = serde_yaml::to_string(&value)
        .map_err(|err| format!("could not serialize the model list: {err}"))?;
    let pad = " ".repeat(indent);
    let mut out = format!("{pad}{MODELS_KEY}:{newline}");
    for line in body.lines() {
        if line.is_empty() {
            out.push_str(newline);
        } else {
            // serde_yaml emits a top-level block sequence flush left; nest it
            // one level under its key, which is the shape a hand-written
            // settings document uses.
            out.push_str(&format!("{pad}  {line}{newline}"));
        }
    }
    Ok(out)
}

/// Replace, insert or delete `llm-deepseek.models` in `existing`, leaving every
/// other byte of the document alone.
fn patch_settings_models(
    existing: &str,
    models: Option<&[DeepSeekCatalogModel]>,
) -> Result<String, String> {
    let newline = if existing.contains("\r\n") { "\r\n" } else { "\n" };

    // A document codeg cannot parse is one it must not rewrite: the splice
    // below reasons about indentation, and the verification at the end needs a
    // "before" to compare against.
    let before: Option<serde_yaml::Value> = if existing.trim().is_empty() {
        None
    } else {
        let parsed: serde_yaml::Value = serde_yaml::from_str(existing)
            .map_err(|err| format!("could not parse the YAML: {err}"))?;
        if !parsed.is_mapping() && !parsed.is_null() {
            return Err("the settings document's root is not a mapping".to_string());
        }
        // A section that is neither a mapping nor absent (a list, a scalar) is
        // not a shape a `models` key can be added to at all — say so here
        // rather than producing a document the verification would reject with a
        // vaguer message.
        let section = parsed
            .as_mapping()
            .and_then(|map| map.get(serde_yaml::Value::String(SECTION_KEY.to_string())));
        if section.is_some_and(|value| !value.is_mapping() && !value.is_null()) {
            return Err(format!("`{SECTION_KEY}` is not a mapping"));
        }
        Some(parsed)
    };

    let patched = splice_models(existing, models, newline)?;
    verify_patch(&patched, before.as_ref(), models)?;
    Ok(patched)
}

fn splice_models(
    existing: &str,
    models: Option<&[DeepSeekCatalogModel]>,
    newline: &str,
) -> Result<String, String> {
    let lines = split_lines(existing);

    // ── The section header ───────────────────────────────────────────────
    let mut section: Option<usize> = None;
    for (index, line) in lines.iter().enumerate() {
        if line.indent != Some(0) || line.comment {
            continue;
        }
        match classify_key_line(&line.text, SECTION_KEY) {
            KeyLine::Block => {
                section = Some(index);
                break;
            }
            KeyLine::Inline => {
                return Err(format!(
                    "`{SECTION_KEY}` is written inline in this document; edit it by hand instead"
                ))
            }
            KeyLine::Other => {}
        }
    }

    let Some(section) = section else {
        // No section yet. Nothing to remove; otherwise append a fresh one.
        let Some(models) = models else {
            return Ok(existing.to_string());
        };
        let block = render_models_block(models, 2, newline)?;
        let mut out = existing.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(newline);
        }
        out.push_str(&format!("{SECTION_KEY}:{newline}"));
        out.push_str(&block);
        return Ok(out);
    };

    // ── The section body: every following line indented past column 0 ────
    // A line flush against the left margin ends it — including a comment,
    // which introduces whatever comes after it rather than closing this
    // section.
    let body_end = lines
        .iter()
        .enumerate()
        .skip(section + 1)
        .find(|(_, line)| line.indent == Some(0))
        .map_or(lines.len(), |(index, _)| index);

    // The indentation the section's own keys sit at.
    let child_indent = lines[section + 1..body_end]
        .iter()
        .find(|line| line.indent.is_some() && !line.comment)
        .and_then(|line| line.indent)
        .unwrap_or(2);

    // ── The `models` block inside it ─────────────────────────────────────
    let mut models_at: Option<usize> = None;
    for (index, line) in lines.iter().enumerate().take(body_end).skip(section + 1) {
        if line.indent != Some(child_indent) || line.comment {
            continue;
        }
        match classify_key_line(&line.text, MODELS_KEY) {
            KeyLine::Block => {
                models_at = Some(index);
                break;
            }
            KeyLine::Inline => {
                return Err(format!(
                    "`{SECTION_KEY}.{MODELS_KEY}` is written inline in this document; edit it by hand instead"
                ))
            }
            KeyLine::Other => {}
        }
    }

    let (replace_from, replace_to) = match models_at {
        Some(start) => {
            // The block runs to the next line at or above the key's own
            // indent — except a sequence item sitting AT that indent, which is
            // how both `serde_yaml`'s emitter and plenty of hand-written YAML
            // write a list under its key.
            let mut end = body_end;
            for (index, line) in lines.iter().enumerate().take(body_end).skip(start + 1) {
                let Some(indent) = line.indent else { continue };
                if indent > child_indent {
                    continue;
                }
                if indent == child_indent && line.text.trim_start().starts_with('-') {
                    continue;
                }
                end = index;
                break;
            }
            // Blank lines after the block separate it from what follows; leave
            // them where they are.
            while end > start + 1 && lines[end - 1].indent.is_none() {
                end -= 1;
            }
            (start, end)
        }
        // No block yet: append one after the section's last meaningful line, so
        // a trailing comment or blank line keeps introducing what it introduced.
        None => {
            let mut end = body_end;
            while end > section + 1
                && (lines[end - 1].indent.is_none() || lines[end - 1].comment)
            {
                end -= 1;
            }
            (end, end)
        }
    };

    let prefix_end = if replace_from == lines.len() {
        existing.len()
    } else {
        lines[replace_from].range.start
    };
    let suffix_start = if replace_to == lines.len() {
        existing.len()
    } else {
        lines[replace_to].range.start
    };

    let mut out = String::with_capacity(existing.len() + 256);
    out.push_str(&existing[..prefix_end]);
    // A document whose last line has no terminator would otherwise have the
    // new block glued onto it.
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str(newline);
    }

    match models {
        Some(models) => out.push_str(&render_models_block(models, child_indent, newline)?),
        None => {
            // Removing the only key of the section leaves `llm-deepseek:` with
            // an empty body, i.e. a NULL section — and the settings service
            // rejects a section that is not a plain object ("must be an object
            // of keys"), logs it, and skips the namespace. Dropping the header
            // reaches the same place (built-in catalog) without the warning, so
            // the header goes with the last key.
            //
            // A comment-only body counts as empty, which does mean a note
            // written above `models:` goes with the section it annotated. That
            // is the one thing this splice deletes on purpose; leaving the
            // header behind to keep the note would leave the rejected shape.
            let section_is_empty = lines[section + 1..body_end]
                .iter()
                .enumerate()
                .all(|(offset, line)| {
                    let index = section + 1 + offset;
                    (index >= replace_from && index < replace_to)
                        || line.indent.is_none()
                        || line.comment
                });
            if section_is_empty {
                let header_start = lines[section].range.start;
                let mut out = String::with_capacity(existing.len());
                out.push_str(&existing[..header_start]);
                out.push_str(&existing[suffix_start..]);
                return Ok(out);
            }
        }
    }

    out.push_str(&existing[suffix_start..]);
    Ok(out)
}

/// Re-read the patched document and refuse it unless it says exactly what the
/// splice meant to say and nothing else moved. The splice reasons about text;
/// this is the only check that reasons about the resulting YAML.
fn verify_patch(
    patched: &str,
    before: Option<&serde_yaml::Value>,
    models: Option<&[DeepSeekCatalogModel]>,
) -> Result<(), String> {
    let unsafe_edit = |detail: &str| {
        format!(
            "could not update `{SECTION_KEY}.{MODELS_KEY}` without disturbing the rest of the \
             document ({detail}); edit it by hand instead"
        )
    };

    let after: serde_yaml::Value = if patched.trim().is_empty() {
        serde_yaml::Value::Null
    } else {
        serde_yaml::from_str(patched).map_err(|err| unsafe_edit(&format!("re-parse failed: {err}")))?
    };

    let section_key = serde_yaml::Value::String(SECTION_KEY.to_string());
    let models_key = serde_yaml::Value::String(MODELS_KEY.to_string());

    // What was written is what was asked for.
    let stored = after
        .as_mapping()
        .and_then(|map| map.get(&section_key))
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|section| section.get(&models_key));
    match models {
        Some(models) => {
            let expected = serde_yaml::to_value(models)
                .map_err(|err| unsafe_edit(&format!("serialize failed: {err}")))?;
            if stored != Some(&expected) {
                return Err(unsafe_edit("the model list did not land where it was aimed"));
            }
        }
        None => {
            if stored.is_some() {
                return Err(unsafe_edit("the model list is still there"));
            }
        }
    }

    // Nothing else changed. Comparing the PARSED documents (rather than the
    // text) is the point: a splice that ran off the end of the block would
    // change a neighbour's meaning, and that shows up here even though every
    // byte outside the block was copied verbatim.
    //
    // The section itself is normalized away when `models` is all it holds, so
    // "wrote the first one" and "removed the last one" — which legitimately
    // add and drop the header — compare equal on both sides.
    let strip = |value: Option<&serde_yaml::Value>| -> serde_yaml::Mapping {
        let mut map = match value {
            Some(serde_yaml::Value::Mapping(map)) => map.clone(),
            _ => serde_yaml::Mapping::new(),
        };
        match map.get(&section_key).cloned() {
            Some(serde_yaml::Value::Mapping(mut section)) => {
                section.remove(&models_key);
                if section.is_empty() {
                    map.remove(&section_key);
                } else {
                    map.insert(section_key.clone(), serde_yaml::Value::Mapping(section));
                }
            }
            // An empty `llm-deepseek:` header resolves to null; treat it as the
            // absence it is, so writing the first entry under one is allowed.
            Some(serde_yaml::Value::Null) | None => {
                map.remove(&section_key);
            }
            // A section that is neither a mapping nor null is not ours to
            // reshape: leave it in the comparison so any change to it fails.
            Some(_) => {}
        }
        map
    };
    if strip(before) != strip(Some(&after)) {
        return Err(unsafe_edit("another section would have changed"));
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider routes (`llm-pi-ai.providers`)
// ─────────────────────────────────────────────────────────────────────────────

/// One `llm-pi-ai` provider route: a provider the bridge may serve models
/// from, keyed by the route id a request selects with.
///
/// Only the fields the panel edits are modelled. Everything else a profile can
/// carry — `models`, `modelOverrides`, `compat`, `retryPolicy`, … — is
/// round-tripped untouched from the document being written, because dropping a
/// hand-written `models` list on save would silently change which models the
/// route serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekProviderRoute {
    /// Route id: any non-empty key, as pi-ai accepts. A stored sign-in
    /// addresses it as a credential-key segment, which catalog ids
    /// (`[a-z][a-z0-9-]*`) already are; any other id authenticates through
    /// `apiKeyEnv`.
    pub id: String,
    /// Selector label; absent falls back to the provider's own name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Credential reference resolved through the harness credential store
    /// (`$DSH_HOME/.credentials.yaml`). Absent defers to pi-ai's own ambient
    /// environment discovery for that provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    /// Wire protocol override; absent takes the pi-ai catalog's protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    /// Endpoint override; absent takes the pi-ai catalog's endpoint.
    #[serde(rename = "baseURL", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// What the settings panel reads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekProviderRoutes {
    /// Where a save lands: the bridge's own document
    /// (`$DSH_HOME/deepseek-acp/settings.yaml`).
    pub path: String,
    /// Whether that document exists at all.
    pub exists: bool,
    /// Whether the effective document declares `llm-pi-ai.providers`.
    /// `false` means the bridge serves only the official DeepSeek route.
    pub configured: bool,
    /// The document the routes on screen came from — the bridge's own document,
    /// or a legacy harness document the bridge imports from until this panel
    /// writes one. `None` when nothing is configured anywhere.
    pub source: Option<String>,
    pub routes: Vec<DeepSeekProviderRoute>,
    /// Why the effective document could not be read. Set only when it exists
    /// and is unusable — the panel then refuses to edit rather than overwriting
    /// something it never understood.
    pub error: Option<String>,
    /// Why the stored routes are ones the agent will refuse (a malformed route
    /// id, a bad credential reference, an unsupported protocol…). The document
    /// was understood, so its rows stay editable; what it means meanwhile is
    /// that the bridge logs the failure and keeps the routes it had before.
    pub invalid: Option<String>,
}

/// `$DSH_HOME/deepseek-acp/settings.yaml` — the document deepseek-acp 0.10.0
/// and later keep their `llm-pi-ai` routes in (and the one `providers/*`
/// writes). Its `llm-deepseek` section, if a hand editor added one, is not read
/// by the bridge.
pub fn pi_settings_path() -> PathBuf {
    crate::parsers::deepseek::resolve_dsh_home_dir()
        .join("deepseek-acp")
        .join("settings.yaml")
}

/// The documents a 0.10.0+ bridge imports `llm-pi-ai` from while its own
/// document does not exist: the file 0.9.0 wrote, then what DSH 0.2 renames
/// that file to on its first launch.
fn legacy_pi_settings_paths() -> Vec<PathBuf> {
    let home = crate::parsers::deepseek::resolve_dsh_home_dir();
    vec![
        home.join("settings.yaml"),
        home.join("settings.yaml.imported"),
    ]
}

/// Read a document, telling "absent" apart from "unreadable".
fn read_document(path: &Path) -> Result<Option<String>, std::io::Error> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// Parse `llm-pi-ai.providers` out of a settings document. `Ok(None)` is a
/// well-formed document that does not declare the section (or declares
/// `providers:` with no value); `Ok(Some(empty))` is a declared-but-empty map.
fn read_pi_providers(raw: &str) -> Result<Option<serde_yaml::Mapping>, String> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let root: serde_yaml::Value =
        serde_yaml::from_str(raw).map_err(|err| format!("could not parse the YAML: {err}"))?;
    if root.is_null() {
        return Ok(None);
    }
    let Some(map) = root.as_mapping() else {
        return Err("the settings document's root is not a mapping".to_string());
    };
    let section = match map.get(serde_yaml::Value::String(PI_SECTION_KEY.to_string())) {
        None | Some(serde_yaml::Value::Null) => return Ok(None),
        Some(section) => section
            .as_mapping()
            .ok_or_else(|| format!("`{PI_SECTION_KEY}` is not a mapping"))?,
    };
    match section.get(serde_yaml::Value::String(PI_PROVIDERS_KEY.to_string())) {
        None | Some(serde_yaml::Value::Null) => Ok(None),
        Some(providers) => providers
            .as_mapping()
            .cloned()
            .map(Some)
            .ok_or_else(|| format!("`{PI_SECTION_KEY}.{PI_PROVIDERS_KEY}` is not a mapping")),
    }
}

/// Whether a legacy document carries the `llm-pi-ai` key at all.
///
/// The bridge's importer stops at the first legacy document whose section is
/// PRESENT — an empty one shadows every later file — so the panel has to stop
/// in the same place, or it would show routes from a file the agent never
/// reads.
fn legacy_declares_pi_ai(raw: &str) -> bool {
    serde_yaml::from_str::<serde_yaml::Value>(raw)
        .ok()
        .and_then(|root| {
            let map = root.as_mapping()?;
            Some(map.contains_key(serde_yaml::Value::String(PI_SECTION_KEY.to_string())))
        })
        .unwrap_or(false)
}

/// Whether a legacy document's `llm-pi-ai` value is a mapping. The bridge's
/// importer skips a document only when it cannot read the section as a mapping
/// at all; a mapping section ends the search even when its `providers` is
/// malformed (pi-ai then reports the schema error), so the panel must stop at
/// that document too rather than fall through to a later file the agent never
/// reads.
fn legacy_pi_section_is_mapping(raw: &str) -> bool {
    serde_yaml::from_str::<serde_yaml::Value>(raw)
        .ok()
        .and_then(|root| {
            root.as_mapping()?
                .get(serde_yaml::Value::String(PI_SECTION_KEY.to_string()))
                .map(serde_yaml::Value::is_mapping)
        })
        .unwrap_or(false)
}

/// Project the stored profiles onto the fields the panel edits.
fn routes_from_profiles(
    profiles: &serde_yaml::Mapping,
) -> Result<Vec<DeepSeekProviderRoute>, String> {
    let mut out = Vec::with_capacity(profiles.len());
    for (key, value) in profiles {
        let Some(id) = key.as_str() else {
            return Err("a provider route name is not a string".to_string());
        };
        let empty = serde_yaml::Mapping::new();
        let profile = match value {
            serde_yaml::Value::Mapping(map) => map,
            // `opencode-go:` with nothing under it is how YAML spells an empty
            // profile, and it is exactly what a route with only catalog
            // defaults looks like.
            serde_yaml::Value::Null => &empty,
            _ => {
                return Err(format!(
                    "`{PI_SECTION_KEY}.{PI_PROVIDERS_KEY}.{id}` is not a mapping"
                ))
            }
        };
        let field = |name: &str| -> Result<Option<String>, String> {
            match profile.get(serde_yaml::Value::String(name.to_string())) {
                None | Some(serde_yaml::Value::Null) => Ok(None),
                Some(serde_yaml::Value::String(text)) => Ok(Some(text.clone())),
                Some(_) => Err(format!(
                    "`{PI_SECTION_KEY}.{PI_PROVIDERS_KEY}.{id}.{name}` is not a string"
                )),
            }
        };
        out.push(DeepSeekProviderRoute {
            id: id.to_string(),
            display_name: field("displayName")?,
            api_key_env: field("apiKeyEnv")?,
            api: field("api")?,
            base_url: field("baseURL")?,
        });
    }
    Ok(out)
}

/// Judge submitted routes by pi-ai's own configuration rules, so a document
/// codeg writes is one the adapter actually loads. Returns the normalized
/// routes to store (every field trimmed, blanks removed).
fn validate_provider_routes(
    routes: &[DeepSeekProviderRoute],
) -> Result<Vec<DeepSeekProviderRoute>, String> {
    let mut seen: Vec<String> = Vec::with_capacity(routes.len());
    let mut out: Vec<DeepSeekProviderRoute> = Vec::with_capacity(routes.len());
    let trimmed = |value: &Option<String>| -> Option<String> {
        value
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };

    for route in routes {
        // pi-ai takes any non-empty route key (`resolveProfiles`). Only a
        // stored sign-in needs the credential-key grammar, and a route outside
        // it authenticates through `apiKeyEnv` instead — so a hand-declared
        // `my_gateway` is a working route, not one to refuse.
        let id = route.id.trim().to_string();
        if id.is_empty() {
            return Err("every provider route needs an id".to_string());
        }
        if seen.iter().any(|prev| prev == &id) {
            return Err(format!("duplicate provider route \"{id}\""));
        }
        seen.push(id.clone());

        let api_key_env = match trimmed(&route.api_key_env) {
            None => None,
            Some(name) if is_credential_ref_name(&name) => Some(name),
            Some(name) => {
                return Err(format!(
                    "provider route \"{id}\" has an API key reference \"{name}\"; it must be an \
                     environment-variable name"
                ))
            }
        };

        let api = match trimmed(&route.api) {
            None => None,
            Some(api) if PI_PROTOCOLS.contains(&api.as_str()) => Some(api),
            Some(api) => {
                return Err(format!(
                    "provider route \"{id}\" names protocol \"{api}\"; the agent accepts {}",
                    PI_PROTOCOLS.join(", ")
                ))
            }
        };

        let base_url = match trimmed(&route.base_url) {
            None => None,
            Some(url) if is_usable_base_url(&url) => Some(url),
            Some(url) => {
                return Err(format!(
                    "provider route \"{id}\" has an unusable endpoint \"{url}\"; use an http(s) \
                     URL with no credentials, query or fragment"
                ))
            }
        };

        out.push(DeepSeekProviderRoute {
            id,
            display_name: trimmed(&route.display_name),
            api_key_env,
            api,
            base_url,
        });
    }
    Ok(out)
}

/// The endpoint check the DeepSeek base-URL field uses, for the same reason:
/// the adapter concatenates paths onto this string, so a query or fragment does
/// not travel as one.
fn is_usable_base_url(value: &str) -> bool {
    if value.contains(['?', '#']) {
        return false;
    }
    match url::Url::parse(value) {
        Ok(url) => {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some_and(|host| !host.is_empty())
                && url.username().is_empty()
                && url.password().is_none()
        }
        Err(_) => false,
    }
}

/// Read the routes the agent is actually serving from today.
pub fn load_deepseek_provider_routes_core() -> DeepSeekProviderRoutes {
    load_deepseek_provider_routes_at(&pi_settings_path(), &legacy_pi_settings_paths())
}

fn load_deepseek_provider_routes_at(
    path: &Path,
    legacy: &[PathBuf],
) -> DeepSeekProviderRoutes {
    let display = path.display().to_string();
    let unreadable = |exists: bool, message: String| DeepSeekProviderRoutes {
        path: display.clone(),
        exists,
        configured: false,
        source: None,
        routes: Vec::new(),
        error: Some(message),
        invalid: None,
    };

    let bridge = match read_document(path) {
        Ok(document) => document,
        Err(err) => {
            return unreadable(
                true,
                format!("could not read the provider settings document: {err}"),
            )
        }
    };

    // An existing bridge document is authoritative even when it declares no
    // routes: the bridge stops importing the legacy documents at that point, so
    // reporting the legacy routes here would offer a list no session can use.
    if let Some(raw) = bridge.as_deref() {
        return provider_routes_view(
            read_pi_providers(raw),
            display,
            true,
            Some(display_from(path)),
        );
    }

    for candidate in legacy {
        let Ok(Some(raw)) = read_document(candidate) else {
            continue;
        };
        // A legacy document belongs to the harness and to older releases;
        // unreadable content there is skipped rather than blocking the panel,
        // exactly as the bridge's own importer does.
        let profiles = match read_pi_providers(&raw) {
            Ok(Some(profiles)) => Ok(Some(upgrade_legacy_profiles(profiles))),
            // An empty section still ends the search: the bridge imports this
            // file and never looks at the next one.
            Ok(None) if legacy_declares_pi_ai(&raw) => Ok(None),
            // So does a mapping section with a malformed `providers`: the
            // bridge imports it and fails on it, so the panel reports it (and
            // refuses to edit) instead of showing a later file's routes.
            Err(message) if legacy_pi_section_is_mapping(&raw) => Err(message),
            _ => continue,
        };
        return provider_routes_view(
            profiles,
            display,
            false,
            Some(display_from(candidate)),
        );
    }

    DeepSeekProviderRoutes {
        path: display,
        exists: false,
        configured: false,
        source: None,
        routes: Vec::new(),
        error: None,
        invalid: None,
    }
}

fn display_from(path: &Path) -> String {
    path.display().to_string()
}

/// Fold a `read_pi_providers` result into the panel's view.
fn provider_routes_view(
    profiles: Result<Option<serde_yaml::Mapping>, String>,
    path: String,
    exists: bool,
    source: Option<String>,
) -> DeepSeekProviderRoutes {
    match profiles {
        Ok(None) => DeepSeekProviderRoutes {
            path,
            exists,
            configured: false,
            source,
            routes: Vec::new(),
            error: None,
            invalid: None,
        },
        Ok(Some(profiles)) => match routes_from_profiles(&profiles) {
            Ok(routes) => DeepSeekProviderRoutes {
                path,
                exists,
                configured: true,
                source,
                invalid: validate_provider_routes(&routes).err(),
                routes,
                error: None,
            },
            Err(message) => DeepSeekProviderRoutes {
                path,
                exists,
                configured: true,
                source,
                routes: Vec::new(),
                error: Some(message),
                invalid: None,
            },
        },
        Err(message) => DeepSeekProviderRoutes {
            path,
            exists,
            configured: false,
            source,
            routes: Vec::new(),
            error: Some(message),
            invalid: None,
        },
    }
}

/// Write (or clear) `llm-pi-ai.providers` in the bridge's own document.
///
/// `None` — and an empty list, which the panel emits when the last row is
/// deleted — REMOVES the key so the bridge serves the official DeepSeek route
/// alone. When the cleared routes came from a legacy document instead, it
/// leaves an empty `llm-pi-ai` section behind, because an absent bridge
/// document is what makes the agent import them again. The rest of the
/// document, including fields this panel does not model inside a route
/// profile, is left untouched.
pub fn update_deepseek_provider_routes_core(
    routes: Option<Vec<DeepSeekProviderRoute>>,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let validated = match routes {
        Some(routes) if !routes.is_empty() => {
            Some(validate_provider_routes(&routes).map_err(|message| {
                AcpError::protocol(format!("invalid DeepSeek provider routes: {message}"))
            })?)
        }
        _ => None,
    };

    update_deepseek_provider_routes_at(
        &pi_settings_path(),
        &legacy_pi_settings_paths(),
        validated.as_deref(),
    )?;
    emit_acp_agents_updated(emitter, "config_updated", Some(AgentType::DeepSeek));
    Ok(())
}

fn update_deepseek_provider_routes_at(
    path: &Path,
    legacy: &[PathBuf],
    routes: Option<&[DeepSeekProviderRoute]>,
) -> Result<(), AcpError> {
    let protocol_err =
        |message: String| AcpError::protocol(format!("DeepSeek settings: {message}"));

    let (existing, document_exists) = match read_document(path) {
        Ok(Some(existing)) => (existing, true),
        Ok(None) => (String::new(), false),
        Err(err) => {
            return Err(AcpError::protocol(format!(
                "could not read the DeepSeek provider settings document: {err}"
            )))
        }
    };

    // Profiles whose unmodelled fields (`models`, `compat`, `retryPolicy`…)
    // have to survive the save. An existing bridge document wins; before the
    // first save that document does not exist and the agent serves the imported
    // legacy section, so those are the profiles to carry over.
    let base = if document_exists {
        read_pi_providers(&existing).map_err(protocol_err)?
    } else {
        legacy_pi_profiles(legacy)
    }
    .unwrap_or_default();

    // Clearing imported routes has to leave something behind: the legacy
    // document is read-only to us, and an ABSENT bridge document is exactly
    // what makes the agent import it. An empty section in the bridge document
    // shadows the import without mounting pi-ai.
    if routes.into_iter().flatten().next().is_none() && !document_exists && !base.is_empty() {
        let body = format!("{PI_SECTION_KEY}: {{}}\n");
        write_settings_document(path, &body)?;
        return Ok(());
    }

    let mut profiles = serde_yaml::Mapping::new();
    for route in routes.into_iter().flatten() {
        let previous = base
            .get(serde_yaml::Value::String(route.id.clone()))
            .and_then(serde_yaml::Value::as_mapping);
        profiles.insert(
            serde_yaml::Value::String(route.id.clone()),
            serde_yaml::Value::Mapping(profile_from_route(route, previous)),
        );
    }

    let providers = if profiles.is_empty() {
        None
    } else {
        Some(&profiles)
    };
    let patched = patch_pi_providers(&existing, providers).map_err(protocol_err)?;
    if patched != existing {
        write_settings_document(path, &patched)?;
    }
    Ok(())
}

/// The `llm-pi-ai.providers` mapping an existing bridge would import, if any.
fn legacy_pi_profiles(legacy: &[PathBuf]) -> Option<serde_yaml::Mapping> {
    for candidate in legacy {
        let Ok(Some(raw)) = read_document(candidate) else {
            continue;
        };
        match read_pi_providers(&raw) {
            Ok(Some(profiles)) => return Some(upgrade_legacy_profiles(profiles)),
            Ok(None) if legacy_declares_pi_ai(&raw) => return None,
            // The bridge stops at this document too; it carries no profile
            // the panel could merge from.
            Err(_) if legacy_pi_section_is_mapping(&raw) => return None,
            _ => continue,
        }
    }
    None
}

/// Apply the bridge's legacy-import renames ([`PI_RENAMED_PROVIDERS`]) to a
/// legacy `providers` mapping. When both the old and the new id are present
/// the new one wins — it is the one configured on a current release — and the
/// old one is dropped either way, exactly as `upgradeLegacySection` does.
fn upgrade_legacy_profiles(mut profiles: serde_yaml::Mapping) -> serde_yaml::Mapping {
    for (from, to) in PI_RENAMED_PROVIDERS {
        let from = serde_yaml::Value::String((*from).to_string());
        let to = serde_yaml::Value::String((*to).to_string());
        if let Some(profile) = profiles.shift_remove(&from) {
            if !profiles.contains_key(&to) {
                profiles.insert(to, profile);
            }
        }
    }
    profiles
}

/// The fields this panel owns inside one provider profile.
const PI_ROUTE_FIELDS: &[&str] = &["displayName", "apiKeyEnv", "api", "baseURL"];

/// Render one route as a profile mapping, keeping every field the panel does
/// not model from `base`.
fn profile_from_route(
    route: &DeepSeekProviderRoute,
    base: Option<&serde_yaml::Mapping>,
) -> serde_yaml::Mapping {
    let mut out = serde_yaml::Mapping::new();
    let mut insert = |key: &str, value: &Option<String>| {
        if let Some(value) = value {
            out.insert(
                serde_yaml::Value::String(key.to_string()),
                serde_yaml::Value::String(value.clone()),
            );
        }
    };
    insert("displayName", &route.display_name);
    insert("apiKeyEnv", &route.api_key_env);
    insert("api", &route.api);
    insert("baseURL", &route.base_url);
    if let Some(base) = base {
        for (key, value) in base {
            let known = key
                .as_str()
                .is_some_and(|key| PI_ROUTE_FIELDS.contains(&key));
            if !known {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    out
}

/// Replace, insert or delete `llm-pi-ai.providers` in `existing`, leaving every
/// other section of the document alone.
fn patch_pi_providers(
    existing: &str,
    providers: Option<&serde_yaml::Mapping>,
) -> Result<String, String> {
    let newline = if existing.contains("\r\n") { "\r\n" } else { "\n" };

    let before: Option<serde_yaml::Value> = if existing.trim().is_empty() {
        None
    } else {
        let parsed: serde_yaml::Value = serde_yaml::from_str(existing)
            .map_err(|err| format!("could not parse the YAML: {err}"))?;
        if !parsed.is_mapping() && !parsed.is_null() {
            return Err("the settings document's root is not a mapping".to_string());
        }
        let section = parsed
            .as_mapping()
            .and_then(|map| map.get(serde_yaml::Value::String(PI_SECTION_KEY.to_string())));
        if section.is_some_and(|value| !value.is_mapping() && !value.is_null()) {
            return Err(format!("`{PI_SECTION_KEY}` is not a mapping"));
        }
        Some(parsed)
    };

    let mut section = before
        .as_ref()
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|map| map.get(serde_yaml::Value::String(PI_SECTION_KEY.to_string())))
        .and_then(serde_yaml::Value::as_mapping)
        .cloned()
        .unwrap_or_default();
    match providers {
        Some(providers) if !providers.is_empty() => {
            section.insert(
                serde_yaml::Value::String(PI_PROVIDERS_KEY.to_string()),
                serde_yaml::Value::Mapping(providers.clone()),
            );
        }
        _ => {
            section.remove(serde_yaml::Value::String(PI_PROVIDERS_KEY.to_string()));
        }
    }

    let inline_section_is_empty = before
        .as_ref()
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|map| map.get(serde_yaml::Value::String(PI_SECTION_KEY.to_string())))
        .is_none_or(|value| {
            value.is_null() || value.as_mapping().is_some_and(serde_yaml::Mapping::is_empty)
        });

    let lines = split_lines(existing);
    let mut header: Option<usize> = None;
    for (index, line) in lines.iter().enumerate() {
        if line.indent != Some(0) || line.comment {
            continue;
        }
        match classify_key_line(&line.text, PI_SECTION_KEY) {
            KeyLine::Block => {
                header = Some(index);
                break;
            }
            // An empty inline section (`llm-pi-ai: {}`) holds nothing to lose,
            // and it is exactly what clearing imported routes writes — and what
            // the bridge's own YAML writer emits for an empty section — so it is
            // replaced like a block header. `verify_pi_patch` still checks the
            // result.
            KeyLine::Inline if inline_section_is_empty => {
                header = Some(index);
                break;
            }
            KeyLine::Inline => {
                return Err(format!(
                    "`{PI_SECTION_KEY}` is written inline in this document; edit it by hand \
                     instead"
                ))
            }
            KeyLine::Other => {}
        }
    }

    let (prefix_end, suffix_start) = match header {
        Some(index) => {
            let body_end = lines
                .iter()
                .enumerate()
                .skip(index + 1)
                .find(|(_, line)| line.indent == Some(0))
                .map_or(lines.len(), |(index, _)| index);
            let suffix = if body_end == lines.len() {
                existing.len()
            } else {
                lines[body_end].range.start
            };
            (lines[index].range.start, suffix)
        }
        // No section yet: append one at the end.
        None => (existing.len(), existing.len()),
    };

    let replacement = if section.is_empty() {
        String::new()
    } else {
        render_pi_section(&section, newline)?
    };

    let mut out = String::with_capacity(existing.len() + 256);
    out.push_str(&existing[..prefix_end]);
    if !replacement.is_empty() && prefix_end == existing.len() {
        // Appending: separate the new section from whatever came before.
        if !out.is_empty() && !out.ends_with('\n') {
            out.push_str(newline);
        }
        out.push_str(&replacement);
    } else if prefix_end < existing.len() {
        out.push_str(&replacement);
    }
    out.push_str(&existing[suffix_start..]);

    verify_pi_patch(&out, before.as_ref(), &section)?;
    Ok(out)
}

/// Render the whole `llm-pi-ai` section at the top level, so a section that
/// nests a mapping under its key stays readable in a hand-edited document.
fn render_pi_section(
    section: &serde_yaml::Mapping,
    newline: &str,
) -> Result<String, String> {
    let body = serde_yaml::to_string(&serde_yaml::Value::Mapping(section.clone()))
        .map_err(|err| format!("could not serialize the provider routes: {err}"))?;
    let mut out = format!("{PI_SECTION_KEY}:{newline}");
    for line in body.lines() {
        if line.is_empty() {
            out.push_str(newline);
        } else {
            out.push_str("  ");
            out.push_str(line);
            out.push_str(newline);
        }
    }
    Ok(out)
}

/// Re-read the patched document and refuse it unless `llm-pi-ai` says exactly
/// what the splice meant to say and no other section moved.
fn verify_pi_patch(
    patched: &str,
    before: Option<&serde_yaml::Value>,
    expected: &serde_yaml::Mapping,
) -> Result<(), String> {
    let unsafe_edit = |detail: &str| {
        format!(
            "could not update `{PI_SECTION_KEY}.{PI_PROVIDERS_KEY}` without disturbing the rest \
             of the document ({detail}); edit it by hand instead"
        )
    };

    let after: serde_yaml::Value = if patched.trim().is_empty() {
        serde_yaml::Value::Null
    } else {
        serde_yaml::from_str(patched).map_err(|err| unsafe_edit(&format!("re-parse failed: {err}")))?
    };

    let section_key = serde_yaml::Value::String(PI_SECTION_KEY.to_string());
    let stored = match after
        .as_mapping()
        .and_then(|map| map.get(&section_key))
    {
        None | Some(serde_yaml::Value::Null) => None,
        Some(value) => Some(value.clone()),
    };
    let wanted = if expected.is_empty() {
        None
    } else {
        Some(serde_yaml::Value::Mapping(expected.clone()))
    };
    if stored != wanted {
        return Err(unsafe_edit("the provider routes did not land where they were aimed"));
    }

    // Nothing outside the section moved.
    let without = |value: Option<&serde_yaml::Value>| -> serde_yaml::Mapping {
        let mut map = match value {
            Some(serde_yaml::Value::Mapping(map)) => map.clone(),
            _ => serde_yaml::Mapping::new(),
        };
        map.remove(&section_key);
        map
    };
    if without(before) != without(Some(&after)) {
        return Err(unsafe_edit("another section would have changed"));
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Read the DeepSeek Harness model catalog for the settings panel. Desktop
/// command; the web handler calls [`load_deepseek_model_catalog_core`]
/// directly. Reads the filesystem only — no DB/state needed.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_load_deepseek_model_catalog() -> Result<DeepSeekModelCatalog, AcpError> {
    Ok(load_deepseek_model_catalog_core())
}

/// Store (or clear) the DeepSeek Harness model catalog. Desktop command; the
/// web handler calls [`update_deepseek_model_catalog_core`] directly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_update_deepseek_model_catalog(
    models: Option<Vec<DeepSeekCatalogModel>>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::from_app(&app);
    update_deepseek_model_catalog_core(models, &emitter)
}

/// Read the DeepSeek Harness provider routes for the settings panel. Desktop
/// command; the web handler calls [`load_deepseek_provider_routes_core`]
/// directly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_load_deepseek_provider_routes(
) -> Result<DeepSeekProviderRoutes, AcpError> {
    Ok(load_deepseek_provider_routes_core())
}

/// Store (or clear) the DeepSeek Harness provider routes. Desktop command; the
/// web handler calls [`update_deepseek_provider_routes_core`] directly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_update_deepseek_provider_routes(
    routes: Option<Vec<DeepSeekProviderRoute>>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::from_app(&app);
    update_deepseek_provider_routes_core(routes, &emitter)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> DeepSeekCatalogModel {
        DeepSeekCatalogModel {
            id: id.to_string(),
            name: Some(id.to_uppercase()),
            description: None,
            context_window: Some(1_000_000),
            max_tokens: None,
            input_modalities: None,
            image_pixel_budget: None,
            image_max_bytes: None,
            system_prompt_update: None,
            image_detail: None,
        }
    }

    fn vision(id: &str) -> DeepSeekCatalogModel {
        DeepSeekCatalogModel {
            id: id.to_string(),
            name: None,
            description: None,
            context_window: None,
            max_tokens: None,
            input_modalities: Some(vec!["text".into(), "image".into()]),
            image_pixel_budget: None,
            image_max_bytes: None,
            system_prompt_update: None,
            image_detail: None,
        }
    }

    fn models_of(raw: &str) -> Vec<DeepSeekCatalogModel> {
        read_models(raw)
            .expect("document parses")
            .expect("models present")
    }

    #[test]
    fn defaults_mirror_the_catalog_the_agents_composition_declares() {
        let defaults = default_models();
        let ids: Vec<&str> = defaults.iter().map(|m| m.id.as_str()).collect();
        // `deepseek-acp`'s own `DEEPSEEK_MODELS`, which shadows the adapter's
        // schema default. The two ids that list retires — `deepseek-v4-flash`
        // and `deepseek-v4-flash-vision-exp` — must not come back: no stock
        // launch can reach them, so offering them is offering nothing.
        assert_eq!(ids, vec!["deepseek-flash", "deepseek-v4-pro"]);

        // The default model takes images, and says so with the request limits
        // the adapter would materialize anyway. Getting this wrong is not
        // cosmetic: image admission is judged against this entry, so a
        // text-only default refuses a picture the endpoint would have taken.
        assert!(defaults[0].accepts_images());
        assert_eq!(
            defaults[0].image_pixel_budget,
            Some(DeepSeekImagePixelBudget::Pixels(640_000))
        );
        assert_eq!(defaults[0].image_max_bytes, Some(1_048_576));
        // Upstream copies this onto the same entry and warns that dropping it
        // moves the model to the other system-prompt delivery mode silently.
        assert_eq!(defaults[0].system_prompt_update.as_deref(), Some("in-history"));
        assert!(!defaults[1].accepts_images());

        // Every default has to survive the same validation a user edit does.
        validate_models(&defaults).expect("defaults are valid");
    }

    #[test]
    fn reads_the_section_and_tells_absent_from_unusable() {
        let doc = "llm-deepseek:\n  models:\n    - id: a\n      contextWindow: 128000\n";
        let models = models_of(doc);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "a");
        assert_eq!(models[0].context_window, Some(128_000));

        // Absent — either the whole section or just the key.
        assert!(read_models("").expect("empty parses").is_none());
        assert!(read_models("other: {}\n").expect("parses").is_none());
        assert!(read_models("llm-deepseek:\n  baseURL: https://x\n")
            .expect("parses")
            .is_none());
        // Present, but not something the panel may edit blind.
        assert!(read_models("llm-deepseek:\n  models: nope\n").is_err());
        assert!(read_models("llm-deepseek: 3\n").is_err());
        assert!(read_models("llm-deepseek:\n  models:\n    - id: 3\n").is_err());
        assert!(read_models("- a\n- b\n").is_err());
    }

    #[test]
    fn refuses_to_edit_entries_carrying_fields_it_would_drop() {
        // A save rewrites the whole block, so a field codeg does not model
        // would be lost. Report it instead — the panel then refuses to edit.
        let doc = "llm-deepseek:\n  models:\n    - id: a\n      futureKnob: 1\n";
        let err = read_models(doc).expect_err("unknown field is reported");
        assert!(err.contains("futureKnob"), "{err}");
        // The fields it does model are not "unknown".
        let doc = concat!(
            "llm-deepseek:\n",
            "  models:\n",
            "    - id: a\n",
            "      name: A\n",
            "      description: d\n",
            "      contextWindow: 1\n",
            "      maxTokens: 2\n",
            "      inputModalities: [text, image]\n",
            "      imagePixelBudget: 3\n",
            "      imageMaxBytes: 4\n",
            "      systemPromptUpdate: in-history\n",
            // Retired upstream, but still a key codeg itself once wrote — so it
            // stays READABLE here. Refusing it as unknown would lock the panel
            // out of exactly the documents that need repairing.
            "      imageDetail: low\n",
        );
        assert_eq!(models_of(doc).len(), 1);
    }

    #[test]
    fn refuses_a_section_that_is_not_a_mapping() {
        let existing = "llm-deepseek:\n  - a\n  - b\n";
        assert!(read_models(existing).is_err());
        assert!(patch_settings_models(existing, Some(&[model("a")])).is_err());
    }

    #[test]
    fn load_reports_missing_absent_and_unreadable_documents() {
        let dir = tempfile::tempdir().expect("tempdir");

        let missing = load_deepseek_model_catalog_at(&dir.path().join("settings.yaml"));
        assert!(!missing.exists);
        assert!(!missing.configured);
        assert!(missing.error.is_none());
        assert_eq!(missing.models, default_models());

        let inherited = dir.path().join("inherited.yaml");
        fs::write(&inherited, "other-plugin:\n  a: 1\n").expect("write");
        let inherited = load_deepseek_model_catalog_at(&inherited);
        assert!(inherited.exists);
        assert!(!inherited.configured);
        assert!(inherited.error.is_none());
        assert_eq!(inherited.models, default_models());

        let configured = dir.path().join("configured.yaml");
        fs::write(&configured, "llm-deepseek:\n  models:\n    - id: only\n").expect("write");
        let configured = load_deepseek_model_catalog_at(&configured);
        assert!(configured.configured);
        assert_eq!(configured.models.len(), 1);

        let broken = dir.path().join("broken.yaml");
        fs::write(&broken, "llm-deepseek:\n  models: 7\n").expect("write");
        let broken = load_deepseek_model_catalog_at(&broken);
        assert!(broken.exists);
        assert!(!broken.configured);
        assert!(broken.error.is_some());
        assert!(broken.invalid.is_none());
        // An unusable document still reports what a session would actually get.
        assert_eq!(broken.models, default_models());
    }

    #[test]
    fn load_reports_a_stored_list_the_agent_would_refuse() {
        // Hand-written, well-formed YAML that upstream's `resolveModels`
        // throws on: the agent keeps its last good configuration (the built-in
        // catalog), so the panel must not present this list as what a session
        // can pick.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.yaml");
        fs::write(
            &path,
            "llm-deepseek:\n  models:\n    - id: duplicate\n    - id: duplicate\n",
        )
        .expect("write");

        let stored = load_deepseek_model_catalog_at(&path);
        // Readable, so the rows stay editable — fixing them is the point.
        assert!(stored.error.is_none());
        assert!(stored.configured);
        assert_eq!(stored.models.len(), 2);
        let invalid = stored.invalid.expect("the duplicate is reported");
        assert!(invalid.contains("duplicate"), "{invalid}");

        // The same document with the duplicate resolved reports nothing.
        fs::write(
            &path,
            "llm-deepseek:\n  models:\n    - id: one\n    - id: two\n",
        )
        .expect("write");
        assert!(load_deepseek_model_catalog_at(&path).invalid.is_none());
    }

    #[test]
    fn validation_mirrors_the_adapters_own_rules() {
        assert!(validate_models(&[model("a"), model("b")]).is_ok());

        let blank = DeepSeekCatalogModel {
            id: "  ".into(),
            ..model("a")
        };
        assert!(validate_models(&[blank]).is_err());
        assert!(validate_models(&[model("a"), model("a")]).is_err());

        let zero = DeepSeekCatalogModel {
            context_window: Some(0),
            ..model("a")
        };
        assert!(validate_models(&[zero]).is_err());
        let huge = DeepSeekCatalogModel {
            max_tokens: Some(MAX_SAFE_INTEGER + 1),
            ..model("a")
        };
        assert!(validate_models(&[huge]).is_err());

        let empty_modalities = DeepSeekCatalogModel {
            input_modalities: Some(vec![]),
            ..model("a")
        };
        assert!(validate_models(&[empty_modalities]).is_err());
        let unknown_modality = DeepSeekCatalogModel {
            input_modalities: Some(vec!["audio".into()]),
            ..model("a")
        };
        assert!(validate_models(&[unknown_modality]).is_err());
        let duplicate_modality = DeepSeekCatalogModel {
            input_modalities: Some(vec!["text".into(), "text".into()]),
            ..model("a")
        };
        assert!(validate_models(&[duplicate_modality]).is_err());

        // Image limits on a text-only entry are refused by the adapter — the
        // whole section would be dropped, so they are refused here too.
        let text_only_with_limits = DeepSeekCatalogModel {
            image_max_bytes: Some(1024),
            ..model("a")
        };
        assert!(validate_models(&[text_only_with_limits]).is_err());
        let ok = DeepSeekCatalogModel {
            image_max_bytes: Some(1024),
            image_pixel_budget: Some(DeepSeekImagePixelBudget::Pixels(262_144)),
            ..vision("v")
        };
        assert!(validate_models(&[ok]).is_ok());
        let zero_budget = DeepSeekCatalogModel {
            image_pixel_budget: Some(DeepSeekImagePixelBudget::Pixels(0)),
            ..vision("v")
        };
        assert!(validate_models(&[zero_budget]).is_err());

        // The named tier the adapter accepts in place of a count, and anything
        // else spelled where it goes.
        let low = DeepSeekCatalogModel {
            image_pixel_budget: Some(DeepSeekImagePixelBudget::Named("low".into())),
            ..vision("v")
        };
        assert!(validate_models(&[low]).is_ok());
        let unknown_tier = DeepSeekCatalogModel {
            image_pixel_budget: Some(DeepSeekImagePixelBudget::Named("high".into())),
            ..vision("v")
        };
        assert!(validate_models(&[unknown_tier]).is_err());

        // `systemPromptUpdate` has exactly one legal value upstream.
        let in_history = DeepSeekCatalogModel {
            system_prompt_update: Some("in-history".into()),
            ..model("a")
        };
        assert!(validate_models(&[in_history]).is_ok());
        let other_mode = DeepSeekCatalogModel {
            system_prompt_update: Some("each-request".into()),
            ..model("a")
        };
        assert!(validate_models(&[other_mode]).is_err());
    }

    #[test]
    fn validation_refuses_the_retired_image_detail_and_names_its_replacement() {
        // `resolveModels` throws on the KEY's presence, not on its value, and a
        // section it throws on is dropped whole — one leftover `imageDetail`
        // silently takes the user's entire catalog with it. Both spellings the
        // old panel could produce have to be caught.
        for detail in ["auto", "low"] {
            let stale = DeepSeekCatalogModel {
                image_detail: Some(detail.into()),
                ..vision("v")
            };
            let err = validate_models(&[stale]).expect_err("the retired key is refused");
            assert!(err.contains("image detail"), "{err}");
            assert!(err.contains("image pixel budget"), "{err}");
        }
    }

    #[test]
    fn a_stored_image_detail_is_reported_shown_without_it_and_dropped_on_save() {
        // The full repair path for a document an older codeg wrote. Each step
        // carries its own half: the panel must be able to OPEN it (so the key
        // stays readable), must SAY it is not in effect (so nobody hunts for
        // why their models are missing), must not hand the key back to the
        // editor (which would send it straight back on save), and a save must
        // leave the document clean.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.yaml");
        fs::write(
            &path,
            concat!(
                "llm-deepseek:\n",
                "  models:\n",
                "    - id: gateway-vision\n",
                "      inputModalities: [text, image]\n",
                "      imageDetail: low\n",
            ),
        )
        .expect("write");

        let stored = load_deepseek_model_catalog_at(&path);
        assert!(stored.error.is_none(), "the document still parses");
        assert!(stored.configured);
        let invalid = stored.invalid.clone().expect("the retired key is reported");
        assert!(invalid.contains("image detail"), "{invalid}");

        // What the panel receives is the entry WITHOUT the key, so its draft
        // cannot round-trip it back into the document.
        let wire = serde_json::to_value(&stored.models).expect("serializes");
        assert_eq!(wire[0]["id"], "gateway-vision");
        assert!(
            wire[0].get("imageDetail").is_none(),
            "the retired key must not reach the panel: {wire}"
        );

        // Saving that same list back is the repair. It goes through the wire
        // shape rather than the parsed structs, because that is the only way a
        // save ever arrives — and the difference matters: the parsed entry
        // still carries the key in memory, and `validate_models` refuses it.
        let draft: Vec<DeepSeekCatalogModel> =
            serde_json::from_value(wire).expect("the panel's shape parses back");
        update_deepseek_model_catalog_at(&path, Some(draft)).expect("save");
        let repaired = load_deepseek_model_catalog_at(&path);
        assert!(repaired.invalid.is_none(), "{:?}", repaired.invalid);
        assert_eq!(repaired.models.len(), 1);
        assert!(!fs::read_to_string(&path)
            .expect("read")
            .contains("imageDetail"));
    }

    #[test]
    fn a_named_pixel_budget_and_the_prompt_update_mode_survive_a_round_trip() {
        // Both are shapes only a hand-written document (or the agent's own
        // defaults) produces — the panel has no control for the second at all.
        // Read-modify-write must give them back byte for byte, or saving an
        // unrelated edit would quietly re-tune someone's deployment.
        let doc = concat!(
            "llm-deepseek:\n",
            "  models:\n",
            "    - id: gateway-vision\n",
            "      inputModalities: [text, image]\n",
            "      imagePixelBudget: low\n",
            "      systemPromptUpdate: in-history\n",
        );
        let models = models_of(doc);
        assert_eq!(
            models[0].image_pixel_budget,
            Some(DeepSeekImagePixelBudget::Named("low".into()))
        );
        assert_eq!(models[0].system_prompt_update.as_deref(), Some("in-history"));

        let patched = patch_settings_models(doc, Some(&models)).expect("patch");
        assert_eq!(models_of(&patched), models);
        // Written as the bare word, which is what the adapter's union reads —
        // a quoted or numeric spelling would land on the other arm.
        assert!(patched.contains("imagePixelBudget: low"), "{patched}");
    }

    #[test]
    fn validation_normalizes_blank_optional_text() {
        let entry = DeepSeekCatalogModel {
            id: "  a  ".into(),
            name: Some("   ".into()),
            description: Some("  hi  ".into()),
            ..model("a")
        };
        let out = validate_models(&[entry]).expect("valid");
        assert_eq!(out[0].id, "a");
        // A blank name is stored as absent: the adapter rejects an empty one,
        // and "no name" already means "show the id".
        assert_eq!(out[0].name, None);
        assert_eq!(out[0].description.as_deref(), Some("hi"));
    }

    #[test]
    fn writes_a_fresh_document_when_none_exists() {
        let patched = patch_settings_models("", Some(&[model("a")])).expect("patch");
        assert_eq!(models_of(&patched)[0].id, "a");
        assert!(patched.starts_with("llm-deepseek:\n  models:\n    - id: a\n"));
    }

    #[test]
    fn appends_a_section_to_a_document_that_has_none() {
        let existing = "# top of file\nother-plugin:\n  a: 1\n";
        let patched = patch_settings_models(existing, Some(&[model("a")])).expect("patch");
        assert!(patched.starts_with(existing));
        assert_eq!(models_of(&patched)[0].id, "a");
    }

    #[test]
    fn inserts_the_key_into_an_existing_section_without_touching_its_others() {
        let existing = "llm-deepseek:\n  baseURL: https://gw.example.com\n  thinking: enabled\n";
        let patched = patch_settings_models(existing, Some(&[model("a")])).expect("patch");
        assert!(patched.contains("baseURL: https://gw.example.com"));
        assert!(patched.contains("thinking: enabled"));
        assert_eq!(models_of(&patched)[0].id, "a");
    }

    #[test]
    fn replaces_an_existing_block_and_keeps_every_other_byte() {
        let existing = concat!(
            "# harness settings\n",
            "llm-deepseek:\n",
            "  # the endpoint this checkout talks to\n",
            "  baseURL: https://gw.example.com\n",
            "  models:\n",
            "    - id: old\n",
            "      name: Old\n",
            "      # only write this when it really takes images\n",
            "      inputModalities: [text, image]\n",
            "  thinking: enabled\n",
            "\n",
            "other-plugin:\n",
            "  keep: me\n",
        );
        let patched = patch_settings_models(existing, Some(&[model("new")])).expect("patch");

        assert_eq!(models_of(&patched)[0].id, "new");
        // Comments and neighbours outside the replaced block survive verbatim.
        assert!(patched.starts_with("# harness settings\n"));
        assert!(patched.contains("  # the endpoint this checkout talks to\n"));
        assert!(patched.contains("  baseURL: https://gw.example.com\n"));
        assert!(patched.contains("  thinking: enabled\n"));
        assert!(patched.contains("other-plugin:\n  keep: me\n"));
        // The old entry (and the comment that lived inside its block) is gone.
        assert!(!patched.contains("id: old"));
        assert!(!patched.contains("only write this when"));
    }

    #[test]
    fn replaces_a_block_written_flush_left_under_its_key() {
        // `serde_yaml`'s own emitter writes sequences at the key's indent, so a
        // document codeg (or a script) produced looks like this.
        let existing = "llm-deepseek:\n  models:\n  - id: old\n  thinking: enabled\n";
        let patched = patch_settings_models(existing, Some(&[model("new")])).expect("patch");
        assert_eq!(models_of(&patched)[0].id, "new");
        assert!(patched.contains("  thinking: enabled\n"));
        assert!(!patched.contains("id: old"));
    }

    #[test]
    fn removes_the_key_and_keeps_the_rest_of_the_section() {
        let existing = concat!(
            "llm-deepseek:\n",
            "  baseURL: https://gw.example.com\n",
            "  models:\n",
            "    - id: old\n",
            "  thinking: enabled\n",
        );
        let patched = patch_settings_models(existing, None).expect("patch");
        assert!(read_models(&patched).expect("parses").is_none());
        assert!(patched.contains("baseURL: https://gw.example.com"));
        assert!(patched.contains("thinking: enabled"));
    }

    #[test]
    fn removes_the_whole_section_when_the_key_was_all_it_had() {
        // An empty `llm-deepseek:` resolves to null and fails the adapter's
        // schema, so the header goes with the last key.
        let existing = "llm-deepseek:\n  models:\n    - id: old\nother:\n  a: 1\n";
        let patched = patch_settings_models(existing, None).expect("patch");
        assert_eq!(patched, "other:\n  a: 1\n");
    }

    #[test]
    fn removing_from_a_document_without_the_section_is_a_no_op() {
        let existing = "other:\n  a: 1\n";
        assert_eq!(
            patch_settings_models(existing, None).expect("patch"),
            existing
        );
        assert_eq!(patch_settings_models("", None).expect("patch"), "");
    }

    #[test]
    fn refuses_an_inline_section_or_key_rather_than_guessing() {
        assert!(patch_settings_models("llm-deepseek: {baseURL: x}\n", Some(&[model("a")])).is_err());
        assert!(patch_settings_models(
            "llm-deepseek:\n  models: [{id: old}]\n",
            Some(&[model("a")])
        )
        .is_err());
    }

    #[test]
    fn refuses_a_document_it_cannot_parse() {
        assert!(patch_settings_models("a: [1,\n", Some(&[model("a")])).is_err());
        // A multi-document stream is not something the splice can reason about.
        assert!(patch_settings_models("a: 1\n---\nb: 2\n", Some(&[model("a")])).is_err());
    }

    #[test]
    fn keeps_the_documents_line_endings() {
        let existing = "llm-deepseek:\r\n  baseURL: https://x\r\n";
        let patched = patch_settings_models(existing, Some(&[model("a")])).expect("patch");
        assert!(patched.contains("  baseURL: https://x\r\n"));
        assert!(patched.contains("  models:\r\n"));
        assert!(!patched.trim_end().ends_with('\n'));
        assert_eq!(models_of(&patched)[0].id, "a");
    }

    #[test]
    fn terminates_a_final_line_that_had_no_newline() {
        let existing = "llm-deepseek:\n  baseURL: https://x";
        let patched = patch_settings_models(existing, Some(&[model("a")])).expect("patch");
        assert!(patched.contains("  baseURL: https://x\n  models:\n"));
        assert_eq!(models_of(&patched)[0].id, "a");
    }

    #[test]
    fn stores_optional_fields_only_when_they_are_set() {
        let entry = DeepSeekCatalogModel {
            id: "v".into(),
            name: Some("V".into()),
            description: None,
            context_window: None,
            max_tokens: None,
            input_modalities: Some(vec!["text".into(), "image".into()]),
            image_pixel_budget: Some(DeepSeekImagePixelBudget::Pixels(262_144)),
            image_max_bytes: None,
            system_prompt_update: None,
            image_detail: None,
        };
        let patched =
            patch_settings_models("", Some(std::slice::from_ref(&entry))).expect("patch");
        // Absent stays absent — the adapter's schema rejects an explicit null,
        // and "absent" is what selects its own default.
        assert!(!patched.contains("null"));
        assert!(!patched.contains("description"));
        assert!(!patched.contains("contextWindow"));
        assert!(!patched.contains("imageMaxBytes"));
        assert_eq!(models_of(&patched), vec![entry]);
    }

    #[test]
    fn round_trips_a_hand_written_document_verbatim() {
        // The shape a user maintaining this file by hand actually writes:
        // dotted and dated ids, a display name with CJK and parentheses, flow
        // modality lists, and a comment on the line that declares them.
        let existing = concat!(
            "# ~/.dsh/settings.yaml\n",
            "llm-deepseek:\n",
            "  models:\n",
            "    - id: deepseek-v4-flash\n",
            "      name: DeepSeek-V4-Flash\n",
            "      contextWindow: 1000000\n",
            "    - id: deepseek-v4.1-flash-expires-on-0910\n",
            "      name: DeepSeek-V4.1-Flash (内测)\n",
            "      contextWindow: 1000000\n",
            "      inputModalities: [text, image]   # 只在它确实收图时才写\n",
        );
        let models = models_of(existing);
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].name.as_deref(), Some("DeepSeek-V4.1-Flash (内测)"));
        assert!(models[1].accepts_images());

        let patched = patch_settings_models(existing, Some(&models)).expect("patch");
        // Same catalog, and the comment ABOVE the block is still there. The one
        // INSIDE it is not: the block is replaced wholesale, which is what the
        // panel's copy says it does.
        assert_eq!(models_of(&patched), models);
        assert!(patched.starts_with("# ~/.dsh/settings.yaml\n"));
        assert!(!patched.contains("只在它确实收图时才写"));
    }

    #[test]
    fn round_trips_the_shape_the_harness_documents() {
        // The agent's own catalog as it would be written out by hand.
        let existing = concat!(
            "llm-deepseek:\n",
            "  models:\n",
            "    - id: deepseek-flash\n",
            "      name: DeepSeek-V4.1-Flash\n",
            "      contextWindow: 1000000\n",
            "      inputModalities: [text, image]\n",
            "      systemPromptUpdate: in-history\n",
            "    - id: deepseek-v4-pro\n",
            "      name: DeepSeek-V4-Pro\n",
            "      contextWindow: 1000000\n",
        );
        let models = models_of(existing);
        assert_eq!(models.len(), 2);
        assert!(models[0].accepts_images());
        assert!(!models[1].accepts_images());
        // Writing them straight back leaves the same catalog in place.
        let patched = patch_settings_models(existing, Some(&models)).expect("patch");
        assert_eq!(models_of(&patched), models);
    }

    #[test]
    fn update_writes_validates_and_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("settings.yaml");

        update_deepseek_model_catalog_at(&path, Some(vec![model("a"), model("b")]))
            .expect("first write");
        let stored = load_deepseek_model_catalog_at(&path);
        assert!(stored.configured);
        assert_eq!(stored.models.len(), 2);

        // An invalid list never reaches the disk.
        let before = fs::read_to_string(&path).expect("read");
        let duplicate = update_deepseek_model_catalog_at(&path, Some(vec![model("a"), model("a")]));
        assert!(duplicate.is_err());
        assert_eq!(fs::read_to_string(&path).expect("read"), before);

        // An empty list means "inherit the defaults", same as `None`.
        update_deepseek_model_catalog_at(&path, Some(vec![])).expect("clear");
        let cleared = load_deepseek_model_catalog_at(&path);
        assert!(!cleared.configured);
        assert_eq!(cleared.models, default_models());
    }

    #[test]
    fn the_swap_leaves_no_temporary_file_behind() {
        // The swap stages in a sibling temp; a completed save must not leave it
        // in `$DSH_HOME` for the user (or a backup) to find.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.yaml");
        update_deepseek_model_catalog_at(&path, Some(vec![model("a")])).expect("write");
        update_deepseek_model_catalog_at(&path, Some(vec![model("b")])).expect("rewrite");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name != "settings.yaml")
            .collect();
        assert!(leftovers.is_empty(), "left behind {leftovers:?}");
    }

    #[test]
    fn two_saves_never_stage_into_the_same_temporary_file() {
        // Two windows saving at once would otherwise interleave their bytes in
        // one shared temp and rename a document spliced from both.
        let dir = tempfile::tempdir().expect("tempdir");
        let (first_path, first) = create_temp_file(
            dir.path(),
            "settings.yaml",
            #[cfg(unix)]
            0o600,
        )
        .expect("first temp");
        let (second_path, second) = create_temp_file(
            dir.path(),
            "settings.yaml",
            #[cfg(unix)]
            0o600,
        )
        .expect("second temp");
        assert_ne!(first_path, second_path);
        drop(first);
        drop(second);

        // A stale temp from a killed run is never written through either: the
        // name is simply retried.
        let stale = first_path.clone();
        let (fresh, _file) = create_temp_file(
            dir.path(),
            "settings.yaml",
            #[cfg(unix)]
            0o600,
        )
        .expect("third temp");
        assert_ne!(fresh, stale);
        assert!(fs::read_to_string(&stale).expect("stale kept").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlinked_document_instead_of_replacing_it() {
        // A settings.yaml symlinked elsewhere (a dotfiles checkout) must keep
        // its indirection: the rename lands on the resolved target.
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real-settings.yaml");
        let link = dir.path().join("settings.yaml");
        fs::write(&real, "other:\n  keep: me\n").expect("seed");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        update_deepseek_model_catalog_at(&link, Some(vec![model("a")])).expect("write");

        assert!(
            fs::symlink_metadata(&link)
                .expect("link")
                .file_type()
                .is_symlink(),
            "the symlink was replaced by a regular file"
        );
        let written = fs::read_to_string(&real).expect("target");
        assert!(written.contains("id: a"), "{written}");
        assert!(written.contains("keep: me"), "{written}");
    }

    #[cfg(unix)]
    #[test]
    fn creates_the_target_of_a_symlink_whose_file_does_not_exist_yet() {
        // A dotfiles checkout can link settings.yaml at a file it has not
        // written yet. The old in-place `open(O_CREAT)` created the target;
        // replacing the link instead would quietly break the setup.
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("store").join("real-settings.yaml");
        fs::create_dir_all(real.parent().expect("parent")).expect("mkdir");
        let link = dir.path().join("settings.yaml");
        // Relative link: it must resolve against the directory holding it.
        std::os::unix::fs::symlink("store/real-settings.yaml", &link).expect("symlink");

        update_deepseek_model_catalog_at(&link, Some(vec![model("a")])).expect("write");

        assert!(
            fs::symlink_metadata(&link)
                .expect("link")
                .file_type()
                .is_symlink(),
            "the dangling symlink was replaced by a regular file"
        );
        assert!(fs::read_to_string(&real).expect("target").contains("id: a"));
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_dangling_chain_that_spends_the_whole_hop_budget() {
        // Exactly as many links as the walk will follow, ending at a file that
        // does not exist yet: the last hop is the file to create, not a chain
        // to give up on.
        let dir = tempfile::tempdir().expect("tempdir");
        let head = dir.path().join("settings.yaml");
        let final_target = dir.path().join("new-settings.yaml");
        let hops: Vec<PathBuf> = (1..8).map(|i| dir.path().join(format!("l{i}"))).collect();
        std::os::unix::fs::symlink(&hops[0], &head).expect("head");
        for pair in hops.windows(2) {
            std::os::unix::fs::symlink(&pair[1], &pair[0]).expect("hop");
        }
        std::os::unix::fs::symlink(&final_target, hops.last().expect("last")).expect("tail");

        update_deepseek_model_catalog_at(&head, Some(vec![model("a")])).expect("write");
        assert!(fs::read_to_string(&final_target)
            .expect("target")
            .contains("id: a"));
        assert!(fs::symlink_metadata(&head)
            .expect("head")
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_chain_it_cannot_follow_to_the_end() {
        // The caller renames over whatever the walk returns, so giving up on a
        // long chain (or a cycle) must not mean "rename over the link I stopped
        // at" — that link can live anywhere, including outside the harness home.
        let dir = tempfile::tempdir().expect("tempdir");
        let head = dir.path().join("settings.yaml");
        // A cycle: settings.yaml -> loop-a -> loop-b -> loop-a -> …
        let a = dir.path().join("loop-a");
        let b = dir.path().join("loop-b");
        std::os::unix::fs::symlink(&a, &head).expect("head");
        std::os::unix::fs::symlink(&b, &a).expect("a");
        std::os::unix::fs::symlink(&a, &b).expect("b");

        assert!(resolve_write_target(&head).is_err());
        assert!(update_deepseek_model_catalog_at(&head, Some(vec![model("a")])).is_err());
        // Every link in the cycle is still a link, and nothing was created.
        for link in [&head, &a, &b] {
            assert!(fs::symlink_metadata(link)
                .expect("link")
                .file_type()
                .is_symlink());
        }
        let created: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| !matches!(name.as_str(), "settings.yaml" | "loop-a" | "loop-b"))
            .collect();
        assert!(created.is_empty(), "left behind {created:?}");
    }

    #[cfg(unix)]
    #[test]
    fn creates_the_document_owner_only_under_an_owner_only_home() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("dsh-home");
        let path = home.join("settings.yaml");

        update_deepseek_model_catalog_at(&path, Some(vec![model("a")])).expect("write");
        assert_eq!(
            fs::metadata(&home).expect("home").permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).expect("file").permissions().mode() & 0o777,
            0o600
        );

        // An existing world-readable document is repaired on the next write,
        // but a deliberately group-shared one is left alone.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod");
        update_deepseek_model_catalog_at(&path, Some(vec![model("b")])).expect("rewrite");
        assert_eq!(
            fs::metadata(&path).expect("file").permissions().mode() & 0o007,
            0
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).expect("chmod");
        update_deepseek_model_catalog_at(&path, Some(vec![model("c")])).expect("rewrite");
        assert_eq!(
            fs::metadata(&path).expect("file").permissions().mode() & 0o777,
            0o640
        );
    }

    // ── provider routes ──────────────────────────────────────────────────

    fn route(id: &str) -> DeepSeekProviderRoute {
        DeepSeekProviderRoute {
            id: id.to_string(),
            display_name: None,
            api_key_env: None,
            api: None,
            base_url: None,
        }
    }

    fn written(path: &Path, routes: &[DeepSeekProviderRoute]) -> String {
        update_deepseek_provider_routes_at(path, &[], Some(routes)).expect("write routes");
        fs::read_to_string(path).expect("document")
    }

    fn yaml_at<'a>(root: &'a serde_yaml::Value, path: &[&str]) -> &'a serde_yaml::Value {
        let mut current = root;
        for key in path {
            current = match current {
                serde_yaml::Value::Sequence(items) => items
                    .get(key.parse::<usize>().expect("sequence index"))
                    .unwrap_or_else(|| panic!("missing {key} in {current:?}")),
                _ => current
                    .as_mapping()
                    .and_then(|map| map.get(serde_yaml::Value::String((*key).to_string())))
                    .unwrap_or_else(|| panic!("missing {key} in {current:?}")),
            };
        }
        current
    }

    #[test]
    fn reads_routes_from_the_bridge_document() {
        let raw = "llm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY\n";
        let profiles = read_pi_providers(raw)
            .expect("parses")
            .expect("section present");
        let routes = routes_from_profiles(&profiles).expect("routes");
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].id, "opencode-go");
        assert_eq!(routes[0].api_key_env.as_deref(), Some("OPENCODE_GO_API_KEY"));
        assert!(routes[0].api.is_none());
        assert!(routes[0].base_url.is_none());

        // A section-level key this panel does not own is fine; a `providers:`
        // that is not a mapping is not.
        assert!(read_pi_providers("llm-pi-ai:\n  providers: nope\n").is_err());
        assert!(read_pi_providers("llm-pi-ai: 3\n").is_err());
        // A route profile that is a scalar cannot be edited blind.
        assert!(
            read_pi_providers("llm-pi-ai:\n  providers:\n    x: 1\n")
                .expect("parses")
                .map(|profiles| routes_from_profiles(&profiles))
                .transpose()
                .is_err()
        );
        // A field with the wrong type is reported rather than guessed at.
        assert!(
            read_pi_providers("llm-pi-ai:\n  providers:\n    x:\n      apiKeyEnv: [a]\n")
                .expect("parses")
                .map(|profiles| routes_from_profiles(&profiles))
                .transpose()
                .is_err()
        );
        // Absent in every spelling the panel may meet.
        assert!(read_pi_providers("").expect("empty").is_none());
        assert!(read_pi_providers("other: {}\n").expect("parses").is_none());
        assert!(read_pi_providers("llm-pi-ai:\n").expect("parses").is_none());
    }

    #[test]
    fn a_legacy_document_is_read_until_the_bridge_has_its_own() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = dir.path().join("deepseek-acp").join("settings.yaml");
        let legacy = dir.path().join("settings.yaml");
        let imported = dir.path().join("settings.yaml.imported");
        fs::write(
            &legacy,
            "llm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY\n",
        )
        .expect("legacy document");
        let roots = [legacy.clone(), imported.clone()];

        let view = load_deepseek_provider_routes_at(&bridge, &roots);
        assert!(!view.exists);
        assert!(view.configured);
        assert_eq!(view.routes.len(), 1);
        assert_eq!(view.routes[0].id, "opencode-go");
        assert_eq!(
            view.source.as_deref(),
            Some(legacy.display().to_string().as_str())
        );

        // An existing bridge document is authoritative even when it declares
        // nothing: that is the point at which the bridge stops importing.
        fs::create_dir_all(bridge.parent().expect("parent")).expect("dirs");
        fs::write(&bridge, "llm-pi-ai: {}\n").expect("bridge document");
        let view = load_deepseek_provider_routes_at(&bridge, &roots);
        assert!(view.exists);
        assert!(!view.configured);
        assert!(view.routes.is_empty());
        assert!(view.source.is_some());

        // `settings.yaml.imported` is the second legacy fallback.
        fs::remove_file(&bridge).expect("remove");
        fs::remove_file(&legacy).expect("remove");
        fs::write(
            &imported,
            "llm-pi-ai:\n  providers:\n    opencode:\n      apiKeyEnv: OPENCODE_API_KEY\n",
        )
        .expect("imported document");
        let view = load_deepseek_provider_routes_at(&bridge, &roots);
        assert_eq!(view.routes[0].id, "opencode");
        assert_eq!(
            view.source.as_deref(),
            Some(imported.display().to_string().as_str())
        );

        // An EMPTY section in the first legacy file still ends the search: the
        // bridge imports that file and never reads the next one, so the panel
        // must not show routes no session can pick.
        fs::write(&legacy, "llm-pi-ai:\n  providers:\n").expect("legacy");
        let view = load_deepseek_provider_routes_at(&bridge, &roots);
        assert!(!view.configured);
        assert!(view.routes.is_empty());
        assert_eq!(
            view.source.as_deref(),
            Some(legacy.display().to_string().as_str())
        );
    }

    #[test]
    fn a_save_keeps_the_rest_of_the_document_and_unmodelled_profile_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("deepseek-acp").join("settings.yaml");
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        fs::write(
            &path,
            r#"# hand-written
llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OLD_KEY
      models:
        - id: deepseek-v4.1-flash
      compat:
        thinkingFormat: deepseek
llm-deepseek:
  models:
    - id: keep-me
"#,
        )
        .expect("document");

        let mut route = route("opencode-go");
        route.api_key_env = Some("NEW_KEY".to_string());
        let saved = written(&path, &[route]);

        // The comment and the sibling section survive.
        assert!(saved.contains("# hand-written"));
        assert!(saved.contains("keep-me"));

        let doc: serde_yaml::Value = serde_yaml::from_str(&saved).expect("parses");
        let profile = yaml_at(
            &doc,
            &["llm-pi-ai", "providers", "opencode-go"],
        );
        assert_eq!(
            yaml_at(profile, &["apiKeyEnv"]).as_str(),
            Some("NEW_KEY")
        );
        // Fields this panel does not model ride along untouched.
        assert_eq!(
            yaml_at(profile, &["models", "0", "id"]).as_str(),
            Some("deepseek-v4.1-flash")
        );
        assert_eq!(
            yaml_at(profile, &["compat", "thinkingFormat"]).as_str(),
            Some("deepseek")
        );
    }

    #[test]
    fn clearing_the_last_route_drops_the_section_but_not_its_neighbours() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("deepseek-acp").join("settings.yaml");
        fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        let first = written(&path, &[route("opencode-go")]);
        assert!(first.contains("llm-pi-ai:"));

        update_deepseek_provider_routes_at(&path, &[], None).expect("clear");
        let cleared = fs::read_to_string(&path).expect("document");
        assert!(!cleared.contains("llm-pi-ai"));

        // A save that only edits a different document must not touch this one.
        fs::write(
            &path,
            "llm-deepseek:\n  models:\n    - id: keep\n",
        )
        .expect("document");
        update_deepseek_provider_routes_at(&path, &[], None).expect("no-op");
        assert_eq!(
            fs::read_to_string(&path).expect("document"),
            "llm-deepseek:\n  models:\n    - id: keep\n"
        );
    }

    #[test]
    fn the_first_save_moves_imported_routes_into_the_bridge_document() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = dir.path().join("deepseek-acp").join("settings.yaml");
        let legacy = dir.path().join("settings.yaml");
        fs::write(
            &legacy,
            r#"llm-pi-ai:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_API_KEY
      compat:
        thinkingFormat: deepseek
"#,
        )
        .expect("legacy");

        let mut route = route("opencode-go");
        route.api_key_env = Some("OPENCODE_GO_API_KEY".to_string());
        update_deepseek_provider_routes_at(
            &bridge,
            std::slice::from_ref(&legacy),
            Some(&[route]),
        )
        .expect("write");

        let saved = fs::read_to_string(&bridge).expect("bridge document");
        let doc: serde_yaml::Value = serde_yaml::from_str(&saved).expect("parses");
        let profile = yaml_at(&doc, &["llm-pi-ai", "providers", "opencode-go"]);
        assert_eq!(
            yaml_at(profile, &["apiKeyEnv"]).as_str(),
            Some("OPENCODE_GO_API_KEY")
        );
        // The legacy profile's unmodelled fields came along.
        assert_eq!(
            yaml_at(profile, &["compat", "thinkingFormat"]).as_str(),
            Some("deepseek")
        );
        // The legacy file is read-only to us.
        assert!(!fs::read_to_string(&legacy)
            .expect("legacy")
            .is_empty());
    }

    #[test]
    fn clearing_imported_routes_shadows_the_legacy_document() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = dir.path().join("deepseek-acp").join("settings.yaml");
        let legacy = dir.path().join("settings.yaml");
        fs::write(
            &legacy,
            "llm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY\n",
        )
        .expect("legacy");

        // Before the save the panel shows the imported route.
        let view = load_deepseek_provider_routes_at(&bridge, std::slice::from_ref(&legacy));
        assert!(view.configured);
        assert_eq!(view.routes.len(), 1);

        update_deepseek_provider_routes_at(&bridge, std::slice::from_ref(&legacy), None)
            .expect("clear");

        // The bridge document now exists with an empty section, which shadows
        // the legacy file the agent would otherwise import.
        let saved = fs::read_to_string(&bridge).expect("bridge document");
        assert!(saved.contains("llm-pi-ai: {}"), "{saved}");
        let view = load_deepseek_provider_routes_at(&bridge, std::slice::from_ref(&legacy));
        assert!(view.exists);
        assert!(!view.configured);
        assert!(view.routes.is_empty());

        // The legacy file is read-only to us.
        assert!(fs::read_to_string(&legacy)
            .expect("legacy")
            .contains("opencode-go"));
    }

    #[test]
    fn validation_rejects_routes_the_agent_cannot_address() {
        assert!(validate_provider_routes(&[route("")]).is_err());
        assert!(validate_provider_routes(&[route("  ")]).is_err());
        assert!(validate_provider_routes(&[route("dup"), route("dup")]).is_err());
        // pi-ai takes any non-empty route key; only a stored sign-in needs the
        // credential-key grammar, so a hand-declared gateway id is served.
        assert!(validate_provider_routes(&[route("my_gateway")]).is_ok());
        assert!(validate_provider_routes(&[route("OpenCode")]).is_ok());

        let mut bad = route("ok");
        bad.api_key_env = Some("not a ref".to_string());
        assert!(validate_provider_routes(std::slice::from_ref(&bad)).is_err());
        bad.api_key_env = None;
        bad.api = Some("bedrock-converse-stream".to_string());
        assert!(validate_provider_routes(std::slice::from_ref(&bad)).is_err());
        // Every protocol `supportedProtocols()` lists is accepted.
        for api in PI_PROTOCOLS {
            bad.api = Some((*api).to_string());
            assert!(
                validate_provider_routes(std::slice::from_ref(&bad)).is_ok(),
                "{api}"
            );
        }
        bad.api = Some("openai-completions".to_string());
        bad.base_url = Some("ftp://gateway/v1".to_string());
        assert!(validate_provider_routes(std::slice::from_ref(&bad)).is_err());
        bad.base_url = Some("https://user:pw@gateway/v1".to_string());
        assert!(validate_provider_routes(std::slice::from_ref(&bad)).is_err());
        bad.base_url = Some("https://gateway/v1?x=1".to_string());
        assert!(validate_provider_routes(std::slice::from_ref(&bad)).is_err());

        // Trimmed on the way in, and the wire fields survive.
        bad.base_url = Some("  https://gateway/v1  ".to_string());
        bad.display_name = Some("  Gateway  ".to_string());
        let valid = validate_provider_routes(&[bad]).expect("valid");
        assert_eq!(valid[0].base_url.as_deref(), Some("https://gateway/v1"));
        assert_eq!(valid[0].display_name.as_deref(), Some("Gateway"));
        assert!(validate_provider_routes(&[route("ok")]).is_ok());
    }

    #[test]
    fn legacy_routes_take_the_bridges_provider_renames() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = dir.path().join("deepseek-acp").join("settings.yaml");
        let legacy = dir.path().join("settings.yaml");
        fs::write(
            &legacy,
            r#"llm-pi-ai:
  providers:
    azure-openai-responses:
      apiKeyEnv: AZURE_OPENAI_API_KEY
      headers:
        x-team: platform
    opencode-go:
      apiKeyEnv: OPENCODE_API_KEY
"#,
        )
        .expect("legacy");
        let roots = std::slice::from_ref(&legacy);

        // The panel shows the route under the id the bridge serves it as.
        let view = load_deepseek_provider_routes_at(&bridge, roots);
        let ids: Vec<&str> = view.routes.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["opencode-go", "azure"]);
        assert!(view.invalid.is_none(), "{:?}", view.invalid);

        // The first save carries the renamed profile's unmodelled fields over.
        update_deepseek_provider_routes_at(&bridge, roots, Some(&view.routes)).expect("write");
        let saved = fs::read_to_string(&bridge).expect("bridge document");
        let doc: serde_yaml::Value = serde_yaml::from_str(&saved).expect("parses");
        assert_eq!(
            yaml_at(&doc, &["llm-pi-ai", "providers", "azure", "headers", "x-team"]).as_str(),
            Some("platform")
        );
        assert!(!saved.contains("azure-openai-responses"), "{saved}");

        // When both ids are present the new one wins and the old one is dropped.
        let mut both = serde_yaml::Mapping::new();
        both.insert("azure-openai-responses".into(), "old".into());
        both.insert("azure".into(), "new".into());
        let upgraded = upgrade_legacy_profiles(both);
        assert_eq!(upgraded.len(), 1);
        assert_eq!(upgraded.get("azure").and_then(|v| v.as_str()), Some("new"));
    }

    #[test]
    fn routes_can_be_added_again_after_clearing_imported_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = dir.path().join("deepseek-acp").join("settings.yaml");
        let legacy = dir.path().join("settings.yaml");
        fs::write(
            &legacy,
            "llm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_API_KEY\n",
        )
        .expect("legacy");
        let roots = std::slice::from_ref(&legacy);

        // Clearing imported routes leaves `llm-pi-ai: {}` behind …
        update_deepseek_provider_routes_at(&bridge, roots, None).expect("clear");
        assert!(fs::read_to_string(&bridge)
            .expect("bridge")
            .contains("llm-pi-ai: {}"));

        // … which the next save must be able to replace.
        let mut route = route("openrouter");
        route.api_key_env = Some("OPENROUTER_API_KEY".to_string());
        update_deepseek_provider_routes_at(&bridge, roots, Some(&[route])).expect("re-add");
        let view = load_deepseek_provider_routes_at(&bridge, roots);
        let ids: Vec<&str> = view.routes.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["openrouter"]);

        // A null inline section is just as empty; a non-empty one stays refused.
        let patched = patch_pi_providers("other: 1\nllm-pi-ai: ~\n", Some(&{
            let mut providers = serde_yaml::Mapping::new();
            providers.insert("xai".into(), serde_yaml::Value::Mapping(Default::default()));
            providers
        }))
        .expect("null inline section");
        assert!(patched.starts_with("other: 1\nllm-pi-ai:\n"), "{patched}");
    }

    #[test]
    fn a_malformed_legacy_providers_table_still_ends_the_import_search() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bridge = dir.path().join("deepseek-acp").join("settings.yaml");
        let legacy = dir.path().join("settings.yaml");
        let imported = dir.path().join("settings.yaml.imported");
        // The bridge imports the first file (its section is a mapping) and
        // fails on it; it never reads the second.
        fs::write(&legacy, "llm-pi-ai:\n  providers: []\n").expect("legacy");
        fs::write(
            &imported,
            "llm-pi-ai:\n  providers:\n    opencode:\n      apiKeyEnv: OPENCODE_API_KEY\n",
        )
        .expect("imported");
        let roots = [legacy.clone(), imported.clone()];

        let view = load_deepseek_provider_routes_at(&bridge, &roots);
        assert!(view.error.is_some(), "{view:?}");
        assert!(view.routes.is_empty());
        assert_eq!(
            view.source.as_deref(),
            Some(legacy.display().to_string().as_str())
        );
        assert!(legacy_pi_profiles(&roots).is_none());

        // A section the bridge cannot read as a mapping is skipped, as before.
        fs::write(&legacy, "llm-pi-ai: 3\n").expect("legacy");
        let view = load_deepseek_provider_routes_at(&bridge, &roots);
        assert!(view.error.is_none(), "{view:?}");
        assert_eq!(view.routes[0].id, "opencode");
    }

    #[test]
    fn an_inline_section_is_refused_rather_than_rewritten() {
        let error = patch_pi_providers(
            "llm-pi-ai: {providers: {}}\n",
            Some(&serde_yaml::Mapping::new()),
        )
        .expect_err("inline section");
        assert!(error.contains("inline"), "{error}");
    }
}
