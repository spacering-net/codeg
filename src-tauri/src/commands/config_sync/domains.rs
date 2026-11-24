//! The single table of configuration domains a snapshot carries.
//!
//! Collection ([`super::snapshot::collect_snapshot_core`]) and application
//! ([`super::snapshot::apply_snapshot_core`]) both iterate [`CONFIG_DOMAINS`],
//! so a domain cannot be collected without an applier or vice versa — the
//! failure mode `commands/backup/sections.rs` documents (two hand-kept lists
//! drifting until a whole section silently stopped travelling) is structurally
//! impossible here.
//!
//! Two rules the DTOs below encode:
//!
//! 1. **Field denylists are types, not filters.** A snapshot is plaintext on
//!    someone's WebDAV share the moment it is uploaded, so device-local fields
//!    (`installed_version`, `skills_dir`) and identity columns (`id`,
//!    `created_at`, `updated_at`) are simply absent from the DTO. There is no
//!    "strip it on the way out" step that a future refactor can skip.
//! 2. **Rows are matched by natural key, never by id.** Applying a snapshot
//!    upserts: matched rows are updated, unmatched rows are inserted, and rows
//!    the snapshot does not mention are LEFT ALONE. Wiping the table would
//!    renumber autoincrement ids and break `agent_setting.model_provider_id`,
//!    and would turn "bring my config over" into "make this machine a clone".

use chrono::Utc;
use futures::future::BoxFuture;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, DatabaseTransaction,
    EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, Set,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::portable_keys::{is_portable_key, PORTABLE_PREFERENCE_KEYS};
use crate::acp::delegation::types::AgentDelegationDefaults;
use crate::app_error::AppCommandError;
use crate::db::entities::{
    agent_setting, app_metadata, custom_agent, model_provider, quick_message, work_task_template,
};
use crate::db::service::personal_agent_service as pa_service;
use crate::db::service::{app_metadata_service, assistant_service};
use crate::models::personal_agent_bots::BotAvatar;
use crate::models::{
    AgentType, AssistantAgentConfig, AssistantAvatar, AssistantDraft, AssistantLabelSnapshot,
};

pub const DOMAIN_MODEL_PROVIDERS: &str = "modelProviders";
pub const DOMAIN_AGENT_SETTINGS: &str = "agentSettings";
pub const DOMAIN_CUSTOM_AGENTS: &str = "customAgents";
pub const DOMAIN_ASSISTANTS: &str = "assistants";
pub const DOMAIN_QUICK_MESSAGES: &str = "quickMessages";
pub const DOMAIN_TASK_TEMPLATES: &str = "taskTemplates";
pub const DOMAIN_PREFERENCES: &str = "preferences";
pub const DOMAIN_APPEARANCE: &str = "appearance";

type CollectFn =
    for<'a> fn(&'a DatabaseConnection) -> BoxFuture<'a, Result<Value, AppCommandError>>;
type ApplyFn = for<'a> fn(
    &'a DatabaseTransaction,
    &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>>;

/// What applying one domain wrote.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DomainApplied {
    pub written: usize,
    /// Entries written under another name than the snapshot's, to keep a name
    /// that must be unique free (assistants).
    pub renamed: usize,
    /// Assistants matched whose persona is their own `SOUL.md` and stays,
    /// the snapshot's another.
    pub persona_kept: usize,
}

impl From<usize> for DomainApplied {
    fn from(written: usize) -> Self {
        Self {
            written,
            renamed: 0,
            persona_kept: 0,
        }
    }
}
type ValidateFn = fn(&Value) -> Result<(), AppCommandError>;
type CountFn = fn(&Value) -> usize;

/// One configuration domain: how it is read out of the local database, how it
/// is checked before anything is written, and how it is written back in.
pub struct ConfigDomain {
    /// Stable snapshot key. Never rename: older snapshots are matched by it.
    pub id: &'static str,
    pub collect: CollectFn,
    /// The decode half of [`Self::apply`], without the database. It exists so
    /// a file can be REFUSED at preview time instead of failing halfway
    /// through an apply: the envelope being well-formed JSON says nothing
    /// about the domain payloads inside it, and a hand-edited export happily
    /// previews "3 providers" and then aborts on the third.
    ///
    /// Each one runs the same `decode_rows::<Dto>` call its applier opens with,
    /// against the same DTO type; `validate_matches_apply` holds the two
    /// together.
    pub validate: ValidateFn,
    /// How many entries [`Self::apply`] would write. Beside the applier rather
    /// than derived from the JSON container, because the two are not the same
    /// number: `preferences` is an object whose non-portable and non-string
    /// members are skipped on the way in, so counting its keys promises the
    /// confirmation dialog rows that the import will not write.
    pub count: CountFn,
    pub apply: ApplyFn,
}

/// Domain order IS application order. `modelProviders` must precede
/// `agentSettings`: an agent setting references its provider by natural key
/// and the applier resolves that to a local id, which only works once the
/// provider row exists. `assistants` follows `customAgents`, whose agents an
/// assistant may run on.
pub const CONFIG_DOMAINS: &[ConfigDomain] = &[
    ConfigDomain {
        id: DOMAIN_MODEL_PROVIDERS,
        collect: collect_model_providers,
        validate: validate_model_providers,
        count: count_rows,
        apply: apply_model_providers,
    },
    ConfigDomain {
        id: DOMAIN_AGENT_SETTINGS,
        collect: collect_agent_settings,
        validate: validate_agent_settings,
        count: count_rows,
        apply: apply_agent_settings,
    },
    ConfigDomain {
        id: DOMAIN_CUSTOM_AGENTS,
        collect: collect_custom_agents,
        validate: validate_custom_agents,
        count: count_rows,
        apply: apply_custom_agents,
    },
    ConfigDomain {
        id: DOMAIN_ASSISTANTS,
        collect: collect_assistants,
        validate: validate_assistants,
        count: count_assistants,
        apply: apply_assistants,
    },
    ConfigDomain {
        id: DOMAIN_QUICK_MESSAGES,
        collect: collect_quick_messages,
        validate: validate_quick_messages,
        count: count_rows,
        apply: apply_quick_messages,
    },
    ConfigDomain {
        id: DOMAIN_TASK_TEMPLATES,
        collect: collect_task_templates,
        validate: validate_task_templates,
        count: count_rows,
        apply: apply_task_templates,
    },
    ConfigDomain {
        id: DOMAIN_PREFERENCES,
        collect: collect_preferences,
        validate: validate_preferences,
        count: count_portable_preferences,
        apply: apply_preferences,
    },
    // The webview's localStorage appearance settings, via their database
    // mirror — see `appearance`.
    ConfigDomain {
        id: DOMAIN_APPEARANCE,
        collect: super::appearance::collect_appearance,
        validate: super::appearance::validate_appearance,
        count: super::appearance::count_appearance,
        apply: super::appearance::apply_appearance,
    },
];

fn validate_model_providers(value: &Value) -> Result<(), AppCommandError> {
    // A synced Codex row's model config reaches codex's files on the next
    // bind or provider edit, so it passes the checks a provider saved in the
    // settings page does. Other agents' rows keep the lenient decode: older
    // rows predate some of those checks and must still import.
    for row in decode_rows::<ModelProviderDto>(DOMAIN_MODEL_PROVIDERS, value)? {
        if row.agent_type == "codex" {
            crate::commands::model_provider::validate_model(&row.agent_type, row.model.as_deref())?;
        }
    }
    Ok(())
}

