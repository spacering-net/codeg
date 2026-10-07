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
use crate::app_error::AppCommandError;
use crate::db::entities::{
    agent_setting, app_metadata, custom_agent, model_provider, quick_message, work_task_template,
};
use crate::db::service::app_metadata_service;

pub const DOMAIN_MODEL_PROVIDERS: &str = "modelProviders";
pub const DOMAIN_AGENT_SETTINGS: &str = "agentSettings";
pub const DOMAIN_CUSTOM_AGENTS: &str = "customAgents";
pub const DOMAIN_QUICK_MESSAGES: &str = "quickMessages";
pub const DOMAIN_TASK_TEMPLATES: &str = "taskTemplates";
pub const DOMAIN_PREFERENCES: &str = "preferences";

type CollectFn =
    for<'a> fn(&'a DatabaseConnection) -> BoxFuture<'a, Result<Value, AppCommandError>>;
type ApplyFn = for<'a> fn(
    &'a DatabaseTransaction,
    &'a Value,
) -> BoxFuture<'a, Result<usize, AppCommandError>>;
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
/// provider row exists.
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
) -> BoxFuture<'a, Result<usize, AppCommandError>> {
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
        Ok(applied)
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
) -> BoxFuture<'a, Result<usize, AppCommandError>> {
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
        Ok(applied)
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
) -> BoxFuture<'a, Result<usize, AppCommandError>> {
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
        Ok(applied)
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
) -> BoxFuture<'a, Result<usize, AppCommandError>> {
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
        Ok(applied)
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
) -> BoxFuture<'a, Result<usize, AppCommandError>> {
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
        Ok(applied)
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
) -> BoxFuture<'a, Result<usize, AppCommandError>> {
    Box::pin(async move {
        let Some(map) = value.as_object() else {
            return Ok(0);
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
        Ok(applied)
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
                let Ok(written) = applied else { continue };
                assert_eq!(
                    promised, written,
                    "domain '{}' promised {promised} and wrote {written} for {payload}",
                    domain.id
                );
            }
        }
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
