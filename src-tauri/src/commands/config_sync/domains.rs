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
use crate::db::service::{app_metadata_service, assistant_service};
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
}

impl From<usize> for DomainApplied {
    fn from(written: usize) -> Self {
        Self {
            written,
            renamed: 0,
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
];

fn validate_model_providers(value: &Value) -> Result<(), AppCommandError> {
    decode_rows::<ModelProviderDto>(DOMAIN_MODEL_PROVIDERS, value).map(drop)
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
/// write obeys (`assistant_service::normalize_draft`), plus a usable `uid`.
/// `Ok(None)` is a row for an agent this build does not know.
fn assistant_row(
    index: usize,
    dto: &AssistantDto,
) -> Result<Option<assistant_service::ImportedAssistant>, AppCommandError> {
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
    Ok(Some(assistant_service::ImportedAssistant {
        uid: uid.to_string(),
        row,
        sort_order: dto.sort_order,
    }))
}

/// Decode and check every row, keeping the ones this build can apply — one
/// per `uid`, the last entry for it, in the order the uids first appear (what
/// `assistant_service::import_into` writes, so the count says the same).
fn assistant_rows(
    value: &Value,
) -> Result<Vec<assistant_service::ImportedAssistant>, AppCommandError> {
    let dtos: Vec<AssistantDto> = decode_rows(DOMAIN_ASSISTANTS, value)?;
    let mut rows: Vec<assistant_service::ImportedAssistant> = Vec::with_capacity(dtos.len());
    for (index, dto) in dtos.iter().enumerate() {
        match assistant_row(index, dto)? {
            Some(row) => match rows.iter_mut().find(|held| held.uid == row.uid) {
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

/// Live assistants only: a deleted one is not configuration anyone wants
/// carried over (and "never delete" means an import could not remove it
/// here anyway).
fn collect_assistants(conn: &DatabaseConnection) -> BoxFuture<'_, Result<Value, AppCommandError>> {
    Box::pin(async move {
        let rows = assistant_service::live_rows_for_export(conn)
            .await
            .map_err(db_err)?;
        encode(
            rows.into_iter()
                .map(|a| AssistantDto {
                    uid: a.uid,
                    name: a.name,
                    description: a.description,
                    avatar: a.avatar,
                    agent_type: a.agent_type.as_wire().into_owned(),
                    agent_options: a.agent_options,
                    label_snapshot: a.label_snapshot,
                    instructions: a.instructions,
                    enabled: a.enabled,
                    sort_order: a.sort_order,
                })
                .collect::<Vec<_>>(),
        )
    })
}

fn apply_assistants<'a>(
    tx: &'a DatabaseTransaction,
    value: &'a Value,
) -> BoxFuture<'a, Result<DomainApplied, AppCommandError>> {
    Box::pin(async move {
        let rows = assistant_rows(value)?;
        let outcome = assistant_service::import_into(tx, rows)
            .await
            .map_err(db_err)?;
        Ok(DomainApplied {
            written: outcome.written,
            renamed: outcome.renamed,
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

    async fn assistants_in(db: &crate::db::AppDatabase) -> Vec<crate::models::AssistantInfo> {
        assistant_service::list_all(&db.conn).await.expect("list")
    }

    fn local_draft(name: &str) -> AssistantDraft {
        let row: AssistantDto =
            serde_json::from_value(assistant_json("unused", name)).expect("dto");
        AssistantDraft {
            name: row.name,
            description: row.description,
            avatar: row.avatar,
            agent_config: AssistantAgentConfig {
                agent_type: AgentType::Codex,
                agent_options: row.agent_options,
                label_snapshot: row.label_snapshot,
            },
            instructions: row.instructions,
            enabled: true,
        }
    }

    #[tokio::test]
    async fn assistants_travel_by_uid_and_move_their_revision_on() {
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
                renamed: 0
            }
        );
        let rows = assistants_in(&db).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].uid, "u-1");
        assert_eq!(rows[0].revision, 1);
        assert_eq!(rows[0].instructions, "Cite line numbers.");
        assert_eq!(rows[0].sort_order, 3);

        let mut edited = assistant_json("u-1", "Reviewer");
        edited["description"] = Value::from("Reads every diff");
        apply_assistants_committed(&db, &serde_json::json!([edited])).await;
        let rows = assistants_in(&db).await;
        assert_eq!(rows.len(), 1, "matched by uid, not added again");
        assert_eq!(rows[0].description, "Reads every diff");
        assert_eq!(rows[0].revision, 2);
    }

    #[tokio::test]
    async fn an_imported_name_another_assistant_has_is_made_unique_the_same_way_twice() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        assistant_service::create(&db.conn, &local_draft("Reviewer"))
            .await
            .expect("local assistant");
        let snapshot = serde_json::json!([
            assistant_json("u-1", "reviewer"),
            assistant_json("u-2", "Writer"),
            assistant_json("u-3", "WRITER"),
        ]);
        for _ in 0..2 {
            let applied = apply_assistants_committed(&db, &snapshot).await;
            assert_eq!(
                applied,
                DomainApplied {
                    written: 3,
                    renamed: 2
                }
            );
            let mut names: Vec<(String, String)> = assistants_in(&db)
                .await
                .into_iter()
                .map(|a| (a.uid, a.name))
                .collect();
            names.sort();
            assert_eq!(names.len(), 4);
            assert_eq!(
                names[1..],
                [
                    ("u-1".to_string(), "reviewer (2)".to_string()),
                    ("u-2".to_string(), "Writer".to_string()),
                    ("u-3".to_string(), "WRITER (2)".to_string()),
                ]
            );
        }
    }

    /// The outcome depends on the snapshot and on the rows it leaves alone —
    /// not on what its own rows were called before. Two assistants trading
    /// names land traded (no rename, no unique-index clash half way), and
    /// re-applying the snapshot from before puts every name back.
    #[tokio::test]
    async fn assistants_trading_names_land_traded_and_a_rollback_puts_them_back() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let before = serde_json::json!([
            assistant_json("u-a", "Alpha"),
            assistant_json("u-b", "Beta"),
        ]);
        apply_assistants_committed(&db, &before).await;
        let names = |rows: Vec<crate::models::AssistantInfo>| {
            let mut out: Vec<(String, String)> =
                rows.into_iter().map(|a| (a.uid, a.name)).collect();
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
                names(assistants_in(&db).await),
                [
                    ("u-a".to_string(), "Beta".to_string()),
                    ("u-b".to_string(), "Alpha".to_string()),
                ]
            );
        }

        apply_assistants_committed(&db, &before).await;
        assert_eq!(
            names(assistants_in(&db).await),
            [
                ("u-a".to_string(), "Alpha".to_string()),
                ("u-b".to_string(), "Beta".to_string()),
            ]
        );
    }

    /// Uids are matched exactly, so two may differ only in case; re-applying
    /// them must not trip the live-name index, which folds case.
    #[tokio::test]
    async fn uids_differing_only_in_case_re_apply_cleanly() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let snapshot = serde_json::json!([
            assistant_json("u-a", "Alpha"),
            assistant_json("U-A", "Beta"),
        ]);
        for _ in 0..2 {
            let applied = apply_assistants_committed(&db, &snapshot).await;
            assert_eq!(applied.written, 2);
        }
        assert_eq!(assistants_in(&db).await.len(), 2);
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
        let rows = assistants_in(&db).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|a| a.uid == "u-1" && a.name == "Last"));
    }

    #[tokio::test]
    async fn an_assistant_deleted_here_comes_back_when_a_snapshot_carries_it() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        apply_assistants_committed(&db, &serde_json::json!([assistant_json("u-1", "Reviewer")]))
            .await;
        let id = assistants_in(&db).await[0].id;
        assistant_service::soft_delete(&db.conn, id)
            .await
            .expect("delete");

        apply_assistants_committed(&db, &serde_json::json!([assistant_json("u-1", "Reviewer")]))
            .await;
        let rows = assistants_in(&db).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id, "the same row, not a second one");
        assert!(rows[0].deleted_at.is_none());
        assert_eq!(rows[0].revision, 3);
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
        assert_eq!(assistants_in(&db).await.len(), 1);
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
        assert!(assistants_in(&db).await.is_empty());
    }

    #[tokio::test]
    async fn collecting_carries_live_assistants_whole() {
        let source = crate::db::test_helpers::fresh_in_memory_db().await;
        let kept = assistant_service::create(&source.conn, &local_draft("Reviewer"))
            .await
            .expect("create");
        let gone = assistant_service::create(&source.conn, &local_draft("Writer"))
            .await
            .expect("create");
        assistant_service::soft_delete(&source.conn, gone.id)
            .await
            .expect("delete");

        let collected = collect_assistants(&source.conn).await.expect("collect");
        let rows = collected.as_array().expect("a list");
        assert_eq!(rows.len(), 1, "a deleted assistant does not travel");
        assert_eq!(rows[0]["uid"], kept.uid.as_str());
        assert!(rows[0].get("id").is_none() && rows[0].get("revision").is_none());

        let target = crate::db::test_helpers::fresh_in_memory_db().await;
        apply_assistants_committed(&target, &collected).await;
        let landed = &assistants_in(&target).await[0];
        assert_eq!(landed.uid, kept.uid);
        assert_eq!(landed.name, kept.name);
        assert_eq!(landed.avatar, kept.avatar);
        assert_eq!(landed.agent_type, kept.agent_type);
        assert_eq!(landed.agent_options, kept.agent_options);
        assert_eq!(landed.label_snapshot, kept.label_snapshot);
        assert_eq!(landed.instructions, kept.instructions);
        assert_eq!(landed.enabled, kept.enabled);
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