fn validate_agent_settings(value: &Value) -> Result<(), AppCommandError> {
    decode_rows::<AgentSettingDto>(DOMAIN_AGENT_SETTINGS, value).map(drop)
}

fn validate_custom_agents(value: &Value) -> Result<(), AppCommandError> {
    decode_rows::<CustomAgentDto>(DOMAIN_CUSTOM_AGENTS, value).map(drop)
}

fn validate_quick_messages(value: &Value) -> Result<(), AppCommandError> {
    decode_rows::<QuickMessageDto>(DOMAIN_QUICK_MESSAGES, value).map(drop)
}

fn validate_task_templates(value: &Value) -> Result<(), AppCommandError> {
    decode_rows::<TaskTemplateDto>(DOMAIN_TASK_TEMPLATES, value).map(drop)
}

/// `preferences` has no shape to decode: the applier walks whatever object it
/// is handed, skips non-portable keys and non-string values, and treats a
/// non-object as carrying nothing. Anything this accepts, the applier accepts
/// too — which is precisely the agreement the pair has to keep.
fn validate_preferences(_value: &Value) -> Result<(), AppCommandError> {
    Ok(())
}

/// Row domains apply every element they decode, so the list length is the
/// answer.
fn count_rows(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.len(),
        _ => 0,
    }
}

/// `preferences` does not. Its applier skips keys outside the portable
/// allowlist and values that are not strings, so the key count overstates what
/// an import writes — `{"appearanceMode":"dark","githubAccounts":"…"}` previews
/// as two and applies one. `count_matches_apply_on_every_domain` keeps this
/// filter and the applier's from drifting apart.
fn count_portable_preferences(value: &Value) -> usize {
    match value {
        Value::Object(map) => map
            .iter()
            .filter(|(key, entry)| is_portable_key(key) && entry.is_string())
            .count(),
        _ => 0,
    }
}

/// How many entries applying this domain would write. Domains this build does
/// not know are not applied at all, so they count for nothing rather than for
/// however many elements they happen to contain.
pub fn count_entries(id: &str, value: &Value) -> usize {
    CONFIG_DOMAINS
        .iter()
        .find(|domain| domain.id == id)
        .map_or(0, |domain| (domain.count)(value))
}

fn db_err(err: sea_orm::DbErr) -> AppCommandError {
    AppCommandError::db(crate::db::error::DbError::from(err))
}

fn encode<T: Serialize>(rows: Vec<T>) -> Result<Value, AppCommandError> {
    serde_json::to_value(rows).map_err(|e| {
        AppCommandError::task_execution_failed("Serialize config domain").with_detail(e.to_string())
    })
}

fn decode_rows<T: DeserializeOwned>(domain: &str, value: &Value) -> Result<Vec<T>, AppCommandError> {
    // A domain missing from an older snapshot is not an error; it simply
    // carries nothing.
    if value.is_null() {
        return Ok(Vec::new());
    }
    serde_json::from_value(value.clone()).map_err(|e| {
        AppCommandError::invalid_input(format!("Snapshot domain '{domain}' is malformed"))
            .with_detail(e.to_string())
    })
}

// ─── modelProviders ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderDto {
    pub name: String,
    pub api_url: String,
    pub api_key: String,
    #[serde(default)]
    pub agent_types_json: String,
    pub agent_type: String,
    #[serde(default)]
    pub model: Option<String>,
}

fn collect_model_providers(
    conn: &DatabaseConnection,
) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let rows = model_provider::Entity::find()
            .order_by_asc(model_provider::Column::Id)
            .all(conn)
            .await
            .map_err(db_err)?;
        encode(
            rows.into_iter()
                .map(|m| ModelProviderDto {
                    name: m.name,
                    api_url: m.api_url,
                    api_key: m.api_key,
                    agent_types_json: m.agent_types_json,
                    agent_type: m.agent_type,
                    model: m.model,
                })
                .collect::<Vec<_>>(),
        )
    })
}

/// `model_provider` has no unique index (verified against the migrations), so
/// `(agent_type, name)` can legitimately match more than one row. Updating the
/// lowest id and leaving the rest untouched is arbitrary but deterministic —
/// preferable to guessing which duplicate the user meant.
async fn find_provider(
    tx: &DatabaseTransaction,
    agent_type: &str,
    name: &str,
) -> Result<Option<model_provider::Model>, AppCommandError> {
    model_provider::Entity::find()
        .filter(model_provider::Column::AgentType.eq(agent_type))
        .filter(model_provider::Column::Name.eq(name))
        .order_by_asc(model_provider::Column::Id)
        .one(tx)
        .await
        .map_err(db_err)
}

fn apply_model_providers<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        let rows: Vec<ModelProviderDto> = decode_rows(DOMAIN_MODEL_PROVIDERS, value)?;
        let now = Utc::now();
        let mut applied = 0usize;
        for dto in rows {
            match find_provider(tx, &dto.agent_type, &dto.name).await? {
                Some(existing) => {
                    let mut active = existing.into_active_model();
                    active.api_url = Set(dto.api_url);
                    active.api_key = Set(dto.api_key);
                    active.agent_types_json = Set(dto.agent_types_json);
                    active.model = Set(dto.model);
                    active.updated_at = Set(now);
                    active.update(tx).await.map_err(db_err)?;
                }
                None => {
                    model_provider::ActiveModel {
                        id: NotSet,
                        name: Set(dto.name),
                        api_url: Set(dto.api_url),
                        api_key: Set(dto.api_key),
                        agent_types_json: Set(dto.agent_types_json),
                        agent_type: Set(dto.agent_type),
                        model: Set(dto.model),
                        created_at: Set(now),
                        updated_at: Set(now),
                    }
                    .insert(tx)
                    .await
                    .map_err(db_err)?;
                }
            }
            applied += 1;
        }
        Ok(applied.into())
    })
}

// ─── agentSettings ────────────────────────────────────────────────────

/// A provider referenced by its natural key rather than its local row id —
/// ids are per-machine and would point at a different provider (or nothing)
/// after travelling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRefDto {
    pub agent_type: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingDto {
    pub agent_type: String,
    #[serde(default)]
    pub registry_id: String,
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i32,
    #[serde(default)]
    pub env_json: Option<String>,
    /// Absent when the setting uses no provider, or when the referenced
    /// provider row was gone at collection time.
    #[serde(default)]
    pub provider: Option<ProviderRefDto>,
}

fn collect_agent_settings(
    conn: &DatabaseConnection,
) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let rows = agent_setting::Entity::find()
            .order_by_asc(agent_setting::Column::Id)
            .all(conn)
            .await
            .map_err(db_err)?;
        let providers = model_provider::Entity::find()
            .all(conn)
            .await
            .map_err(db_err)?;
        let mut dtos = Vec::with_capacity(rows.len());
        for row in rows {
            let provider = row.model_provider_id.and_then(|pid| {
                providers
                    .iter()
                    .find(|p| p.id == pid)
                    .map(|p| ProviderRefDto {
                        agent_type: p.agent_type.clone(),
                        name: p.name.clone(),
                    })
            });
            dtos.push(AgentSettingDto {
                agent_type: row.agent_type,
                registry_id: row.registry_id,
                enabled: row.enabled,
                sort_order: row.sort_order,
                env_json: row.env_json,
                provider,
            });
        }
        encode(dtos)
    })
}

fn apply_agent_settings<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        let rows: Vec<AgentSettingDto> = decode_rows(DOMAIN_AGENT_SETTINGS, value)?;
        let now = Utc::now();
        let mut applied = 0usize;
        for dto in rows {
            // Remap the provider reference to a LOCAL id. An unresolvable
            // reference degrades to "no provider" rather than failing the
            // whole apply: the setting itself is still worth carrying over.
            let mut provider_id = None;
            if let Some(reference) = &dto.provider {
                provider_id = find_provider(tx, &reference.agent_type, &reference.name)
                    .await?
                    .map(|p| p.id);
            }

            let existing = agent_setting::Entity::find()
                .filter(agent_setting::Column::AgentType.eq(dto.agent_type.clone()))
                .one(tx)
                .await
                .map_err(db_err)?;

            match existing {
                Some(existing) => {
                    let mut active = existing.into_active_model();
                    if !dto.registry_id.is_empty() {
                        active.registry_id = Set(dto.registry_id);
                    }
                    active.enabled = Set(dto.enabled);
                    active.sort_order = Set(dto.sort_order);
                    active.env_json = Set(dto.env_json);
                    active.model_provider_id = Set(provider_id);
                    active.updated_at = Set(now);
                    active.update(tx).await.map_err(db_err)?;
                }
                None => {
                    let registry_id = if dto.registry_id.is_empty() {
                        dto.agent_type.clone()
                    } else {
                        dto.registry_id
                    };
                    agent_setting::ActiveModel {
                        id: NotSet,
                        agent_type: Set(dto.agent_type),
                        registry_id: Set(registry_id),
                        enabled: Set(dto.enabled),
                        sort_order: Set(dto.sort_order),
                        // Device-local: what this machine actually has
                        // installed, discovered by the version probe.
                        installed_version: Set(None),
                        env_json: Set(dto.env_json),
                        model_provider_id: Set(provider_id),
                        created_at: Set(now),
                        updated_at: Set(now),
                    }
                    .insert(tx)
                    .await
                    .map_err(db_err)?;
                }
            }
            applied += 1;
        }
        Ok(applied.into())
    })
}

// ─── customAgents ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentDto {
    pub registry_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub distribution_kind: String,
    #[serde(default)]
    pub spec_json: String,
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub skills_shared_store: bool,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub version_probe: Option<String>,
    #[serde(default)]
    pub supports_mcp: bool,
}

fn collect_custom_agents(
    conn: &DatabaseConnection,
) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let rows = custom_agent::Entity::find()
            .order_by_asc(custom_agent::Column::Id)
            .all(conn)
            .await
            .map_err(db_err)?;
        encode(
            rows.into_iter()
                .map(|m| CustomAgentDto {
                    registry_id: m.registry_id,
                    name: m.name,
                    description: m.description,
                    version: m.version,
                    distribution_kind: m.distribution_kind,
                    spec_json: m.spec_json,
                    icon_url: m.icon_url,
                    skills_shared_store: m.skills_shared_store,
                    source: m.source,
                    version_probe: m.version_probe,
                    supports_mcp: m.supports_mcp,
                })
                .collect::<Vec<_>>(),
        )
    })
}

fn apply_custom_agents<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        let rows: Vec<CustomAgentDto> = decode_rows(DOMAIN_CUSTOM_AGENTS, value)?;
        let now = Utc::now();
        let mut applied = 0usize;
        for dto in rows {
            let existing = custom_agent::Entity::find()
                .filter(custom_agent::Column::RegistryId.eq(dto.registry_id.clone()))
                .one(tx)
                .await
                .map_err(db_err)?;
            match existing {
                Some(existing) => {
                    let mut active = existing.into_active_model();
                    active.name = Set(dto.name);
                    active.description = Set(dto.description);
                    active.version = Set(dto.version);
                    active.distribution_kind = Set(dto.distribution_kind);
                    active.spec_json = Set(dto.spec_json);
                    active.icon_url = Set(dto.icon_url);
                    active.skills_shared_store = Set(dto.skills_shared_store);
                    active.source = Set(dto.source);
                    active.version_probe = Set(dto.version_probe);
                    active.supports_mcp = Set(dto.supports_mcp);
                    // `skills_dir` is an absolute path on the machine that
                    // owns it; whatever this machine has stays.
                    active.updated_at = Set(now);
                    active.update(tx).await.map_err(db_err)?;
                }
                None => {
                    custom_agent::ActiveModel {
                        id: NotSet,
                        registry_id: Set(dto.registry_id),
                        name: Set(dto.name),
                        description: Set(dto.description),
                        version: Set(dto.version),
                        distribution_kind: Set(dto.distribution_kind),
                        spec_json: Set(dto.spec_json),
                        icon_url: Set(dto.icon_url),
                        skills_shared_store: Set(dto.skills_shared_store),
                        skills_dir: Set(None),
                        source: Set(dto.source),
                        version_probe: Set(dto.version_probe),
                        supports_mcp: Set(dto.supports_mcp),
                        created_at: Set(now),
                        updated_at: Set(now),
                    }
                    .insert(tx)
                    .await
                    .map_err(db_err)?;
                }
            }
            applied += 1;
        }
        Ok(applied.into())
    })
}

// ─── assistants ───────────────────────────────────────────────────────

/// One assistant as a snapshot carries it: everything but the local id, the
/// revision and the timestamps. The option list and the selection keep the
/// shapes the API uses (`snake_case` inside), which the row check below reads
/// exactly as `assistant_create` would.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantDto {
    /// The natural key: stable across machines and renames.
    pub uid: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub avatar: AssistantAvatar,
    /// The agent's wire slug. A row naming an agent this build does not know
    /// (written by a newer one) is skipped rather than refusing the file.
    pub agent_type: String,
    #[serde(default)]
    pub agent_options: AgentDelegationDefaults,
    pub label_snapshot: AssistantLabelSnapshot,
    #[serde(default)]
    pub instructions: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i32,
}

fn default_enabled() -> bool {
    true
}

/// Longest `uid` accepted: a v4 uuid is 36; this leaves room without letting
/// a hand-edited file store an essay as a key.
const MAX_ASSISTANT_UID_CHARS: usize = 64;

/// The one row check `validate` and `apply` share: the rules every assistant
/// of the collaboration settings obeyed (`assistant_service::normalize_draft`,
/// so a package from an older build reads as it did), plus a usable `uid`.
/// `Ok(None)` is a row for an agent this build does not know.
fn assistant_row(
    index: usize,
    dto: &AssistantDto,
) -> Result<Option<pa_service::ImportedWorker>, AppCommandError> {
    let invalid = |why: String| {
        AppCommandError::invalid_input(format!(
            "Snapshot domain '{DOMAIN_ASSISTANTS}' row {index} is invalid"
        ))
        .with_detail(why)
    };
    let uid = dto.uid.trim();
    if uid.is_empty() || uid.chars().count() > MAX_ASSISTANT_UID_CHARS {
        return Err(invalid("missing or oversized uid".to_string()));
    }
    let Some(agent_type) = AgentType::from_wire(&dto.agent_type) else {
        return Ok(None);
    };
    let draft = AssistantDraft {
        name: dto.name.clone(),
        description: dto.description.clone(),
        avatar: dto.avatar.clone(),
        agent_config: AssistantAgentConfig {
            agent_type,
            agent_options: dto.agent_options.clone(),
            label_snapshot: dto.label_snapshot.clone(),
        },
        instructions: dto.instructions.clone(),
        enabled: dto.enabled,
    };
    let row = assistant_service::normalize_draft(&draft).map_err(|e| invalid(e.to_string()))?;
    Ok(Some(pa_service::ImportedWorker {
        key: uid.to_string(),
        name: row.name,
        persona: row.description,
        work: pa_service::AgentColumns {
            agent_type: row.agent_type,
            agent_options_json: row.agent_options_json,
            label_snapshot_json: row.label_snapshot_json,
        },
        instructions: row.instructions,
        hidden: !row.enabled,
        sort_order: dto.sort_order,
    }))
}

/// Decode and check every row, keeping the ones this build can apply — one
/// per `uid`, the last entry for it, in the order the uids first appear (what
/// `personal_agent_service::import_workers` writes, so the count says the
/// same).
fn assistant_rows(value: &Value) -> Result<Vec<pa_service::ImportedWorker>, AppCommandError> {
    let dtos: Vec<AssistantDto> = decode_rows(DOMAIN_ASSISTANTS, value)?;
    let mut rows: Vec<pa_service::ImportedWorker> = Vec::with_capacity(dtos.len());
    for (index, dto) in dtos.iter().enumerate() {
        match assistant_row(index, dto)? {
            Some(row) => match rows.iter_mut().find(|held| held.key == row.key) {
                Some(held) => *held = row,
                None => rows.push(row),
            },
            None => tracing::warn!(
                "[CONFIG-SYNC] skipping assistant row {index}: unknown agent '{}'",
                dto.agent_type
            ),
        }
    }
    Ok(rows)
}

fn validate_assistants(value: &Value) -> Result<(), AppCommandError> {
    assistant_rows(value).map(drop)
}

/// The rows the applier writes: every decodable row on a known agent.
fn count_assistants(value: &Value) -> usize {
    assistant_rows(value).map_or(0, |rows| rows.len())
}

/// A face as the collaboration settings' avatar a package carries (read by
/// an older build only; this one gives each assistant made its own face):
/// a monogram in the nearest colour those had, the other kinds as they are.
fn package_avatar(avatar: BotAvatar) -> AssistantAvatar {
    let color = |c: &str| -> String {
        let near = match c {
            "brown" | "yellow" => "amber",
            "purple" => "violet",
            "magenta" => "pink",
            "gray" => "slate",
            other => other,
        };
        if crate::models::assistant::ASSISTANT_AVATAR_COLORS.contains(&near) {
            near.to_string()
        } else {
            "violet".to_string()
        }
    };
    match avatar {
        BotAvatar::Face { color: c, .. } | BotAvatar::Monogram { color: c } => {
            AssistantAvatar::Monogram { color: color(&c) }
        }
        BotAvatar::Emoji { emoji, color: c } => AssistantAvatar::Emoji {
            emoji,
            color: color(&c),
        },
        BotAvatar::Image { data_url } => AssistantAvatar::Image { data_url },
    }
}

/// A work assistant's persona as a package carries it, on one line and no
/// longer than a description may be: the one waiting for its directory, else
/// the first paragraph of its `SOUL.md` (none while it is the one it started
/// with). `None` when its directory cannot be read here.
fn package_persona(
    row: &crate::db::entities::personal_agent::Model,
    data_dir: Option<&std::path::Path>,
) -> Option<String> {
    use crate::personal_agent::team;
    let text = if row.workdir_ready {
        let soul = crate::personal_agent::workdir::soul_text(data_dir?, row);
        if crate::personal_agent::templates::persona_unwritten(&soul) {
            String::new()
        } else {
            team::persona_paragraph(&soul)
        }
    } else {
        row.seed_persona.clone().unwrap_or_default()
    };
    Some(team::persona_head(
        &text,
        assistant_service::MAX_DESCRIPTION_CHARS,
    ))
}

/// The work assistants (the primary is not one a package carries), every
/// one — those with no brain yet too: each under the uid it came with from
/// the collaboration settings when it did, so a package goes on matching the
/// same one on every device, else its own. What its work runs on is the
/// agent and options, its standing instructions the instructions, shown the
/// enabled; one on an agent codeg no longer knows is left out.
fn collect_assistants(conn: &DatabaseConnection) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let data_dir = crate::personal_agent::host::data_dir_hint();
        collect_assistants_in(conn, data_dir.as_deref()).await
    })
}

async fn collect_assistants_in(
    conn: &DatabaseConnection,
    data_dir: Option<&std::path::Path>,
) -> Result<Value, AppCommandError> {
    use crate::db::entities::personal_agent::BotKind;
    let rows = pa_service::list_bots(conn)
        .await
        .map_err(AppCommandError::db)?;
    encode(
        rows.into_iter()
            .filter(|b| b.kind == BotKind::Worker)
            .filter_map(|b| {
                let work = crate::personal_agent::engine::work_of_row(&b)?;
                let uid = b.legacy_assistant_uid.clone().or_else(|| b.uid.clone())?;
                Some(AssistantDto {
                    uid,
                    name: b.name.trim().to_string(),
                    description: package_persona(&b, data_dir).unwrap_or_default(),
                    avatar: package_avatar(BotAvatar::parse(&b.avatar)),
                    agent_type: work.agent_type.as_wire().into_owned(),
                    agent_options: work.agent_options,
                    label_snapshot: work.label_snapshot,
                    instructions: b.work_instructions.clone().unwrap_or_default(),
                    enabled: !b.hidden,
                    sort_order: b.sort_order,
                })
            })
            .collect::<Vec<_>>(),
    )
}

fn apply_assistants<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        let rows = assistant_rows(value)?;
        let data_dir = crate::personal_agent::host::data_dir_hint();
        let persona_of = move |row: &crate::db::entities::personal_agent::Model| {
            package_persona(row, data_dir.as_deref())
        };
        let outcome = pa_service::import_workers(tx, rows, &persona_of)
            .await
            .map_err(AppCommandError::db)?;
        Ok(DomainApplied {
            written: outcome.written,
            renamed: outcome.renamed,
            persona_kept: outcome.persona_kept,
        })
    })
}

// ─── quickMessages ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickMessageDto {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub sort_order: i32,
}

fn collect_quick_messages(
    conn: &DatabaseConnection,
) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let rows = quick_message::Entity::find()
            .order_by_asc(quick_message::Column::Id)
            .all(conn)
            .await
            .map_err(db_err)?;
        encode(
            rows.into_iter()
                .map(|m| QuickMessageDto {
                    title: m.title,
                    content: m.content,
                    sort_order: m.sort_order,
                })
                .collect::<Vec<_>>(),
        )
    })
}

fn apply_quick_messages<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        let rows: Vec<QuickMessageDto> = decode_rows(DOMAIN_QUICK_MESSAGES, value)?;
        let now = Utc::now();
        let mut applied = 0usize;
        for dto in rows {
            let existing = quick_message::Entity::find()
                .filter(quick_message::Column::Title.eq(dto.title.clone()))
                .order_by_asc(quick_message::Column::Id)
                .one(tx)
                .await
                .map_err(db_err)?;
            match existing {
                Some(existing) => {
                    let mut active = existing.into_active_model();
                    active.content = Set(dto.content);
                    active.sort_order = Set(dto.sort_order);
                    active.updated_at = Set(now);
                    active.update(tx).await.map_err(db_err)?;
                }
                None => {
                    quick_message::ActiveModel {
                        id: NotSet,
                        title: Set(dto.title),
                        content: Set(dto.content),
                        sort_order: Set(dto.sort_order),
                        created_at: Set(now),
                        updated_at: Set(now),
                    }
                    .insert(tx)
                    .await
                    .map_err(db_err)?;
                }
            }
            applied += 1;
        }
        Ok(applied.into())
    })
}

// ─── taskTemplates ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTemplateDto {
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub config: String,
}

fn collect_task_templates(
    conn: &DatabaseConnection,
) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let rows = work_task_template::Entity::find()
            .order_by_asc(work_task_template::Column::Id)
            .all(conn)
            .await
            .map_err(db_err)?;
        encode(
            rows.into_iter()
                .map(|m| TaskTemplateDto {
                    name: m.name,
                    title: m.title,
                    config: m.config,
                })
                .collect::<Vec<_>>(),
        )
    })
}

fn apply_task_templates<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        let rows: Vec<TaskTemplateDto> = decode_rows(DOMAIN_TASK_TEMPLATES, value)?;
        let now = Utc::now();
        let mut applied = 0usize;
        for dto in rows {
            let existing = work_task_template::Entity::find()
                .filter(work_task_template::Column::Name.eq(dto.name.clone()))
                .order_by_asc(work_task_template::Column::Id)
                .one(tx)
                .await
                .map_err(db_err)?;
            match existing {
                Some(existing) => {
                    let mut active = existing.into_active_model();
                    active.title = Set(dto.title);
                    active.config = Set(dto.config);
                    active.updated_at = Set(now);
                    active.update(tx).await.map_err(db_err)?;
                }
                None => {
                    work_task_template::ActiveModel {
                        id: NotSet,
                        name: Set(dto.name),
                        title: Set(dto.title),
                        config: Set(dto.config),
                        created_at: Set(now),
                        updated_at: Set(now),
                    }
                    .insert(tx)
                    .await
                    .map_err(db_err)?;
                }
            }
            applied += 1;
        }
        Ok(applied.into())
    })
}

// ─── preferences ──────────────────────────────────────────────────────

fn collect_preferences(conn: &DatabaseConnection) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let rows = app_metadata::Entity::find()
            .filter(app_metadata::Column::Key.is_in(PORTABLE_PREFERENCE_KEYS.iter().copied()))
            .filter(app_metadata::Column::DeletedAt.is_null())
            .order_by_asc(app_metadata::Column::Key)
            .all(conn)
            .await
            .map_err(db_err)?;
        let mut map = Map::new();
        for row in rows {
            map.insert(row.key, Value::String(row.value));
        }
        Ok(Value::Object(map))
    })
}

fn apply_preferences<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        let Some(map) = value.as_object() else {
            return Ok(DomainApplied::default());
        };
        let mut applied = 0usize;
        for (key, entry) in map {
            // Re-check the allowlist on the way IN. The snapshot is a plain
            // file a user can edit and a remote a user does not fully
            // control; without this, a doctored snapshot could write
            // `github_accounts` or the sync credentials themselves.
            if !is_portable_key(key) {
                tracing::warn!("[CONFIG-SYNC] ignoring non-portable preference key from snapshot");
                continue;
            }
            let Some(text) = entry.as_str() else {
                continue;
            };
            app_metadata_service::upsert_value(tx, key, text)
                .await
                .map_err(AppCommandError::db)?;
            applied += 1;
        }
        Ok(applied.into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_ids_are_unique_and_non_empty() {
        let mut seen = std::collections::HashSet::new();
        for domain in CONFIG_DOMAINS {
            assert!(!domain.id.is_empty());
            assert!(seen.insert(domain.id), "duplicate domain id: {}", domain.id);
        }
    }

    /// `agentSettings` resolves its provider reference against rows the
    /// `modelProviders` applier has already written.
    #[test]
    fn providers_are_applied_before_agent_settings() {
        let providers = CONFIG_DOMAINS
            .iter()
            .position(|d| d.id == DOMAIN_MODEL_PROVIDERS)
            .expect("modelProviders domain");
        let settings = CONFIG_DOMAINS
            .iter()
            .position(|d| d.id == DOMAIN_AGENT_SETTINGS)
            .expect("agentSettings domain");
        assert!(providers < settings);
    }

    #[test]
    fn count_entries_handles_arrays_objects_and_junk() {
        let rows = DOMAIN_QUICK_MESSAGES;
        assert_eq!(count_entries(rows, &serde_json::json!([1, 2, 3])), 3);
        assert_eq!(count_entries(rows, &Value::Null), 0);
        // A row domain handed an object is junk, not one entry.
        assert_eq!(count_entries(rows, &serde_json::json!({ "a": "b" })), 0);

        // Preferences count only what an import would write.
        assert_eq!(
            count_entries(
                DOMAIN_PREFERENCES,
                &serde_json::json!({ "appearance_mode": "dark", "github_accounts": "leaked" })
            ),
            1
        );

        // A domain from a newer build is not applied, so it counts for nothing
        // rather than advertising rows that will be skipped.
        assert_eq!(
            count_entries("somethingNewer", &serde_json::json!([1, 2, 3])),
            0
        );
    }

    /// The whole point of `validate` is that it answers the same question the
    /// applier would, one step earlier. If the two ever disagree, the preview
    /// is lying: either it waves through a payload that aborts the apply, or it
    /// refuses a file that would have applied fine.
    ///
    /// Run against a real (in-memory) database so `apply` is the actual
    /// applier, not a stand-in — the drift this guards against is exactly a
    /// `validate` that stopped tracking its applier's DTO.
    #[tokio::test]
    async fn validate_matches_apply_on_every_domain() {
        use sea_orm::TransactionTrait;

        // Shapes a hand-edited snapshot plausibly ends up with: the wrong
        // container, the right container with the wrong element type, and a
        // row missing a field the DTO requires.
        let payloads = [
            serde_json::json!("not a list"),
            serde_json::json!(42),
            serde_json::json!({ "registryId": "acme" }),
            serde_json::json!([1, 2, 3]),
            serde_json::json!([{ "unexpected": true }]),
            serde_json::json!([]),
            Value::Null,
        ];

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        for domain in CONFIG_DOMAINS {
            for payload in &payloads {
                let validated = (domain.validate)(payload).is_ok();
                // Each probe gets its own transaction, rolled back either way:
                // a payload that applies must not leave rows behind for the
                // next probe to trip over.
                let tx = db.conn.begin().await.expect("begin");
                let applied = (domain.apply)(&tx, payload).await.is_ok();
                tx.rollback().await.expect("rollback");
                assert_eq!(
                    validated, applied,
                    "domain '{}' disagrees with itself on {payload}",
                    domain.id
                );
            }
        }
    }

    /// The other half of the same agreement. The confirmation dialog and the
    /// manifest both quote `count`, and the user reads that as "this is what
    /// will be written" — so whenever an apply succeeds, the number it reports
    /// has to be the number that was promised.
    ///
    /// `preferences` is the one that can drift, because its applier filters and
    /// its container does not: counting keys would promise the two entries
    /// below that an import silently drops.
    #[tokio::test]
    async fn count_matches_apply_on_every_domain() {
        use sea_orm::TransactionTrait;

        let portable = *PORTABLE_PREFERENCE_KEYS
            .first()
            .expect("at least one portable preference key");
        let mut mixed = Map::new();
        mixed.insert(portable.to_string(), Value::from("kept"));
        // Not on the allowlist: refused on the way in, so it must not be
        // counted on the way out.
        mixed.insert("definitely_not_portable".to_string(), Value::from("dropped"));
        // On the allowlist but not a string — preferences are stored as text,
        // and the applier skips anything else rather than stringifying it.
        mixed.insert("appearance_zoom_level".to_string(), Value::from(7));

        let payloads = [
            serde_json::json!([]),
            Value::Null,
            serde_json::json!({}),
            Value::Object(mixed),
        ];

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        for domain in CONFIG_DOMAINS {
            for payload in &payloads {
                let promised = (domain.count)(payload);
                let tx = db.conn.begin().await.expect("begin");
                let applied = (domain.apply)(&tx, payload).await;
                tx.rollback().await.expect("rollback");
                let Ok(DomainApplied { written, .. }) = applied else {
                    continue;
                };
                assert_eq!(
                    promised, written,
                    "domain '{}' promised {promised} and wrote {written} for {payload}",
                    domain.id
                );
            }
        }
    }

    // ── assistants ──

    use crate::db::entities::personal_agent::{self as pa_entity, BotKind};

    fn assistant_json(uid: &str, name: &str) -> Value {
        serde_json::json!({
            "uid": uid,
            "name": name,
            "description": "Reviews diffs",
            "avatar": { "kind": "monogram", "color": "teal" },
            "agentType": "codex",
            "agentOptions": { "config_values": { "model": "gpt-5.5" } },
            "labelSnapshot": {
                "agent": "Codex",
                "mode": null,
                "options": [
                    { "id": "model", "kind": "select", "name": "Model", "value_label": "GPT-5.5" }
                ]
            },
            "instructions": "Cite line numbers.",
            "enabled": true,
            "sortOrder": 3
        })
    }

    async fn apply_assistants_committed(
        db: &crate::db::AppDatabase,
        value: &Value,
    ) -> DomainApplied {
        use sea_orm::TransactionTrait;
        let tx = db.conn.begin().await.expect("begin");
        let applied = apply_assistants(&tx, value).await.expect("apply");
        tx.commit().await.expect("commit");
        applied
    }

    /// Every work assistant, deleted or not, by id.
    async fn all_workers(db: &crate::db::AppDatabase) -> Vec<pa_entity::Model> {
        pa_entity::Entity::find()
            .filter(pa_entity::Column::Kind.eq(BotKind::Worker))
            .order_by_asc(pa_entity::Column::Id)
            .all(&db.conn)
            .await
            .expect("workers")
    }

    async fn workers_in(db: &crate::db::AppDatabase) -> Vec<pa_entity::Model> {
        all_workers(db)
            .await
            .into_iter()
            .filter(|b| b.deleted_at.is_none())
            .collect()
    }

    fn columns(agent_type: &str) -> pa_service::AgentColumns {
        pa_service::AgentColumns {
            agent_type: agent_type.to_string(),
            agent_options_json: "{}".to_string(),
            label_snapshot_json: format!(r#"{{"agent":"{agent_type}","mode":null,"options":[]}}"#),
        }
    }

    /// A worker made here, its directory made with it.
    async fn local_worker(db: &crate::db::AppDatabase, name: &str) -> pa_entity::Model {
        pa_service::create_worker(
            &db.conn,
            pa_service::NewWorker::made(
                name.to_string(),
                "{}".to_string(),
                columns("claude_code"),
                columns("codex"),
                "{}".to_string(),
            ),
        )
        .await
        .expect("worker")
    }

    async fn primary(db: &crate::db::AppDatabase) -> pa_entity::Model {
        pa_service::save_primary(
            &db.conn,
            pa_service::AgentWrite {
                name: Some("Primary".to_string()),
                brain: Some(columns("claude_code")),
                work: Some(columns("claude_code")),
                ..Default::default()
            },
        )
        .await
        .expect("primary")
    }

    #[tokio::test]
    async fn assistants_land_as_work_assistants_matched_by_the_package_uid() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let first = apply_assistants_committed(
            &db,
            &serde_json::json!([assistant_json("u-1", "Reviewer")]),
        )
        .await;
        assert_eq!(
            first,
            DomainApplied {
                written: 1,
                renamed: 0,
                persona_kept: 0,
            }
        );
        let rows = workers_in(&db).await;
        assert_eq!(rows.len(), 1);
        let made = &rows[0];
        assert_eq!(made.legacy_assistant_uid.as_deref(), Some("u-1"));
        let uid = made.uid.clone().expect("a uid of its own");
        assert_eq!(uid.len(), 32, "its own uid, not the package's: {uid}");
        assert_eq!(made.name, "Reviewer");
        assert_eq!(made.work_agent_type, "codex");
        assert!(made.work_agent_options.contains("gpt-5.5"));
        assert!(made.work_label_snapshot.contains("GPT-5.5"));
        assert_eq!(made.work_instructions.as_deref(), Some("Cite line numbers."));
        assert_eq!(made.sort_order, 3);
        assert!(!made.hidden);
        assert!(!made.workdir_ready, "its directory is made when first needed");
        assert_eq!(made.seed_persona.as_deref(), Some("Reviews diffs"));
        assert_eq!(made.seed_version, 1);
        assert_eq!(made.agent_type, None, "no primary here to copy a brain from");
        assert_eq!(
            made.avatar,
            serde_json::to_string(&BotAvatar::default_for(&uid)).unwrap(),
            "a face of its own, not the package's"
        );

        // Again, edited: the same one, its persona the new one while its
        // directory is not made — the version moved on for the one being made.
        let mut edited = assistant_json("u-1", "Reviewer");
        edited["description"] = Value::from("Reads every diff");
        edited["enabled"] = Value::from(false);
        edited["instructions"] = Value::from("");
        apply_assistants_committed(&db, &serde_json::json!([edited])).await;
        let rows = workers_in(&db).await;
        assert_eq!(rows.len(), 1, "matched, not added again");
        assert_eq!(rows[0].id, made.id);
        assert_eq!(rows[0].seed_persona.as_deref(), Some("Reads every diff"));
        assert_eq!(rows[0].seed_version, 2);
        assert!(rows[0].hidden, "not enabled is hidden");
        assert_eq!(rows[0].work_instructions, None);
        assert_eq!(rows[0].revision, made.revision + 1);
    }

    /// One whose directory is made keeps its `SOUL.md`: the persona is not
    /// written, and the ones kept are counted when the package's differs.
    #[tokio::test]
    async fn a_made_ones_persona_stays_its_own() {
        use sea_orm::TransactionTrait;
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let mine = local_worker(&db, "Reviewer").await;
        let row = |persona: &str| pa_service::ImportedWorker {
            key: mine.uid.clone().unwrap(),
            name: "Reviewer".to_string(),
            persona: persona.to_string(),
            work: columns("codex"),
            instructions: String::new(),
            hidden: false,
            sort_order: 1,
        };
        for (given, kept) in [("Reads  every\ndiff", 0), ("Something else", 1)] {
            let tx = db.conn.begin().await.unwrap();
            let outcome = pa_service::import_workers(&tx, vec![row(given)], &|_| {
                Some("Reads every diff".to_string())
            })
            .await
            .expect("import");
            tx.commit().await.unwrap();
            assert_eq!(outcome.written, 1);
            assert_eq!(outcome.persona_kept, kept, "{given:?}");
        }
        let now = &workers_in(&db).await[0];
        assert_eq!(now.id, mine.id, "matched by its own uid");
        assert_eq!(now.seed_persona, None);
        assert_eq!(now.seed_version, mine.seed_version);
        assert!(now.workdir_ready);
        assert_eq!(now.work_agent_type, "codex");
        assert_eq!(now.agent_type.as_deref(), Some("claude_code"), "its brain stays");
    }

    #[tokio::test]
    async fn one_made_by_an_import_gets_the_primarys_brain() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let primary = primary(&db).await;
        apply_assistants_committed(
            &db,
            &serde_json::json!([assistant_json("u-1", "Reviewer")]),
        )
        .await;
        let made = &workers_in(&db).await[0];
        assert_eq!(made.agent_type, primary.agent_type);
        assert_eq!(made.agent_options, primary.agent_options);
        assert_eq!(made.label_snapshot, primary.label_snapshot);
        assert_eq!(made.work_agent_type, "codex", "its work is the package's");
    }

    /// The primary is not one a package carries, nor one it writes.
    #[tokio::test]
    async fn the_primary_is_never_matched() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let primary = primary(&db).await;
        let row = assistant_json(primary.uid.as_deref().unwrap(), "Reviewer");
        apply_assistants_committed(&db, &serde_json::json!([row])).await;
        let after = pa_service::primary_bot(&db.conn).await.unwrap().unwrap();
        assert_eq!(after.name, "Primary");
        assert_eq!(after.revision, primary.revision);
        assert_eq!(workers_in(&db).await.len(), 1, "a work assistant made");

        let collected = collect_assistants_in(&db.conn, None).await.expect("collect");
        let rows = collected.as_array().unwrap();
        assert_eq!(rows.len(), 1, "the primary does not travel");
        assert_eq!(rows[0]["name"], "Reviewer");
    }

    #[tokio::test]
    async fn an_imported_name_another_assistant_has_is_made_unique_the_same_way_twice() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        local_worker(&db, "Reviewer").await;
        primary(&db).await;
        let snapshot = serde_json::json!([
            assistant_json("u-1", "reviewer"),
            assistant_json("u-2", "Writer"),
            assistant_json("u-3", "WRITER"),
            assistant_json("u-4", "primary"),
        ]);
        for _ in 0..2 {
            let applied = apply_assistants_committed(&db, &snapshot).await;
            assert_eq!((applied.written, applied.renamed), (4, 3));
            let mut names: Vec<(String, String)> = workers_in(&db)
                .await
                .into_iter()
                .filter_map(|b| Some((b.legacy_assistant_uid?, b.name)))
                .collect();
            names.sort();
            assert_eq!(
                names,
                [
                    ("u-1".to_string(), "reviewer (2)".to_string()),
                    ("u-2".to_string(), "Writer".to_string()),
                    ("u-3".to_string(), "WRITER (2)".to_string()),
                    ("u-4".to_string(), "primary (2)".to_string()),
                ]
            );
        }
        assert_eq!(workers_in(&db).await.len(), 5);
    }

    /// The outcome depends on the snapshot and on the rows it leaves alone —
    /// not on what its own rows were called before. Two assistants trading
    /// names land traded, and re-applying the snapshot from before puts every
    /// name back.
    #[tokio::test]
    async fn assistants_trading_names_land_traded_and_a_rollback_puts_them_back() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let before = serde_json::json!([
            assistant_json("u-a", "Alpha"),
            assistant_json("u-b", "Beta"),
        ]);
        apply_assistants_committed(&db, &before).await;
        let names = |rows: Vec<pa_entity::Model>| {
            let mut out: Vec<(String, String)> = rows
                .into_iter()
                .filter_map(|b| Some((b.legacy_assistant_uid?, b.name)))
                .collect();
            out.sort();
            out
        };

        let traded = serde_json::json!([
            assistant_json("u-a", "Beta"),
            assistant_json("u-b", "Alpha"),
        ]);
        for _ in 0..2 {
            let applied = apply_assistants_committed(&db, &traded).await;
            assert_eq!(applied.renamed, 0);
            assert_eq!(
                names(workers_in(&db).await),
                [
                    ("u-a".to_string(), "Beta".to_string()),
                    ("u-b".to_string(), "Alpha".to_string()),
                ]
            );
        }

        apply_assistants_committed(&db, &before).await;
        assert_eq!(
            names(workers_in(&db).await),
            [
                ("u-a".to_string(), "Alpha".to_string()),
                ("u-b".to_string(), "Beta".to_string()),
            ]
        );
    }

    /// Uids are matched exactly, so two may differ only in case.
    #[tokio::test]
    async fn uids_differing_only_in_case_are_two_assistants() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let snapshot = serde_json::json!([
            assistant_json("u-a", "Alpha"),
            assistant_json("U-A", "Beta"),
        ]);
        for _ in 0..2 {
            let applied = apply_assistants_committed(&db, &snapshot).await;
            assert_eq!(applied.written, 2);
        }
        assert_eq!(workers_in(&db).await.len(), 2);
    }

    #[tokio::test]
    async fn a_uid_the_snapshot_repeats_is_written_once_with_its_last_entry() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let snapshot = serde_json::json!([
            assistant_json("u-1", "First"),
            assistant_json("u-2", "Other"),
            assistant_json("u-1", "Last"),
        ]);
        assert_eq!(count_assistants(&snapshot), 2);
        let applied = apply_assistants_committed(&db, &snapshot).await;
        assert_eq!(applied.written, 2);
        let rows = workers_in(&db).await;
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|b| b.legacy_assistant_uid.as_deref() == Some("u-1") && b.name == "Last"));
    }

    /// A deleted one is not brought back (its directory may be going away,
    /// or another's by now): a new one is made, and takes the legacy uid —
    /// deleted and imported again, the unique index never trips.
    #[tokio::test]
    async fn an_assistant_deleted_here_is_made_anew_when_a_snapshot_carries_it() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let package = serde_json::json!([assistant_json("u-1", "Reviewer")]);
        apply_assistants_committed(&db, &package).await;
        let gone = workers_in(&db).await.remove(0);
        for round in 0..2 {
            let live = workers_in(&db).await.remove(0);
            assert!(pa_service::delete_worker(&db.conn, live.id).await.unwrap());
            apply_assistants_committed(&db, &package).await;
            let now = workers_in(&db).await;
            assert_eq!(now.len(), 1, "round {round}");
            assert_ne!(now[0].id, live.id, "a new one, not the deleted brought back");
            assert_ne!(now[0].uid, live.uid);
            assert_eq!(now[0].legacy_assistant_uid.as_deref(), Some("u-1"));
            assert_eq!(now[0].name, "Reviewer", "a deleted one's name is free");
        }
        let all = all_workers(&db).await;
        assert_eq!(all.len(), 3);
        assert!(all
            .iter()
            .filter(|b| b.deleted_at.is_some())
            .all(|b| b.legacy_assistant_uid.is_none()));
        assert_eq!(all[0].id, gone.id);
    }

    #[tokio::test]
    async fn a_row_on_an_agent_this_build_does_not_know_is_skipped_not_refused() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let mut newer = assistant_json("u-2", "From the future");
        newer["agentType"] = Value::from("an_agent_from_a_newer_build");
        let snapshot = serde_json::json!([assistant_json("u-1", "Reviewer"), newer]);
        validate_assistants(&snapshot).expect("still a valid file");
        assert_eq!(count_assistants(&snapshot), 1);
        let applied = apply_assistants_committed(&db, &snapshot).await;
        assert_eq!(applied.written, 1);
        assert_eq!(workers_in(&db).await.len(), 1);
    }

    #[tokio::test]
    async fn an_assistant_row_breaking_the_rules_refuses_the_file_up_front() {
        use sea_orm::TransactionTrait;
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let mut incomplete = assistant_json("u-1", "Reviewer");
        // The option list names a value the selection does not carry.
        incomplete["labelSnapshot"]["options"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "effort", "kind": "select", "name": "Effort", "value_label": "High"
            }));
        let mut nameless = assistant_json("u-2", "  ");
        nameless["uid"] = Value::from("u-2");
        let mut no_uid = assistant_json("", "Writer");
        no_uid["uid"] = Value::from(" ");
        for row in [incomplete, nameless, no_uid] {
            let payload = serde_json::json!([assistant_json("u-9", "Fine"), row]);
            let err = validate_assistants(&payload).expect_err("refused at preview");
            assert!(err.message.contains(DOMAIN_ASSISTANTS), "{}", err.message);
            let tx = db.conn.begin().await.unwrap();
            assert!(apply_assistants(&tx, &payload).await.is_err());
            tx.rollback().await.unwrap();
        }
        assert!(workers_in(&db).await.is_empty());
    }

    /// Collected: the live work assistants, each under the uid it came with
    /// when it did (so the package goes on naming the same one everywhere),
    /// its persona the one waiting for its directory or its `SOUL.md`'s
    /// first paragraph, shown the enabled — and landing whole on another
    /// device.
    #[tokio::test]
    async fn collecting_carries_live_work_assistants_whole() {
        let source = crate::db::test_helpers::fresh_in_memory_db().await;
        apply_assistants_committed(
            &source,
            &serde_json::json!([assistant_json("u-1", "Reviewer")]),
        )
        .await;
        let mine = local_worker(&source, "Writer").await;
        let gone = local_worker(&source, "Gone").await;
        pa_service::delete_worker(&source.conn, gone.id).await.unwrap();
        pa_entity::Entity::update_many()
            .col_expr(pa_entity::Column::Hidden, sea_orm::sea_query::Expr::value(true))
            .col_expr(
                pa_entity::Column::WorkInstructions,
                sea_orm::sea_query::Expr::value("Short sentences."),
            )
            .filter(pa_entity::Column::Id.eq(mine.id))
            .exec(&source.conn)
            .await
            .unwrap();
        let data = tempfile::tempdir().unwrap();
        let mine = pa_service::get_bot(&source.conn, mine.id).await.unwrap().unwrap();
        let dir = crate::personal_agent::workdir::workdir_of_bot(data.path(), &mine);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SOUL.md"),
            crate::personal_agent::templates::worker_soul(
                crate::models::system::AppLocale::En,
                Some("Writes the docs.\nPlainly."),
            ),
        )
        .unwrap();

        let collected = collect_assistants_in(&source.conn, Some(data.path()))
            .await
            .expect("collect");
        let rows = collected.as_array().expect("a list");
        assert_eq!(rows.len(), 2, "a deleted assistant does not travel");
        let by = |name: &str| rows.iter().find(|r| r["name"] == name).expect(name);
        let reviewer = by("Reviewer");
        assert_eq!(reviewer["uid"], "u-1", "the uid it came with");
        assert_eq!(reviewer["description"], "Reviews diffs");
        assert_eq!(reviewer["enabled"], true);
        assert_eq!(reviewer["agentType"], "codex");
        assert_eq!(reviewer["instructions"], "Cite line numbers.");
        assert_eq!(reviewer["sortOrder"], 3);
        let writer = by("Writer");
        assert_eq!(writer["uid"], mine.uid.clone().unwrap().as_str(), "its own");
        assert_eq!(writer["description"], "Writes the docs. Plainly.");
        assert_eq!(writer["enabled"], false);
        assert_eq!(writer["instructions"], "Short sentences.");
        assert!(rows.iter().all(|r| r.get("id").is_none() && r.get("revision").is_none()));
        validate_assistants(&collected).expect("a package an older build reads");

        // Its persona unread here (no data dir): none, not the default.
        let blind = collect_assistants_in(&source.conn, None).await.unwrap();
        let blind_writer = blind
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == "Writer")
            .unwrap()
            .clone();
        assert_eq!(blind_writer["description"], "");

        let target = crate::db::test_helpers::fresh_in_memory_db().await;
        apply_assistants_committed(&target, &collected).await;
        let landed = workers_in(&target).await;
        assert_eq!(landed.len(), 2);
        let writer = landed.iter().find(|b| b.name == "Writer").unwrap();
        assert_eq!(writer.legacy_assistant_uid, mine.uid);
        assert_eq!(writer.seed_persona.as_deref(), Some("Writes the docs. Plainly."));
        assert!(writer.hidden);
        assert_eq!(writer.work_agent_type, mine.work_agent_type);
        assert_eq!(writer.work_instructions.as_deref(), Some("Short sentences."));
        // And back: the uid it travels under stays the first device's.
        let again = collect_assistants_in(&target.conn, None).await.unwrap();
        assert!(again
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["uid"] == mine.uid.clone().unwrap().as_str()));
    }

    /// And the pair is not vacuously in agreement: at least one of those
    /// payloads must actually be refused, or a `validate` stubbed out to
    /// `Ok(())` everywhere would pass the test above.
    #[test]
    fn a_malformed_row_domain_is_refused() {
        for domain in CONFIG_DOMAINS {
            if domain.id == DOMAIN_PREFERENCES {
                continue;
            }
            let err = (domain.validate)(&serde_json::json!("not a list"))
                .expect_err("a row domain must refuse a bare string");
            assert!(err.message.contains(domain.id), "{}", err.message);
        }
    }
}
